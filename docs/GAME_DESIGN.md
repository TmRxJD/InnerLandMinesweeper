# Inner Land Minesweeper — Game Design Overview

**Status:** playable. This document describes the game **as it currently plays**. The numbers in
the tables are the live tuning values (`src/engine/tuning.ts`) — tuned, not frozen.

---

## The pitch

Minesweeper × *The Tower*'s Inner Land Mines × a dash of Bomberman.

> **Finding a mine is good — mines are your weapons. Clear the field from a corner inward, build
> big stacks on the mines nearest the centre, and unleash them on the Boss. The clock is your
> score, not your executioner.**

Every tile is a 1-HP enemy that vaporises on any hit — *except* the Boss at the centre, the one
enemy with real HP, which **only mine blasts can hurt**. So the loop is a fast outward→inward race:
sweep the field to find your mines, chain detonations to clear ground and pump the inner mines'
stacks, and deliver those stacks to the Boss before the clock climbs. Finish fast for a medal.

---

## Where it comes from

Themed on *The Tower*'s Inner Land Mines (ILMs) and its enemies:

| The Tower | Inner Land Minesweeper |
|---|---|
| Inner Land Mines | The mines you uncover and detonate |
| ILM charge / recursive scaling on shared hits | Mine **stack**, grown by overlapping blasts |
| ILM area damage | A square blast whose size grows with the stack |
| Magnetic Hook (pulls ILMs toward the boss) | Pull an armed mine one tile toward the Boss |
| The Boss you burn down with ILMs | The centre Boss, killable only by blasts |

You don't need to know *The Tower* to play. The theme is flavour; the game stands alone.

---

## The field

Every non-centre tile is a **1-HP enemy**. It clears from a single tap or any blast. Enemies come
in the Tower's classes (Common/Advanced/Elite/Fleet) purely for **sprite variety** — the class is
cosmetic, it does not change HP or behaviour. There are no per-enemy health bars (a 1-HP enemy has
nothing to show); only the Boss carries HP.

Mines are hidden among the enemies. There is **no flag** — you sweep mines, you don't mark them.

---

## Mines are your weapons

- **Tap a hidden mine → it arms.** It uncovers as a glowing Inner Land Mine with an `N×` stack
  badge whose colour ramps with the stack. Free and safe; it does not explode.
- **Tap an armed mine → it detonates.**

**Detonation** deals `stack` damage across a **square** around the mine, and the **radius grows with
the stack too**:

```
radius = 1 + ⌊(stack − 1) / 2⌋      (capped at 3)   → stack 1→r1, 3→r2, 5→r3
damage = stack                       (every tile in the square takes this)
```

1-HP enemies in the square vaporise; the Boss (if in range) takes `stack`. So a bigger stack both
**clears more ground** *and* **hits the Boss harder and from further away** (radius = reach). A blast
also:

- **chain-arms** any hidden mine, and
- **overlap-charges** every *armed* mine (+1 stack, capped at the stack cap),

for any mine **inside the blast OR one ring beyond it** — a mine that merely *neighbours* a blast
tile still catches the overlap. This one-ring reach matters because mines never spawn touching: at
stack 1 (radius 1) a mine two tiles away is just outside the blast, and without the +1 trigger you
could only ever stack by hooking mines together first. With it, detonating *next to* a mine pumps
it, so overlap-charging works straight off the spawn — hooks then *tighten* a cluster rather than
being the only way to build one. (Ground damage stays at the true radius; the extra ring only
triggers mines.)

That overlap is the engine of the game: detonating outer mines pumps the inner ones, so you build
the biggest stacks in the centre — exactly where the Boss is.

---

## Charge & tapping

**Charge** is a small, regenerating pool (`current / max` in the HUD). A **hand-tap costs 1 charge
and clears one 1-HP enemy** (broke → the tap does nothing). Charge is deliberately scarce, so you
can't tap the whole board — you tap to find mines and open ground, and let **blasts** (which clear
their whole square for free) do the bulk of the work.

**The Boss is immune to hand-taps.** Only blasts hurt it. Tapping it does nothing.

---

## The Boss

A single tile at the exact centre, and the only multi-hit enemy (HP **18 / 28 / 40** by difficulty).
You kill it by **delivering blast damage** to the centre: detonate charged mines near it. Like every
special tile, the Boss is hit when it merely **neighbours the blast** (radius **+1**), so a mine one
empty tile away already chips it — you do **not** have to land a mine right against it. Radius also
grows with stack, so a well-charged mine tags the Boss from further still.

The killers spawn as a **sparse, non-touching wedge** near the Boss. How many of them (beyond the
bare ≈√(2·HP) minimum) is the per-difficulty **hook-reliance dial** (`killerMargin`):

- **Easy** — a generous margin, so even a **spread, un-hooked chain finishes the Boss**. Hooks are
  optional; they just let you win faster / score better.
- **Standard** — a smaller margin: many boards fall to a loose chain, but plenty need you to hook a
  few mines together first.
- **Hard** — near-minimal: the mines only chain to a kill once **hooked into a tight cluster**, so on
  Hard the Magnetic Hook is effectively **required**.

So the floor is hook-free on Easy and the ceiling always rewards hooks; difficulty is partly *how
much the Boss forces you to route mines with hooks*. (There is no hand-tap fallback — the Boss is
blast-only.) Empirically (headless, a deliberately weak no-hook player): Easy 100% / Standard ~68% /
Hard 0% winnable without hooks, while the hook-using reference bot clears 100% everywhere.

---

## Magnetic Hook

A single-use, earnable, repeatable delivery tool — the game's main expression of *routing* skill.

- **Earn it.** Magnetic Hook bonus tiles hide on the field in the **outer/mid rings only** (never near
  the centre, so you can't farm them by tapping around the Boss). They are **not marked** — a hook is a
  *discovery*: clearing a tile that hides one — by tap or blast — grants **+1 hook charge** (the HUD
  **Hooks** count ticks up; you can hold several). *(A dev/testing build can mark them: `?showhooks` in
  the browser, `--debug` in the CLI.)*
- **Spend it.** **Right-click** (desktop) or **long-press** (touch) an armed mine to pull it **one
  tile toward the Boss** (dominant axis first). It slides into cleared ground, or **crushes** the
  enemy in the way (a free clear); it can't move onto another mine, onto the Boss, or off-grid.
- **Numbers stay honest** — moving a mine updates the adjacent-mine counts at both the old and new
  cell.

Why one tile, player-chosen? Because that keeps it a *routing* decision — which mine, when, along
which lane you've cleared — rather than a board-warping nuke. It's the tool for "my biggest stack is
two tiles short of the Boss."

---

## Numbers stay honest

When a mine leaves a cell — detonated *or* hooked away — every adjacent revealed number updates.
Numbers come only from tiles you cleared **by hand**; blast-vaporised tiles never reveal a number, so
your information stays tied to the taps you chose to make. (Deduction here is light and optional: no
tap is ever fatal, so the numbers are an efficiency aid for finding mines, not a survival puzzle.)

---

## Winning, and the clock

**Win:** the whole field cleared **and** the Boss dead. There is **no lose condition** — every board
is completable, and the clock only counts **up**. Your **time is your score**: faster is better, and
each difficulty awards **gold / silver / bronze** medals under set thresholds. (The run pauses on
tab-hide, so nobody's time is ruined by a phone call.)

---

## Board & difficulties

Odd squares, so the Boss sits at a true centre. Every board is **seeded and deterministic** (same
seed → same board), which powers the CLI, the harness, and any future daily board.

| Difficulty | Size | Mines | Hooks | Boss HP | Stack cap | Max charge | Regen | Par | Gold / Silver / Bronze |
|---|---|---|---|---|---|---|---|---|---|
| **Easy** (`gentle`) | 13×13 | 24 | 8 | 18 | 6 | 12 | 1.0/s | 1:15 | ≤0:48 / ≤1:00 / ≤1:15 |
| **Standard** | 17×17 | 40 | 13 | 28 | 7 | 14 | 1.1/s | 2:10 | ≤1:28 / ≤1:48 / ≤2:10 |
| **Hard** | 21×21 | 62 | 20 | 40 | 8 | 16 | 1.2/s | 2:55 | ≤2:02 / ≤2:25 / ≤2:55 |

The **caps scale with difficulty** — a harder board gives bigger max stacks and a bigger charge
pool (its bigger Boss and field need them). Blast-radius cap is 3 everywhere (a consistent blast
size), a tap always costs 1 charge, and mines are ~14% of the field. Generation guarantees:

- the **opening is a corner** (zero adjacent mines, safe first tap — routes play inward);
- the **Boss is pinned to centre and never a mine**;
- **no two mines ever spawn touching** (Chebyshev-adjacent) — every stack is *built*, never found;
- the **Boss-killing mines spawn as a sparse wedge** in the "near" zone (within `gatherRadius` of the
  Boss, one side only, never inside the inner two rings), sized to ≈√(2·BossHP) + margin — the
  minimum that can chain past the Boss's HP. Because they don't touch and aren't in range at rest,
  **the only way to kill the Boss is to hook them into a tight blob and chain it** — no cheese path;
- **field ordnance** (the rest of the mines) spawns strictly *outside* the near zone — ammunition for
  clearing ground, never accidentally part of the kill cluster;
- **Magnetic Hook tiles only in the outer rings**, so pulls are earned by clearing outward.

This is verified solvable the only honest way: the reference bot **completes 100%** of boards on every
difficulty (see Balance status), and the "blind prober" **completes 0%**.

> Note: medal/par times are calibrated against the reference bot in the headless sim and will be
> re-tuned against real wall-clock play. The gathering requirement makes clears longer than the
> earlier no-gather model (Easy now ~100 s for the bot; a fast human should beat that).

---

## Accessibility & platform

- **Class is shown by colour + shape** (recoloured Tower sprites).
- **`prefers-reduced-motion` honoured** — shockwaves, particles, screen-shake all have a calm path.
- **Full keyboard navigation and ARIA** — the board is real DOM (roving tabindex, per-tile labels).
- **Touch-first** — tap to clear/arm, tap the orb to detonate, **long-press an armed mine to hook**;
  the board fits phone widths.

---

## Architecture & tooling

- **Framework-free engine** (`src/engine`) — pure TypeScript, deterministic, emits an ordered event
  list on every action. Its only host output is a `GameResult` (time + medal). All tunables live in
  `tuning.ts`.
- **DOM board + one canvas FX overlay** (`src/ui`) — vanilla TS, driven by the engine's events.
- **Headless CLI** (`pnpm play`) — ASCII board; `t`/`d`/`h` = tap / detonate / hook; `--debug`,
  `--moves`, `--auto` (`--n` for a speed sweep).
- **Speed harness** (`pnpm harness`) — the board always completes, so the metric is **clear time**,
  not win rate: median time + medal split + **hooks used** per bot, flagging any board that can't
  finish or where blind play isn't slower. The reference bot runs three phases — clear the field
  outward (sparing the near-Boss killers), **gather** those killers with directional hooks *only when
  a chain-damage prediction says the spread won't kill the Boss on its own*, then **chain** in a one-
  ply-greedy order (measured against an offline beam search at ~95% of the optimal boss delivery). It
  runs alongside two references: **`noHook`** — the same player with gathering switched off, whose
  finish-rate measures how hook-dependent each difficulty is — and the **blind prober**, which can't
  kill the blast-only Boss at all.
- **Watch-demo** — the same reference bot plays the real UI hands-off.

The game is a **standalone repo**, to be embedded in the Tower Run Tracker later via `GameResult` —
the engine knows nothing about the host.

---

## Balance status

Reference bot (hooks used *only when needed*) over the headless sim — **finishes 100%** on every
difficulty, median clear ~**96 / 130 / 160 s**, landing mostly **silver** with a spread to gold (fast
runs) and bronze (slow); it never fails to medal. Hooks spent scale with difficulty and need, not
habit: **median 0 / 0 / 3** (Easy / Standard / Hard) — on Easy the spread chain always wins so it
never hooks, on Hard it hooks a few mines to make the chain lethal.

The hook-reliance ramp is the point of the `killerMargin` dial. Measured by the `noHook` reference
(same player, gathering off), **winnable without hooks: Easy 100% / Standard ~59% / Hard 0%** — hooks
optional on Easy, needed on many Standard boards, effectively required on Hard (rare tightly-spawned
seeds aside). The **blind prober finishes 0%** everywhere — no cheese path. No balance flags.

So the shape is: the floor is hook-free on Easy, hooks are what win the hard boards *and* what shave
time for a better medal — you never hook out of habit, only when it pays.

## Open questions

Empirical — answered by play, not argument:

- Does the **gather-then-chain** climax feel like *routing skill* or *busywork*? Levers: `gatherRadius`,
  `killerMargin`, Boss HP.
- Hooks are abundant (14 / 22 / 32 tiles) but the bot needs only a few — should hooks be *scarcer* so
  managing them is part of the puzzle, or is plenty-on-tap the friendlier call?
- Times settled at ~96 / 130 / 160 s. Right feel, or should the field shrink to speed Easy up?
- Is the outward→inward route compelling, or should generation shape the field more?

---

*Known stale surfaces (to fix): the in-game **help dialog** and some UI copy still describe an older
model. This doc is current; those are not yet.*
