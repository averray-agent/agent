// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {DepositPool} from "../contracts/DepositPool.sol";
import {IDepositPoolVenueAdapter} from "../contracts/interfaces/IDepositPoolVenueAdapter.sol";

interface VmDepositPool {
    function expectRevert(bytes4 selector) external;
}

contract DepositPoolTest is Test {
    uint256 internal constant USDC = 1e6;
    VmDepositPool internal constant vmx = VmDepositPool(address(uint160(uint256(keccak256("hevm cheat code")))));

    MockPoolUsdc internal asset;
    MockPoolVenueAdapter internal adapter;
    DepositPool internal pool;

    address internal operator = address(0xA0);
    address internal agent = address(0xA11CE);
    address internal agentTwo = address(0xB0B);
    address internal recipient = address(0xCAFE);

    function setUp() public {
        asset = new MockPoolUsdc();
        adapter = new MockPoolVenueAdapter(asset);
        pool = new DepositPool(address(asset), operator, adapter);
        _fundAndApprove(agent, 200 * USDC);
        _fundAndApprove(agentTwo, 200 * USDC);
        _fundAndApprove(operator, 1_000 * USDC);
    }

    function testDepositTenUsdcRedeemInstantReturnsTenFromBuffer() public {
        vm.prank(agent);
        uint256 shares = pool.deposit(10 * USDC, agent);

        assertEq(shares, 10 * USDC);
        assertEq(pool.balanceOf(agent), 10 * USDC);
        assertEq(pool.totalAssets(), 10 * USDC);
        assertEq(pool.bufferAssets(), 10 * USDC);

        vm.prank(agent);
        uint256 assetsReturned = pool.redeem(shares, agent, agent);

        assertEq(assetsReturned, 10 * USDC);
        assertEq(asset.balanceOf(agent), 200 * USDC);
        assertEq(asset.balanceOf(address(pool)), 0);
        assertEq(pool.totalSupply(), 0);
    }

    function testNotice7DayRedeemRevertsAtPeriodMinusOneAndSucceedsAtPeriod() public {
        vm.prank(agent);
        uint256 shares = pool.deposit(10 * USDC, agent);

        uint256 requestedAt = block.timestamp;
        vm.prank(agent);
        uint256 requestId = pool.requestRedeem(shares, recipient, DepositPool.NoticeTier.Notice7Days);
        (,,, uint64 unlockAt,,) = pool.redeemRequests(requestId);
        assertEq(uint256(unlockAt), requestedAt + 7 days);

        vm.warp(uint256(unlockAt) - 1);
        (bool ok, bytes memory data) = address(pool).call(abi.encodeCall(pool.fulfilRedeem, (requestId)));
        _assertRevertedWith(ok, data, DepositPool.NoticeNotElapsed.selector);

        vm.warp(uint256(unlockAt));
        uint256 assetsReturned = pool.fulfilRedeem(requestId);
        assertEq(assetsReturned, 10 * USDC);
        assertEq(asset.balanceOf(recipient), 10 * USDC);
        assertEq(pool.lockedShares(agent), 0);
    }

    function testNotice30DayTierUsesFullThirtyDayPeriod() public {
        vm.prank(agent);
        uint256 shares = pool.deposit(10 * USDC, agent);

        uint256 requestedAt = block.timestamp;
        vm.prank(agent);
        uint256 requestId = pool.requestRedeem(shares, agent, DepositPool.NoticeTier.Notice30Days);
        (,,, uint64 unlockAt, DepositPool.NoticeTier tier,) = pool.redeemRequests(requestId);
        assertEq(uint256(tier), uint256(DepositPool.NoticeTier.Notice30Days));
        assertEq(uint256(unlockAt), requestedAt + 30 days);

        vm.warp(uint256(unlockAt));
        assertEq(pool.fulfilRedeem(requestId), 10 * USDC);
    }

    function testRequestedSharesCannotAlsoRedeemInstantly() public {
        vm.prank(agent);
        uint256 shares = pool.deposit(10 * USDC, agent);
        vm.prank(agent);
        pool.requestRedeem(shares, agent, DepositPool.NoticeTier.Notice7Days);

        vm.prank(agent);
        vmx.expectRevert(DepositPool.InsufficientUnlockedShares.selector);
        pool.redeem(1, agent, agent);
    }

    function testVenueYieldRaisesShareValueOnlyOnDeployedFraction() public {
        vm.prank(agent);
        uint256 shares = pool.deposit(10 * USDC, agent);
        assertEq(shares, 10 * USDC);

        vm.prank(operator);
        pool.deployToVenue(5 * USDC, uint64(block.timestamp + 1 days));
        assertEq(pool.bufferAssets(), 5 * USDC);
        assertEq(adapter.managedAssets(address(pool)), 5 * USDC);

        adapter.simulateYield(address(pool), 1_000);

        assertEq(pool.balanceOf(agent), 10 * USDC);
        assertEq(pool.totalAssets(), 10_500_000);
        assertEq(pool.convertToAssets(shares), 10_500_000);
        assertEq(pool.earnedProtocolFees(), 0);
        assertEq(pool.PLATFORM_FEE_BPS(), 0);
    }

    function testInstantRedeemUsesBufferRatherThanVenueAccounting() public {
        vm.prank(agent);
        pool.deposit(10 * USDC, agent);
        vm.prank(operator);
        pool.deployToVenue(8 * USDC, uint64(block.timestamp + 1 days));

        vm.prank(agent);
        (bool ok, bytes memory data) = address(pool).call(abi.encodeCall(pool.redeem, (3 * USDC, agent, agent)));
        _assertRevertedWith(ok, data, DepositPool.InsufficientBuffer.selector);
    }

    function testOperatorPrincipalAndEarnedFeesRemainSeparateLedgerLines() public {
        vm.prank(agent);
        uint256 agentShares = pool.deposit(10 * USDC, agent);
        uint256 agentAssetsBefore = pool.convertToAssets(agentShares);

        vm.prank(operator);
        uint256 principalShares = pool.contributeOperatorPrincipal(10 * USDC);

        assertEq(principalShares, 10 * USDC);
        assertEq(pool.operatorContributedPrincipal(), 10 * USDC);
        assertEq(pool.operatorPrincipalShares(), 10 * USDC);
        assertEq(pool.balanceOf(address(pool)), 10 * USDC);
        assertEq(pool.earnedProtocolFees(), 0);
        assertEq(pool.convertToAssets(agentShares), agentAssetsBefore);
        assertEq(pool.totalAssets(), 20 * USDC);
    }

    function testOperatorPrincipalUsesDepositRoundingAndCannotDiluteAgents() public {
        vm.prank(agent);
        uint256 agentShares = pool.deposit(10 * USDC, agent);
        vm.prank(operator);
        pool.deployToVenue(5 * USDC, uint64(block.timestamp + 1 days));
        adapter.simulateYield(address(pool), 1_000);
        uint256 agentAssetsBefore = pool.convertToAssets(agentShares);

        vm.prank(operator);
        uint256 principalShares = pool.contributeOperatorPrincipal(1 * USDC);

        assertEq(principalShares, 952_380);
        assertEq(pool.operatorContributedPrincipal(), 1 * USDC);
        assertEq(pool.earnedProtocolFees(), 0);
        assertEq(pool.convertToAssets(agentShares), agentAssetsBefore);
    }

    function testMintSuppliesExactRequestedSharesWithStandardRounding() public {
        vm.prank(agent);
        pool.deposit(10 * USDC, agent);
        vm.prank(operator);
        pool.deployToVenue(5 * USDC, uint64(block.timestamp + 1 days));
        adapter.simulateYield(address(pool), 1_000);

        vm.prank(agentTwo);
        uint256 assetsPaid = pool.mint(1 * USDC, agentTwo);
        assertEq(assetsPaid, 1_050_000);
        assertEq(pool.balanceOf(agentTwo), 1 * USDC);
    }

    function testPerAgentCapRejectsTheOneHundredAndFirstUsdc() public {
        vm.prank(agent);
        pool.deposit(100 * USDC, agent);

        vm.prank(agent);
        (bool ok, bytes memory data) = address(pool).call(abi.encodeCall(pool.deposit, (1 * USDC, agent)));
        _assertRevertedWith(ok, data, DepositPool.AgentAssetCapExceeded.selector);
    }

    function testPoolCapRejectsTheOneThousandAndFirstUsdc() public {
        for (uint160 i = 1; i <= 10; i++) {
            address depositor = address(0x1000 + i);
            _fundAndApprove(depositor, 100 * USDC);
            vm.prank(depositor);
            pool.deposit(100 * USDC, depositor);
        }
        assertEq(pool.totalAssets(), 1_000 * USDC);

        address eleventh = address(0x2000);
        _fundAndApprove(eleventh, 1 * USDC);
        vm.prank(eleventh);
        (bool ok, bytes memory data) = address(pool).call(abi.encodeCall(pool.deposit, (1 * USDC, eleventh)));
        _assertRevertedWith(ok, data, DepositPool.TotalAssetCapExceeded.selector);
    }

    function testTransferAndTransferFromAlwaysRevert() public {
        vm.prank(agent);
        pool.deposit(10 * USDC, agent);

        vm.prank(agent);
        vmx.expectRevert(DepositPool.SharesNonTransferable.selector);
        pool.transfer(agentTwo, 1 * USDC);

        vm.prank(agent);
        pool.approve(agentTwo, 1 * USDC);
        vm.prank(agentTwo);
        vmx.expectRevert(DepositPool.SharesNonTransferable.selector);
        pool.transferFrom(agent, agentTwo, 1 * USDC);
    }

    function testAdapterDeploymentIsPinnedClockedAndOperatorRecallable() public {
        vm.prank(agent);
        pool.deposit(10 * USDC, agent);

        uint64 returnBy = uint64(block.timestamp + 2 days);
        vm.prank(operator);
        uint256 deploymentId = pool.deployToVenue(6 * USDC, returnBy);
        (uint256 principal, uint256 recalled, uint64 recordedReturnBy) = pool.venueDeployments(deploymentId);
        assertEq(principal, 6 * USDC);
        assertEq(recalled, 0);
        assertEq(recordedReturnBy, returnBy);

        vm.prank(agentTwo);
        vmx.expectRevert(DepositPool.Unauthorized.selector);
        pool.recallVenueDeployment(deploymentId, 6 * USDC);

        vm.prank(operator);
        assertEq(pool.recallVenueDeployment(deploymentId, 6 * USDC), 6 * USDC);
        assertEq(pool.bufferAssets(), 10 * USDC);
        assertEq(adapter.managedAssets(address(pool)), 0);
    }

    function testOnlyOperatorCanCreateVenueDeployment() public {
        vm.prank(agent);
        pool.deposit(10 * USDC, agent);

        vm.prank(agent);
        vmx.expectRevert(DepositPool.Unauthorized.selector);
        pool.deployToVenue(1 * USDC, uint64(block.timestamp + 1 days));
    }

    function testVenueDeploymentRequiresAPoolSelectedFutureDeadline() public {
        vm.prank(agent);
        pool.deposit(10 * USDC, agent);

        vm.prank(operator);
        vmx.expectRevert(DepositPool.InvalidReturnDeadline.selector);
        pool.deployToVenue(1 * USDC, uint64(block.timestamp));
    }

    function testDepositPullsOnlyFromSignerAndCannotUseAnAgentsApproval() public {
        MockPoolUsdc freshAsset = new MockPoolUsdc();
        DepositPool freshPool = new DepositPool(address(freshAsset), operator, IDepositPoolVenueAdapter(address(0)));
        freshAsset.mint(agent, 10 * USDC);
        vm.prank(agent);
        freshAsset.approve(address(freshPool), type(uint256).max);

        vm.prank(operator);
        (bool ok,) = address(freshPool).call(abi.encodeCall(freshPool.deposit, (10 * USDC, agent)));
        require(!ok, "OPERATOR_USED_AGENT_APPROVAL");
        assertEq(freshAsset.balanceOf(agent), 10 * USDC);
        assertEq(freshAsset.balanceOf(address(freshPool)), 0);
        assertEq(freshPool.balanceOf(agent), 0);

        vm.prank(agent);
        assertEq(freshPool.deposit(10 * USDC, agent), 10 * USDC);
    }

    function testStandalonePoolNeedsNoAdapterAndHasNoLiveVenuePath() public {
        MockPoolUsdc freshAsset = new MockPoolUsdc();
        DepositPool freshPool = new DepositPool(address(freshAsset), operator, IDepositPoolVenueAdapter(address(0)));
        freshAsset.mint(agent, 10 * USDC);
        vm.startPrank(agent);
        freshAsset.approve(address(freshPool), type(uint256).max);
        freshPool.deposit(10 * USDC, agent);
        vm.stopPrank();

        assertEq(freshPool.totalAssets(), 10 * USDC);
        vm.prank(operator);
        vmx.expectRevert(DepositPool.VenueNotConfigured.selector);
        freshPool.deployToVenue(1 * USDC, uint64(block.timestamp + 1 days));
    }

    function testStructuralLaw6RuntimeHasNoCreditOrDiscretionaryEgressSurface() public view {
        bytes memory runtime = address(pool).code;
        bytes4[16] memory forbidden = [
            bytes4(keccak256("borrow(uint256)")),
            bytes4(keccak256("borrow(address,uint256)")),
            bytes4(keccak256("borrow(address,address,uint256)")),
            bytes4(keccak256("lend(uint256)")),
            bytes4(keccak256("lend(address,uint256)")),
            bytes4(keccak256("lend(address,address,uint256)")),
            bytes4(keccak256("loan(uint256)")),
            bytes4(keccak256("loan(address,uint256)")),
            bytes4(keccak256("sendToAgentFor(address,address,uint256)")),
            bytes4(keccak256("sweep(address,address,uint256)")),
            bytes4(keccak256("rescueTokens(address,address,uint256)")),
            bytes4(keccak256("withdrawOperatorPrincipal(uint256,address)")),
            bytes4(keccak256("setVenueAdapter(address)")),
            bytes4(keccak256("setReserveRatio(uint256)")),
            bytes4(keccak256("depositFor(address,uint256)")),
            bytes4(keccak256("depositFrom(address,uint256,address)"))
        ];
        for (uint256 i = 0; i < forbidden.length; i++) {
            require(!_containsBytes(runtime, abi.encodePacked(forbidden[i])), "FORBIDDEN_SELECTOR_FOUND");
        }
        assertEq(pool.asset(), address(asset));
        assertEq(pool.operator(), operator);
        assertEq(address(pool.venueAdapter()), address(adapter));
    }

    function _fundAndApprove(address account, uint256 amount) internal {
        asset.mint(account, amount);
        vm.prank(account);
        asset.approve(address(pool), type(uint256).max);
    }

    function _assertRevertedWith(bool ok, bytes memory data, bytes4 expected) internal pure {
        require(!ok, "EXPECTED_REVERT");
        require(data.length >= 4, "MISSING_REVERT_SELECTOR");
        bytes4 actual;
        assembly {
            actual := mload(add(data, 32))
        }
        require(actual == expected, "WRONG_REVERT_SELECTOR");
    }

    function _containsBytes(bytes memory source, bytes memory target) internal pure returns (bool) {
        if (target.length == 0 || target.length > source.length) return false;
        for (uint256 i = 0; i <= source.length - target.length; i++) {
            bool equal = true;
            for (uint256 j = 0; j < target.length; j++) {
                if (source[i + j] != target[j]) {
                    equal = false;
                    break;
                }
            }
            if (equal) return true;
        }
        return false;
    }
}

contract MockPoolUsdc {
    string public constant name = "Mock USDC";
    string public constant symbol = "mUSDC";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "ALLOWANCE");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "BALANCE");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

contract MockPoolVenueAdapter is IDepositPoolVenueAdapter {
    MockPoolUsdc public immutable token;
    address public immutable override asset;
    mapping(address => uint256) public override managedAssets;
    mapping(address => uint64) public returnDeadline;

    constructor(MockPoolUsdc token_) {
        token = token_;
        asset = address(token_);
    }

    function deploy(uint256 assets, uint64 returnBy) external override {
        require(returnBy > block.timestamp, "DEADLINE");
        managedAssets[msg.sender] += assets;
        returnDeadline[msg.sender] = returnBy;
    }

    function recall(uint256 assets) external override returns (uint256 returnedAssets) {
        require(managedAssets[msg.sender] >= assets, "MANAGED");
        managedAssets[msg.sender] -= assets;
        require(token.transfer(msg.sender, assets), "TRANSFER");
        return assets;
    }

    function simulateYield(address pool, uint256 bps) external returns (uint256 accrued) {
        accrued = (managedAssets[pool] * bps) / 10_000;
        managedAssets[pool] += accrued;
        token.mint(address(this), accrued);
    }
}
