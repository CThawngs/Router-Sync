# DeepSeek Harness (DSH) — RouterSync Integration & Skill Guide

**Harness ID:** `dsh`
**Display Name:** DeepSeek Harness (`dsh`)
**Direction A Mode:** `write-adapter`
**MCP Support:** `supported: true` (`yaml` — `insert[]` plugin rows for `@deepseek-ai/dsh-mcp-client` in `~/.dsh/profiles/desktop/cordis.patch.yml` or `~/.dsh/cordis.patch.yml`)
**Scheduler Support:** `built-in-dsh-schedule-llm-prompts` (`zeroTokenScriptCapable: false` — use `os-scheduler-and-tick-if-due`)

---

## 1. MCP Server Registration

DSH registers MCP servers as Cordis plugin rows (`@deepseek-ai/dsh-mcp-client`) under `insert:` in `~/.dsh/profiles/desktop/cordis.patch.yml` (overridable via `DSH_HOME`):

```bash
routersync mcp install --harness dsh
```

- **Cordis Boot Safety:** A malformed YAML row prevents DSH from booting, and editing `cordis.patch.yml` mid-turn can interrupt active sessions — always apply when DSH is idle and rely on RouterSync's atomic `.routersync.bak` + read-back verification.

---

## 2. Direction A Model Sync (`write-adapter`)

DSH uses `directionAMode: write-adapter`:
- Provider model lists live under `row[name="@deepseek-ai/dsh-llm-pi-ai"].config.providers.<provider_id>.models[]` in `~/.dsh/profiles/desktop/cordis.patch.yml`, while credentials stay isolated in `~/.dsh/.credentials.yaml` (`apiKeyEnv`).
- Because a Cordis patch row replaces the target plugin's config block as a unit, RouterSync's lossless YAML CST adapter preserves every sibling field, provider block, comment, and default model slot (`config.provider`, `config.model`, `config.default`, `config.selectedDefault`) byte-for-byte.

---

## 3. Adaptive User Interview Protocol (`<= 12` Questions)

When running the RouterSync setup interview inside DSH:
1. Invoke the `routersync_adaptive_interview` MCP prompt (`{ "harness": "dsh" }`) or call `profile_interview` (`{}`).
2. Ask **`<= 12` questions total** (`7..8` everyday core questions; up to `4` optional follow-ups only for power users).
3. Never ask for plaintext API keys or credentials.
4. **Explicit `assumptions[]` & Zero Fabrication:**
   - Vague preference answers (`"idk"`, `"not sure"`) apply conservative defaults (`budget: "free-only"`, `automationLevel: "propose"`, `scanCycle: "daily"`) and record each assumption in `assumptions[]`.
   - Never fabricate factual inventory (`harnesses`, `routers`, `keyedProviders`, `favorites`, `allowList`); unstated lists remain `[]`.
5. Validate in memory with `profile_interview({ "answers": { ... } })` (`0` disk writes) and persist via `routersync profile interview --adaptive --answers <json> --write`.

---

## 4. Router Strategy & Combo Selection Workflow

1. Call `list_strategies` to inspect **9Router** (`fallback`, `round-robin`), **OmniRoute** (`priority`, `weighted`, `round-robin`), and **LiteLLM** (`fallbacks`, `simple-shuffle`, `least-busy`) capabilities.
2. Build combos with `2..12` chat steps (`2..15` for `free-only`), `0%` `DEAD`/`HANG` models (even if in `favorites`), `0` non-chat specialists (`embedding`, `audio`, `moderation`, `image-gen`, `rerank`), and cross-provider round-robin interleaving.
3. Use `routersync litellm inspect|plan|apply|rollback` for lossless LiteLLM `config.yaml` updates.

---

## 5. Standing Consent & Emergency Freeze Safety

- Default mode is **`propose`**.
- Upgrading a target to **`auto-safe`** requires **at least 1 completed `propose` apply with verified post-write read-back** (`C45 §3.2`) and an explicit expiry.
- Run `routersync freeze` at any time to immediately halt all controlled writes.
