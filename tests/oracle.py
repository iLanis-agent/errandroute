#!/usr/bin/env python3
"""Independent oracle for ErrandRoute. Re-implements the timing semantics from
scratch (no shared code with engine.js) and brute-forces every permutation.
Writes tests/expected.json: raw inputs + expected optimal order and costs."""
import itertools, json, math, random

def grid_matrix(points, circuity, speed):
    n = len(points)
    return [[0.0 if i == j else math.sqrt((points[i][0]-points[j][0])**2 + (points[i][1]-points[j][1])**2) * circuity / speed * 60
             for j in range(n)] for i in range(n)]

def parse_hm(s):
    if s is None or str(s).strip() == '':
        return None
    h, m = str(s).split(':')
    return int(h) * 60 + int(m)

def normalize(raw):
    mode = 'matrix' if raw.get('mode') == 'matrix' else 'grid'
    stops = []
    points = [(0.0, 0.0)]
    if mode == 'grid':
        points[0] = (float(raw['home']['x']), float(raw['home']['y']))
    for s in raw['stops']:
        st = {'service': float(s.get('service', 10)),
              'earliest': parse_hm(s.get('earliest')),
              'latest': parse_hm(s.get('latest'))}
        if mode == 'grid':
            points.append((float(s['x']), float(s['y'])))
        stops.append(st)
    if mode == 'grid':
        drive = grid_matrix(points, float(raw.get('circuity', 1.3)), float(raw.get('speedMph', 22)))
    else:
        drive = [[0.0 if i == j else float(raw['matrix'][i][j]) for j in range(len(raw['matrix']))]
                 for i in range(len(raw['matrix']))]
    return {'stops': stops, 'depart': parse_hm(raw['depart']),
            'returnHome': bool(raw.get('returnHome')), 'drive': drive}

def eval_order(order, inp):
    t, total_drive, total_late, cur = inp['depart'], 0.0, 0.0, 0
    for s in order:
        st = inp['stops'][s]
        drive = inp['drive'][cur][s + 1]
        total_drive += drive
        arrive = t + drive
        begin = arrive if st['earliest'] is None else max(arrive, st['earliest'])
        late = 0.0 if st['latest'] is None else max(0.0, begin - st['latest'])
        total_late += late
        t = begin + st['service']
        cur = s + 1
    if inp['returnHome']:
        total_drive += inp['drive'][cur][0]
    return total_late, total_drive

def best_order(inp):
    n = len(inp['stops'])
    best = None
    best_perm = None
    for perm in itertools.permutations(range(n)):
        key = eval_order(perm, inp)
        if best is None or key < best:  # tuple compare: late first, then drive; first wins ties
            best = key
            best_perm = list(perm)
    return best_perm, best[0], best[1]

def rand_case(rng, n):
    stops = []
    for i in range(n):
        s = {'name': f'stop{i+1}', 'x': round(rng.uniform(-8, 8), 3), 'y': round(rng.uniform(-8, 8), 3),
             'service': rng.choice([5, 10, 15, 20, 30, 45])}
        r = rng.random()
        if r < 0.35:
            s['latest'] = f"{rng.randint(11, 19):02d}:{rng.choice([0, 15, 30, 45]):02d}"
        elif r < 0.45:
            s['earliest'] = f"{rng.randint(8, 11):02d}:{rng.choice([0, 30]):02d}"
            s['latest'] = f"{rng.randint(14, 20):02d}:{rng.choice([0, 30]):02d}"
        stops.append(s)
    return {'mode': 'grid', 'depart': f"{rng.randint(7, 11):02d}:{rng.choice([0, 15, 30, 45]):02d}",
            'home': {'x': round(rng.uniform(-3, 3), 3), 'y': round(rng.uniform(-3, 3), 3)},
            'circuity': rng.choice([1.0, 1.3, 1.42]), 'speedMph': rng.choice([15, 22, 30]),
            'returnHome': rng.random() < 0.6, 'stops': stops}

cases = []
# Crafted 1: tight early closing forces visiting the far stop first, against distance greed
cases.append({'id': 'crafted-tight-window', 'raw': {
    'depart': '09:00', 'home': {'x': 0, 'y': 0}, 'returnHome': True,
    'stops': [{'name': 'near-shop', 'x': 1, 'y': 0, 'service': 10},
              {'name': 'far-pharmacy', 'x': 9, 'y': 0, 'service': 5, 'latest': '09:40'},
              {'name': 'mid-cafe', 'x': 5, 'y': 0, 'service': 5}]}})
# Crafted 2: opening time creates waiting; checking wait semantics
cases.append({'id': 'crafted-early-wait', 'raw': {
    'depart': '08:00', 'home': {'x': 0, 'y': 0}, 'returnHome': False,
    'stops': [{'name': 'bakery', 'x': 2, 'y': 0, 'service': 5, 'earliest': '09:00'},
              {'name': 'kiosk', 'x': 0, 'y': 2, 'service': 5}]}})
# Crafted 3: impossible window -> lateness minimized, order changes
cases.append({'id': 'crafted-infeasible', 'raw': {
    'depart': '16:00', 'home': {'x': 0, 'y': 0}, 'returnHome': True,
    'stops': [{'name': 'bank', 'x': 6, 'y': 8, 'service': 20, 'latest': '16:30'},
              {'name': 'clinic', 'x': -6, 'y': -8, 'service': 15, 'latest': '17:00'},
              {'name': 'market', 'x': 1, 'y': 1, 'service': 25}]}})
# Crafted 4: 3-4-5 triangle distances
cases.append({'id': 'crafted-triangle', 'raw': {
    'depart': '10:00', 'home': {'x': 0, 'y': 0}, 'returnHome': True, 'circuity': 1.0, 'speedMph': 30,
    'stops': [{'name': 'a', 'x': 3, 'y': 0, 'service': 0},
              {'name': 'b', 'x': 3, 'y': 4, 'service': 0},
              {'name': 'c', 'x': 0, 'y': 4, 'service': 0}]}})
# Crafted 5: matrix mode, asymmetric one-way trap
cases.append({'id': 'crafted-matrix-oneway', 'raw': {
    'mode': 'matrix', 'depart': '09:00', 'returnHome': True,
    'stops': [{'name': 'A', 'service': 5}, {'name': 'B', 'service': 5}, {'name': 'C', 'service': 5}],
    'matrix': [[0, 10, 40, 12],
               [50, 0, 8, 20],
               [9, 7, 0, 15],
               [11, 19, 6, 0]]}})
# Crafted 6: matrix mode with windows
cases.append({'id': 'crafted-matrix-window', 'raw': {
    'mode': 'matrix', 'depart': '13:00', 'returnHome': False,
    'stops': [{'name': 'A', 'service': 10, 'latest': '14:00'}, {'name': 'B', 'service': 10},
              {'name': 'C', 'service': 10}, {'name': 'D', 'service': 10, 'earliest': '15:00'}],
    'matrix': [[0, 20, 15, 25, 30],
               [22, 0, 12, 18, 10],
               [14, 11, 0, 9, 16],
               [26, 17, 8, 0, 12],
               [28, 9, 15, 13, 0]]}})

rng = random.Random(20261007)
for i, n in enumerate([2, 3, 4, 5, 5, 6, 6, 6, 7, 7, 7, 8, 8, 8, 8, 8]):
    cases.append({'id': f'rand-{i:02d}-n{n}', 'raw': rand_case(rng, n)})

out = []
for c in cases:
    inp = normalize(c['raw'])
    order, late, drive = best_order(inp)
    out.append({'id': c['id'], 'raw': c['raw'],
                'expected': {'order': order, 'totalLate': late, 'totalDrive': drive,
                             'feasible': late == 0.0}})
with open('tests/expected.json', 'w') as f:
    json.dump(out, f, indent=1)
print(f'wrote {len(out)} cases')
for o in out:
    print(o['id'], 'order=', o['expected']['order'], 'late=', round(o['expected']['totalLate'], 3),
          'drive=', round(o['expected']['totalDrive'], 3), 'feasible=', o['expected']['feasible'])
