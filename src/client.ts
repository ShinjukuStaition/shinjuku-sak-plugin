import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Default `shinjuku-shielded` version: the npm dist-tag `latest`. A new wallet release reaches
 * the plugin at the next start, without a new plugin version. Set `version` to pin one.
 */
export const DEFAULT_WALLET_VERSION = "latest";

/** The error code that x402_pay answers while the wallet refills. */
export const REFILLING_CODE = "wallet_refilling_retry_same_request";

/** request_id format this plugin generates and accepts for shield / unshield. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,44}$/;

export interface ShinjukuPluginOptions {
  /** Version or dist-tag of `shinjuku-shielded` to run with npx. Default "latest". */
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
  /** Most total wait for x402_pay refill retries, in ms. Default 15 minutes. */
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
  const args = ["-y", `shinjuku-shielded@${version}`, "mcp"];
  if (options.maxPayment !== undefined) args.push("--max-payment", atomic("maxPayment", options.maxPayment));
  if (options.maxSession !== undefined) args.push("--max-session", atomic("maxSession", options.maxSession));
  if (options.maxUnshield !== undefined) args.push("--max-unshield", atomic("maxUnshield", options.maxUnshield));
  for (const address of options.unshieldTo ?? []) args.push("--unshield-to", address);
  if (options.tor) args.push("--tor");
  args.push(...(options.extraArgs ?? []));
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
    const client = new Client({ name: "solana-agent-kit-plugin-shinjuku", version: "0.1.1" });
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

  /** Calls one wallet tool and returns its parsed JSON answer. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<ShinjukuResult> {
    const client = await this.start();
    if (!(await this.toolNames()).includes(name)) {
      return {
        ok: false,
        error: "shinjuku_tool_unavailable",
        detail: `the wallet server does not offer ${name} now; nothing was paid or moved`,
        next: "if the wallet is not set up, run `npx -y shinjuku-shielded setup` in a terminal, then call again",
      };
    }
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) if (value !== undefined) clean[key] = value;
    const result = await client.callTool({ name, arguments: clean }, undefined, {
      timeout: this.options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
    });
    return parseToolResult(result);
  }

  /**
   * Calls x402_pay. On wallet_refilling_retry_same_request it waits readyInSeconds and
   * calls again with the SAME request_id, until payRetryMaxWaitMs is used up.
   */
  async pay(args: Record<string, unknown>): Promise<ShinjukuResult> {
    const requestId = typeof args.request_id === "string" ? args.request_id : newRequestId("pay");
    const request = { ...args, request_id: requestId };
    const maxWait = this.options.payRetryMaxWaitMs ?? DEFAULT_PAY_RETRY_MAX_WAIT_MS;
    const deadline = Date.now() + maxWait;
    for (;;) {
      const answer = await this.call("x402_pay", request);
      if (answer.error !== REFILLING_CODE) return withRequestId(answer, requestId);
      const ready = Number(answer.readyInSeconds);
      const waitMs = Math.max(1000, Number.isFinite(ready) ? ready * 1000 : 30_000);
      const left = deadline - Date.now();
      if (left <= 0) return withRequestId(answer, requestId);
      await sleep(Math.min(waitMs, left));
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
