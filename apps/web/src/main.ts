import { mount } from 'svelte';

import App from './App.svelte';
import './app.css';
import { exposePageApi } from './lib/page-api.ts';

exposePageApi();
mount(App, { target: document.getElementById('app')! });

// Service workers need a secure context (HTTPS or localhost); plain HTTP on the LAN goes without.
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
