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

const LoginResponse = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/), user: ActorSchema });
const ErrorResponse = z.object({ error: z.object({ message: z.string(), fields: z.record(z.string(), z.array(z.string())).optional() }) });

export class AuthClient {
  #token: string | null = null;
  #generation = 0;
  readonly origin: string;
  constructor(origin: string) { this.origin = parseApiUrl(origin); }

  private async request<T>(path: string, schema: z.ZodType<T>, method = 'GET', body?: unknown, token = this.#token): Promise<ApiResult<T>> {
    try {
      const response = await fetch(`${this.origin}/api/v1${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        if (response.status === 401 && this.#token === token) this.#token = null;
        const parsed = ErrorResponse.safeParse(await response.json());
        return { ok: false, error: { status: response.status, message: parsed.success ? parsed.data.error.message : 'The request could not be completed.', ...(parsed.success && parsed.data.error.fields ? { fields: parsed.data.error.fields } : {}) } };
      }
      return { ok: true, data: schema.parse(response.status === 204 ? null : await response.json()) };
    } catch {
      return { ok: false, error: { status: 0, message: 'The BCIS server could not complete the request. Check the connection and try again.' } };
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
}
