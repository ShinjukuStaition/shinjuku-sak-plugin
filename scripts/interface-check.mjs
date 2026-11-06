// Free interface check: starts the wallet MCP server the way the plugin does and checks that
// every wallet tool the plugin calls exists and takes the arguments the plugin sends.
// It calls only shinjukuStatus and shinjukuBalance. No payment, shield or unshield.
// Usage: node scripts/interface-check.mjs <wallet-home-folder> [wallet-version]
// Exit code 0 = the interface matches; 1 = it does not (the output names each difference).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ShinjukuPlugin, buildCommand, DEFAULT_WALLET_VERSION, WALLET_PACKAGE } from "../dist/index.js";

const home = process.argv[2];
const version = process.argv[3] ?? DEFAULT_WALLET_VERSION;
if (!home) {
  console.error("usage: node scripts/interface-check.mjs <wallet-home-folder> [wallet-version]");
  process.exit(2);
}

// The arguments the plugin sends to each wallet tool (src/index.ts). A tool with two names (src/client.ts TOOL_NAMES):
// the first one the wallet lists is the one the plugin calls.
const EXPECTED = [
  [["wallet_balance"], []],
  [["wallet_receipts"], ["limit"]],
  [["check_price", "x402_preview"], ["url", "method", "headers", "body"]],
  [["pay_for_service", "x402_pay"], ["url", "method", "headers", "body", "request_id", "max_payment_atomic"]],
  [["wallet_shield"], ["amount_atomic", "request_id"]],
  [["wallet_unshield"], ["amount_atomic", "to", "request_id"]],
];

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
  for (const [names, sent] of EXPECTED) {
    const name = names.find((one) => byName.has(one));
    const tool = name === undefined ? undefined : byName.get(name);
    if (!tool) {
      problems.push(`tool ${names.join(" or ")} is missing`);
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
  console.log(`${WALLET_PACKAGE}@${version} (server ${served}): ${tools.length} tools: ${tools.map((tool) => tool.name).join(", ")}`);
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
  // balanceAtomic is null while the wallet has no balance walk yet (for example during a pool switch).
  if (balance.ok !== true || !(typeof balance.balanceAtomic === "string" || (balance.balanceAtomic === null && typeof balance.status === "string"))) {
    problems.push("shinjukuBalance does not answer ok: true with a balanceAtomic string (or null with a status)");
  }
} finally {
  await plugin.close();
}

if (problems.length > 0) {
  console.log(`INTERFACE MISMATCH with ${WALLET_PACKAGE}@${version}:`);
  for (const problem of problems) console.log(`- ${problem}`);
  process.exit(1);
}
console.log(`INTERFACE OK with ${WALLET_PACKAGE}@${version}`);
