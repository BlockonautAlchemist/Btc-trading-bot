import "dotenv/config";
import { runBtcPrediction } from "./prediction";

const main = async (): Promise<void> => {
  try {
    const result = await runBtcPrediction();
    console.log("=== BTC 24h Prediction ===");
    console.log(result.rawText);
  } catch (error) {
    console.error("Failed to produce prediction:", error);
    process.exit(1);
  }
};

void main();

