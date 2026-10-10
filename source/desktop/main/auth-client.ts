import { masterInputs, recordSchema, ListQuery, EditMetadata, HistorySchema, AssignmentInput, type Resource, type MasterRecord, type MasterList } from '../../shared/master-data';
import { z } from 'zod';
import { ActorSchema, LoginInput, NewUserInput, UpdateUserInput, UserListSchema, type Actor, type ApiResult, type UserList } from '../../shared/auth';
import {
  AdjustmentInput, BillingCycleListSchema, BillingRunListSchema, BillingRunSchema, DraftInvoiceInput, DraftItemsInput, FinalizeInput, GenerateRunInput,
  InvoiceListSchema, InvoiceQuery, InvoiceSchema, LedgerQuery, LedgerSchema, OverdueSweepInput, OverdueSweepSchema, VoidInput,
  type BillingCycleList, type BillingRun, type BillingRunList, type Invoice, type InvoiceList, type Ledger, type OverdueSweep,
} from '../../shared/billing';
import { parseApiUrl } from './api-client';
import {
  AccountQuery, PaymentDetailSchema, PaymentListSchema, PaymentProofContentSchema, PaymentQuery, PaymentResultSchema, PaymentSchema,
  RecordPaymentInput, ReversePaymentInput, SubscriberAccountSchema, VerifyPaymentInput, VoidPaymentInput,
  type Payment, type PaymentDetail, type PaymentList, type PaymentProofContent, type PaymentResult, type SubscriberAccount,
} from '../../shared/payments';
import {
  BatchDetailSchema, BatchListSchema, BatchQuery, CloseBatchInput, CreateBatchInput, ReconcileBatchInput, RemittanceInput,
  RouteSheetSchema, SubmitBatchInput,
  type BatchDetail, type BatchList, type RouteSheet,
} from '../../shared/collections';
import {
  AssignTechnicianInput, CompleteReconnectionInput, LiftSuspensionInput, ReceivableListSchema, ReceivableQuery,
  ReceivableSummarySchema, RequestReconnectionInput, ServiceControlEventSchema, ServicePolicySchema, ServiceTechnicianSchema,
  SuspendServiceInput, SuspensionListSchema, SuspensionQuery, SuspensionSchema, UpdatePolicyInput,
  type ReceivableList, type ReceivableSummary, type ServiceControlEvent, type ServicePolicy, type ServiceTechnician, type Suspension, type SuspensionList,
} from '../../shared/receivables';
import {
  DashboardQuery, DashboardSchema, ExportFormat, ReportCatalogueSchema, ReportCode, ReportQuery, ReportTableSchema,
  type Dashboard, type ExportFormat as ExportFormatType, type ReportCatalogue, type ReportTable,
} from '../../shared/reports';
import {
  BackupListSchema, BackupRecordSchema, BackupVerificationSchema, CreateBackupInputSchema, RestoreBackupInputSchema, RestoreReportSchema,
  type BackupList, type BackupRecord, type BackupVerification, type RestoreReport,
} from '../../shared/backups';

const LoginResponse = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/), user: ActorSchema });
const ErrorResponse = z.object({ error: z.object({ message: z.string(), fields: z.record(z.string(), z.array(z.string())).optional() }) });

/** A report export as bytes. The body crosses the bridge, never a path the renderer chose. */
export type ReportExport = { fileName: string; contentType: string; body: Buffer };

/**
 * Path separators, reserved characters and control codes. A file name is built here and
 * joined to a folder on the main process, so none of these may survive. Checked per
 * character rather than with a range inside one regular expression, which would have to
 * embed literal control bytes to say what it means.
 */
const UNSAFE_IN_NAME = new Set('/\\:*?"<>|'.split(''));
const isControl = (character: string) => { const code = character.codePointAt(0) ?? 0; return code <= 0x1f || code === 0x7f; };

/** Drops absent filters so the URL carries only what was actually asked for. */
const compact = (values: Record<string, unknown>): Record<string, string> => Object.fromEntries(
  Object.entries(values)
    .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== null && entry[1] !== '')
    .map(([key, value]) => [key, String(value)]),
);

/**
 * The file name the server suggested, taken from `Content-Disposition` so the save dialog
 * offers the same name the export was built with. Anything unusable in it is discarded in
 * favour of a name derived from the report code, and the result is reduced to a bare file
 * name: a header is attacker-influenced input that ends up on a path.
 */
/**
 * Picks the file name to save under.
 *
 * `fallback` is any short kind of document: a report code, or 'receipt' for the official
 * receipt. It is only reached when the server's own suggestion is missing or unusable, and the
 * suggestion is preferred because the server is what numbered the document.
 */
export function attachmentName(header: string | null, fallbackKind: string, format: ExportFormatType | string): string {
    const fallback = `${fallbackKind.toLowerCase().replace(/_/g, '-')}.${format.toLowerCase()}`;
  const suggested = header?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1]?.trim();
  if (!suggested) return fallback;
  // Rejected outright rather than cleaned up. Stripping the separator out of "../../etc/passwd"
  // leaves "....etcpasswd", which is legal but meaningless, and a name that had to be repaired
  // is not a name the server built. Anything not exactly a plain file name is discarded.
  const characters = [...suggested];
  if (characters.some((character) => UNSAFE_IN_NAME.has(character) || isControl(character))) return fallback;
  if (suggested === '.' || suggested === '..' || suggested.length > 120) return fallback;
  return suggested;
}

export class AuthClient {
  #token: string | null = null;
  #generation = 0;
  readonly origin: string;
  constructor(origin: string) { this.origin = parseApiUrl(origin); }

  /**
   * One JSON request against the API.
   *
   * `token` is passed explicitly where the caller needs to prove a token is
   * still the current one rather than the one it happened to hold, and `timeoutMs` exists because
   * a backup is not a normal request: the answer only means something once the server has written
   * the archive and read it back, which takes longer than a list of subscribers, and a desktop
   * that gave up early would report a backup as failed while it was still running.
   */
  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    method = 'GET',
    body?: unknown,
    token = this.#token,
    timeoutMs = 10_000,
  ): Promise<ApiResult<T>> {
    try {
      const response = await fetch(`${this.origin}/api/v1${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        if (response.status === 401 && this.#token === token) this.#token = null;
        let body: unknown;
        try { body = await response.json(); } catch { /* An upstream error page may be plain text. */ }
        const parsed = ErrorResponse.safeParse(body);
        return { ok: false, error: { status: response.status, message: parsed.success ? parsed.data.error.message : 'The office system could not complete the request. Try again or contact your administrator.', ...(parsed.success && parsed.data.error.fields ? { fields: parsed.data.error.fields } : {}) } };
      }
      return { ok: true, data: schema.parse(response.status === 204 ? null : await response.json()) };
    } catch {
      return { ok: false, error: { status: 0, message: 'Could not reach the office system. Check your network and try again.' } };
    }
  }

  async login(input: unknown): Promise<ApiResult<Actor>> {
    const parsed = LoginInput.safeParse(input);
    if (!parsed.success) return { ok: false, error: { status: 422, message: 'Enter a valid username and password.' } };
    const generation = ++this.#generation;
    this.#token = null;
    const result = await this.request('/auth/login', LoginResponse, 'POST', parsed.data, null);
    if (!result.ok) return result;
    if (generation !== this.#generation) {
      await this.request('/auth/logout', z.null(), 'POST', undefined, result.data.token);
      return { ok: false, error: { status: 401, message: 'Sign-in was cancelled. Please sign in again.' } };
    }
    this.#token = result.data.token;
    return { ok: true, data: result.data.user };
  }

  async getSession(): Promise<ApiResult<Actor | null>> {
    if (!this.#token) return { ok: true, data: null };
    return this.request('/auth/me', ActorSchema);
  }

  async endSession(action: 'lock' | 'logout'): Promise<ApiResult<null>> {
    ++this.#generation;
    const token = this.#token;
    this.#token = null;
    if (!token) return { ok: true, data: null };
    const result = await this.request(`/auth/${action}`, z.null(), 'POST', undefined, token);
    if (!result.ok && result.error.status !== 401) return { ok: false, error: { status: result.error.status, message: 'This desktop is signed out. Server revocation could not be confirmed; the remote session will expire automatically.' } };
    return { ok: true, data: null };
  }

  async listUsers(page: unknown = 1): Promise<ApiResult<UserList>> {
    const parsed = z.number().int().min(1).max(1000000).safeParse(page);
    if (!parsed.success) return { ok: false, error: { status: 422, message: 'Invalid page number.' } };
    return this.request(`/admin/users?page=${parsed.data}&perPage=20`, UserListSchema);
  }
  async createUser(input: unknown): Promise<ApiResult<Actor>> {
    const parsed = NewUserInput.safeParse(input);
    if (!parsed.success) return { ok: false, error: { status: 422, message: 'Check the account details. Passwords need at least 12 characters.', fields: z.flattenError(parsed.error).fieldErrors } };
    return this.request('/admin/users', ActorSchema, 'POST', parsed.data);
  }
  async updateUser(id: unknown, input: unknown): Promise<ApiResult<Actor>> {
    const userId = z.uuid().safeParse(id);
    const parsed = UpdateUserInput.safeParse(input);
    if (!userId.success || !parsed.success) return { ok: false, error: { status: 422, message: 'Check the account details and try again.' } };
    return this.request(`/admin/users/${userId.data}`, ActorSchema, 'PATCH', parsed.data);
  }

  private async listMaster<K extends Resource>(resource: K, raw: unknown): Promise<ApiResult<MasterList<K>>> {
    const query = ListQuery.safeParse(raw);
    if (!query.success) return { ok: false, error: { status: 422, message: 'Invalid search filters.' } };
    const params = new URLSearchParams();
    for (const [key,value] of Object.entries(query.data)) if (value !== undefined) params.set(key,String(value));
    return this.request(`/${resource}?${params}`, z.object({ items: z.array(recordSchema(resource)), total: z.number(), page: z.number(), perPage: z.number() })) as Promise<ApiResult<MasterList<K>>>;
  }
  private async saveMaster<K extends Resource>(resource: K, id: unknown, raw: unknown): Promise<ApiResult<MasterRecord<K>>> {
    const key = z.uuid().nullable().safeParse(id);
    const input = EditMetadata.extend({ data: masterInputs[resource] }).strict().safeParse(raw);
    if (!key.success || !input.success) return { ok: false, error: { status: 422, message: 'Check the record details.', fields: input.success ? {} : z.flattenError(input.error).fieldErrors as Record<string, string[]> } };
    return this.request(`/${resource}${key.data ? `/${key.data}` : ''}`, recordSchema(resource), key.data ? 'PUT' : 'POST', input.data) as Promise<ApiResult<MasterRecord<K>>>;
  }
  async getMasterRecord(resource: unknown, id: unknown): Promise<ApiResult<MasterRecord>> {
    const key = z.uuid().safeParse(id); const kind = z.enum(['plans','areas','collectors','subscribers','services']).safeParse(resource);
    if (!key.success || !kind.success) return { ok: false, error: { status: 422, message: 'Invalid record.' } };
    return this.request(`/${kind.data}/${key.data}`, recordSchema(kind.data)) as Promise<ApiResult<MasterRecord>>;
  }
  async getMasterHistory(resource: unknown, id: unknown, page: unknown) {
    const key = z.uuid().safeParse(id); const kind = z.enum(['plans','areas','collectors','subscribers','services']).safeParse(resource); const query = ListQuery.safeParse({ page });
    if (!key.success || !kind.success || !query.success) return { ok: false as const, error: { status: 422, message: 'Invalid history request.' } };
    return this.request(`/${kind.data}/${key.data}/history?page=${query.data.page}`, HistorySchema);
  }
  private async assignMaster<K extends 'subscribers' | 'services'>(resource: K, id: unknown, raw: unknown): Promise<ApiResult<MasterRecord<K>>> {
    const key = z.uuid().safeParse(id); const input = AssignmentInput.safeParse(raw);
    if (!key.success || !input.success) return { ok: false, error: { status: 422, message: 'Check the assignment details.' } };
    return this.request(`/${resource}/${key.data}/assignment`, recordSchema(resource), 'PATCH', input.data) as Promise<ApiResult<MasterRecord<K>>>;
  }
  assignSubscriber(id: unknown, input: unknown) { return this.assignMaster('subscribers',id,input); }
  assignService(id: unknown, input: unknown) { return this.assignMaster('services',id,input); }
  listPlans(input: unknown) { return this.listMaster('plans',input); }
  savePlan(id: unknown, input: unknown) { return this.saveMaster('plans',id,input); }
  listAreas(input: unknown) { return this.listMaster('areas',input); }
  saveArea(id: unknown, input: unknown) { return this.saveMaster('areas',id,input); }
  listCollectors(input: unknown) { return this.listMaster('collectors',input); }
  saveCollector(id: unknown, input: unknown) { return this.saveMaster('collectors',id,input); }
  listSubscribers(input: unknown) { return this.listMaster('subscribers',input); }
  saveSubscriber(id: unknown, input: unknown) { return this.saveMaster('subscribers',id,input); }
  listServices(input: unknown) { return this.listMaster('services',input); }
  saveService(id: unknown, input: unknown) { return this.saveMaster('services',id,input); }

  // --------------------------------------------------------------------- billing
  // Every billing command is a named operation. The desktop never builds a URL, never
  // chooses a permission and never recomputes an amount: the API validates the command
  // and answers with the stored document, so the screen can only display server truth.

  listBillingCycles(): Promise<ApiResult<BillingCycleList>> {
    return this.request('/billing/cycles', BillingCycleListSchema);
  }
  async listBillingRuns(page: unknown = 1): Promise<ApiResult<BillingRunList>> {
    const parsed = z.number().int().min(1).max(1000000).safeParse(page);
    if (!parsed.success) return { ok: false, error: { status: 422, message: 'Invalid page number.' } };
    return this.request(`/billing/runs?page=${parsed.data}&perPage=20`, BillingRunListSchema);
  }
  async generateBillingRun(input: unknown): Promise<ApiResult<BillingRun>> {
    const parsed = GenerateRunInput.safeParse(input);
    if (!parsed.success) return { ok: false, error: { status: 422, message: 'Choose a billing period in the YYYY-MM format.', fields: z.flattenError(parsed.error).fieldErrors } };
    return this.request('/billing/runs', BillingRunSchema, 'POST', parsed.data);
  }
  async listBillingInvoices(input: unknown): Promise<ApiResult<InvoiceList>> {
    const parsed = InvoiceQuery.safeParse(input);
    if (!parsed.success) return { ok: false, error: { status: 422, message: 'Invalid invoice filters.' } };
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(parsed.data)) if (value !== undefined && value !== '') params.set(key, String(value));
    return this.request(`/billing/invoices?${params}`, InvoiceListSchema);
  }
  async getBillingInvoice(id: unknown): Promise<ApiResult<Invoice>> {
    const key = z.uuid().safeParse(id);
    if (!key.success) return { ok: false, error: { status: 422, message: 'Invalid invoice.' } };
    return this.request(`/billing/invoices/${key.data}`, InvoiceSchema);
  }
  async createBillingInvoice(input: unknown): Promise<ApiResult<Invoice>> {
    const parsed = DraftInvoiceInput.safeParse(input);
    if (!parsed.success) return { ok: false, error: { status: 422, message: 'Check the invoice details.', fields: z.flattenError(parsed.error).fieldErrors as Record<string, string[]> } };
    return this.request('/billing/invoices', InvoiceSchema, 'POST', parsed.data);
  }
  async replaceBillingInvoiceItems(id: unknown, input: unknown): Promise<ApiResult<Invoice>> {
    const key = z.uuid().safeParse(id); const parsed = DraftItemsInput.safeParse(input);
    if (!key.success || !parsed.success) return { ok: false, error: { status: 422, message: 'Check the invoice lines.', fields: parsed.success ? {} : z.flattenError(parsed.error).fieldErrors as Record<string, string[]> } };
    return this.request(`/billing/invoices/${key.data}/items`, InvoiceSchema, 'PUT', parsed.data);
  }
  async finalizeBillingInvoice(id: unknown, input: unknown): Promise<ApiResult<Invoice>> {
    const key = z.uuid().safeParse(id); const parsed = FinalizeInput.safeParse(input);
    if (!key.success || !parsed.success) return { ok: false, error: { status: 422, message: 'Provide a reason for issuing this invoice.' } };
    return this.request(`/billing/invoices/${key.data}/finalize`, InvoiceSchema, 'POST', parsed.data);
  }
  async adjustBillingInvoice(id: unknown, input: unknown): Promise<ApiResult<Invoice>> {
    const key = z.uuid().safeParse(id); const parsed = AdjustmentInput.safeParse(input);
    if (!key.success || !parsed.success) return { ok: false, error: { status: 422, message: 'Check the adjustment amount and reason.', fields: parsed.success ? {} : z.flattenError(parsed.error).fieldErrors as Record<string, string[]> } };
    return this.request(`/billing/invoices/${key.data}/adjustments`, InvoiceSchema, 'POST', parsed.data);
  }
  async voidBillingInvoice(id: unknown, input: unknown): Promise<ApiResult<Invoice>> {
    const key = z.uuid().safeParse(id); const parsed = VoidInput.safeParse(input);
    if (!key.success || !parsed.success) return { ok: false, error: { status: 422, message: 'Provide a reason for voiding this invoice.' } };
    return this.request(`/billing/invoices/${key.data}/void`, InvoiceSchema, 'POST', parsed.data);
  }
  async sweepOverdueInvoices(input: unknown): Promise<ApiResult<OverdueSweep>> {
    const parsed = OverdueSweepInput.safeParse(input ?? {});
    if (!parsed.success) return { ok: false, error: { status: 422, message: 'Invalid sweep date.' } };
    return this.request('/billing/overdue-sweep', OverdueSweepSchema, 'POST', parsed.data);
  }
  async getSubscriberLedger(input: unknown): Promise<ApiResult<Ledger>> {
    const parsed = LedgerQuery.safeParse(input);
    if (!parsed.success) return { ok: false, error: { status: 422, message: 'Choose a subscriber to open the account ledger.' } };
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(parsed.data)) if (value !== undefined && value !== '') params.set(key, String(value));
    return this.request(`/billing/ledger?${params}`, LedgerSchema);
  }

  // --------------------------------------------------------------------- payments
  // A payment command is sent exactly as the cashier entered it, including the receipt
  // image as base64. The API decides the receipt number, the allocation and the invoice
  // figures, so this layer only parses and forwards; it never computes money.

  async listPayments(input: unknown): Promise<ApiResult<PaymentList>> {
    const parsed = PaymentQuery.safeParse(input);
    if (!parsed.success) return { ok: false, error: { status: 422, message: 'Invalid payment filters.' } };
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(parsed.data)) if (value !== undefined && value !== '') params.set(key, String(value));
    return this.request(`/payments?${params}`, PaymentListSchema);
  }
  async getPayment(id: unknown): Promise<ApiResult<PaymentDetail>> {
    const key = z.uuid().safeParse(id);
    if (!key.success) return { ok: false, error: { status: 422, message: 'Invalid payment.' } };
    return this.request(`/payments/${key.data}`, PaymentDetailSchema);
  }
  async getSubscriberAccount(subscriberId: unknown): Promise<ApiResult<SubscriberAccount>> {
    const parsed = AccountQuery.safeParse({ subscriberId });
    if (!parsed.success) return { ok: false, error: { status: 422, message: 'Choose a subscriber to open the collection account.' } };
    return this.request(`/payments/account?subscriberId=${parsed.data.subscriberId}`, SubscriberAccountSchema);
  }
  async getPaymentProof(id: unknown): Promise<ApiResult<PaymentProofContent>> {
    const key = z.uuid().safeParse(id);
    if (!key.success) return { ok: false, error: { status: 422, message: 'Invalid payment.' } };
    return this.request(`/payments/${key.data}/proof`, PaymentProofContentSchema);
  }

  // ---------------------------------------------------------------- Phase 8: reports

  /** Which reports exist and which of them this user may export. */
  async getReportCatalogue(): Promise<ApiResult<ReportCatalogue>> {
    return this.request('/reports', ReportCatalogueSchema);
  }

  async getReport(code: unknown, query: unknown = {}): Promise<ApiResult<ReportTable>> {
    const parsed = ReportQuery.safeParse(query ?? {});
    if (!parsed.success) return this.invalid('Check the report filters.', parsed.error);
    const key = ReportCode.safeParse(code);
    if (!key.success) return { ok: false, error: { status: 404, message: 'That report does not exist.' } };
    return this.request(`/reports/${key.data}?${new URLSearchParams(compact(parsed.data))}`, ReportTableSchema);
  }

  /**
   * The dashboard takes a date and nothing more. A filter the dashboard cannot honour is
   * refused here rather than silently dropped, so an owner asking for last March is told.
   */
  async getDashboard(query: unknown = {}): Promise<ApiResult<Dashboard>> {
    const parsed = DashboardQuery.safeParse(query ?? {});
    if (!parsed.success) return this.invalid('The dashboard answers for one date only.', parsed.error);
    return this.request(`/dashboard?${new URLSearchParams(compact(parsed.data))}`, DashboardSchema);
  }

  /**
   * Fetches an export as bytes. The desktop never renders a report document itself: the PDF,
   * workbook or CSV is built by the server, and all that arrives here is what to write to
   * disk and the name the server suggested. The name is taken from the response's own
   * `Content-Disposition` and sanitised again on the main side before it reaches a dialog.
   */
  async exportReport(code: unknown, query: unknown, format: unknown): Promise<ApiResult<ReportExport>> {
    const key = ReportCode.safeParse(code);
    if (!key.success) return { ok: false, error: { status: 404, message: 'That report does not exist.' } };
    const target = ExportFormat.safeParse(format);
    if (!target.success) return { ok: false, error: { status: 422, message: 'Choose PDF, XLSX or CSV.' } };
    const parsed = ReportQuery.safeParse(query ?? {});
    if (!parsed.success) return this.invalid('Check the report filters.', parsed.error);
    const search = new URLSearchParams({ ...compact(parsed.data), format: target.data });
    try {
      const response = await fetch(`${this.origin}/api/v1/reports/${key.data}/export?${search}`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { Accept: '*/*', ...(this.#token ? { Authorization: `Bearer ${this.#token}` } : {}) },
      });
      if (!response.ok) {
        if (response.status === 401) this.#token = null;
        const parsedError = ErrorResponse.safeParse(await response.json().catch(() => null));
        return { ok: false, error: { status: response.status, message: parsedError.success ? parsedError.data.error.message : 'The export could not be produced.' } };
      }
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length === 0) return { ok: false, error: { status: 0, message: 'The server returned an empty file.' } };
      return {
        ok: true,
        data: { fileName: attachmentName(response.headers.get('content-disposition'), key.data, target.data), contentType: response.headers.get('content-type') ?? '', body },
      };
    } catch {
      return { ok: false, error: { status: 0, message: 'The BCIS server could not produce the export. Check the connection and try again.' } };
    }
  }

  /**
   * Fetches the official receipt PDF for a payment.
   *
   * The bytes are never handed to the renderer. Producing them is what records the print in the
   * audit trail, so this request happening is the receipt having been issued. A payment with
   * nothing to print is refused by the server rather than answered with a blank page, and the
   * reason it gives is returned unchanged so the cashier can act on it.
   */
  async printReceipt(id: unknown): Promise<ApiResult<ReportExport>> {
    const key = z.uuid().safeParse(id);
    if (!key.success) return { ok: false, error: { status: 422, message: 'Invalid payment.' } };
    let response: Response;
    try {
      response = await fetch(`${this.origin}/api/v1/payments/${key.data}/receipt`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { Accept: 'application/pdf', ...(this.#token ? { Authorization: `Bearer ${this.#token}` } : {}) },
      });
    } catch {
      return { ok: false, error: { status: 0, message: 'The BCIS server could not produce the receipt. Check the connection and try again.' } };
    }
    if (response.status === 401) this.#token = null;
    if (!response.ok) {
      const parsed = ErrorResponse.safeParse(await response.json().catch(() => null));
      return {
        ok: false,
        error: {
          status: response.status,
          message: parsed.success ? parsed.data.error.message : 'The receipt could not be produced.',
        },
      };
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length === 0) return { ok: false, error: { status: 0, message: 'The server returned an empty receipt.' } };
    return {
      ok: true,
      data: { fileName: attachmentName(response.headers.get('content-disposition'), 'receipt', 'PDF'), contentType: 'application/pdf', body },
    };
  }

  // --------------------------------------------------------------------- backups
  // Every backup operation is a plain request and a plain response. The archive itself never
  // crosses the bridge: no method returns bytes and none accepts a path, so the renderer cannot
  // read, move or delete a backup, and the only things that touch those files are the API's own
  // pg_dump and pg_restore processes on the server.

  async listBackups(): Promise<ApiResult<BackupList>> {
    return this.request('/backups', BackupListSchema);
  }

  /**
   * Takes a backup on the server.
   *
   * The timeout is generous because the response only arrives once the finished archive has been
   * read back with pg_restore, which is the only point at which the answer means anything.
   */
  async createBackup(input: unknown): Promise<ApiResult<BackupRecord>> {
    const parsed = CreateBackupInputSchema.safeParse(input ?? {});
    if (!parsed.success) return this.invalid('Check the backup details.', parsed.error);
    return this.request('/backups', BackupRecordSchema, 'POST', parsed.data, undefined, 300_000);
  }

  async verifyBackup(id: unknown): Promise<ApiResult<BackupVerification>> {
    const key = z.uuid().safeParse(id);
    if (!key.success) return { ok: false, error: { status: 404, message: 'That backup does not exist.' } };
    return this.request(`/backups/${key.data}/verify`, BackupVerificationSchema, 'POST', {}, undefined, 120_000);
  }

  /**
   * Restores a backup over the live database.
   *
   * The confirmation phrase and the reason are required here as well as on the server, so the
   * renderer cannot be used to skip the part of the decision that asks the operator to mean it.
   */
  async restoreBackup(id: unknown, input: unknown): Promise<ApiResult<RestoreReport>> {
    const key = z.uuid().safeParse(id);
    if (!key.success) return { ok: false, error: { status: 404, message: 'That backup does not exist.' } };
    const parsed = RestoreBackupInputSchema.safeParse(input ?? {});
    if (!parsed.success) return this.invalid('Type RESTORE and give a reason before restoring.', parsed.error);
    return this.request(`/backups/${key.data}/restore`, RestoreReportSchema, 'POST', parsed.data, undefined, 600_000);
  }

  private invalid(message: string, error: z.ZodError): ApiResult<never> {
    return { ok: false, error: { status: 422, message, fields: z.flattenError(error).fieldErrors as Record<string, string[]> } };
  }
  async recordPayment(input: unknown): Promise<ApiResult<PaymentResult>> {
    const parsed = RecordPaymentInput.safeParse(input);
    if (!parsed.success) return { ok: false, error: { status: 422, message: 'Check the payment details.', fields: z.flattenError(parsed.error).fieldErrors as Record<string, string[]> } };
    return this.request('/payments', PaymentResultSchema, 'POST', parsed.data);
  }
  async verifyPayment(id: unknown, input: unknown): Promise<ApiResult<PaymentResult>> {
    const key = z.uuid().safeParse(id);
    const parsed = VerifyPaymentInput.safeParse(input ?? {});
    if (!key.success || !parsed.success) return { ok: false, error: { status: 422, message: 'Check the confirmation details.' } };
    return this.request(`/payments/${key.data}/verify`, PaymentResultSchema, 'POST', parsed.data);
  }
  async voidPayment(id: unknown, input: unknown): Promise<ApiResult<Payment>> {
    const key = z.uuid().safeParse(id);
    const parsed = VoidPaymentInput.safeParse(input);
    if (!key.success || !parsed.success) return { ok: false, error: { status: 422, message: 'Provide a reason for voiding this entry.' } };
    return this.request(`/payments/${key.data}/void`, PaymentSchema, 'POST', parsed.data);
  }
  async reversePayment(id: unknown, input: unknown): Promise<ApiResult<PaymentResult>> {
    const key = z.uuid().safeParse(id);
    const parsed = ReversePaymentInput.safeParse(input);
    if (!key.success || !parsed.success) return { ok: false, error: { status: 422, message: 'Provide a reason for reversing this receipt.' } };
    return this.request(`/payments/${key.data}/reverse`, PaymentResultSchema, 'POST', parsed.data);
  }

  // ------------------------------------------------------------------- collections
  // A collection command is forwarded exactly as the operator gave it. The desktop never
  // counts a route, never compares a remittance and never decides a batch state: the API
  // freezes the sheet, derives the totals and answers with the stored batch.

  async listCollectionBatches(input: unknown): Promise<ApiResult<BatchList>> {
    const parsed = BatchQuery.safeParse(input);
    if (!parsed.success) return { ok: false, error: { status: 422, message: 'Invalid collection filters.' } };
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(parsed.data)) if (value !== undefined && value !== '') params.set(key, String(value));
    return this.request(`/collections/batches?${params}`, BatchListSchema);
  }
  async getCollectionBatch(id: unknown): Promise<ApiResult<BatchDetail>> {
    const key = z.uuid().safeParse(id);
    if (!key.success) return { ok: false, error: { status: 422, message: 'Invalid collection batch.' } };
    return this.request(`/collections/batches/${key.data}`, BatchDetailSchema);
  }
  async getCollectionRouteSheet(id: unknown): Promise<ApiResult<RouteSheet>> {
    const key = z.uuid().safeParse(id);
    if (!key.success) return { ok: false, error: { status: 422, message: 'Invalid collection batch.' } };
    return this.request(`/collections/batches/${key.data}/route-sheet`, RouteSheetSchema);
  }
  async createCollectionBatch(input: unknown): Promise<ApiResult<BatchDetail>> {
    const parsed = CreateBatchInput.safeParse(input);
    if (!parsed.success) return { ok: false, error: { status: 422, message: 'Check the route details.', fields: z.flattenError(parsed.error).fieldErrors as Record<string, string[]> } };
    return this.request('/collections/batches', BatchDetailSchema, 'POST', parsed.data);
  }
  async startCollectionBatch(id: unknown): Promise<ApiResult<BatchDetail>> {
    const key = z.uuid().safeParse(id);
    if (!key.success) return { ok: false, error: { status: 422, message: 'Invalid collection batch.' } };
    return this.request(`/collections/batches/${key.data}/start`, BatchDetailSchema, 'POST', {});
  }
  async submitCollectionBatch(id: unknown, input: unknown): Promise<ApiResult<BatchDetail>> {
    const key = z.uuid().safeParse(id);
    const parsed = SubmitBatchInput.safeParse(input ?? {});
    if (!key.success || !parsed.success) return { ok: false, error: { status: 422, message: 'Check the submission details.' } };
    return this.request(`/collections/batches/${key.data}/submit`, BatchDetailSchema, 'POST', parsed.data);
  }
  async remitCollectionBatch(id: unknown, input: unknown): Promise<ApiResult<BatchDetail>> {
    const key = z.uuid().safeParse(id);
    const parsed = RemittanceInput.safeParse(input);
    if (!key.success || !parsed.success) return { ok: false, error: { status: 422, message: 'Check the counted cash and its date.', fields: parsed.success ? {} : z.flattenError(parsed.error).fieldErrors as Record<string, string[]> } };
    return this.request(`/collections/batches/${key.data}/remittance`, BatchDetailSchema, 'POST', parsed.data);
  }
  async reconcileCollectionBatch(id: unknown, input: unknown): Promise<ApiResult<BatchDetail>> {
    const key = z.uuid().safeParse(id);
    const parsed = ReconcileBatchInput.safeParse(input);
    if (!key.success || !parsed.success) return { ok: false, error: { status: 422, message: 'Provide a written reason for reconciling this remittance.' } };
    return this.request(`/collections/batches/${key.data}/reconcile`, BatchDetailSchema, 'POST', parsed.data);
  }
  async closeCollectionBatch(id: unknown, input: unknown): Promise<ApiResult<BatchDetail>> {
    const key = z.uuid().safeParse(id);
    const parsed = CloseBatchInput.safeParse(input ?? {});
    if (!key.success || !parsed.success) return { ok: false, error: { status: 422, message: 'Invalid close request.' } };
    return this.request(`/collections/batches/${key.data}/close`, BatchDetailSchema, 'POST', parsed.data);
  }

  // ------------------------------------------------------- receivables & service control
  // Nothing here derives a figure or a lifecycle step. The aging report is a read of open
  // invoices and the suspension commands are forwarded as given, so the desktop can only ever
  // show what the API decided and refused.

  async getReceivableSummary(query?: unknown): Promise<ApiResult<ReceivableSummary>> {
    const filters = typeof query === 'string' ? query : '';
    return this.request(`/receivables/summary${filters ? `?${filters}` : ''}`, ReceivableSummarySchema);
  }
  async listOverdueReceivables(query?: unknown): Promise<ApiResult<ReceivableList>> {
    const params = new URLSearchParams();
    if (typeof query === 'string') {
      for (const [key, value] of new URLSearchParams(query)) params.set(key, value);
    } else if (query !== undefined && query !== null) {
      const parsed = ReceivableQuery.safeParse(query);
      if (!parsed.success) return { ok: false, error: { status: 422, message: 'Invalid receivable filters.' } };
      for (const [key, value] of Object.entries(parsed.data)) if (value !== undefined && value !== '') params.set(key, String(value));
    }
    return this.request(`/receivables/overdue?${params}`, ReceivableListSchema);
  }
  async getServicePolicy(): Promise<ApiResult<ServicePolicy>> {
    return this.request('/service-control/policy', ServicePolicySchema);
  }
  async updateServicePolicy(input: unknown): Promise<ApiResult<ServicePolicy>> {
    const parsed = UpdatePolicyInput.safeParse(input);
    if (!parsed.success) return { ok: false, error: { status: 422, message: 'Check the policy values.', fields: z.flattenError(parsed.error).fieldErrors as Record<string, string[]> } };
    return this.request('/service-control/policy', ServicePolicySchema, 'PUT', parsed.data);
  }
  async listServiceTechnicians(): Promise<ApiResult<ServiceTechnician[]>> {
    return this.request('/service-control/technicians', z.array(ServiceTechnicianSchema));
  }
  async listSuspensions(query?: unknown): Promise<ApiResult<SuspensionList>> {
    const params = new URLSearchParams();
    if (typeof query === 'string') {
      for (const [key, value] of new URLSearchParams(query)) params.set(key, value);
    } else if (query !== undefined && query !== null) {
      const parsed = SuspensionQuery.safeParse(query);
      if (!parsed.success) return { ok: false, error: { status: 422, message: 'Invalid suspension filters.' } };
      for (const [key, value] of Object.entries(parsed.data)) if (value !== undefined && value !== '') params.set(key, String(value));
    }
    return this.request(`/service-control/suspensions?${params}`, SuspensionListSchema);
  }
  async getSuspension(id: unknown): Promise<ApiResult<Suspension>> {
    const key = z.uuid().safeParse(id);
    if (!key.success) return { ok: false, error: { status: 422, message: 'Invalid suspension.' } };
    return this.request(`/service-control/suspensions/${key.data}`, SuspensionSchema);
  }
  async suspendService(serviceAccountId: unknown, input: unknown): Promise<ApiResult<Suspension>> {
    const key = z.uuid().safeParse(serviceAccountId);
    const parsed = SuspendServiceInput.safeParse(input);
    if (!key.success || !parsed.success) return { ok: false, error: { status: 422, message: 'Give a written reason for the disconnection.', fields: parsed.success ? {} : z.flattenError(parsed.error).fieldErrors as Record<string, string[]> } };
    return this.request(`/service-control/services/${key.data}/suspend`, SuspensionSchema, 'POST', parsed.data);
  }
  async liftSuspension(id: unknown, input: unknown): Promise<ApiResult<Suspension>> {
    const key = z.uuid().safeParse(id);
    const parsed = LiftSuspensionInput.safeParse(input ?? {});
    if (!key.success || !parsed.success) return { ok: false, error: { status: 422, message: 'Give a written reason for restoring service.', fields: parsed.success ? {} : z.flattenError(parsed.error).fieldErrors as Record<string, string[]> } };
    return this.request(`/service-control/suspensions/${key.data}/lift`, SuspensionSchema, 'POST', parsed.data);
  }
  async requestReconnection(id: unknown, input: unknown): Promise<ApiResult<Suspension>> {
    const key = z.uuid().safeParse(id);
    const parsed = RequestReconnectionInput.safeParse(input ?? {});
    if (!key.success || !parsed.success) return { ok: false, error: { status: 422, message: 'Check the reconnection request.', fields: parsed.success ? {} : z.flattenError(parsed.error).fieldErrors as Record<string, string[]> } };
    return this.request(`/service-control/suspensions/${key.data}/reconnection`, SuspensionSchema, 'POST', parsed.data);
  }
  async assignTechnician(id: unknown, input: unknown): Promise<ApiResult<Suspension>> {
    const key = z.uuid().safeParse(id);
    const parsed = AssignTechnicianInput.safeParse(input);
    if (!key.success || !parsed.success) return { ok: false, error: { status: 422, message: 'Choose a technician for the visit.', fields: parsed.success ? {} : z.flattenError(parsed.error).fieldErrors as Record<string, string[]> } };
    return this.request(`/service-control/suspensions/${key.data}/reconnection/assign`, SuspensionSchema, 'POST', parsed.data);
  }
  async completeReconnection(id: unknown, input: unknown): Promise<ApiResult<Suspension>> {
    const key = z.uuid().safeParse(id);
    const parsed = CompleteReconnectionInput.safeParse(input ?? {});
    if (!key.success || !parsed.success) return { ok: false, error: { status: 422, message: 'Check the completion details.', fields: parsed.success ? {} : z.flattenError(parsed.error).fieldErrors as Record<string, string[]> } };
    return this.request(`/service-control/suspensions/${key.data}/reconnection/complete`, SuspensionSchema, 'POST', parsed.data);
  }
  async getServiceControlHistory(serviceAccountId: unknown): Promise<ApiResult<ServiceControlEvent[]>> {
    const key = z.uuid().safeParse(serviceAccountId);
    if (!key.success) return { ok: false, error: { status: 422, message: 'Invalid service account.' } };
    return this.request(`/service-control/services/${key.data}/history`, z.array(ServiceControlEventSchema));
  }
}

