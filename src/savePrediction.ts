import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { runBtcPrediction } from "./prediction";

const OUTPUT_DIR = path.join(process.cwd(), "public");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "prediction.json");

const main = async (): Promise<void> => {
  try {
    const result = await runBtcPrediction();

    const payload = {
      timestamp: result.timestamp,
      direction: result.direction,
      confidence: result.confidence,
      targetPrice: result.targetPrice,
      reasoning: result.reasoning,
    };

    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(payload, null, 2), "utf-8");

    console.log(`Saved latest prediction to ${path.relative(process.cwd(), OUTPUT_FILE)}`);
  } catch (error) {
    console.error("Failed to save prediction:", error);
    process.exit(1);
  }
};

void main();

