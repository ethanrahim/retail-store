'use strict';
/* Rahim's Mart web server: serves the pages in /public and a JSON API backed by SQLite.
   Run with:  node server.js     (needs Node 22.5 or newer, no packages to install) */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./db');
const { createStore, HttpError } = require('./store');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // only this computer, unless you set HOST=0.0.0.0
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'shop.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const BACKUP_DIR = path.join(path.dirname(DB_FILE), 'backups');
const SECURE_COOKIE = process.env.COOKIE_SECURE === '1';

const db = openDb(DB_FILE);
const store = createStore(db);
const started = store.ensureStarted();

// ---------- backups ----------
function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function autoBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    store.backupTo(path.join(BACKUP_DIR, 'shop-' + stamp() + '.db'));
    const files = fs.readdirSync(BACKUP_DIR).filter(f => /^shop-.*\.db$/.test(f)).sort();
    files.slice(0, Math.max(0, files.length - 14)).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
  } catch (e) { console.error('Backup failed:', e.message); }
}

// ---------- helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY'
};
function send(res, status, body, headers) {
  const h = Object.assign({}, SECURITY_HEADERS, headers);
  if (typeof body === 'object' && !Buffer.isBuffer(body)) { body = JSON.stringify(body); h['Content-Type'] = 'application/json; charset=utf-8'; h['Cache-Control'] = 'no-store'; }
  res.writeHead(status, h);
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 100000) { reject(new HttpError(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); }
      catch (e) { reject(new HttpError(400, 'Request is not valid JSON')); }
    });
    req.on('error', reject);
  });
}
function cookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
const sessionCookie = (token, maxAge) => 'sid=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + maxAge + (SECURE_COOKIE ? '; Secure' : '');

// failed logins: 5 wrong tries lock that username and address for 5 minutes
const attempts = new Map();
function lockedOut(key) { const a = attempts.get(key); return a && a.until > Date.now(); }
function noteFailure(key) {
  const a = attempts.get(key) || { n: 0, until: 0 };
  if (a.until && a.until <= Date.now()) { a.n = 0; a.until = 0; }
  a.n++; if (a.n >= 5) a.until = Date.now() + 5 * 60 * 1000;
  attempts.set(key, a);
}

// ---------- routes ----------
// [method, pattern, who, handler]   who: 'public' | 'user' | 'admin'
const routes = [
  ['POST', /^\/api\/login$/, 'public', async (c) => {
    const key = c.ip + '|' + String(c.body.username || '').toLowerCase();
    if (lockedOut(key)) throw new HttpError(429, 'Too many wrong attempts. Try again in a few minutes.');
    const user = store.login(c.body.username, c.body.password);
    if (!user) { noteFailure(key); throw new HttpError(401, 'Wrong username or password'); }
    attempts.delete(key);
    const token = store.createSession(user.id, 8);
    return { body: user, headers: { 'Set-Cookie': sessionCookie(token, 8 * 3600) } };
  }],
  ['POST', /^\/api\/logout$/, 'public', async (c) => {
    store.destroySession(c.token);
    return { body: { ok: true }, headers: { 'Set-Cookie': sessionCookie('', 0) } };
  }],
  ['GET', /^\/api\/me$/, 'user', async (c) => c.user],
  ['POST', /^\/api\/password$/, 'user', async (c) => { store.changePassword(c.user, c.body.current, c.body.next); return { ok: true }; }],

  ['GET', /^\/api\/products$/, 'user', async (c) => store.listProducts(c.user.role === 'admin')],
  ['POST', /^\/api\/products$/, 'admin', async (c) => ({ status: 201, body: store.createProduct(c.user, c.body) })],
  ['PUT', /^\/api\/products\/([a-f0-9]+)$/, 'admin', async (c) => store.updateProduct(c.user, c.m[1], c.body)],
  ['DELETE', /^\/api\/products\/([a-f0-9]+)$/, 'admin', async (c) => { store.deleteProduct(c.user, c.m[1]); return { ok: true }; }],
  ['POST', /^\/api\/products\/([a-f0-9]+)\/restock$/, 'admin', async (c) => store.restock(c.user, c.m[1], c.body)],
  ['POST', /^\/api\/products\/([a-f0-9]+)\/writeoff$/, 'admin', async (c) => store.writeOff(c.user, c.m[1], c.body)],
  ['POST', /^\/api\/products\/([a-f0-9]+)\/count$/, 'admin', async (c) => store.countStock(c.user, c.m[1], c.body)],
  ['POST', /^\/api\/products\/([a-f0-9]+)\/lost-sale$/, 'user', async (c) => store.lostSale(c.user, c.m[1])],

  ['GET', /^\/api\/suppliers$/, 'admin', async () => store.listSuppliers()],
  ['POST', /^\/api\/suppliers$/, 'admin', async (c) => ({ status: 201, body: store.saveSupplier(c.user, null, c.body) })],
  ['PUT', /^\/api\/suppliers\/([a-f0-9]+)$/, 'admin', async (c) => store.saveSupplier(c.user, c.m[1], c.body)],
  ['DELETE', /^\/api\/suppliers\/([a-f0-9]+)$/, 'admin', async (c) => { store.deleteSupplier(c.user, c.m[1]); return { ok: true }; }],

  ['POST', /^\/api\/sales$/, 'user', async (c) => ({ status: 201, body: store.createSale(c.user, c.body) })],
  ['GET', /^\/api\/sales$/, 'admin', async (c) => store.listSales(c.query.get('limit'))],
  ['GET', /^\/api\/events$/, 'admin', async (c) => store.listEvents(c.query.get('limit'))],
  ['GET', /^\/api\/movements$/, 'admin', async (c) => store.listMovements(c.query.get('product_id'), c.query.get('limit'))],
  ['GET', /^\/api\/purchases$/, 'admin', async (c) => store.listPurchases(c.query.get('limit'))],
  ['GET', /^\/api\/audit$/, 'admin', async (c) => store.listAudit(c.query.get('limit'))],

  ['GET', /^\/api\/check$/, 'admin', async (c) => { const r = store.runChecks(); store.audit(c.user, 'records_check', r.problems + ' problem(s), ' + r.warnings + ' warning(s)'); return r; }],
  ['POST', /^\/api\/check\/fix-ledger$/, 'admin', async (c) => store.fixLedger(c.user)],

  ['GET', /^\/api\/users$/, 'admin', async () => store.listUsers()],
  ['POST', /^\/api\/users$/, 'admin', async (c) => ({ status: 201, body: store.createUser(c.user, c.body) })],
  ['PUT', /^\/api\/users\/([a-f0-9]+)$/, 'admin', async (c) => store.updateUser(c.user, c.m[1], c.body)],

  ['GET', /^\/api\/backup$/, 'admin', async (c) => {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const file = path.join(BACKUP_DIR, 'download-' + stamp() + '.db');
    store.backupTo(file);
    const data = fs.readFileSync(file);
    store.audit(c.user, 'backup_downloaded', null);
    return { raw: data, headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="rahims-mart-' + stamp() + '.db"' } };
  }],
  ['POST', /^\/api\/reset$/, 'admin', async (c) => {
    if (c.body.confirm !== 'RESET') throw new HttpError(400, 'Type RESET to confirm');
    autoBackup();
    store.resetAll(c.user);
    return { ok: true };
  }]
];

async function handleApi(req, res, url) {
  const method = req.method;
  const mutating = method !== 'GET' && method !== 'HEAD';
  if (mutating && req.headers['x-requested-with'] !== 'shop') throw new HttpError(403, 'Missing request header');
  let route = null, m = null;
  for (const r of routes) { if (r[0] === method && (m = r[1].exec(url.pathname))) { route = r; break; } }
  if (!route) {
    const known = routes.some(r => r[1].test(url.pathname));
    throw new HttpError(known ? 405 : 404, known ? 'Method not allowed' : 'Not found');
  }
  const token = cookies(req).sid;
  const user = store.sessionUser(token);
  if (route[2] !== 'public') {
    if (!user) throw new HttpError(401, 'Please log in');
    if (user.must_change && !['/api/me', '/api/password', '/api/logout'].includes(url.pathname)) throw new HttpError(403, 'Change your password first');
    if (route[2] === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Administrators only');
  }
  const body = mutating ? await readJson(req) : {};
  const out = await route[3]({ user, token, body, m, query: url.searchParams, ip: req.socket.remoteAddress || '' });
  if (out && out.raw) return send(res, 200, out.raw, out.headers);
  if (out && out.body !== undefined) return send(res, out.status || 200, out.body, out.headers);
  return send(res, 200, out === undefined ? { ok: true } : out);
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain' });
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    console.error(err);
    send(res, 500, { error: 'Something went wrong on the server' });
  }
});

server.listen(PORT, HOST, () => {
  console.log("Rahim's Mart is running at http://" + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT);
  console.log('Database: ' + DB_FILE);
  if (started.adminPassword) {
    console.log('\nFIRST RUN: administrator account created');
    console.log('  username: admin');
    console.log('  password: ' + started.adminPassword + '   (you will be asked to change it at first login)\n');
  }
  autoBackup();
  setInterval(autoBackup, 24 * 3600 * 1000).unref();
});

function shutdown() { server.close(() => { try { db.close(); } catch (e) { /* ignore */ } process.exit(0); }); setTimeout(() => process.exit(0), 2000).unref(); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
