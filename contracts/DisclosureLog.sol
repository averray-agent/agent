// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract DisclosureLog {
    address public publisher;

    mapping(bytes32 => bool) public disclosed;
    mapping(bytes32 => bool) public autoDisclosed;

    event Disclosed(bytes32 indexed hash, address indexed byWallet, uint64 timestamp);
    event AutoDisclosed(bytes32 indexed hash, uint64 timestamp);
    event PublisherUpdated(address indexed previousPublisher, address indexed newPublisher);

    error Unauthorized();
    error ZeroAddress();
    error AlreadyAutoDisclosed();

    constructor(address publisher_) {
        if (publisher_ == address(0)) revert ZeroAddress();
        publisher = publisher_;
    }

    modifier onlyPublisher() {
        if (msg.sender != publisher) revert Unauthorized();
        _;
    }

    function disclose(bytes32 hash, address byWallet) external onlyPublisher {
        disclosed[hash] = true;
        emit Disclosed(hash, byWallet, uint64(block.timestamp));
    }

    function autoDisclose(bytes32 hash) external onlyPublisher {
        if (autoDisclosed[hash]) revert AlreadyAutoDisclosed();
        autoDisclosed[hash] = true;
        emit AutoDisclosed(hash, uint64(block.timestamp));
    }

    function setPublisher(address newPublisher) external onlyPublisher {
        if (newPublisher == address(0)) revert ZeroAddress();
        emit PublisherUpdated(publisher, newPublisher);
        publisher = newPublisher;
    }
}
