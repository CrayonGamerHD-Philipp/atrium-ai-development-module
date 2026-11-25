# AGENTS.md – Atrium AI Development (`aidev`)

Module repository for Kalypzo Atrium. The binding rules are in [`.claude/CLAUDE.md`](.claude/CLAUDE.md) and in the
core rules [`.core/.claude/rules/*.md`](.core/.claude/rules/) (core: Git submodule at `.core`). Read them before
changing code; this file only summarizes them.

## Rules (summary of `.claude/CLAUDE.md`)

1. Never modify `.core`. Modules import only `$lib/sdk/*`, `$lib/components/{ui,layout,forms}`, `$lib/utils`.
2. `modules/aidev/protocol.ts` affects both Atrium and the runner – keep it backward compatible, observe
   `PROTOCOL_VERSION`, and run the runner tests.
3. Migrations are additive and immutable (`check:migrations`); add new permissions to both the manifest **and**
   `atrium-module.json`.
4. Never render agent output as `{@html}`; secrets stay on the runner.
5. Do not commit or push anything unless the task requests it.

## Commands

| Command | Purpose |
|---|---|
| `npm run setup` | Install core, `node_modules` → `.core/node_modules`, module packages |
| `npm run check` / `npm run lint` / `npm run format:check` | Types / ESLint / Prettier |
| `npm test` | Module tests (Vitest in core with `ATRIUM_MODULES_DIR`) |
| `npm run build` / `npm run demo` | Build / demo (:4300) |
| `npm run runner:test` | Runner tests |

## Working on pull requests

- Work on a PR until there is a verifiable result.
- Run the matching checks: `npm run check`, `npm run lint`, `npm run format:check`, `npm test`, `npm run runner:test`.
- Document results and open risks in the summary/PR.
- Do not push or commit unless the task asks for it.
