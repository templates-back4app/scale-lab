# scale-lab

[![Deploy on Back4app](https://img.shields.io/badge/Deploy%20on-Back4app-1568B8?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0iI2ZmZiIgZD0iTTEyIDJMMiA3djEwbDEwIDUgMTAtNVY3eiIvPjwvc3ZnPg==)](https://www.back4app.com/signup?utm_source=github&utm_medium=repo&utm_campaign=scale-lab)

**Why an app that is instant for you crawls for eighty people — measured, with the database's own query plan as the evidence.** One file, no dependencies, Node 22+.

Measured on 27 October 2026 against 50,000 orders: a missing index costs **30×**, and a query-per-row loop costs **101×** once the database is across a network — while on one machine the same loop is **indistinguishable** from the fast version.

> **Read the article:** [Why Your App Gets Slow With Only 80 Users: a Missing Index and an N+1 Loop, Measured](https://www.back4app.com/blog/why-your-app-gets-slow-with-80-users?utm_source=github&utm_medium=repo&utm_campaign=scale-lab)

## Run it

```bash
node bench.mjs
```

Node 22 or newer — it uses the built-in `node:sqlite` and `fetch`. `SKIP_NETWORK=1` leaves out the round-trip section; `ENDPOINT=https://…` points it at a different host.

## What it measures

```
  50,000 orders · 5,000 customers · one page = 200 rows · median of 7 runs

  filter + sort, no index         2.95 ms   SCAN orders / USE TEMP B-TREE FOR ORDER BY
  filter + sort, with index       0.08 ms   SEARCH orders USING INDEX idx_orders_status_created
  N+1: 1 + 200 queries            0.22 ms   201 statements executed
  the same data, 2 queries        0.18 ms   2 statements, 200 ids in one IN
  SELECT *                        0.13 ms   80,650 bytes of JSON
  only the columns drawn          0.06 ms   6,102 bytes of JSON

  index:   30x faster
  N+1:     1x slower than two queries

  once the database is across a network — https://parseapi.back4app.com/
    round trip, warm connection   150.0 ms   (median of 15)
    26 round trips, measured      3.94 s   (predicted 3.90 s, off by 1.1%)
    201 round trips, projected    30.16 s   ← the N+1 page
    2 round trips                 0.30 s   ← the same page, two queries

  N+1 over a network: 101x slower. In process, it was 1x.
```

## The three findings

**1. The index is worth 30×, and the plan says why.** `SCAN orders` means the whole table was read to return 200 rows. After one `CREATE INDEX` the plan reads `SEARCH orders USING INDEX`. The index covers `status` then `created_at`, the order the query uses them in.

**2. N+1 is free in process and ruinous over a network.** 201 statements against 2 measured 0.22 ms against 0.18 ms on one machine — no signal at all. The cost is not computation, it is the round trip, and a laptop does not have one. With a measured 150 ms round trip the same page is 30.16 s against 0.30 s.

The projection is checked rather than assumed: a real run of 26 sequential round trips took 3.94 s against a predicted 3.90 s, off by 1.1%.

**3. `SELECT *` is a bandwidth bill.** The same 200 rows are 80,650 bytes with every column and 6,102 bytes with the two a list view draws — about 13×, paid per request, per user, and again on a weak connection.

## Why SQLite

Because the shapes are not SQLite's. A full scan and a round trip per row cost the same kind of thing in every engine, and running in memory with no server removes every variable except the one being measured. The numbers to carry away are the **ratios** and the **query plans**, not the milliseconds.

## Deploy your own

1. **Create a free account.** Sign up at [https://www.back4app.com/signup?utm_source=github&utm_medium=repo&utm_campaign=scale-lab](https://www.back4app.com/signup?utm_source=github&utm_medium=repo&utm_campaign=scale-lab).
2. **Build on a managed database**, so growth is a plan change rather than a migration — the servers, the patching and the connection limits are operated for you.
3. **Keep the query shape yours.** No platform can fix a loop that asks 201 times; only your code knows what the screen needs.

Documentation: [https://www.back4app.com/docs?utm_source=github&utm_medium=repo&utm_campaign=scale-lab](https://www.back4app.com/docs?utm_source=github&utm_medium=repo&utm_campaign=scale-lab).

## License

MIT.
