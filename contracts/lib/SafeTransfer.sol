// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Lightweight SafeERC20-style transfer helpers.
///
/// Some ERC20s (most famously USDT) return no bool on transfer/transferFrom,
/// while others return false instead of reverting on failure. Wrapping the
/// low-level call here normalises both behaviours: success requires either
/// (a) no return data, or (b) a return of exactly 32 bytes that decodes to
/// `true`. Any other outcome reverts with TransferFailed.
///
/// The `Exact` variants additionally check the recipient balance delta. That
/// makes vault accounting fail closed for fee-on-transfer, burn-on-transfer, or
/// otherwise non-canonical ERC20 behaviour instead of over-crediting ledgers.
library SafeTransfer {
    error TransferFailed();
    error BalanceQueryFailed();
    error TransferAmountMismatch(uint256 expected, uint256 actual);

    function safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        _checkResult(ok, data);
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        _checkResult(ok, data);
    }

    function safeTransferExact(address token, address to, uint256 amount) internal {
        uint256 beforeBalance = safeBalanceOf(token, to);
        safeTransfer(token, to, amount);
        _requireExactBalanceDelta(token, to, beforeBalance, amount);
    }

    function safeTransferFromExact(address token, address from, address to, uint256 amount) internal {
        uint256 beforeBalance = safeBalanceOf(token, to);
        safeTransferFrom(token, from, to, amount);
        _requireExactBalanceDelta(token, to, beforeBalance, amount);
    }

    function safeApprove(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        _checkResult(ok, data);
    }

    function safeBalanceOf(address token, address account) internal view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(0x70a08231, account));
        if (!ok || data.length < 32) revert BalanceQueryFailed();
        return abi.decode(data, (uint256));
    }

    function _checkResult(bool ok, bytes memory data) private pure {
        if (!ok) revert TransferFailed();
        if (data.length == 0) {
            return;
        }
        if (data.length != 32) revert TransferFailed();
        if (abi.decode(data, (bool)) == false) revert TransferFailed();
    }

    function _requireExactBalanceDelta(address token, address account, uint256 beforeBalance, uint256 expected)
        private
        view
    {
        uint256 afterBalance = safeBalanceOf(token, account);
        uint256 actual = afterBalance >= beforeBalance ? afterBalance - beforeBalance : 0;
        if (actual != expected) revert TransferAmountMismatch(expected, actual);
    }
}
