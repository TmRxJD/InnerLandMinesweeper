# Inner Land Minesweeper

A *Tower*-themed sweep-the-mines puzzle. You're a mine **sweeper** — finding a mine is good, mines are
your weapons, and the dangerous click is the safe tile. Classic Minesweeper deduction, wrapped in a
risk-and-power economy.

> **Full design:** [`docs/GAME_DESIGN.md`](docs/GAME_DESIGN.md) — read this first.

## Why a separate repo

Deliberately standalone, so nothing tangles with the host site early. The game is built engine-first
and framework-free; the Tower Run Tracker will import it later as **one consumer among potentially
several**, not as its owner.

## Layout

```
src/
  engine/     Pure TS game core. Zero DOM, zero framework, zero I/O.
    types.ts    The contract: TileView, BoardSnapshot, GameEvent, GameResult, MinesweeperEngine.
    tuning.ts   Every playtest-deferred number, in one place, per difficulty.
    index.ts    Public barrel — import from here, never deeper.
  harness/    Headless playout bots. Balance tuning + "reasonably completable" validation.
docs/
  GAME_DESIGN.md   The design overview.
```

The UI layer (Vue component + one canvas FX overlay) and a tiny standalone dev host will live
alongside `engine/` once the engine is real. Until then this is a types-and-tuning skeleton.

## Principles

- **Engine emits events, never diffs.** Every mutating call returns an ordered `EventList`; the UI
  animates from that. `snapshot()` is the read model.
- **The engine's only output to a host is `GameResult`.** It knows nothing about persistence.
- **Seeded and deterministic.** Same seed + difficulty + inputs → identical run. Required for the
  harness, for shareable boards, and for a future daily.
- **The harness is a first-class citizen.** Balance is settled by thousands of headless playouts,
  including an adversarial "blind-prober" bot, not by hand-playing.

## Status

Pre-implementation. Type contract and tuning constants are in; `createEngine`, the harness bots, and
the UI are next.

## Scripts

```bash
pnpm type-check   # tsc, no emit
pnpm test         # vitest
pnpm harness      # run headless playouts (once implemented)
```
