import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/service';
import { BillingService } from './service';
import { parse } from '../master-data/service';

export async function billingRoutes(app: FastifyInstance, auth: AuthService) {
  const service = new BillingService(auth);
  const token = (request: FastifyRequest) => request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '';
  const id = (request: FastifyRequest) => parse(z.object({ id: z.uuid() }), request.params).id;
  // Billing documents are financial records, so no response is ever cached.
  app.addHook('onSend', async (_, reply) => { reply.header('Cache-Control', 'no-store'); });
  const view = async (request: FastifyRequest) => { await auth.authorize(token(request), 'billing.view'); };
  const generate = async (request: FastifyRequest) => { await auth.authorize(token(request), 'billing.generate'); };

  app.get('/api/v1/billing/invoices', { preHandler: view }, request => service.listInvoices(token(request), request.query));
  app.get('/api/v1/billing/invoices/:id', { preHandler: view }, request => service.getInvoice(token(request), id(request)));
  app.get('/api/v1/billing/runs', { preHandler: view }, request => service.listRuns(token(request), request.query));
  app.get('/api/v1/billing/cycles', { preHandler: view }, request => service.listCycles(token(request)));
  app.get('/api/v1/billing/ledger', { preHandler: view }, request => service.ledger(token(request), request.query));

  app.post('/api/v1/billing/invoices', { preHandler: generate }, async (request, reply) => reply.code(201).send(await service.createDraft(token(request), request.body)));
  app.put('/api/v1/billing/invoices/:id/items', { preHandler: generate }, request => service.replaceDraftItems(token(request), id(request), request.body));
  app.post('/api/v1/billing/invoices/:id/finalize', { preHandler: generate }, request => service.finalize(token(request), id(request), request.body));
  app.post('/api/v1/billing/invoices/:id/adjustments', { preHandler: generate }, request => service.adjust(token(request), id(request), request.body));
  app.post('/api/v1/billing/invoices/:id/void', { preHandler: generate }, request => service.voidInvoice(token(request), id(request), request.body));
  app.post('/api/v1/billing/runs', { preHandler: generate }, request => service.generate(token(request), request.body));
  app.post('/api/v1/billing/overdue-sweep', { preHandler: generate }, request => service.overdueSweep(token(request), request.body));
}
