(function () {
  'use strict';

  var KEY = 'rahims-mart-v1';
  var EXPIRY_WARN_DAYS = 7;
  var state = load();
  var cart = []; // [{id, qty}]
  var editingId = null;
  var restockId = null;
  var lastStockoutLog = {};

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) { return 'KES ' + Number(n).toLocaleString('en-KE', { maximumFractionDigits: 2 }); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dateStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function today() { return dateStr(new Date()); }
  function addDays(n) { var d = new Date(); d.setDate(d.getDate() + n); return dateStr(d); }
  function daysTo(iso) {
    if (!iso) return null;
    var a = new Date(today() + 'T00:00:00'), b = new Date(iso + 'T00:00:00');
    return Math.round((b - a) / 86400000);
  }
  function byId(id) { return state.products.filter(function (p) { return p.id === id; })[0]; }
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  // ---------- storage ----------
  function seed() {
    function p(sku, name, cat, cost, price, qty, reorder, exp) {
      return { id: uid() + sku, sku: sku, name: name, category: cat, cost: cost, price: price, qty: qty, reorder: reorder, expiry: exp };
    }
    return {
      products: [
        p('6001001', 'Maize Flour 2kg', 'Staples', 150, 185, 40, 15, addDays(120)),
        p('6001002', 'Sugar 1kg', 'Staples', 140, 165, 25, 15, addDays(300)),
        p('6001003', 'Cooking Oil 1L', 'Staples', 260, 310, 12, 10, addDays(200)),
        p('6001004', 'Rice 1kg', 'Staples', 150, 190, 30, 10, addDays(250)),
        p('6001005', 'Fresh Milk 500ml', 'Dairy', 48, 60, 18, 12, addDays(3)),
        p('6001006', 'Yoghurt 250ml', 'Dairy', 55, 75, 8, 10, addDays(-2)),
        p('6001007', 'Bread (400g)', 'Bakery', 55, 70, 20, 10, addDays(2)),
        p('6001008', 'Eggs (tray of 30)', 'Fresh', 380, 450, 6, 5, addDays(14)),
        p('6001009', 'Tea Leaves 250g', 'Beverages', 85, 110, 22, 10, addDays(400)),
        p('6001010', 'Soda 500ml', 'Beverages', 45, 60, 0, 24, addDays(150)),
        p('6001011', 'Bar Soap', 'Household', 70, 95, 35, 15, addDays(700)),
        p('6001012', 'Toilet Paper (4 pack)', 'Household', 120, 160, 9, 10, null),
        p('6001013', 'Salt 500g', 'Staples', 25, 40, 50, 20, addDays(600))
      ],
      sales: [],
      log: []
    };
  }
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var s = JSON.parse(raw);
        if (s && s.products && s.sales && s.log) return s;
      }
    } catch (e) { /* storage blocked: fall through to demo data */ }
    return seed();
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* private mode: data lasts this session only */ }
  }
  function log(type, text, loss) {
    state.log.unshift({ time: new Date().toISOString(), type: type, text: text, loss: loss || 0 });
    if (state.log.length > 500) state.log.length = 500;
  }

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
    state.products.forEach(function (p) {
      var d = daysTo(p.expiry);
      if (d !== null && d < 0 && p.qty > 0) out.push({ p: p, kind: 'expired', cls: 'bad', text: p.name + ' expired ' + (-d) + ' day(s) ago – ' + p.qty + ' unit(s) must be removed.' });
      else if (d !== null && d >= 0 && d <= EXPIRY_WARN_DAYS && p.qty > 0) out.push({ p: p, kind: 'expiring', cls: 'warn', text: p.name + ' expires in ' + d + ' day(s) – ' + p.qty + ' unit(s) left. Sell first or discount.' });
      if (p.qty <= 0 && !(d !== null && d < 0)) out.push({ p: p, kind: 'out', cls: 'bad', text: p.name + ' is out of stock.' });
      else if (p.qty > 0 && p.qty <= p.reorder) out.push({ p: p, kind: 'low', cls: 'warn', text: p.name + ' is low: ' + p.qty + ' left (reorder at ' + p.reorder + ').' });
    });
    return out;
  }

  // ---------- views ----------
  function show(view) {
    document.querySelectorAll('.view').forEach(function (v) { v.hidden = v.id !== 'v-' + view; });
    document.querySelectorAll('#tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.view === view); });
    render();
    if (view === 'pos') $('posSearch').focus();
  }
  function currentView() {
    var on = document.querySelector('#tabs button.on');
    return on ? on.dataset.view : 'dashboard';
  }
  function render() {
    var a = alerts();
    var badge = $('alertCount');
    badge.textContent = a.length; badge.hidden = a.length === 0;
    var v = currentView();
    if (v === 'dashboard') renderDashboard(a);
    if (v === 'pos') { renderResults(); renderCart(); }
    if (v === 'inventory') renderInventory();
    if (v === 'alerts') renderAlerts(a);
    if (v === 'reports') renderReports();
  }
  function card(label, value, cls) { return '<div class="card ' + (cls || '') + '"><small>' + esc(label) + '</small><b>' + esc(value) + '</b></div>'; }

  function localDay(iso) { return dateStr(new Date(iso)); }
  function sum(arr, f) { return arr.reduce(function (t, x) { return t + f(x); }, 0); }

  function renderDashboard(a) {
    var st = state.sales.filter(function (s) { return localDay(s.time) === today(); });
    var stockValue = sum(state.products, function (p) { return p.qty * p.cost; });
    var out = state.products.filter(function (p) { return p.qty <= 0; }).length;
    var low = state.products.filter(function (p) { return p.qty > 0 && p.qty <= p.reorder; }).length;
    var exp = a.filter(function (x) { return x.kind === 'expired' || x.kind === 'expiring'; }).length;
    $('dashCards').innerHTML =
      card('Sales today', money(sum(st, function (s) { return s.total; })), 'good') +
      card('Transactions today', st.length) +
      card('Stock value (at cost)', money(stockValue)) +
      card('Out of stock', out, out ? 'bad' : '') +
      card('Low stock', low, low ? 'warn' : '') +
      card('Expiry alerts', exp, exp ? 'bad' : '');
    $('dashAlerts').innerHTML = a.length
      ? a.slice(0, 6).map(function (x) { return '<div class="alert ' + x.cls + '"><span>' + esc(x.text) + '</span></div>'; }).join('') +
        (a.length > 6 ? '<p class="empty">+ ' + (a.length - 6) + ' more in Alerts.</p>' : '')
      : '<p class="empty">Everything is in order.</p>';
  }

  // POS
  function renderResults() {
    var q = $('posSearch').value.trim().toLowerCase();
    var list = state.products.filter(function (p) {
      return !q || p.name.toLowerCase().indexOf(q) > -1 || p.sku.toLowerCase().indexOf(q) > -1;
    }).slice(0, 30);
    $('posResults').innerHTML = list.length ? list.map(function (p) {
      var s = status(p);
      var blocked = s.key === 'out' || s.key === 'expired';
      return '<button class="item" data-add="' + esc(p.id) + '"' + (blocked ? ' disabled' : '') + '>' +
        '<span>' + esc(p.name) + '<small>' + esc(p.sku) + ' &middot; ' + p.qty + ' in stock</small></span>' +
        '<span><b>' + money(p.price) + '</b><br><span class="pill ' + s.cls + '">' + esc(s.label) + '</span></span></button>';
    }).join('') : '<p class="empty">No product found.</p>';
  }
  function addToCart(id) {
    var p = byId(id); if (!p) return;
    var s = status(p);
    if (s.key === 'expired') { toast(p.name + ' is expired and cannot be sold.'); return; }
    if (p.qty <= 0) { noteStockout(p); toast(p.name + ' is out of stock.'); return; }
    var line = cart.filter(function (l) { return l.id === id; })[0];
    var have = line ? line.qty : 0;
    if (have + 1 > p.qty) { toast('Only ' + p.qty + ' of ' + p.name + ' in stock.'); return; }
    if (line) line.qty++; else cart.push({ id: id, qty: 1 });
    renderCart();
  }
  function noteStockout(p) {
    // a customer asked for something we do not have: a lost-sale record (objective 2)
    var now = Date.now();
    if (lastStockoutLog[p.id] && now - lastStockoutLog[p.id] < 60000) return;
    lastStockoutLog[p.id] = now;
    log('stockout', 'Customer asked for ' + p.name + ' but it was out of stock (lost sale).', p.price);
    save();
  }
  function cartTotal() {
    return sum(cart, function (l) { var p = byId(l.id); return p ? p.price * l.qty : 0; });
  }
  function renderCart() {
    $('cartLines').innerHTML = cart.length ? cart.map(function (l) {
      var p = byId(l.id); if (!p) return '';
      return '<div class="line"><span>' + esc(p.name) + '<br><small>' + money(p.price) + ' each</small></span>' +
        '<span class="qty"><button data-dec="' + esc(l.id) + '" aria-label="Less">&minus;</button><span>' + l.qty + '</span><button data-inc="' + esc(l.id) + '" aria-label="More">+</button></span>' +
        '<b>' + money(p.price * l.qty) + '</b></div>';
    }).join('') : '<p class="empty">Cart is empty.</p>';
    $('cartTotal').textContent = money(cartTotal());
    $('checkoutBtn').disabled = cart.length === 0;
  }
  function checkout() {
    if (!cart.length) return;
    var items = [];
    for (var i = 0; i < cart.length; i++) {
      var p = byId(cart[i].id);
      if (!p || cart[i].qty > p.qty || status(p).key === 'expired') { toast('Stock changed. Review the cart.'); cart = cart.filter(function (l) { var q = byId(l.id); return q && q.qty > 0 && status(q).key !== 'expired'; }); renderCart(); return; }
      items.push({ id: p.id, name: p.name, qty: cart[i].qty, price: p.price, cost: p.cost });
    }
    items.forEach(function (it) {
      var p = byId(it.id); p.qty -= it.qty;
      if (p.qty <= 0) log('stockout', p.name + ' sold out.', 0);
    });
    var sale = { id: uid(), time: new Date().toISOString(), items: items, total: sum(items, function (x) { return x.price * x.qty; }), method: $('payMethod').value };
    state.sales.unshift(sale);
    save();
    cart = [];
    $('posSearch').value = '';
    showReceipt(sale);
    render();
  }
  function showReceipt(s) {
    var d = new Date(s.time);
    $('rcptBody').innerHTML =
      '<h2>Rahim\'s Mart</h2><div>Nakuru, Kenya</div><div>' + esc(d.toLocaleString()) + '</div><div>Receipt #' + esc(s.id.slice(-6).toUpperCase()) + '</div><hr>' +
      s.items.map(function (i) { return '<div class="r"><span>' + esc(i.name) + ' x' + i.qty + '</span><span>' + money(i.price * i.qty) + '</span></div>'; }).join('') +
      '<hr><div class="r"><b>TOTAL</b><b>' + money(s.total) + '</b></div><div class="r"><span>Paid by</span><span>' + esc(s.method) + '</span></div><hr><div>Thank you for shopping with us!</div>';
    $('rcptDlg').showModal();
  }

  // Inventory
  function renderInventory() {
    var q = $('invSearch').value.trim().toLowerCase(), f = $('invFilter').value;
    var rows = state.products.filter(function (p) {
      if (q && p.name.toLowerCase().indexOf(q) < 0 && p.sku.toLowerCase().indexOf(q) < 0 && p.category.toLowerCase().indexOf(q) < 0) return false;
      var k = status(p).key;
      if (f === 'low') return k === 'low';
      if (f === 'out') return k === 'out';
      if (f === 'expiring') return k === 'expiring' || k === 'expired';
      return true;
    });
    $('invTable').innerHTML = '<thead><tr><th>Product</th><th>Barcode</th><th>Category</th><th class="n">Cost</th><th class="n">Price</th><th class="n">Qty</th><th>Expiry</th><th>Status</th><th></th></tr></thead><tbody>' +
      (rows.length ? rows.map(function (p) {
        var s = status(p);
        return '<tr><td>' + esc(p.name) + '</td><td>' + esc(p.sku) + '</td><td>' + esc(p.category) + '</td><td class="n">' + money(p.cost) + '</td><td class="n">' + money(p.price) + '</td><td class="n">' + p.qty + '</td><td>' + esc(p.expiry || '–') + '</td>' +
          '<td><span class="pill ' + s.cls + '">' + esc(s.label) + '</span></td>' +
          '<td class="n"><button class="mini" data-restock="' + esc(p.id) + '">Restock</button> <button class="mini" data-edit="' + esc(p.id) + '">Edit</button> <button class="mini" data-del="' + esc(p.id) + '">Delete</button></td></tr>';
      }).join('') : '<tr><td colspan="9" class="empty">No products match.</td></tr>') + '</tbody>';
  }
  function openProduct(id) {
    editingId = id || null;
    var f = $('prodForm'); f.reset(); $('prodErr').textContent = '';
    $('prodTitle').textContent = id ? 'Edit product' : 'New product';
    if (id) {
      var p = byId(id);
      ['name', 'sku', 'category', 'cost', 'price', 'qty', 'reorder'].forEach(function (k) { f.elements[k].value = p[k]; });
      f.elements.expiry.value = p.expiry || '';
    } else { f.elements.category.value = 'General'; f.elements.reorder.value = 10; }
    $('prodDlg').showModal();
  }
  function saveProduct(e) {
    e.preventDefault();
    var f = $('prodForm'), el = f.elements;
    var rec = {
      name: el.name.value.trim(), sku: el.sku.value.trim(), category: el.category.value.trim() || 'General',
      cost: parseFloat(el.cost.value), price: parseFloat(el.price.value),
      qty: parseInt(el.qty.value, 10), reorder: parseInt(el.reorder.value, 10), expiry: el.expiry.value || null
    };
    var err = '';
    if (!rec.name || !rec.sku) err = 'Name and barcode are required.';
    else if (isNaN(rec.cost) || isNaN(rec.price) || rec.cost < 0 || rec.price < 0) err = 'Enter valid prices.';
    else if (isNaN(rec.qty) || rec.qty < 0 || isNaN(rec.reorder) || rec.reorder < 0) err = 'Enter valid quantities.';
    else if (rec.price < rec.cost) err = 'Selling price is below cost price.';
    else if (state.products.some(function (p) { return p.sku === rec.sku && p.id !== editingId; })) err = 'That barcode is already used.';
    if (err) { $('prodErr').textContent = err; return; }
    if (editingId) { Object.assign(byId(editingId), rec); toast('Product updated.'); }
    else { rec.id = uid(); state.products.push(rec); log('restock', 'New product added: ' + rec.name + ' (' + rec.qty + ' units).', 0); toast('Product added.'); }
    save(); $('prodDlg').close(); render();
  }
  function deleteProduct(id) {
    var p = byId(id); if (!p) return;
    if (!confirm('Delete ' + p.name + '? Past sales are kept.')) return;
    state.products = state.products.filter(function (x) { return x.id !== id; });
    cart = cart.filter(function (l) { return l.id !== id; });
    save(); render(); toast('Deleted.');
  }
  function openRestock(id) {
    restockId = id; var p = byId(id);
    $('restockTitle').textContent = 'Restock: ' + p.name;
    $('restockForm').reset(); $('restockDlg').showModal();
  }
  function saveRestock(e) {
    e.preventDefault();
    var n = parseInt($('restockForm').elements.n.value, 10), exp = $('restockForm').elements.expiry.value;
    var p = byId(restockId);
    if (!p || isNaN(n) || n < 1) return;
    p.qty += n; if (exp) p.expiry = exp;
    log('restock', 'Received ' + n + ' x ' + p.name + '.', 0);
    save(); $('restockDlg').close(); render(); toast('Stock updated.');
  }

  // Alerts
  function renderAlerts(a) {
    if (!a.length) { $('alertsBody').innerHTML = '<p class="empty">No alerts. Stock levels and expiry dates are fine.</p>'; return; }
    $('alertsBody').innerHTML = a.map(function (x) {
      var btn = x.kind === 'expired'
        ? '<button class="mini" data-writeoff="' + esc(x.p.id) + '">Write off ' + x.p.qty + '</button>'
        : (x.kind === 'low' || x.kind === 'out') ? '<button class="mini" data-restock="' + esc(x.p.id) + '">Restock</button>' : '';
      return '<div class="alert ' + x.cls + '"><span>' + esc(x.text) + '</span>' + btn + '</div>';
    }).join('');
  }
  function writeOff(id) {
    var p = byId(id); if (!p || p.qty <= 0) return;
    var loss = p.qty * p.cost;
    log('expired', 'Wrote off ' + p.qty + ' x ' + p.name + ' (expired ' + p.expiry + ').', loss);
    p.qty = 0; save(); render(); toast('Written off ' + money(loss) + '.');
  }

  // Reports
  function renderReports() {
    var rev = sum(state.sales, function (s) { return s.total; });
    var profit = sum(state.sales, function (s) { return sum(s.items, function (i) { return (i.price - i.cost) * i.qty; }); });
    var waste = sum(state.log.filter(function (l) { return l.type === 'expired'; }), function (l) { return l.loss; });
    var lost = state.log.filter(function (l) { return l.type === 'stockout' && l.text.indexOf('lost sale') > -1; });
    $('repCards').innerHTML =
      card('Total sales', money(rev), 'good') + card('Gross profit', money(profit), 'good') +
      card('Expiry write-offs', money(waste), waste ? 'bad' : '') +
      card('Lost-sale requests', lost.length, lost.length ? 'warn' : '') +
      card('Receipts', state.sales.length);
    var days = {};
    state.sales.forEach(function (s) { var d = localDay(s.time); days[d] = days[d] || { n: 0, t: 0 }; days[d].n++; days[d].t += s.total; });
    var dk = Object.keys(days).sort().reverse().slice(0, 14);
    $('dayTable').innerHTML = '<thead><tr><th>Date</th><th class="n">Sales</th><th class="n">Total</th></tr></thead><tbody>' +
      (dk.length ? dk.map(function (d) { return '<tr><td>' + esc(d) + '</td><td class="n">' + days[d].n + '</td><td class="n">' + money(days[d].t) + '</td></tr>'; }).join('') : '<tr><td colspan="3" class="empty">No sales yet.</td></tr>') + '</tbody>';
    var tally = {};
    state.sales.forEach(function (s) { s.items.forEach(function (i) { tally[i.name] = tally[i.name] || { q: 0, t: 0 }; tally[i.name].q += i.qty; tally[i.name].t += i.qty * i.price; }); });
    var tk = Object.keys(tally).sort(function (a, b) { return tally[b].q - tally[a].q; }).slice(0, 8);
    $('topTable').innerHTML = '<thead><tr><th>Product</th><th class="n">Units</th><th class="n">Revenue</th></tr></thead><tbody>' +
      (tk.length ? tk.map(function (k) { return '<tr><td>' + esc(k) + '</td><td class="n">' + tally[k].q + '</td><td class="n">' + money(tally[k].t) + '</td></tr>'; }).join('') : '<tr><td colspan="3" class="empty">No sales yet.</td></tr>') + '</tbody>';
    $('logTable').innerHTML = '<thead><tr><th>Time</th><th>Type</th><th>Detail</th><th class="n">Value</th></tr></thead><tbody>' +
      (state.log.length ? state.log.slice(0, 30).map(function (l) {
        return '<tr><td>' + esc(new Date(l.time).toLocaleString()) + '</td><td>' + esc(l.type) + '</td><td>' + esc(l.text) + '</td><td class="n">' + (l.loss ? money(l.loss) : '') + '</td></tr>';
      }).join('') : '<tr><td colspan="4" class="empty">Nothing logged yet.</td></tr>') + '</tbody>';
  }

  // CSV export (guards against spreadsheet formula injection)
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function download(name, rows) {
    var csv = rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
    var url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    var a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 500);
  }

  // ---------- events ----------
  $('tabs').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) show(b.dataset.view); });
  $('posSearch').addEventListener('input', renderResults);
  $('posSearch').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var q = e.target.value.trim().toLowerCase(); if (!q) return;
    var exact = state.products.filter(function (p) { return p.sku.toLowerCase() === q; })[0];
    var hits = state.products.filter(function (p) { return p.name.toLowerCase().indexOf(q) > -1; });
    var pick = exact || (hits.length === 1 ? hits[0] : null);
    if (pick) { addToCart(pick.id); e.target.value = ''; renderResults(); }
    else toast(hits.length ? 'Several matches – tap the product.' : 'No product found.');
  });
  $('posResults').addEventListener('click', function (e) { var b = e.target.closest('[data-add]'); if (b) addToCart(b.dataset.add); });
  $('cartLines').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.dataset.inc) addToCart(b.dataset.inc);
    if (b.dataset.dec) {
      var l = cart.filter(function (x) { return x.id === b.dataset.dec; })[0];
      if (l && --l.qty <= 0) cart = cart.filter(function (x) { return x !== l; });
      renderCart();
    }
  });
  $('checkoutBtn').addEventListener('click', checkout);
  $('clearCartBtn').addEventListener('click', function () { cart = []; renderCart(); });
  $('rcptClose').addEventListener('click', function () { $('rcptDlg').close(); });
  $('rcptPrint').addEventListener('click', function () { window.print(); });

  $('invSearch').addEventListener('input', renderInventory);
  $('invFilter').addEventListener('change', renderInventory);
  $('addProductBtn').addEventListener('click', function () { openProduct(null); });
  $('invTable').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.dataset.edit) openProduct(b.dataset.edit);
    if (b.dataset.del) deleteProduct(b.dataset.del);
    if (b.dataset.restock) openRestock(b.dataset.restock);
  });
  $('prodForm').addEventListener('submit', saveProduct);
  $('prodCancel').addEventListener('click', function () { $('prodDlg').close(); });
  $('restockForm').addEventListener('submit', saveRestock);
  $('restockCancel').addEventListener('click', function () { $('restockDlg').close(); });

  $('alertsBody').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.dataset.writeoff) writeOff(b.dataset.writeoff);
    if (b.dataset.restock) openRestock(b.dataset.restock);
  });

  $('exportSales').addEventListener('click', function () {
    var rows = [['Receipt', 'Time', 'Payment', 'Item', 'Qty', 'Unit price', 'Line total']];
    state.sales.forEach(function (s) { s.items.forEach(function (i) { rows.push([s.id.slice(-6).toUpperCase(), s.time, s.method, i.name, i.qty, i.price, i.qty * i.price]); }); });
    download('sales.csv', rows);
  });
  $('exportStock').addEventListener('click', function () {
    var rows = [['Barcode', 'Name', 'Category', 'Cost', 'Price', 'Qty', 'Reorder level', 'Expiry']];
    state.products.forEach(function (p) { rows.push([p.sku, p.name, p.category, p.cost, p.price, p.qty, p.reorder, p.expiry || '']); });
    download('stock.csv', rows);
  });
  $('resetBtn').addEventListener('click', function () {
    if (!confirm('Erase all data and restore the demo products?')) return;
    state = seed(); cart = []; save(); render(); toast('Demo data restored.');
  });

  render();
})();
