/* OSRS Pathing Trainer: quiz flow, explanations, rendering, sandbox. */
(function () {
  'use strict';
  const E = window.PathEngine, S = window.Scenarios;
  const $ = (id) => document.getElementById(id);
  const cv = $('cv'), ctx = cv.getContext('2d');

  const MODES = [
    { id: 'trace', label: 'Trace' },
    { id: 'step', label: 'Tie-breaks' },
    { id: 'tick', label: 'Tick' },
    { id: 'unreach', label: 'Unreachable' },
    { id: 'melee', label: 'Melee' },
    { id: 'mixed', label: 'Mixed' },
    { id: 'misses', label: 'Misses' },
    { id: 'sandbox', label: 'Sandbox' },
    { id: 'explore', label: 'Explore' },
    { id: 'dodge', label: 'Dodge' },
  ];
  const QUIZ = ['trace', 'step', 'tick', 'unreach', 'melee'];
  const NAME = { trace: 'Trace', step: 'Tie-breaks', tick: 'Tick', unreach: 'Unreachable', melee: 'Melee', all: 'All' };
  const TERRAIN_NAME = { any: 'Any', pillars: 'Pillars', rocks: 'Rocks', walls: 'Walls & fences', rooms: 'Rooms', mixed: 'Mixed' };
  const OVERLAYS = ['none', 'dist', 'order'];
  const TICK_MS = 600;
  const STORE = 'osrsPathingTrainer.v1';
  const C = {
    ground1: '#34412f', ground2: '#303c2b', gridLine: 'rgba(0,0,0,0.28)',
    rock: '#6d6155', rockTop: '#7d7062', rockEdge: '#3f372f', wall: '#eadbb2', wallEdge: '#2a241c',
    player: '#3fd0ff', avatar: '#f4f4f4', target: '#ffd84a', npc: '#ff5a4f',
    route: '#5ee08a', user: '#7aa7ff', bad: '#ff5a4f', good: '#5ee08a', muted: '#c9d1d9',
  };

  const same = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y;
  const signed = (n) => (n > 0 ? '+' + n : n < 0 ? '−' + -n : '0');
  const rel = (t, o) => `(${signed(t.x - o.x)}, ${signed(t.y - o.y)})`;
  const inRect = (t, r) => t.x >= r.x && t.x < r.x + r.w && t.y >= r.y && t.y < r.y + r.h;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  // ---- state ------------------------------------------------------------------------------

  function load() {
    try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { return {}; }
  }
  const saved = load();
  const st = {
    mode: MODES.some((m) => m.id === saved.mode) ? saved.mode : 'trace',
    terrain: TERRAIN_NAME[saved.terrain] ? saved.terrain : 'any',
    size: [12, 16, 20].includes(saved.size) ? saved.size : 16,
    run: saved.run !== false,
    level: [1, 2, 3].includes(saved.level) ? saved.level : 1,
    overlay: OVERLAYS.includes(saved.overlay) ? saved.overlay : 'none',
    stats: saved.stats || {},
    misses: Array.isArray(saved.misses) ? saved.misses : [],
    q: null, phase: 'ask', clicks: [], pick: null, verdict: null, stepIdx: 0, stepLog: [],
    hover: null, anim: null, raf: 0, ts: 32, mouseDown: false,
    ex: { grid: null, pos: null, npcs: [], route: [], pending: null, seg: null, dest: null, click: null,
      tick: 0, tickAt: 0, timer: 0, raf: 0, showPath: true, last: null },
    dg: { grid: null, pos: null, npcs: [], route: [], pending: null, seg: null, dest: null, click: null,
      tick: 0, tickAt: 0, timer: 0, raf: 0, showPath: true, last: null, hazards: true,
      hp: 99, hits: 0, splats: [], wave: 0, nextWave: 3, dead: false, paused: false, hitFx: null,
      showStops: true, best: saved.dodgeBest || 0, rng: null,
      style: ['acid', 'puzzle', 'survival'].includes(saved.dodgeStyleV2) ? saved.dodgeStyleV2 : 'acid',
      preview: false, puzzle: null, trail: [], acid: null, boss: null, acidAmount: saved.acidAmount || 'medium',
      ac: saved.acidStats || { n: 0, clean: 0, best: 0, streak: 0 },
      pz: saved.dodgePuzzle || { n: 0, ok: 0, streak: 0, best: 0 } },
    sb: { grid: null, src: null, npc: null, goal: null, res: null, search: null, tool: 'walk', npcSize: 2, paint: null },
  };
  if (saved.sandbox) {
    try {
      st.sb.grid = E.Grid.fromJSON(saved.sandbox.grid);
      st.sb.src = saved.sandbox.src;
      st.sb.npc = saved.sandbox.npc || null;
    } catch (e) { st.sb.grid = null; }
  }

  function persist() {
    const sb = st.sb;
    try {
      localStorage.setItem(STORE, JSON.stringify({
        mode: st.mode, dodgeBest: st.dg.best, dodgeStyleV2: st.dg.style, dodgePuzzle: st.dg.pz, acidAmount: st.dg.acidAmount, acidStats: st.dg.ac, level: st.level, terrain: st.terrain, size: st.size, run: st.run, overlay: st.overlay,
        stats: st.stats, misses: st.misses,
        sandbox: sb.grid ? { grid: sb.grid.toJSON(), src: sb.src, npc: sb.npc } : null,
      }));
    } catch (e) { /* storage full or disabled: the session still works */ }
  }

  function stat(m) {
    return st.stats[m] || (st.stats[m] = { n: 0, ok: 0, streak: 0, best: 0, ms: 0 });
  }
  function record(mode, ok, ms) {
    for (const k of [mode, 'all']) {
      const s = stat(k);
      s.n++;
      if (ok) { s.ok++; s.streak++; s.best = Math.max(s.best, s.streak); s.ms += ms; } else s.streak = 0;
    }
  }

  // Wrong answers are kept (by seed) for the Misses mode; a right answer removes them.
  const specKey = (s) => `${s.mode}|${s.level || 3}|${s.terrain}|${s.size}|${s.run}|${s.seed}`;
  function noteResult(q, ok) {
    const k = specKey(q.spec), i = st.misses.findIndex((s) => specKey(s) === k);
    if (ok) { if (i >= 0) st.misses.splice(i, 1); return; }
    if (i >= 0) st.misses.push(st.misses.splice(i, 1)[0]);
    else st.misses.push(Object.assign({}, q.spec));
    if (st.misses.length > 100) st.misses.shift();
  }

  // Mixed mode leans towards whichever mode you're worst at.
  function pickWeakMode() {
    const w = QUIZ.map((m) => { const s = stat(m); return 1 + 3 * (1 - (s.ok + 1) / (s.n + 2)); });
    let r = Math.random() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < QUIZ.length; i++) if ((r -= w[i]) < 0) return QUIZ[i];
    return QUIZ[QUIZ.length - 1];
  }

  // ---- quiz flow --------------------------------------------------------------------------

  function nextQuestion() {
    stopAnim();
    Object.assign(st, { phase: 'ask', clicks: [], pick: null, verdict: null, q: null, stepIdx: 0, stepLog: [] });
    const replaying = st.mode === 'misses';
    let spec;
    if (replaying) {
      if (!st.misses.length) return render();
      spec = Object.assign({}, st.misses[0]);
    } else {
      spec = { mode: st.mode === 'mixed' ? pickWeakMode() : st.mode, level: st.level, terrain: st.terrain, size: st.size, run: st.run, seed: 0 };
    }
    let q = null;
    for (let tries = 0; !q && tries < (replaying ? 1 : 6); tries++) {
      if (!replaying) spec.seed = (Math.random() * 4294967296) >>> 0;
      q = S.generate(spec.mode, spec);
    }
    if (!q) {
      toast("Couldn't build that question.");
      if (replaying) st.misses.shift();
      return render();
    }
    q.spec = spec;
    q.t0 = performance.now();
    st.q = q;
    render();
  }

  function quizClick(t) {
    const q = st.q;
    if (!q || st.phase !== 'ask') return;
    if (q.grid.isBlocked(t.x, t.y)) return toast('That tile is blocked');
    if (q.mode === 'step') {
      const tiles = q.result.tiles, cur = tiles[st.stepIdx], next = tiles[st.stepIdx + 1];
      if (Math.max(Math.abs(t.x - cur.x), Math.abs(t.y - cur.y)) !== 1) return toast('Pick a tile next to you');
      const ok = same(t, next);
      st.stepLog.push({ i: st.stepIdx, ok, from: cur, user: t, why: ok ? '' : stepWhy(q, cur, next, t) });
      st.stepIdx++;
      if (st.stepIdx >= tiles.length - 1) return finish();
      return render();
    }
    if (q.mode !== 'trace') { st.pick = t; return finish(); }
    const last = st.clicks.length ? st.clicks[st.clicks.length - 1] : q.src;
    if (st.clicks.length && same(t, last)) { st.clicks.pop(); return render(); }
    if (same(t, q.src) && !st.clicks.length) return;
    if (Math.max(Math.abs(t.x - last.x), Math.abs(t.y - last.y)) !== 1) return toast('Pick a tile next to your last step');
    st.clicks.push(t);
    if (same(t, q.target) || st.clicks.length >= 40) return finish();
    render();
  }

  function undo() {
    if (st.mode === 'sandbox' || !st.q || st.phase !== 'ask' || st.q.mode !== 'trace') return;
    st.clicks.pop();
    render();
  }

  function finish() {
    const q = st.q;
    if (!q || st.phase !== 'ask') return;
    const ms = performance.now() - q.t0;
    const v = judge(q);
    v.ms = ms;
    st.verdict = v;
    st.phase = 'done';
    record(q.mode, v.correct, ms);
    noteResult(q, v.correct);
    persist();
    startAnim(q.result.tiles, q.run);
    render();
  }

  // ---- judging and explanations ------------------------------------------------------------

  const WHY = {
    blocked: 'it walks onto a blocked tile.',
    wall: 'it walks through a wall.',
    corner: 'it cuts a corner. A diagonal step needs both tiles beside it to be walkable.',
    cornerWall: 'a wall touches the corner it passes. Any wall at that corner blocks the diagonal.',
  };

  function judge(q) {
    if (q.mode === 'trace') return judgeTrace(q);
    if (q.mode === 'step') return judgeStep(q);
    if (q.mode === 'tick') return judgeTick(q);
    if (q.mode === 'unreach') return judgeUnreach(q);
    return judgeMelee(q);
  }

  function judgeTrace(q) {
    const d = E.diagnoseTrace(q.grid, q.result, st.clicks);
    const v = { correct: d.correct, d, marks: [] };
    if (d.correct) { v.body = "<p>Every step matches the game's route.</p>"; return v; }
    if (d.kind === 'illegal') {
      v.body = `<p>Step ${d.step} isn't allowed: ${WHY[d.why]}</p>`;
      v.marks.push({ x: d.to.x, y: d.to.y, label: '!', color: C.bad });
    } else if (d.kind === 'incomplete') {
      v.body = "<p>Your trace stops before the X. The green line is the game's full route.</p>";
    } else if (d.kind === 'longer') {
      v.body = `<p>Your route takes ${d.userSteps} steps; the game's takes ${d.trueSteps}. You always walk a route with the fewest steps, and a diagonal counts as one step.</p>`;
    } else if (d.kind === 'tiebreak') {
      const i = d.firstDiff, tr = q.result.tiles, user = [q.src].concat(st.clicks);
      v.body = `<p>Your route is just as short, so the tie-break decides it. The routes split at step ${i}.</p>` + stepWhy(q, tr[i - 1], tr[i], user[i]);
      v.marks.push({ x: tr[i].x, y: tr[i].y, label: 'game', color: C.good }, { x: user[i].x, y: user[i].y, label: 'you', color: C.user });
    } else {
      v.body = "<p>Your trace skips a tile. The green line is the game's route.</p>";
    }
    v.body += `<p class="tip">${RULE}</p>`;
    return v;
  }

  const RULE = 'Tie-break rule: at every step, take the first direction in W, E, S, N, SW, SE, NW, NE that still keeps you on a shortest route. Straight directions come before diagonals, so you go straight whenever a straight step still works.';
  const ORDINAL = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];

  function toDistOf(q) {
    const end = q.result.tiles[q.result.tiles.length - 1];
    return q.toDist || (q.toDist = E.distTo(q.grid, end.x, end.y));
  }

  // Why the game steps from `from` to `gameTo` rather than to `userTo`.
  function stepWhy(q, from, gameTo, userTo) {
    const g = q.grid, toDist = toDistOf(q);
    const opts = E.shortestSteps(g, from.x, from.y, toDist);
    const dir = (to) => E.dirName(to.x - from.x, to.y - from.y);
    const game = dir(gameTo), user = dir(userTo);
    const blocker = g.stepBlocker(from.x, from.y, userTo.x - from.x, userTo.y - from.y);
    let why;
    if (blocker) why = `${user} isn't possible: ${WHY[blocker]}`;
    else if (!opts.some((o) => o.name === user)) {
      const left = toDist[g.idx(userTo.x, userTo.y)];
      why = left < 0 ? "You can't reach the end from that tile."
        : `${user} doesn't keep you on a shortest route. It costs ${plural(1 + left - toDist[g.idx(from.x, from.y)], 'extra step')}.`;
    } else why = `${user} also keeps you on a shortest route, but ${game} comes earlier in the order.`;
    const list = opts.map((o) => `<b>${o.name}</b> (${ORDINAL[o.k]})`).join(', ');
    return `<p>You went <b>${user}</b> and the game goes <b>${game}</b>. ${why} From that tile, ${opts.length > 1 ? 'the steps that keep you on a shortest route are' : 'the only step that keeps you on a shortest route is'} ${list}.</p>`;
  }

  function judgeStep(q) {
    const total = q.result.tiles.length - 1, wrong = st.stepLog.filter((s) => !s.ok);
    const missing = total - st.stepLog.length;
    const v = { correct: wrong.length === 0 && missing === 0, marks: [] };
    let h = `<p>${st.stepLog.length - wrong.length} of ${plural(total, 'step')} right${missing ? ` (${missing} not answered)` : ''}.</p>`;
    for (const s of wrong) h += `<p class="meta">Step ${s.i + 1}</p>${s.why}`;
    v.body = h + `<p class="tip">${RULE}</p>`;
    return v;
  }

  // Marks for the last wrong step: every tied option, labelled with its place in the order.
  function stepMarks(q) {
    const s = st.stepLog[st.stepLog.length - 1];
    if (!s || s.ok) return null;
    const opts = E.shortestSteps(q.grid, s.from.x, s.from.y, toDistOf(q));
    const marks = opts.map((o, j) => ({ x: o.x, y: o.y, label: ORDINAL[o.k], color: j === 0 ? C.good : C.muted }));
    if (!opts.some((o) => same(o, s.user))) marks.push({ x: s.user.x, y: s.user.y, label: '✗', color: C.bad });
    return marks;
  }

  function judgeTick(q) {
    const p = st.pick, tiles = q.result.tiles, step = q.run ? 2 : 1;
    const stop = E.tickStops(tiles, q.run)[q.tick - 1];
    const v = { correct: same(p, q.answer), marks: [{ x: stop.x, y: stop.y, label: 't' + q.tick, color: C.target }] };
    let h = '';
    if (!v.correct) {
      const i = p ? tiles.findIndex((t) => same(t, p)) : -2;
      if (i === -2) h += '<p>No answer given.</p>';
      else if (i < 0) h += "<p>Your route doesn't pass over that tile. The green line is the route the game takes.</p>";
      else if (i % step === 0 || i === tiles.length - 1) h += `<p>You do stand there, but at the end of tick ${Math.ceil(i / step)}, not tick ${q.tick}.</p>`;
      else h += `<p>You run over that tile mid-tick (step ${i}), but no tick ends with you on it.</p>`;
      if (q.run && i === q.tick) h += '<p>That is where walking would put you. Running covers 2 tiles per tick.</p>';
    }
    h += `<p>The end of tick ${q.tick} is step ${stop.i} of the route (${plural(step, 'tile')} per tick ${q.run ? 'running' : 'walking'}).</p>`;
    v.body = h;
    return v;
  }

  function table(head, rows) {
    return `<table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${rows.map((r) =>
      `<tr class="${r.cls}">${r.cells.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;
  }

  function judgeUnreach(q) {
    const p = st.pick, r = q.result, ap = r.approach, best = ap.best, X = q.target, g = q.grid;
    const v = { correct: same(p, r.end), marks: [] };
    const mine = p ? ap.candidates.find((c) => same(c, p)) : null;
    const shown = ap.candidates.slice(0, 5);
    if (mine && !shown.includes(mine)) shown.push(mine);
    const d2 = (c) => { const dx = Math.abs(c.x - X.x), dy = Math.abs(c.y - X.y); return `${dx}²+${dy}² = ${dx * dx + dy * dy}`; };
    let h = '';
    if (!v.correct) {
      if (!p) h += '<p>No answer given.</p>';
      else if (!mine) {
        const d = r.search.dist[g.idx(p.x, p.y)];
        h += d < 0 ? "<p>You can't reach that tile at all.</p>" : '<p>That tile is outside the 21×21 square the game searches around the X.</p>';
      } else if (mine.cost > best.cost) h += `<p>Your tile is further from the X in a straight line: ${d2(mine)} vs ${d2(best)}.</p>`;
      else if (mine.dist > best.dist) h += `<p>Your tile is the same straight-line distance from the X, but ${mine.dist} steps away vs ${best.dist}. Fewer steps wins the tie.</p>`;
      else h += '<p>That is an exact tie on distance and steps. The game scans west to east, and south to north within each column, and keeps the first tile it finds. So the westmost tile wins, then the southmost.</p>';
    }
    h += table(['#', 'Tile (from X)', 'dx²+dy²', 'Steps'], shown.map((c) => {
      const rank = ap.candidates.indexOf(c) + 1;
      v.marks.push({ x: c.x, y: c.y, label: String(rank), color: c === best ? C.good : C.muted });
      return { cls: (c === best ? 'win ' : '') + (c === mine ? 'you' : ''), cells: [rank, rel(c, X), d2(c), c.dist] };
    }));
    h += '<p class="tip">Unreachable click: you go to the reachable tile closest to the X in a straight line (dx² + dy²) within a 21×21 square. Ties go to fewer steps, then the westmost tile, then the southmost.</p>';
    v.body = h;
    return v;
  }

  function judgeMelee(q) {
    const p = st.pick, r = q.result, g = q.grid, npc = q.target;
    const cands = E.meleeCandidates(g, r), best = cands[0];
    const v = { correct: same(p, r.end), marks: [] };
    const mine = p ? cands.find((c) => same(c, p)) : null;
    const shown = cands.slice(0, 5);
    if (mine && !shown.includes(mine)) shown.push(mine);
    let h = '';
    if (!v.correct) {
      const issue = p ? E.meleeTileIssue(g, p.x, p.y, npc) : 'none';
      if (!p) h += '<p>No answer given.</p>';
      else if (issue === 'inside') h += "<p>You can't attack from under the NPC.</p>";
      else if (issue === 'corner') h += '<p>That tile only touches a corner of the NPC. Melee needs a tile that shares an edge with it.</p>';
      else if (issue === 'far') h += "<p>That tile isn't next to the NPC.</p>";
      else if (issue === 'wall') h += "<p>A wall sits between that tile and the NPC, so you can't hit it from there.</p>";
      else if (!mine) h += "<p>You can't reach that tile.</p>";
      else if (mine.dist > best.dist) h += `<p>That attack tile is ${plural(mine.dist, 'step')} away and the nearest is ${best.dist}. You stop on the first attack tile you reach.</p>`;
      else h += `<p>Both are ${plural(best.dist, 'step')} away. The search reached the answer first (#${best.order} vs #${mine.order}), because from each tile it tries W, E, S, N, SW, SE, NW, NE in that order.</p>`;
    }
    h += table(['#', 'Tile (from you)', 'Steps', 'Search #'], shown.map((c) => {
      const rank = cands.indexOf(c) + 1;
      v.marks.push({ x: c.x, y: c.y, label: String(rank), color: c === best ? C.good : C.muted });
      return { cls: (c === best ? 'win ' : '') + (c === mine ? 'you' : ''), cells: [rank, rel(c, q.src), c.dist, c.order] };
    }));
    h += "<p class=\"tip\">Melee: you stop on the first tile the search reaches that shares an edge with the NPC. Corners don't count, and neither do tiles with a wall in between. From a diagonal you step west or east before you'd step south or north.</p>";
    v.body = h;
    return v;
  }

  // ---- panels -----------------------------------------------------------------------------

  // Shown on Beginner and Easy questions.
  const HINT = {
    step: "at every step, take the first direction in W, E, S, N, SW, SE, NW, NE that still keeps you on a shortest route. So go straight whenever a straight step still works, and when two straight steps both work, W beats E beats S beats N.",
    trace: "you always take the fewest steps, and a diagonal step counts as one. With nothing in the way you do the straight part first and the diagonal steps last. You can't cut a corner past a rock.",
    tick: "work out the route first, then count along it. Running covers 2 tiles per tick (tick 1 ends 2 steps in, tick 2 ends 4 steps in). Walking covers 1.",
    unreach: "you walk to the reachable tile closest to the X in a straight line. A tile straight beside the rock beats a diagonal one. If two tie, the one with fewer steps wins, then the westmost.",
    melee: "you stop on the nearest tile that shares an edge with the NPC. Corners don't count. If two are equally close and you're diagonal to the NPC, you step west or east rather than south or north.",
  };

  function promptHTML(q) {
    const ask = st.phase === 'ask';
    let title, text;
    if (q.mode === 'step') {
      const total = q.result.tiles.length - 1;
      title = ask ? `Tie-breaks: step ${st.stepIdx + 1} of ${total}` : 'Tie-breaks';
      text = 'You click the <b class="y">yellow X</b>. Walk there one step at a time: click the tile you step onto next. Each step is checked as you go.';
    } else if (q.mode === 'trace') {
      title = 'Trace the route';
      text = "You click the <b class=\"y\">yellow X</b>. Click every tile you'll step on, in order, ending on the X.";
    } else if (q.mode === 'tick') {
      title = `Where are you after tick ${q.tick}?`;
      text = `You click the <b class="y">yellow X</b> while <b>${q.run ? 'running' : 'walking'}</b>. Click the tile you'll be standing on at the end of <b>tick ${q.tick}</b>.`;
    } else if (q.mode === 'unreach') {
      title = 'Unreachable click';
      text = "You click the <b class=\"y\">yellow X</b>, but you can't reach it. Click the tile you'll end up on.";
    } else {
      title = 'Melee approach';
      text = `You click <b>Attack</b> on the <b class="r">${q.target.w}×${q.target.h} NPC</b> with a melee weapon. Click the tile you'll stop on.`;
    }
    const hint = (q.mode === 'trace' && ask ? '<p class="hint">Backspace or right-click undoes a step. Enter submits early.</p>' : '') +
      (q.level < 3 || q.mode === 'step' ? `<p class="tip"><b>Rule:</b> ${HINT[q.mode]}</p>` : '');
    const last = q.mode === 'step' && ask ? st.stepLog[st.stepLog.length - 1] : null;
    const feedback = last ? (last.ok ? `<p class="verdict ok">✓ Step ${last.i + 1} right</p>` : `<p class="verdict bad">✗ Step ${last.i + 1}</p>${last.why}<p class="hint">You've been moved to the game's tile. Keep going.</p>`) : '';
    const btns = ask ? `<div class="row">${q.mode === 'trace' ? '<button data-act="undo">Undo</button><button data-act="submit">Submit</button>' : ''}<button data-act="reveal">Show answer</button><button data-act="skip">Skip <kbd>N</kbd></button></div>` : '';
    const label = st.mode === 'mixed' || st.mode === 'misses' ? `${NAME[q.mode]} · ` : '';
    const where = q.level < 3 ? S.LEVELS[q.level].name : TERRAIN_NAME[q.terrain];
    return `<h2>${title}</h2><p>${text}</p>${hint}${feedback}${btns}<p class="meta">${label}${where} · ${q.size}×${q.size} · seed ${q.seed}</p>`;
  }

  function resultHTML(q, v) {
    const steps = q.result.tiles.length - 1;
    return `<div class="verdict ${v.correct ? 'ok' : 'bad'}">${v.correct ? '✓ Correct' : '✗ Not quite'}</div>${v.body}` +
      `<p class="meta">Route: ${plural(steps, 'step')}, which is ${plural(Math.ceil(steps / 2), 'tick')} running or ${steps} walking. You answered in ${(v.ms / 1000).toFixed(1)}s.</p>` +
      '<div class="row"><button class="primary" data-act="next">Next <kbd>Enter</kbd></button><button data-act="replay">Replay <kbd>A</kbd></button></div>';
  }

  function statsHTML() {
    const rows = QUIZ.concat('all').map((m) => {
      const s = stat(m);
      return {
        cls: m === 'all' ? 'total' : '',
        cells: [NAME[m], `${s.ok}/${s.n}`, s.n ? Math.round((100 * s.ok) / s.n) + '%' : '–', s.streak, s.best,
          s.ok ? (s.ms / s.ok / 1000).toFixed(1) + 's' : '–'],
      };
    });
    return '<div class="row spread"><h2>Stats</h2><button class="small" data-act="resetStats">Reset</button></div>' +
      table(['Mode', 'Right', '%', 'Streak', 'Best', 'Avg time'], rows);
  }

  function renderSandboxInfo() {
    const sb = st.sb, r = sb.res;
    let h;
    if (!r) h = '<p>Pick <b>Walk</b> and click a tile to see the route, or click the NPC to attack it.</p>';
    else if (r.noRoute) h = '<p>Nothing reachable near there.</p>';
    else {
      const steps = r.tiles.length - 1;
      const what = r.npc ? (r.reached ? 'Melee tile' : "Can't reach melee range, so you take the closest approach")
        : r.reached ? 'Walk to the tile' : 'Unreachable, so you take the closest approach';
      h = `<p><b>${what}</b> at ${rel(r.end, sb.src)} from the start.</p>`;
      if (r.alternative) h += `<p>dx²+dy² = ${r.approach.best.cost}, ${plural(r.approach.best.dist, 'step')}.</p>`;
      h += `<p class="meta">${plural(steps, 'step')}, which is ${plural(Math.ceil(steps / 2), 'tick')} running or ${steps} walking. ${plural(r.turns.length, 'turn point')}${r.truncated ? ', so the route is cut at 25 turns' : ''}.</p>`;
    }
    $('sbInfo').innerHTML = h;
  }

  function renderNav() {
    $('modes').innerHTML = MODES.map((m, i) =>
      `<button data-mode="${m.id}" class="${st.mode === m.id ? 'active' : ''}" title="Key ${i + 1}">${m.id === 'misses' ? `Misses (${st.misses.length})` : m.label}</button>`).join('');
    document.querySelectorAll('.tools button').forEach((b) => b.classList.toggle('active', b.dataset.tool === st.sb.tool));
  }

  function render() {
    renderNav();
    const sandbox = st.mode === 'sandbox', explore = isRoam();
    $('sandboxPanel').classList.toggle('hidden', !sandbox);
    $('explorePanel').classList.toggle('hidden', st.mode !== 'explore');
    $('dodgePanel').classList.toggle('hidden', st.mode !== 'dodge');
    $('promptCard').classList.toggle('hidden', sandbox || explore);
    $('statsCard').classList.toggle('hidden', sandbox || explore);
    if (explore) {
      $('resultCard').classList.add('hidden');
      renderExploreInfo();
    } else if (sandbox) {
      $('resultCard').classList.add('hidden');
      renderSandboxInfo();
    } else {
      const q = st.q, rc = $('resultCard');
      $('promptCard').innerHTML = q ? promptHTML(q) : st.mode === 'misses'
        ? '<h2>Misses</h2><p>Nothing to retry yet. Questions you get wrong land here, and each one drops off once you get it right.</p>'
        : '<p>Loading…</p>';
      if (q && st.phase === 'done') { rc.innerHTML = resultHTML(q, st.verdict); rc.classList.remove('hidden'); }
      else rc.classList.add('hidden');
      $('statsCard').innerHTML = statsHTML();
    }
    const simple = !sandbox && !explore && st.level < 3;
    for (const id of ['terrain', 'size']) {
      $(id).disabled = simple || (explore && id === 'size') || (st.mode === 'dodge' && id === 'terrain');
      $(id).title = simple ? 'Beginner and Easy use their own small maps. Switch Level to Normal to choose.' : '';
    }
    $('overlay').value = st.overlay;
    $('overlay').disabled = explore || (!sandbox && st.phase !== 'done');
    $('overlay').title = $('overlay').disabled ? 'Overlays unlock after you answer' : '';
    layout();
    draw();
    renderHover();
  }

  function renderHover() {
    const el = $('hover'), v = view(), h = st.hover;
    if (!v || !h) { el.innerHTML = 'Hover a tile for details.'; return; }
    const g = v.g;
    let s = `Tile ${rel(h, v.src)} from you`;
    if (g.isBlocked(h.x, h.y)) s += ' · blocked';
    else if (v.search) {
      const i = g.idx(h.x, h.y), d = v.search.dist[i];
      if (d < 0) s += ' · unreachable';
      else {
        s += ` · ${plural(d, 'step')} · search #${v.search.order[i]}`;
        if (v.search.via[i] >= 0) s += ` · entered by a ${E.DIRS[v.search.via[i]].name} step`;
      }
    }
    el.textContent = s;
  }

  let toastTimer = 0;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
  }

  // ---- sandbox ----------------------------------------------------------------------------

  function freeNear(g, x, y) {
    for (let r = 0; r < Math.max(g.w, g.h); r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) === r && g.inBounds(x + dx, y + dy) && !g.isBlocked(x + dx, y + dy)) return { x: x + dx, y: y + dy };
        }
      }
    }
    g.setBlocked(x, y, false);
    return { x, y };
  }

  function newSandboxMap(random) {
    const sb = st.sb, rng = S.makeRng((Math.random() * 4294967296) >>> 0);
    const style = st.terrain === 'any' ? rng.pick(S.TERRAINS) : st.terrain;
    sb.grid = random ? S.genTerrain(rng, st.size, style) : new E.Grid(st.size, st.size);
    sb.npc = null;
    sb.goal = null;
    sb.src = freeNear(sb.grid, Math.floor(st.size / 2), Math.floor(st.size / 2));
    recomputeSandbox(false);
  }

  function initSandbox() {
    const sb = st.sb;
    if (!sb.grid || sb.grid.w !== st.size || !sb.src) newSandboxMap(true);
    else recomputeSandbox(false);
  }

  function recomputeSandbox(animate) {
    const sb = st.sb;
    sb.res = sb.goal ? E.findPath(sb.grid, sb.src, sb.goal) : null;
    sb.search = sb.res ? sb.res.search : E.search(sb.grid, sb.src.x, sb.src.y, null);
    if (sb.res && animate) startAnim(sb.res.tiles, st.run);
    else stopAnim();
    persist();
    renderSandboxInfo();
    draw();
    renderHover();
  }

  function edgeAt(t) {
    const near = [['W', t.fx], ['E', 1 - t.fx], ['S', t.fy], ['N', 1 - t.fy]].sort((a, b) => a[1] - b[1])[0][0];
    if (near === 'E') return { k: 'E', x: t.x, y: t.y };
    if (near === 'W') return { k: 'E', x: t.x - 1, y: t.y };
    if (near === 'N') return { k: 'N', x: t.x, y: t.y };
    return { k: 'N', x: t.x, y: t.y - 1 };
  }
  const getEdge = (g, e) => (e.k === 'E' ? g.hasWallE(e.x, e.y) : g.hasWallN(e.x, e.y));
  const setEdge = (g, e, v) => (e.k === 'E' ? g.setWallE(e.x, e.y, v) : g.setWallN(e.x, e.y, v));

  function sandboxDown(t) {
    const sb = st.sb, g = sb.grid, tile = { x: t.x, y: t.y };
    if (sb.tool === 'walk') {
      sb.goal = sb.npc && inRect(tile, sb.npc) ? Object.assign({}, sb.npc) : { x: t.x, y: t.y, w: 1, h: 1, kind: 'tile' };
      return recomputeSandbox(true);
    }
    if (sb.tool === 'rock') {
      if (same(tile, sb.src)) return toast("Move the player before blocking this tile");
      sb.paint = { kind: 'rock', v: !g.blocked[g.idx(t.x, t.y)] };
      g.setBlocked(t.x, t.y, sb.paint.v);
      return recomputeSandbox(false);
    }
    if (sb.tool === 'wall') {
      const e = edgeAt(t);
      sb.paint = { kind: 'wall', v: !getEdge(g, e) };
      setEdge(g, e, sb.paint.v);
      return recomputeSandbox(false);
    }
    if (sb.tool === 'player') {
      if (g.isBlocked(t.x, t.y)) return toast('That tile is blocked');
      sb.src = tile;
      return recomputeSandbox(false);
    }
    if (sb.tool === 'npc') {
      if (sb.npc && inRect(tile, sb.npc)) sb.npc = null;
      else {
        const n = sb.npcSize;
        sb.npc = { x: Math.min(t.x, g.w - n), y: Math.min(t.y, g.h - n), w: n, h: n, kind: 'npc' };
      }
      if (sb.goal && sb.goal.kind === 'npc') sb.goal = sb.npc ? Object.assign({}, sb.npc) : null;
      return recomputeSandbox(false);
    }
  }

  function sandboxDrag(t) {
    const sb = st.sb, g = sb.grid, p = sb.paint;
    if (!g.inBounds(t.x, t.y)) return;
    if (p.kind === 'rock') {
      if (same(t, sb.src) || g.blocked[g.idx(t.x, t.y)] === (p.v ? 1 : 0)) return;
      g.setBlocked(t.x, t.y, p.v);
    } else {
      const e = edgeAt(t);
      if (getEdge(g, e) === p.v) return;
      setEdge(g, e, p.v);
    }
    recomputeSandbox(false);
  }

  function setTool(tool) {
    st.sb.tool = tool;
    renderNav();
  }

  // ---- explore: free roam on game ticks --------------------------------------------------------
  // Clicks are picked up on the next tick and routed from the true tile (where the server has you),
  // then you move 2 route tiles per tick running, 1 walking. The drawn avatar catches up over the
  // tick, like the game client.

  const EXPLORE_SIZE = 24;
  const isRoam = (m) => (m || st.mode) === 'explore' || (m || st.mode) === 'dodge';
  const roam = () => (st.mode === 'dodge' ? st.dg : st.ex);

  function newExploreMap() {
    if (st.mode === 'dodge') return newDodge();
    const ex = st.ex, rng = S.makeRng((Math.random() * 4294967296) >>> 0);
    const style = st.terrain === 'any' ? rng.pick(S.TERRAINS) : st.terrain;
    ex.grid = S.genTerrain(rng, EXPLORE_SIZE, style);
    ex.pos = freeNear(ex.grid, EXPLORE_SIZE >> 1, EXPLORE_SIZE >> 1);
    ex.npcs = [];
    for (let tries = 0; ex.npcs.length < 3 && tries < 300; tries++) {
      const n = rng.pick([1, 2, 3]), x = rng.int(1, EXPLORE_SIZE - n - 1), y = rng.int(1, EXPLORE_SIZE - n - 1);
      const r = { x, y, w: n, h: n, kind: 'npc' };
      let ok = !inRect(ex.pos, r) && !ex.npcs.some((o) => x < o.x + o.w + 1 && o.x < x + n + 1 && y < o.y + o.h + 1 && o.y < y + n + 1);
      for (let j = 0; j < n && ok; j++) for (let i = 0; i < n && ok; i++) if (ex.grid.isBlocked(x + i, y + j)) ok = false;
      if (ok) ex.npcs.push(r);
    }
    Object.assign(ex, { route: [], pending: null, seg: null, dest: null, click: null, tick: 0, last: null });
  }

  function startExplore() {
    const ex = roam();
    if (!ex.grid) newExploreMap();
    stopExplore();
    ex.tickAt = performance.now();
    ex.timer = setInterval(exploreTick, TICK_MS);
    const loop = () => {
      if (!isRoam() || roam() !== ex) return;
      draw();
      ex.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  function stopExplore() {
    for (const ex of [st.ex, st.dg]) {
      clearInterval(ex.timer);
      cancelAnimationFrame(ex.raf);
      ex.timer = 0;
    }
  }

  function exploreTick() {
    const ex = roam();
    if (ex.hazards && (ex.paused || ex.dead)) return;
    ex.tick++;
    ex.tickAt = performance.now();
    if (ex.pending) {
      if (ex.acid && !ex.acid.done) ex.acid.clicks++;
      const res = E.findPath(ex.grid, ex.pos, ex.pending);
      ex.route = res.tiles.slice(1);
      ex.dest = ex.route.length ? res.end : null;
      ex.last = { steps: ex.route.length, alternative: res.alternative, npc: res.npc, reached: res.reached, truncated: res.truncated };
      ex.pending = null;
    }
    const seg = [ex.pos];
    for (let n = st.run ? 2 : 1; n > 0 && ex.route.length; n--) seg.push(ex.route.shift());
    ex.seg = seg;
    ex.pos = seg[seg.length - 1];
    if (!ex.route.length) ex.dest = null;
    if (ex.hazards) dodgeTick(ex, seg);
    renderExploreInfo();
  }

  function exploreClick(t) {
    const ex = roam(), tile = { x: t.x, y: t.y };
    if (ex.dead || (ex.acid && ex.acid.done)) return;
    if (ex.hazards && ex.style === 'puzzle') {
      const pz = ex.puzzle;
      if (!pz || pz.clicked || pz.done) return;
      pz.clicked = tile;
      ex.paused = false;
    }
    const npc = ex.npcs.find((n) => inRect(tile, n));
    ex.pending = npc ? Object.assign({}, npc) : { x: t.x, y: t.y, w: 1, h: 1, kind: 'tile' };
    ex.click = { x: t.x, y: t.y, red: !!npc, at: performance.now() };
  }

  function renderExploreInfo() {
    if (st.mode === 'dodge') return renderDodgeInfo();
    const ex = st.ex, l = ex.last, per = st.run ? 2 : 1;
    let s = `Tick ${ex.tick} · ${st.run ? 'running' : 'walking'}`;
    if (ex.route.length) s += ` · ${plural(ex.route.length, 'step')} left (${plural(Math.ceil(ex.route.length / per), 'tick')})`;
    else if (l) s += ' · arrived';
    if (l) {
      s += ` · last route ${plural(l.steps, 'step')}`;
      if (l.npc) s += l.reached ? ', to melee range' : ', melee range unreachable so closest approach';
      else if (l.alternative) s += ', unreachable so closest approach';
      if (l.truncated) s += ', cut at 25 turns';
    }
    $('exInfo').textContent = s;
  }

  function drawCross(g, t, age, color) {
    const ts = st.ts, x = cx(t.x), y = cy(t.y, g), a = ts * 0.3 * (1 - 0.45 * age);
    ctx.save();
    ctx.globalAlpha = 1 - 0.7 * age;
    ctx.lineCap = 'round';
    for (const [w, c] of [[Math.max(5, ts * 0.17), '#111'], [Math.max(3, ts * 0.1), color]]) {
      ctx.strokeStyle = c;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(x - a, y - a); ctx.lineTo(x + a, y + a);
      ctx.moveTo(x + a, y - a); ctx.lineTo(x - a, y + a);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawExplore(g) {
    const ex = roam(), ts = st.ts, now = performance.now();
    if (ex.hazards) drawSplats(g, ex);
    drawRocks(g);
    drawWalls(g);
    if (ex.hazards && ex.style === 'acid') drawAcidExtras(g, ex);
    ex.npcs.forEach((n) => drawNpc(g, n));
    if (ex.showPath && ex.route.length) {
      ctx.save();
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = 'rgba(94,224,138,0.7)';
      ctx.lineWidth = Math.max(2, ts * 0.07);
      ctx.lineJoin = 'round';
      polyline(g, [ex.pos].concat(ex.route));
      ctx.restore();
    }
    if (ex.dest) {
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 2;
      ctx.strokeRect(px(ex.dest.x) + 2, py(ex.dest.y, g) + 2, ts - 4, ts - 4);
    }
    if (ex.click) {
      const age = (now - ex.click.at) / 450;
      if (age < 1) drawCross(g, ex.click, age, ex.click.red ? C.npc : C.target);
    }
    // Avatar glides along this tick's tiles over the tick; the true tile is already at the end.
    let p = ex.pos;
    const seg = ex.seg, f = (now - ex.tickAt) / TICK_MS;
    if (seg && seg.length > 1 && f < 1) {
      const idx = f * (seg.length - 1), i0 = Math.floor(idx), fr = idx - i0;
      const a = seg[i0], b = seg[Math.min(i0 + 1, seg.length - 1)];
      p = { x: a.x + (b.x - a.x) * fr, y: a.y + (b.y - a.y) * fr };
    }
    if (ex.hazards && ex.showStops) drawTickStops(g, ex);
    ctx.strokeStyle = C.player;
    ctx.lineWidth = 2;
    ctx.strokeRect(px(ex.pos.x) + 1.5, py(ex.pos.y, g) + 1.5, ts - 3, ts - 3);
    circle(cx(p.x), cy(p.y, g), ts * 0.27);
    ctx.fillStyle = ex.dead ? '#777' : C.avatar;
    ctx.fill();
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2;
    ctx.stroke();
    if (ex.hazards) drawHitsplat(g, ex, p, now);
    // Tick pulse in the corner: it flashes as each 0.6s tick lands.
    const pzl = ex.hazards && ex.puzzle;
    const label = pzl && !pzl.clicked ? 'planning: clock stopped' : pzl ? `tick ${ex.tick - pzl.wave.t0}` : ex.paused ? `tick ${ex.tick} · paused` : `tick ${ex.tick}`;
    ctx.font = '600 12px system-ui, sans-serif';
    const w = ctx.measureText(label).width + 26;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(g.w * ts - w - 6, 6, w, 20);
    circle(g.w * ts - w + 4, 16, 4);
    ctx.fillStyle = f < 0.25 ? C.target : '#555';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, g.w * ts - w + 12, 16);
    if (st.hover && g.inBounds(st.hover.x, st.hover.y)) {
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 2;
      ctx.strokeRect(px(st.hover.x) + 1, py(st.hover.y, g) + 1, ts - 2, ts - 2);
    }
  }

  // ---- dodge: floor hazards on top of the roam tick loop -------------------------------------
  // Waves come from Scenarios.dodgeWave: a band of pools and closing gaps around you that you have to
  // cross, checked so some click survives while the nearest calm-looking tile is a trap. A pool hits
  // you only if a tick ends with your true tile on it; a tile run over mid-tick never hurts. The
  // pathfinder ignores splats, as the game's does. Puzzle style: the clock waits, you get one click.
  // Survival style: the same waves in real time with 2 extra warning ticks.

  const DODGE_SIZE = 16;

  function freshDodgeMap(dg) {
    dg.rng = S.makeRng((Math.random() * 4294967296) >>> 0);
    dg.grid = S.genTerrain(dg.rng, DODGE_SIZE, 'light');
    dg.pos = freeNear(dg.grid, dg.rng.int(5, DODGE_SIZE - 6), dg.rng.int(5, DODGE_SIZE - 6));
    Object.assign(dg, { npcs: [], route: [], pending: null, seg: null, dest: null, click: null, last: null, splats: [], trail: [], hitFx: null });
  }

  function newDodge() {
    const dg = st.dg;
    freshDodgeMap(dg);
    Object.assign(dg, { tick: 0, hp: 99, hits: 0, wave: 0, nextWave: 2, dead: false, paused: false, puzzle: null });
    if (dg.style === 'puzzle') nextPuzzle();
    else if (dg.style === 'acid') nextAcid();
    else renderDodgeInfo();
  }

  // ---- acid floor: Doom-style persistent acid around a 5x5 boss --------------------------------

  function nextAcid() {
    const dg = st.dg, rng = S.makeRng((Math.random() * 4294967296) >>> 0);
    const P = S.acidPuzzle(rng, { run: st.run, amount: dg.acidAmount });
    dg.rng = rng;
    Object.assign(dg, { npcs: [], route: [], pending: null, seg: null, dest: null, click: null, last: null, trail: [], hitFx: null, puzzle: null, paused: false });
    if (!P) { dg.acid = null; renderDodgeInfo(); return; }
    dg.grid = P.grid;
    dg.pos = P.start;
    dg.boss = P.boss;
    dg.splats = P.acid.map((a) => ({ x: a.x, y: a.y, kind: 'acid', land: -1e9, until: 1e9 }));
    dg.acid = { target: P.target, start: P.start, best: P.solution, direct: P.direct, clicks: 0, touched: 0, done: false };
    renderDodgeInfo();
  }

  function acidTick(dg, seg) {
    const a = dg.acid;
    if (!a || a.done) return;
    if (poolAt(dg, dg.pos.x, dg.pos.y, dg.tick)) {
      a.touched++;
      dg.hitFx = { at: performance.now(), dmg: dg.rng.int(1, 7) };
    }
    for (const c of seg.slice(1)) dg.trail.push({ x: c.x, y: c.y, hit: poolAt(dg, c.x, c.y, dg.tick) && same(c, dg.pos) });
    if (same(dg.pos, a.target) && !dg.route.length && !dg.pending) {
      a.done = true;
      const s = dg.ac, clean = a.touched === 0, par = clean && a.clicks <= a.best.clicks;
      s.n++;
      if (clean) s.clean++;
      if (par) { s.streak++; s.best = Math.max(s.best, s.streak); } else s.streak = 0;
      a.par = par;
      persist();
    }
    renderDodgeInfo();
  }

  // Lay a wave down relative to the current tick. delay = extra warning ticks; clickTick = the tick
  // the solver assumes your click lands on.
  function placeWave(dg, delay, clickTick) {
    const w = S.dodgeWave(dg.rng, dg.grid, dg.pos, { run: st.run, delay, clickTick });
    if (!w) return null;
    const t0 = dg.tick;
    dg.splats = dg.splats.concat(w.splats.map((s) => ({ x: s.x, y: s.y, kind: s.kind, land: t0 + s.land, until: t0 + s.until })));
    return Object.assign(w, { t0 });
  }

  function nextPuzzle() {
    const dg = st.dg;
    let w = null;
    for (let tries = 0; !w && tries < 10; tries++) {
      freshDodgeMap(dg);
      w = placeWave(dg, 0, 1);
    }
    dg.puzzle = w ? { wave: w, clicked: null, done: false, first: null, ok: false } : null;
    dg.paused = true; // the clock waits for your click
    renderDodgeInfo();
  }

  const poolAt = (dg, x, y, tick) => dg.splats.some((s) => s.x === x && s.y === y && s.land <= tick && tick < s.until);

  function dodgeTick(dg, seg) {
    if (dg.style === 'acid') return acidTick(dg, seg);
    const t = dg.tick, pz = dg.puzzle;
    const dmg = poolAt(dg, dg.pos.x, dg.pos.y, t) ? dg.rng.int(8, 15) : 0;
    if (dmg) {
      if (!pz) dg.hp = Math.max(0, dg.hp - dmg);
      dg.hits++;
      dg.hitFx = { at: performance.now(), dmg };
    }
    if (pz) {
      dg.trail.push({ x: dg.pos.x, y: dg.pos.y, tick: t - pz.wave.t0, hit: !!dmg });
      if (dmg && !pz.first) pz.first = { tick: t - pz.wave.t0, x: dg.pos.x, y: dg.pos.y };
      if (t - pz.wave.t0 >= pz.wave.horizon) finishPuzzle(dg);
      return;
    }
    dg.splats = dg.splats.filter((s) => s.until > t + 1);
    if (dg.hp <= 0) {
      dg.dead = true;
      dg.route = [];
      dg.dest = null;
      if (t > dg.best) { dg.best = t; persist(); }
      return;
    }
    // A new wave once the last one has cleared and you've stopped moving (or waited long enough).
    if (t >= dg.nextWave && (!dg.route.length || t >= dg.nextWave + 4)) {
      const w = placeWave(dg, 2, 2);
      dg.wave++;
      dg.nextWave = t + (w ? w.horizon : 4) + 1;
    }
  }

  function finishPuzzle(dg) {
    const pz = dg.puzzle, s = dg.pz;
    pz.done = true;
    pz.ok = !pz.first;
    dg.paused = true;
    s.n++;
    if (pz.ok) { s.ok++; s.streak++; s.best = Math.max(s.best, s.streak); } else s.streak = 0;
    persist();
    renderDodgeInfo();
  }

  function renderDodgeInfo() {
    const dg = st.dg, pz = dg.puzzle;
    let h = '';
    $('dgAbout').innerHTML = DODGE_ABOUT[dg.style];
    $('acidAmountRow').classList.toggle('hidden', dg.style !== 'acid');
    if (dg.style === 'acid') {
      const a = dg.acid, s = dg.ac;
      h += `<p class="meta">Clean ${s.clean}/${s.n} · at best click count ${s.streak} in a row (best ${s.best})</p>`;
      if (!a) h += "<p>Couldn't build a puzzle. Press Next.</p>";
      else if (!a.done) {
        h += `<p>Get to the <b class="y">flag</b> without ending a tick on acid. Clicks so far: <b>${a.clicks}</b>${a.touched ? ` · <span class="r">acid touched ${a.touched}×</span>` : ''}.</p>`;
      } else {
        h += a.touched === 0 ? `<p class="verdict ok">✓ Clean in ${plural(a.clicks, 'click')}</p>` : `<p class="verdict bad">✗ Touched acid ${a.touched}×</p>`;
        h += `<p>Fewest clicks for a clean run: <b>${a.best.clicks}</b>${a.touched === 0 && a.clicks > a.best.clicks ? ` (you used ${a.clicks})` : ''}. The gold numbers show one way to do it.</p>`;
        if (a.best.plan.some((s) => !same(s.click, s.stop))) h += '<p class="hint">A gold step with a dashed ring means re-clicking mid-run: click the next tile on the tick you reach the ring.</p>';
        h += `<p class="hint">Clicking the flag straight away would have dragged you through ${plural(a.direct.length, 'acid tile')}. Press Enter or Next for another.</p>`;
      }
    } else if (dg.style === 'puzzle') {
      const s = dg.pz;
      h += `<p class="meta">Solved ${s.ok}/${s.n} · streak ${s.streak} · best streak ${s.best}</p>`;
      if (!pz) h += "<p>Couldn't build a puzzle on this map. Press Next.</p>";
      else if (!pz.clicked) h += '<p><b>Plan it.</b> The clock is stopped and you get <b>one click</b>. Pick the tile to run to so that no tick ends with you on a pool.</p>';
      else if (!pz.done) h += '<p>Running it…</p>';
      else {
        const w = pz.wave, naive = same(pz.clicked, w.naive);
        h += pz.ok ? '<p class="verdict ok">✓ Clean run</p>' : `<p class="verdict bad">✗ Hit on tick ${pz.first.tick}</p>`;
        if (!pz.ok) {
          h += `<p>Tick ${pz.first.tick} ended with you on a pool (the red dot on your trail).</p>`;
          if (naive) h += '<p>You picked the nearest tile no splat ever lands on. That was the trap: the route there stops on a pool on the way.</p>';
        }
        h += `<p>${plural(w.winners.length, 'tile')} would have worked (gold), out of ${w.calmCount} calm tiles in reach. The nearest calm tile is marked ✗.</p>`;
        h += '<p class="hint">Press Enter or Next for another.</p>';
      }
    } else {
      const pct = Math.round((100 * dg.hp) / 99);
      h += `<div class="hpbar"><div style="width:${pct}%"></div><span>${dg.hp} / 99</span></div>`;
      h += `<p class="meta">Tick ${dg.tick} · wave ${dg.wave} · ${plural(dg.hits, 'hit')} taken · best ${plural(dg.best, 'tick')}${dg.paused ? ' · <b>paused</b>' : ''}</p>`;
      if (dg.dead) h += `<p class="verdict bad">You died on tick ${dg.tick} after ${plural(dg.wave, 'wave')}.</p><p class="hint">Press Enter or Restart to go again.</p>`;
    }
    $('dgHud').innerHTML = h;
    $('dgPause').classList.toggle('hidden', dg.style !== 'survival');
    $('dgPause').textContent = dg.paused ? 'Resume' : 'Pause';
    $('dgRestart').textContent = dg.style === 'survival' ? 'Restart' : 'Next puzzle';
    $('acidAmount').value = dg.acidAmount;
    $('dgStyle').value = dg.style;
  }

  const DODGE_ABOUT = {
    acid: `<p>Doom of Mokhaiotl style: each time the boss is hit it sprays acid on one side, up to 5 tiles out, and
      the acid never goes away. The pathfinder ignores acid, so clicking where you want to go often runs you
      straight through it. Get to the flag clean, in as few clicks as you can. Clicks are picked up on the next tick
      and you can re-click mid-run.</p>
      <p class="hint">Acid hurts only if a tick <b>ends</b> with you standing on it. Running covers 2 tiles in one tick,
      so the tile you pass over in between is safe. Here the boss blocks movement, which is an assumption.</p>`,
    puzzle: `<p>Solid green pools hurt from the moment you can reach them. Dashed splats show the tick they land on (a
      closing gap). A pool hits you only if a tick <b>ends</b> with you standing on it, so tiles you run over
      mid-tick are safe.</p>
      <p class="hint">You get one click with the clock stopped. Every wave has a way across, and the obvious pick (the nearest
      tile no splat lands on) is always a trap.</p>`,
    survival: `<p>Same waves as Puzzle, in real time with two extra ticks of warning. A pool hits you only if a tick
      <b>ends</b> with you standing on it. <kbd>Space</kbd> pauses.</p>`,
  };

  function drawAcidExtras(g, dg) {
    const ts = st.ts, a = dg.acid;
    if (dg.boss) {
      const b = dg.boss, x = px(b.x), y = py(b.y + b.h - 1, g);
      ctx.fillStyle = '#3a1d1d';
      ctx.fillRect(x, y, b.w * ts, b.h * ts);
      ctx.strokeStyle = '#a33';
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, b.w * ts - 2, b.h * ts - 2);
      ctx.fillStyle = '#e88';
      ctx.font = `700 ${Math.max(11, Math.round(ts * 0.45))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Doom', x + (b.w * ts) / 2, y + (b.h * ts) / 2);
    }
    if (!a) return;
    // Flag on the target tile.
    const fx = px(a.target.x), fy = py(a.target.y, g);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(fx + ts * 0.3, fy + ts * 0.85); ctx.lineTo(fx + ts * 0.3, fy + ts * 0.15); ctx.stroke();
    ctx.fillStyle = C.target;
    ctx.beginPath(); ctx.moveTo(fx + ts * 0.32, fy + ts * 0.15); ctx.lineTo(fx + ts * 0.82, fy + ts * 0.32); ctx.lineTo(fx + ts * 0.32, fy + ts * 0.5); ctx.fill();
    // Your trail: red where you touched acid.
    for (const s of dg.trail) {
      circle(cx(s.x), cy(s.y, g), ts * 0.1);
      ctx.fillStyle = s.hit ? C.bad : 'rgba(122,167,255,0.9)';
      ctx.fill();
    }
    if (!a.done) return;
    // A best clean plan: numbered clicks, its route, and dashed rings where you re-click mid-run.
    let from = a.start;
    ctx.font = `800 ${Math.max(10, Math.round(ts * 0.32))}px system-ui, sans-serif`;
    a.best.plan.forEach((s, k) => {
      const r = E.findPath(g, from, { x: s.click.x, y: s.click.y }).tiles;
      const upto = r.findIndex((t) => same(t, s.stop));
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = 'rgba(255,216,74,0.85)';
      ctx.lineWidth = Math.max(2, ts * 0.07);
      polyline(g, r.slice(0, upto + 1));
      ctx.restore();
      if (!same(s.click, s.stop)) {
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = C.target;
        ctx.lineWidth = 2;
        circle(cx(s.stop.x), cy(s.stop.y, g), ts * 0.4);
        ctx.stroke();
        ctx.restore();
      }
      circle(cx(s.click.x), cy(s.click.y, g), ts * 0.24);
      ctx.fillStyle = C.target;
      ctx.fill();
      ctx.fillStyle = '#1a1606';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(k + 1), cx(s.click.x), cy(s.click.y, g) + 1);
      from = s.stop;
    });
  }

  function drawSplats(g, dg) {
    const ts = st.ts;
    ctx.font = `700 ${Math.max(9, Math.round(ts * 0.3))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Reviewing a finished puzzle shows the board as it was when you planned it.
    const pz = dg.puzzle, now = pz && pz.done ? pz.wave.t0 : dg.tick;
    for (const s of dg.splats) {
      if (now >= s.until) continue;
      const x = cx(s.x), y = cy(s.y, g);
      if (s.kind === 'acid') {
        ctx.fillStyle = 'rgba(170,215,30,0.55)';
        ctx.fillRect(px(s.x) + 2, py(s.y, g) + 2, ts - 4, ts - 4);
        ctx.fillStyle = 'rgba(120,170,10,0.8)';
        circle(x - ts * 0.15, y + ts * 0.1, ts * 0.13); ctx.fill();
        circle(x + ts * 0.12, y - ts * 0.12, ts * 0.1); ctx.fill();
        continue;
      }
      if (s.kind === 'field' || now >= s.land) {
        ctx.fillStyle = 'rgba(70,190,40,0.6)';
        circle(x, y, ts * 0.42); ctx.fill();
        ctx.fillStyle = 'rgba(40,140,20,0.7)';
        circle(x - ts * 0.12, y + ts * 0.08, ts * 0.16); ctx.fill();
        circle(x + ts * 0.14, y - ts * 0.1, ts * 0.12); ctx.fill();
      } else {
        circle(x, y, ts * 0.4);
        ctx.fillStyle = 'rgba(150,255,90,0.14)';
        ctx.fill();
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = 'rgba(160,255,100,0.9)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
        ctx.fillStyle = 'rgba(200,255,170,0.95)';
        ctx.fillText(String(s.land - now), x, y + 1);
      }
    }
  }

  // Numbered dots for where you'll stand at the end of each coming tick; red = a pool will be there.
  function drawStops(g, dg, from, tiles, startTick) {
    const ts = st.ts, stops = E.tickStops([from].concat(tiles), st.run);
    ctx.font = `700 ${Math.max(9, Math.round(ts * 0.26))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const s of stops) {
      const bad = poolAt(dg, s.x, s.y, startTick + s.tick);
      circle(cx(s.x), cy(s.y, g), ts * 0.2);
      ctx.fillStyle = bad ? C.bad : C.route;
      ctx.fill();
      ctx.fillStyle = bad ? '#fff' : '#0d1a10';
      ctx.fillText(String(s.tick), cx(s.x), cy(s.y, g) + 1);
    }
  }

  function drawTickStops(g, dg) {
    if (dg.style === 'acid') {
      let tiles = [dg.pos].concat(dg.route);
      const h = st.hover;
      if (dg.preview && h && !dg.grid.isBlocked(h.x, h.y) && dg.acid && !dg.acid.done) {
        tiles = E.findPath(dg.grid, dg.pos, { x: h.x, y: h.y }).tiles;
        ctx.save();
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = Math.max(2, st.ts * 0.06);
        polyline(g, tiles);
        ctx.restore();
      }
      if (tiles.length < 2) return;
      for (const c of S.acidTouches(tiles, (x, y) => poolAt(dg, x, y, dg.tick), st.run)) {
        ctx.strokeStyle = C.bad;
        ctx.lineWidth = 3;
        ctx.strokeRect(px(c.x) + 3, py(c.y, g) + 3, st.ts - 6, st.ts - 6);
      }
      return;
    }
    const pz = dg.puzzle;
    if (pz && !pz.clicked) {
      if (dg.preview && st.hover && !dg.grid.isBlocked(st.hover.x, st.hover.y)) {
        const r = E.findPath(dg.grid, dg.pos, { x: st.hover.x, y: st.hover.y });
        ctx.save();
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = Math.max(2, st.ts * 0.06);
        polyline(g, r.tiles);
        ctx.restore();
        drawStops(g, dg, dg.pos, r.tiles.slice(1), dg.tick);
      }
      return;
    }
    if (pz && pz.done) return drawPuzzleReview(g, dg);
    if (dg.route.length) drawStops(g, dg, dg.pos, dg.route, dg.tick);
  }

  function drawPuzzleReview(g, dg) {
    const ts = st.ts, pz = dg.puzzle;
    ctx.fillStyle = '#ffd84a';
    for (const w of pz.wave.winners) {
      const x = cx(w.x), y = cy(w.y, g), r = ts * 0.13;
      ctx.beginPath();
      ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.fill();
    }
    drawMarks(g, [{ x: pz.wave.naive.x, y: pz.wave.naive.y, label: '✗', color: C.bad }]);
    ctx.font = `700 ${Math.max(9, Math.round(ts * 0.26))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let prev = null;
    for (const s of dg.trail) {
      if (prev && same(prev, s)) continue;
      prev = s;
      circle(cx(s.x), cy(s.y, g), ts * 0.2);
      ctx.fillStyle = s.hit ? C.bad : C.route;
      ctx.fill();
      ctx.fillStyle = s.hit ? '#fff' : '#0d1a10';
      ctx.fillText(String(s.tick), cx(s.x), cy(s.y, g) + 1);
    }
  }

  function drawHitsplat(g, dg, p, now) {
    const fx = dg.hitFx;
    if (!fx || now - fx.at > 900) return;
    const ts = st.ts, x = cx(p.x), y = cy(p.y, g) - ts * 0.15;
    circle(x, y, ts * 0.3);
    ctx.fillStyle = '#b3120c';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `800 ${Math.max(10, Math.round(ts * 0.32))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(fx.dmg), x, y + 1);
  }

  function toggleDodgePause() {
    const dg = st.dg;
    if (dg.dead || dg.style === 'puzzle') return;
    dg.paused = !dg.paused;
    renderDodgeInfo();
  }

  function restartDodge() {
    newDodge();
    startExplore();
    render();
  }

  // Run changes which clicks work, so rebuild a puzzle that hasn't been clicked yet.
  function dodgeSettingChanged() {
    const dg = st.dg;
    persist();
    if (st.mode !== 'dodge') return;
    if (dg.style === 'puzzle' && dg.puzzle && !dg.puzzle.clicked) nextPuzzle();
    if (dg.style === 'acid' && (!dg.acid || (!dg.acid.clicks && !dg.pending) || dg.acid.done)) nextAcid();
  }

  // ---- settings and modes -----------------------------------------------------------------

  function setMode(id) {
    if (st.mode === id && id !== 'misses') return;
    stopAnim();
    stopExplore();
    st.mode = id;
    st.hover = null;
    persist();
    if (id === 'sandbox') { initSandbox(); render(); } else if (isRoam(id)) { startExplore(); render(); } else nextQuestion();
  }

  function setRun(v) {
    st.run = v;
    $('run').checked = v;
    persist();
    if (isRoam()) { dodgeSettingChanged(); return render(); }
    if (st.mode === 'sandbox') {
      if (st.sb.res) startAnim(st.sb.res.tiles, v);
      return render();
    }
    const q = st.q;
    if (!q) return;
    if (st.phase === 'ask' && q.mode === 'tick') return nextQuestion();
    if (st.mode === 'misses') return toast('Misses replay with their original run setting');
    q.run = v;
    if (st.phase === 'done') startAnim(q.result.tiles, v);
    render();
  }

  function cycleOverlay() {
    if (isRoam()) return;
    if (st.mode !== 'sandbox' && st.phase !== 'done') return toast('Overlays unlock after you answer');
    st.overlay = OVERLAYS[(OVERLAYS.indexOf(st.overlay) + 1) % OVERLAYS.length];
    persist();
    render();
  }

  function replay() {
    if (isRoam()) return;
    if (st.mode === 'sandbox') { if (st.sb.res) startAnim(st.sb.res.tiles, st.run); return; }
    if (st.q && st.phase === 'done') startAnim(st.q.result.tiles, st.q.run);
  }

  // ---- animation --------------------------------------------------------------------------

  function startAnim(tiles, run) {
    cancelAnimationFrame(st.raf);
    st.anim = { tiles, run, t0: performance.now() };
    const loop = () => {
      draw();
      st.raf = st.anim && !animPos().done ? requestAnimationFrame(loop) : 0;
    };
    loop();
  }

  function stopAnim() {
    cancelAnimationFrame(st.raf);
    st.raf = 0;
    st.anim = null;
  }

  // Smooth avatar position plus the "true tile" the server has you on after each completed tick.
  function animPos() {
    const a = st.anim, tiles = a.tiles, last = tiles.length - 1, step = a.run ? 2 : 1;
    const ticks = Math.ceil(last / step);
    const prog = Math.max(0, (performance.now() - a.t0 - 300) / TICK_MS);
    const k = Math.min(Math.floor(prog), ticks), f = k >= ticks ? 0 : prog - k;
    const base = Math.min(k * step, last);
    const idx = base + f * Math.min(step, last - base);
    const i0 = Math.floor(idx), i1 = Math.min(i0 + 1, last), fr = idx - i0;
    return {
      pos: { x: tiles[i0].x + (tiles[i1].x - tiles[i0].x) * fr, y: tiles[i0].y + (tiles[i1].y - tiles[i0].y) * fr },
      trueTile: tiles[base], tick: k, ticks, done: k >= ticks,
    };
  }

  // ---- rendering --------------------------------------------------------------------------

  function view() {
    if (isRoam()) {
      const ex = roam();
      return ex.grid ? { g: ex.grid, src: ex.pos, overlay: 'none', search: null } : null;
    }
    if (st.mode === 'sandbox') {
      const sb = st.sb;
      if (!sb.grid) return null;
      return {
        g: sb.grid, src: sb.src, npc: sb.npc, res: sb.res, run: st.run, overlay: st.overlay, search: sb.search,
        target: sb.res && !sb.res.npc ? sb.res.target : null, altWindow: sb.res && sb.res.alternative ? sb.res.target : null,
      };
    }
    const q = st.q;
    if (!q) return null;
    const done = st.phase === 'done', npc = q.target.kind === 'npc';
    const stepping = q.mode === 'step' && !done;
    return {
      g: q.grid, src: stepping ? q.result.tiles[st.stepIdx] : q.src,
      walked: stepping && st.stepIdx > 0 ? q.result.tiles.slice(0, st.stepIdx + 1) : null, npc: npc ? q.target : null, target: npc ? null : q.target,
      res: done ? q.result : null, run: q.run, overlay: done ? st.overlay : 'none', search: done ? q.result.search : null,
      clicks: q.mode === 'trace' ? st.clicks : null, pick: st.pick, done,
      marks: done && st.verdict ? st.verdict.marks : stepping ? stepMarks(q) : null,
      wrongFrom: done && st.verdict && st.verdict.d && !st.verdict.correct ? st.verdict.d.firstDiff : -1,
      altWindow: done && q.result.alternative ? q.target : null,
    };
  }

  function currentGrid() {
    const v = view();
    return v ? v.g : null;
  }

  function layout() {
    const g = currentGrid();
    if (!g) { cv.style.width = cv.style.height = '0px'; return; }
    const board = $('board');
    const pad = board.clientWidth < 700 ? 8 : 32;
    const ts = Math.max(14, Math.min(56, Math.floor(Math.min((board.clientWidth - pad) / g.w, (board.clientHeight - pad) / g.h))));
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(g.w * ts * dpr), h = Math.round(g.h * ts * dpr);
    st.ts = ts;
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; } // resizing clears the canvas
    cv.style.width = g.w * ts + 'px';
    cv.style.height = g.h * ts + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  const px = (x) => x * st.ts;
  const py = (y, g) => (g.h - 1 - y) * st.ts;
  const cx = (x) => (x + 0.5) * st.ts;
  const cy = (y, g) => (g.h - 0.5 - y) * st.ts;

  function circle(x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }

  function draw() {
    const v = view();
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!v) return;
    const g = v.g, ts = st.ts;
    for (let y = 0; y < g.h; y++) {
      for (let x = 0; x < g.w; x++) {
        ctx.fillStyle = (x + y) % 2 ? C.ground1 : C.ground2;
        ctx.fillRect(px(x), py(y, g), ts, ts);
      }
    }
    ctx.strokeStyle = C.gridLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 1; x < g.w; x++) { ctx.moveTo(x * ts + 0.5, 0); ctx.lineTo(x * ts + 0.5, g.h * ts); }
    for (let y = 1; y < g.h; y++) { ctx.moveTo(0, y * ts + 0.5); ctx.lineTo(g.w * ts, y * ts + 0.5); }
    ctx.stroke();
    if (isRoam()) return drawExplore(g);

    if (v.overlay !== 'none' && v.search) drawNumbers(g, v.search, v.overlay);
    if (v.altWindow) drawAltWindow(g, v.altWindow);
    drawRocks(g);
    drawWalls(g);
    if (v.npc) drawNpc(g, v.npc);
    if (v.target) drawX(g, v.target);
    if (v.res) drawRoute(g, v.res.tiles, v.run);
    if (v.walked) drawRoute(g, v.walked, false);
    if (v.clicks) drawTrace(g, v.src, v.clicks, v.done, v.wrongFrom);
    if (v.pick) drawPick(g, v.pick, st.verdict ? (st.verdict.correct ? C.good : C.bad) : C.user);
    if (v.marks) drawMarks(g, v.marks);
    drawPlayer(g, v);
    if (st.hover && g.inBounds(st.hover.x, st.hover.y)) {
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 2;
      ctx.strokeRect(px(st.hover.x) + 1, py(st.hover.y, g) + 1, ts - 2, ts - 2);
    }
  }

  function drawNumbers(g, s, kind) {
    const ts = st.ts;
    ctx.font = `${Math.max(9, Math.round(ts * 0.3))}px ui-monospace, Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    for (let y = 0; y < g.h; y++) {
      for (let x = 0; x < g.w; x++) {
        const i = g.idx(x, y);
        if (s.dist[i] < 0) continue;
        ctx.fillText(String(kind === 'dist' ? s.dist[i] : s.order[i]), cx(x), cy(y, g));
      }
    }
  }

  function drawAltWindow(g, t) {
    const R = E.ALT_RANGE;
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = 'rgba(255,216,74,0.6)';
    ctx.lineWidth = 2;
    ctx.strokeRect(px(t.x - R) + 1, py(t.y + R, g) + 1, (2 * R + 1) * st.ts - 2, (2 * R + 1) * st.ts - 2);
    ctx.restore();
  }

  function drawRocks(g) {
    const ts = st.ts, inset = Math.max(1, ts * 0.06);
    for (let y = 0; y < g.h; y++) {
      for (let x = 0; x < g.w; x++) {
        if (!g.blocked[g.idx(x, y)]) continue;
        ctx.fillStyle = C.rockEdge;
        ctx.fillRect(px(x), py(y, g), ts, ts);
        ctx.fillStyle = C.rock;
        ctx.fillRect(px(x) + inset, py(y, g) + inset, ts - 2 * inset, ts - 2 * inset);
        ctx.fillStyle = C.rockTop;
        ctx.fillRect(px(x) + inset, py(y, g) + inset, ts - 2 * inset, (ts - 2 * inset) * 0.35);
      }
    }
  }

  function drawWalls(g) {
    const ts = st.ts, segs = [];
    for (let y = 0; y < g.h; y++) {
      for (let x = 0; x < g.w; x++) {
        if (g.hasWallE(x, y)) segs.push([px(x + 1), py(y, g), px(x + 1), py(y, g) + ts]);
        if (g.hasWallN(x, y)) segs.push([px(x), py(y, g), px(x) + ts, py(y, g)]);
      }
    }
    ctx.lineCap = 'round';
    for (const [w, color] of [[Math.max(5, ts * 0.2), C.wallEdge], [Math.max(3, ts * 0.12), C.wall]]) {
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.beginPath();
      for (const s of segs) { ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]); }
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }

  function drawNpc(g, n) {
    const ts = st.ts, x = px(n.x), y = py(n.y + n.h - 1, g), w = n.w * ts, h = n.h * ts;
    ctx.fillStyle = 'rgba(255,90,79,0.22)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = C.npc;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    ctx.fillStyle = C.npc;
    ctx.font = `700 ${Math.max(10, Math.round(ts * 0.32))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(n.w > 1 ? `NPC ${n.w}×${n.h}` : 'NPC', x + w / 2, y + h / 2);
  }

  function drawX(g, t) {
    const ts = st.ts, a = ts * 0.24, x0 = px(t.x), y0 = py(t.y, g);
    ctx.lineCap = 'round';
    for (const [w, color] of [[Math.max(5, ts * 0.17), '#1a1606'], [Math.max(3, ts * 0.1), C.target]]) {
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(x0 + a, y0 + a); ctx.lineTo(x0 + ts - a, y0 + ts - a);
      ctx.moveTo(x0 + ts - a, y0 + a); ctx.lineTo(x0 + a, y0 + ts - a);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }

  function polyline(g, pts) {
    ctx.beginPath();
    pts.forEach((t, i) => (i ? ctx.lineTo(cx(t.x), cy(t.y, g)) : ctx.moveTo(cx(t.x), cy(t.y, g))));
    ctx.stroke();
  }

  function drawRoute(g, tiles, run) {
    const ts = st.ts;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(94,224,138,0.85)';
    ctx.lineWidth = Math.max(2, ts * 0.09);
    polyline(g, tiles);
    ctx.fillStyle = C.route;
    for (let i = 1; i < tiles.length; i++) { circle(cx(tiles[i].x), cy(tiles[i].y, g), Math.max(2, ts * 0.09)); ctx.fill(); }
    ctx.font = `700 ${Math.max(9, Math.round(ts * 0.28))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const s of E.tickStops(tiles, run)) {
      circle(cx(s.x), cy(s.y, g), ts * 0.24);
      ctx.fillStyle = C.route;
      ctx.fill();
      ctx.fillStyle = '#0d1a10';
      ctx.fillText(String(s.tick), cx(s.x), cy(s.y, g) + 1);
    }
  }

  function drawTrace(g, src, clicks, done, wrongFrom) {
    if (!clicks.length) return;
    const ts = st.ts, pts = [src].concat(clicks);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(122,167,255,0.9)';
    ctx.lineWidth = Math.max(2, ts * 0.07);
    if (done) ctx.setLineDash([5, 4]);
    polyline(g, pts);
    ctx.setLineDash([]);
    ctx.font = `700 ${Math.max(9, Math.round(ts * 0.26))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    clicks.forEach((t, k) => {
      const wrong = done && wrongFrom >= 1 && k + 1 >= wrongFrom;
      if (done) {
        // Small offset badge so the green tick numbers stay readable underneath.
        const bx = px(t.x) + ts * 0.8, by = py(t.y, g) + ts * 0.8;
        circle(bx, by, ts * 0.15);
        ctx.fillStyle = wrong ? C.bad : C.user;
        ctx.fill();
      } else {
        circle(cx(t.x), cy(t.y, g), ts * 0.22);
        ctx.fillStyle = C.user;
        ctx.fill();
        ctx.fillStyle = '#0b1530';
        ctx.fillText(String(k + 1), cx(t.x), cy(t.y, g) + 1);
      }
    });
  }

  function drawPick(g, t, color) {
    const ts = st.ts;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(3, ts * 0.1);
    ctx.strokeRect(px(t.x) + 3, py(t.y, g) + 3, ts - 6, ts - 6);
  }

  function drawMarks(g, marks) {
    const ts = st.ts, fs = Math.max(9, Math.round(ts * 0.28));
    ctx.font = `700 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const m of marks) {
      const w = Math.max(fs * 1.15, ctx.measureText(m.label).width + 6), h = fs * 1.2;
      const x = px(m.x) + 2, y = py(m.y, g) + 2;
      ctx.fillStyle = 'rgba(10,12,14,0.85)';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, 3); else ctx.rect(x, y, w, h);
      ctx.fill();
      ctx.fillStyle = m.color;
      ctx.fillText(m.label, x + w / 2, y + h / 2 + 1);
    }
  }

  function drawPlayer(g, v) {
    const ts = st.ts;
    const a = st.anim && v.res ? animPos() : null;
    if (a) {
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = 'rgba(63,208,255,0.45)';
      ctx.lineWidth = 2;
      ctx.strokeRect(px(v.src.x) + 2, py(v.src.y, g) + 2, ts - 4, ts - 4);
      ctx.restore();
    }
    const tt = a ? a.trueTile : v.src, p = a ? a.pos : v.src;
    ctx.strokeStyle = C.player;
    ctx.lineWidth = 2;
    ctx.strokeRect(px(tt.x) + 1.5, py(tt.y, g) + 1.5, ts - 3, ts - 3);
    circle(cx(p.x), cy(p.y, g), ts * 0.27);
    ctx.fillStyle = C.avatar;
    ctx.fill();
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2;
    ctx.stroke();
    if (a) {
      const label = `tick ${a.tick}/${a.ticks}`;
      ctx.font = '600 12px system-ui, sans-serif';
      const w = ctx.measureText(label).width + 12;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(g.w * ts - w - 6, 6, w, 20);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, g.w * ts - w / 2 - 6, 16);
    }
  }

  // ---- input ------------------------------------------------------------------------------

  function tileFromEvent(e) {
    const g = currentGrid();
    if (!g) return null;
    const r = cv.getBoundingClientRect();
    const fx = (e.clientX - r.left) / st.ts, fyc = (e.clientY - r.top) / st.ts;
    const x = Math.floor(fx), row = Math.floor(fyc);
    const t = { x, y: g.h - 1 - row, fx: fx - x, fy: 1 - (fyc - row) };
    return g.inBounds(t.x, t.y) ? t : null;
  }

  cv.addEventListener('pointerdown', (e) => {
    const t = tileFromEvent(e);
    if (!t) return;
    if (e.button === 2) return undo();
    if (e.button !== 0) return;
    st.mouseDown = true;
    if (isRoam()) exploreClick(t);
    else if (st.mode === 'sandbox') sandboxDown(t);
    else quizClick({ x: t.x, y: t.y });
  });
  window.addEventListener('pointerup', () => {
    st.mouseDown = false;
    st.sb.paint = null;
  });
  cv.addEventListener('pointermove', (e) => {
    const t = tileFromEvent(e);
    if (st.mode === 'sandbox' && st.mouseDown && st.sb.paint && t) sandboxDrag(t);
    const h = t ? { x: t.x, y: t.y } : null;
    if ((h === null) !== (st.hover === null) || (h && !same(h, st.hover))) {
      st.hover = h;
      draw();
      renderHover();
    }
  });
  cv.addEventListener('pointerleave', () => { st.hover = null; draw(); renderHover(); });
  cv.addEventListener('contextmenu', (e) => e.preventDefault());

  $('side').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    b.blur();
    if (b.dataset.mode) return setMode(b.dataset.mode);
    if (b.dataset.tool) return setTool(b.dataset.tool);
    switch (b.dataset.act) {
      case 'next': case 'skip': return nextQuestion();
      case 'reveal': return finish();
      case 'undo': return undo();
      case 'submit': return st.clicks.length ? finish() : toast('Click some tiles first');
      case 'replay': return replay();
      case 'rules': return showRules(true);
      case 'resetStats':
        if (confirm('Reset all stats?')) { st.stats = {}; persist(); render(); }
        return;
      case 'sbRandom': newSandboxMap(true); return render();
      case 'sbClear': newSandboxMap(false); return render();
      case 'exNew': newExploreMap(); return render();
      case 'dgRestart': return restartDodge();
      case 'dgPause': return toggleDodgePause();
    }
  });
  $('rules').addEventListener('click', (e) => {
    if (e.target === $('rules') || (e.target.closest('button') && e.target.closest('button').dataset.act === 'closeRules')) showRules(false);
  });

  function showRules(on) { $('rules').classList.toggle('hidden', !on); }

  $('level').addEventListener('change', (e) => {
    st.level = +e.target.value;
    e.target.blur();
    persist();
    if (st.mode !== 'sandbox' && st.mode !== 'misses' && !isRoam()) nextQuestion(); else render();
  });
  $('terrain').addEventListener('change', (e) => {
    st.terrain = e.target.value;
    e.target.blur();
    persist();
    if (st.mode === 'explore') { newExploreMap(); render(); } else if (st.mode !== 'sandbox' && st.mode !== 'misses' && !isRoam()) nextQuestion();
  });
  $('size').addEventListener('change', (e) => {
    st.size = +e.target.value;
    e.target.blur();
    persist();
    if (st.mode === 'sandbox') { newSandboxMap(true); render(); } else if (st.mode !== 'misses' && !isRoam()) nextQuestion();
  });
  $('run').addEventListener('change', (e) => { e.target.blur(); setRun(e.target.checked); });
  $('overlay').addEventListener('change', (e) => { st.overlay = e.target.value; e.target.blur(); persist(); render(); });
  $('exPath').addEventListener('change', (e) => { st.ex.showPath = e.target.checked; e.target.blur(); });
  $('dgStops').addEventListener('change', (e) => { st.dg.showStops = e.target.checked; e.target.blur(); });
  $('dgPreview').addEventListener('change', (e) => { st.dg.preview = e.target.checked; e.target.blur(); });
  $('acidAmount').addEventListener('change', (e) => { st.dg.acidAmount = e.target.value; e.target.blur(); dodgeSettingChanged(); });
  $('dgStyle').addEventListener('change', (e) => {
    st.dg.style = e.target.value;
    e.target.blur();
    persist();
    restartDodge();
  });
  $('npcSize').addEventListener('change', (e) => { st.sb.npcSize = +e.target.value; e.target.blur(); });

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.tagName === 'SELECT') return;
    const k = e.key, low = k.toLowerCase();
    if (!$('rules').classList.contains('hidden')) { if (k === 'Escape' || k === '?') showRules(false); return; }
    if (k === '?') return showRules(true);
    if (/^[0-9]$/.test(k)) return setMode(MODES[k === '0' ? 9 : +k - 1].id);
    if (low === 'r') return setRun(!st.run);
    if (low === 'o') return cycleOverlay();
    if (low === 'a') return replay();
    if (st.mode === 'dodge') {
      if (k === ' ' || low === 'p') { e.preventDefault(); toggleDodgePause(); }
      else if (k === 'Enter' && (st.dg.dead || (st.dg.puzzle && st.dg.puzzle.done) || (st.dg.acid && st.dg.acid.done))) {
        if (st.dg.style === 'puzzle') { nextPuzzle(); render(); }
        else if (st.dg.style === 'acid') { nextAcid(); render(); }
        else restartDodge();
      }
      return;
    }
    if (st.mode === 'explore') return;
    if (st.mode === 'sandbox') {
      const tools = { w: 'walk', b: 'rock', l: 'wall', p: 'player', n: 'npc' };
      if (tools[low]) setTool(tools[low]);
      return;
    }
    if (k === 'Enter' || k === ' ') {
      e.preventDefault();
      if (st.phase === 'done') nextQuestion();
      else if (st.q && st.q.mode === 'trace' && st.clicks.length) finish();
      return;
    }
    if (k === 'Backspace' || low === 'z') { e.preventDefault(); return undo(); }
    if (low === 'n') return nextQuestion();
  });

  window.addEventListener('resize', () => { layout(); draw(); });

  // ---- boot -------------------------------------------------------------------------------

  $('level').value = String(st.level);
  $('terrain').value = st.terrain;
  $('size').value = String(st.size);
  $('run').checked = st.run;
  $('npcSize').value = String(st.sb.npcSize);
  if (st.mode === 'sandbox') { initSandbox(); render(); } else if (isRoam()) { startExplore(); render(); } else nextQuestion();

  // Exposed for automated smoke tests.
  window.__trainer = { st, nextQuestion, setMode, quizClick, finish };
})();
