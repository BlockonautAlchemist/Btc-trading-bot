import "dotenv/config";
import { runSolPrediction } from "./prediction";

const main = async (): Promise<void> => {
  try {
    const result = await runSolPrediction();
    console.log("=== SOL 24h Prediction ===");
    console.log(result.rawText);
  } catch (error) {
    console.error("Failed to produce prediction:", error);
    process.exit(1);
  }
};

void main();

