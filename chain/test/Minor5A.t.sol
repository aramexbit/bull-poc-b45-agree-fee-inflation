// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/Mocks.sol";

// MINOR 5 — Tim A.
// Agreement v4.1 Robinhood 0x7AB5… etched ZEROFEE, harness copied verbatim
// from poc/round25-c/chain (byte-identical live code, re-verified this
// round: SDK/MCP/templates/contracts all sha-identical to Round 25).
// chainId 4663.
//
// K-2049 (M-116, K-2035): agree() WITHOUT `conditions` — SDK ~baris 393-405:
//   expect = Array.isArray(conditions) ? #expectConditions : null;
//   check() only calls #matchConditions when expect is truthy; the
//   post-create log check verifies payer/payee/amount/asset/termsHash
//   but NEVER conditions. So when the caller omits `conditions`, the
//   server may return ANY conditions (or none) and the SDK sends.
//   Question: what do those server-chosen conditions do on-chain?
//   a) ZERO conditions -> release immediately? (payee paid without work)
//   b) attest-by-attacker (never attests) -> release blocked, funds locked
//      until expiry, then refund to payer; payee worked but is never paid.
//   c) CONTROL honest attest-by-arbiter -> attest + release +500.
//   Forge decides the on-chain semantics; the node run (run-sdk-agree5.mjs)
//   decides whether the live SDK actually sends in case (b).
//
// K-2050 (M-117, K-1988/K-2038): re-run of Round25B K-1988a/b verbatim
// (termsHash 0xdead… vs 0) — see test/Round25B.t.sol.

contract Minor5ATest is Test {
    address constant AGMT_V41 = 0x7AB58fAAe65eFCF0037635382cAA546EaC233DA6;

    uint256 constant PAYER_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 constant PAYEE_PK = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 constant ARB_PK = 0x47e179ec1974f892c2cd3b0cf1a4ec6a36e72a0a0d26ccaa2aa5c8ad6b9b47a8;
    address payer; address payee; address arbiter; address attacker; address stranger;
    MockERC20 token;

    bytes4 constant SEL_ATTEST = 0xa3bb24cc;
    bytes4 constant SEL_RELEASE = 0x37bdc99b;
    bytes4 constant SEL_REFUND = 0x278ecde1; // refund(uint256), cast-verified

    struct Cond { uint8 kind; address target; bytes data; uint256 value; }
    struct Params { address payee; address asset; uint256 amount; uint64 expiry; bytes32 termsHash; Cond[] conditions; }
    struct Quote { uint256 feeWei; uint64 expiry; bytes sig; }

    function setUp() public {
        vm.chainId(4663);
        payer = vm.addr(PAYER_PK);
        payee = vm.addr(PAYEE_PK);
        arbiter = vm.addr(ARB_PK);
        attacker = vm.addr(0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a);
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
    function _create72h(Cond[] memory conds, bytes32 terms) internal returns (bool ok, bytes memory ret) {
        return _create(conds, terms, uint64(block.timestamp + 72 hours));
    }
    function _call(address who, bytes memory data) internal returns (bool ok, bytes memory ret) {
        vm.prank(who);
        (ok, ret) = AGMT_V41.call(data);
    }
    function _conds1(uint8 k1, address t1, bytes memory d1, uint256 v1) internal pure returns (Cond[] memory c) {
        c = new Cond[](1);
        c[0] = Cond({ kind: k1, target: t1, data: d1, value: v1 });
    }
    function _conds0() internal pure returns (Cond[] memory c) {
        c = new Cond[](0);
    }

    // ---- K-2049a: ZERO conditions — create REVERTS on-chain (v4.1 requires >=1 condition).
    //   The "server returns no conditions -> payee paid immediately" variant is DEAD
    //   at the contract layer; only the attacker-attest variant (K-2049b) is live. ----
    function testK2049a_ZeroConditionsCreateReverts() public {
        (bool ok,) = _create72h(_conds0(), bytes32(uint256(0xaaaa)));
        require(!ok, "K-2049a create with zero conditions must revert on-chain");
    }

    // ---- K-2049b: attest-by-ATTACKER (never attests) — blocked, refund after expiry ----
    function testK2049b_AttackerAttestBlocksThenRefunds() public {
        Cond[] memory conds = _conds1(1, attacker, "", 0);
        (bool ok,) = _create72h(conds, bytes32(uint256(0xbbbb)));
        require(ok, "K-2049b create with attacker-attest must succeed");
        (bool relEarly,) = _call(stranger, abi.encodeWithSelector(SEL_RELEASE, uint256(1)));
        require(!relEarly, "K-2049b release must stay blocked while attacker never attests");
        vm.warp(block.timestamp + 72 hours + 1);
        (bool relAtExpiry,) = _call(stranger, abi.encodeWithSelector(SEL_RELEASE, uint256(1)));
        require(!relAtExpiry, "K-2049b release must stay blocked even at expiry without attest");
        uint256 payerBefore = token.balanceOf(payer);
        (bool ref,) = _call(stranger, abi.encodeWithSelector(SEL_REFUND, uint256(1)));
        require(ref, "K-2049b stranger refund after expiry must succeed");
        require(token.balanceOf(payer) - payerBefore == 500 ether, "K-2049b payer must recover full 500");
        require(token.balanceOf(payee) == 0, "K-2049b payee must gain 0 (worked, never paid)");
    }

    // ---- K-2049c: CONTROL honest attest-by-arbiter — attest + release +500 ----
    function testK2049c_HonestAttestReleases() public {
        Cond[] memory conds = _conds1(1, arbiter, "", 0);
        (bool ok,) = _create72h(conds, bytes32(uint256(0xcccc)));
        require(ok, "K-2049c create with arbiter-attest must succeed");
        (bool relEarly,) = _call(stranger, abi.encodeWithSelector(SEL_RELEASE, uint256(1)));
        require(!relEarly, "K-2049c release must stay blocked before attest");
        (bool att,) = _call(arbiter, abi.encodeWithSelector(SEL_ATTEST, uint256(1), uint256(0)));
        require(att, "K-2049c arbiter attest must succeed");
        uint256 before = token.balanceOf(payee);
        (bool rel,) = _call(stranger, abi.encodeWithSelector(SEL_RELEASE, uint256(1)));
        require(rel, "K-2049c release after attest must succeed");
        require(token.balanceOf(payee) - before == 500 ether, "K-2049c payee must gain 500");
    }
}
