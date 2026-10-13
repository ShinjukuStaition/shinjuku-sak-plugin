// Live test: one capped x402 payment through a real SolanaAgentKit instance with the plugin.
// Usage: node scripts/live-pay.mjs <wallet-home> <request_id>
import { SolanaAgentKit, KeypairWallet } from "solana-agent-kit";
import { Keypair } from "@solana/web3.js";
import { ShinjukuPlugin } from "../dist/index.js";
const [home, requestId] = process.argv.slice(2);
const mask = (v) => JSON.stringify(v, null, 2).replace(/"image_base64":s*"[^"]{200,}"/g, "\"image_base64\":\"<omitted>\"").replace(/\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/g, (s) => (s.length > 60 ? s : `${s.slice(0, 4)}…${s.slice(-4)}`));
const plugin = ShinjukuPlugin({ walletHome: home, version: "0.3.12", maxPayment: "14000" });
const agent = new SolanaAgentKit(new KeypairWallet(Keypair.generate(), "https://api.mainnet-beta.solana.com"), "https://api.mainnet-beta.solana.com", {}).use(plugin);
const pay = agent.actions.find((a) => a.name === "SHINJUKU_X402_PAY");
try {
  const t0 = Date.now();
  const out = await pay.handler(agent, {
    url: "https://agentsvc.io/api/v1/proxy/satellite-image", method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bbox: [34.85, 138.35, 36.15, 140.45], date: "2026-10-01", layer: "modis_aqua", width: 1024 }),
    request_id: requestId, max_payment_atomic: "14000",
  });
  console.log(`PAY (${((Date.now() - t0) / 1000).toFixed(1)}s):`, mask(out).slice(0, 4000));
} finally { await plugin.close(); }
