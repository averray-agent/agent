// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TreasuryPolicy} from "./TreasuryPolicy.sol";

contract ReputationSBT {
    TreasuryPolicy public immutable policy;
    string public name = "Agent Reputation Badge";
    string public symbol = "ARB";
    uint256 public nextTokenId = 1;

    struct Badge {
        address owner;
        bytes32 category;
        uint256 level;
        string metadataURI;
    }

    struct ReputationView {
        uint256 skill;
        uint256 reliability;
        uint256 economic;
    }

    mapping(uint256 => Badge) public badges;
    mapping(address => uint256[]) public tokensByOwner;
    mapping(address => mapping(bytes32 => uint256)) public categoryLevels;
    mapping(address => ReputationView) public reputations;

    event BadgeMinted(uint256 indexed tokenId, address indexed account, bytes32 indexed category, uint256 level, string metadataURI);
    event ReputationUpdated(address indexed account, uint256 skill, uint256 reliability, uint256 economic);
    event ReputationSlashed(
        address indexed account,
        uint256 skillDelta,
        uint256 reliabilityDelta,
        uint256 economicDelta,
        bytes32 reasonCode,
        uint256 newSkill,
        uint256 newReliability,
        uint256 newEconomic
    );

    error Unauthorized();
    error Soulbound();

    constructor(TreasuryPolicy policy_) {
        policy = policy_;
    }

    modifier onlyOperator() {
        if (!policy.serviceOperators(msg.sender)) revert Unauthorized();
        _;
    }

    function balanceOf(address account) external view returns (uint256) {
        return tokensByOwner[account].length;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return badges[tokenId].owner;
    }

    function mintBadge(address account, bytes32 category, uint256 level, string calldata metadataURI) external onlyOperator returns (uint256 tokenId) {
        tokenId = nextTokenId++;
        badges[tokenId] = Badge({
            owner: account,
            category: category,
            level: level,
            metadataURI: metadataURI
        });
        tokensByOwner[account].push(tokenId);
        if (level > categoryLevels[account][category]) {
            categoryLevels[account][category] = level;
        }
        emit BadgeMinted(tokenId, account, category, level, metadataURI);
    }

    function updateReputation(address account, uint256 skill, uint256 reliability, uint256 economic) external onlyOperator {
        reputations[account] = ReputationView(skill, reliability, economic);
        emit ReputationUpdated(account, skill, reliability, economic);
    }

    function slashReputation(
        address account,
        uint256 skillDelta,
        uint256 reliabilityDelta,
        uint256 economicDelta,
        bytes32 reasonCode
    ) external onlyOperator {
        ReputationView storage reputation = reputations[account];
        reputation.skill = _saturatingSubtract(reputation.skill, skillDelta);
        reputation.reliability = _saturatingSubtract(reputation.reliability, reliabilityDelta);
        reputation.economic = _saturatingSubtract(reputation.economic, economicDelta);
        emit ReputationSlashed(
            account,
            skillDelta,
            reliabilityDelta,
            economicDelta,
            reasonCode,
            reputation.skill,
            reputation.reliability,
            reputation.economic
        );
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        return badges[tokenId].metadataURI;
    }

    function transferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function transfer(address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert Soulbound();
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert Soulbound();
    }

    function _saturatingSubtract(uint256 value, uint256 delta) internal pure returns (uint256) {
        if (delta >= value) {
            return 0;
        }
        return value - delta;
    }
}
