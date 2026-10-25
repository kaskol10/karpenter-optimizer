import React from 'react';
import ReactDOM from 'react-dom/client';
import axios from 'axios';
import './index.css';
import App from './App';

// When the backend runs with API_AUTH_TOKEN, the frontend (deployed via the
// chart) receives the same token as a runtime env (window.ENV) and sends it
// as a Bearer header on every API call. Local dev without auth: unset, no-op.
(function applyApiToken() {
  const token = window.ENV && window.ENV.REACT_APP_API_TOKEN;
  if (token) {
    axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
  }
})();

// Apply the persisted theme (or the system preference) before first paint so
// there is no flash of the wrong theme.
(function applyInitialTheme() {
  const stored = localStorage.getItem('karpenter-optimizer-theme');
  const dark = stored
    ? stored === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('dark', dark);
})();

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

