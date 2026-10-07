/* ErrandRoute engine: pick the order for a day of errands so nothing closes before you get there.
   Pure functions, no DOM. Used by app.html (browser) and tests/run_tests.js (node). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ErrandRoute = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LATE_WEIGHT = 10000; // one late minute outranks any plausible drive saving

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function parseHM(s) {
    if (s === null || s === undefined || String(s).trim() === '') return null;
    var m = /^(\d{1,2}):([0-5]\d)$/.exec(String(s).trim());
    if (!m) throw new Error('Bad time "' + s + '". Use 24-hour HH:MM.');
    var h = +m[1];
    if (h > 23) throw new Error('Bad time "' + s + '". Hours run 00-23.');
    return h * 60 + (+m[2]);
  }

  function fmtHM(mins) {
    var m = ((Math.round(mins) % 1440) + 1440) % 1440;
    var h = Math.floor(m / 60), mm = m % 60;
    return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm;
  }

  function finiteNum(v, label, min, max) {
    var n = Number(v);
    if (!isFinite(n)) throw new Error(label + ' must be a number.');
    if (n < min || n > max) throw new Error(label + ' must be between ' + min + ' and ' + max + '.');
    return n;
  }

  function gridDriveMatrix(points, circuity, speedMph) {
    var n = points.length, M = [], i, j;
    for (i = 0; i < n; i++) {
      var row = [];
      for (j = 0; j < n; j++) {
        if (i === j) { row.push(0); continue; }
        var dx = points[i].x - points[j].x, dy = points[i].y - points[j].y;
        row.push(Math.sqrt(dx * dx + dy * dy) * circuity / speedMph * 60);
      }
      M.push(row);
    }
    return M;
  }

  function normalize(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('Missing input.');
    var stopsRaw = raw.stops;
    if (!Array.isArray(stopsRaw) || stopsRaw.length < 1) throw new Error('Add at least one stop.');
    if (stopsRaw.length > 60) throw new Error('Too many stops (max 60).');
    var mode = raw.mode === 'matrix' ? 'matrix' : 'grid';
    var circuity = 1.3, speedMph = 22;
    if (mode === 'grid') {
      circuity = finiteNum(raw.circuity === undefined ? 1.3 : raw.circuity, 'Circuity factor', 1, 2);
      speedMph = finiteNum(raw.speedMph === undefined ? 22 : raw.speedMph, 'Average speed', 3, 80);
    }
    var depart = parseHM(raw.depart);
    if (depart === null) throw new Error('Set a departure time (HH:MM).');
    var returnHome = !!raw.returnHome;

    var points = [{ x: 0, y: 0 }];
    if (mode === 'grid') {
      if (!raw.home || typeof raw.home !== 'object') throw new Error('Missing home position.');
      points[0] = {
        x: finiteNum(raw.home.x, 'Home x', -1000, 1000),
        y: finiteNum(raw.home.y, 'Home y', -1000, 1000)
      };
    }
    var stops = [], i, s;
    for (i = 0; i < stopsRaw.length; i++) {
      s = stopsRaw[i] || {};
      var name = String(s.name === undefined ? '' : s.name).trim();
      if (!name) throw new Error('Stop ' + (i + 1) + ' needs a name.');
      if (name.length > 80) throw new Error('Stop name too long (max 80 chars): "' + name.slice(0, 40) + '..."');
      var service = finiteNum(s.service === undefined ? 10 : s.service, 'Service minutes for "' + name + '"', 0, 600);
      var earliest = parseHM(s.earliest), latest = parseHM(s.latest);
      if (earliest !== null && latest !== null && earliest > latest)
        throw new Error('"' + name + '" opens after it closes. Check the times.');
      var st = { name: name, service: service, earliest: earliest, latest: latest };
      if (mode === 'grid') {
        st.x = finiteNum(s.x, 'x for "' + name + '"', -1000, 1000);
        st.y = finiteNum(s.y, 'y for "' + name + '"', -1000, 1000);
        points.push({ x: st.x, y: st.y });
      }
      stops.push(st);
    }

    var drive;
    if (mode === 'grid') {
      drive = gridDriveMatrix(points, circuity, speedMph);
    } else {
      var mtx = raw.matrix, n = stops.length + 1, j;
      if (!Array.isArray(mtx) || mtx.length !== n)
        throw new Error('Matrix mode needs ' + n + ' rows (home + ' + stops.length + ' stops).');
      drive = [];
      for (i = 0; i < n; i++) {
        if (!Array.isArray(mtx[i]) || mtx[i].length !== n)
          throw new Error('Matrix row ' + (i + 1) + ' must have ' + n + ' entries.');
        var r = [];
        for (j = 0; j < n; j++) {
          r.push(i === j ? 0 : finiteNum(mtx[i][j], 'Matrix entry [' + (i + 1) + '][' + (j + 1) + ']', 0, 600));
        }
        drive.push(r);
      }
    }

    return { mode: mode, stops: stops, depart: depart, returnHome: returnHome,
             drive: drive, circuity: circuity, speedMph: speedMph };
  }

  function evalOrder(order, inp) {
    var t = inp.depart, totalDrive = 0, totalLate = 0, cur = 0, k;
    var schedule = [];
    for (k = 0; k < order.length; k++) {
      var s = order[k], node = s + 1, st = inp.stops[s];
      var drive = inp.drive[cur][node];
      totalDrive += drive;
      var arrive = t + drive;
      var begin = st.earliest === null ? arrive : Math.max(arrive, st.earliest);
      var late = st.latest === null ? 0 : Math.max(0, begin - st.latest);
      totalLate += late;
      var departStop = begin + st.service;
      schedule.push({ stop: s, drive: drive, arrive: arrive, begin: begin, late: late, depart: departStop });
      t = departStop; cur = node;
    }
    var homeDrive = 0;
    if (inp.returnHome) { homeDrive = inp.drive[cur][0]; totalDrive += homeDrive; }
    return { totalDrive: totalDrive, totalLate: totalLate, homeDrive: homeDrive,
             finish: t + homeDrive, schedule: schedule, feasible: totalLate === 0 };
  }

  function isBetter(a, b) {
    if (a.totalLate !== b.totalLate) return a.totalLate < b.totalLate;
    return a.totalDrive < b.totalDrive;
  }

  /* Lexicographic next permutation: same enumeration order as python
     itertools.permutations over sorted input, so ties break identically. */
  function nextPerm(p) {
    var i = p.length - 2;
    while (i >= 0 && p[i] >= p[i + 1]) i--;
    if (i < 0) return false;
    var j = p.length - 1;
    while (p[j] <= p[i]) j--;
    var t = p[i]; p[i] = p[j]; p[j] = t;
    var a = i + 1, b = p.length - 1;
    while (a < b) { var u = p[a]; p[a] = p[b]; p[b] = u; a++; b--; }
    return true;
  }

  function exactOrder(inp) {
    var n = inp.stops.length;
    if (n > 8) throw new Error('Exact solver handles up to 8 stops; use heuristic.');
    var perm = [], i;
    for (i = 0; i < n; i++) perm.push(i);
    var best = null, bestPerm = null;
    do {
      var ev = evalOrder(perm, inp);
      if (best === null || isBetter(ev, best)) { best = ev; bestPerm = perm.slice(); }
    } while (nextPerm(perm));
    return { order: bestPerm, result: best, method: 'exact' };
  }

  function nnOrder(inp, forcedFirst) {
    var n = inp.stops.length, remaining = [], i;
    for (i = 0; i < n; i++) remaining.push(i);
    var order = [], t = inp.depart, cur = 0;
    if (forcedFirst !== undefined && forcedFirst !== null) {
      var fp = remaining.indexOf(forcedFirst);
      if (fp < 0) throw new Error('Bad forced start.');
      var st0 = inp.stops[forcedFirst];
      var arr0 = t + inp.drive[0][forcedFirst + 1];
      var beg0 = st0.earliest === null ? arr0 : Math.max(arr0, st0.earliest);
      t = beg0 + st0.service; cur = forcedFirst + 1;
      remaining.splice(fp, 1);
      order.push(forcedFirst);
    }
    while (remaining.length) {
      var bestIdx = -1, bestCost = null;
      for (i = 0; i < remaining.length; i++) {
        var s = remaining[i], st = inp.stops[s];
        var drive = inp.drive[cur][s + 1];
        var arrive = t + drive;
        var begin = st.earliest === null ? arrive : Math.max(arrive, st.earliest);
        var late = st.latest === null ? 0 : Math.max(0, begin - st.latest);
        var cost = late * LATE_WEIGHT + drive;
        if (bestCost === null || cost < bestCost - 1e-12) { bestCost = cost; bestIdx = i; }
      }
      var pick = remaining.splice(bestIdx, 1)[0];
      var st2 = inp.stops[pick];
      var arr2 = t + inp.drive[cur][pick + 1];
      var beg2 = st2.earliest === null ? arr2 : Math.max(arr2, st2.earliest);
      t = beg2 + st2.service; cur = pick + 1;
      order.push(pick);
    }
    return order;
  }

  function improve(order, inp) {
    var n = inp.stops.length;
    var best = evalOrder(order, inp);
    var improved = true, guard = 0, i, j;
    while (improved && guard < 4000) {
      improved = false; guard++;
      var restart = false;
      for (i = 0; i < n - 1 && !restart; i++) {
        for (j = i + 1; j < n && !restart; j++) {
          var cand = order.slice(0, i).concat(order.slice(i, j + 1).reverse(), order.slice(j + 1));
          var ev = evalOrder(cand, inp);
          if (isBetter(ev, best)) { order = cand; best = ev; improved = true; restart = true; }
        }
      }
      for (i = 0; i < n && !restart; i++) {
        for (j = 0; j < n && !restart; j++) {
          if (j === i || j === i + 1) continue;
          var cand2 = order.slice();
          var item = cand2.splice(i, 1)[0];
          cand2.splice(j > i ? j - 1 : j, 0, item);
          var ev2 = evalOrder(cand2, inp);
          if (isBetter(ev2, best)) { order = cand2; best = ev2; improved = true; restart = true; }
        }
      }
    }
    return { order: order, result: best };
  }

  function heuristicOrder(inp) {
    var n = inp.stops.length;
    var maxStarts = Math.min(n, 10), s;
    var bestOut = improve(nnOrder(inp), inp); // plain greedy seed first
    for (s = 0; s < maxStarts; s++) {
      var out = improve(nnOrder(inp, s), inp);
      if (isBetter(out.result, bestOut.result)) bestOut = out;
    }
    return { order: bestOut.order, result: bestOut.result, method: 'heuristic' };
  }

  function plan(raw) {
    var inp = normalize(raw);
    var n = inp.stops.length;
    var out = n <= 8 ? exactOrder(inp) : heuristicOrder(inp);
    var asListedOrder = inp.stops.map(function (_, i) { return i; });
    var asListed = evalOrder(asListedOrder, inp);
    return {
      input: inp, order: out.order, result: out.result, method: out.method,
      asListed: asListed,
      savedDrive: asListed.totalDrive - out.result.totalDrive,
      savedLate: asListed.totalLate - out.result.totalLate
    };
  }

  return {
    plan: plan, normalize: normalize, evalOrder: evalOrder,
    exactOrder: exactOrder, heuristicOrder: heuristicOrder, nnOrder: nnOrder,
    gridDriveMatrix: gridDriveMatrix, parseHM: parseHM, fmtHM: fmtHM, esc: esc,
    LATE_WEIGHT: LATE_WEIGHT
  };
});
