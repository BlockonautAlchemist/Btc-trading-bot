import { runSolPerpsBotOnce } from "./bot";

const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

async function loop() {
  while (true) {
    console.log(`[Loop] Running bot tick @ ${new Date().toISOString()}`);

    try {
      await runSolPerpsBotOnce();
    } catch (err) {
      console.error("[Loop] Error in runSolPerpsBotOnce:", err);
    }

    console.log(
      `[Loop] Sleeping ${(INTERVAL_MS / 1000 / 60).toFixed(0)} minutes...\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

loop().catch((err) => {
  console.error("[Loop] Fatal error:", err);
  process.exit(1);
});

