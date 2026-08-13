// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDepositPoolPledge} from "./interfaces/IDepositPoolPledge.sol";
import {ReentrancyGuard} from "./lib/ReentrancyGuard.sol";
import {SafeTransfer} from "./lib/SafeTransfer.sol";

interface IERC20CreditAsset {
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// @title Averray Agent Credit Pool
/// @notice Peer-to-pool, self-custodied L1 USDC credit against pledged
///         DepositPool v2 shares. The pilot is zero-interest by default.
/// @dev Vested capacity is a platform-derived event-history fact. Origination
///      therefore carries a short-lived operator attestation bound to the
///      borrower, exact loan terms, and one-use nonce. The operator attests
///      eligibility; it never signs or relays the borrower's transaction.
contract CreditPool is ReentrancyGuard {
    string public constant name = "Averray Agent Credit Pool Share";
    string public constant symbol = "avCreditUSDC";
    string public constant RISK_DISCLOSURE = "Technical pilot. Principal at risk. No depositor protection.";
    uint8 public constant decimals = 6;

    uint256 public constant TOTAL_ASSET_CAP = 250_000_000;
    uint256 public constant PER_LENDER_CAP = 100_000_000;
    uint256 public constant PLATFORM_FEE_BPS = 0;
    uint256 public constant MAX_LTV_BPS = 9_000;
    uint256 public constant MAX_INTEREST_BPS = 2_000;
    uint256 public constant IMPAIRMENT_NUMERATOR = 105;
    uint256 public constant IMPAIRMENT_DENOMINATOR = 100;
    uint256 public constant NOTICE_7_DAYS = 7 days;
    uint256 public constant NOTICE_30_DAYS = 30 days;

    bytes32 public constant VESTING_ATTESTATION_TYPEHASH = keccak256(
        "VestingAttestation(address borrower,bytes32 loanId,uint256 pledgeShares,uint256 amount,uint256 vestedRaw,uint64 validUntil,uint256 nonce,uint256 chainId,address creditPool)"
    );

    address public immutable asset;
    address public immutable operator;
    IDepositPoolPledge public immutable depositPool;

    uint256 public ltvBps = 8_000;
    uint256 public interestBps;
    uint256 public totalSupply;
    uint256 public principalOutstanding;
    uint256 public operatorContributedPrincipal;
    uint256 public operatorPrincipalShares;
    uint256 public totalPledgedShares;
    uint256 public defaults;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public outstandingDebt;
    mapping(address => uint256) public nextLoanNonce;
    mapping(address => uint256) public vestingAttestationNonces;
    mapping(address => uint256) public lockedShares;

    enum NoticeTier {
        Notice7Days,
        Notice30Days
    }

    enum LoanStatus {
        None,
        Active,
        Repaid,
        Seized
    }

    struct RedeemRequest {
        address owner;
        address receiver;
        uint256 shares;
        uint64 unlockAt;
        NoticeTier tier;
        bool fulfilled;
    }

    struct Loan {
        address borrower;
        uint256 principal;
        uint256 outstandingPrincipal;
        uint256 outstandingInterest;
        uint256 pledgeShares;
        uint256 vestedRawAtOrigination;
        uint16 interestBpsAtOrigination;
        LoanStatus status;
    }

    uint256 public nextRedeemRequestId = 1;
    mapping(uint256 => RedeemRequest) public redeemRequests;
    mapping(bytes32 => Loan) public loans;

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
    event LoanOriginated(bytes32 indexed loanId, address indexed borrower, uint256 amount, uint256 pledgedShares);
    event LoanRepaid(bytes32 indexed loanId, uint256 amount, uint256 outstanding);
    event LoanClosed(bytes32 indexed loanId);
    event PledgeSeized(bytes32 indexed loanId, uint256 value);
    event LtvBpsChanged(uint256 previousBps, uint256 newBps);
    event InterestBpsChanged(uint256 previousBps, uint256 newBps);

    error Unauthorized();
    error ZeroAddress();
    error ZeroAmount();
    error ZeroShares();
    error InvalidAssetDecimals();
    error InvalidDepositPool();
    error SharesNonTransferable();
    error InsufficientUnlockedShares();
    error InsufficientBuffer(uint256 available, uint256 required);
    error TotalAssetCapExceeded(uint256 attempted, uint256 cap);
    error LenderAssetCapExceeded(address lender, uint256 attempted, uint256 cap);
    error NoticeNotElapsed(uint64 unlockAt);
    error RedeemRequestNotFound();
    error RedeemRequestAlreadyFulfilled();
    error InvalidSchedule();
    error InvalidPledge();
    error LoanAlreadyExists();
    error LoanNotActive();
    error LoanLimitExceeded(uint256 requested, uint256 maximum);
    error InvalidVestingAttestation();
    error VestingAttestationExpired(uint64 validUntil);
    error RepaymentExceedsOutstanding(uint256 attempted, uint256 outstanding);
    error CollateralNotImpaired(uint256 collateralValue, uint256 impairmentThreshold);
    error AssetTransferAmountMismatch();

    modifier onlyOperator() {
        if (msg.sender != operator) revert Unauthorized();
        _;
    }

    constructor(address asset_, address operator_, IDepositPoolPledge depositPool_) {
        if (asset_ == address(0) || operator_ == address(0) || address(depositPool_) == address(0)) {
            revert ZeroAddress();
        }
        if (IERC20CreditAsset(asset_).decimals() != decimals) revert InvalidAssetDecimals();
        if (address(depositPool_).code.length == 0 || depositPool_.asset() != asset_) revert InvalidDepositPool();
        asset = asset_;
        operator = operator_;
        depositPool = depositPool_;
    }

    function totalAssets() public view returns (uint256) {
        return bufferAssets() + principalOutstanding;
    }

    function bufferAssets() public view returns (uint256) {
        return IERC20CreditAsset(asset).balanceOf(address(this));
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
        return assets * supply / managed;
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        uint256 supply = totalSupply;
        if (supply == 0) return shares;
        return shares * totalAssets() / supply;
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
        if (receiver == address(0) || receiver == address(this)) revert ZeroAddress();
        uint256 managedBefore = totalAssets();
        uint256 supplyBefore = totalSupply;
        _checkCaps(receiver, assets, managedBefore, supplyBefore);
        shares = _convertToShares(assets, managedBefore, supplyBefore);
        if (shares == 0) revert ZeroShares();
        _mint(receiver, shares);
        _collectAssets(msg.sender, assets);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function contributeOperatorPrincipal(uint256 assets) external onlyOperator nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        uint256 managedBefore = totalAssets();
        uint256 supplyBefore = totalSupply;
        uint256 attempted = managedBefore + assets;
        if (attempted > TOTAL_ASSET_CAP) revert TotalAssetCapExceeded(attempted, TOTAL_ASSET_CAP);
        shares = _convertToShares(assets, managedBefore, supplyBefore);
        if (shares == 0) revert ZeroShares();
        operatorContributedPrincipal += assets;
        operatorPrincipalShares += shares;
        _mint(address(this), shares);
        _collectAssets(msg.sender, assets);
        emit OperatorPrincipalContributed(assets, shares, operatorContributedPrincipal);
    }

    function redeem(uint256 shares, address receiver, address owner) external nonReentrant returns (uint256 assets) {
        if (shares == 0) revert ZeroShares();
        if (receiver == address(0) || owner == address(0)) revert ZeroAddress();
        if (msg.sender != owner) _spendAllowance(owner, msg.sender, shares);
        if (availableShares(owner) < shares) revert InsufficientUnlockedShares();
        assets = convertToAssets(shares);
        if (assets == 0) revert ZeroAmount();
        _redeemFromBuffer(msg.sender, receiver, owner, shares, assets);
    }

    function requestRedeem(uint256 shares, address receiver, NoticeTier tier) external returns (uint256 requestId) {
        if (shares == 0) revert ZeroShares();
        if (receiver == address(0)) revert ZeroAddress();
        if (availableShares(msg.sender) < shares) revert InsufficientUnlockedShares();
        uint256 period = tier == NoticeTier.Notice7Days ? NOTICE_7_DAYS : NOTICE_30_DAYS;
        uint64 unlockAt = uint64(block.timestamp + period);
        requestId = nextRedeemRequestId++;
        lockedShares[msg.sender] += shares;
        redeemRequests[requestId] = RedeemRequest(msg.sender, receiver, shares, unlockAt, tier, false);
        emit RedeemRequested(requestId, msg.sender, receiver, shares, tier, unlockAt);
    }

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

    function previewLoanId(address borrower) public view returns (bytes32) {
        return keccak256(abi.encodePacked(block.chainid, address(this), borrower, nextLoanNonce[borrower]));
    }

    function vestingAttestationDigest(
        address borrower,
        bytes32 loanId,
        uint256 pledgeShares,
        uint256 amount,
        uint256 vestedRaw,
        uint64 validUntil,
        uint256 nonce
    ) public view returns (bytes32) {
        bytes32 payload = keccak256(
            abi.encode(
                VESTING_ATTESTATION_TYPEHASH,
                borrower,
                loanId,
                pledgeShares,
                amount,
                vestedRaw,
                validUntil,
                nonce,
                block.chainid,
                address(this)
            )
        );
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", payload));
    }

    function originate(
        uint256 pledgeShares,
        uint256 amount,
        uint256 vestedRaw,
        uint64 validUntil,
        bytes calldata vestingSignature
    ) external nonReentrant returns (bytes32 loanId) {
        if (pledgeShares == 0) revert ZeroShares();
        if (amount == 0) revert ZeroAmount();
        loanId = previewLoanId(msg.sender);
        if (loans[loanId].status != LoanStatus.None) revert LoanAlreadyExists();
        (address pledgeOwner, uint256 recordedShares, bool active) = depositPool.pledges(loanId);
        if (!active || pledgeOwner != msg.sender || recordedShares != pledgeShares) revert InvalidPledge();
        if (block.timestamp > validUntil) revert VestingAttestationExpired(validUntil);
        uint256 attestationNonce = vestingAttestationNonces[msg.sender];
        bytes32 digest =
            vestingAttestationDigest(msg.sender, loanId, pledgeShares, amount, vestedRaw, validUntil, attestationNonce);
        if (_recover(digest, vestingSignature) != operator) revert InvalidVestingAttestation();

        // Vested capacity is wallet-wide, not reusable per loan. Use every
        // currently pledged share (including this loan's already-recorded
        // pledge), then subtract all debt already open for the borrower. A
        // per-loan check would let a wallet pledge two tranches and borrow the
        // same D0 standing twice.
        uint256 aggregatePledgedAssetValue = depositPool.convertToAssets(depositPool.pledgedShares(msg.sender));
        uint256 collateralBase = aggregatePledgedAssetValue < vestedRaw ? aggregatePledgedAssetValue : vestedRaw;
        uint256 grossMaximum = collateralBase * ltvBps / 10_000;
        uint256 existingDebt = outstandingDebt[msg.sender];
        uint256 maximum = grossMaximum > existingDebt ? grossMaximum - existingDebt : 0;
        if (amount > maximum) revert LoanLimitExceeded(amount, maximum);
        uint256 available = bufferAssets();
        if (available < amount) revert InsufficientBuffer(available, amount);

        uint256 originationInterest = amount * interestBps / 10_000;
        loans[loanId] = Loan({
            borrower: msg.sender,
            principal: amount,
            outstandingPrincipal: amount,
            outstandingInterest: originationInterest,
            pledgeShares: pledgeShares,
            vestedRawAtOrigination: vestedRaw,
            interestBpsAtOrigination: uint16(interestBps),
            status: LoanStatus.Active
        });
        nextLoanNonce[msg.sender] += 1;
        vestingAttestationNonces[msg.sender] = attestationNonce + 1;
        principalOutstanding += amount;
        outstandingDebt[msg.sender] += amount + originationInterest;
        totalPledgedShares += pledgeShares;
        SafeTransfer.safeTransfer(asset, msg.sender, amount);
        emit LoanOriginated(loanId, msg.sender, amount, pledgeShares);
    }

    /// @notice Release a pledge whose second-step origination never succeeded.
    /// @dev Active loans cannot use this path; their pledge releases only on
    ///      full repayment or is seized after impairment.
    function cancelUnusedPledge(bytes32 loanId) external {
        if (loans[loanId].status != LoanStatus.None) revert LoanAlreadyExists();
        (address pledgeOwner,, bool active) = depositPool.pledges(loanId);
        if (!active || pledgeOwner != msg.sender) revert InvalidPledge();
        depositPool.release(loanId);
    }

    function repay(bytes32 loanId, uint256 amount) external nonReentrant {
        Loan storage loan = loans[loanId];
        if (loan.status != LoanStatus.Active) revert LoanNotActive();
        if (amount == 0) revert ZeroAmount();
        uint256 totalOutstanding = loan.outstandingPrincipal + loan.outstandingInterest;
        if (amount > totalOutstanding) revert RepaymentExceedsOutstanding(amount, totalOutstanding);
        _collectAssets(msg.sender, amount);

        uint256 interestPaid = amount < loan.outstandingInterest ? amount : loan.outstandingInterest;
        loan.outstandingInterest -= interestPaid;
        uint256 principalPaid = amount - interestPaid;
        if (principalPaid != 0) {
            loan.outstandingPrincipal -= principalPaid;
            principalOutstanding -= principalPaid;
        }
        outstandingDebt[loan.borrower] -= amount;
        uint256 remaining = loan.outstandingPrincipal + loan.outstandingInterest;
        emit LoanRepaid(loanId, amount, remaining);
        if (remaining == 0) {
            loan.status = LoanStatus.Repaid;
            totalPledgedShares -= loan.pledgeShares;
            depositPool.release(loanId);
            emit LoanClosed(loanId);
        }
    }

    function seize(bytes32 loanId) external nonReentrant returns (uint256 value) {
        Loan storage loan = loans[loanId];
        if (loan.status != LoanStatus.Active) revert LoanNotActive();
        uint256 collateralValue = depositPool.convertToAssets(loan.pledgeShares);
        uint256 totalOutstanding = loan.outstandingPrincipal + loan.outstandingInterest;
        uint256 threshold = totalOutstanding * IMPAIRMENT_NUMERATOR / IMPAIRMENT_DENOMINATOR;
        if (collateralValue >= threshold) revert CollateralNotImpaired(collateralValue, threshold);
        value = depositPool.seize(loanId, address(this));
        principalOutstanding -= loan.outstandingPrincipal;
        outstandingDebt[loan.borrower] -= loan.outstandingPrincipal + loan.outstandingInterest;
        loan.outstandingPrincipal = 0;
        loan.outstandingInterest = 0;
        loan.status = LoanStatus.Seized;
        totalPledgedShares -= loan.pledgeShares;
        defaults += 1;
        emit PledgeSeized(loanId, value);
        emit LoanClosed(loanId);
    }

    function setLtvBps(uint256 newBps) external onlyOperator {
        if (newBps == 0 || newBps > MAX_LTV_BPS) revert InvalidSchedule();
        uint256 previous = ltvBps;
        ltvBps = newBps;
        emit LtvBpsChanged(previous, newBps);
    }

    function setInterestBps(uint256 newBps) external onlyOperator {
        if (newBps > MAX_INTEREST_BPS) revert InvalidSchedule();
        uint256 previous = interestBps;
        interestBps = newBps;
        emit InterestBpsChanged(previous, newBps);
    }

    function _checkCaps(address receiver, uint256 assets, uint256 managedBefore, uint256 supplyBefore) private view {
        uint256 attemptedTotal = managedBefore + assets;
        if (attemptedTotal > TOTAL_ASSET_CAP) revert TotalAssetCapExceeded(attemptedTotal, TOTAL_ASSET_CAP);
        uint256 shares = _convertToShares(assets, managedBefore, supplyBefore);
        uint256 attemptedLender = supplyBefore + shares == 0
            ? assets
            : (balanceOf[receiver] + shares) * attemptedTotal / (supplyBefore + shares);
        if (attemptedLender > PER_LENDER_CAP) {
            revert LenderAssetCapExceeded(receiver, attemptedLender, PER_LENDER_CAP);
        }
    }

    function _convertToShares(uint256 assets, uint256 managed, uint256 supply) private pure returns (uint256) {
        if (supply == 0) return assets;
        if (managed == 0) return 0;
        return assets * supply / managed;
    }

    function _collectAssets(address from, uint256 assets) private {
        uint256 beforeBalance = bufferAssets();
        SafeTransfer.safeTransferFrom(asset, from, address(this), assets);
        if (bufferAssets() - beforeBalance != assets) revert AssetTransferAmountMismatch();
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

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address recovered) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        // Reject malleable high-s signatures (EIP-2).
        if (uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0) return address(0);
        recovered = ecrecover(digest, v, r, s);
    }
}
