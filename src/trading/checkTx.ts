import { Connection } from "@solana/web3.js";
import "dotenv/config";

const rpcUrl = process.env.SOLANA_RPC_URL;

if (!rpcUrl) {
  console.error("Error: SOLANA_RPC_URL is missing. Set a devnet RPC and retry.");
  process.exit(1);
}

const endpoint = rpcUrl;

// TODO: paste the devnet transaction signature to verify.
const signature = "rQzkpbJ4TWzLN7BBCdpr2fpfboKCWmq1BnSCaCdgg3BKtBt6cNsex2ebwh7RmgSPEviQ1gNqF4nDtwgcomcbSoU";

async function main() {
  try {
    const connection = new Connection(endpoint, "confirmed");

    console.log("Checking transaction on devnet RPC:", endpoint);
    console.log("Signature:", signature);

    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });

    if (!tx) {
      console.log("⚠️ Transaction NOT FOUND on devnet RPC.");
      console.log("   - Wrong cluster?");
      console.log("   - Devnet reset?");
      console.log("   - Transaction never finalized?");
      return;
    }

    const logs = tx.meta?.logMessages ?? [];
    console.log("✅ Transaction FOUND");
    console.log("Slot:", tx.slot);
    console.log("Error:", tx.meta?.err ?? "None");
    console.log("First 10 log messages:");
    logs.slice(0, 10).forEach((l, idx) => console.log(`  [${idx}] ${l}`));
  } catch (error) {
    console.error("Fatal error", error);
  }
}

void main();

/**
 * How to run:
 *   npx ts-node src/trading/checkTx.ts
 *
 * Reminder:
 *   Ensure SOLANA_RPC_URL points to devnet.
 */

