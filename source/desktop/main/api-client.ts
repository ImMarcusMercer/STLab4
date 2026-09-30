import { SystemStatusSchema, type ConnectionResult } from '../../shared/contracts';

export function parseApiUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('BCIS_API_URL must be an HTTP(S) origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('BCIS_API_URL must be an HTTP(S) origin without credentials, path, query or fragment.');
  }
  return url.origin;
}

export async function getSystemStatus(origin: string): Promise<ConnectionResult> {
  try {
    const response = await fetch(`${parseApiUrl(origin)}/api/v1/system/status`, {
      signal: AbortSignal.timeout(4_000), redirect: 'error', headers: { Accept: 'application/json' },
    });
    if (![200, 503].includes(response.status)) throw new Error('Unexpected status');
    const data = SystemStatusSchema.parse(await response.json());
    if ((data.status === 'ready') !== (response.status === 200)) throw new Error('Inconsistent status');
    return { kind: 'status', data };
  } catch {
    return { kind: 'unavailable', message: 'Unable to reach the BCIS API. Check that the server is running and the configured address is correct.' };
  }
}
