import "dotenv/config";
import axios from "axios";
import { BTC_TRADER_SYSTEM_PROMPT } from "./prompt";
import { fetchBtcIndicators } from "./data/fetchIndicators";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const main = async (): Promise<void> => {
  try {
    console.log("Fetching live CoinGecko indicators...");
    const indicators = await fetchBtcIndicators();

    const messages = [
      { role: "system", content: BTC_TRADER_SYSTEM_PROMPT },
      {
        role: "user",
        content:
          "Use ONLY this real CoinGecko data to make a single strict 24h BTC prediction:\n\n" +
          JSON.stringify(indicators, null, 2),
      },
    ];

    const response = await axios.post(
      OPENROUTER_URL,
      {
        model: process.env.OPENROUTER_MODEL ?? "openai/gpt-4.1-mini",
        messages,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "http://localhost",
          "X-Title": "Real BTC 24h Bot",
        },
      }
    );

    const prediction =
      response.data?.choices?.[0]?.message?.content?.trim() ?? null;

    console.log("=== BTC 24h Prediction ===");
    if (prediction) {
      console.log(prediction);
    } else {
      console.log("No prediction received. Full response:");
      console.dir(response.data, { depth: 5 });
    }
  } catch (error) {
    console.error("Failed to produce prediction:", error);
    process.exit(1);
  }
};

void main();

