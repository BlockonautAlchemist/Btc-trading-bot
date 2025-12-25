import "dotenv/config";
import axios from "axios";
import { SOL_TRADER_SYSTEM_PROMPT } from "./prompt";
import { fetchSolIndicators } from "./data/fetchIndicators";

export interface PredictionResult {
  timestamp: string;
  rawText: string;
  direction: "LONG" | "SHORT";
  confidence: number;
  targetPrice: number;
  reasoning: string;
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const parsePrediction = (raw: string): PredictionResult => {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const findValue = (prefix: string): string | null => {
    const line = lines.find((l) => l.toLowerCase().startsWith(prefix));
    if (!line) return null;
    return line.slice(prefix.length).trim();
  };

  const directionText = findValue("direction:");
  if (!directionText || !["LONG", "SHORT"].includes(directionText)) {
    throw new Error("Could not parse Direction from model response.");
  }

  const confidenceText = findValue("confidence:");
  const confidence = confidenceText ? Number(confidenceText.replace(/[^0-9.]/g, "")) : NaN;
  if (!Number.isFinite(confidence)) {
    throw new Error("Could not parse Confidence from model response.");
  }

  const targetText = findValue("target price (24h):");
  const targetPrice = targetText ? Number(targetText.replace(/[^0-9.]/g, "")) : NaN;
  if (!Number.isFinite(targetPrice)) {
    throw new Error("Could not parse Target Price from model response.");
  }

  const reasoning = findValue("reasoning:") ?? "";

  return {
    timestamp: new Date().toISOString(),
    rawText: raw.trim(),
    direction: directionText as "LONG" | "SHORT",
    confidence,
    targetPrice,
    reasoning,
  };
};

export const runSolPrediction = async (): Promise<PredictionResult> => {
  const indicators = await fetchSolIndicators();

  const messages = [
    { role: "system", content: SOL_TRADER_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        "Use ONLY this real CoinGecko data to make a single strict 24h SOL prediction:\n\n" +
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
        "X-Title": "Real SOL 24h Bot",
      },
    }
  );

  const rawText = response.data?.choices?.[0]?.message?.content?.trim();
  if (!rawText) {
    throw new Error("No prediction text received from OpenRouter.");
  }

  return parsePrediction(rawText);
};

