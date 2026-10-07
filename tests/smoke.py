"""Browser smoke test: python tests/smoke.py  (screenshots land in tests/shots/)."""
import pathlib
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHOTS = ROOT / "tests" / "shots"
SHOTS.mkdir(exist_ok=True)
errors = []


def tile_xy(page, x, y):
    return page.evaluate(
        """([x, y]) => {
            const st = window.__trainer.st, r = document.getElementById('cv').getBoundingClientRect();
            const g = st.mode === 'sandbox' ? st.sb.grid : st.mode === 'explore' ? st.ex.grid : st.mode === 'dodge' ? st.dg.grid : st.q.grid;
            return [r.left + (x + 0.5) * st.ts, r.top + (g.h - 0.5 - y) * st.ts];
        }""",
        [x, y],
    )


def click_tile(page, x, y):
    px, py = tile_xy(page, x, y)
    page.mouse.click(px, py)


def q(page, expr):
    return page.evaluate(f"(() => {{ const st = window.__trainer.st, q = st.q; return {expr}; }})()")


def answer(page, correct):
    mode = q(page, "q.mode")
    if mode == "step":
        tiles = q(page, "q.result.tiles")
        if not correct:
            s, nxt = tiles[0], tiles[1]
            for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, -1), (-1, 1), (1, 1)]:
                w = {"x": s["x"] + dx, "y": s["y"] + dy}
                if w != nxt and q(page, f"q.grid.inBounds({w['x']},{w['y']}) && !q.grid.isBlocked({w['x']},{w['y']})"):
                    break
            click_tile(page, w["x"], w["y"])
            page.wait_for_timeout(100)
            if len(tiles) > 2:
                page.screenshot(path=str(SHOTS / "step_feedback.png"))
            tiles = tiles[1:]
        for t in tiles[1:]:
            click_tile(page, t["x"], t["y"])
    elif mode == "trace":
        tiles = q(page, "q.result.tiles")[1:]
        if not correct:
            tiles = tiles[:-1]  # stop short, then submit with Enter
        for t in tiles:
            click_tile(page, t["x"], t["y"])
        if not correct:
            page.keyboard.press("Enter")
    else:
        key = "q.answer" if mode == "tick" else "q.result.end"
        t = q(page, key)
        if not correct:
            # Any free tile that is not the answer.
            t = q(page, f"""(() => {{ const a = {key}; for (let y = 0; y < q.grid.h; y++) for (let x = 0; x < q.grid.w; x++)
                if (!q.grid.isBlocked(x, y) && (x !== a.x || y !== a.y)) return {{x, y}}; }})()""")
        click_tile(page, t["x"], t["y"])
    page.wait_for_timeout(150)
    return mode, q(page, "st.verdict && st.verdict.correct")


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1600, "height": 950})
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: m.type == "error" and errors.append(f"console: {m.text}"))
    page.goto((ROOT / "index.html").as_uri())
    page.evaluate("localStorage.clear()")
    page.reload()

    failures = []
    for key, mode in [("1", "trace"), ("2", "step"), ("3", "tick"), ("4", "unreach"), ("5", "melee")]:
        page.keyboard.press(key)
        for want in (True, False):
            for _ in range(3):
                got_mode, ok = answer(page, want)
                if ok != want:
                    failures.append(f"{mode}: expected correct={want}, got {ok} (seed {q(page, 'q.seed')})")
                page.wait_for_timeout(100)
                if _ == 2:
                    page.wait_for_timeout(2500 if want is False else 0)
                    page.screenshot(path=str(SHOTS / f"{mode}_{'right' if want else 'wrong'}.png"))
                page.keyboard.press("Enter")

    # Overlay unlocks after answering.
    page.keyboard.press("1")
    answer(page, True)
    page.keyboard.press("o")
    page.wait_for_timeout(1500)
    page.screenshot(path=str(SHOTS / "trace_overlay.png"))
    page.keyboard.press("o")
    page.keyboard.press("o")

    # Mixed + misses.
    page.keyboard.press("6")
    for _ in range(4):
        answer(page, False)
        page.keyboard.press("Enter")
    misses = page.evaluate("window.__trainer.st.misses.length")
    page.keyboard.press("7")
    page.wait_for_timeout(100)
    _, ok = answer(page, True)
    after = page.evaluate("window.__trainer.st.misses.length")
    if not (misses >= 4 and ok and after == misses - 1):
        failures.append(f"misses: before={misses} ok={ok} after={after}")

    # Sandbox: place an NPC, draw walls/rocks, walk, attack.
    page.keyboard.press("8")
    page.click("button[data-act=sbClear]")
    page.keyboard.press("b")
    for x in range(5, 10):
        click_tile(page, x, 9)
    page.keyboard.press("l")
    for y in range(3, 7):
        px, py = tile_xy(page, 10, y)
        page.mouse.click(px + 0.45 * page.evaluate("window.__trainer.st.ts"), py)
    page.keyboard.press("n")
    click_tile(page, 12, 12)
    page.keyboard.press("w")
    click_tile(page, 7, 9)  # unreachable rock
    page.wait_for_timeout(2500)
    page.screenshot(path=str(SHOTS / "sandbox_unreachable.png"))
    click_tile(page, 12, 12)  # attack the NPC
    page.wait_for_timeout(3500)
    sb = page.evaluate("(() => { const r = window.__trainer.st.sb.res; return r && { npc: r.npc, reached: r.reached, end: r.end }; })()")
    if not (sb and sb["npc"] and sb["reached"]):
        failures.append(f"sandbox melee: {sb}")
    page.keyboard.press("o")
    page.screenshot(path=str(SHOTS / "sandbox_melee.png"))

    # Explore: real ticks, 2 tiles per tick running, arrival at the engine's end tile, mid-run re-route.
    page.keyboard.press("9")
    page.wait_for_timeout(200)
    ex = "window.__trainer.st.ex"
    far = page.evaluate(f"""(() => {{ const ex = {ex}, g = ex.grid, E = window.PathEngine;
        let best = null;
        for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {{
          if (g.isBlocked(x, y) || ex.npcs.some((n) => x >= n.x && x < n.x + n.w && y >= n.y && y < n.y + n.h)) continue;
          const r = E.findPath(g, ex.pos, {{ x, y }}, {{ altRoute: false }});
          if (r.reached && !r.truncated && (!best || r.tiles.length > best.n)) best = {{ x, y, n: r.tiles.length, end: r.end }};
        }}
        return best; }})()""")
    click_tile(page, far["x"], far["y"])
    page.wait_for_timeout(1500)  # click lands on the next tick, then at least one more tick of movement
    page.screenshot(path=str(SHOTS / "explore_running.png"))
    seg = page.evaluate(f"{ex}.seg")
    if not (seg and len(seg) == 3):
        failures.append(f"explore: expected a 2-tile run segment, got {seg}")
    steps = far["n"] - 1
    page.wait_for_timeout(600 * ((steps + 1) // 2) + 800)
    pos = page.evaluate(f"{ex}.pos")
    if pos != {"x": far["end"]["x"], "y": far["end"]["y"]}:
        failures.append(f"explore: ended at {pos}, expected {far['end']}")
    # Re-click mid-run: the new route must start from the true tile at the tick it is processed.
    page.evaluate(f"(() => {{ const ex = {ex}; ex.probe = []; const orig = window.PathEngine.findPath; window.PathEngine.findPath = (g, s, t, o) => {{ ex.probe.push({{ x: s.x, y: s.y }}); return orig(g, s, t, o); }}; }})()")
    start = page.evaluate(f"{ex}.pos")
    click_tile(page, 0, 0)
    page.wait_for_timeout(1300)
    click_tile(page, 23, 23)
    page.wait_for_timeout(700)
    probe = page.evaluate(f"{ex}.probe")
    if len(probe) != 2 or probe[0] != start:
        failures.append(f"explore re-route sources: {probe}, start {start}")

    # Dodge: end-of-tick hits, run-over is safe.
    page.keyboard.press("0")
    page.wait_for_timeout(300)
    dg = "window.__trainer.st.dg"
    # Acid floor (default style): following the solver's plan is clean at par; clicking the flag isn't.
    plan = page.evaluate(f"{dg}.acid.best.plan")
    for s in plan:
        click_tile(page, s["click"]["x"], s["click"]["y"])
        page.wait_for_function(f"(() => {{ const d = {dg}; return d.pos.x === {s['stop']['x']} && d.pos.y === {s['stop']['y']} && (d.route.length === 0 || {str(s['click'] != s['stop']).lower()}); }})()", timeout=20000)
    page.wait_for_function(f"{dg}.acid.done", timeout=5000)
    res = page.evaluate(f"(() => {{ const a = {dg}.acid; return [a.touched, a.clicks, a.best.clicks]; }})()")
    if res[0] != 0 or res[1] != res[2]:
        failures.append(f"acid: following the plan gave touched/clicks/best = {res}")
    page.screenshot(path=str(SHOTS / "acid_review.png"))
    page.keyboard.press("Enter")
    page.wait_for_timeout(200)
    target = page.evaluate(f"{dg}.acid.target")
    click_tile(page, target["x"], target["y"])
    page.wait_for_function(f"{dg}.acid.done", timeout=20000)
    if page.evaluate(f"{dg}.acid.touched") == 0:
        failures.append("acid: clicking the flag directly should touch acid")
    page.keyboard.press("Enter")
    page.wait_for_timeout(200)
    page.screenshot(path=str(SHOTS / "acid.png"))
    page.select_option("#dgStyle", "puzzle")
    page.wait_for_timeout(200)
    # Puzzle style: a gold tile survives, the obvious calm tile is a trap.
    for pick, want in (("winners[0]", True), ("naive", False)):
        target = page.evaluate(f"{dg}.puzzle.wave.{pick}")
        click_tile(page, target["x"], target["y"])
        page.wait_for_function(f"{dg}.puzzle.done", timeout=15000)
        ok = page.evaluate(f"{dg}.puzzle.ok")
        if ok != want:
            failures.append(f"dodge puzzle: clicking {pick} gave ok={ok}")
        if not want:
            page.screenshot(path=str(SHOTS / "dodge_puzzle_review.png"))
        page.keyboard.press("Enter")
        page.wait_for_timeout(200)
    page.screenshot(path=str(SHOTS / "dodge_puzzle.png"))
    page.select_option("#dgStyle", "survival")
    page.wait_for_timeout(200)
    lane = page.evaluate(f"""(() => {{ const dg = {dg}, g = dg.grid;
        for (let y = 0; y < g.h; y++) for (let x = 0; x + 2 < g.w; x++)
          if (!g.isBlocked(x, y) && !g.isBlocked(x + 1, y) && !g.isBlocked(x + 2, y) && !g.hasWallE(x, y) && !g.hasWallE(x + 1, y)) return {{ x, y }};
      }})()""")
    def dodge_case(stand_still):
        return page.evaluate(f"""(async () => {{ const dg = {dg}, L = {lane};
            Object.assign(dg, {{ hp: 99, hits: 0, nextWave: 1e9, pending: null, dead: false, paused: true }});
            dg.pos = {{ x: L.x, y: L.y }};
            const t = dg.tick + 1;
            dg.route = {('[]' if stand_still else '[{ x: L.x + 1, y: L.y }, { x: L.x + 2, y: L.y }]')};
            dg.splats = [{{ x: L.x + {0 if stand_still else 1}, y: L.y, land: t, until: t + 3 }}];
            dg.paused = false;
            while (dg.tick < t) await new Promise((r) => setTimeout(r, 5));
            dg.paused = true;
            return dg.hits; }})()""")
    page.keyboard.press("r") if not page.evaluate("window.__trainer.st.run") else None
    if dodge_case(True) != 1:
        failures.append("dodge: standing on a pool at tick end should hit")
    if dodge_case(False) != 0:
        failures.append("dodge: running over a pool mid-tick should be safe")
    page.evaluate(f"(() => {{ const dg = {dg}; Object.assign(dg, {{ paused: false, nextWave: dg.tick + 1 }}); }})()")
    page.wait_for_timeout(1300)
    click_tile(page, 1, 1)
    page.wait_for_timeout(700)
    page.screenshot(path=str(SHOTS / "dodge.png"))

    page.keyboard.press("?")
    page.screenshot(path=str(SHOTS / "rules.png"))
    page.keyboard.press("Escape")
    browser.close()

for f in failures + errors:
    print("FAIL", f)
print("smoke ok" if not failures and not errors else f"{len(failures) + len(errors)} problems")
sys.exit(1 if failures or errors else 0)
