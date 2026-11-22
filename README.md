# Bull SDK `agree()` / `deal()`: `feeWei` never verified — server inflates the protocol fee to the per-step cap, treasury takes it immediately

**Report:** B-45 (Major) — Bull.family bug bounty
**Location:** SDK `agree()` / `deal()` — https://www.bull.family/sdk/bull.mjs (live version, sha256 `f450d44df1812a6b9254c7b8cbac8aab89e94301cb86727f439643dfad47efae`, 54,263 B). `agree()` check() ~lines 393–430, `deal()` check() ~lines 500–580, `#agreeCap` ~line 434. Same mechanism, second surface: MCP `vet()` (`bull-mcp.mjs` sha `0cc9dcd6…`, ~lines 324–330).
**Severity:** Major (honestly Major — real funds taken without consent, no refund path)

## What is the bug?

`agree()` and `deal()` verify payee, asset, amount, expiry, termsHash and (when passed) conditions — but never the protocol fee. The `createAgreement` transaction carries a fee quote `(feeWei, expiry, sig)`, and neither check function ever reads `feeWei` or the transaction's ETH `value`. `agree()`/`deal()` take NO fee parameter from the caller, so the user never agrees to any fee amount. The only bound is the hardcoded `#agreeCap`: up to 0.05 ETH of value for an ERC-20 agreement, or up to `amount * 105% + 0.05 ETH` for an ETH agreement — and in `deal()` that full cap applies PER createAgreement step.

The live Agreement v4.1 contract requires `msg.value == amount + feeWei` (value without a matching fee reverts) and forwards `feeWei` to the Bull treasury (`0x1B3b7abb6553a1bbc9B285E6ab3F2012e88e4d5f`) IMMEDIATELY at creation — not held in escrow, not refundable, not part of the agreement amount. A compromised/malicious API server (the SDK's own documented threat model) can set `feeWei` to the cap on every step; the agreement itself still works normally afterwards, so nothing looks wrong to the victim.

## How to reproduce

Local only — fresh Anvil chain 4663, mock malicious Bull API, the LIVE SDK verbatim (`sdk-live.mjs`), live Agreement v4.1 bytecode etched with the fee signer zeroed (so a zero signature passes for ANY feeWei — exactly what a compromised server can sign for real). No real funds, no mainnet, no Bull infrastructure.

```sh
./run.sh        # forge test (6/6) + node live-SDK modes k2122/k2122c/k2122d
```

What the PoC does:

- **K-2122a (forge):** ERC-20 agreement, `feeWei = 0.05 ETH`, `value = 0.05 ETH` — create SUCCEEDS; the treasury gains exactly 0.05 ETH immediately at create, the contract keeps 0, the payer loses 0.05 ETH.
- **K-2122b (forge):** `feeWei = 0`, `value = 0.05 ETH` — create REVERTS. The contract requires value to match the fee, so the server MUST set `feeWei` to extract value — and it can.
- **K-2122c (forge):** ETH agreement, amount 1 ETH, `feeWei = 0.10 ETH`, `value = 1.10 ETH` (the full 105% + 0.05 cap) — create succeeds; treasury gains exactly 0.10 ETH; on release the payee gains exactly 1 ETH. The whole 5% slack is extractable as fee.
- **K-2122d (forge, control):** honest fee (`feeWei = 0`, `value = 0`) — create succeeds, payer spends 0 ETH.
- **K-2122 (node live-SDK):** caller calls `agree({payee, asset: "usdg", amount: "500", terms, expiryHours: 72, conditions: [{type: "attest", by: arbiter}]})`; mock server returns the honest conditions but `feeWei = 0.05 ETH` + tx value 0.05 ETH. The real SDK SENDS with NO error; the treasury gains exactly 0.05 ETH; the arbiter attests and release pays the payee +500 USDG — `exploited: true`.
- **K-2122c (node live-SDK, control):** honest fee 0 — SDK sends, treasury gains 0, payee +500.
- **K-2122d (node live-SDK):** `deal("milestones", 2)` USDG 500 with `feeWei = 0.05 ETH` on EACH of the 2 steps — SDK sends both agreements (ids 1, 2); the treasury gains 0.10 ETH total — `exploited: true`. The per-step cap multiplies the drain: 8 milestones x 0.05 = 0.4 ETH, 12 recurring payments x 0.05 = 0.6 ETH per `deal()` call.

Measured (22 Nov 2026, fresh Anvil per mode):

```
[K-2122 agree() feeWei inflated to 0.05 ETH cap] {"sdkSent":true,"agreementId":"1","treasuryGainedEth":0.05,"arbiterAttested":true,"releasedAfterAttest":true,"payeeGainedUsdg":"500","exploited":true}
[K-2122c CONTROL agree() honest fee 0] {"sdkSent":true,"agreementId":"1","treasuryGainedEth":0,"arbiterAttested":true,"releasedAfterAttest":true,"payeeGainedUsdg":"500","controlClean":true}
[K-2122d deal(milestones,2) feeWei 0.05 ETH on EACH step] {"sdkSent":true,"agreementIds":["1","2"],"treasuryGainedEth":0.1,"exploited":true}
```

## Impact

0.05 ETH taken from the payer per `agree()` call (~$150 at ~$3,000/ETH), with no consent, no warning, and no refund path. For `deal()`, the loss multiplies per step: 0.10 ETH measured for 2 milestones, up to 0.4 ETH (8 milestones) or 0.6 ETH (12 recurring payments) per call at the cap; for ETH agreements, up to 5% of the amount + 0.05 ETH per step.

## Suggested fix

Verify the fee the same way the SDK already verifies amount and conditions: `agree()`/`deal()` should take an explicit fee parameter (e.g. `maxFeeWei`, defaulting to 0 or to the documented protocol fee) and refuse any `createAgreement` step whose `feeWei` exceeds it or whose transaction `value` exceeds `amount + feeWei`. At minimum, surface the fee to the caller (return it from `agree()`/`deal()`) so a user can see what they are paying. The same check belongs in the MCP `vet()` path, which currently allows any `createAgreement` with value up to `MAX_WEI` (default 1 ETH) without decoding `feeWei` at all.

## Dedupe

- **Not B-04.** B-04 was the OLD SDK's `agree()` verifying nothing — amount inflated 10x, conditions rewritten. The current SDK patch closes that scenario. This report is about the field B-04's fix never touched: `feeWei`/value. B-04's draft mentions the 0.05 ETH cap only as the bound on AMOUNT inflation — the fee itself was never the finding, and B-04's suggested fix never mentions `feeWei`. Different unchecked field, different loss (fee taken immediately vs amount locked and releasable), different fix.
- **Not B-07.** B-07's second gap was value locked as the agreement AMOUNT (`p.amount`, now checked exactly) — which goes to the payee on release or back to the payer on refund, not taken. Here the value is taken as a FEE by the treasury at create time and never returns; B-07's fix (the 105% cap) does not touch `feeWei`.
- **Not B-09.** B-09 is the MCP returning the escrow `feeBps` without comparison vs the accepted quote — a different fee (escrow `createDeal` feeBps, hard-capped on-chain at 2.5%) in a different function. This is the Agreement `feeWei`, with no on-chain cap except the SDK's own per-step allowance.
- **Not B-44.** B-44 is the `expect = null` branch (no conditions passed). Here the caller DOES pass honest conditions and they ARE verified — the fee is still taken.
- **Additional instance, same report:** the MCP `vet()` allows any `createAgreement` with value up to `MAX_WEI` (default 1 ETH) and never decodes `feeWei`. Same root cause and fix family — verified by code reading + the forge proof that the contract forwards `feeWei` to the treasury.
- **Third party:** GitHub sweep (Major 26, Team A): `feeWei` / `agreeCap` / `createAgreement` / contract addresses / `BullEscrowV3` / `bull_sign_terms` / `checkBridge` / `relayToBull` — 0 relevant hits; 4 known third-party repos byte-identical; minachan-sec/bull-poc still 404. No third-party claim of a `feeWei` gap.
- **Dedupe risk, stated honestly:** LOW–MEDIUM. A reviewer could view this as B-04/B-07 residue ("the same unchecked-value family"). The counter-argument is that B-04/B-07 are about the agreement AMOUNT (locked funds, recoverable via release/refund) while this is about the FEE (taken immediately, irrevocably, to a third address), with a different fix. The honest-fee question is also a risk: if Bull's intended protocol fee were actually 0.05 ETH per agreement, this would be working as designed — but no SDK parameter, document, or user-facing text states any such fee, and `agree()`/`deal()` take no fee argument, so the user cannot have agreed to it.

## Files

- `run.sh` — end-to-end: forge test + node modes k2122/k2122c/k2122d
- `run-sdk-fee.mjs` — live-SDK node runner (mock malicious API + Anvil)
- `run-node.sh` — fresh Anvil per mode driver
- `sdk-live.mjs` — live SDK verbatim (sha `f450d44d…`, 54,263 B)
- `chain/` — Foundry project (test/Round26A.t.sol, src/, bytecode/; also Minor5A + Round25B re-grade tests)
- `mocks/MockERC20.json` — mock USDG token ABI/bytecode
- `node-result-k2122*.json` — recorded node results (generated by run.sh)
