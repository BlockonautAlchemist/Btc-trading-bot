export type Direction = "LONG" | "SHORT";

export interface PredictionResult {
  timestamp: string;
  direction: Direction;
  confidence: number;
  targetPrice: number;
  reasoning: string;
}

export type TradeActionType =
  | "OPEN_LONG"
  | "OPEN_SHORT"
  | "CLOSE_POSITION"
  | "DO_NOTHING";

export interface TradeIntent {
  action: TradeActionType;
  riskFraction: number;
  note?: string;
}

