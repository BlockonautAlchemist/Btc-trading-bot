import { createConnection, loadBotWallet } from "./solanaClient";
import { readLatestPrediction } from "./predictionReader";
import { mapPredictionToTradeIntent } from "./intentMapper";
import type { TradeIntent } from "./types";

async function executeTrade(intent: TradeIntent) {
  // TODO: Implement Jupiter Perps interaction here.
  // For now:
  // - log intent
  // - log bot wallet public key
  // - fetch and log current SOL balance

  const connection = createConnection();
  const bot = loadBotWallet();

  console.log("Bot wallet:", bot.publicKey.toBase58());
  console.log("Trade intent:", intent);

  const balanceLamports = await connection.getBalance(bot.publicKey);
  const balanceSol = balanceLamports / 1_000_000_000;
  console.log("Current SOL balance:", balanceSol, "SOL");

  // Future: OPEN_LONG / OPEN_SHORT / CLOSE_POSITION with Jupiter Perps.
}

export async function runSolPerpsBotOnce() {
  try {
    const pred = await readLatestPrediction();
    console.log("Loaded prediction:", pred);

    const intent = mapPredictionToTradeIntent(pred);
    console.log("Mapped trade intent:", intent);

    if (intent.action === "DO_NOTHING") {
      console.log("Decision: DO_NOTHING (confidence too low or neutral).");
      return;
    }

    await executeTrade(intent);
  } catch (error) {
    console.error("Bot run failed:", error);
    throw error;
  }
}

