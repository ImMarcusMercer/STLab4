import type { Resource, MasterQuery, MasterList, MasterRecord, SaveInput, MasterHistory, Assignment } from './master-data';
import { z } from 'zod';
import type { Actor, ApiResult, LoginInput, NewUserInput, UpdateUserInput, UserList } from './auth';
import type {
  BillingCycleList, BillingRun, BillingRunList, DraftInvoiceInput, DraftItemsInput, AdjustmentInput, FinalizeInput, VoidInput,
  GenerateRunInput, OverdueSweep, OverdueSweepInput, Invoice, InvoiceList, InvoiceQueryInput, Ledger, LedgerQueryInput,
} from './billing';
import type {
  PaymentDetail, PaymentList, PaymentProofContent, PaymentQueryInput, Payment, PaymentResult, RecordPaymentInput,
  ReversePaymentInput, SubscriberAccount, VerifyPaymentInput, VoidPaymentInput,
} from './payments';

const common = { service: z.literal('bcis-api'), version: z.string().min(1) };
export const SystemStatusSchema = z.discriminatedUnion('status', [
  z.object({ ...common, status: z.literal('ready'), database: z.literal('connected') }),
  z.object({ ...common, status: z.literal('degraded'), database: z.literal('unavailable') }),
]);
export type SystemStatus = z.infer<typeof SystemStatusSchema>;
export type ConnectionResult =
  | { kind: 'status'; data: SystemStatus }
  | { kind: 'unavailable'; message: string };
export interface DesktopBridge {
  listPlans(query: MasterQuery): Promise<ApiResult<MasterList<"plans">>>;
  savePlan(id: string | null, input: SaveInput<"plans">): Promise<ApiResult<MasterRecord<"plans">>>;
  listAreas(query: MasterQuery): Promise<ApiResult<MasterList<"areas">>>;
  saveArea(id: string | null, input: SaveInput<"areas">): Promise<ApiResult<MasterRecord<"areas">>>;
  listCollectors(query: MasterQuery): Promise<ApiResult<MasterList<"collectors">>>;
  saveCollector(id: string | null, input: SaveInput<"collectors">): Promise<ApiResult<MasterRecord<"collectors">>>;
  listSubscribers(query: MasterQuery): Promise<ApiResult<MasterList<"subscribers">>>;
  saveSubscriber(id: string | null, input: SaveInput<"subscribers">): Promise<ApiResult<MasterRecord<"subscribers">>>;
  listServices(query: MasterQuery): Promise<ApiResult<MasterList<"services">>>;
  saveService(id: string | null, input: SaveInput<"services">): Promise<ApiResult<MasterRecord<"services">>>;
  getMasterRecord(resource: Resource, id: string): Promise<ApiResult<MasterRecord>>;
  getMasterHistory(resource: Resource, id: string, page: number): Promise<ApiResult<MasterHistory>>;
  assignSubscriber(id: string, input: Assignment): Promise<ApiResult<MasterRecord<"subscribers">>>;
  assignService(id: string, input: Assignment): Promise<ApiResult<MasterRecord<"services">>>;
  getSystemStatus(): Promise<ConnectionResult>;
  login(input: LoginInput): Promise<ApiResult<Actor>>;
  getSession(): Promise<ApiResult<Actor | null>>;
  logout(): Promise<ApiResult<null>>;
  lock(): Promise<ApiResult<null>>;
  listUsers(page: number): Promise<ApiResult<UserList>>;
  createUser(input: NewUserInput): Promise<ApiResult<Actor>>;
  updateUser(id: string, input: UpdateUserInput): Promise<ApiResult<Actor>>;
  // -------------------------------------------------------------- billing
  listBillingCycles(): Promise<ApiResult<BillingCycleList>>;
  listBillingRuns(page: number): Promise<ApiResult<BillingRunList>>;
  generateBillingRun(input: GenerateRunInput): Promise<ApiResult<BillingRun>>;
  listBillingInvoices(query: InvoiceQueryInput): Promise<ApiResult<InvoiceList>>;
  getBillingInvoice(id: string): Promise<ApiResult<Invoice>>;
  createBillingInvoice(input: DraftInvoiceInput): Promise<ApiResult<Invoice>>;
  replaceBillingInvoiceItems(id: string, input: DraftItemsInput): Promise<ApiResult<Invoice>>;
  finalizeBillingInvoice(id: string, input: FinalizeInput): Promise<ApiResult<Invoice>>;
  adjustBillingInvoice(id: string, input: AdjustmentInput): Promise<ApiResult<Invoice>>;
  voidBillingInvoice(id: string, input: VoidInput): Promise<ApiResult<Invoice>>;
  sweepOverdueInvoices(input: OverdueSweepInput): Promise<ApiResult<OverdueSweep>>;
  getSubscriberLedger(query: LedgerQueryInput): Promise<ApiResult<Ledger>>;
  // -------------------------------------------------------------- payments
  listPayments(query: PaymentQueryInput): Promise<ApiResult<PaymentList>>;
  getPayment(id: string): Promise<ApiResult<PaymentDetail>>;
  getSubscriberAccount(subscriberId: string): Promise<ApiResult<SubscriberAccount>>;
  getPaymentProof(id: string): Promise<ApiResult<PaymentProofContent>>;
  recordPayment(input: RecordPaymentInput): Promise<ApiResult<PaymentResult>>;
  verifyPayment(id: string, input: VerifyPaymentInput): Promise<ApiResult<PaymentResult>>;
  voidPayment(id: string, input: VoidPaymentInput): Promise<ApiResult<Payment>>;
  reversePayment(id: string, input: ReversePaymentInput): Promise<ApiResult<PaymentResult>>;
}
