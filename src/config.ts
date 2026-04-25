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
  // Inline keypair env var (Railway / production deploys) takes precedence
  // over file path. Accepts either a JSON array `[1,2,...]` or a base64-encoded
  // 64-byte secret.
  const inline = process.env.FACILITATOR_KEYPAIR;
  if (inline) {
    const trimmed = inline.trim();
    if (trimmed.startsWith("[")) {
      const arr = JSON.parse(trimmed) as number[];
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    }
    return Keypair.fromSecretKey(Uint8Array.from(Buffer.from(trimmed, "base64")));
  }
  const absPath = path.isAbsolute(keyPath)
    ? keyPath
    : path.resolve(process.cwd(), keyPath);
  const candidates = [absPath, path.resolve(process.cwd(), "..", keyPath)];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const secret = JSON.parse(fs.readFileSync(p, "utf-8")) as number[];
      return Keypair.fromSecretKey(Uint8Array.from(secret));
    }
  }
  throw new Error(
    `Keypair file not found at ${candidates.join(" or ")} and FACILITATOR_KEYPAIR not set.`
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
    // Railway / many PaaS set PORT; honor that first, then FACILITATOR_PORT, then default
    port: parseInt(process.env.PORT || process.env.FACILITATOR_PORT || "4021", 10),
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
