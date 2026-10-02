/*
 * OSRS player pathfinding model (the server's BFS "smart" pathfinder for a size-1 player).
 * Coordinates: x grows east, y grows north. Tiles outside the grid count as blocked.
 * Works as a browser global (window.PathEngine) and as a CommonJS module for the tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PathEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Neighbour expansion order of the BFS. Every tie in pathing comes down to this order.
  const DIRS = [
    { name: 'W', dx: -1, dy: 0 },
    { name: 'E', dx: 1, dy: 0 },
    { name: 'S', dx: 0, dy: -1 },
    { name: 'N', dx: 0, dy: 1 },
    { name: 'SW', dx: -1, dy: -1 },
    { name: 'SE', dx: 1, dy: -1 },
    { name: 'NW', dx: -1, dy: 1 },
    { name: 'NE', dx: 1, dy: 1 },
  ];
  const ALT_RANGE = 10;      // unreachable clicks: search the 21x21 square around the target
  const ALT_MAX_DIST = 100;  // tiles this many steps away or more are never chosen
  const MAX_TURNS = 25;      // routes are cut after this many turn points

  function dirName(dx, dy) {
    for (const d of DIRS) if (d.dx === dx && d.dy === dy) return d.name;
    return '?';
  }

  function setIndices(arr) {
    const out = [];
    for (let i = 0; i < arr.length; i++) if (arr[i]) out.push(i);
    return out;
  }

  class Grid {
    constructor(w, h) {
      this.w = w;
      this.h = h;
      this.blocked = new Uint8Array(w * h);
      this.wallE = new Uint8Array(w * h); // wall along the east edge of the tile
      this.wallN = new Uint8Array(w * h); // wall along the north edge of the tile
    }
    idx(x, y) { return y * this.w + x; }
    inBounds(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
    isBlocked(x, y) { return !this.inBounds(x, y) || this.blocked[this.idx(x, y)] === 1; }
    hasWallE(x, y) { return this.inBounds(x, y) && this.wallE[this.idx(x, y)] === 1; }
    hasWallN(x, y) { return this.inBounds(x, y) && this.wallN[this.idx(x, y)] === 1; }
    setBlocked(x, y, v) { if (this.inBounds(x, y)) this.blocked[this.idx(x, y)] = v ? 1 : 0; }
    setWallE(x, y, v) { if (this.inBounds(x, y)) this.wallE[this.idx(x, y)] = v ? 1 : 0; }
    setWallN(x, y, v) { if (this.inBounds(x, y)) this.wallN[this.idx(x, y)] = v ? 1 : 0; }

    // Wall on the shared edge of two orthogonally adjacent tiles.
    wallBetween(ax, ay, bx, by) {
      if (bx === ax + 1) return this.hasWallE(ax, ay);
      if (bx === ax - 1) return this.hasWallE(bx, by);
      if (by === ay + 1) return this.hasWallN(ax, ay);
      if (by === ay - 1) return this.hasWallN(bx, by);
      return false;
    }

    // Why a one-tile step is illegal ('blocked' | 'wall' | 'corner' | 'cornerWall'), or null if legal.
    // A diagonal step needs both side tiles walkable and no wall on any of the four edges at the corner.
    stepBlocker(x, y, dx, dy) {
      const nx = x + dx, ny = y + dy;
      if (this.isBlocked(nx, ny)) return 'blocked';
      if (dx === 0 || dy === 0) return this.wallBetween(x, y, nx, ny) ? 'wall' : null;
      if (this.isBlocked(x + dx, y) || this.isBlocked(x, y + dy)) return 'corner';
      if (this.wallBetween(x, y, x + dx, y) || this.wallBetween(x, y, x, y + dy) ||
          this.wallBetween(x + dx, y, nx, ny) || this.wallBetween(x, y + dy, nx, ny)) return 'cornerWall';
      return null;
    }
    canStep(x, y, dx, dy) { return this.stepBlocker(x, y, dx, dy) === null; }

    clone() {
      const g = new Grid(this.w, this.h);
      g.blocked.set(this.blocked);
      g.wallE.set(this.wallE);
      g.wallN.set(this.wallN);
      return g;
    }
    toJSON() {
      return { w: this.w, h: this.h, blocked: setIndices(this.blocked), wallE: setIndices(this.wallE), wallN: setIndices(this.wallN) };
    }
    static fromJSON(o) {
      const g = new Grid(o.w, o.h);
      for (const i of o.blocked || []) g.blocked[i] = 1;
      for (const i of o.wallE || []) g.wallE[i] = 1;
      for (const i of o.wallN || []) g.wallN[i] = 1;
      return g;
    }
  }

  // Breadth-first search from (sx, sy), run to exhaustion so explanations can see every tile.
  // `found` is the first dequeued tile satisfying isGoal: the tile where the game's search stops.
  // Everything the game's search touched before stopping is identical here.
  function search(grid, sx, sy, isGoal) {
    const n = grid.w * grid.h;
    const dist = new Int32Array(n).fill(-1);
    const parent = new Int32Array(n).fill(-1);
    const via = new Int8Array(n).fill(-1);
    const order = new Int32Array(n).fill(-1);
    const queue = new Int32Array(n);
    let head = 0, tail = 0, found = -1;
    const s = grid.idx(sx, sy);
    dist[s] = 0;
    queue[tail++] = s;
    while (head < tail) {
      const cur = queue[head];
      order[cur] = head++;
      const cx = cur % grid.w, cy = (cur - cx) / grid.w;
      if (found < 0 && isGoal && isGoal(cx, cy)) found = cur;
      for (let d = 0; d < 8; d++) {
        const nx = cx + DIRS[d].dx, ny = cy + DIRS[d].dy;
        if (!grid.inBounds(nx, ny)) continue;
        const ni = grid.idx(nx, ny);
        if (dist[ni] !== -1 || !grid.canStep(cx, cy, DIRS[d].dx, DIRS[d].dy)) continue;
        dist[ni] = dist[cur] + 1;
        parent[ni] = cur;
        via[ni] = d;
        queue[tail++] = ni;
      }
    }
    return { dist, parent, via, order, found, src: s };
  }

  function backtrack(grid, s, end) {
    const out = [];
    for (let i = end; i !== -1; i = s.parent[i]) out.push({ x: i % grid.w, y: Math.floor(i / grid.w) });
    return out.reverse();
  }

  // Melee/interaction reach on an NPC rectangle: share an edge (not a corner), stand outside it,
  // and have no wall on that edge.
  function meleeReach(grid, x, y, r) {
    const x2 = r.x + r.w - 1, y2 = r.y + r.h - 1;
    if (x === r.x - 1 && y >= r.y && y <= y2) return !grid.hasWallE(x, y);
    if (x === x2 + 1 && y >= r.y && y <= y2) return !grid.hasWallE(x - 1, y);
    if (y === r.y - 1 && x >= r.x && x <= x2) return !grid.hasWallN(x, y);
    if (y === y2 + 1 && x >= r.x && x <= x2) return !grid.hasWallN(x, y - 1);
    return false;
  }

  // Why a tile cannot attack the NPC ('inside' | 'corner' | 'far' | 'wall'), or null if it can.
  function meleeTileIssue(grid, x, y, r) {
    const x2 = r.x + r.w - 1, y2 = r.y + r.h - 1;
    const ex = x < r.x ? r.x - x : x > x2 ? x - x2 : 0;
    const ey = y < r.y ? r.y - y : y > y2 ? y - y2 : 0;
    if (ex === 0 && ey === 0) return 'inside';
    if (ex > 1 || ey > 1) return 'far';
    if (ex === 1 && ey === 1) return 'corner';
    return meleeReach(grid, x, y, r) ? null : 'wall';
  }

  // Squared distance from a tile to the nearest tile of rectangle r.
  function rectDist2(x, y, r) {
    const dx = x < r.x ? r.x - x : x > r.x + r.w - 1 ? x - (r.x + r.w - 1) : 0;
    const dy = y < r.y ? r.y - y : y > r.y + r.h - 1 ? y - (r.y + r.h - 1) : 0;
    return dx * dx + dy * dy;
  }

  // Unreachable target: among reachable tiles in the 21x21 square around the target's SW tile,
  // take the lowest dx^2+dy^2; ties go to fewer steps; full ties to the first scanned
  // (x ascending, then y ascending = westmost, then southmost).
  function closestApproach(grid, s, rect) {
    const candidates = [];
    let best = null, scan = 0;
    for (let x = rect.x - ALT_RANGE; x <= rect.x + ALT_RANGE; x++) {
      for (let y = rect.y - ALT_RANGE; y <= rect.y + ALT_RANGE; y++) {
        if (!grid.inBounds(x, y)) continue;
        const d = s.dist[grid.idx(x, y)];
        if (d < 0 || d >= ALT_MAX_DIST) continue;
        const c = { x, y, cost: rectDist2(x, y, rect), dist: d, scan: scan++ };
        candidates.push(c);
        if (!best || c.cost < best.cost || (c.cost === best.cost && c.dist < best.dist)) best = c;
      }
    }
    candidates.sort((a, b) => a.cost - b.cost || a.dist - b.dist || a.scan - b.scan);
    return { best, candidates };
  }

  // Tiles where the route changes direction, plus the final tile. `i` indexes into tiles.
  function turnPoints(tiles) {
    const out = [];
    for (let i = 1; i < tiles.length; i++) {
      if (i === tiles.length - 1) { out.push({ x: tiles[i].x, y: tiles[i].y, i }); break; }
      const ax = tiles[i].x - tiles[i - 1].x, ay = tiles[i].y - tiles[i - 1].y;
      const bx = tiles[i + 1].x - tiles[i].x, by = tiles[i + 1].y - tiles[i].y;
      if (ax !== bx || ay !== by) out.push({ x: tiles[i].x, y: tiles[i].y, i });
    }
    return out;
  }

  // target: { x, y, w?, h?, kind?: 'tile' | 'npc' }. Tile targets walk onto the tile;
  // NPC targets stop at melee reach. opts.altRoute (default true) enables closest-approach.
  function findPath(grid, src, target, opts) {
    opts = opts || {};
    const rect = { x: target.x, y: target.y, w: target.w || 1, h: target.h || 1 };
    const npc = target.kind === 'npc';
    const isGoal = npc ? (x, y) => meleeReach(grid, x, y, rect) : (x, y) => x === rect.x && y === rect.y;
    const s = search(grid, src.x, src.y, isGoal);
    let end = s.found, approach = null;
    if (end < 0 && opts.altRoute !== false) {
      approach = closestApproach(grid, s, rect);
      if (approach.best) end = grid.idx(approach.best.x, approach.best.y);
    }
    const fullTiles = end < 0 ? [{ x: src.x, y: src.y }] : backtrack(grid, s, end);
    const turns = turnPoints(fullTiles);
    const maxTurns = opts.maxTurns || MAX_TURNS;
    const truncated = turns.length > maxTurns;
    const tiles = truncated ? fullTiles.slice(0, turns[maxTurns - 1].i + 1) : fullTiles;
    return {
      target: rect, npc, search: s, approach, turns, truncated, fullTiles, tiles,
      reached: s.found >= 0,
      alternative: s.found < 0 && end >= 0,
      noRoute: end < 0,
      end: tiles[tiles.length - 1],
    };
  }

  // Where the player stands at the end of each tick: 2 route tiles per tick running, 1 walking.
  function tickStops(tiles, run) {
    const step = run ? 2 : 1, last = tiles.length - 1, out = [];
    for (let t = 1, i = 0; i < last; t++) {
      i = Math.min(i + step, last);
      out.push({ tick: t, i, x: tiles[i].x, y: tiles[i].y });
    }
    return out;
  }

  // Every neighbour one step closer that could have discovered (x, y), earliest-expanded first.
  // The earliest one is the tile's parent, i.e. where the route comes from.
  function discoverers(grid, s, x, y) {
    const i = grid.idx(x, y), d = s.dist[i], out = [];
    for (let k = 0; k < 8; k++) {
      const px = x - DIRS[k].dx, py = y - DIRS[k].dy;
      if (!grid.inBounds(px, py)) continue;
      const pi = grid.idx(px, py);
      if (s.dist[pi] !== d - 1 || !grid.canStep(px, py, DIRS[k].dx, DIRS[k].dy)) continue;
      out.push({ x: px, y: py, dir: DIRS[k].name, order: s.order[pi], parent: s.parent[pi], chosen: s.parent[i] === pi });
    }
    return out.sort((a, b) => a.order - b.order);
  }

  // Steps from every tile to (tx, ty). Legal moves between walkable tiles are symmetric, so this is
  // just the same search run from the target.
  function distTo(grid, tx, ty) {
    return search(grid, tx, ty, null).dist;
  }

  // From (x, y), the directions that keep you on a shortest route to the tile `toDist` was built
  // for, in search order. The game's route always takes the first one: its route is the
  // lexicographically smallest shortest route over W < E < S < N < SW < SE < NW < NE.
  function shortestSteps(grid, x, y, toDist) {
    const here = toDist[grid.idx(x, y)], out = [];
    for (let k = 0; k < 8; k++) {
      const d = DIRS[k], nx = x + d.dx, ny = y + d.dy;
      if (!grid.inBounds(nx, ny) || !grid.canStep(x, y, d.dx, d.dy)) continue;
      if (toDist[grid.idx(nx, ny)] === here - 1) out.push({ k, name: d.name, x: nx, y: ny });
    }
    return out;
  }

  // Valid melee tiles the player can reach, in the order the game would prefer them.
  function meleeCandidates(grid, result) {
    const s = result.search, out = [];
    for (let y = 0; y < grid.h; y++) {
      for (let x = 0; x < grid.w; x++) {
        const i = grid.idx(x, y);
        if (s.dist[i] >= 0 && meleeReach(grid, x, y, result.target)) out.push({ x, y, dist: s.dist[i], order: s.order[i] });
      }
    }
    return out.sort((a, b) => a.dist - b.dist || a.order - b.order);
  }

  // Compare a traced route (clicked tiles, excluding the start) with the game's route.
  function diagnoseTrace(grid, result, clicks) {
    const truth = result.tiles;
    const user = [truth[0]].concat(clicks);
    const same = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y;
    let firstDiff = -1;
    for (let i = 1; i < Math.max(user.length, truth.length); i++) {
      if (!same(user[i], truth[i])) { firstDiff = i; break; }
    }
    if (firstDiff < 0) return { correct: true };
    for (let i = 1; i < user.length; i++) {
      const a = user[i - 1], b = user[i], dx = b.x - a.x, dy = b.y - a.y;
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== 1) return { correct: false, kind: 'jump', firstDiff, step: i };
      const why = grid.stepBlocker(a.x, a.y, dx, dy);
      if (why) return { correct: false, kind: 'illegal', firstDiff, step: i, from: a, to: b, why };
    }
    if (!same(user[user.length - 1], truth[truth.length - 1])) return { correct: false, kind: 'incomplete', firstDiff };
    if (user.length !== truth.length) {
      return { correct: false, kind: 'longer', firstDiff, userSteps: user.length - 1, trueSteps: truth.length - 1 };
    }
    // Same length, same end: read both routes backwards to the first tile they enter differently.
    let j = 1;
    while (same(user[user.length - 1 - j], truth[truth.length - 1 - j])) j++;
    const T = truth[truth.length - j], A = truth[truth.length - 1 - j], B = user[user.length - 1 - j];
    return { correct: false, kind: 'tiebreak', firstDiff, T, A, B, options: discoverers(grid, result.search, T.x, T.y) };
  }

  return {
    DIRS, ALT_RANGE, ALT_MAX_DIST, MAX_TURNS, Grid,
    dirName, search, findPath, closestApproach, meleeReach, meleeTileIssue, meleeCandidates,
    rectDist2, turnPoints, tickStops, discoverers, diagnoseTrace, distTo, shortestSteps,
  };
});
