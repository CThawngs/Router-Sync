# RouterSync Setup & Developer Onboarding

Welcome to RouterSync! This guide details how to set up your local development environment and verify baseline health.

---

## 1. Prerequisites

Before starting, ensure your system has the following tools installed:
- **Node.js:** `>= 20.0.0` (Recommended: Node 20 LTS or Node 24)
- **pnpm:** `>= 9.0.0`
- **Git:** `>= 2.40.0`

---

## 2. Quick Setup Steps

1. **Install Dependencies:**
   ```bash
   pnpm install --frozen-lockfile
   ```

2. **Configure Pre-Commit Guard Hooks:**
   RouterSync uses the local guard (`tools/guard/no-secrets.mjs`) to block accidental secret leaks or personal home directory paths:
   ```bash
   git config core.hooksPath tools/guard
   ```

3. **Run the Diagnostic Doctor:**
   Verify your environment, Node version, and reachable router instances:
   ```bash
   pnpm routersync doctor
   ```

4. **Verify Typecheck, Lint, and Tests:**
   ```bash
   pnpm typecheck
   pnpm lint
   pnpm test
   ```

---

## 3. Environment Configuration

Copy `.env.example` to `.env` if you need custom router URLs:
```bash
cp .env.example .env
```
Default URLs:
- OmniRoute: `http://localhost:30128`
- 9Router: `http://localhost:20128`

*Note: Never paste API keys directly into public repositories or chat transcripts.*
