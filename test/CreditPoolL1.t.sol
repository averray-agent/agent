// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";

import {CreditPool} from "../contracts/CreditPool.sol";
import {DepositPoolV2, IDepositPoolV2Errors} from "../contracts/DepositPoolV2.sol";
import {IDepositPoolPledge} from "../contracts/interfaces/IDepositPoolPledge.sol";
import {IDepositPoolVenueAdapter} from "../contracts/interfaces/IDepositPoolVenueAdapter.sol";

interface VmCreditPoolSign {
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata revertData) external;
}

contract CreditPoolL1Test is Test {
    VmCreditPoolSign internal constant vmSign =
        VmCreditPoolSign(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant USDC = 1e6;
    uint256 internal constant OPERATOR_KEY = 0xA11CE;

    CreditPoolMockUsdc internal asset;
    DepositPoolV2 internal depositPool;
    CreditPool internal creditPool;
    address internal operator;
    address internal borrower = address(0xB0B);
    address internal lender = address(0x1EAD);
    address internal stranger = address(0xBAD);

    function setUp() public {
        operator = 0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7;
        asset = new CreditPoolMockUsdc();

        // A freshly-created test contract starts at nonce 1. The mock asset is
        // CREATE #1, DepositPoolV2 is #2, and CreditPool is #3.
        address predictedCreditPool =
            address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", address(this), hex"03")))));
        depositPool =
            new DepositPoolV2(address(asset), operator, IDepositPoolVenueAdapter(address(0)), predictedCreditPool);
        creditPool = new CreditPool(address(asset), operator, IDepositPoolPledge(address(depositPool)));
        assertEq(address(creditPool), predictedCreditPool);

        _fundAndApprove(borrower, address(depositPool), 20 * USDC);
        _fundAndApprove(lender, address(creditPool), 100 * USDC);
        _fundAndApprove(operator, address(creditPool), 250 * USDC);
        vm.prank(borrower);
        depositPool.deposit(10 * USDC, borrower);
        vm.prank(operator);
        creditPool.contributeOperatorPrincipal(20 * USDC);
    }

    function testPilotConstantsArePinnedToPacketSectionThree() public view {
        assertEq(creditPool.TOTAL_ASSET_CAP(), 250_000_000);
        assertEq(creditPool.PER_LENDER_CAP(), 100_000_000);
        assertEq(creditPool.ltvBps(), 8_000);
        assertEq(creditPool.MAX_LTV_BPS(), 9_000);
        assertEq(creditPool.interestBps(), 0);
        assertEq(creditPool.MAX_INTEREST_BPS(), 2_000);
        assertEq(creditPool.IMPAIRMENT_NUMERATOR(), 105);
        assertEq(creditPool.IMPAIRMENT_DENOMINATOR(), 100);
        assertEq(creditPool.PLATFORM_FEE_BPS(), 0);
    }

    function testPledgedSharesRefuseInstantAndNoticeRedemption() public {
        (bytes32 loanId,) = _pledgeAndOriginate(8 * USDC, 10 * USDC, 10 * USDC);
        assertEq(depositPool.pledgedShares(borrower), 10 * USDC);

        vm.startPrank(borrower);
        vmSign.expectRevert(IDepositPoolV2Errors.SharesPledged.selector);
        depositPool.redeem(1, borrower, borrower);
        vmSign.expectRevert(IDepositPoolV2Errors.SharesPledged.selector);
        depositPool.requestRedeem(1, borrower, DepositPoolV2.NoticeTier.Notice7Days);
        vm.stopPrank();

        (address owner, uint256 shares, bool active) = depositPool.pledges(loanId);
        assertEq(owner, borrower);
        assertEq(shares, 10 * USDC);
        require(active, "EXPECTED_ACTIVE_PLEDGE");
    }

    function testFreshUnvestedTrancheCannotCollateralizeAtLtvBoundary() public {
        bytes32 loanId = creditPool.previewLoanId(borrower);
        vm.prank(borrower);
        depositPool.pledge(10 * USDC, loanId);
        bytes memory signature = _vestingSignature(loanId, 10 * USDC, 1, 0, uint64(block.timestamp + 5 minutes));

        vm.prank(borrower);
        vmSign.expectRevert(abi.encodeWithSelector(CreditPool.LoanLimitExceeded.selector, 1, 0));
        creditPool.originate(10 * USDC, 1, 0, uint64(block.timestamp + 5 minutes), signature);

        // A failed second step cannot strand the first-step pledge forever.
        vm.prank(borrower);
        creditPool.cancelUnusedPledge(loanId);
        (,, bool active) = depositPool.pledges(loanId);
        require(!active, "UNUSED_PLEDGE_STUCK");
    }

    function testVestedDivergenceCapsLoanAtEightyPercentOfTheSmallerValue() public {
        bytes32 loanId = creditPool.previewLoanId(borrower);
        vm.prank(borrower);
        depositPool.pledge(10 * USDC, loanId);
        uint64 validUntil = uint64(block.timestamp + 5 minutes);
        bytes memory signature = _vestingSignature(loanId, 10 * USDC, 4 * USDC + 1, 5 * USDC, validUntil);

        vm.prank(borrower);
        vmSign.expectRevert(abi.encodeWithSelector(CreditPool.LoanLimitExceeded.selector, 4 * USDC + 1, 4 * USDC));
        creditPool.originate(10 * USDC, 4 * USDC + 1, 5 * USDC, validUntil, signature);

        // A refused attestation does not consume either one-use nonce.
        assertEq(creditPool.nextLoanNonce(borrower), 0);
        assertEq(creditPool.vestingAttestationNonces(borrower), 0);
    }

    function testVestedCapacityCannotBeReusedAcrossMultipleLoans() public {
        (bytes32 firstLoanId,) = _pledgeAndOriginate(4 * USDC, 5 * USDC, 5 * USDC);
        assertEq(creditPool.outstandingDebt(borrower), 4 * USDC);

        bytes32 secondLoanId = creditPool.previewLoanId(borrower);
        vm.prank(borrower);
        depositPool.pledge(5 * USDC, secondLoanId);
        uint64 validUntil = uint64(block.timestamp + 5 minutes);
        bytes memory signature = _vestingSignature(secondLoanId, 5 * USDC, 1, 5 * USDC, validUntil);

        // Aggregate pledged value is 10 USDC, but the same 5 USDC of vested
        // standing supports only 4 USDC total at 80%; loan one consumed it.
        vm.prank(borrower);
        vmSign.expectRevert(abi.encodeWithSelector(CreditPool.LoanLimitExceeded.selector, 1, 0));
        creditPool.originate(5 * USDC, 1, 5 * USDC, validUntil, signature);

        vm.prank(borrower);
        creditPool.cancelUnusedPledge(secondLoanId);
        (,,,,,,, CreditPool.LoanStatus firstStatus) = creditPool.loans(firstLoanId);
        assertEq(uint256(firstStatus), uint256(CreditPool.LoanStatus.Active));
    }

    function testZeroInterestRepaysPrincipalExactlyAndOnlyFullRepaymentReleases() public {
        (bytes32 loanId, uint256 balanceBefore) = _pledgeAndOriginate(8 * USDC, 10 * USDC, 10 * USDC);
        assertEq(asset.balanceOf(borrower), balanceBefore + 8 * USDC);
        assertEq(creditPool.outstandingDebt(borrower), 8 * USDC);
        assertEq(creditPool.principalOutstanding(), 8 * USDC);

        vm.startPrank(borrower);
        asset.approve(address(creditPool), 8 * USDC);
        creditPool.repay(loanId, 3 * USDC);
        vm.stopPrank();
        assertEq(creditPool.outstandingDebt(borrower), 5 * USDC);
        (,, bool activeAfterPartial) = depositPool.pledges(loanId);
        require(activeAfterPartial, "PARTIAL_REPAY_RELEASED_PLEDGE");

        vm.prank(borrower);
        creditPool.repay(loanId, 5 * USDC);
        assertEq(creditPool.outstandingDebt(borrower), 0);
        assertEq(creditPool.principalOutstanding(), 0);
        (,, bool activeAfterFull) = depositPool.pledges(loanId);
        require(!activeAfterFull, "FULL_REPAY_DID_NOT_RELEASE_PLEDGE");
        assertEq(depositPool.pledgedShares(borrower), 0);
        (,,,,,,, CreditPool.LoanStatus status) = creditPool.loans(loanId);
        assertEq(uint256(status), uint256(CreditPool.LoanStatus.Repaid));
    }

    function testSeizeRefusesHealthyCollateralAndSucceedsOnlyBelowOneHundredFivePercent() public {
        (bytes32 loanId,) = _pledgeAndOriginate(8 * USDC, 10 * USDC, 10 * USDC);
        vmSign.expectRevert(abi.encodeWithSelector(CreditPool.CollateralNotImpaired.selector, 10 * USDC, 8_400_000));
        creditPool.seize(loanId);

        asset.burn(address(depositPool), 2 * USDC);
        assertEq(depositPool.convertToAssets(10 * USDC), 8 * USDC);
        uint256 seized = creditPool.seize(loanId);
        assertEq(seized, 8 * USDC);
        assertEq(creditPool.defaults(), 1);
        assertEq(creditPool.principalOutstanding(), 0);
        assertEq(creditPool.outstandingDebt(borrower), 0);
        assertEq(asset.balanceOf(address(creditPool)), 20 * USDC);
    }

    function testNonBorrowerCannotPledgeAnotherWalletShares() public {
        bytes32 loanId = creditPool.previewLoanId(borrower);
        _fundAndApprove(stranger, address(depositPool), USDC);
        vm.prank(stranger);
        depositPool.deposit(USDC, stranger);
        vm.prank(stranger);
        vmSign.expectRevert(DepositPoolV2.InvalidLoanId.selector);
        depositPool.pledge(1, loanId);
        assertEq(depositPool.pledgedShares(borrower), 0);
    }

    function testLenderCapsAndScheduleCeilingsAreFailClosed() public {
        vm.prank(lender);
        creditPool.deposit(100 * USDC, lender);
        vm.prank(lender);
        vmSign.expectRevert(
            abi.encodeWithSelector(CreditPool.LenderAssetCapExceeded.selector, lender, 100_000_001, 100_000_000)
        );
        creditPool.deposit(1, lender);

        vm.startPrank(operator);
        creditPool.setLtvBps(9_000);
        vmSign.expectRevert(CreditPool.InvalidSchedule.selector);
        creditPool.setLtvBps(9_001);
        creditPool.setInterestBps(2_000);
        vmSign.expectRevert(CreditPool.InvalidSchedule.selector);
        creditPool.setInterestBps(2_001);
        vm.stopPrank();
    }

    function _pledgeAndOriginate(uint256 amount, uint256 pledgeShares, uint256 vestedRaw)
        private
        returns (bytes32 loanId, uint256 balanceBefore)
    {
        loanId = creditPool.previewLoanId(borrower);
        vm.prank(borrower);
        depositPool.pledge(pledgeShares, loanId);
        uint64 validUntil = uint64(block.timestamp + 5 minutes);
        bytes memory signature = _vestingSignature(loanId, pledgeShares, amount, vestedRaw, validUntil);
        balanceBefore = asset.balanceOf(borrower);
        vm.prank(borrower);
        bytes32 originated = creditPool.originate(pledgeShares, amount, vestedRaw, validUntil, signature);
        require(originated == loanId, "LOAN_ID_DRIFT");
    }

    function _vestingSignature(
        bytes32 loanId,
        uint256 pledgeShares,
        uint256 amount,
        uint256 vestedRaw,
        uint64 validUntil
    ) private returns (bytes memory) {
        bytes32 digest = creditPool.vestingAttestationDigest(
            borrower, loanId, pledgeShares, amount, vestedRaw, validUntil, creditPool.vestingAttestationNonces(borrower)
        );
        (uint8 v, bytes32 r, bytes32 s) = vmSign.sign(OPERATOR_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _fundAndApprove(address owner, address spender, uint256 amount) private {
        asset.mint(owner, amount);
        vm.prank(owner);
        asset.approve(spender, type(uint256).max);
    }
}

contract CreditPoolMockUsdc {
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
