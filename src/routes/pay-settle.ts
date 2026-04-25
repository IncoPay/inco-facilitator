/**
 * /pay/settle — Single-payment settle for the IncoPay /started demo.
 *
 * Two-step flow (mirrors IncoPay/app/facilator/server.ts):
 *  1) Client POSTs `payload.authorization` with {message, signature, payer,
 *     ciphertext, mint, paymentReceiver, sourceHandle, destHandle}. We build
 *     an unsigned tx [Ed25519 verify, transfer_with_authorization] with the
 *     facilitator as fee payer, return it as base64.
 *  2) Client signs (as `payer`) and POSTs `payload.transaction`. We apply the
 *     facilitator's fee-payer signature and submit via direct RPC.
 *
 * Architectural deviation from old facilitator: Kora has been replaced with
 * direct signing using the existing facilitator keypair (cfg.facilitatorKeypair
 * already loaded by config.ts). Kora was only used as an off-chain fee payer
 * + relayer; the facilitator wallet has 5.97 SOL devnet, plenty for fees.
 */
import { Request, Response } from "express";
import {
  Connection,
  Ed25519Program,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { FacilitatorConfig } from "../config";
import {
  INCO_LIGHTNING_PROGRAM_ID,
  INCO_TOKEN_PROGRAM_ID,
  getAllowancePda,
  getIncoAssociatedTokenAddress,
  hexToBuffer,
  waitForTx,
} from "../solana";

const SYSVAR_INSTRUCTIONS_ID = new PublicKey(
  "Sysvar1nstructions1111111111111111111111111"
);

// IDL discriminator for IncoToken::transfer_with_authorization (8 bytes).
// Matches IncoPay/public/idl/inco_token.json. We encode the instruction by
// hand here so the facilitator doesn't need the IDL on disk.
const DISC_TRANSFER_WITH_AUTHORIZATION = Buffer.from([
  241, 208, 6, 43, 81, 61, 213, 10,
]);

function encodeBytes(b: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length, 0);
  return Buffer.concat([len, b]);
}

/** Build the IncoToken `transfer_with_authorization` instruction by hand. */
function ixTransferWithAuthorization(args: {
  source: PublicKey;
  destination: PublicKey;
  payer: PublicKey;
  ciphertext: Buffer;
  sourceAllowancePda: PublicKey;
  sourceOwner: PublicKey;
  destAllowancePda: PublicKey;
  destOwner: PublicKey;
}): TransactionInstruction {
  const data = Buffer.concat([
    DISC_TRANSFER_WITH_AUTHORIZATION,
    encodeBytes(args.ciphertext),
    Buffer.from([0]), // input_type
  ]);
  const keys = [
    { pubkey: args.source, isSigner: false, isWritable: true },
    { pubkey: args.destination, isSigner: false, isWritable: true },
    { pubkey: args.payer, isSigner: true, isWritable: true },
    { pubkey: SYSVAR_INSTRUCTIONS_ID, isSigner: false, isWritable: false },
    { pubkey: INCO_LIGHTNING_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    // remaining_accounts as documented by the IDL
    { pubkey: args.sourceAllowancePda, isSigner: false, isWritable: true },
    { pubkey: args.payer, isSigner: false, isWritable: false },
    { pubkey: args.destAllowancePda, isSigner: false, isWritable: true },
    { pubkey: args.destOwner, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({
    programId: INCO_TOKEN_PROGRAM_ID,
    keys,
    data,
  });
}

interface AuthorizationBody {
  message: string;
  signature: string;
  payer: string;
  ciphertext: string;
  mint: string;
  paymentReceiver: string;
  sourceHandle: string;
  destHandle: string;
}

async function buildAuthTx(
  connection: Connection,
  feePayer: PublicKey,
  auth: AuthorizationBody
): Promise<string> {
  const payerPk = new PublicKey(auth.payer);
  const mint = new PublicKey(auth.mint);
  const paymentReceiver = new PublicKey(auth.paymentReceiver);

  const sourceAccount = getIncoAssociatedTokenAddress(payerPk, mint);
  const destAccount = getIncoAssociatedTokenAddress(paymentReceiver, mint);

  const sourceHandle = BigInt(auth.sourceHandle);
  const destHandle = BigInt(auth.destHandle);
  const sourceAllowancePda = getAllowancePda(sourceHandle, payerPk);
  const destAllowancePda = getAllowancePda(destHandle, paymentReceiver);

  const messageBytes = new TextEncoder().encode(auth.message);
  const sigDecoded = Buffer.from(auth.signature, "base64");
  const sigBytes = new Uint8Array(
    sigDecoded.length >= 64 ? sigDecoded.subarray(0, 64) : sigDecoded
  );
  if (sigBytes.length < 64) throw new Error("Invalid signature length");

  // The Inco program reads the Ed25519 verify instruction at index 0 and
  // checks the signature was made by `payer` over `message`.
  const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
    publicKey: payerPk.toBytes(),
    message: messageBytes,
    signature: sigBytes,
  });

  const ciphertextBuf = hexToBuffer(auth.ciphertext);

  const transferIx = ixTransferWithAuthorization({
    source: sourceAccount,
    destination: destAccount,
    payer: payerPk,
    ciphertext: ciphertextBuf,
    sourceAllowancePda,
    sourceOwner: payerPk,
    destAllowancePda,
    destOwner: paymentReceiver,
  });

  const tx = new Transaction();
  tx.add(ed25519Ix, transferIx);
  tx.feePayer = feePayer;
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;

  const serialized = tx.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
  return Buffer.from(serialized).toString("base64");
}

export function paySettleRoute(
  cfg: FacilitatorConfig,
  connection: Connection
) {
  return async (req: Request, res: Response) => {
    const network = cfg.network;
    try {
      const { paymentPayload, paymentRequirements } = req.body as {
        paymentPayload?: { payload?: Record<string, unknown> };
        paymentRequirements?: { network?: string };
      };

      if (!paymentRequirements?.network?.startsWith("solana:")) {
        throw new Error("Invalid network - only Solana networks are supported");
      }

      const payload = paymentPayload?.payload ?? {};

      // Step 1: client supplied the authorization — return unsigned tx.
      if (payload.authorization != null) {
        const auth = payload.authorization as Partial<AuthorizationBody>;
        const required: Array<keyof AuthorizationBody> = [
          "message",
          "signature",
          "payer",
          "ciphertext",
          "mint",
          "paymentReceiver",
          "sourceHandle",
          "destHandle",
        ];
        for (const k of required) {
          if (auth[k] == null) {
            return res.status(400).json({
              success: false,
              transaction: "",
              network,
              errorReason: `authorization missing field: ${k}`,
            });
          }
        }

        const unsignedB64 = await buildAuthTx(
          connection,
          cfg.facilitatorPubkey,
          auth as AuthorizationBody
        );

        return res.json({
          success: false,
          network,
          requiresPayerSignature: true,
          unsignedTransaction: unsignedB64,
        });
      }

      // Step 2: client returns the user-signed tx; we co-sign as fee payer + submit.
      const txBase64 = payload.transaction;
      if (typeof txBase64 !== "string") {
        throw new Error(
          "payload must include `transaction` (base64) or `authorization`"
        );
      }

      const tx = Transaction.from(Buffer.from(txBase64, "base64"));
      if (!tx.feePayer || !tx.feePayer.equals(cfg.facilitatorPubkey)) {
        // Trust the original feePayer the client signed against. If the
        // client built a tx with a different fee payer we have to reject —
        // we can't change feePayer without invalidating the user's signature.
        if (!tx.feePayer) {
          tx.feePayer = cfg.facilitatorPubkey;
        } else if (!tx.feePayer.equals(cfg.facilitatorPubkey)) {
          throw new Error(
            `tx fee payer (${tx.feePayer.toBase58()}) does not match facilitator (${cfg.facilitatorPubkey.toBase58()})`
          );
        }
      }
      // Add facilitator's fee-payer signature without disturbing the user's.
      tx.partialSign(cfg.facilitatorKeypair);

      const raw = tx.serialize({
        requireAllSignatures: true,
        verifySignatures: true,
      });
      const sig = await connection.sendRawTransaction(raw, {
        skipPreflight: false,
      });
      await waitForTx(connection, sig, 30000);

      return res.json({
        transaction: sig,
        success: true,
        network,
      });
    } catch (error: unknown) {
      const raw = error instanceof Error ? error.message : String(error);
      const errorReason =
        raw.includes("0xbc0") || raw.includes("custom program error")
          ? "Payment failed (program error). Sign the message first, then sign the transaction once when prompted so the facilitator can complete the payment on your behalf."
          : raw || "Settle failed.";
      console.error("[pay/settle] error:", raw);
      return res.status(400).json({
        transaction: "",
        success: false,
        network,
        errorReason,
      });
    }
  };
}
