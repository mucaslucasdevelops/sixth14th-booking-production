import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:net';
import os from 'node:os';
import { runInNewContext } from 'node:vm';
import path from 'node:path';

const root = new URL('../', import.meta.url);
const dir = await mkdtemp(path.join(os.tmpdir(), 'deposit-refresh-'));
const socket = createServer();
socket.listen(0, '127.0.0.1');
await once(socket, 'listening');
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const auth = `Basic ${Buffer.from('qa:qa-pass').toString('base64')}`;
const preload = path.join(dir, 'stripe-mock.mjs');
await writeFile(preload, `
const nativeFetch = globalThis.fetch;
let count = 0;
let lastExpired = '';
const sessions = new Map();
globalThis.fetch = async (url, options = {}) => {
  if (!String(url).startsWith('https://api.stripe.com/')) return nativeFetch(url, options);
  const id = String(url).split('/')[6];
  if (String(url).endsWith('/expire')) {
    if (id === 'cs_race') return Response.json({ error: { message: 'Checkout completed during refresh' } }, { status: 400 });
    lastExpired = id;
    sessions.set(id, 'expired');
    return Response.json({ id, status: 'expired' });
  }
  if (options.method === 'POST') {
    const params = new URLSearchParams(options.body);
    if (params.get('line_items[0][price_data][unit_amount]') !== '40000' || params.get('metadata[gclid]') !== 'retained-click-id') throw new Error('Incorrect deposit amount or attribution');
    if (params.get('metadata[booking_id]') === 'open' && lastExpired !== 'cs_open') throw new Error('Old checkout was not expired');
    if (params.get('metadata[booking_id]') === 'create-failure') return Response.json({ error: { message: 'Stripe unavailable' } }, { status: 503 });
    const newId = 'cs_new_' + ++count;
    sessions.set(newId, 'open');
    return Response.json({ id: newId, url: 'https://checkout.stripe.com/' + newId,
      amount: params.get('line_items[0][price_data][unit_amount]'), lastExpired });
  }
  if (id === 'cs_paid') return Response.json({ id, status: 'complete', payment_status: 'paid' });
  if (id === 'cs_verify_failure') return Response.json({ error: { message: 'Cannot verify Stripe' } }, { status: 503 });
  return Response.json({ id, status: sessions.get(id) || (id === 'cs_expired' ? 'expired' : 'open'), payment_status: 'unpaid' });
};
`);
const child = spawn(process.execPath, ['--import', preload, new URL('server.mjs', root).pathname], {
  cwd: root,
  env: { ...process.env, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1',
    DATABASE_URL: '', STRIPE_SECRET_KEY: 'sk_test_mock', EMAIL_SEND_ENABLED: '',
    OWNER_NOTIFY_ENABLED: '', GOOGLE_CALENDAR_SYNC_ENABLED: '', PUBLIC_BASE_URL: base,
    STAGING_USERNAME: 'qa', STAGING_PASSWORD: 'qa-pass', PUBLIC_BOOKING_ENABLED: 'true',
    PAYMENT_HOLD_MINUTES: '30' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
child.stderr.on('data', chunk => { output += chunk; });
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(output);
    if (await fetch(`${base}/api/health`).then(r => r.ok).catch(() => false)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const storePath = path.join(dir, 'reservations.json');
  const store = JSON.parse(await readFile(storePath, 'utf8'));
  const seed = (id, extra = {}) => ({ id, arrival: '2099-06-10', departure: '2099-06-13',
    status: 'pending_payment', paymentStatus: 'deposit_due', holdExpiresAt: '2000-01-01T00:00:00Z',
    guest: { name: 'Test Guest', email: 'test@example.test', guests: 2 },
    quote: { total: 800, depositDue: 400, balanceDue: 400, currency: 'USD', specialOfferTotal: 800 },
    amountPaid: 0, stripeCheckoutSessionId: 'cs_expired', stripeCheckoutUrl: 'https://checkout.stripe.com/old',
    depositPaymentToken: `${id}-token`, attribution: { gclid: 'retained-click-id' }, ...extra });
  const reset = async (...reservations) => writeFile(storePath, JSON.stringify({ ...store, reservations }));
  const refresh = async (id, authenticated = true) => {
    const response = await fetch(`${base}/api/admin/reservations/${id}/refresh-deposit`, {
      method: 'POST', headers: authenticated ? { authorization: auth } : {}
    });
    return { status: response.status, body: response.status === 401 ? await response.text() : await response.json() };
  };
  const adminSource = await readFile(new URL('public/admin.js', root), 'utf8');
  const actionStart = adminSource.indexOf('function reservationAction(');
  const actionEnd = adminSource.indexOf('\nfunction emailComposeLink(', actionStart);
  const renderAction = runInNewContext(adminSource.slice(actionStart, actionEnd) + '\nreservationAction', {
    canEditGuest: () => false, isExpiredHold: r => Date.parse(r.holdExpiresAt) <= Date.now(),
    escapeHtml: String, paymentPageUrl: () => '/pay/deposit/test', emailComposeLink: () => '',
    remainingBalance: () => 0
  });
  assert.ok(renderAction(seed('ui')).includes('data-action="refresh-deposit-link"'));
  assert.ok(renderAction(seed('ui', { holdExpiresAt: '2099-01-01' })).includes('Refresh deposit link'));
  assert.ok(!renderAction(seed('ui', { status: 'booked' })).includes('refresh-deposit-link'));
  console.log('PASS Admin offers refresh on expired/active unpaid holds and hides it on booked stays');
  await reset(seed('expired'));
  assert.equal((await refresh('expired', false)).status, 401);
  assert.equal((await fetch(`${base}/admin-data/reservations/expired/refresh-deposit`, { method: 'POST' })).status, 401);
  const renewed = await refresh('expired');
  assert.equal(renewed.status, 200);
  assert.equal(renewed.body.reservation.depositPaymentToken, 'expired-token');
  assert.deepEqual(renewed.body.reservation.quote, seed('expired').quote);
  assert.deepEqual(renewed.body.reservation.attribution, seed('expired').attribution);
  assert.ok(Date.parse(renewed.body.reservation.holdExpiresAt) > Date.now());
  assert.equal(renewed.body.email.status, 'ready');
  assert.ok(renewed.body.email.text.includes(`${base}/pay/deposit/expired-token`));
  const guestPage = await fetch(`${base}/pay/deposit/expired-token`).then(r => r.text());
  assert.ok(guestPage.includes(renewed.body.checkoutUrl));
  const saved = JSON.parse(await readFile(storePath, 'utf8'));
  assert.ok(saved.auditEvents.some(event => event.action === 'payment.deposit_link_refreshed'));
  console.log('PASS expired hold renews with original pricing, attribution, stable link, email draft and audit');

  await reset(seed('open', { stripeCheckoutSessionId: 'cs_open' }));
  assert.equal((await refresh('open')).status, 200);
  console.log('PASS open checkout can be replaced');
  for (const extra of [ { status: 'booked', paymentStatus: 'deposit_paid' },
    { status: 'canceled' }, { status: 'declined' }, { amountPaid: 1 },
    { arrival: '2000-06-10', departure: '2000-06-13' },
    { stripeCheckoutSessionId: 'cs_paid' }, { stripeCheckoutSessionId: 'cs_race' },
    { stripeCheckoutSessionId: 'cs_verify_failure' } ]) {
    const original = seed('blocked', extra);
    await reset(original);
    assert.ok((await refresh('blocked')).status >= 400);
    assert.deepEqual(JSON.parse(await readFile(storePath, 'utf8')).reservations[0], original);
  }
  console.log('PASS paid/canceled/declined/ended bookings, payment races and verification failures stay unchanged');
  for (const conflict of [
    { reservations: [seed('other', { status: 'booked' })] },
    { manualBlocks: [{ id: 'manual', start: '2099-06-09', end: '2099-06-14' }] },
    { availabilityBlocks: [{ id: 'synced', start: '2099-06-09', end: '2099-06-14' }] }
  ]) {
    await writeFile(storePath, JSON.stringify({ ...store, ...conflict, reservations: [seed('conflict'), ...(conflict.reservations || [])] }));
    assert.equal((await refresh('conflict')).status, 409);
  }
  console.log('PASS conflicting reservations and manual/synced blocks prevent renewal');
  await reset(seed('create-failure'));
  assert.equal((await refresh('create-failure')).status, 400);
  assert.deepEqual(JSON.parse(await readFile(storePath, 'utf8')).reservations[0], seed('create-failure'));
  await reset(seed('parallel'));
  const parallel = await Promise.all([refresh('parallel'), refresh('parallel')]);
  assert.ok(parallel.every(result => result.status === 200));
  assert.notEqual(parallel[0].body.checkoutUrl, parallel[1].body.checkoutUrl);
  assert.equal(JSON.parse(await readFile(storePath, 'utf8')).reservations[0].depositPaymentToken, 'parallel-token');
  console.log('PASS Stripe creation failure preserves state; parallel refreshes serialize safely');
} finally {
  child.kill('SIGTERM');
  await once(child, 'exit');
  await rm(dir, { recursive: true, force: true });
}
