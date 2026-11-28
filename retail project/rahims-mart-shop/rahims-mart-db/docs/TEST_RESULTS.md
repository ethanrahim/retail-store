# Test results

Run on 28 November 2026 with `npm test`: **23 tests, 23 passed, 0 failed.** Each test starts the real server on a temporary database and calls it over HTTP. The tables follow the layout used in the project report (module, test carried out, result of the test).

## Functional requirements

| Module | Test carried out | Result of the test |
| --- | --- | --- |
| Login | Sign in with a wrong password | Refused with "Wrong username or password" |
| Login | Sign in with the correct password | Accepted; role administrator |
| Login | Five wrong passwords in a row | Account locked for five minutes (error 429) |
| Logout | Use the session after logging out | Refused (error 401); must sign in again |
| Access control | Request with no login | Refused (error 401) |
| Access control | Change request without the shop header | Refused (error 403) |
| Users | Create a user with a short password | Refused: password must be 8 to 100 characters |
| Users | Create a user whose name differs only in letter case | Refused: username already taken |
| Users | New cashier signs in for the first time | Must change the temporary password before anything else |
| Users | Disable the only active administrator | Refused: there must be at least one active administrator |
| Users | Disable a cashier who is signed in | Cashier is signed out and cannot sign in again |
| Roles | Cashier opens users, checks, audit, suppliers, backup, sales list, adds a product | All refused (error 403); cost prices not shown to cashier |
| Sales | Sell 2 x Sugar 1kg at KES 165 | Receipt total KES 330; stock 25 to 23; ledger shows a sale of -2 |
| Sales | Send a changed price in the request | Server price used; total unchanged |
| Sales | Sell more than the stock; sell an expired item; sell an empty cart | Refused: "Only N in stock"; "expired and cannot be sold"; cart must hold 1 to 100 lines |
| Sales | Two-line sale where the second line is more than the stock | Refused; stock of both items unchanged (all or nothing) |
| Lost sale | Ask twice for an out-of-stock item | One lost sale recorded, not two |
| Restock | Receive 48 x Soda 500ml at KES 44 from a supplier | Purchase of KES 2,112 recorded with the supplier; stock 0 to 48 |
| Stock-take | Count 3 fewer Cooking Oil than the system shows | Stock corrected; adjustment in ledger; loss KES 780 recorded |
| Stock-take | Count equal to the system quantity | "Matches"; no change |
| Write-off | Write off 8 expired Yoghurt at cost KES 55 | Stock 0; loss KES 440 recorded |
| Products | Add a product with an existing barcode; add one priced below cost | Both refused |
| Audit | Review the audit log after the tests | Sign-ins, failed sign-ins, user creation, restock, stock-take, write-off and ledger reconciliation all recorded with the user |
| Backup | Download a backup as administrator | A valid SQLite database file |

## Records check

| Module | Test carried out | Result of the test |
| --- | --- | --- |
| Records check | Run after normal selling, restocking and counting | 0 problems |
| Records check | Change a product quantity (+5) directly in the database file | Problem found: "Sugar 1kg: shows N but movements add up to N-5" |
| Records check | Use "Fix: record adjustments" | One adjustment recorded; ledger agrees; check passes |
| Records check | Change a sale total (+10) directly in the database file | Problem found: sale total does not equal its lines (not fixable automatically) |

## Non-functional requirements

| Requirement | Test carried out | Result of the test |
| --- | --- | --- |
| Security | Passwords, sessions, cross-site requests, folder access | Passwords stored as hashes; sessions end on logout; requests without the shop header refused; `/server.js` and `/../` paths return 404 |
| Reliability | A sale that fails part-way | Nothing is saved (all or nothing) |
| Reliability | Database health | Integrity and foreign-key checks run inside the records check |
| Portability | Screens at a phone width of 390 pixels (Dashboard, Sell, Stock, Records) | No sideways scrolling |

Not yet tested: usability with real cashiers, and performance with a large number of sales. These need to be done on the shop's own computer before the system is relied on.

## How the tests were run

```
npm test
```
