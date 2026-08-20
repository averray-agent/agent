// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {AgentAccountCore} from "../contracts/AgentAccountCore.sol";
import {CreditBook} from "../contracts/CreditBook.sol";
import {TreasuryPolicy} from "../contracts/TreasuryPolicy.sol";

interface VmCreditBookFork {
    function addr(uint256 privateKey) external returns (address);
    function createSelectFork(string calldata urlOrAlias) external returns (uint256 forkId);
    function etch(address target, bytes calldata newRuntimeBytecode) external;
    function envOr(string calldata name, string calldata defaultValue) external returns (string memory value);
    function expectRevert(bytes4 selector) external;
    function prank(address msgSender) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

interface ICreditBookForkUsdc {
    function balanceOf(address account) external view returns (uint256);

    function approve(address spender, uint256 amount) external returns (bool);
}

/// @dev Start anvil with `--fork-url <Hub RPC> --chain-id 31337`, then set
/// MAINNET_RPC_URL to that local endpoint. The fork supplies deployed Policy
/// and AAC state. USDC remains an EVM test double because anvil cannot execute
/// Hub's native asset precompile; the evidence boundary and pinned old failure
/// are recorded in docs/CREDITBOOK_AAC_LIQUIDITY_REGRESSION.md.
contract CreditBookForkTest is Test {
    VmCreditBookFork internal constant vmFork =
        VmCreditBookFork(address(uint160(uint256(keccak256("hevm cheat code")))));

    TreasuryPolicy internal constant POLICY = TreasuryPolicy(0x226F14252A98BD2eA140271647De20132F09AF20);
    AgentAccountCore internal constant ACCOUNTS = AgentAccountCore(0xB1350932bf85E7ffd0599E9a3CC7b55718D89E57);
    ICreditBookForkUsdc internal constant USDC = ICreditBookForkUsdc(0x0000053900000000000000000000000001200000);
    address internal constant LIVE_ESCROW = 0xC2Eb191FB75246667226a5D5Db9d821f95a5f793;
    uint256 internal constant ONE_USDC = 1e6;
    uint256 internal constant BORROWER_KEY = 0xC0FFEE;
    uint256 internal constant POSTER_KEY = 0xA11CE;

    function testForkFullLoopUsesAacLiquidityAndMakesBookWholeToRawUnit() public {
        if (!_selectMainnetFork()) return;
        address borrower = vmFork.addr(BORROWER_KEY);
        CreditBook book = _seedBook(address(0));

        bytes32 loanId = book.originate(borrower, ONE_USDC, CreditBook.Mode.CASH, keccak256("fork-cash"));
        (uint256 borrowerLiquid,,,,,) = ACCOUNTS.positions(borrower, address(USDC));
        assertEq(borrowerLiquid, ONE_USDC);
        assertEq(book.accountedLiquidityRaw(), 4 * ONE_USDC);

        _authorizeTransfer(BORROWER_KEY, borrower, address(book), ONE_USDC, 1);
        book.recordSweepRepayment(loanId, ONE_USDC);
        (,,, uint256 outstandingRaw,,, uint64 closedAt) = book.loans(loanId);
        assertEq(outstandingRaw, 0);
        require(closedAt > 0, "fork cash loan did not close");
        assertEq(book.totalOutstandingRaw(), 0);
        assertEq(book.accountedLiquidityRaw(), 5 * ONE_USDC);
        assertEq(book.bookLiquidRaw(), 5 * ONE_USDC);
    }

    function testForkAssetDoublePinsApproveZeroFalseRegression() public {
        if (!_selectMainnetFork()) return;
        _installAssetDouble();

        bool approved = USDC.approve(address(ACCOUNTS), 0);

        require(!approved, "approve(0) without an existing approval must stay false in the fork fixture");
    }

    function testForkPostingFlagPosterFundingAndRefundClose() public {
        if (!_selectMainnetFork()) return;
        address borrower = vmFork.addr(BORROWER_KEY);
        address poster = vmFork.addr(POSTER_KEY);
        CreditBook book = _seedBook(poster);

        vmFork.expectRevert(CreditBook.L3Disabled.selector);
        book.originate(borrower, 2 * ONE_USDC, CreditBook.Mode.POSTING, keccak256("fork-posting"));
        vmFork.prank(POLICY.owner());
        book.setL3Enabled(true);

        bytes32 loanId = book.originate(borrower, 2 * ONE_USDC, CreditBook.Mode.POSTING, keccak256("fork-posting"));
        (uint256 borrowerLiquid,,,,,) = ACCOUNTS.positions(borrower, address(USDC));
        (uint256 posterLiquid,,,,,) = ACCOUNTS.positions(poster, address(USDC));
        assertEq(borrowerLiquid, 0);
        assertEq(posterLiquid, 2 * ONE_USDC);

        vmFork.prank(poster);
        ACCOUNTS.reserveForJob(poster, address(USDC), 2 * ONE_USDC);
        vmFork.prank(LIVE_ESCROW);
        ACCOUNTS.refundReserved(poster, address(USDC), 2 * ONE_USDC);
        _authorizeTransfer(POSTER_KEY, poster, address(book), 2 * ONE_USDC, 2);
        book.repayFromRefund(loanId);

        (,,, uint256 outstandingRaw,,, uint64 closedAt) = book.loans(loanId);
        assertEq(outstandingRaw, 0);
        require(closedAt > 0, "fork posting loan did not close");
    }

    function _selectMainnetFork() internal returns (bool) {
        string memory rpcUrl = vmFork.envOr("MAINNET_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) return false;
        vmFork.createSelectFork(rpcUrl);
        require(block.chainid == 31337, "credit fork must use anvil --chain-id 31337");
        return true;
    }

    function _seedBook(address poster) internal returns (CreditBook book) {
        address policyOwner = POLICY.owner();
        vmFork.prank(policyOwner);
        POLICY.setAgentTransferBroker(address(this), true);
        vmFork.prank(policyOwner);
        POLICY.setDailyOutflowCap(type(uint256).max);
        vmFork.prank(policyOwner);
        POLICY.setOutflowRecorder(address(ACCOUNTS), true);
        _installAssetDouble();
        book = new CreditBook(POLICY, ACCOUNTS, address(USDC), address(this), poster);
        CreditBookForkUsdc(address(USDC)).mint(address(this), 5 * ONE_USDC);
        _approveUsdc(address(ACCOUNTS), 5 * ONE_USDC);
        ACCOUNTS.deposit(address(USDC), 5 * ONE_USDC);
        ACCOUNTS.sendToAgent(address(book), address(USDC), 5 * ONE_USDC);
        book.seed(5 * ONE_USDC);
    }

    function _installAssetDouble() internal {
        CreditBookForkUsdc mockUsdc = new CreditBookForkUsdc();
        vmFork.etch(address(USDC), address(mockUsdc).code);
    }

    function _approveUsdc(address spender, uint256 amountRaw) internal {
        (bool success,) = address(USDC).call(abi.encodeWithSignature("approve(address,uint256)", spender, amountRaw));
        require(success, "fork USDC approve failed");
    }

    function _authorizeTransfer(uint256 privateKey, address from, address recipient, uint256 amountRaw, uint256 nonce)
        internal
    {
        uint256 deadline = block.timestamp + 1 days;
        bytes32 digest =
            ACCOUNTS.hashSendToAgentAuthorization(from, recipient, address(USDC), amountRaw, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vmFork.sign(privateKey, digest);
        ACCOUNTS.sendToAgentFor(from, recipient, address(USDC), amountRaw, nonce, deadline, abi.encodePacked(r, s, v));
    }
}

contract CreditBookForkUsdc {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address recipient, uint256 amount) external {
        balanceOf[recipient] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (amount == 0 && allowance[msg.sender][spender] == 0) return false;
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }

    function transferFrom(address from, address recipient, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }
}
