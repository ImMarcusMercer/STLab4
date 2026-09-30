import type pg from 'pg';
import { NewUserInput, roleNames, type RoleCode } from '../source/shared/auth';
import { hashPassword } from '../source/api/auth/passwords';
import { rolePermissions } from '../source/api/auth/roles';

export async function seedSecurity(pool: pg.Pool, input: { username: string; displayName: string; password: string }) {
  const user = NewUserInput.parse({ ...input, roles: ['OWNER'] });
  const hash = await hashPassword(user.password);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(1739101)');
    for (const role of Object.keys(roleNames) as RoleCode[]) {
      await client.query('INSERT INTO roles(code,name) VALUES($1,$2) ON CONFLICT(code) DO UPDATE SET name=excluded.name', [role, roleNames[role]]);
      for (const permission of rolePermissions[role]) {
        await client.query('INSERT INTO permissions(code) VALUES($1) ON CONFLICT DO NOTHING', [permission]);
        await client.query('INSERT INTO role_permissions(role_code,permission_code) VALUES($1,$2) ON CONFLICT DO NOTHING', [role, permission]);
      }
    }
    const created = await client.query<{ id: string }>('INSERT INTO users(username,display_name,password_hash) VALUES($1,$2,$3) ON CONFLICT(username) DO NOTHING RETURNING id', [user.username, user.displayName, hash]);
    if (created.rows[0]) {
      await client.query('INSERT INTO user_roles(user_id,role_code) VALUES($1,$2)', [created.rows[0].id, 'OWNER']);
      await client.query('INSERT INTO audit_logs(actor_id,action,subject_id,details) VALUES($1,$2,$1,$3)', [created.rows[0].id, 'user.bootstrap', JSON.stringify({ username: user.username })]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
