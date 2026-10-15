import { BakaClient, randomId } from '@bakatavern/api-client';

/**
 * Identifies this tab in change events and job claims. It survives reloads (sessionStorage is
 * per tab), so a reloaded tab still owns the replies it started.
 */
function tabClientId(): string {
  const key = 'bt.clientId';
  try {
    const saved = sessionStorage.getItem(key);
    if (saved) return saved;
    const id = randomId();
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    return randomId();
  }
}

/** The single API client of the app (same origin; Vite proxies /api during development). */
export const api = new BakaClient({
  clientId: tabClientId(),
  onUnauthorized: () => window.dispatchEvent(new CustomEvent('bt:unauthorized')),
});
