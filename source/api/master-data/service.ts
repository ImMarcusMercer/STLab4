import type pg from 'pg';
import { z } from 'zod';
import { masterInputs, type Resource, ListQuery, EditMetadata, AssignmentInput } from '../../shared/master-data';
import { ApiError } from '../auth/errors';
import type { AuthService } from '../auth/service';

const config = {
  plans: { table: 'service_plans', read: ['subscriber.view', 'service.view', 'plan.manage'], write: 'plan.manage', search: ['code','name','description'] },
  areas: { table: 'collection_areas', read: ['subscriber.view', 'collection.view', 'service.view'], write: 'collection.manage', search: ['code','name','description'] },
  collectors: { table: 'collectors', read: ['subscriber.view', 'collection.view'], write: 'collection.manage', search: ['code','name','contact'] },
  subscribers: { table: 'subscribers', read: ['subscriber.view'], write: 'subscriber.manage', search: ['code','name','contact','email','addresses'] },
  services: { table: 'service_accounts', read: ['subscriber.view', 'service.view'], write: 'service.manage', search: ['code','installation_address'] },
} satisfies Record<Resource, { table: string; read: string[]; write: string; search: string[] }>;
const column = (name: string) => name.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
const fields = (resource: Resource) => [...Object.keys(masterInputs[resource].shape), 'id', 'version', 'createdAt', ...(resource === 'services' ? ['planVersion'] : [])];
const select = (resource: Resource) => fields(resource).map(key => `${['activationDate','billingStartDate'].includes(key) ? `to_char(${column(key)},'YYYY-MM-DD')` : column(key)} AS "${key}"`).join(',');
type Row = Record<string, unknown>;
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(422, 'VALIDATION', 'Check the highlighted fields.', z.flattenError(result.error).fieldErrors as Record<string, string[]>);
  return result.data;
}
const conflict = (message: string) => new ApiError(409, 'CONFLICT', message);

export class MasterService {
  constructor(private auth: AuthService) {}
  async authorize(resource: Resource, token: string, write = false, client: pg.Pool | pg.PoolClient = this.auth.pool) {
    const actor = await this.auth.authorize(token, undefined, client);
    const required: string[] = write ? [config[resource].write] : config[resource].read;
    if (!required.some(permission => actor.permissions.includes(permission))) throw new ApiError(403, 'FORBIDDEN', 'Your account does not have permission for this action.');
    return actor;
  }
  async get(resource: Resource, token: string, id: string) {
    await this.authorize(resource, token); return this.read(resource, id, this.auth.pool);
  }
  private async read(resource: Resource, id: string, client: pg.Pool | pg.PoolClient): Promise<Row> {
    const result = await client.query(`SELECT ${select(resource)} FROM ${config[resource].table} WHERE id=$1`, [id]);
    if (!result.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Record not found.');
    return result.rows[0] as Row;
  }
  async list(resource: Resource, token: string, raw: unknown) {
    await this.authorize(resource, token);
    const query = parse(ListQuery, raw); const values: unknown[] = [];
    const conditions: string[] = [];
    if (query.q) {
      values.push(`%${query.q.replace(/[\\%_]/g, '\\$&')}%`);
      conditions.push(`(${config[resource].search.map(key => `${key}::text ILIKE $${values.length}`).join(' OR ')})`);
    }
    if (query.status) {
      const statuses = resource === 'subscribers' ? ['ACTIVE','INACTIVE','TERMINATED','ARCHIVED'] : resource === 'services' ? ['PENDING','ACTIVE','INACTIVE','TERMINATED','ARCHIVED'] : ['ACTIVE','INACTIVE'];
      if (!statuses.includes(query.status)) throw new ApiError(422, 'VALIDATION', 'Invalid status filter.');
      values.push(['plans','areas','collectors'].includes(resource) ? query.status === 'ACTIVE' : query.status);
      conditions.push(`${['plans','areas','collectors'].includes(resource) ? 'active' : 'status'}=$${values.length}`);
    }
    if (query.subscriberId) {
      if (resource !== 'services') throw new ApiError(422, 'VALIDATION', 'Subscriber filter is only available for services.');
      values.push(query.subscriberId); conditions.push(`subscriber_id=$${values.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sort = resource === 'services' ? 'code' : query.sort;
    // One statement gives the count and page a consistent snapshot, even for an empty page.
    const result = await this.auth.pool.query(`WITH filtered AS (SELECT ${select(resource)} FROM ${config[resource].table} ${where}), page AS (SELECT * FROM filtered ORDER BY "${sort}" ${query.direction},id LIMIT $${values.length + 1} OFFSET $${values.length + 2}) SELECT coalesce((SELECT jsonb_agg(page) FROM page),'[]') AS items,(SELECT count(*)::int FROM filtered) AS total`, [...values, query.perPage, (query.page - 1) * query.perPage]);
    return { ...result.rows[0], page: query.page, perPage: query.perPage };
  }
  async history(resource: Resource, token: string, id: string, raw: unknown) {
    await this.authorize(resource, token); await this.read(resource, id, this.auth.pool);
    const query = parse(ListQuery, raw);
    const rows = await this.auth.pool.query('SELECT h.version,h.snapshot,h.reason,u.display_name AS "actorName",h.created_at AS "createdAt" FROM master_history h JOIN users u ON u.id=h.actor_id WHERE resource=$1 AND record_id=$2 ORDER BY version DESC LIMIT $3 OFFSET $4', [resource,id,query.perPage,(query.page-1)*query.perPage]);
    const count = await this.auth.pool.query('SELECT count(*)::int AS total FROM master_history WHERE resource=$1 AND record_id=$2', [resource,id]);
    return { items: rows.rows, total: count.rows[0].total, page: query.page, perPage: query.perPage };
  }
  async save(resource: Resource, token: string, id: string | null, raw: unknown, assignmentOnly = false) {
    if (assignmentOnly) await this.auth.authorize(token, 'collection.manage'); else await this.authorize(resource, token, true);
    const envelope = assignmentOnly ? parse(AssignmentInput, raw) : parse(EditMetadata.extend({ data: masterInputs[resource] }).strict(), raw);
    if (id && envelope.version === undefined) throw new ApiError(422, 'VALIDATION', 'Reload the record before saving.');
    const client = await this.auth.pool.connect();
    try {
      await client.query('BEGIN');
      // Shares identity lock with role changes; prevents authorization races and reference changes.
      await client.query('SELECT pg_advisory_xact_lock(1739101)');
      const actor = assignmentOnly ? await this.auth.authorize(token, 'collection.manage', client) : await this.authorize(resource, token, true, client);
      const before = id ? await this.read(resource,id,client) : null;
      if (before && before.version !== envelope.version) throw conflict('Another user changed this record. Refresh and apply your changes again.');
      const source = assignmentOnly ? { ...Object.fromEntries(Object.keys(masterInputs[resource].shape).map(key => [key, before?.[key]])), areaId: (envelope as z.infer<typeof AssignmentInput>).areaId, collectorId: (envelope as z.infer<typeof AssignmentInput>).collectorId } : (envelope as { data: unknown }).data;
      const data = parse(masterInputs[resource] as z.ZodType<Row>, source);
      if (before && data.code !== before.code) throw conflict('Account and reference codes cannot be changed.');
      if (before && resource === 'plans' && data.serviceType !== before.serviceType) throw conflict('Create a new plan for a different service type.');
      if (before && resource === 'services' && data.subscriberId !== before.subscriberId) throw conflict('A service cannot be transferred to another subscriber.');
      for (const [key, table] of [['areaId','collection_areas'],['collectorId','collectors'],['planId','service_plans'],['subscriberId','subscribers']] as const) {
        if (!data[key]) continue;
        const reference = await client.query(`SELECT * FROM ${table} WHERE id=$1`, [data[key]]);
        const row = reference.rows[0];
        const newlyAssigned = !before || before[key] !== data[key];
        if (!row || (newlyAssigned && (row.active === false || (table === 'subscribers' && row.status !== 'ACTIVE')))) throw new ApiError(422, 'VALIDATION', 'Select an existing active reference.', { [key]: ['This reference is missing or inactive.'] });
        if (key === 'planId') data.planVersion = newlyAssigned ? row.version : before?.planVersion;
        if (key === 'subscriberId' && data.status === 'ACTIVE' && row.status !== 'ACTIVE') throw conflict('Activate the subscriber before activating a service.');
      }
      if (resource === 'subscribers' && id && data.status !== 'ACTIVE') {
        const active = await client.query("SELECT 1 FROM service_accounts WHERE subscriber_id=$1 AND status='ACTIVE' LIMIT 1", [id]);
        if (active.rowCount) throw conflict('Deactivate active service accounts before changing the subscriber status.');
      }
      const keys = Object.keys(masterInputs[resource].shape); if (resource === 'services') keys.push('planVersion');
      const values = keys.map(key => key === 'addresses' ? JSON.stringify(data[key]) : data[key]);
      let savedId = id;
      if (id) await client.query(`UPDATE ${config[resource].table} SET ${keys.map((key,i) => `${column(key)}=$${i+1}`).join(',')},version=version+1 WHERE id=$${values.length+1}`, [...values,id]);
      else {
        const result = await client.query(`INSERT INTO ${config[resource].table}(${keys.map(column).join(',')}) VALUES(${values.map((_,i) => `$${i+1}`).join(',')}) RETURNING id`,values); savedId = result.rows[0].id as string;
      }
      const after = await this.read(resource,savedId!,client);
      await client.query('INSERT INTO master_history(resource,record_id,version,snapshot,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6)', [resource,savedId,after.version,JSON.stringify(after),envelope.reason,actor.id]);
      await client.query('INSERT INTO audit_logs(actor_id,action,subject_id,details) VALUES($1,$2,$3,$4)', [actor.id,`${resource}.${before ? assignmentOnly ? 'assign' : 'update' : 'create'}`,savedId,JSON.stringify({ before, after, reason: envelope.reason })]);
      await client.query('COMMIT'); return after;
    } catch (error) {
      await client.query('ROLLBACK');
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') throw conflict('That account or reference code already exists.');
      throw error;
    } finally { client.release(); }
  }
}
