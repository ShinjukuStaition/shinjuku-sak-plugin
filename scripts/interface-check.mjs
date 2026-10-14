// Free interface check: starts the wallet MCP server the way the plugin does and checks that
// every wallet tool the plugin calls exists and takes the arguments the plugin sends.
// It calls only shinjukuStatus and shinjukuBalance. No payment, shield or unshield.
// Usage: node scripts/interface-check.mjs <wallet-home-folder> [wallet-version]
// Exit code 0 = the interface matches; 1 = it does not (the output names each difference).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ShinjukuPlugin, buildCommand, DEFAULT_WALLET_VERSION } from "../dist/index.js";

const home = process.argv[2];
const version = process.argv[3] ?? DEFAULT_WALLET_VERSION;
if (!home) {
  console.error("usage: node scripts/interface-check.mjs <wallet-home-folder> [wallet-version]");
  process.exit(2);
}

// The arguments the plugin sends to each wallet tool (src/index.ts).
const EXPECTED = {
  wallet_balance: [],
  wallet_receipts: ["limit"],
  x402_preview: ["url", "method", "headers", "body"],
  x402_pay: ["url", "method", "headers", "body", "request_id", "max_payment_atomic"],
  wallet_shield: ["amount_atomic", "request_id"],
  wallet_unshield: ["amount_atomic", "to", "request_id"],
};

const mask = (value) =>
  JSON.stringify(value).replace(/\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/g, (s) => `${s.slice(0, 4)}…${s.slice(-4)}`);

const problems = [];
const { command, args } = buildCommand({ version });
const env = { ...process.env, SHIELDED_WALLET_HOME: home };
const client = new Client({ name: "shinjuku-sak-plugin-interface-check", version: "1" });
await client.connect(new StdioClientTransport({ command, args, env, stderr: "ignore" }));
let served = "unknown";
try {
  served = client.getServerVersion()?.version ?? "unknown";
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  if (byName.has("wallet_status")) problems.push("the wallet is not set up (the server offers wallet_status)");
  for (const [name, sent] of Object.entries(EXPECTED)) {
    const tool = byName.get(name);
    if (!tool) {
      problems.push(`tool ${name} is missing`);
      continue;
    }
    const properties = Object.keys(tool.inputSchema?.properties ?? {});
    const required = tool.inputSchema?.required ?? [];
    for (const arg of sent) {
      if (!properties.includes(arg)) problems.push(`${name}: the plugin sends "${arg}", the tool does not take it`);
    }
    for (const arg of required) {
      if (!sent.includes(arg)) problems.push(`${name}: the tool requires "${arg}", the plugin does not send it`);
    }
  }
  console.log(`shinjuku-shielded@${version} (server ${served}): ${tools.length} tools: ${tools.map((tool) => tool.name).join(", ")}`);
} finally {
  await client.close();
}

const plugin = ShinjukuPlugin({ walletHome: home, version });
try {
  const status = await plugin.methods.shinjukuStatus();
  console.log("shinjukuStatus:", mask(status));
  if (status.setUp !== true) problems.push("shinjukuStatus does not answer setUp: true");
  const balance = await plugin.methods.shinjukuBalance();
  console.log("shinjukuBalance:", mask(balance));
  if (balance.ok !== true || typeof balance.balanceAtomic !== "string") {
    problems.push("shinjukuBalance does not answer ok: true with a balanceAtomic string");
  }
} finally {
  await plugin.close();
}

if (problems.length > 0) {
  console.log(`INTERFACE MISMATCH with shinjuku-shielded@${version}:`);
  for (const problem of problems) console.log(`- ${problem}`);
  process.exit(1);
}
console.log(`INTERFACE OK with shinjuku-shielded@${version}`);
