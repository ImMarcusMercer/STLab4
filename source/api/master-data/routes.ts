import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { masterInputs, type Resource } from '../../shared/master-data';
import type { AuthService } from '../auth/service';
import { MasterService, parse } from './service';

export async function masterRoutes(app: FastifyInstance, auth: AuthService) {
  const service = new MasterService(auth);
  const token = (request: FastifyRequest) => request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '';
  const id = (request: FastifyRequest) => parse(z.object({ id: z.uuid() }), request.params).id;
  app.addHook('onSend', async (_, reply) => { reply.header('Cache-Control','no-store'); });
  for (const resource of Object.keys(masterInputs) as Resource[]) {
    const url = `/api/v1/${resource}`;
    const read = async (request: FastifyRequest) => { await service.authorize(resource,token(request)); };
    const write = async (request: FastifyRequest) => { await service.authorize(resource,token(request),true); };
    app.get(url, { preHandler: read }, request => service.list(resource,token(request),request.query));
    app.get(`${url}/:id`, { preHandler: read }, request => service.get(resource,token(request),id(request)));
    app.get(`${url}/:id/history`, { preHandler: read }, request => service.history(resource,token(request),id(request),request.query));
    app.post(url, { preHandler: write }, async (request,reply) => reply.code(201).send(await service.save(resource,token(request),null,request.body)));
    app.put(`${url}/:id`, { preHandler: write }, request => service.save(resource,token(request),id(request),request.body));
    if (resource === 'services' || resource === 'subscribers') app.patch(`${url}/:id/assignment`, { preHandler: async request => { await auth.authorize(token(request),'collection.manage'); } }, request => service.save(resource,token(request),id(request),request.body,true));
  }
}
