import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AuthService } from '../auth/service';
import type pg from 'pg';
import { z } from 'zod';
import { ApiError } from '../auth/errors';
import { attachmentDirectory, backupDirectory } from './paths';
import { BackupService, poolConnectionString } from './service';
import {
  BackupListSchema, BackupRecordSchema, BackupVerificationSchema, RestoreReportSchema,
} from '../../shared/backups';

const id = z.uuid();

/**
 * Backup and restore endpoints.
 *
 * No response returns archive bytes or anything derived from the connection string. The list
 * includes the storage directory, because an operator has to know where to copy a backup to
 * removable media, but the desktop never writes to a path the API chose: only the API's own
 * backup tools create and read files.
 */
export async function backupRoutes(app: FastifyInstance, auth: AuthService, pool: pg.Pool) {
  const service = new BackupService(pool, auth, {
    // Taken from the pool rather than read separately from the environment, so the archive always
    // describes the database this API is actually serving and there is one place a password and a
    // hostname are configured. Never logged and never returned in a response.
    connectionString: poolConnectionString(pool),
    proofDirectory: attachmentDirectory(),
  });
  const token = (request: FastifyRequest) => request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '';
  const parseId = (request: FastifyRequest) => {
    const value = (request.params as { id?: string }).id;
    if (!id.safeParse(value).success) throw new ApiError(404, 'NOT_FOUND', 'That backup does not exist.');
    return value as string;
  };

  // Backups are as sensitive as the data they hold: they contain every subscriber record and
  // every posted payment. They must never be cached by a browser or a proxy.
  app.addHook('onSend', async (_, reply) => { reply.header('Cache-Control', 'no-store'); });

  app.get('/api/v1/backups', async (request) => BackupListSchema.parse({
    backups: await service.list(token(request)),
    storagePath: backupDirectory(),
  }));

  app.post('/api/v1/backups', async (request, reply) => {
    reply.code(201);
    return BackupRecordSchema.parse(await service.create(token(request), request.body ?? {}));
  });

  app.get('/api/v1/backups/:id', async (request) => BackupRecordSchema.parse(await service.get(token(request), parseId(request))));

  /**
   * Verifies without restoring. This is the endpoint a schedule should call: a backup nobody has
   * read back is a claim, not evidence.
   */
  app.post('/api/v1/backups/:id/verify', async (request) => BackupVerificationSchema.parse(await service.verify(token(request), parseId(request))));

  app.post('/api/v1/backups/:id/restore', async (request) => RestoreReportSchema.parse(await service.restore(token(request), parseId(request), request.body ?? {})));
}