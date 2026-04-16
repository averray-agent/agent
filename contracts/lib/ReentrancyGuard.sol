// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal reentrancy guard modelled on OpenZeppelin's pattern but
///         without an external dependency. Works by toggling a single storage
///         slot between "not entered" (1) and "entered" (2). The non-zero base
///         value keeps the SSTORE cost consistent across the first and
///         subsequent calls.
abstract contract ReentrancyGuard {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    uint256 private _status;

    error ReentrantCall();

    constructor() {
        _status = _NOT_ENTERED;
    }

    modifier nonReentrant() {
        if (_status == _ENTERED) revert ReentrantCall();
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }
}
