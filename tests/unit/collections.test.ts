import { it, expect } from 'vitest';
import {
  batchAccountStatus, batchSummary, batchTransitions, canTransition, formatBatchNumber, formatRemittanceNumber,
  isCollectable, reconcileCash, routeAccountLimit, routeSheetTotals, BatchDetailSchema, BatchQuery, CreateBatchInput,
  ReconcileBatchInput, RemittanceInput, type BatchDetail,
} from '../../source/shared/collections';

const account = (id: string, totalDueCentavos: number, collectedCentavos: number) => ({ id, totalDueCentavos, collectedCentavos });
const figures = (cash = 0, nonCash = 0, pending = 0) => ({ expectedReceivableCentavos: 0, cashCollectedCentavos: cash, nonCashCollectedCentavos: nonCash, pendingClaimCentavos: pending });

it('numbers a batch and a remittance the same gap-free way invoices are numbered', () => {
  expect(formatBatchNumber(2026, 1)).toBe('BCH-2026-0001');
  expect(formatBatchNumber(2026, 1002)).toBe('BCH-2026-1002');
  expect(formatRemittanceNumber(2025, 12)).toBe('RMT-2025-0012');
  expect(formatBatchNumber(2026, 1)).toMatch(/^BCH-\d{4}-\d{4}$/);
  expect(formatRemittanceNumber(2026, 1)).toMatch(/^RMT-\d{4}-\d{4}$/);
});

it('allows exactly one step forward in the lifecycle and nothing backwards', () => {
  expect(Object.values(batchTransitions).flat()).toHaveLength(Object.keys(batchTransitions).length - 1);
  for (const [from, next] of Object.entries(batchTransitions)) {
    if (from === 'CLOSED') { expect(next).toEqual([]); continue; }
    expect(next).toHaveLength(1);
    expect(canTransition(from as keyof typeof batchTransitions, next[0]!)).toBe(true);
  }
  expect(canTransition('OPEN', 'SUBMITTED')).toBe(false);
  expect(canTransition('SUBMITTED', 'IN_PROGRESS')).toBe(false);
  expect(canTransition('CLOSED', 'OPEN')).toBe(false);
  expect(batchTransitions.CLOSED).toEqual([]);
});

it('takes a collection only while the route is open or in progress', () => {
  expect(isCollectable('OPEN')).toBe(true);
  expect(isCollectable('IN_PROGRESS')).toBe(true);
  // Once the route is handed in, the sheet is frozen and no more money may be added to it.
  for (const status of ['SUBMITTED', 'REMITTED', 'RECONCILED', 'CLOSED'] as const) expect(isCollectable(status)).toBe(false);
});

it('AT-07: compares the cash handed in with the cash that was due', () => {
  expect(reconcileCash(50000, 50000)).toEqual({ balanced: true, shortageCentavos: 0, overageCentavos: 0 });
  expect(reconcileCash(50000, 0)).toEqual({ balanced: false, shortageCentavos: 50000, overageCentavos: 0 });
  expect(reconcileCash(0, 0)).toEqual({ balanced: true, shortageCentavos: 0, overageCentavos: 0 });
  // A single peso is enough to make the sheet unbalanced, because centavos are the smallest unit.
  expect(reconcileCash(50000, 49999)).toEqual({ balanced: false, shortageCentavos: 1, overageCentavos: 0 });
});

it('AT-08: reports a difference as an explicit shortage or an explicit overage, never as a silent fix', () => {
  expect(reconcileCash(10000, 12345)).toEqual({ balanced: false, shortageCentavos: 0, overageCentavos: 2345 });
  // Only one direction can ever be set, so a count can never claim to be both short and over.
  for (const [expected, counted] of [[0, 1], [1, 0], [123456, 123455], [123455, 123456]] as const) {
    const result = reconcileCash(expected, counted);
    expect(Number(result.shortageCentavos > 0) + Number(result.overageCentavos > 0)).toBe(result.balanced ? 0 : 1);
  }
  expect(() => reconcileCash(-1, 0)).toThrow(RangeError);
  expect(() => reconcileCash(0, -1)).toThrow(RangeError);
  expect(() => reconcileCash(10.5, 0)).toThrow(RangeError);
});

it('reads an account as pending, partial, collected or overpaid against the frozen amount', () => {
  expect(batchAccountStatus(50000, 0)).toBe('PENDING');
  expect(batchAccountStatus(50000, 1)).toBe('PARTIAL');
  expect(batchAccountStatus(50000, 49999)).toBe('PARTIAL');
  expect(batchAccountStatus(50000, 50000)).toBe('COLLECTED');
  expect(batchAccountStatus(50000, 50001)).toBe('OVERPAID');
  // An account with nothing due is not owed anything, so nothing collected is still collected.
  expect(batchAccountStatus(0, 0)).toBe('PENDING');
});

it('sums the route from the frozen lines and keeps uncollected apart from over-collected', () => {
  const summary = batchSummary(
    [account('a', 50000, 50000), account('b', 30000, 10000), account('c', 20000, 0), account('d', 10000, 12000)],
    { expectedReceivableCentavos: 110000, cashCollectedCentavos: 62000, nonCashCollectedCentavos: 0, pendingClaimCentavos: 0 },
  );
  expect(summary.expectedReceivableCentavos).toBe(110000);
  expect(summary.totalCollectedCentavos).toBe(62000);
  expect(summary.uncollectedCentavos).toBe(40000);
  expect(summary.overCollectedCentavos).toBe(2000);
  expect(summary.accountCount).toBe(4);
  expect(summary.accountsCollected).toBe(1);
  expect(summary.accountsPartial).toBe(1);
  expect(summary.accountsUnpaid).toBe(1);
});

it('leaves a pending GCash claim out of the collected figures', () => {
  const summary = batchSummary([account('a', 50000, 50000)], figures(50000, 0, 25000));
  expect(summary.totalCollectedCentavos).toBe(50000);
  expect(summary.pendingClaimCentavos).toBe(25000);
  expect(summary.uncollectedCentavos).toBe(0);
});

it('prints the sheet from the same figures the detail screen shows', () => {
  const detail = { expectedReceivableCentavos: 110000, cashCollectedCentavos: 62000, nonCashCollectedCentavos: 0, totalCollectedCentavos: 62000, uncollectedCentavos: 40000, accountCount: 4 } as BatchDetail;
  expect(routeSheetTotals(detail)).toEqual({
    expectedReceivableCentavos: 110000, cashCollectedCentavos: 62000, nonCashCollectedCentavos: 0,
    totalCollectedCentavos: 62000, uncollectedCentavos: 40000, accountCount: 4,
  });
  // The sheet is a projection, so it carries no field of its own that the detail could disagree with.
  expect(Object.keys(routeSheetTotals(detail)).sort()).toEqual(Object.keys(detail).filter((key) => !['id', 'status'].includes(key)).sort().slice(0, 6));
});

it('bounds a route so one batch can never be an unbounded document', () => {
  expect(routeAccountLimit).toBe(500);
  const many = Array.from({ length: routeAccountLimit }, (_, index) => `1111111${index % 10}-1111-4111-8111-111111111111`);
  expect(CreateBatchInput.safeParse({ collectorId: many[0], areaId: many[0], collectionDate: '2026-09-30', subscriberIds: many }).success).toBe(true);
  expect(CreateBatchInput.safeParse({ collectorId: many[0], areaId: many[0], collectionDate: '2026-09-30', subscriberIds: [...many, many[0]!] }).success).toBe(false);
  // Without a chosen list the whole area is used, and an empty list is not a way to ask for that.
  expect(CreateBatchInput.safeParse({ collectorId: many[0], areaId: many[0], collectionDate: '2026-09-30' }).success).toBe(true);
  expect(CreateBatchInput.safeParse({ collectorId: many[0], areaId: many[0], collectionDate: '2026-09-30', subscriberIds: [] }).success).toBe(false);
});

it('requires a written reason for a reconciliation and refuses a bare one', () => {
  expect(ReconcileBatchInput.safeParse({ notes: 'Torn note explained' }).success).toBe(true);
  expect(ReconcileBatchInput.safeParse({ notes: '   ' }).success).toBe(false);
  expect(ReconcileBatchInput.safeParse({ notes: 'ok' }).success).toBe(false);
  expect(ReconcileBatchInput.safeParse({}).success).toBe(false);
  expect(ReconcileBatchInput.safeParse({ notes: 'fine', force: true }).success).toBe(false);
  // A nil remittance is legitimate, so a count of zero is allowed while a negative one is not.
  expect(RemittanceInput.safeParse({ remittedOn: '2026-09-30', cashCentavos: 0 }).success).toBe(true);
  expect(RemittanceInput.safeParse({ remittedOn: '2026-09-30', cashCentavos: -1 }).success).toBe(false);
  expect(RemittanceInput.safeParse({ remittedOn: '2026-09-30', cashCentavos: 10.5 }).success).toBe(false);
  expect(RemittanceInput.safeParse({ remittedOn: '30-09-2026', cashCentavos: 0 }).success).toBe(false);
  expect(BatchQuery.safeParse({}).success).toBe(true);
  expect(BatchQuery.safeParse({ page: 0 }).success).toBe(false);
  expect(BatchQuery.safeParse({ status: 'HALF_DONE' }).success).toBe(false);
});

it('refuses a detail document that is missing one of the figures the sheet is built from', () => {
  const detail = {
    id: '11111111-1111-4111-8111-111111111111', batchNumber: 'BCH-2026-0001', status: 'OPEN',
    collectorId: '11111111-1111-4111-8111-111111111111', collectorName: 'Ana', areaId: '11111111-1111-4111-8111-111111111111', areaName: 'Poblacion',
    collectionDate: '2026-09-30', expectedReceivableCentavos: 50000, cashCollectedCentavos: 0, nonCashCollectedCentavos: 0,
    pendingClaimCentavos: 0, totalCollectedCentavos: 0, uncollectedCentavos: 50000, overCollectedCentavos: 0,
    accountCount: 1, accountsCollected: 0, accountsPartial: 0, accountsUnpaid: 1,
    shortageCentavos: 0, overageCentavos: 0, balanced: false,
    startedAt: null, submittedAt: null, remittedAt: null, reconciledAt: null, reconciledName: null, reconciliationNotes: '',
    closedAt: null, createdBy: '11111111-1111-4111-8111-111111111111', createdName: 'Owner', createdAt: '2026-09-30T00:00:00.000Z',
    accounts: [{ id: '11111111-1111-4111-8111-111111111111', subscriberId: '11111111-1111-4111-8111-111111111111', subscriberCode: 'SUB001', subscriberName: 'Sample', address: 'Malaybalay', currentBillCentavos: 50000, arrearsCentavos: 0, totalDueCentavos: 50000, collectedCentavos: 0, status: 'PENDING' }],
    remittance: null,
  };
  expect(BatchDetailSchema.safeParse(detail).success).toBe(true);
  expect(BatchDetailSchema.safeParse({ ...detail, uncollectedCentavos: undefined }).success).toBe(false);
  expect(BatchDetailSchema.safeParse({ ...detail, remittance: undefined }).success).toBe(false);
  expect(BatchDetailSchema.safeParse({ ...detail, accounts: [{ ...detail.accounts[0], totalDueCentavos: -1 }] }).success).toBe(false);
  expect(BatchDetailSchema.safeParse({ ...detail, status: 'PARTLY_DONE' }).success).toBe(false);
});
