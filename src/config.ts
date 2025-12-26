export const config = (() => {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  const botSecretKey = process.env.BOT_WALLET_SECRET_KEY;

  if (!rpcUrl) {
    throw new Error("Missing SOLANA_RPC_URL in environment.");
  }
  if (!botSecretKey) {
    throw new Error("Missing BOT_WALLET_SECRET_KEY in environment.");
  }

  return {
    rpcUrl,
    botSecretKey,
  };
})();

export const jupPerpsEnv = process.env.JUP_PERPS_ENV ?? "mainnet";

