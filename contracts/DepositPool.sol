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
    }

    uint256 public nextRedeemRequestId = 1;
    uint256 public nextVenueDeploymentId = 1;
    mapping(address => uint256) public lockedShares;
    mapping(uint256 => RedeemRequest) public redeemRequests;
    mapping(uint256 => VenueDeployment) public venueDeployments;

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
    event VenueDeploymentCreated(uint256 indexed deploymentId, uint256 assets, uint64 returnBy);
    event VenueDeploymentRecalled(uint256 indexed deploymentId, uint256 principalAssets, uint256 returnedAssets);

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
    error VenueDeploymentNotFound();
    error VenueRecallExceedsPrincipal();
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

    /// @notice Deploy existing pool assets only to the immutable venue adapter.
    /// @param returnBy Pool-selected deadline for this exact principal commitment.
    function deployToVenue(uint256 assets, uint64 returnBy)
        external
        onlyOperator
        nonReentrant
        returns (uint256 deploymentId)
    {
        if (address(venueAdapter) == address(0)) revert VenueNotConfigured();
        if (assets == 0) revert ZeroAmount();
        if (returnBy <= block.timestamp) revert InvalidReturnDeadline();
        uint256 available = bufferAssets();
        if (available < assets) revert InsufficientBuffer(available, assets);

        deploymentId = nextVenueDeploymentId++;
        venueDeployments[deploymentId] =
            VenueDeployment({principalAssets: assets, recalledPrincipalAssets: 0, returnBy: returnBy});
        SafeTransfer.safeTransfer(asset, address(venueAdapter), assets);
        venueAdapter.deploy(assets, returnBy);
        emit VenueDeploymentCreated(deploymentId, assets, returnBy);
    }

    /// @notice Recall principal from a venue deployment into the pool buffer.
    function recallVenueDeployment(uint256 deploymentId, uint256 principalAssets)
        external
        onlyOperator
        nonReentrant
        returns (uint256 returnedAssets)
    {
        if (address(venueAdapter) == address(0)) revert VenueNotConfigured();
        if (principalAssets == 0) revert ZeroAmount();
        VenueDeployment storage deployment = venueDeployments[deploymentId];
        if (deployment.principalAssets == 0) revert VenueDeploymentNotFound();
        if (deployment.recalledPrincipalAssets + principalAssets > deployment.principalAssets) {
            revert VenueRecallExceedsPrincipal();
        }

        uint256 beforeBalance = bufferAssets();
        returnedAssets = venueAdapter.recall(principalAssets);
        uint256 received = bufferAssets() - beforeBalance;
        if (returnedAssets < principalAssets || received < principalAssets) {
            revert VenueRecallShortfall(received, principalAssets);
        }
        deployment.recalledPrincipalAssets += principalAssets;
        emit VenueDeploymentRecalled(deploymentId, principalAssets, received);
        return received;
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
