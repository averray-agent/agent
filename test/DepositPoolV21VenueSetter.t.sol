// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {DepositPoolV2} from "../contracts/DepositPoolV2.sol";
import {IDepositPoolVenueAdapter} from "../contracts/interfaces/IDepositPoolVenueAdapter.sol";
import {TreasuryPolicy} from "../contracts/TreasuryPolicy.sol";

interface VmDepositPoolV21VenueSetter {
    function expectRevert(bytes4 selector) external;
    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData, address emitter) external;
}

contract DepositPoolV21VenueSetterTest is Test {
    uint256 internal constant USDC = 1e6;
    VmDepositPoolV21VenueSetter internal constant vmx =
        VmDepositPoolV21VenueSetter(address(uint160(uint256(keccak256("hevm cheat code")))));

    TreasuryPolicy internal policy;
    VenueSetterUsdc internal asset;
    VenueSetterAdapter internal venueAdapter;
    VenueSetterCreditPool internal creditPool;

    address internal operator = address(0xA0);
    address internal agent = address(0xA11CE);
    address internal aggregator = address(0xADA7);
    address internal coldOwner = address(0xC01D);
    address internal stranger = address(0xBAD);

    event VenueAdapterSet(address indexed adapter);

    function setUp() public {
        policy = new TreasuryPolicy();
        asset = new VenueSetterUsdc();
        venueAdapter = new VenueSetterAdapter(asset, policy.owner());
        creditPool = new VenueSetterCreditPool();
    }

    function testVenueAdapterCanOnlyBeSetOnceIncludingConstructorBoundPool() public {
        DepositPoolV2 unbound = _newUnboundPool(asset);

        vmx.expectRevert(DepositPoolV2.ZeroAddress.selector);
        unbound.setVenueAdapter(IDepositPoolVenueAdapter(address(0)));
        vmx.expectEmit(true, false, false, false, address(unbound));
        emit VenueAdapterSet(address(venueAdapter));
        unbound.setVenueAdapter(venueAdapter);
        assertEq(address(unbound.venueAdapter()), address(venueAdapter));

        vmx.expectRevert(DepositPoolV2.VenueAdapterAlreadySet.selector);
        unbound.setVenueAdapter(venueAdapter);

        DepositPoolV2 constructorBound =
            new DepositPoolV2(policy, address(asset), operator, venueAdapter, address(creditPool));
        vmx.expectRevert(DepositPoolV2.VenueAdapterAlreadySet.selector);
        constructorBound.setVenueAdapter(venueAdapter);
    }

    function testSetVenueAdapterIsPolicyOwnerOnly() public {
        DepositPoolV2 unbound = _newUnboundPool(asset);

        vm.prank(operator);
        vmx.expectRevert(DepositPoolV2.Unauthorized.selector);
        unbound.setVenueAdapter(venueAdapter);
        vm.prank(stranger);
        vmx.expectRevert(DepositPoolV2.Unauthorized.selector);
        unbound.setVenueAdapter(venueAdapter);

        policy.transferOwnership(coldOwner);
        vmx.expectRevert(DepositPoolV2.Unauthorized.selector);
        unbound.setVenueAdapter(venueAdapter);
        vm.prank(coldOwner);
        unbound.setVenueAdapter(venueAdapter);
        assertEq(address(unbound.venueAdapter()), address(venueAdapter));
    }

    function testVenueAdapterNoCodeValidationMatchesConstructorAndSetter() public {
        _assertConstructorAndSetterRejectVenueAdapter(IDepositPoolVenueAdapter(address(0x1234)));
    }

    function testVenueAdapterAssetValidationMatchesConstructorAndSetter() public {
        VenueSetterUsdc wrongAsset = new VenueSetterUsdc();
        _assertConstructorAndSetterRejectVenueAdapter(new VenueSetterAdapter(wrongAsset, policy.owner()));
    }

    function testVenueAdapterLossReporterValidationMatchesConstructorAndSetter() public {
        _assertConstructorAndSetterRejectVenueAdapter(new VenueSetterAdapter(asset, address(0)));
    }

    function testVenueLessPoolSupportsDepositsRedeemsAndAggregatorFlows() public {
        DepositPoolV2 unbound = _newUnboundPool(asset);
        unbound.setAggregatorAdapter(aggregator, true);
        _fundAndApprove(asset, agent, address(unbound), 20 * USDC);
        _fundAndApprove(asset, aggregator, address(unbound), 110 * USDC);

        vm.prank(agent);
        unbound.deposit(10 * USDC, agent);
        vm.prank(agent);
        assertEq(unbound.redeem(4 * USDC, agent, agent), 4 * USDC);

        vm.prank(aggregator);
        uint256 aggregatorShares = unbound.deposit(110 * USDC, aggregator);
        vm.prank(aggregator);
        uint256 requestId = unbound.requestRedeem(aggregatorShares, aggregator, DepositPoolV2.NoticeTier.Notice7Days);
        vm.warp(block.timestamp + 7 days);
        assertEq(unbound.fulfilRedeem(requestId), 110 * USDC);
        assertEq(unbound.balanceOf(agent), 6 * USDC);
        assertEq(unbound.balanceOf(aggregator), 0);

        vm.prank(operator);
        vmx.expectRevert(DepositPoolV2.VenueNotConfigured.selector);
        unbound.deployToVenue(1, uint64(block.timestamp + 1 days));
    }

    function testSetterBoundVenueMechanicsMatchConstructorBoundPool() public {
        VenueSetterUsdc constructorAsset = new VenueSetterUsdc();
        VenueSetterUsdc setterAsset = new VenueSetterUsdc();
        VenueSetterAdapter constructorAdapter = new VenueSetterAdapter(constructorAsset, policy.owner());
        DepositPoolV2 constructorBound =
            new DepositPoolV2(policy, address(constructorAsset), operator, constructorAdapter, address(creditPool));
        DepositPoolV2 setterBound = _newUnboundPool(setterAsset);
        setterBound.setVenueAdapter(new VenueSetterAdapter(setterAsset, policy.owner()));

        _exerciseVenueRoundTrip(constructorBound, constructorAsset);
        _exerciseVenueRoundTrip(setterBound, setterAsset);

        assertEq(constructorBound.totalSupply(), setterBound.totalSupply());
        assertEq(constructorBound.totalAssets(), setterBound.totalAssets());
        assertEq(constructorBound.bufferAssets(), setterBound.bufferAssets());
        assertEq(constructorBound.venuePrincipalCostBasis(), setterBound.venuePrincipalCostBasis());
        assertEq(constructorBound.activeVenueDeploymentId(), setterBound.activeVenueDeploymentId());
        assertEq(constructorBound.activeVenueRecallId(), setterBound.activeVenueRecallId());
        assertEq(constructorAsset.balanceOf(address(constructorBound)), setterAsset.balanceOf(address(setterBound)));
    }

    function _newUnboundPool(VenueSetterUsdc poolAsset) private returns (DepositPoolV2) {
        return new DepositPoolV2(
            policy, address(poolAsset), operator, IDepositPoolVenueAdapter(address(0)), address(creditPool)
        );
    }

    function _assertConstructorAndSetterRejectVenueAdapter(IDepositPoolVenueAdapter invalidAdapter) private {
        vmx.expectRevert(DepositPoolV2.InvalidVenueAdapter.selector);
        new DepositPoolV2(policy, address(asset), operator, invalidAdapter, address(creditPool));

        DepositPoolV2 unbound = _newUnboundPool(asset);
        vmx.expectRevert(DepositPoolV2.InvalidVenueAdapter.selector);
        unbound.setVenueAdapter(invalidAdapter);
    }

    function _exerciseVenueRoundTrip(DepositPoolV2 targetPool, VenueSetterUsdc targetAsset) private {
        _fundAndApprove(targetAsset, agent, address(targetPool), 10 * USDC);
        _fundAndApprove(targetAsset, operator, address(targetPool), 10 * USDC);
        vm.prank(agent);
        targetPool.deposit(10 * USDC, agent);
        vm.prank(operator);
        targetPool.contributeOperatorPrincipal(10 * USDC);

        vm.prank(operator);
        uint256 deploymentId = targetPool.deployToVenue(10 * USDC, uint64(block.timestamp + 7 days));
        targetPool.settleVenueDeployment(deploymentId);
        vm.prank(operator);
        uint256 recallId = targetPool.recallVenueDeployment(deploymentId, 10 * USDC);
        targetPool.settleVenueRecall(recallId);
    }

    function _fundAndApprove(VenueSetterUsdc token, address owner, address spender, uint256 amount) private {
        token.mint(owner, amount);
        vm.prank(owner);
        token.approve(spender, type(uint256).max);
    }
}

contract VenueSetterCreditPool {
    function previewLoanId(address borrower) external pure returns (bytes32) {
        return keccak256(abi.encode("venue-setter-loan", borrower));
    }
}

contract VenueSetterAdapter is IDepositPoolVenueAdapter {
    address public immutable override asset;
    address public immutable reporter;
    uint256 internal nextNonce = 1;
    mapping(bytes32 => Request) internal requests;

    constructor(VenueSetterUsdc asset_, address reporter_) {
        asset = address(asset_);
        reporter = reporter_;
    }

    function lossReporter() external view override returns (address) {
        return reporter;
    }

    function managedAssets(address) external view override returns (uint256) {
        return VenueSetterUsdc(asset).balanceOf(address(this));
    }

    function requestDeploy(uint256 assets, uint64 returnBy) external override returns (bytes32 requestId) {
        requestId = _recordRequest(RequestKind.Deploy, assets, returnBy);
    }

    function requestRecall(uint256 assets, uint64 returnBy) external override returns (bytes32 requestId) {
        requestId = _recordRequest(RequestKind.Recall, assets, returnBy);
    }

    function getRequest(bytes32 requestId) external view override returns (Request memory) {
        return requests[requestId];
    }

    function claimSettled(bytes32 requestId) external override returns (uint256 settledAssets) {
        Request storage request = requests[requestId];
        request.claimed = true;
        settledAssets = request.settledAssets;
        if (request.kind == RequestKind.Recall && settledAssets != 0) {
            VenueSetterUsdc(asset).transfer(msg.sender, settledAssets);
        }
    }

    function _recordRequest(RequestKind kind, uint256 assets, uint64 returnBy) private returns (bytes32 requestId) {
        requestId = keccak256(abi.encode(address(this), nextNonce++));
        requests[requestId] = Request({
            kind: kind,
            status: RequestStatus.Succeeded,
            requestedAssets: assets,
            settledAssets: assets,
            returnBy: returnBy,
            claimed: false
        });
    }
}

    contract VenueSetterUsdc {
        string public constant name = "Mock USDC";
        string public constant symbol = "USDC";
        uint8 public constant decimals = 6;

        mapping(address => uint256) public balanceOf;
        mapping(address => mapping(address => uint256)) public allowance;

        function mint(address to, uint256 amount) external {
            balanceOf[to] += amount;
        }

        function approve(address spender, uint256 amount) external returns (bool) {
            allowance[msg.sender][spender] = amount;
            return true;
        }

        function transfer(address to, uint256 amount) external returns (bool) {
            balanceOf[msg.sender] -= amount;
            balanceOf[to] += amount;
            return true;
        }

        function transferFrom(address from, address to, uint256 amount) external returns (bool) {
            uint256 allowed = allowance[from][msg.sender];
            if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
            balanceOf[from] -= amount;
            balanceOf[to] += amount;
            return true;
        }
    }
