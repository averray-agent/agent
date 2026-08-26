// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {AgentAccountCore} from "../contracts/AgentAccountCore.sol";
import {DepositPoolV2} from "../contracts/DepositPoolV2.sol";
import {IDepositPoolVenueAdapter} from "../contracts/interfaces/IDepositPoolVenueAdapter.sol";
import {StrategyAdapterRegistry} from "../contracts/StrategyAdapterRegistry.sol";
import {AacPoolAggregatorAdapter} from "../contracts/strategies/AacPoolAggregatorAdapter.sol";
import {TreasuryPolicy} from "../contracts/TreasuryPolicy.sol";

interface VmAacPoolAggregator {
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata revertData) external;
}

contract AacPoolAggregatorAdapterTest is Test {
    uint256 internal constant USDC = 1e6;
    bytes4 internal constant PENDING_DEPOSIT_ASSETS_SELECTOR = bytes4(keccak256("pendingDepositAssets()"));
    VmAacPoolAggregator internal constant vmx =
        VmAacPoolAggregator(address(uint160(uint256(keccak256("hevm cheat code")))));

    TreasuryPolicy internal policy;
    StrategyAdapterRegistry internal registry;
    AgentAccountCore internal accounts;
    AggregatorUsdc internal asset;
    AggregatorVenueAdapter internal venueAdapter;
    AggregatorCreditPool internal creditPool;
    DepositPoolV2 internal pool;
    AacPoolAggregatorAdapter internal adapter;

    address internal operator = address(0xA0);
    address internal worker = address(0xB0B);
    address internal workerTwo = address(0xCAFE);
    address internal stranger = address(0xBAD);

    function setUp() public {
        policy = new TreasuryPolicy();
        registry = new StrategyAdapterRegistry(policy);
        accounts = new AgentAccountCore(policy, registry);
        asset = new AggregatorUsdc();
        venueAdapter = new AggregatorVenueAdapter(asset, policy.owner());
        creditPool = new AggregatorCreditPool();
        pool = new DepositPoolV2(policy, address(asset), operator, venueAdapter, address(creditPool));
        adapter = new AacPoolAggregatorAdapter(address(accounts), pool);

        policy.setApprovedAsset(address(asset), true);
        policy.setApprovedStrategy(address(adapter), true);
        registry.registerStrategy(address(adapter));
        pool.setAggregatorAdapter(address(adapter), true);

        _fundAccount(worker, 500 * USDC);
        _fundAccount(workerTwo, 500 * USDC);
    }

    function testAsyncProbeSelectorFailsAndAacClassifiesAdapterSynchronous() public {
        (bool ok,) = address(adapter).staticcall(abi.encodeWithSelector(PENDING_DEPOSIT_ASSETS_SELECTOR));
        require(!ok, "ASYNC_PROBE_MUST_FAIL");

        _allocate(worker, 1 * USDC);
        assertEq(accounts.strategyShares(worker, adapter.strategyId()), 1 * USDC);
    }

    function testOnlyAgentAccountCoreCanDepositOrWithdraw() public {
        vm.prank(operator);
        vmx.expectRevert(AacPoolAggregatorAdapter.Unauthorized.selector);
        adapter.deposit(1);
        vm.prank(operator);
        vmx.expectRevert(AacPoolAggregatorAdapter.Unauthorized.selector);
        adapter.withdraw(1, address(accounts));

        vmx.expectRevert(AacPoolAggregatorAdapter.Unauthorized.selector);
        adapter.deposit(1);
        vmx.expectRevert(AacPoolAggregatorAdapter.Unauthorized.selector);
        adapter.withdraw(1, address(accounts));

        vm.prank(stranger);
        vmx.expectRevert(AacPoolAggregatorAdapter.Unauthorized.selector);
        adapter.deposit(1);
        vm.prank(stranger);
        vmx.expectRevert(AacPoolAggregatorAdapter.Unauthorized.selector);
        adapter.withdraw(1, address(accounts));
    }

    function testPoolSharePricePassesThroughWithoutDilutingEarlierDepositor() public {
        _allocate(worker, 100 * USDC);
        vm.prank(operator);
        adapter.sweepToPool(100 * USDC);

        asset.mint(address(pool), 20 * USDC);
        uint256 firstShares = accounts.strategyShares(worker, adapter.strategyId());
        assertEq(_assetsForAdapterShares(firstShares), 120 * USDC);

        _allocate(workerTwo, 60 * USDC);
        uint256 secondShares = accounts.strategyShares(workerTwo, adapter.strategyId());
        assertEq(secondShares, 50 * USDC);
        assertEq(_assetsForAdapterShares(firstShares), 120 * USDC);
        assertEq(adapter.totalAssets(), 180 * USDC);
        assertEq(adapter.totalShares(), 150 * USDC);
    }

    function testWithdrawUsesOnlyFloatAndRevertsFloatExhaustedWithoutCallingPool() public {
        _allocate(worker, 100 * USDC);
        vm.prank(operator);
        adapter.sweepToPool(80 * USDC);

        bytes32 id = adapter.strategyId();
        assertEq(adapter.maxWithdraw(address(accounts)), 20 * USDC);
        assertEq(adapter.maxWithdraw(stranger), 0);
        uint256 poolSharesBefore = pool.balanceOf(address(adapter));
        uint256 poolSupplyBefore = pool.totalSupply();
        vm.prank(worker);
        accounts.deallocateIdleFunds(worker, id, 20 * USDC);
        assertEq(adapter.maxWithdraw(address(accounts)), 0);
        assertEq(pool.balanceOf(address(adapter)), poolSharesBefore);
        assertEq(pool.totalSupply(), poolSupplyBefore);

        vm.prank(worker);
        vmx.expectRevert(abi.encodeWithSelector(AacPoolAggregatorAdapter.FloatExhausted.selector, 0, 1 * USDC));
        accounts.deallocateIdleFunds(worker, id, 1 * USDC);
        assertEq(pool.balanceOf(address(adapter)), poolSharesBefore);
        assertEq(pool.totalSupply(), poolSupplyBefore);
    }

    function testValueClosureHardcodesPoolExitReceiverAndWithdrawRecipient() public {
        vm.prank(stranger);
        vmx.expectRevert(AacPoolAggregatorAdapter.Unauthorized.selector);
        adapter.sweepToPool(1);
        vm.prank(stranger);
        vmx.expectRevert(AacPoolAggregatorAdapter.Unauthorized.selector);
        adapter.requestFloatExit(1, DepositPoolV2.NoticeTier.Notice7Days);
        vm.prank(stranger);
        vmx.expectRevert(AacPoolAggregatorAdapter.Unauthorized.selector);
        adapter.fulfilFloatExit(1);

        _allocate(worker, 60 * USDC);
        vm.prank(operator);
        adapter.sweepToPool(50 * USDC);

        vm.prank(operator);
        uint256 requestId = adapter.requestFloatExit(20 * USDC, DepositPoolV2.NoticeTier.Notice7Days);
        (address owner, address receiver, uint256 shares,,,) = pool.redeemRequests(requestId);
        assertEq(owner, address(adapter));
        assertEq(receiver, address(adapter));
        assertEq(shares, 20 * USDC);

        vm.warp(block.timestamp + 7 days);
        uint256 strangerBefore = asset.balanceOf(stranger);
        vm.prank(operator);
        uint256 returned = adapter.fulfilFloatExit(requestId);
        assertEq(returned, 20 * USDC);
        assertEq(asset.balanceOf(address(adapter)), 30 * USDC);
        assertEq(asset.balanceOf(stranger), strangerBefore);

        vm.prank(address(accounts));
        vmx.expectRevert(abi.encodeWithSelector(AacPoolAggregatorAdapter.InvalidRecipient.selector, stranger));
        adapter.withdraw(1 * USDC, stranger);
    }

    function testV21AggregatorSweepAndNoticeExitReplenishFloatEndToEnd() public {
        _allocate(worker, 150 * USDC);
        uint256 highWaterBefore = pool.maxIssuedAgentShares();
        uint256 floorBefore = pool.bufferFloor();

        vm.prank(operator);
        uint256 poolShares = adapter.sweepToPool(150 * USDC);
        assertEq(poolShares, 150 * USDC);
        assertEq(pool.maxIssuedAgentShares(), highWaterBefore);
        assertEq(pool.bufferFloor(), floorBefore);
        assertEq(highWaterBefore, 0);
        assertEq(floorBefore, 0);

        vm.prank(address(adapter));
        vmx.expectRevert(DepositPoolV2.AggregatorMustUseNoticeExit.selector);
        pool.redeem(poolShares, address(adapter), address(adapter));

        vm.prank(operator);
        uint256 requestId = adapter.requestFloatExit(poolShares, DepositPoolV2.NoticeTier.Notice7Days);
        vm.warp(block.timestamp + 7 days);
        vm.prank(operator);
        adapter.fulfilFloatExit(requestId);

        assertEq(asset.balanceOf(address(adapter)), 150 * USDC);
        assertEq(pool.balanceOf(address(adapter)), 0);
        assertEq(adapter.totalAssets(), 150 * USDC);
    }

    function testTotalAssetsDoesNotDipAcrossPendingAndFulfilledExit() public {
        _allocate(worker, 100 * USDC);
        vm.prank(operator);
        adapter.sweepToPool(100 * USDC);
        assertEq(adapter.totalAssets(), 100 * USDC);

        vm.prank(operator);
        uint256 requestId = adapter.requestFloatExit(40 * USDC, DepositPoolV2.NoticeTier.Notice7Days);
        assertEq(pool.lockedShares(address(adapter)), 40 * USDC);
        assertEq(adapter.totalAssets(), 100 * USDC);

        asset.mint(address(pool), 10 * USDC);
        assertEq(adapter.totalAssets(), 110 * USDC);

        vm.warp(block.timestamp + 7 days);
        vm.prank(operator);
        uint256 returned = adapter.fulfilFloatExit(requestId);
        assertEq(returned, 44 * USDC);
        assertEq(asset.balanceOf(address(adapter)), 44 * USDC);
        assertEq(pool.convertToAssets(pool.balanceOf(address(adapter))), 66 * USDC);
        assertEq(adapter.totalAssets(), 110 * USDC);
    }

    function _fundAccount(address account, uint256 amount) private {
        asset.mint(account, amount);
        vm.startPrank(account);
        asset.approve(address(accounts), type(uint256).max);
        accounts.deposit(address(asset), amount);
        vm.stopPrank();
    }

    function _allocate(address account, uint256 amount) private {
        bytes32 id = adapter.strategyId();
        vm.prank(account);
        accounts.allocateIdleFunds(account, id, amount);
    }

    function _assetsForAdapterShares(uint256 shares) private view returns (uint256) {
        return (shares * adapter.totalAssets()) / adapter.totalShares();
    }
}

contract AggregatorCreditPool {
    function previewLoanId(address borrower) external pure returns (bytes32) {
        return keccak256(abi.encode("aggregator-credit", borrower));
    }
}

contract AggregatorVenueAdapter is IDepositPoolVenueAdapter {
    address public immutable override asset;
    address public immutable reporter;

    constructor(AggregatorUsdc asset_, address reporter_) {
        asset = address(asset_);
        reporter = reporter_;
    }

    function lossReporter() external view override returns (address) {
        return reporter;
    }

    function managedAssets(address) external pure override returns (uint256) {
        return 0;
    }

    function requestDeploy(uint256, uint64) external pure override returns (bytes32) {
        revert("NOT_USED");
    }

    function requestRecall(uint256, uint64) external pure override returns (bytes32) {
        revert("NOT_USED");
    }

    function getRequest(bytes32) external pure override returns (Request memory request) {
        return request;
    }

    function claimSettled(bytes32) external pure override returns (uint256) {
        revert("NOT_USED");
    }
}

    contract AggregatorUsdc {
        string public constant name = "Mock USDC";
        string public constant symbol = "USDC";
        uint8 public constant decimals = 6;
        uint256 public totalSupply;

        mapping(address => uint256) public balanceOf;
        mapping(address => mapping(address => uint256)) public allowance;

        function mint(address to, uint256 amount) external {
            totalSupply += amount;
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
