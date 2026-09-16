// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDepositPoolVenueAdapter} from "./interfaces/IDepositPoolVenueAdapter.sol";
import {ReentrancyGuard} from "./lib/ReentrancyGuard.sol";
import {SafeTransfer} from "./lib/SafeTransfer.sol";
import {TreasuryPolicy} from "./TreasuryPolicy.sol";

interface IERC20PoolAsset {
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

interface IDepositPoolV22Errors {
    error SharesPledged();
}

interface ICreditPoolLoanIds {
    function previewLoanId(address borrower) external view returns (bytes32);
}

/// @title Averray Agent Deposit Pool v2.2 (not deployed)
/// @notice Commitment-bounded windows, timelocked venue rebinding and realised recall NAV.
/// @dev This is deliberately not advertised as ERC-4626 compliant: shares cannot move
///      between accounts and notice redemption is a small purpose-built extension.
contract DepositPoolV22 is ReentrancyGuard {
    string public constant name = "Averray Agent Deposit Pool Share";
    string public constant symbol = "avUSDC";
    uint8 public constant decimals = 6;

    uint256 public constant TOTAL_ASSET_CAP = 1_000e6;
    uint256 public constant PER_AGENT_ASSET_CAP = 100e6;
    uint256 public constant PLATFORM_FEE_BPS = 0;
    uint256 public constant NOTICE_7_DAYS = 7 days;
    uint256 public constant NOTICE_30_DAYS = 30 days;
    uint256 public constant NOTICE_90_DAYS = 90 days;
    uint256 public constant VENUE_REBIND_DELAY = 7 days;
    uint256 public constant DEPLOYMENT_EPOCH = 1 days;

    TreasuryPolicy public immutable policy;
    address public immutable asset;
    address public immutable operator;
    address public immutable creditPool;
    IDepositPoolVenueAdapter public venueAdapter;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public aggregatorAdapters;

    /// @notice Principal supplied by the operator through the dedicated capital entry.
    /// @dev Protocol-owned shares are minted alongside principal, while the principal
    ///      itself remains separately identifiable from earned fees.
    uint256 public operatorContributedPrincipal;
    uint256 public operatorPrincipalShares;

    /// @notice Earned protocol fees, kept separate from operator principal.
    /// @dev The launch fee is zero, so packet 1 intentionally has no write path here.
    uint256 public earnedProtocolFees;

    /// @notice Historical-cost principal outside the buffer.
    /// @dev This is the only remote-capital value admitted to NAV. It rises
    ///      when the pool transfers principal to its adapter and falls only
    ///      when USDC returns to the buffer or TreasuryPolicy's owner writes a
    ///      loss off. Remote observations are recall inventory, never pricing.
    uint256 public venuePrincipalCostBasis;

    enum NoticeTier {
        Notice7Days,
        Notice30Days,
        Notice90Days
    }

    struct Commitment {
        NoticeTier tier;
        uint64 committedUntil;
    }

    // Absolute weekly keys prevent a stale ring slot from reviving expired shares.
    // Use the earliest exact expiry in a bucket: aggregation may UNDERSTATE backing,
    // never count shares past their consent. No holder enumeration or expiry sweep.
    struct ExpiryBucket {
        uint256 shares;
        uint64 earliestUntil;
        uint256[3] tierShares;
    }

    mapping(address => Commitment) public commitment;
    mapping(uint256 => ExpiryBucket) private expiryBuckets;
    IDepositPoolVenueAdapter public proposedVenueAdapter;
    uint64 public venueAdapterApplyAfter;

    event Committed(address indexed holder, NoticeTier tier, uint64 committedUntil, uint256 shares);
    event VenueAdapterProposed(address indexed adapter, uint64 applyAfter);
    event VenueLossRealised(uint256 indexed deploymentId, uint256 assets);

    error CommitmentActive(uint64 committedUntil);
    error CommitmentCannotShorten(uint64 currentUntil, uint64 attemptedUntil);
    error CommitmentHasEncumberedShares();
    error VenueRebindNotReady(uint64 applyAfter);

    struct RedeemRequest {
        address owner;
        address receiver;
        uint256 shares;
        uint64 unlockAt;
        NoticeTier tier;
        bool fulfilled;
    }

    struct VenueDeployment {
        uint256 principalAssets;
        uint256 recalledPrincipalAssets;
        uint64 returnBy;
        bytes32 adapterRequestId;
        IDepositPoolVenueAdapter.RequestStatus status;
    }

    struct VenueRecall {
        uint256 deploymentId;
        uint256 requestedAssets;
        uint256 returnedAssets;
        bytes32 adapterRequestId;
        IDepositPoolVenueAdapter.RequestStatus status;
    }

    uint256 public nextRedeemRequestId = 1;
    uint256 public nextVenueDeploymentId = 1;
    uint256 public nextVenueRecallId = 1;
    uint256 public maxIssuedAgentShares;
    uint256 public activeVenueDeploymentId;
    uint256 public activeVenueRecallId;
    uint64 public lastDeploymentEpochAt;
    mapping(address => uint256) public lockedShares;
    mapping(address => uint256) public pledgedShares;

    struct PledgeRecord {
        address owner;
        uint256 shares;
        bool active;
    }

    mapping(bytes32 => PledgeRecord) public pledges;
    mapping(uint256 => RedeemRequest) public redeemRequests;
    mapping(uint256 => VenueDeployment) public venueDeployments;
    mapping(uint256 => VenueRecall) public venueRecalls;
    mapping(uint256 => uint256) public venueWrittenOffPrincipalAssets;
    mapping(bytes32 => uint256) internal venueDeploymentForAdapterRequest;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    event Deposit(address indexed caller, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(
        address indexed caller, address indexed receiver, address indexed owner, uint256 assets, uint256 shares
    );
    event RedeemRequested(
        uint256 indexed requestId,
        address indexed owner,
        address indexed receiver,
        uint256 shares,
        NoticeTier tier,
        uint64 unlockAt
    );
    event RedeemFulfilled(uint256 indexed requestId, uint256 shares, uint256 assets);
    event OperatorPrincipalContributed(uint256 assets, uint256 shares, uint256 totalPrincipal);
    event VenueDeploymentCreated(
        uint256 indexed deploymentId, bytes32 indexed adapterRequestId, uint256 assets, uint64 returnBy
    );
    event VenueDeploymentSettled(
        uint256 indexed deploymentId, IDepositPoolVenueAdapter.RequestStatus status, uint256 settledAssets
    );
    event VenueRecallRequested(
        uint256 indexed recallId,
        uint256 indexed deploymentId,
        bytes32 indexed adapterRequestId,
        uint256 requestedAssets
    );
    event VenueRecallSettled(
        uint256 indexed recallId,
        uint256 indexed deploymentId,
        IDepositPoolVenueAdapter.RequestStatus status,
        uint256 returnedAssets
    );
    event VenuePrincipalReturned(uint256 indexed deploymentId, uint256 returnedAssets, uint256 principalReduction);
    event VenueLossWrittenOff(uint256 indexed deploymentId, uint256 assets, uint256 remainingPrincipalCostBasis);
    event SharesPledged(address indexed owner, uint256 shares, bytes32 indexed loanId);
    event SharesReleased(address indexed owner, uint256 shares, bytes32 indexed loanId);
    event SharesSeized(address indexed owner, address indexed receiver, uint256 shares, uint256 assets, bytes32 loanId);
    event AggregatorAdapterSet(address indexed adapter, bool enabled);
    event VenueAdapterSet(address indexed adapter);

    error Unauthorized();
    error ZeroAddress();
    error ZeroAmount();
    error ZeroShares();
    error InvalidAssetDecimals();
    error InvalidVenueAdapter();
    error SharesNonTransferable();
    error InsufficientUnlockedShares();
    error InsufficientBuffer(uint256 available, uint256 required);
    error TotalAssetCapExceeded(uint256 attempted, uint256 cap);
    error AgentAssetCapExceeded(address agent, uint256 attempted, uint256 cap);
    error NoticeNotElapsed(uint64 unlockAt);
    error RedeemRequestNotFound();
    error RedeemRequestAlreadyFulfilled();
    error VenueNotConfigured();
    error InvalidReturnDeadline();
    error VenueDeadlineExceedsNoticeTier(uint64 attempted, uint64 maximum);
    error BufferFloorBreached(uint256 available, uint256 floor, uint256 attemptedDeployment);
    error DeploymentEpochNotElapsed(uint64 nextEpochAt);
    error VenueDeploymentAlreadyActive();
    error VenueDeploymentNotFound();
    error VenueRecallAlreadyActive();
    error VenueRecallNotFound();
    error VenueRecallExceedsManaged(uint256 available, uint256 requested);
    error VenueRequestPending();
    error VenueRequestMismatch();
    error VenueRecallShortfall(uint256 returnedAssets, uint256 requiredAssets);
    error AssetTransferAmountMismatch();
    error VenueLossExceedsOutstanding(uint256 outstanding, uint256 attempted);
    error PledgeNotFound();
    error PledgeAlreadyExists();
    error InvalidLoanId();
    error InvalidAggregatorAdapter();
    error AggregatorMustUseNoticeExit();
    error VenueAdapterAlreadySet();

    modifier onlyOwner() {
        if (msg.sender != policy.owner()) revert Unauthorized();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert Unauthorized();
        _;
    }

    modifier onlyVenueAdapter() {
        if (msg.sender != address(venueAdapter)) revert Unauthorized();
        _;
    }

    modifier onlyCreditPool() {
        if (msg.sender != creditPool) revert Unauthorized();
        _;
    }

    constructor(
        TreasuryPolicy policy_,
        address asset_,
        address operator_,
        IDepositPoolVenueAdapter venueAdapter_,
        address creditPool_
    ) {
        if (
            address(policy_) == address(0) || asset_ == address(0) || operator_ == address(0)
                || creditPool_ == address(0)
        ) {
            revert ZeroAddress();
        }
        if (IERC20PoolAsset(asset_).decimals() != decimals) revert InvalidAssetDecimals();
        policy = policy_;
        asset = asset_;
        operator = operator_;
        creditPool = creditPool_;
        if (address(venueAdapter_) != address(0)) _validateVenueAdapter(venueAdapter_);
        venueAdapter = venueAdapter_;
    }

    function setVenueAdapter(IDepositPoolVenueAdapter adapter_) external onlyOwner {
        if (address(venueAdapter) != address(0)) revert VenueAdapterAlreadySet();
        if (address(adapter_) == address(0)) revert ZeroAddress();
        _validateVenueAdapter(adapter_);
        venueAdapter = adapter_;
        emit VenueAdapterSet(address(adapter_));
    }

    function setAggregatorAdapter(address adapter, bool enabled) external onlyOwner {
        if (adapter == address(0) || adapter == address(this)) revert InvalidAggregatorAdapter();
        aggregatorAdapters[adapter] = enabled;
        emit AggregatorAdapterSet(adapter, enabled);
    }

    function proposeVenueAdapter(IDepositPoolVenueAdapter next) external onlyOwner {
        if (address(venueAdapter) == address(0)) revert VenueNotConfigured();
        if (address(next) == address(0) || address(next) == address(venueAdapter)) revert InvalidVenueAdapter();
        _validateVenueAdapter(next);
        proposedVenueAdapter = next;
        venueAdapterApplyAfter = uint64(block.timestamp + VENUE_REBIND_DELAY);
        emit VenueAdapterProposed(address(next), venueAdapterApplyAfter);
    }

    function applyVenueAdapter() external onlyOwner {
        if (activeVenueDeploymentId != 0) revert VenueDeploymentAlreadyActive();
        if (activeVenueRecallId != 0) revert VenueRecallAlreadyActive();
        if (venueAdapterApplyAfter == 0 || block.timestamp < venueAdapterApplyAfter) {
            revert VenueRebindNotReady(venueAdapterApplyAfter);
        }
        _validateVenueAdapter(proposedVenueAdapter);
        venueAdapter = proposedVenueAdapter;
        delete proposedVenueAdapter;
        delete venueAdapterApplyAfter;
        emit VenueAdapterSet(address(venueAdapter));
    }

    function commit(NoticeTier tier) external {
        _commit(tier, uint64(block.timestamp + _noticePeriod(tier)));
    }

    /// @notice The keeper's exact shared-consent deadline; never rounds up a depositor's term.
    /// @dev Only registered aggregators can select an exact deadline. Direct holders
    ///      use commit(tier). Both paths lock the WHOLE position and cannot shorten it.
    function commitUntil(NoticeTier tier, uint64 until) external {
        if (!aggregatorAdapters[msg.sender]) revert Unauthorized();
        if (until <= block.timestamp || until > block.timestamp + _noticePeriod(tier)) {
            revert InvalidReturnDeadline();
        }
        _commit(tier, until);
    }

    function _commit(NoticeTier tier, uint64 until) private {
        Commitment memory previous = commitment[msg.sender];
        if (until < previous.committedUntil) revert CommitmentCannotShorten(previous.committedUntil, until);
        if (balanceOf[msg.sender] == 0) revert ZeroShares();
        if (lockedShares[msg.sender] != 0 || pledgedShares[msg.sender] != 0) revert CommitmentHasEncumberedShares();
        _debitCommitment(msg.sender, balanceOf[msg.sender]);
        commitment[msg.sender] = Commitment(tier, until);
        _creditCommitment(msg.sender, balanceOf[msg.sender]);
        emit Committed(msg.sender, tier, until, balanceOf[msg.sender]);
    }

    /// @notice Conservative share backing through t (returnBy == expiry is safe).
    /// @dev At most 13 future weekly buckets cover 90 days. The current partial
    ///      week is read separately for telemetry; it cannot back a >7-day window.
    function committedSharesBeyond(uint256 t) public view returns (uint256 shares) {
        uint256 week = block.timestamp / 7 days;
        shares = _sharesBeyond(expiryBuckets[week], t);
        for (uint256 i = 1; i <= 13; ++i) shares += _sharesBeyond(expiryBuckets[week + i], t);
    }

    function _sharesBeyond(ExpiryBucket storage bucket, uint256 t) private view returns (uint256) {
        return bucket.earliestUntil > block.timestamp && bucket.earliestUntil >= t ? bucket.shares : 0;
    }

    /// @notice Conservative active amounts by declared tier, never holder addresses.
    function committedSharesByTier() external view returns (uint256[3] memory shares) {
        uint256 week = block.timestamp / 7 days;
        for (uint256 i; i <= 13; ++i) {
            ExpiryBucket storage bucket = expiryBuckets[week + i];
            if (bucket.earliestUntil <= block.timestamp) continue;
            for (uint256 tier; tier < 3; ++tier) shares[tier] += bucket.tierShares[tier];
        }
    }

    function longDeployedOutstanding() public view returns (uint256) {
        uint256 active = activeVenueDeploymentId;
        if (active == 0 || !longVenueDeployment[active]) return 0;
        return _outstandingVenuePrincipal(active);
    }

    mapping(uint256 => bool) public longVenueDeployment;

    function deployableFor(uint256 duration) public view returns (uint256) {
        if (duration == 0 || duration > NOTICE_90_DAYS) return 0;
        uint256 liquidCapacity = maxDeployableAssets();
        if (duration <= NOTICE_7_DAYS) return liquidCapacity;
        uint256 committed = convertToAssets(committedSharesBeyond(block.timestamp + duration));
        uint256 outstanding = longDeployedOutstanding();
        uint256 backing = committed > outstanding ? committed - outstanding : 0;
        return backing < liquidCapacity ? backing : liquidCapacity;
    }

    function _noticePeriod(NoticeTier tier) private pure returns (uint256) {
        if (tier == NoticeTier.Notice7Days) return NOTICE_7_DAYS;
        return tier == NoticeTier.Notice30Days ? NOTICE_30_DAYS : NOTICE_90_DAYS;
    }

    function _requireUncommitted(address holder) private view {
        uint64 until = commitment[holder].committedUntil;
        if (block.timestamp < until) revert CommitmentActive(until);
    }

    function _creditCommitment(address holder, uint256 shares) private {
        Commitment memory position = commitment[holder];
        if (position.committedUntil <= block.timestamp) return;
        ExpiryBucket storage bucket = expiryBuckets[position.committedUntil / 7 days];
        if (bucket.shares == 0 || position.committedUntil < bucket.earliestUntil) {
            bucket.earliestUntil = position.committedUntil;
        }
        bucket.shares += shares;
        bucket.tierShares[uint256(position.tier)] += shares;
    }

    function _debitCommitment(address holder, uint256 shares) private {
        Commitment memory position = commitment[holder];
        if (position.committedUntil == 0) return;
        ExpiryBucket storage bucket = expiryBuckets[position.committedUntil / 7 days];
        bucket.shares -= shares;
        bucket.tierShares[uint256(position.tier)] -= shares;
    }

    /// @notice Total depositor and protocol-owned assets at buffer cash plus venue cost.
    /// @dev Yield is deliberately absent until USDC reaches the buffer. This
    ///      conservative step recognition leaves a known timing seam: a deposit
    ///      immediately before a profitable recall and redemption immediately
    ///      after can capture yield it did not earn. It cannot extract more than
    ///      the pool actually holds, but must be redesigned before scale.
    function totalAssets() public view returns (uint256 assets) {
        assets = bufferAssets() + venuePrincipalCostBasis;
    }

    function bufferAssets() public view returns (uint256) {
        return IERC20PoolAsset(asset).balanceOf(address(this));
    }

    /// @notice Conservative instant-liquidity floor for one whole agent position.
    /// @dev Non-transferable shares make the largest position ever issued an upper
    ///      bound for every current agent position. Keeping the high-water mark is
    ///      deliberately conservative after that agent exits.
    function bufferFloor() public view returns (uint256 floor) {
        floor = convertToAssets(maxIssuedAgentShares);
        uint256 managed = totalAssets();
        if (floor > managed) return managed;
    }

    function maxDeployableAssets() public view returns (uint256) {
        uint256 available = bufferAssets();
        uint256 floor = bufferFloor();
        return available > floor ? available - floor : 0;
    }

    function assetsOf(address account) public view returns (uint256) {
        return convertToAssets(balanceOf[account]);
    }

    function availableShares(address account) public view returns (uint256) {
        return balanceOf[account] - lockedShares[account] - pledgedShares[account];
    }

    /// @notice Reserve the caller's own currently-unlocked shares for the
    ///         deterministic CreditPool loan id supplied by the door.
    function pledge(uint256 shares, bytes32 loanId) external {
        _requireUncommitted(msg.sender);
        if (shares == 0) revert ZeroShares();
        // A globally-keyed pledge must be bound to its owner. Without this
        // check, another depositor could front-run a borrower's deterministic
        // id and pin that borrower's nonce forever with an unrelated pledge.
        if (loanId == bytes32(0) || loanId != ICreditPoolLoanIds(creditPool).previewLoanId(msg.sender)) {
            revert InvalidLoanId();
        }
        if (pledges[loanId].owner != address(0)) revert PledgeAlreadyExists();
        if (availableShares(msg.sender) < shares) revert InsufficientUnlockedShares();
        pledgedShares[msg.sender] += shares;
        pledges[loanId] = PledgeRecord({owner: msg.sender, shares: shares, active: true});
        emit SharesPledged(msg.sender, shares, loanId);
    }

    /// @notice Release a pledge only after CreditPool has recorded full repayment.
    function release(bytes32 loanId) external onlyCreditPool {
        PledgeRecord storage record = pledges[loanId];
        if (record.owner == address(0) || !record.active) revert PledgeNotFound();
        record.active = false;
        pledgedShares[record.owner] -= record.shares;
        emit SharesReleased(record.owner, record.shares, loanId);
    }

    /// @notice Burn pledged shares and deliver their then-current buffer value
    ///         to CreditPool after its fixed impairment check has passed.
    function seize(bytes32 loanId, address receiver) external onlyCreditPool nonReentrant returns (uint256 assets) {
        if (receiver == address(0)) revert ZeroAddress();
        PledgeRecord storage record = pledges[loanId];
        if (record.owner == address(0) || !record.active) revert PledgeNotFound();
        assets = convertToAssets(record.shares);
        record.active = false;
        pledgedShares[record.owner] -= record.shares;
        if (assets == 0) {
            _burn(record.owner, record.shares);
            emit Withdraw(msg.sender, receiver, record.owner, 0, record.shares);
        } else {
            _redeemFromBuffer(msg.sender, receiver, record.owner, record.shares, assets);
        }
        emit SharesSeized(record.owner, receiver, record.shares, assets, loanId);
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        uint256 supply = totalSupply;
        uint256 managed = totalAssets();
        if (supply == 0) return assets;
        if (managed == 0) return 0;
        return (assets * supply) / managed;
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        uint256 supply = totalSupply;
        if (supply == 0) return shares;
        return (shares * totalAssets()) / supply;
    }

    function approve(address spender, uint256 shares) external returns (bool) {
        allowance[msg.sender][spender] = shares;
        emit Approval(msg.sender, spender, shares);
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) {
        revert SharesNonTransferable();
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        revert SharesNonTransferable();
    }

    function deposit(uint256 assets, address receiver) external nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        _requireAgentReceiver(receiver);

        uint256 managedBefore = totalAssets();
        uint256 supplyBefore = totalSupply;
        _checkTotalCap(managedBefore, assets);
        shares = _convertToShares(assets, managedBefore, supplyBefore, false);
        if (shares == 0) revert ZeroShares();
        if (!aggregatorAdapters[receiver]) {
            _checkAgentCap(receiver, shares, managedBefore + assets, supplyBefore + shares);
        }

        _mint(receiver, shares);
        if (!aggregatorAdapters[receiver]) _recordAgentShareHighWater(receiver);
        _collectAssets(msg.sender, assets);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function mint(uint256 shares, address receiver) external nonReentrant returns (uint256 assets) {
        if (shares == 0) revert ZeroShares();
        _requireAgentReceiver(receiver);

        uint256 managedBefore = totalAssets();
        uint256 supplyBefore = totalSupply;
        assets = _convertToAssets(shares, managedBefore, supplyBefore, true);
        if (assets == 0) revert ZeroAmount();
        _checkTotalCap(managedBefore, assets);
        if (!aggregatorAdapters[receiver]) {
            _checkAgentCap(receiver, shares, managedBefore + assets, supplyBefore + shares);
        }

        _mint(receiver, shares);
        if (!aggregatorAdapters[receiver]) _recordAgentShareHighWater(receiver);
        _collectAssets(msg.sender, assets);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    /// @notice Add operator capital on the same share-price basis as a deposit.
    /// @dev Matching shares are permanently held by the pool contract. There is no
    ///      privileged operator withdrawal path.
    function contributeOperatorPrincipal(uint256 assets) external onlyOperator nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        uint256 managedBefore = totalAssets();
        uint256 supplyBefore = totalSupply;
        _checkTotalCap(managedBefore, assets);
        // Round down like deposit(): operator capital must never dilute depositors.
        shares = _convertToShares(assets, managedBefore, supplyBefore, false);
        if (shares == 0) revert ZeroShares();

        operatorContributedPrincipal += assets;
        operatorPrincipalShares += shares;
        _mint(address(this), shares);
        _collectAssets(msg.sender, assets);
        emit OperatorPrincipalContributed(assets, shares, operatorContributedPrincipal);
    }

    /// @notice Synchronous redemption against assets currently in the pool buffer.
    function redeem(uint256 shares, address receiver, address owner) external nonReentrant returns (uint256 assets) {
        _requireUncommitted(owner);
        if (shares == 0) revert ZeroShares();
        if (receiver == address(0) || owner == address(0)) revert ZeroAddress();
        if (aggregatorAdapters[owner]) revert AggregatorMustUseNoticeExit();
        if (msg.sender != owner) _spendAllowance(owner, msg.sender, shares);
        uint256 unlockedBeforePledges = balanceOf[owner] - lockedShares[owner];
        if (unlockedBeforePledges < shares) revert InsufficientUnlockedShares();
        if (availableShares(owner) < shares) revert IDepositPoolV22Errors.SharesPledged();

        assets = convertToAssets(shares);
        if (assets == 0) revert ZeroAmount();
        _redeemFromBuffer(msg.sender, receiver, owner, shares, assets);
    }

    /// @notice Request notice redemption only after the holder's commitment expires.
    function requestRedeem(uint256 shares, address receiver, NoticeTier tier) external returns (uint256 requestId) {
        _requireUncommitted(msg.sender);
        if (shares == 0) revert ZeroShares();
        if (receiver == address(0)) revert ZeroAddress();
        uint256 unlockedBeforePledges = balanceOf[msg.sender] - lockedShares[msg.sender];
        if (unlockedBeforePledges < shares) revert InsufficientUnlockedShares();
        if (availableShares(msg.sender) < shares) revert IDepositPoolV22Errors.SharesPledged();

        uint256 period = _noticePeriod(tier);
        uint64 unlockAt = uint64(block.timestamp + period);
        requestId = nextRedeemRequestId++;
        lockedShares[msg.sender] += shares;
        redeemRequests[requestId] = RedeemRequest({
            owner: msg.sender, receiver: receiver, shares: shares, unlockAt: unlockAt, tier: tier, fulfilled: false
        });
        emit RedeemRequested(requestId, msg.sender, receiver, shares, tier, unlockAt);
    }

    /// @notice Fulfil a matured notice request at the then-current share price.
    /// @dev Anyone may execute it; the request fixes both owner and receiver.
    function fulfilRedeem(uint256 requestId) external nonReentrant returns (uint256 assets) {
        RedeemRequest storage request = redeemRequests[requestId];
        if (request.owner == address(0)) revert RedeemRequestNotFound();
        if (request.fulfilled) revert RedeemRequestAlreadyFulfilled();
        if (block.timestamp < request.unlockAt) revert NoticeNotElapsed(request.unlockAt);

        assets = convertToAssets(request.shares);
        if (assets == 0) revert ZeroAmount();
        request.fulfilled = true;
        lockedShares[request.owner] -= request.shares;
        _redeemFromBuffer(msg.sender, request.receiver, request.owner, request.shares, assets);
        emit RedeemFulfilled(requestId, request.shares, assets);
    }

    /// @notice Begin one asynchronous, epoch-batched deployment.
    /// @dev Short windows preserve v2.1 liquidity policy. Long windows must
    ///      ALSO have commitment backing through the exact return deadline.
    function deployToVenue(uint256 assets, uint64 returnBy)
        external
        onlyOperator
        nonReentrant
        returns (uint256 deploymentId)
    {
        if (address(venueAdapter) == address(0)) revert VenueNotConfigured();
        if (assets == 0) revert ZeroAmount();
        if (returnBy <= block.timestamp) revert InvalidReturnDeadline();
        uint64 maximumReturnBy = uint64(block.timestamp + NOTICE_90_DAYS);
        if (returnBy > maximumReturnBy) revert VenueDeadlineExceedsNoticeTier(returnBy, maximumReturnBy);
        if (activeVenueDeploymentId != 0) revert VenueDeploymentAlreadyActive();
        if (lastDeploymentEpochAt != 0 && block.timestamp < uint256(lastDeploymentEpochAt) + DEPLOYMENT_EPOCH) {
            revert DeploymentEpochNotElapsed(uint64(uint256(lastDeploymentEpochAt) + DEPLOYMENT_EPOCH));
        }

        uint256 available = bufferAssets();
        uint256 floor = bufferFloor();
        if (assets > deployableFor(returnBy - block.timestamp)) revert BufferFloorBreached(available, floor, assets);

        deploymentId = nextVenueDeploymentId++;
        longVenueDeployment[deploymentId] = returnBy - block.timestamp > NOTICE_7_DAYS;
        activeVenueDeploymentId = deploymentId;
        lastDeploymentEpochAt = uint64(block.timestamp);
        venuePrincipalCostBasis += assets;
        SafeTransfer.safeTransfer(asset, address(venueAdapter), assets);
        bytes32 adapterRequestId = venueAdapter.requestDeploy(assets, returnBy);
        venueDeploymentForAdapterRequest[adapterRequestId] = deploymentId;
        venueDeployments[deploymentId] = VenueDeployment({
            principalAssets: assets,
            recalledPrincipalAssets: 0,
            returnBy: returnBy,
            adapterRequestId: adapterRequestId,
            status: IDepositPoolVenueAdapter.RequestStatus.Pending
        });
        emit VenueDeploymentCreated(deploymentId, adapterRequestId, assets, returnBy);
    }

    /// @notice Latch a terminal async deployment result into the epoch ledger.
    function settleVenueDeployment(uint256 deploymentId)
        external
        nonReentrant
        returns (IDepositPoolVenueAdapter.RequestStatus status, uint256 settledAssets)
    {
        VenueDeployment storage deployment = venueDeployments[deploymentId];
        if (deployment.principalAssets == 0) revert VenueDeploymentNotFound();
        if (deployment.status != IDepositPoolVenueAdapter.RequestStatus.Pending) revert VenueRequestMismatch();
        IDepositPoolVenueAdapter.Request memory request = venueAdapter.getRequest(deployment.adapterRequestId);
        _requireTerminalAdapterRequest(
            request, IDepositPoolVenueAdapter.RequestKind.Deploy, deployment.principalAssets, deployment.returnBy
        );

        uint256 beforeBalance = bufferAssets();
        settledAssets = venueAdapter.claimSettled(deployment.adapterRequestId);
        uint256 received = bufferAssets() - beforeBalance;
        status = request.status;
        deployment.status = status;
        if (received != 0) _recordVenueReturn(deploymentId, received);
        _maybeCloseVenueDeployment(deploymentId);
        emit VenueDeploymentSettled(deploymentId, status, settledAssets);
    }

    /// @notice Begin an asynchronous recall from the one active venue epoch.
    /// @dev Yield is not attributed to individual deployments, so a recall may
    ///      include principal plus observed yield up to all managed venue assets.
    function recallVenueDeployment(uint256 deploymentId, uint256 requestedAssets)
        external
        onlyOperator
        nonReentrant
        returns (uint256 recallId)
    {
        if (address(venueAdapter) == address(0)) revert VenueNotConfigured();
        if (requestedAssets == 0) revert ZeroAmount();
        if (activeVenueRecallId != 0) revert VenueRecallAlreadyActive();
        VenueDeployment storage deployment = venueDeployments[deploymentId];
        if (deployment.principalAssets == 0 || activeVenueDeploymentId != deploymentId) {
            revert VenueDeploymentNotFound();
        }
        uint256 managed = venueAdapter.managedAssets(address(this));
        if (requestedAssets > managed) revert VenueRecallExceedsManaged(managed, requestedAssets);

        recallId = nextVenueRecallId++;
        activeVenueRecallId = recallId;
        bytes32 adapterRequestId = venueAdapter.requestRecall(requestedAssets, deployment.returnBy);
        venueRecalls[recallId] = VenueRecall({
            deploymentId: deploymentId,
            requestedAssets: requestedAssets,
            returnedAssets: 0,
            adapterRequestId: adapterRequestId,
            status: IDepositPoolVenueAdapter.RequestStatus.Pending
        });
        emit VenueRecallRequested(recallId, deploymentId, adapterRequestId, requestedAssets);
    }

    /// @notice Claim locally-settled recall assets into the buffer.
    function settleVenueRecall(uint256 recallId)
        external
        nonReentrant
        returns (IDepositPoolVenueAdapter.RequestStatus status, uint256 returnedAssets)
    {
        VenueRecall storage recall = venueRecalls[recallId];
        if (recall.deploymentId == 0) revert VenueRecallNotFound();
        if (recall.status != IDepositPoolVenueAdapter.RequestStatus.Pending) revert VenueRequestMismatch();
        VenueDeployment storage deployment = venueDeployments[recall.deploymentId];
        IDepositPoolVenueAdapter.Request memory request = venueAdapter.getRequest(recall.adapterRequestId);
        _requireTerminalAdapterRequest(
            request, IDepositPoolVenueAdapter.RequestKind.Recall, recall.requestedAssets, deployment.returnBy
        );

        uint256 beforeBalance = bufferAssets();
        returnedAssets = venueAdapter.claimSettled(recall.adapterRequestId);
        uint256 received = bufferAssets() - beforeBalance;
        status = request.status;
        if (status == IDepositPoolVenueAdapter.RequestStatus.Succeeded && received != returnedAssets) {
            revert VenueRecallShortfall(received, returnedAssets);
        }

        recall.returnedAssets = returnedAssets;
        recall.status = status;
        activeVenueRecallId = 0;
        if (received != 0) _recordVenueReturn(recall.deploymentId, received);
        // A failed or partial recall is NOT evidence the rest of the venue
        // position was lost. Only a successful terminal drain realises friction.
        if (status == IDepositPoolVenueAdapter.RequestStatus.Succeeded && venueAdapter.managedAssets(address(this)) == 0) {
            uint256 loss = _outstandingVenuePrincipal(recall.deploymentId);
            if (loss != 0) {
                venueWrittenOffPrincipalAssets[recall.deploymentId] += loss;
                venuePrincipalCostBasis -= loss;
                emit VenueLossRealised(recall.deploymentId, loss);
            }
        }
        _maybeCloseVenueDeployment(recall.deploymentId);
        emit VenueRecallSettled(recallId, recall.deploymentId, status, returnedAssets);
    }

    /// @notice Account for cash returned through the adapter's recovery path.
    /// @dev The bound adapter calls this after transferring USDC. Normal
    ///      recall/deploy claims are balance-delta measured by the pool itself.
    function recordVenueReturn(bytes32 adapterRequestId, uint256 assets) external onlyVenueAdapter nonReentrant {
        if (assets == 0) revert ZeroAmount();
        uint256 deploymentId = venueDeploymentForAdapterRequest[adapterRequestId];
        if (deploymentId == 0) revert VenueDeploymentNotFound();
        _recordVenueReturn(deploymentId, assets);
        _maybeCloseVenueDeployment(deploymentId);
    }

    /// @notice Reduce depositor NAV for principal that cannot return.
    /// @dev Only the TreasuryPolicy owner exposed by the bound adapter may
    ///      take this depositor-impacting action; operator and settler keys may not.
    function writeOffVenueLoss(uint256 deploymentId, uint256 assets) external nonReentrant {
        if (address(venueAdapter) == address(0)) revert VenueNotConfigured();
        if (msg.sender != venueAdapter.lossReporter()) revert Unauthorized();
        if (assets == 0) revert ZeroAmount();
        VenueDeployment storage deployment = venueDeployments[deploymentId];
        if (deployment.principalAssets == 0) revert VenueDeploymentNotFound();
        uint256 outstanding = _outstandingVenuePrincipal(deploymentId);
        if (assets > outstanding) revert VenueLossExceedsOutstanding(outstanding, assets);
        venueWrittenOffPrincipalAssets[deploymentId] += assets;
        venuePrincipalCostBasis -= assets;
        _maybeCloseVenueDeployment(deploymentId);
        emit VenueLossWrittenOff(deploymentId, assets, venuePrincipalCostBasis);
    }

    function _recordVenueReturn(uint256 deploymentId, uint256 returnedAssets) private {
        uint256 outstanding = _outstandingVenuePrincipal(deploymentId);
        uint256 principalReduction = returnedAssets < outstanding ? returnedAssets : outstanding;
        if (principalReduction != 0) {
            venueDeployments[deploymentId].recalledPrincipalAssets += principalReduction;
            venuePrincipalCostBasis -= principalReduction;
        }
        emit VenuePrincipalReturned(deploymentId, returnedAssets, principalReduction);
    }

    function _validateVenueAdapter(IDepositPoolVenueAdapter adapter_) private view {
        if (address(adapter_).code.length == 0 || adapter_.asset() != asset || adapter_.lossReporter() == address(0)) {
            revert InvalidVenueAdapter();
        }
    }

    function _outstandingVenuePrincipal(uint256 deploymentId) private view returns (uint256) {
        VenueDeployment storage deployment = venueDeployments[deploymentId];
        return
            deployment.principalAssets - deployment.recalledPrincipalAssets
                - venueWrittenOffPrincipalAssets[deploymentId];
    }

    function _maybeCloseVenueDeployment(uint256 deploymentId) private {
        if (
            activeVenueDeploymentId == deploymentId && activeVenueRecallId == 0
                && _outstandingVenuePrincipal(deploymentId) == 0
        ) activeVenueDeploymentId = 0;
    }

    function _redeemFromBuffer(address caller, address receiver, address owner, uint256 shares, uint256 assets)
        private
    {
        uint256 available = bufferAssets();
        if (available < assets) revert InsufficientBuffer(available, assets);
        _burn(owner, shares);
        SafeTransfer.safeTransfer(asset, receiver, assets);
        emit Withdraw(caller, receiver, owner, assets, shares);
    }

    function _collectAssets(address from, uint256 assets) private {
        uint256 beforeBalance = bufferAssets();
        SafeTransfer.safeTransferFrom(asset, from, address(this), assets);
        if (bufferAssets() - beforeBalance != assets) revert AssetTransferAmountMismatch();
    }

    function _recordAgentShareHighWater(address account) private {
        uint256 position = balanceOf[account];
        if (position > maxIssuedAgentShares) maxIssuedAgentShares = position;
    }

    function _requireTerminalAdapterRequest(
        IDepositPoolVenueAdapter.Request memory request,
        IDepositPoolVenueAdapter.RequestKind expectedKind,
        uint256 expectedAssets,
        uint64 expectedReturnBy
    ) private pure {
        if (request.status == IDepositPoolVenueAdapter.RequestStatus.Pending) {
            revert VenueRequestPending();
        }
        if (
            request.status == IDepositPoolVenueAdapter.RequestStatus.None || request.kind != expectedKind
                || request.requestedAssets != expectedAssets || request.returnBy != expectedReturnBy || request.claimed
        ) revert VenueRequestMismatch();
    }

    function _checkTotalCap(uint256 managedBefore, uint256 addedAssets) private pure {
        uint256 attempted = managedBefore + addedAssets;
        if (attempted > TOTAL_ASSET_CAP) revert TotalAssetCapExceeded(attempted, TOTAL_ASSET_CAP);
    }

    function _checkAgentCap(address receiver, uint256 addedShares, uint256 managedAfter, uint256 supplyAfter)
        private
        view
    {
        uint256 attempted = ((balanceOf[receiver] + addedShares) * managedAfter) / supplyAfter;
        if (attempted > PER_AGENT_ASSET_CAP) {
            revert AgentAssetCapExceeded(receiver, attempted, PER_AGENT_ASSET_CAP);
        }
    }

    function _requireAgentReceiver(address receiver) private view {
        if (receiver == address(0)) revert ZeroAddress();
        if (receiver == address(this)) revert Unauthorized();
    }

    function _convertToShares(uint256 assets, uint256 managed, uint256 supply, bool roundUp)
        private
        pure
        returns (uint256)
    {
        if (supply == 0) return assets;
        if (managed == 0) return 0;
        uint256 numerator = assets * supply;
        return roundUp ? _ceilDiv(numerator, managed) : numerator / managed;
    }

    function _convertToAssets(uint256 shares, uint256 managed, uint256 supply, bool roundUp)
        private
        pure
        returns (uint256)
    {
        if (supply == 0) return shares;
        uint256 numerator = shares * managed;
        return roundUp ? _ceilDiv(numerator, supply) : numerator / supply;
    }

    function _ceilDiv(uint256 numerator, uint256 denominator) private pure returns (uint256) {
        if (numerator == 0) return 0;
        return ((numerator - 1) / denominator) + 1;
    }

    function _mint(address account, uint256 shares) private {
        if (commitment[account].committedUntil != 0 && commitment[account].committedUntil <= block.timestamp) {
            _debitCommitment(account, balanceOf[account]);
            delete commitment[account];
        }
        _creditCommitment(account, shares);
        totalSupply += shares;
        balanceOf[account] += shares;
        emit Transfer(address(0), account, shares);
    }

    function _burn(address account, uint256 shares) private {
        _debitCommitment(account, shares);
        balanceOf[account] -= shares;
        totalSupply -= shares;
        emit Transfer(account, address(0), shares);
    }

    function _spendAllowance(address owner, address spender, uint256 shares) private {
        uint256 allowed = allowance[owner][spender];
        if (allowed != type(uint256).max) {
            allowance[owner][spender] = allowed - shares;
            emit Approval(owner, spender, allowance[owner][spender]);
        }
    }
}
