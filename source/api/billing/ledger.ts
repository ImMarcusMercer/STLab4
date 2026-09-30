import type pg from 'pg';
import { verifyRunningBalance, type LedgerEvent } from '../../shared/billing';

export type Client = pg.Pool | pg.PoolClient;
export type LedgerEntry = {
  subscriberId: string; entryDate: string; referenceType: string; description: string;
  debitCentavos: number; creditCentavos: number; actorId: string;
  serviceAccountId?: string | null; invoiceId?: string | null; referenceId?: string | null;
  referenceNumber?: string; reversalOfId?: string | null;
};

/** Serialises work that must not interleave, keyed by a stable text label. */
export const lock = (client: Client, scope: string) => client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`bcis:${scope}`]);

export function rebuildBalances(client: Client, subscriberId: string) {
  return client.query(
    `UPDATE ledger_entries l SET balance_centavos = expected.balance
     FROM (
       SELECT id,
         sum(debit_centavos - credit_centavos) OVER (ORDER BY entry_date, entry_no ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS balance
       FROM ledger_entries WHERE subscriber_id = $1
     ) expected
     WHERE l.id = expected.id AND l.balance_centavos <> expected.balance`,
    [subscriberId],
  );
}

/**
 * Appends one ledger line, then rebuilds every running balance of that subscriber in the
 * same transaction. A back-dated document therefore shifts the later balances instead of
 * leaving a gap, and the statement is always reproducible from its entries.
 */
export async function postLedgerEntry(client: Client, entry: LedgerEntry) {
  await lock(client, `ledger:${entry.subscriberId}`);
  const next = (await client.query('SELECT coalesce(max(entry_no),0)+1 AS next FROM ledger_entries WHERE subscriber_id=$1', [entry.subscriberId])).rows[0].next as number;
  const result = await client.query(
    `INSERT INTO ledger_entries(entry_no,subscriber_id,service_account_id,invoice_id,entry_date,reference_type,reference_id,reference_number,description,debit_centavos,credit_centavos,balance_centavos,reversal_of_id,actor_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,$12,$13) RETURNING id`,
    [next, entry.subscriberId, entry.serviceAccountId ?? null, entry.invoiceId ?? null, entry.entryDate, entry.referenceType,
      entry.referenceId ?? null, entry.referenceNumber ?? '', entry.description, entry.debitCentavos, entry.creditCentavos, entry.reversalOfId ?? null, entry.actorId],
  );
  await rebuildBalances(client, entry.subscriberId);
  return result.rows[0].id as string;
}

/** Fails loudly when the stored running balance cannot be reproduced from the entries. */
export async function assertLedgerConsistent(client: Client, subscriberId: string) {
  const entries = (await client.query(
    'SELECT entry_no AS "entryNo",to_char(entry_date,\'YYYY-MM-DD\') AS "entryDate",debit_centavos AS "debitCentavos",credit_centavos AS "creditCentavos",balance_centavos AS "balanceCentavos" FROM ledger_entries WHERE subscriber_id=$1 ORDER BY entry_date,entry_no',
    [subscriberId],
  )).rows as unknown as LedgerEvent[];
  return verifyRunningBalance(entries).differences;
}
