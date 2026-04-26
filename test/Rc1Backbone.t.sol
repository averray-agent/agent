// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {TreasuryPolicy} from "../contracts/TreasuryPolicy.sol";
import {StrategyAdapterRegistry} from "../contracts/StrategyAdapterRegistry.sol";
import {AgentAccountCore} from "../contracts/AgentAccountCore.sol";
import {EscrowCore} from "../contracts/EscrowCore.sol";
import {ReputationSBT} from "../contracts/ReputationSBT.sol";
import {DiscoveryRegistry} from "../contracts/DiscoveryRegistry.sol";

interface VmEvent {
    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData, address emitter) external;
}

contract Rc1BackboneTest is Test {
    VmEvent internal constant vmEvent = VmEvent(address(uint160(uint256(keccak256("hevm cheat code")))));

    TreasuryPolicy internal policy;
    StrategyAdapterRegistry internal registry;
    AgentAccountCore internal accounts;
    ReputationSBT internal reputation;
    EscrowCore internal escrow;
    MockERC20 internal dot;

    address internal poster = address(0xA11CE);
    address internal worker = address(0xB0B);
    address internal verifier = address(0xCAFE);
    address internal stranger = address(0xBAD);

    bytes32 internal constant SPEC_HASH = bytes32("SPEC_HASH");
    bytes32 internal constant PAYLOAD_HASH = bytes32("PAYLOAD_HASH");
    bytes32 internal constant REASONING_HASH = bytes32("REASONING_HASH");

    event JobCreated(bytes32 indexed jobId, address indexed poster, bytes32 indexed specHash, address asset, uint256 totalReserved, EscrowCore.PayoutMode payoutMode);
    event Submitted(bytes32 indexed jobId, address indexed worker, bytes32 indexed payloadHash);
    event Verified(bytes32 indexed jobId, address indexed verifier, bool approved, bytes32 reasonCode, bytes32 reasoningHash);
    event AutoDisclosed(bytes32 indexed hash, uint64 timestamp);

    function setUp() public {
        policy = new TreasuryPolicy();
        registry = new StrategyAdapterRegistry(policy);
        accounts = new AgentAccountCore(policy, registry);
        reputation = new ReputationSBT(policy);
        escrow = new EscrowCore(policy, accounts, reputation);
        dot = new MockERC20("Mock DOT", "mDOT");

        policy.setApprovedAsset(address(dot), true);
        policy.setServiceOperator(address(escrow), true);
        policy.setServiceOperator(address(accounts), true);
        policy.setServiceOperator(address(this), true);
        policy.setDailyOutflowCap(type(uint256).max);

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

    function testUnauthorizedVerifierCannotResolveEscrow() public {
        bytes32 jobId = prepareSubmittedJob("job/unauthorized");

        vm.prank(stranger);
        (bool ok,) = address(escrow).call(
            abi.encodeCall(
                escrow.resolveSinglePayout,
                (jobId, true, bytes32("OK"), "ipfs://badge/unauthorized", REASONING_HASH)
            )
        );

        require(!ok, "EXPECTED_UNAUTHORIZED_REVERT");
    }

    function testAuthorizedVerifierCanResolveEscrow() public {
        bytes32 jobId = prepareSubmittedJob("job/authorized");
        policy.setVerifier(verifier, true);

        vm.prank(verifier);
        escrow.resolveSinglePayout(jobId, true, bytes32("OK"), "ipfs://badge/authorized", REASONING_HASH);

        EscrowCore.JobEscrow memory job = escrow.jobs(jobId);
        assertEq(uint256(job.state), uint256(EscrowCore.JobState.Closed));
    }

    function testRemovedVerifierCannotResolveEscrow() public {
        bytes32 jobId = prepareSubmittedJob("job/removed");
        policy.setVerifier(verifier, true);
        policy.setVerifier(verifier, false);

        vm.prank(verifier);
        (bool ok,) = address(escrow).call(
            abi.encodeCall(
                escrow.resolveSinglePayout,
                (jobId, true, bytes32("OK"), "ipfs://badge/removed", REASONING_HASH)
            )
        );

        require(!ok, "EXPECTED_REMOVED_VERIFIER_REVERT");
    }

    function testVerifierAuthorizationHistoryIsAuditable() public {
        vm.warp(100);
        policy.setVerifier(verifier, true);
        require(!policy.wasAuthorizedAt(verifier, 99), "EXPECTED_NOT_AUTHORIZED_BEFORE");
        require(policy.wasAuthorizedAt(verifier, 100), "EXPECTED_AUTHORIZED_AT_START");

        vm.warp(150);
        policy.setVerifier(verifier, false);
        require(policy.wasAuthorizedAt(verifier, 149), "EXPECTED_AUTHORIZED_BEFORE_REMOVAL");
        require(!policy.wasAuthorizedAt(verifier, 150), "EXPECTED_NOT_AUTHORIZED_AT_REMOVAL");

        vm.warp(200);
        policy.setVerifier(verifier, true);
        require(policy.wasAuthorizedAt(verifier, 100), "EXPECTED_FIRST_WINDOW_RETAINED");
        require(!policy.wasAuthorizedAt(verifier, 175), "EXPECTED_GAP_RETAINED");
        require(policy.wasAuthorizedAt(verifier, 200), "EXPECTED_SECOND_WINDOW");
    }

    function testDiscoveryManifestPublishIncrementsVersionAndRejectsNonPublisher() public {
        DiscoveryRegistry discovery = new DiscoveryRegistry(address(this));
        bytes32 firstHash = keccak256("manifest/1");
        bytes32 secondHash = keccak256("manifest/2");

        discovery.publish(firstHash);
        assertEq(discovery.currentVersion(), 1);
        require(discovery.currentManifestHash() == firstHash, "EXPECTED_FIRST_HASH");

        discovery.publish(secondHash);
        assertEq(discovery.currentVersion(), 2);
        require(discovery.currentManifestHash() == secondHash, "EXPECTED_SECOND_HASH");

        vm.prank(stranger);
        (bool ok,) = address(discovery).call(abi.encodeCall(discovery.publish, (keccak256("nope"))));
        require(!ok, "EXPECTED_PUBLISHER_REVERT");
    }

    function testDisclosureAutoDiscloseEmitsOnce() public {
        bytes32 hash = keccak256("content");

        vmEvent.expectEmit(true, false, false, true, address(escrow));
        emit AutoDisclosed(hash, uint64(block.timestamp));
        escrow.autoDisclose(hash);
        require(escrow.autoDisclosed(hash), "EXPECTED_AUTO_DISCLOSED");

        (bool ok,) = address(escrow).call(abi.encodeCall(escrow.autoDisclose, (hash)));
        require(!ok, "EXPECTED_ALREADY_AUTO_DISCLOSED_REVERT");
    }

    function testReputationSbtTransferMethodsAreSoulbound() public {
        policy.setServiceOperator(address(this), true);
        uint256 tokenId = reputation.mintBadge(worker, bytes32("CODING"), 1, "ipfs://badge/sbt");

        (bool transferFromOk,) = address(reputation).call(
            abi.encodeCall(reputation.transferFrom, (worker, poster, tokenId))
        );
        require(!transferFromOk, "EXPECTED_TRANSFER_FROM_REVERT");

        (bool transferOk,) = address(reputation).call(
            abi.encodeCall(reputation.transfer, (poster, tokenId))
        );
        require(!transferOk, "EXPECTED_TRANSFER_REVERT");

        (bool safeTransferOk,) = address(reputation).call(
            abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", worker, poster, tokenId)
        );
        require(!safeTransferOk, "EXPECTED_SAFE_TRANSFER_REVERT");

        (bool safeTransferWithDataOk,) = address(reputation).call(
            abi.encodeWithSignature("safeTransferFrom(address,address,uint256,bytes)", worker, poster, tokenId, "")
        );
        require(!safeTransferWithDataOk, "EXPECTED_SAFE_TRANSFER_DATA_REVERT");
    }

    function testCanonicalHashEventsAreEmitted() public {
        bytes32 jobId = keccak256("job/events");
        policy.setVerifier(verifier, true);

        vmEvent.expectEmit(true, true, true, true, address(escrow));
        emit JobCreated(jobId, poster, SPEC_HASH, address(dot), 10 ether, EscrowCore.PayoutMode.Single);
        vm.prank(poster);
        escrow.createSinglePayoutJob(jobId, address(dot), 10 ether, 0, 0, 1 days, bytes32("AUTO"), bytes32("CODING"), SPEC_HASH);

        vm.prank(worker);
        escrow.claimJob(jobId);

        vmEvent.expectEmit(true, true, true, true, address(escrow));
        emit Submitted(jobId, worker, PAYLOAD_HASH);
        vm.prank(worker);
        escrow.submitWork(jobId, PAYLOAD_HASH);

        vmEvent.expectEmit(true, true, false, true, address(escrow));
        emit Verified(jobId, verifier, true, bytes32("OK"), REASONING_HASH);
        vm.prank(verifier);
        escrow.resolveSinglePayout(jobId, true, bytes32("OK"), "ipfs://badge/events", REASONING_HASH);
    }

    function prepareSubmittedJob(string memory label) internal returns (bytes32 jobId) {
        jobId = keccak256(bytes(label));
        vm.prank(poster);
        escrow.createSinglePayoutJob(jobId, address(dot), 10 ether, 0, 0, 1 days, bytes32("AUTO"), bytes32("CODING"), SPEC_HASH);
        vm.prank(worker);
        escrow.claimJob(jobId);
        vm.prank(worker);
        escrow.submitWork(jobId, PAYLOAD_HASH);
    }
}
