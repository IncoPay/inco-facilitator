import Database from "better-sqlite3";
import { SessionRecord } from "./types";

export class Storage {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id                   TEXT PRIMARY KEY,
        user                 TEXT NOT NULL,
        spender              TEXT NOT NULL,
        asset                TEXT NOT NULL,
        recipient            TEXT NOT NULL,
        cap                  TEXT NOT NULL,
        spent                TEXT NOT NULL DEFAULT '0',
        expiration_unix      INTEGER NOT NULL,
        network              TEXT NOT NULL,
        approve_tx_signature TEXT NOT NULL,
        auth_message         TEXT NOT NULL,
        auth_signature       TEXT NOT NULL,
        created_at           INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user);
      CREATE INDEX IF NOT EXISTS idx_sessions_spender ON sessions(spender);
    `);
  }

  insert(row: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO sessions
         (id, user, spender, asset, recipient, cap, spent, expiration_unix, network, approve_tx_signature, auth_message, auth_signature, created_at)
         VALUES (@id, @user, @spender, @asset, @recipient, @cap, @spent, @expirationUnix, @network, @approveTxSignature, @authMessage, @authSignature, @createdAt)`
      )
      .run(row as any);
  }

  get(id: string): SessionRecord | null {
    const row: any = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    if (!row) return null;
    return {
      id: row.id,
      user: row.user,
      spender: row.spender,
      asset: row.asset,
      recipient: row.recipient,
      cap: row.cap,
      spent: row.spent,
      expirationUnix: row.expiration_unix,
      network: row.network,
      approveTxSignature: row.approve_tx_signature,
      authMessage: row.auth_message,
      authSignature: row.auth_signature,
      createdAt: row.created_at,
    };
  }

  /**
   * Atomically add `amount` to session.spent. Throws if cap would be exceeded
   * or session is expired / missing.
   */
  debit(id: string, amount: bigint, nowUnix: number): SessionRecord {
    const tx = this.db.transaction((id: string, amount: bigint, nowUnix: number) => {
      const row: any = this.db
        .prepare("SELECT * FROM sessions WHERE id = ?")
        .get(id);
      if (!row) throw new Error("session_not_found");
      if (row.expiration_unix < nowUnix) throw new Error("session_expired");
      const newSpent = BigInt(row.spent) + amount;
      const cap = BigInt(row.cap);
      if (newSpent > cap) throw new Error("cap_exceeded");
      this.db
        .prepare("UPDATE sessions SET spent = ? WHERE id = ?")
        .run(newSpent.toString(), id);
      return { ...row, spent: newSpent.toString() };
    });
    const updated = tx(id, amount, nowUnix);
    return {
      id: updated.id,
      user: updated.user,
      spender: updated.spender,
      asset: updated.asset,
      recipient: updated.recipient,
      cap: updated.cap,
      spent: updated.spent,
      expirationUnix: updated.expiration_unix,
      network: updated.network,
      approveTxSignature: updated.approve_tx_signature,
      authMessage: updated.auth_message,
      authSignature: updated.auth_signature,
      createdAt: updated.created_at,
    };
  }

  /** Inverse of debit — called when on-chain settle fails. Clamps to 0. */
  refund(id: string, amount: bigint): void {
    this.db
      .prepare(
        `UPDATE sessions
           SET spent = CASE
             WHEN CAST(spent AS INTEGER) > ? THEN CAST(CAST(spent AS INTEGER) - ? AS TEXT)
             ELSE '0'
           END
         WHERE id = ?`
      )
      .run(Number(amount), Number(amount), id);
  }

  close(): void {
    this.db.close();
  }
}
