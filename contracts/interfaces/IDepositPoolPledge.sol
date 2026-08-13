// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IDepositPoolPledge {
    struct PledgeRecord {
        address owner;
        uint256 shares;
        bool active;
    }

    function asset() external view returns (address);
    function pledgedShares(address owner) external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256);
    function pledges(bytes32 loanId) external view returns (address owner, uint256 shares, bool active);
    function release(bytes32 loanId) external;
    function seize(bytes32 loanId, address receiver) external returns (uint256 assets);
}
