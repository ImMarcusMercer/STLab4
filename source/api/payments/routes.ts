import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/service';
import { ApiError } from '../auth/errors';
import { parse } from '../master-data/service';
import { ReceiptTooLongError, renderReceiptPdf } from '../reports/receipt';
import { documentFileName } from '../../shared/documents';
import { PaymentService } from './service';
import { ReceiptService } from './receipt';

export async function paymentRoutes(app: FastifyInstance, auth: AuthService) {
  const service = new PaymentService(auth);
  const receipts = new ReceiptService(auth);
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

  /**
   * The official receipt, as a PDF the desktop saves through the native dialog.
   *
   * Reading a receipt is part of `payment.view`, because the payment itself is already
   * visible to anyone holding it. Producing a *document* from it is `report.export`, so the
   * permission that lets somebody read a payment on screen is not the permission that lets
   * them write one to disk. Both are checked here rather than in the renderer, because a
   * button the API would refuse is a button that should not have been offered.
   */
  app.get('/api/v1/payments/:id/receipt', async (request, reply) => {
    const { format } = request.query as Record<string, string | undefined>;
    if (format !== undefined && format !== 'PDF') {
      throw new ApiError(422, 'VALIDATION', 'A receipt is produced as a PDF.', { format: ['Choose PDF.'] });
    }
    const paymentId = id(request);
    const { receipt, actor } = await receipts.document(token(request), paymentId, 'report.export');
    // The writer is the authority on how many invoice lines one receipt page can carry. A
    // payment that settled more than that is refused as a 422 with somewhere to go instead,
    // rather than being handed over clipped or with its total printed over a signature.
    let body: Buffer;
    try {
      body = renderReceiptPdf(receipt);
    } catch (error) {
      if (error instanceof ReceiptTooLongError) {
        throw new ApiError(422, 'VALIDATION', `This payment settled ${error.lines} invoices, which is more than one receipt can list. Print the subscriber's statement of account instead.`);
      }
      throw error;
    }
    // Recorded only now that the bytes exist, so a refused receipt never leaves a trace that
    // reads as a document a subscriber was handed.
    await receipts.recordPrint(actor, paymentId, receipt);
    const fileName = documentFileName('receipt', [receipt.receiptNumber, receipt.subscriberCode]);
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `attachment; filename="${fileName}"`);
    reply.header('Content-Length', String(body.length));
    return reply.send(body);
  });

  app.post('/api/v1/payments', { preHandler: create, bodyLimit: 8_000_000 }, async (request, reply) => reply.code(201).send(await service.record(token(request), request.body)));
  app.post('/api/v1/payments/:id/verify', { preHandler: verify }, request => service.verify(token(request), id(request), request.body));
  app.post('/api/v1/payments/:id/void', { preHandler: create }, request => service.voidPayment(token(request), id(request), request.body));
  app.post('/api/v1/payments/:id/reverse', { preHandler: reverse }, request => service.reverse(token(request), id(request), request.body));
}
