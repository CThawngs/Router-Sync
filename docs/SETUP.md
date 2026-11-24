# RouterSync Setup & New-User Onboarding

Welcome to RouterSync! This guide walks through prerequisites, a zero-token **New-User Read-Only Quickstart** for **9Router** and **OmniRoute**, and contributor guard setup.

---

## 1. Prerequisites

Ensure your environment meets the repository engine requirements (`package.json` and `.nvmrc`):

- **Node.js:** `>= 22.12.0` (Node 22 LTS or Node 24; `better-sqlite3` uses prebuilt binaries on Windows, macOS, and Linux — no C++ compiler required)
- **pnpm:** `>= 10.0.0` (activate via `corepack enable pnpm` or `npm install -g pnpm@10`)
- **Git:** `>= 2.40.0`

---

## 2. New-User Read-Only Quickstart (Zero Tokens, Zero Router Writes)

Every command below is **100% read-only**: it never mutates your 9Router or OmniRoute SQLite databases and consumes **0 inference tokens**.

### Step 1 — Install & Build

```bash
pnpm install --frozen-lockfile
pnpm build
```

If you are developing or committing in a git clone, install the repository pre-commit and pre-push hooks (`tools/hooks/pre-commit` and `tools/hooks/pre-push`):

```bash
pnpm hooks:install
```

Copy the starter ranking policy and generate a local `config.yaml` if you do not have one yet:

```bash
# macOS / Linux:
mkdir -p ~/.config/routersync && cp ranking.example.yaml ~/.config/routersync/ranking.yaml

# Windows (PowerShell):
# New-Item -ItemType Directory -Force "$env:APPDATA\routersync" | Out-Null
# Copy-Item ranking.example.yaml "$env:APPDATA\routersync\ranking.yaml"

pnpm routersync init
```

### Step 2 — Diagnose Environment & Router Discovery (`doctor`)

Run the human-readable diagnostic or structured JSON check (used by AI agents per `AGENTS.md`):

```bash
pnpm routersync doctor
pnpm routersync doctor --json
```

> *Note:* Always invoke `pnpm routersync doctor` (not `pnpm doctor`, which runs pnpm's own package-manager check).

### Step 3 — Inspect Stale Combo Steps (`combos stale`)

Audit existing combo steps in **9Router** and **OmniRoute** against active provider models without touching either router:

```bash
pnpm routersync combos stale --router 9router
pnpm routersync combos stale --router omniroute
```

### Step 4 — Run a Read-Only Trial on 9Router & OmniRoute

Scan router databases and provider `/models` endpoints, inspect health/read-back status, preview the deterministic sync diff, and classify models across L1/L2/L3 verification layers:

```bash
pnpm routersync scan
pnpm routersync status
pnpm routersync plan
pnpm routersync verify
```

All four commands open router databases in read-only mode and perform **zero router writes**. If your router databases live in non-default locations (or you are testing against copied SQLite snapshots), override paths via environment variables:

| Variable | Purpose | Default Location |
|---|---|---|
| `ROUTERSYNC_9ROUTER_DB` | Path to 9Router SQLite DB | `%APPDATA%\9router\db\data.sqlite` (Windows) / `~/.9router/db/data.sqlite` (macOS/Linux) |
| `ROUTERSYNC_OMNIROUTE_DB` | Path to OmniRoute SQLite DB | `~/.omniroute/storage.sqlite` |
| `ROUTERSYNC_CONFIG` | Path to `config.yaml` | `./config.yaml` (or `./routersync.yaml`) |
| `ROUTERSYNC_STATE_DIR` | Directory for local RouterSync state/snapshots | Platform state directory |

---

## 3. Contributor Verification & Security Checks

Before opening a pull request, verify static guards, types, tests, and multi-surface security hygiene:

```bash
pnpm hooks:install
pnpm lint
pnpm typecheck
pnpm test
node tools/agent/security-audit.mjs
```

On low-RAM hosts (`< 2.5 GiB` free memory), `tools/agent/heavy.mjs` blocks parallel root runs with exit code `3`; use `pnpm typecheck:changed`, `pnpm test:file -- <path>`, and the sequential workflow documented in `docs/low-resource.md`.

---

## 4. Optional Environment Overrides

Refer to `.env.example` for optional local URL overrides (never commit a `.env` file or paste real API keys into repository files or transcripts; see `SECURITY.md`):

- Default 9Router API URL: `http://localhost:20128`
- Default OmniRoute API URL: `http://localhost:30128`
