// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract DiscoveryRegistry {
    address public publisher;
    bytes32 public currentManifestHash;
    uint64 public currentVersion;

    event ManifestPublished(
        uint64 indexed version,
        bytes32 indexed hash,
        uint64 timestamp,
        address publisher
    );
    event PublisherUpdated(address indexed previousPublisher, address indexed newPublisher);

    error Unauthorized();
    error ZeroAddress();

    constructor(address publisher_) {
        if (publisher_ == address(0)) revert ZeroAddress();
        publisher = publisher_;
    }

    modifier onlyPublisher() {
        if (msg.sender != publisher) revert Unauthorized();
        _;
    }

    function publish(bytes32 newHash) external onlyPublisher {
        currentVersion += 1;
        currentManifestHash = newHash;
        emit ManifestPublished(currentVersion, newHash, uint64(block.timestamp), msg.sender);
    }

    function setPublisher(address newPublisher) external onlyPublisher {
        if (newPublisher == address(0)) revert ZeroAddress();
        emit PublisherUpdated(publisher, newPublisher);
        publisher = newPublisher;
    }
}
