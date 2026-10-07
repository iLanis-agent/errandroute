/* ErrandRoute tests: oracle cases (python brute force), engine semantics,
   heuristic properties, validation, escaping. Run: node tests/run_tests.js */
'use strict';
const E = require('../engine.js');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL:', msg); }
}
function close(a, b, tol, msg) { ok(Math.abs(a - b) <= tol, msg + ` (${a} vs ${b})`); }
function throwsWith(fn, needle, msg) {
  try { fn(); failed++; console.error('FAIL (no throw):', msg); }
  catch (e) { ok(e.message.includes(needle), msg + ` (threw "${e.message}")`); }
}

// ---------- 1. Oracle cases: JS exact solver vs independent python brute force ----------
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'expected.json'), 'utf8'));
for (const c of cases) {
  const p = E.plan(c.raw);
  const exp = c.expected;
  ok(p.method === 'exact', `${c.id}: method exact (got ${p.method})`);
  ok(JSON.stringify(p.order) === JSON.stringify(exp.order),
     `${c.id}: order ${JSON.stringify(p.order)} == ${JSON.stringify(exp.order)}`);
  close(p.result.totalLate, exp.totalLate, 1e-9, `${c.id}: totalLate`);
  close(p.result.totalDrive, exp.totalDrive, 1e-9, `${c.id}: totalDrive`);
  ok(p.result.feasible === exp.feasible, `${c.id}: feasible flag`);
  // asListed baseline is the identity order evaluated
  close(p.asListed.totalDrive, E.evalOrder(c.raw.stops.map((_, i) => i), E.normalize(c.raw)).totalDrive, 1e-12,
        `${c.id}: asListed matches identity eval`);
}

// ---------- 2. Timing semantics ----------
{
  const inp = E.normalize({ depart: '08:00', home: { x: 0, y: 0 }, circuity: 1, speedMph: 60,
    stops: [{ name: 'waiter', x: 1, y: 0, service: 10, earliest: '09:00', latest: '09:30' }] });
  const ev = E.evalOrder([0], inp);
  close(ev.schedule[0].arrive, 481, 1e-9, 'arrive = depart(480) + 1 mile at 60mph');
  close(ev.schedule[0].begin, 540, 1e-9, 'begin waits for earliest 09:00');
  close(ev.schedule[0].late, 0, 1e-9, 'no lateness when waiting satisfies window');
  close(ev.schedule[0].depart, 550, 1e-9, 'depart = begin + service');
}
{
  const inp = E.normalize({ depart: '09:00', home: { x: 0, y: 0 }, circuity: 1, speedMph: 60,
    stops: [{ name: 'late', x: 1, y: 0, service: 5, latest: '09:00' }] });
  const ev = E.evalOrder([0], inp);
  close(ev.schedule[0].late, 1, 1e-9, 'late = begin - latest when arrive 09:01, closes 09:00');
  ok(!ev.feasible, 'feasible false when late');
}
{
  // 3-4-5 triangle drive times with circuity 1 at 30mph: 3mi=6min, 4mi=8min, 5mi=10min
  const M = E.gridDriveMatrix([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 4 }], 1, 30);
  close(M[0][1], 6, 1e-12, 'triangle leg 3mi');
  close(M[1][2], 8, 1e-12, 'triangle leg 4mi');
  close(M[0][2], 10, 1e-12, 'triangle hypotenuse 5mi');
  close(M[1][0], 6, 1e-12, 'symmetric in grid mode');
}

// ---------- 3. One-way matrix trap: engine must respect asymmetry ----------
{
  const raw = { mode: 'matrix', depart: '09:00', returnHome: true,
    stops: [{ name: 'A', service: 0 }, { name: 'B', service: 0 }],
    matrix: [[0, 1, 100], [100, 0, 1], [1, 100, 0]] };
  const p = E.plan(raw);
  // home->A(1) A->B(1) B->home(1) = 3 beats home->B(100) ...
  ok(JSON.stringify(p.order) === JSON.stringify([0, 1]), 'asymmetric matrix forces A then B');
  close(p.result.totalDrive, 3, 1e-9, 'asymmetric total drive');
}

// ---------- 4. Heuristic properties (n > 8) ----------
function lcg(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
function randRaw(seed, n) {
  const rnd = lcg(seed), stops = [];
  for (let i = 0; i < n; i++) {
    const st = { name: 's' + i, x: +(rnd() * 20 - 10).toFixed(3), y: +(rnd() * 20 - 10).toFixed(3),
                 service: [5, 10, 20, 30][Math.floor(rnd() * 4)] };
    if (rnd() < 0.3) st.latest = '1' + Math.floor(rnd() * 9) + ':' + (rnd() < 0.5 ? '00' : '30');
    stops.push(st);
  }
  return { depart: '08:30', home: { x: 0, y: 0 }, returnHome: rnd() < 0.5, stops };
}
for (let k = 0; k < 14; k++) {
  const n = 9 + (k % 7) * 4; // 9..33
  const raw = randRaw(1000 + k * 77, n);
  const inp = E.normalize(raw);
  const h1 = E.heuristicOrder(inp), h2 = E.heuristicOrder(inp);
  ok(JSON.stringify(h1.order) === JSON.stringify(h2.order), `heur-${k}: deterministic`);
  ok(new Set(h1.order).size === n && h1.order.every(v => v >= 0 && v < n), `heur-${k}: valid permutation`);
  const nn = E.evalOrder(E.nnOrder(inp), inp);
  ok((h1.result.totalLate < nn.totalLate - 1e-9) ||
     (Math.abs(h1.result.totalLate - nn.totalLate) <= 1e-9 && h1.result.totalDrive <= nn.totalDrive + 1e-9),
     `heur-${k}: 2-opt never worse than nearest-neighbour`);
  const recheck = E.evalOrder(h1.order, inp);
  close(recheck.totalDrive, h1.result.totalDrive, 1e-9, `heur-${k}: result matches re-eval`);
  // 2-opt local optimality: sample 250 segment reversals, none strictly better
  const rnd = lcg(555 + k);
  let localOpt = true;
  for (let t = 0; t < 250; t++) {
    const i = Math.floor(rnd() * (n - 1)), j = i + 2 + Math.floor(rnd() * (n - i - 2));
    if (j >= n) continue;
    const cand = h1.order.slice(0, i).concat(h1.order.slice(i, j + 1).reverse(), h1.order.slice(j + 1));
    const ev = E.evalOrder(cand, inp);
    const better = (Math.abs(ev.totalLate - h1.result.totalLate) > 1e-9)
      ? ev.totalLate < h1.result.totalLate
      : ev.totalDrive < h1.result.totalDrive - 1e-9;
    if (better) { localOpt = false; break; }
  }
  ok(localOpt, `heur-${k}: locally 2-opt optimal`);
}
// heuristic beats/equal brute force sanity on n=9,10 against python-checked exhaustive? Exact caps at 8;
// instead: heuristic on n<=8 must equal exact order cost (not necessarily same order on ties)
for (const c of cases.filter(c => c.raw.stops.length <= 8)) {
  const inp = E.normalize(c.raw);
  const h = E.heuristicOrder(inp);
  close(h.result.totalLate, c.expected.totalLate, 1e-9, `heur-matches-exact late ${c.id}`);
  close(h.result.totalDrive, c.expected.totalDrive, 1e-9, `heur-matches-exact drive ${c.id}`);
}

// ---------- 5. Validation ----------
throwsWith(() => E.plan(null), 'Missing input', 'null input');
throwsWith(() => E.plan({ depart: '09:00', stops: [] }), 'at least one stop', 'no stops');
throwsWith(() => E.plan({ depart: '9:99', stops: [{ name: 'a', x: 1, y: 1 }] }), 'Bad time', 'bad depart minutes');
throwsWith(() => E.plan({ depart: '25:00', stops: [{ name: 'a', x: 1, y: 1 }] }), 'Hours run 00-23', 'hour 25');
throwsWith(() => E.plan({ stops: [{ name: 'a', x: 1, y: 1 }] }), 'departure time', 'missing depart');
throwsWith(() => E.plan({ depart: '09:00', home: { x: 0, y: 0 }, stops: [{ name: '', x: 1, y: 1 }] }), 'needs a name', 'empty name');
throwsWith(() => E.plan({ depart: '09:00', home: { x: 0, y: 0 }, stops: [{ name: 'a', x: 'far', y: 1 }] }), 'must be a number', 'non-numeric x');
throwsWith(() => E.plan({ depart: '09:00', home: { x: 0, y: 0 }, stops: [{ name: 'a', x: 5000, y: 1 }] }), 'between -1000 and 1000', 'x out of range');
throwsWith(() => E.plan({ depart: '09:00', home: { x: 0, y: 0 }, stops: [{ name: 'a', x: 1, y: 1, service: 9999 }] }), 'between 0 and 600', 'service too big');
throwsWith(() => E.plan({ depart: '09:00', home: { x: 0, y: 0 }, stops: [{ name: 'a', x: 1, y: 1, earliest: '12:00', latest: '09:00' }] }),
  'opens after it closes', 'earliest after latest');
throwsWith(() => E.plan({ depart: '09:00', speedMph: 500, stops: [{ name: 'a', x: 1, y: 1 }] }), 'Average speed', 'speed out of range');
throwsWith(() => E.plan({ depart: '09:00', circuity: 0.5, stops: [{ name: 'a', x: 1, y: 1 }] }), 'Circuity factor', 'circuity below 1');
throwsWith(() => E.plan({ mode: 'matrix', depart: '09:00', stops: [{ name: 'a' }, { name: 'b' }], matrix: [[0, 1, 2]] }),
  'needs 3 rows', 'matrix wrong row count');
throwsWith(() => E.plan({ mode: 'matrix', depart: '09:00', stops: [{ name: 'a' }],
  matrix: [[0, -5], [3, 0]] }), 'between 0 and 600', 'negative matrix entry');
throwsWith(() => E.plan({ depart: '09:00', home: { x: 0, y: 0 },
  stops: [{ name: 'x'.repeat(81), y: 1, x: 1 }] }), 'too long', 'name too long');
ok(E.exactOrder.length !== 0 && (() => {
  try { E.exactOrder(E.normalize(randRaw(1, 9))); return false; } catch (e) { return e.message.includes('up to 8'); }
})(), 'exactOrder refuses n=9');

// ---------- 6. parseHM / fmtHM / esc ----------
ok(E.parseHM('') === null && E.parseHM(null) === null && E.parseHM('  ') === null, 'parseHM empty -> null');
ok(E.parseHM('0:00') === 0 && E.parseHM('23:59') === 1439 && E.parseHM(' 09:30 ') === 570, 'parseHM values');
throwsWith(() => E.parseHM('9:5'), 'Bad time', 'parseHM one-digit minute');
throwsWith(() => E.parseHM('noon'), 'Bad time', 'parseHM junk');
ok(E.fmtHM(0) === '00:00' && E.fmtHM(570) === '09:30' && E.fmtHM(1439) === '23:59', 'fmtHM basics');
ok(E.fmtHM(1440 + 75) === '01:15' && E.fmtHM(-30) === '23:30', 'fmtHM wraps past midnight');
ok(E.esc('<script>alert("x")</script>') === '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;', 'esc script tag');
ok(E.esc("it's & \"that\"") === 'it&#39;s &amp; &quot;that&quot;', 'esc ampersand and quotes');
ok(E.esc(42) === '42', 'esc coerces numbers');
// HTML-shaped stop name must survive planning as plain text
{
  const p = E.plan({ depart: '09:00', home: { x: 0, y: 0 },
    stops: [{ name: '<img src=x onerror=alert(1)>', x: 1, y: 1, service: 5 }] });
  ok(p.input.stops[0].name === '<img src=x onerror=alert(1)>', 'name preserved raw; escaping happens at render');
  ok(E.esc(p.input.stops[0].name).indexOf('<') === -1, 'escaped render has no angle brackets');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
