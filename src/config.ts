import * as fs from "fs";
import * as path from "path";
import { config as loadDotenv } from "dotenv";
import { Keypair, PublicKey } from "@solana/web3.js";

// Load .env from parent dir (shared) and local .env (overrides)
loadDotenv({ path: path.resolve(process.cwd(), "../.env") });
loadDotenv({ path: path.resolve(process.cwd(), ".env"), override: true });

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

function opt(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function loadKeypair(keyPath: string): Keypair {
  const absPath = path.isAbsolute(keyPath)
    ? keyPath
    : path.resolve(process.cwd(), keyPath);
  // try ../ first (repo root), then local
  const candidates = [absPath, path.resolve(process.cwd(), "..", keyPath)];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const secret = JSON.parse(fs.readFileSync(p, "utf-8")) as number[];
      return Keypair.fromSecretKey(Uint8Array.from(secret));
    }
  }
  throw new Error(
    `Keypair file not found at ${candidates.join(" or ")}. Set FACILITATOR_KEYPAIR_PATH.`
  );
}

export interface FacilitatorConfig {
  port: number;
  network: string;
  solanaRpcUrl: string;
  koraRpcUrl: string;
  koraApiKey: string;
  facilitatorKeypair: Keypair;
  facilitatorPubkey: PublicKey;
  incoTokenProgramId: PublicKey;
  incoLightningProgramId: PublicKey;
  tokenMint: PublicKey | null;
  assetDecimals: number;
  maxPerCall: string; // decimal string
  dbPath: string;
}

export function loadConfig(): FacilitatorConfig {
  const facilitatorKeypair = loadKeypair(
    opt("FACILITATOR_KEYPAIR_PATH", ".keys/facilitator.json")
  );
  const tokenMintStr = process.env.TOKEN_MINT;
  return {
    port: parseInt(opt("FACILITATOR_PORT", "4021"), 10),
    network: opt("NETWORK", "solana:devnet"),
    solanaRpcUrl: opt("SOLANA_RPC_URL", "https://api.devnet.solana.com"),
    koraRpcUrl: opt("KORA_RPC_URL", "http://localhost:8080/"),
    koraApiKey: opt("KORA_API_KEY", "kora_facilitator_api_key_example"),
    facilitatorKeypair,
    facilitatorPubkey: facilitatorKeypair.publicKey,
    incoTokenProgramId: new PublicKey(
      opt(
        "INCO_TOKEN_PROGRAM_ID",
        "9Cir3JKBcQ1mzasrQNKWMiGVZvYu3dxvfkGeQ6mohWWi"
      )
    ),
    incoLightningProgramId: new PublicKey(
      opt(
        "INCO_LIGHTNING_PROGRAM_ID",
        "5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj"
      )
    ),
    tokenMint: tokenMintStr ? new PublicKey(tokenMintStr) : null,
    assetDecimals: parseInt(opt("ASSET_DECIMALS", "6"), 10),
    maxPerCall: opt("MAX_PER_CALL", "1.00"),
    dbPath: opt("DB_PATH", "./sessions.db"),
  };
}
