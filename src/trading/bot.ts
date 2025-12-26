import { createConnection, loadBotWallet } from "./solanaClient";
import { readLatestPrediction } from "./predictionReader";
import { mapPredictionToTradeIntent } from "./intentMapper";
import type { TradeIntent } from "./types";
import {
  buildAndSendPerpsTx,
  getSolPerpsMarketConfig,
} from "./jupiterPerps";
import { jupPerpsEnv } from "../config";

async function executeTrade(intent: TradeIntent) {
  const connection = createConnection();
  const bot = loadBotWallet();

  console.log("Bot wallet:", bot.publicKey.toBase58());
  console.log("Trade intent:", intent);

  if (intent.action === "DO_NOTHING") {
    console.log("Decision: DO_NOTHING, skipping perps trade.");
    return;
  }

  const side = intent.action === "OPEN_LONG" ? "long" : "short";

  const market = await getSolPerpsMarketConfig(bot.publicKey, side);
  if (!market) {
    console.log("No valid SOL perps market config; skipping trade.");
    return;
  }

  const txSig = await buildAndSendPerpsTx({
    connection,
    bot,
    intent,
    market,
  });

  if (txSig) {
    console.log("Perps trade sent. Tx signature:", txSig);
  } else {
    console.log("Perps trade not sent (insufficient data or balance).");
  }
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

