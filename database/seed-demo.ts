import { crc32, deflateSync } from 'node:zlib';
import type pg from 'pg';
import { buildApp } from '../source/api/app';
import { AuthService } from '../source/api/auth/service';
import { periodOf, shiftPeriod } from '../source/shared/billing';
import type { RoleCode } from '../source/shared/auth';
import { BatchDetailSchema, BatchListSchema, type BatchDetail } from '../source/shared/collections';
import { ReceivableListSchema, ReceivableSummarySchema, SuspensionListSchema } from '../source/shared/receivables';
import { SubscriberAccountSchema, type SubscriberAccount } from '../source/shared/payments';
import { seedSecurity } from './seed-security';

/**
 * Phase 10: the demonstration dataset.
 *
 * The laboratory asks for a realistic office rather than one subscriber: five users across
 * the roles, seven plans, fifty subscribers, sixty-odd service accounts, three billing
 * months, a mix of payment kinds, overdue accounts in more than one aging bucket, a reversal
 * or void, and suspension/reconnection scenarios. See section 8 of the activity.
 *
 * Two decisions are what make this dataset defensible:
 *
 * 1. **Nothing is inserted with raw SQL.** Every subscriber, invoice, payment, batch,
 *    suspension and ledger entry is produced by calling the same Fastify routes, services,
 *    permissions and number sequences the desktop calls. The seed therefore cannot produce a
 *    state the application itself would refuse, and the invoice, receipt and batch numbers in
 *    the demonstration are real gap-free numbers from the real sequences.
 * 2. **Nothing is fabricated behind the reports.** Accounts are left deliberately unpaid,
 *    part-paid and overpaid, and the aging figures are then read back from the receivables
 *    API rather than written down here. The verification at the end fails loudly when the
 *    dataset does not meet the laboratory's minimums, instead of printing a table that
 *    claims a success the database does not hold.
 *
 * Every record is synthetic and prefixed `DEMO-`, and the seed refuses to run twice: a second
 * run would duplicate the demonstration rather than refresh it, and the project rule is that
 * posted financial history is never deleted to make room for a fresh start.
 */

export const DEMO_PREFIX = 'DEMO-';

export interface DemoSeedOptions {
  pool: pg.Pool;
  ownerUsername: string;
  ownerPassword: string;
  /** The synthetic password given to every demonstration staff account. */
  password: string;
  /** How many subscribers to create. The laboratory minimum is 50. */
  subscribers?: number;
  log?: (message: string) => void;
}

export interface DemoRequirement {
  key: string;
  label: string;
  minimum: number;
}

/** Section 8 of the laboratory, plus the payment mix section 3.6 asks to be demonstrated. */
export const demoRequirements: DemoRequirement[] = [
  { key: 'staffUsers', label: 'Users covering Admin, Cashier, Supervisor, Auditor/Viewer', minimum: 5 },
  { key: 'internetPlans', label: 'Internet plans', minimum: 3 },
  { key: 'cablePlans', label: 'Cable plans', minimum: 2 },
  { key: 'comboPlans', label: 'Combo plans', minimum: 2 },
  { key: 'subscribers', label: 'Subscribers', minimum: 50 },
  { key: 'serviceAccounts', label: 'Service accounts', minimum: 60 },
  { key: 'serviceTypes', label: 'Service types in use across those accounts', minimum: 3 },
  { key: 'collectors', label: 'Collectors', minimum: 2 },
  { key: 'areas', label: 'Collection areas', minimum: 3 },
  { key: 'billingMonths', label: 'Billing months generated', minimum: 3 },
  { key: 'cashPayments', label: 'Posted cash payments', minimum: 1 },
  { key: 'gcashPayments', label: 'Verified GCash payments', minimum: 1 },
  { key: 'partialPayments', label: 'Partial payments leaving a part-paid invoice', minimum: 1 },
  { key: 'advancePayments', label: 'Advance payments holding a credit', minimum: 1 },
  { key: 'overdueAccounts', label: 'Overdue accounts', minimum: 10 },
  { key: 'agingBuckets', label: 'Aging buckets holding overdue money', minimum: 3 },
  { key: 'reversedPayments', label: 'Reversed payments', minimum: 1 },
  { key: 'voidedPayments', label: 'Voided payment entries', minimum: 1 },
  { key: 'collectionBatches', label: 'Reconciled and closed collection routes', minimum: 1 },
  { key: 'suspensions', label: 'Suspension / reconnection scenarios', minimum: 2 },
];

export interface DemoRequirementRow extends DemoRequirement {
  actual: number;
  met: boolean;
}

export interface DemoSeedResult {
  counts: Record<string, number>;
  rows: DemoRequirementRow[];
  unmet: string[];
  /** Handle-free references for the documentation: codes and numbers only, never a password. */
  showcase: {
    ledgerSubscriberCode: string;
    overdueSubscriberCodes: string[];
    agingSubscriberCodes: string[];
    suspendedSubscriberCodes: string[];
    reconnectedSubscriberCode: string;
    advanceSubscriberCode: string;
    partialSubscriberCode: string;
    reversedReceiptNumber: string;
    voidedGcashReference: string;
    pendingGcashReference: string;
    closedBatchNumbers: string[];
    periods: string[];
  };
}

// ---------------------------------------------------------------- static fixtures

const areas = [
  { code: 'DEMO-A1', name: 'Demo Area 1 - Poblacion North', description: 'Synthetic demonstration collection area.' },
  { code: 'DEMO-A2', name: 'Demo Area 2 - Mabini South', description: 'Synthetic demonstration collection area.' },
  { code: 'DEMO-A3', name: 'Demo Area 3 - San Isidro East', description: 'Synthetic demonstration collection area.' },
];

const collectors = [
  { code: 'DEMO-C1', name: 'Demo Collector One', contact: '09170000010', notes: 'Synthetic demonstration collector.' },
  { code: 'DEMO-C2', name: 'Demo Collector Two', contact: '09170000011', notes: 'Synthetic demonstration collector.' },
];

/** Three Internet, two Cable and two Combo plans, with the fees the invoice engine can use. */
const plans = [
  { code: 'DEMO-N50', name: 'Demo Internet 50', serviceType: 'INTERNET', priceCentavos: 74_900, installationFeeCentavos: 100_000, reconnectionFeeCentavos: 10_000, speedMbps: 50, channelCount: null },
  { code: 'DEMO-N100', name: 'Demo Internet 100', serviceType: 'INTERNET', priceCentavos: 99_900, installationFeeCentavos: 100_000, reconnectionFeeCentavos: 10_000, speedMbps: 100, channelCount: null },
  { code: 'DEMO-N200', name: 'Demo Internet 200', serviceType: 'INTERNET', priceCentavos: 129_900, installationFeeCentavos: 120_000, reconnectionFeeCentavos: 15_000, speedMbps: 200, channelCount: null },
  { code: 'DEMO-C50', name: 'Demo Cable 50', serviceType: 'CABLE', priceCentavos: 35_000, installationFeeCentavos: 50_000, reconnectionFeeCentavos: 5_000, speedMbps: null, channelCount: 50 },
  { code: 'DEMO-C80', name: 'Demo Cable 80', serviceType: 'CABLE', priceCentavos: 45_000, installationFeeCentavos: 60_000, reconnectionFeeCentavos: 5_000, speedMbps: null, channelCount: 80 },
  { code: 'DEMO-CB100', name: 'Demo Combo 100', serviceType: 'COMBO', priceCentavos: 139_900, installationFeeCentavos: 150_000, reconnectionFeeCentavos: 15_000, speedMbps: 100, channelCount: 60 },
  { code: 'DEMO-CB200', name: 'Demo Combo 200', serviceType: 'COMBO', priceCentavos: 169_900, installationFeeCentavos: 150_000, reconnectionFeeCentavos: 20_000, speedMbps: 200, channelCount: 80 },
] as const;

const staff: { username: string; displayName: string; role: RoleCode }[] = [
  { username: 'demo-admin', displayName: 'Demo Administrator', role: 'ADMIN' },
  { username: 'demo-cashier', displayName: 'Demo Cashier', role: 'CASHIER' },
  { username: 'demo-supervisor', displayName: 'Demo Collection Supervisor', role: 'SUPERVISOR' },
  { username: 'demo-auditor', displayName: 'Demo Auditor', role: 'AUDITOR' },
  { username: 'demo-viewer', displayName: 'Demo Read-only Viewer', role: 'VIEWER' },
  { username: 'demo-technician', displayName: 'Demo Technician', role: 'TECHNICIAN' },
];

const surnames = ['Abad', 'Bagumbayan', 'Cabarrog', 'Dumalag', 'Gomez', 'Hilario', 'Immantong', 'Jurat', 'Kinugsa', 'Luy-a', 'Mabangon', 'Nugan', 'Oclarit', 'Pabalan', 'Quijano', 'Razon', 'Salamat', 'Tuminac', 'Ugdan', 'Villar', 'Wagas', 'Yabot', 'Zapanta'];
const givenNames = ['Allyn', 'Besian', 'Caryl', 'Dovi', 'Elma', 'Fede', 'Grace', 'Hera', 'Iman', 'Jovy', 'Kyla', 'Liezl', 'Mika', 'Nina', 'Ozzy', 'Pia', 'Rhea', 'Soya', 'Tina', 'Una', 'Val', 'Wes', 'Yara', 'Zed'];
const streetNames = ['Acacia', 'Bamboo', 'Cogon', 'Durian', 'Eucalyptus', 'Falcon', 'Guava', 'Hibiscus', 'Ipil', 'Jackfruit', 'Kamal', 'Langka'];

/** The staff password is never a real one; it is generated for the rehearsal and written to the ignored local configuration. */
const groups = {
  /** Every generated invoice settled: the accounts the dashboard and the reports show as current. */
  goodStanding: 30,
  /** Part-paid: one invoice left at PARTIALLY_PAID so the register and the ledger have a partial to show. */
  partial: 10,
  /** One deliberate arrears invoice each, one per aging bucket. */
  aging: 5,
  /** Paid ahead of the three billed months, so an advance credit exists to spend. */
  advance: 3,
  /** Disconnected and still owing: the suspension candidate on the register. */
  suspended: 1,
  /** Disconnected, paid off, reconnected by a technician: the completed trail. */
  reconnected: 1,
};

/** Days of arrears behind the five aging accounts, so each bucket is represented whatever day the seed runs. */
const agingTargets = [
  { bucket: 'D1_30', daysAgo: 20, description: 'Unpaid subscription carried forward' },
  { bucket: 'D31_60', daysAgo: 45, description: 'Unpaid subscription carried forward' },
  { bucket: 'D61_90', daysAgo: 75, description: 'Unpaid subscription carried forward' },
  { bucket: 'D90_PLUS', daysAgo: 130, description: 'Unpaid subscription carried forward' },
  { bucket: 'CURRENT', daysAgo: -12, description: 'Installation fee for the new service drop' },
] as const;

const policy = { gracePeriodDays: 60, suspensionThresholdCentavos: 100_000, autoSuspend: false, reconnectionFeeCentavos: 75_000 };

// ---------------------------------------------------------------- small helpers

const iso = (date: Date) => date.toISOString().slice(0, 10);
const today = () => iso(new Date());
/** A date `days` away from today, as the server writes dates. */
const offset = (days: number) => iso(new Date(Date.now() + days * 86_400_000));
/** The first of the month `months` before the current one, which is how the seed dates an activation. */
const monthStartAgo = (months: number) => `${shiftPeriod(periodOf(today()), -months)}-01`;
/** Whole pesos, never a fraction of one: the allocation engine works in centavos but the office pays in pesos. */
const pesos = (centavos: number) => Math.floor(centavos / 100) * 100;
const pad = (value: number, length: number) => String(value).padStart(length, '0');
const first = <T>(rows: readonly T[], what: string): T => {
  const row = rows[0];
  if (row === undefined) throw new Error(`The demonstration seed expected ${what}.`);
  return row;
};
const entry = <T>(rows: readonly T[], index: number, what: string): T => {
  const row = rows[index];
  if (row === undefined) throw new Error(`The demonstration seed expected ${what}.`);
  return row;
};

/**
 * A small, valid PNG written here rather than shipped as a binary blob, so the GCash proof in
 * the demonstration dataset is visibly synthetic and the seed stays text-only. The server
 * checks the real magic bytes, so this has to be a real PNG rather than a placeholder string.
 */
function syntheticReceiptPng(tint: number): string {
  const width = 240;
  const height = 96;
  const scanlines = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const start = row * (width * 3 + 1);
    scanlines[start] = 0;
    for (let column = 0; column < width; column += 1) {
      const at = start + 1 + column * 3;
      scanlines[at] = (tint + column * 3) % 256;
      scanlines[at + 1] = (tint + row * 5) % 256;
      scanlines[at + 2] = 200;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;   // bit depth
  header[9] = 2;   // truecolour
  const png = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return png.toString('base64');
}

/** Splits a total into group sizes by largest remainder, so a smaller rehearsal still has every group. */
function splitGroups(total: number) {
  const weights = Object.entries(groups);
  const sum = weights.reduce((running, [, weight]) => running + weight, 0);
  const raw = weights.map(([, weight]) => ({ weight, exact: (total * weight) / sum }));
  const sizes = raw.map(entry => Math.floor(entry.exact));
  let remainder = total - sizes.reduce((running, size) => running + size, 0);
  const order = raw
    .map((entry, index) => ({ index, fraction: entry.exact - Math.floor(entry.exact) }))
    .sort((left, right) => right.fraction - left.fraction);
  for (const { index } of order) {
    if (remainder <= 0) break;
    const target = sizes[index];
    if (target === undefined) continue;
    sizes[index] = target + 1;
    remainder -= 1;
  }
  return Object.fromEntries(weights.map(([key], index) => [key, entry(sizes, index, 'a group size')])) as Record<keyof typeof groups, number>;
}

// ---------------------------------------------------------------- the seed

export async function seedDemoDataset(options: DemoSeedOptions): Promise<DemoSeedResult> {
  const { pool, ownerUsername, ownerPassword, password } = options;
  const subscriberTotal = options.subscribers ?? 50;
  const log = options.log ?? (() => undefined);
  const auth = new AuthService(pool);

  const existing = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM subscribers WHERE code LIKE $1', [`${DEMO_PREFIX}%`]);
  if (Number(first(existing.rows, 'a subscriber count').count) > 0) {
    throw new Error('The demonstration dataset is already present. It is never deleted and re-seeded, because posted financial history must not be removed; use a fresh database for another rehearsal.');
  }

  // Role permissions are top-ups, not resets: a development database seeded before a later
  // phase added a permission is brought up to date here, and an existing owner keeps its
  // password because seedSecurity only inserts the account when it is missing.
  await seedSecurity(pool, { username: ownerUsername, displayName: 'BCIS Owner', password: ownerPassword });

  const owner = (await auth.login(ownerUsername, ownerPassword)).token;
  const app = buildApp({ checkDatabase: async () => undefined, auth, logLevel: 'silent' });
  const counts: Record<string, number> = {};
  const add = (key: string, by = 1) => { counts[key] = (counts[key] ?? 0) + by; };
  const showcase = {
    ledgerSubscriberCode: '', overdueSubscriberCodes: [] as string[], agingSubscriberCodes: [] as string[],
    suspendedSubscriberCodes: [] as string[], reconnectedSubscriberCode: '', advanceSubscriberCode: '',
    partialSubscriberCode: '', reversedReceiptNumber: '', voidedGcashReference: '', pendingGcashReference: '',
    closedBatchNumbers: [] as string[], periods: [] as string[],
  };

  /** One API call, with the failure message that a demonstration rehearsal needs. */
  const call = async (method: 'GET' | 'POST' | 'PUT', url: string, token: string, payload?: Record<string, unknown>) => {
    const response = await app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, payload });
    if (response.statusCode >= 400) {
      throw new Error(`${method} ${url} answered ${response.statusCode}: ${response.body.slice(0, 400)}`);
    }
    return response.json() as unknown;
  };
  const create = async (resource: string, data: unknown, token: string, reason: string) => {
    const saved = await call('POST', `/${resource}`, token, { data, reason }) as Record<string, unknown>;
    const id = saved.id;
    if (typeof id !== 'string') throw new Error(`Creating ${resource} returned no id.`);
    return id;
  };

  try {
    // ---------------------------------------------------------- staff accounts
    log('Creating the demonstration staff accounts...');
    const tokens: Record<string, string> = { owner };
    for (const person of staff) {
      await auth.createUser(owner, { username: person.username, displayName: person.displayName, password, roles: [person.role] });
      tokens[person.role] = (await auth.login(person.username, password)).token;
      add('staffUsers');
    }
    const admin = tokens.ADMIN as string;
    const cashier = tokens.CASHIER as string;
    const supervisor = tokens.SUPERVISOR as string;
    const auditor = tokens.AUDITOR as string;
    let technicianId = '';
    {
      const found = await pool.query<{ id: string }>('SELECT id FROM users WHERE username=$1', ['demo-technician']);
      technicianId = first(found.rows, 'the demonstration technician').id;
    }

    // ---------------------------------------------------------- master data
    log('Creating collection areas, collectors and plans...');
    const areaIds: string[] = [];
    for (const area of areas) {
      areaIds.push(await create('areas', { ...area, active: true }, admin, 'Demonstration collection area'));
      add('areas');
    }
    const collectorIds: string[] = [];
    for (const collector of collectors) {
      collectorIds.push(await create('collectors', { ...collector, active: true }, admin, 'Demonstration collector'));
      add('collectors');
    }
    const planIds: string[] = [];
    const planRates: number[] = [];
    for (const plan of plans) {
      planIds.push(await create('plans', { ...plan, description: 'Synthetic demonstration plan.', active: true }, admin, 'Demonstration plan'));
      planRates.push(plan.priceCentavos);
      add(plan.serviceType === 'INTERNET' ? 'internetPlans' : plan.serviceType === 'CABLE' ? 'cablePlans' : 'comboPlans');
    }

    log(`Creating ${subscriberTotal} subscribers and their service accounts...`);
    const sizes = splitGroups(subscriberTotal);
    type Account = { subscriberId: string; subscriberCode: string; subscriberName: string; serviceId: string; serviceCode: string; planId: string; rateCentavos: number; areaId: string; collectorId: string };
    const accounts: Account[] = [];
    const groupOf = (index: number) => {
      for (const [name, size] of Object.entries(sizes) as [keyof typeof sizes, number][]) {
        if (index < size) return name;
        index -= size;
      }
      return 'goodStanding' as const;
    };
    for (let index = 0; index < subscriberTotal; index += 1) {
      const serial = pad(index + 1, 3);
      const areaId = entry(areaIds, index % areaIds.length, 'a collection area');
      const collectorId = entry(collectorIds, index % collectorIds.length, 'a collector');
      const planIndex = index % plans.length;
      const planId = entry(planIds, planIndex, 'a plan id');
      const rateCentavos = entry(planRates, planIndex, 'a plan rate');
      const subscriberCode = `DEMO-S${serial}`;
      const surname = entry(surnames, index % surnames.length, 'a surname');
      const given = entry(givenNames, index % givenNames.length, 'a given name');
      const street = entry(streetNames, index % streetNames.length, 'a street name');
      const purok = (index % 7) + 1;
      const address = `Purok ${purok}, ${street} Street, Barangay Demo ${index % 3 + 1}, Malaybalay City`;
      // A handful of accounts start later, so the dataset has services with a shorter history.
      const monthsAgo = index % 8 === 7 ? 2 : 4;
      const activation = monthStartAgo(monthsAgo);
      const subscriberId = await create('subscribers', {
        code: subscriberCode, name: `${surname}, ${given}.`, contact: `0917000${pad(index + 1, 4)}`,
        email: `demo.s${serial.toLowerCase()}@bcis.invalid`, addresses: [address],
        areaId, collectorId, billingDay: 1, dueDay: 5, status: 'ACTIVE',
        notes: 'Synthetic laboratory demonstration subscriber.',
      }, admin, 'Demonstration subscriber');
      add('subscribers');
      const serviceCount = index % 4 === 0 ? 2 : 1;
      for (let service = 1; service <= serviceCount; service += 1) {
        const serviceCode = `DEMO-S${serial}-${service}`;
        const serviceId = await create('services', {
          code: serviceCode, subscriberId, planId, installationAddress: service === 1 ? address : `${address} (second address)`,
          activationDate: activation, billingStartDate: activation, billingDay: 1, dueDay: 5,
          currentRateCentavos: rateCentavos, status: 'ACTIVE', areaId, collectorId,
          notes: 'Synthetic laboratory demonstration service account.',
        }, admin, 'Demonstration service account');
        add('serviceAccounts');
        if (service === 1) accounts.push({ subscriberId, subscriberCode, subscriberName: `${surname}, ${given}.`, serviceId, serviceCode, planId, rateCentavos, areaId, collectorId });
      }
    }
    if (accounts.length === 0) throw new Error('The demonstration seed created no service accounts.');

    // ---------------------------------------------------------- billing
    const periods = [-3, -2, -1].map(months => shiftPeriod(periodOf(today()), months));
    showcase.periods = periods;
    log(`Generating ${periods.length} billing periods through the billing engine...`);
    for (const period of periods) {
      await call('POST', '/billing/runs', admin, { period });
      add('billingMonths');
    }

    // A policy the suspension decisions are measured against, set before anything is suspended.
    await call('PUT', '/service-control/policy', admin, { ...policy, reason: 'Demonstration disconnection policy' });

    // ---------------------------------------------------------- payments
    log('Recording cash and GCash payments, including partial and advance payments...');
    const accountPanel = async (subscriberId: string): Promise<SubscriberAccount> =>
      SubscriberAccountSchema.parse(await call('GET', `/payments/account?subscriberId=${subscriberId}`, cashier));
    let reference = 0;
    const nextReference = () => {
      reference += 1;
      return `GC-DEMO-${pad(reference, 6)}`;
    };

    /** Records a payment as the cashier and, for GCash, has the administrator confirm it. */
    const collect = async (subscriberId: string, method: 'CASH' | 'GCASH', amountCentavos: number, receivedOn: string, notes: string, batchId?: string) => {
      const payload: Record<string, unknown> = { subscriberId, method, amountCentavos, receivedOn, notes };
      if (method === 'GCASH') {
        payload.referenceNumber = nextReference();
        payload.proof = { fileName: `gcash-proof-${reference}.png`, mimeType: 'image/png', base64: syntheticReceiptPng(reference * 7) };
      }
      if (batchId) payload.collectionBatchId = batchId;
      // Attaching money to a frozen route sheet needs `collection.manage` as well as
      // `payment.create`, which only the administrator and the owner hold.
      const recorded = await call('POST', '/payments', batchId ? admin : cashier, payload) as { payment: { id: string } };
      if (method === 'GCASH') {
        await call('POST', `/payments/${recorded.payment.id}/verify`, admin, { notes: 'Reference checked against the attached proof.' });
        add('gcashPayments');
      } else {
        add('cashPayments');
      }
      return recorded.payment.id;
    };

    const byGroup = (name: keyof typeof groups) => accounts.filter((_account, index) => groupOf(index) === name);
    const partialAccounts = byGroup('partial');
    const agingAccounts = byGroup('aging');
    const suspendedAccounts = byGroup('suspended');
    const reconnectedAccounts = byGroup('reconnected');

    let reversedPaymentId = '';
    for (const [index, account] of accounts.entries()) {
      const group = groupOf(index);
      const panel = await accountPanel(account.subscriberId);
      if (panel.outstandingCentavos <= 0) continue;
      const method: 'CASH' | 'GCASH' = index % 3 === 0 ? 'GCASH' : 'CASH';
      const receivedOn = offset(-Math.max(1, Math.min(45, 70 - (index % 9) * 7)));
      if (group === 'goodStanding' || group === 'aging') {
        const id = await collect(account.subscriberId, method, panel.outstandingCentavos, receivedOn, `Full settlement of the account to date (${account.serviceCode}).`);
        // The first settled account becomes the demonstration reversal below, so the register
        // shows both a correct posting and a corrected one.
        if (index === 0) reversedPaymentId = id;
      } else if (group === 'partial') {
        const amount = pesos(panel.outstandingCentavos * 0.6);
        if (amount > 0 && amount < panel.outstandingCentavos) {
          await collect(account.subscriberId, method, amount, receivedOn, `Part payment against ${account.serviceCode}.`);
          add('partialPayments');
          if (!showcase.partialSubscriberCode) showcase.partialSubscriberCode = account.subscriberCode;
        }
      } else if (group === 'advance') {
        await collect(account.subscriberId, method, pesos(account.rateCentavos * 4), receivedOn, 'Paid four months ahead against three billed months.');
        add('advancePayments');
        if (!showcase.advanceSubscriberCode) showcase.advanceSubscriberCode = account.subscriberCode;
      }
    }
    showcase.ledgerSubscriberCode = accounts[0]?.subscriberCode ?? '';

    // ---------------------------------------------------------- aging fixtures
    log('Raising the deliberate arrears that put one account in each aging bucket...');
    for (const [position, account] of agingAccounts.entries()) {
      const target = entry(agingTargets, position % agingTargets.length, 'an aging target');
      const dueDate = offset(-target.daysAgo);
      const issued = offset(-target.daysAgo - 5);
      const itemType = target.bucket === 'CURRENT' ? 'INSTALLATION' : 'SUBSCRIPTION';
      const unitPriceCentavos = target.bucket === 'CURRENT' ? 50_000 : account.rateCentavos;
      const draft = await call('POST', '/billing/invoices', admin, {
        serviceAccountId: account.serviceId, issueDate: issued, dueDate, notes: `Demonstration ${target.bucket} account`,
        items: [{ itemType, description: `${target.description} (${dueDate})`, quantity: 1, unitPriceCentavos }],
      }) as { id: string };
      await call('POST', `/billing/invoices/${draft.id}/finalize`, admin, { reason: 'Demonstration arrears' });
      showcase.agingSubscriberCodes.push(account.subscriberCode);
    }
    // Marking what is past due is the office's overdue sweep, and the reports read the same rows.
    await call('POST', '/billing/overdue-sweep', admin, {});

    // ---------------------------------------------------------- suspension and reconnection
    log('Suspending the delinquent accounts and reconnecting one of them...');
    for (const account of suspendedAccounts) {
      await call('POST', `/service-control/services/${account.serviceId}/suspend`, admin, {
        reason: 'Three months unpaid with no contact', notes: 'Demonstration disconnection decision.',
      });
      showcase.suspendedSubscriberCodes.push(account.subscriberCode);
    }
    for (const account of reconnectedAccounts) {
      await call('POST', `/service-control/services/${account.serviceId}/suspend`, admin, {
        reason: 'Two months unpaid', notes: 'Demonstration disconnection before the reconnection workflow.',
      });
      showcase.suspendedSubscriberCodes.push(account.subscriberCode);
      // The reconnection is refused while money is open, so the account is settled first.
      const panel = await accountPanel(account.subscriberId);
      if (panel.outstandingCentavos > 0) {
        await collect(account.subscriberId, 'CASH', panel.outstandingCentavos, offset(-1), 'Settled before the reconnection was requested.');
      }
      const register = SuspensionListSchema.parse(await call('GET', '/service-control/suspensions?perPage=100', admin));
      const row = register.items.find(item => item.serviceAccountId === account.serviceId);
      if (!row) throw new Error(`The demonstration suspension for ${account.serviceCode} is not on the register.`);
      await call('POST', `/service-control/suspensions/${row.id}/reconnection`, admin, { notes: 'Demonstration reconnection with the policy fee.' });
      await call('POST', `/service-control/suspensions/${row.id}/reconnection/assign`, admin, { technicianId, notes: 'Assigned by the office.' });
      await call('POST', `/service-control/suspensions/${row.id}/reconnection/complete`, admin, { notes: 'Line restored and tested.' });
      showcase.reconnectedSubscriberCode = account.subscriberCode;
    }

    // ---------------------------------------------------------- collection routes
    log('Opening, working, remitting and closing one collection route per area...');
    const routeDate = offset(-2);
    for (const [position, areaId] of areaIds.entries()) {
      const collectorId = entry(collectorIds, position % collectorIds.length, 'a collector');
      const batch = BatchDetailSchema.parse(await call('POST', '/collections/batches', supervisor, {
        collectorId, areaId, collectionDate: routeDate, notes: 'Demonstration route sheet',
      })) as BatchDetail;
      await call('POST', `/collections/batches/${batch.id}/start`, supervisor, {});
      // Cash collected on the route is recorded against the frozen sheet, which is what the
      // batch totals are derived from afterwards.
      const worked = entry(batch.accounts, 0, 'a route account');
      const panel = await accountPanel(worked.subscriberId);
      const collectedCentavos = pesos(panel.outstandingCentavos * 0.5);
      if (collectedCentavos > 0) {
        await collect(worked.subscriberId, 'CASH', collectedCentavos, routeDate, 'Collected on the demonstration route.', batch.id);
      }
      await call('POST', `/collections/batches/${batch.id}/submit`, supervisor, { notes: 'Route worked.' });
      const counted = BatchDetailSchema.parse(await call('GET', `/collections/batches/${batch.id}`, supervisor)) as BatchDetail;
      // The remittance counts exactly the cash the route posted, so the sheet balances (AT-07).
      await call('POST', `/collections/batches/${batch.id}/remittance`, supervisor, { remittedOn: offset(-1), cashCentavos: counted.cashCollectedCentavos, notes: 'Cash handed in at the office.' });
      // Reconciled by the administrator, who is not the person who counted the cash.
      await call('POST', `/collections/batches/${batch.id}/reconcile`, admin, { notes: 'Counted and signed by a second authorised user.' });
      const closed = BatchDetailSchema.parse(await call('POST', `/collections/batches/${batch.id}/close`, admin, {})) as BatchDetail;
      showcase.closedBatchNumbers.push(closed.batchNumber);
      add('collectionBatches');
    }

    // ---------------------------------------------------------- the correction history
    log('Recording the void and the reversal the audit trail must show...');
    {
      const account = first(partialAccounts, 'a part-paid account');
      const claimed = await call('POST', '/payments', cashier, {
        subscriberId: account.subscriberId, method: 'GCASH', amountCentavos: pesos(account.rateCentavos), receivedOn: offset(-4),
        referenceNumber: nextReference(), notes: 'Claimed from the demonstration Facebook page.',
        proof: { fileName: `gcash-proof-${reference}.png`, mimeType: 'image/png', base64: syntheticReceiptPng(24) },
      }) as { payment: { id: string; referenceNumber: string | null } };
      await call('POST', `/payments/${claimed.payment.id}/void`, cashier, { reason: 'The customer sent the wrong reference; recorded against the wrong account.' });
      showcase.voidedGcashReference = claimed.payment.referenceNumber ?? '';
      add('voidedPayments');
    }
    if (reversedPaymentId) {
      // The auditor holds payment.reverse, which is how an office correction is separated from
      // the person who took the money.
      await call('POST', `/payments/${reversedPaymentId}/reverse`, auditor, { reason: 'Demonstration reversal: the payment was posted against the wrong account.' });
      add('reversedPayments');
    }
    {
      const account = first(partialAccounts, 'a part-paid account');
      const pending = await call('POST', '/payments', cashier, {
        subscriberId: account.subscriberId, method: 'GCASH', amountCentavos: pesos(account.rateCentavos), receivedOn: today(),
        referenceNumber: nextReference(), notes: 'Waiting for a second person to check the reference.',
        proof: { fileName: `gcash-proof-${reference}.png`, mimeType: 'image/png', base64: syntheticReceiptPng(96) },
      }) as { payment: { referenceNumber: string | null } };
      showcase.pendingGcashReference = pending.payment.referenceNumber ?? '';
    }

    // ---------------------------------------------------------- verification
    log('Reading the dataset back through the API to check it against the laboratory minimums...');
    return await verify(pool, app, owner, counts, showcase);
  } finally {
    await app.close();
  }
}

/**
 * The demonstration is only credible if the figures on its screens come from the same rows the
 * rest of the system uses, so the check reads them back over HTTP and fails rather than
 * printing a table that the database does not support.
 */
async function verify(
  pool: pg.Pool,
  app: ReturnType<typeof buildApp>,
  owner: string,
  counts: Record<string, number>,
  showcase: DemoSeedResult['showcase'],
): Promise<DemoSeedResult> {
  const get = async (url: string, token: string) => {
    const response = await app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` } });
    if (response.statusCode >= 400) throw new Error(`GET ${url} answered ${response.statusCode}: ${response.body.slice(0, 400)}`);
    return response.json() as unknown;
  };
  const tableCount = async (table: string) => {
    const counted = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
    return Number(first(counted.rows, `a ${table} count`).count);
  };

  // Read through the API where an API answer exists, so the check cannot pass on a figure the
  // office would never be shown.
  const summary = ReceivableSummarySchema.parse(await get('/receivables/summary', owner));
  const overdue = ReceivableListSchema.parse(await get('/receivables/overdue?perPage=100', owner));
  const suspensions = SuspensionListSchema.parse(await get('/service-control/suspensions?perPage=100', owner));
  const batches = BatchListSchema.parse(await get('/collections/batches?perPage=100', owner));
  // The reversal and the void are counted from the rows themselves rather than from what the
  // seed believes it did.
  const paymentStates = await pool.query<{ status: string; count: string }>('SELECT status,count(*)::text AS count FROM payments GROUP BY status');
  const state = (status: string) => Number(paymentStates.rows.find(row => row.status === status)?.count ?? 0);
  const months = await pool.query<{ count: string }>("SELECT count(DISTINCT period_label)::text AS count FROM invoices WHERE period_label<>''");
  const serviceTypes = await pool.query<{ count: string }>('SELECT count(DISTINCT p.service_type)::text AS count FROM service_accounts sa JOIN service_plans p ON p.id=sa.plan_id');

  counts.overdueAccounts = overdue.items.length;
  counts.agingBuckets = summary.aging.filter(bucket => bucket.totalCentavos > 0).length;
  counts.billingMonths = Number(first(months.rows, 'a billing month count').count);
  counts.collectionBatches = batches.items.filter(batch => batch.status === 'CLOSED').length;
  counts.suspensions = suspensions.items.length;
  counts.serviceTypes = Number(first(serviceTypes.rows, 'a service type count').count);
  counts.reversedPayments = state('REVERSED');
  counts.voidedPayments = state('VOID');
  counts.subscribers = await tableCount('subscribers');
  counts.serviceAccounts = await tableCount('service_accounts');
  counts.invoices = await tableCount('invoices');
  counts.receipts = await tableCount('payments').then(async total => total - state('PENDING') - state('VOID'));
  counts.auditEntries = await tableCount('audit_logs');

  showcase.overdueSubscriberCodes = overdue.items.slice(0, 8).map(row => row.subscriberCode);
  showcase.suspendedSubscriberCodes = suspensions.items.map(row => row.subscriberCode);

  const rows: DemoRequirementRow[] = demoRequirements.map(requirement => {
    const actual = counts[requirement.key] ?? 0;
    return { ...requirement, actual, met: actual >= requirement.minimum };
  });
  return { counts, rows, unmet: rows.filter(row => !row.met).map(row => `${row.label}: ${row.actual} of ${row.minimum}`), showcase };
}