import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/service';
import { parse } from '../master-data/service';
import { CollectionService } from './service';

export async function collectionRoutes(app: FastifyInstance, auth: AuthService) {
  const service = new CollectionService(auth);
  const token = (request: FastifyRequest) => request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '';
  const id = (request: FastifyRequest) => parse(z.object({ id: z.uuid() }), request.params).id;
  // A collection sheet and a remittance are financial records, so nothing is cached.
  app.addHook('onSend', async (_, reply) => { reply.header('Cache-Control', 'no-store'); });
  const view = async (request: FastifyRequest) => { await auth.authorize(token(request), 'collection.view'); };
  const manage = async (request: FastifyRequest) => { await auth.authorize(token(request), 'collection.manage'); };
  const reconcile = async (request: FastifyRequest) => { await auth.authorize(token(request), 'collection.reconcile'); };

  app.get('/api/v1/collections/batches', { preHandler: view }, request => service.list(token(request), request.query));
  app.get('/api/v1/collections/batches/:id', { preHandler: view }, request => service.get(token(request), id(request)));
  app.get('/api/v1/collections/batches/:id/route-sheet', { preHandler: view }, request => service.routeSheet(token(request), id(request)));

  app.post('/api/v1/collections/batches', { preHandler: manage }, async (request, reply) => reply.code(201).send(await service.create(token(request), request.body)));
  app.post('/api/v1/collections/batches/:id/start', { preHandler: manage }, request => service.start(token(request), id(request)));
  app.post('/api/v1/collections/batches/:id/submit', { preHandler: manage }, request => service.submit(token(request), id(request), request.body));
  app.post('/api/v1/collections/batches/:id/remittance', { preHandler: manage }, request => service.remit(token(request), id(request), request.body));
  // Reconciliation is a second signature, so it needs its own permission and the person who
  // counted the money is refused even with it.
  app.post('/api/v1/collections/batches/:id/reconcile', { preHandler: reconcile }, request => service.reconcile(token(request), id(request), request.body));
  app.post('/api/v1/collections/batches/:id/close', { preHandler: reconcile }, request => service.close(token(request), id(request), request.body));
}
