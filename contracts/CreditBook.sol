// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentAccountCore} from "./AgentAccountCore.sol";
import {TreasuryPolicy} from "./TreasuryPolicy.sol";
import {ReentrancyGuard} from "./lib/ReentrancyGuard.sol";
import {SafeTransfer} from "./lib/SafeTransfer.sol";

/// @title Averray receipt-graph credit book
/// @notice Operator-seeded, zero-interest pilot book for receipt-graph cash
///         lines and purpose-bound job-posting credit.
/// @dev The platform underwrites the borrower off-chain. This contract only
///      enforces the book schedule, immutable ceilings, terms commitment, and
///      value movement through AgentAccountCore. Repayment sweeps arrive via
///      AgentAccountCore.sendToAgentFor before the operator records them here.
contract CreditBook is ReentrancyGuard {
    uint256 public constant PER_WALLET_CAP_CEILING_RAW = 100_000_000;
    uint256 public constant BOOK_CAP_CEILING_RAW = 250_000_000;
    uint256 public constant INTEREST_BPS_CEILING = 2_000;
    uint256 public constant BPS = 10_000;
    uint8 public constant ASSET_DECIMALS = 6;

    TreasuryPolicy public immutable policy;
    AgentAccountCore public immutable accounts;
    address public immutable asset;
    address public immutable operator;

    enum Mode {
        CASH,
        POSTING
    }

    struct Loan {
        address borrower;
        Mode mode;
        uint256 principalRaw;
        uint256 outstandingRaw;
        bytes32 termsHash;
        uint64 originatedAt;
        uint64 closedAt;
    }

    uint256 public cashPerWalletCapRaw = 25_000_000;
    uint256 public postingPerWalletCapRaw = 25_000_000;
    uint256 public bookCapRaw = 50_000_000;
    uint256 public interestBps;
    uint256 public repayBps = 5_000;
    uint256 public totalOutstandingRaw;
    uint256 public accountedLiquidityRaw;
    bool public l3Enabled;
    address public l3PosterWallet;

    mapping(address => bool) public l3PosterAllowlisted;
    mapping(address => uint256) public nextLoanNonce;
    mapping(address => mapping(Mode => uint256)) public outstandingByModeRaw;
    mapping(address => mapping(Mode => bytes32)) public activeLoanByMode;
    mapping(bytes32 => Loan) public loans;

    event Seeded(address indexed operator, uint256 amountRaw, uint256 accountedLiquidityRaw);
    event LoanOriginated(
        bytes32 indexed loanId,
        address indexed borrower,
        Mode indexed mode,
        uint256 principalRaw,
        address recipient,
        bytes32 termsHash
    );
    event LoanRepaid(bytes32 indexed loanId, address indexed payer, uint256 amountRaw, uint256 outstandingRaw);
    event LoanClosed(bytes32 indexed loanId, address indexed borrower, Mode indexed mode);
    event SweepRepaymentRecorded(bytes32 indexed loanId, uint256 amountRaw, uint256 outstandingRaw);
    event PostingRefundRepaymentRecorded(bytes32 indexed loanId, uint256 amountRaw);
    event PerWalletCapChanged(Mode indexed mode, uint256 previousRaw, uint256 currentRaw);
    event BookCapChanged(uint256 previousRaw, uint256 currentRaw);
    event InterestBpsChanged(uint256 previousBps, uint256 currentBps);
    event RepayBpsChanged(uint256 previousBps, uint256 currentBps);
    event L3EnabledChanged(bool enabled);
    event L3PosterAllowlistChanged(address indexed wallet, bool allowed);
    event L3PosterWalletChanged(address indexed previousWallet, address indexed currentWallet);

    error Unauthorized();
    error ZeroAddress();
    error ZeroAmount();
    error InvalidTermsHash();
    error InvalidSchedule();
    error L3Disabled();
    error L3PosterNotAllowed();
    error ActiveLoanExists(bytes32 loanId);
    error LoanNotActive();
    error InvalidLoanMode();
    error PerWalletCapExceeded(uint256 attempted, uint256 cap);
    error BookCapExceeded(uint256 attempted, uint256 cap);
    error InsufficientBookLiquidity(uint256 available, uint256 required);
    error RepaymentExceedsOutstanding(uint256 attempted, uint256 outstanding);
    error UnfundedRepayment(uint256 observedLiquidity, uint256 requiredLiquidity);

    modifier onlyOperator() {
        if (msg.sender != operator) revert Unauthorized();
        _;
    }

    modifier onlyPolicyOwner() {
        if (msg.sender != policy.owner()) revert Unauthorized();
        _;
    }

    constructor(
        TreasuryPolicy policy_,
        AgentAccountCore accounts_,
        address asset_,
        address operator_,
        address initialL3PosterWallet_
    ) {
        if (
            address(policy_) == address(0) || address(accounts_) == address(0) || asset_ == address(0)
                || operator_ == address(0)
        ) revert ZeroAddress();
        if (address(policy_).code.length == 0 || address(accounts_).code.length == 0 || asset_.code.length == 0) {
            revert ZeroAddress();
        }
        policy = policy_;
        accounts = accounts_;
        asset = asset_;
        operator = operator_;
        if (initialL3PosterWallet_ != address(0)) {
            l3PosterAllowlisted[initialL3PosterWallet_] = true;
            l3PosterWallet = initialL3PosterWallet_;
            emit L3PosterAllowlistChanged(initialL3PosterWallet_, true);
            emit L3PosterWalletChanged(address(0), initialL3PosterWallet_);
        }
    }

    function previewLoanId(address borrower) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), borrower, nextLoanNonce[borrower]));
    }

    function perWalletCapRaw(Mode mode) public view returns (uint256) {
        return mode == Mode.CASH ? cashPerWalletCapRaw : postingPerWalletCapRaw;
    }

    function bookLiquidRaw() public view returns (uint256 liquid) {
        (liquid,,,,,) = accounts.positions(address(this), asset);
    }

    function seed(uint256 amountRaw) external onlyOperator nonReentrant {
        if (amountRaw == 0) revert ZeroAmount();
        uint256 managedAfter = accountedLiquidityRaw + totalOutstandingRaw + amountRaw;
        if (managedAfter > bookCapRaw) revert BookCapExceeded(managedAfter, bookCapRaw);

        SafeTransfer.safeTransferFrom(asset, msg.sender, address(this), amountRaw);
        SafeTransfer.safeApprove(asset, address(accounts), 0);
        SafeTransfer.safeApprove(asset, address(accounts), amountRaw);
        accounts.deposit(asset, amountRaw);
        accountedLiquidityRaw += amountRaw;
        emit Seeded(msg.sender, amountRaw, accountedLiquidityRaw);
    }

    function originate(address borrower, uint256 amountRaw, Mode mode, bytes32 termsHash)
        external
        onlyOperator
        nonReentrant
        returns (bytes32 loanId)
    {
        if (borrower == address(0)) revert ZeroAddress();
        if (amountRaw == 0) revert ZeroAmount();
        if (termsHash == bytes32(0)) revert InvalidTermsHash();
        // The pilot implements zero-interest debt only. The bounded schedule
        // knob can be staged by policy, but non-zero economics require the
        // separately-gated follow-on before any new loan may originate.
        if (interestBps != 0) revert InvalidSchedule();
        bytes32 existing = activeLoanByMode[borrower][mode];
        if (existing != bytes32(0)) revert ActiveLoanExists(existing);

        uint256 walletOutstandingAfter = outstandingByModeRaw[borrower][mode] + amountRaw;
        uint256 walletCap = perWalletCapRaw(mode);
        if (walletOutstandingAfter > walletCap) {
            revert PerWalletCapExceeded(walletOutstandingAfter, walletCap);
        }
        uint256 bookOutstandingAfter = totalOutstandingRaw + amountRaw;
        if (bookOutstandingAfter > bookCapRaw) revert BookCapExceeded(bookOutstandingAfter, bookCapRaw);
        if (accountedLiquidityRaw < amountRaw) {
            revert InsufficientBookLiquidity(accountedLiquidityRaw, amountRaw);
        }

        address recipient = borrower;
        if (mode == Mode.POSTING) {
            if (!l3Enabled) revert L3Disabled();
            recipient = l3PosterWallet;
            if (recipient == address(0) || !l3PosterAllowlisted[recipient]) revert L3PosterNotAllowed();
        }

        loanId = previewLoanId(borrower);
        nextLoanNonce[borrower] += 1;
        loans[loanId] = Loan({
            borrower: borrower,
            mode: mode,
            principalRaw: amountRaw,
            outstandingRaw: amountRaw,
            termsHash: termsHash,
            originatedAt: uint64(block.timestamp),
            closedAt: 0
        });
        activeLoanByMode[borrower][mode] = loanId;
        outstandingByModeRaw[borrower][mode] = walletOutstandingAfter;
        totalOutstandingRaw = bookOutstandingAfter;
        accountedLiquidityRaw -= amountRaw;

        accounts.sendToAgent(recipient, asset, amountRaw);
        emit LoanOriginated(loanId, borrower, mode, amountRaw, recipient, termsHash);
    }

    function repay(bytes32 loanId, uint256 amountRaw) external nonReentrant {
        Loan storage loan = _activeLoan(loanId);
        if (amountRaw == 0) revert ZeroAmount();
        if (amountRaw > loan.outstandingRaw) {
            revert RepaymentExceedsOutstanding(amountRaw, loan.outstandingRaw);
        }

        SafeTransfer.safeTransferFrom(asset, msg.sender, address(this), amountRaw);
        SafeTransfer.safeApprove(asset, address(accounts), 0);
        SafeTransfer.safeApprove(asset, address(accounts), amountRaw);
        accounts.deposit(asset, amountRaw);
        accountedLiquidityRaw += amountRaw;
        _recordRepayment(loanId, loan, amountRaw, msg.sender);
    }

    /// @notice Record a borrower-authorized AAC sweep after the shared
    ///         /admin/agent-transfers transport has moved value into this book.
    function recordSweepRepayment(bytes32 loanId, uint256 amountRaw) external onlyOperator nonReentrant {
        Loan storage loan = _activeLoan(loanId);
        if (amountRaw == 0) revert ZeroAmount();
        if (amountRaw > loan.outstandingRaw) {
            revert RepaymentExceedsOutstanding(amountRaw, loan.outstandingRaw);
        }
        _consumeUnaccountedLiquidity(amountRaw);
        _recordRepayment(loanId, loan, amountRaw, loan.borrower);
        emit SweepRepaymentRecorded(loanId, amountRaw, loan.outstandingRaw);
    }

    /// @notice Close a posting loan after a cancelled job's refund has first
    ///         been consent-transferred from the poster identity to the book.
    function repayFromRefund(bytes32 loanId) external onlyOperator nonReentrant {
        Loan storage loan = _activeLoan(loanId);
        if (loan.mode != Mode.POSTING) revert InvalidLoanMode();
        uint256 amountRaw = loan.outstandingRaw;
        _consumeUnaccountedLiquidity(amountRaw);
        _recordRepayment(loanId, loan, amountRaw, l3PosterWallet);
        emit PostingRefundRepaymentRecorded(loanId, amountRaw);
    }

    function setPerWalletCapRaw(Mode mode, uint256 newCapRaw) external onlyPolicyOwner {
        if (newCapRaw == 0 || newCapRaw > PER_WALLET_CAP_CEILING_RAW) revert InvalidSchedule();
        uint256 previous = perWalletCapRaw(mode);
        if (mode == Mode.CASH) cashPerWalletCapRaw = newCapRaw;
        else postingPerWalletCapRaw = newCapRaw;
        emit PerWalletCapChanged(mode, previous, newCapRaw);
    }

    function setBookCapRaw(uint256 newCapRaw) external onlyPolicyOwner {
        uint256 managed = accountedLiquidityRaw + totalOutstandingRaw;
        if (newCapRaw == 0 || newCapRaw > BOOK_CAP_CEILING_RAW || newCapRaw < managed) {
            revert InvalidSchedule();
        }
        emit BookCapChanged(bookCapRaw, newCapRaw);
        bookCapRaw = newCapRaw;
    }

    function setInterestBps(uint256 newInterestBps) external onlyPolicyOwner {
        if (newInterestBps > INTEREST_BPS_CEILING) revert InvalidSchedule();
        emit InterestBpsChanged(interestBps, newInterestBps);
        interestBps = newInterestBps;
    }

    function setRepayBps(uint256 newRepayBps) external onlyPolicyOwner {
        if (newRepayBps == 0 || newRepayBps > BPS) revert InvalidSchedule();
        emit RepayBpsChanged(repayBps, newRepayBps);
        repayBps = newRepayBps;
    }

    function setL3Enabled(bool enabled) external onlyPolicyOwner {
        l3Enabled = enabled;
        emit L3EnabledChanged(enabled);
    }

    function setL3PosterAllowlisted(address wallet, bool allowed) external onlyPolicyOwner {
        if (wallet == address(0)) revert ZeroAddress();
        l3PosterAllowlisted[wallet] = allowed;
        emit L3PosterAllowlistChanged(wallet, allowed);
    }

    function setL3PosterWallet(address wallet) external onlyPolicyOwner {
        if (wallet == address(0)) revert ZeroAddress();
        if (!l3PosterAllowlisted[wallet]) revert L3PosterNotAllowed();
        emit L3PosterWalletChanged(l3PosterWallet, wallet);
        l3PosterWallet = wallet;
    }

    function _consumeUnaccountedLiquidity(uint256 amountRaw) internal {
        uint256 observed = bookLiquidRaw();
        uint256 required = accountedLiquidityRaw + amountRaw;
        if (observed < required) revert UnfundedRepayment(observed, required);
        accountedLiquidityRaw = required;
    }

    function _activeLoan(bytes32 loanId) internal view returns (Loan storage loan) {
        loan = loans[loanId];
        if (loan.borrower == address(0) || loan.closedAt != 0 || loan.outstandingRaw == 0) revert LoanNotActive();
    }

    function _recordRepayment(bytes32 loanId, Loan storage loan, uint256 amountRaw, address payer) internal {
        loan.outstandingRaw -= amountRaw;
        outstandingByModeRaw[loan.borrower][loan.mode] -= amountRaw;
        totalOutstandingRaw -= amountRaw;
        emit LoanRepaid(loanId, payer, amountRaw, loan.outstandingRaw);
        if (loan.outstandingRaw == 0) {
            loan.closedAt = uint64(block.timestamp);
            activeLoanByMode[loan.borrower][loan.mode] = bytes32(0);
            emit LoanClosed(loanId, loan.borrower, loan.mode);
        }
    }
}
