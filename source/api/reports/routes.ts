import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ReportCode, reportCatalogue } from '../../shared/reports';
import type { AuthService } from '../auth/service';
import { ApiError } from '../auth/errors';
import { parse } from '../master-data/service';
import { renderDocument } from './documents';
import { ReportsService } from './service';

export async function reportsRoutes(app: FastifyInstance, auth: AuthService) {
  const service = new ReportsService(auth);
  const token = (request: FastifyRequest) => request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] ?? '';
  const code = (request: FastifyRequest) => {
    const value = parse(z.object({ code: z.string().max(40) }), request.params).code;
    if (!(value in reportCatalogue)) throw new ApiError(404, 'NOT_FOUND', 'That report does not exist.');
    return value as ReportCode;
  };

  // A report is live money, so nothing here is cached and nothing is logged with its body.
  app.addHook('onSend', async (_, reply) => { reply.header('Cache-Control', 'no-store'); });

  app.get('/api/v1/reports', async (request) => service.catalogue(token(request)));
  app.get('/api/v1/reports/:code', async (request) => service.build(token(request), code(request), request.query));
  app.get('/api/v1/dashboard', async (request) => service.dashboard(token(request), request.query));

  // The export is the one endpoint that answers with bytes rather than JSON. It is marked
  // no-store and given a fixed name, so the save dialog can suggest something the user
  // recognises and a proxy cannot keep a copy of.
  app.get('/api/v1/reports/:code/export', async (request, reply) => {
    const { format, ...filters } = request.query as Record<string, string | undefined>;
    if (format !== 'PDF' && format !== 'XLSX' && format !== 'CSV') {
      throw new ApiError(422, 'VALIDATION', 'Choose PDF, XLSX or CSV.', { format: ['Choose PDF, XLSX or CSV.'] });
    }
    const table = await service.forExport(token(request), code(request), filters, format);
    const document = renderDocument(table, format);
    reply.header('Content-Type', document.contentType);
    reply.header('Content-Disposition', `attachment; filename="${document.fileName}"`);
    reply.header('Content-Length', String(document.body.length));
    return reply.send(document.body);
  });
}
