// Why an app that is fine for you crawls for eighty people.
//
// Three shapes, measured on the same 50,000 rows, with the database's own
// query plan printed next to each so the reason is visible rather than claimed.
// Node 22+, no dependencies:   node bench.mjs
import { DatabaseSync } from 'node:sqlite';

const ORDERS = 50_000;
const CUSTOMERS = 5_000;
const PAGE = 200;            // one screen of a list view
const REPEATS = 7;           // median of this many timed runs

const db = new DatabaseSync(':memory:');
const ms = (f) => { const t = process.hrtime.bigint(); const out = f(); return [Number(process.hrtime.bigint() - t) / 1e6, out]; };
const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
const time = (label, f) => {
  const runs = [];
  let out;
  for (let i = 0; i < REPEATS; i++) { const [t, o] = ms(f); runs.push(t); out = o; }
  return { label, ms: median(runs), rows: Array.isArray(out) ? out.length : out };
};
const plan = (sql, params = []) =>
  db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((r) => r.detail).join(' / ');

// ---------- seed ----------
db.exec(`
  CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, city TEXT);
  CREATE TABLE orders (
    id INTEGER PRIMARY KEY, customer_id INTEGER, status TEXT,
    total_cents INTEGER, created_at INTEGER, notes TEXT
  );
`);
const insC = db.prepare('INSERT INTO customers (id, name, city) VALUES (?, ?, ?)');
const insO = db.prepare('INSERT INTO orders (id, customer_id, status, total_cents, created_at, notes) VALUES (?, ?, ?, ?, ?, ?)');
const CITIES = ['Lisbon', 'Porto', 'Braga', 'Faro', 'Coimbra'];
const STATUS = ['paid', 'pending', 'refunded', 'cancelled'];
const padding = 'x'.repeat(300);   // a realistic row, not three integers

db.exec('BEGIN');
for (let i = 1; i <= CUSTOMERS; i++) insC.run(i, `Customer ${i}`, CITIES[i % CITIES.length]);
for (let i = 1; i <= ORDERS; i++) {
  insO.run(i, (i % CUSTOMERS) + 1, STATUS[i % STATUS.length], (i * 37) % 90_000,
    1_760_000_000 - (i * 60), `${padding} ${i}`);
}
db.exec('COMMIT');

const results = [];
const show = (r, note) => { results.push({ ...r, note }); };

// ---------- 1. the same filter, with and without an index ----------
const FILTER = `SELECT id, total_cents, created_at FROM orders
                WHERE status = ? AND created_at > ? ORDER BY created_at DESC LIMIT ${PAGE}`;
const args = ['paid', 1_760_000_000 - ORDERS * 60];

const planBefore = plan(FILTER, args);
show(time('filter + sort, no index', () => db.prepare(FILTER).all(...args)), planBefore);

db.exec('CREATE INDEX idx_orders_status_created ON orders (status, created_at DESC)');
const planAfter = plan(FILTER, args);
show(time('filter + sort, with index', () => db.prepare(FILTER).all(...args)), planAfter);

// ---------- 2. N+1 versus one query ----------
const page = db.prepare(`SELECT id, customer_id FROM orders WHERE status = 'paid'
                         ORDER BY created_at DESC LIMIT ${PAGE}`).all();
const one = db.prepare('SELECT id, name FROM customers WHERE id = ?');

show(time(`N+1: 1 + ${PAGE} queries`, () => {
  const rows = db.prepare(`SELECT id, customer_id FROM orders WHERE status = 'paid'
                           ORDER BY created_at DESC LIMIT ${PAGE}`).all();
  return rows.map((r) => one.get(r.customer_id));
}), `${PAGE + 1} statements executed`);

const ids = [...new Set(page.map((r) => r.customer_id))];
const inSql = `SELECT id, name FROM customers WHERE id IN (${ids.map(() => '?').join(',')})`;
show(time('the same data, 2 queries', () => {
  const rows = db.prepare(`SELECT id, customer_id FROM orders WHERE status = 'paid'
                           ORDER BY created_at DESC LIMIT ${PAGE}`).all();
  db.prepare(inSql).all(...ids);
  return rows;
}), `2 statements, ${ids.length} ids in one IN`);

// ---------- 3. SELECT * versus the columns you draw ----------
const starSql = `SELECT * FROM orders WHERE status = 'paid' ORDER BY created_at DESC LIMIT ${PAGE}`;
const leanSql = `SELECT id, total_cents FROM orders WHERE status = 'paid' ORDER BY created_at DESC LIMIT ${PAGE}`;
const bytes = (rows) => Buffer.byteLength(JSON.stringify(rows));
show(time('SELECT *', () => db.prepare(starSql).all()), `${bytes(db.prepare(starSql).all()).toLocaleString()} bytes of JSON`);
show(time('only the columns drawn', () => db.prepare(leanSql).all()), `${bytes(db.prepare(leanSql).all()).toLocaleString()} bytes of JSON`);

// ---------- 4. the same N+1, once the database is on the other end of a network ----------
// In-process the two shapes above are indistinguishable. That is the trap: the cost of
// N+1 is not the query, it is the round trip — which is zero on a laptop and is not zero
// in production. So measure a real round trip, verify the arithmetic on a small run,
// then project it to a full page.
const ENDPOINT = process.env.ENDPOINT ?? 'https://parseapi.back4app.com/';
const SAMPLES = 15;
const PROBE = 25;
let network = null;

if (process.env.SKIP_NETWORK !== '1') {
  const once = async () => { const s = performance.now(); await fetch(ENDPOINT).catch(() => {}); return performance.now() - s; };
  await once();                                  // warm the connection and the TLS handshake
  const rtts = [];
  for (let i = 0; i < SAMPLES; i++) rtts.push(await once());
  const rtt = median(rtts);

  const probeStart = performance.now();
  for (let i = 0; i < PROBE + 1; i++) await once();
  const probed = performance.now() - probeStart;
  const predicted = (PROBE + 1) * rtt;

  network = {
    rtt,
    probed,
    predicted,
    error: Math.abs(probed - predicted) / predicted,
    nPlusOne: (PAGE + 1) * rtt,
    twoQueries: 2 * rtt,
  };
}

// ---------- report ----------
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
console.log(`\n  ${ORDERS.toLocaleString()} orders · ${CUSTOMERS.toLocaleString()} customers · one page = ${PAGE} rows · median of ${REPEATS} runs\n`);
for (const r of results) console.log(`  ${pad(r.label, 26)} ${padL(r.ms.toFixed(2), 9)} ms   ${r.note}`);

const by = (l) => results.find((r) => r.label === l).ms;
console.log(`\n  index:   ${(by('filter + sort, no index') / by('filter + sort, with index')).toFixed(0)}x faster`);
console.log(`  N+1:     ${(by(`N+1: 1 + ${PAGE} queries`) / by('the same data, 2 queries')).toFixed(0)}x slower than two queries`);
console.log(`\n  query plan before the index:  ${planBefore}`);
console.log(`  query plan after the index:   ${planAfter}`);

if (network) {
  const s = (x) => `${(x / 1000).toFixed(2)} s`;
  console.log(`\n  once the database is across a network — ${ENDPOINT}`);
  console.log(`    round trip, warm connection   ${network.rtt.toFixed(1)} ms   (median of ${SAMPLES})`);
  console.log(`    ${PROBE + 1} round trips, measured      ${s(network.probed)}   (predicted ${s(network.predicted)}, off by ${(network.error * 100).toFixed(1)}%)`);
  console.log(`    ${PAGE + 1} round trips, projected    ${s(network.nPlusOne)}   ← the N+1 page`);
  console.log(`    2 round trips                 ${s(network.twoQueries)}   ← the same page, two queries`);
  console.log(`\n  N+1 over a network: ${(network.nPlusOne / network.twoQueries).toFixed(0)}x slower. In process, it was ${(by(`N+1: 1 + ${PAGE} queries`) / by('the same data, 2 queries')).toFixed(0)}x.\n`);
} else {
  console.log('');
}
