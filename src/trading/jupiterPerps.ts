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
const PERPS_API_BASE = "https://perps-api.jup.ag/v1";

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

  // TESTING: For API-based approach, we don't actually need the market config.
  // The API handles account derivation internally. Return a dummy config.
  // if (side === "short") {
  //   console.log("SHORT SOL with USDC collateral is not yet supported on devnet; skipping.");
  //   return null;
  // }

  // Return dummy config - API will handle the actual account resolution
  return {
    pool: PublicKey.default,
    custody: PublicKey.default,
    collateralCustody: PublicKey.default,
    programId: PublicKey.default,
  };
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

    // For shorts, use USDC as collateral; for longs, use SOL
    const isShort = side === "short";
    const inputToken = isShort ? "USDC" : "SOL";

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
      `TESTING: Attempting to open/increase ${side.toUpperCase()} SOL position for approx $${targetUsd.toFixed(
        2
      )} notional on devnet using ${inputToken} as collateral.`
    );

    // API requirements:
    // - Minimum collateral: $10 for new positions
    // - Leverage must be > 1.1 (so sizeUsdDelta must be > $11 when collateral is $10)
    // Adjust targetUsd to meet minimum collateral requirement
    const minCollateralUsd = 10;
    const adjustedTargetUsd = Math.max(targetUsd, minCollateralUsd * 1.2); // At least $12 to have leverage > 1.1
    
    // Build transaction via Perps API (returns a ready-to-sign serialized tx).
    const sizeUsdDelta = Math.max(1, Math.floor(adjustedTargetUsd * 1_000_000)); // 6dp
    
    // Use minimum required collateral ($10) to maximize leverage while meeting API requirements
    const collateralUsd = minCollateralUsd;
    
    // For shorts: inputTokenAmount in USDC (6 decimals); for longs: in SOL lamports (9 decimals)
    let inputTokenAmount: string;
    let collateralTokenDelta: string;
    if (isShort) {
      // USDC has 6 decimals
      inputTokenAmount = String(Math.max(1, Math.floor(targetUsd * 1_000_000)));
      collateralTokenDelta = String(Math.max(1, Math.floor(collateralUsd * 1_000_000)));
    } else {
      // SOL has 9 decimals (lamports)
      inputTokenAmount = String(Math.max(1, Math.floor((targetUsd / assumedSolPriceUsd) * 1_000_000_000)));
      collateralTokenDelta = String(Math.max(1, Math.floor((collateralUsd / assumedSolPriceUsd) * 1_000_000_000)));
    }

    // Mint addresses: SOL and USDC
    const SOL_MINT = "So11111111111111111111111111111111111111112";
    const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // Mainnet USDC, might differ on devnet
    
    const payload = {
      asset: "SOL", // Legacy field, might not be used
      side,
      inputToken, // Legacy field
      inputTokenAmount,
      // Required fields per API error
      marketMint: SOL_MINT,
      inputMint: isShort ? USDC_MINT : SOL_MINT,
      collateralMint: isShort ? USDC_MINT : SOL_MINT,
      collateralTokenDelta,
      sizeUsdDelta: String(sizeUsdDelta),
      maxSlippageBps: "200",
      feeToken: "USDC",
      feeTokenAmount: "0",
      feeReceiver: bot.publicKey.toBase58(),
      walletAddress: bot.publicKey.toBase58(),
      transactionType: "legacy",
      env: "devnet",
    };

    console.log("TESTING: Sending payload to API:", JSON.stringify(payload, null, 2));
    
    const resp = await axios.post(`${PERPS_API_BASE}/positions/increase`, payload, {
      timeout: 10_000,
      validateStatus: () => true,
    });

    console.log("TESTING: API response status:", resp.status);
    console.log("TESTING: API response data:", JSON.stringify(resp.data, null, 2));

    if (!resp.data || resp.data.error) {
      console.log("Perps API increase response error:", resp.data ?? resp.status);
      return null;
    }

    const { serializedTxBase64, txMetadata } = resp.data;
    if (!serializedTxBase64) {
      console.log("Perps API did not return a serialized transaction. Full response:", resp.data);
      return null;
    }

    const txBytes = Buffer.from(serializedTxBase64, "base64");
    const tx = VersionedTransaction.deserialize(txBytes);
    tx.sign([bot]);

    // Skip preflight to avoid blockhash simulation issues - API provides valid blockhash
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true, // Skip simulation to avoid blockhash expiration issues
      maxRetries: 3,
    });

    console.log("✅ TESTING SUCCESS: Sent perps tx via API; signature:", sig);
    console.log("   Position pubkey:", resp.data.positionPubkey);
    console.log("   Leverage:", resp.data.quote?.leverage);
    console.log("   Side:", resp.data.quote?.side);
    
    // Confirm transaction
    try {
      await connection.confirmTransaction(sig, "confirmed");
      console.log("✅ Transaction confirmed on-chain!");
    } catch (confirmError) {
      console.log("⚠️  Transaction sent but confirmation pending:", confirmError);
    }

    return sig;
  } catch (error) {
    console.error("Failed to build/send perps transaction:", error);
    return null;
  }
}

