import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import { installApiAuth } from './lib/api';

installApiAuth();

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

