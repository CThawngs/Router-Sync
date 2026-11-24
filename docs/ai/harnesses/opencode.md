# OpenCode — RouterSync Integration & Skill Guide

**Harness ID:** `opencode`
**Display Name:** OpenCode
**Direction A Mode:** `write-adapter`
**MCP Support:** `supported: true` (`jsonc` — top-level `mcp` key in `~/.config/opencode/opencode.json` or `opencode.jsonc`)
**Scheduler Support:** `none` (`zeroTokenScriptCapable: false` — use `os-scheduler-and-tick-if-due`)

---

## 1. MCP Server Registration

OpenCode configures MCP servers under top-level `"mcp"` (not `"mcpServers"`) with `"type": "local"` and an argv `"command"` array in `~/.config/opencode/opencode.json` (or `<project>/opencode.json`):

```jsonc
{
  "mcp": {
    "routersync": {
      "type": "local",
      "command": ["routersync-mcp"],
      "enabled": true
    }
  }
}
```

- **Native CLI install:** `opencode mcp add`
- **Reload:** Restart OpenCode TUI or open a new session after updating `opencode.json`.

---

## 2. Direction A Model Sync (`write-adapter`)

OpenCode uses `directionAMode: write-adapter`:
- Provider model catalogs live at `provider.<provider_id>.models.<model_id>` in `opencode.json` / `opencode.jsonc`, while credentials stay in `~/.local/share/opencode/auth.json` or `options.apiKey` env references.
- RouterSync performs lossless JSONC comment-preserving span edits, keeping `model`, `small_model`, `agent.<name>.model`, `options.baseURL`, and `options.apiKey` byte-identical.
- Preview plans with `routersync apps plan --app opencode --catalog <catalog.json>` and test in `os.tmpdir()` with `--sandbox-copy`.

---

## 3. Adaptive User Interview Protocol (`<= 12` Questions)

When guiding a user through RouterSync configuration in OpenCode:
1. Trigger the `routersync_adaptive_interview` MCP prompt (`{ "harness": "opencode" }`) or call `profile_interview` (`{}`).
2. Ask **`<= 12` questions total** (`7..8` everyday questions; up to `4` optional power-user questions only when needed).
3. Never ask for raw API keys.
4. **Explicit `assumptions[]` & Zero Fabrication:**
   - Vague preference answers (`"idk"`, `"not sure"`) use conservative defaults (`budget: "free-only"`, `automationLevel: "propose"`, `scanCycle: "daily"`) and log each assumption in `assumptions[]`.
   - Never fabricate `harnesses`, `routers`, `keyedProviders`, `favorites`, or `allowList` (`[]` when unstated).
5. Validate in memory with `profile_interview({ "answers": { ... } })` (`0` disk writes) and persist via `routersync profile interview --adaptive --answers <json> --write`.

---

## 4. Router Strategy & Combo Selection Workflow

1. Inspect **9Router** (`fallback`, `round-robin`), **OmniRoute** (`priority`, `weighted`, `round-robin`), and **LiteLLM** (`fallbacks`, `simple-shuffle`, `least-busy`) capabilities via `list_strategies`.
2. Enforce `2..12` steps (`2..15` for `free-only`), `0` `DEAD`/`HANG` steps (including `favorites`), `0` specialist non-chat models (`embedding`, `audio`, `moderation`, `image-gen`, `rerank`), and cross-provider round-robin interleaving.
3. Use `routersync litellm inspect|plan|apply|rollback` for lossless LiteLLM `config.yaml` updates.

---

## 5. Standing Consent & Emergency Freeze Safety

- Default mode is **`propose`**.
- Enabling **`auto-safe`** requires **at least 1 completed `propose` apply with verified read-back** (`C45 §3.2`) and a bounded `expiresAt`.
- Run `routersync freeze` to halt all controlled writes immediately.
