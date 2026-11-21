#!/usr/bin/env node
/**
 * host-check.mjs — live host reachability checks for the official-status table.
 *
 * Prints a JSON object on stdout; recorded via capture.mjs, which computes the
 * sha256 of the output and masks private provider names from workspace paths.
 *
 *   node tools/agent/host-check.mjs
 *
 * Checks:
 *   - Hugging Face per-id: GET https://huggingface.co/api/models/<id> (status).
 *   - HF root catalog: GET https://huggingface.co/api/models (status, size,
 *     and whether the five checked ids are present).
 *   - models.dev community catalog (NVIDIA steps): GET https://models.dev/api.json
 *     (root status, NVIDIA catalog ids, has the command-a id).
 *   - OpenRouter root list + per-id filter: GET /api/v1/models (status/size).
 *
 * C29 J1/J4: run-time only; no secrets printed.
 */
import { createHash } from 'node:crypto';

const HF_CHECK_IDS = [
  'openai/gpt-4o',
  'CohereLabs/c4ai-command-a-03-2025',
  'CohereLabs/command-r-08-2024',
  'CohereLabs/c4ai-command-r7b-12-2024',
  'CohereLabs/aya-expanse-32b',
];
const OPENROUTER_PER_ID = [
  'openai/gpt-4o',
  'moonshotai/kimi-k2',
  'meta-llama/llama-3.1-8b-instruct',
  'ai21/jamba-mini-1.6-v2',
  'openai/gpt-4.1-nano',
];

async function get(url, timeoutMs = 10000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    const ids = (Array.isArray(json) ? json : json?.ids ?? []).map((m) => (typeof m === 'string' ? m : m?.id));
    return { status: res.status, ok: res.ok, json, size: ids.length, ids };
  } catch (err) {
    return { status: null, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  const hfRoot = await get('https://huggingface.co/api/models?limit=5000');
  const modelsDev = await get('https://models.dev/api.json');
  const openrouterRoot = await get('https://openrouter.ai/api/v1/models');
  const hfPerId = {};
  for (const id of HF_CHECK_IDS) {
    // HF rejects a url-encoded slash (%2F); encode each path segment instead.
    const encodedId = id.split('/').map((s) => encodeURIComponent(s)).join('/');
    hfPerId[id] = await get(`https://huggingface.co/api/models/${encodedId}`, 5000);
  }
  const openrouterPerId = {};
  for (const id of OPENROUTER_PER_ID) openrouterPerId[id] = await get(`https://openrouter.ai/api/v1/models?id=${encodeURIComponent(id)}`);

  // models.dev may ship a provider's models as an object keyed by id (newer
  // schema) or as an array (older). Normalise to a list of ids before use.
  const nvModelsRaw = modelsDev.json?.nvidia?.models;
  const nvModels = Array.isArray(nvModelsRaw)
    ? nvModelsRaw
    : Object.entries(nvModelsRaw ?? {}).map(([id, m]) => ({ ...(m ?? {}), id: m?.id ?? id }));
  const nvIds = nvModels.map((m) => m?.id);

  const out = {
    checkedAt: new Date().toISOString(),
    hfPerId,
    hfRoot: {
      status: hfRoot.status,
      ok: hfRoot.ok,
      size: hfRoot.size,
      hfCatalogIdsPresent: HF_CHECK_IDS.map((id) => ({ id, present: hfRoot.ids?.includes(id) === true })),
    },
    modelsDev: {
      status: modelsDev.status,
      ok: modelsDev.ok,
      size: modelsDev.size,
      nvidiaIds: nvIds,
      commandAIndex: nvIds.indexOf('CohereLabs/c4ai-command-a-03-2025'),
    },
    openrouterRoot: { status: openrouterRoot.status, ok: openrouterRoot.ok, size: openrouterRoot.size },
    openrouterPerId,
  };
  out.sha256 = createHash('sha256').update(JSON.stringify(out), 'utf8').digest('hex');
  console.log(JSON.stringify(out));
}

await main();
