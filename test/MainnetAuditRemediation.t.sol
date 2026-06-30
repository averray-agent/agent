// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {TreasuryPolicy} from "../contracts/TreasuryPolicy.sol";
import {StrategyAdapterRegistry} from "../contracts/StrategyAdapterRegistry.sol";
import {AgentAccountCore} from "../contracts/AgentAccountCore.sol";
import {EscrowCore} from "../contracts/EscrowCore.sol";
import {ReputationSBT} from "../contracts/ReputationSBT.sol";

contract MainnetAuditRemediationTest is Test {
    TreasuryPolicy internal policy;
    StrategyAdapterRegistry internal registry;
    AgentAccountCore internal accounts;
    ReputationSBT internal reputation;
    EscrowCore internal escrow;
    MockERC20 internal token;

    address internal poster = address(0xA11CE);
    address internal worker = address(0xB0B);
    address internal treasury = address(0x777777);

    function setUp() public {
        policy = new TreasuryPolicy();
        registry = new StrategyAdapterRegistry(policy);
        accounts = new AgentAccountCore(policy, registry);
        reputation = new ReputationSBT(policy);
        escrow = new EscrowCore(policy, accounts, reputation);
        token = new MockERC20("Audit Token", "AUD");

        policy.setApprovedAsset(address(token), true);
        policy.setServiceOperator(address(escrow), true);
        policy.setServiceOperator(address(this), true);
        policy.setServiceOperator(address(accounts), true);
        policy.setTreasury(treasury);
        policy.setDailyOutflowCap(type(uint256).max);
        accounts.setEscrowOperator(address(escrow), true);
        accounts.setEscrowOperator(address(this), true);

        token.mint(poster, 1_000 ether);
        token.mint(worker, 100 ether);

        vm.startPrank(poster);
        token.approve(address(accounts), type(uint256).max);
        accounts.deposit(address(token), 1_000 ether);
        vm.stopPrank();

        vm.startPrank(worker);
        token.approve(address(accounts), type(uint256).max);
        accounts.deposit(address(token), 100 ether);
        vm.stopPrank();
    }

    function testTreasuryPolicyDefaultOutflowCapIsConservativeAndOwnerCanRaise() public {
        TreasuryPolicy fresh = new TreasuryPolicy();

        assertEq(fresh.dailyOutflowCap(), fresh.DEFAULT_DAILY_OUTFLOW_CAP());
        assertEq(fresh.treasury(), address(this));

        fresh.setDailyOutflowCap(2_000_000_000);
        assertEq(fresh.dailyOutflowCap(), 2_000_000_000);
    }

    function testMinimumCollateralRatioRejectsUnboundedValues() public {
        (bool ok,) = address(policy).call(abi.encodeCall(policy.setMinimumCollateralRatioBps, (50_001)));

        require(!ok, "EXPECTED_HIGH_RATIO_REVERT");
    }

    function testSlashedStakeTransfersTreasuryPortionOutOfAgentAccountCore() public {
        accounts.lockJobStake(worker, address(token), 10 ether);

        uint256 posterBalanceBefore = token.balanceOf(poster);
        uint256 treasuryBalanceBefore = token.balanceOf(treasury);
        uint256 aacBalanceBefore = token.balanceOf(address(accounts));

        accounts.slashJobStake(worker, address(token), 10 ether, poster);

        assertEq(token.balanceOf(poster), posterBalanceBefore + 5 ether);
        assertEq(token.balanceOf(treasury), treasuryBalanceBefore + 5 ether);
        assertEq(token.balanceOf(address(accounts)), aacBalanceBefore - 10 ether);
    }

    function testSlashingFailsClosedWhenAgentAccountCoreIsNotPolicyServiceOperator() public {
        policy.setServiceOperator(address(accounts), false);
        accounts.lockJobStake(worker, address(token), 10 ether);

        (bool ok, bytes memory data) =
            address(accounts).call(abi.encodeCall(accounts.slashJobStake, (worker, address(token), 10 ether, poster)));
        require(!ok, "EXPECTED_POLICY_OPERATOR_READY_REVERT");
        require(bytes4(data) == AgentAccountCore.Unauthorized.selector, "EXPECTED_UNAUTHORIZED_SELECTOR");

        (,,,, uint256 jobStakeLocked,) = accounts.positions(worker, address(token));
        assertEq(jobStakeLocked, 10 ether);
    }

    function testZeroRewardSinglePayoutJobsAreRejected() public {
        bytes32 jobId = keccak256("audit/zero-single");

        vm.prank(poster);
        (bool ok, bytes memory data) = address(escrow)
            .call(
                abi.encodeWithSignature(
                    "createSinglePayoutJob(bytes32,address,uint256,uint256,uint256,uint256,bytes32,bytes32,bytes32)",
                    jobId,
                    address(token),
                    0,
                    0,
                    0,
                    1 days,
                    bytes32("AUTO"),
                    bytes32("AUDIT"),
                    bytes32("SPEC")
                )
            );

        require(!ok, "EXPECTED_ZERO_REWARD_REVERT");
        require(bytes4(data) == EscrowCore.InvalidState.selector, "EXPECTED_INVALID_STATE");
    }

    function testZeroRewardRecurringJobsAreRejectedBeforeReserveConsume() public {
        EscrowCore.RecurringSinglePayoutJob memory params = EscrowCore.RecurringSinglePayoutJob({
            jobId: keccak256("audit/zero-recurring"),
            templateId: bytes32("TEMPLATE"),
            poster: poster,
            asset: address(token),
            reward: 0,
            opsReserve: 0,
            contingencyReserve: 0,
            claimTtl: 1 days,
            verifierMode: bytes32("AUTO"),
            category: bytes32("AUDIT"),
            specHash: bytes32("SPEC"),
            schemaHash: bytes32(0),
            schemaUrl: "",
            schemaIssuer: address(0),
            schemaSignature: new bytes(0)
        });

        (bool ok, bytes memory data) =
            address(escrow).call(abi.encodeCall(escrow.createSinglePayoutJobFromRecurringReserve, (params)));

        require(!ok, "EXPECTED_ZERO_REWARD_REVERT");
        require(bytes4(data) == EscrowCore.InvalidState.selector, "EXPECTED_INVALID_STATE");
    }

    function testZeroRewardMilestoneJobsAreRejected() public {
        uint256[] memory milestones = new uint256[](2);
        bytes32 jobId = keccak256("audit/zero-milestone");

        vm.prank(poster);
        (bool ok, bytes memory data) = address(escrow)
            .call(
                abi.encodeCall(
                    escrow.createMilestoneJob,
                    (
                        jobId,
                        address(token),
                        milestones,
                        0,
                        0,
                        1 days,
                        bytes32("AUTO"),
                        bytes32("AUDIT"),
                        bytes32("SPEC")
                    )
                )
            );

        require(!ok, "EXPECTED_ZERO_REWARD_REVERT");
        require(bytes4(data) == EscrowCore.InvalidState.selector, "EXPECTED_INVALID_STATE");
    }
}
