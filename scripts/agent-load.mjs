// Loads the plugin into a real SolanaAgentKit with a throwaway in-memory key.
// It makes no RPC call and starts no wallet process.
import { Keypair } from "@solana/web3.js";
import { SolanaAgentKit, KeypairWallet } from "solana-agent-kit";
import { ShinjukuPlugin } from "../dist/index.js";

const rpc = "https://api.mainnet-beta.solana.com";
const plugin = ShinjukuPlugin();
const agent = new SolanaAgentKit(new KeypairWallet(Keypair.generate(), rpc), rpc, {}).use(plugin);
console.log("agent.actions:", agent.actions.map((a) => a.name).join(", "));
console.log("agent.methods:", Object.keys(agent.methods).join(", "));
await plugin.close();
