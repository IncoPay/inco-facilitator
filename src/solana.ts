/**
 * Facilitator-side Solana helpers: instruction builders + Kora client.
 * Kept intentionally independent of the SDK so the facilitator ships standalone.
 */
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  Keypair,
  SystemProgram,
} from "@solana/web3.js";

export const INCO_TOKEN_PROGRAM_ID = new PublicKey(
  "9Cir3JKBcQ1mzasrQNKWMiGVZvYu3dxvfkGeQ6mohWWi"
);
export const INCO_LIGHTNING_PROGRAM_ID = new PublicKey(
  "5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj"
);

export function getIncoAssociatedTokenAddress(
  wallet: PublicKey,
  mint: PublicKey
): PublicKey {
  const [addr] = PublicKey.findProgramAddressSync(
    [wallet.toBuffer(), INCO_TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    INCO_TOKEN_PROGRAM_ID
  );
  return addr;
}

export function getAllowancePda(
  handle: bigint,
  allowedAddress: PublicKey
): PublicKey {
  const buf = Buffer.alloc(16);
  let h = handle;
  for (let i = 0; i < 16; i++) {
    buf[i] = Number(h & BigInt(0xff));
    h >>= BigInt(8);
  }
  const [pda] = PublicKey.findProgramAddressSync(
    [buf, allowedAddress.toBuffer()],
    INCO_LIGHTNING_PROGRAM_ID
  );
  return pda;
}

export function extractAmountHandle(base64: string): bigint {
  const buf = Buffer.from(base64, "base64");
  if (buf.length < 88)
    throw new Error(`IncoAccount data too short: ${buf.length}`);
  const bytes = buf.slice(72, 88);
  let h = 0n;
  for (let i = 15; i >= 0; i--) h = h * 256n + BigInt(bytes[i]);
  return h;
}

export async function encryptValue(v: bigint): Promise<string> {
  const mod: any = await import("@inco/solana-sdk/encryption");
  return mod.encryptValue(v);
}

export function hexToBuffer(hex: string): Buffer {
  const c = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Buffer.from(c, "hex");
}

const DISC_TRANSFER = Buffer.from([163, 52, 200, 231, 140, 3, 69, 186]);
const DISC_CREATE_IDEMPOTENT = Buffer.from([
  143, 88, 34, 91, 112, 20, 245, 59,
]);

function encodeBytes(b: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length, 0);
  return Buffer.concat([len, b]);
}

export function ixTransfer(args: {
  source: PublicKey;
  destination: PublicKey;
  authority: PublicKey;
  ciphertext: Buffer;
  sourceAllowancePda: PublicKey | null;
  sourceOwner: PublicKey;
  destAllowancePda: PublicKey | null;
  destOwner: PublicKey;
}): TransactionInstruction {
  const data = Buffer.concat([
    DISC_TRANSFER,
    encodeBytes(args.ciphertext),
    Buffer.from([0]),
  ]);
  const keys = [
    { pubkey: args.source, isSigner: false, isWritable: true },
    { pubkey: args.destination, isSigner: false, isWritable: true },
    { pubkey: args.authority, isSigner: true, isWritable: true },
    { pubkey: INCO_LIGHTNING_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  if (args.sourceAllowancePda && args.destAllowancePda) {
    keys.push(
      { pubkey: args.sourceAllowancePda, isSigner: false, isWritable: true },
      { pubkey: args.sourceOwner, isSigner: false, isWritable: false },
      { pubkey: args.destAllowancePda, isSigner: false, isWritable: true },
      { pubkey: args.destOwner, isSigner: false, isWritable: false }
    );
  }
  return new TransactionInstruction({
    programId: INCO_TOKEN_PROGRAM_ID,
    keys,
    data,
  });
}

export function ixCreateIdempotent(args: {
  payer: PublicKey;
  ata: PublicKey;
  wallet: PublicKey;
  mint: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: INCO_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.ata, isSigner: false, isWritable: true },
      { pubkey: args.wallet, isSigner: false, isWritable: false },
      { pubkey: args.mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: INCO_LIGHTNING_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: DISC_CREATE_IDEMPOTENT,
  });
}

// ---------- Kora RPC client ----------

export interface KoraClient {
  getBlockhash(): Promise<{ blockhash: string; slot?: number }>;
  getPayerSigner(): Promise<{ signer_address: string; payment_address?: string }>;
  signTransaction(params: {
    transaction: string;
    sig_verify?: boolean;
  }): Promise<{ signed_transaction: string; signer_pubkey?: string }>;
  signAndSendTransaction(params: {
    transaction: string;
    sig_verify?: boolean;
  }): Promise<{
    signature?: string;
    signed_transaction?: string;
    confirmed?: boolean;
  }>;
}

export function makeKoraClient(rpcUrl: string, apiKey: string): KoraClient {
  const call = async (method: string, params: unknown = {}): Promise<any> => {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(
        `Kora ${method} non-JSON response (${res.status}): ${text.slice(0, 200)}`
      );
    }
    if (json.error) {
      throw new Error(
        `Kora ${method} error: ${JSON.stringify(json.error)}`
      );
    }
    return json.result;
  };
  return {
    getBlockhash: () => call("getBlockhash"),
    getPayerSigner: () => call("getPayerSigner"),
    signTransaction: (p) => call("signTransaction", p),
    signAndSendTransaction: (p) => call("signAndSendTransaction", p),
  };
}

/**
 * Submit a partially-signed tx through Kora. Returns on-chain signature.
 * Falls back to direct RPC send if Kora is unavailable (uses `payer` keypair).
 */
export async function submitViaKoraOrFallback(
  kora: KoraClient,
  connection: Connection,
  txBase64: string,
  fallbackPayer?: Keypair
): Promise<string> {
  try {
    const result = await kora.signAndSendTransaction({
      transaction: txBase64,
      sig_verify: false,
    });
    const sig = result.signature;
    if (sig) return sig;
    if (result.signed_transaction) {
      const raw = Buffer.from(result.signed_transaction, "base64");
      const sent = await connection.sendRawTransaction(raw, {
        skipPreflight: true,
      });
      return sent;
    }
    throw new Error(`Kora returned no signature: ${JSON.stringify(result)}`);
  } catch (koraErr) {
    if (!fallbackPayer) throw koraErr;
    console.warn(
      "[kora] falling back to direct RPC submission:",
      (koraErr as Error).message
    );
    const tx = Transaction.from(Buffer.from(txBase64, "base64"));
    // if feePayer unset or not matching, set to fallbackPayer and re-sign
    if (!tx.feePayer || !tx.feePayer.equals(fallbackPayer.publicKey)) {
      tx.feePayer = fallbackPayer.publicKey;
    }
    tx.partialSign(fallbackPayer);
    const raw = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    return connection.sendRawTransaction(raw, { skipPreflight: true });
  }
}

export async function waitForTx(
  connection: Connection,
  signature: string,
  timeoutMs = 30000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await connection.getSignatureStatus(signature, {
      searchTransactionHistory: true,
    });
    const s = status.value;
    if (s) {
      if (s.err)
        throw new Error(`tx ${signature} failed: ${JSON.stringify(s.err)}`);
      if (
        s.confirmationStatus === "confirmed" ||
        s.confirmationStatus === "finalized"
      ) {
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`tx ${signature} not confirmed within ${timeoutMs}ms`);
}
