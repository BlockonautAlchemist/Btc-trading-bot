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

export async function buildAndSendPerpsTx(
  params: BuildParams
): Promise<string | null> {
  const { connection, bot, intent, market: _market } = params;

  try {
    if (intent.action === "DO_NOTHING") {
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

    const resp = await axios.post(`${PERPS_API_BASE}/positions/increase`, payload, {
      timeout: 10_000,
      validateStatus: () => true,
    });

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

    // Debug: list program IDs and address table lookups to ensure we are on the right cluster.
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

    // Refresh blockhash to avoid "blockhash not found" on our RPC.
    const latest = await connection.getLatestBlockhash("confirmed");
    tx.message.recentBlockhash = latest.blockhash;
    tx.sign([bot]);

    let sig: string;
    try {
      // Skip preflight if the API-provided blockhash is close to expiring; otherwise allow simulation
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
      // Some SendTransactionError instances support getLogs(); call if present.
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

