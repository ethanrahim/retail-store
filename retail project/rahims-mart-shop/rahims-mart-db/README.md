# Rahim's Mart: shop system with a database

A small supermarket system for stock, sales and records. It is a Node.js web server with a SQLite database file and a plain HTML, CSS and JavaScript front end. There is nothing to install except Node.js.

## Run it

1. Install Node.js **22.5 or newer** (https://nodejs.org).
2. Open a terminal in this folder and run:

```
node server.js
```

3. Open **http://localhost:3000** in a browser.

The first time it runs it creates the database file `data/shop.db`, loads demo products, and creates an administrator account. The username is `admin` and a random password is printed in the terminal once. You must change that password when you first sign in. To choose your own first password, run `ADMIN_PASSWORD=YourPassword123 node server.js` (on Windows PowerShell: `$env:ADMIN_PASSWORD="YourPassword123"; node server.js`).

To start again with an empty shop, stop the server and delete the `data` folder.

Settings (environment variables): `PORT` (default 3000), `HOST` (default `127.0.0.1`, this computer only), `DB_FILE` (database path), `NO_DEMO=1` (do not load demo products).

## Run it in VS Code

1. Install Node.js 22.5 or newer, then in VS Code choose **File > Open Folder** and open this folder.
2. Press **F5** (or open the terminal with Ctrl+` and type `npm start`).
3. Open http://localhost:3000. The first-run administrator password appears in the VS Code terminal.

Do not use the Live Server extension or open `index.html` directly: the screens need `server.js` running because that is what talks to the database.

## Who can do what

| Function | Cashier | Administrator |
| --- | --- | --- |
| Sign in, sign out, change own password | Yes | Yes |
| Sell, print receipts, see stock and alerts | Yes (cost prices hidden) | Yes |
| Add, edit, delete products; restock; stock-take; write off | No | Yes |
| Suppliers and purchase records | No | Yes |
| Records check, stock ledger, audit log | No | Yes |
| Reports, exports, database backup | No | Yes |
| Create users, reset passwords, disable users | No | Yes |

## What the database keeps

| Table | Holds |
| --- | --- |
| users, sessions | Accounts (passwords stored only as scrypt hashes) and sign-ins |
| suppliers | Supplier names and phone numbers |
| products | Barcode, name, category, cost, price, quantity, reorder level, expiry, usual supplier |
| purchases | Every delivery: product, supplier, quantity, unit cost, total, who recorded it |
| sales, sale_items | Every receipt and its lines, with the price and cost at the time of sale |
| movements | **Stock ledger.** Every change to a quantity (opening, sale, restock, write-off, adjustment) with who and why |
| events | Lost sales, sold-out items, write-offs and stock-take shortages with their value |
| audit | Who did what and when: sign-ins, failed sign-ins, changes to products, users and stock |

The schema diagram is in `docs/database-schema.png`.

## Checking records

Three ways the system checks that its records are true:

1. **Records check** (Records screen, administrators). It compares records against each other and reports anything that disagrees: stock quantity against the stock ledger, each sale total against its lines, each sold item against a stock movement, each purchase against its restock movement, the database file's own integrity check, plus warnings for expired stock, prices below cost, zero prices and duplicate products. If a quantity and the ledger disagree, **Fix: record adjustments** records an adjustment so they match.
2. **Stock-take** (Stock screen, Count button). Enter what you physically counted. The difference is corrected in the ledger, logged as an adjustment, and a shortage is recorded as a loss on the Reports screen.
3. **Rules inside the database.** Quantities, prices and costs cannot be negative; barcodes and usernames are unique; every sale, purchase and movement must point to a real product; a sale either saves completely or not at all.

## Protection

- Passwords are hashed with scrypt and a random salt. Minimum length 8.
- Five wrong passwords lock a username and address for five minutes.
- Sessions use a random token in a `HttpOnly`, `SameSite=Strict` cookie and last 8 hours.
- The server decides prices, checks stock and expiry, and ignores prices sent by the browser.
- Only administrators can reach administrator functions; the server checks this on every request.
- The server only listens on this computer unless `HOST=0.0.0.0` is set. The connection is plain HTTP, so if other devices on the shop network use it, put it behind HTTPS (for example a reverse proxy) and set `COOKIE_SECURE=1`.
- A backup copy of the database is made when the server starts and then every 24 hours in `data/backups` (the newest 14 are kept). Administrators can also download a backup from the Reports screen, where **Reset to demo data** erases the shop's records (it asks you to type RESET and makes a backup first).

There is no password recovery by email. An administrator resets another user's password (the user must change it at the next sign in). If the only administrator forgets their password, stop the server and delete `data/shop.db` to start again, or restore from a backup.

## Tests

```
npm test
```

This starts the real server on a temporary database and runs 23 checks over HTTP, including changing a record directly in the database file to prove the records check finds it. The results, written as a module test table for a project report, are in `docs/TEST_RESULTS.md`.

## Files

| File | Purpose |
| --- | --- |
| `server.js` | Web server, routes, sign-in, sessions, backups |
| `store.js` | Business rules and every database operation |
| `db.js` | Opens the database and creates the tables |
| `public/` | The pages: `index.html`, `style.css`, `app.js` |
| `test/api.test.js` | Automated tests |
| `docs/` | Schema diagram and test results |

## Tools used (for the report)

- **Node.js** runs the server. It is a JavaScript runtime, used here to serve pages and the JSON API and to talk to the database.
- **SQLite** (through Node's built-in `node:sqlite` module) stores all records in one file, `data/shop.db`. It was chosen over a separate database server such as MySQL because a single-shop system needs no extra software to install, run or secure, and a backup is a file copy.
- **HTML, CSS and JavaScript** build the screens in the browser; no front-end framework is used.
- **Playwright** was used to check the screens in a browser during development; it is not needed to run the system.

## Suggested computer requirements

Any computer or laptop that can run Node.js 22.5 or newer (Windows, macOS or Linux), about 2 GB of RAM and 500 MB of free disk space, and a current version of Chrome, Edge or Firefox. The database file stays small for a single shop; check the size of `data/shop.db` after a few months of trading.
