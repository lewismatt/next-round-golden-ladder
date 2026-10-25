# Golden Ladder — a Next Round game module

Golden Ladder is a cooperative ladder-climb quiz for the
[Next Round](https://github.com/lewismatt/next-round) platform: a team
climbs a 15-rung question ladder together, taking turns to answer, and one
wrong answer from anyone ends the run. It is a standalone game module —
this repository is the whole game — designed against the platform's game
SDK (`next-round-game/0.1`).

Design v0.2, endorsed by Matthew Lewis with his amendments on 2026-10-25
(deadline miss passes to the next player; turn timer optional; the name;
question generation as a separate task). The format is inspired by the
classic television ladder-climb quiz, with an original name, original
questions, and points instead of money — no show branding, questions, or
catchphrases are used.

## Rules

- **Players:** solo (1) or a team of 2–8. The team shares one ladder, one
  lifeline pool, and one score — everyone wins or falls together.
- **The ladder (points):** 100, 200, 300, 500, **1,000**, 2,000, 4,000,
  8,000, 16,000, **32,000**, 64,000, 125,000, 250,000, 500,000, 1,000,000.
  Rungs 5 (1,000) and 10 (32,000) are **safe havens**.
- **Turns:** an answerer pointer rotates in strict order. Only the player
  the pointer names may act on the live rung. The question and its four
  choices are public to the whole team; the correct answer is never sent
  to a client before the rung resolves.
- **Answering is final immediately.** Correct: the team climbs to the next
  rung. Wrong — from anyone, at any rung: **the run ends** and the team
  banks the highest safe haven at or below the last correct rung
  (0 / 1,000 / 32,000). The missed question is revealed with its correct
  answer and explanation.
- **Walk away:** the answerer, before answering, may end the run and bank
  the value of the last correct rung (0 if none). It is the answerer's
  call alone.
- **Turn timer (optional):** a match setting (`turnSeconds`, 30 seconds
  to 7 days, or none). A missed deadline **passes the rung to the next
  player** — same question, fresh deadline, no penalty; it is never a
  wrong answer. In solo a miss renews the same player's deadline.
- **Lifelines** (team-shared, each once per match, answerer only, before
  answering):
  - **Fifty-Fifty** — the server removes two wrong choices for the live
    question, deterministically from the match seed.
  - **Tag In** — hand this rung to the next teammate; rotation continues
    from them. Unavailable in solo.
  - **Swap** — discard the live question and draw an unused replacement
    at the same rung. A Fifty-Fifty spent on the discarded question stays
    spent; the replacement starts with all four choices.
- Invalid actions (wrong player, out-of-range or removed choice, spent
  lifeline) are rejected without consuming the turn. Membership loss
  pauses the match with the deadline preserved. A host ending the match
  early records `ended_early` with score 0.
- **Results:** every participant scores the team's banked points; reaching
  the top rung is a win for the whole team. Contributions record rungs
  answered, correct answers, lifelines used, and who ended the run.

## Questions

Questions arrive as an importable resource bank (format
`next-round.golden-ladder/1`, CC0-1.0), following the platform's Trivia
bank pattern: each question has an `id`, a `rung` (1–15), a `prompt`,
exactly 4 distinct `choices`, a `correctChoice`, and an `explanation`.
A match requires at least 2 questions per rung (one drawn, one Swap
spare); the draw is deterministic from the match seed, server-side only.

`content/fixture.json` is a small **synthetic test-fixture bank** (30
deliberately trivial questions) used by the unit tests and smoke matches.
It is **not** the production bank.

The production bank lives at `content/bank.json` (same format, **CC0-1.0**
— the attribution inside the file is the operative rights note:
agent-drafted, no human attestation claimed). It is a work in progress:
**139 of 200 questions** as of 2026-10-25 (rungs 1–10 at 14 each
except rung 8 at 13; rungs 11–15 still being collected). A match needs at least 2 questions
per rung, so the bank is not yet playable end-to-end. Per-contributor
source files are kept under `content/contributions/` and merged into the
bank from their `questions` arrays, minus any questions dropped in
review — question ids carry a contributor tag and are never renumbered,
so provenance survives merging. (One reserve file,
`content/contributions/quill-reserve-3.json`, holds reviewed spare
questions that were surplus to the per-rung targets; it is not part of
the bank.)

## Layout

- `src/manifest.ts` — module manifest (modes, capabilities, JSON
  schemas, bank schema)
- `src/types.ts` — ladder constants and state/view types
- `src/server.ts` — pure rules reducer (`GameServer`): seed draw,
  answerer pointer, lifelines, ladder resolution, deadline pass,
  pause/resume
- `src/content.ts` — question-bank import (`parseGoldenLadderImport`)
- `src/client.ts` — browser client (vanilla DOM over the platform's
  `GameBridge`); renders the ladder, the live question, lifelines, and
  the run history from the projected view only
- `src/server.test.ts` / `src/content.test.ts` — rules and import tests;
  every transition is schema-validated
- `content/fixture.json` — synthetic test-fixture bank (see above)
- `content/bank.json` — the production question bank (CC0-1.0; in
  progress, 139 of 200 questions)
- `content/contributions/` — per-contributor source files merged into
  `content/bank.json`

## Development

The platform packages (`@next-round/contracts`, `@next-round/game-sdk`,
`@next-round/game-client`) live in the core repository and are not published
to a registry. Development links them from a pinned checkout:

```sh
pnpm setup   # clones lewismatt/next-round into .core/ at a pinned ref,
             # installs, and builds the platform packages
pnpm build
pnpm typecheck
pnpm test
```

`CORE_REF` (see `scripts/fetch-core.sh`) pins the platform commit this module
is developed and verified against. CI does the same.

## Bundling into a Next Round deployment

Per the platform's module model, an operator adds a reviewed package to the
server build registry and redeploys API/web/worker together. The mechanism
below is the one verified end-to-end against the core platform for Cipher
(draft PR `lewismatt/next-round#46`, CI green on all jobs, 2026-10-24):

1. **Fetch this repo into the core checkout as a workspace package.** A
   core `scripts/fetch-golden-ladder.sh` clones this repository into
   `games/golden-ladder/` (gitignored) at a pinned commit; the `games/*`
   workspace glob picks it up and `apps/api` / `apps/worker` depend on
   `@next-round/game-golden-ladder` via `workspace:*`, so the monorepo
   build compiles it alongside the platform's own packages and its
   dependencies on `@next-round/contracts` / `game-sdk` / `game-client`
   resolve to the platform's copies. A registry- or git-sourced dependency
   does **not** work: this package ships sources only (no committed
   `dist/`, no `prepare` script) and a platform build never compiles a
   dependency's sources — workspace inclusion is what makes it build. Keep
   the fetched tree byte-identical to the pinned upstream commit.
2. Register it next to the bundled games — a `golden-ladder-module.ts` in
   each app that calls
   `registry.register(manifest, server, { clientRoot, isDefault: true })`
   (mirroring `trivia-module.ts`), invoked from the API server and worker
   startup, plus a `golden-ladder` entry in `install-bundled-games.ts`.
   The default question bank also needs installing as an instance
   resource (the fixture bank for testing; the production bank when it
   lands).
3. Add the client bundle input `games/golden-ladder/0.1.0/client` → this
   package's `src/client.ts` in the web app's Vite config, plus match
   creation settings UI for `turnSeconds` and bank selection.
4. CI and the deployment image build run the fetch step before
   `pnpm install` / the Docker build.

The core repository intentionally carries no Golden Ladder code;
deployments that don't want the game simply never bundle it.

## License

Apache-2.0. Question banks imported as resources carry their own license
(the format requires CC0-1.0).
