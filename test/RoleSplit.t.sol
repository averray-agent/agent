// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {AgentAccountCore} from "../contracts/AgentAccountCore.sol";
import {EscrowCore} from "../contracts/EscrowCore.sol";
import {IXcmWrapper} from "../contracts/interfaces/IXcmWrapper.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {ReputationSBT} from "../contracts/ReputationSBT.sol";
import {StrategyAdapterRegistry} from "../contracts/StrategyAdapterRegistry.sol";
import {TreasuryPolicy} from "../contracts/TreasuryPolicy.sol";

contract RoleSplitTest is Test {
    TreasuryPolicy internal policy;
    StrategyAdapterRegistry internal registry;
    AgentAccountCore internal accounts;
    EscrowCore internal escrow;
    ReputationSBT internal reputation;
    MockERC20 internal token;

    address internal settlementBroker = address(0xB10C);
    address internal stranger = address(0xBAD);
    address internal worker = address(0xB0B);
    address internal poster = address(0xA11CE);
    address internal treasury = address(0x7E45);

    function setUp() public {
        policy = new TreasuryPolicy();
        registry = new StrategyAdapterRegistry(policy);
        accounts = new AgentAccountCore(policy, registry);
        reputation = new ReputationSBT(policy);
        escrow = new EscrowCore(policy, accounts, reputation);
        token = new MockERC20("Mock DOT", "mDOT");

        policy.setApprovedAsset(address(token), true);
        policy.setSettlementBroker(settlementBroker, true);
        policy.setOutflowRecorder(address(accounts), true);
        accounts.setEscrowOperator(address(this), true);
        accounts.setTreasuryAccount(treasury);

        token.mint(worker, 200 ether);
        vm.startPrank(worker);
        token.approve(address(accounts), type(uint256).max);
        accounts.deposit(address(token), 200 ether);
        vm.stopPrank();
    }

    function testSettlementBrokerDoesNotInheritOtherOperationalRoles() public {
        vm.startPrank(settlementBroker);

        _expectUnauthorized(
            address(accounts),
            abi.encodeCall(
                accounts.settleStrategyRequest,
                (bytes32("request"), IXcmWrapper.RequestStatus.Succeeded, 1, 1, bytes32(0), bytes32(0))
            )
        );

        _expectUnauthorized(address(reputation), abi.encodeCall(reputation.updateReputation, (worker, 1, 1, 1)));

        _expectUnauthorized(
            address(accounts),
            abi.encodeCall(
                accounts.sendToAgentFor, (worker, poster, address(token), 1, 1, block.timestamp + 1 days, bytes(""))
            )
        );

        _expectUnauthorized(address(policy), abi.encodeCall(policy.recordOutflow, (worker, 1)));
        _expectUnauthorized(address(policy), abi.encodeCall(policy.recordProtocolOutflow, (worker, 1)));
        _expectUnauthorized(address(escrow), abi.encodeCall(escrow.autoDisclose, (bytes32("hash"))));

        vm.stopPrank();
    }

    function testPlainEoaCannotWriteOutflowMeters() public {
        vm.startPrank(stranger);
        _expectUnauthorized(address(policy), abi.encodeCall(policy.recordOutflow, (worker, 1)));
        _expectUnauthorized(address(policy), abi.encodeCall(policy.recordProtocolOutflow, (worker, 1)));
        vm.stopPrank();
    }

    function testProtocolSlashOutflowRecordsButDoesNotLetAccountBlockPenalty() public {
        policy.setDailyOutflowCap(10 ether);

        vm.prank(worker);
        accounts.withdraw(address(token), 10 ether);
        assertEq(policy.accountOutflowToday(worker), 10 ether);

        accounts.lockJobStake(worker, address(token), 10 ether);
        uint256 posterBalanceBefore = token.balanceOf(poster);

        accounts.slashJobStake(worker, address(token), 10 ether, poster);

        assertEq(token.balanceOf(poster), posterBalanceBefore + 5 ether);
        assertEq(policy.accountOutflowToday(worker), 15 ether);

        vm.prank(worker);
        (bool ok, bytes memory data) =
            address(accounts).call(abi.encodeCall(accounts.withdraw, (address(token), 1 ether)));
        require(!ok, "EXPECTED_WITHDRAW_CAP_REVERT");
        require(bytes4(data) == TreasuryPolicy.OutflowCapExceeded.selector, "EXPECTED_OUTFLOW_CAP_SELECTOR");
    }

    function _expectUnauthorized(address target, bytes memory callData) internal {
        (bool ok, bytes memory data) = target.call(callData);
        _assertUnauthorized(ok, data);
    }

    function _assertUnauthorized(bool ok, bytes memory data) internal pure {
        require(!ok, "EXPECTED_UNAUTHORIZED_REVERT");
        require(bytes4(data) == TreasuryPolicy.Unauthorized.selector, "EXPECTED_UNAUTHORIZED_SELECTOR");
    }
}
