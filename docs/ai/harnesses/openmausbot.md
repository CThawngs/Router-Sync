# OpenMausBot — RouterSync Integration & Skill Guide

**Harness ID:** `openmausbot`
**Display Name:** OpenMausBot
**Direction A Mode:** `write-adapter` (`~/.openmausbot/config.json` **ONLY**)
**MCP Support:** `supported: true` (`json` — `mcpServers` in `~/.openmausbot/config.json`, overridable via `OMB_DATA_DIR`)
**Scheduler Support:** `built-in-croner-llm-routines` (`zeroTokenScriptCapable: false` — use `os-scheduler-and-tick-if-due`)

---

## 1. Critical File Boundary (`config.json` ONLY — Never Touch `bots.json` or `routines.json`)

- **`~/.openmausbot/config.json`** is the **only** file managed by RouterSync (`mcpServers` and `instances.<instance_id>.config.managedModels` for `driver === "openai-compat"`).
- **STRICT PROHIBITION:** **NEVER inspect for mutation, recommend hand-editing, or touch `bots.json` or `routines.json`!** Both `bots.json` and `routines.json` are runtime-owned by the running OpenMausBot process and MUST remain 100% untouched on disk to prevent save races and state corruption.
- Built-in drivers (`openai`, `claudeApi`, `xaiApi`, `openrouter`) and `customAcp` remain `report-only`; default slots (`defaultModelSelection`, `automaticRecovery.backup`, `decider.openrouterModel`, `instances.<id>.config.model`) are always preserved.
- Restart OpenMausBot after applying verified updates to `config.json` (engine instances are read at boot).

---

## 2. MCP Server Registration

Register `routersync-mcp` under `mcpServers` in `~/.openmausbot/config.json` (or via *Plugins > MCP servers > Add server* in the OpenMausBot UI):

```json
{
  "mcpServers": {
    "routersync": {
      "command": "routersync-mcp",
      "args": [],
      "enabled": true
    }
  }
}
```

---

## 3. Adaptive User Interview Protocol (`<= 12` Questions)

When assisting a user inside OpenMausBot:
1. Run the `routersync_adaptive_interview` MCP prompt (`{ "harness": "openmausbot" }`) or call `profile_interview` (`{}`).
2. Ask **at most `12` questions** in plain everyday language (`7..8` core questions; up to `4` optional follow-ups only for power users).
3. Never ask for plaintext API keys or secrets in chat.
4. **Explicit `assumptions[]` & Zero Fabrication:**
   - Vague preference answers (`"idk"`, `"not sure"`) apply conservative defaults (`budget: "free-only"`, `automationLevel: "propose"`, `scanCycle: "daily"`) and record each assumption in `assumptions[]`.
   - Never fabricate factual inventory (`harnesses`, `routers`, `keyedProviders`, `favorites`, `allowList`); unstated lists remain `[]`.
5. Validate answers in memory via `profile_interview({ "answers": { ... } })` (`0` disk writes) before saving via `routersync profile interview --adaptive --answers <json> --write`.

---

## 4. Router Strategy & Combo Selection Workflow

1. Call `list_strategies` to inspect **9Router** (`fallback`, `round-robin`), **OmniRoute** (`priority`, `weighted`, `round-robin`), and **LiteLLM** (`fallbacks`, `simple-shuffle`, `least-busy`) capabilities.
2. Build combos with `2..12` chat steps (`2..15` for `free-only`), `0%` `DEAD`/`HANG` steps (even if in `favorites`), `0` non-chat specialists (`embedding`, `audio`, `moderation`, `image-gen`, `rerank`), and cross-provider round-robin interleaving.
3. Because OpenMausBot's Croner routines wake LLM bot turns (and `routines.json` must stay untouched), schedule zero-token RouterSync background ticks via OS scheduler (`routersync schedule install --harness openmausbot --dry-run`).

---

## 5. Standing Consent & Emergency Freeze Safety

- Every target defaults to **`propose`**.
- Upgrading to **`auto-safe`** requires **at least 1 completed `propose` apply with verified post-write read-back** (`C45 §3.2`) and an explicit expiry.
- Operators can stop all controlled writes immediately with `routersync freeze`.
