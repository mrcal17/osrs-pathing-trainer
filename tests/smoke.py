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
            const g = st.mode === 'sandbox' ? st.sb.grid : st.q.grid;
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

    page.keyboard.press("?")
    page.screenshot(path=str(SHOTS / "rules.png"))
    page.keyboard.press("Escape")
    browser.close()

for f in failures + errors:
    print("FAIL", f)
print("smoke ok" if not failures and not errors else f"{len(failures) + len(errors)} problems")
sys.exit(1 if failures or errors else 0)
