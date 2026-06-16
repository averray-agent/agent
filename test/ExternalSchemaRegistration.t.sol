// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {MockERC20} from "../contracts/mocks/MockERC20.sol";
import {TreasuryPolicy} from "../contracts/TreasuryPolicy.sol";
import {StrategyAdapterRegistry} from "../contracts/StrategyAdapterRegistry.sol";
import {AgentAccountCore} from "../contracts/AgentAccountCore.sol";
import {EscrowCore} from "../contracts/EscrowCore.sol";
import {ReputationSBT} from "../contracts/ReputationSBT.sol";

interface VmEvent {
    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData, address emitter) external;
}

contract ExternalSchemaRegistrationTest is Test {
    VmEvent internal constant vmEvent = VmEvent(address(uint160(uint256(keccak256("hevm cheat code")))));

    TreasuryPolicy internal policy;
    StrategyAdapterRegistry internal registry;
    AgentAccountCore internal accounts;
    ReputationSBT internal reputation;
    EscrowCore internal escrow;
    MockERC20 internal dot;

    address internal poster = address(0xA11CE);
    address internal issuer = 0xCc8940b1c72567cf04c9Ccc96242Ee7A4444534C;
    address internal otherIssuer = 0xFf1914A904ed524aec571244c5aEb2140C234304;

    bytes32 internal constant SPEC_HASH = bytes32("SPEC_HASH");
    bytes32 internal constant SCHEMA_HASH = keccak256("external schema");
    string internal constant SCHEMA_URL = "https://schemas.example.com/jobs/external-output.json";
    bytes internal constant VALID_SIGNATURE =
        hex"876a9ed85c63b0773c3d2d5a7eac09204aa00c7da465bfe2648f063336d5efba33eda920e896a1f5d977e15bc55c29813382e9d0fcac3679a96bc1d760c576e01b";
    bytes internal constant BAD_SIGNATURE =
        hex"a1d1c6d2e40953c768d6b12351c9029ab3d0a7d0b238444fca2163ff8934b79e56eceb48f9440700cdf90bbf372e4d7e0d06cf2162df0d5961aaa72400104aed1c";
    bytes internal constant UNTRUSTED_SIGNATURE =
        hex"1aa6b1387ef692d01bccd36f02a8e05f202500db457f28f1c558e0b3bf43c9fc1c5525a8c931d1928b10aa1083e19e649ef91691d24dc94f003f5ba338689b811b";
    bytes internal constant RECURRING_SIGNATURE =
        hex"64e2697330e5627eb177c3c9f7e5849f8a9ee101f0b04263a5bb3c824fd6cea15b243561da102b39c329e036650435b9562f5ca11e68e06f0ad36ba03c849f031b";

    event TrustedSchemaIssuerSet(address indexed issuer, bool approved);
    event ExternalSchemaRegistered(
        bytes32 indexed jobId, bytes32 indexed schemaHash, address indexed schemaIssuer, string schemaUrl
    );

    function setUp() public {
        policy = new TreasuryPolicy();
        registry = new StrategyAdapterRegistry(policy);
        accounts = new AgentAccountCore(policy, registry);
        reputation = new ReputationSBT(policy);
        escrow = new EscrowCore(policy, accounts, reputation);
        dot = new MockERC20("Mock DOT", "mDOT");
        policy.setApprovedAsset(address(dot), true);
        policy.setServiceOperator(address(escrow), true);
        accounts.setEscrowOperator(address(escrow), true);
        policy.setServiceOperator(address(accounts), true);
        policy.setServiceOperator(address(this), true);

        dot.mint(poster, 1_000 ether);
        vm.startPrank(poster);
        dot.approve(address(accounts), type(uint256).max);
        accounts.deposit(address(dot), 500 ether);
        vm.stopPrank();
    }

    function testOwnerGatesTrustedSchemaIssuerAndEmits() public {
        vmEvent.expectEmit(true, false, false, true, address(policy));
        emit TrustedSchemaIssuerSet(issuer, true);
        policy.setTrustedSchemaIssuer(issuer, true);
        require(policy.trustedSchemaIssuers(issuer), "EXPECTED_TRUSTED_ISSUER");

        vm.prank(address(0xBEEF));
        (bool ok,) = address(policy).call(abi.encodeCall(policy.setTrustedSchemaIssuer, (otherIssuer, true)));
        require(!ok, "EXPECTED_OWNER_GATE_REVERT");
    }

    function testValidExternalSchemaAccepted() public {
        policy.setTrustedSchemaIssuer(issuer, true);
        bytes32 jobId = keccak256("job/external-schema/valid");
        bytes memory signature = VALID_SIGNATURE;

        vmEvent.expectEmit(true, true, true, true, address(escrow));
        emit ExternalSchemaRegistered(jobId, SCHEMA_HASH, issuer, SCHEMA_URL);

        vm.prank(poster);
        escrow.createSinglePayoutJob(
            jobId,
            address(dot),
            10 ether,
            0,
            0,
            1 days,
            bytes32("AUTO"),
            bytes32("CODING"),
            SPEC_HASH,
            EscrowCore.ExternalSchemaRegistration({
                schemaHash: SCHEMA_HASH, schemaUrl: SCHEMA_URL, schemaIssuer: issuer, schemaSignature: signature
            })
        );

        (bytes32 schemaHash, string memory schemaUrl, address schemaIssuer, bytes memory schemaSignature) =
            escrow.jobExternalSchemas(jobId);
        require(schemaHash == SCHEMA_HASH, "EXPECTED_SCHEMA_HASH");
        require(keccak256(bytes(schemaUrl)) == keccak256(bytes(SCHEMA_URL)), "EXPECTED_SCHEMA_URL");
        require(schemaIssuer == issuer, "EXPECTED_SCHEMA_ISSUER");
        require(keccak256(schemaSignature) == keccak256(signature), "EXPECTED_SCHEMA_SIGNATURE");
    }

    function testInvalidSignatureRejected() public {
        policy.setTrustedSchemaIssuer(issuer, true);
        bytes32 jobId = keccak256("job/external-schema/bad-signature");
        bytes memory signature = BAD_SIGNATURE;

        vm.prank(poster);
        (bool ok,) = address(escrow).call(createExternalSchemaJobCalldata(jobId, issuer, signature));
        require(!ok, "EXPECTED_BAD_SIGNATURE_REVERT");
    }

    function testUntrustedIssuerRejected() public {
        bytes32 jobId = keccak256("job/external-schema/untrusted");
        bytes memory signature = UNTRUSTED_SIGNATURE;

        vm.prank(poster);
        (bool ok,) = address(escrow).call(createExternalSchemaJobCalldata(jobId, issuer, signature));
        require(!ok, "EXPECTED_UNTRUSTED_ISSUER_REVERT");
    }

    function testRecurringReserveAcceptsExternalSchemaMetadata() public {
        policy.setTrustedSchemaIssuer(issuer, true);
        bytes32 templateId = keccak256("template/external-schema");
        bytes32 jobId = keccak256("template/external-schema/run/1");
        bytes memory signature = RECURRING_SIGNATURE;

        vm.prank(poster);
        accounts.reserveForRecurringTemplate(poster, address(dot), templateId, 10 ether);

        escrow.createSinglePayoutJobFromRecurringReserve(
            EscrowCore.RecurringSinglePayoutJob({
                jobId: jobId,
                templateId: templateId,
                poster: poster,
                asset: address(dot),
                reward: 5 ether,
                opsReserve: 0,
                contingencyReserve: 0,
                claimTtl: 1 days,
                verifierMode: bytes32("AUTO"),
                category: bytes32("CODING"),
                specHash: SPEC_HASH,
                schemaHash: SCHEMA_HASH,
                schemaUrl: SCHEMA_URL,
                schemaIssuer: issuer,
                schemaSignature: signature
            })
        );

        (bytes32 schemaHash,, address schemaIssuer,) = escrow.jobExternalSchemas(jobId);
        require(schemaHash == SCHEMA_HASH, "EXPECTED_SCHEMA_HASH");
        require(schemaIssuer == issuer, "EXPECTED_SCHEMA_ISSUER");
    }

    function createExternalSchemaJobCalldata(bytes32 jobId, address schemaIssuer, bytes memory signature)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodeWithSelector(
            bytes4(
                keccak256(
                    "createSinglePayoutJob(bytes32,address,uint256,uint256,uint256,uint256,bytes32,bytes32,bytes32,(bytes32,string,address,bytes))"
                )
            ),
            jobId,
            address(dot),
            10 ether,
            0,
            0,
            1 days,
            bytes32("AUTO"),
            bytes32("CODING"),
            SPEC_HASH,
            EscrowCore.ExternalSchemaRegistration({
                schemaHash: SCHEMA_HASH, schemaUrl: SCHEMA_URL, schemaIssuer: schemaIssuer, schemaSignature: signature
            })
        );
    }
}
