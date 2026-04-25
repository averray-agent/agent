// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {TreasuryPolicy} from "../contracts/TreasuryPolicy.sol";
import {StrategyAdapterRegistry} from "../contracts/StrategyAdapterRegistry.sol";
import {AgentAccountCore} from "../contracts/AgentAccountCore.sol";
import {EscrowCore} from "../contracts/EscrowCore.sol";
import {ReputationSBT} from "../contracts/ReputationSBT.sol";
import {VerifierRegistry} from "../contracts/VerifierRegistry.sol";

/// @notice Pins the Phase 1 hardening guarantees: pausability kills new writes,
///         milestone arrays are bounded, and SafeERC20 rejects tokens that
///         return false on transfer.
contract HardeningTest is Test {
    TreasuryPolicy internal policy;
    StrategyAdapterRegistry internal registry;
    AgentAccountCore internal accounts;
    ReputationSBT internal reputation;
    VerifierRegistry internal verifierRegistry;
    EscrowCore internal escrow;
    MockERC20 internal dot;

    address internal poster = address(0xA11CE);
    address internal worker = address(0xB0B);
    address internal verifier = address(0xCAFE);
    bytes32 internal constant SPEC_HASH = bytes32("SPEC_HASH");

    function setUp() public {
        policy = new TreasuryPolicy();
        registry = new StrategyAdapterRegistry(policy);
        accounts = new AgentAccountCore(policy, registry);
        reputation = new ReputationSBT(policy);
        verifierRegistry = new VerifierRegistry(address(this));
        escrow = new EscrowCore(policy, accounts, reputation, verifierRegistry);
        dot = new MockERC20("Mock DOT", "mDOT");

        policy.setApprovedAsset(address(dot), true);
        policy.setServiceOperator(address(escrow), true);
        policy.setServiceOperator(address(accounts), true);
        policy.setVerifier(verifier, true);
        verifierRegistry.addVerifier(verifier);

        dot.mint(poster, 1_000 ether);
        dot.mint(worker, 1_000 ether);

        vm.startPrank(poster);
        dot.approve(address(accounts), type(uint256).max);
        accounts.deposit(address(dot), 500 ether);
        vm.stopPrank();

        vm.startPrank(worker);
        dot.approve(address(accounts), type(uint256).max);
        accounts.deposit(address(dot), 200 ether);
        vm.stopPrank();
    }

    function testPauseBlocksNewJobCreation() public {
        policy.setPaused(true);

        vm.prank(poster);
        (bool ok,) = address(escrow).call(
            abi.encodeCall(
                escrow.createSinglePayoutJob,
                (
                    keccak256("paused-job"),
                    address(dot),
                    10 ether,
                    1 ether,
                    1 ether,
                    1 days,
                    bytes32("AUTO"),
                    bytes32("CODING"),
                    SPEC_HASH
                )
            )
        );
        require(!ok, "EXPECTED_PAUSED_REVERT");
    }

    function testPauseBlocksClaim() public {
        bytes32 jobId = keccak256("job/pause-claim");
        vm.prank(poster);
        escrow.createSinglePayoutJob(
            jobId,
            address(dot),
            10 ether,
            1 ether,
            1 ether,
            1 days,
            bytes32("AUTO"),
            bytes32("CODING"),
            SPEC_HASH
        );

        policy.setPaused(true);

        vm.prank(worker);
        (bool ok,) = address(escrow).call(abi.encodeCall(escrow.claimJob, (jobId)));
        require(!ok, "EXPECTED_PAUSED_REVERT");
    }

    function testPauseBlocksDeposit() public {
        policy.setPaused(true);
        dot.mint(worker, 50 ether);
        vm.prank(worker);
        (bool ok,) = address(accounts).call(
            abi.encodeCall(accounts.deposit, (address(dot), 50 ether))
        );
        require(!ok, "EXPECTED_PAUSED_REVERT");
    }

    function testMilestoneArrayCapEnforced() public {
        uint256[] memory milestones = new uint256[](33);
        for (uint256 i = 0; i < 33; i++) {
            milestones[i] = 1 ether;
        }
        vm.prank(poster);
        (bool ok,) = address(escrow).call(
            abi.encodeCall(
                escrow.createMilestoneJob,
                (
                    keccak256("job/too-many"),
                    address(dot),
                    milestones,
                    0,
                    0,
                    1 days,
                    bytes32("AUTO"),
                    bytes32("CODING"),
                    SPEC_HASH
                )
            )
        );
        require(!ok, "EXPECTED_MILESTONE_LIMIT_REVERT");
    }

    function testEmptyMilestoneArrayRejected() public {
        uint256[] memory milestones = new uint256[](0);
        vm.prank(poster);
        (bool ok,) = address(escrow).call(
            abi.encodeCall(
                escrow.createMilestoneJob,
                (
                    keccak256("job/empty"),
                    address(dot),
                    milestones,
                    0,
                    0,
                    1 days,
                    bytes32("AUTO"),
                    bytes32("CODING"),
                    SPEC_HASH
                )
            )
        );
        require(!ok, "EXPECTED_MILESTONE_LIMIT_REVERT");
    }

    function testMilestoneAtCapStillAccepted() public {
        uint256[] memory milestones = new uint256[](32);
        for (uint256 i = 0; i < 32; i++) {
            milestones[i] = 1 ether;
        }
        vm.prank(poster);
        escrow.createMilestoneJob(
            keccak256("job/at-cap"),
            address(dot),
            milestones,
            0,
            0,
            1 days,
            bytes32("AUTO"),
            bytes32("CODING"),
            SPEC_HASH
        );
    }

    function testSafeTransferRejectsFailingToken() public {
        FalseReturnToken bad = new FalseReturnToken();
        policy.setApprovedAsset(address(bad), true);
        bad.mint(worker, 10 ether);

        vm.startPrank(worker);
        bad.approve(address(accounts), type(uint256).max);
        (bool ok,) = address(accounts).call(
            abi.encodeCall(accounts.deposit, (address(bad), 5 ether))
        );
        vm.stopPrank();
        require(!ok, "EXPECTED_SAFE_TRANSFER_REVERT");
    }

    function testUnpauseRestoresWrites() public {
        policy.setPaused(true);
        policy.setPaused(false);

        vm.prank(poster);
        escrow.createSinglePayoutJob(
            keccak256("job/after-unpause"),
            address(dot),
            10 ether,
            1 ether,
            1 ether,
            1 days,
            bytes32("AUTO"),
            bytes32("CODING"),
            SPEC_HASH
        );
    }

    function testDesignatedPauserCanPauseWithoutOwner() public {
        address hotPauser = address(0xFEED);
        policy.setPauser(hotPauser);

        vm.prank(hotPauser);
        policy.setPaused(true);
        require(policy.paused(), "EXPECTED_PAUSED");

        // Pauser can also unpause.
        vm.prank(hotPauser);
        policy.setPaused(false);
        require(!policy.paused(), "EXPECTED_UNPAUSED");
    }

    function testPauserCannotCallAdminOperations() public {
        address hotPauser = address(0xFEED);
        policy.setPauser(hotPauser);

        // Non-pause admin ops still require owner signature.
        vm.prank(hotPauser);
        (bool ok,) = address(policy).call(
            abi.encodeCall(policy.setApprovedAsset, (address(0xDEAD), true))
        );
        require(!ok, "EXPECTED_UNAUTHORIZED_REVERT");
    }

    function testRandomAccountCannotPause() public {
        vm.prank(address(0xBEEF));
        (bool ok,) = address(policy).call(abi.encodeCall(policy.setPaused, (true)));
        require(!ok, "EXPECTED_UNAUTHORIZED_REVERT");
    }

    function testOwnerCanRevokePauser() public {
        address hotPauser = address(0xFEED);
        policy.setPauser(hotPauser);
        policy.setPauser(address(0));

        vm.prank(hotPauser);
        (bool ok,) = address(policy).call(abi.encodeCall(policy.setPaused, (true)));
        require(!ok, "EXPECTED_UNAUTHORIZED_REVERT");
    }
}

/// @dev A pathological ERC20 that always returns false from transfer/transferFrom.
///      Used to confirm SafeTransfer reverts on protocol-incompatible tokens.
contract FalseReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}
