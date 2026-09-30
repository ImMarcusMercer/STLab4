export function isTrustedRendererUrl(actual: string, expected: string): boolean {
  try { return new URL(actual).href === new URL(expected).href; }
  catch { return false; }
}
