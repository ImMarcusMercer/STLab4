import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/service';
import { parse } from '../master-data/service';
import { PaymentService } from './service';

export async function paymentRoutes(app: FastifyInstance, auth: AuthService) {
  const service = new PaymentService(auth);
  const token = (request: FastifyRequest) => request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '';
  const id = (request: FastifyRequest) => parse(z.object({ id: z.uuid() }), request.params).id;
  // A payment, its receipt and its proof are financial records, so nothing is cached and
  // the proof upload is the one request allowed a body larger than the ordinary limit.
  app.addHook('onSend', async (_, reply) => { reply.header('Cache-Control', 'no-store'); });
  const view = async (request: FastifyRequest) => { await auth.authorize(token(request), 'payment.view'); };
  const create = async (request: FastifyRequest) => { await auth.authorize(token(request), 'payment.create'); };
  const verify = async (request: FastifyRequest) => { await auth.authorize(token(request), 'payment.verify'); };
  const reverse = async (request: FastifyRequest) => { await auth.authorize(token(request), 'payment.reverse'); };

  app.get('/api/v1/payments', { preHandler: view }, request => service.list(token(request), request.query));
  app.get('/api/v1/payments/account', { preHandler: view }, request => service.account(token(request), request.query));
  app.get('/api/v1/payments/:id', { preHandler: view }, request => service.get(token(request), id(request)));
  app.get('/api/v1/payments/:id/proof', { preHandler: view }, request => service.proof(token(request), id(request)));

  app.post('/api/v1/payments', { preHandler: create, bodyLimit: 8_000_000 }, async (request, reply) => reply.code(201).send(await service.record(token(request), request.body)));
  app.post('/api/v1/payments/:id/verify', { preHandler: verify }, request => service.verify(token(request), id(request), request.body));
  app.post('/api/v1/payments/:id/void', { preHandler: create }, request => service.voidPayment(token(request), id(request), request.body));
  app.post('/api/v1/payments/:id/reverse', { preHandler: reverse }, request => service.reverse(token(request), id(request), request.body));
}
