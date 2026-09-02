# Inner Land Minesweeper — Game Design Overview

**Status:** playable / shippable. This document describes the game **as it currently plays**. The
numbers in the tables are the live tuning values (`src/engine/tuning.ts`) — tuned, not frozen.

---

## The pitch

Minesweeper × *The Tower*'s Inner Land Mines × a roguelike speedrun.

> **Finding a mine is good — mines are your weapons. But they're one scarce pool that has to do two
> jobs: clear the field *and* kill the Boss. Spend too many clearing and the Boss outlives your ammo.
> And it's a race against yourself: after your first clear, the clock counts *down* from your best
> time — beat it or the run is lost.**

Every tile is a 1-HP enemy that vaporises on any hit — *except* the Boss at the centre, the one enemy
with real HP, which **only mine blasts can hurt** and which hides behind a regenerating shield. The
loop is a fast outward→inward race under real pressure: sweep the field to find your mines, chain
detonations to clear ground and pump your mines' stacks, hook a cluster to the moated Boss, and break
it — all before the countdown hits zero. Two ways to lose, one way to win, and every game has to be
faster than the last.

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

Every non-centre tile is a **1-HP enemy**. It clears from a single tap or any blast. Enemies come in
the Tower's classes (Common/Advanced/Elite/Fleet) purely for **sprite variety** — the class is
cosmetic; it does not change HP or behaviour. Only the Boss carries HP.

Mines are hidden among the enemies. There is **no flag** — you sweep mines, you don't mark them.

---

## Mines are ONE scarce pool — and bad allocation is fatal

Your mines are your **entire arsenal for both jobs**: clearing the field *and* killing the Boss. The
HUD **Mines** counter is your remaining ammo (positions stay hidden, like a classic mine counter — you
budget how many to spend without being told where they are).

- **Tap a hidden mine → it arms** (safe): it uncovers as a glowing Inner Land Mine with an `N×` stack
  badge whose colour ramps with the stack.
- **Tap an armed mine → it detonates.**

Spend too many mines opening the board and you won't have enough left to break the Boss — the run is
**lost** ("Out of mines") the instant the mines remaining can no longer finish the kill. This is the
core roguelike tension: every detonation is an allocation decision.

**Detonation** deals `stack` damage across a **square** around the mine, and the **radius grows with
the stack**:

```
radius = 1 + ⌊(stack − 1) / 2⌋      (capped at 3)   → stack 1→r1, 3→r2, 5→r3
damage = stack                       (every tile in the square takes this)
```

A single detonation does four things:

1. **Vaporises** the 1-HP ground in its square (and deals `stack` to the Boss if in reach).
2. **Blast-arm cascade** — arms any hidden mine and pumps any *armed* mine it touches (inside the
   blast **or one ring beyond**), so detonations chain and mines never need to spawn touching.
3. **Scaled overlap boost** — the pump a neighbouring mine receives *scales with the detonator's own
   stack*: `overlapBoost = max(1, ⌊stack · 0.5⌋)`. A 1×/2×/3× passes **+1**, a **4× passes +2** (lifts
   a 1× to 3×), a 6× passes +3. So one fat mine snowballs the whole cluster — building a big mine and
   setting it off beside the blob is the engine of the game.
4. **Shrapnel** — on top of its square, the blast takes `⌊stack · 1⌋` **extra** enemies with it from
   the ring just outside the blast. This is the field-clearing payoff for a big stack — a reason to
   grow mines even away from the Boss. Its reach is **capped** (`shrapnelMaxReach = 3`) so a big mine's
   shrapnel never lands beyond a full-size blast's footprint — it can shred a lot, but not across the
   board. Shrapnel only ever hits ground (never mines or the Boss), so it can't cheese the kill.

The Boss and mines are affected at the **extended (radius + 1) reach**; plain ground only at the true
radius.

---

## Charge — a small budget you earn back

**Charge** gates hand-tapping: a **hand-tap costs 1 charge** and clears one 1-HP enemy (broke → the
tap does nothing). Charge does **not** passively regenerate. Instead:

- You **start with only a little** (`startingCharge`, well below the max).
- **Detonating a mine refunds charge** — `round(stack · 0.5)`, so a **bigger mine refunds more**. This
  climbs toward a ceiling (`maxPlayerCharge`) you can only reach by detonating.

So you can't hand-clear the board: you tap to find mines and open lanes, then let **blasts** (which
clear their whole square for free and refund charge) do the bulk of the work. Mindless tapping stalls
— you run the small budget dry and, without detonating big mines to refuel, you're stuck.

**The Boss is immune to hand-taps.** Only blasts hurt it.

---

## The Boss — moated, and behind a regenerating shield

A single tile at the exact centre, the only multi-hit enemy. Two defences make it a real fight:

**A blast-free moat.** No mine spawns within `blastRadiusCap + 1` of the Boss, so **no blast reaches
it from the field** — you **must** hook a charged cluster in to deliver the kill. Hooks aren't a
luxury here; they're the only delivery mechanism (the headless `noHook` player wins **0%**).

**A regenerating shield.** The Boss has a **shield** (cyan layer on its bar) in front of its **HP**:

- **Absorb-then-overflow.** A hit fills the shield first; only the **overflow past it** reaches HP. A
  hit smaller than the shield deals **zero HP damage** (the shield must be down to hurt the Boss), but
  a hit that *breaks* the shield carries its remainder through — nothing is wasted.
- **It regrows when neglected.** If the Boss goes `bossRegenDelayMoves` moves without taking damage,
  the shield heals `bossShieldRegenPerMove` per move back up to its max. So you **can't** clear the
  whole board in peace and then one-shot a fresh Boss — hit it and *keep* hitting. Commit.

Its bar shows `HP + shield` and is always visible.

---

## Magnetic Hook

A single-use, earnable, repeatable delivery tool — the game's main expression of *routing* skill, and
**required** to reach the moated Boss.

- **Earn it.** Magnetic Hook bonus tiles hide on the field in the **outer/mid rings only** (never near
  the centre). They are **not marked** — clearing a tile that hides one, by tap or blast, grants **+1
  hook charge** (the HUD **Mag Hooks** count ticks up; you can hold several). *(A dev/testing build can
  mark them: `?showhooks` in the browser, `--debug` in the CLI.)*
- **Spend it.** **Drag** an armed mine one tile in any of 8 directions, or **right-click** /
  **long-press** it for a quick pull toward the Boss. It slides into cleared ground or **crushes** the
  1-HP enemy in the way (a free clear); it can't move onto another live mine, the Boss, or off-grid.
- **Numbers stay honest** — moving a mine updates the adjacent counts at both the old and new cell.

You gather a cluster of charged mines against the Boss, then chain it — the shield and moat mean a
loose, un-gathered chain won't do.

---

## Numbers stay honest

When a mine leaves a cell — detonated *or* hooked away — every adjacent revealed number updates.
Numbers come only from tiles you cleared **by hand**; blast-vaporised (and shrapnel) tiles never
reveal a number, so your information stays tied to the taps you chose to make.

---

## Winning, losing, and the speedrun clock

**Win:** the whole field cleared **and** the Boss dead.

**Lose** — two ways:

- **Out of mines** — you spent too much of the pool clearing and can no longer finish the Boss.
- **Too slow** — the speedrun clock ran out (see below).

**The speedrun clock.** Your **first** game on a difficulty is untimed and just sets a baseline: your
clear **time is your best**. Every game after that starts the clock at your best time and counts
**down**. Clear before it hits zero and, if you beat your best, that becomes the new time to chase;
run it out and the run is lost. Clear times still earn **gold / silver / bronze** medals at set
thresholds. (The run pauses on tab-hide, so nobody's time is ruined by a phone call.)

**Progress & high scores.** Best times and a per-difficulty record (games played, cleared, win rate,
best medal) are kept in the browser (`ilm.best.*`, `ilm.stats`). The header has three icon buttons:
**?** (how to play), **🗑** (reset all progress — clears best times and stats), and **🏆** (high scores
& stats). Reset asks for confirmation; it can't be undone.

---

## Board & difficulties

Odd squares, so the Boss sits at a true centre. Every board is **seeded and deterministic** (same
seed → same board), which powers the CLI, the harness, and any future daily board.

| Difficulty | Size | Mines | Hooks | Boss HP + Shield | Stack cap | Start / Max charge | Par | Gold / Silver / Bronze |
|---|---|---|---|---|---|---|---|---|
| **Easy** (`gentle`) | 15×15 | 34 | 30 | 14 + 5 | 6 | 18 / 40 | 0:50 | ≤0:30 / ≤0:38 / ≤0:50 |
| **Standard** | 17×17 | 42 | 45 | 30 + 9 | 7 | 22 / 48 | 1:06 | ≤0:44 / ≤0:54 / ≤1:06 |
| **Hard** | 21×21 | 62 | 70 | 42 + 12 | 8 | 26 / 56 | 1:30 | ≤1:00 / ≤1:14 / ≤1:30 |

Shared across difficulties: charge does **not** regenerate (earned by detonating, `round(stack·0.5)`
per mine); blast-radius cap is 3; the overlap boost is `⌊stack·0.5⌋`; shrapnel is `⌊stack·1⌋` capped at
Chebyshev 3; the shield regrows after 4 idle moves; a tap costs 1 charge; mines are ~14% of the field.

Generation guarantees:

- the **opening is a corner** (zero adjacent mines, safe first tap — routes play inward);
- the **Boss is pinned to centre and never a mine**;
- **no mine spawns inside the blast-free moat** (`blastRadiusCap + 1` around the Boss) — so the kill
  **must** be hooked across it;
- **no two mines ever spawn touching** (Chebyshev-adjacent) — every stack is *built*, never found;
- **Magnetic Hook tiles only in the outer rings**, so pulls are earned by clearing outward.

---

## Accessibility & platform

- **Class is shown by colour + shape** (recoloured Tower sprites).
- **No screen shake** (a fast game; a kick every detonation would be obnoxious). Effects are
  deliberately **subtle**. `prefers-reduced-motion` additionally suppresses ambient looping motion
  (Boss idle pulse, orb pulse); the brief gameplay-feedback flourishes still play.
- **Full keyboard navigation and ARIA** — the board is real DOM (roving tabindex, per-tile labels).
- **Touch-first** — tap to clear/arm, tap the orb to detonate, **long-press an armed mine to hook**;
  the board fits phone widths.

---

## Architecture & tooling

- **Framework-free engine** (`src/engine`) — pure TypeScript, deterministic, emits an ordered event
  list on every action. Its only host output is a `GameResult` (time, medal, outcome, `timedOut`). All
  tunables live in `tuning.ts`; the engine can `clone()` itself for hypothetical play.
- **DOM board + one canvas FX overlay** (`src/ui`) — vanilla TS, driven by the engine's events.
- **Headless CLI** (`pnpm play`) — ASCII board; `t`/`d`/`h` = tap / detonate / hook; `--debug`,
  `--moves`, `--auto` (`--n` for a speed sweep).
- **Speed harness** (`pnpm harness`) — plays the reference bots headlessly and reports finish rate,
  clear time, medal split, and hooks used, flagging any difficulty that's too punishing or cheesable.
  The reference bot budgets its mines against the ammo counter (reserve ~what the Boss needs, spend the
  surplus clearing), gathers a squad to a Boss-adjacent rally point with directional hooks, and chains
  it in a greedy order. Two references bracket it: **`noHook`** (gathering off — measures how
  hook-dependent each difficulty is) and the **blind prober** (random-ish play — measures cheese).
- **Autoplay (in-game)** — a **Monte Carlo Tree Search** planner (`mcts.ts`): each move it clones the
  live game, simulates many futures, and lets the choice emerge from which turn out best. A wall-clock
  budget per move keeps the demo responsive.

The game is a **standalone repo**, embedded in the Tower Run Tracker via an iframe + `postMessage`
handoff of the `GameResult` — the engine knows nothing about the host.

---

## Balance status

Reference bot (a near-optimal player) over the headless sim, n=200: **finishes ~54 / 54 / 52%**
(Easy / Standard / Hard) — a challenging but fair share for strong play. The two guard rails hold:
**`noHook` finishes 0%** everywhere (the moat makes hooks mandatory) and the **blind prober finishes
0%** (no tap-cheese — the small charge budget stalls mindless play). No balance flags.

Because the bot is *near-optimal*, ~55% for it means an average human wins less and a skilled human
more — which is the intended difficulty. Median clear times sit near the gold/silver line, so median
play lands silver and elite play golds.

## Open questions

Answered by play, not argument:

- Does the **gather-then-break-the-shield** climax feel like routing skill, or busywork? Levers:
  `bossShield`, the regen delay/rate, `gatherRadius`.
- Is the **surplus-mines** feel right for a skilled player, or should supply be tighter? (The bot needs
  its full supply, so this can't be tuned on the bot alone — it's a real-play question.)
- Do the **shrapnel** and **scaled boost** read clearly now that each has its own FX, or still opaque?
- Are the **countdown-to-best** stakes motivating, or too punishing on an off run?
