// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract VerifierRegistry {
    address public admin;

    mapping(address => bool) public isAuthorized;
    mapping(address => bool) public hasBeenAuthorized;
    mapping(address => uint64) public authorizedSince;
    mapping(address => uint64) public authorizedUntil;

    struct AuthorizationWindow {
        uint64 since;
        uint64 until;
    }

    mapping(address => AuthorizationWindow[]) internal _authorizationWindows;

    event VerifierAdded(address indexed verifier, uint64 timestamp);
    event VerifierRemoved(address indexed verifier, uint64 timestamp);
    event AdminTransferred(address indexed from, address indexed to);

    error Unauthorized();
    error ZeroAddress();
    error AlreadyAuthorized();
    error NotAuthorized();

    constructor(address admin_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

    function addVerifier(address verifier) external onlyAdmin {
        if (verifier == address(0)) revert ZeroAddress();
        if (isAuthorized[verifier]) revert AlreadyAuthorized();
        isAuthorized[verifier] = true;
        hasBeenAuthorized[verifier] = true;
        authorizedSince[verifier] = uint64(block.timestamp);
        authorizedUntil[verifier] = 0;
        _authorizationWindows[verifier].push(AuthorizationWindow({
            since: uint64(block.timestamp),
            until: 0
        }));
        emit VerifierAdded(verifier, uint64(block.timestamp));
    }

    function removeVerifier(address verifier) external onlyAdmin {
        if (!isAuthorized[verifier]) revert NotAuthorized();
        isAuthorized[verifier] = false;
        authorizedUntil[verifier] = uint64(block.timestamp);
        uint256 lastIndex = _authorizationWindows[verifier].length - 1;
        _authorizationWindows[verifier][lastIndex].until = uint64(block.timestamp);
        emit VerifierRemoved(verifier, uint64(block.timestamp));
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    function wasAuthorizedAt(address verifier, uint64 timestamp) external view returns (bool) {
        AuthorizationWindow[] storage windows = _authorizationWindows[verifier];
        for (uint256 i = 0; i < windows.length; i++) {
            if (timestamp < windows[i].since) continue;
            if (windows[i].until != 0 && timestamp >= windows[i].until) continue;
            return true;
        }
        return false;
    }
}
