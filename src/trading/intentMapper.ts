import type { PredictionResult, TradeIntent } from "./types";

export const mapPredictionToTradeIntent = (
  pred: PredictionResult
): TradeIntent => {
  if (pred.confidence < 55) {
    return { action: "DO_NOTHING", riskFraction: 0, note: pred.reasoning };
  }

  if (pred.direction === "LONG") {
    return { action: "OPEN_LONG", riskFraction: 0.3, note: pred.reasoning };
  }

  if (pred.direction === "SHORT") {
    return { action: "OPEN_SHORT", riskFraction: 0.3, note: pred.reasoning };
  }

  return { action: "DO_NOTHING", riskFraction: 0, note: pred.reasoning };
};

