# solana-agent-kit-plugin-shinjuku

A [Solana Agent Kit](https://github.com/sendaifun/solana-agent-kit) v2 plugin for the Shinjuku private x402 wallet.

Your agent pays x402 APIs on Solana from a private USDC balance that only your keys can move. The chain does not show which wallet paid: your wallet pays Shinjuku privately, and Shinjuku pays the seller from its own funds. The seller's payment is a normal USDC payment, so its amount and the seller show on chain. Adding USDC to the private balance and sending it out to an address show their amounts too.

The plugin does not hold keys and does not make payments by itself. It starts the official wallet, the npm package [`shinjuku-shield`](https://www.npmjs.com/package/shinjuku-shield), as a local MCP stdio server. It then calls the wallet's tools. Full wallet docs: [shinjuku-shield](https://github.com/ShinjukuStaition/shinjuku-shield).

## Install

```sh
npm install solana-agent-kit solana-agent-kit-plugin-shinjuku
```

Node 22.21 or later, or Node 24 or later (the wallet needs it). `npx` must be on the PATH. The wallet version this plugin runs is `shinjuku-shield` 0.3.218; its [README](https://github.com/ShinjukuStaition/shinjuku-shield) names the systems it runs on.

## One-time setup (in a terminal)

Set up the wallet once, in a real terminal:

```sh
npx -y --no-audit --no-fund shinjuku-shield@0.3.218 setup
```

This plugin needs the wallet set up before its first call: the plugin itself cannot run setup. (The wallet's own setup also has a no-question form, `setup --yes`, and an MCP client that can show the wallet's setup question can run it; see the wallet README.) Until setup is done, `SHINJUKU_STATUS` answers `setUp: false`. The other actions answer `shinjuku_tool_unavailable` with that setup line, and call nothing.

To use a different wallet folder, set `SHIELDED_WALLET_HOME` for the setup. Give the same folder to the plugin as `walletHome`.

## Usage

```ts
import { SolanaAgentKit, KeypairWallet } from "solana-agent-kit";
import { ShinjukuPlugin } from "solana-agent-kit-plugin-shinjuku";

const shinjuku = ShinjukuPlugin({
  maxPayment: 50_000,   // at most 0.05 USDC for one payment
  maxSession: 1_000_000, // at most 1 USDC for all payments of this process
});

const agent = new SolanaAgentKit(wallet, rpcUrl, {}).use(shinjuku);

const balance = await agent.methods.shinjukuBalance();
const price = await agent.methods.shinjukuPreview(agent, { url: "https://seller.example/report" });
const answer = await agent.methods.shinjukuPay(agent, {
  url: "https://seller.example/report",
  max_payment_atomic: "20000",
});

await shinjuku.close(); // stop the wallet process
```

The plugin starts ONE wallet process per plugin instance, on the first call. `close()` (or `agent.methods.shinjukuClose()`) stops it. A later call starts it again.

The balance, receipts, preview, pay, shield and unshield methods and actions return the wallet's parsed JSON answer (or the plugin's own `shinjuku_tool_unavailable` answer when the wallet does not offer that tool). `shinjukuStatus` returns the wallet's `wallet_status` answer before setup, and a plugin-made object after it. `shinjukuClose` returns nothing. An input that does not match the action's zod schema throws an error before the wallet is called. Amounts are atomic USDC units: `1000000` = 1 USDC.

A payment to an outside seller goes through Shinjuku: your wallet pays Shinjuku privately, and Shinjuku pays the seller. The answer then holds `shinjukuTransaction` (your private payment) and `transaction` (the seller's settlement, when the seller returns one).

## Wallet version

By default the plugin runs `npx -y --no-audit --no-fund shinjuku-shield@0.3.218 mcp`: the exact stable wallet release this plugin version was checked with. A new stable wallet release comes with a new plugin version. Set up the wallet with the same version (the setup line above).

To run another wallet version, set `version` to that `shinjuku-shield` version or dist-tag. Wallets newer than 0.3.131 name two tools differently (`pay_for_service` for `x402_pay`, `check_price` for `x402_preview`); the plugin calls the name the wallet lists, so both work.

The workflow `daily-check.yml` has no schedule: a maintainer starts it by hand. It sets up an empty throwaway wallet and checks that each wallet tool that the plugin calls exists, that the tool's input lists every argument name the plugin sends, and that the plugin sends every argument the tool requires. It does not check argument types or limits, and it does not call the paying tools; `wallet_status` (a setup-time tool) is not in its list. It calls only `shinjukuStatus` and `shinjukuBalance` and moves no money. On a difference, it opens an issue in this repository.

## Options

| Option | Wallet flag | Meaning |
| --- | --- | --- |
| `version` | | `shinjuku-shield` version or dist-tag to run. Default `0.3.218` (the stable release). |
| `walletHome` | env `SHIELDED_WALLET_HOME` | The wallet folder. |
| `maxPayment` | `--max-payment` | Most one payment may cost. |
| `maxSession` | `--max-session` | Most all payments of one wallet process may cost. |
| `maxUnshield` | `--max-unshield` | Most one unshield may send. |
| `unshieldTo` | `--unshield-to` (repeated) | Addresses that unshield may send to at once (base58 Solana addresses only). |
| `tor` | `--tor` | Send the wallet's traffic through Tor. |
| `extraArgs` | | More wallet arguments, added last: flags (`--name`) and values of letters, digits and `. _ : / \ @ + = , -` only (no spaces or shell characters; on Windows the wallet starts through `cmd`). |
| `payRetryMaxWaitMs` | | Most total wait for refill retries. Default 15 minutes. |
| `callTimeoutMs` | | Timeout for one tool call. Default 5 minutes. |

## Actions

| Action | Method | Wallet tool | Input | Costs money |
| --- | --- | --- | --- | --- |
| `SHINJUKU_STATUS` | `shinjukuStatus` | `wallet_status` before setup; after setup the list of wallet tools (`shinjuku_status_unknown` when the wallet lists neither `wallet_status` nor `wallet_balance`) | none | no |
| `SHINJUKU_BALANCE` | `shinjukuBalance` | `wallet_balance` | none | no |
| `SHINJUKU_RECEIPTS` | `shinjukuReceipts` | `wallet_receipts` | `limit` (1-200) | no |
| `SHINJUKU_X402_PREVIEW` | `shinjukuPreview` | `check_price` (`x402_preview` on 0.3.131) | `url`, `method`, `headers`, `body` | no |
| `SHINJUKU_X402_PAY` | `shinjukuPay` | `pay_for_service` (`x402_pay` on 0.3.131) | `url`, `method`, `headers`, `body`, `request_id`, `max_payment_atomic` | yes |
| `SHINJUKU_SHIELD` | `shinjukuShield` | `wallet_shield` | `amount_atomic`, `request_id` | moves USDC |
| `SHINJUKU_UNSHIELD` | `shinjukuUnshield` | `wallet_unshield` | `amount_atomic`, `to`, `request_id` | moves USDC |

Methods take the agent first, then the input, as in other Solana Agent Kit plugins. Every action has a zod schema.

When you give no `request_id`, the plugin makes one (it matches `^[A-Za-z0-9_-]{1,44}$`). The answer then carries it as `request_id`. Keep it. Shield and unshield take minutes. Call again with the same `request_id` to read the stage.

## Caps

The wallet enforces the caps, not the plugin. `maxPayment` and `maxSession` are the launch caps. `max_payment_atomic` on one payment can only lower the cap. It can never raise it. It must cover the price plus the fee. The price check (`shinjukuPreview`) shows `priceAtomic`, `feeAtomic` and `totalAtomic`.

Unshield to an address that is not in `unshieldTo` needs a confirmation in an MCP client. This plugin cannot show that prompt, so the wallet refuses such an address. Put the addresses that you trust in `unshieldTo`.

## Retry behaviour

An older wallet (not 0.3.131) can answer a payment with `wallet_refilling_retry_same_request` and `readyInSeconds`. This is not a payment. The wallet moves value inside your private balance first.

`shinjukuPay` then waits `readyInSeconds` and calls again with the SAME `request_id`. It starts a new call only when that call can start within `payRetryMaxWaitMs` (default 15 minutes) of the first one; otherwise it returns the last answer at once. A call that has started can run longer, up to `callTimeoutMs`.

A repeat with the same `request_id` never pays twice. After a payment it returns the same receipt.

## Other frameworks

Solana Agent Kit turns its actions into tools for other frameworks: `createVercelAITools`, `createLangchainTools` and `createOpenAITools` (exported by `solana-agent-kit`). The Shinjuku actions come along with the other actions.

To use the wallet in the Vercel AI SDK without Solana Agent Kit, connect the MCP server directly: see [examples/vercel-ai-sdk.md](https://github.com/ShinjukuStaition/shinjuku-shield/blob/main/examples/vercel-ai-sdk.md).

## Live proof

On 2026-10-13 a real `SolanaAgentKit` agent with this plugin (wallet `shinjuku-shielded@0.3.12`) paid a public satellite-imagery seller 0.013 USDC (+0.001 fee) on Solana mainnet through `SHINJUKU_X402_PAY`, and got the JPEG back in 36 s. That run used an older wallet (0.3.12); no live run with 0.3.218 is on record yet:

- Private payment from the wallet to Shinjuku (pool transaction): [`66BgMYrD…Nxex6E`](https://solscan.io/tx/66BgMYrD6XecUcy3EVo1UmkrAWxDdidC4qLUDeLuzsjsm3KFNhYoNhdLW3QTQkgPJmWsTmjjP7VcQ8StFtNxex6E)
- Shinjuku pays the seller (the chain shows Shinjuku, not the wallet): [`4ecLga5y…9qudu`](https://solscan.io/tx/4ecLga5ypMivF8sqiUUb4Tfm7yQxWpp8dLcWSPe3tSfMmvsbFGsRHosr1QS58z68UsWCTdztDVvPBv5ZT4z9qudu)

## Windows

On Windows the plugin starts the wallet with `cmd /c npx ...`, because `npx` is a `.cmd` file there. On other systems it runs `npx` directly.

## Local check

```sh
npm run build
node scripts/check.mjs <wallet-folder>
```

The check calls only `shinjukuStatus` and `shinjukuBalance`. Both are free. It masks long base58 strings in the output.

```sh
node scripts/interface-check.mjs <wallet-folder> [wallet-version]
```

The interface check also compares the wallet's tool list with the argument names the plugin sends (names and required fields only, not types). The `daily-check.yml` workflow (started by hand) runs it.

## Interface source

The plugin follows the `Plugin` and `Action` types in `solana-agent-kit@2.0.10`, file `dist/index.d.ts`:

```ts
interface Plugin { name: string; methods: Record<string, any>; actions: Action[]; initialize(agent: SolanaAgentKit): void; }
interface Action { name: string; similes: string[]; description: string; examples: ActionExample[][]; schema: z.ZodType<any>; handler: Handler; }
type Handler = (agent: SolanaAgentKit, input: Record<string, any>) => Promise<Record<string, any>>;
```

`SolanaAgentKit.use(plugin)` calls `initialize`, adds `methods` to `agent.methods`, and adds `actions` to `agent.actions`. The layout (one `methods` object, one `actions` array, a no-op `initialize`, upper-case action names) mirrors the community plugin `solana-agent-kit-plugin-madeonsol@2.4.2` (`dist/index.js`, `dist/actions/me.js`).

## License

MIT
