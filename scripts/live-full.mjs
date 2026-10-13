// Live test through a real SolanaAgentKit agent: balance, shield 0.1 USDC (polled), pay agentsvc (cap 14000), receipts.
import { SolanaAgentKit, KeypairWallet } from "solana-agent-kit";
import { Keypair } from "@solana/web3.js";
import { ShinjukuPlugin } from "../dist/index.js";
const home = process.argv[2];
const mask = (v) => JSON.stringify(v, null, 1).replace(/"image_base64":\s*"[^"]{200,}"/g, '"image_base64":"<omitted>"').replace(/\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/g, (s) => `${s.slice(0, 4)}…${s.slice(-4)}`);
const plugin = ShinjukuPlugin({ walletHome: home, version: "0.3.12", maxPayment: "14000" });
const rpc = "https://api.mainnet-beta.solana.com";
const agent = new SolanaAgentKit(new KeypairWallet(Keypair.generate(), rpc), rpc, {}).use(plugin);
const act = (n) => agent.actions.find((a) => a.name === n);
const log = (t, v) => console.log(`=== ${new Date().toISOString()} ${t}\n${mask(v).slice(0, 3000)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  log("balance", await act("SHINJUKU_BALANCE").handler(agent, {}));
  for (let i = 0; i < 90; i++) {
    const s = await act("SHINJUKU_SHIELD").handler(agent, { amount_atomic: "100000", request_id: "sak-shield-1" });
    log("shield", s);
    const t = JSON.stringify(s);
    if (/"stage":"(done|failed)"/.test(t) || s.ok === false && !/retry|wait|progress/i.test(t)) break;
    await sleep(20000);
  }
  log("balance", await act("SHINJUKU_BALANCE").handler(agent, {}));
  const t0 = Date.now();
  const pay = await act("SHINJUKU_X402_PAY").handler(agent, {
    url: "https://agentsvc.io/api/v1/proxy/satellite-image", method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bbox: [34.85, 138.35, 36.15, 140.45], date: "2026-10-01", layer: "modis_aqua", width: 1024 }),
    request_id: "sak-sat-3", max_payment_atomic: "14000" });
  log(`pay (${((Date.now() - t0) / 1000).toFixed(1)}s)`, pay);
  log("receipts", await act("SHINJUKU_RECEIPTS").handler(agent, { limit: 3 }));
  log("balance", await act("SHINJUKU_BALANCE").handler(agent, {}));
} finally { await plugin.close(); }
