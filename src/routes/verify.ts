import { Request, Response } from "express";
import { FacilitatorConfig } from "../config";
import { Storage } from "../storage";
import { PaymentPayload, PaymentRequirements } from "../types";

export function verifyRoute(cfg: FacilitatorConfig, storage: Storage) {
  return (req: Request, res: Response) => {
    try {
      const { paymentPayload, paymentRequirements } = req.body as {
        paymentPayload: PaymentPayload;
        paymentRequirements: PaymentRequirements;
      };
      if (!paymentPayload || !paymentRequirements) {
        return res.json({ isValid: false, invalidReason: "bad_request" });
      }
      if (paymentRequirements.scheme !== "session") {
        return res.json({
          isValid: false,
          invalidReason: "scheme_mismatch",
          invalidMessage: `expected session, got ${paymentRequirements.scheme}`,
        });
      }
      if (paymentRequirements.network !== cfg.network) {
        return res.json({
          isValid: false,
          invalidReason: "network_mismatch",
        });
      }
      const sessionId = paymentPayload.payload?.sessionId;
      if (!sessionId)
        return res.json({ isValid: false, invalidReason: "missing_session_id" });

      const session = storage.get(sessionId);
      if (!session)
        return res.json({ isValid: false, invalidReason: "session_not_found" });

      if (session.asset !== paymentRequirements.asset)
        return res.json({ isValid: false, invalidReason: "asset_mismatch" });
      if (session.recipient !== paymentRequirements.payTo)
        return res.json({ isValid: false, invalidReason: "recipient_mismatch" });
      if (session.network !== paymentRequirements.network)
        return res.json({
          isValid: false,
          invalidReason: "session_network_mismatch",
        });

      const nowUnix = Math.floor(Date.now() / 1000);
      if (session.expirationUnix < nowUnix) {
        return res.json({ isValid: false, invalidReason: "session_expired" });
      }

      const amount = BigInt(paymentRequirements.amount);
      if (amount <= 0n)
        return res.json({ isValid: false, invalidReason: "invalid_amount" });

      const maxPerCallBase = decimalToBaseUnits(
        cfg.maxPerCall,
        cfg.assetDecimals
      );
      if (amount > maxPerCallBase) {
        return res.json({
          isValid: false,
          invalidReason: "per_call_limit_exceeded",
          invalidMessage: `${amount} exceeds per-call cap ${maxPerCallBase}`,
        });
      }

      const cap = BigInt(session.cap);
      const spent = BigInt(session.spent);
      if (spent + amount > cap) {
        return res.json({
          isValid: false,
          invalidReason: "cap_exceeded",
          invalidMessage: `would debit ${amount} with ${spent}/${cap} spent`,
        });
      }

      return res.json({ isValid: true, payer: session.user });
    } catch (err) {
      console.error("[verify] error", err);
      return res.status(500).json({
        isValid: false,
        invalidReason: "internal_error",
        invalidMessage: (err as Error).message,
      });
    }
  };
}

function decimalToBaseUnits(amount: string, decimals: number): bigint {
  const [whole, frac = ""] = amount.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  const s = (whole || "0") + padded;
  return BigInt(s.replace(/^0+(?=\d)/, "") || "0");
}
