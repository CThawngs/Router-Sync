# OpenCode Adapter Investigation (Phase 0 Discovery)

This document records the discovery status and public specification baseline for OpenCode.

---

## 1. Project Owner Scope Directive
- **Directive Date:** 2026-10-13 (Checkpoint 1)
- **Decision:** Dropped / Example Only. The project owner explicitly confirmed that OpenCode was only an illustrative example in earlier drafts, and the primary focus for RouterSync is **Hermes Agent Desktop**.
- **Phase 0 Status:** `DEFERRED / EXAMPLE ONLY`

---

## 2. Specification & Public Baseline (L0) (V-07, spec §17, §30.9)
- **Status:** `OBSERVED (L0)`
- **Evidence level:** `L0` (public documentation and specification reference)
- **Config file:** `~/.config/opencode/opencode.json` (JSON / JSONC) or project-local `opencode.json`.
- **Merge Behavior:** Global and project configurations are merged, not overwritten.
- **Provider Models Allowlist:** For custom providers, `provider.<id>.models` functions as an allowlist; newly synced models only appear in OpenCode if explicitly registered under the provider's model map.
- **Default Model Slots:** Slots `model` and `small_model` designate the primary default models. Changing these slots carries higher risk of impacting active sessions.
- **Credential Storage:** Keys should reference environment variables via `{env:VAR}` syntax rather than hardcoding plaintext secrets.
- **Reload Mechanism:** Configuration changes require restarting the OpenCode daemon or session reload.

---

## 3. Integration Assessment
- **Integration Tier:** Tier 2 (Config file merge).
- **Current Recommendation:** Retain adapter specification as a secondary reference template; do not implement product adapter code in Phase 1 unless prioritized by user.
