# OSRS Pathing Trainer

A drill tool for OSRS player movement. It shows a tile grid and asks where you'll walk. Each answer is checked
against a model of the game's pathfinder, and wrong answers come with the rule that decides the case.

Open `index.html` in a browser, or run `start.bat`. There's no install, server or network access. Stats, your list
of missed questions and the sandbox map are saved in the browser's localStorage.

## Modes

| Key | Mode | Question |
|-----|------|----------|
| 1 | Trace | Click every tile you step on, in order, ending on the yellow X. |
| 2 | Tie-breaks | Walk the route one step at a time. Each step is checked straight away, and a wrong step shows every tied direction. |
| 3 | Tick | Where are you standing at the end of tick N? Uses the Run toggle. |
| 4 | Unreachable | The X can't be reached. Which tile do you end up on? |
| 5 | Melee | You attack an NPC of size 1–5. Which tile do you stop on? |
| 6 | Mixed | Random questions, weighted towards your weakest mode. |
| 7 | Misses | Replays questions you got wrong (by seed). A right answer removes one. |
| 8 | Sandbox | Paint rocks and walls, place the player or an NPC, and click to see routes. |

Other keys: `Enter`/`Space` submits or goes to the next question, `Backspace`/right-click undoes a trace step,
`N` skips, `A` replays the movement, `O` cycles the overlays (steps from you / search order, unlocked after you
answer), `R` toggles run, `?` opens the rules.

After you answer, hovering a tile shows how many steps away it is, its position in the search order, and which
direction it was entered from. That's usually enough to see why the route went the way it did.

## The model

The model is in `engine.js`:

- The search is a breadth-first search from the player's tile. Neighbours are expanded in the order W, E, S, N,
  SW, SE, NW, NE, and a diagonal step costs 1. The goal is checked when a tile is taken off the queue.
- The route is read backwards through the tiles' parents. That gives the same route as a forward rule you can use while
  playing: at each step take the first direction in W, E, S, N, SW, SE, NW, NE that still keeps you on a shortest route.
  In other words, the route is the lexicographically smallest shortest route, and a test checks this on 4000 random maps.
  Straight directions come before diagonals, so in open ground you go straight first and diagonal last.
- A diagonal step needs both side tiles walkable and no wall on any of the four edges that meet at that corner.
- Unreachable targets use the closest approach. The game scans a 21×21 square centred on the target's SW tile,
  only considers tiles under 100 steps away, and takes the lowest dx²+dy². Ties go to fewer steps, then x
  ascending, then y ascending.
- Melee uses the exclusive-rectangle reach: the tile must share an edge with the NPC, sit outside it, and have no
  wall on that edge. NPCs don't block the route.
- A route is cut at 25 turn points, and the ones nearest the start are kept. Running moves 2 tiles per tick,
  walking 1.

These rules were checked against rsmod's route finder (`engine/routefinder` in `rsmod/rsmod`: `RouteFinding.kt`,
`ReachStrategy.kt`, `RectangularBounds.kt`). The model doesn't cover diagonal wall pieces, blocking ground
decorations, or NPCs that block your steps (like Brawlers). The osrs-sdk pathing in `osrs-rl` is not a reliable
reference: it has no walls, a bug in its fallback scan, and no 25-turn cap.

## Tests

```
node tests/engine.test.js   # rules, hand-checked cases, 4000 random maps vs an independent bit-flag BFS port
python tests/smoke.py       # drives the real page with Playwright and saves screenshots to tests/shots/
```

## Files

- `engine.js`: the pathfinding model and the diagnosis helpers. It's a pure module that works in the browser and in Node.
- `scenarios.js`: the seeded terrain and question generator. The same seed always gives the same question.
- `app.js`: the UI, rendering, quiz flow and sandbox.
- `index.html`, `style.css`: the page.
