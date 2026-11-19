# Dependency security policy

## Single source of truth for pins

RouterSync uses **pnpm 10**. Transitive security pins live in
`pnpm-workspace.yaml` under `overrides`:

```yaml
overrides:
  hono: 4.13.19
  "@hono/node-server": 2.1.9
  body-parser: 2.4.0
  qs: 6.17.1
  fast-uri: 3.1.9
```

Do **not** put these under `pnpm.overrides` in `package.json`. pnpm 10 ignores
that field and will silently install the vulnerable transitive versions.

## Checks

- CI job `security-audit` runs `pnpm audit --audit-level=moderate` on every push
  and pull request. A new advisory makes the job fail before a merge.
- `.github/dependabot.yml` opens weekly version-update PRs for npm and GitHub
  Actions. Dependabot security updates are separate and are not grouped.

## When an advisory appears

1. Reproduce locally: `pnpm audit --audit-level=moderate`.
2. If the vulnerable package is direct, bump it in the owning `package.json`.
3. If it is transitive, add or raise the pin in `pnpm-workspace.yaml`
   `overrides` using the advisory's `first_patched_version`.
4. Run `pnpm install`, then `pnpm audit`, `pnpm lint`, `pnpm -r typecheck`, and
   the relevant tests. Rebuild packages before tests that spawn `dist/`:
   `pnpm -r build`.
5. Open a PR; do not dismiss the Dependabot alert unless the code path is
   provably unreachable, and record the reason in the PR.
