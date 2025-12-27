import {
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  VersionedTransaction,
} from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddress } from "@solana/spl-token";
import axios from "axios";
import type { TradeIntent } from "./types";
import { config, jupPerpsEnv } from "../config";

export interface PerpsMarketConfig {
  pool: PublicKey;
  custody: PublicKey;
  collateralCustody: PublicKey;
  programId: PublicKey;
}

type Side = "long" | "short";

const PERPS_API_BASE = "https://perps-api.jup.ag/v1";
// Mint addresses: SOL and USDC
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_MINT_PK = new PublicKey(USDC_MINT);
const TP_THRESHOLD_PCT = 0.035; // +3.5%
const SL_THRESHOLD_PCT = -0.035; // -3.5%
const MAX_POSITION_AGE_MS = 24 * 60 * 60 * 1000; // 24h

async function getUsdcBalance(
  connection: Connection,
  owner: PublicKey
): Promise<number> {
  try {
    const ata = await getAssociatedTokenAddress(USDC_MINT_PK, owner);
    const account = await getAccount(connection, ata);
    // USDC has 6 decimals
    return Number(account.amount) / 1_000_000;
  } catch (_) {
    // Most likely: no ATA or zero balance
    return 0;
  }
}

type NormalizedPerpsPosition = {
  side: Side;
  entryPrice: number | null;
  markPrice: number | null;
  createdAtMs: number | null;
  sizeUsd: number | null;
  raw: any;
};

function numOrNull(v: any): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizePerpsPosition(p: any): NormalizedPerpsPosition | null {
  if (!p) return null;
  const sideRaw = (p.side ?? p.positionSide ?? "").toString().toLowerCase();
  const side: Side | null =
    sideRaw === "long" ? "long" : sideRaw === "short" ? "short" : null;
  if (!side) return null;

  const entryPrice =
    numOrNull(p.entryPriceUsd) ??
    numOrNull(p.entryPrice) ??
    numOrNull(p.avgEntryPriceUsd) ??
    numOrNull(p.avgEntryPrice) ??
    null;

  const markPrice =
    numOrNull(p.markPriceUsd) ??
    numOrNull(p.indexPriceUsd) ??
    numOrNull(p.oraclePriceUsd) ??
    numOrNull(p.currentPriceUsd) ??
    numOrNull(p.price) ??
    null;

  const createdField =
    p.createdAt ?? p.createdTs ?? p.timestamp ?? p.openedAt ?? p.openTime;
  let createdAtMs: number | null = null;
  if (typeof createdField === "number") {
    createdAtMs =
      createdField > 3_000_000_000 ? createdField : createdField * 1000;
  } else if (typeof createdField === "string") {
    const ts = Number(createdField);
    if (Number.isFinite(ts)) {
      createdAtMs = ts > 3_000_000_000 ? ts : ts * 1000;
    } else {
      const d = Date.parse(createdField);
      createdAtMs = Number.isFinite(d) ? d : null;
    }
  } else if (createdField instanceof Date) {
    createdAtMs = createdField.getTime();
  }

  const sizeUsd =
    numOrNull(p.positionSizeUsd) ??
    numOrNull(p.sizeUsd) ??
    numOrNull(p.notionalUsd) ??
    numOrNull(p.size) ??
    null;

  return {
    side,
    entryPrice,
    markPrice,
    createdAtMs,
    sizeUsd,
    raw: p,
  };
}

async function fetchOpenPerpsPositions(
  wallet: PublicKey
): Promise<any[] | null> {
  try {
    const resp = await axios.get(`${PERPS_API_BASE}/positions`, {
      params: { wallet: wallet.toBase58(), env: jupPerpsEnv },
      timeout: 10_000,
      validateStatus: () => true,
    });

    if (!resp.data || resp.data.error) {
      console.warn("Perps positions query failed:", resp.data?.message ?? resp.data?.error ?? resp.status);
      return null;
    }

    const positionsRaw = Array.isArray(resp.data)
      ? resp.data
      : Array.isArray(resp.data.positions)
      ? resp.data.positions
      : [];

    const openPositions = positionsRaw.filter((p: any) => {
      if (!p) return false;
      if (typeof p.isClosed === "boolean") return !p.isClosed;
      if (typeof p.status === "string") return p.status.toLowerCase() !== "closed";
      return true;
    });

    return openPositions;
  } catch (err) {
    console.warn("Failed to fetch open perps positions:", err);
    return null;
  }
}

function evaluateExitDecision(
  pos: NormalizedPerpsPosition,
  intent: TradeIntent
): { shouldClose: boolean; reason: string | null } {
  // Direction flip: if intent is opposite of existing position
  if (
    (intent.action === "OPEN_LONG" && pos.side === "short") ||
    (intent.action === "OPEN_SHORT" && pos.side === "long")
  ) {
    return { shouldClose: true, reason: "Signal flipped direction" };
  }

  // Price-based TP/SL
  if (pos.entryPrice && pos.markPrice) {
    const movePct =
      pos.side === "long"
        ? (pos.markPrice - pos.entryPrice) / pos.entryPrice
        : (pos.entryPrice - pos.markPrice) / pos.entryPrice;

    if (movePct >= TP_THRESHOLD_PCT) {
      return {
        shouldClose: true,
        reason: `Take profit triggered (+${(movePct * 100).toFixed(2)}%)`,
      };
    }

    if (movePct <= SL_THRESHOLD_PCT) {
      return {
        shouldClose: true,
        reason: `Stop loss triggered (${(movePct * 100).toFixed(2)}%)`,
      };
    }
  }

  // Max age
  if (pos.createdAtMs) {
    const ageMs = Date.now() - pos.createdAtMs;
    if (ageMs >= MAX_POSITION_AGE_MS) {
      return { shouldClose: true, reason: "Max position age exceeded (24h)" };
    }
  }

  return { shouldClose: false, reason: null };
}

export async function getSolPerpsMarketConfig(
  botPubkey: PublicKey,
  side: Side
): Promise<PerpsMarketConfig | null> {
  // For API-based approach, we don't need actual market config.
  // The API handles account derivation internally. Return dummy config.
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

async function submitPerpsApiTx(params: {
  payload: any;
  side: Side;
  connection: Connection;
  bot: Keypair;
  logLabel: string;
}): Promise<string | null> {
  const { payload, side, connection, bot, logLabel } = params;

  const resp = await axios.post(
    `${PERPS_API_BASE}/positions/${payload.reduceOnly ? "decrease" : "increase"}`,
    payload,
    {
      timeout: 10_000,
      validateStatus: () => true,
    }
  );

  if (!resp.data || resp.data.error) {
    console.log("Perps API error:", resp.data?.message ?? resp.data?.error ?? resp.status);
    return null;
  }

  const { serializedTxBase64, txMetadata } = resp.data;
  if (txMetadata) {
    console.log("Perps txMetadata (from API):", txMetadata);
  }
  if (!serializedTxBase64) {
    console.log("Perps API did not return a serialized transaction. Full response:");
    console.log(resp.data);
    return null;
  }

  const txBytes = Buffer.from(serializedTxBase64, "base64");
  const tx = VersionedTransaction.deserialize(txBytes);

  try {
    const message = tx.message;
    const programIds = new Set<string>();
    for (const ix of message.compiledInstructions) {
      const pid = message.staticAccountKeys[ix.programIdIndex]?.toBase58();
      if (pid) programIds.add(pid);
    }
    if (message.addressTableLookups?.length) {
      console.log(
        "Address table lookups (program IDs will be resolved on-chain):",
        message.addressTableLookups.map((l) => ({
          accountKey: l.accountKey.toBase58(),
          writableIndexes: Array.from(l.writableIndexes),
          readonlyIndexes: Array.from(l.readonlyIndexes),
        }))
      );
    }
    console.log("Programs referenced in tx:", Array.from(programIds));
  } catch (ixLogErr) {
    console.warn("Could not decode program IDs:", ixLogErr);
  }

  const latest = await connection.getLatestBlockhash("confirmed");
  tx.message.recentBlockhash = latest.blockhash;
  tx.sign([bot]);

  let sig: string;
  try {
    sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
  } catch (sendErr) {
    const ste = sendErr as SendTransactionError;
    console.error("SendRawTransaction failed:", ste);
    if (ste?.logs) {
      console.error("Simulation logs:", ste.logs);
    }
    if (typeof (ste as any).getLogs === "function") {
      try {
        const extraLogs = await (ste as any).getLogs(connection);
        if (extraLogs) {
          console.error("Simulation logs (getLogs):", extraLogs);
        }
      } catch (_) {
        // ignore secondary failure
      }
    }
    return null;
  }

  try {
    const confirmation = await connection.confirmTransaction(
      {
        signature: sig,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      "confirmed"
    );

    if (confirmation.value.err) {
      console.log("⚠️ Perps transaction not confirmed; RPC reported error:", confirmation.value.err);
      return null;
    }

    if (payload.reduceOnly) {
      console.log(`✅ Perps position reduced/closed (${logLabel}):`);
    } else {
      console.log(`✅ Perps ${side.toUpperCase()} position opened:`);
    }
    console.log(`   Transaction: ${sig}`);
    if (resp.data.positionPubkey) {
      console.log(`   Position: ${resp.data.positionPubkey}`);
    }
    const quote = resp.data.quote;
    if (quote?.positionSizeUsd) console.log(`   Size: $${quote.positionSizeUsd}`);
    if (quote?.leverage) console.log(`   Leverage: ${quote.leverage}x`);
    if (quote?.entryPriceUsd) console.log(`   Entry Price: $${quote.entryPriceUsd}`);
    console.log("✅ Transaction confirmed on-chain!");
  } catch (confirmError) {
    const explorerUrl =
      jupPerpsEnv === "devnet"
        ? `https://solscan.io/tx/${sig}?cluster=devnet`
        : `https://solscan.io/tx/${sig}`;
    console.log(
      "⚠️  Transaction sent but confirmation failed/pending; check manually:",
      explorerUrl
    );
    return null;
  }

  return resp.data?.positionPubkey ?? null;
}

export async function buildAndSendPerpsTx(
  params: BuildParams
): Promise<string | null> {
  const { connection, bot, intent, market: _market } = params;

  try {
    if (intent.action === "DO_NOTHING") {
      return null;
    }

    const openPositions = await fetchOpenPerpsPositions(bot.publicKey);
    if (openPositions === null) {
      console.log("[Perps] Could not verify existing positions; skipping to avoid overlap.");
      return null;
    }

    if (openPositions.length > 0) {
      const normalized = openPositions
        .map((p) => normalizePerpsPosition(p))
        .filter((p): p is NormalizedPerpsPosition => !!p);

      if (!normalized.length) {
        console.log("[Perps] Unable to normalize existing position; skipping new trade to avoid overlap.");
        return null;
      }

      const currentPos = normalized[0];
      const exitDecision = evaluateExitDecision(currentPos, intent);

      if (exitDecision.shouldClose) {
        console.log(`[Perps] Closing existing position: ${exitDecision.reason ?? "exit signal"}.`);
        if (jupPerpsEnv === "mainnet") {
          console.log("[Perps] MAINNET TRADE: sending close transaction to Solana mainnet.");
        }

        const sizeUsdDelta =
          currentPos.sizeUsd && currentPos.sizeUsd > 0
            ? Math.max(1, Math.ceil(currentPos.sizeUsd * 1_000_000))
            : null;

        if (!sizeUsdDelta) {
          console.log("[Perps] Unknown position size; cannot build close tx.");
          return null;
        }

        const payload = {
          side: currentPos.side,
          marketMint: SOL_MINT,
          inputMint: currentPos.side === "short" ? USDC_MINT : SOL_MINT,
          collateralMint: currentPos.side === "short" ? USDC_MINT : SOL_MINT,
          sizeUsdDelta: String(sizeUsdDelta),
          collateralTokenDelta: "0",
          maxSlippageBps: "200",
          feeToken: "USDC",
          feeTokenAmount: "0",
          feeReceiver: bot.publicKey.toBase58(),
          walletAddress: bot.publicKey.toBase58(),
          transactionType: "legacy",
          env: jupPerpsEnv,
          reduceOnly: true,
        };

        return await submitPerpsApiTx({
          payload,
          side: currentPos.side,
          connection,
          bot,
          logLabel: exitDecision.reason ?? "close",
        });
      }

      console.log(
        "[Perps] Existing open position detected; no TP/SL/age/flip exit triggered. Skipping new trade to avoid overlap."
      );
      return null;
    }

    const side: Side = intent.action === "OPEN_LONG" ? "long" : "short";

    // For shorts, use USDC as collateral; for longs, use SOL
    const isShort = side === "short";
    const inputToken = isShort ? "USDC" : "SOL";

    // Always need SOL for fees
    const balanceLamports = await connection.getBalance(bot.publicKey);
    const balanceSol = balanceLamports / 1_000_000_000;
    if (balanceSol <= 0) {
      console.log("Bot SOL balance is zero; cannot pay transaction fees.");
      return null;
    }

    let balanceUsd: number;
    const assumedSolPriceUsd = 100; // simple approximation
    const minCollateralUsd = 10;

    if (isShort) {
      // SHORT → USDC collateral
      const usdcBalance = await getUsdcBalance(connection, bot.publicKey);
      if (usdcBalance < minCollateralUsd) {
        console.log(
          `[Perps] Need at least $${minCollateralUsd} of USDC for collateral; have ~$${usdcBalance.toFixed(
            2
          )}. Skipping trade.`
        );
        return null;
      }
      // 1 USDC ≈ 1 USD
      balanceUsd = usdcBalance;
    } else {
      // LONG → SOL collateral (approximate USD value for sizing)
      balanceUsd = balanceSol * assumedSolPriceUsd;

      const requiredCollateralLamports = Math.ceil(
        (minCollateralUsd / assumedSolPriceUsd) * 1_000_000_000
      );
      if (balanceLamports < requiredCollateralLamports) {
        console.log(
          `[Perps] Need at least ${(requiredCollateralLamports / 1_000_000_000).toFixed(
            4
          )} SOL (~$${minCollateralUsd}) for collateral; have ${balanceSol.toFixed(
            4
          )} SOL. Skipping trade.`
        );
        return null;
      }
    }

    // Simple notional sizing: cap at $10 equivalent or riskFraction of balance.
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

    // API requirements:
    // - Minimum collateral: $10 for new positions
    // - Leverage must be > 1.1 (so sizeUsdDelta must be > $11 when collateral is $10)
    // Adjust targetUsd to meet minimum collateral requirement
    const adjustedTargetUsd = Math.max(targetUsd, minCollateralUsd * 1.2); // At least $12 to have leverage > 1.1
    const collateralUsd = minCollateralUsd;
    // Further bump notional to comfortably clear leverage threshold even if oracle SOL price
    // is higher than our assumedSolPriceUsd. Target 1.3x the collateral size.
    const sizeUsdTarget = Math.max(adjustedTargetUsd, collateralUsd * 1.3);

    console.log(
      `Opening ${side.toUpperCase()} SOL position: ~$${adjustedTargetUsd.toFixed(
        2
      )} notional using ${inputToken} collateral.`
    );
    
    // Build transaction via Perps API (returns a ready-to-sign serialized tx).
    const sizeUsdDelta = Math.max(1, Math.floor(sizeUsdTarget * 1_000_000)); // 6dp
    const intendedLeverage = sizeUsdDelta / 1_000_000 / collateralUsd;
    console.log(
      `Requested sizeUsdDelta=$${(sizeUsdDelta / 1_000_000).toFixed(
        2
      )}, collateralUsd=$${collateralUsd.toFixed(2)}, intended leverage=${intendedLeverage.toFixed(2)}x`
    );

    if (jupPerpsEnv === "mainnet") {
      console.log(
        `[Perps] MAINNET TRADE side=${side} sizeUsd=$${(sizeUsdDelta / 1_000_000).toFixed(
          2
        )} collateralUsd=$${collateralUsd.toFixed(2)} leverageTarget=${intendedLeverage.toFixed(2)}x`
      );
    }
    
    // For shorts: inputTokenAmount in USDC (6 decimals); for longs: in SOL lamports (9 decimals)
    let inputTokenAmount: string;
    let collateralTokenDelta: string;
    if (isShort) {
      // USDC has 6 decimals
      collateralTokenDelta = String(Math.max(1, Math.floor(collateralUsd * 1_000_000)));
      // Pay in exactly the collateral amount when opening
      inputTokenAmount = collateralTokenDelta;
    } else {
      // SOL has 9 decimals (lamports)
      collateralTokenDelta = String(
        Math.max(1, Math.floor((collateralUsd / assumedSolPriceUsd) * 1_000_000_000))
      );
      // Pay in exactly the collateral amount when opening
      inputTokenAmount = collateralTokenDelta;
    }

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
      env: jupPerpsEnv,
    };

    return await submitPerpsApiTx({
      payload,
      side,
      connection,
      bot,
      logLabel: "open",
    });
  } catch (error) {
    console.error("Failed to build/send perps transaction:", error);
    return null;
  }
}

