import express from "express";
import cors from "cors";
import { Connection } from "@solana/web3.js";
import { loadConfig } from "./config";
import { Storage } from "./storage";
import { makeKoraClient } from "./solana";
import { supportedRoute } from "./routes/supported";
import {
  createSessionRoute,
  getSessionRoute,
} from "./routes/sessions";
import { verifyRoute } from "./routes/verify";
import { settleRoute } from "./routes/settle";
import { payGetAmountRoute } from "./routes/pay-getAmount";
import { payVerifyRoute } from "./routes/pay-verify";
import { paySettleRoute } from "./routes/pay-settle";

async function main() {
  const cfg = loadConfig();
  const storage = new Storage(cfg.dbPath);
  const connection = new Connection(cfg.solanaRpcUrl, "confirmed");
  const kora = makeKoraClient(cfg.koraRpcUrl, cfg.koraApiKey);

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      address: cfg.facilitatorPubkey.toBase58(),
      network: cfg.network,
      tokenMint: cfg.tokenMint?.toBase58() ?? null,
    });
  });

  app.get("/supported", supportedRoute(cfg));
  app.post("/sessions", createSessionRoute(cfg, storage, connection, kora));
  app.get("/sessions/:id", getSessionRoute(storage));
  app.post("/verify", verifyRoute(cfg, storage));
  app.post("/settle", settleRoute(cfg, storage, connection, kora));

  // Single-payment "Pay 1 INCO" demo (used by IncoPay /started). Namespaced
  // under /pay so it doesn't collide with the session-scheme /verify /settle.
  app.post("/pay/getAmount", payGetAmountRoute());
  app.get("/pay/getAmount", (_req, res) =>
    res.json({
      endpoint: "/pay/getAmount",
      description: "POST { amount, decimals } to get ECIES ciphertext",
    })
  );
  app.post("/pay/verify", payVerifyRoute());
  app.post("/pay/settle", paySettleRoute(cfg, connection));

  app.listen(cfg.port, () => {
    console.log(
      `inco-facilitator listening on :${cfg.port}\n` +
        `  spender:  ${cfg.facilitatorPubkey.toBase58()}\n` +
        `  network:  ${cfg.network}\n` +
        `  rpc:      ${cfg.solanaRpcUrl}\n` +
        `  kora:     ${cfg.koraRpcUrl}\n` +
        `  mint:     ${cfg.tokenMint?.toBase58() ?? "(unset — set TOKEN_MINT after deploy)"}`
    );
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
