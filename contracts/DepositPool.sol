// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDepositPoolVenueAdapter} from "./interfaces/IDepositPoolVenueAdapter.sol";
import {ReentrancyGuard} from "./lib/ReentrancyGuard.sol";
import {SafeTransfer} from "./lib/SafeTransfer.sol";

interface IERC20PoolAsset {
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// @title Averray Agent Deposit Pool
/// @notice ERC-4626-shaped USDC pool with non-transferable shares and no credit path.
/// @dev This is deliberately not advertised as ERC-4626 compliant: shares cannot move
///      between accounts and notice redemption is a small purpose-built extension.
contract DepositPool is ReentrancyGuard {
    string public constant name = "Averray Agent Deposit Pool Share";
    string public constant symbol = "avUSDC";
    uint8 public constant decimals = 6;

    uint256 public constant TOTAL_ASSET_CAP = 1_000e6;
    uint256 public constant PER_AGENT_ASSET_CAP = 100e6;
    uint256 public constant PLATFORM_FEE_BPS = 0;
    uint256 public constant NOTICE_7_DAYS = 7 days;
    uint256 public constant NOTICE_30_DAYS = 30 days;
    uint256 public constant DEPLOYMENT_EPOCH = 1 days;

    address public immutable asset;
    address public immutable operator;
    IDepositPoolVenueAdapter public immutable venueAdapter;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @notice Principal supplied by the operator through the dedicated capital entry.
    /// @dev Protocol-owned shares are minted alongside principal, while the principal
    ///      itself remains separately identifiable from earned fees.
    uint256 public operatorContributedPrincipal;
    uint256 public operatorPrincipalShares;

    /// @notice Earned protocol fees, kept separate from operator principal.
    /// @dev The launch fee is zero, so packet 1 intentionally has no write path here.
    uint256 public earnedProtocolFees;

    enum NoticeTier {
        Notice7Days,
        Notice30Days
    }

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
    mapping(uint256 => RedeemRequest) public redeemRequests;
    mapping(uint256 => VenueDeployment) public venueDeployments;
    mapping(uint256 => VenueRecall) public venueRecalls;

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

    modifier onlyOperator() {
        if (msg.sender != operator) revert Unauthorized();
        _;
    }

    constructor(address asset_, address operator_, IDepositPoolVenueAdapter venueAdapter_) {
        if (asset_ == address(0) || operator_ == address(0)) revert ZeroAddress();
        if (IERC20PoolAsset(asset_).decimals() != decimals) revert InvalidAssetDecimals();
        if (address(venueAdapter_) != address(0)) {
            if (address(venueAdapter_).code.length == 0 || venueAdapter_.asset() != asset_) {
                revert InvalidVenueAdapter();
            }
        }
        asset = asset_;
        operator = operator_;
        venueAdapter = venueAdapter_;
    }

    /// @notice Total depositor and protocol-owned assets, including the pinned venue.
    function totalAssets() public view returns (uint256 assets) {
        assets = bufferAssets();
        if (address(venueAdapter) != address(0)) {
            assets += venueAdapter.managedAssets(address(this));
        }
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
        return balanceOf[account] - lockedShares[account];
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
        _checkAgentCap(receiver, shares, managedBefore + assets, supplyBefore + shares);

        _mint(receiver, shares);
        _recordAgentShareHighWater(receiver);
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
        _checkAgentCap(receiver, shares, managedBefore + assets, supplyBefore + shares);

        _mint(receiver, shares);
        _recordAgentShareHighWater(receiver);
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
        if (shares == 0) revert ZeroShares();
        if (receiver == address(0) || owner == address(0)) revert ZeroAddress();
        if (msg.sender != owner) _spendAllowance(owner, msg.sender, shares);
        if (availableShares(owner) < shares) revert InsufficientUnlockedShares();

        assets = convertToAssets(shares);
        if (assets == 0) revert ZeroAmount();
        _redeemFromBuffer(msg.sender, receiver, owner, shares, assets);
    }

    /// @notice Lock the caller's shares for one of the two launch notice periods.
    function requestRedeem(uint256 shares, address receiver, NoticeTier tier) external returns (uint256 requestId) {
        if (shares == 0) revert ZeroShares();
        if (receiver == address(0)) revert ZeroAddress();
        if (availableShares(msg.sender) < shares) revert InsufficientUnlockedShares();

        uint256 period = tier == NoticeTier.Notice7Days ? NOTICE_7_DAYS : NOTICE_30_DAYS;
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
    /// @dev The shortest notice tier derives the maximum venue clock. The
    ///      caller names the exact earlier-or-equal deadline for the adapter.
    function deployToVenue(uint256 assets, uint64 returnBy)
        external
        onlyOperator
        nonReentrant
        returns (uint256 deploymentId)
    {
        if (address(venueAdapter) == address(0)) revert VenueNotConfigured();
        if (assets == 0) revert ZeroAmount();
        if (returnBy <= block.timestamp) revert InvalidReturnDeadline();
        uint64 maximumReturnBy = uint64(block.timestamp + NOTICE_7_DAYS);
        if (returnBy > maximumReturnBy) revert VenueDeadlineExceedsNoticeTier(returnBy, maximumReturnBy);
        if (activeVenueDeploymentId != 0) revert VenueDeploymentAlreadyActive();
        if (lastDeploymentEpochAt != 0 && block.timestamp < uint256(lastDeploymentEpochAt) + DEPLOYMENT_EPOCH) {
            revert DeploymentEpochNotElapsed(uint64(uint256(lastDeploymentEpochAt) + DEPLOYMENT_EPOCH));
        }

        uint256 available = bufferAssets();
        uint256 floor = bufferFloor();
        if (available < floor || assets > available - floor) revert BufferFloorBreached(available, floor, assets);

        deploymentId = nextVenueDeploymentId++;
        activeVenueDeploymentId = deploymentId;
        lastDeploymentEpochAt = uint64(block.timestamp);
        SafeTransfer.safeTransfer(asset, address(venueAdapter), assets);
        bytes32 adapterRequestId = venueAdapter.requestDeploy(assets, returnBy);
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

        settledAssets = venueAdapter.claimSettled(deployment.adapterRequestId);
        status = request.status;
        deployment.status = status;
        if (status == IDepositPoolVenueAdapter.RequestStatus.Failed && venueAdapter.managedAssets(address(this)) == 0) {
            activeVenueDeploymentId = 0;
        }
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
        if (returnedAssets != 0) {
            uint256 outstandingPrincipal = deployment.principalAssets - deployment.recalledPrincipalAssets;
            uint256 principalRecalled = returnedAssets < outstandingPrincipal ? returnedAssets : outstandingPrincipal;
            deployment.recalledPrincipalAssets += principalRecalled;
        }
        if (venueAdapter.managedAssets(address(this)) == 0) {
            if (status == IDepositPoolVenueAdapter.RequestStatus.Succeeded) {
                deployment.recalledPrincipalAssets = deployment.principalAssets;
            }
            activeVenueDeploymentId = 0;
        }
        emit VenueRecallSettled(recallId, recall.deploymentId, status, returnedAssets);
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
        totalSupply += shares;
        balanceOf[account] += shares;
        emit Transfer(address(0), account, shares);
    }

    function _burn(address account, uint256 shares) private {
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
