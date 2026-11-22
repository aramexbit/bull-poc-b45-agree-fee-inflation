// Bull SDK: agent-to-agent settlement. Agents choose the terms, Bull settles them. Non-custodial, no account, no API key.
//
// WHEN TO USE: your agent must pay (or be paid by) another agent it does not trust, and the payment depends on something:
// delivery confirmed by an arbiter, milestones, a dispute / veto window, k-of-n votes, a time, another deal, an onchain value.
// The money is locked in a contract and released when the agreed conditions are true. Not for tiny pay-per-call payments (use x402 "exact").
//
//   import { Bull } from "./bull.mjs";            // needs `viem` installed (npm i viem)
//   const bull = new Bull({ walletClient, publicClient, chain: "base" });   // Base (USDC) or "robinhood" (default, USDG/ETH)
//
//   // 1. Any block in one call (arbiter_escrow, two_of_three, milestones, optimistic, confirmed_with_cooling, panel, ...):
//   const id = await bull.deal("arbiter_escrow", { payee, asset: "usdc", amount: "5", arbiter, terms: "Deliver the report" });
//   await bull.attest(id);                        // the arbiter wallet confirms
//   await bull.release(id);                       // pays the payee (the keeper also does it). After expiry: bull.refund(id)
//
//   // 2. Your own conditions:  bull.agree({ payee, asset: "usdc", amount: "5", conditions: [{ type: "attest", by }, { type: "veto", by, afterHours: 24, attestIndex: 0 }] })
//
//   // 3. Atomic token swap (Robinhood Chain):  const dealId = await bull.open({ seller, sellToken, sellAmount: "1000", payAsset: "eth", payAmount: "0.25" });
//   //    await bull.fund(dealId); await bull.waitSettled(dealId);
//
//   // 4. Cross-chain (Base agent <-> Robinhood agent), no contract change. The agreement lives on ONE chain (the settlement chain, default the seller's).
//   //    The agent on the other chain first bridges its stablecoin to your own address with Relay (third party, experimental, untested end to end):
//   //    USDC on Base arrives as USDG on Robinhood Chain, USDG arrives as USDC on Base. Bull never touches bridge funds; the recipient is always you.
//   //    const b = new Bull({ walletClient, publicClient, chain: "base" });          // clients on the ORIGIN chain; optional relayApiKey: "..." calls Relay directly
//   //    const q = await b.bridge.quote({ from: "base", to: "robinhood", amount: "25" });  await b.bridge.send(q);  await b.bridge.wait(q.id);   // then open the agreement on the other chain
//   //    const plan = await b.crossChainSettle({ payerChain: "base", sellerChain: "robinhood", amount: "25" });   // ordered steps: bridge -> approve + open agreement -> release (does not send anything)
//   //    Needs a little ETH on the settlement chain for gas and the protocol fee. Runnable: https://www.bull.family/examples/crosschain-base-to-robinhood.mjs
//
// Check a counterparty first: GET https://www.bull.family/api/v1/agents/{wallet}. Runnable example: https://www.bull.family/examples/quickstart-base.mjs
// `walletClient` and `publicClient` are standard viem clients on the chain you pick. Robinhood is 4663, Base is 8453.
// Status: beta, contracts not audited. Every transaction the server returns is checked here before it is sent (see below).

import { parseEventLogs, parseAbi, parseEther, parseUnits, erc20Abi, recoverMessageAddress, decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, toHex } from "viem";

// Safety: the API server is not trusted with your wallet. Every transaction it returns is checked before it is sent, and the
// consent message is checked against what YOU asked for before it is signed. Only these contracts can ever receive a transaction.
const DEFAULT_BASE = "https://www.bull.family";
const ESCROWS = ["0xd961ca37e339e14e0d3478383a252e218fe7aa4a"]; // the current escrow (v3, fees buy and burn BULL). Older escrows are not used by the SDK.
const FEE_SIGNER = "0x585770c10434fa6d434b6b27316354f9d1688bd0"; // signs receipts
const AGREEMENT = "0x7ab58faae65efcf0037635382caa546eac233da6"; // Agreement v4.1 (live 2026-11-21, adds the veto window); v4 0x3d8f... and v3 0x84c6... are retired
const ZERO = "0x0000000000000000000000000000000000000000";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const low = (x) => String(x || "").toLowerCase();
const bad = (m) => { throw new Error("Bull SDK safety check failed: " + m); };

const AGR_ABI = parseAbi(["event AgreementCreated(uint256 indexed id, address indexed payer, address indexed payee, address asset, uint256 amount, uint64 expiry, bytes32 termsHash)"]);
const LOCK_ABI = parseAbi(["event LockCreated(uint256 indexed id, address indexed token, address indexed beneficiary, address creator, uint256 amount, uint64 start, uint64 cliff, uint64 end, uint64 step)"]);

// The only functions the SDK ever sends to a Bull contract. Everything else is refused, and the arguments are checked against what you asked for.
const FN_ABI = parseAbi([
  "function createDeal((address seller,address sellerPayout,address buyerReceive,address sellToken,uint256 sellAmount,address payToken,uint256 payAmount,uint64 deadline) p,(uint16 feeBps,uint64 expiry,bytes sig) q,(uint64 validUntil,bytes sig) c) returns (uint256)",
  "function fundPayment(uint256 id) payable",
  "function fundTokens(uint256 id)",
  "function fundTokensWithPermit(uint256 id,uint256 permitDeadline,uint8 v,bytes32 r,bytes32 s,bytes fundSig)",
  "function cancel(uint256 id)",
  "function createAgreement((address payee,address asset,uint256 amount,uint64 expiry,bytes32 termsHash,(uint8 kind,address target,bytes data,uint256 value)[] conditions) p,(uint256 feeWei,uint64 expiry,bytes sig) q) payable returns (uint256)",
  "function attest(uint256 id,uint256 index)",
  "function object(uint256 id,uint256 index)",
  "function vote(uint256 id,uint256 index)",
  "function release(uint256 id)",
  "function refund(uint256 id)",
]);
const CHAINS = {
  robinhood: { id: 4663, name: "Robinhood Chain", escrows: ESCROWS, agreement: AGREEMENT, stable: USDG, alias: "usdg" },
  // Base (live 2026-11-21): USDC is the main currency. The instant escrow (delivery_vs_payment) is Robinhood only for now.
  base: { id: 8453, name: "Base", escrows: ["0x22b6bd2b101959c970130ccf6738981925419687"], agreement: "0x81d4a3a3b4cdd43c32b14949a15521b4ce7a1391", stable: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", alias: "usdc" },
};

const DEALS_ABI = parseAbi(["function deals(uint256) view returns (address buyer,address seller,address sellToken,uint256 sellAmount,address payToken,uint256 payAmount,uint64 deadline,bool buyerFunded,bool sellerFunded,uint8 status,address sellerPayout,address buyerReceive,uint16 feeBps)"]);
const ABI = parseAbi(["event DealCreated(uint256 indexed id, address indexed buyer, address indexed seller, uint16 feeBps)"]);


// Cross-chain (bridge) helpers. Third-party intents bridge (Relay). Bull never touches bridge funds. Everything the server (or Relay) returns is checked here before it is sent.
const RELAY_API = "https://api.relay.link";
const BRIDGE = {
  base: { id: 8453, name: "Base", symbol: "USDC", token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", asset: "usdc" },
  robinhood: { id: 4663, name: "Robinhood Chain", symbol: "USDG", token: USDG, asset: "usdg" },
};
const bridgeChain = (v) => { const k = low(v); if (k === "arc") bad("Arc is not supported by the bridge helper."); const c = BRIDGE[k]; if (!c) bad('bridge chains are "base" and "robinhood".'); return { key: k, ...c }; };
const toRaw = (amount) => { const m = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(String(amount ?? "").trim()); if (!m) bad('amount must be a whole-unit string like "25" or "25.5" (max 6 decimals).'); return BigInt(m[1]) * 1000000n + BigInt((m[2] || "").padEnd(6, "0")); };
/** Same rules the server applies: plain transactions on the origin chain, from you, no native value, approvals only on the input token for at most the amount, recipient = you. */
function checkBridge(q, req) {
  if (!q || !Array.isArray(q.steps) || !q.steps.length || q.steps.length > 4) bad("the bridge quote has no usable steps.");
  if (q.recipient && low(q.recipient) !== low(req.user)) bad("the bridge recipient is not your own address.");
  if (q.to?.chainId !== undefined && Number(q.to.chainId) !== req.to.id) bad("the bridge pays out on another chain than you asked for.");
  for (const s of q.steps) {
    const t = s?.transaction;
    if (!t || Number(t.chainId) !== req.from.id) bad(`a bridge step is not for ${req.from.name} (${req.from.id}).`);
    if (t.from && low(t.from) !== low(req.user)) bad("a bridge step is sent from another address than yours.");
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(t.to || ""))) bad("a bridge step has no valid target.");
    if (BigInt(t.value || "0") !== 0n) bad("a bridge step sends native coin. A stablecoin bridge never needs that.");
    const data = String(t.data || "0x");
    if (!/^0x([0-9a-fA-F]{2})*$/.test(data)) bad("a bridge step has invalid calldata.");
    if (data.startsWith("0x095ea7b3")) {
      if (low(t.to) !== req.from.token) bad("a bridge approval is on another token than the one you bridge.");
      if (!/^0x[0-9a-fA-F]{136}$/.test(data) || BigInt("0x" + data.slice(74, 138)) > req.raw) bad("a bridge approval is malformed or for more than the amount you bridge.");
    }
  }
  return q;
}
/** Relay /quote/v2 response -> Bull's transaction-step shape (same as POST /api/v1/bridge/quote). */
function relayToBull(req, j) {
  const d = j?.details || {};
  if (d.recipient && low(d.recipient) !== low(req.user)) bad("Relay's recipient is not your address.");
  if (d.currencyOut?.currency?.address && low(d.currencyOut.currency.address) !== req.to.token) bad("Relay's output token is not the expected one.");
  let out = null; try { if (d.currencyOut?.amount !== undefined) out = BigInt(String(d.currencyOut.amount)); } catch { bad("Relay's output amount is not a number."); }
  if (out !== null && out * 100n < req.raw * 95n) bad("the quote returns less than 95% of the amount sent.");
  const steps = []; let id = null;
  for (const s of j?.steps || []) {
    if (s?.kind && s.kind !== "transaction") bad(`step "${s?.id}" is a ${s.kind} step; the SDK only sends plain transactions.`);
    for (const it of s?.items || []) {
      const t = it?.data; if (!t) continue;
      const rid = String(s?.requestId || /requestId=(0x[0-9a-fA-F]{64})/.exec(String(it?.check?.endpoint || ""))?.[1] || "");
      if (!id && /^0x[0-9a-fA-F]{64}$/.test(rid)) id = rid;
      steps.push({ name: s.id === "approve" || String(t.data || "").startsWith("0x095ea7b3") ? "approve" : String(s.id || "bridge"), transaction: { chainId: Number(t.chainId), from: t.from || req.user, to: t.to, value: String(t.value || "0"), data: t.data || "0x" } });
    }
  }
  return { id, provider: "relay", from: { chain: req.from.key, chainId: req.from.id, asset: req.from.symbol, token: req.from.token }, to: { chain: req.to.key, chainId: req.to.id, asset: req.to.symbol, token: req.to.token }, amount: req.amount, recipient: req.user, expectedOut: out === null ? null : String(Number(out) / 1e6), steps };
}

export class Bull {
  /** @param {{ walletClient: any, publicClient: any, baseUrl?: string }} o */
  constructor({ walletClient, publicClient, baseUrl = "https://www.bull.family", chain = "robinhood", relayApiKey }) {
    this.relayKey = relayApiKey || undefined; // optional: bridge quotes then go to Relay directly instead of through Bull
    this.chainName = String(chain).toLowerCase();
    this.cfg = CHAINS[this.chainName];
    if (!this.cfg) bad(`chain must be ${Object.keys(CHAINS).join(" or ")}.`);
    this.w = walletClient;
    this.p = publicClient;
    this.base = baseUrl.replace(/\/$/, "");
    this.tokens = new Set([this.cfg.stable]); // token contracts you named yourself (approvals are only allowed on these)
    if (this.base !== DEFAULT_BASE) console.warn(`Bull SDK WARNING: using ${this.base} instead of ${DEFAULT_BASE}. Only continue if you run this server yourself.`);
  }

  #note(...tokens) {
    for (const t of tokens) if (/^0x[0-9a-fA-F]{40}$/.test(String(t || ""))) this.tokens.add(low(t));
  }

  get address() {
    return this.w.account.address;
  }

  async #call(path, body) {
    if (this.chainName !== "robinhood") { if (body) body = { ...body, chain: this.chainName }; else path += (path.includes("?") ? "&" : "?") + "chain=" + this.chainName; }
    const r = await fetch(this.base + path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message || j?.error || `Bull API ${r.status}`);
    return j;
  }

  /** Refuses anything that is not (1) a call to a Bull contract, (2) an approval of a token you named, to a Bull contract (or the locker you pinned),
   *  for at most `o.maxApprove`, or (3) a call to the `o.locker` you pinned. ETH value is capped at maxWei. Nothing here is derived from the server's reply. */
  #guard(tx, maxWei = 0n, o = {}) {
    const to = low(tx?.to), data = String(tx?.data || "0x"), value = BigInt(tx?.value || "0");
    if (value > maxWei) bad(`transaction sends ${value} wei, more than the ${maxWei} you agreed to.`);
    if (data.startsWith("0x095ea7b3")) {
      if (!/^0x[0-9a-fA-F]{136}$/.test(data)) bad("the approval calldata has the wrong length.");
      const spender = "0x" + data.slice(34, 74).toLowerCase();
      const amt = BigInt("0x" + data.slice(74, 138));
      if (!this.tokens.has(to)) bad(`approval on ${to}, a token you did not name.`);
      if (o.token !== undefined && to !== low(o.token)) bad(`approval on ${to}, which is not the token of this step (${low(o.token)}).`);
      if (!(spender === this.cfg.agreement || this.cfg.escrows.includes(spender) || (o.locker && spender === low(o.locker)))) bad(`approval to ${spender}, which is not a Bull contract.`);
      if (o.maxApprove === undefined || amt > o.maxApprove) bad(`approval of ${amt}, more than the ${o.maxApprove ?? 0n} this step needs.`);
      return;
    }
    if (to === this.cfg.agreement || this.cfg.escrows.includes(to)) {
      // Decode the call: it must be a function this step is allowed to call, and (if the step is about one deal or agreement) for exactly that id.
      let fn;
      try { fn = decodeFunctionData({ abi: FN_ABI, data }); } catch { bad("the transaction calls a function the SDK does not know."); }
      if (o.fn && !o.fn.includes(fn.functionName)) bad(`the transaction calls ${fn.functionName}, expected ${o.fn.join(" or ")}.`);
      if (o.id !== undefined && fn.args[0] !== BigInt(o.id)) bad(`the transaction is for id ${fn.args[0]}, not the ${o.id} you asked for.`);
      return fn;
    }
    if (o.locker && to === low(o.locker) && !/^0x(a9059cbb|23b872dd|095ea7b3)/.test(data)) return;
    bad(`the server asked to send a transaction to ${to}, which is not a Bull contract.`);
  }

  /** Reads a deal straight from the escrow (the chain, not the server). */
  async #deal(dealId, escrow = this.cfg.escrows[0]) {
    const r = await this.p.readContract({ address: escrow, abi: DEALS_ABI, functionName: "deals", args: [BigInt(dealId)] });
    return { buyer: r[0], seller: r[1], sellToken: r[2], sellAmount: r[3], payToken: r[4], payAmount: r[5], deadline: r[6], buyerFunded: r[7], sellerFunded: r[8], status: Number(r[9]), sellerPayout: r[10], buyerReceive: r[11], feeBps: Number(r[12]) };
  }

  /** The wallet must be connected to Robinhood Chain, otherwise value would go to Bull's addresses on a chain where nothing lives there. */
  async #chainOk() {
    let id;
    let live;
    try { live = Number(await this.w.getChainId()); } catch { live = undefined; }
    try { id = Number(this.w.chain?.id ?? live); } catch { bad("could not read the wallet's chain id."); }
    if (live !== undefined && live !== id) bad(`the wallet's configured chain (${id}) and its live chain (${live}) differ.`);
    if (!Number.isFinite(id) || id !== this.cfg.id) bad(`the wallet is on chain ${id}, not ${this.cfg.name} (${this.cfg.id}).`);
  }

  async #decimals(token) {
    if (!token || low(token) === "eth" || low(token) === ZERO) return 18;
    if (low(token) === this.cfg.alias) return 6;
    try { return Number(await this.p.readContract({ address: token, abi: erc20Abi, functionName: "decimals" })); } catch { bad("could not read the token's decimals."); }
  }

  async #send(tx, maxWei = 0n, o = {}) {
    await this.#chainOk();
    const fn = this.#guard(tx, maxWei, o);
    if (o.check && fn) o.check(fn);
    const hash = await this.w.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value || "0"), chain: this.w.chain });
    const rc = await this.p.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error("Transaction failed: " + hash);
    return rc;
  }

  /** Signed fee quote and the createDeal transaction for an agreed trade. The connected wallet is the buyer. */
  quote({ seller, sellToken, sellAmount, payAsset = "eth", payAmount, sellerPayout, buyerReceive, deadlineHours, sellerSig, validUntil, deadline }) {
    return this.#call("/api/v1/settle", { buyer: this.address, seller, sellToken, sellAmount, payAsset, payAmount, sellerPayout, buyerReceive, deadlineHours, sellerSig, validUntil, deadline });
  }

  /** Seller side, step 1: the connected wallet (the seller) signs the exact deal terms. Give the result to the buyer, who passes it to open().
   *  `buyer` is the buyer's wallet. Returns { sellerSig, validUntil, deadline }: pass all three to the buyer's open(). The signature is EIP-712 and the escrow contract checks it. */
  async consent({ buyer, sellToken, sellAmount, payAsset = "eth", payAmount, sellerPayout, buyerReceive, deadlineHours }) {
    const m = await this.#call("/api/v1/settle", { buyer, seller: this.address, sellToken, sellAmount, payAsset, payAmount, sellerPayout, buyerReceive, deadlineHours, consentOnly: true });
    await this.#checkConsent(m.typedData, { buyer, sellToken, sellAmount, payAsset, payAmount, sellerPayout, buyerReceive, deadlineHours });
    const t = m.typedData;
    const message = Object.fromEntries(Object.entries(t.message).map(([k, v]) => [k, /^\d+$/.test(String(v)) ? BigInt(v) : v]));
    const sellerSig = await this.w.signTypedData({ account: this.w.account, domain: t.domain, types: t.types, primaryType: t.primaryType, message });
    return { sellerSig, validUntil: String(t.message.validUntil), deadline: String(t.message.deadline) }; // the values that were signed, not the server's separate fields
  }

  /** Compares the typed data the server wants signed with the terms you passed. Refuses to sign if anything differs. */
  async #checkConsent(typed, t) {
    if (!typed || typed.primaryType !== "Consent" || !typed.message || !typed.domain) bad("unexpected consent data.");
    const f = Object.fromEntries(Object.entries(typed.message).map(([k, v]) => [k, String(v).toLowerCase()]));
    const me = low(this.address);
    const dec = await this.#decimals(t.sellToken); // refuses when the decimals cannot be read: never guess 18
    if (!["eth", "usdg"].includes(low(t.payAsset))) bad("payAsset must be eth or usdg.");
    const payToken = low(t.payAsset) === "usdg" ? USDG : ZERO;
    const payDec = payToken === ZERO ? 18 : 6;
    const want = {
      seller: me, buyer: low(t.buyer), sellToken: low(t.sellToken), sellAmount: parseUnits(String(t.sellAmount), dec).toString(),
      payToken, payAmount: parseUnits(String(t.payAmount), payDec).toString(), sellerPayout: low(t.sellerPayout || ZERO) /* zero = pay the seller */, buyerReceive: low(t.buyerReceive || ZERO),
    };
    for (const k of Object.keys(want)) if (f[k] !== want[k]) bad(`consent has ${k}=${f[k]}, you asked for ${want[k]}.`);
    const d = typed.domain;
    if (d.name !== "BullEscrow" || String(d.version) !== "3" || Number(d.chainId) !== this.cfg.id || !this.cfg.escrows.includes(low(d.verifyingContract))) bad("consent names an unknown escrow contract.");
    const shape = (typed.types?.Consent || []).map((x) => x.name + ":" + x.type).join(",");
    if (shape !== "buyer:address,seller:address,sellerPayout:address,buyerReceive:address,sellToken:address,sellAmount:uint256,payToken:address,payAmount:uint256,deadline:uint64,validUntil:uint64") bad("consent has an unexpected layout.");
    if (!/^\d+$/.test(String(f.validUntil)) || Number(f.validUntil) < Math.floor(Date.now() / 1000) + 60) bad("consent is already expired or has no validity time.");
    const left = Number(f.deadline) - Math.floor(Date.now() / 1000);
    if (!(left > 600 && left <= 60 * 86400)) bad("consent has an unreasonable deadline.");
    if (Number(f.validUntil) > Number(f.deadline)) bad("consent stays valid longer than the deal deadline.");
    if (t.deadlineHours !== undefined && Math.abs(left - Number(t.deadlineHours) * 3600) > 600) bad("consent has a different deadline than you asked for.");
  }

  /** Buyer: opens the escrow deal. Returns the dealId. The createDeal transaction is decoded and checked BEFORE it is sent. */
  async open(params) {
    if (this.chainName !== "robinhood") bad("delivery_vs_payment (open/fund/receipt) is live on Robinhood Chain only for now.");
    this.#note(params.sellToken);
    if (!["eth", "usdg"].includes(low(params.payAsset || "eth"))) bad("payAsset must be eth or usdg.");
    const payToken = low(params.payAsset || "eth") === "usdg" ? USDG : ZERO;
    const sd = await this.#decimals(params.sellToken), pd = payToken === ZERO ? 18 : 6;
    const wantSell = parseUnits(String(params.sellAmount), sd), wantPay = parseUnits(String(params.payAmount), pd);
    const me = low(this.address);
    const q = await this.quote(params);
    const pre = (fn) => {
      if (fn.functionName !== "createDeal") return;
      const [p, qt, c] = fn.args, now = Math.floor(Date.now() / 1000);
      if (low(p.seller) !== low(params.seller) || low(p.sellToken) !== low(params.sellToken) || p.sellAmount !== wantSell || low(p.payToken) !== payToken || p.payAmount !== wantPay)
        bad("the createDeal transaction has other terms (seller, token, amounts) than you asked for.");
      const wantPayout = low(params.sellerPayout || ZERO);
      if (low(p.sellerPayout) !== wantPayout && !(wantPayout === ZERO && low(p.sellerPayout) === low(params.seller))) bad("the createDeal transaction pays the seller's proceeds to another wallet than you asked for.");
      if (low(p.buyerReceive) !== low(params.buyerReceive || ZERO) && !(!params.buyerReceive && low(p.buyerReceive) === me)) bad("the createDeal transaction sends the tokens to a wallet other than yours.");
      if (Number(qt.feeBps) > 250) bad("the createDeal transaction has a fee above 2.5%.");
      const left = Number(p.deadline) - now;
      if (!(left > 600 && left <= 60 * 86400)) bad("the createDeal transaction has an unreasonable deadline.");
      if (Number(c.validUntil) < now) bad("the seller's consent in the transaction has expired.");
    };
    const rc = await this.#send(q.transaction, 0n, { fn: ["createDeal"], check: pre });
    const logs = parseEventLogs({ abi: ABI, logs: rc.logs, eventName: "DealCreated" });
    if (!logs.length) throw new Error("DealCreated event not found.");
    const L = logs[0].args;
    if (low(L.buyer) !== me || low(L.seller) !== low(params.seller)) bad("the deal that was opened has a different buyer or seller than you asked for.");
    if (L.feeBps > 250) bad("the deal has a fee above 2.5%.");
    if (q.feeBps !== undefined && Number(L.feeBps) !== Number(q.feeBps)) bad("the deal has a different fee than the quote you were shown.");
    const d = await this.#deal(L.id);
    if (low(d.buyer) !== me || low(d.seller) !== low(params.seller) || low(d.sellToken) !== low(params.sellToken) || d.sellAmount !== wantSell || low(d.payToken) !== payToken || d.payAmount !== wantPay)
      bad("the deal that was created on chain does not match the terms you asked for. Do NOT fund it; cancel it.");
    if (low(d.buyerReceive) !== low(params.buyerReceive || ZERO) && !(!params.buyerReceive && low(d.buyerReceive) === me)) bad("the deal that was created on chain sends the tokens to another wallet than yours. Do NOT fund it; cancel it.");
    const wp = low(params.sellerPayout || ZERO);
    if (low(d.sellerPayout) !== wp && !(wp === ZERO && low(d.sellerPayout) === low(params.seller))) bad("the deal that was created on chain pays the seller's proceeds elsewhere than you asked for. Do NOT fund it; cancel it.");
    return String(L.id);
  }

  /** Current state of a deal and the next transactions of each side. */
  status(dealId) {
    return this.#call("/api/v1/settle/" + dealId);
  }

  /** Sends every pending step of the connected wallet (buyer: pay, seller: deliver tokens). The swap settles when the second side funds.
   *  What each step may do is limited by the deal read from the chain (never by the server). */
  async fund(dealId) {
    const d = await this.#deal(dealId);
    if (d.status !== 1) bad("the deal is not open.");
    const me = low(this.address), buyer = me === low(d.buyer), seller = me === low(d.seller);
    if (!buyer && !seller) bad("this wallet is neither the buyer nor the seller of the deal.");
    const s = await this.status(dealId);
    const mine = [...s.buyerSteps, ...s.sellerSteps].filter((x) => low(x.from) === me);
    const token = buyer ? d.payToken : d.sellToken;
    if (low(token) !== ZERO) this.tokens.add(low(token));
    const maxWei = buyer && low(d.payToken) === ZERO ? d.payAmount : 0n;
    const maxApprove = buyer ? d.payAmount : d.sellAmount;
    const hashes = [];
    for (const step of mine) hashes.push((await this.#send(step.transaction, maxWei, { token, maxApprove, fn: ["fundPayment", "fundTokens", "fundTokensWithPermit"], id: dealId })).transactionHash);
    return hashes;
  }

  /** Waits until the swap is settled (or cancelled). */
  async waitSettled(dealId, { timeoutMs = 600000, everyMs = 4000 } = {}) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const s = await this.status(dealId);
      if (s.status === "settled" || s.status === "cancelled") {
        // Never believe the server about this: read the deal from the chain.
        const d = await this.#deal(dealId);
        if (d.status !== (s.status === "settled" ? 2 : 3)) bad(`the server says the deal is ${s.status}, the chain does not.`);
        return s;
      }
      if (Date.now() > end) throw new Error("Timed out waiting for settlement.");
      await new Promise((r) => setTimeout(r, everyMs));
    }
  }

  /** Signed receipt of a settled deal. Public. */
  async receipt(dealId) {
    const j = await this.#call("/api/v1/receipts/" + dealId);
    const r = j.receipt;
    const message = ["Bull receipt v1", ...Object.entries(r).map(([k, x]) => `${k}:${x}`)].join("\n");
    if (message !== j.message) bad("the receipt text does not match its fields.");
    if (low(await recoverMessageAddress({ message, signature: j.signature })) !== FEE_SIGNER) bad("the receipt is not signed by Bull.");
    if (!this.cfg.escrows.includes(low(r.escrow)) || String(r.dealId) !== String(dealId)) bad("the receipt is for a different escrow or deal.");
    const d = await this.#deal(dealId, r.escrow);
    if (d.status !== 2 || low(d.buyer) !== low(r.buyer) || low(d.seller) !== low(r.seller) || low(d.sellToken) !== low(r.sellToken) || String(d.sellAmount) !== r.sellAmount || low(d.payToken) !== low(r.payToken) || String(d.payAmount) !== r.payAmount)
      bad("the chain does not show this deal as settled with these terms.");
    return j;
  }

  /** Locks tokens with an unlock schedule (cliff, then linear or stepped). Returns the lockId. Days can be fractions.
   *  await bull.lock({ token, amount: "1000000", beneficiary, cliffDays: 90, durationDays: 365, stepDays: 30, locker: "0xVestingContractYouTrust" }) */
  async lock({ token, amount, beneficiary, cliffDays = 0, durationDays, stepDays = 0, startAt, locker }) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(locker || ""))) bad("pass { locker }: the vesting contract address you trust. It is never taken from the server.");
    const q = await this.#call("/api/v1/vesting", { locker: this.address, token, amount, beneficiary, cliffDays, durationDays, stepDays, startAt });
    this.#note(token);
    const dec = await this.#decimals(token);
    let rc;
    const hex = (a) => low(a).slice(2).padStart(64, "0");
    for (const step of q.steps) {
      const tx = step.transaction, d = String(tx?.data || "").toLowerCase();
      // Only the approval and the call to the locker you pinned are allowed. A call to any Bull contract (createAgreement, fundPayment, ...) is refused, and the locker call must name the token and the beneficiary you asked for.
      if (low(tx?.to) === low(locker) && !d.startsWith("0x095ea7b3") && !(d.includes(hex(token)) && d.includes(hex(beneficiary))))
        bad("the lock transaction does not name the token and the beneficiary you asked for.");
      rc = await this.#send(tx, 0n, { locker, token, fn: [], maxApprove: parseUnits(String(amount), dec) });
    }
    const logs = parseEventLogs({ abi: LOCK_ABI, logs: rc.logs, eventName: "LockCreated" });
    if (!logs.length) throw new Error("LockCreated event not found.");
    const L = logs[0].args;
    if (low(L.token) !== low(token) || low(L.beneficiary) !== low(beneficiary) || L.amount !== parseUnits(String(amount), dec)) bad("the lock that was created does not match what you asked for.");
    const near = (got, days) => Math.abs(Number(got) - Number(days || 0) * 86400) <= 3600; // within an hour
    if (!near(L.cliff - L.start, cliffDays) || !near(L.end - L.start, durationDays) || !near(L.step, stepDays) || (Number(startAt) > 0 && Number(L.start) !== Math.floor(Number(startAt))))
      bad("the lock that was created has a different cliff, end or step than the schedule you asked for.");
    return String(L.id);
  }

  /** Schedule and unlocked/claimable amounts of a lock. Public. */
  lockStatus(lockId) {
    return this.#call("/api/v1/vesting/" + lockId);
  }

  /** Claims what has unlocked. Anyone can send it, the tokens always go to the beneficiary. */
  async claim(lockId, opts = {}) {
    const s = await this.lockStatus(lockId);
    if (!s.claimTransaction) throw new Error("Nothing to claim yet.");
    if (!opts.locker || low(opts.locker) !== low(s.claimTransaction.to)) bad("pass { locker } with the vesting contract address you trust; the server's claim goes elsewhere.");
    return (await this.#send(s.claimTransaction, 0n, { locker: opts.locker, fn: [] })).transactionHash;
  }

  /** Programmable escrow: pay `payee` when all conditions are true, refund the payer after expiry. Returns the agreementId.
   *  await bull.agree({ payee, asset: "usdg", amount: "500", terms: "Deliver the report", expiryHours: 72,
   *    conditions: [{ type: "attest", by: "0xArbiterOrAgentB" }, { type: "time_after", afterHours: 1 }] })
   *  Condition types: time_after {at|afterHours}, attest {by}, token_balance_gte {token, holder, min}, call_gte / call_lte {target, data, value}. */
  async agree({ payee, asset = "eth", amount, terms, expiryHours, conditions }) {
    const q = await this.#call("/api/v1/agreements", { payer: this.address, payee, asset, amount, terms, expiryHours, conditions });
    this.#note(asset);
    const dec = await this.#decimals(asset);
    const want = parseUnits(String(amount), dec);
    const cap = this.#agreeCap(asset, amount);
    let rc;
    const assetAddr = String(asset).toLowerCase() === "eth" ? ZERO : (String(asset).toLowerCase() === this.cfg.alias ? this.cfg.stable : low(asset));
    const expect = Array.isArray(conditions) ? await this.#expectConditions(conditions) : null;
    const wantTerms = terms ? keccak256(toHex(String(terms))) : "0x" + "00".repeat(32);
    const creates = (q.steps || []).filter((x) => String(x?.name) === "createAgreement" || low(x?.transaction?.to) === this.cfg.agreement).length;
    if (creates !== 1) bad(`the server returned ${creates} createAgreement steps, you asked for exactly one.`);
    const check = (fn) => {
      if (fn.functionName !== "createAgreement") return;
      const p = fn.args[0], now = Math.floor(Date.now() / 1000);
      if (low(p.payee) !== low(payee) || low(p.asset) !== assetAddr || p.amount !== want) bad("the agreement transaction has a different payee, asset or amount than you asked for.");
      if (Number(p.expiry) <= now || (expiryHours !== undefined && Math.abs(Number(p.expiry) - (now + Number(expiryHours) * 3600)) > 900)) bad("the agreement transaction has a different expiry than you asked for.");
      if (low(p.termsHash) !== wantTerms) bad("the agreement transaction commits to other terms than the text you passed (termsHash).");
      if (expect) this.#matchConditions(p.conditions, expect);
    };
    for (const step of q.steps) rc = await this.#send(step.transaction, cap, { token: assetAddr, maxApprove: want, fn: ["createAgreement"], check });
    const logs = parseEventLogs({ abi: AGR_ABI, logs: rc.logs, eventName: "AgreementCreated" });
    if (!logs.length) throw new Error("AgreementCreated event not found.");
    const L = logs[0].args;
    if (low(L.payer) !== low(this.address) || low(L.payee) !== low(payee)) bad("the agreement that was created has a different payer or payee than you asked for.");
    if (L.amount !== want || low(L.asset) !== (String(asset).toLowerCase() === "eth" ? ZERO : (String(asset).toLowerCase() === this.cfg.alias ? this.cfg.stable : low(asset)))) bad("the agreement that was created has a different asset or amount than you asked for.");
    if (low(L.termsHash) !== wantTerms) bad("the agreement that was created commits to other terms than the text you passed (termsHash).");
    return String(L.id);
  }

  /** The on-chain conditions (kind, target, data, value) that the conditions you passed must turn into. */
  async #expectConditions(conditions) {
    const now = Math.floor(Date.now() / 1000), out = [];
    for (const c of conditions) {
      const at = (x) => (Number(x.at) > 0 ? { v: BigInt(Math.floor(Number(x.at))), tol: 0 } : { v: BigInt(now + Math.round(Number(x.afterHours) * 3600)), tol: 900 });
      if (c.type === "time_after") out.push({ kind: 0, target: ZERO, ...at(c) });
      else if (c.type === "unless") out.push({ kind: 5, target: low(c.by), ...at(c) });
      else if (c.type === "veto") out.push({ kind: 9, target: low(c.by), data: encodeAbiParameters([{ type: "uint256" }], [BigInt(c.attestIndex ?? conditions.slice(0, conditions.indexOf(c)).map((x) => x.type).lastIndexOf("attest"))]).toLowerCase(), v: BigInt(Math.round(Number(c.afterHours) * 3600)), tol: 0 });
      else if (c.type === "attest") out.push({ kind: 1, target: low(c.by) });
      else if (c.type === "token_balance_gte") out.push({ kind: 7, target: low(c.token), data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [c.holder] }).toLowerCase(), v: parseUnits(String(c.min), await this.#decimals(c.token)), tol: 0 });
      else if (c.type === "call_gte" || c.type === "call_lte") out.push({ kind: c.type === "call_gte" ? 7 : 8, target: low(c.target), data: low(c.data), v: BigInt(c.value), tol: 0 });
      else if (c.type === "deal_settled") out.push({ kind: 4, target: low(c.escrow || this.cfg.escrows[0]), v: BigInt(c.dealId), tol: 0 });
      else if (c.type === "quorum") out.push({ kind: 6, target: ZERO, data: encodeAbiParameters([{ type: "address[]" }], [c.by]).toLowerCase(), v: BigInt(c.k), tol: 0 });
      else bad(`unknown condition type ${c.type}.`);
    }
    return out;
  }

  /** Every on-chain condition must equal the one you asked for, in order: kind, target, data and value. */
  #matchConditions(got, expect) {
    if (got.length !== expect.length) bad("the agreement transaction has a different number of conditions than you asked for.");
    got.forEach((g, i) => {
      const e = expect[i], v = BigInt(g.value), d = e.v === undefined ? 0n : e.v, tol = BigInt(e.tol || 0);
      if (Number(g.kind) !== e.kind || low(g.target) !== e.target || (e.data !== undefined && low(g.data) !== e.data) || (e.v !== undefined && (v < d - tol || v > d + tol)) || (e.v === undefined && v !== 0n))
        bad(`condition ${i + 1} of the agreement transaction is not the one you asked for.`);
    });
  }

  // Most ETH an agreement transaction may carry: the amount (if paid in ETH) plus a fee allowance.
  #agreeCap(asset, amount, mult = 105n) {
    const fee = parseEther("0.05");
    return String(asset || "eth").toLowerCase() === "eth" ? (parseEther(String(amount)) * mult) / 100n + fee : fee;
  }

  /** Status, every condition (met true/false) and the next transactions. Public. */
  agreement(id) {
    return this.#call("/api/v1/agreements/" + id);
  }

  /** Sends every pending action of the connected wallet on an agreement: attest (confirm), vote (panel) or, with
   *  { object: true }, the objection of an "unless" window. */
  async attest(id, { object = false } = {}) {
    const a = await this.agreement(id);
    const mine = a.conditions.flatMap((c) => c.actions).filter((x) => x.from.toLowerCase() === this.address.toLowerCase() && (object ? x.name === "object" : x.name !== "object"));
    if (!mine.length) throw new Error("Nothing to " + (object ? "object to" : "confirm") + " from this wallet.");
    const hashes = [];
    for (const x of mine) hashes.push((await this.#send(x, 0n, { fn: object ? ["object"] : ["attest", "vote"], id })).transactionHash);
    return hashes;
  }

  /** Objects during an objection window (template "optimistic"): the payee is then not paid automatically. */
  object(id) {
    return this.attest(id, { object: true });
  }

  /** Deal templates and their fields. Public. */
  templates() {
    return this.#call("/api/v1/templates");
  }

  /** One call for a standard deal. Returns the agreement id (an array for "milestones").
   *  await bull.deal("arbiter_escrow", { payee, asset: "usdg", amount: "500", arbiter: "0xArbiter", terms: "Deliver the report" })
   *  Templates: delivery_vs_payment, arbiter_escrow, milestones, optimistic, panel, scheduled_payment, recurring_payment, split_payment, after_deal, balance_trigger, price_trigger, performance_bond. */
  async deal(template, params) {
    if (template === "delivery_vs_payment") return this.open({ seller: params.seller, sellToken: params.sellToken, sellAmount: params.sellAmount, payAsset: params.payAsset, payAmount: params.payAmount, deadlineHours: params.deadlineHours });
    const q = await this.#call("/api/v1/templates", { ...params, template, payer: this.address });
    this.#note(params.asset);
    const dec = await this.#decimals(params.asset || "eth");
    const amountOne = parseUnits(String(params.amount), dec);
    const cap = this.#agreeCap(params.asset || "eth", params.amount);
    const ids = [];
    let sum = 0n;
    const assetAddr = String(params.asset || "eth").toLowerCase() === "eth" ? ZERO : (String(params.asset).toLowerCase() === this.cfg.alias ? this.cfg.stable : low(params.asset));
    const isMs = template === "milestones", isRec = template === "recurring_payment", isSplit = template === "split_payment", multi = isMs || isRec || isSplit;
    const payeesL = isSplit && Array.isArray(params.payees) ? params.payees.map(low) : [];
    const n = isMs ? Math.round(Number(params.milestones)) : isRec ? Math.round(Number(params.payments)) : isSplit ? payeesL.length : 1;
    if (isMs && !(n >= 2 && n <= 8)) bad("milestones must be 2 to 8.");
    if (isRec && !(n >= 2 && n <= 12)) bad("payments must be 2 to 12.");
    if (isSplit && !(n >= 2 && n <= 10)) bad("payees must list 2 to 10 wallets.");
    const total = isRec ? amountOne * BigInt(n) : amountOne;
    // Split: the amount of each share, computed exactly like the server does it (micro units, the first payee gets the rounding rest).
    let splitAmt = [];
    if (isSplit) {
      if (dec < 6) bad("split payments need a token with at least 6 decimals.");
      const sh = (Array.isArray(params.shares) ? params.shares : []).map(Number);
      if (sh.length !== n || sh.some((x) => !(x > 0) || !Number.isFinite(x))) bad("shares must be one positive number per payee.");
      const sumSh = sh.reduce((a, c) => a + c, 0), totalMicro = Math.round(Number(params.amount) * 1e6);
      const micro = sh.map((x) => Math.floor((totalMicro * x) / sumSh));
      micro[0] += totalMicro - micro.reduce((a, c) => a + c, 0);
      splitAmt = micro.map((m) => BigInt(m) * 10n ** BigInt(dec - 6));
    }
    const creates = (q.steps || []).filter((x) => String(x?.name) === "createAgreement" || low(x?.transaction?.to) === this.cfg.agreement).length;
    if (creates !== n) bad(`the server returned ${creates} createAgreement steps, you asked for ${n}.`);
    // Conditions each template must produce (kind and target). The arbiter / payer / token you passed must be the ones in the transaction.
    const me = low(this.address), arb = low(params.arbiter);
    const shape = {
      arbiter_escrow: [[1, arb]], performance_bond: [[1, arb]], milestones: [[1, arb]], recurring_payment: [[0, ZERO]], split_payment: [[params.arbiter ? 1 : 0, params.arbiter ? arb : ZERO]], optimistic: [[5, me]], panel: [[6, ZERO]], two_of_three: [[6, ZERO]],
      scheduled_payment: [[0, ZERO]], confirmed_with_cooling: [[1, arb], [9, me]], after_deal: [[4, null]], balance_trigger: [[7, low(params.token)]],
      price_trigger: [[params.op === "lte" ? 8 : 7, low(params.target)]],
    }[template];
    if (!shape && template !== "token_price_trigger") bad(`unknown template ${template}.`);
    const wantTerms = params.terms ? keccak256(toHex(String(params.terms))) : "0x" + "00".repeat(32);
    const hoursMax = Math.max(Number(params.expiryHours) || 72, Number(params.windowHours || 0) + 24, Number(params.afterHours || 0) + 24, isMs ? (Number(params.stepHours) || 168) * n : 0, isRec ? (Number(params.everyHours) || 168) * n + 24 : 0);
    const balMin = template === "balance_trigger" ? parseUnits(String(params.min), await this.#decimals(params.token)) : 0n;
    const balData = template === "balance_trigger" ? encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [params.holder] }).toLowerCase() : "";
    let seen = 0;
    const check = (fn) => {
      if (fn.functionName !== "createAgreement") return;
      const p = fn.args[0], now = Math.floor(Date.now() / 1000);
      seen++;
      if (low(p.asset) !== assetAddr || (params.payee && low(p.payee) !== low(params.payee))) bad("the agreement transaction has a different payee or asset than you asked for.");
      if (isSplit && low(p.payee) !== payeesL[seen - 1]) bad("the agreement transaction pays another wallet than the payee you listed for this share.");
      const amountOk = isMs ? (p.amount <= total && p.amount >= total / BigInt(n) - BigInt(n) * 10n ** BigInt(Math.max(0, dec - 6))) : isRec ? p.amount === amountOne : isSplit ? p.amount === splitAmt[seen - 1] : p.amount === total;
      if (!amountOk) bad("the agreement transaction has a different amount than you asked for.");
      if (Number(p.expiry) <= now || Number(p.expiry) > now + hoursMax * 3600 + 900) bad("the agreement transaction has an expiry that does not fit the expiryHours you asked for.");
      if (template === "milestones") {
        const want = Math.max(Number(params.expiryHours) || 0, (Number(params.stepHours) || 168) * seen);
        if (Math.abs(Number(p.expiry) - (now + want * 3600)) > 1800) bad(`milestone ${seen} has an expiry that is not the ${want} hours the schedule defines.`);
      }
      if (low(p.termsHash) !== wantTerms && !multi) bad("the agreement transaction commits to other terms than the text you passed (termsHash).");
      if (shape) {
        if (p.conditions.length !== shape.length) bad("the agreement transaction has a different number of conditions than the template defines.");
        shape.forEach(([kind, target], i) => { const g = p.conditions[i]; if (Number(g.kind) !== kind || (target !== null && low(g.target) !== target)) bad(`condition ${i + 1} of the agreement transaction is not the one the template defines for the parameters you passed.`); });
        if (template === "price_trigger" && (low(p.conditions[0].data) !== low(params.data) || BigInt(p.conditions[0].value) !== BigInt(params.value))) bad("the price condition has another data or threshold than you asked for.");
        if (template === "after_deal" && p.conditions[0].value !== BigInt(params.dealId)) bad("the deal_settled condition names another deal than you asked for.");
        if (template === "balance_trigger" && (BigInt(p.conditions[0].value) !== balMin || low(p.conditions[0].data) !== balData)) bad("the balance condition watches another wallet or minimum than you asked for.");
        const near = (v, hours) => Number.isFinite(hours) && Math.abs(Number(v) - (now + hours * 3600)) <= 900;
        if (template === "scheduled_payment" && !near(p.conditions[0].value, Number(params.afterHours))) bad("the time condition unlocks at another time than the afterHours you asked for.");
        if (isRec) { const ev = Number(params.everyHours) || 168; if (Math.abs(Number(p.conditions[0].value) - (now + seen * ev * 3600)) > 1800) bad(`payment ${seen} unlocks at another time than every ${ev} hours.`); }
        if (isSplit && !params.arbiter && !near(p.conditions[0].value, Number(params.afterHours))) bad("the share unlocks at another time than the afterHours you asked for.");
        if (template === "optimistic" && !near(p.conditions[0].value, Number(params.windowHours) || 24)) bad("the objection window is another length than the windowHours you asked for.");
      }
      if (sum + p.amount > total) bad("the agreement transactions would lock more than the amount you asked for.");
      sum += p.amount; // counted BEFORE it is sent
    };
    for (const step of q.steps) {
      const rc = await this.#send(step.transaction, cap, { token: assetAddr, maxApprove: total, fn: ["createAgreement"], check });
      for (const l of parseEventLogs({ abi: AGR_ABI, logs: rc.logs, eventName: "AgreementCreated" })) ids.push(String(l.args.id));
    }
    if (seen !== n || ids.length !== n) bad(`${ids.length} agreements were created, you asked for ${n}.`);
    if (sum > total || (isMs ? total - sum > BigInt(n) * 10n ** BigInt(Math.max(0, dec - 6)) : sum !== total)) bad("the agreements that were created do not add up to the amount you asked for.");
    return n > 1 ? ids : ids[0];
  }

  /** Pays the payee once every condition is true (anyone can send it). */
  async release(id) {
    const a = await this.agreement(id);
    if (!a.releaseTransaction) throw new Error("Not releasable yet: " + a.conditions.filter((c) => !c.met).map((c) => c.type).join(", "));
    return (await this.#send(a.releaseTransaction, 0n, { fn: ["release"], id })).transactionHash;
  }

  /** After the expiry, sends the funds back to the payer (anyone can send it). */
  async refund(id) {
    const a = await this.agreement(id);
    if (!a.refundTransaction) throw new Error("Not refundable yet.");
    return (await this.#send(a.refundTransaction, 0n, { fn: ["refund"], id })).transactionHash;
  }

  // ---- Cross-chain (Base <-> Robinhood Chain), third-party bridge. Bull never holds bridge funds; the recipient is always your own address. ----
  /** bull.bridge.quote({from,to,amount}) / .send(quote) / .status(id) / .wait(id). `to` is the settlement chain. Experimental, not tested end to end. */
  get bridge() {
    const self = this;
    const prep = ({ from, to, amount, user }) => {
      const f = bridgeChain(from), t = bridgeChain(to);
      if (f.id === t.id) bad("from and to must be different chains.");
      const raw = toRaw(amount);
      if (raw < 1000000n || raw > 10000n * 1000000n) bad("amount must be between 1 and 10000.");
      return { from: f, to: t, amount: String(amount).trim(), raw, user: user || self.address };
    };
    const relay = async (path, body) => {
      const r = await fetch(RELAY_API + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-api-key": self.relayKey }, body: body ? JSON.stringify(body) : undefined });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.message || j?.error || `Relay ${r.status}`);
      return j;
    };
    return {
      /** Quote: the transactions that move your stablecoin to the settlement chain. Nothing is sent. */
      quote: async (o) => {
        const req = prep(o);
        if (low(req.user) === low(this.cfg.agreement) || this.cfg.escrows.includes(low(req.user))) bad("user must be your own wallet, not a Bull contract.");
        if (this.relayKey) {
          const j = await relay("/quote/v2", { user: req.user, originChainId: req.from.id, destinationChainId: req.to.id, originCurrency: req.from.token, destinationCurrency: req.to.token, amount: req.raw.toString(), tradeType: "EXACT_INPUT", recipient: req.user });
          return checkBridge(relayToBull(req, j), req);
        }
        const r = await fetch(this.base + "/api/v1/bridge/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fromChain: req.from.key, toChain: req.to.key, amount: req.amount, user: req.user }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j?.error?.message || j?.error || `Bull API ${r.status}`);
        return checkBridge(j, req);
      },
      /** Sends the quote's transactions from this wallet, in order (the SDK must be constructed with chain = the ORIGIN chain). Returns the transaction hashes. */
      send: async (q) => {
        const f = bridgeChain(q?.from?.chain), t = bridgeChain(q?.to?.chain);
        const req = { from: f, to: t, amount: q.amount, raw: toRaw(q.amount), user: self.address };
        checkBridge(q, req);
        if (this.cfg.id !== f.id) bad(`create the Bull instance with chain "${f.key}" to send the bridge from ${f.name}.`);
        await this.#chainOk();
        const hashes = [];
        for (const s of q.steps) {
          const hash = await this.w.sendTransaction({ account: this.w.account, to: s.transaction.to, data: s.transaction.data, value: 0n });
          await this.p.waitForTransactionReceipt({ hash });
          hashes.push(hash);
        }
        return hashes;
      },
      /** pending | confirmed | failed | refunded. Open the agreement only when it is confirmed. */
      status: async (id) => {
        if (!/^0x[0-9a-fA-F]{64}$/.test(String(id || ""))) bad("id must be the 0x… id from bridge.quote.");
        if (this.relayKey) {
          const j = await relay("/intents/status/v3?requestId=" + id);
          const raw = low(j?.status);
          const status = raw === "success" ? "confirmed" : raw === "refund" || raw === "refunded" ? "refunded" : raw === "failure" ? "failed" : "pending";
          return { id, status, done: status !== "pending", relayStatus: raw || null };
        }
        const r = await fetch(this.base + "/api/v1/bridge/status?id=" + id);
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j?.error?.message || j?.error || `Bull API ${r.status}`);
        return j;
      },
      /** Polls until the bridge is confirmed. Throws if it failed or was refunded. Default timeout 15 minutes. */
      wait: async (id, { timeoutMs = 900000, everyMs = 4000 } = {}) => {
        const end = Date.now() + timeoutMs;
        while (Date.now() < end) {
          const s = await this.bridge.status(id);
          if (s.status === "confirmed") return s;
          if (s.status === "failed" || s.status === "refunded") throw new Error("Bridge " + s.status + ". Do not open the agreement.");
          await new Promise((r) => setTimeout(r, everyMs));
        }
        throw new Error("Bridge not confirmed in time. Check bridge.status(id) before you do anything else.");
      },
    };
  }

  /** Plan for an agreement between agents on different chains. Sends nothing. Returns ordered steps:
   *  1 bridge (payer's stablecoin to the settlement chain, only if the payer is not already there), 2 wait for the bridge, 3 approve + open the agreement ON the
   *  settlement chain, 4 release later. settleOn defaults to the seller's chain, so the seller is paid natively. Experimental: third-party bridge, not tested end to end. */
  async crossChainSettle({ payerChain, sellerChain, amount, settleOn, payer = this.address, template = "arbiter_escrow", terms }) {
    const pc = bridgeChain(payerChain), sc = bridgeChain(sellerChain), st = bridgeChain(settleOn || sellerChain);
    if (pc.id === sc.id) bad("both agents are on the same chain: no bridge needed, use bull.deal() on that chain.");
    const steps = [];
    if (pc.id !== st.id) {
      const quote = await this.bridge.quote({ from: pc.key, to: st.key, amount, user: payer });
      steps.push({ n: 1, action: "bridge", chain: pc.key, by: "payer", note: `Send these transactions on ${pc.name}: ${pc.symbol} arrives as ${st.symbol} on ${st.name}, to your own address.`, quote });
      steps.push({ n: 2, action: "wait_bridge", by: "payer", note: "Call bull.bridge.wait(quote.id). Only continue when it is confirmed.", id: quote.id });
    } else {
      steps.push({ n: 1, action: "bridge", by: "none", note: `The payer is already on the settlement chain ${st.name}. The seller receives ${st.symbol} there and can bridge it with bull.bridge.quote() if it wants it on ${sc.name}.` });
    }
    steps.push({ n: steps.length + 1, action: "open_agreement", chain: st.key, by: "payer", note: `With a Bull instance on chain "${st.key}": await bull.deal("${template}", { payee, asset: "${st.asset}", amount: "${amount}"${terms ? `, terms: ${JSON.stringify(terms)}` : ""}, ... }). Approve + createAgreement are sent, checked by the SDK. Needs a little ETH on ${st.name} for gas and the protocol fee.` });
    steps.push({ n: steps.length + 1, action: "release", chain: st.key, by: "anyone", note: "When the conditions are true (e.g. the arbiter attested): bull.release(id). The keeper does it too. After expiry: bull.refund(id)." });
    return { settlementChain: st.key, payerChain: pc.key, sellerChain: sc.key, amount: String(amount), status: "experimental: third-party bridge (Relay), not tested end to end", steps };
  }
}
