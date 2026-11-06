// Single source of truth for reaching the backend API.
//
// The base URL comes from the runtime config (window.ENV, written by the
// container's config.js) and falls back to the build-time env var, then to
// same-origin. An explicit empty string in window.ENV means same-origin too.
import axios from 'axios';

function resolveApiUrl() {
  const env = typeof window !== 'undefined' ? window.ENV : undefined;
  if (env && Object.prototype.hasOwnProperty.call(env, 'REACT_APP_API_URL')) {
    return env.REACT_APP_API_URL || '';
  }
  return process.env.REACT_APP_API_URL || '';
}

export const API_URL = resolveApiUrl();

// When the backend runs with API_AUTH_TOKEN, the chart hands the frontend the
// same token as a runtime env (window.ENV, never baked into the bundle). Every
// API call then carries it as a Bearer header. Local dev without auth: no-op.
export function installApiAuth() {
  const token = typeof window !== 'undefined' && window.ENV && window.ENV.REACT_APP_API_TOKEN;
  if (token) {
    axios.defaults.headers.common.Authorization = `Bearer ${token}`;
  }
}
