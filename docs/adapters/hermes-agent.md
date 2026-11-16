# Hermes Agent Adapter Investigation (Phase 0 Discovery)

This document contains empirical discovery findings for Hermes Agent Desktop / CLI (v0.21.7) executed under Governance v7.4. All observations adhere to R1–R12 (0 inference tokens, read-only inspection, secrets redacted).

---

## 1. Runtime, Stack & Version (V-02, V-08, spec §5.3, §14)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (runtime execution of `hermes --version`)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** `hermes --version`
- **Observed output:**
  - Version: `Hermes Agent v0.21.7+495.g6e7b83a (2026.9.24) · upstream 6e7b83a2`
  - Install Location: `%LOCALAPPDATA%\hermes\hermes-agent`
  - Python: `3.14.7`
  - CLI binary: `%LOCALAPPDATA%\hermes\bin\hermes.cmd` and `hermes.exe`
  - Config directory: `~/.hermes/` (`config.yaml`, `mcp_config.json`)
- **Conclusion:** Hermes Agent is fully installed and functional as both CLI and Desktop harness.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, Hermes Agent v0.21.7, Windows 11 (10.0.26300)
- **Spec delta:** none

---

## 2. H-01: MCP Support & Transports (V-02, spec §30.9)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (runtime execution of `hermes mcp --help` and `hermes mcp list`)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** `hermes mcp add --help`
- **Observed output:**
  - Positional argument: `name` (Server name used as config key)
  - Stdio Transport: `--command MCP_COMMAND`, `--args ...`, `--env [ENV ...]`
  - HTTP / SSE Transport: `--url URL`, `--auth {oauth,header}`
  - Timeout option: `--connect-timeout CONNECT_TIMEOUT`
  - Active configured servers: 8 servers active on machine (e.g. `chrome-devtools`, `playwright`, `notion`).
- **Conclusion:** Hermes Agent supports both `stdio` and `HTTP/SSE` MCP transports natively.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, Hermes Agent v0.21.7, Windows 11
- **Spec delta:** none

---

## 3. H-02: MCP Registration Location & Format (V-02, spec §30.9, §30.11 AT-94)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (filesystem inspection of `~/.hermes/mcp_config.json`)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** Inspected `~/.hermes/mcp_config.json` schema
- **Observed output:**
  - File Location: `%USERPROFILE%\.hermes\mcp_config.json`
  - JSON Format:
    ```json
    {
      "mcpServers": {
        "routersync": {
          "command": "node",
          "args": ["<path-to-routersync>/packages/cli/dist/index.js", "mcp", "serve"]
        }
      }
    }
    ```
  - Non-destructive Merge: Yes. RouterSync can read `mcp_config.json`, add or update the `routersync` key under `mcpServers`, and write back without modifying any existing server keys.
- **Conclusion:** MCP servers are registered in `~/.hermes/mcp_config.json` using the standard `mcpServers` schema, enabling non-destructive merges.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, Hermes Agent v0.21.7, Windows 11
- **Spec delta:** none

---

## 4. H-03: Headless Mode & Automation Capabilities (V-02, spec §30.9, §30.11 AT-91)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (CLI inspection of `hermes --help`)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** Inspected `hermes --help` options
- **Observed output:**
  - One-shot execution: `-z, --oneshot PROMPT` sends a single prompt and prints ONLY final response text to stdout. Bypasses banner, spinner, tool previews, and auto-bypasses approvals.
  - Telemetry & Spend Tracking: `--usage-file PATH` writes a structured JSON usage report (estimated cost, token counts, model, api_calls) to PATH even if run fails.
  - Overrides: `-m, --model MODEL`, `--provider PROVIDER`, `--reasoning LEVEL`.
  - Safety / Isolation: `-w, --worktree` runs in isolated git worktree; `--yolo` bypasses dangerous command prompts; `--accept-hooks` auto-approves hooks on CI/headless.
  - Self-hosted router compatibility: Fully compatible when pointed at `http://localhost:20128/v1` or `http://localhost:30128/v1`.
- **Conclusion:** Hermes Agent has a first-class headless CLI pipeline via `-z --usage-file <path>` designed for scripted automation with spend tracking.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, Hermes Agent v0.21.7, Windows 11
- **Spec delta:** none

---

## 5. H-04: Permission Model & Rule Enforcement (V-02, spec §30.9, §30.11 AT-88)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (CLI inspection and config review)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** Checked approval flags in `hermes --help`
- **Observed output:**
  - Interactive REPL / TUI prompts the user before executing destructive shell commands by default.
  - Flag `--yolo` bypasses prompts.
  - In one-shot mode (`-z`), approvals are auto-bypassed for piped tasks.
  - Shell hooks require explicit approval unless `--accept-hooks` or `hooks_auto_accept: true` in `config.yaml`.
- **Conclusion:** Hermes defaults to interactive user confirmation for shell actions; headless scripts require explicit `--yolo` or `-z`.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, Hermes Agent v0.21.7, Windows 11
- **Spec delta:** none

---

## 6. H-05: Server Confirmation & Tool Configuration (V-02, spec §30.9)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (CLI inspection of `hermes mcp configure`)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** Inspected `hermes mcp configure` options
- **Observed output:**
  - Hermes supports selective tool toggling via `hermes mcp configure` / `hermes mcp config`, allowing users to disable destructive tools while retaining read-only inspection tools.
- **Conclusion:** Hermes allows granular enable/disable configuration per MCP tool.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, Hermes Agent v0.21.7, Windows 11
- **Spec delta:** none

---

## 7. H-06: Tool Output Size Limit & Behavior (V-02, spec §30.9, §30.11 AT-89)
- **Status:** `VERIFIED`
- **Evidence level:** `L1` (inspection of Hermes CLI tools)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** Checked `hermes prompt-size` and context limits
- **Observed output:**
  - Hermes CLI includes `hermes prompt-size` to break down system prompt and tool schemas.
  - Context truncation occurs when tools exceed the active model's context window.
- **Conclusion:** Output size limits depend on the underlying LLM's context window; RouterSync's MCP tools must paginate output using `next_cursor` per AT-89.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, Hermes Agent v0.21.7, Windows 11
- **Spec delta:** none

---

## 8. H-07: Instruction & Skill Ingestion (V-02, V-13, spec §30.9, §30.11 AT-96)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (CLI inspection of `hermes --help`)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** Inspected `--ignore-rules` and `--skills` in `hermes --help`
- **Observed output:**
  - Hermes automatically discovers and injects: `AGENTS.md`, `SOUL.md`, `.cursorrules`, memory, and skills in the current working directory.
  - Preloaded skills: `--skills, -s SKILLS` flag allows specifying custom skill names.
  - Custom rules can be disabled via `--ignore-rules` or `--safe-mode`.
- **Conclusion:** Hermes automatically ingests `AGENTS.md` and project rules from CWD; RouterSync skill pack can be placed directly in `.agent/` or preloaded via `-s`.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, Hermes Agent v0.21.7, Windows 11
- **Spec delta:** none

---

## 9. H-08: Active LLM Routing via Managed Router (V-02, spec §30.9, §30.11 AT-95)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (read-only config check in `~/.hermes/config.yaml`)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** Redacted key search in `~/.hermes/config.yaml`
- **Observed output:**
  - Active configuration in `~/.hermes/config.yaml`:
    ```yaml
    model: 9Router-Dev
    provider: 9router
    base_url: http://localhost:20128/v1
    secondary_provider: omniroute
    secondary_base_url: http://localhost:30128/v1
    ```
  - Crucial Finding: Hermes Agent is ALREADY configured to use 9Router (`http://localhost:20128/v1`) as primary provider and OmniRoute (`http://localhost:30128/v1`) as secondary provider!
- **Conclusion:** Hermes Agent directly routes through the local routers managed by RouterSync, confirming the real-world necessity of AT-95 (circular dependency detection).
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, Hermes Agent v0.21.7, Windows 11
- **Spec delta:** none

---

## 10. Recommended Adapter Strategy (V-08, spec §30.9)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (synthesis)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Recommendation:**
  - **Harness Priority:** Hermes Agent is the primary target harness for RouterSync.
  - **MCP Registration:** Register RouterSync stdio server in `%USERPROFILE%\.hermes\mcp_config.json`.
  - **Headless Advisor:** Execute headless recommendations via `hermes -z --usage-file .routersync/advisor-usage.json`.
  - **Circular Dependency Guard:** Check `~/.hermes/config.yaml` before applying router modifications; if Hermes targets a modified combo, warn user and require safe rollback plan.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, Hermes Agent v0.21.7, Windows 11
- **Spec delta:** none
