/** Validate the dedicated development database before any local setup side effects.
 * @param {string} value
 * @returns {URL}
 */
export function localDatabaseUrl(value) {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || url.port !== '55432' || url.username !== 'bcis_local' || url.pathname !== '/bcis' || !url.password || url.password === 'replace-with-local-password' || url.search || url.hash) {
    throw new Error('Local setup requires its dedicated bcis_local@127.0.0.1:55432/bcis configuration. Custom databases must be provisioned separately.');
  }
  return url;
}
