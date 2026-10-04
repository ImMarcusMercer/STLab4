import type { FastifyInstance, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { LoginInput, NewUserInput, UpdateUserInput } from '../../shared/auth';
import { ApiError } from './errors';
import type { AuthService } from './service';

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(422, 'VALIDATION', 'Check the highlighted fields.', z.flattenError(result.error).fieldErrors as Record<string, string[]>);
  return result.data;
}
const token = (request: FastifyRequest) => request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '';
const Pagination = z.object({ page: z.coerce.number().int().min(1).max(1000000).default(1), perPage: z.coerce.number().int().min(1).max(100).default(20) });

export async function authRoutes(app: FastifyInstance, auth: AuthService) {
  await app.register(rateLimit, { global: false });
  app.addHook('onSend', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); });
  app.post('/api/v1/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    const input = parse(LoginInput, request.body);
    try {
      const session = await auth.login(input.username, input.password);
      // The username is the point of the line; the password and the issued token are not
      // logged at all, on either outcome. A refused sign-in is the line an operator looks
      // for when a cashier cannot get in.
      request.log.info({ event: 'auth.login.succeeded', username: input.username }, 'Signed in');
      return session;
    } catch (error) {
      request.log.warn({ event: 'auth.login.failed', username: input.username, code: (error as ApiError).code ?? 'ERROR' }, 'Sign-in refused');
      throw error;
    }
  });
  app.get('/api/v1/auth/me', (request) => auth.authorize(token(request)));
  for (const action of ['logout', 'lock'] as const) {
    app.post(`/api/v1/auth/${action}`, async (request, reply) => {
      await auth.revoke(token(request), `auth.${action}`);
      request.log.info({ event: 'auth.session.revoked', action }, 'Session ended');
      return reply.code(204).send();
    });
  }
  const ownerOnly = async (request: FastifyRequest) => { await auth.authorize(token(request), 'user.manage'); };
  app.get('/api/v1/admin/users', { preHandler: ownerOnly }, async (request) => {
    const query = parse(Pagination, request.query);
    return auth.listUsers(token(request), query.page, query.perPage);
  });
  app.post('/api/v1/admin/users', { preHandler: ownerOnly }, async (request, reply) => {
    const user = await auth.createUser(token(request), parse(NewUserInput, request.body));
    return reply.code(201).send(user);
  });
  app.patch('/api/v1/admin/users/:id', { preHandler: ownerOnly }, async (request) => {
    const { id } = parse(z.object({ id: z.uuid() }), request.params);
    return auth.updateUser(token(request), id, parse(UpdateUserInput, request.body));
  });
}
