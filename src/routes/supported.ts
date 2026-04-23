import { Request, Response } from "express";
import { FacilitatorConfig } from "../config";

export function supportedRoute(cfg: FacilitatorConfig) {
  return (_req: Request, res: Response) => {
    const base = {
      scheme: "session",
      network: cfg.network,
      asset: cfg.tokenMint?.toBase58(),
      extra: {
        facilitatorAddress: cfg.facilitatorPubkey.toBase58(),
        spender: cfg.facilitatorPubkey.toBase58(),
        sessionsEndpoint: "/sessions",
        decimals: cfg.assetDecimals,
      },
    };
    res.json({
      kinds: [
        { x402Version: 2, ...base },
        { x402Version: 1, ...base },
      ],
    });
  };
}
