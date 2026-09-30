import { describe, expect, it } from 'vitest';
import { isTrustedRendererUrl } from '../../source/desktop/main/renderer-security';

describe('trusted renderer URL', () => {
  it('accepts the canonical trailing slash Chromium adds to the development origin', () => {
    expect(isTrustedRendererUrl('http://localhost:5173/', 'http://localhost:5173')).toBe(true);
  });
  it.each(['http://localhost:5174/', 'http://localhost:5173/other', 'https://example.com/', 'not-a-url'])('rejects a different page %s', (actual) => {
    expect(isTrustedRendererUrl(actual, 'http://localhost:5173')).toBe(false);
  });
});
