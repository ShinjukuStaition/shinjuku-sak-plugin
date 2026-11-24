import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** The wallet package the plugin runs with npx (the name agent apps use; `shinjuku-shielded` is its old name). */
export const WALLET_PACKAGE = "shinjuku-shield";

/**
 * Default wallet version: the exact stable release (the pin), not a dist-tag, so the plugin always runs a wallet it was
 * checked with. A new pin comes with a new plugin version. Set `version` to run another one.
 */
export const DEFAULT_WALLET_VERSION = "0.3.270";

/**
 * The name a user types for a command that npm installs (npm, npx): `<name>.cmd` on Windows. npm writes a .cmd, a .ps1
 * and a POSIX file for each command, and Windows PowerShell picks the .ps1, which its default setting on a Windows client
 * refuses ("running scripts is disabled on this system"). The .cmd file runs in Command Prompt and in PowerShell. Only for
 * a line the user types; the plugin itself starts the wallet with `cmd /c npx` (buildCommand).
 */
export function typedCommand(name: "npm" | "npx", platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `${name}.cmd` : name;
}

/**
 * Each wallet tool the plugin calls under two names, newest first. A wallet answers the tools it lists: older wallets
 * list only the older names (0.3.131: x402_pay, x402_preview), newer ones the new names (and still take the old ones as
 * aliases).
 */
export const TOOL_NAMES = {
  pay: ["pay_for_service", "x402_pay"],
  preview: ["check_price", "x402_preview"],
} as const;

/** The error code that x402_pay of an older wallet answers while the wallet refills. */
export const REFILLING_CODE = "wallet_refilling_retry_same_request";

/** request_id format this plugin generates and accepts for shield / unshield. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,44}$/;

export interface ShinjukuPluginOptions {
  /** Version or dist-tag of `shinjuku-shield` to run with npx. Default DEFAULT_WALLET_VERSION (the pin). */
  version?: string;
  /** Wallet folder. Sets SHIELDED_WALLET_HOME for the wallet process. */
  walletHome?: string;
  /** --max-payment: most one payment may cost, in atomic units (1000000 = 1 USDC). */
  maxPayment?: string | number | bigint;
  /** --max-session: most all payments of this process may cost, in atomic units. */
  maxSession?: string | number | bigint;
  /** --max-unshield: most one unshield may send, in atomic units. */
  maxUnshield?: string | number | bigint;
  /** --unshield-to: addresses that wallet_unshield may send to without a prompt. */
  unshieldTo?: string[];
  /** --tor: send the wallet's network traffic through Tor. */
  tor?: boolean;
  /** More arguments, added after the flags above. */
  extraArgs?: string[];
  /** Most total wait for refill retries of a payment, in ms. Default 15 minutes. */
  payRetryMaxWaitMs?: number;
  /** Timeout for one MCP tool call, in ms. Default 5 minutes. */
  callTimeoutMs?: number;
}

export type ShinjukuResult = Record<string, unknown>;

const DEFAULT_PAY_RETRY_MAX_WAIT_MS = 15 * 60 * 1000;
const DEFAULT_CALL_TIMEOUT_MS = 5 * 60 * 1000;

/** Makes a new request_id that matches REQUEST_ID_PATTERN. */
export function newRequestId(prefix = "sak"): string {
  return `${prefix}-${randomBytes(12).toString("hex")}`;
}

/** A Solana address in base58 (32 to 44 characters): the only form --unshield-to takes. */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * One extraArgs word: a flag (--name) or a value of letters, digits and . _ : / \ @ + = , -. On Windows the wallet starts
 * through `cmd /c npx`, and cmd reads & | < > ^ % ! " ( ) and spaces as shell syntax; no word with one of them is passed.
 */
const EXTRA_ARG = /^(?:--[a-z][a-z0-9-]{0,63}|[A-Za-z0-9._:/\\@+=,-]{1,512})$/;

function atomic(name: string, value: string | number | bigint): string {
  const text = String(value);
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new Error(`${name} must be a positive whole number of atomic units`);
  }
  return text;
}

/** Builds the command and arguments that start the wallet MCP server. */
export function buildCommand(
  options: ShinjukuPluginOptions,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  const version = options.version ?? DEFAULT_WALLET_VERSION;
  if (!/^[0-9A-Za-z.+-]{1,64}$/.test(version)) throw new Error("version is not a valid npm version");
  // --no-audit --no-fund: at the first start after a new wallet version, npx ran npm's audit request, and it hung
  // for about 5 min (2026-10-22: setup 311.9 s). The flags skip it.
  const args = ["-y", "--no-audit", "--no-fund", `${WALLET_PACKAGE}@${version}`, "mcp"];
  if (options.maxPayment !== undefined) args.push("--max-payment", atomic("maxPayment", options.maxPayment));
  if (options.maxSession !== undefined) args.push("--max-session", atomic("maxSession", options.maxSession));
  if (options.maxUnshield !== undefined) args.push("--max-unshield", atomic("maxUnshield", options.maxUnshield));
  for (const address of options.unshieldTo ?? []) {
    if (typeof address !== "string" || !BASE58_ADDRESS.test(address)) throw new Error("unshieldTo takes only base58 Solana addresses");
    args.push("--unshield-to", address);
  }
  if (options.tor) args.push("--tor");
  for (const word of options.extraArgs ?? []) {
    if (typeof word !== "string" || !EXTRA_ARG.test(word)) {
      throw new Error("extraArgs takes only flags (--name) and values of letters, digits and . _ : / \\ @ + = , - (no spaces or shell characters)");
    }
    args.push(word);
  }
  if (platform === "win32") return { command: "cmd", args: ["/c", "npx", ...args] };
  return { command: "npx", args };
}

function childEnv(walletHome: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  if (walletHome !== undefined) env.SHIELDED_WALLET_HOME = walletHome;
  return env;
}

interface ContentBlock {
  type: string;
  text?: string;
  mimeType?: string;
  data?: string;
}

/** Parses the JSON text of an MCP tool answer. */
export function parseToolResult(result: Record<string, unknown>): ShinjukuResult {
  const blocks = Array.isArray(result.content) ? (result.content as ContentBlock[]) : [];
  const textBlock = blocks.find((block) => block.type === "text" && typeof block.text === "string");
  let parsed: ShinjukuResult;
  if (textBlock?.text === undefined) {
    parsed = { ok: false, error: "shinjuku_no_text_answer" };
  } else {
    try {
      const value: unknown = JSON.parse(textBlock.text);
      parsed = value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as ShinjukuResult)
        : { value };
    } catch {
      parsed = { ok: false, error: "shinjuku_answer_not_json", text: textBlock.text };
    }
  }
  const images = blocks
    .filter((block) => block.type === "image")
    .map((block) => ({ mimeType: block.mimeType ?? null, base64Length: block.data?.length ?? 0 }));
  if (images.length > 0) parsed.images = images;
  if (result.isError === true && parsed.isError === undefined) parsed.isError = true;
  return parsed;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One shared MCP stdio client for one plugin instance. Starts on the first call. */
export class ShinjukuClient {
  private readonly options: ShinjukuPluginOptions;
  private starting: Promise<Client> | null = null;
  private client: Client | null = null;
  private tools: string[] | null = null;
  private toolsOf: Client | null = null;

  constructor(options: ShinjukuPluginOptions = {}) {
    this.options = options;
    buildCommand(options); // validate options early
  }

  private start(): Promise<Client> {
    if (this.starting) return this.starting;
    const { command, args } = buildCommand(this.options);
    const transport = new StdioClientTransport({
      command,
      args,
      env: childEnv(this.options.walletHome),
      stderr: "ignore",
    });
    const client = new Client({ name: "solana-agent-kit-plugin-shinjuku", version: "0.1.3" });
    const run = client.connect(transport).then(
      () => {
        this.client = client;
        client.onclose = () => {
          if (this.client === client) {
            this.client = null;
            this.starting = null;
          }
        };
        return client;
      },
      async (error: unknown) => {
        this.starting = null;
        await client.close().catch(() => undefined);
        throw error;
      },
    );
    this.starting = run;
    return run;
  }

  /** The tool names this server offers. A server with no wallet set up offers only the setup tools. */
  async toolNames(): Promise<string[]> {
    const client = await this.start();
    if (!this.tools || this.toolsOf !== client) {
      const listed = await client.listTools();
      this.tools = listed.tools.map((tool) => tool.name);
      this.toolsOf = client;
    }
    return this.tools;
  }

  /**
   * Calls one wallet tool and returns its parsed JSON answer. `name` may list several names of one tool, newest first
   * (TOOL_NAMES): the first one this wallet lists is called.
   */
  async call(name: string | readonly string[], args: Record<string, unknown> = {}): Promise<ShinjukuResult> {
    const client = await this.start();
    const names: readonly string[] = typeof name === "string" ? [name] : name;
    const listed = await this.toolNames();
    const tool = names.find((one) => listed.includes(one));
    if (tool === undefined) {
      const version = this.options.version ?? DEFAULT_WALLET_VERSION;
      // A wallet that is not set up lists its setup tools (shinjuku_setup, wallet_status) instead of the wallet tools.
      const notSetUp = listed.includes("shinjuku_setup");
      return {
        ok: false,
        error: "shinjuku_tool_unavailable",
        detail: notSetUp
          ? `the wallet is not set up yet, so it does not offer ${names.join(" or ")}; nothing was paid or moved`
          : `this wallet version (${WALLET_PACKAGE}@${version}) does not offer ${names.join(" or ")}; nothing was paid or moved`,
        next: notSetUp
          ? `run \`${typedCommand("npx")} -y --no-audit --no-fund ${WALLET_PACKAGE}@${version} setup\` in a terminal, then call again`
          : version === DEFAULT_WALLET_VERSION
            ? `install the newest version of this plugin (${typedCommand("npm")} install solana-agent-kit-plugin-shinjuku@latest), then call again`
            : `leave \`version\` unset so the plugin runs the wallet version it was checked with (${WALLET_PACKAGE}@${DEFAULT_WALLET_VERSION}), then call again`,
      };
    }
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) if (value !== undefined) clean[key] = value;
    const result = await client.callTool({ name: tool, arguments: clean }, undefined, {
      timeout: this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
    });
    return parseToolResult(result);
  }

  /**
   * Calls pay_for_service (x402_pay on an older wallet). On wallet_refilling_retry_same_request (older wallets) it
   * waits readyInSeconds and calls again with the SAME request_id. A new call starts only if it can start before
   * payRetryMaxWaitMs (from the first call) is used up; otherwise the last answer is returned at once.
   */
  async pay(args: Record<string, unknown>): Promise<ShinjukuResult> {
    const requestId = typeof args.request_id === "string" ? args.request_id : newRequestId("pay");
    const request = { ...args, request_id: requestId };
    const maxWait = this.options.payRetryMaxWaitMs ?? DEFAULT_PAY_RETRY_MAX_WAIT_MS;
    const deadline = Date.now() + maxWait;
    for (;;) {
      const answer = await this.call(TOOL_NAMES.pay, request);
      if (answer.error !== REFILLING_CODE) return withRequestId(answer, requestId);
      const ready = Number(answer.readyInSeconds);
      const waitMs = Math.max(1000, Number.isFinite(ready) ? ready * 1000 : 30_000);
      if (Date.now() + waitMs >= deadline) return withRequestId(answer, requestId);
      await sleep(waitMs);
      // A timer can fire late: check the deadline again before the next call.
      if (Date.now() >= deadline) return withRequestId(answer, requestId);
    }
  }

  /** Stops the wallet process. A later call starts a new one. */
  async close(): Promise<void> {
    const pending = this.starting;
    this.starting = null;
    this.client = null;
    if (!pending) return;
    const client = await pending.catch(() => null);
    await client?.close();
  }
}

/** Adds request_id to an answer that does not name its request. */
export function withRequestId(answer: ShinjukuResult, requestId: string): ShinjukuResult {
  if (answer.requestId === undefined && answer.request_id === undefined) {
    return { ...answer, request_id: requestId };
  }
  return answer;
}
