/**
 * /settle — the heart of the session scheme.
 *
 * 1. verify session
 * 2. atomically debit sqlite BEFORE hitting chain
 * 3. build IncoToken `transfer(amount_ciphertext)` tx as authority=facilitator
 *    - simulate for updated source+dest amount handles
 *    - derive allowance PDAs for source_owner & dest_owner decrypt rights
 *    - rebuild + sign + ship via Kora
 * 4. on failure, refund sqlite
 */
import { Request, Response } from "express";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { FacilitatorConfig } from "../config";
import { Storage } from "../storage";
import { PaymentPayload, PaymentRequirements } from "../types";
import {
  KoraClient,
  encryptValue,
  hexToBuffer,
  ixTransfer,
  ixCreateIdempotent,
  getIncoAssociatedTokenAddress,
  getAllowancePda,
  extractAmountHandle,
  submitViaKoraOrFallback,
  waitForTx,
} from "../solana";

export function settleRoute(
  cfg: FacilitatorConfig,
  storage: Storage,
  connection: Connection,
  kora: KoraClient
) {
  return async (req: Request, res: Response) => {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };
    const network = cfg.network;
    const sessionId = paymentPayload?.payload?.sessionId;
    if (!sessionId) {
      return res.status(400).json({
        success: false,
        transaction: "",
        network,
        errorReason: "missing_session_id",
      });
    }

    const session = storage.get(sessionId);
    if (!session) {
      return res.status(400).json({
        success: false,
        transaction: "",
        network,
        errorReason: "session_not_found",
      });
    }

    const amount = BigInt(paymentRequirements.amount);
    const nowUnix = Math.floor(Date.now() / 1000);
    let debited = false;
    try {
      storage.debit(sessionId, amount, nowUnix);
      debited = true;

      const user = new PublicKey(session.user);
      const recipient = new PublicKey(session.recipient);
      const mint = new PublicKey(session.asset);
      const sourceAta = getIncoAssociatedTokenAddress(user, mint);
      const destAta = getIncoAssociatedTokenAddress(recipient, mint);

      // build ciphertext for amount
      const amountCtHex = await encryptValue(amount);
      const amountCt = hexToBuffer(amountCtHex);

      // If recipient ATA doesn't exist, create it in its own tx first (session-scoped).
      const destInfo = await connection.getAccountInfo(destAta);
      if (!destInfo) {
        const ataTx = new Transaction();
        ataTx.add(
          ixCreateIdempotent({
            payer: cfg.facilitatorPubkey,
            ata: destAta,
            wallet: recipient,
            mint,
          })
        );
        ataTx.feePayer = cfg.facilitatorPubkey;
        ataTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        ataTx.partialSign(cfg.facilitatorKeypair);
        const ataSig = await connection.sendRawTransaction(
          ataTx.serialize({ requireAllSignatures: false, verifySignatures: false }),
          { skipPreflight: true }
        );
        await waitForTx(connection, ataSig, 30000);
      }

      // Bare transfer simulation (no remaining_accounts) — extract new source + dest handles.
      const preTx = new Transaction();
      preTx.add(
        ixTransfer({
          source: sourceAta,
          destination: destAta,
          authority: cfg.facilitatorPubkey,
          ciphertext: amountCt,
          sourceAllowancePda: null,
          sourceOwner: user,
          destAllowancePda: null,
          destOwner: recipient,
        })
      );
      preTx.feePayer = cfg.facilitatorPubkey;
      preTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      preTx.partialSign(cfg.facilitatorKeypair);

      const sim = await connection.simulateTransaction(preTx, undefined, [
        sourceAta,
        destAta,
      ]);
      if (sim.value.err) {
        throw new Error(
          `transfer simulation failed: ${JSON.stringify(sim.value.err)}`
        );
      }
      const sourceData = sim.value.accounts?.[0]?.data?.[0];
      const destData = sim.value.accounts?.[1]?.data?.[0];
      if (!sourceData || !destData) {
        throw new Error("simulation returned no account data");
      }
      const srcHandle = extractAmountHandle(sourceData);
      const dstHandle = extractAmountHandle(destData);
      const srcAllowance = getAllowancePda(srcHandle, user);
      const dstAllowance = getAllowancePda(dstHandle, recipient);

      // Real tx — just the transfer ix, with real allowance PDAs in remaining_accounts.
      const tx = new Transaction();
      tx.add(
        ixTransfer({
          source: sourceAta,
          destination: destAta,
          authority: cfg.facilitatorPubkey,
          ciphertext: amountCt,
          sourceAllowancePda: srcAllowance,
          sourceOwner: user,
          destAllowancePda: dstAllowance,
          destOwner: recipient,
        })
      );
      tx.feePayer = cfg.facilitatorPubkey;
      const { blockhash: bh2 } = await connection.getLatestBlockhash();
      tx.recentBlockhash = bh2;
      tx.partialSign(cfg.facilitatorKeypair);

      const serialized = tx
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString("base64");

      const txSig = await submitViaKoraOrFallback(
        kora,
        connection,
        serialized,
        cfg.facilitatorKeypair
      );
      await waitForTx(connection, txSig, 30000);

      return res.json({
        success: true,
        transaction: txSig,
        network,
        payer: session.user,
        extensions: {
          session: {
            id: session.id,
            spent: (BigInt(session.spent) + amount).toString(),
            remaining: (BigInt(session.cap) - BigInt(session.spent) - amount).toString(),
          },
        },
      });
    } catch (err) {
      const msg = (err as Error).message;
      console.error("[settle] error:", msg);
      if (debited) {
        try {
          storage.refund(sessionId, amount);
        } catch (refundErr) {
          console.error("[settle] refund also failed:", refundErr);
        }
      }
      const reason = msg.includes("session_expired")
        ? "session_expired"
        : msg.includes("cap_exceeded")
        ? "cap_exceeded"
        : msg.includes("simulation failed")
        ? "simulation_failed"
        : "onchain_transfer_failed";
      return res.status(400).json({
        success: false,
        transaction: "",
        network,
        errorReason: reason,
        errorMessage: msg,
      });
    }
  };
}
