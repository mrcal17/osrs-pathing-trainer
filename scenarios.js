/*
 * Seeded question generator. The same (mode, terrain, size, run, seed) always rebuilds the same
 * question, which is how missed questions are replayed.
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./engine.js') : root.PathEngine);
  if (isNode) module.exports = api;
  else root.Scenarios = api;
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const TERRAINS = ['pillars', 'rocks', 'walls', 'rooms', 'mixed'];

  // Difficulty levels. Lengths are route steps; `filter` turns on the "make it interesting" rejections
  // (tie-breaks, obstacle-shaped routes) that Normal uses.
  const LEVELS = {
    1: {
      name: 'Beginner', size: 10, terrains: ['sparse'], filter: false,
      trace: [2, 4], tick: [3, 6], maxTick: 2, unreach: [1, 4], unreachGap: 2, blockedOnly: true,
      melee: [1, 3], npcSizes: [1, 1, 2], corner: 0.3,
    },
    2: {
      name: 'Easy', size: 12, terrains: ['light'], filter: false,
      trace: [3, 7], tick: [4, 10], maxTick: 3, unreach: [2, 8], unreachGap: 2, blockedOnly: true,
      melee: [1, 6], npcSizes: [1, 1, 2, 2, 3], corner: 0.2,
    },
    3: {
      name: 'Normal', size: 0, terrains: null, filter: true,
      trace: [4, 12], tick: [5, 16], maxTick: 0, unreach: [2, 14], unreachGap: 3, blockedOnly: false,
      melee: [2, 14], npcSizes: [1, 1, 1, 2, 2, 3, 3, 3, 4, 5], corner: 0.15,
    },
  };

  function makeRng(seed) {
    let a = seed >>> 0;
    const next = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
      next,
      int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
      chance: (p) => next() < p,
      pick: (arr) => arr[Math.floor(next() * arr.length)],
    };
  }

  // ---- terrain ------------------------------------------------------------------------------

  function areaClear(g, x, y, w, h) {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        if (g.inBounds(x + i, y + j) && g.blocked[g.idx(x + i, y + j)]) return false;
      }
    }
    return true;
  }

  function pillars(g, rng, count, sizes) {
    sizes = sizes || [1, 2, 2, 3, 3, 3];
    for (let tries = 0, placed = 0; placed < count && tries < count * 40; tries++) {
      const s = rng.pick(sizes);
      const w = rng.chance(0.3) ? Math.max(1, s + rng.pick([-1, 1])) : s;
      const x = rng.int(0, g.w - w), y = rng.int(0, g.h - s);
      const pad = rng.chance(0.2) ? 0 : 1;
      if (!areaClear(g, x - pad, y - pad, w + 2 * pad, s + 2 * pad)) continue;
      for (let j = 0; j < s; j++) for (let i = 0; i < w; i++) g.setBlocked(x + i, y + j, true);
      placed++;
    }
  }

  function rocks(g, rng, density) {
    for (let i = 0; i < g.w * g.h; i++) if (rng.chance(density)) g.blocked[i] = 1;
  }

  // Walls are drawn between corner points (0..w, 0..h); one unit segment = one tile-edge flag.
  function addSegment(g, cx, cy, dx, dy) {
    if (dx !== 0) {
      const tx = Math.min(cx, cx + dx), ty = cy - 1; // north edge of the tile below the segment
      if (ty >= 0 && ty < g.h - 1) g.setWallN(tx, ty, true);
    } else {
      const tx = cx - 1, ty = Math.min(cy, cy + dy); // east edge of the tile left of the segment
      if (tx >= 0 && tx < g.w - 1) g.setWallE(tx, ty, true);
    }
  }

  function fences(g, rng, count) {
    for (let k = 0; k < count; k++) {
      let cx = rng.int(2, g.w - 2), cy = rng.int(2, g.h - 2);
      let dir = rng.pick([[1, 0], [-1, 0], [0, 1], [0, -1]]);
      const turns = rng.pick([0, 0, 1, 1, 2]);
      for (let t = 0; t <= turns; t++) {
        const len = rng.int(2, 6);
        for (let i = 0; i < len; i++) {
          const nx = cx + dir[0], ny = cy + dir[1];
          if (nx < 1 || ny < 1 || nx > g.w - 1 || ny > g.h - 1) break;
          if (!rng.chance(0.12)) addSegment(g, cx, cy, dir[0], dir[1]); // the odd gap is a gate
          cx = nx; cy = ny;
        }
        dir = rng.chance(0.5) ? [dir[1], dir[0]] : [-dir[1], -dir[0]];
      }
    }
  }

  function rooms(g, rng, count) {
    for (let k = 0; k < count; k++) {
      const rw = rng.int(3, 6), rh = rng.int(3, 6);
      const x0 = rng.int(1, g.w - rw - 1), y0 = rng.int(1, g.h - rh - 1);
      const x1 = x0 + rw, y1 = y0 + rh, segs = [];
      for (let x = x0; x < x1; x++) segs.push([x, y0, 1, 0], [x, y1, 1, 0]);
      for (let y = y0; y < y1; y++) segs.push([x0, y, 0, 1], [x1, y, 0, 1]);
      const doors = new Set();
      for (let d = rng.pick([0, 1, 1, 2]); d > 0; d--) doors.add(rng.int(0, segs.length - 1));
      segs.forEach((s, i) => { if (!doors.has(i)) addSegment(g, s[0], s[1], s[2], s[3]); });
    }
  }

  function genTerrain(rng, size, style) {
    const g = new E.Grid(size, size);
    const k = (size * size) / 256;
    const n = (lo, hi) => Math.max(1, Math.round(k * rng.int(lo, hi)));
    if (style === 'sparse') pillars(g, rng, rng.int(1, 3), [1, 1, 2]);
    else if (style === 'light') { pillars(g, rng, n(3, 4), [1, 2, 2, 3]); rocks(g, rng, 0.03); }
    else if (style === 'pillars') pillars(g, rng, n(4, 7));
    else if (style === 'rocks') rocks(g, rng, 0.08 + rng.next() * 0.08);
    else if (style === 'walls') { fences(g, rng, n(5, 8)); rocks(g, rng, 0.02); }
    else if (style === 'rooms') { rooms(g, rng, n(1, 2)); pillars(g, rng, n(1, 3)); rocks(g, rng, 0.02); }
    else { pillars(g, rng, n(2, 3)); fences(g, rng, n(2, 4)); rocks(g, rng, 0.04); }
    return g;
  }

  // ---- questions ----------------------------------------------------------------------------

  function freeTile(g, rng, ok) {
    for (let t = 0; t < 200; t++) {
      const x = rng.int(0, g.w - 1), y = rng.int(0, g.h - 1);
      if (!g.isBlocked(x, y) && (!ok || ok(x, y))) return { x, y };
    }
    return null;
  }

  function samePath(a, b) {
    return a.length === b.length && a.every((t, i) => t.x === b[i].x && t.y === b[i].y);
  }

  // Would an empty map give the same route? Those only teach the open-ground rule, so ration them.
  function openGroundRoute(g, src, res) {
    return samePath(E.findPath(new E.Grid(g.w, g.h), src, res.end, { altRoute: false }).tiles, res.tiles);
  }

  function walkQuestion(rng, g, minLen, maxLen, openShare, strict) {
    const src = freeTile(g, rng);
    if (!src) return null;
    const dst = freeTile(g, rng, (x, y) => x !== src.x || y !== src.y);
    if (!dst) return null;
    const target = { x: dst.x, y: dst.y, w: 1, h: 1, kind: 'tile' };
    const res = E.findPath(g, src, target, { altRoute: false });
    if (!res.reached || res.truncated) return null;
    const len = res.tiles.length - 1;
    if (len < minLen || len > maxLen) return null;
    if (strict && openGroundRoute(g, src, res) && !rng.chance(openShare)) return null;
    return { grid: g, src, target, result: res };
  }

  function genTrace(rng, g, opts, strict, L) {
    return walkQuestion(rng, g, L.trace[0], L.trace[1], 0.25, strict && L.filter);
  }

  function genTick(rng, g, opts, strict, L) {
    const q = walkQuestion(rng, g, L.tick[0], L.tick[1], 0.35, strict && L.filter);
    if (!q) return null;
    const stops = E.tickStops(q.result.tiles, !!opts.run);
    if (stops.length < 2) return null;
    q.tick = rng.int(1, L.maxTick ? Math.min(L.maxTick, stops.length - 1) : stops.length - 1);
    q.answer = { x: stops[q.tick - 1].x, y: stops[q.tick - 1].y };
    return q;
  }

  function genUnreach(rng, g, opts, strict, L) {
    const src = freeTile(g, rng);
    if (!src) return null;
    let dst = null;
    if (L.blockedOnly || rng.chance(0.55)) {
      for (let t = 0; t < 60 && !dst; t++) {
        const x = rng.int(0, g.w - 1), y = rng.int(0, g.h - 1);
        if (g.isBlocked(x, y)) dst = { x, y };
      }
    } else {
      const s = E.search(g, src.x, src.y, null);
      dst = freeTile(g, rng, (x, y) => s.dist[g.idx(x, y)] < 0);
    }
    if (!dst || Math.max(Math.abs(dst.x - src.x), Math.abs(dst.y - src.y)) < L.unreachGap) return null;
    const target = { x: dst.x, y: dst.y, w: 1, h: 1, kind: 'tile' };
    const res = E.findPath(g, src, target);
    if (!res.alternative || res.truncated) return null;
    const len = res.tiles.length - 1;
    if (len < L.unreach[0] || len > L.unreach[1]) return null;
    const best = res.approach.best;
    const ties = res.approach.candidates.filter((c) => c.cost === best.cost).length;
    if (strict && L.filter && ties < 2 && !rng.chance(0.3)) return null;
    return { grid: g, src, target, result: res };
  }

  function genMelee(rng, g, opts, strict, L) {
    const size = rng.pick(L.npcSizes);
    if (size + 2 > g.w) return null;
    const nx = rng.int(1, g.w - size - 1), ny = rng.int(1, g.h - size - 1);
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        if (g.isBlocked(nx + i, ny + j)) return null;
        if (i < size - 1 && g.hasWallE(nx + i, ny + j)) return null;
        if (j < size - 1 && g.hasWallN(nx + i, ny + j)) return null;
      }
    }
    const npc = { x: nx, y: ny, w: size, h: size, kind: 'npc' };
    const gap = (x, y) => Math.max(nx - x, x - (nx + size - 1), ny - y, y - (ny + size - 1));
    // Sometimes start on a diagonal corner: the "which way do I step?" case.
    const corner = rng.chance(L.corner);
    let src;
    if (corner) {
      const c = rng.pick([[nx - 1, ny - 1], [nx + size, ny - 1], [nx - 1, ny + size], [nx + size, ny + size]]);
      src = { x: c[0], y: c[1] };
    } else {
      src = freeTile(g, rng, (x, y) => gap(x, y) >= 2);
    }
    if (!src || g.isBlocked(src.x, src.y)) return null;
    const res = E.findPath(g, src, npc);
    if (!res.reached || res.truncated) return null;
    const len = res.tiles.length - 1;
    if (len < (corner ? 1 : L.melee[0]) || len > L.melee[1]) return null;
    const cands = E.meleeCandidates(g, res);
    const ties = cands.filter((c) => c.dist === cands[0].dist).length;
    if (strict && L.filter && !corner && ties < 2 && !rng.chance(0.35)) return null;
    return { grid: g, src, target: npc, result: res };
  }

  const GENERATORS = { trace: genTrace, tick: genTick, unreach: genUnreach, melee: genMelee };

  // opts: { level: 1-3 (default 3), terrain: 'any' | one of TERRAINS, size, run, seed }.
  // Beginner and Easy pick their own grid size and terrain.
  function generate(mode, opts) {
    const rng = makeRng(opts.seed >>> 0);
    const level = LEVELS[opts.level] ? opts.level : 3, L = LEVELS[level];
    const size = L.size || opts.size || 16;
    const gen = GENERATORS[mode];
    let grid = null, style = null;
    for (let attempt = 0; attempt < 1500; attempt++) {
      if (attempt % 20 === 0) {
        style = L.terrains ? rng.pick(L.terrains) : !opts.terrain || opts.terrain === 'any' ? rng.pick(TERRAINS) : opts.terrain;
        grid = genTerrain(rng, size, style);
      }
      const q = gen(rng, grid, opts, attempt < 1000, L);
      if (q) return Object.assign(q, { mode, level, seed: opts.seed >>> 0, size, terrain: style, run: !!opts.run });
    }
    return null;
  }

  return { TERRAINS, LEVELS, makeRng, genTerrain, generate };
});
