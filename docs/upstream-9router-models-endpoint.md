# Draft issue for 9Router — `/v1/models` blocks the event loop

**Version:** 9Router 0.5.119 (Windows, Node 24, 16 GB RAM, 9Router pid stable for 11 h).

**Observed**

`GET /v1/models` returns 904 models / ~425 KB but takes ~5–14 s of wall time and
~4–5 s of CPU for **one** call (median over 6 calls, 20 s apart, no other router
traffic: `usageHistory` gained 0 rows). CPU/wall ratio ~0.82 — a single core is
saturated while serialising the list.

With a direct model request (`max_tokens` 8, stream) in flight, latency rises from
p50 **309 ms** (max 326 ms) to p50 **3440 ms** (max 4301 ms) when `/v1/models` is
called one second earlier. A combo request got **no response header within 120 s**
when `/v1/models` was called during its wait.

**Reproduce**

```
node tools/agent/models-probe.mjs      # 6 x GET /v1/models, CPU before/after
node tools/agent/blocking-probe.mjs    # direct model with and without /v1/models
```

Both are read-only against the router and print no keys.

**Question**

Is `/v1/models` serialised on the same event loop as chat completions? If so,
could the model list be cached/streamed or built off the request path?

**Constraints**

No private provider names, keys, paths or credentials are included here.
Numbers come from the C36 evidence package, verified by the standard verifiers.