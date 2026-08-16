// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {AgentAccountCore} from "../contracts/AgentAccountCore.sol";
import {CreditBook} from "../contracts/CreditBook.sol";
import {StrategyAdapterRegistry} from "../contracts/StrategyAdapterRegistry.sol";
import {TreasuryPolicy} from "../contracts/TreasuryPolicy.sol";

interface VmCreditBook {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata revertData) external;
}

contract CreditBookTest is Test {
    VmCreditBook internal constant vmCredit = VmCreditBook(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant USDC = 1e6;
    uint256 internal constant BORROWER_KEY = 0xB0B;
    uint256 internal constant POSTER_KEY = 0xA11CE;

    CreditBookMockUsdc internal asset;
    TreasuryPolicy internal policy;
    StrategyAdapterRegistry internal registry;
    AgentAccountCore internal accounts;
    CreditBook internal book;
    address internal borrower;
    address internal poster;
    address internal settlementSource = address(0x5151);

    function setUp() public {
        borrower = vmCredit.addr(BORROWER_KEY);
        poster = vmCredit.addr(POSTER_KEY);
        asset = new CreditBookMockUsdc();
        policy = new TreasuryPolicy();
        policy.setApprovedAsset(address(asset), true);
        policy.setSettlementBroker(address(this), true);
        policy.setAgentTransferBroker(address(this), true);
        registry = new StrategyAdapterRegistry(policy);
        accounts = new AgentAccountCore(policy, registry);
        policy.setOutflowRecorder(address(accounts), true);
        accounts.setEscrowOperator(address(this), true);
        book = new CreditBook(policy, accounts, address(asset), address(this), poster);

        asset.mint(address(this), 250 * USDC);
        asset.approve(address(book), type(uint256).max);
        book.seed(50 * USDC);
    }

    function testCashOriginationSettlementSweepCloseAndWithdrawal() public {
        bytes32 termsHash = keccak256("cash-terms");
        bytes32 loanId = book.originate(borrower, USDC, CreditBook.Mode.CASH, termsHash);
        (uint256 borrowerLiquid,,,,,) = accounts.positions(borrower, address(asset));
        assertEq(borrowerLiquid, USDC);

        _settleTo(borrower, 2 * USDC);
        uint256 sweepRaw = 2 * USDC * book.repayBps() / book.BPS();
        assertEq(sweepRaw, USDC);
        _consentedTransfer(BORROWER_KEY, borrower, address(book), sweepRaw, 1, block.timestamp + 1 days);
        book.recordSweepRepayment(loanId, sweepRaw);

        (,,, uint256 outstandingRaw,,, uint64 closedAt) = book.loans(loanId);
        assertEq(outstandingRaw, 0);
        require(closedAt > 0, "loan did not close");
        assertEq(book.totalOutstandingRaw(), 0);

        (borrowerLiquid,,,,,) = accounts.positions(borrower, address(asset));
        assertEq(borrowerLiquid, 2 * USDC);
        vm.prank(borrower);
        accounts.withdraw(address(asset), borrowerLiquid);
        assertEq(asset.balanceOf(borrower), borrowerLiquid);
    }

    function testPostingDisabledThenRefundClosesWithoutPayingBorrower() public {
        bytes32 termsHash = keccak256("posting-terms");
        vmCredit.expectRevert(CreditBook.L3Disabled.selector);
        book.originate(borrower, 2 * USDC, CreditBook.Mode.POSTING, termsHash);

        book.setL3Enabled(true);
        bytes32 loanId = book.originate(borrower, 2 * USDC, CreditBook.Mode.POSTING, termsHash);
        (uint256 borrowerLiquid,,,,,) = accounts.positions(borrower, address(asset));
        (uint256 posterLiquid,,,,,) = accounts.positions(poster, address(asset));
        assertEq(borrowerLiquid, 0);
        assertEq(posterLiquid, 2 * USDC);

        accounts.reserveForJob(poster, address(asset), 2 * USDC);
        accounts.refundReserved(poster, address(asset), 2 * USDC);
        _consentedTransfer(POSTER_KEY, poster, address(book), 2 * USDC, 2, block.timestamp + 1 days);
        book.repayFromRefund(loanId);

        (,,, uint256 outstandingRaw,,, uint64 closedAt) = book.loans(loanId);
        assertEq(outstandingRaw, 0);
        require(closedAt > 0, "posting loan did not close");
        assertEq(book.totalOutstandingRaw(), 0);
    }

    function testPerWalletAndSharedBookCapsAreEnforced() public {
        vmCredit.expectRevert(
            abi.encodeWithSelector(CreditBook.PerWalletCapExceeded.selector, 25 * USDC + 1, 25 * USDC)
        );
        book.originate(borrower, 25 * USDC + 1, CreditBook.Mode.CASH, keccak256("too-large"));

        address second = address(0x2222);
        address third = address(0x3333);
        book.originate(borrower, 25 * USDC, CreditBook.Mode.CASH, keccak256("one"));
        book.originate(second, 25 * USDC, CreditBook.Mode.CASH, keccak256("two"));
        vmCredit.expectRevert(abi.encodeWithSelector(CreditBook.BookCapExceeded.selector, 50 * USDC + 1, 50 * USDC));
        book.originate(third, 1, CreditBook.Mode.CASH, keccak256("three"));
    }

    function testScheduleSettersCannotCrossImmutableCeilings() public {
        uint256 walletCeiling = book.PER_WALLET_CAP_CEILING_RAW();
        uint256 bookCeiling = book.BOOK_CAP_CEILING_RAW();
        uint256 interestCeiling = book.INTEREST_BPS_CEILING();
        uint256 bps = book.BPS();
        book.setPerWalletCapRaw(CreditBook.Mode.CASH, walletCeiling);
        vmCredit.expectRevert(CreditBook.InvalidSchedule.selector);
        book.setPerWalletCapRaw(CreditBook.Mode.CASH, walletCeiling + 1);

        book.setBookCapRaw(bookCeiling);
        vmCredit.expectRevert(CreditBook.InvalidSchedule.selector);
        book.setBookCapRaw(bookCeiling + 1);

        book.setInterestBps(interestCeiling);
        vmCredit.expectRevert(CreditBook.InvalidSchedule.selector);
        book.originate(borrower, 1, CreditBook.Mode.CASH, keccak256("non-zero-interest-out-of-scope"));
        vmCredit.expectRevert(CreditBook.InvalidSchedule.selector);
        book.setInterestBps(interestCeiling + 1);

        book.setRepayBps(bps);
        vmCredit.expectRevert(CreditBook.InvalidSchedule.selector);
        book.setRepayBps(bps + 1);
    }

    function testWashEconomicsConstantsReproduceStructuralLossBound() public pure {
        uint256 cycleRewardRaw = 250_000;
        uint256 posterFeeRaw = 50_000;
        uint256 retentionRaw = 50_000;
        uint256 workerGasRaw = 60_000;
        uint256 structuralLossRaw = posterFeeRaw + retentionRaw + workerGasRaw;

        assertEq(structuralLossRaw, 160_000);
        require(structuralLossRaw >= 150_000, "wash loss below packet bound");
        require(structuralLossRaw * 10_000 / cycleRewardRaw > 5_000, "wash loss not majority of cycle");
    }

    function _settleTo(address worker, uint256 payoutRaw) internal {
        asset.mint(settlementSource, payoutRaw);
        vm.startPrank(settlementSource);
        asset.approve(address(accounts), payoutRaw);
        accounts.deposit(address(asset), payoutRaw);
        vm.stopPrank();
        accounts.reserveForJob(settlementSource, address(asset), payoutRaw);
        accounts.settleReservedTo(
            keccak256(abi.encode(worker, payoutRaw)), settlementSource, address(asset), worker, payoutRaw
        );
    }

    function _consentedTransfer(
        uint256 privateKey,
        address from,
        address recipient,
        uint256 amountRaw,
        uint256 nonce,
        uint256 deadline
    ) internal {
        bytes32 digest = accounts.hashSendToAgentAuthorization(
            from, recipient, address(asset), amountRaw, nonce, deadline
        );
        (uint8 v, bytes32 r, bytes32 s) = vmCredit.sign(privateKey, digest);
        accounts.sendToAgentFor(from, recipient, address(asset), amountRaw, nonce, deadline, abi.encodePacked(r, s, v));
    }
}

contract CreditBookMockUsdc {
    string public constant name = "Mock USDC";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
