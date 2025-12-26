import "dotenv/config";
import { runSolPerpsBotOnce } from "./bot";

const main = async (): Promise<void> => {
  try {
    await runSolPerpsBotOnce();
  } catch (error) {
    console.error("Bot execution failed:", error);
    process.exit(1);
  }
};

void main();

