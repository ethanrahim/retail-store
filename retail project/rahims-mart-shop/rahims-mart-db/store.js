'use strict';
/* Business rules: products, stock movements, sales, suppliers, users, audit trail and the records check.
   Every change to stock goes through here so the stock ledger (movements table) never drifts. */
const crypto = require('node:crypto');
const { tx, uid, nowIso, todayStr, addDays, hashPassword, verifyPassword } = require('./db');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function fail(status, message) { throw new HttpError(status, message); }

// ---------- input checking ----------
function num(v, name, o) {
  o = Object.assign({ min: 0, max: 1e7, int: false }, o);
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  if (!Number.isFinite(n)) fail(400, name + ' must be a number');
  if (o.int && !Number.isInteger(n)) fail(400, name + ' must be a whole number');
  if (n < o.min || n > o.max) fail(400, name + ' must be between ' + o.min + ' and ' + o.max);
  return n;
}
function str(v, name, o) {
  o = Object.assign({ max: 60, required: true }, o);
  if (v == null) v = '';
  if (typeof v !== 'string') fail(400, name + ' must be text');
  v = v.trim();
  if (o.required && !v) fail(400, name + ' is required');
  if (v.length > o.max) fail(400, name + ' is too long');
  return v;
}
function dateOrNull(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) fail(400, 'Expiry must be a date (YYYY-MM-DD)');
  const d = new Date(v + 'T00:00:00Z');
  if (isNaN(d) || d.toISOString().slice(0, 10) !== v) fail(400, 'Expiry is not a valid date');
  return v;
}
const round2 = n => Math.round(n * 100) / 100;
function uniqueOr409(fn, message) {
  try { return fn(); } catch (e) {
    if (e && /UNIQUE/i.test(String(e.message))) fail(409, message);
    throw e;
  }
}

function createStore(db) {
  const get = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  const lostSaleSeen = new Map();

  // ---------- audit trail ----------
  function audit(user, action, detail) {
    run('INSERT INTO audit(time,user_id,username,action,detail) VALUES(?,?,?,?,?)',
      nowIso(), user ? user.id : null, user ? user.username : null, action, detail || null);
  }
  function addMovement(productId, type, change, ref, note, userId) {
    run('INSERT INTO movements(time,product_id,type,qty_change,ref,note,user_id) VALUES(?,?,?,?,?,?,?)',
      nowIso(), productId, type, change, ref || null, note || null, userId || null);
  }
  function addEvent(type, text, loss, userId) {
    run('INSERT INTO events(time,type,text,loss,user_id) VALUES(?,?,?,?,?)', nowIso(), type, text, loss || 0, userId || null);
  }

  // ---------- users and sessions ----------
  const PUBLIC_USER = 'id, username, full_name, role, must_change, active, created_at';
  function createUser(actor, b, opts) {
    opts = opts || {};
    const username = str(b.username, 'Username', { max: 30 });
    if (!/^[A-Za-z0-9._-]{3,30}$/.test(username)) fail(400, 'Username may use letters, numbers, dot, dash and underscore (3 to 30 characters)');
    const full_name = str(b.full_name, 'Full name');
    const role = b.role;
    if (role !== 'admin' && role !== 'cashier') fail(400, 'Role must be admin or cashier');
    const password = typeof b.password === 'string' ? b.password : '';
    if (password.length < 8 || password.length > 100) fail(400, 'Password must be 8 to 100 characters');
    const id = uid();
    const h = hashPassword(password);
    uniqueOr409(() => run('INSERT INTO users(id,username,full_name,role,salt,hash,must_change,active,created_at) VALUES(?,?,?,?,?,?,?,1,?)',
      id, username, full_name, role, h.salt, h.hash, opts.mustChange === false ? 0 : 1, nowIso()), 'That username is already taken');
    audit(actor, 'user_created', username + ' (' + role + ')');
    return get('SELECT ' + PUBLIC_USER + ' FROM users WHERE id=?', id);
  }
  function listUsers() { return all('SELECT ' + PUBLIC_USER + ' FROM users ORDER BY username'); }
  function activeAdmins(exceptId) {
    return get("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1 AND id != ?", exceptId || '').n;
  }
  function updateUser(actor, id, b) {
    const u = get('SELECT * FROM users WHERE id=?', id);
    if (!u) fail(404, 'User not found');
    const full_name = b.full_name !== undefined ? str(b.full_name, 'Full name') : u.full_name;
    const role = b.role !== undefined ? b.role : u.role;
    if (role !== 'admin' && role !== 'cashier') fail(400, 'Role must be admin or cashier');
    const active = b.active !== undefined ? (b.active ? 1 : 0) : u.active;
    if (u.role === 'admin' && u.active && (role !== 'admin' || !active) && activeAdmins(id) < 1) fail(409, 'There must be at least one active administrator');
    tx(db, () => {
      run('UPDATE users SET full_name=?, role=?, active=? WHERE id=?', full_name, role, active, id);
      if (b.password !== undefined && b.password !== '') {
        if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 100) fail(400, 'Password must be 8 to 100 characters');
        const h = hashPassword(b.password);
        run('UPDATE users SET salt=?, hash=?, must_change=1 WHERE id=?', h.salt, h.hash, id);
        run('DELETE FROM sessions WHERE user_id=?', id);
      }
      if (!active) run('DELETE FROM sessions WHERE user_id=?', id);
      audit(actor, 'user_updated', u.username + ': role ' + role + ', ' + (active ? 'active' : 'disabled') + (b.password ? ', password reset' : ''));
    });
    return get('SELECT ' + PUBLIC_USER + ' FROM users WHERE id=?', id);
  }
  function login(username, password) {
    const u = typeof username === 'string' ? get('SELECT * FROM users WHERE username=?', username.trim()) : null;
    if (!u || !u.active || typeof password !== 'string' || !verifyPassword(password, u.salt, u.hash)) {
      audit(null, 'login_failed', String(username).slice(0, 60));
      return null;
    }
    audit(u, 'login', null);
    return get('SELECT ' + PUBLIC_USER + ' FROM users WHERE id=?', u.id);
  }
  const sha = t => crypto.createHash('sha256').update(t).digest('hex');
  function createSession(userId, hours) {
    const token = crypto.randomBytes(32).toString('hex');
    run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
    run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', sha(token), userId, Date.now() + (hours || 8) * 3600 * 1000);
    return token;
  }
  function sessionUser(token) {
    if (!token) return null;
    return get('SELECT u.id, u.username, u.full_name, u.role, u.must_change FROM sessions s JOIN users u ON u.id=s.user_id ' +
      'WHERE s.token_hash=? AND s.expires_at > ? AND u.active=1', sha(token), Date.now()) || null;
  }
  function destroySession(token) { if (token) run('DELETE FROM sessions WHERE token_hash=?', sha(token)); }
  function changePassword(user, current, next) {
    const u = get('SELECT * FROM users WHERE id=?', user.id);
    if (typeof current !== 'string' || !verifyPassword(current, u.salt, u.hash)) fail(403, 'Current password is wrong');
    if (typeof next !== 'string' || next.length < 8 || next.length > 100) fail(400, 'New password must be 8 to 100 characters');
    if (next === current) fail(400, 'New password must be different');
    const h = hashPassword(next);
    run('UPDATE users SET salt=?, hash=?, must_change=0 WHERE id=?', h.salt, h.hash, user.id);
    audit(user, 'password_changed', null);
  }

  // ---------- suppliers ----------
  function listSuppliers() { return all('SELECT id,name,phone,notes,created_at FROM suppliers WHERE active=1 ORDER BY name'); }
  function saveSupplier(actor, id, b) {
    const name = str(b.name, 'Supplier name'), phone = str(b.phone, 'Phone', { max: 30, required: false }), notes = str(b.notes, 'Notes', { max: 200, required: false });
    if (id) {
      if (!get('SELECT id FROM suppliers WHERE id=? AND active=1', id)) fail(404, 'Supplier not found');
      run('UPDATE suppliers SET name=?, phone=?, notes=? WHERE id=?', name, phone, notes, id);
      audit(actor, 'supplier_updated', name);
      return get('SELECT id,name,phone,notes FROM suppliers WHERE id=?', id);
    }
    id = uid();
    run('INSERT INTO suppliers(id,name,phone,notes,active,created_at) VALUES(?,?,?,?,1,?)', id, name, phone, notes, nowIso());
    audit(actor, 'supplier_added', name);
    return get('SELECT id,name,phone,notes FROM suppliers WHERE id=?', id);
  }
  function deleteSupplier(actor, id) {
    const s = get('SELECT name FROM suppliers WHERE id=? AND active=1', id);
    if (!s) fail(404, 'Supplier not found');
    run('UPDATE suppliers SET active=0 WHERE id=?', id);
    run('UPDATE products SET supplier_id=NULL WHERE supplier_id=?', id);
    audit(actor, 'supplier_deleted', s.name);
  }
  function checkSupplier(id) {
    if (!id) return null;
    if (!get('SELECT id FROM suppliers WHERE id=? AND active=1', id)) fail(400, 'Unknown supplier');
    return id;
  }

  // ---------- products ----------
  function listProducts(isAdmin) {
    const cols = 'id, sku, name, category, price, qty, reorder, expiry, supplier_id' + (isAdmin ? ', cost' : '');
    return all('SELECT ' + cols + ' FROM products WHERE active=1 ORDER BY name');
  }
  function validProduct(b) {
    const p = {
      name: str(b.name, 'Name'), sku: str(b.sku, 'Barcode', { max: 30 }),
      category: str(b.category, 'Category', { max: 30, required: false }) || 'General',
      cost: num(b.cost, 'Cost price'), price: num(b.price, 'Selling price'),
      qty: num(b.qty, 'Quantity', { int: true, max: 1e6 }), reorder: num(b.reorder, 'Reorder level', { int: true, max: 1e6 }),
      expiry: dateOrNull(b.expiry), supplier_id: checkSupplier(b.supplier_id)
    };
    if (p.price < p.cost) fail(400, 'Selling price is below cost price');
    return p;
  }
  function productById(id) { return get('SELECT * FROM products WHERE id=? AND active=1', id); }
  function createProduct(actor, b) {
    const p = validProduct(b), id = uid();
    tx(db, () => {
      uniqueOr409(() => run('INSERT INTO products(id,sku,name,category,cost,price,qty,reorder,expiry,supplier_id,active,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,1,?)',
        id, p.sku, p.name, p.category, p.cost, p.price, p.qty, p.reorder, p.expiry, p.supplier_id, nowIso()), 'That barcode is already used');
      if (p.qty > 0) addMovement(id, 'opening', p.qty, null, 'Product added', actor && actor.id);
      audit(actor, 'product_added', p.name + ' (' + p.sku + '), ' + p.qty + ' units');
    });
    return productById(id);
  }
  function updateProduct(actor, id, b) {
    const old = productById(id);
    if (!old) fail(404, 'Product not found');
    const p = validProduct(b);
    tx(db, () => {
      uniqueOr409(() => run('UPDATE products SET sku=?, name=?, category=?, cost=?, price=?, qty=?, reorder=?, expiry=?, supplier_id=? WHERE id=?',
        p.sku, p.name, p.category, p.cost, p.price, p.qty, p.reorder, p.expiry, p.supplier_id, id), 'That barcode is already used');
      const delta = p.qty - old.qty;
      if (delta !== 0) addMovement(id, 'adjust', delta, null, 'Manual stock correction', actor.id);
      audit(actor, 'product_updated', p.name + (delta ? ', stock ' + old.qty + ' to ' + p.qty : ''));
    });
    return productById(id);
  }
  function deleteProduct(actor, id) {
    const old = productById(id);
    if (!old) fail(404, 'Product not found');
    run('UPDATE products SET active=0, sku=? WHERE id=?', old.sku + '#deleted-' + id, id);
    audit(actor, 'product_deleted', old.name + ' (' + old.sku + ')');
  }
  function restock(actor, id, b) {
    const p = productById(id);
    if (!p) fail(404, 'Product not found');
    const n = num(b.n, 'Units received', { min: 1, max: 100000, int: true });
    const unitCost = b.unit_cost === undefined || b.unit_cost === '' || b.unit_cost === null ? p.cost : num(b.unit_cost, 'Unit cost');
    const expiry = dateOrNull(b.expiry), supplier = checkSupplier(b.supplier_id);
    if (p.price < unitCost) fail(400, 'Unit cost is above the selling price. Update the price first.');
    const pid = uid();
    tx(db, () => {
      run('INSERT INTO purchases(id,time,product_id,product_name,supplier_id,qty,unit_cost,total,user_id) VALUES(?,?,?,?,?,?,?,?,?)',
        pid, nowIso(), id, p.name, supplier || p.supplier_id, n, unitCost, round2(n * unitCost), actor.id);
      run('UPDATE products SET qty = qty + ?, cost = ?, expiry = COALESCE(?, expiry), supplier_id = COALESCE(?, supplier_id) WHERE id=?', n, unitCost, expiry, supplier, id);
      addMovement(id, 'restock', n, pid, 'Goods received', actor.id);
      audit(actor, 'restock', n + ' x ' + p.name + ' at ' + unitCost);
    });
    return productById(id);
  }
  function writeOff(actor, id, b) {
    const p = productById(id);
    if (!p) fail(404, 'Product not found');
    if (p.qty <= 0) fail(409, 'Nothing to write off');
    const reason = b && b.reason === 'damaged' ? 'damaged' : 'expired';
    const loss = round2(p.qty * p.cost);
    tx(db, () => {
      run('UPDATE products SET qty=0 WHERE id=?', id);
      addMovement(id, 'writeoff', -p.qty, null, reason, actor.id);
      addEvent('writeoff', 'Wrote off ' + p.qty + ' x ' + p.name + ' (' + reason + ').', loss, actor.id);
      audit(actor, 'writeoff', p.qty + ' x ' + p.name + ' (' + reason + '), loss ' + loss);
    });
    return { loss, product: productById(id) };
  }
  // Physical stock-take: the counted quantity is compared with the system quantity.
  // A difference is recorded as an adjustment in the stock ledger; a shortage is also logged as a loss.
  function countStock(actor, id, b) {
    const p = productById(id);
    if (!p) fail(404, 'Product not found');
    const counted = num(b.counted, 'Counted quantity', { min: 0, max: 100000, int: true });
    const note = typeof b.note === 'string' ? b.note.trim().slice(0, 200) : '';
    const diff = counted - p.qty;
    let loss = 0;
    tx(db, () => {
      if (diff !== 0) {
        run('UPDATE products SET qty=? WHERE id=?', counted, id);
        addMovement(id, 'adjust', diff, 'stocktake', note || 'Physical stock-take', actor.id);
        if (diff < 0) {
          loss = round2(-diff * p.cost);
          addEvent('shrinkage', 'Stock-take found ' + (-diff) + ' fewer ' + p.name + ' than the system showed.', loss, actor.id);
        }
      }
      audit(actor, 'stocktake', p.name + ': system ' + p.qty + ', counted ' + counted + (diff ? ', difference ' + diff : ', matches'));
    });
    return { diff, loss, system: p.qty, counted, product: productById(id) };
  }

  // ---------- sales ----------
  function createSale(user, b) {
    const method = b.method;
    if (method !== 'Cash' && method !== 'M-Pesa' && method !== 'Card') fail(400, 'Choose Cash, M-Pesa or Card');
    if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 100) fail(400, 'The cart must hold 1 to 100 lines');
    const wanted = new Map();
    for (const it of b.items) {
      if (!it || typeof it.id !== 'string') fail(400, 'Bad cart line');
      const q = num(it.qty, 'Quantity', { min: 1, max: 1000, int: true });
      wanted.set(it.id, (wanted.get(it.id) || 0) + q);
    }
    const today = todayStr();
    return tx(db, () => {
      const saleId = uid(), lines = [];
      for (const [pid, q] of wanted) {
        const p = productById(pid);
        if (!p) fail(409, 'A product in the cart no longer exists');
        if (p.expiry && p.expiry < today) fail(409, p.name + ' is expired and cannot be sold');
        const res = run('UPDATE products SET qty = qty - ? WHERE id=? AND qty >= ?', q, pid, q);
        if (res.changes !== 1) fail(409, 'Only ' + p.qty + ' of ' + p.name + ' in stock');
        lines.push({ pid, name: p.name, qty: q, price: p.price, cost: p.cost, left: p.qty - q });
      }
      const total = round2(lines.reduce((t, l) => t + l.price * l.qty, 0));
      run('INSERT INTO sales(id,time,total,method,user_id) VALUES(?,?,?,?,?)', saleId, nowIso(), total, method, user.id);
      for (const l of lines) {
        run('INSERT INTO sale_items(sale_id,product_id,name,qty,price,cost) VALUES(?,?,?,?,?,?)', saleId, l.pid, l.name, l.qty, l.price, l.cost);
        addMovement(l.pid, 'sale', -l.qty, saleId, null, user.id);
        if (l.left === 0) addEvent('sold_out', l.name + ' sold out.', 0, user.id);
      }
      return getSale(saleId);
    });
  }
  function getSale(id) {
    const s = get('SELECT s.*, u.full_name AS cashier FROM sales s LEFT JOIN users u ON u.id=s.user_id WHERE s.id=?', id);
    s.items = all('SELECT product_id, name, qty, price, cost FROM sale_items WHERE sale_id=? ORDER BY id', id);
    return s;
  }
  function listSales(limit) {
    limit = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 5000);
    const sales = all('SELECT s.id, s.time, s.total, s.method, s.user_id, u.full_name AS cashier FROM sales s LEFT JOIN users u ON u.id=s.user_id ORDER BY s.time DESC LIMIT ?', limit);
    if (!sales.length) return sales;
    const byId = new Map(sales.map(s => [s.id, (s.items = [], s)]));
    const ids = sales.map(s => s.id);
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      for (const it of all('SELECT sale_id, product_id, name, qty, price, cost FROM sale_items WHERE sale_id IN (' + part.map(() => '?').join(',') + ') ORDER BY id', ...part)) {
        byId.get(it.sale_id).items.push(it);
      }
    }
    return sales;
  }
  function lostSale(user, productId) {
    const p = productById(productId);
    if (!p) fail(404, 'Product not found');
    if (p.qty > 0) fail(409, 'That product is in stock');
    const last = lostSaleSeen.get(productId) || 0;
    if (Date.now() - last < 60000) return { recorded: false };
    lostSaleSeen.set(productId, Date.now());
    addEvent('lost_sale', 'Customer asked for ' + p.name + ' but it was out of stock.', p.price, user.id);
    return { recorded: true };
  }

  // ---------- record lists ----------
  const lim = (v, d) => Math.min(Math.max(parseInt(v, 10) || d, 1), 2000);
  function listEvents(limit) { return all('SELECT id, time, type, text, loss FROM events ORDER BY id DESC LIMIT ?', lim(limit, 300)); }
  function listMovements(productId, limit) {
    const base = 'SELECT m.id, m.time, m.product_id, p.name AS product_name, m.type, m.qty_change, m.ref, m.note, u.username FROM movements m JOIN products p ON p.id=m.product_id LEFT JOIN users u ON u.id=m.user_id';
    return productId ? all(base + ' WHERE m.product_id=? ORDER BY m.id DESC LIMIT ?', productId, lim(limit, 300)) : all(base + ' ORDER BY m.id DESC LIMIT ?', lim(limit, 300));
  }
  function listPurchases(limit) {
    return all('SELECT pu.id, pu.time, pu.product_name, pu.qty, pu.unit_cost, pu.total, s.name AS supplier, u.username FROM purchases pu LEFT JOIN suppliers s ON s.id=pu.supplier_id LEFT JOIN users u ON u.id=pu.user_id ORDER BY pu.time DESC LIMIT ?', lim(limit, 300));
  }
  function listAudit(limit) { return all('SELECT id, time, username, action, detail FROM audit ORDER BY id DESC LIMIT ?', lim(limit, 300)); }

  // ---------- records check ----------
  function runChecks() {
    const today = todayStr();
    const checks = [];
    function add(id, title, description, severity, rows, fmt, fix) {
      checks.push({
        id, title, description, severity, status: rows.length ? (severity === 'error' ? 'problem' : 'warning') : 'ok',
        count: rows.length, items: rows.slice(0, 10).map(fmt), fix: rows.length && fix ? fix : undefined
      });
    }
    add('ledger', 'Stock quantity matches the stock ledger',
      'For each product, the quantity on hand must equal the total of all recorded stock movements.', 'error',
      all('SELECT p.name, p.qty, COALESCE(SUM(m.qty_change),0) AS ledger FROM products p LEFT JOIN movements m ON m.product_id=p.id WHERE p.active=1 GROUP BY p.id HAVING p.qty != ledger'),
      r => r.name + ': shows ' + r.qty + ' but movements add up to ' + r.ledger, 'ledger');
    add('sale_totals', 'Every sale total equals the sum of its lines',
      'A receipt total must equal quantity times price for all of its items.', 'error',
      all('SELECT s.id, s.total, COALESCE(SUM(i.qty*i.price),0) AS calc FROM sales s LEFT JOIN sale_items i ON i.sale_id=s.id GROUP BY s.id HAVING ABS(s.total - calc) > 0.005 OR COUNT(i.id)=0'),
      r => 'Receipt ' + r.id.slice(-6).toUpperCase() + ': total ' + r.total + ' but lines add up to ' + r.calc);
    add('sale_stock', 'Every sold item reduced stock',
      'Each sale line must have a matching stock movement for the same quantity.', 'error',
      all("SELECT i.sale_id, i.name, i.qty FROM sale_items i WHERE NOT EXISTS (SELECT 1 FROM movements m WHERE m.type='sale' AND m.ref=i.sale_id AND m.product_id=i.product_id AND m.qty_change = -i.qty)"),
      r => 'Receipt ' + r.sale_id.slice(-6).toUpperCase() + ': ' + r.qty + ' x ' + r.name + ' has no matching stock movement');
    add('purchases', 'Purchase records are complete and add up',
      'Each purchase total must equal quantity times unit cost and must have a matching restock movement.', 'error',
      all("SELECT pu.id, pu.product_name, pu.total, pu.qty, pu.unit_cost FROM purchases pu WHERE ABS(pu.total - pu.qty*pu.unit_cost) > 0.005 OR NOT EXISTS (SELECT 1 FROM movements m WHERE m.type='restock' AND m.ref=pu.id AND m.qty_change=pu.qty)"),
      r => r.product_name + ' (purchase ' + r.id.slice(-6).toUpperCase() + ') does not add up or has no stock movement');
    const integrity = all('PRAGMA integrity_check').map(r => r.integrity_check).filter(v => v !== 'ok');
    const fkeys = all('PRAGMA foreign_key_check');
    add('database', 'Database file is healthy',
      'SQLite integrity and foreign-key checks must report no faults.', 'error',
      integrity.map(v => ({ msg: v })).concat(fkeys.map(r => ({ msg: 'Broken link in ' + r.table + ' row ' + r.rowid }))), r => r.msg);
    add('admin', 'At least one active administrator exists',
      'Without an administrator nobody can manage the shop.', 'error',
      get("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1").n ? [] : [{}], () => 'No active administrator');
    add('below_cost', 'No product is priced below its cost',
      'A selling price under cost price means a loss on every sale.', 'warning',
      all('SELECT name, price, cost FROM products WHERE active=1 AND price < cost'), r => r.name + ': price ' + r.price + ' is below cost ' + r.cost);
    add('zero_price', 'Every product has a selling price',
      'A price of zero usually means the price was never entered.', 'warning',
      all('SELECT name FROM products WHERE active=1 AND price = 0'), r => r.name + ' has a price of 0');
    add('expired_stock', 'No expired goods are counted as stock',
      'Expired items must be written off so they are not counted or sold.', 'warning',
      all('SELECT name, qty, expiry FROM products WHERE active=1 AND qty > 0 AND expiry IS NOT NULL AND expiry < ?', today),
      r => r.name + ': ' + r.qty + ' units expired on ' + r.expiry);
    add('duplicates', 'No product is entered twice',
      'Two active products with the same name are probably a double entry.', 'warning',
      all('SELECT lower(name) AS n, COUNT(*) AS c FROM products WHERE active=1 GROUP BY lower(name) HAVING c > 1'), r => r.n + ' appears ' + r.c + ' times');
    return { ran_at: nowIso(), problems: checks.filter(c => c.status === 'problem').length, warnings: checks.filter(c => c.status === 'warning').length, checks };
  }
  function fixLedger(actor) {
    const rows = all('SELECT p.id, p.name, p.qty, COALESCE(SUM(m.qty_change),0) AS ledger FROM products p LEFT JOIN movements m ON m.product_id=p.id WHERE p.active=1 GROUP BY p.id HAVING p.qty != ledger');
    tx(db, () => {
      for (const r of rows) addMovement(r.id, 'adjust', r.qty - r.ledger, 'reconciliation', 'Records check: ledger brought in line with quantity on hand', actor.id);
      audit(actor, 'ledger_fixed', rows.length + ' product(s) reconciled');
    });
    return { fixed: rows.length };
  }

  // ---------- backup, reset and demo data ----------
  function backupTo(file) { run('VACUUM INTO ?', file); }
  function seedDemo(actor) {
    const sup = {};
    for (const n of ['Town Wholesalers', 'Fresh Dairy Distributors', 'Daily Bakery Supplies']) sup[n] = saveSupplier(actor, null, { name: n }).id;
    const T = sup['Town Wholesalers'], D = sup['Fresh Dairy Distributors'], B = sup['Daily Bakery Supplies'];
    const items = [
      ['6001001', 'Maize Flour 2kg', 'Staples', 150, 185, 40, 15, addDays(120), T], ['6001002', 'Sugar 1kg', 'Staples', 140, 165, 25, 15, addDays(300), T],
      ['6001003', 'Cooking Oil 1L', 'Staples', 260, 310, 12, 10, addDays(200), T], ['6001004', 'Rice 1kg', 'Staples', 150, 190, 30, 10, addDays(250), T],
      ['6001005', 'Fresh Milk 500ml', 'Dairy', 48, 60, 18, 12, addDays(3), D], ['6001006', 'Yoghurt 250ml', 'Dairy', 55, 75, 8, 10, addDays(-2), D],
      ['6001007', 'Bread (400g)', 'Bakery', 55, 70, 20, 10, addDays(2), B], ['6001008', 'Eggs (tray of 30)', 'Fresh', 380, 450, 6, 5, addDays(14), T],
      ['6001009', 'Tea Leaves 250g', 'Beverages', 85, 110, 22, 10, addDays(400), T], ['6001010', 'Soda 500ml', 'Beverages', 45, 60, 0, 24, addDays(150), T],
      ['6001011', 'Bar Soap', 'Household', 70, 95, 35, 15, addDays(700), T], ['6001012', 'Toilet Paper (4 pack)', 'Household', 120, 160, 9, 10, null, T],
      ['6001013', 'Salt 500g', 'Staples', 25, 40, 50, 20, addDays(600), T]
    ];
    for (const i of items) createProduct(actor, { sku: i[0], name: i[1], category: i[2], cost: i[3], price: i[4], qty: i[5], reorder: i[6], expiry: i[7], supplier_id: i[8] });
  }
  function resetAll(actor) {
    tx(db, () => {
      for (const t of ['sale_items', 'sales', 'purchases', 'movements', 'events', 'products', 'suppliers']) run('DELETE FROM ' + t);
      seedDemo(actor);
      audit(actor, 'reset', 'All shop records erased and demo data restored');
    });
  }
  function ensureStarted() {
    const out = { adminPassword: null };
    if (get('SELECT COUNT(*) AS n FROM users').n === 0) {
      const given = process.env.ADMIN_PASSWORD;
      const password = given || crypto.randomBytes(9).toString('base64url');
      const u = createUser(null, { username: 'admin', full_name: 'Shop Owner', role: 'admin', password }, { mustChange: !given });
      out.adminPassword = given ? null : password;
      out.adminId = u.id;
    }
    if (!get("SELECT value FROM meta WHERE key='seeded'") && get('SELECT COUNT(*) AS n FROM products').n === 0 && process.env.NO_DEMO !== '1') {
      seedDemo(null);
    }
    run("INSERT OR IGNORE INTO meta(key,value) VALUES('seeded','1')");
    return out;
  }

  return {
    audit, createUser, listUsers, updateUser, login, createSession, sessionUser, destroySession, changePassword,
    listSuppliers, saveSupplier, deleteSupplier, listProducts, createProduct, updateProduct, deleteProduct, restock, writeOff, countStock,
    createSale, getSale, listSales, lostSale, listEvents, listMovements, listPurchases, listAudit,
    runChecks, fixLedger, backupTo, resetAll, ensureStarted
  };
}

module.exports = { createStore, HttpError };
