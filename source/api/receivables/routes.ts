import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/service';
import { parse } from '../master-data/service';
import { ReceivablesService } from './service';

export async function receivablesRoutes(app: FastifyInstance, auth: AuthService) {
  const service = new ReceivablesService(auth);
  const token = (request: FastifyRequest) => request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '';
  const id = (request: FastifyRequest) => parse(z.object({ id: z.uuid() }), request.params).id;
  const serviceId = (request: FastifyRequest) => parse(z.object({ serviceAccountId: z.uuid() }), request.params).serviceAccountId;
  // A receivable report and a disconnection notice are both sensitive and both move, so
  // nothing on these endpoints is cached.
  app.addHook('onSend', async (_, reply) => { reply.header('Cache-Control', 'no-store'); });
  const view = async (request: FastifyRequest) => { await auth.authorize(token(request), 'receivable.view'); };
  const control = async (request: FastifyRequest) => { await auth.authorize(token(request), 'service.control'); };

  app.get('/api/v1/receivables/summary', { preHandler: view }, request => service.summary(token(request), request.query));
  app.get('/api/v1/receivables/overdue', { preHandler: view }, request => service.list(token(request), request.query));

  app.get('/api/v1/service-control/policy', { preHandler: control }, request => service.getPolicy(token(request)));
  app.put('/api/v1/service-control/policy', { preHandler: control }, request => service.updatePolicy(token(request), request.body));
  app.get('/api/v1/service-control/technicians', { preHandler: control }, request => service.listTechnicians(token(request)));

  app.get('/api/v1/service-control/suspensions', { preHandler: control }, request => service.listSuspensions(token(request), request.query));
  app.get('/api/v1/service-control/suspensions/:id', { preHandler: control }, request => service.getSuspension(token(request), id(request)));
  app.post('/api/v1/service-control/services/:serviceAccountId/suspend', { preHandler: control }, request => service.suspend(token(request), serviceId(request), request.body));
  app.post('/api/v1/service-control/suspensions/:id/lift', { preHandler: control }, request => service.lift(token(request), id(request), request.body));

  // The reconnection steps hang off the suspension they answer, so a reconnection can never
  // be recorded against a disconnection that does not exist.
  app.post('/api/v1/service-control/suspensions/:id/reconnection', { preHandler: control }, request => service.requestReconnection(token(request), id(request), request.body));
  app.post('/api/v1/service-control/suspensions/:id/reconnection/assign', { preHandler: control }, request => service.assignTechnician(token(request), id(request), request.body));
  app.post('/api/v1/service-control/suspensions/:id/reconnection/complete', { preHandler: control }, request => service.completeReconnection(token(request), id(request), request.body));

  app.get('/api/v1/service-control/services/:serviceAccountId/history', { preHandler: control }, request => service.controlHistory(token(request), serviceId(request)));
}
