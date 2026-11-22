// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/Mocks.sol";

// MAJOR 26 - Tim A.
// K-2122: SDK agree()/deal() NEVER verifies feeWei / msg.value of the
// createAgreement tx. #agreeCap only caps value at 0.05 ETH (ERC-20) or
// amount*105% + 0.05 ETH (ETH). The createAgreement check() verifies
// payee/asset/amount/expiry/termsHash/conditions - NOT feeWei, NOT value.
// Question (forge decides): does the live v4.1 contract actually TAKE
// msg.value as a fee, and where does it go? If the server inflates
// feeWei to the cap, is the payer's ETH lost (treasury/contract keeps it)
// or refunded?
//
// Harness: live v4.1 etched ZEROFEE (feeSigner patched to address(0),
// so a zero sig passes for ANY feeWei - exactly what a compromised
// server can sign for real). chainId 4663.

contract Round26ATest is Test {
    address constant AGMT_V41 = 0x7AB58fAAe65eFCF0037635382cAA546EaC233DA6;
    address constant TREASURY = 0x1B3b7abb6553a1bbc9B285E6ab3F2012e88e4d5f;

    uint256 constant PAYER_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 constant PAYEE_PK = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 constant ARB_PK = 0x47e179ec1974f892c2cd3b0cf1a4ec6a36e72a0a0d26ccaa2aa5c8ad6b9b47a8;
    address payer; address payee; address arbiter; address stranger;
    MockERC20 token;

    bytes4 constant SEL_ATTEST = 0xa3bb24cc;
    bytes4 constant SEL_RELEASE = 0x37bdc99b;
    bytes4 constant SEL_REFUND = 0x278ecde1;

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

    function _createRaw(address asset, uint256 amount, Cond[] memory conds, uint256 feeWei, uint256 value) internal returns (bool ok, bytes memory ret) {
        Params memory p = Params({ payee: payee, asset: asset, amount: amount, expiry: uint64(block.timestamp + 72 hours), termsHash: bytes32(uint256(0xaaaa)), conditions: conds });
        Quote memory q = Quote({ feeWei: feeWei, expiry: uint64(block.timestamp + 3600), sig: new bytes(65) });
        vm.prank(payer);
        token.approve(AGMT_V41, 100000 ether);
        vm.prank(payer);
        (ok, ret) = AGMT_V41.call{value: value}(abi.encodeWithSignature(
            "createAgreement((address,address,uint256,uint64,bytes32,(uint8,address,bytes,uint256)[]),(uint256,uint64,bytes))", p, q));
    }
    function _condsAttest(address by) internal pure returns (Cond[] memory c) {
        c = new Cond[](1);
        c[0] = Cond({ kind: 1, target: by, data: "", value: 0 });
    }
    function _call(address who, bytes memory data) internal returns (bool ok, bytes memory ret) {
        vm.prank(who);
        (ok, ret) = AGMT_V41.call(data);
    }

    // ---- K-2122a: ERC-20 agreement, feeWei inflated to the full SDK cap (0.05 ETH).
    //   Does create succeed, and where does the 0.05 ETH go? ----
    function testK2122a_FeeInflatedToCap() public {
        uint256 treasuryBefore = TREASURY.balance;
        uint256 contractBefore = AGMT_V41.balance;
        uint256 payerEthBefore = payer.balance;
        (bool ok, bytes memory ret) = _createRaw(address(token), 500 ether, _condsAttest(arbiter), 0.05 ether, 0.05 ether);
        emit log_named_bytes("create ret", ret);
        require(ok, "K-2122a create with feeWei=0.05 ETH must succeed (or revert - forge decides)");
        emit log_named_uint("treasury ETH delta", TREASURY.balance - treasuryBefore);
        emit log_named_uint("contract ETH delta", AGMT_V41.balance - contractBefore);
        emit log_named_uint("payer ETH spent", payerEthBefore - payer.balance);
        // Attest + release: payee must still get exactly 500 tokens.
        (bool att,) = _call(arbiter, abi.encodeWithSelector(SEL_ATTEST, uint256(1), uint256(0)));
        require(att, "attest must succeed");
        uint256 payeeBefore = token.balanceOf(payee);
        (bool rel,) = _call(stranger, abi.encodeWithSelector(SEL_RELEASE, uint256(1)));
        require(rel, "release must succeed");
        require(token.balanceOf(payee) - payeeBefore == 500 ether, "payee must gain exactly 500");
        emit log_named_uint("treasury ETH delta after release", TREASURY.balance - treasuryBefore);
        emit log_named_uint("contract ETH delta after release", AGMT_V41.balance - contractBefore);
        // The 0.05 ETH fee is gone from the payer either way; record whether
        // it went to the treasury (stolen/kept) or sits in the contract.
        require(payerEthBefore - payer.balance == 0.05 ether, "payer must have spent exactly 0.05 ETH");
    }

    // ---- K-2122b: ERC-20 agreement, feeWei=0 but msg.value=0.05 ETH (value without fee).
    //   Does the contract keep excess value, or revert/refund? ----
    function testK2122b_ValueWithoutFee() public {
        (bool ok,) = _createRaw(address(token), 500 ether, _condsAttest(arbiter), 0, 0.05 ether);
        emit log_named_uint("create ok (1=yes,0=no)", ok ? 1 : 0);
        emit log_named_uint("contract ETH after", AGMT_V41.balance);
        emit log_named_uint("treasury ETH after", TREASURY.balance);
    }

    // ---- K-2122c: ETH agreement, value inflated to the full SDK cap
    //   (amount 1 ETH * 105% + 0.05 = 1.10 ETH) with feeWei=0.10 ETH.
    //   Where does the extra 0.10 ETH go - fee, or extra locked funds? ----
    function testK2122c_EthAgreementInflatedValue() public {
        uint256 treasuryBefore = TREASURY.balance;
        uint256 payerEthBefore = payer.balance;
        (bool ok,) = _createRaw(address(0), 1 ether, _condsAttest(arbiter), 0.10 ether, 1.10 ether);
        require(ok, "K-2122c create ETH agreement with inflated value must succeed (or revert - forge decides)");
        emit log_named_uint("treasury ETH delta", TREASURY.balance - treasuryBefore);
        emit log_named_uint("contract ETH delta", AGMT_V41.balance);
        (bool att,) = _call(arbiter, abi.encodeWithSelector(SEL_ATTEST, uint256(1), uint256(0)));
        require(att, "attest must succeed");
        uint256 payeeBefore = payee.balance;
        (bool rel,) = _call(stranger, abi.encodeWithSelector(SEL_RELEASE, uint256(1)));
        require(rel, "release must succeed");
        emit log_named_uint("payee ETH gained on release", payee.balance - payeeBefore);
        emit log_named_uint("payer ETH spent total", payerEthBefore - payer.balance);
        emit log_named_uint("treasury ETH delta after release", TREASURY.balance - treasuryBefore);
        emit log_named_uint("contract ETH delta after release", AGMT_V41.balance);
    }

    // ---- K-2122d: CONTROL - honest fee (feeWei=0, value=0), ERC-20. ----
    function testK2122d_ControlZeroFee() public {
        uint256 payerEthBefore = payer.balance;
        (bool ok,) = _createRaw(address(token), 500 ether, _condsAttest(arbiter), 0, 0);
        require(ok, "K-2122d control create must succeed");
        require(payer.balance == payerEthBefore, "K-2122d control must spend 0 ETH");
    }

    // ---- K-2133: attest() index/caller swap - can a stranger attest, or
    //   the arbiter attest a wrong index? The SDK attest() takes its action
    //   list from the SERVER and never checks the condition index.
    //   Forge decides whether the contract kills the swap on-chain. ----
    function testK2133a_StrangerCannotAttest() public {
        (bool ok,) = _createRaw(address(token), 500 ether, _condsAttest(arbiter), 0, 0);
        require(ok, "K-2133a create must succeed");
        (bool att,) = _call(stranger, abi.encodeWithSelector(SEL_ATTEST, uint256(1), uint256(0)));
        require(!att, "K-2133a stranger must NOT be able to attest the arbiter condition");
        (bool rel,) = _call(stranger, abi.encodeWithSelector(SEL_RELEASE, uint256(1)));
        require(!rel, "K-2133a release must stay blocked after failed stranger attest");
    }
    function testK2133b_ArbiterWrongIndexReverts() public {
        (bool ok,) = _createRaw(address(token), 500 ether, _condsAttest(arbiter), 0, 0);
        require(ok, "K-2133b create must succeed");
        (bool att,) = _call(arbiter, abi.encodeWithSelector(SEL_ATTEST, uint256(1), uint256(1)));
        require(!att, "K-2133b attest of a nonexistent condition index must revert");
        (bool rel,) = _call(stranger, abi.encodeWithSelector(SEL_RELEASE, uint256(1)));
        require(!rel, "K-2133b release must stay blocked after failed wrong-index attest");
    }
}
