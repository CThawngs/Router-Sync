# `combos stale` — evidence rules (C19)

`routersync combos stale` is read-only. It answers one question: for each step in
a combo, did the router itself show any evidence that the model is available?

## Evidence source

- `direct` (default, `DEFAULT_STALE_SOURCE`): only what the router database
  reports — provider connections, custom models, aliases, disabled flags.
- `snapshot`: the provider registry shipped with RouterSync.
- The report prints `source=<value>` as its first line when the evidence is
  readable, and always carries `source` and `diagnostics.availabilitySource` in
  JSON.

`DEFAULT_AVAILABILITY_SOURCE` (tier classification) stays `snapshot` because
tier parity is defined against the 9Router provider page. Staleness deliberately
does not reuse it: a combo must not be able to validate its own members.

## Statuses

| Status | Meaning |
|---|---|
| `PRESENT` | Exact step found in available models. |
| `PRESENT-NORMALIZED` | Found after dropping a `models/` prefix. |
| `DISABLED` | The router marks the model disabled. |
| `ABSENT` | The provider carried availability evidence, but this model was not in it. |
| `UNVERIFIABLE` | The provider carried no availability evidence at all (e.g. a custom provider with no connection evidence). |

`UNKNOWN` is a report-level status, not a row status: the router database could
not be resolved, opened, or queried. In that case the command exits non-zero,
prints the reason on the first line, and emits no rows.

## Removal rule

Never delete a model because it is `ABSENT` or `UNVERIFIABLE`.

- `ABSENT` says "the router did not list it", not "the upstream provider killed it".
- `UNVERIFIABLE` says "we have no evidence either way".
- Only a model the owner confirms as gone upstream may be removed, and the
  removal decision belongs to the owner, not to this report.

## Known limitations

- **G4** — the 9Router reader only understands the `combos`/`kv`/
  `providerConnections` schema it was written against; a new table or a renamed
  column shows up as `UNVERIFIABLE`, not as a migration error.
- **G5** — OmniRoute has no availability reader yet. It is reported in
  `omittedRouters`, never as `ABSENT` rows.
- **G7** — provider aliases are expanded on read, so a report can contain both
  `google/...` and `gemini/...` spellings of the same step. Counts are per row,
  not per model.
