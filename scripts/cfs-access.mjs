import { readAuthKeys, createGrant, exchangeGrant } from '../app/lib/apiAuthCore.mjs';

// Local CLI only: stdout is consumed by the launcher/test process, never logged.
const keys = await readAuthKeys();
if (process.argv[2] === 'session') {
  process.stdout.write(exchangeGrant(createGrant(keys), keys));
} else {
  const url = new URL(process.argv[2] || 'http://localhost:3014/');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('PC launch URL must use loopback');
  url.hash = `cfs_access=${createGrant(keys)}`;
  process.stdout.write(url.href);
}
