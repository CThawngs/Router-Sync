# Skill: RouterSync Assistant (Agent Harness Guide)

This guide documents the interaction model, tool protocol, and available commands for AI agents connected to RouterSync via Model Context Protocol (MCP) or CLI.

---

## 1. Safety Boundary & Invariant Rules

As an AI agent interacting with RouterSync, you operate strictly within read-only boundaries:

1. **Zero Autonomous Writes:** You CANNOT execute `routersync apply --write` or modify live router state autonomously. State modification strictly requires human review in an interactive TTY.
2. **Read-Only MCP Server:** The RouterSync MCP server exposes only read-only diagnostic, query, and planning tools. There are NO write tools on the MCP server.
3. **No Inference Probing:** Model verification does not consume billable LLM tokens (Rule §23.2 / R12). Do not probe models with billable completions.
4. **Independent Rollback:** If an ongoing sync causes issues, human operators can always run `routersync rollback` independently from the terminal without AI assistance.

---

## 2. Tool Calling Protocol & Discovery Sequence

When diagnosing, inspecting, or planning combo synchronization, follow this sequence:

1. **Detect Routers:** Call `detect_routers` to discover local running routers and check port liveness.
2. **Inspect Status:** Call `status` to retrieve health, combo counts, and serving-path read-back levels.
3. **Check Changes:** Call `diff` to compare scan results and check provider changes.
4. **Generate Plan:** Call `plan` or `sync_plan` to compute a deterministic diff (pure dry-run, zero live writes).
5. **Review Inbox:** Call `inbox_list` and `get_item` to review proposals or warnings.

---

## 3. Real MCP Tools Catalog

Every tool listed below is implemented in `@routersync/mcp-server` and supports cursor-based pagination and untrusted string sanitization:

| MCP Tool | Description |
|---|---|
| `detect_routers` | Scans local system for active LLM routers (OmniRoute, 9Router) |
| `get_config` | Returns loaded `routersync.yaml` configuration with secrets redacted |
| `validate_config` | Parses `routersync.yaml` as YAML, validates it against the Zod schema, and evaluates only the invariants provable from combos plus catalog (I1, I2, I3, I6, I7); I4, I5, I8 are returned as `invariantsNotEvaluated` |
| `list_models` | Lists catalog models with pagination (`cursor`, `limit`) and traits |
| `list_combos` | Lists active router combos with pagination and routing strategies |
| `status` | Reads the daemon tick state (`status.json`) and reports last-tick counters, per-router `applyStates` (published only when a write left evidence) and `pendingReloadRouters` |
| `plan` | Computes deterministic synchronization plan (dry-run only) |
| `sync_plan` | Returns synchronization plan model changes without router writes |
| `diff` | Compares scan results to detect new and gone models across providers |
| `health` | Runs the named state-file checks (tick status, catalog snapshot, config) and zero-token router liveness probes |
| `discover` | Discovers newly available models and free candidate tiers |
| `scan_completeness` | Reports scan completeness status across configured providers |
| `research_queue` | Derives the research queue from the verification ledger records (`state/verify-status.json`), not from a fixed list |
| `research_evidence` | Returns the ledger record (L1/L2/L3 evidence) for one model id, or `found: false` when it is absent |
| `schedule_status` | Reads `autopilot.yaml` and the plans directory and reports the newest plan file |
| `autopilot_status` | Reports the configured autonomy mode, the policy file presence and the newest plan on disk |
| `search_docs` | Searches the repository Markdown tree (depth <= 3, <= 200 files) for a literal case-insensitive query and returns file, line and snippet |
| `inbox_list` | Lists the items actually present in `state/inbox.json`; it never fabricates a system-health item |
| `verify_requests` | Counts the ledger records that still need research and returns their ids |
| `get_item` | Retrieves a model, combo, inbox item or plan by id from its real source file |
| `list_traits` | Reflects the capability fields declared by the runtime model schema |
| `list_strategies` | Lists the strategies observed on the live combos, with a per-strategy count |
| `get_schema` | Reflects the runtime Zod schema for a named target; the response is labelled a reflection, not a complete JSON Schema document |
| `profile_interview` | Reads `profile.yaml` and returns the 12 interview questions that are still unanswered |

---

## 4. Real CLI Commands Catalog

The following commands are available via `routersync` CLI:

| Command | Usage | Description |
|---|---|---|
| `init` | `routersync init` | Initializes default `routersync.yaml` configuration |
| `scan` | `routersync scan` | Scans local routers for health and active model combos |
| `plan` | `routersync plan` | Computes deterministic combo changes without writing |
| `apply` | `routersync apply` | Applies plan (dry-run by default; requires `--write` and TTY) |
| `rollback` | `routersync rollback [snapshot-id]` | Restores router state to previous pre-write snapshot (dry-run by default; `--write` requires TTY and confirmation) |
| `status` | `routersync status` | Displays status, health, and read-back levels |
| `doctor` | `routersync doctor` | Diagnoses harness configuration and circular dependencies |
| `mcp install` | `routersync mcp install` | Installs MCP server into Hermes or DSH harness |

---

## 5. Agent Guidelines on `status` & `applyStates`

When calling `status` or evaluating sync execution:
- RouterSync tracks target router apply states (`applyStates`) and routers pending reload (`pendingReloadRouters`).
- A status of `written-pending-reload` means SQLite/file updates were committed, but the router process has not yet reloaded its in-memory state or read-back verification has not completed.
- **Strict Rule for AI Agents:** Agents MUST NEVER report `written-pending-reload` as a successful sync. It must be communicated as pending reload, and if reload fails or times out, as an incomplete sync requiring operator attention.

---

## 6. Workflow Examples

### Example 1: Inspecting Router Health and Status
```json
// Step 1: Detect running routers
{ "tool": "detect_routers" }

// Step 2: Query overall status and read-back levels
{ "tool": "status" }
```

### Example 2: Diagnosing Provider Changes and Inspecting Combos
```json
// Step 1: Check diff between scans
{ "tool": "diff" }

// Step 2: List current combos across routers
{ "tool": "list_combos", "arguments": { "limit": 20 } }

// Step 3: Inspect specific combo details
{ "tool": "get_item", "arguments": { "type": "combo", "id": "routersync-coder", "comboId": "routersync-coder" } }
```

### Example 3: Generating Plan and Inspecting Sync Changes
```json
// Step 1: Generate deterministic plan
{ "tool": "plan" }

// Step 2: Inspect sync plan model changes
{ "tool": "sync_plan" }
```

### Example 4: Diagnosing Circular Dependency and Harness Setup
```json
// Step 1: Search documentation
{ "tool": "search_docs", "arguments": { "query": "circular dependency" } }

// Step 2: Review inbox items
{ "tool": "inbox_list", "arguments": { "limit": 10 } }
```
