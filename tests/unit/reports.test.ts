import { describe, expect, it } from 'vitest';
import {
  DashboardQuery, ReportQuery, assertBalanced, bucketBounds, bucketKey, bucketLabel, defaultGranularity, emptyTable,
  formatCell, formatMoneyCell, periodBuckets, reconcileAll, reconcileMoney, reportCatalogue, reportCodes, reportFileName,
  reportTitle, resolvePeriod, sumColumn, type ReportColumn, type ReportRow, type ReportTotal,
} from '../../source/shared/reports';

const moneyColumn: ReportColumn = { key: 'amountCentavos', label: 'Collected', kind: 'MONEY', align: 'RIGHT', runningTotal: false };
const textColumn: ReportColumn = { key: 'note', label: 'Note', kind: 'TEXT', align: 'LEFT', runningTotal: false };
const numberColumn: ReportColumn = { key: 'count', label: 'Count', kind: 'NUMBER', align: 'RIGHT', runningTotal: false };
const rows = (...amounts: number[]): ReportRow[] => amounts.map((amount) => ({ amountCentavos: amount }));
const totals = (...amounts: number[]): ReportTotal[] => [{ label: 'Total', values: { amountCentavos: amounts[0] ?? 0 }, emphasis: true }];

describe('the report catalogue', () => {
  it('carries exactly the nine reports the laboratory lists', () => {
    expect(reportCodes()).toHaveLength(9);
    expect(reportCodes()).toEqual([
      'COLLECTIONS', 'BILLING_VS_COLLECTION', 'REVENUE', 'AR_AGING', 'SUBSCRIBER_LEDGER',
      'SUBSCRIBER_MASTER', 'COLLECTOR_PERFORMANCE', 'PAYMENT_EXCEPTIONS', 'AUDIT_TRAIL',
    ]);
  });

  it('gives every report a title and a description, so the desktop needs nothing hard-coded', () => {
    for (const code of reportCodes()) {
      expect(reportTitle(code).length).toBeGreaterThan(0);
      expect(reportCatalogue[code].description.length).toBeGreaterThan(20);
      expect(reportCatalogue[code].code).toBe(code);
    }
  });

  it('marks only the reports that are snapshots or per-subscriber', () => {
    expect(reportCodes().filter((code) => reportCatalogue[code].snapshot)).toEqual(['AR_AGING']);
    expect(reportCodes().filter((code) => reportCatalogue[code].requiresSubscriber)).toEqual(['SUBSCRIBER_LEDGER']);
  });
});

describe('period bucketing', () => {
  it('produces the same key strings the SQL reports group by', () => {
    expect(bucketKey('2026-10-01', 'DAY')).toBe('2026-10-01');
    expect(bucketKey('2026-10-01', 'MONTH')).toBe('2026-10');
    expect(bucketKey('2026-10-01', 'YEAR')).toBe('2026');
    expect(bucketKey('2026-10-01', 'WEEK')).toBe('2026-W40');
  });

  it('treats Monday as the first day of an ISO week', () => {
    // 2026-10-05 is a Monday and 2026-10-04 a Sunday, and the two belong to different weeks.
    expect(bucketKey('2026-10-05', 'WEEK')).toBe('2026-W41');
    expect(bucketKey('2026-10-04', 'WEEK')).toBe('2026-W40');
  });

  it('assigns a week to the year whose Thursday it holds, so no week is counted twice', () => {
    // 31 December 2026 is a Thursday, so the week beginning Monday 28 December is 2026-W53
    // and 2027-W01 does not begin until Monday 4 January. Getting this wrong would count
    // the days between New Year and the 4th under no week at all.
    expect(bucketKey('2026-12-28', 'WEEK')).toBe('2026-W53');
    expect(bucketKey('2027-01-01', 'WEEK')).toBe('2026-W53');
    expect(bucketKey('2027-01-04', 'WEEK')).toBe('2027-W01');
    // 1 January 2021 was a Friday, so it belongs to the last week of 2020.
    expect(bucketKey('2021-01-01', 'WEEK')).toBe('2020-W53');
    expect(bucketKey('2021-01-04', 'WEEK')).toBe('2021-W01');
  });

  it('gives every bucket bounds that contain the date it came from', () => {
    for (const date of ['2026-01-01', '2026-02-28', '2026-12-31', '2026-10-05']) {
      for (const granularity of ['DAY', 'WEEK', 'MONTH', 'YEAR'] as const) {
        const bounds = bucketBounds(bucketKey(date, granularity), granularity);
        expect(bounds.from <= date && date <= bounds.to, `${date} in ${granularity}`).toBe(true);
      }
    }
  });

  it('refuses a bucket key that belongs to another granularity', () => {
    expect(() => bucketBounds('2026-10-01', 'WEEK')).toThrow(RangeError);
    expect(() => bucketBounds('2026-10', 'DAY')).toThrow(RangeError);
    expect(() => bucketBounds('2026', 'MONTH')).toThrow(RangeError);
    expect(() => bucketBounds('2026-W40', 'YEAR')).toThrow(RangeError);
    expect(() => bucketBounds('2026-13', 'MONTH')).toThrow(RangeError);
    expect(() => bucketKey('not-a-date', 'DAY')).toThrow(RangeError);
  });

  it('handles a leap day without rolling into March', () => {
    expect(bucketBounds('2028-02', 'MONTH')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(bucketBounds('2026-02', 'MONTH')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('labels a period for a person to read', () => {
    expect(bucketLabel('2026-10', 'MONTH')).toBe('October 2026');
    expect(bucketLabel('2026', 'YEAR')).toBe('2026');
    expect(bucketLabel('2026-10-01', 'DAY')).toBe('1 Oct 2026');
    expect(bucketLabel('2026-W40', 'WEEK')).toBe('Week of 28 Sep – 4 Oct 2026');
  });

  it('enumerates a range once per bucket, in order and without repeats', () => {
    const days = periodBuckets('2026-10-01', '2026-10-05', 'DAY');
    expect(days.map((entry) => entry.key)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
    const months = periodBuckets('2026-01-01', '2026-10-01', 'MONTH');
    expect(months).toHaveLength(10);
    expect(months[0]!.key).toBe('2026-01');
    expect(months[9]!.key).toBe('2026-10');
    const weeks = periodBuckets('2026-09-01', '2026-10-31', 'WEEK');
    expect(new Set(weeks.map((entry) => entry.key)).size).toBe(weeks.length);
  });

  it('picks a bucket size that suits the range', () => {
    expect(defaultGranularity('2026-10-01', '2026-10-01')).toBe('DAY');
    expect(defaultGranularity('2026-09-01', '2026-10-01')).toBe('DAY');
    expect(defaultGranularity('2026-07-01', '2026-10-01')).toBe('WEEK');
    expect(defaultGranularity('2026-01-01', '2026-10-01')).toBe('MONTH');
  });
});

describe('resolving a period', () => {
  it('defaults to one day', () => {
    expect(resolvePeriod({}, '2026-10-01')).toEqual({ from: '2026-10-01', to: '2026-10-01', granularity: 'DAY' });
  });

  it('defaults a longer range to the whole month it ends in', () => {
    // No "from": the period opens on the first of the month it is asked about, so a
    // quarter-to-date request does not quietly become a single day.
    expect(resolvePeriod({ to: '2026-10-20' }, '2026-10-01')).toEqual({ from: '2026-10-01', to: '2026-10-20', granularity: 'DAY' });
    expect(resolvePeriod({ from: '2026-01-01' }, '2026-10-01')).toEqual({ from: '2026-01-01', to: '2026-10-01', granularity: 'MONTH' });
    // An explicit granularity is never second-guessed by the default.
    expect(resolvePeriod({ from: '2026-01-01', to: '2026-10-01', granularity: 'WEEK' }, '2026-10-01').granularity).toBe('WEEK');
  });

  it('clamps a start date after the end date instead of returning an impossible range', () => {
    expect(resolvePeriod({ from: '2026-12-01', to: '2026-10-01' }, '2026-10-01').from).toBe('2026-10-01');
  });

  it('collapses a snapshot report onto the single day it describes', () => {
    expect(resolvePeriod({}, '2026-10-01', true)).toEqual({ from: '2026-10-01', to: '2026-10-01', granularity: 'MONTH' });
  });
});

describe('money', () => {
  it('adds a column as exact integers', () => {
    expect(sumColumn(rows(100, 250, 3), 'amountCentavos')).toBe(353);
    expect(sumColumn([], 'amountCentavos')).toBe(0);
  });

  it('refuses to add a column that is not whole-number centavos', () => {
    expect(() => sumColumn([{ amountCentavos: '100.50' }], 'amountCentavos')).toThrow(TypeError);
    expect(() => sumColumn([{ amountCentavos: 1.5 }], 'amountCentavos')).toThrow(TypeError);
  });

  it('treats a blank cell as nothing owed rather than as an error', () => {
    expect(sumColumn([{ amountCentavos: null }, { amountCentavos: 5 }], 'amountCentavos')).toBe(5);
  });

  it('converts centavos to a peso string by splitting the digits, not by dividing', () => {
    expect(formatMoneyCell(0)).toBe('PHP 0.00');
    expect(formatMoneyCell(5)).toBe('PHP 0.05');
    expect(formatMoneyCell(999)).toBe('PHP 9.99');
    expect(formatMoneyCell(100_000)).toBe('PHP 1,000.00');
    expect(formatMoneyCell(123_456_789)).toBe('PHP 1,234,567.89');
    expect(formatMoneyCell(-2_500)).toBe('PHP -25.00');
    expect(formatMoneyCell(123_400, false)).toBe('1,234.00');
  });

  it('leaves a text cell alone when asked to format money', () => {
    expect(formatMoneyCell('Not yet due')).toBe('Not yet due');
    expect(formatMoneyCell(null)).toBe('');
  });

  it('formats every kind of cell for display', () => {
    expect(formatCell(1234, numberColumn)).toBe('1,234');
    expect(formatCell('PLAIN', textColumn)).toBe('PLAIN');
    expect(formatCell(null, textColumn)).toBe('');
    expect(formatCell(true, textColumn)).toBe('true');
  });
});

describe('reconciliation', () => {
  it('proves a column adds up to the total stated beside it', () => {
    const [entry] = reconcileAll([moneyColumn], rows(100, 200, 300), totals(600));
    expect(entry).toEqual({
      label: 'Rows equal the stated collected', column: 'amountCentavos',
      summedCentavos: 600, statedCentavos: 600, balanced: true,
    });
  });

  it('refuses to publish a report whose rows disagree with its totals', () => {
    const broken = reconcileAll([moneyColumn], rows(100, 200), totals(999));
    expect(broken[0]!.balanced).toBe(false);
    expect(() => assertBalanced(broken)).toThrow(/do not reconcile/);
    expect(() => assertBalanced(broken)).toThrow(/300/);
  });

  it('leaves a running balance out of it, because a sum of balances is not a total', () => {
    const running: ReportColumn = { ...moneyColumn, key: 'balanceCentavos', label: 'Balance', runningTotal: true };
    const statement: ReportTotal[] = [{ label: 'Opening', values: { balanceCentavos: 0 }, emphasis: false }];
    // Summed would be 100+200 against a stated 0: a permanent, meaningless disagreement.
    expect(reconcileAll([moneyColumn, running], rows(100, 200), statement)).toHaveLength(1);
    expect(reconcileAll([running], rows(100, 200), statement)).toHaveLength(0);
  });

  it('checks every money column, so a report cannot forget one', () => {
    const other: ReportColumn = { ...moneyColumn, key: 'advanceCentavos', label: 'Customer credit held' };
    expect(reconcileAll([moneyColumn, other], rows(10), [{ label: 'T', values: { amountCentavos: 10, advanceCentavos: 10 }, emphasis: true }]))
      .toHaveLength(2);
  });

  it('reports a total the report never stated as a disagreement rather than passing it', () => {
    const entry = reconcileMoney('Total', 'amountCentavos', rows(100), []);
    expect(entry.statedCentavos).toBe(0);
    expect(entry.balanced).toBe(false);
  });
});

describe('requests', () => {
  it('accepts the filters a report offers', () => {
    const id = '018f0000-0000-4000-8000-000000000001';
    expect(ReportQuery.parse({ from: '2026-01-01', to: '2026-10-01', granularity: 'MONTH', collectorId: id }).granularity).toBe('MONTH');
  });

  it('refuses a start date after the end date rather than reversing them', () => {
    expect(ReportQuery.safeParse({ from: '2026-10-01', to: '2026-01-01' }).success).toBe(false);
  });

  it('refuses a filter it does not understand instead of ignoring it', () => {
    expect(ReportQuery.safeParse({ fortnight: 1 }).success).toBe(false);
    expect(ReportQuery.safeParse({ collectorId: 'nope' }).success).toBe(false);
  });

  it('gives the dashboard its own narrow schema, so a report filter cannot be ignored', () => {
    expect(DashboardQuery.safeParse({ to: '2026-10-01' }).success).toBe(true);
    expect(DashboardQuery.safeParse({ granularity: 'MONTH' }).success).toBe(false);
    expect(DashboardQuery.safeParse({ from: '2026-01-01' }).success).toBe(false);
  });
});

describe('file names', () => {
  it('names a file after the report and the period', () => {
    expect(reportFileName('AR_AGING', '2026-10-01', '2026-10-01', 'PDF')).toBe('BCIS-ar-aging-2026-10-01.pdf');
    expect(reportFileName('COLLECTIONS', '2026-01-01', '2026-10-01', 'XLSX')).toBe('BCIS-collections-2026-01-01_to_2026-10-01.xlsx');
  });

  it('cannot be made to climb out of the folder it is saved into', () => {
    const name = reportFileName('REVENUE', '../../etc', '2026-10-01', 'CSV');
    expect(name).not.toContain('/');
    expect(name).not.toContain('\\');
    expect(name).not.toContain('..');
  });
});

describe('an empty report', () => {
  it('is still a valid report, so a period with no rows renders instead of erroring', () => {
    const table = emptyTable({ code: 'COLLECTIONS', from: '2026-10-01', to: '2026-10-01', generatedAt: '2026-10-01T00:00:00.000Z', generatedBy: 'Owner' });
    expect(table.rows).toEqual([]);
    expect(table.rowCount).toBe(0);
    expect(table.truncated).toBe(false);
    expect(table.reconciliations).toEqual([]);
    expect(() => assertBalanced(table.reconciliations)).not.toThrow();
    // A snapshot report states the day it describes; a period report does not.
    expect(table.asOf).toBeNull();
    expect(emptyTable({ code: 'AR_AGING', from: '2026-10-01', to: '2026-10-01', generatedAt: 'x', generatedBy: 'Owner' }).asOf).toBe('2026-10-01');
  });
});