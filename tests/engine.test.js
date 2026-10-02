// Run: node tests/engine.test.js
'use strict';
const assert = require('assert');
const E = require('../engine.js');
const S = require('../scenarios.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n  ' + (e.stack || e)); process.exitCode = 1; }
}
const T = (x, y) => ({ x, y });
const fmt = (tiles) => tiles.map((t) => `(${t.x},${t.y})`).join(' ');
const walk = (g, src, dst, opts) => E.findPath(g, src, { x: dst.x, y: dst.y }, opts);

// ---------------------------------------------------------------------------------------------
// Independent reference: the classic client's doWalkTo BFS written against bit-flag collision
// masks (same structure rsmod uses), so it shares no collision code with engine.js.
const WALL_N = 0x2, WALL_E = 0x8, WALL_S = 0x20, WALL_W = 0x80, BLOCK = 0x100;
function buildFlags(g) {
  const f = new Int32Array(g.w * g.h);
  const at = (x, y) => y * g.w + x;
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      if (g.blocked[at(x, y)]) f[at(x, y)] |= BLOCK;
      if (g.wallE[at(x, y)]) { f[at(x, y)] |= WALL_E; if (x + 1 < g.w) f[at(x + 1, y)] |= WALL_W; }
      if (g.wallN[at(x, y)]) { f[at(x, y)] |= WALL_N; if (y + 1 < g.h) f[at(x, y + 1)] |= WALL_S; }
    }
  }
  return f;
}
function refPath(g, src, rect, melee) {
  const W = g.w, H = g.h, F = buildFlags(g), at = (x, y) => y * W + x;
  const via = new Int32Array(W * H), cost = new Int32Array(W * H).fill(99999999);
  const qx = [], qy = [];
  const east = rect.x + rect.w - 1, north = rect.y + rect.h - 1;
  const reached = (x, y) => {
    if (!melee) return x === rect.x && y === rect.y;
    const f = F[at(x, y)];
    if (x === rect.x - 1 && y >= rect.y && y <= north && (f & WALL_E) === 0) return true;
    if (x === east + 1 && y >= rect.y && y <= north && (f & WALL_W) === 0) return true;
    if (y + 1 === rect.y && x >= rect.x && x <= east && (f & WALL_N) === 0) return true;
    return y === north + 1 && x >= rect.x && x <= east && (f & WALL_S) === 0;
  };
  via[at(src.x, src.y)] = 99; cost[at(src.x, src.y)] = 0; qx.push(src.x); qy.push(src.y);
  let head = 0, found = false, ex = -1, ey = -1;
  const enq = (x, y, v, c) => { via[at(x, y)] = v; cost[at(x, y)] = c; qx.push(x); qy.push(y); };
  while (head < qx.length) {
    const x = qx[head], y = qy[head]; head++;
    if (reached(x, y)) { found = true; ex = x; ey = y; break; }
    const c = cost[at(x, y)] + 1;
    const free = (xx, yy, mask) => (F[at(xx, yy)] & mask) === 0;
    if (x > 0 && via[at(x - 1, y)] === 0 && free(x - 1, y, BLOCK | WALL_E)) enq(x - 1, y, 2, c);
    if (x < W - 1 && via[at(x + 1, y)] === 0 && free(x + 1, y, BLOCK | WALL_W)) enq(x + 1, y, 8, c);
    if (y > 0 && via[at(x, y - 1)] === 0 && free(x, y - 1, BLOCK | WALL_N)) enq(x, y - 1, 1, c);
    if (y < H - 1 && via[at(x, y + 1)] === 0 && free(x, y + 1, BLOCK | WALL_S)) enq(x, y + 1, 4, c);
    if (x > 0 && y > 0 && via[at(x - 1, y - 1)] === 0 && free(x - 1, y - 1, BLOCK | WALL_N | WALL_E) &&
        free(x - 1, y, BLOCK | WALL_E) && free(x, y - 1, BLOCK | WALL_N)) enq(x - 1, y - 1, 3, c);
    if (x < W - 1 && y > 0 && via[at(x + 1, y - 1)] === 0 && free(x + 1, y - 1, BLOCK | WALL_W | WALL_N) &&
        free(x + 1, y, BLOCK | WALL_W) && free(x, y - 1, BLOCK | WALL_N)) enq(x + 1, y - 1, 9, c);
    if (x > 0 && y < H - 1 && via[at(x - 1, y + 1)] === 0 && free(x - 1, y + 1, BLOCK | WALL_E | WALL_S) &&
        free(x - 1, y, BLOCK | WALL_E) && free(x, y + 1, BLOCK | WALL_S)) enq(x - 1, y + 1, 6, c);
    if (x < W - 1 && y < H - 1 && via[at(x + 1, y + 1)] === 0 && free(x + 1, y + 1, BLOCK | WALL_S | WALL_W) &&
        free(x + 1, y, BLOCK | WALL_W) && free(x, y + 1, BLOCK | WALL_S)) enq(x + 1, y + 1, 12, c);
  }
  if (!found) {
    let best = 1000, bestCost = 100;
    for (let x = rect.x - 10; x <= rect.x + 10; x++) {
      for (let y = rect.y - 10; y <= rect.y + 10; y++) {
        if (x < 0 || y < 0 || x >= W || y >= H || cost[at(x, y)] >= 100) continue;
        const dx = x < rect.x ? rect.x - x : x > east ? x - east : 0;
        const dy = y < rect.y ? rect.y - y : y > north ? y - north : 0;
        const d2 = dx * dx + dy * dy;
        if (d2 < best || (d2 === best && cost[at(x, y)] < bestCost)) { best = d2; bestCost = cost[at(x, y)]; ex = x; ey = y; }
      }
    }
    if (best === 1000) return null;
  }
  // Back-track turn points, keeping the 25 nearest the source (rsmod: addFirst / removeLast).
  const waypoints = [{ x: ex, y: ey }];
  let x = ex, y = ey, dir = via[at(x, y)];
  while (x !== src.x || y !== src.y) {
    if (dir & 2) x++; else if (dir & 8) x--;
    if (dir & 1) y++; else if (dir & 4) y--;
    if (x === src.x && y === src.y) break;
    const nd = via[at(x, y)];
    if (nd !== dir) {
      if (waypoints.length >= 25) waypoints.pop();
      waypoints.unshift({ x, y });
      dir = nd;
    }
  }
  if (ex === src.x && ey === src.y) waypoints.length = 0;
  return waypoints;
}
// ---------------------------------------------------------------------------------------------

test('open ground: straight first, diagonal last', () => {
  const g = new E.Grid(16, 16);
  assert.strictEqual(fmt(walk(g, T(5, 5), T(8, 6)).tiles), '(5,5) (6,5) (7,5) (8,6)');
  assert.strictEqual(fmt(walk(g, T(5, 5), T(2, 6)).tiles), '(5,5) (4,5) (3,5) (2,6)');
  assert.strictEqual(fmt(walk(g, T(5, 5), T(6, 8)).tiles), '(5,5) (5,6) (5,7) (6,8)');
  assert.strictEqual(fmt(walk(g, T(5, 5), T(4, 2)).tiles), '(5,5) (5,4) (5,3) (4,2)');
  assert.strictEqual(fmt(walk(g, T(5, 5), T(8, 7)).tiles), '(5,5) (6,5) (7,6) (8,7)');
});

test('no corner cutting past a blocked side tile', () => {
  const g = new E.Grid(16, 16);
  g.setBlocked(6, 5, true);
  assert.strictEqual(fmt(walk(g, T(5, 5), T(6, 6)).tiles), '(5,5) (5,6) (6,6)');
  assert.strictEqual(g.stepBlocker(5, 5, 1, 1), 'corner');
});

test('a wall touching the corner blocks the diagonal', () => {
  const g = new E.Grid(16, 16);
  g.setWallN(6, 5, true); // between (6,5) and (6,6): not adjacent to the start tile, but touches the corner
  assert.strictEqual(g.stepBlocker(5, 5, 1, 1), 'cornerWall');
  assert.strictEqual(g.canStep(5, 5, 1, 0), true);
  assert.strictEqual(g.stepBlocker(6, 5, 0, 1), 'wall');
  assert.strictEqual(fmt(walk(g, T(5, 5), T(6, 6)).tiles), '(5,5) (5,6) (6,6)');
});

test('unreachable rock: closest tile, then fewest steps', () => {
  const g = new E.Grid(16, 16);
  g.setBlocked(5, 5, true);
  const r = walk(g, T(5, 1), T(5, 5));
  assert.ok(r.alternative);
  assert.deepStrictEqual(r.end, T(5, 4));
});

test('unreachable full tie: westmost wins', () => {
  const g = new E.Grid(16, 16);
  g.setBlocked(5, 4, true); g.setBlocked(5, 5, true); g.setBlocked(5, 6, true);
  const r = walk(g, T(5, 1), T(5, 5));
  assert.deepStrictEqual(r.end, T(4, 5));
  const best = r.approach.candidates.slice(0, 2).map((c) => [c.x, c.y, c.cost, c.dist]);
  assert.deepStrictEqual(best, [[4, 5, 1, 4], [6, 5, 1, 4]]);
});

test('unreachable from inside a closed room goes to the nearest inside tile', () => {
  const g = new E.Grid(16, 16);
  for (let x = 4; x <= 7; x++) { g.setWallN(x, 3, true); g.setWallN(x, 7, true); }
  for (let y = 4; y <= 7; y++) { g.setWallE(3, y, true); g.setWallE(7, y, true); }
  const r = walk(g, T(5, 5), T(12, 5));
  assert.deepStrictEqual(r.end, T(7, 5));
});

test('melee from a diagonal steps horizontally', () => {
  const g = new E.Grid(16, 16);
  const npc = (x, y) => ({ x, y, w: 1, h: 1, kind: 'npc' });
  assert.deepStrictEqual(E.findPath(g, T(5, 5), npc(6, 6)).end, T(6, 5));
  assert.deepStrictEqual(E.findPath(g, T(7, 7), npc(6, 6)).end, T(6, 7));
  assert.deepStrictEqual(E.findPath(g, T(5, 7), npc(6, 6)).end, T(6, 7));
  assert.deepStrictEqual(E.findPath(g, T(7, 5), npc(6, 6)).end, T(6, 5));
});

test('melee ignores tiles behind a wall and corners', () => {
  const g = new E.Grid(16, 16);
  const npc = { x: 6, y: 6, w: 2, h: 2, kind: 'npc' };
  g.setWallN(6, 5, true); g.setWallN(7, 5, true); // wall along the NPC's south edge
  assert.strictEqual(E.meleeTileIssue(g, 6, 5, npc), 'wall');
  assert.strictEqual(E.meleeTileIssue(g, 5, 5, npc), 'corner');
  assert.strictEqual(E.meleeTileIssue(g, 6, 6, npc), 'inside');
  assert.strictEqual(E.meleeTileIssue(g, 5, 6, npc), null);
  const r = E.findPath(g, T(6, 2), npc);
  assert.ok(r.reached);
  assert.strictEqual(E.meleeTileIssue(g, r.end.x, r.end.y, npc), null);
  assert.notStrictEqual(r.end.y, 5);
});

test('tick stops: run 2 per tick, odd remainder walks', () => {
  const tiles = [T(0, 0), T(1, 0), T(2, 0), T(3, 0), T(4, 0), T(5, 0)];
  assert.deepStrictEqual(E.tickStops(tiles, true).map((s) => s.i), [2, 4, 5]);
  assert.deepStrictEqual(E.tickStops(tiles, false).map((s) => s.i), [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(E.tickStops([T(0, 0)], true), []);
});

test('route is cut after 25 turn points', () => {
  const g = new E.Grid(30, 30);
  for (let row = 1; row < 29; row += 2) {
    for (let x = 0; x < 30; x++) g.setBlocked(x, row, true);
    g.setBlocked(((row - 1) / 2) % 2 === 0 ? 29 : 0, row, false);
  }
  const r = walk(g, T(0, 0), T(0, 28));
  assert.ok(r.reached && r.truncated);
  assert.ok(r.turns.length > 25);
  assert.deepStrictEqual(r.end, { x: r.turns[24].x, y: r.turns[24].y });
  assert.deepStrictEqual(E.turnPoints(r.tiles).map((t) => [t.x, t.y]), refPath(g, T(0, 0), { x: 0, y: 28, w: 1, h: 1 }, false).map((t) => [t.x, t.y]));
});

test('trace diagnosis: tie-break explained from the target backwards', () => {
  const g = new E.Grid(16, 16);
  const r = walk(g, T(5, 5), T(8, 6));
  const d = E.diagnoseTrace(g, r, [T(6, 6), T(7, 6), T(8, 6)]);
  assert.strictEqual(d.kind, 'tiebreak');
  assert.deepStrictEqual([d.T, d.A, d.B], [T(8, 6), T(7, 5), T(7, 6)]);
  assert.ok(d.options[0].chosen && d.options[0].x === 7 && d.options[0].y === 5);
  assert.strictEqual(E.diagnoseTrace(g, r, [T(6, 5), T(7, 5), T(8, 6)]).correct, true);
  assert.strictEqual(E.diagnoseTrace(g, r, [T(6, 5), T(7, 5), T(8, 5), T(8, 6)]).kind, 'longer');
  g.setBlocked(6, 5, true);
  const r2 = walk(g, T(5, 5), T(8, 6));
  assert.strictEqual(E.diagnoseTrace(g, r2, [T(6, 5)]).kind, 'illegal');
});

test('random maps match the bit-flag reference (walk, unreachable, melee)', () => {
  const rng = S.makeRng(12345);
  let compared = 0, alts = 0, melees = 0;
  for (let n = 0; n < 4000; n++) {
    const size = rng.int(8, 20);
    const g = new E.Grid(size, size);
    const pr = 0.05 + rng.next() * 0.25, pw = rng.next() * 0.25;
    for (let i = 0; i < size * size; i++) {
      if (rng.chance(pr)) g.blocked[i] = 1;
      if (rng.chance(pw)) g.wallE[i] = 1;
      if (rng.chance(pw)) g.wallN[i] = 1;
    }
    const src = T(rng.int(0, size - 1), rng.int(0, size - 1));
    if (g.isBlocked(src.x, src.y)) continue;
    const melee = rng.chance(0.3);
    const s = melee ? rng.int(1, 3) : 1;
    const rect = { x: rng.int(0, size - s), y: rng.int(0, size - s), w: s, h: s };
    const mine = E.findPath(g, src, Object.assign({ kind: melee ? 'npc' : 'tile' }, rect));
    const ref = refPath(g, src, rect, melee);
    const mineTurns = E.turnPoints(mine.tiles).map((t) => [t.x, t.y]);
    if (ref === null) {
      assert.ok(mine.noRoute, `expected no route, seed case ${n}`);
    } else {
      assert.deepStrictEqual(mineTurns, ref.map((t) => [t.x, t.y]), `case ${n}`);
    }
    compared++;
    if (mine.alternative) alts++;
    if (melee) melees++;
  }
  assert.ok(compared > 3000 && alts > 300 && melees > 800, `coverage ${compared}/${alts}/${melees}`);
});

test('scenario generator produces every mode deterministically', () => {
  for (const mode of ['trace', 'tick', 'unreach', 'melee']) {
    for (const terrain of ['any', ...S.TERRAINS]) {
      for (let seed = 1; seed <= 12; seed++) {
        const opts = { terrain, size: 16, run: seed % 2 === 0, seed };
        const a = S.generate(mode, opts), b = S.generate(mode, opts);
        assert.ok(a, `${mode}/${terrain}/${seed} generated`);
        assert.strictEqual(JSON.stringify(a.grid.toJSON()), JSON.stringify(b.grid.toJSON()));
        assert.deepStrictEqual([a.src, a.target], [b.src, b.target]);
        assert.ok(a.result.tiles.length >= 2, 'player moves');
        if (mode === 'trace') assert.ok(a.result.reached && !a.result.truncated);
        if (mode === 'unreach') assert.ok(a.result.alternative);
        if (mode === 'melee') assert.ok(a.result.reached && a.result.npc);
        if (mode === 'tick') {
          const stops = E.tickStops(a.result.tiles, opts.run);
          assert.ok(a.tick >= 1 && a.tick < stops.length, 'tick is not the arrival tick');
          assert.deepStrictEqual(a.answer, { x: stops[a.tick - 1].x, y: stops[a.tick - 1].y });
        }
      }
    }
  }
});

test('Beginner and Easy levels stay small and short', () => {
  for (const level of [1, 2]) {
    const L = S.LEVELS[level];
    for (const mode of ['trace', 'tick', 'unreach', 'melee']) {
      for (let seed = 1; seed <= 40; seed++) {
        const q = S.generate(mode, { level, size: 20, terrain: 'walls', run: true, seed });
        assert.ok(q, `${level}/${mode}/${seed}`);
        assert.strictEqual(q.size, L.size);
        assert.strictEqual(q.grid.wallE.some(Boolean) || q.grid.wallN.some(Boolean), false, 'no walls');
        const steps = q.result.tiles.length - 1;
        const [lo, hi] = L[mode];
        assert.ok(steps <= hi && (steps >= lo || mode === 'melee'), `${level}/${mode} steps ${steps}`);
        if (mode === 'tick') assert.ok(q.tick <= L.maxTick);
        if (mode === 'unreach') assert.ok(q.grid.isBlocked(q.target.x, q.target.y));
        if (mode === 'melee') assert.ok(L.npcSizes.includes(q.target.w));
      }
    }
  }
});

console.log(`${passed} tests passed` + (process.exitCode ? ' (with failures above)' : ''));
