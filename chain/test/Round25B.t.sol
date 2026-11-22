// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/Mocks.sol";

// ROUND 25 — Tim B (Major).
// Agreement v4.1 Robinhood 0x7AB5… etched ZEROFEE (feeSigner -> 0), same
// harness/bytecode as round24-b (byte-identical to live, re-verified this
// round: forge round23-a 19/19 + round24-b 25/25 re-runs green).
// chainId 4663. Duplicate-guard 0xf3fb463d: distinct termsHash per create
// within one test (each test has fresh setUp state, so terms 0 is fine).
//
// K-1987: deal("after_deal") — SDK shape is [[4, null]]: the kind-4
// TARGET (which escrow the deal lives on) is never checked by deal(),
// only value == params.dealId. Question: does creation pin the target
// on-chain to the Agreement's stored escrow()? GATE-round22 says YES
// (fake escrow reverts BadInput at creation). Forge decides:
//   a) target = legacy escrow 0xd685… must REVERT at creation
//   b) target = real escrow v3 0xd961… must SUCCEED at creation (control)
//   c) target = attacker EOA must REVERT at creation
//   d) target = real escrow, dealId 999 (never settled) must SUCCEED at
//      creation but never release (control: value-only check is real,
//      target is the pinned dimension)
//   If (a) reverts and (b) succeeds: SDK gap is closed on-chain -> KILL.
//   If (a) succeeds: the gap is LIVE -> PASS candidate (new instance).
//
// K-1988: deal() skips the termsHash check for multi-step templates
//   (`low(p.termsHash) !== wantTerms && !multi`). Forge shows termsHash
//   carries no economic weight on-chain: an agreement created with an
//   arbitrary termsHash (0xdead…) attests + releases exactly like the
//   honest one. Supports OBS/BELOW BAR (dispute-evidence only, no funds).
//
// K-1989: agree() with NO expiryHours — SDK imposes no upper bound
//   (B-28 / K-805, K-1890). Forge shows v4.1 accepts a 100-year expiry
//   at creation (mechanism exists on-chain). FOLD -> B-28 (BURNED,
//   do not file); no new proof needed beyond this on-chain acceptance.

contract Round25BTest is Test {
    address constant AGMT_V41 = 0x7AB58fAAe65eFCF0037635382cAA546EaC233DA6;
    address constant ESCROW_V3 = 0xd961cA37e339E14e0D3478383a252E218fe7aa4a;
    address constant ESCROW_LEGACY = 0xd685d39E7a3deF19E52B9AB09679b7452C23e20b;

    uint256 constant PAYER_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 constant PAYEE_PK = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 constant ARB_PK = 0x47e179ec1974f892c2cd3b0cf1a4ec6a36e72a0a0d26ccaa2aa5c8ad6b9b47a8;
    address payer; address payee; address arbiter; address stranger;
    MockERC20 token;

    bytes4 constant SEL_ATTEST = 0xa3bb24cc;
    bytes4 constant SEL_RELEASE = 0x37bdc99b;

    struct Cond { uint8 kind; address target; bytes data; uint256 value; }
    struct Params { address payee; address asset; uint256 amount; uint64 expiry; bytes32 termsHash; Cond[] conditions; }
    struct Quote { uint256 feeWei; uint64 expiry; bytes sig; }

    function setUp() public {
        vm.chainId(4663);
        payer = vm.addr(PAYER_PK);
        payee = vm.addr(PAYEE_PK);
        arbiter = vm.addr(ARB_PK);
        stranger = vm.addr(0x9999);
        vm.etch(AGMT_V41, vm.parseBytes(vm.readFile("bytecode/agreement-v41-zerofee.hex")));
        vm.store(AGMT_V41, bytes32(uint256(0)), bytes32(uint256(1)));   // nextId = 1
        vm.store(AGMT_V41, bytes32(uint256(11)), bytes32(uint256(1)));  // guard slot 11
        token = new MockERC20();
        token.mint(payer, 100000 ether);
        vm.deal(payer, 100 ether);
        vm.deal(payee, 10 ether);
        vm.deal(arbiter, 10 ether);
        vm.deal(stranger, 10 ether);
        vm.warp(1000);
    }

    function _create(Cond[] memory conds, bytes32 terms, uint64 expiry) internal returns (bool ok, bytes memory ret) {
        Params memory p = Params({ payee: payee, asset: address(token), amount: 500 ether, expiry: expiry, termsHash: terms, conditions: conds });
        Quote memory q = Quote({ feeWei: 0, expiry: uint64(block.timestamp + 3600), sig: new bytes(65) });
        vm.prank(payer);
        token.approve(AGMT_V41, 100000 ether);
        vm.prank(payer);
        (ok, ret) = AGMT_V41.call(abi.encodeWithSignature(
            "createAgreement((address,address,uint256,uint64,bytes32,(uint8,address,bytes,uint256)[]),(uint256,uint64,bytes))", p, q));
    }
    function _create90d(Cond[] memory conds, bytes32 terms) internal returns (bool ok, bytes memory ret) {
        return _create(conds, terms, uint64(block.timestamp + 90 days));
    }
    function _call(address who, bytes memory data) internal returns (bool ok, bytes memory ret) {
        vm.prank(who);
        (ok, ret) = AGMT_V41.call(data);
    }
    function _conds1(uint8 k1, address t1, bytes memory d1, uint256 v1) internal pure returns (Cond[] memory c) {
        c = new Cond[](1);
        c[0] = Cond({ kind: k1, target: t1, data: d1, value: v1 });
    }

    // ---- K-1987a: kind-4 target = LEGACY escrow — must REVERT at creation ----
    function testK1987a_Kind4LegacyEscrowReverts() public {
        Cond[] memory conds = _conds1(4, ESCROW_LEGACY, "", 5);
        (bool ok,) = _create90d(conds, bytes32(uint256(1)));
        require(!ok, "K-1987a create with legacy-escrow kind-4 target must revert (on-chain pin)");
    }

    // ---- K-1987b: CONTROL kind-4 target = REAL escrow v3 — must SUCCEED ----
    function testK1987b_Kind4RealEscrowSucceeds() public {
        Cond[] memory conds = _conds1(4, ESCROW_V3, "", 5);
        (bool ok,) = _create90d(conds, bytes32(uint256(2)));
        require(ok, "K-1987b create with real-escrow kind-4 target must succeed");
    }

    // ---- K-1987c: kind-4 target = attacker EOA — must REVERT at creation ----
    function testK1987c_Kind4AttackerEoaReverts() public {
        Cond[] memory conds = _conds1(4, stranger, "", 5);
        (bool ok,) = _create90d(conds, bytes32(uint256(3)));
        require(!ok, "K-1987c create with EOA kind-4 target must revert (on-chain pin)");
    }

    // ---- K-1987d: CONTROL real escrow, dealId 999 — create OK, release blocked ----
    function testK1987d_Kind4UnsettledDealNeverReleases() public {
        Cond[] memory conds = _conds1(4, ESCROW_V3, "", 999);
        (bool ok,) = _create90d(conds, bytes32(uint256(4)));
        require(ok, "K-1987d create with real escrow + unsettled deal must succeed");
        vm.warp(block.timestamp + 30 days);
        (bool rel,) = _call(stranger, abi.encodeWithSelector(SEL_RELEASE, uint256(1)));
        require(!rel, "K-1987d release must stay blocked while deal 999 is unsettled");
    }

    // ---- K-1988a: arbitrary termsHash — create + attest + release +500 ----
    function testK1988a_ArbitraryTermsHashReleases() public {
        Cond[] memory conds = _conds1(1, arbiter, "", 0);
        (bool ok,) = _create90d(conds, bytes32(uint256(0xdead)));
        require(ok, "K-1988a create with arbitrary termsHash must succeed");
        (bool att,) = _call(arbiter, abi.encodeWithSelector(SEL_ATTEST, uint256(1), uint256(0)));
        require(att, "K-1988a attest must succeed");
        uint256 before = token.balanceOf(payee);
        (bool rel,) = _call(stranger, abi.encodeWithSelector(SEL_RELEASE, uint256(1)));
        require(rel, "K-1988a release must succeed");
        require(token.balanceOf(payee) - before == 500 ether, "K-1988a payee must gain 500");
    }

    // ---- K-1988b: CONTROL termsHash 0 — same flow +500 ----
    function testK1988b_ZeroTermsHashReleases() public {
        Cond[] memory conds = _conds1(1, arbiter, "", 0);
        (bool ok,) = _create90d(conds, bytes32(0));
        require(ok, "K-1988b create with termsHash 0 must succeed");
        (bool att,) = _call(arbiter, abi.encodeWithSelector(SEL_ATTEST, uint256(1), uint256(0)));
        require(att, "K-1988b attest must succeed");
        uint256 before = token.balanceOf(payee);
        (bool rel,) = _call(stranger, abi.encodeWithSelector(SEL_RELEASE, uint256(1)));
        require(rel, "K-1988b release must succeed");
        require(token.balanceOf(payee) - before == 500 ether, "K-1988b payee must gain 500");
    }

    // ---- K-1989a: 100-year expiry accepted at creation (agree() omit path) ----
    function testK1989a_Expiry100yAccepted() public {
        Cond[] memory conds = _conds1(1, arbiter, "", 0);
        (bool ok,) = _create(conds, bytes32(uint256(5)), uint64(block.timestamp + 100 * 365 days));
        require(ok, "K-1989a create with 100y expiry must succeed on-chain (no on-chain max)");
        (bool rel,) = _call(stranger, abi.encodeWithSelector(SEL_RELEASE, uint256(1)));
        require(!rel, "K-1989a release must stay blocked before attest");
    }
}
