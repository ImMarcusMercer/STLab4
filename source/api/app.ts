import Fastify, { type FastifyError } from 'fastify';
import type pg from 'pg';
import type { SystemStatus } from '../shared/contracts';
import type { AuthService } from './auth/service';
import { authRoutes } from './auth/routes';
import { ApiError } from './auth/errors';
import { buildLoggerOptions } from './logging';
import { masterRoutes } from './master-data/routes';
import { billingRoutes } from './billing/routes';
import { paymentRoutes } from './payments/routes';
import { collectionRoutes } from './collections/routes';
import { receivablesRoutes } from './receivables/routes';
import { reportsRoutes } from './reports/routes';
import { backupRoutes } from './backup/routes';

export function buildApp(options: { checkDatabase: () => Promise<void>; logLevel?: string; logStream?: { write: (line: string) => void }; auth?: AuthService; pool?: pg.Pool }) {
  // One logger configuration for every process, so redaction cannot be left out of the way a
  // test or a future entry point happens to take. See source/api/logging.ts.
  const app = Fastify({
    logger: buildLoggerOptions(options.logLevel ?? 'info', options.logStream),
    bodyLimit: 1_048_576,
    requestTimeout: 10_000,
  });

  // An API answer is consumed by the desktop's main process rather than rendered, but these
  // three cost nothing and stop a response being sniffed, framed or leaked as a referrer if
  // the port is ever reached from a browser on the office LAN.
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
  });

  app.get('/health', async () => ({ status: 'ok', service: 'bcis-api' }));
  app.get('/api/v1/system/status', async (request, reply) => {
    let status: SystemStatus;
    try {
      await options.checkDatabase();
      status = { status: 'ready', database: 'connected', service: 'bcis-api', version: '0.1.0' };
    } catch (error) {
      // The reason is logged so an outage can be diagnosed from the log, and it goes through
      // the error serializer, which scrubs a driver message that quotes the connection string.
      request.log.warn({ event: 'database_readiness_failed', err: error }, 'Database or migration unavailable');
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
    if (error instanceof ApiError) {
      // A refusal is a security event, not an exception: it is logged with the route and the
      // reason so a lockout loop or a user probing permissions is visible in the log without
      // having to read the audit table. The session token is never part of the line.
      if (error.statusCode === 401 || error.statusCode === 403) {
        request.log.warn({
          event: error.statusCode === 401 ? 'security.unauthenticated' : 'security.permission_denied',
          code: error.code, path: request.routeOptions?.url ?? request.url,
        }, 'Request refused');
      }
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, fields: error.fields, requestId: request.id } });
    }
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
  if (options.auth) app.register(async (scope) => receivablesRoutes(scope, options.auth!));
  if (options.auth) app.register(async (scope) => reportsRoutes(scope, options.auth!));
  // The backup routes need the pool because the dump tool and the row counts both come from the
  // same connection the API uses, so a backup reflects what this server would see.
  if (options.auth && options.pool) app.register(async (scope) => backupRoutes(scope, options.auth!, options.pool!));
  return app;
}
