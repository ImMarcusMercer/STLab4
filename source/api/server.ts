import 'dotenv/config';
import { buildApp } from './app';
import { readConfig } from './config';
import { createDatabase } from './database';
import { AuthService } from './auth/service';

const config = readConfig(process.env);
const database = createDatabase(config.DATABASE_URL);
const app = buildApp({ checkDatabase: database.check, logLevel: config.LOG_LEVEL, auth: new AuthService(database.pool) });
app.addHook('onClose', () => database.close());
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close(); });
}
try { await app.listen({ host: config.HOST, port: config.PORT }); }
catch {
  app.log.error('Unable to start API. Check the configured host and port.');
  await app.close();
  process.exitCode = 1;
}
