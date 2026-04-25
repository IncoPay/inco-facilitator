/**
 * /pay/getAmount — Single-payment helper for the IncoPay /started demo.
 *
 * Returns ECIES ciphertext for a plain-amount payment. The ciphertext is
 * what the user signs as part of their authorization message and what the
 * IncoToken `transfer_with_authorization` instruction consumes.
 *
 * Ported from IncoPay/app/facilator/server.ts. No Kora dependency.
 */
import { Request, Response } from "express";
import { encryptValue } from "../solana";

export function payGetAmountRoute() {
  return async (req: Request, res: Response) => {
    try {
      const amount = Number(req.body?.amount ?? req.query?.amount ?? 1);
      const decimals = Number(req.body?.decimals ?? req.query?.decimals ?? 9);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: "Invalid amount" });
      }
      if (!Number.isFinite(decimals) || decimals < 0) {
        return res.status(400).json({ error: "Invalid decimals" });
      }
      const amountRaw = BigInt(Math.floor(amount * Math.pow(10, decimals)));
      const ciphertext = await encryptValue(amountRaw);
      return res.json({ ciphertext, amount, decimals });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "encryption failed";
      console.error("[pay/getAmount] error:", msg);
      return res.status(500).json({ error: msg });
    }
  };
}
