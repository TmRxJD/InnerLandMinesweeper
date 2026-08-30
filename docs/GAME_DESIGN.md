# Inner Land Minesweeper — Game Design Overview

**Status:** playable, in tuning. This document describes the game **as it currently plays**. Numbers
in the tuning table are the live values; they are still being tuned, not frozen.

---

## The pitch

Minesweeper's fiction is backwards. You play a mine *sweeper*, yet the game punishes you for finding
a mine and makes you mark them with flags instead of clearing them. Inner Land Minesweeper flips that:

> **Finding a mine is good. Mines are your weapons. Enemies hold the board; you clear it before the
> clock runs out.**

Every hidden tile is a Tower enemy. Weak ones you kill by hand. Tougher ones are **shielded** — the
only thing that hurts them is a **mine blast**. So the loop is: sweep the weak enemies to read the
board and find your mines, then detonate mines to blow open the tough ground — and grind down the
Boss at the centre before time runs out.

---

## Where it comes from

Themed on *The Tower*'s Inner Land Mines and its enemies. The mapping is deliberate:

| The Tower | Inner Land Minesweeper |
|---|---|
| Inner Land Mines (ILMs) | The mines you uncover and detonate |
| Enemies with HP | The tiles — each is a real Tower enemy |
| Enemy categories (Normal / Elite / Fleet / Boss) | The tile classes |
| ILM blast | Detonation damage in a radius |
| ILM charge, recursive scaling on shared hits | Mine charge, grown by overlapping blasts |

You don't need to know *The Tower* to play. The theme is flavour; the game stands alone.

---

## Enemy classes

Every tile is one of five classes, shown by **colour and shape** (the real extracted Tower sprites,
recoloured so a class reads at a glance). Colour is never the only cue — each class is a distinct
enemy silhouette too.

| Class | Colour | Real enemies | HP band _(tuning)_ | Cleared by |
|---|---|---|---|---|
| **Common** | grey | Basic, Fast, Tank | 1–2 | **Tapping** (costs charge) |
| **Advanced** | yellow | Ranged, Protector | 2–4 | **Mine blast only** |
| **Elite** | blue | Vampire, Ray, Scatter | 4–6 | **Mine blast only** |
| **Fleet** | red | Saboteur, Commander, Overcharge | 6–9 | **Mine blast only** |
| **Boss** | magenta | Boss | 20–32 | **Tapping** (slow grind) + blasts |

Three rules about HP:

- **The class is visible from the start; the exact HP is hidden.** You know a tile is Fleet, not
  whether it's a 6 or a 9. That gap is the risk when you spend charge.
- **A health bar shows damage.** Every enemy shows a small HP bar; it drains as you hurt it. (This is
  the only damage indicator — there is no separate "crack" overlay.)
- **Tough classes cluster.** The generator clumps tough ground rather than sprinkling it, so you can
  see where the hard terrain is and plan a route.

Frequency is skewed hard toward Common (roughly **Common 60% · Advanced 17% · Elite 14% · Fleet 7%**,
plus the single Boss), so weak enemies dominate and tough ones are the exception.

---

## Mines

Mines are hidden and look exactly like enemy tiles until you touch them — that's the deduction. There
is **no flag**: you sweep mines, you don't mark them.

- **Tap a hidden mine → it arms.** It uncovers as a glowing **Inner Land Mine** with an `N×` charge
  badge. This is free and safe. It does not explode.
- **Tap an armed mine → it detonates.** (Two taps on the same tile: arm, then detonate. This split is
  deliberate — it lets you arm several mines and choose the detonation order.)

Mine density is **higher than classic Minesweeper's ~16%** (25–27%). Mines are ammunition, not
hazards, so scarcity means you can't clear the tough ground.

---

## Tapping

You tap a hidden tile. What happens depends on what's under it:

- **A Common** → it clears, revealing its number (adjacent mines, like classic Minesweeper). Clearing
  costs **charge** equal to its hidden HP. If you can't pay in full you deal partial damage instead,
  shown by the health bar — no time penalty, just slower.
- **A mine** → it arms (see above). Free.
- **An Advanced / Elite / Fleet tile** → **shielded.** Nothing happens but a red bump. You cannot hurt
  these by hand; only a blast reduces their HP.
- **The Boss** → it chips. The Boss is the one tough enemy you *can* work by hand, and with 20–32 HP
  it takes several charged taps (and/or blasts) — the deliberate end-game grind.

**One tile per tap.** There is no flood-fill: clearing a Common with zero adjacent mines opens only
that tile. (This is a deliberate departure from classic Minesweeper — clearing is always a chosen,
paid action.)

---

## Charge

**Charge is your damage currency**, and it is **capped** (22 / 22 / 24 by difficulty) so detonations
can't inflate it without bound. The HUD shows it as `current / max`.

- **Spent** tapping Commons (and grinding the Boss).
- **Refilled** by detonating mines — each detonation converts that mine's charge into your pool.

Because tough tiles are cleared by blasts (free) and Commons are cheap, charge is a secondary
resource; **mines are the primary one.**

---

## Detonation

Detonating an armed mine:

- deals `9 × that mine's charge` damage to every tile in a **radius-2** (Chebyshev) square,
- **vaporises** tiles whose HP it meets — clearing tough enemies and Commons alike, leaving craters,
- **reveals no numbers** for what it vaporises (information stays tied to risky manual taps),
- **converts the mine's charge into your (capped) pool**,
- **uncovers and arms** any hidden mine caught in the blast (chain-arming), and
- **charges every other armed mine whose blast area overlaps the ground it just cleared** — the
  Chrono-Jump analogue. Mine charge is capped (6–7).

A single blast at base charge clears any one tough tile, so mines are powerful and the interesting
question is **where and in what order** to detonate — a charged mine, or a cluster of overlapping
mines, clears a whole region and pumps the survivors.

---

## Numbers stay honest

When a mine detonates it is **gone**, and every adjacent revealed number **decrements**. The
constraint system is always currently true, and a number reaching zero cleanly signals a swept
region. Numbers come only from tiles you cleared **by hand** (tapped Commons, or the Boss); blasts
vaporise without revealing anything, so your information stays tied to the risky manual taps.

---

## Winning and losing

**Win:** every ground tile cleared and every mine uncovered. (Armed mines you never detonated don't
block the win, but you usually need them to clear the tough ground.)

**Lose:** the timer runs out. That's the only failure. It is **generous and fixed per difficulty** —
it exists to bound a run, not to punish thinking, so a competent player rarely sees it.

---

## Score

```
score = (timeRemaining × difficultyMultiplier) + (25 × maxChain) − (15 × cracks)
```

- **timeRemaining** — efficiency.
- **maxChain** — the largest chain of clears one detonation produced (sequencing skill).
- **cracks** — under-charged taps (an inefficiency count).

Leaderboards are **per difficulty**; scores across sizes aren't comparable.

---

## Board & difficulties

Boards are **odd squares** so the Boss sits at a true centre with an equal number of tiles on all four
sides. Every board is **seeded and deterministic** (same seed → same board), which also powers the
CLI, the harness, and any future daily/shareable board.

| Difficulty | Size | Mines | Timer | Start / Max charge |
|---|---|---|---|---|
| **Easy** | 9×9 | 25% | 5:00 | 14 / 22 |
| **Standard** | 11×11 | 27% | 7:00 | 15 / 22 |
| **Hard** | 15×15 | 26% | 10:00 | 14 / 24 |

Generation guarantees: a **Common, zero-adjacent opening** for a safe first tap; the Boss pinned to
centre; and — because tough tiles are blast-only — **every tough tile has a mine within blast range**
(any that wouldn't is downgraded to a tappable Common), so no board can soft-lock.

---

## Accessibility & platform

- **Class is never colour-only** — each is a distinct enemy shape too.
- **`prefers-reduced-motion` honoured** — shockwaves, particles, and screen-shake all have a calm path.
- **Full keyboard navigation and ARIA** — the board is real DOM (roving tabindex, per-tile labels).
- **Touch is first-class** — tap to clear/arm, tap the orb to detonate; the board fits phone widths.
- **The run pauses** on tab-hide, so nobody loses to a phone call.

---

## Architecture & tooling

- **Framework-free engine** (`src/engine`) — pure TypeScript, deterministic, emits an ordered event
  list on every action. Its only output to a host is a `GameResult`.
- **DOM board + one canvas FX overlay** (`src/ui`) — vanilla TS, driven by the engine's events.
- **Headless CLI** (`pnpm play`) — ASCII board, tap/detonate REPL, `--moves` scripting, `--debug`
  (reveal mines), `--auto` (the reference bot plays; `--n` for a quick win-rate sweep). Built for
  driving and tuning the game without a browser.
- **Balance harness** (`pnpm harness`) — playout bots over many seeds. A reasonable "greedy" bot and
  an adversarial "blind-prober"; invariants are guarded in tests.
- **Watch-demo** — the same reference bot plays the real UI hands-off, cycling boards.

The game is a **standalone repo**, to be embedded in the Tower Run Tracker later as one consumer via
`GameResult` — nothing in the engine knows about the host, Appwrite, or persistence.

---

## Balance status

Current reference-bot win rate (headless, non-deducing, non-charging bot): **Easy ~81% · Standard
~85% · Hard ~73%**; the blind-prober wins **0%** everywhere (tough tiles are shielded, so ignoring the
mine economy leaves the board unclearable). A real player does better than the bot. These confirm the
economy is solvent and that mines-as-the-key-resource holds up.

## Open tuning questions

These are empirical — answered by play and the CLI/harness, not by argument:

- Base blast damage is high enough that a single blast clears any one tough tile. Does that make mines
  feel powerful and satisfying, or does it make the charge/overlap mechanic irrelevant? (Alternative:
  lower blast damage and guarantee two mines per tough tile — more strategic, more generation work.)
- Is the Boss grind a satisfying end-game or a chore?
- Is the hidden-HP-within-a-visible-class gamble fair once tough tiles are blast-only?
- Are the per-difficulty mine densities and timers in the right place?
