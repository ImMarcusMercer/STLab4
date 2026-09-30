import { z } from 'zod';

const Config = z.object({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  DATABASE_URL: z.url().refine((value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol)),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export function readConfig(env: Record<string, string | undefined>) {
  const result = Config.safeParse(env);
  if (!result.success) {
    // Return field names only, never a connection string from a validation error.
    throw new Error(`Invalid configuration: ${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}. See .env.example.`);
  }
  return result.data;
}
