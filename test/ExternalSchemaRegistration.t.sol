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

interface VmSign {
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
}

contract ExternalSchemaRegistrationTest is Test {
    VmEvent internal constant vmEvent = VmEvent(address(uint160(uint256(keccak256("hevm cheat code")))));
    VmSign internal constant vmSign = VmSign(address(uint160(uint256(keccak256("hevm cheat code")))));

    TreasuryPolicy internal policy;
    StrategyAdapterRegistry internal registry;
    AgentAccountCore internal accounts;
    ReputationSBT internal reputation;
    EscrowCore internal escrow;
    MockERC20 internal dot;

    address internal poster = address(0xA11CE);
    uint256 internal constant ISSUER_KEY = 0xA11CE123;
    uint256 internal constant OTHER_ISSUER_KEY = 0xB0B;
    address internal issuer = 0xCc8940b1c72567cf04c9Ccc96242Ee7A4444534C;
    address internal otherIssuer = 0x0376AAc07Ad725E01357B1725B5ceC61aE10473c;

    bytes32 internal constant SPEC_HASH = bytes32("SPEC_HASH");
    bytes32 internal constant SCHEMA_HASH = keccak256("external schema");
    string internal constant SCHEMA_URL = "https://schemas.example.com/jobs/external-output.json";
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant EIP712_NAME_HASH = keccak256("Averray EscrowCore");
    bytes32 internal constant EIP712_VERSION_HASH = keccak256("1");
    uint256 internal constant SECP256K1N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;

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
        bytes memory signature = signExternalSchema(escrow, jobId, ISSUER_KEY);

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
        bytes memory signature = signExternalSchema(escrow, jobId, OTHER_ISSUER_KEY);

        vm.prank(poster);
        (bool ok,) = address(escrow).call(createExternalSchemaJobCalldata(jobId, issuer, signature));
        require(!ok, "EXPECTED_BAD_SIGNATURE_REVERT");
    }

    function testUntrustedIssuerRejected() public {
        bytes32 jobId = keccak256("job/external-schema/untrusted");
        bytes memory signature = signExternalSchema(escrow, jobId, ISSUER_KEY);

        vm.prank(poster);
        (bool ok,) = address(escrow).call(createExternalSchemaJobCalldata(jobId, issuer, signature));
        require(!ok, "EXPECTED_UNTRUSTED_ISSUER_REVERT");
    }

    function testExternalSchemaSignatureCannotReplayAcrossEscrowContracts() public {
        policy.setTrustedSchemaIssuer(issuer, true);
        bytes32 jobId = keccak256("job/external-schema/replay-contract");
        bytes memory signature = signExternalSchema(escrow, jobId, ISSUER_KEY);
        EscrowCore otherEscrow = new EscrowCore(policy, accounts, reputation);
        policy.setServiceOperator(address(otherEscrow), true);
        accounts.setEscrowOperator(address(otherEscrow), true);

        vm.prank(poster);
        (bool ok,) = address(otherEscrow).call(createExternalSchemaJobCalldata(jobId, issuer, signature));
        require(!ok, "EXPECTED_CROSS_CONTRACT_REPLAY_REVERT");
    }

    function testExternalSchemaSignatureCannotReplayAcrossChainIds() public {
        policy.setTrustedSchemaIssuer(issuer, true);
        bytes32 jobId = keccak256("job/external-schema/replay-chain");
        bytes memory signature = signExternalSchemaForDomain(escrow, jobId, ISSUER_KEY, block.chainid + 1);

        vm.prank(poster);
        (bool ok,) = address(escrow).call(createExternalSchemaJobCalldata(jobId, issuer, signature));
        require(!ok, "EXPECTED_CROSS_CHAIN_REPLAY_REVERT");
    }

    function testHighSSignatureRejected() public {
        policy.setTrustedSchemaIssuer(issuer, true);
        bytes32 jobId = keccak256("job/external-schema/high-s");
        bytes memory signature = highSSignature(escrow, jobId, ISSUER_KEY);

        vm.prank(poster);
        (bool ok,) = address(escrow).call(createExternalSchemaJobCalldata(jobId, issuer, signature));
        require(!ok, "EXPECTED_HIGH_S_REVERT");
    }

    function testRecurringReserveAcceptsExternalSchemaMetadata() public {
        policy.setTrustedSchemaIssuer(issuer, true);
        bytes32 templateId = keccak256("template/external-schema");
        bytes32 jobId = keccak256("template/external-schema/run/1");
        bytes memory signature = signExternalSchema(escrow, jobId, ISSUER_KEY);

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

    function signExternalSchema(EscrowCore target, bytes32 jobId, uint256 signerKey) internal returns (bytes memory) {
        bytes32 digest = target.hashExternalSchemaRegistration(SCHEMA_HASH, SCHEMA_URL, jobId);
        (uint8 v, bytes32 r, bytes32 s) = vmSign.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function signExternalSchemaForDomain(EscrowCore target, bytes32 jobId, uint256 signerKey, uint256 chainId)
        internal
        returns (bytes memory)
    {
        bytes32 domainSeparator = keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, EIP712_NAME_HASH, EIP712_VERSION_HASH, chainId, address(target))
        );
        bytes32 structHash = keccak256(
            abi.encode(
                target.EXTERNAL_SCHEMA_REGISTRATION_TYPEHASH(), SCHEMA_HASH, keccak256(bytes(SCHEMA_URL)), jobId
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vmSign.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function highSSignature(EscrowCore target, bytes32 jobId, uint256 signerKey) internal returns (bytes memory) {
        bytes32 digest = target.hashExternalSchemaRegistration(SCHEMA_HASH, SCHEMA_URL, jobId);
        (uint8 v, bytes32 r, bytes32 s) = vmSign.sign(signerKey, digest);
        bytes32 highS = bytes32(SECP256K1N - uint256(s));
        uint8 highV = v == 27 ? 28 : 27;
        return abi.encodePacked(r, highS, highV);
    }
}
