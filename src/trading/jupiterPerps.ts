import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import { createSolanaRpc } from "@solana/kit";
import axios from "axios";
import type { TradeIntent } from "./types";
import { config, jupPerpsEnv } from "../config";

export async function getPerpsClient(connection: Connection) {
  // The kit client is used for data fetch helpers (pools/custodies).
  const rpcEndpoint =
    (connection as unknown as { rpcEndpoint?: string }).rpcEndpoint ??
    (connection as unknown as { _rpcEndpoint?: string })._rpcEndpoint ??
    config.rpcUrl;
  return createSolanaRpc(rpcEndpoint);
}

export interface PerpsMarketConfig {
  pool: PublicKey;
  custody: PublicKey;
  collateralCustody: PublicKey;
  programId: PublicKey;
}

type Side = "long" | "short";

const DEVNET_FALLBACKS = {
  programId: null as PublicKey | null,
  solLong: {
    pool: null as PublicKey | null,
    custody: null as PublicKey | null,
    collateralCustody: null as PublicKey | null,
  },
  solShort: {
    pool: null as PublicKey | null,
    custody: null as PublicKey | null,
    collateralCustody: null as PublicKey | null,
  },
};

const DEVNET_PERPS_ENDPOINT =
  "https://perps-api.jup.ag/v1/config?env=devnet&symbol=SOL";
const PERPS_API_BASE = "https://perps-api.jup.ag";

async function fetchDevnetSolConfig(): Promise<PerpsMarketConfig | null> {
  try {
    const { data } = await axios.get(DEVNET_PERPS_ENDPOINT, {
      timeout: 5_000,
      validateStatus: () => true,
    });

    const pool = data?.poolAddress as string | undefined;
    const custody = data?.custodyAddress as string | undefined;
    const collateralCustody = data?.collateralCustodyAddress as
      | string
      | undefined;
    const programId = data?.programId as string | undefined;

    if (pool && custody && collateralCustody && programId) {
      return {
        pool: new PublicKey(pool),
        custody: new PublicKey(custody),
        collateralCustody: new PublicKey(collateralCustody),
        programId: new PublicKey(programId),
      };
    }

    console.log(
      "Jupiter Perps config endpoint did not return full SOL config. Received keys:",
      { pool, custody, collateralCustody, programId }
    );
  } catch (error) {
    console.log("Failed to fetch Jupiter Perps devnet config; will fall back:", error);
  }

  if (DEVNET_FALLBACKS.programId && DEVNET_FALLBACKS.solLong.pool) {
    console.log("Using static devnet fallback addresses for SOL perps.");
    return {
      pool: DEVNET_FALLBACKS.solLong.pool,
      custody: DEVNET_FALLBACKS.solLong.custody!,
      collateralCustody: DEVNET_FALLBACKS.solLong.collateralCustody!,
      programId: DEVNET_FALLBACKS.programId!,
    };
  }

  return null;
}

export async function getSolPerpsMarketConfig(
  botPubkey: PublicKey,
  side: Side
): Promise<PerpsMarketConfig | null> {
  if (jupPerpsEnv !== "devnet") {
    return null;
  }

  // Shorting SOL on devnet may not be supported if USDC custody is missing.
  if (side === "short") {
    console.log("SHORT SOL with USDC collateral is not yet supported on devnet; skipping.");
    return null;
  }

  const config = await fetchDevnetSolConfig();
  if (!config) {
    console.log("Could not resolve SOL perps market config on devnet; skipping trade.");
    return null;
  }

  return config;
}

interface BuildParams {
  connection: Connection;
  bot: Keypair;
  intent: TradeIntent;
  market: PerpsMarketConfig;
}

export async function buildAndSendPerpsTx(
  params: BuildParams
): Promise<string | null> {
  const { connection, bot, intent, market: _market } = params;

  try {
    if (intent.action === "DO_NOTHING") {
      return null;
    }

    if (jupPerpsEnv !== "devnet") {
      console.log(
        "Perps trades are in DRY RUN because JUP_PERPS_ENV is not devnet."
      );
      return null;
    }

    const side: Side = intent.action === "OPEN_LONG" ? "long" : "short";

    // Fetch collateral balance
    const balanceLamports = await connection.getBalance(bot.publicKey);
    const balanceSol = balanceLamports / 1_000_000_000;
    if (balanceSol <= 0) {
      console.log("Bot SOL balance is zero; cannot fund perps trade.");
      return null;
    }

    // Simple notional sizing: cap at $10 equivalent or riskFraction of balance.
    const assumedSolPriceUsd = 100; // devnet approximation
    const balanceUsd = balanceSol * assumedSolPriceUsd;
    const targetUsd = Math.max(
      0,
      Math.min(balanceUsd * intent.riskFraction, 10)
    );

    if (targetUsd < 1) {
      console.log(
        `Not enough balance for minimum notional (computed ~$${targetUsd.toFixed(
          2
        )}); skipping.`
      );
      return null;
    }

    console.log(
      `Would open/increase ${side.toUpperCase()} SOL position for approx $${targetUsd.toFixed(
        2
      )} notional on devnet.`
    );

    // Build transaction via Perps API (returns a ready-to-sign serialized tx).
    const sizeUsdDelta = Math.max(1, Math.floor(targetUsd * 1_000_000)); // 6dp
    const inputTokenAmountLamports = Math.max(
      1,
      Math.floor((targetUsd / assumedSolPriceUsd) * 1_000_000_000)
    );

    const payload = {
      asset: "SOL",
      side,
      inputToken: "SOL",
      inputTokenAmount: String(inputTokenAmountLamports),
      sizeUsdDelta: String(sizeUsdDelta),
      maxSlippageBps: "200",
      feeToken: "USDC",
      feeTokenAmount: "0",
      feeReceiver: bot.publicKey.toBase58(),
      walletAddress: bot.publicKey.toBase58(),
      transactionType: "legacy",
      env: "devnet",
    };

    const resp = await axios.post(`${PERPS_API_BASE}/positions/increase`, payload, {
      timeout: 10_000,
      validateStatus: () => true,
    });

    if (!resp.data || resp.data.error) {
      console.log("Perps API increase response error:", resp.data ?? resp.status);
      return null;
    }

    const { serializedTxBase64 } = resp.data;
    if (!serializedTxBase64) {
      console.log("Perps API did not return a serialized transaction; skipping.");
      return null;
    }

    const txBytes = Buffer.from(serializedTxBase64, "base64");
    const tx = VersionedTransaction.deserialize(txBytes);
    tx.sign([bot]);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    console.log("Sent perps tx via API; signature:", sig);
    return sig;
  } catch (error) {
    console.error("Failed to build/send perps transaction:", error);
    return null;
  }
}

