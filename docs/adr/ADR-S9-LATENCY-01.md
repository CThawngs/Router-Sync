# ADR-S9-LATENCY-01: Separate Detection Latency from Removal Settle Time

- **Status:** ACCEPTED
- **Date:** 2026-11-26
- **Author:** RouterSync Team
- **Related work:** C48 (H1-H4), S9, `routersync tick`, `routersync pilot-report`, Invariant I4, `docs/runbook/OWNER-CHECKLIST.md`
- **Verification:** Focused C48 and affected C46/WP3 suites, targeted mutation checks, typecheck, lint, and build.

## 1. Context

Before C48, `pilot-report` used `detectionLatencyMs` for two measurements with different meanings:

1. The time RouterSync takes to **detect** an absent model or an official notice.
2. The mandatory safety **settle time** before a model may be removed from a combo or harness configuration.

Combining them caused a valid absence-only removal, which must wait at least 24 hours and three qualifying scans, to be reported as a violation of the `<= 60,000 ms` detection threshold. The report also had no field proving that the safety wait had actually been observed.

## 2. Decision

Measure detection latency and removal settle time independently. Never add them together.

### 2.1 `detectionLatencyMs` - detection latency

| Detection path | Start point | End point |
|---|---|---|
| Absence (`absence-only`) | Start of the tick scan (`scanStartedAt`) | First `model_pending` transition (`modelPendingAt`) |
| Official notice (`official-notice`) | First qualifying scan that sees actionable official evidence (`firstQualifyingScanStartedAt`) | First plan creation for that evidence (`firstPlanCreatedAt`) |

- The hard threshold is `HARD_PASS_MAX_DETECTION_LATENCY_MS = 60_000` milliseconds.
- Absence detections are stored in `tick-catalog.json` under `absenceDetections[]`, including `episodeId`, `scanStartedAt`, `modelPendingAt`, `detectionMs`, and `targetsAffected`.
- `officialNoticeDetections[]` latches the first qualifying scan and first plan per model and evidence ID. Repeated targets or ticks reuse those anchors. An actionable scan without a plan still starts the clock.
- `publicationToPlanMs` measures `firstPlanCreatedAt - sourcePublishedAt` for provenance. It is null if publication is unknown and is excluded from Criterion 3. Qualifying latches use the stable claim identity. Within a continuous actionable chain (no verified non-actionable gap after the anchor), follow-up notices update provenance (`evidenceId`, `recordKey`, `sourcePublishedAt`, `publicationToPlanMs`) in place while preserving both `firstQualifyingScanStartedAt` and any existing `firstPlanCreatedAt` / `detectionMs` latch, and append superseded chain identities into additive `previousEvidenceIds` / `previousRecordKeys` so rolled-back receipts from earlier notices in the same continuous episode remain verifiable without false `S9_REMOVAL_DETECTION_INCOMPLETE` failures. A verified non-actionable gap closes the episode (`withdrawnAt` or `supersededAt`); a later reassertion starts a new one. Legacy measurements without a scan anchor are incomplete. Future timestamps, forged lineage keys, or reversed scan-to-plan timestamps fail validation.
- If `modelPendingAt` equals `scanStartedAt` because of clock resolution, the value is advanced to `scanStartedAt + 1` millisecond so the two events remain distinct.

### 2.2 `removalSettleMs` - removal settle time

`removalSettleMs = removedAt - firstObservedAbsentAt`.

- There is **no maximum duration** for this value. A valid removal can take 86,400,000 milliseconds (24 hours) or longer.
- It must never be added to `criteria.detectionLatencyMs.maxMs` or used to score detection-latency criterion 3.
- It is evaluated by a separate policy: `REMOVAL_SETTLE_ABSENCE_MIN_MS = 86_400_000` and `REMOVAL_SETTLE_ABSENCE_MIN_SCANS = 3`.
- Apply receipts record it through `RemovedModelReceiptEvidence.removalSettleMs`, together with `removalPath`, `firstObservedAbsentAt`, `removedAt`, and `qualifyingScanCount`.
- The auto-safe write phase validates removal evidence for the planned targets before applying changes and signs the same timestamped evidence after verified read-back.
- The aggregate report exposes `removalSettle` with `status` (`PASS` / `INCOMPLETE` / `FAIL`), `removalSettleMs`, `removalPaths`, and `noticeOrigin`.

### 2.3 Detection history and pilot windows

Detection history is capped at 500 records across both episode types. On each tick and before inserting an episode, prune only terminal records completed more than 30 days ago. Completion comes from recorded removal, verified target membership after a successful manual apply, recovery, withdrawal, supersession, or abandonment after seven unused days. Keep unresolved anchors regardless of age. At capacity, preserve existing records and block auto-safe writes with `DETECTION_HISTORY_CAP_EXCEEDED`.

`pilot-report` reads the last 30 days by default. `--pilot-started-at <ISO-8601>` can narrow the completion window. Unresolved episodes remain visible regardless of age. An actionable notice without a plan beyond 60 seconds fails Criterion 3. Samples match removals by provider, model, target and evidence or episode. Use a fresh state directory for each pilot. A future timestamp or a history overflow fails the report.

### 2.4 Standalone harness apply

Auto-safe `apps apply --write` reads only the state directory’s tick catalog. It requires scoped C48 evidence, provider verifiability and three qualifying absence scans over 24 hours or verified effective official evidence. The absence path rejects models corroborated by L2. Auto-safe checks the 10% shrink cap using the minimum current membership proved by preview, and requires a verified live replacement for a protected default slot.

Manual propose displays each removal and requires an interactive TTY and `chay` (a declined confirmation returns cleanly with zero writes and zero receipts). It rejects synthetic evidence, unverifiable provider scans, L2-corroborated absence, withdrawn or future-effective official notices, and absence-only evidence below three scans. On an interactive TTY, it explicitly warns (`C48_TTY_OVERRIDE`) before a human-confirmed timing override for an absence shorter than 24 hours, a legacy Format C catalog entry lacking `firstAbsentAt`, or an explicit `--catalog` file. Such manual overrides remain distinct from canonical C48 proof required by `auto-safe` and S9 sign-off, keeping settlement incomplete when timing proof is absent.

Both live paths pin the rechecked plan hash, exclude grace-absent models (`absenceCounts > 0`) from live additions and live default-slot replacements via shared `resolveCatalogPresence` semantics while allowing verified official deprecation removals during grace cycles, resolve nested default-slot provider overrides (`<provider>/<vendor>/<model>`) while keeping vendor-namespaced models under multi-segment aggregators (`openrouter`, `together`, `fireworks`, `groq`, etc.) and strict provider-scoped slots (such as `decider.openrouterModel`) scoped to their owning provider without cross-provider false positives, and filter catalog candidates by consent level so ineligible siblings never poison valid additions or removals. After verified success, they sign per-model removal evidence and close a shared episode only when `apply-history.json` is both present and valid and every affected target (modulo configured router `id`/`adapter` combo aliases) is either covered by an active non-rolled-back removal receipt for that exact `provider/model/episode` or fail-closed verified live to no longer contain that model; a byte-exact verified `rollback` or `apps rollback` reopens the restored target's episode (and `pendingEpisodes` for absent models) without altering original detection timestamps, whereas unverified rollbacks leave closed episodes untouched. Sandbox-copy keeps its catalog formats and writes no C48 state.

## 3. Unobservable window

`providerToFirstScanMs`, the interval from the provider's actual removal until RouterSync's first scan, cannot be observed from the client. The field therefore remains `null` and is accompanied by `unobservableWindow: 'provider-to-first-scan'`. It must not be inferred, estimated, or replaced with another value.

Observed scan cadence is reported separately as `observedScanIntervalMs` (`sampleCount`, `minMs`, `maxMs`, `lastMs`) so readers can assess time resolution without mixing it into detection latency.

## 4. Preserved invariants

C48 does not relax any existing safeguard:

| Invariant | Required value |
|---|---|
| Detection-latency ceiling | `<= 60,000` ms |
| Maximum shrink ratio per cycle | `<= 10%` (`TARGET_REMOVAL_MAX_SHRINK_RATIO = 0.10`) |
| Minimum absence wait | `>= 24 hours` from the first absence observation |
| Minimum qualifying scans | `>= 3`, including two consecutive cycles |
| Absence-only path | Both the 24-hour wait and three qualifying scans are mandatory |
| `VACUOUS` / `INCOMPLETE` | `--accept-vacuous-detection` applies only to Criterion 3. Sign-off still requires measured detection when a removal occurred and independent settlement evidence. |
| Official notices for a live pilot | Only genuine first-party notices qualify; `synthetic` evidence is excluded from live evidence |

The absence wait respects the 15-minute tick gate and provider backoff. The first qualifying scan records the absence. Removal requires at least three qualifying absence scans in total, with the final scan at least 24 hours after the first.

## 5. Consequences

### Benefits

- The S9 report measures actual detection performance without contamination from the safety wait.
- The report can demonstrate that the 24-hour and three-scan safeguards were observed instead of relying on an assertion.
- Detection latency, removal settle time, and the unobservable provider-to-first-scan window remain separate measurements.

### Limitations

- Legacy receipts containing only `{ provider, modelId, inProviderCatalog }` remain readable because all new fields are optional.
- The report rejects legacy-style `ABSENT_STABLE` plans that omit `detectionKind: 'absence-settled'` or `episodeId`, or that provide a non-null `detectionLatencyMs`, because those plans do not contain unambiguous evidence.
- `providerToFirstScanMs` remains `null`; exact measurement requires provider-side telemetry.

## 6. Rejected alternatives

1. **Add `removalSettleMs` to `detectionLatencyMs`:** rejected because it turns a required safety interval into a detection-latency violation.
2. **Set a maximum duration for `removalSettleMs`:** rejected because valid wait time depends on tick scheduling and provider backoff rather than a fixed constant.
3. **Estimate `providerToFirstScanMs` from the average scan interval:** rejected because it creates a fabricated metric that appears to be evidence.
4. **Allow `synthetic` notices as live evidence:** rejected because the live pilot requires genuine first-party notices.

## 7. Verification

The focused contract in `packages/cli/test/c48-h1-h2-latency-settle.test.ts` contains 38 tests covering H1, CTO timing, retention, Strike-3, QA-FINAL, AC6, and QA-V2 (`Probe6` multi-target settlement and `Probe3c` continuous official-notice rollback/update lineage) regressions, and the five required H2 scenarios:

1. A valid absence removal on the third qualifying absence scan after 48 hours produces `PASS`, detection `<= 60,000` ms, settle time approximately 172,800,000 ms, exactly one removal, no false removal, verified router rows, and restored harness SHA.
2. Early-removal evidence in a synthetic fixture produces `FAIL`.
3. An isolated rehearsal exercises the synthetic official-notice removal path. Live sign-off excludes the detection sample and fails the settlement policy.
4. Stable `VACUOUS` / `INCOMPLETE` semantics remain unchanged.
5. A forced scan latency above 60,000 ms produces `FAIL`.

Sixteen targeted mutations across `write-adapter.ts`, `apps.ts`, `tick.ts`, `pilot-report.ts`, and `rollback.ts` must trip their focused assertions, with byte-exact restoration after each. The final verification record must also include `vitest related --run`, the focused regression suites, typecheck, lint, workflow validation, and build.

## 8. Rollback

The change is limited to runtime files `packages/cli/src/commands/tick.ts`, `packages/cli/src/commands/pilot-report.ts`, `packages/cli/src/commands/apps.ts`, `packages/cli/src/commands/rollback.ts`, `packages/cli/src/apps/write-adapter.ts`, `packages/cli/src/index.ts`, `packages/core/src/consent/types.ts`, `packages/core/src/consent/apply-history.ts`, and `packages/core/src/research/ledger.ts`; test suites `packages/cli/test/c48-h1-h2-latency-settle.test.ts`, `packages/cli/test/c45-wp2-harness-write.test.ts`, `packages/cli/test/c46-f6-pilot-report.test.ts`, `packages/cli/test/wp3-research-loop.test.ts`, and `packages/cli/test/wp4-controlled-automation.test.ts`; and documentation `docs/adr/ADR-S9-LATENCY-01.md` and `docs/runbook/OWNER-CHECKLIST.md`. Reverting the C48 commit restores the prior behavior. Existing receipts remain valid because the new fields are optional. No data migration, dependency change, package publication, or tag is required.
