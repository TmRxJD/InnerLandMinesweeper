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
    auto-player.ts  Heuristic reference: clear → gather-when-needed → escalating chain (harness + MCTS rollouts).
    mcts.ts      The AI that drives in-game Autoplay: Monte Carlo Tree Search — clones the game and
                 searches simulated futures, so it reasons per move and plays variedly, not by rules.
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
near-optimal bot wins ~54 / 54 / 52% (Easy / Standard / Hard) while hookless and blind play both win
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
