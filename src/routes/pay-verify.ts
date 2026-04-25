/**
 * /pay/verify — Single-payment Ed25519 signature verification for the
 * IncoPay /started demo.
 *
 * Confirms the user signed the authorization message off-chain. Ported from
 * IncoPay/app/facilator/server.ts. Independent of the session-scheme /verify
 * route (which is x402 session-based).
 */
import { Request, Response } from "express";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";

export function payVerifyRoute() {
  return (req: Request, res: Response) => {
    try {
      const { paymentPayload, paymentRequirements } = req.body as {
        paymentPayload?: { payload?: Record<string, unknown> };
        paymentRequirements?: { network?: string };
      };

      if (!paymentRequirements?.network?.startsWith("solana:")) {
        return res
          .status(400)
          .json({ isValid: false, invalidReason: "Invalid network" });
      }

      const payload = paymentPayload?.payload ?? {};
      const signature = payload.signature as string | undefined;
      const message = payload.message as string | undefined;
      const payer = payload.payer as string | undefined;
      const ciphertext = payload.ciphertext as string | undefined;

      if (!signature || !message || !payer) {
        return res.status(400).json({
          isValid: false,
          invalidReason: "Missing signature/message/payer",
        });
      }

      const messageBytes = new TextEncoder().encode(message);
      let sigBuf: Buffer = Buffer.isBuffer(signature)
        ? (signature as Buffer)
        : Buffer.from(signature, signature.length === 128 ? "hex" : "base64");
      if (sigBuf.length > 64) sigBuf = sigBuf.subarray(0, 64);
      if (sigBuf.length < 64) {
        return res.status(400).json({
          isValid: false,
          invalidReason: "Invalid signature length",
        });
      }
      const signatureBytes = new Uint8Array(sigBuf);

      const payerPubkey = new PublicKey(payer);
      const valid = nacl.sign.detached.verify(
        messageBytes,
        signatureBytes,
        payerPubkey.toBytes()
      );
      if (!valid) {
        return res
          .status(400)
          .json({ isValid: false, invalidReason: "Invalid signature" });
      }

      // Optional sanity check: message references the ciphertext prefix used
      // by the client. Mirrors the old facilitator behaviour.
      if (ciphertext && !message.includes(ciphertext.substring(0, 32))) {
        return res.status(400).json({
          isValid: false,
          invalidReason: "Message does not match ciphertext",
        });
      }

      return res.json({ isValid: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "verify failed";
      console.error("[pay/verify] error:", msg);
      return res
        .status(400)
        .json({ isValid: false, invalidReason: msg });
    }
  };
}
