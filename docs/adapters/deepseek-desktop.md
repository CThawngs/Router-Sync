# DeepSeek Harness Desktop (DSH Desktop) Adapter Investigation (Phase 0 Discovery)

This document records the empirical discovery findings for DeepSeek Harness Desktop (DSH Desktop) on the local host machine, aligning with RouterSync's global open-source multi-harness design.

---

## 1. Runtime, Stack & Installation (V-02, spec §5.3, §14)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (runtime inspection of local host installation)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Install Locations:**
  - App Data Profile: `~/.dsh/` (`%USERPROFILE%\.dsh\`)
  - Application Cache & Binaries: `%APPDATA%\@deepseek-ai\dsh-desktop\` and `%LOCALAPPDATA%\@deepseek-aidsh-desktop-updater\`
  - Config Profiles: `~/.dsh/profiles/desktop/`, `~/.dsh/profiles/headless/`
- **Tech Stack & Framework:**
  - Desktop client powered by `@deepseek-ai/dsh-*` modules.
  - Configuration composition engine: Cordis framework (`cordis.yml`, `cordis.patch.yml`).
  - Active runtime plugins: `@deepseek-ai/dsh-agent-default-model`, `@deepseek-ai/dsh-mcp-client`, `@deepseek-ai/dsh-api-gateway`, `@deepseek-ai/dsh-permission-presets`.
- **Conclusion:** DeepSeek Harness Desktop (DSH Desktop) is actively installed and operates via a Cordis-patch plugin architecture.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, DeepSeek Harness Desktop (DSH), Windows 11 (10.0.26300)
- **Spec delta:** Added DeepSeek Harness Desktop as an active tier-1 supported desktop agent harness.

---

## 2. H-01: MCP Support & Transports (V-02, spec §30.9)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (inspection of active plugin configuration in `cordis.patch.yml`)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Observed Configuration:**
  - MCP client plugin: `@deepseek-ai/dsh-mcp-client`.
  - Supported Transport: `stdio` (command + args array, environment variables).
  - Existing Active MCP Servers: `notion` (via `mcp-remote`), `chrome-devtools`, `playwright`.
- **Conclusion:** DSH Desktop natively supports standard stdio MCP servers through its `@deepseek-ai/dsh-mcp-client` plugin.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, DSH Desktop, Windows 11
- **Spec delta:** none

---

## 3. H-02: MCP Registration Location & Format (V-02, spec §30.9, §30.11 AT-94)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (filesystem inspection of `~/.dsh/profiles/desktop/cordis.patch.yml`)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **File Location:** `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`
- **Registration Syntax:**
  ```yaml
  - insert:
      - id: mcp-routersync
        name: "@deepseek-ai/dsh-mcp-client"
        config:
          serverName: routersync
          transport: stdio
          command: node
          args:
            - "<path-to-routersync>/packages/cli/dist/index.js"
            - "mcp"
            - "serve"
          toolCallTimeoutMs: 60000
          failOnStartupError: false
  ```
- **Non-destructive Merge:** Yes. Cordis patch files use an append/insert patch list (`- insert: [...]`). RouterSync can append a patch entry with a unique `id: mcp-routersync` without overwriting existing plugins or credentials.
- **Conclusion:** RouterSync can register its MCP server non-destructively in `~/.dsh/profiles/desktop/cordis.patch.yml`.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, DSH Desktop, Windows 11
- **Spec delta:** none

---

## 4. H-03: Headless Execution & Multi-Profile Support (V-02, spec §30.9)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (filesystem inspection of `~/.dsh/profiles/headless/`)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Observed Profiles:**
  - `~/.dsh/profiles/desktop/`: GUI chat and agent workflow.
  - `~/.dsh/profiles/headless/`: Headless execution profile with dedicated `cordis.patch.yml` and `cordis.yml`.
  - `~/.dsh/profiles/bots/` and `~/.dsh/profiles/web/`.
- **Conclusion:** DSH Desktop maintains a distinct `headless` profile for automated script and pipeline execution.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, DSH Desktop, Windows 11
- **Spec delta:** none

---

## 5. H-04: Permission Model & Safety Presets (V-02, spec §30.9)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (inspection of `cordis.patch.yml`)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Observed Configuration:**
  - Plugin `@deepseek-ai/dsh-permission-presets` manages tool execution approval levels.
  - Configurable timeouts per MCP client: `toolCallTimeoutMs` (e.g. 60,000 ms to 120,000 ms).
  - Fault tolerance: `failOnStartupError: false` prevents crashing the harness if a specific MCP server is temporarily offline.
- **Conclusion:** DSH Desktop incorporates permission presets and granular per-tool timeouts.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, DSH Desktop, Windows 11
- **Spec delta:** none

---

## 6. H-07: Instruction & Skill Ingestion (V-02, V-13, spec §30.9)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (inspection of `~/.dsh/` root)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Observed Files:**
  - `~/.dsh/AGENTS.md` and `~/.dsh/MEMORY.md` reside at the root of `~/.dsh/`.
  - Workspace `AGENTS.md` is ingested during active project sessions.
  - Skill directories: `~/.dsh/skills/` and `~/.dsh/skill-trace/`.
- **Conclusion:** DSH Desktop natively ingests `AGENTS.md` instructions and supports a dedicated skill library.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, DSH Desktop, Windows 11
- **Spec delta:** none

---

## 7. Recommended Integration Strategy
- **Harness Category:** Tier 1 Desktop Harness (alongside Hermes Agent Desktop).
- **Adapter Implementation:** Create `@routersync/adapter-dsh` (or modular harness handler) supporting:
  1. Reading and updating `~/.dsh/profiles/desktop/cordis.patch.yml` using a safe YAML parser.
  2. Injecting `mcp-routersync` into the `- insert:` block with pre-write snapshot and rollback.
  3. Inspecting `@deepseek-ai/dsh-agent-default-model` to detect circular dependencies if DSH routes to a local managed router.
- **Global Community Applicability:** Design the DSH adapter with neutral path resolution (`os.homedir() + '/.dsh'`), fully compatible with Windows, macOS, and Linux installations worldwide.
