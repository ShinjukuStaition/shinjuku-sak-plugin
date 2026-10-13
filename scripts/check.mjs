// Free local check: wallet_status and wallet_balance only. No payment, shield or unshield.
// Usage: node scripts/check.mjs <wallet-home-folder>
import { ShinjukuPlugin } from "../dist/index.js";

const home = process.argv[2];
if (!home) {
  console.error("usage: node scripts/check.mjs <wallet-home-folder>");
  process.exit(2);
}
process.env.SHIELDED_WALLET_HOME = home;

const mask = (value) =>
  JSON.stringify(value, null, 2).replace(/\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/g, (s) => `${s.slice(0, 4)}…${s.slice(-4)}`);

const plugin = ShinjukuPlugin({ walletHome: home });
try {
  console.log("shinjukuStatus:", mask(await plugin.methods.shinjukuStatus()));
  console.log("shinjukuBalance:", mask(await plugin.methods.shinjukuBalance()));
} finally {
  await plugin.close();
}
