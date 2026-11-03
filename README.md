# AI Wayfinding journeys

A journey is a private space for a team and its agents.

This repository is being rebuilt from a clean start as a public MCP server. Every coordination change will be checked by rules written in [gdp-wired](https://github.com/monotykamary/gdp-wired), proven, and compiled to plain JavaScript at build time. The earlier app is retired; its code stays in Git history.

| Package | Status |
|---|---|
| `packages/rules`: coordination rules, their proofs and the generated JavaScript | pipeline built, example rule only |

## Develop

Node 22.18 or later.

```sh
npm ci
npm run check:rules
npm run typecheck
npm test
```

After changing a rule, run `npm run build:rules` and commit the generated files and `packages/rules/rules.lock.json`.

## Licence

MIT. See `LICENSE`.
