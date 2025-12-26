import {
  Connection,
  Keypair,
  PublicKey,
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
// Mint addresses: SOL and devnet USDC
const SOL_MINT = "So11111111111111111111111111111111111111112";
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const DEVNET_USDC_MINT_PK = new PublicKey(DEVNET_USDC_MINT);

async function getDevnetUsdcBalance(
  connection: Connection,
  owner: PublicKey
): Promise<number> {
  try {
    const ata = await getAssociatedTokenAddress(DEVNET_USDC_MINT_PK, owner);
    const account = await getAccount(connection, ata);
    // USDC has 6 decimals
    return Number(account.amount) / 1_000_000;
  } catch (_) {
    // Most likely: no ATA or zero balance
    return 0;
  }
}

export async function getSolPerpsMarketConfig(
  botPubkey: PublicKey,
  side: Side
): Promise<PerpsMarketConfig | null> {
  if (jupPerpsEnv !== "devnet") {
    return null;
  }

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

export async function buildAndSendPerpsTx(
  params: BuildParams
): Promise<string | null> {
  const { connection, bot, intent, market: _market } = params;

  try {
    if (intent.action === "DO_NOTHING") {
      return null;
    }

    const isDevnet = jupPerpsEnv === "devnet";

    const MIN_NOTIONAL_USD = isDevnet ? 0.1 : 1; // allow tiny trades on devnet
    const MIN_COLLATERAL_USD = isDevnet ? 0.5 : 10; // devnet hack: much lower collateral

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

    // Always need SOL for fees
    const balanceLamports = await connection.getBalance(bot.publicKey);
    const balanceSol = balanceLamports / 1_000_000_000;
    if (balanceSol <= 0) {
      console.log("Bot SOL balance is zero; cannot pay transaction fees.");
      return null;
    }

    let balanceUsd: number;
    const assumedSolPriceUsd = 100; // devnet approximation

    if (isShort) {
      // SHORT → USDC collateral on devnet
      const usdcBalance = await getDevnetUsdcBalance(connection, bot.publicKey);
      if (usdcBalance <= 0) {
        console.log(
          "[Perps] No devnet USDC in bot wallet; cannot open SHORT. Skipping trade."
        );
        return null;
      }
      // 1 USDC ≈ 1 USD
      balanceUsd = usdcBalance;
    } else {
      // LONG → SOL collateral (approximate USD value for sizing)
      balanceUsd = balanceSol * assumedSolPriceUsd;
    }

    // Simple notional sizing: cap at $10 equivalent or riskFraction of balance.
    const targetUsd = Math.max(
      0,
      Math.min(balanceUsd * intent.riskFraction, 10)
    );

    if (targetUsd < MIN_NOTIONAL_USD) {
      console.log(
        `[Perps] Not enough balance for minimum notional on ${jupPerpsEnv}. ` +
          `Computed ~$${targetUsd.toFixed(2)}, min is ~$${MIN_NOTIONAL_USD.toFixed(
            2
          )}; skipping.`
      );
      return null;
    }

    // API requirements:
    // - Minimum collateral: $10 for new positions (relaxed on devnet)
    // - Leverage must be > 1.1 (so sizeUsdDelta must be > $11 when collateral is $10)
    // Adjust targetUsd to meet minimum collateral requirement
    const minCollateralUsd = MIN_COLLATERAL_USD;
    const adjustedTargetUsd = Math.max(targetUsd, minCollateralUsd * 1.2); // At least $12 to have leverage > 1.1

    if (isDevnet && minCollateralUsd < 10) {
      console.log(
        `[Perps] DEVNET MODE: using relaxed min collateral of $${minCollateralUsd.toFixed(
          2
        )} (mainnet would require ~$10+).`
      );
    }

    console.log(
      `Opening ${side.toUpperCase()} SOL position: ~$${adjustedTargetUsd.toFixed(
        2
      )} notional using ${inputToken} collateral.`
    );
    
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

    const payload = {
      asset: "SOL", // Legacy field, might not be used
      side,
      inputToken, // Legacy field
      inputTokenAmount,
      // Required fields per API error
      marketMint: SOL_MINT,
      inputMint: isShort ? DEVNET_USDC_MINT : SOL_MINT,
      collateralMint: isShort ? DEVNET_USDC_MINT : SOL_MINT,
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

    const resp = await axios.post(`${PERPS_API_BASE}/positions/increase`, payload, {
      timeout: 10_000,
      validateStatus: () => true,
    });

    if (!resp.data || resp.data.error) {
      console.log("Perps API error:", resp.data?.message ?? resp.data?.error ?? resp.status);
      return null;
    }

    const { serializedTxBase64, txMetadata } = resp.data;
    if (!serializedTxBase64) {
      console.log("Perps API did not return a serialized transaction.");
      return null;
    }

    const txBytes = Buffer.from(serializedTxBase64, "base64");
    const tx = VersionedTransaction.deserialize(txBytes);

    // Refresh blockhash to avoid "blockhash not found" on our RPC.
    const latest = await connection.getLatestBlockhash("confirmed");
    tx.message.recentBlockhash = latest.blockhash;
    tx.sign([bot]);

    // Skip preflight to avoid blockhash simulation issues - API provides valid blockhash
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    // Confirm transaction using returned blockhash metadata
    try {
      const confirmation = await connection.confirmTransaction(
        {
          signature: sig,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        "confirmed"
      );

      const quote = resp.data.quote;
      if (confirmation.value.err) {
        console.log("⚠️ Perps transaction not confirmed; RPC reported error:", confirmation.value.err);
        return null;
      }

      console.log(`✅ Perps ${side.toUpperCase()} position opened:`);
      console.log(`   Transaction: ${sig}`);
      console.log(`   Position: ${resp.data.positionPubkey}`);
      console.log(`   Size: $${quote?.positionSizeUsd ?? "N/A"}`);
      console.log(`   Leverage: ${quote?.leverage ?? "N/A"}x`);
      console.log(`   Entry Price: $${quote?.entryPriceUsd ?? "N/A"}`);
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

    return sig;
  } catch (error) {
    console.error("Failed to build/send perps transaction:", error);
    return null;
  }
}

