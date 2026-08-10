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

    function testThirtyDayNoticeRemainsHonourableAcrossSevenDayVenueRollovers() public {
        vm.prank(agent);
        uint256 shares = pool.deposit(10 * USDC, agent);
        vm.prank(agentTwo);
        pool.deposit(10 * USDC, agentTwo);

        vm.prank(agent);
        uint256 noticeRequestId = pool.requestRedeem(shares, agent, DepositPool.NoticeTier.Notice30Days);
        (,,, uint64 noticeUnlockAt,,) = pool.redeemRequests(noticeRequestId);

        vm.prank(operator);
        uint256 deploymentId = pool.deployToVenue(10 * USDC, uint64(block.timestamp + 7 days));
        _settleDeployment(deploymentId);

        for (uint256 epoch = 1; epoch <= 4; epoch++) {
            (,, uint64 returnBy,,) = pool.venueDeployments(deploymentId);
            vm.warp(returnBy);
            uint256 managed = adapter.managedAssets(address(pool));
            vm.prank(operator);
            uint256 recallId = pool.recallVenueDeployment(deploymentId, managed);
            _settleRecall(recallId);
            assertEq(adapter.managedAssets(address(pool)), 0);

            if (epoch < 4) {
                vm.prank(operator);
                deploymentId = pool.deployToVenue(10 * USDC, uint64(block.timestamp + 7 days));
                _settleDeployment(deploymentId);
            }
        }

        require(block.timestamp == uint256(noticeUnlockAt) - 2 days, "ROLLOVER_CLOCK_DRIFT");
        assertEq(pool.bufferAssets(), 20 * USDC);
        vm.warp(noticeUnlockAt);
        assertEq(pool.fulfilRedeem(noticeRequestId), 10 * USDC);
        assertEq(pool.activeVenueDeploymentId(), 0);
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
        vm.prank(agentTwo);
        pool.deposit(10 * USDC, agentTwo);
        assertEq(shares, 10 * USDC);

        vm.prank(operator);
        uint256 deploymentId = pool.deployToVenue(10 * USDC, uint64(block.timestamp + 7 days));
        _settleDeployment(deploymentId);
        assertEq(pool.bufferAssets(), 10 * USDC);
        assertEq(adapter.managedAssets(address(pool)), 10 * USDC);

        adapter.simulateYield(address(pool), 1_000);

        assertEq(pool.balanceOf(agent), 10 * USDC);
        assertEq(pool.totalAssets(), 21 * USDC);
        assertEq(pool.convertToAssets(shares), 10_500_000);
        assertEq(pool.earnedProtocolFees(), 0);
        assertEq(pool.PLATFORM_FEE_BPS(), 0);
    }

    function testInstantRedeemSucceedsWhileMaximumDeploymentIsInFlight() public {
        vm.prank(agent);
        uint256 shares = pool.deposit(10 * USDC, agent);
        vm.prank(agentTwo);
        pool.deposit(10 * USDC, agentTwo);

        assertEq(pool.bufferFloor(), 10 * USDC);
        assertEq(pool.maxDeployableAssets(), 10 * USDC);
        uint256 maximumDeployment = pool.maxDeployableAssets();
        vm.prank(operator);
        pool.deployToVenue(maximumDeployment, uint64(block.timestamp + 7 days));

        vm.prank(agent);
        assertEq(pool.redeem(shares, agent, agent), 10 * USDC);
        assertEq(pool.bufferAssets(), 0);
        assertEq(adapter.managedAssets(address(pool)), 10 * USDC);
    }

    function testBufferFloorCannotBeDeployedThroughForAnyOperatorAmount() public {
        vm.prank(agent);
        pool.deposit(10 * USDC, agent);
        vm.prank(agentTwo);
        pool.deposit(10 * USDC, agentTwo);

        vm.startPrank(operator);
        (bool oneOverOk, bytes memory oneOverData) =
            address(pool).call(abi.encodeCall(pool.deployToVenue, (10 * USDC + 1, uint64(block.timestamp + 7 days))));
        _assertRevertedWith(oneOverOk, oneOverData, DepositPool.BufferFloorBreached.selector);
        (bool maximumOk, bytes memory maximumData) = address(pool)
            .call(abi.encodeCall(pool.deployToVenue, (type(uint256).max, uint64(block.timestamp + 7 days))));
        _assertRevertedWith(maximumOk, maximumData, DepositPool.BufferFloorBreached.selector);
        vm.stopPrank();

        assertEq(pool.bufferAssets(), 20 * USDC);
        assertEq(adapter.managedAssets(address(pool)), 0);
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
        vm.prank(agentTwo);
        pool.deposit(10 * USDC, agentTwo);
        vm.prank(operator);
        uint256 deploymentId = pool.deployToVenue(10 * USDC, uint64(block.timestamp + 7 days));
        _settleDeployment(deploymentId);
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
        vm.prank(agentTwo);
        pool.deposit(10 * USDC, agentTwo);
        vm.prank(operator);
        uint256 deploymentId = pool.deployToVenue(10 * USDC, uint64(block.timestamp + 7 days));
        _settleDeployment(deploymentId);
        adapter.simulateYield(address(pool), 1_000);

        vm.prank(agentTwo);
        uint256 assetsPaid = pool.mint(1 * USDC, agentTwo);
        assertEq(assetsPaid, 1_050_000);
        assertEq(pool.balanceOf(agentTwo), 11 * USDC);
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
        vm.prank(agentTwo);
        pool.deposit(10 * USDC, agentTwo);

        uint64 returnBy = uint64(block.timestamp + 2 days);
        vm.prank(operator);
        uint256 deploymentId = pool.deployToVenue(6 * USDC, returnBy);
        (
            uint256 principal,
            uint256 recalled,
            uint64 recordedReturnBy,
            bytes32 deployRequestId,
            IDepositPoolVenueAdapter.RequestStatus deployStatus
        ) = pool.venueDeployments(deploymentId);
        assertEq(principal, 6 * USDC);
        assertEq(recalled, 0);
        assertEq(recordedReturnBy, returnBy);
        require(deployRequestId != bytes32(0), "MISSING_ADAPTER_REQUEST");
        assertEq(uint256(deployStatus), uint256(IDepositPoolVenueAdapter.RequestStatus.Pending));
        _settleDeployment(deploymentId);

        vm.prank(agentTwo);
        vmx.expectRevert(DepositPool.Unauthorized.selector);
        pool.recallVenueDeployment(deploymentId, 6 * USDC);

        vm.prank(operator);
        uint256 recallId = pool.recallVenueDeployment(deploymentId, 6 * USDC);
        _settleRecall(recallId);
        assertEq(pool.bufferAssets(), 20 * USDC);
        assertEq(adapter.managedAssets(address(pool)), 0);
        assertEq(pool.activeVenueDeploymentId(), 0);
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
        vm.prank(agentTwo);
        pool.deposit(10 * USDC, agentTwo);

        vm.prank(operator);
        vmx.expectRevert(DepositPool.InvalidReturnDeadline.selector);
        pool.deployToVenue(1 * USDC, uint64(block.timestamp));
    }

    function testVenueDeadlineCannotExceedDerivedShortestNoticeTier() public {
        vm.prank(agent);
        pool.deposit(10 * USDC, agent);
        vm.prank(agentTwo);
        pool.deposit(10 * USDC, agentTwo);

        uint256 shortestNotice = pool.NOTICE_7_DAYS();
        vm.prank(operator);
        (bool ok, bytes memory data) = address(pool)
            .call(abi.encodeCall(pool.deployToVenue, (1 * USDC, uint64(block.timestamp + shortestNotice + 1))));
        _assertRevertedWith(ok, data, DepositPool.VenueDeadlineExceedsNoticeTier.selector);

        vm.prank(operator);
        uint256 deploymentId = pool.deployToVenue(1 * USDC, uint64(block.timestamp + shortestNotice));
        (,, uint64 returnBy,,) = pool.venueDeployments(deploymentId);
        assertEq(uint256(returnBy), block.timestamp + shortestNotice);
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

    function testStructuralLaw6ExternalAbiMatchesExactAllowlist() public view {
        _assertExactPoolAbi(address(pool));
        assertEq(pool.asset(), address(asset));
        assertEq(pool.operator(), operator);
        assertEq(address(pool.venueAdapter()), address(adapter));
    }

    function assertExactPoolAbi(address target) external view {
        _assertExactPoolAbi(target);
    }

    function _assertExactPoolAbi(address target) internal view {
        bytes4[] memory allowed = new bytes4[](50);
        allowed[0] = bytes4(keccak256("DEPLOYMENT_EPOCH()"));
        allowed[1] = bytes4(keccak256("NOTICE_30_DAYS()"));
        allowed[2] = bytes4(keccak256("NOTICE_7_DAYS()"));
        allowed[3] = bytes4(keccak256("PER_AGENT_ASSET_CAP()"));
        allowed[4] = bytes4(keccak256("PLATFORM_FEE_BPS()"));
        allowed[5] = bytes4(keccak256("TOTAL_ASSET_CAP()"));
        allowed[6] = bytes4(keccak256("activeVenueDeploymentId()"));
        allowed[7] = bytes4(keccak256("activeVenueRecallId()"));
        allowed[8] = bytes4(keccak256("allowance(address,address)"));
        allowed[9] = bytes4(keccak256("approve(address,uint256)"));
        allowed[10] = bytes4(keccak256("asset()"));
        allowed[11] = bytes4(keccak256("assetsOf(address)"));
        allowed[12] = bytes4(keccak256("availableShares(address)"));
        allowed[13] = bytes4(keccak256("balanceOf(address)"));
        allowed[14] = bytes4(keccak256("bufferAssets()"));
        allowed[15] = bytes4(keccak256("bufferFloor()"));
        allowed[16] = bytes4(keccak256("contributeOperatorPrincipal(uint256)"));
        allowed[17] = bytes4(keccak256("convertToAssets(uint256)"));
        allowed[18] = bytes4(keccak256("convertToShares(uint256)"));
        allowed[19] = bytes4(keccak256("decimals()"));
        allowed[20] = bytes4(keccak256("deployToVenue(uint256,uint64)"));
        allowed[21] = bytes4(keccak256("deposit(uint256,address)"));
        allowed[22] = bytes4(keccak256("earnedProtocolFees()"));
        allowed[23] = bytes4(keccak256("fulfilRedeem(uint256)"));
        allowed[24] = bytes4(keccak256("lastDeploymentEpochAt()"));
        allowed[25] = bytes4(keccak256("lockedShares(address)"));
        allowed[26] = bytes4(keccak256("maxDeployableAssets()"));
        allowed[27] = bytes4(keccak256("maxIssuedAgentShares()"));
        allowed[28] = bytes4(keccak256("mint(uint256,address)"));
        allowed[29] = bytes4(keccak256("name()"));
        allowed[30] = bytes4(keccak256("nextRedeemRequestId()"));
        allowed[31] = bytes4(keccak256("nextVenueDeploymentId()"));
        allowed[32] = bytes4(keccak256("nextVenueRecallId()"));
        allowed[33] = bytes4(keccak256("operator()"));
        allowed[34] = bytes4(keccak256("operatorContributedPrincipal()"));
        allowed[35] = bytes4(keccak256("operatorPrincipalShares()"));
        allowed[36] = bytes4(keccak256("recallVenueDeployment(uint256,uint256)"));
        allowed[37] = bytes4(keccak256("redeem(uint256,address,address)"));
        allowed[38] = bytes4(keccak256("redeemRequests(uint256)"));
        allowed[39] = bytes4(keccak256("requestRedeem(uint256,address,uint8)"));
        allowed[40] = bytes4(keccak256("settleVenueDeployment(uint256)"));
        allowed[41] = bytes4(keccak256("settleVenueRecall(uint256)"));
        allowed[42] = bytes4(keccak256("symbol()"));
        allowed[43] = bytes4(keccak256("totalAssets()"));
        allowed[44] = bytes4(keccak256("totalSupply()"));
        allowed[45] = bytes4(keccak256("transfer(address,uint256)"));
        allowed[46] = bytes4(keccak256("transferFrom(address,address,uint256)"));
        allowed[47] = bytes4(keccak256("venueAdapter()"));
        allowed[48] = bytes4(keccak256("venueDeployments(uint256)"));
        allowed[49] = bytes4(keccak256("venueRecalls(uint256)"));

        bytes4[] memory actual = _dispatcherSelectors(target.code);
        require(actual.length == allowed.length, "EXTERNAL_ABI_CHANGED");
        for (uint256 i = 0; i < actual.length; i++) {
            require(_containsSelector(allowed, actual[i]), "UNALLOWLISTED_EXTERNAL_SELECTOR");
        }
    }

    function testExactAbiAllowlistDetectsAnAddedFunction() public {
        DepositPoolAbiMutation mutated = new DepositPoolAbiMutation(address(asset), operator, adapter);
        bytes4[] memory actual = _dispatcherSelectors(address(mutated).code);
        require(actual.length == 51, "MUTATION_NOT_IN_DISPATCHER");
        require(_containsSelector(actual, bytes4(keccak256("advance(uint256)"))), "MUTATION_SELECTOR_MISSING");
        (bool ok, bytes memory data) =
            address(this).staticcall(abi.encodeCall(this.assertExactPoolAbi, (address(mutated))));
        _assertRevertedWith(ok, data, bytes4(keccak256("Error(string)")));
    }

    function _settleDeployment(uint256 deploymentId) internal {
        (,,, bytes32 adapterRequestId,) = pool.venueDeployments(deploymentId);
        adapter.settle(adapterRequestId, true);
        (IDepositPoolVenueAdapter.RequestStatus status,) = pool.settleVenueDeployment(deploymentId);
        assertEq(uint256(status), uint256(IDepositPoolVenueAdapter.RequestStatus.Succeeded));
    }

    function _settleRecall(uint256 recallId) internal {
        (,,, bytes32 adapterRequestId,) = pool.venueRecalls(recallId);
        adapter.settle(adapterRequestId, true);
        (IDepositPoolVenueAdapter.RequestStatus status,) = pool.settleVenueRecall(recallId);
        assertEq(uint256(status), uint256(IDepositPoolVenueAdapter.RequestStatus.Succeeded));
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

    function _dispatcherSelectors(bytes memory runtime) internal pure returns (bytes4[] memory selectors) {
        bytes4[] memory scratch = new bytes4[](128);
        uint256 count;
        bool dispatcherStarted;
        for (uint256 i = 0; i < runtime.length;) {
            uint8 opcode = uint8(runtime[i]);
            if (!dispatcherStarted) {
                if (opcode == 0x5b) dispatcherStarted = true;
                i++;
                continue;
            }
            if (
                opcode == 0x5f && i + 2 < runtime.length && runtime[i + 1] == bytes1(0x80)
                    && runtime[i + 2] == bytes1(0xfd)
            ) break;
            if (opcode == 0x63) {
                bytes4 selector;
                assembly {
                    selector := mload(add(add(runtime, 32), add(i, 1)))
                }
                scratch[count++] = selector;
                i += 5;
                continue;
            }
            if (opcode >= 0x60 && opcode <= 0x7f) {
                i += 1 + (opcode - 0x5f);
                continue;
            }
            i++;
        }
        require(count != 0, "DISPATCHER_NOT_FOUND");
        selectors = new bytes4[](count);
        for (uint256 i = 0; i < count; i++) {
            selectors[i] = scratch[i];
        }
    }

    function _containsSelector(bytes4[] memory selectors, bytes4 target) internal pure returns (bool) {
        for (uint256 i = 0; i < selectors.length; i++) {
            if (selectors[i] == target) return true;
        }
        return false;
    }
}

contract DepositPoolAbiMutation is DepositPool {
    constructor(address asset_, address operator_, IDepositPoolVenueAdapter venueAdapter_)
        DepositPool(asset_, operator_, venueAdapter_)
    {}

    function advance(uint256) external pure {}
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
    struct StoredRequest {
        Request request;
        address pool;
    }

    MockPoolUsdc public immutable token;
    address public immutable override asset;
    mapping(address => uint256) public override managedAssets;
    mapping(address => uint64) public returnDeadline;
    mapping(bytes32 => StoredRequest) internal requests;
    uint256 public nextNonce = 1;

    constructor(MockPoolUsdc token_) {
        token = token_;
        asset = address(token_);
    }

    function requestDeploy(uint256 assets, uint64 returnBy) external override returns (bytes32 requestId) {
        require(returnBy > block.timestamp, "DEADLINE");
        managedAssets[msg.sender] += assets;
        returnDeadline[msg.sender] = returnBy;
        requestId = _createRequest(msg.sender, RequestKind.Deploy, assets, returnBy);
    }

    function requestRecall(uint256 assets, uint64 returnBy) external override returns (bytes32 requestId) {
        require(managedAssets[msg.sender] >= assets, "MANAGED");
        requestId = _createRequest(msg.sender, RequestKind.Recall, assets, returnBy);
    }

    function getRequest(bytes32 requestId) external view override returns (Request memory) {
        return requests[requestId].request;
    }

    function settle(bytes32 requestId, bool succeeded) external {
        StoredRequest storage stored = requests[requestId];
        require(stored.request.requestedAssets != 0, "REQUEST");
        require(stored.request.status == RequestStatus.Pending, "STATUS");
        stored.request.status = succeeded ? RequestStatus.Succeeded : RequestStatus.Failed;
        if (succeeded) {
            stored.request.settledAssets = stored.request.requestedAssets;
            if (stored.request.kind == RequestKind.Recall) {
                managedAssets[stored.pool] -= stored.request.requestedAssets;
            }
        } else if (stored.request.kind == RequestKind.Deploy) {
            managedAssets[stored.pool] -= stored.request.requestedAssets;
        }
    }

    function claimSettled(bytes32 requestId) external override returns (uint256 settledAssets) {
        StoredRequest storage stored = requests[requestId];
        require(msg.sender == stored.pool, "POOL");
        require(
            stored.request.status == RequestStatus.Succeeded || stored.request.status == RequestStatus.Failed, "PENDING"
        );
        require(!stored.request.claimed, "CLAIMED");
        stored.request.claimed = true;
        settledAssets = stored.request.settledAssets;
        if (stored.request.kind == RequestKind.Recall && stored.request.status == RequestStatus.Succeeded) {
            require(token.transfer(stored.pool, settledAssets), "TRANSFER");
        } else if (stored.request.kind == RequestKind.Deploy && stored.request.status == RequestStatus.Failed) {
            settledAssets = stored.request.requestedAssets;
            require(token.transfer(stored.pool, settledAssets), "TRANSFER");
        }
    }

    function simulateYield(address pool, uint256 bps) external returns (uint256 accrued) {
        accrued = (managedAssets[pool] * bps) / 10_000;
        managedAssets[pool] += accrued;
        token.mint(address(this), accrued);
    }

    function _createRequest(address pool, RequestKind kind, uint256 assets, uint64 returnBy)
        private
        returns (bytes32 requestId)
    {
        requestId = keccak256(abi.encode(address(this), pool, nextNonce++, kind, assets, returnBy));
        requests[requestId] = StoredRequest({
            request: Request({
                kind: kind,
                status: RequestStatus.Pending,
                requestedAssets: assets,
                settledAssets: 0,
                returnBy: returnBy,
                claimed: false
            }),
            pool: pool
        });
    }
}
