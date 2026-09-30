import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { AuthClient } from '../../source/desktop/main/auth-client';
import { InvoiceSchema, type Invoice } from '../../source/shared/billing';

const actor = { id: '11111111-1111-4111-8111-111111111111', username: 'owner', displayName: 'Owner', active: true, roles: ['OWNER'], permissions: ['billing.view', 'billing.generate'] };
const invoice: Invoice = {
  id: '22222222-2222-4222-8222-222222222222', invoiceNumber: 'INV-2026-1001', status: 'UNPAID', source: 'CYCLE',
  periodLabel: 'September 2026', issueDate: '2026-09-01', dueDate: '2026-09-15',
  subtotalCentavos: 99900, adjustmentCentavos: 0, totalCentavos: 99900, paidCentavos: 0, balanceCentavos: 99900,
  notes: '', voidReason: '', createdAt: '2026-09-01T00:00:00.000Z', finalizedAt: '2026-09-01T00:00:00.000Z', voidedAt: null,
  subscriberId: '33333333-3333-4333-8333-333333333333', subscriberCode: 'SUB-001', subscriberName: 'Billing Sample',
  serviceAccountId: '44444444-4444-4444-8444-444444444444', serviceCode: 'SVC-001', serviceAddress: 'Malaybalay billing address',
  cycleCode: '2026-09', items: [], adjustments: [],
};

async function withApi<T>(build: (api: ReturnType<typeof Fastify>, calls: string[]) => void, run: (client: AuthClient, calls: string[]) => Promise<T>) {
  const api = Fastify(); const calls: string[] = [];
  build(api, calls);
  const url = await api.listen({ host: '127.0.0.1', port: 0 });
  try { return await run(new AuthClient(url), calls); } finally { await api.close(); }
}

describe('billing desktop boundary', () => {
  it('sends the session token and returns only the figures the server decided', async () => {
    await withApi((api, calls) => {
      api.post('/api/v1/auth/login', () => ({ token: 'd'.repeat(64), user: actor }));
      api.get('/api/v1/billing/invoices', (request: { method: string; url: string; headers: Record<string, string | undefined> }, reply: { code(status: number): { send(body: unknown): unknown } }) => {
        calls.push(`${request.method} ${request.url} auth=${Boolean(request.headers.authorization)}`);
        if (request.headers.authorization !== `Bearer ${'d'.repeat(64)}`) return reply.code(401).send({ error: { message: 'Missing session' } });
        return { items: [invoice], total: 1, page: 1, perPage: 20 };
      });
    }, async (client) => {
      await client.login({ username: 'owner', password: 'synthetic-password' });
      const listed = await client.listBillingInvoices({ q: '', page: 1 });
      expect(listed).toEqual({ ok: true, data: { items: [invoice], total: 1, page: 1, perPage: 20 } });
    });
  });
  it('refuses a billing payload the shared contracts do not accept', async () => {
    await withApi((api) => {
      api.get('/api/v1/billing/invoices', () => ({ items: [{ ...invoice, totalCentavos: -1 }], total: 1, page: 1, perPage: 20 }));
    }, async (client) => {
      const listed = await client.listBillingInvoices({ page: 1 });
      expect(listed).toMatchObject({ ok: false, error: { status: 0 } });
    });
  });
  it('rejects an impossible document shape before the renderer can show it', async () => {
    expect(InvoiceSchema.safeParse({ ...invoice, status: 'REFUNDED' }).success).toBe(false);
    expect(InvoiceSchema.safeParse({ ...invoice, totalCentavos: 999.5 }).success).toBe(false);
  });
  it('validates the command in the main process instead of trusting the screen', async () => {
    await withApi((api) => {
      api.post('/api/v1/billing/runs', () => ({ ...invoice, cycleCode: '2026-09' }));
    }, async (client, calls) => {
      expect(await client.generateBillingRun({ period: '2026-13' })).toMatchObject({ ok: false, error: { status: 422 } });
      expect(await client.finalizeBillingInvoice('not-a-uuid', { reason: 'Issuing the monthly subscription' })).toMatchObject({ ok: false, error: { status: 422 } });
      expect(await client.adjustBillingInvoice(invoice.id, { adjustmentType: 'DEBIT', amountCentavos: -100, reason: 'Reversing a duplicate fee' })).toMatchObject({ ok: false, error: { status: 422 } });
      expect(await client.voidBillingInvoice(invoice.id, { reason: 'no' })).toMatchObject({ ok: false, error: { status: 422 } });
      expect(await client.getSubscriberLedger({ subscriberId: 'not-a-uuid' })).toMatchObject({ ok: false, error: { status: 422 } });
      expect(calls).toEqual([]);
    });
  });
});
