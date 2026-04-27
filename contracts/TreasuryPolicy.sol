// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract TreasuryPolicy {
    address public owner;
    /// @dev Separate hot-key role authorised to flip the pause bit without
    ///      requiring owner (multisig) signatures. Intentionally scoped to
    ///      exactly one capability — `setPaused` — so a compromised pauser
    ///      key can grief but cannot drain, reconfigure, or rotate roles.
    ///      Owner can rotate or revoke the pauser at any time.
    address public pauser;
    bool public paused;
    uint256 public dailyOutflowCap;
    uint256 public perAccountBorrowCap;
    uint256 public minimumCollateralRatioBps;
    uint16 public defaultClaimStakeBps;
    uint16 public claimFeeBps;
    uint16 public claimFeeVerifierBps;
    uint256 public onboardingWaiverClaimCount;
    uint256 public rejectionSkillPenalty;
    uint256 public rejectionReliabilityPenalty;
    uint256 public disputeLossSkillPenalty;
    uint256 public disputeLossReliabilityPenalty;

    struct AuthorizationWindow {
        uint64 since;
        uint64 until;
    }

    mapping(address => bool) public approvedAssets;
    mapping(address => bool) public approvedStrategies;
    mapping(address => bool) public serviceOperators;
    mapping(address => bool) public verifiers;
    mapping(address => uint64) public authorizedSince;
    mapping(address => uint64) public authorizedUntil;
    mapping(address => bool) public arbitrators;
    mapping(address => uint256) public minClaimFeeByAsset;
    mapping(address => AuthorizationWindow[]) internal verifierAuthorizationWindows;

    uint256 public currentDay;
    uint256 public outflowToday;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PauserUpdated(address indexed previousPauser, address indexed newPauser);
    event PauseUpdated(bool paused);
    event AssetApprovalUpdated(address indexed asset, bool approved);
    event StrategyApprovalUpdated(address indexed strategy, bool approved);
    event ServiceOperatorUpdated(address indexed operator, bool approved);
    event VerifierUpdated(address indexed verifier, bool approved);
    event ArbitratorUpdated(address indexed arbitrator, bool approved);
    event DailyOutflowCapUpdated(uint256 newCap);
    event PerAccountBorrowCapUpdated(uint256 newCap);
    event MinimumCollateralRatioUpdated(uint256 newRatioBps);
    event DefaultClaimStakeBpsUpdated(uint16 newClaimStakeBps);
    event ClaimFeeBpsUpdated(uint16 newClaimFeeBps);
    event ClaimFeeVerifierBpsUpdated(uint16 newClaimFeeVerifierBps);
    event OnboardingWaiverClaimCountUpdated(uint256 newClaimCount);
    event MinClaimFeeUpdated(address indexed asset, uint256 amount);
    event RejectionSkillPenaltyUpdated(uint256 newPenalty);
    event RejectionReliabilityPenaltyUpdated(uint256 newPenalty);
    event DisputeLossSkillPenaltyUpdated(uint256 newPenalty);
    event DisputeLossReliabilityPenaltyUpdated(uint256 newPenalty);
    event OutflowRecorded(uint256 day, uint256 amount, uint256 newTotal);

    error Unauthorized();
    error Paused();
    error OutflowCapExceeded();

    constructor() {
        owner = msg.sender;
        dailyOutflowCap = type(uint256).max;
        perAccountBorrowCap = type(uint256).max;
        minimumCollateralRatioBps = 15_000;
        defaultClaimStakeBps = 500;
        claimFeeBps = 200;
        claimFeeVerifierBps = 7_000;
        onboardingWaiverClaimCount = 3;
        rejectionSkillPenalty = 10;
        rejectionReliabilityPenalty = 20;
        disputeLossSkillPenalty = 30;
        disputeLossReliabilityPenalty = 50;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyOwnerOrPauser() {
        if (msg.sender != owner && msg.sender != pauser) revert Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "ZERO_ADDRESS");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Rotate the hot-key pauser. Passing address(0) disables pause
    ///         delegation so only the owner (multisig) can pause — useful if
    ///         the hot key is believed compromised and needs revocation.
    function setPauser(address newPauser) external onlyOwner {
        emit PauserUpdated(pauser, newPauser);
        pauser = newPauser;
    }

    function setPaused(bool newPaused) external onlyOwnerOrPauser {
        paused = newPaused;
        emit PauseUpdated(newPaused);
    }

    function setApprovedAsset(address asset, bool approved) external onlyOwner {
        approvedAssets[asset] = approved;
        emit AssetApprovalUpdated(asset, approved);
    }

    function setApprovedStrategy(address strategy, bool approved) external onlyOwner {
        approvedStrategies[strategy] = approved;
        emit StrategyApprovalUpdated(strategy, approved);
    }

    function setServiceOperator(address operator, bool approved) external onlyOwner {
        serviceOperators[operator] = approved;
        emit ServiceOperatorUpdated(operator, approved);
    }

    function setVerifier(address verifier, bool approved) external onlyOwner {
        uint64 timestamp = uint64(block.timestamp);
        if (approved == verifiers[verifier]) {
            emit VerifierUpdated(verifier, approved);
            return;
        }

        verifiers[verifier] = approved;
        if (approved) {
            authorizedSince[verifier] = timestamp;
            authorizedUntil[verifier] = 0;
            verifierAuthorizationWindows[verifier].push(AuthorizationWindow({since: timestamp, until: 0}));
        } else {
            authorizedUntil[verifier] = timestamp;
            uint256 windowCount = verifierAuthorizationWindows[verifier].length;
            if (windowCount > 0 && verifierAuthorizationWindows[verifier][windowCount - 1].until == 0) {
                verifierAuthorizationWindows[verifier][windowCount - 1].until = timestamp;
            }
        }
        emit VerifierUpdated(verifier, approved);
    }

    function verifierAuthorizationWindowCount(address verifier) external view returns (uint256) {
        return verifierAuthorizationWindows[verifier].length;
    }

    function verifierAuthorizationWindow(address verifier, uint256 index)
        external
        view
        returns (uint64 since, uint64 until)
    {
        AuthorizationWindow memory window = verifierAuthorizationWindows[verifier][index];
        return (window.since, window.until);
    }

    function wasAuthorizedAt(address verifier, uint64 timestamp) external view returns (bool) {
        AuthorizationWindow[] storage windows = verifierAuthorizationWindows[verifier];
        for (uint256 i = 0; i < windows.length; i++) {
            if (timestamp >= windows[i].since && (windows[i].until == 0 || timestamp < windows[i].until)) {
                return true;
            }
        }
        return false;
    }

    function setArbitrator(address arbitrator, bool approved) external onlyOwner {
        arbitrators[arbitrator] = approved;
        emit ArbitratorUpdated(arbitrator, approved);
    }

    function setDailyOutflowCap(uint256 cap) external onlyOwner {
        dailyOutflowCap = cap;
        emit DailyOutflowCapUpdated(cap);
    }

    function setPerAccountBorrowCap(uint256 cap) external onlyOwner {
        perAccountBorrowCap = cap;
        emit PerAccountBorrowCapUpdated(cap);
    }

    function setMinimumCollateralRatioBps(uint256 ratioBps) external onlyOwner {
        require(ratioBps >= 10_000, "LOW_RATIO");
        minimumCollateralRatioBps = ratioBps;
        emit MinimumCollateralRatioUpdated(ratioBps);
    }

    function setDefaultClaimStakeBps(uint16 claimStakeBps) external onlyOwner {
        require(claimStakeBps <= 10_000, "INVALID_BPS");
        defaultClaimStakeBps = claimStakeBps;
        emit DefaultClaimStakeBpsUpdated(claimStakeBps);
    }

    function setClaimFeeBps(uint16 feeBps) external onlyOwner {
        require(feeBps <= 10_000, "INVALID_BPS");
        claimFeeBps = feeBps;
        emit ClaimFeeBpsUpdated(feeBps);
    }

    function setClaimFeeVerifierBps(uint16 verifierBps) external onlyOwner {
        require(verifierBps <= 10_000, "INVALID_BPS");
        claimFeeVerifierBps = verifierBps;
        emit ClaimFeeVerifierBpsUpdated(verifierBps);
    }

    function setOnboardingWaiverClaimCount(uint256 claimCount) external onlyOwner {
        onboardingWaiverClaimCount = claimCount;
        emit OnboardingWaiverClaimCountUpdated(claimCount);
    }

    function setMinClaimFee(address asset, uint256 amount) external onlyOwner {
        minClaimFeeByAsset[asset] = amount;
        emit MinClaimFeeUpdated(asset, amount);
    }

    function setRejectionSkillPenalty(uint256 penalty) external onlyOwner {
        rejectionSkillPenalty = penalty;
        emit RejectionSkillPenaltyUpdated(penalty);
    }

    function setRejectionReliabilityPenalty(uint256 penalty) external onlyOwner {
        rejectionReliabilityPenalty = penalty;
        emit RejectionReliabilityPenaltyUpdated(penalty);
    }

    function setDisputeLossSkillPenalty(uint256 penalty) external onlyOwner {
        disputeLossSkillPenalty = penalty;
        emit DisputeLossSkillPenaltyUpdated(penalty);
    }

    function setDisputeLossReliabilityPenalty(uint256 penalty) external onlyOwner {
        disputeLossReliabilityPenalty = penalty;
        emit DisputeLossReliabilityPenaltyUpdated(penalty);
    }

    function recordOutflow(uint256 amount) external whenNotPaused {
        if (!serviceOperators[msg.sender]) revert Unauthorized();
        uint256 dayNumber = block.timestamp / 1 days;
        if (dayNumber != currentDay) {
            currentDay = dayNumber;
            outflowToday = 0;
        }
        outflowToday += amount;
        if (outflowToday > dailyOutflowCap) revert OutflowCapExceeded();
        emit OutflowRecorded(dayNumber, amount, outflowToday);
    }
}
