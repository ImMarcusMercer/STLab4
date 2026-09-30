import type pg from 'pg';
import { randomBytes } from 'node:crypto';
import { ActorSchema, type Actor, type NewUserInput, type UpdateUserInput } from '../../shared/auth';
import { hashPassword, tokenDigest, verifyPassword } from './passwords';
import { ApiError } from './errors';

const actorQuery = `SELECT u.id,u.username,u.display_name AS "displayName",u.active,
  coalesce(array_agg(DISTINCT r.role_code) FILTER (WHERE r.role_code IS NOT NULL),'{}') AS roles,
  coalesce(array_agg(DISTINCT p.permission_code) FILTER (WHERE p.permission_code IS NOT NULL),'{}') AS permissions
  FROM users u LEFT JOIN user_roles r ON r.user_id=u.id
  LEFT JOIN role_permissions p ON p.role_code=r.role_code`;
const unauthorized = () => new ApiError(401, 'UNAUTHORIZED', 'Sign in with a valid account to continue.');
const dummyHash = `scrypt$131072$8$1$${'0'.repeat(32)}$${'0'.repeat(128)}`;
type Client = pg.Pool | pg.PoolClient;

export class AuthService {
  constructor(readonly pool: pg.Pool) {}

  private async actor(id: string, client: Client = this.pool): Promise<Actor> {
    const result = await client.query(`${actorQuery} WHERE u.id=$1 GROUP BY u.id`, [id]);
    if (!result.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Account not found.');
    return ActorSchema.parse(result.rows[0]);
  }

  async authorize(token: string, permission?: string, client: Client = this.pool): Promise<Actor> {
    if (!/^[a-f0-9]{64}$/.test(token)) throw unauthorized();
    const session = await client.query<{ user_id: string }>('SELECT s.user_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true', [tokenDigest(token)]);
    if (!session.rows[0]) throw unauthorized();
    const actor = await this.actor(session.rows[0].user_id, client);
    if (!actor.active) throw unauthorized();
    if (permission && !actor.permissions.includes(permission)) throw new ApiError(403, 'FORBIDDEN', 'Your account does not have permission for this action.');
    return actor;
  }

  private async transaction<T>(operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize identity changes so concurrent owner removals cannot both succeed.
      await client.query('SELECT pg_advisory_xact_lock(1739101)');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') throw new ApiError(409, 'CONFLICT', 'That username is already in use.');
      throw error;
    } finally { client.release(); }
  }

  async login(username: string, password: string) {
    const found = await this.pool.query<{ id: string; password_hash: string; active: boolean }>('SELECT id,password_hash,active FROM users WHERE username=$1', [username]);
    const candidate = found.rows[0];
    const valid = await verifyPassword(password, candidate?.password_hash ?? dummyHash);
    if (!valid || !candidate?.active) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Username or password is incorrect.');
    return this.transaction(async (client) => {
      const current = await client.query('SELECT password_hash,active FROM users WHERE id=$1', [candidate.id]);
      if (!current.rows[0]?.active || current.rows[0].password_hash !== candidate.password_hash) throw unauthorized();
      const token = randomBytes(32).toString('hex');
      await client.query('DELETE FROM sessions WHERE user_id=$1 AND expires_at<=now()', [candidate.id]);
      await client.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '8 hours')", [tokenDigest(token), candidate.id]);
      await client.query('INSERT INTO audit_logs(actor_id,action,subject_id) VALUES($1,$2,$1)', [candidate.id, 'auth.login']);
      return { token, user: await this.actor(candidate.id, client) };
    });
  }

  async revoke(token: string, action: 'auth.logout' | 'auth.lock') {
    await this.transaction(async (client) => {
      const actor = await this.authorize(token, undefined, client);
      await client.query('DELETE FROM sessions WHERE token_hash=$1', [tokenDigest(token)]);
      await client.query('INSERT INTO audit_logs(actor_id,action,subject_id) VALUES($1,$2,$1)', [actor.id, action]);
    });
  }

  async listUsers(token: string, page: number, perPage: number) {
    await this.authorize(token, 'user.manage');
    const rows = await this.pool.query(`${actorQuery} GROUP BY u.id ORDER BY u.username LIMIT $1 OFFSET $2`, [perPage, (page - 1) * perPage]);
    const total = await this.pool.query<{ count: string }>('SELECT count(*) FROM users');
    return { items: rows.rows.map((row) => ActorSchema.parse(row)), page, perPage, total: Number(total.rows[0]?.count ?? 0) };
  }

  async createUser(token: string, input: NewUserInput) {
    await this.authorize(token, 'user.manage');
    const hash = await hashPassword(input.password);
    return this.transaction(async (client) => {
      const actor = await this.authorize(token, 'user.manage', client);
      const result = await client.query<{ id: string }>('INSERT INTO users(username,display_name,password_hash) VALUES($1,$2,$3) RETURNING id', [input.username, input.displayName, hash]);
      const id = result.rows[0]!.id;
      for (const role of input.roles) await client.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [id, role]);
      await client.query('INSERT INTO audit_logs(actor_id,action,subject_id,details) VALUES($1,$2,$3,$4)', [actor.id, 'user.create', id, JSON.stringify({ username: input.username, roles: input.roles })]);
      return this.actor(id, client);
    });
  }

  async updateUser(token: string, id: string, input: UpdateUserInput) {
    await this.authorize(token, 'user.manage');
    const hash = input.password ? await hashPassword(input.password) : undefined;
    return this.transaction(async (client) => {
      const actor = await this.authorize(token, 'user.manage', client);
      const before = await this.actor(id, client);
      await client.query('UPDATE users SET display_name=coalesce($2,display_name),active=coalesce($3,active),password_hash=coalesce($4,password_hash) WHERE id=$1', [id, input.displayName ?? null, input.active ?? null, hash ?? null]);
      if (input.roles) {
        await client.query('DELETE FROM user_roles WHERE user_id=$1', [id]);
        for (const role of input.roles) await client.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [id, role]);
      }
      const owners = await client.query("SELECT 1 FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.active=true AND r.role_code='OWNER' LIMIT 1");
      if (!owners.rowCount) throw new ApiError(409, 'LAST_OWNER', 'Keep at least one active Owner account.');
      if (input.roles || input.active !== undefined || hash) await client.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      const after = await this.actor(id, client);
      await client.query('INSERT INTO audit_logs(actor_id,action,subject_id,details) VALUES($1,$2,$3,$4)', [actor.id, 'user.update', id, JSON.stringify({ before, after, passwordChanged: Boolean(hash) })]);
      return after;
    });
  }
}
