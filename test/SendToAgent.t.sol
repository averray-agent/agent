// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {TreasuryPolicy} from "../contracts/TreasuryPolicy.sol";
import {StrategyAdapterRegistry} from "../contracts/StrategyAdapterRegistry.sol";
import {AgentAccountCore} from "../contracts/AgentAccountCore.sol";
import {MockVDotAdapter} from "../contracts/strategies/MockVDotAdapter.sol";

interface VmSign {
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

/// @notice Pins the agent-to-agent transfer primitive. Moving liquid
///         balance between two on-platform accounts is pure bookkeeping —
///         no ERC20 transfer — so these tests verify the accounting +
///         access-control gates, not any external asset flow.
contract SendToAgentTest is Test {
    VmSign internal constant vmSign = VmSign(address(uint160(uint256(keccak256("hevm cheat code")))));

    TreasuryPolicy internal policy;
    StrategyAdapterRegistry internal registry;
    AgentAccountCore internal accounts;
    MockERC20 internal dot;

    uint256 internal constant ALICE_KEY = 0xA11CE;
    uint256 internal constant BOB_KEY = 0xB0B;

    address internal alice = 0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7;
    address internal bob = address(0xB0B);
    address internal operator = address(0xBEEF);

    uint256 internal constant ALICE_DEPOSIT = 1_000 ether;

    function setUp() public {
        policy = new TreasuryPolicy();
        registry = new StrategyAdapterRegistry(policy);
        accounts = new AgentAccountCore(policy, registry);
        dot = new MockERC20("Mock DOT", "mDOT");

        policy.setApprovedAsset(address(dot), true);
        policy.setServiceOperator(operator, true);

        dot.mint(alice, ALICE_DEPOSIT);
        vm.startPrank(alice);
        dot.approve(address(accounts), type(uint256).max);
        accounts.deposit(address(dot), ALICE_DEPOSIT);
        vm.stopPrank();
    }

    function _signSendAuthorization(address from, address recipient, uint256 amount, uint256 nonce, uint256 signerKey)
        internal
        returns (uint256 deadline, bytes memory signature)
    {
        deadline = block.timestamp + 1 days;
        bytes32 digest = accounts.hashSendToAgentAuthorization(from, recipient, address(dot), amount, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vmSign.sign(signerKey, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _borrowAgainstCollateral() internal {
        vm.startPrank(alice);
        accounts.lockCollateral(address(dot), 150 ether);
        accounts.borrow(address(dot), 100 ether);
        vm.stopPrank();
    }

    function _liquid(address account) internal view returns (uint256) {
        (uint256 liquid,,,,,) = accounts.positions(account, address(dot));
        return liquid;
    }

    function testSendToAgentMovesLiquidBalance() public {
        vm.prank(alice);
        accounts.sendToAgent(bob, address(dot), 10 ether);
        assertEq(_liquid(alice), ALICE_DEPOSIT - 10 ether);
        assertEq(_liquid(bob), 10 ether);
    }

    function testSendToAgentRejectsZeroAmount() public {
        vm.prank(alice);
        (bool ok,) = address(accounts).call(abi.encodeCall(accounts.sendToAgent, (bob, address(dot), 0)));
        require(!ok, "EXPECTED_ZERO_AMOUNT_REVERT");
    }

    function testSendToAgentRejectsSelfTransfer() public {
        vm.prank(alice);
        (bool ok,) = address(accounts).call(abi.encodeCall(accounts.sendToAgent, (alice, address(dot), 1 ether)));
        require(!ok, "EXPECTED_INVALID_RECIPIENT_REVERT");
    }

    function testSendToAgentRejectsZeroAddress() public {
        vm.prank(alice);
        (bool ok,) = address(accounts).call(abi.encodeCall(accounts.sendToAgent, (address(0), address(dot), 1 ether)));
        require(!ok, "EXPECTED_INVALID_RECIPIENT_REVERT");
    }

    function testSendToAgentRejectsInsufficientLiquidity() public {
        vm.prank(alice);
        (bool ok,) =
            address(accounts).call(abi.encodeCall(accounts.sendToAgent, (bob, address(dot), ALICE_DEPOSIT + 1 ether)));
        require(!ok, "EXPECTED_INSUFFICIENT_LIQUIDITY_REVERT");
    }

    function testSendToAgentRejectsUnsupportedAsset() public {
        MockERC20 other = new MockERC20("Other", "OTH");
        vm.prank(alice);
        (bool ok,) = address(accounts).call(abi.encodeCall(accounts.sendToAgent, (bob, address(other), 1 ether)));
        require(!ok, "EXPECTED_UNSUPPORTED_ASSET_REVERT");
    }

    function testSendToAgentPausesWithProtocol() public {
        policy.setPaused(true);
        vm.prank(alice);
        (bool ok,) = address(accounts).call(abi.encodeCall(accounts.sendToAgent, (bob, address(dot), 1 ether)));
        require(!ok, "EXPECTED_PAUSED_REVERT");
    }

    function testSendToAgentForAllowsOperatorRelay() public {
        (uint256 deadline, bytes memory signature) = _signSendAuthorization(alice, bob, 25 ether, 1, ALICE_KEY);
        vm.prank(operator);
        accounts.sendToAgentFor(alice, bob, address(dot), 25 ether, 1, deadline, signature);
        assertEq(_liquid(alice), ALICE_DEPOSIT - 25 ether);
        assertEq(_liquid(bob), 25 ether);
        require(accounts.sendToAgentAuthorizationUsed(alice, 1), "EXPECTED_AUTHORIZATION_USED");
    }

    function testSendToAgentForRejectsReplay() public {
        (uint256 deadline, bytes memory signature) = _signSendAuthorization(alice, bob, 25 ether, 2, ALICE_KEY);
        vm.prank(operator);
        accounts.sendToAgentFor(alice, bob, address(dot), 25 ether, 2, deadline, signature);

        vm.prank(operator);
        (bool ok, bytes memory data) = address(accounts)
            .call(abi.encodeCall(accounts.sendToAgentFor, (alice, bob, address(dot), 25 ether, 2, deadline, signature)));
        require(!ok, "EXPECTED_REPLAY_REVERT");
        require(bytes4(data) == AgentAccountCore.AuthorizationAlreadyUsed.selector, "EXPECTED_REPLAY_SELECTOR");
    }

    function testSendToAgentForRejectsWrongSigner() public {
        (uint256 deadline, bytes memory signature) = _signSendAuthorization(alice, bob, 25 ether, 3, BOB_KEY);
        vm.prank(operator);
        (bool ok, bytes memory data) = address(accounts)
            .call(abi.encodeCall(accounts.sendToAgentFor, (alice, bob, address(dot), 25 ether, 3, deadline, signature)));
        require(!ok, "EXPECTED_INVALID_SIGNATURE_REVERT");
        require(bytes4(data) == AgentAccountCore.InvalidSignature.selector, "EXPECTED_INVALID_SIGNATURE_SELECTOR");
    }

    function testSendToAgentForRejectsExpiredAuthorization() public {
        uint256 expiredDeadline = 1;
        vm.warp(expiredDeadline);
        bytes32 digest = accounts.hashSendToAgentAuthorization(alice, bob, address(dot), 25 ether, 4, expiredDeadline);
        (uint8 v, bytes32 r, bytes32 s) = vmSign.sign(ALICE_KEY, digest);
        vm.warp(expiredDeadline + 1);

        vm.prank(operator);
        (bool ok, bytes memory data) = address(accounts)
            .call(
                abi.encodeCall(
                    accounts.sendToAgentFor,
                    (alice, bob, address(dot), 25 ether, 4, expiredDeadline, abi.encodePacked(r, s, v))
                )
            );
        require(!ok, "EXPECTED_EXPIRED_AUTHORIZATION_REVERT");
        require(bytes4(data) == AgentAccountCore.ExpiredAuthorization.selector, "EXPECTED_EXPIRED_SELECTOR");
    }

    function testSendToAgentForRejectsNonOperator() public {
        (uint256 deadline, bytes memory signature) = _signSendAuthorization(alice, bob, 1 ether, 5, ALICE_KEY);
        vm.prank(bob);
        (bool ok,) = address(accounts)
            .call(abi.encodeCall(accounts.sendToAgentFor, (alice, bob, address(dot), 1 ether, 5, deadline, signature)));
        require(!ok, "EXPECTED_UNAUTHORIZED_REVERT");
    }

    function testSendToAgentForStillRejectsSelfTransfer() public {
        (uint256 deadline, bytes memory signature) = _signSendAuthorization(alice, alice, 1 ether, 6, ALICE_KEY);
        vm.prank(operator);
        (bool ok,) = address(accounts)
            .call(
                abi.encodeCall(accounts.sendToAgentFor, (alice, alice, address(dot), 1 ether, 6, deadline, signature))
            );
        require(!ok, "EXPECTED_INVALID_RECIPIENT_REVERT");
    }

    function testSendToAgentRespectsDebtOutstanding() public {
        _borrowAgainstCollateral();

        vm.prank(alice);
        (bool ok, bytes memory data) =
            address(accounts).call(abi.encodeCall(accounts.sendToAgent, (bob, address(dot), 851 ether)));
        require(!ok, "EXPECTED_DEBT_GATE_REVERT");
        require(bytes4(data) == AgentAccountCore.InsufficientLiquidity.selector, "EXPECTED_LIQUIDITY_SELECTOR");
    }

    function testStrategyAllocationRespectsDebtOutstanding() public {
        bytes32 strategyId = bytes32("VDOT_V1_MOCK");
        MockVDotAdapter adapter = new MockVDotAdapter(policy, address(dot), strategyId);
        policy.setApprovedStrategy(address(adapter), true);
        registry.registerStrategy(address(adapter));
        _borrowAgainstCollateral();

        vm.prank(alice);
        (bool ok, bytes memory data) =
            address(accounts).call(abi.encodeCall(accounts.allocateIdleFunds, (alice, strategyId, 851 ether)));
        require(!ok, "EXPECTED_DEBT_GATE_REVERT");
        require(bytes4(data) == AgentAccountCore.InsufficientLiquidity.selector, "EXPECTED_LIQUIDITY_SELECTOR");
    }
}
