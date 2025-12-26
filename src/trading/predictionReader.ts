import fs from "fs/promises";
import path from "path";
import type { PredictionResult } from "./types";

const PREDICTION_PATH = path.join(process.cwd(), "public", "prediction.json");

export const readLatestPrediction = async (): Promise<PredictionResult> => {
  const raw = await fs.readFile(PREDICTION_PATH, "utf-8");
  const parsed = JSON.parse(raw);

  if (
    !parsed ||
    typeof parsed.timestamp !== "string" ||
    (parsed.direction !== "LONG" && parsed.direction !== "SHORT") ||
    typeof parsed.confidence !== "number" ||
    typeof parsed.targetPrice !== "number" ||
    typeof parsed.reasoning !== "string"
  ) {
    throw new Error("prediction.json is missing required fields or has invalid types.");
  }

  return {
    timestamp: parsed.timestamp,
    direction: parsed.direction,
    confidence: parsed.confidence,
    targetPrice: parsed.targetPrice,
    reasoning: parsed.reasoning,
  };
};

