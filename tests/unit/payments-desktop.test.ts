import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { AuthClient } from '../../source/desktop/main/auth-client';
import { PaymentSchema, type Payment, type PaymentResult } from '../../source/shared/payments';

const actor = { id: '11111111-1111-4111-8111-111111111111', username: 'cashier', displayName: 'Cashier', active: true, roles: ['CASHIER'], permissions: ['payment.view', 'payment.create', 'payment.verify'] };
const subscriberId = '33333333-3333-4333-8333-333333333333';
const invoiceId = '55555555-5555-4555-8555-555555555555';

const payment: Payment = {
  id: '22222222-2222-4222-8222-222222222222', receiptNumber: 'RCT-2026-1001', method: 'CASH', status: 'POSTED', direction: 'PAYMENT',
  amountCentavos: 199900, receivedOn: '2026-09-30', referenceNumber: null, notes: '', reason: '',
  subscriberId, subscriberCode: 'SUB-001', subscriberName: 'Payment Sample', appliedCentavos: 199900, advanceCentavos: 0,
  reversalOfId: null, reversalOfReceipt: null, recordedBy: actor.id, recordedName: 'Cashier',
  verifiedBy: null, verifiedName: null, verifiedAt: null, voidedAt: null, voidReason: '', proof: null, createdAt: '2026-09-30T00:00:00.000Z',
};
const result: PaymentResult = {
  payment, allocatedCentavos: 199900, advanceCentavos: 0,
  touched: [{ invoiceId, invoiceNumber: 'INV-2026-1001', appliedCentavos: 199900, balanceCentavos: 0, status: 'PAID' }],
};

async function withApi<T>(build: (api: ReturnType<typeof Fastify>, calls: string[]) => void, run: (client: AuthClient, calls: string[]) => Promise<T>) {
  const api = Fastify(); const calls: string[] = [];
  build(api, calls);
  const url = await api.listen({ host: '127.0.0.1', port: 0 });
  try { return await run(new AuthClient(url), calls); } finally { await api.close(); }
}

const recordBody = { subscriberId, method: 'CASH', amountCentavos: 199900, receivedOn: '2026-09-30', notes: '' };

describe('payment desktop boundary', () => {
  it('sends the session token and returns only the allocation the server decided', async () => {
    await withApi((api, calls) => {
      api.post('/api/v1/auth/login', () => ({ token: 'd'.repeat(64), user: actor }));
      api.post('/api/v1/payments', (request: { method: string; url: string; headers: Record<string, string | undefined>; body: unknown }, reply: { code(status: number): { send(body: unknown): unknown } }) => {
        calls.push(`${request.method} ${request.url} auth=${Boolean(request.headers.authorization)} amount=${(request.body as { amountCentavos: number }).amountCentavos}`);
        if (request.headers.authorization !== `Bearer ${'d'.repeat(64)}`) return reply.code(401).send({ error: { message: 'Missing session' } });
        return result;
      });
    }, async (client) => {
      await client.login({ username: 'cashier', password: 'synthetic-password' });
      const recorded = await client.recordPayment(recordBody);
      expect(recorded).toEqual({ ok: true, data: result });
    });
  });

  it('refuses a payment payload the shared contracts do not accept', async () => {
    await withApi((api) => { api.get('/api/v1/payments', () => ({ items: [{ ...payment, amountCentavos: 1999.5 }], total: 1, page: 1, perPage: 20 })); },
      async (client) => { expect(await client.listPayments({ page: 1 })).toMatchObject({ ok: false, error: { status: 0 } }); });
  });

  it('rejects an impossible payment shape before the renderer can show it', () => {
    expect(PaymentSchema.safeParse({ ...payment, status: 'REFUNDED' }).success).toBe(false);
    expect(PaymentSchema.safeParse({ ...payment, receiptNumber: 'RCT-2026-0001' }).success).toBe(true);
    expect(PaymentSchema.safeParse({ ...payment, method: 'BANK_TRANSFER' }).success).toBe(false);
    expect(PaymentSchema.safeParse({ ...payment, appliedCentavos: -1 }).success).toBe(false);
  });

  it('validates every payment command in the main process instead of trusting the screen', async () => {
    await withApi((api, calls) => {
      api.post('/api/v1/auth/login', () => ({ token: 'd'.repeat(64), user: actor }));
      const reached = (request: { method: string; url: string; headers: Record<string, string | undefined> }) => {
        calls.push(`${request.method} ${request.url} auth=${Boolean(request.headers.authorization)}`);
      };
      api.post('/api/v1/payments', (request: { method: string; url: string; headers: Record<string, string | undefined> }, reply: { code(status: number): { send(body: unknown): unknown } }) => {
        reached(request);
        if (request.headers.authorization !== `Bearer ${'d'.repeat(64)}`) return reply.code(401).send({ error: { message: 'Missing session' } });
        return result;
      });
      api.post('/api/v1/payments/:id/verify', (request: { method: string; url: string; headers: Record<string, string | undefined> }) => { reached(request); return result; });
      api.post('/api/v1/payments/:id/void', (request: { method: string; url: string; headers: Record<string, string | undefined> }) => { reached(request); return payment; });
      api.post('/api/v1/payments/:id/reverse', (request: { method: string; url: string; headers: Record<string, string | undefined> }) => { reached(request); return result; });
      api.get('/api/v1/payments/:id/proof', () => ({ fileName: 'gcash.png', mimeType: 'image/png', byteSize: 68, base64: 'aGVsbG8=' }));
    }, async (client, calls) => {
      await client.login({ username: 'cashier', password: 'synthetic-password' });
      calls.length = 0;
      const gcash = { subscriberId, method: 'GCASH', amountCentavos: 50000, receivedOn: '2026-09-30', referenceNumber: 'GC-123456', notes: '' };
      expect(await client.recordPayment({ ...gcash })).toMatchObject({ ok: false, error: { status: 422 } });
      expect(await client.recordPayment({ ...gcash, proof: { fileName: 'x.exe', mimeType: 'application/x-msdownload', base64: 'aGVsbG8=' } })).toMatchObject({ ok: false, error: { status: 422 } });
      expect(await client.recordPayment({ ...gcash, proof: { fileName: 'ok.png', mimeType: 'image/png', base64: 'aGVsbG8=' }, referenceNumber: 'gc ref!' })).toMatchObject({ ok: false, error: { status: 422 } });
      expect(await client.recordPayment({ ...recordBody, referenceNumber: 'GC-123456' })).toMatchObject({ ok: false, error: { status: 422 } });
      expect(await client.recordPayment({ ...recordBody, amountCentavos: 0 })).toMatchObject({ ok: false, error: { status: 422 } });
      expect(await client.recordPayment({ ...recordBody, amountCentavos: 1999.5 })).toMatchObject({ ok: false, error: { status: 422 } });
      expect(await client.recordPayment({ ...recordBody, receivedOn: '2026-02-31' })).toMatchObject({ ok: false, error: { status: 422 } });
      expect(await client.getSubscriberAccount('not-a-uuid')).toMatchObject({ ok: false, error: { status: 422 } });
      expect(await client.getPayment('not-a-uuid')).toMatchObject({ ok: false, error: { status: 422 } });
      expect(await client.getPaymentProof('not-a-uuid')).toMatchObject({ ok: false, error: { status: 422 } });
      expect(await client.voidPayment(payment.id, { reason: 'no' })).toMatchObject({ ok: false, error: { status: 422 } });
      expect(await client.reversePayment(payment.id, { reason: '' })).toMatchObject({ ok: false, error: { status: 422 } });
      expect(calls).toEqual([]);
      expect(await client.verifyPayment(payment.id, { notes: 'reference matches the receipt' })).toMatchObject({ ok: true });
      expect(await client.reversePayment(payment.id, { reason: 'Collector entered the wrong subscriber' })).toMatchObject({ ok: true });
      expect(calls).toEqual([
        `POST /api/v1/payments/${payment.id}/verify auth=true`,
        `POST /api/v1/payments/${payment.id}/reverse auth=true`,
      ]);
    });
  });

  it('reads a GCash receipt back as bytes, never as a path on the server', async () => {
    await withApi((api) => {
      api.get('/api/v1/payments/:id/proof', () => ({ fileName: 'gcash.png', mimeType: 'image/png', byteSize: 68, base64: 'aGVsbG8=' }));
    }, async (client) => {
      const proof = await client.getPaymentProof(payment.id);
      expect(proof).toEqual({ ok: true, data: { fileName: 'gcash.png', mimeType: 'image/png', byteSize: 68, base64: 'aGVsbG8=' } });
    });
  });

  it('refuses a proof response that leaks a filesystem path', async () => {
    await withApi((api) => { api.get('/api/v1/payments/:id/proof', () => ({ fileName: 'C:\\bcis\\proofs\\a.png', mimeType: 'image/png', byteSize: 68, base64: 'aGVsbG8=' })); },
      async (client) => {
        const proof = await client.getPaymentProof(payment.id);
        expect(proof).toMatchObject({ ok: false, error: { status: 0 } });
        await expect(PaymentSchema.shape.proof.safeParse({ id: '66666666-6666-4666-8666-666666666666', originalName: 'a.png', storedName: 'C:\\proofs\\a.png', mimeType: 'image/png', byteSize: 68, sha256: 'a'.repeat(64), uploadedAt: '2026-09-30T00:00:00.000Z' }).success).toBe(false);
      });
  });
});
