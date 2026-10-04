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
import type {
  BatchDetail, BatchList, BatchQueryInput, CloseBatchInput, CreateBatchInput, ReconcileBatchInput, RemittanceInput,
  RouteSheet, SubmitBatchInput,
} from './collections';
import type {
  AssignTechnicianInput, CompleteReconnectionInput, LiftSuspensionInput, ReceivableList, ReceivableQueryInput,
  ReceivableSummary, RequestReconnectionInput,   ServiceControlEvent, ServicePolicy, ServiceTechnician, SuspendServiceInput, Suspension,
  SuspensionList, SuspensionQueryInput, UpdatePolicyInput,
} from './receivables';
import type {
  Dashboard, DashboardQueryInput, ExportFormat, ReportCatalogue, ReportCode, ReportQueryInput, ReportTable,
} from './reports';
import type {
  BackupList, BackupRecord, BackupVerification, CreateBackupInput, RestoreBackupInput, RestoreReport,
} from './backups';

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
  // -------------------------------------------------------------- collections
  // Every collection command answers with the stored batch, so the screen redraws from server
  // truth instead of guessing what a button did to the figures.
  listCollectionBatches(query: BatchQueryInput): Promise<ApiResult<BatchList>>;
  getCollectionBatch(id: string): Promise<ApiResult<BatchDetail>>;
  getCollectionRouteSheet(id: string): Promise<ApiResult<RouteSheet>>;
  createCollectionBatch(input: CreateBatchInput): Promise<ApiResult<BatchDetail>>;
  startCollectionBatch(id: string): Promise<ApiResult<BatchDetail>>;
  submitCollectionBatch(id: string, input: SubmitBatchInput): Promise<ApiResult<BatchDetail>>;
  remitCollectionBatch(id: string, input: RemittanceInput): Promise<ApiResult<BatchDetail>>;
  reconcileCollectionBatch(id: string, input: ReconcileBatchInput): Promise<ApiResult<BatchDetail>>;
  closeCollectionBatch(id: string, input: CloseBatchInput): Promise<ApiResult<BatchDetail>>;
  // -------------------------------------------------- receivables & service control
  // Receivables are derived from open invoices and a suspension or reconnection is a
  // document, not a flag, so every command here forwards to the guarded API command and
  // answers with the stored document. The desktop never decides an amount or a lifecycle.
  getReceivableSummary(query?: string): Promise<ApiResult<ReceivableSummary>>;
  listOverdueReceivables(query?: ReceivableQueryInput | string): Promise<ApiResult<ReceivableList>>;
  getServicePolicy(): Promise<ApiResult<ServicePolicy>>;
  updateServicePolicy(input: UpdatePolicyInput): Promise<ApiResult<ServicePolicy>>;
  listServiceTechnicians(): Promise<ApiResult<ServiceTechnician[]>>;
  listSuspensions(query?: SuspensionQueryInput | string): Promise<ApiResult<SuspensionList>>;
  getSuspension(id: string): Promise<ApiResult<Suspension>>;
  suspendService(serviceAccountId: string, input: SuspendServiceInput): Promise<ApiResult<Suspension>>;
  liftSuspension(id: string, input: LiftSuspensionInput): Promise<ApiResult<Suspension>>;
  requestReconnection(id: string, input: RequestReconnectionInput): Promise<ApiResult<Suspension>>;
  assignTechnician(id: string, input: AssignTechnicianInput): Promise<ApiResult<Suspension>>;
  completeReconnection(id: string, input: CompleteReconnectionInput): Promise<ApiResult<Suspension>>;
  getServiceControlHistory(serviceAccountId: string): Promise<ApiResult<ServiceControlEvent[]>>;

  // -------------------------------------------------- reports, dashboard and exports
  // Every figure on these screens comes from the server as an integer number of centavos,
  // already reconciled against its own rows. The renderer formats and draws; it never sums,
  // never rounds and never decides what a period means.
  getReportCatalogue(): Promise<ApiResult<ReportCatalogue>>;
  getReport(code: ReportCode, query?: ReportQueryInput | string): Promise<ApiResult<ReportTable>>;
  getDashboard(query?: DashboardQueryInput | string): Promise<ApiResult<Dashboard>>;

  /**
   * Produces the export on the server and saves it through the native dialog, answering
   * only with what happened. There is no operation that returns bytes or accepts a path,
   * because either would let a renderer read or write files of its own choosing.
   */
  exportReport(
    code: ReportCode,
    query: ReportQueryInput | string,
    format: ExportFormat,
  ): Promise<ApiResult<{ saved: boolean; fileName: string; bytes?: number }>>;

  /**
   * Produces the official receipt on the server and saves it through the native dialog.
   *
   * A receipt is the document a customer leaves with, so the PDF is built where the allocation
   * and receipt number are authoritative rather than in the renderer. The server audits the
   * print when it renders, so this is also the record that a receipt was handed over. A receipt
   * that cannot fit one page is refused with a message pointing at the statement of account,
   * and that message is passed through rather than replaced with a generic failure.
   */
  printReceipt(id: string): Promise<ApiResult<{ saved: boolean; fileName: string; bytes?: number }>>;

  // -------------------------------------------------- backups
  // The backup archive is written, listed and restored by the API. The desktop never chooses a
  // path for it and never receives its bytes, so a renderer cannot read or delete an archive.
  listBackups(): Promise<ApiResult<BackupList>>;

  /**
   * Takes a backup on the server.
   *
   * 'FULL' carries the payment proofs as well as the database, and is what an operator means by
   * a backup; 'DATABASE' is the dump alone, recorded as such so nobody mistakes it for a complete
   * one. The response only arrives once the server has read the finished archive back.
   */
  createBackup(input: CreateBackupInput | string): Promise<ApiResult<BackupRecord>>;

  /**
   * Checks an existing backup without restoring it: the digest answers "are these still the same
   * bytes" and the listing answers "is this still a readable archive". Read-only, so an auditor
   * may run it.
   */
  verifyBackup(id: string): Promise<ApiResult<BackupVerification>>;

  /**
   * Restores a backup over the live database.
   *
   * The confirmation phrase is required by the server, and the result reports the row counts that
   * were compared and any difference by name, so the answer shown is the server's rather than a
   * reassuring message.
   */
  restoreBackup(id: string, input: RestoreBackupInput | string): Promise<ApiResult<RestoreReport>>;
}
