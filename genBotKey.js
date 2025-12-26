const { Keypair } = require("@solana/web3.js");

function main() {
  const kp = Keypair.generate();
  console.log("=== Generated Solana Bot Wallet ===");
  console.log("Public Key:", kp.publicKey.toBase58());
  console.log("Secret Key JSON (put this in .env):");
  console.log("[" + kp.secretKey.toString() + "]");
}

main();
