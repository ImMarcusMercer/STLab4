import type { FastifyServerOptions } from 'fastify';

/**
 * The option object Fastify passes to pino: Fastify's own additions (level, serializers,
 * stream) merged with the pino ones (base, timestamp, redact).
 */
type LoggerOptions = Extract<FastifyServerOptions['logger'], object>;

/**
 * Phase 9: structured logging and the redaction that keeps it safe to keep.
 *
 * The API already writes one JSON object per line, but two things were missing. First, the
 * log carried whatever Fastify put in it, so a bearer token in a header or a password in a
 * request body would have been written to disk if anything ever logged one. Second, an error
 * message quoted from a driver can contain a connection string, and the pool's password is
 * in it.
 *
 * Both are closed here rather than by remembering not to do it: the paths below are removed
 * from every line whatever the caller passes, and `scrubSecrets` removes credentials from
 * free text before it is written.
 *
 * `tests/unit/logging.test.ts` and `tests/integration/security.test.ts` both prove this by
 * reading real log output rather than by inspecting the configuration.
 */
export const SECRET_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["proxy-authorization"]',
  'password',
  'passwordHash',
  'password_hash',
  'newPassword',
  'currentPassword',
  'body.password',
  'body.newPassword',
  'body.currentPassword',
  'body.data.password',
  '*.password',
  '*.passwordHash',
  '*.token',
  'token',
  'tokenHash',
  'token_hash',
  'sessionToken',
  'DATABASE_URL',
  '*.DATABASE_URL',
  'connectionString',
  '*.connectionString',
  // A GCash proof arrives as base64 in the body; a logged line should never carry an
  // uploaded customer's photograph.
  '*.base64',
  'base64',
] as const;

/** `[redacted]`, written in place of a secret so a reader can see that one was there. */
export const REDACTION = '[redacted]';

/** A connection string with its password replaced, wherever one appears in free text. */
const CONNECTION_STRING = /((?:postgres|postgresql|mysql|mariadb|redis|amqp):\/\/[^:\s/@]+:)[^@\s]*@/gi;
/** `password=…`, `PGPASSWORD: …`, `pwd:…` and similar in a message, a file name or a command line. */
const SECRET_ASSIGNMENT = /\b(PGPASSWORD|password|passwd|pwd|secret|api[_-]?key|token)(\s*[=:]\s*)["']?[^"'\s,;)]+["']?/gi;

/**
 * Removes credentials from text that is about to be logged.
 *
 * This is the last line of defence, not the first: a message is written through it because a
 * driver error can quote the connection string it failed on, and the pool's password is in
 * it. A message that never held a secret is returned unchanged, so an operator reading a log
 * still sees what actually happened.
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(CONNECTION_STRING, `$1${REDACTION}@`)
    .replace(SECRET_ASSIGNMENT, (_match, name: string, separator: string) => `${name}${separator}${REDACTION}`);
}

const isoTime = () => `,"time":"${new Date().toISOString()}"`;

type LoggableRequest = { method?: string; url?: string; id?: string; ip?: string; headers: Record<string, unknown> };
type LoggableError = { name?: string; code?: string; message?: string; stack?: string; statusCode?: number };

/**
 * The logger every API process uses.
 *
 * Three choices worth stating, because they are what make a log line worth keeping:
 *
 * - `base` carries `service`, so a line from this API can be told apart from the desktop's or
 *   from a migration tool's when several processes write to one file.
 * - the request serializer keeps the method, path, id, peer address and user agent, and drops
 *   every other header. The default serializer copies the header object, which is where an
 *   `Authorization` value would otherwise be duplicated on every line.
 * - the error serializer writes the type, code, status, scrubbed message and stack. The stack
 *   is what makes a crash diagnosable; the message is scrubbed because a driver quotes the
 *   connection string it failed on, and that string carries the pool password.
 */
export function buildLoggerOptions(level: string, stream?: { write: (line: string) => void }): LoggerOptions {
  return {
    level,
    base: { service: 'bcis-api' },
    timestamp: isoTime,
    redact: { paths: [...SECRET_PATHS], censor: REDACTION },
    ...(stream ? { stream } : {}),
    serializers: {
      req: (request: LoggableRequest) => ({
        method: request.method,
        url: request.url,
        reqId: request.id,
        remoteAddress: request.ip,
        userAgent: request.headers['user-agent'],
      }),
      res: (reply: { statusCode?: number }) => ({ statusCode: reply.statusCode }),
      err: (error: LoggableError) => ({
        type: error.name ?? 'Error',
        code: error.code,
        statusCode: error.statusCode,
        message: scrubSecrets(error.message ?? ''),
        // The stack repeats the message, so it is scrubbed as well. Leaving it alone was a real
        // leak: the first version of this suite caught a whole connection string, password
        // included, arriving through the stack of a failed readiness check.
        stack: scrubSecrets(error.stack ?? ''),
      }),
    },
  };
}
