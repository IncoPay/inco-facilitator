import { Request, Response } from "express";
import { Connection, PublicKey } from "@solana/web3.js";
import { v4 as uuid } from "uuid";
import nacl from "tweetnacl";
import { FacilitatorConfig } from "../config";
import { Storage } from "../storage";
import { CreateSessionBody, SessionRecord } from "../types";
import {
  KoraClient,
  submitViaKoraOrFallback,
  waitForTx,
} from "../solana";

export function createSessionRoute(
  cfg: FacilitatorConfig,
  storage: Storage,
  connection: Connection,
  kora: KoraClient
) {
  return async (req: Request, res: Response) => {
    try {
      const body = req.body as CreateSessionBody;
      const required: Array<keyof CreateSessionBody> = [
        "user",
        "asset",
        "recipient",
        "cap",
        "expirationUnix",
        "network",
        "approveTxBase64",
        "authMessage",
        "authSignature",
      ];
      for (const k of required) {
        if (!(k in body) || body[k] == null)
          return res.status(400).json({ error: `missing_${k}` });
      }
      if (body.network !== cfg.network) {
        return res
          .status(400)
          .json({ error: "network_mismatch", expected: cfg.network });
      }

      // 1. Verify the auth message signature (Ed25519 over the canonical JSON)
      const messageText = Buffer.from(body.authMessage, "base64").toString("utf8");
      const sig = Buffer.from(body.authSignature, "base64");
      const userPubkey = new PublicKey(body.user);
      const ok = nacl.sign.detached.verify(
        Buffer.from(messageText, "utf8"),
        sig,
        userPubkey.toBytes()
      );
      if (!ok) return res.status(400).json({ error: "invalid_auth_signature" });

      // 2. Cross-check auth message fields match the body fields
      let parsed: any;
      try {
        parsed = JSON.parse(messageText);
      } catch {
        return res.status(400).json({ error: "auth_message_not_json" });
      }
      const mustMatch: Array<[string, unknown]> = [
        ["user", body.user],
        ["spender", cfg.facilitatorPubkey.toBase58()],
        ["asset", body.asset],
        ["recipient", body.recipient],
        ["cap", body.cap],
        ["expirationUnix", body.expirationUnix],
        ["network", body.network],
      ];
      for (const [k, v] of mustMatch) {
        if (parsed[k] !== v)
          return res
            .status(400)
            .json({ error: `auth_message_field_mismatch_${k}` });
      }
      if (!parsed.nonce || typeof parsed.nonce !== "string") {
        return res.status(400).json({ error: "auth_message_missing_nonce" });
      }

      // 3. Submit the approve tx via Kora (fallback: facilitator's keypair as fee payer)
      let approveSig: string;
      try {
        approveSig = await submitViaKoraOrFallback(
          kora,
          connection,
          body.approveTxBase64,
          cfg.facilitatorKeypair
        );
        await waitForTx(connection, approveSig, 30000);
      } catch (err) {
        return res.status(400).json({
          error: "approve_submit_failed",
          message: (err as Error).message,
        });
      }

      // 4. Store session
      const nowUnix = Math.floor(Date.now() / 1000);
      if (body.expirationUnix <= nowUnix) {
        return res.status(400).json({ error: "expiration_in_past" });
      }
      const row: SessionRecord = {
        id: uuid(),
        user: body.user,
        spender: cfg.facilitatorPubkey.toBase58(),
        asset: body.asset,
        recipient: body.recipient,
        cap: body.cap,
        spent: "0",
        expirationUnix: body.expirationUnix,
        network: body.network,
        approveTxSignature: approveSig,
        authMessage: body.authMessage,
        authSignature: body.authSignature,
        createdAt: nowUnix,
      };
      storage.insert(row);
      return res.status(201).json({
        sessionId: row.id,
        user: row.user,
        spender: row.spender,
        asset: row.asset,
        recipient: row.recipient,
        cap: row.cap,
        spent: row.spent,
        expirationUnix: row.expirationUnix,
        network: row.network,
        approveTxSignature: row.approveTxSignature,
      });
    } catch (err) {
      console.error("[sessions] error", err);
      return res
        .status(500)
        .json({ error: "internal_error", message: (err as Error).message });
    }
  };
}

export function getSessionRoute(storage: Storage) {
  return (req: Request, res: Response) => {
    const row = storage.get(req.params.id);
    if (!row) return res.status(404).json({ error: "session_not_found" });
    return res.json(row);
  };
}
