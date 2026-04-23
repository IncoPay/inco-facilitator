// Mirror of inco-x402-sessions/src/types.ts (kept in-sync manually for now).
export type Network = "solana:devnet" | "solana:mainnet";

export interface PaymentRequirements {
  scheme: string;
  network: Network;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface SupportedKind {
  x402Version: 1 | 2;
  scheme: string;
  network: Network;
  asset?: string;
  extra?: Record<string, unknown>;
}

export interface SessionPaymentPayloadBody {
  sessionId: string;
  amount: string;
  nonce?: string;
}

export interface PaymentPayload {
  x402Version: 1 | 2;
  accepted: PaymentRequirements;
  payload: SessionPaymentPayloadBody;
  resource?: { url: string };
}

export interface CreateSessionBody {
  user: string;
  asset: string;
  recipient: string;
  cap: string;
  expirationUnix: number;
  network: Network;
  approveTxBase64: string;   // partially-signed (user as owner); we forward to Kora
  authMessage: string;       // base64 of canonical JSON
  authSignature: string;     // base64 of Ed25519 sig
}

export interface SessionRecord {
  id: string;
  user: string;
  spender: string;
  asset: string;
  recipient: string;
  cap: string;
  spent: string;
  expirationUnix: number;
  network: Network;
  approveTxSignature: string;
  authMessage: string;
  authSignature: string;
  createdAt: number;
}
