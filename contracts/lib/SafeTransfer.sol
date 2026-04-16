// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Lightweight SafeERC20-style transfer helpers.
///
/// Some ERC20s (most famously USDT) return no bool on transfer/transferFrom,
/// while others return false instead of reverting on failure. Wrapping the
/// low-level call here normalises both behaviours: success requires either
/// (a) no return data, or (b) a return of exactly 32 bytes that decodes to
/// `true`. Any other outcome reverts with TRANSFER_FAILED.
library SafeTransfer {
    error TransferFailed();

    function safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        _checkResult(ok, data);
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        _checkResult(ok, data);
    }

    function _checkResult(bool ok, bytes memory data) private pure {
        if (!ok) revert TransferFailed();
        if (data.length == 0) {
            return;
        }
        if (data.length != 32) revert TransferFailed();
        if (abi.decode(data, (bool)) == false) revert TransferFailed();
    }
}
