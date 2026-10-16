/**
 * The mock model API as SillyTavern sees it during recording. Runs inside the network namespace
 * SillyTavern joins: plain HTTP on 5057 (custom endpoints, reverse proxies, control) and HTTPS on
 * 443 for providers with fixed hosts, which /etc/hosts points at this namespace.
 *
 * Usage (in a container): node mock-host.ts <tls-key.pem> <tls-cert.pem>
 */

import { readFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';

import { createMockServer } from '../../mock-llm/src/server.ts';

const [keyPath, certPath] = process.argv.slice(2);
const mock = createMockServer({ reply: 'OK', delayMs: 0 });
mock.server.listen(5057, '0.0.0.0');
if (keyPath && certPath) {
  createHttpsServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, mock.handler).listen(
    443,
    '0.0.0.0',
  );
}
console.log('mock host ready');
