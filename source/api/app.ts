import Fastify, { type FastifyError } from 'fastify';
import type { SystemStatus } from '../shared/contracts';
import type { AuthService } from './auth/service';
import { authRoutes } from './auth/routes';
import { ApiError } from './auth/errors';
import { masterRoutes } from './master-data/routes';
import { billingRoutes } from './billing/routes';
import { paymentRoutes } from './payments/routes';
import { collectionRoutes } from './collections/routes';

export function buildApp(options: { checkDatabase: () => Promise<void>; logLevel?: string; auth?: AuthService }) {
  const app = Fastify({
    logger: options.logLevel ? {
      level: options.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'password', 'DATABASE_URL'],
    } : false,
    bodyLimit: 1_048_576,
    requestTimeout: 10_000,
  });

  app.get('/health', async () => ({ status: 'ok', service: 'bcis-api' }));
  app.get('/api/v1/system/status', async (request, reply) => {
    let status: SystemStatus;
    try {
      await options.checkDatabase();
      status = { status: 'ready', database: 'connected', service: 'bcis-api', version: '0.1.0' };
    } catch {
      request.log.warn({ event: 'database_readiness_failed' }, 'Database or migration unavailable');
      reply.code(503);
      status = { status: 'degraded', database: 'unavailable', service: 'bcis-api', version: '0.1.0' };
    }
    reply.header('Cache-Control', 'no-store');
    return status;
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'This endpoint does not exist.', requestId: request.id } });
  });
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, fields: error.fields, requestId: request.id } });
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    request.log.error({ event: 'request_failed', code: error.code, status, message: error.message }, 'Request failed');
    return reply.code(status).send({ error: {
      code: status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST',
      message: status === 429 ? 'Too many sign-in attempts. Try again in one minute.' : status === 500 ? 'The request could not be completed.' : 'The request is invalid.',
      requestId: request.id,
    } });
  });
  if (options.auth) app.register(async (scope) => authRoutes(scope, options.auth!));
  if (options.auth) app.register(async (scope) => masterRoutes(scope, options.auth!));
  if (options.auth) app.register(async (scope) => billingRoutes(scope, options.auth!));
  if (options.auth) app.register(async (scope) => paymentRoutes(scope, options.auth!));
  if (options.auth) app.register(async (scope) => collectionRoutes(scope, options.auth!));
  return app;
}
