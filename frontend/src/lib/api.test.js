// axios ships as an ES module that CRA's Jest does not transform; the code
// under test only touches axios.defaults, so a plain object stands in for it.
jest.mock('axios', () => ({ defaults: { headers: { common: {} } } }));

describe('lib/api', () => {
  const originalEnv = window.ENV;

  afterEach(() => {
    window.ENV = originalEnv;
  });

  // Each case loads a fresh copy of the module (and of axios), because
  // API_URL is resolved once at import time.
  function load() {
    let mod;
    let axios;
    jest.isolateModules(() => {
      axios = require('axios');
      mod = require('./api');
    });
    return { ...mod, axios };
  }

  test('uses the runtime REACT_APP_API_URL, including an explicit empty value', () => {
    window.ENV = { REACT_APP_API_URL: 'https://api.example.test' };
    expect(load().API_URL).toBe('https://api.example.test');
    window.ENV = { REACT_APP_API_URL: '' };
    expect(load().API_URL).toBe('');
  });

  test('installApiAuth sets the bearer header only when a token is configured', () => {
    window.ENV = {};
    const none = load();
    none.installApiAuth();
    expect(none.axios.defaults.headers.common.Authorization).toBeUndefined();

    window.ENV = { REACT_APP_API_TOKEN: 's3cret' };
    const withToken = load();
    withToken.installApiAuth();
    expect(withToken.axios.defaults.headers.common.Authorization).toBe('Bearer s3cret');
  });
});
