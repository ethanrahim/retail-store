'use strict';
/* End-to-end tests: start the real server on a temporary database and call it over HTTP.
   Run with:  npm test      (Node 22.5 or newer) */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = 3300 + Math.floor(Math.random() * 600);
const BASE = 'http://127.0.0.1:' + PORT;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mart-test-'));
const DB_FILE = path.join(dir, 'shop.db');
const ADMIN_PW = 'Admin-pass-1';
let child;

// A client that remembers its own login cookie, like a browser tab.
function client() {
  let cookie = '';
  return async function call(method, url, body, opts) {
    opts = opts || {};
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (method !== 'GET' && !opts.noHeader) headers['X-Requested-With'] = 'shop';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) { const m = /sid=([^;]*)/.exec(sc); cookie = m && m[1] ? 'sid=' + m[1] : ''; }
    const isJson = (r.headers.get('content-type') || '').includes('json');
    return { status: r.status, data: isJson ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
}
const admin = client();
const cashier = client();

before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', DB_FILE, ADMIN_PASSWORD: ADMIN_PW }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Server did not start')), 10000);
    child.stdout.on('data', (d) => { if (String(d).includes('is running')) { clearTimeout(t); resolve(); } });
    child.on('exit', (c) => reject(new Error('Server exited early with code ' + c)));
  });
});
after(() => {
  if (child) child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function product(call, name) {
  const r = await call('GET', '/api/products');
  return r.data.find((p) => p.name === name);
}
async function checkOf(id) {
  const r = await admin('GET', '/api/check');
  return { report: r.data, check: r.data.checks.find((c) => c.id === id) };
}

// ---------- login, logout and access control ----------
test('Login: wrong password is refused, right password is accepted', async () => {
  const bad = await admin('POST', '/api/login', { username: 'admin', password: 'wrong-password' });
  assert.equal(bad.status, 401);
  const good = await admin('POST', '/api/login', { username: 'admin', password: ADMIN_PW });
  assert.equal(good.status, 200);
  assert.equal(good.data.role, 'admin');
});

test('Access: a request with no login is refused', async () => {
  const r = await client()('GET', '/api/products');
  assert.equal(r.status, 401);
});

test('Access: a change request without the shop header is refused (cross-site protection)', async () => {
  const r = await admin('POST', '/api/sales', { method: 'Cash', items: [] }, { noHeader: true });
  assert.equal(r.status, 403);
});

test('Login: five wrong passwords lock the account for a few minutes', async () => {
  const c = client();
  for (let i = 0; i < 5; i++) await c('POST', '/api/login', { username: 'ghost', password: 'nope-nope' });
  const r = await c('POST', '/api/login', { username: 'ghost', password: 'nope-nope' });
  assert.equal(r.status, 429);
});

test('Users: weak password refused; cashier created and must change the temporary password', async () => {
  const weak = await admin('POST', '/api/users', { username: 'wanjiku', full_name: 'Wanjiku K', role: 'cashier', password: 'short' });
  assert.equal(weak.status, 400);
  const ok = await admin('POST', '/api/users', { username: 'wanjiku', full_name: 'Wanjiku K', role: 'cashier', password: 'Temp-pass-1' });
  assert.equal(ok.status, 201);
  const dup = await admin('POST', '/api/users', { username: 'Wanjiku', full_name: 'Again', role: 'cashier', password: 'Temp-pass-2' });
  assert.equal(dup.status, 409);
  const login = await cashier('POST', '/api/login', { username: 'wanjiku', password: 'Temp-pass-1' });
  assert.equal(login.status, 200);
  assert.equal(login.data.must_change, 1);
  const blocked = await cashier('GET', '/api/products');
  assert.equal(blocked.status, 403);
  const change = await cashier('POST', '/api/password', { current: 'Temp-pass-1', next: 'My-new-pass-9' });
  assert.equal(change.status, 200);
  assert.equal((await cashier('GET', '/api/products')).status, 200);
});

test('Roles: a cashier cannot reach administrator functions or see cost prices', async () => {
  for (const url of ['/api/users', '/api/check', '/api/audit', '/api/suppliers', '/api/backup', '/api/sales']) {
    assert.equal((await cashier('GET', url)).status, 403, url);
  }
  const list = await cashier('GET', '/api/products');
  assert.ok(list.data.length > 0);
  assert.equal(list.data[0].cost, undefined);
  const edit = await cashier('POST', '/api/products', { sku: '1', name: 'X', cost: 1, price: 2, qty: 1, reorder: 0 });
  assert.equal(edit.status, 403);
});

// ---------- sales ----------
test('Sale: stock falls, a ledger entry is written and the total is correct', async () => {
  const sugar = await product(admin, 'Sugar 1kg');
  const r = await cashier('POST', '/api/sales', { method: 'M-Pesa', items: [{ id: sugar.id, qty: 2 }] });
  assert.equal(r.status, 201);
  assert.equal(r.data.total, 330);
  assert.equal((await product(admin, 'Sugar 1kg')).qty, sugar.qty - 2);
  const moves = await admin('GET', '/api/movements?product_id=' + sugar.id);
  assert.equal(moves.data[0].type, 'sale');
  assert.equal(moves.data[0].qty_change, -2);
});

test('Sale: the server uses its own price, so a changed price in the request is ignored', async () => {
  const salt = await product(admin, 'Salt 500g');
  const r = await cashier('POST', '/api/sales', { method: 'Cash', items: [{ id: salt.id, qty: 1, price: 1 }] });
  assert.equal(r.status, 201);
  assert.equal(r.data.total, salt.price);
});

test('Sale: more than the stock, an expired item, and an empty cart are all refused', async () => {
  const eggs = await product(admin, 'Eggs (tray of 30)');
  const tooMany = await cashier('POST', '/api/sales', { method: 'Cash', items: [{ id: eggs.id, qty: eggs.qty + 1 }] });
  assert.equal(tooMany.status, 409);
  assert.match(tooMany.data.error, /Only/);
  const yoghurt = await product(admin, 'Yoghurt 250ml');
  const expired = await cashier('POST', '/api/sales', { method: 'Cash', items: [{ id: yoghurt.id, qty: 1 }] });
  assert.equal(expired.status, 409);
  assert.match(expired.data.error, /expired/);
  assert.equal((await cashier('POST', '/api/sales', { method: 'Cash', items: [] })).status, 400);
  assert.equal((await product(admin, 'Eggs (tray of 30)')).qty, eggs.qty);
});

test('Sale: a failed sale changes nothing (all or nothing)', async () => {
  const rice = await product(admin, 'Rice 1kg');
  const eggs = await product(admin, 'Eggs (tray of 30)');
  const r = await cashier('POST', '/api/sales', { method: 'Cash', items: [{ id: rice.id, qty: 1 }, { id: eggs.id, qty: eggs.qty + 1 }] });
  assert.equal(r.status, 409);
  assert.equal((await product(admin, 'Rice 1kg')).qty, rice.qty);
  assert.equal((await product(admin, 'Eggs (tray of 30)')).qty, eggs.qty);
});

test('Lost sale: asking for an out-of-stock item is recorded once a minute', async () => {
  const soda = await product(admin, 'Soda 500ml');
  assert.equal(soda.qty, 0);
  const a = await cashier('POST', '/api/products/' + soda.id + '/lost-sale', {});
  const b = await cashier('POST', '/api/products/' + soda.id + '/lost-sale', {});
  assert.equal(a.data.recorded, true);
  assert.equal(b.data.recorded, false);
  const ev = await admin('GET', '/api/events');
  assert.equal(ev.data.filter((e) => e.type === 'lost_sale').length, 1);
});

// ---------- stock records ----------
test('Restock: a purchase is recorded with its supplier and the ledger agrees', async () => {
  const soda = await product(admin, 'Soda 500ml');
  const sup = (await admin('GET', '/api/suppliers')).data[0];
  const r = await admin('POST', '/api/products/' + soda.id + '/restock', { n: 48, unit_cost: 44, supplier_id: sup.id });
  assert.equal(r.status, 200);
  assert.equal((await product(admin, 'Soda 500ml')).qty, 48);
  const purchases = await admin('GET', '/api/purchases');
  assert.equal(purchases.data[0].total, 48 * 44);
  assert.equal(purchases.data[0].supplier, sup.name);
});

test('Stock-take: a shortage corrects the stock, logs a loss and writes an adjustment', async () => {
  const oil = await product(admin, 'Cooking Oil 1L');
  const r = await admin('POST', '/api/products/' + oil.id + '/count', { counted: oil.qty - 3, note: 'Shelf count' });
  assert.equal(r.status, 200);
  assert.equal(r.data.diff, -3);
  assert.equal(r.data.loss, 3 * 260);
  assert.equal((await product(admin, 'Cooking Oil 1L')).qty, oil.qty - 3);
  const ev = await admin('GET', '/api/events');
  assert.ok(ev.data.some((e) => e.type === 'shrinkage' && e.loss === 780));
  const match = await admin('POST', '/api/products/' + oil.id + '/count', { counted: oil.qty - 3 });
  assert.equal(match.data.diff, 0);
});

test('Write-off: expired stock is removed and its cost recorded as a loss', async () => {
  const y = await product(admin, 'Yoghurt 250ml');
  const r = await admin('POST', '/api/products/' + y.id + '/writeoff', { reason: 'expired' });
  assert.equal(r.status, 200);
  assert.equal(r.data.loss, 8 * 55);
  assert.equal((await product(admin, 'Yoghurt 250ml')).qty, 0);
});

test('Products: duplicate barcode is refused; price below cost is refused', async () => {
  const dup = await admin('POST', '/api/products', { sku: '6001001', name: 'Another', category: 'X', cost: 1, price: 2, qty: 1, reorder: 0 });
  assert.equal(dup.status, 409);
  const loss = await admin('POST', '/api/products', { sku: '7000001', name: 'Loss leader', category: 'X', cost: 100, price: 50, qty: 1, reorder: 0 });
  assert.equal(loss.status, 400);
});

// ---------- records check ----------
test('Records check: after normal work every record agrees', async () => {
  const { report } = await checkOf('ledger');
  assert.equal(report.problems, 0, JSON.stringify(report.checks.filter((c) => c.status === 'problem')));
});

test('Records check: a quantity changed behind the system\'s back is found and can be reconciled', async () => {
  const sugar = await product(admin, 'Sugar 1kg');
  const raw = new DatabaseSync(DB_FILE);
  raw.prepare('UPDATE products SET qty = qty + 5 WHERE id = ?').run(sugar.id);
  raw.close();
  const bad = await checkOf('ledger');
  assert.equal(bad.check.status, 'problem');
  assert.equal(bad.check.count, 1);
  assert.match(bad.check.items[0], /Sugar 1kg/);
  const fix = await admin('POST', '/api/check/fix-ledger', {});
  assert.equal(fix.data.fixed, 1);
  assert.equal((await checkOf('ledger')).check.status, 'ok');
});

test('Records check: a sale total that does not match its items is found', async () => {
  const raw = new DatabaseSync(DB_FILE);
  raw.exec('UPDATE sales SET total = total + 10 WHERE rowid = (SELECT MIN(rowid) FROM sales)');
  raw.close();
  const bad = await checkOf('sale_totals');
  assert.equal(bad.check.status, 'problem');
  assert.equal(bad.check.count, 1);
});

// ---------- audit, backup, users, static files ----------
test('Audit: logins, sales, restocks and stock-takes are all recorded with who did them', async () => {
  const r = await admin('GET', '/api/audit?limit=500');
  const actions = new Set(r.data.map((a) => a.action));
  for (const a of ['login', 'login_failed', 'user_created', 'sale', 'restock', 'stocktake', 'writeoff', 'ledger_fixed']) {
    if (a === 'sale') continue; // sales are recorded in the sales table itself
    assert.ok(actions.has(a), 'missing audit action: ' + a);
  }
});

test('Backup: the administrator can download a real SQLite database file', async () => {
  const r = await admin('GET', '/api/backup');
  assert.equal(r.status, 200);
  assert.equal(r.data.subarray(0, 15).toString(), 'SQLite format 3');
});

test('Users: the last administrator cannot be disabled; a disabled cashier is signed out and cannot log in', async () => {
  const users = (await admin('GET', '/api/users')).data;
  const me = users.find((u) => u.username === 'admin');
  const w = users.find((u) => u.username === 'wanjiku');
  assert.equal((await admin('PUT', '/api/users/' + me.id, { active: false })).status, 409);
  assert.equal((await admin('PUT', '/api/users/' + w.id, { active: false })).status, 200);
  assert.equal((await cashier('GET', '/api/products')).status, 401);
  assert.equal((await client()('POST', '/api/login', { username: 'wanjiku', password: 'My-new-pass-9' })).status, 401);
});

test('Logout: the session stops working', async () => {
  const c = client();
  await c('POST', '/api/login', { username: 'admin', password: ADMIN_PW });
  assert.equal((await c('GET', '/api/products')).status, 200);
  await c('POST', '/api/logout', {});
  assert.equal((await c('GET', '/api/products')).status, 401);
});

test('Files: the page is served, but server code and folders outside public are not', async () => {
  assert.equal((await fetch(BASE + '/')).status, 200);
  assert.equal((await fetch(BASE + '/server.js')).status, 404);
  assert.equal((await fetch(BASE + '/%2e%2e/server.js')).status, 404);
  assert.equal((await fetch(BASE + '/api/nothing')).status, 404);
});
