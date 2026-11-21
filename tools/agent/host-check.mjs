#!/usr/bin/env node
// host-check.mjs - phép kiểm host mức tóm tắt cho bảng official-status.
//
// Chỉ in tóm tắt (id -> trạng thái HTTP, số lượng phần tử), KHÔNG in danh
// mục đầy đủ: bản C29 đổ cả catalog vào đầu ra (4,7 MB) là thừa và nặng.
//
// Dùng qua capture.mjs để bản ghi có sha256 và danh sách tên riêng được nạp:
//   node tools/agent/capture.mjs host-check -- node tools/agent/host-check.mjs
//
// Không đọc/ghi DB router, không in khóa, không in tên cổng riêng.

const HF_CHECK_IDS = [
  'openai/gpt-4o',
  'CohereLabs/c4ai-command-a-03-2025',
  'CohereLabs/command-r-08-2024',
  'CohereLabs/c4ai-command-r7b-12-2024',
  'CohereLabs/aya-expanse-32b',
];
const NVIDIA_MODELS_DEV = 'https://models.dev/api.json';

async function get(url, timeoutMs = 15000) {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { url, status: res.status, ok: res.ok, ms: Date.now() - started, json };
  } catch (err) {
    return { url, status: null, ok: false, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}

// HF từ chối slash đã url-encode (%2F); mã hoá từng đoạn đường dẫn.
const encodeModelId = (id) => id.split('/').map((s) => encodeURIComponent(s)).join('/');

async function main() {
  const hfRoot = await get('https://huggingface.co/api/models?limit=1000');
  const hfRootIds = Array.isArray(hfRoot.json) ? hfRoot.json.map((m) => m?.id).filter(Boolean) : [];

  const hfPerId = {};
  for (const id of HF_CHECK_IDS) {
    const r = await get(`https://huggingface.co/api/models/${encodeModelId(id)}`, 10000);
    hfPerId[id] = { status: r.status, ok: r.ok, ms: r.ms };
  }

  // models.dev có thể trả models dạng mảng (cũ) hoặc object theo id (mới).
  const modelsDev = await get(NVIDIA_MODELS_DEV, 15000);
  const nvRaw = modelsDev.json?.nvidia?.models;
  const nvList = Array.isArray(nvRaw) ? nvRaw : Object.entries(nvRaw ?? {}).map(([id, m]) => ({ ...(m ?? {}), id: m?.id ?? id }));
  const nvIds = nvList.map((m) => m?.id).filter(Boolean);

  const openrouterRoot = await get('https://openrouter.ai/api/v1/models', 15000);
  const orCount = Array.isArray(openrouterRoot.json?.data) ? openrouterRoot.json.data.length : Array.isArray(openrouterRoot.json) ? openrouterRoot.json.length : 0;

  const out = {
    checkedAt: new Date().toISOString(),
    hf: {
      root: { status: hfRoot.status, ok: hfRoot.ok, ids: hfRootIds.length, truncated: hfRootIds.length >= 1000 },
      perId: hfPerId,
    },
    modelsDev: {
      status: modelsDev.status,
      ok: modelsDev.ok,
      nvidiaModels: nvIds.length,
      commandAIndex: nvIds.indexOf('CohereLabs/c4ai-command-a-03-2025'),
    },
    openrouter: { status: openrouterRoot.status, ok: openrouterRoot.ok, ids: orCount },
  };
  console.log(JSON.stringify(out, null, 2));
}

await main();