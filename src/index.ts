import { z } from "zod";
import type { Action, Plugin, SolanaAgentKit } from "solana-agent-kit";
import {
  ShinjukuClient,
  newRequestId,
  withRequestId,
  type ShinjukuPluginOptions,
  type ShinjukuResult,
} from "./client.js";

export {
  ShinjukuClient,
  buildCommand,
  newRequestId,
  parseToolResult,
  DEFAULT_WALLET_VERSION,
  REFILLING_CODE,
  REQUEST_ID_PATTERN,
} from "./client.js";
export type { ShinjukuPluginOptions, ShinjukuResult } from "./client.js";

const atomicString = z
  .union([z.string().regex(/^[1-9][0-9]*$/), z.number().int().positive()])
  .transform((value) => String(value));
const shortRequestId = z.string().regex(/^[A-Za-z0-9_-]{1,44}$/);
const payRequestId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const httpRequest = {
  url: z.string().url().describe("The absolute https URL of the paid resource."),
  method: z.enum(["GET", "POST"]).optional().describe("HTTP method; default GET."),
  headers: z.record(z.string()).optional().describe("Extra request headers (no payment headers)."),
  body: z.string().optional().describe("Request body text (POST only)."),
};

export const balanceSchema = z.object({});
export const statusSchema = z.object({});
export const receiptsSchema = z.object({
  limit: z.number().int().min(1).max(200).optional().describe("How many receipts; default 20."),
});
export const previewSchema = z.object(httpRequest);
export const paySchema = z.object({
  ...httpRequest,
  request_id: payRequestId.optional().describe("Stable name for this payment. Same id never pays twice."),
  max_payment_atomic: atomicString.optional().describe("Most this call may pay (price plus fee), atomic units."),
});
export const shieldSchema = z.object({
  amount_atomic: atomicString.describe("USDC to shield, atomic units (1000000 = 1 USDC)."),
  request_id: shortRequestId.optional().describe("Stable name for this deposit. Pass it again to read the stage."),
});
export const unshieldSchema = z.object({
  amount_atomic: atomicString.describe("USDC to send, atomic units (1000000 = 1 USDC)."),
  to: z.string().min(32).max(44).describe("Receiving public Solana address (base58)."),
  request_id: shortRequestId.optional().describe("Stable name for this send. Pass it again to read the stage."),
});

export type PayInput = z.input<typeof paySchema>;
export type PreviewInput = z.input<typeof previewSchema>;
export type ShieldInput = z.input<typeof shieldSchema>;
export type UnshieldInput = z.input<typeof unshieldSchema>;
export type ReceiptsInput = z.input<typeof receiptsSchema>;

function action(
  name: string,
  similes: string[],
  description: string,
  schema: z.ZodTypeAny,
  example: { input: Record<string, unknown>; output: Record<string, unknown>; explanation: string },
  run: (input: Record<string, unknown>) => Promise<ShinjukuResult>,
): Action {
  return {
    name,
    similes,
    description,
    examples: [[example]],
    schema,
    handler: async (_agent: SolanaAgentKit, input: Record<string, any>) => run(schema.parse(input)),
  };
}

/**
 * Creates the Shinjuku plugin. Each call makes one plugin instance with one shared
 * wallet MCP process, started on the first call.
 */
export function ShinjukuPlugin(options: ShinjukuPluginOptions = {}) {
  const wallet = new ShinjukuClient(options);

  const shield = async (input: Record<string, unknown>) => {
    const parsed = shieldSchema.parse(input);
    const requestId = parsed.request_id ?? newRequestId("shield");
    return withRequestId(await wallet.call("wallet_shield", { ...parsed, request_id: requestId }), requestId);
  };
  const unshield = async (input: Record<string, unknown>) => {
    const parsed = unshieldSchema.parse(input);
    const requestId = parsed.request_id ?? newRequestId("send");
    return withRequestId(await wallet.call("wallet_unshield", { ...parsed, request_id: requestId }), requestId);
  };
  const pay = async (input: Record<string, unknown>) => wallet.pay(paySchema.parse(input));
  const preview = async (input: Record<string, unknown>) => wallet.call("x402_preview", previewSchema.parse(input));
  const receipts = async (input: Record<string, unknown>) => wallet.call("wallet_receipts", receiptsSchema.parse(input));
  const balance = async () => wallet.call("wallet_balance");
  const status = async (): Promise<ShinjukuResult> => {
    const tools = await wallet.toolNames();
    // wallet_status exists only while the wallet is not set up; a set-up server offers the wallet tools instead.
    if (tools.includes("wallet_status")) return wallet.call("wallet_status");
    return { ok: true, setUp: true, tools };
  };

  const methods = {
    shinjukuBalance: (_agent?: SolanaAgentKit) => balance(),
    shinjukuStatus: (_agent?: SolanaAgentKit) => status(),
    shinjukuReceipts: (_agent?: SolanaAgentKit, input: ReceiptsInput = {}) => receipts(input),
    shinjukuPreview: (_agent: SolanaAgentKit | undefined, input: PreviewInput) => preview(input),
    shinjukuPay: (_agent: SolanaAgentKit | undefined, input: PayInput) => pay(input),
    shinjukuShield: (_agent: SolanaAgentKit | undefined, input: ShieldInput) => shield(input),
    shinjukuUnshield: (_agent: SolanaAgentKit | undefined, input: UnshieldInput) => unshield(input),
    shinjukuClose: () => wallet.close(),
  };

  const actions: Action[] = [
    action(
      "SHINJUKU_BALANCE",
      ["private balance", "shielded balance", "shinjuku balance", "x402 wallet balance"],
      "Read the Shinjuku private wallet balance: the one balance x402 payments spend, the shielded part, and plain USDC on the wallet's own key. Free.",
      balanceSchema,
      { input: {}, output: { ok: true, balanceAtomic: "1000000" }, explanation: "Read the private USDC balance" },
      () => balance(),
    ),
    action(
      "SHINJUKU_STATUS",
      ["private wallet status", "is the shinjuku wallet set up", "shinjuku status"],
      "Say whether the Shinjuku private wallet is set up and what to do next. Free.",
      statusSchema,
      { input: {}, output: { ok: false, error: "wallet_not_set_up" }, explanation: "Check the wallet before the first payment" },
      () => status(),
    ),
    action(
      "SHINJUKU_RECEIPTS",
      ["private payment receipts", "x402 receipts", "what did I pay"],
      "List the most recent paid x402 receipts: host, amount, transaction, time. Free.",
      receiptsSchema,
      { input: { limit: 5 }, output: { ok: true, receipts: [] }, explanation: "Show the last 5 receipts" },
      receipts,
    ),
    action(
      "SHINJUKU_X402_PREVIEW",
      ["price of this url", "x402 preview", "how much does this api cost"],
      "Make one unpaid request to an x402 URL and return the seller's price, the fee, the total and whether the caps allow it. Pays nothing.",
      previewSchema,
      { input: { url: "https://seller.example/report" }, output: { ok: true, paymentRequired: true }, explanation: "Look at the price before paying" },
      preview,
    ),
    action(
      "SHINJUKU_X402_PAY",
      ["pay this url privately", "private x402 payment", "fetch paid url", "pay for api call"],
      "Pay an x402 URL from the private Shinjuku balance (amount and payer hidden on chain) and return the seller's answer. A retry with the same request_id never pays twice. Refills are waited out automatically.",
      paySchema,
      { input: { url: "https://seller.example/report", max_payment_atomic: "20000" }, output: { ok: true, paid: true }, explanation: "Pay at most 0.02 USDC for the report" },
      pay,
    ),
    action(
      "SHINJUKU_SHIELD",
      ["shield usdc", "make usdc private", "deposit to private balance"],
      "Move USDC from the wallet's own Solana key into the shielded balance. Takes minutes: call again with the same request_id to read the stage. Never starts a second deposit for one request_id.",
      shieldSchema,
      { input: { amount_atomic: "1000000", request_id: "shield-1" }, output: { ok: true, stage: "submitting" }, explanation: "Shield 1 USDC" },
      shield,
    ),
    action(
      "SHINJUKU_UNSHIELD",
      ["send usdc privately", "withdraw private usdc", "unshield"],
      "Send shielded USDC as plain USDC to a public Solana address. The chain does not show which wallet paid. Takes minutes: call again with the same request_id to read the stage.",
      unshieldSchema,
      { input: { amount_atomic: "500000", to: "<base58 address>", request_id: "send-1" }, output: { ok: true, stage: "confirming" }, explanation: "Send 0.5 USDC privately" },
      unshield,
    ),
  ];

  const plugin = {
    name: "shinjuku",
    methods,
    actions,
    initialize(_agent: SolanaAgentKit): void {
      // The wallet process starts on the first call.
    },
    /** Stops the wallet process of this plugin instance. */
    close: () => wallet.close(),
  } satisfies Plugin & { close: () => Promise<void> };
  return plugin;
}

export default ShinjukuPlugin;
