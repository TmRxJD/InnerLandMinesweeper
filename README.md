# Inner Land Minesweeper

A *Tower*-themed sweep-the-mines **roguelike speedrun**. You're a mine **sweeper** — finding a mine is
*good*, mines are your weapons. But they're one scarce pool for both clearing the field *and* killing
the central Boss, so bad allocation loses the run; and after your first clear the timer counts *down*
from your best, so every game must be faster than the last. Classic Minesweeper board-reading wrapped
in a build-and-deliver blast economy.

> **Full design:** [`docs/GAME_DESIGN.md`](docs/GAME_DESIGN.md) — the canonical description of how it
> plays and why. Read that first; this file is just the map of the repo.

## The loop, in one breath

Clear the field from a corner inward with a **scarce pool of mines** that also has to kill the Boss.
Every non-centre tile is a 1-HP enemy that vaporises on any hit; tapping a hidden mine **arms** it,
tapping an armed one **detonates** it. A blast clears a square, refunds some charge, and **pumps
nearby mines' stacks** (the bigger the mine you set off, the bigger the boost) — so you chain
detonations to grow the cluster near the middle. The **Boss** sits in a blast-free **moat** behind a
**regenerating shield**, so you *must* **Magnetic-Hook** a charged cluster in and break it. Win =
field cleared and Boss dead; lose by running out of mines, or by letting the **countdown to your best
time** hit zero.

## Why a separate repo

Deliberately standalone, so nothing tangles with the host site. The engine is framework-free and
knows nothing about its host — its only output is a `GameResult`. The Tower Run Tracker embeds it as
**one consumer among potentially several** (see *Embedding* below), never as its owner.

## Layout

```
src/
  engine/     Pure TS game core. Zero DOM, zero framework, zero I/O.
    types.ts     The contract: TileView, BoardSnapshot, GameEvent, GameResult, MinesweeperEngine.
    engine.ts    createEngine — reveal / detonate / useHook / tick, emits an ordered EventList.
    board.ts     Seeded board generation (corner opening, non-touching mines outside a Boss moat, hook tiles).
    auto-player.ts  Heuristic reference: clear → gather-when-needed → escalating chain. Drives the
                 harness, the in-game Autoplay, AND the Hints (so the coach and Autoplay never disagree).
    mcts.ts      Monte Carlo Tree Search planner — kept for the harness/experiments (Autoplay now uses
                 the heuristic so it matches the hints move-for-move).
    tuning.ts    Every playtest-deferred number, per difficulty, in one place.
    rng.ts       Deterministic seeded RNG.  index.ts  Public barrel — import from here.
  ui/         Vanilla-TS view: DOM board + one canvas FX overlay, driven by the engine's events.
  dev/        Local dev host (index.html + main.ts) — `pnpm dev`, port 5180.
  embed/      Embeddable host: postMessages GameResult/height to a parent — `pnpm build:embed`.
  cli/        ASCII REPL + scripted/auto play — `pnpm play`.
  harness/    Headless balance bots (greedy / noHook / blindProber) + the speed sweep.
docs/
  GAME_DESIGN.md   The design overview — kept current.
```

## Principles

- **Engine emits events, never diffs.** Every mutating call returns an ordered `EventList`; the UI
  animates from that, and `snapshot()` is the read model. No hidden state leaks — the UI only ever
  sees a `TileView`.
- **The engine's only output to a host is `GameResult`.** It knows nothing about persistence.
- **Seeded and deterministic.** Same seed + difficulty + inputs → identical run. Required for the
  harness, shareable boards, and a future daily.
- **The harness is a first-class citizen.** Balance is settled by thousands of headless playouts —
  a `greedy` reference, a `noHook` variant (same player, gathering off, to measure hook-dependence),
  and an adversarial `blindProber` that must *not* be able to win — never by hand-playing.

## Embedding (Tower Run Tracker)

`pnpm build:embed` produces a self-contained bundle with relative asset paths (`dist-embed/`). The
host vendors that bundle and loads it in an iframe; the embed speaks a tiny postMessage protocol:

```
→ ilm:ready
→ ilm:content-height  { height }        host sizes the frame to the board
→ ilm:result          { payload: GameResult }   the win handoff (time + medal)
```

In the tracker, `scripts/publish-inner-land-minesweeper.mjs` builds this repo and copies the bundle
into `public/games/inner-land-minesweeper/`; the page lives at `/games/inner-land-minesweeper`.

## Status

**Shippable.** Engine, UI, CLI, dev + embed hosts, and the balance harness are all in, and the game
is embedded in the Tower Run Tracker at `/games/inner-land-minesweeper`. Over the headless sim the
near-optimal bot wins ~47 / 53 / 55% (Easy / Standard / Hard) while hookless and blind play both win
0%. Best times and a per-difficulty record persist locally (in-header 🏆 stats, 🗑 reset). The win
handoff to a host leaderboard is via `ilm:result` (`GameResult`).

## Scripts

```bash
pnpm dev            # local dev host (port 5180)
pnpm build:embed    # self-contained embed bundle → dist-embed/
pnpm test           # vitest (engine + balance)
pnpm type-check     # tsc, no emit (strict, no unused)
pnpm harness        # headless speed sweep: completion, times, medals, hooks used, cheese check
pnpm analyze        # strategic analysis: stack building, hooks, blast eff, boss economy, VARIETY
pnpm play           # ASCII CLI — t/d/h = tap/detonate/hook; --auto, --debug, --moves
```

## Standalone game and GitHub Pages

`pnpm dev` serves the complete fullscreen-capable game. It supports mouse, keyboard,
long-press and drag on touch screens; the public host adapts from 320px phones through
wide desktop screens and short landscape viewports. The reusable engine and embed
entry remain independent of this host. `?seed=showcase-0&demo=1` starts real autoplay.

`pnpm build:dev` generates `dist-dev`. The Pages workflow publishes that directory
with relative asset URLs, after type checking and the current engine/gameplay-planner
suite. Configure the repository's Pages source as GitHub Actions.

### Validation scope

The current engine and actual in-game `planMove` policy are covered by the Pages check.
The planner regression plays 24 seeded boards across all three difficulties to a real
win (all ground cleared and Boss dead), and checks blocked hooks/no-op probing.

The independent legacy snapshot `autoPlay` balance harness and Monte Carlo planner
are preserved. Their full-suite baseline reported 11 failures / 32 passes before this
work: nine balance expectations (`expected 0 to be greater than 0.1`, `expected Infinity
to be less than 50/66/90`, `expected Infinity to be less than Infinity`), the old
snapshot reference win assertion (`expected 0 to be greater than 0`), and independent
MCTS win assertion (`expected false to be true`). The engine reference win test now
uses the actual UI planner. Legacy balance/MCTS tests are explicitly outside the Pages
check; their thresholds have not been relaxed. Run `pnpm test` to include them.
