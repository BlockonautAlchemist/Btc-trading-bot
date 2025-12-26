import { Connection, Keypair } from "@solana/web3.js";
import { config } from "../config";

export const createConnection = (): Connection => {
  return new Connection(config.rpcUrl, "confirmed");
};

export const loadBotWallet = (): Keypair => {
  let secret: unknown;
  try {
    secret = JSON.parse(config.botSecretKey);
  } catch (error) {
    throw new Error("BOT_WALLET_SECRET_KEY is not valid JSON.");
  }

  if (!Array.isArray(secret) || secret.length !== 64) {
    throw new Error("BOT_WALLET_SECRET_KEY must be a JSON array of 64 numbers.");
  }

  const nums = secret.map((n) => Number(n));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error("BOT_WALLET_SECRET_KEY must contain byte values (0-255).");
  }

  return Keypair.fromSecretKey(Uint8Array.from(nums));
};

