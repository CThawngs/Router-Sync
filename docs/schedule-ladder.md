# RouterSync 4-Tier Zero-Token Schedule Ladder

RouterSync executes periodic catalog, pricing, and deprecation scans (`routersync tick`) with **zero LLM tokens**, **zero inference calls**, and **zero paid API requests**. This guide explains how to choose and configure the right scheduling tier for your operating system and AI coding harness.

---

## 1. The 4-Tier Schedule Ladder

RouterSync evaluates scheduling mechanisms in strict priority order so background ticks never wake an LLM session on a timer:

| Tier | Mechanism | Token Cost | Primary Use Case |
|---|---|---|---|
| **Tier 1** | **Harness-Native Zero-Token Script Cron** | `0` tokens | Harnesses whose native scheduler executes OS scripts directly without creating an LLM turn (`hermes` `no_agent: true` script cron, `antigravity` `builtin: "schedule"` sidecar). |
| **Tier 2** | **OS-Level Background Scheduler** | `0` tokens | Universal default for developer laptops, servers, WSL2, and containers: Windows Task Scheduler (`schtasks`), macOS `launchd` (`LaunchAgents`), Linux `systemd --user` timer, and Linux `crontab` fallback (`--scheduler cron`). |
| **Tier 3** | **MCP `tick_if_due` Freshness Gate** | `0` tokens | Zero-daemon fallback when no OS scheduler is installed: checks `<stateDir>/status.json` against a 15-minute freshness gate and spawns a detached `routersync tick --mode observe` only when stale and unlocked. |
| **Tier 4** | **Local `routersync daemon` Loop** | `0` tokens | Optional persistent localhost HTTP/UI server (`routersync daemon --port 3128`) sharing the same atomic `<stateDir>/tick.lock` single-instance lock. |

All tiers coordinate through `<stateDir>/tick.lock` (`packages/core/src/schedule/tick-gate.ts`), guaranteeing that overlapping triggers never run two concurrent ticks against the same state directory.

---

## 2. 9-Harness Capability & Tier Matrix

RouterSync resolves per-harness scheduling rules from `packages/core/src/harness/harness-matrix.json`. Harnesses whose built-in routines require an LLM prompt turn (`zeroTokenScriptCapable: false`) are **never** assigned Tier 1 native cron; they default to Tier 2 (`os-scheduler`) + Tier 3 (`tick_if_due`).

| Harness ID | Display Name | Zero-Token Native Cron | Primary Tier | Fallback Tiers | Notes |
|---|---|---|---|---|---|
| `hermes` | Hermes Agent | Yes (`no_agent: true`) | Tier 1 (`harness-native`) | Tier 2, Tier 3, Tier 4 | Runs `~/.hermes/scripts/routersync-tick.sh` or `.ps1` without invoking an agent turn. |
| `antigravity` | Google Antigravity | Yes (`builtin: "schedule"`) | Tier 1 (`harness-native`) | Tier 2, Tier 3, Tier 4 | Runs deterministic schedule sidecar without LLM prompt execution. |
| `claude-code` | Claude Code | No (session-scoped `/loop`) | Tier 2 (`os-scheduler`) | Tier 3, Tier 4 | Native `/loop` consumes LLM turns; use OS scheduler + MCP `tick_if_due`. |
| `codex` | OpenAI Codex | No (app-open LLM prompt) | Tier 2 (`os-scheduler`) | Tier 3, Tier 4 | Native automations invoke LLM prompts; use OS scheduler + MCP `tick_if_due`. |
| `opencode` | OpenCode | No (`none`) | Tier 2 (`os-scheduler`) | Tier 3, Tier 4 | No built-in scheduler; use OS scheduler + MCP `tick_if_due`. |
| `cursor` | Cursor | No (Cloud Agent prompt) | Tier 2 (`os-scheduler`) | Tier 3, Tier 4 | Cloud triggers invoke paid agent sessions; use local OS scheduler + MCP `tick_if_due`. |
| `openclaw` | OpenClaw | No (Gateway wake turn) | Tier 2 (`os-scheduler`) | Tier 3, Tier 4 | Cron jobs run inside Gateway agent turns; use OS scheduler + MCP `tick_if_due`. |
| `cline` | Cline | No (`none`) | Tier 2 (`os-scheduler`) | Tier 3, Tier 4 | Editor extension without background cron; use OS scheduler + MCP `tick_if_due`. |
| `openmausbot` | OpenMausBot | No (LLM bot routine) | Tier 2 (`os-scheduler`) | Tier 3, Tier 4 | Bot routines wake an LLM session (`routines.json` is never modified for `tick`). |

---

## 3. Preview, Install, Verify & Uninstall Commands

### Preview Artifacts (`0` Disk Writes)

Inspect generated OS and harness artifacts before installing anything:

```bash
routersync schedule install --dry-run --json
routersync schedule install --harness hermes --dry-run --json
routersync schedule install --harness claude-code --dry-run --json
```

### Tier 2: OS Scheduler Installation & Removal

- **Windows (`schtasks`, low-priority background `Priority=7`, `IgnoreNew`):**
  ```bash
  routersync schedule install
  routersync schedule status
  routersync schedule uninstall
  ```
- **macOS (`launchd` `~/Library/LaunchAgents/com.routersync.daemon.plist`):**
  ```bash
  routersync schedule install
  routersync schedule uninstall
  ```
- **Linux (`systemd --user` with automatic `crontab` fallback on WSL2 / headless containers):**
  ```bash
  routersync schedule install --scheduler auto
  routersync schedule install --scheduler systemd
  routersync schedule install --scheduler cron
  routersync schedule uninstall
  ```
  When `--scheduler cron` (or `--scheduler auto` without an active `systemctl --user` bus) is used, RouterSync merges a single `# routersync-tick` line into `crontab` with `%` characters escaped as `\%`, preserving all unrelated user cron entries.

### Tier 1: Harness-Native Snippets (`hermes` & `antigravity`)

Run `routersync schedule install --harness hermes --dry-run --json` or `routersync schedule install --harness antigravity --dry-run --json` to emit copy-pasteable `no_agent: true` / `builtin: "schedule"` snippets targeting `routersync tick --mode propose`.

### Tier 3 & Tier 4: MCP `tick_if_due` and `routersync daemon`

- **MCP `tick_if_due`:** Available to any connected MCP client. To opt into a freshness-gated check on MCP server startup, set `ROUTERSYNC_MCP_STARTUP_TICK=1` (off by default).
- **Daemon:** Run `routersync daemon --port 3128` when you also want the localhost status API or web UI.

---

## 4. Health & Cost Verification (`doctor` & `cost_report`)

Verify active schedule tiers, stale-tick warnings (`> 2x` configured interval), and zero-token accounting at any time:

```bash
routersync doctor
routersync doctor --json
routersync tick --mode observe --json
```

In MCP-connected harnesses, call `cost_report` (strictly read-only, `0` disk writes) to inspect weekly Tier-0 HTTP domain request counts (`tier0Tokens: 0`, `tier0LlmCalls: 0`, `tier0PaidRequests: 0`) and Tier-1 weekly research session budget usage (`maxWeeklyResearchSessions`, default `5`).
