'use strict';
/* Database layer: opens the SQLite file and creates the tables.
   Uses Node's built-in SQLite module (Node 22.5 or newer), so nothing needs installing. */
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name   TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('admin','cashier')),
  salt        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS suppliers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT,
  notes      TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  sku         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'General',
  cost        REAL NOT NULL CHECK (cost >= 0),
  price       REAL NOT NULL CHECK (price >= 0),
  qty         INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  reorder     INTEGER NOT NULL DEFAULT 0 CHECK (reorder >= 0),
  expiry      TEXT,
  supplier_id TEXT REFERENCES suppliers(id),
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS purchases (
  id           TEXT PRIMARY KEY,
  time         TEXT NOT NULL,
  product_id   TEXT NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  supplier_id  TEXT REFERENCES suppliers(id),
  qty          INTEGER NOT NULL CHECK (qty > 0),
  unit_cost    REAL NOT NULL CHECK (unit_cost >= 0),
  total        REAL NOT NULL,
  user_id      TEXT REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS sales (
  id      TEXT PRIMARY KEY,
  time    TEXT NOT NULL,
  total   REAL NOT NULL,
  method  TEXT NOT NULL CHECK (method IN ('Cash','M-Pesa','Card')),
  user_id TEXT REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS sale_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id    TEXT NOT NULL REFERENCES sales(id),
  product_id TEXT REFERENCES products(id),
  name       TEXT NOT NULL,
  qty        INTEGER NOT NULL CHECK (qty > 0),
  price      REAL NOT NULL,
  cost       REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS movements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  time       TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  type       TEXT NOT NULL CHECK (type IN ('opening','sale','restock','writeoff','adjust')),
  qty_change INTEGER NOT NULL,
  ref        TEXT,
  note       TEXT,
  user_id    TEXT REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  time    TEXT NOT NULL,
  type    TEXT NOT NULL,
  text    TEXT NOT NULL,
  loss    REAL NOT NULL DEFAULT 0,
  user_id TEXT
);
CREATE TABLE IF NOT EXISTS audit (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  time     TEXT NOT NULL,
  user_id  TEXT,
  username TEXT,
  action   TEXT NOT NULL,
  detail   TEXT
);
CREATE INDEX IF NOT EXISTS idx_movements_product ON movements(product_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale   ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sales_time        ON sales(time);
CREATE INDEX IF NOT EXISTS idx_audit_time        ON audit(time);
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/** Run fn inside one transaction: everything is saved, or nothing is. */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (e) { /* already rolled back */ }
    throw err;
  }
}

function uid() { return crypto.randomBytes(8).toString('hex'); }
function nowIso() { return new Date().toISOString(); }
function pad(n) { return n < 10 ? '0' + n : String(n); }
function dateStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function todayStr() { return dateStr(new Date()); }
function addDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return dateStr(d); }

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const test = crypto.scryptSync(password, salt, 64);
  const real = Buffer.from(hash, 'hex');
  return test.length === real.length && crypto.timingSafeEqual(test, real);
}

module.exports = { openDb, tx, uid, nowIso, todayStr, addDays, hashPassword, verifyPassword };
