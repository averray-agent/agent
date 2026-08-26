// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {DepositPoolV2, IDepositPoolV2Errors} from "../contracts/DepositPoolV2.sol";
import {IDepositPoolVenueAdapter} from "../contracts/interfaces/IDepositPoolVenueAdapter.sol";
import {TreasuryPolicy} from "../contracts/TreasuryPolicy.sol";
import {DepositPoolV2Baseline, IDepositPoolV2BaselineErrors} from "./fixtures/DepositPoolV2Baseline.sol";

interface VmDepositPoolV21 {
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata revertData) external;
    function expectEmit(bool checkTopic1, bool checkTopic2, bool checkTopic3, bool checkData, address emitter) external;
}

contract DepositPoolV21Test is Test {
    uint256 internal constant USDC = 1e6;
    VmDepositPoolV21 internal constant vmx = VmDepositPoolV21(address(uint160(uint256(keccak256("hevm cheat code")))));

    TreasuryPolicy internal policy;
    MockV21Usdc internal asset;
    MockV21VenueAdapter internal venueAdapter;
    MockV21CreditPool internal creditPool;
    DepositPoolV2 internal pool;

    address internal operator = address(0xA0);
    address internal agent = address(0xA11CE);
    address internal agentTwo = address(0xB0B);
    address internal aggregator = address(0xADA7);
    address internal coldOwner = address(0xC01D);
    address internal stranger = address(0xBAD);

    event AggregatorAdapterSet(address indexed adapter, bool enabled);

    struct PoolPair {
        MockV21Usdc baselineAsset;
        MockV21Usdc candidateAsset;
        MockV21VenueAdapter baselineAdapter;
        MockV21VenueAdapter candidateAdapter;
        DepositPoolV2Baseline baseline;
        DepositPoolV2 candidate;
    }

    function setUp() public {
        policy = new TreasuryPolicy();
        asset = new MockV21Usdc();
        venueAdapter = new MockV21VenueAdapter(asset, policy.owner());
        creditPool = new MockV21CreditPool();
        pool = new DepositPoolV2(policy, address(asset), operator, venueAdapter, address(creditPool));

        _fundAndApprove(asset, agent, address(pool), 1_100 * USDC);
        _fundAndApprove(asset, aggregator, address(pool), 1_100 * USDC);
        _fundAndApprove(asset, operator, address(pool), 1_100 * USDC);
    }

    function testAggregatorDepositAndMintAboveAgentCapLeaveHighWaterAndBufferFloorUnchanged() public {
        pool.setAggregatorAdapter(aggregator, true);
        pool.setAggregatorAdapter(agentTwo, true);

        uint256 highWaterBefore = pool.maxIssuedAgentShares();
        uint256 floorBefore = pool.bufferFloor();

        vm.prank(aggregator);
        uint256 depositedShares = pool.deposit(110 * USDC, aggregator);
        asset.mint(agentTwo, 110 * USDC);
        vm.startPrank(agentTwo);
        asset.approve(address(pool), type(uint256).max);
        uint256 mintedAssets = pool.mint(110 * USDC, agentTwo);
        vm.stopPrank();

        assertEq(depositedShares, 110 * USDC);
        assertEq(mintedAssets, 110 * USDC);
        assertEq(pool.maxIssuedAgentShares(), highWaterBefore);
        assertEq(pool.bufferFloor(), floorBefore);
        assertEq(highWaterBefore, 0);
        assertEq(floorBefore, 0);
    }

    function testPlainAgentStillRecordsHighWaterAndRevertsAboveAgentCap() public {
        vm.prank(agent);
        pool.deposit(90 * USDC, agent);
        vm.prank(agent);
        pool.mint(10 * USDC, agent);

        assertEq(pool.maxIssuedAgentShares(), 100 * USDC);
        assertEq(pool.bufferFloor(), 100 * USDC);

        vm.prank(agent);
        vmx.expectRevert(
            abi.encodeWithSelector(DepositPoolV2.AgentAssetCapExceeded.selector, agent, 100 * USDC + 1, 100 * USDC)
        );
        pool.deposit(1, agent);
    }

    function testAggregatorDepositStillRevertsAtTotalAssetCap() public {
        pool.setAggregatorAdapter(aggregator, true);
        vm.prank(aggregator);
        pool.deposit(1_000 * USDC, aggregator);

        vm.prank(aggregator);
        vmx.expectRevert(
            abi.encodeWithSelector(DepositPoolV2.TotalAssetCapExceeded.selector, 1_000 * USDC + 1, 1_000 * USDC)
        );
        pool.deposit(1, aggregator);
    }

    function testAggregatorMustUseNoticeExitButCanRequestRedeem() public {
        pool.setAggregatorAdapter(aggregator, true);
        vm.prank(aggregator);
        uint256 shares = pool.deposit(110 * USDC, aggregator);

        vm.prank(aggregator);
        vmx.expectRevert(DepositPoolV2.AggregatorMustUseNoticeExit.selector);
        pool.redeem(shares, aggregator, aggregator);

        vm.prank(aggregator);
        uint256 requestId = pool.requestRedeem(shares, aggregator, DepositPoolV2.NoticeTier.Notice7Days);
        (address owner, address receiver, uint256 requestedShares,, DepositPoolV2.NoticeTier tier, bool fulfilled) =
            pool.redeemRequests(requestId);
        assertEq(owner, aggregator);
        assertEq(receiver, aggregator);
        assertEq(requestedShares, shares);
        assertEq(uint256(tier), uint256(DepositPoolV2.NoticeTier.Notice7Days));
        require(!fulfilled, "REQUEST_ALREADY_FULFILLED");
    }

    function testAggregatorRegistryIsDynamicPolicyOwnerOnlyAndRejectsInvalidTargets() public {
        vm.prank(operator);
        vmx.expectRevert(DepositPoolV2.Unauthorized.selector);
        pool.setAggregatorAdapter(aggregator, true);

        vm.prank(stranger);
        vmx.expectRevert(DepositPoolV2.Unauthorized.selector);
        pool.setAggregatorAdapter(aggregator, true);

        policy.transferOwnership(coldOwner);
        vmx.expectRevert(DepositPoolV2.Unauthorized.selector);
        pool.setAggregatorAdapter(aggregator, true);

        vm.startPrank(coldOwner);
        vmx.expectRevert(DepositPoolV2.InvalidAggregatorAdapter.selector);
        pool.setAggregatorAdapter(address(0), true);
        vmx.expectRevert(DepositPoolV2.InvalidAggregatorAdapter.selector);
        pool.setAggregatorAdapter(address(pool), true);
        vmx.expectEmit(true, false, false, true, address(pool));
        emit AggregatorAdapterSet(aggregator, true);
        pool.setAggregatorAdapter(aggregator, true);
        vm.stopPrank();

        require(pool.aggregatorAdapters(aggregator), "AGGREGATOR_NOT_ENABLED");
    }

    function testRemovingAggregatorRestoresHighWaterAndAgentCap() public {
        pool.setAggregatorAdapter(aggregator, true);
        vm.prank(aggregator);
        pool.deposit(90 * USDC, aggregator);
        assertEq(pool.maxIssuedAgentShares(), 0);

        pool.setAggregatorAdapter(aggregator, false);
        vm.prank(aggregator);
        pool.mint(10 * USDC, aggregator);
        assertEq(pool.maxIssuedAgentShares(), 100 * USDC);
        assertEq(pool.bufferFloor(), 100 * USDC);

        vm.prank(aggregator);
        vmx.expectRevert(
            abi.encodeWithSelector(DepositPoolV2.AgentAssetCapExceeded.selector, aggregator, 100 * USDC + 1, 100 * USDC)
        );
        pool.deposit(1, aggregator);
    }

    function testPlainAgentV21MatchesV2AcrossHappyPathAndEveryGuardRevert() public {
        _assertHappyPathEquivalent();
        _assertDepositGuardRevertsEquivalent();
        _assertRedeemGuardRevertsEquivalent();
    }

    function _assertHappyPathEquivalent() private {
        PoolPair memory pair = _newPair();
        (bool baselineOk, bytes memory baselineData) =
            _callAs(address(pair.baseline), agent, abi.encodeCall(pair.baseline.deposit, (10 * USDC, agent)));
        (bool candidateOk, bytes memory candidateData) =
            _callAs(address(pair.candidate), agent, abi.encodeCall(pair.candidate.deposit, (10 * USDC, agent)));
        _assertSameCall(baselineOk, baselineData, candidateOk, candidateData);

        (baselineOk, baselineData) =
            _callAs(address(pair.baseline), agent, abi.encodeCall(pair.baseline.redeem, (4 * USDC, agent, agent)));
        (candidateOk, candidateData) =
            _callAs(address(pair.candidate), agent, abi.encodeCall(pair.candidate.redeem, (4 * USDC, agent, agent)));
        _assertSameCall(baselineOk, baselineData, candidateOk, candidateData);

        assertEq(pair.baseline.totalSupply(), pair.candidate.totalSupply());
        assertEq(pair.baseline.balanceOf(agent), pair.candidate.balanceOf(agent));
        assertEq(pair.baseline.totalAssets(), pair.candidate.totalAssets());
        assertEq(pair.baseline.maxIssuedAgentShares(), pair.candidate.maxIssuedAgentShares());
        assertEq(pair.baseline.bufferFloor(), pair.candidate.bufferFloor());
    }

    function _assertDepositGuardRevertsEquivalent() private {
        PoolPair memory pair = _newPair();
        _assertPairCallReverts(
            pair,
            agent,
            abi.encodeCall(pair.baseline.deposit, (0, agent)),
            abi.encodeCall(pair.candidate.deposit, (0, agent))
        );
        _assertPairCallReverts(
            pair,
            agent,
            abi.encodeCall(pair.baseline.deposit, (1, address(0))),
            abi.encodeCall(pair.candidate.deposit, (1, address(0)))
        );
        _assertPairCallReverts(
            pair,
            agent,
            abi.encodeCall(pair.baseline.deposit, (1, address(pair.baseline))),
            abi.encodeCall(pair.candidate.deposit, (1, address(pair.candidate)))
        );

        pair = _newPair();
        _assertPairCallSucceeds(pair, agent, 100 * USDC);
        _assertPairCallReverts(
            pair,
            agent,
            abi.encodeCall(pair.baseline.deposit, (1, agent)),
            abi.encodeCall(pair.candidate.deposit, (1, agent))
        );

        pair = _newPair();
        _assertPairCallEquivalent(
            pair,
            operator,
            abi.encodeCall(pair.baseline.contributeOperatorPrincipal, (900 * USDC)),
            abi.encodeCall(pair.candidate.contributeOperatorPrincipal, (900 * USDC))
        );
        _assertPairCallSucceeds(pair, agent, 100 * USDC);
        _assertPairCallReverts(
            pair,
            agent,
            abi.encodeCall(pair.baseline.deposit, (1, agent)),
            abi.encodeCall(pair.candidate.deposit, (1, agent))
        );

        pair = _newPair();
        _assertPairCallSucceeds(pair, agent, 1);
        pair.baselineAsset.mint(address(pair.baseline), 2 * USDC);
        pair.candidateAsset.mint(address(pair.candidate), 2 * USDC);
        _assertPairCallReverts(
            pair,
            agentTwo,
            abi.encodeCall(pair.baseline.deposit, (1, agentTwo)),
            abi.encodeCall(pair.candidate.deposit, (1, agentTwo))
        );
    }

    function _assertRedeemGuardRevertsEquivalent() private {
        PoolPair memory pair = _newPair();
        _assertPairCallSucceeds(pair, agent, 10 * USDC);
        _assertPairCallReverts(
            pair,
            agent,
            abi.encodeCall(pair.baseline.redeem, (0, agent, agent)),
            abi.encodeCall(pair.candidate.redeem, (0, agent, agent))
        );
        _assertPairCallReverts(
            pair,
            agent,
            abi.encodeCall(pair.baseline.redeem, (1, address(0), agent)),
            abi.encodeCall(pair.candidate.redeem, (1, address(0), agent))
        );
        _assertPairCallReverts(
            pair,
            agent,
            abi.encodeCall(pair.baseline.redeem, (1, agent, address(0))),
            abi.encodeCall(pair.candidate.redeem, (1, agent, address(0)))
        );
        _assertPairCallReverts(
            pair,
            stranger,
            abi.encodeCall(pair.baseline.redeem, (1, agent, agent)),
            abi.encodeCall(pair.candidate.redeem, (1, agent, agent))
        );
        _assertPairCallReverts(
            pair,
            agent,
            abi.encodeCall(pair.baseline.redeem, (11 * USDC, agent, agent)),
            abi.encodeCall(pair.candidate.redeem, (11 * USDC, agent, agent))
        );

        _assertPairCallEquivalent(
            pair,
            agent,
            abi.encodeCall(
                pair.baseline.requestRedeem, (10 * USDC, agent, DepositPoolV2Baseline.NoticeTier.Notice7Days)
            ),
            abi.encodeCall(pair.candidate.requestRedeem, (10 * USDC, agent, DepositPoolV2.NoticeTier.Notice7Days))
        );
        _assertPairCallReverts(
            pair,
            agent,
            abi.encodeCall(pair.baseline.redeem, (1, agent, agent)),
            abi.encodeCall(pair.candidate.redeem, (1, agent, agent))
        );

        pair = _newPair();
        _assertPairCallSucceeds(pair, agent, 10 * USDC);
        bytes32 loanId = creditPool.previewLoanId(agent);
        _assertPairCallEquivalent(
            pair,
            agent,
            abi.encodeCall(pair.baseline.pledge, (10 * USDC, loanId)),
            abi.encodeCall(pair.candidate.pledge, (10 * USDC, loanId))
        );
        _assertPairCallReverts(
            pair,
            agent,
            abi.encodeCall(pair.baseline.redeem, (1, agent, agent)),
            abi.encodeCall(pair.candidate.redeem, (1, agent, agent))
        );

        pair = _newPair();
        _assertPairCallSucceeds(pair, agent, 10 * USDC);
        pair.baselineAsset.burn(address(pair.baseline), 10 * USDC);
        pair.candidateAsset.burn(address(pair.candidate), 10 * USDC);
        _assertPairCallReverts(
            pair,
            agent,
            abi.encodeCall(pair.baseline.redeem, (1, agent, agent)),
            abi.encodeCall(pair.candidate.redeem, (1, agent, agent))
        );

        pair = _newPair();
        _assertPairCallSucceeds(pair, agent, 10 * USDC);
        _assertPairCallEquivalent(
            pair,
            operator,
            abi.encodeCall(pair.baseline.contributeOperatorPrincipal, (10 * USDC)),
            abi.encodeCall(pair.candidate.contributeOperatorPrincipal, (10 * USDC))
        );
        _assertPairCallEquivalent(
            pair,
            operator,
            abi.encodeCall(pair.baseline.deployToVenue, (10 * USDC, uint64(block.timestamp + 7 days))),
            abi.encodeCall(pair.candidate.deployToVenue, (10 * USDC, uint64(block.timestamp + 7 days)))
        );
        pair.baselineAsset.burn(address(pair.baseline), 5 * USDC);
        pair.candidateAsset.burn(address(pair.candidate), 5 * USDC);
        _assertPairCallReverts(
            pair,
            agent,
            abi.encodeCall(pair.baseline.redeem, (10 * USDC, agent, agent)),
            abi.encodeCall(pair.candidate.redeem, (10 * USDC, agent, agent))
        );
    }

    function _newPair() private returns (PoolPair memory pair) {
        pair.baselineAsset = new MockV21Usdc();
        pair.candidateAsset = new MockV21Usdc();
        pair.baselineAdapter = new MockV21VenueAdapter(pair.baselineAsset, policy.owner());
        pair.candidateAdapter = new MockV21VenueAdapter(pair.candidateAsset, policy.owner());
        pair.baseline =
            new DepositPoolV2Baseline(address(pair.baselineAsset), operator, pair.baselineAdapter, address(creditPool));
        pair.candidate = new DepositPoolV2(
            policy, address(pair.candidateAsset), operator, pair.candidateAdapter, address(creditPool)
        );
        _fundAndApprove(pair.baselineAsset, agent, address(pair.baseline), 2_000 * USDC);
        _fundAndApprove(pair.candidateAsset, agent, address(pair.candidate), 2_000 * USDC);
        _fundAndApprove(pair.baselineAsset, agentTwo, address(pair.baseline), 2_000 * USDC);
        _fundAndApprove(pair.candidateAsset, agentTwo, address(pair.candidate), 2_000 * USDC);
        _fundAndApprove(pair.baselineAsset, operator, address(pair.baseline), 2_000 * USDC);
        _fundAndApprove(pair.candidateAsset, operator, address(pair.candidate), 2_000 * USDC);
    }

    function _assertPairCallSucceeds(PoolPair memory pair, address caller, uint256 assets) private {
        _assertPairCallEquivalent(
            pair,
            caller,
            abi.encodeCall(pair.baseline.deposit, (assets, caller)),
            abi.encodeCall(pair.candidate.deposit, (assets, caller))
        );
    }

    function _assertPairCallReverts(
        PoolPair memory pair,
        address caller,
        bytes memory baselineCall,
        bytes memory candidateCall
    ) private {
        (bool baselineOk, bytes memory baselineData) = _callAs(address(pair.baseline), caller, baselineCall);
        (bool candidateOk, bytes memory candidateData) = _callAs(address(pair.candidate), caller, candidateCall);
        require(!baselineOk, "BASELINE_CALL_SUCCEEDED");
        require(!candidateOk, "CANDIDATE_CALL_SUCCEEDED");
        assertEq(uint256(keccak256(baselineData)), uint256(keccak256(candidateData)));
    }

    function _assertPairCallEquivalent(
        PoolPair memory pair,
        address caller,
        bytes memory baselineCall,
        bytes memory candidateCall
    ) private {
        (bool baselineOk, bytes memory baselineData) = _callAs(address(pair.baseline), caller, baselineCall);
        (bool candidateOk, bytes memory candidateData) = _callAs(address(pair.candidate), caller, candidateCall);
        _assertSameCall(baselineOk, baselineData, candidateOk, candidateData);
    }

    function _assertSameCall(bool baselineOk, bytes memory baselineData, bool candidateOk, bytes memory candidateData)
        private
        pure
    {
        require(baselineOk, "BASELINE_CALL_REVERTED");
        require(candidateOk, "CANDIDATE_CALL_REVERTED");
        assertEq(uint256(keccak256(baselineData)), uint256(keccak256(candidateData)));
    }

    function _callAs(address target, address caller, bytes memory data) private returns (bool ok, bytes memory result) {
        vm.prank(caller);
        return target.call(data);
    }

    function _fundAndApprove(MockV21Usdc token, address owner, address spender, uint256 amount) private {
        token.mint(owner, amount);
        vm.prank(owner);
        token.approve(spender, type(uint256).max);
    }
}

contract MockV21CreditPool {
    function previewLoanId(address borrower) external pure returns (bytes32) {
        return keccak256(abi.encode("v2.1-baseline-loan", borrower));
    }
}

contract MockV21VenueAdapter is IDepositPoolVenueAdapter {
    address public immutable override asset;
    address public immutable reporter;
    uint256 internal nextNonce = 1;
    mapping(bytes32 => Request) internal requests;

    constructor(MockV21Usdc asset_, address reporter_) {
        asset = address(asset_);
        reporter = reporter_;
    }

    function lossReporter() external view override returns (address) {
        return reporter;
    }

    function managedAssets(address) external view override returns (uint256) {
        return MockV21Usdc(asset).balanceOf(address(this));
    }

    function requestDeploy(uint256 assets, uint64 returnBy) external override returns (bytes32 requestId) {
        requestId = keccak256(abi.encode(address(this), nextNonce++));
        requests[requestId] = Request({
            kind: RequestKind.Deploy,
            status: RequestStatus.Succeeded,
            requestedAssets: assets,
            settledAssets: assets,
            returnBy: returnBy,
            claimed: false
        });
    }

    function requestRecall(uint256 assets, uint64 returnBy) external override returns (bytes32 requestId) {
        requestId = keccak256(abi.encode(address(this), nextNonce++));
        requests[requestId] = Request({
            kind: RequestKind.Recall,
            status: RequestStatus.Succeeded,
            requestedAssets: assets,
            settledAssets: assets,
            returnBy: returnBy,
            claimed: false
        });
    }

    function getRequest(bytes32 requestId) external view override returns (Request memory) {
        return requests[requestId];
    }

    function claimSettled(bytes32 requestId) external override returns (uint256 settledAssets) {
        Request storage request = requests[requestId];
        request.claimed = true;
        settledAssets = request.settledAssets;
    }
}

    contract MockV21Usdc {
        string public constant name = "Mock USDC";
        string public constant symbol = "USDC";
        uint8 public constant decimals = 6;
        mapping(address => uint256) public balanceOf;
        mapping(address => mapping(address => uint256)) public allowance;

        function mint(address to, uint256 amount) external {
            balanceOf[to] += amount;
        }

        function burn(address from, uint256 amount) external {
            balanceOf[from] -= amount;
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
