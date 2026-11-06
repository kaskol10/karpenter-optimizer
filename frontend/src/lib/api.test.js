import { afterEach, describe, expect, test, vi } from 'vitest';

describe('lib/api', () => {
  const originalEnv = window.ENV;

  afterEach(() => {
    window.ENV = originalEnv;
  });

  // API_URL is resolved once at import time, so each case loads a fresh copy
  // of the module (and of axios, to inspect the headers it installs).
  async function load() {
    vi.resetModules();
    const axios = (await import('axios')).default;
    const mod = await import('./api');
    return { ...mod, axios };
  }

  test('uses the runtime REACT_APP_API_URL, including an explicit empty value', async () => {
    window.ENV = { REACT_APP_API_URL: 'https://api.example.test' };
    expect((await load()).API_URL).toBe('https://api.example.test');
    window.ENV = { REACT_APP_API_URL: '' };
    expect((await load()).API_URL).toBe('');
  });

  test('falls back to same-origin when nothing is configured', async () => {
    window.ENV = undefined;
    expect((await load()).API_URL).toBe('');
  });

  test('installApiAuth sets the bearer header only when a token is configured', async () => {
    window.ENV = {};
    const none = await load();
    none.installApiAuth();
    expect(none.axios.defaults.headers.common.Authorization).toBeUndefined();

    window.ENV = { REACT_APP_API_TOKEN: 's3cret' };
    const withToken = await load();
    withToken.installApiAuth();
    expect(withToken.axios.defaults.headers.common.Authorization).toBe('Bearer s3cret');
  });
});
