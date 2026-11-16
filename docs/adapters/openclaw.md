# OpenClaw Adapter Investigation (Phase 0 Discovery)

This document records the discovery status and public specification baseline for OpenClaw.

---

## 1. Project Owner Scope Directive
- **Directive Date:** 2026-10-13 (Checkpoint 1)
- **Decision:** Not Installed / Deferred. The project owner confirmed that OpenClaw is not currently installed on the host machine, and **Hermes Agent Desktop** is the sole active target harness for Phase 0 and Phase 1.
- **Phase 0 Status:** `DEFERRED / NOT INSTALLED`

---

## 2. Specification & Public Baseline (L0)
- **Status:** `UNVERIFIED (L0)`
- **Evidence level:** `L0` (public documentation baseline)
- **Harness Type:** OpenClaw autonomous coding agent harness.
- **MCP Support:** Stdio and SSE MCP client capabilities documented in public repositories.
- **Config file:** User configuration typically resides in `~/.openclaw/config.json` or `.openclawrc`.
- **Headless Mode:** CLI flags exist for non-interactive execution, but behavioral parameters on Windows remain unverified without a local installation.

---

## 3. Integration Assessment
- **Integration Tier:** TBD upon installation in a future phase.
- **Current Recommendation:** Keep OpenClaw on the backlog. Re-evaluate when the user installs OpenClaw or requests multi-harness sync.
