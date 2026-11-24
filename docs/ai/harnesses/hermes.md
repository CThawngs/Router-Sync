# Hermes Agent — RouterSync Integration & Skill Guide

**Harness ID:** `hermes`
**Display Name:** Hermes Agent (Nous Research)
**Direction A Mode:** `write-adapter`
**MCP Support:** `supported: true` (`yaml` — `mcp_servers` in `%LOCALAPPDATA%/hermes/config.yaml` or `~/.hermes/config.yaml`)
**Scheduler Support:** `built-in-gateway-cron` (`zeroTokenScriptCapable: true` via `no_agent: true` script jobs, paired with `os-scheduler` fallback)

---

## 1. MCP Server Registration

Hermes supports native local stdio and HTTP MCP servers under `mcp_servers` in `<HERMES_HOME>/config.yaml` (`%LOCALAPPDATA%/hermes/config.yaml` on Windows native, `~/.hermes/config.yaml` on macOS/Linux/WSL2).

- **Native CLI install:**
  ```bash
  hermes mcp add routersync -- routersync-mcp
  ```
- **RouterSync lossless merge (`yaml-comment-preserving-merge`):**
  ```bash
  routersync mcp install --harness hermes
  ```
- **Reload:** Run `/reload-mcp` in active Hermes chat to reload MCP tools without restarting the session.

---

## 2. Direction A Model Sync (`write-adapter`)

Hermes uses `directionAMode: write-adapter`:
- Model lists live in `<HERMES_HOME>/config.yaml` (`providers.<provider_id>.models` and `custom_providers[].models`), while secrets stay isolated in `<HERMES_HOME>/.env`.
- RouterSync preserves all YAML comments, key ordering, `api_key` / `key_env` references, `base_url`, and default model slots (`model.default`, `model.provider`, `model.base_url`, `cron.model`, `cron.model_provider`).
- Always preview changes first on an isolated sandbox copy (`routersync apps plan --app hermes --catalog <catalog.json>`).

---

## 3. Adaptive User Interview Protocol (`<= 12` Questions)

When setting up or updating a user's RouterSync preferences in Hermes:
1. Launch the MCP prompt `routersync_adaptive_interview` (with `{ "harness": "hermes" }`) or call `profile_interview` (`{}`).
2. Ask **at most `12` questions total** (`7..8` everyday core questions for general users; up to `4` optional power-user follow-ups only when the user requests custom step caps, router merge mode, or favorites/blocklists).
3. Use plain everyday language with relatable examples — **never** ask the user to paste API keys into chat.
4. **Explicit `assumptions[]` & Zero Fabrication:**
   - If the user answers vaguely (`"idk"`, `"not sure"`, `"whatever"`), apply safe conservative defaults for preferences (`budget: "free-only"`, `automationLevel: "propose"`, `scanCycle: "daily"`) and record every assumption in `assumptions[]`.
   - **Never fabricate** factual inventory (`harnesses`, `routers`, `keyedProviders`, `favorites`, `allowList`); leave unstated factual arrays as `[]` pending read-only local discovery (`routersync apps inspect --app hermes`, `detect_routers`).
5. Validate answers in memory with `profile_interview({ "answers": { ... } })` (`0` disk writes) and persist via `routersync profile interview --adaptive --answers <json> --write`.

---

## 4. Router Strategy & Combo Selection Workflow

1. Call `list_strategies` to inspect live combo strategies and capability tiers across **9Router** (`fallback`, `round-robin` + provider credential pools), **OmniRoute** (`priority`, `weighted`, `round-robin`), and **LiteLLM** (`fallbacks`, `simple-shuffle`, `least-busy`).
2. Build combos with `12` steps default (`15` for `free-only`, minimum `2` steps per Invariant `I3`), `0%` `DEAD` or `HANG` models (even if listed in `favorites`), `0` non-chat specialist models (`embedding`, `audio`, `moderation`, `image-gen`, `rerank`), and full cross-provider round-robin interleaving.
3. For LiteLLM `config.yaml`, use `routersync litellm inspect|plan|apply|rollback --config <sandbox-path>` (preserving `#` comments, `os.environ/...` references, `general_settings`, and `litellm_settings` byte-for-byte).

---

## 5. Standing Consent & Emergency Freeze Safety

- Every target defaults to **`propose`** (human approval required before writes).
- Upgrading a target to **`auto-safe`** requires **at least 1 completed `propose` apply with verified post-write read-back** first (`C45 §3.2`), an explicit expiry (`expiresAt`), and strict `I1..I8` invariant validation.
- Operators can halt all automated or MCP-triggered writes immediately at any time with:
  ```bash
  routersync freeze --reason "operator pause"
  ```
