# Inner Land Minesweeper — Game Design Overview

**Status:** design locked, pre-implementation. Numbers marked _(tuning)_ are starting guesses to be
settled by playtesting, not decisions.

---

## The pitch

Minesweeper's fiction is backwards. You play a mine *sweeper*, but the game punishes you for finding
a mine and makes you mark them with flags instead of clearing them. Inner Land Minesweeper flips that
single assumption:

> **Finding a mine is good. Mines are your weapons. Safe tiles are the dangerous click.**

Everything else follows from that flip. The result keeps Minesweeper's deduction completely intact
while replacing "safe or dead" with a continuous risk economy:

> **Information costs risk, and risk earns power.**

You reveal safe tiles to read numbers. Numbers tell you where the mines are. Mines are ammunition.
Ammunition clears ground. Clearing ground is how you win — before the clock runs out.

---

## Where it comes from

The game is themed on *The Tower*'s Inner Land Mines and Chrono Jump. The mapping is deliberate and
one-to-one:

| The Tower | Inner Land Minesweeper |
|---|---|
| Inner Land Mines (ILMs) | The mines you uncover and detonate |
| Enemies with HP | Tiles with HP |
| ILM charge | Per-mine charge, grown by overlapping blasts |
| Chrono Jump meter | Your player charge pool |
| Recursive scaling on shared hits | Blasts that overlap charge each other |
| Enemy HP outscaling your damage | Tougher tiles guarding the late board |

You do not need to know *The Tower* to play it. The theme is flavour; the game stands alone.

---

## The board

A rectangular grid. Every tile is one of two things — a **mine** or a **ground tile** — and the
player cannot tell which by looking.

Every tile, mine or not, displays a visible **HP tier**:

| Tier | HP range _(tuning)_ |
|---|---|
| Light | 1–2 |
| Medium | 2–4 |
| Heavy | 4–6 |
| Elite | 6–9 |

Three things matter about tiers:

- **The tier is visible from the first moment; the exact HP is never shown.** You know a tile is
  Heavy. You don't know whether it's a 4 or a 6. That gap is where the risk lives.
- **The bands overlap on purpose.** A Medium can roll a 2, exactly like a Light. The tier is a
  *hint*, not a contract.
- **Mines display a tier too**, drawn from the same distribution as ground tiles. If they didn't,
  every mine on the board would be identifiable at a glance and there would be no game.

Tough tiles are **clustered by the board generator**, not sprinkled randomly. You can see where the
hard ground is before you commit, which makes route choice a real decision: open the soft region for
cheap information, or push the hard region early while you still have charge to spend.

---

## The two resources

**Player charge** is your risk budget. It is what you spend to click.

**Mine charge** is a per-mine multiplier. Every uncovered mine has one, starting at 1×. It grows when
another mine's blast overlaps ground that this mine's blast would also cover.

The two connect in one direction: **detonating a mine converts its charge into your player pool.** A
mine you've patiently grown to 4× pays out far more than one you popped immediately.

---

## Clicking

You click a tile. One of three things happens.

**It's a mine.** It uncovers and **arms** — it does not explode. It now shows its charge ring and
begins accumulating charge from nearby blasts. This is the good outcome. Uncovering a mine costs no
charge.

**It's ground you can afford.** It clears, revealing its number: how many mines are adjacent, exactly
as in classic Minesweeper. Charge is a **damage currency**: a clean clear costs the tile's *hidden HP*
(one charge per HP). The tier tells you the band — Light is cheap, Elite is expensive — but never the
exact cost, and that gap is the risk.

**It's ground you can't afford.** You don't die, and you aren't blocked. Instead the click *chips*:

- the tile cracks instead of clearing
- your player charge drains sharply
- you take a time penalty
- the tile's remaining HP is knocked down, so it's cheaper next time

Charge never prevents a click. It only decides whether the click is clean or costly. That means there
is no stalled state, and no board is ever unwinnable — you can always grind your way through a bad
tile. It will just cost you the clock.

**The time penalty escalates** with repeated chipping, so a single honest misjudgement is cheap while
grinding — or blind-clicking to hunt for mines — gets expensive fast.

---

## Detonation

Detonating an armed mine is a **separate action** from uncovering it (right-click on desktop,
long-press or a detonate mode on touch). This split is the heart of the strategy layer: you choose
*when* and *in what order* your mines go off.

A blast:

- deals `base damage × that mine's charge` to tiles in its radius
- **vaporises** tiles whose HP is at or below the damage; cracks the rest
- **charges every other armed mine whose blast radius overlaps the ground it just cleared**
- **uncovers and arms** any undiscovered mine caught in the radius, without detonating it

**A vaporised tile never reveals its number.** This is the key to keeping blasts honest: a manual
click buys information (you paid risk for a number), but a blast only clears *space*. Because blasts
leak no information, they can clear a generous area — and clearing the board is mostly their job.
Manual clicking is how you *read* the board and find your mines; detonation is how you *clear* it.

The interesting decision is sequencing. With several mines armed, firing them in the right order
routes overlaps so each blast pumps the next, and a charged mine vaporises a wide, tough area. That
chain is what the score rewards.

---

## Numbers change as the board changes

When a mine detonates, it is **gone**, and every adjacent number **decrements**.

This is a real departure from classic Minesweeper, where numbers are static because mines never
leave. Here the constraint system is live: every number on the board is always *currently true*, and
a number ticking to zero is a clean signal that its region is fully swept.

And it has a consequence that turns out to be the best moment in the game:

> **A revealed number that decrements to zero immediately cascades.**

So a well-placed detonation doesn't just clear its blast radius — it can drop a `1` to a `0` and
unzip a whole region behind it. Setting those up deliberately is the highest-skill play in the game.

---

## Cascades

As in classic Minesweeper, clearing a tile with zero adjacent mines opens its neighbours.

Two rules keep this from breaking the economy:

- **Cascades are free.** They never spend player charge. (An unpredictable drain on your banked
  charge would punish exactly the patient play the game wants to reward.)
- **Cascades only propagate through Light tiles.** They stop at anything tougher.

Because tiers are visible, cascade size is *readable in advance* — "click into that Light cluster for
a big open" is a decision you can actually make. And because tough tiles cluster more heavily as you
push into hard ground, big cascades are naturally an early-game pleasure that fades exactly as the
pressure rises.

---

## Winning and losing

**Win:** every ground tile cleared and every mine uncovered.

Armed mines you never detonated don't block the win — they're just wasted ammunition. Nothing forces
you to detonate, because the economy already does: charge comes only from detonations, and hoarding
means chip-grinding, and chip-grinding means the clock catches you.

**Loss:** the timer runs out. That's the only way to lose.

The timer is **generous and fixed per difficulty**. It is not meant to threaten a player who is
thinking — Minesweeper is a game about sitting and staring at a `1-2-1` until it resolves, and a
clock that punishes that would suppress the whole puzzle. It exists to kill stalled runs and to make
chip-grinding a real cost. A competent player should rarely see it.

---

## Score

Winning is the baseline; the score ranks *how well* you won.

```
score = (timeRemaining × difficultyMultiplier) + (chainWeight × maxChain) − (crackWeight × cracks)
```

- **timeRemaining** — efficiency
- **maxChain** — the largest chain reaction you engineered, i.e. sequencing skill
- **cracks** — how many times you clicked something you couldn't afford

Leaderboards are **per difficulty**; a 9×9 result and a 16×16 result aren't comparable.

Tiles cleared and detonation count are recorded for the loss screen and analytics, but they're
near-constant on a win, so they don't rank anything.

---

## Difficulty

Every difficulty is a set of tuning constants over the same rules:

board size · mine density · tier distribution and how hard ground clusters · click costs per tier ·
blast radius and base damage · charge conversion rate · timer budget · chip penalty curve

Mine density is **higher than classic Minesweeper's ~16%**. Mines are ammunition here, not hazards,
so scarcity means starvation rather than safety.

**Every board is seeded.** The seed goes into the result, so runs are reproducible and shareable, and
a daily board is a trivial addition later.

**The opening is guaranteed:** your first click always lands on a Light, zero-adjacent tile, giving a
free opening cascade and a readable board. You start with enough charge to clear Light tiles _(tuning)_.

---

## Accessibility and platform

Non-negotiable, because tier is primary gameplay information:

- **Tier is never encoded by colour alone.** Border weight, fill pattern, and iconography carry it
  too. Same for crack severity.
- **`prefers-reduced-motion` is honoured** — the shockwaves, particles, and screen shake all have a
  calm path.
- **Full keyboard navigation and screen-reader labelling.** The board is real DOM, not a canvas, and
  this is most of the reason why.
- **Touch is a first-class input**, not a port: tap to click, long-press or a mode toggle to detonate.
- **Catastrophic clicks ask for confirmation** when visible information already says so ("this is
  Elite and your charge is low"). It leaks nothing you couldn't already see, and it saves mobile
  players from fat-finger disasters.
- **The run pauses** on tab-hide and on navigating away. Nobody loses a run to a phone call.

---

## What is settled, and what isn't

**Settled — the rules above.** Arm-then-detonate, the two-resource economy, tiers as hidden ranges,
free Light-only cascades, chip-out instead of hard failure, decrementing numbers, zero-triggered
cascades, tight blast radius, generous fixed timer, clear-the-board win, per-difficulty scoring.

**Not settled — how any of it *feels*.** These are empirical and will be answered by a headless
simulation harness plus real play, not by more discussion:

- How generous does the timer need to be before thinking feels safe?
- Is a tight blast radius still satisfying, or does it feel weak?
- Is chip-grinding tense, or just tedious?
- Does tier fuzz read as exciting uncertainty or as unfairness?
- How often do decrement-cascades actually fire? Are they rare enough to feel special and common
  enough to plan around?
- What mine density makes deduction interesting rather than noisy?
- How steep should the hard-ground gradient be?

**The known balance risk:** "dump charge, then blind-click the board to find mines" is a candidate
strategy that would replace deduction with brute force. Two mechanics kill it: a broke player deals
*zero* damage (so blind ground-clicks never actually clear), and an escalating time penalty on chips.
An adversarial bot that plays exactly that way is part of the test suite, and if it beats the honest
bot, the constants are wrong.

**Current harness result** (headless, non-deducing bots, 150 boards/difficulty): a sensible "greedy"
player wins **95% / 95% / 84%** across Gentle / Standard / Hard and clears the full board; the
blind-prober wins **0%** everywhere, clearing 2–8% before the clock kills it. So the economy is
solvent and honest play beats brute force decisively. What the harness does *not* answer is feel —
the greedy bot still cracks 8–15 times a game, where a deducing human should crack far less. These
are floor numbers, not the ceiling, and real play will move the constants.

---

## Feedback welcome on

1. Does the core flip — *finding mines is good* — read as clever or as a gimmick?
2. Is a two-resource economy one resource too many?
3. Is losing only to a clock enough tension, given classic Minesweeper's instant death?
4. Is the arm-then-detonate split worth the extra input, or should uncovering just detonate?
5. Does hidden-HP-within-a-visible-tier feel fair?
