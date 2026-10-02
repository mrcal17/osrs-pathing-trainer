/* OSRS Pathing Trainer: quiz flow, explanations, rendering, sandbox. */
(function () {
  'use strict';
  const E = window.PathEngine, S = window.Scenarios;
  const $ = (id) => document.getElementById(id);
  const cv = $('cv'), ctx = cv.getContext('2d');

  const MODES = [
    { id: 'trace', label: 'Trace' },
    { id: 'tick', label: 'Tick' },
    { id: 'unreach', label: 'Unreachable' },
    { id: 'melee', label: 'Melee' },
    { id: 'mixed', label: 'Mixed' },
    { id: 'misses', label: 'Misses' },
    { id: 'sandbox', label: 'Sandbox' },
  ];
  const QUIZ = ['trace', 'tick', 'unreach', 'melee'];
  const NAME = { trace: 'Trace', tick: 'Tick', unreach: 'Unreachable', melee: 'Melee', all: 'All' };
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
    q: null, phase: 'ask', clicks: [], pick: null, verdict: null,
    hover: null, anim: null, raf: 0, ts: 32, mouseDown: false,
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
        mode: st.mode, level: st.level, terrain: st.terrain, size: st.size, run: st.run, overlay: st.overlay,
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
    Object.assign(st, { phase: 'ask', clicks: [], pick: null, verdict: null, q: null });
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
      v.body = tiebreakHTML(q, d, v.marks);
    } else {
      v.body = "<p>Your trace skips a tile. The green line is the game's route.</p>";
    }
    v.body += '<p class="tip">Open ground: straight steps first, diagonals last. Ties are settled by the search order W, E, S, N, SW, SE, NW, NE.</p>';
    return v;
  }

  function tiebreakHTML(q, d, marks) {
    const s = q.result.search, g = q.grid;
    const a = d.options.find((o) => same(o, d.A)), b = d.options.find((o) => same(o, d.B));
    marks.push({ x: d.T.x, y: d.T.y, label: 'T', color: C.target },
      { x: d.A.x, y: d.A.y, label: 'A', color: C.good }, { x: d.B.x, y: d.B.y, label: 'B', color: C.user });
    let h = '<p>Your route is just as short, so the tie-break decides it. The game builds the route <b>backwards from the X</b>, and each tile is entered from whichever neighbour the search expanded first.</p>';
    if (!a || !b) return h + "<p>The game's route goes through A instead of B.</p>";
    h += `<p>Tile <b>T</b> can be entered from <b>A</b> (a ${a.dir} step) or <b>B</b> (a ${b.dir} step). Both are ${plural(s.dist[g.idx(a.x, a.y)], 'step')} from you. `;
    if (a.parent >= 0 && a.parent === b.parent) {
      const da = E.DIRS[s.via[g.idx(a.x, a.y)]].name, db = E.DIRS[s.via[g.idx(b.x, b.y)]].name;
      h += `Both were found from the same tile, A by a ${da} step and B by a ${db} step. ${da} comes before ${db} in the order W, E, S, N, SW, SE, NW, NE. `;
    } else {
      h += `The search expanded A before B (#${a.order} vs #${b.order}; hover a tile to see its number). `;
    }
    return h + 'So the route goes through A.</p>';
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
    trace: "you always take the fewest steps, and a diagonal step counts as one. With nothing in the way you do the straight part first and the diagonal steps last. You can't cut a corner past a rock.",
    tick: "work out the route first, then count along it. Running covers 2 tiles per tick (tick 1 ends 2 steps in, tick 2 ends 4 steps in). Walking covers 1.",
    unreach: "you walk to the reachable tile closest to the X in a straight line. A tile straight beside the rock beats a diagonal one. If two tie, the one with fewer steps wins, then the westmost.",
    melee: "you stop on the nearest tile that shares an edge with the NPC. Corners don't count. If two are equally close and you're diagonal to the NPC, you step west or east rather than south or north.",
  };

  function promptHTML(q) {
    const ask = st.phase === 'ask';
    let title, text;
    if (q.mode === 'trace') {
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
      (q.level < 3 ? `<p class="tip"><b>Rule:</b> ${HINT[q.mode]}</p>` : '');
    const btns = ask ? `<div class="row">${q.mode === 'trace' ? '<button data-act="undo">Undo</button><button data-act="submit">Submit</button>' : ''}<button data-act="reveal">Show answer</button><button data-act="skip">Skip <kbd>N</kbd></button></div>` : '';
    const label = st.mode === 'mixed' || st.mode === 'misses' ? `${NAME[q.mode]} · ` : '';
    const where = q.level < 3 ? S.LEVELS[q.level].name : TERRAIN_NAME[q.terrain];
    return `<h2>${title}</h2><p>${text}</p>${hint}${btns}<p class="meta">${label}${where} · ${q.size}×${q.size} · seed ${q.seed}</p>`;
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
    const sandbox = st.mode === 'sandbox';
    $('sandboxPanel').classList.toggle('hidden', !sandbox);
    $('promptCard').classList.toggle('hidden', sandbox);
    $('statsCard').classList.toggle('hidden', sandbox);
    if (sandbox) {
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
    const simple = !sandbox && st.level < 3;
    for (const id of ['terrain', 'size']) {
      $(id).disabled = simple;
      $(id).title = simple ? 'Beginner and Easy use their own small maps. Switch Level to Normal to choose.' : '';
    }
    $('overlay').value = st.overlay;
    $('overlay').disabled = !sandbox && st.phase !== 'done';
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

  // ---- settings and modes -----------------------------------------------------------------

  function setMode(id) {
    if (st.mode === id && id !== 'misses') return;
    stopAnim();
    st.mode = id;
    st.hover = null;
    persist();
    if (id === 'sandbox') { initSandbox(); render(); } else nextQuestion();
  }

  function setRun(v) {
    st.run = v;
    $('run').checked = v;
    persist();
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
    if (st.mode !== 'sandbox' && st.phase !== 'done') return toast('Overlays unlock after you answer');
    st.overlay = OVERLAYS[(OVERLAYS.indexOf(st.overlay) + 1) % OVERLAYS.length];
    persist();
    render();
  }

  function replay() {
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
    return {
      g: q.grid, src: q.src, npc: npc ? q.target : null, target: npc ? null : q.target,
      res: done ? q.result : null, run: q.run, overlay: done ? st.overlay : 'none', search: done ? q.result.search : null,
      clicks: q.mode === 'trace' ? st.clicks : null, pick: st.pick, done,
      marks: done && st.verdict ? st.verdict.marks : null,
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

    if (v.overlay !== 'none' && v.search) drawNumbers(g, v.search, v.overlay);
    if (v.altWindow) drawAltWindow(g, v.altWindow);
    drawRocks(g);
    drawWalls(g);
    if (v.npc) drawNpc(g, v.npc);
    if (v.target) drawX(g, v.target);
    if (v.res) drawRoute(g, v.res.tiles, v.run);
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
    if (st.mode === 'sandbox') sandboxDown(t);
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
    if (st.mode !== 'sandbox' && st.mode !== 'misses') nextQuestion(); else render();
  });
  $('terrain').addEventListener('change', (e) => {
    st.terrain = e.target.value;
    e.target.blur();
    persist();
    if (st.mode !== 'sandbox' && st.mode !== 'misses') nextQuestion();
  });
  $('size').addEventListener('change', (e) => {
    st.size = +e.target.value;
    e.target.blur();
    persist();
    if (st.mode === 'sandbox') { newSandboxMap(true); render(); } else if (st.mode !== 'misses') nextQuestion();
  });
  $('run').addEventListener('change', (e) => { e.target.blur(); setRun(e.target.checked); });
  $('overlay').addEventListener('change', (e) => { st.overlay = e.target.value; e.target.blur(); persist(); render(); });
  $('npcSize').addEventListener('change', (e) => { st.sb.npcSize = +e.target.value; e.target.blur(); });

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.tagName === 'SELECT') return;
    const k = e.key, low = k.toLowerCase();
    if (!$('rules').classList.contains('hidden')) { if (k === 'Escape' || k === '?') showRules(false); return; }
    if (k === '?') return showRules(true);
    if (/^[1-7]$/.test(k)) return setMode(MODES[+k - 1].id);
    if (low === 'r') return setRun(!st.run);
    if (low === 'o') return cycleOverlay();
    if (low === 'a') return replay();
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
  if (st.mode === 'sandbox') { initSandbox(); render(); } else nextQuestion();

  // Exposed for automated smoke tests.
  window.__trainer = { st, nextQuestion, setMode, quizClick, finish };
})();
