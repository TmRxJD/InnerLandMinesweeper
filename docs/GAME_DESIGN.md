# Inner Land Minesweeper — Game Design Overview

**Status:** playable, tuned around the current model. This document describes the game **as it
currently plays**. The numbers in the tables are the live tuning values (`src/engine/tuning.ts`) —
tuned, not frozen.

---

## The pitch

Minesweeper's fiction is backwards. You play a mine *sweeper*, yet the game punishes you for finding
a mine and makes you mark them with flags instead of clearing them. Inner Land Minesweeper flips that:

> **Finding a mine is good. Mines are your weapons. Enemies hold the board; you clear it before the
> clock runs out.**

Every hidden tile is a Tower enemy with hidden HP. Weak ones fall to a single tap; tougher ones you
wear down — by hand, or far faster with a **mine blast**. The loop: sweep the weak enemies to read
the board and uncover your mines, detonate mines to blow open clusters of tough ground, and grind
down the **Boss** at the centre before time runs out.

---

## Where it comes from

Themed on *The Tower*'s Inner Land Mines and its enemies. The mapping is deliberate:

| The Tower | Inner Land Minesweeper |
|---|---|
| Inner Land Mines (ILMs) | The mines you uncover and detonate |
| Enemies with HP | The tiles — each is a real Tower enemy |
| Enemy categories (Common / Advanced / Elite / Fleet / Boss) | The tile classes |
| ILM blast | Detonation damage in a radius |
| ILM charge, recursive scaling on shared hits | Mine charge, grown by overlapping blasts |

You don't need to know *The Tower* to play. The theme is flavour; the game stands alone.

---

## Enemy classes

Every tile is one of five classes, shown by **colour and shape** (the real extracted Tower sprites,
recoloured so a class reads at a glance). Colour is never the only cue — each class is a distinct
enemy silhouette too.

| Class | Colour | Real enemies | HP band _(tuning)_ |
|---|---|---|---|
| **Common** | grey | Basic, Fast, Tank | 2–4 |
| **Advanced** | yellow | Ranged, Protector | 5–9 |
| **Elite** | blue | Vampire, Ray, Scatter | 10–16 |
| **Fleet** | red | Saboteur, Commander, Overcharge | 18–28 |
| **Boss** | magenta | Boss | scales by difficulty (40–55 / 60–85 / 90–120) |

Three rules about HP:

- **The class is visible from the start; the exact HP is hidden.** You know a tile is a Fleet, not
  whether it's an 18 or a 28. That gap is the risk when you commit charge to it.
- **A health bar shows damage.** Every enemy carries a small HP bar from the start; it drains as you
  hurt it. It is the only damage indicator — there is no separate "crack" overlay.
- **Tough classes cluster.** The generator clumps tough ground rather than sprinkling it
  (`hardGroundGradient`), so you can see where the hard terrain is and plan a route.

Frequency is skewed hard toward Common (roughly **Common 59% · Advanced 24% · Elite 12% · Fleet 5%**
on Standard, shifting toward the tough end on Hard), plus the single Boss — so weak enemies dominate
and tough ones are the exception.

---

## Tapping — everything is choppable

You tap a hidden (or damaged) tile. A tap deals up to **`handTapDamage` (6)** HP and **costs that much
charge** (never more than you have). What that does depends on the tile:

- **A Common** (2–4 HP) → clears in a single tap, revealing its number (adjacent mines, like classic
  Minesweeper).
- **An Advanced / Elite / Fleet** → takes a **dent**. Its HP bar drops by the damage dealt; it clears
  only once the bar empties, so it needs several taps (Advanced ~2, Elite ~3, Fleet ~4). This is
  slow and charge-hungry on purpose — a blast is far better — but nothing is *un*-tappable.
- **The Boss** → chips. With 40–120 HP (by difficulty) it takes a dozen-plus taps: the deliberate
  end-game grind, sped up by blast chip and a saved charged mine.
- **A hidden mine** → it **arms** (see below). Free — no charge, no damage.

If you can't pay a tile's full HP in one tap you simply deal partial damage; the health bar shows the
progress. There is no time penalty for a partial hit — just slower.

**One tile per tap.** There is no flood-fill: clearing a Common with zero adjacent mines opens only
that tile. Clearing is always a chosen, paid action.

---

## Charge — a regenerating pool

**Charge is your damage currency.** The HUD shows it as `current / max`; it is **capped** (10 / 10 /
14 by difficulty) so it can't be inflated without bound.

- **Spent** on every tap, equal to the damage dealt.
- **Refilled** two ways:
  - **Passive regen** — the pool refills at **1.2 / 1.3 / 1.5 charge per second** (the "chrono
    charging" of the theme). This is the **primary economy**: it is what funds clearing the board's
    HP, and it is the load-bearing difficulty knob. It keeps refilling even while you wait.
  - **Detonation conversion** — detonating a mine converts `charge × 3` into your pool (a bonus on
    top of regen).

Because clearing scales with total board HP and regen is what pays for it, **charge throughput — not
mine count — is the economy.** Mines are the *tool* that clears tough ground cheaply; regen is the
*fuel*.

---

## Mines

Mines are hidden and look exactly like enemy tiles until you touch them — that's the deduction. There
is **no flag**: you sweep mines, you don't mark them.

- **Tap a hidden mine → it arms.** It uncovers as a glowing **Inner Land Mine** with an `N×` charge
  badge. Free and safe; it does not explode.
- **Tap an armed mine → it detonates.** (Two taps on the same tile: arm, then detonate. The split is
  deliberate — it lets you arm several mines and choose the detonation order.)

Mine counts are **explicit and low, and drop with difficulty** (16 / 12 / 11 — roughly 20% / 10% / 5%
of the board). Mines are a scarce power tool, not the bulk clearer; on Hard you have very few and
must spend them well.

---

## Detonation — a percentage-of-HP explosion

Detonating an armed mine does **not** deal flat damage. It removes a **fraction of each tile's *max*
HP**, so its bite scales with the target and it can never one-shot a full-HP tough tile.

For each tile in a **radius-2** (Chebyshev) square around the mine:

```
damage = round( maxHP × blastPct × mineCharge × blastFalloff^(distance − 1) × resist )
```

- **`blastPct` (0.9)** — the core-ring fraction, per point of mine charge. At charge 1, a blast strips
  90% of an adjacent tile's max HP.
- **`blastFalloff` (0.4)** — each ring further out takes ×0.4 again, so a blast is an explosion
  (strong core, weak edge), not a uniform slab. HP decides what survives at range.
- **`mineCharge`** — multiplies the whole thing. A charge-2 mine clears outright; charged mines are
  the cluster-clearers.
- **`resist`** — 1 for everything except the **Boss** (`bossBlastResist` 0.15), which shrugs off the
  percentage wipe and must be worn down mostly by hand.

What that means in play, for a **charge-1** blast:

- **Adjacent Commons clear** (the rounding tips a ≤4-HP tile over 100%).
- **Everything tougher — Advanced, Elite, Fleet — takes a dent and lives.** Outer-ring Commons only
  soften.
- **The Boss barely notices** (~12 of its HP).

Detonation also:

- **vaporises** any tile whose HP it empties — leaving a crater and **revealing no number** (blast
  clears leak no information; that stays tied to risky manual taps),
- **converts the mine's charge into your (capped) pool**,
- **uncovers and arms** any hidden mine caught in the blast (chain-arming), and
- **charges every other armed mine whose blast area overlaps the ground it just cleared** — the
  Chrono-Jump analogue, capped at `maxMineCharge` (6–7). Because charge-1 blasts now clear the
  adjacent Commons, this overlap-charging fires again, so clustered mines pump each other up into
  cluster-clearing charged blasts.

So the interesting question is **where and in what order** to detonate: a lone fresh mine softens a
patch, but a cluster of overlapping mines charges itself up and clears a whole region.

---

## Numbers stay honest

When a mine detonates it is **gone**, and every adjacent revealed number **decrements**. The
constraint system is always currently true, and a number reaching zero cleanly signals a swept
region. Numbers come only from tiles you cleared **by hand** (tapped Commons, or the Boss); blasts
vaporise without revealing anything, so your information stays tied to the risky manual taps.

---

## Winning and losing

**Win:** every ground tile cleared and every mine uncovered. (Armed mines you never detonated don't
block the win, but you usually want them for the tough ground.)

**Lose:** the timer runs out. That is the only failure. It is **fixed per difficulty** and sized to
the board — generous enough that a competent player finishes, tight enough that Hard is a real
squeeze.

---

## Score

```
score = (timeRemaining × difficultyMultiplier) + (25 × maxChain) − (15 × cracks)
```

- **timeRemaining** — efficiency.
- **maxChain** — the most tiles one detonation cleared at once (sequencing skill; smaller now that
  blasts are focused rather than block-wiping).
- **cracks** — the count of partial (under-finishing) hits, an inefficiency penalty.

Leaderboards are **per difficulty**; scores across sizes aren't comparable.

---

## Board & difficulties

Boards are **odd squares** so the Boss sits at a true centre with equal ground on all four sides.
Every board is **seeded and deterministic** (same seed → same board), which also powers the CLI, the
harness, and any future daily/shareable board.

| Difficulty | Size | Mines | Timer | Start / Max charge | Regen /s | Boss HP |
|---|---|---|---|---|---|---|
| **Easy** (`gentle`) | 9×9 | 16 | 5:00 | 9 / 10 | 1.2 | 40–55 |
| **Standard** | 11×11 | 12 | 7:00 | 9 / 10 | 1.3 | 60–85 |
| **Hard** | 15×15 | 11 | 16:40 | 12 / 14 | 1.5 | 90–120 |

Shared across difficulties: `handTapDamage` 6, `blastPct` 0.9, `blastRadius` 2, `blastFalloff` 0.4,
`bossBlastResist` 0.15. Tough-tile frequency and clustering rise with difficulty; the Boss and the
timer scale too.

Generation guarantees: a **Common, zero-adjacent opening** for a safe first tap, and the **Boss
pinned to centre** (never a mine). There is **no reachability/soft-lock guarantee and none is needed**
— every tile is choppable by hand, so no board can trap you even with no mine in range.

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
  list on every action. Its only output to a host is a `GameResult`. All tunables live in
  `tuning.ts`; nothing is a magic literal in game logic.
- **DOM board + one canvas FX overlay** (`src/ui`) — vanilla TS, driven by the engine's events.
- **Headless CLI** (`pnpm play`) — ASCII board, tap/detonate REPL, `--moves` scripting, `--debug`
  (reveal mines), `--auto` (the reference bot plays; `--n` for a quick win-rate sweep). Built for
  driving and tuning the game without a browser.
- **Balance harness** (`pnpm harness`) — playout bots over many seeds: a reasonable "greedy" bot and
  an adversarial "blind-prober". Flags fire if greedy drops below 60% or the prober approaches honest
  play; invariants are guarded in `balance.test.ts`.
- **Watch-demo** — the same reference bot plays the real UI hands-off, cycling boards.

The game is a **standalone repo**, to be embedded in the Tower Run Tracker later as one consumer via
`GameResult` — nothing in the engine knows about the host, Appwrite, or persistence.

---

## Balance status

Reference-bot win rate (headless, non-deducing, ticks time so passive regen flows), n=150:
**Easy 100% · Standard 97% · Hard 97%**. The greedy bot is completability-bound — it doesn't misplay,
it only runs out of time — so ~100% means "a careful player can always finish", not "trivial"; the
human challenge is board size, hidden HP, and the clock. The **blind-prober** (detonates without
sweeping) wins **≤6%** (Easy) and **≤1%** (Standard/Hard): ignoring the sweep leaves tough tiles and
the Boss standing, so the board can't be finished in time. The economy is solvent and mines-as-the-
key-tool holds up.

---

## Settled model (what these iterations decided)

- **Blasts are percentage-of-max-HP, not flat.** Flat damage either flattened whole blocks (a number
  big enough for a Fleet vaporised Commons) or, when lowered, did nothing. A fraction of max HP scales
  with the target: every tile takes the same *number* of blasts regardless of its HP.
- **Distance falloff makes a blast an explosion, not a slab.** The core ring clears; the edge only
  chips. This is what stops one mine flattening a 5×5 block.
- **`blastPct` 0.9 clears the adjacent Commons but nothing tougher.** With percentage damage there is
  no middle setting that clears weak-but-not-tough at charge 1 — a tile clears only when the fraction
  rounds past its own HP, which happens near the same threshold for all of them — so this is the value
  that clears Commons while sparing Advanced+.
- **The Boss resists blasts** (`bossBlastResist` 0.15). Percentage damage otherwise trivialised it (a
  fraction of 90 HP is still ~80). Resisted, it's a hand-chip duel — the intended climax.
- **Passive regen is the economy, mines are the tool.** Doubling HP doubled the charge cost of
  clearing; regen (not mine count) is what funds it, which is why mine counts could drop and even fall
  with difficulty. Pushing regen too high, though, lets blind play coast — so difficulty is bought
  with *time* on the big board, not cheaper charge.

## Open tuning questions

Empirical — answered by play and the harness, not by argument:

- Is Hard's 16:40 timer the right length, or should the big board be smaller / faster instead?
- Does the Boss grind (up to ~20 taps on Hard) stay a satisfying climax or become a chore? The lever
  is `bossBlastResist` and the Boss band.
- Should a fresh (charge-1) blast clear *only* the adjacent Commons, or the whole radius of Commons?
  (The latter is a higher `blastFalloff`, which walks back toward block-clearing.)
- Easy's blind-prober win rate (~6%) is higher than the others — acceptable for a forgiving mode, or
  worth tightening?
