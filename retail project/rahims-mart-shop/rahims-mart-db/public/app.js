/* Rahim's Mart front end. Plain JavaScript, no libraries.
   All records live in the server's SQLite database; this file only shows them and sends requests. */
(function () {
  'use strict';

  var EXPIRY_WARN_DAYS = 7;
  var S = { me: null, products: [], suppliers: [], sales: [], events: [], cart: [], view: null, rec: 'check', pwForced: false };
  var editingId = null, restockId = null, editingSupplier = null, editingUser = null, usersCache = [];

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) { return 'KES ' + Number(n).toLocaleString('en-KE', { maximumFractionDigits: 2 }); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dateStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function today() { return dateStr(new Date()); }
  function daysTo(iso) {
    if (!iso) return null;
    return Math.round((new Date(iso + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 86400000);
  }
  function when(iso) { return new Date(iso).toLocaleString(); }
  function sum(arr, f) { return arr.reduce(function (t, x) { return t + f(x); }, 0); }
  function isAdmin() { return S.me && S.me.role === 'admin'; }
  function byId(id) { return S.products.filter(function (p) { return p.id === id; })[0]; }
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, 3000);
  }

  async function api(method, url, body) {
    var res = await fetch(url, {
      method: method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'shop' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    var data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (res.status === 401 && S.me && url !== '/api/login') {
      S.me = null; showLogin('Your session ended. Please log in again.');
      throw new Error('Session ended');
    }
    if (!res.ok) { var err = new Error((data && data.error) || ('Request failed (' + res.status + ')')); err.status = res.status; throw err; }
    return data;
  }
  // wrap a click/submit handler so any error becomes a message instead of a silent failure
  function guard(fn) {
    return async function (e) { try { await fn(e); } catch (err) { if (err.message !== 'Session ended') toast(err.message); } };
  }

  // ---------- sign in / out ----------
  function showLogin(msg) {
    $('app').hidden = true; $('login').hidden = false;
    $('loginErr').textContent = msg || '';
    $('loginForm').elements.password.value = '';
    $('loginForm').elements.username.focus();
    ['prodDlg', 'restockDlg', 'countDlg', 'supDlg', 'userDlg', 'pwDlg', 'rcptDlg'].forEach(function (d) { if ($(d).open) $(d).close(); });
  }
  async function enter() {
    $('login').hidden = true; $('app').hidden = false;
    $('whoName').textContent = S.me.full_name + ' (' + S.me.role + ')';
    if (S.me.must_change) { openPassword(true); return; }
    buildNav();
    await loadData();
    show(isAdmin() ? 'dashboard' : 'pos');
  }
  async function boot() {
    try { S.me = await api('GET', '/api/me'); } catch (e) { S.me = null; }
    if (S.me) await enter(); else showLogin();
  }
  $('loginForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var f = e.target.elements;
    try {
      S.me = await api('POST', '/api/login', { username: f.username.value.trim(), password: f.password.value });
      f.password.value = ''; $('loginErr').textContent = '';
      await enter();
    } catch (err) { S.me = null; $('loginErr').textContent = err.message; }
  });
  $('logoutBtn').addEventListener('click', guard(async function () {
    try { await api('POST', '/api/logout'); } finally { S.me = null; S.cart = []; showLogin(); }
  }));

  // ---------- data ----------
  async function loadProducts() { S.products = await api('GET', '/api/products'); }
  async function loadSales() { S.sales = await api('GET', '/api/sales?limit=1000'); }
  async function loadAdminData() {
    var r = await Promise.all([api('GET', '/api/suppliers'), api('GET', '/api/sales?limit=1000'), api('GET', '/api/events?limit=300')]);
    S.suppliers = r[0]; S.sales = r[1]; S.events = r[2];
  }
  async function loadData() { await loadProducts(); if (isAdmin()) await loadAdminData(); }
  async function refreshAll() { await loadData(); render(); }

  // ---------- status ----------
  function status(p) {
    var d = daysTo(p.expiry);
    if (d !== null && d < 0) return { key: 'expired', label: 'Expired', cls: 'bad' };
    if (p.qty <= 0) return { key: 'out', label: 'Out of stock', cls: 'bad' };
    if (d !== null && d <= EXPIRY_WARN_DAYS) return { key: 'expiring', label: 'Expires in ' + d + 'd', cls: 'warn' };
    if (p.qty <= p.reorder) return { key: 'low', label: 'Low stock', cls: 'warn' };
    return { key: 'ok', label: 'OK', cls: 'good' };
  }
  function alerts() {
    var out = [];
    S.products.forEach(function (p) {
      var d = daysTo(p.expiry);
      if (d !== null && d < 0 && p.qty > 0) out.push({ p: p, kind: 'expired', cls: 'bad', text: p.name + ' expired ' + (-d) + ' day(s) ago – ' + p.qty + ' unit(s) must be removed.' });
      else if (d !== null && d >= 0 && d <= EXPIRY_WARN_DAYS && p.qty > 0) out.push({ p: p, kind: 'expiring', cls: 'warn', text: p.name + ' expires in ' + d + ' day(s) – ' + p.qty + ' unit(s) left. Sell first or discount.' });
      if (p.qty <= 0 && !(d !== null && d < 0)) out.push({ p: p, kind: 'out', cls: 'bad', text: p.name + ' is out of stock.' });
      else if (p.qty > 0 && p.qty <= p.reorder) out.push({ p: p, kind: 'low', cls: 'warn', text: p.name + ' is low: ' + p.qty + ' left (reorder at ' + p.reorder + ').' });
    });
    return out;
  }

  // ---------- navigation ----------
  var TABS = [
    { id: 'dashboard', label: 'Dashboard', admin: true }, { id: 'pos', label: 'Sell' }, { id: 'inventory', label: 'Stock', admin: true },
    { id: 'suppliers', label: 'Suppliers', admin: true }, { id: 'alerts', label: 'Alerts', admin: true }, { id: 'records', label: 'Records', admin: true },
    { id: 'reports', label: 'Reports', admin: true }, { id: 'users', label: 'Users', admin: true }
  ];
  function buildNav() {
    $('tabs').innerHTML = TABS.filter(function (t) { return !t.admin || isAdmin(); }).map(function (t) {
      return '<button data-view="' + t.id + '">' + esc(t.label) + (t.id === 'alerts' ? ' <span id="alertCount" class="badge" hidden>0</span>' : '') + '</button>';
    }).join('');
  }
  function show(view) {
    S.view = view;
    document.querySelectorAll('.view').forEach(function (v) { v.hidden = v.id !== 'v-' + view; });
    document.querySelectorAll('#tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.view === view); });
    render();
    if (view === 'pos') $('posSearch').focus();
  }
  $('tabs').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) show(b.dataset.view); });

  function render() {
    if (!S.me) return;
    var a = isAdmin() ? alerts() : [];
    var badge = $('alertCount');
    if (badge) { badge.textContent = a.length; badge.hidden = a.length === 0; }
    var v = S.view;
    if (v === 'dashboard') renderDashboard(a);
    if (v === 'pos') { renderResults(); renderCart(); }
    if (v === 'inventory') renderInventory();
    if (v === 'suppliers') renderSuppliers();
    if (v === 'alerts') renderAlerts(a);
    if (v === 'records') renderRecords();
    if (v === 'reports') renderReports();
    if (v === 'users') renderUsers();
  }
  function card(label, value, cls) { return '<div class="card ' + (cls || '') + '"><small>' + esc(label) + '</small><b>' + esc(value) + '</b></div>'; }
  function localDay(iso) { return dateStr(new Date(iso)); }
  function emptyRow(cols, text) { return '<tr><td colspan="' + cols + '" class="empty">' + esc(text) + '</td></tr>'; }

  // ---------- dashboard ----------
  function renderDashboard(a) {
    var st = S.sales.filter(function (s) { return localDay(s.time) === today(); });
    var out = S.products.filter(function (p) { return p.qty <= 0; }).length;
    var low = S.products.filter(function (p) { return p.qty > 0 && p.qty <= p.reorder; }).length;
    var exp = a.filter(function (x) { return x.kind === 'expired' || x.kind === 'expiring'; }).length;
    $('dashCards').innerHTML =
      card('Sales today', money(sum(st, function (s) { return s.total; })), 'good') +
      card('Transactions today', st.length) +
      card('Stock value (at cost)', money(sum(S.products, function (p) { return p.qty * p.cost; }))) +
      card('Out of stock', out, out ? 'bad' : '') + card('Low stock', low, low ? 'warn' : '') + card('Expiry alerts', exp, exp ? 'bad' : '');
    $('dashAlerts').innerHTML = a.length
      ? a.slice(0, 6).map(function (x) { return '<div class="alert ' + x.cls + '"><span>' + esc(x.text) + '</span></div>'; }).join('') +
        (a.length > 6 ? '<p class="empty">+ ' + (a.length - 6) + ' more in Alerts.</p>' : '')
      : '<p class="empty">Everything is in order.</p>';
  }

  // ---------- selling ----------
  function renderResults() {
    var q = $('posSearch').value.trim().toLowerCase();
    var list = S.products.filter(function (p) { return !q || p.name.toLowerCase().indexOf(q) > -1 || p.sku.toLowerCase().indexOf(q) > -1; }).slice(0, 30);
    $('posResults').innerHTML = list.length ? list.map(function (p) {
      var s = status(p), blocked = s.key === 'expired';
      return '<button class="item" data-add="' + esc(p.id) + '"' + (blocked ? ' disabled' : '') + '>' +
        '<span>' + esc(p.name) + '<small>' + esc(p.sku) + ' &middot; ' + p.qty + ' in stock</small></span>' +
        '<span><b>' + money(p.price) + '</b><br><span class="pill ' + s.cls + '">' + esc(s.label) + '</span></span></button>';
    }).join('') : '<p class="empty">No product found.</p>';
  }
  async function addToCart(id) {
    var p = byId(id); if (!p) return;
    var s = status(p);
    if (s.key === 'expired') { toast(p.name + ' is expired and cannot be sold.'); return; }
    if (p.qty <= 0) { toast(p.name + ' is out of stock.'); api('POST', '/api/products/' + id + '/lost-sale').catch(function () { /* not critical */ }); return; }
    var line = S.cart.filter(function (l) { return l.id === id; })[0];
    if ((line ? line.qty : 0) + 1 > p.qty) { toast('Only ' + p.qty + ' of ' + p.name + ' in stock.'); return; }
    if (line) line.qty++; else S.cart.push({ id: id, qty: 1 });
    renderCart();
  }
  function cartTotal() { return sum(S.cart, function (l) { var p = byId(l.id); return p ? p.price * l.qty : 0; }); }
  function renderCart() {
    $('cartLines').innerHTML = S.cart.length ? S.cart.map(function (l) {
      var p = byId(l.id); if (!p) return '';
      return '<div class="line"><span>' + esc(p.name) + '<br><small>' + money(p.price) + ' each</small></span>' +
        '<span class="qty"><button data-dec="' + esc(l.id) + '" aria-label="Less">&minus;</button><span>' + l.qty + '</span><button data-inc="' + esc(l.id) + '" aria-label="More">+</button></span>' +
        '<b>' + money(p.price * l.qty) + '</b></div>';
    }).join('') : '<p class="empty">Cart is empty.</p>';
    $('cartTotal').textContent = money(cartTotal());
    $('checkoutBtn').disabled = S.cart.length === 0;
  }
  async function checkout() {
    if (!S.cart.length) return;
    try {
      var sale = await api('POST', '/api/sales', { items: S.cart.map(function (l) { return { id: l.id, qty: l.qty }; }), method: $('payMethod').value });
      S.cart = []; $('posSearch').value = '';
      showReceipt(sale);
      await loadProducts();
      if (isAdmin()) await loadSales();
      render();
    } catch (err) {
      toast(err.message);
      await loadProducts();
      S.cart = S.cart.filter(function (l) { var p = byId(l.id); return p && p.qty >= l.qty && status(p).key !== 'expired'; });
      render();
    }
  }
  function showReceipt(s) {
    $('rcptBody').innerHTML =
      '<h2>Rahim\'s Mart</h2><div>Nakuru, Kenya</div><div>' + esc(when(s.time)) + '</div><div>Receipt #' + esc(s.id.slice(-6).toUpperCase()) + '</div>' +
      (s.cashier ? '<div>Served by ' + esc(s.cashier) + '</div>' : '') + '<hr>' +
      s.items.map(function (i) { return '<div class="r"><span>' + esc(i.name) + ' x' + i.qty + '</span><span>' + money(i.price * i.qty) + '</span></div>'; }).join('') +
      '<hr><div class="r"><b>TOTAL</b><b>' + money(s.total) + '</b></div><div class="r"><span>Paid by</span><span>' + esc(s.method) + '</span></div><hr><div>Thank you for shopping with us!</div>';
    $('rcptDlg').showModal();
  }
  $('posSearch').addEventListener('input', renderResults);
  $('posSearch').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var q = e.target.value.trim().toLowerCase(); if (!q) return;
    var exact = S.products.filter(function (p) { return p.sku.toLowerCase() === q; })[0];
    var hits = S.products.filter(function (p) { return p.name.toLowerCase().indexOf(q) > -1; });
    var pick = exact || (hits.length === 1 ? hits[0] : null);
    if (pick) { addToCart(pick.id); e.target.value = ''; renderResults(); }
    else toast(hits.length ? 'Several matches – tap the product.' : 'No product found.');
  });
  $('posResults').addEventListener('click', function (e) { var b = e.target.closest('[data-add]'); if (b) addToCart(b.dataset.add); });
  $('cartLines').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.dataset.inc) addToCart(b.dataset.inc);
    if (b.dataset.dec) {
      var l = S.cart.filter(function (x) { return x.id === b.dataset.dec; })[0];
      if (l && --l.qty <= 0) S.cart = S.cart.filter(function (x) { return x !== l; });
      renderCart();
    }
  });
  $('checkoutBtn').addEventListener('click', checkout);
  $('clearCartBtn').addEventListener('click', function () { S.cart = []; renderCart(); });
  $('rcptClose').addEventListener('click', function () { $('rcptDlg').close(); });
  $('rcptPrint').addEventListener('click', function () { window.print(); });

  // ---------- stock ----------
  function supplierName(id) { var s = S.suppliers.filter(function (x) { return x.id === id; })[0]; return s ? s.name : '–'; }
  function supplierOptions(selected) {
    return '<option value="">(none)</option>' + S.suppliers.map(function (s) {
      return '<option value="' + esc(s.id) + '"' + (s.id === selected ? ' selected' : '') + '>' + esc(s.name) + '</option>';
    }).join('');
  }
  function renderInventory() {
    var q = $('invSearch').value.trim().toLowerCase(), f = $('invFilter').value;
    var rows = S.products.filter(function (p) {
      if (q && p.name.toLowerCase().indexOf(q) < 0 && p.sku.toLowerCase().indexOf(q) < 0 && p.category.toLowerCase().indexOf(q) < 0) return false;
      var k = status(p).key;
      if (f === 'low') return k === 'low';
      if (f === 'out') return k === 'out';
      if (f === 'expiring') return k === 'expiring' || k === 'expired';
      return true;
    });
    $('invTable').innerHTML = '<thead><tr><th>Product</th><th>Barcode</th><th>Category</th><th>Supplier</th><th class="n">Cost</th><th class="n">Price</th><th class="n">Qty</th><th>Expiry</th><th>Status</th><th></th></tr></thead><tbody>' +
      (rows.length ? rows.map(function (p) {
        var s = status(p);
        return '<tr><td>' + esc(p.name) + '</td><td>' + esc(p.sku) + '</td><td>' + esc(p.category) + '</td><td>' + esc(supplierName(p.supplier_id)) + '</td><td class="n">' + money(p.cost) + '</td><td class="n">' + money(p.price) + '</td><td class="n">' + p.qty + '</td><td>' + esc(p.expiry || '–') + '</td>' +
          '<td><span class="pill ' + s.cls + '">' + esc(s.label) + '</span></td>' +
          '<td class="n"><button class="mini" data-restock="' + esc(p.id) + '">Restock</button> <button class="mini" data-count="' + esc(p.id) + '">Count</button> <button class="mini" data-edit="' + esc(p.id) + '">Edit</button> <button class="mini" data-del="' + esc(p.id) + '">Delete</button></td></tr>';
      }).join('') : emptyRow(10, 'No products match.')) + '</tbody>';
  }
  function openProduct(id) {
    editingId = id || null;
    var f = $('prodForm'); f.reset(); $('prodErr').textContent = '';
    f.elements.supplier_id.innerHTML = supplierOptions(id ? byId(id).supplier_id : '');
    $('prodTitle').textContent = id ? 'Edit product' : 'New product';
    if (id) {
      var p = byId(id);
      ['name', 'sku', 'category', 'cost', 'price', 'qty', 'reorder'].forEach(function (k) { f.elements[k].value = p[k]; });
      f.elements.expiry.value = p.expiry || '';
    } else { f.elements.category.value = 'General'; f.elements.reorder.value = 10; }
    $('prodDlg').showModal();
  }
  $('prodForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var el = e.target.elements;
    var body = { name: el.name.value, sku: el.sku.value, category: el.category.value, cost: el.cost.value, price: el.price.value, qty: el.qty.value, reorder: el.reorder.value, expiry: el.expiry.value || null, supplier_id: el.supplier_id.value || null };
    try {
      if (editingId) await api('PUT', '/api/products/' + editingId, body); else await api('POST', '/api/products', body);
      $('prodDlg').close(); toast(editingId ? 'Product updated.' : 'Product added.'); await refreshAll();
    } catch (err) { $('prodErr').textContent = err.message; }
  });
  $('prodCancel').addEventListener('click', function () { $('prodDlg').close(); });
  $('addProductBtn').addEventListener('click', function () { openProduct(null); });
  $('invSearch').addEventListener('input', renderInventory);
  $('invFilter').addEventListener('change', renderInventory);
  $('invTable').addEventListener('click', guard(async function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.dataset.edit) openProduct(b.dataset.edit);
    if (b.dataset.restock) openRestock(b.dataset.restock);
    if (b.dataset.count) openCount(b.dataset.count);
    if (b.dataset.del) {
      var p = byId(b.dataset.del);
      if (!confirm('Delete ' + p.name + '? Past sales and the stock ledger are kept.')) return;
      await api('DELETE', '/api/products/' + p.id); S.cart = S.cart.filter(function (l) { return l.id !== p.id; });
      toast('Deleted.'); await refreshAll();
    }
  }));

  function openRestock(id) {
    restockId = id; var p = byId(id), f = $('restockForm');
    f.reset(); $('restockErr').textContent = '';
    $('restockTitle').textContent = 'Restock: ' + p.name;
    f.elements.unit_cost.value = p.cost;
    f.elements.supplier_id.innerHTML = supplierOptions(p.supplier_id);
    $('restockDlg').showModal();
  }
  $('restockForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var el = e.target.elements;
    try {
      await api('POST', '/api/products/' + restockId + '/restock', { n: el.n.value, unit_cost: el.unit_cost.value, supplier_id: el.supplier_id.value || null, expiry: el.expiry.value || null });
      $('restockDlg').close(); toast('Stock updated and purchase recorded.'); await refreshAll();
    } catch (err) { $('restockErr').textContent = err.message; }
  });
  $('restockCancel').addEventListener('click', function () { $('restockDlg').close(); });

  // physical stock-take: compare what is counted with what the system shows
  var countId = null;
  function openCount(id) {
    countId = id; var p = byId(id), f = $('countForm');
    f.reset(); $('countErr').textContent = '';
    $('countTitle').textContent = 'Stock-take: ' + p.name;
    $('countInfo').textContent = 'The system shows ' + p.qty + ' in stock. Count the real units, then enter the number.';
    f.elements.counted.value = p.qty;
    $('countDlg').showModal();
  }
  $('countForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var el = e.target.elements;
    try {
      var r = await api('POST', '/api/products/' + countId + '/count', { counted: el.counted.value, note: el.note.value });
      $('countDlg').close();
      toast(r.diff === 0 ? 'Count matches the system.' : (r.diff < 0 ? 'Short by ' + (-r.diff) + ' (loss ' + money(r.loss) + '). Stock corrected.' : 'Found ' + r.diff + ' more than recorded. Stock corrected.'));
      await refreshAll();
    } catch (err) { $('countErr').textContent = err.message; }
  });
  $('countCancel').addEventListener('click', function () { $('countDlg').close(); });

  // ---------- suppliers ----------
  function renderSuppliers() {
    $('supTable').innerHTML = '<thead><tr><th>Name</th><th>Phone</th><th>Notes</th><th class="n">Products</th><th></th></tr></thead><tbody>' +
      (S.suppliers.length ? S.suppliers.map(function (s) {
        var n = S.products.filter(function (p) { return p.supplier_id === s.id; }).length;
        return '<tr><td>' + esc(s.name) + '</td><td>' + esc(s.phone || '–') + '</td><td>' + esc(s.notes || '–') + '</td><td class="n">' + n + '</td>' +
          '<td class="n"><button class="mini" data-sedit="' + esc(s.id) + '">Edit</button> <button class="mini" data-sdel="' + esc(s.id) + '">Delete</button></td></tr>';
      }).join('') : emptyRow(5, 'No suppliers yet.')) + '</tbody>';
  }
  function openSupplier(id) {
    editingSupplier = id || null;
    var f = $('supForm'); f.reset(); $('supErr').textContent = '';
    $('supTitle').textContent = id ? 'Edit supplier' : 'New supplier';
    if (id) { var s = S.suppliers.filter(function (x) { return x.id === id; })[0]; f.elements.name.value = s.name; f.elements.phone.value = s.phone || ''; f.elements.notes.value = s.notes || ''; }
    $('supDlg').showModal();
  }
  $('addSupplierBtn').addEventListener('click', function () { openSupplier(null); });
  $('supCancel').addEventListener('click', function () { $('supDlg').close(); });
  $('supForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var el = e.target.elements, body = { name: el.name.value, phone: el.phone.value, notes: el.notes.value };
    try {
      if (editingSupplier) await api('PUT', '/api/suppliers/' + editingSupplier, body); else await api('POST', '/api/suppliers', body);
      $('supDlg').close(); toast('Supplier saved.'); await refreshAll();
    } catch (err) { $('supErr').textContent = err.message; }
  });
  $('supTable').addEventListener('click', guard(async function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.dataset.sedit) openSupplier(b.dataset.sedit);
    if (b.dataset.sdel) {
      if (!confirm('Delete this supplier? Their past purchase records are kept.')) return;
      await api('DELETE', '/api/suppliers/' + b.dataset.sdel); toast('Supplier deleted.'); await refreshAll();
    }
  }));

  // ---------- alerts ----------
  function renderAlerts(a) {
    if (!a.length) { $('alertsBody').innerHTML = '<p class="empty">No alerts. Stock levels and expiry dates are fine.</p>'; return; }
    $('alertsBody').innerHTML = a.map(function (x) {
      var btn = x.kind === 'expired' ? '<button class="mini" data-writeoff="' + esc(x.p.id) + '">Write off ' + x.p.qty + '</button>'
        : (x.kind === 'low' || x.kind === 'out') ? '<button class="mini" data-restock="' + esc(x.p.id) + '">Restock</button>' : '';
      return '<div class="alert ' + x.cls + '"><span>' + esc(x.text) + '</span>' + btn + '</div>';
    }).join('');
  }
  $('alertsBody').addEventListener('click', guard(async function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.dataset.restock) openRestock(b.dataset.restock);
    if (b.dataset.writeoff) {
      var r = await api('POST', '/api/products/' + b.dataset.writeoff + '/writeoff', { reason: 'expired' });
      toast('Written off ' + money(r.loss) + '.'); await refreshAll();
    }
  }));

  // ---------- records ----------
  var recBusy = 0;
  async function renderRecords() {
    document.querySelectorAll('#recTabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.rec === S.rec); });
    var token = ++recBusy, body = $('recBody');
    body.innerHTML = '<p class="empty">Loading…</p>';
    try {
      var html = '';
      if (S.rec === 'check') html = checkHtml(await api('GET', '/api/check'));
      if (S.rec === 'ledger') html = ledgerHtml(await api('GET', '/api/movements?limit=300'));
      if (S.rec === 'purchases') html = purchasesHtml(await api('GET', '/api/purchases?limit=300'));
      if (S.rec === 'audit') html = auditHtml(await api('GET', '/api/audit?limit=300'));
      if (token === recBusy) body.innerHTML = html;
    } catch (err) { if (token === recBusy && err.message !== 'Session ended') body.innerHTML = '<p class="err">' + esc(err.message) + '</p>'; }
  }
  function checkHtml(r) {
    var head = '<p class="sumline"><b>' + r.problems + '</b> problem(s) and <b>' + r.warnings + '</b> warning(s). Last run ' + esc(when(r.ran_at)) + '. <button class="mini" data-recheck="1">Run again</button></p>';
    return head + r.checks.map(function (c) {
      var pill = c.status === 'ok' ? '<span class="pill good">OK</span>' : c.status === 'warning' ? '<span class="pill warn">Warning · ' + c.count + '</span>' : '<span class="pill bad">Problem · ' + c.count + '</span>';
      return '<div class="chk ' + c.status + '"><div class="head"><span><b>' + esc(c.title) + '</b><small>' + esc(c.description) + '</small></span><span>' + pill +
        (c.fix === 'ledger' ? ' <button class="mini" data-fixledger="1">Fix: record adjustments</button>' : '') + '</span></div>' +
        (c.items.length ? '<ul>' + c.items.map(function (i) { return '<li>' + esc(i) + '</li>'; }).join('') + (c.count > c.items.length ? '<li>… and ' + (c.count - c.items.length) + ' more</li>' : '') + '</ul>' : '') + '</div>';
    }).join('');
  }
  function ledgerHtml(rows) {
    return '<div class="scroll"><table><thead><tr><th>Time</th><th>Product</th><th>Type</th><th class="n">Change</th><th>Reference</th><th>Note</th><th>User</th></tr></thead><tbody>' +
      (rows.length ? rows.map(function (m) {
        return '<tr><td>' + esc(when(m.time)) + '</td><td>' + esc(m.product_name) + '</td><td>' + esc(m.type) + '</td><td class="n">' + (m.qty_change > 0 ? '+' : '') + m.qty_change + '</td><td>' + esc(m.ref ? String(m.ref).slice(-6).toUpperCase() : '') + '</td><td>' + esc(m.note || '') + '</td><td>' + esc(m.username || '') + '</td></tr>';
      }).join('') : emptyRow(7, 'No movements yet.')) + '</tbody></table></div>';
  }
  function purchasesHtml(rows) {
    return '<div class="scroll"><table><thead><tr><th>Time</th><th>Product</th><th>Supplier</th><th class="n">Qty</th><th class="n">Unit cost</th><th class="n">Total</th><th>Recorded by</th></tr></thead><tbody>' +
      (rows.length ? rows.map(function (p) {
        return '<tr><td>' + esc(when(p.time)) + '</td><td>' + esc(p.product_name) + '</td><td>' + esc(p.supplier || '–') + '</td><td class="n">' + p.qty + '</td><td class="n">' + money(p.unit_cost) + '</td><td class="n">' + money(p.total) + '</td><td>' + esc(p.username || '') + '</td></tr>';
      }).join('') : emptyRow(7, 'No purchases recorded yet. Use Restock on the Stock screen.')) + '</tbody></table></div>';
  }
  function auditHtml(rows) {
    return '<div class="scroll"><table><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Detail</th></tr></thead><tbody>' +
      (rows.length ? rows.map(function (a) {
        return '<tr><td>' + esc(when(a.time)) + '</td><td>' + esc(a.username || '–') + '</td><td>' + esc(a.action) + '</td><td>' + esc(a.detail || '') + '</td></tr>';
      }).join('') : emptyRow(4, 'Nothing recorded yet.')) + '</tbody></table></div>';
  }
  $('recTabs').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) { S.rec = b.dataset.rec; renderRecords(); } });
  $('recBody').addEventListener('click', guard(async function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.dataset.recheck) renderRecords();
    if (b.dataset.fixledger) {
      if (!confirm('For each mismatch, record an adjustment so the ledger matches the quantity on hand. Continue?')) return;
      var r = await api('POST', '/api/check/fix-ledger'); toast('Reconciled ' + r.fixed + ' product(s).'); renderRecords();
    }
  }));

  // ---------- reports ----------
  var EVENT_LABEL = { lost_sale: 'Lost sale', sold_out: 'Sold out', writeoff: 'Write-off', shrinkage: 'Stock-take shortage' };
  function renderReports() {
    var rev = sum(S.sales, function (s) { return s.total; });
    var profit = sum(S.sales, function (s) { return sum(s.items, function (i) { return (i.price - i.cost) * i.qty; }); });
    var waste = sum(S.events.filter(function (l) { return l.type === 'writeoff'; }), function (l) { return l.loss; });
    var shortage = sum(S.events.filter(function (l) { return l.type === 'shrinkage'; }), function (l) { return l.loss; });
    var lost = S.events.filter(function (l) { return l.type === 'lost_sale'; });
    $('repCards').innerHTML = card('Total sales', money(rev), 'good') + card('Gross profit', money(profit), 'good') +
      card('Write-offs', money(waste), waste ? 'bad' : '') + card('Stock-take shortages', money(shortage), shortage ? 'bad' : '') + card('Lost-sale requests', lost.length, lost.length ? 'warn' : '') + card('Receipts', S.sales.length);
    var days = {};
    S.sales.forEach(function (s) { var d = localDay(s.time); days[d] = days[d] || { n: 0, t: 0 }; days[d].n++; days[d].t += s.total; });
    var dk = Object.keys(days).sort().reverse().slice(0, 14);
    $('dayTable').innerHTML = '<thead><tr><th>Date</th><th class="n">Sales</th><th class="n">Total</th></tr></thead><tbody>' +
      (dk.length ? dk.map(function (d) { return '<tr><td>' + esc(d) + '</td><td class="n">' + days[d].n + '</td><td class="n">' + money(days[d].t) + '</td></tr>'; }).join('') : emptyRow(3, 'No sales yet.')) + '</tbody>';
    var tally = {};
    S.sales.forEach(function (s) { s.items.forEach(function (i) { tally[i.name] = tally[i.name] || { q: 0, t: 0 }; tally[i.name].q += i.qty; tally[i.name].t += i.qty * i.price; }); });
    var tk = Object.keys(tally).sort(function (a, b) { return tally[b].q - tally[a].q; }).slice(0, 8);
    $('topTable').innerHTML = '<thead><tr><th>Product</th><th class="n">Units</th><th class="n">Revenue</th></tr></thead><tbody>' +
      (tk.length ? tk.map(function (k) { return '<tr><td>' + esc(k) + '</td><td class="n">' + tally[k].q + '</td><td class="n">' + money(tally[k].t) + '</td></tr>'; }).join('') : emptyRow(3, 'No sales yet.')) + '</tbody>';
    $('logTable').innerHTML = '<thead><tr><th>Time</th><th>Type</th><th>Detail</th><th class="n">Value</th></tr></thead><tbody>' +
      (S.events.length ? S.events.slice(0, 30).map(function (l) {
        return '<tr><td>' + esc(when(l.time)) + '</td><td>' + esc(EVENT_LABEL[l.type] || l.type) + '</td><td>' + esc(l.text) + '</td><td class="n">' + (l.loss ? money(l.loss) : '') + '</td></tr>';
      }).join('') : emptyRow(4, 'Nothing logged yet.')) + '</tbody>';
  }
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    if (typeof v === 'string' && /^[=+\-@]/.test(s)) s = "'" + s; // stops spreadsheet formula injection
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function download(name, rows) {
    var csv = rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
    var url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    var a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 500);
  }
  $('exportSales').addEventListener('click', function () {
    var rows = [['Receipt', 'Time', 'Payment', 'Cashier', 'Item', 'Qty', 'Unit price', 'Line total']];
    S.sales.forEach(function (s) { s.items.forEach(function (i) { rows.push([s.id.slice(-6).toUpperCase(), s.time, s.method, s.cashier || '', i.name, i.qty, i.price, i.qty * i.price]); }); });
    download('sales.csv', rows);
  });
  $('exportStock').addEventListener('click', function () {
    var rows = [['Barcode', 'Name', 'Category', 'Supplier', 'Cost', 'Price', 'Qty', 'Reorder level', 'Expiry']];
    S.products.forEach(function (p) { rows.push([p.sku, p.name, p.category, supplierName(p.supplier_id) === '–' ? '' : supplierName(p.supplier_id), p.cost, p.price, p.qty, p.reorder, p.expiry || '']); });
    download('stock.csv', rows);
  });
  $('backupBtn').addEventListener('click', function () { window.location.href = '/api/backup'; });
  $('resetBtn').addEventListener('click', guard(async function () {
    var answer = prompt('This erases ALL products, sales and records and restores the demo data (a backup is saved first).\nType RESET to continue.');
    if (answer !== 'RESET') return;
    await api('POST', '/api/reset', { confirm: 'RESET' }); S.cart = []; toast('Demo data restored.'); await refreshAll();
  }));

  // ---------- users ----------
  async function renderUsers() {
    usersCache = await api('GET', '/api/users').catch(function () { return usersCache; });
    $('userTable').innerHTML = '<thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>' +
      usersCache.map(function (u) {
        return '<tr><td>' + esc(u.username) + '</td><td>' + esc(u.full_name) + '</td><td>' + esc(u.role) + '</td><td><span class="pill ' + (u.active ? 'good' : 'bad') + '">' + (u.active ? 'Active' : 'Disabled') + '</span>' + (u.must_change ? ' <span class="pill warn">Must change password</span>' : '') + '</td>' +
          '<td class="n"><button class="mini" data-uedit="' + esc(u.id) + '">Edit</button></td></tr>';
      }).join('') + '</tbody>';
  }
  function openUser(id) {
    editingUser = id || null;
    var f = $('userForm'); f.reset(); $('userErr').textContent = '';
    $('userTitle').textContent = id ? 'Edit user' : 'New user';
    f.elements.username.readOnly = !!id;
    $('userActiveRow').hidden = !id;
    $('userPwLabel').firstChild.textContent = id ? 'New password (leave empty to keep the current one)' : 'Password (at least 8 characters)';
    f.elements.password.required = !id;
    if (id) {
      var u = usersCache.filter(function (x) { return x.id === id; })[0];
      f.elements.username.value = u.username; f.elements.full_name.value = u.full_name; f.elements.role.value = u.role; f.elements.active.checked = !!u.active;
    }
    $('userDlg').showModal();
  }
  $('addUserBtn').addEventListener('click', function () { openUser(null); });
  $('userCancel').addEventListener('click', function () { $('userDlg').close(); });
  $('userTable').addEventListener('click', function (e) { var b = e.target.closest('[data-uedit]'); if (b) openUser(b.dataset.uedit); });
  $('userForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var el = e.target.elements;
    try {
      if (editingUser) {
        var body = { full_name: el.full_name.value, role: el.role.value, active: el.active.checked };
        if (el.password.value) body.password = el.password.value;
        await api('PUT', '/api/users/' + editingUser, body);
      } else {
        await api('POST', '/api/users', { username: el.username.value, full_name: el.full_name.value, role: el.role.value, password: el.password.value });
      }
      $('userDlg').close(); toast('User saved.'); renderUsers();
    } catch (err) { $('userErr').textContent = err.message; }
  });

  // ---------- password ----------
  function openPassword(forced) {
    S.pwForced = !!forced;
    var f = $('pwForm'); f.reset(); $('pwErr').textContent = '';
    $('pwNote').hidden = !forced; $('pwCancel').hidden = !!forced;
    $('pwTitle').textContent = forced ? 'Choose a new password' : 'Change password';
    $('pwDlg').showModal();
  }
  $('pwBtn').addEventListener('click', function () { openPassword(false); });
  $('pwCancel').addEventListener('click', function () { $('pwDlg').close(); });
  $('pwDlg').addEventListener('cancel', function (e) { if (S.pwForced) e.preventDefault(); });
  $('pwForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var el = e.target.elements;
    if (el.next.value !== el.again.value) { $('pwErr').textContent = 'The two new passwords do not match.'; return; }
    try {
      await api('POST', '/api/password', { current: el.current.value, next: el.next.value });
      $('pwDlg').close(); toast('Password changed.');
      if (S.pwForced) { S.pwForced = false; S.me.must_change = 0; await enter(); }
    } catch (err) { $('pwErr').textContent = err.message; }
  });

  boot();
})();
