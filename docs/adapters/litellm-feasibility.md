# LiteLLM Proxy Adapter Feasibility Assessment

> **Status:** `RESEARCH — UNVERIFIED` (Community Roadmap candidate)
> **Date:** 2026-10-28
> **Target System:** LiteLLM Proxy (Python / Uvicorn)
> **Reference:** Spec §5.1, §14, §20, §31.9

---

## 1. Executive Summary

LiteLLM provides an OpenAI-compatible proxy interface across multiple LLMs.
Connecting RouterSync to LiteLLM Proxy as a sync target is feasible via declarative YAML configuration.
Official documentation references:
- Config schema: https://docs.litellm.ai/docs/proxy/configs
- Fallbacks and routing: https://docs.litellm.ai/docs/routing
- Reliability and cooldown: https://docs.litellm.ai/docs/proxy/reliability
- Health and model endpoints: https://docs.litellm.ai/docs/proxy/health

The primary synchronization path is file-based configuration (`config.yaml`), complemented by zero-token HTTP probes.

---

## 2. Configuration Surface & Target Schema

LiteLLM supports configuration via a declarative YAML file. In LiteLLM schema, fallback lists belong to `router_settings` or `litellm_settings`, while `model_list` defines underlying model deployments:

| Layer | Target Format | Key Sections |
|---|---|---|
| Primary Config | `config.yaml` | `model_list`, `router_settings`, `litellm_settings` |
| Deployments | `model_list[].litellm_params` | `model_name`, `litellm_params.model`, `litellm_params.api_key` |
| Combo & Routing | `router_settings` | `routing_strategy: "usage-based-routing"`, `fallbacks: [...]` |

Mapping RouterSync combos to LiteLLM fallbacks in `config.yaml`:
```yaml
model_list:
  - model_name: primary-llama
    litellm_params:
      model: groq/llama-3.3-70b-versatile
      api_key: os.environ/GROQ_API_KEY
  - model_name: fallback-gemini
    litellm_params:
      model: gemini/gemini-2.5-flash
      api_key: os.environ/GEMINI_API_KEY

router_settings:
  routing_strategy: usage-based-routing
  fallbacks:
    - primary-llama: ["fallback-gemini"]
```

---

## 3. Reload & Verification Mechanics

1. **Reload Mechanism:**
   - File modification watching: LiteLLM watches `config.yaml` when started with polling flags (UNVERIFIED without dedicated file watcher process).
   - In-memory reload endpoint `POST /config/reload`: UNVERIFIED in standard OSS distribution without enterprise extensions. Production setups typically require process restart (SIGHUP or container replacement).
2. **Zero-Inference Read-Back:**
   - Endpoint `GET /models` returns active model and alias definitions without inference.
   - Endpoint `GET /health/readiness` verifies proxy availability without dispatching token inference calls.
3. **Snapshot & Rollback:**
   - File-based YAML target allows pre-write file copies (`config.yaml.bak.<timestamp>`).
   - Rollback performs atomic file restore followed by proxy reload.

---

## 4. Invariant Compatibility (I1–I8)

- **I1 (No Missing Targets):** RouterSync validates provider credentials and model tags before generating YAML.
- **I2 (Quarantine Discipline):** Quarantined models are filtered out of the primary `model_name` and `fallbacks` list.
- **I3 (Minimum Steps):** Combos with fewer than `minSteps` preserve previous YAML sections.
- **I6 (Free-Only Discipline):** Metered providers are excluded from free combo fallback arrays.
- **I8 (Write Ordering):** Write order writes provider keys/env references first, then models, then combo fallbacks.

---

## 5. Feasibility Rating & Roadmap Recommendation

- **Implementation Complexity:** Low-to-Medium (~250 lines TypeScript in `@routersync/adapter-litellm`).
- **Dependencies:** Standard library file I/O plus a minimal YAML serializer.
- **Recommendation:**
  - Build `@routersync/adapter-litellm` as an optional sink adapter in Phase 4.
  - Keep tests fixture-driven with mocked `config.yaml` to avoid forcing Python/LiteLLM on local dev machines.
