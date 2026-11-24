# RouterSync Operator Workflow & Safety Guide

This guide details daily operation with RouterSync: observation, proposals, human approval, transactional apply, and rollback.

---

## 1. Core Operating Philosophy

RouterSync synchronizes model routing and combo pipelines across local AI routers (OmniRoute, 9Router) and AI agent harnesses (Hermes Agent, DeepSeek Harness) without incurring inference costs.

Key rules:
- **Zero-Inference Observation:** RouterSync never calls pay-per-token model endpoints. Probes rely on local configs, databases, and zero-token discovery endpoints.
- **Human Approval Mandatory:** No configuration mutation is applied automatically by background jobs or MCP agents without standing consent or approval token.
- **Strict Invariants:** Applied plans must satisfy I1 (no missing models) and I8 (ordered writes).
- **CLI Flags Safety:** The `--yes` flag is rejected by the CLI security policy; interactive confirmation is strictly required.

---

## 2. Setup & Installation

Initialize configuration and verify local routers:
```bash
routersync init
routersync scan
```

Diagnose harness configuration, active 4-tier schedule ladder, circular dependencies, and owner live-pilot readiness (see [docs/schedule-ladder.md](docs/schedule-ladder.md) and [docs/runbook/LIVE-E2E-v2.md](docs/runbook/LIVE-E2E-v2.md)):
```bash
routersync doctor
routersync schedule install --dry-run --json
routersync live-check --router-target router:omniroute/coding-main --harness-target harness:hermes --json
```

Run the local daemon in read-only slice (S1):
```bash
routersync daemon --port 3128
```

To run the local web interface (connecting to daemon at port 3128, source: packages/ui/package.json):
```bash
pnpm --filter @routersync/ui dev
```

To configure MCP server integration for agent harnesses in dry-run mode:
```bash
routersync mcp install --client hermes
```
Target configuration file (`~/.hermes/mcp_config.json`) write verification status is `UNVERIFIED` until tested against a live harness instance.

---

## 3. Observation & Drift Detection

Observe active routers and detect drift between intended state and live router state:
```bash
routersync status
```

---

## 4. Feature Maturity Matrix & Read-Only UI

Current capability maturity across operational surfaces:
- [WORKS TODAY — r44-cli-help] CLI command suite: status, scan, plan, apply, rollback, live-check, freeze, unfreeze, consent, mcp, daemon, doctor.
- [WORKS TODAY — r44-mcp-tools] MCP server tools: read-only inspection, planning, `tick_if_due`, `cost_report`, `submit_research`, and consent-gated `apply_plan` active over stdio.
- [WORKS TODAY — r44-mcp-install-dry] Harness integration: non-destructive merge preview for agent configuration files.
- [NOT YET] In-browser mutation: direct configuration writes from web interface without TTY confirmation.
- [NOT RUN] Automatic background daemon auto-apply without human approval token or standing consent.
- [UNVERIFIED] Multi-node distributed router cluster synchronization.

Web UI Read-Only Operation Today: Action buttons that imply configuration writes (Apply, Approve, Rollback, Pause) open a modal displaying the exact CLI command to run in your terminal. RouterSync only modifies router configuration when confirmed directly in your terminal or covered by valid standing consent.

---

## 5. Change Proposal & Planning

Generate a deterministic change plan without modifying router state:
```bash
routersync plan
```

---

## 6. Human Approval & Transactional Apply

Review plan differences and apply safely to routers (for the full owner live pilot sequence from `propose` to `auto-safe` and `1.0.0` cutover, follow `docs/runbook/LIVE-E2E-v2.md`):
```bash
routersync apply --write
```
- Apply requires interactive TTY confirmation or valid standing consent; `--yes` is rejected.
- Each apply executes: pre-write snapshot -> atomic write -> serving reflection reload check (mã: packages/adapter-9router/src/index.ts:506 hoặc UNVERIFIED) -> read-back verification.

---

## 7. Rollback & Recovery

When anomalies occur, rollback restores logical router state from a recorded snapshot:
```bash
routersync rollback
```
- Logical row-level restore restores past router states without file system corruption.
- Read-back verification confirms live router consistency after rollback (router reload reflection: UNVERIFIED).

---

## 8. Agent Harness & Read-Only MCP Tools

RouterSync provides read-only MCP tools for agent harnesses:
1. Discovery & Config: `detect_routers`, `get_config`, `validate_config`, `get_schema`.
2. Models & Combos: `list_models`, `list_combos`, `list_traits`, `list_strategies`.
3. Health & Drift: `status`, `drift`, `plan_status`, `audit_tail`, `tick_if_due`, `cost_report`.
4. Planning & Guidance: `plan`, `explain`, `search_docs`, `inbox_list`, `get_item`.

---

## 9. Security Boundaries & Acceptance Contracts

Operational safety contracts ensure system integrity:
- **T3-DAEMON-SEC:** Daemon runs in read-only slice (S1) bound to localhost. Endpoint `POST /api/v1/changes/approve` exists for token consumption, but no token issuance mechanism exists outside test suites.
- **T3-DAEMON-PAYLOAD-TEXT:** Payload integrity enforced by strict type guards preventing arbitrary text injection.
- **AT-84:** Verifies invariant preservation during plan evaluation.
- **AT-114:** Phép thử ghi 9Router thật (live router write test, hiện ở trạng thái NOT RUN; kiểm tra an toàn kind=NULL và tiền tố marker; chủ dự án tự chạy theo `docs/runbook/LIVE-E2E-v2.md`).
