# Stage 0: clean slate and gdp-wired rules pipeline

## Summary <!-- work:summary -->
Remove the old journey app from main and set up the build pipeline the rewrite's rules use: gdp-wired pinned exactly, rule models compiled to standalone JavaScript at build time, a lock file that records the gdp-wired version and the hash of every generated file, and tests that prove each rule's laws from any stored state.

## Why <!-- work:rationale -->
Dan decided on a clean start: no migration, no legacy code. Every later stage writes coordination rules in gdp-wired and runs the generated code in the Worker and the local proxy, so the pipeline must exist first. gdp-wired is 0.x with one author and fast releases that have changed verdict meaning in patch versions, so the version is pinned exactly and any bump must show up as a lock-file diff. Stored state is stepped from whatever is stored, so proofs use `proveSteps(..., {from: 'any'})` and `gate()` is not used on stored state. Non-goals: real coordination rules (stage 1), the server, MLS, deployment. Old branches, worktrees, the Cloudflare Worker and its data stay as they are.

## Acceptance criteria <!-- work:criteria -->
- legacy-removed: When main's tree is listed, it contains no `packages/core`, `packages/web`, `packages/client`, `packages/server` or old `packages/rules` Bend sources, no `*.bend` file, no old `stage-*` workspecs or drafts, and no scripts that only served them.
- rules-pinned: The rules package depends on gdp-wired at exactly `0.31.1` and the lockfile records that version.
- rules-build: When `npm run build:rules` runs, it regenerates `packages/rules/generated/*.js` from the TypeScript models with gdp-wired `compileJs` and writes `packages/rules/rules.lock.json` holding the gdp-wired version and each generated file's SHA-256; `npm run check:rules` then reports the generated files up to date and fails if any byte differs.
- rules-proved: `npm test -w @ai-wayfinding/rules` proves every law of the pipeline's example rule with `proveSteps` and `{from: 'any'}` (proven, checked, no assumption), refuses its broken variant, passes `crossCheck`, and runs the generated JavaScript to the same states as the interpreter.
- repo-gate: `npm run typecheck` and `npm test` at the repository root pass, and AGENTS.md describes the new layout, the gdp-wired rules and the done gate instead of Bend.
