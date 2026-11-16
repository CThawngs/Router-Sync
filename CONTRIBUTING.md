# Contributing to RouterSync

Thank you for your interest in contributing! RouterSync is an open-source,
community-driven project licensed under the [MIT licence](LICENSE).

## Code of Conduct

Everyone taking part is expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Prerequisites

- Node.js >= 22.12 (`cat .nvmrc`)
- pnpm >= 10 (`corepack enable pnpm` picks the pinned version)
- Git >= 2.40

## Setup and checks

```bash
pnpm install --frozen-lockfile
pnpm typecheck      # TypeScript, no emit
pnpm lint           # secret guard
pnpm build          # build every package
pnpm test           # unit and acceptance tests (root-tools + packages)
pnpm test:slow      # the user-interface tests
pnpm e2e            # end-to-end: pack, install and drive the published shape
```

All of these must pass before a pull request is merged. The CI workflow runs
the same commands on Linux, macOS and Windows with Node 22 and 24.

## Ground rules

1. **Never write to a real router in a test.** Use a SQLite database created
   in the operating system's temporary directory, or the fixtures in
   `test/harness/`. A test that touches the router database of the machine
   it runs on is a bug, even if it "passes".
2. **Zero inference tokens.** Tests and checks must never call a metered or
   paid model endpoint. Model discovery uses `GET /models` only.
3. **No secrets and no personal paths.** The secret guard
   (`node tools/guard/no-secrets.mjs`) runs over the whole tracked tree and
   must report zero violations.
4. **Test behaviour, not implementation.** Write a test that fails before the
   fix and passes after it.
5. **Conventional commits.** Write the commit message in English as
   `<type>(<scope>): <description>`, for example
   `fix(cli): keep the tick gate when the provider list is empty`.
6. **Sign-off.** Add the sign-off line (`git commit -s`).
7. **Keep the diff small.** One concern per pull request, and no unrelated
   reformatting.

## Reporting a security problem

Do not open a public issue. Follow [SECURITY.md](SECURITY.md) instead.

## Where things live

| Path | Content |
|---|---|
| `packages/cli` | The `routersync` command line |
| `packages/core` | Domain logic, path helpers, planner |
| `packages/mcp-server` | The read-only MCP server |
| `packages/daemon` | The local daemon and its HTTP API |
| `packages/ui` | The web interface |
| `packages/adapter-*` | Router adapters (9Router, OmniRoute) |
| `registry/` | Shared product data (providers, gateways) |
| `examples/` | Configuration and schedule samples |
| `test/e2e` | The end-to-end suite |
| `docs/` | User documentation and decision records |
