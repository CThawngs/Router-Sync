/**
 * packages/cli/src/commands/research.ts
 * W3 + C45-WP8 research: deterministic allowlisted sources, read-only weekly session
 * budget in `queue`, and 5-session weekly cap + byte/char session ledger in `submit`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  OutboundGuardError,
  ResearchValidationError,
  appendResearchEvidence,
  assertAllowedOutboundUrl,
  assertWeeklyResearchSessionAllowed,
  atomicWriteFileSync,
  computeWeeklyResearchBudget,
  createGuardedFetch,
  loadResearchQueue,
  mapConclusionToVerdict,
  recordResearchSessionActivity,
  sanitizeUntrustedString,
} from '@routersync/core';
import { loadConfigFile } from '../config/loader.js';

export interface ResearchOptions {
  subcommand?: 'run' | 'status' | 'evidence' | 'queue' | 'submit' | 'price-confirm' | undefined;
  once?: boolean | undefined;
  model?: string | undefined;
  file?: string | undefined;
  out?: string | undefined;
  json?: boolean | undefined;
  stateDir?: string | undefined;
  configPath?: string | undefined;
  sessionId?: string | undefined;
  nowMs?: number | undefined;
  fetchFn?: typeof globalThis.fetch | undefined;
}

function resolveMaxWeeklySessionsFromConfig(configPath?: string): number | undefined {
  try {
    const { config } = loadConfigFile(configPath);
    return config.research?.maxWeeklyResearchSessions;
  } catch {
    return undefined;
  }
}

function readSources(): Array<{ id: string; url: string; loai: string; reliability: number }> {
  const p = path.join(process.cwd(), 'registry', 'sources.yaml');
  if (!fs.existsSync(p)) return [];
  const text = fs.readFileSync(p, 'utf8');
  const out: Array<{ id: string; url: string; loai: string; reliability: number }> = [];
  let cur: Record<string, string> | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s+-\s+id:\s*(.+)$/);
    if (m) {
      if (cur) {
        out.push({
          id: cur['id'] ?? '',
          url: cur['url'] ?? '',
          loai: cur['loai'] ?? '',
          reliability: Number(cur['reliability'] ?? '0') || 0,
        });
      }
      cur = { id: m[1]!.trim() };
      continue;
    }
    if (cur) {
      const k = line.match(/^\s+(url|loai|reliability):\s*(.*)$/);
      if (k) cur[k[1]!] = k[2]!.trim();
    }
  }
  if (cur) {
    out.push({
      id: cur['id'] ?? '',
      url: cur['url'] ?? '',
      loai: cur['loai'] ?? '',
      reliability: Number(cur['reliability'] ?? '0') || 0,
    });
  }
  return out.filter((s) => s.id && s.url);
}

export function priceOf(_id: string, job: unknown): number | null {
  if (!job || typeof job !== 'object') return null;
  const o = job as Record<string, unknown>;
  const p = o['pricing'] as Record<string, unknown> | undefined;
  if (p) {
    const n = Number(p['prompt'] ?? 0) + Number(p['completion'] ?? 0);
    return Number.isFinite(n) ? n : null;
  }
  const cost = o['input_cost_per_token'] ?? o['cost_per_token'];
  return cost != null ? Number(cost) : null;
}

/** D8: phân tích bản ghi cho từng nguồn (không chỉ băm). */
export function countRecords(id: string, text: string): number {
  try {
    const j = JSON.parse(text) as unknown;
    if (id === 'openrouter-models') {
      return Array.isArray((j as { data?: unknown[] }).data) ? (j as { data?: unknown[] }).data!.length : 0;
    }
    if (id === 'models-dev') return countInnerModels(j);
    if (id === 'litellm-prices') return Object.keys(j as Record<string, unknown>).length;
    if (id === 'hf-hub') return Array.isArray(j) ? j.length : 0;
    if (id === 'openrouter-changelog') return (text.match(/<h[123][^>]*>/gi) ?? []).length;
    return 0;
  } catch {
    return 0;
  }
}

/** Một định nghĩa duy nhất cho số bản ghi models-dev: tổng số model trong mọi provider. */
export function countInnerModels(j: unknown): number {
  if (!j || typeof j !== 'object') return 0;
  let total = 0;
  let sawNested = false;
  for (const info of Object.values(j as Record<string, unknown>)) {
    const models = (info as Record<string, unknown>)?.['models'];
    if (models && typeof models === 'object') {
      total += Object.keys(models as Record<string, unknown>).length;
      sawNested = true;
    }
  }
  return sawNested ? total : Object.keys(j as Record<string, unknown>).length;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export async function runResearchCommand(options: ResearchOptions): Promise<void> {
  const guardedFetch = createGuardedFetch(options.fetchFn ?? globalThis.fetch);

  if (!options.subcommand || options.subcommand === 'run') {
    const sources = readSources();
    const lines: string[] = [];
    lines.push('ROUTERSYNC RESEARCH (tất định, LLM/paid-search: NOT RUN)');
    lines.push('Generated: ' + new Date(options.nowMs ?? Date.now()).toISOString());
    lines.push(`nguồn: ${sources.length}`);
    const samples: string[] = [];
    for (const s of sources) {
      assertAllowedOutboundUrl(s.url);
      const t0 = Date.now();
      try {
        const res = await guardedFetch(s.url, {
          headers: { 'User-Agent': 'routersync-research/0.1' },
          signal: AbortSignal.timeout(20_000),
        });
        const buf = Buffer.from(await res.arrayBuffer());
        const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
        let records = 0;
        const text = buf.toString('utf8');
        records = countRecords(s.id, text);
        if (s.id === 'openrouter-changelog') {
          const titles = [...text.matchAll(/<h[123][^>]*>([^<]{5,90})<\/h[123]>/gi)]
            .slice(0, 3)
            .map((m) => decodeEntities(m[1]!.trim()));
          const datePublished =
            text.match(/datePublished["'\s:]+([\dT:.-]{8,30})/)?.[1] ??
            text.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ??
            'unknown';
          records = titles.length;
          if (titles.length) {
            lines.push(`  changelog ${s.id}: ${titles.length} tiêu đề, mẫu: ${titles.join(' | ')} @ ${datePublished}`);
          }
        }
        if (s.id === 'gemini-status') {
          lines.push(`  gemini-status: status=${res.status} bytes=${buf.length} records=0 (trang trạng thái, không phải catalog)`);
        }
        lines.push(
          `${s.id} | ${s.url} | loại=${s.loai} | reliability=${s.reliability} | status=${res.status} | records=${records} | bytes=${buf.length} | hash=${hash} | ms=${Date.now() - t0}`
        );
        if (samples.length < 3 && records > 0) {
          samples.push(`${s.id}: ${records} bản ghi, mẫu hash ${hash}`);
        }
      } catch (e) {
        if (e instanceof OutboundGuardError) throw e;
        const stack = e instanceof Error && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : String(e);
        lines.push(
          `${s.id} | ${s.url} | loại=${s.loai} | reliability=${s.reliability} | status=ERROR | lý do=${e instanceof Error ? e.name : 'fetch-failed'} | chi tiết=${stack} | SKIPPED (log, pipeline không sập)`
        );
      }
    }
    lines.push(
      'ngân sách: chạm ngân sách dừng phần trả phí; phần tất định vẫn chạy; bộ nhớ đệm theo hash + TTL (chưa triển khai daemon cadence trong vòng này)'
    );
    lines.push('bằng chứng mẫu:');
    for (const s of samples) lines.push('  ' + s);
    lines.push('LLM/paid-search: NOT RUN (tắt mặc định)');
    if (samples.length === 0) {
      lines.push('  (không có evidence mẫu — nguồn đều lỗi hoặc không trả records)');
    }
    const text = lines.join('\n') + '\n';
    if (options.out) fs.writeFileSync(options.out, text, 'utf8');
    console.log(text);
    return;
  }

  if (options.subcommand === 'price-confirm') {
    const rawTargets = ['oc/pulse-alpha-free', 'ocz/pulse-alpha-free', 'openrouter/stealth/crouton-alpha'];
    const lines: string[] = ['PRICE-CONFIRM (ba nguon doc lap, khong suy doan)'];
    const fetchJson = async (url: string, key?: string): Promise<unknown> => {
      assertAllowedOutboundUrl(url);
      try {
        const res = await guardedFetch(url, {
          headers: { 'User-Agent': 'routersync-research/0.1' },
          signal: AbortSignal.timeout(20_000),
        });
        const j = JSON.parse(await res.text()) as unknown;
        return key ? (j as Record<string, unknown>)[key] : j;
      } catch (err) {
        if (err instanceof OutboundGuardError) throw err;
        return null;
      }
    };
    const orData = await fetchJson('https://openrouter.ai/api/v1/models', 'data');
    const lite = await fetchJson(
      'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
    );
    const md = await fetchJson('https://models.dev/api.json');
    let mdTotal = 0;
    if (md && typeof md === 'object') {
      for (const info of Object.values(md as Record<string, unknown>)) {
        const models = (info as Record<string, unknown>)?.['models'];
        if (models && typeof models === 'object') mdTotal += Object.keys(models as Record<string, unknown>).length;
      }
      lines.push(`models-dev records (dem bang ma, khong dem provider): ${mdTotal}`);
    }
    for (const rawId of rawTargets) {
      const id = rawId.replace(/^(oc|ocz|openrouter)\//, '');
      const isOpenRouter = rawId.startsWith('openrouter/');
      const arr = Array.isArray(orData) ? (orData as Array<Record<string, unknown>>) : [];
      const orRow = isOpenRouter
        ? arr.find((r) => String(r['id'] ?? '') === id || String(r['id'] ?? '') === rawId)
        : undefined;
      const orPrice = orRow ? priceOf('openrouter-models', orRow) : null;
      const liteKey = id;
      const litePrice =
        lite && typeof lite === 'object'
          ? priceOf(
              'litellm-prices',
              (lite as Record<string, unknown>)[rawId] ?? (lite as Record<string, unknown>)[liteKey]
            )
          : null;
      let mdPrice: number | null = null;
      if (md && typeof md === 'object') {
        const op = (md as Record<string, unknown>)['opencode'] as Record<string, unknown> | undefined;
        const opModels = op?.['models'] as Record<string, unknown> | undefined;
        if (opModels && opModels[liteKey] != null) mdPrice = priceOf('models-dev', opModels[liteKey]);
        if (mdPrice == null) {
          for (const [, info] of Object.entries(md as Record<string, unknown>)) {
            const models = (info as Record<string, unknown>)?.['models'] as Record<string, unknown> | undefined;
            if (models && models[liteKey] != null) {
              mdPrice = priceOf('models-dev', models[liteKey]);
              break;
            }
          }
        }
      }
      const prices = [orPrice, litePrice, mdPrice].filter((p): p is number => p != null);
      const label =
        prices.length === 0
          ? 'NO-SOURCE'
          : prices.length === 1
            ? 'SINGLE-SOURCE'
            : prices.every((p) => p === 0)
              ? 'CONFIRMED-FREE'
              : 'CONFLICT';
      lines.push(
        `raw=${rawId} -> chuan hoa=${liteKey} | openrouter=${orPrice ?? 'n/a'} | litellm=${litePrice ?? 'n/a'} | models-dev=${mdPrice ?? 'n/a'} | ${label}`
      );
    }
    const text = lines.join('\n') + '\n';
    if (options.out) fs.writeFileSync(options.out, text, 'utf8');
    console.log(text);
    return;
  }

  if (options.subcommand === 'status') {
    console.log('research status: hàng đợi xem bằng `research queue`; LLM/paid-search: NOT RUN');
    return;
  }

  if (options.subcommand === 'queue') {
    const sDir = options.stateDir ?? (process.env['ROUTERSYNC_STATE_DIR'] || path.join(process.cwd(), '.routersync'));
    const maxCap = resolveMaxWeeklySessionsFromConfig(options.configPath);
    const weeklyBudget = computeWeeklyResearchBudget(sDir, {
      nowMs: options.nowMs,
      maxWeeklyResearchSessions: maxCap,
    });
    const queueFile = loadResearchQueue(sDir);
    const allItems = queueFile?.items ?? [];

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            items: weeklyBudget.budgetExceeded ? [] : allItems,
            totalPending: allItems.length,
            weeklyBudget,
            ...(weeklyBudget.budgetExceeded ? { skipReason: 'WEEKLY_RESEARCH_CAP_EXCEEDED' } : {}),
          },
          null,
          2
        )
      );
      return;
    }

    const budgetSuffix = weeklyBudget.budgetExceeded
      ? ` [SKIPPED: WEEKLY_RESEARCH_CAP_EXCEEDED (${weeklyBudget.usedSessions}/${weeklyBudget.maxWeeklyResearchSessions} sessions in ${weeklyBudget.isoWeek})]`
      : ` [weeklyBudget=${weeklyBudget.usedSessions}/${weeklyBudget.maxWeeklyResearchSessions} in ${weeklyBudget.isoWeek}]`;
    console.log(
      `research queue: model mới | chưa có giá | sắp deprecate | giá 0 — dữ liệu từ scan DIFF (xem DIFF.txt)${budgetSuffix}`
    );
    return;
  }

  if (options.subcommand === 'evidence') {
    console.log(
      `research evidence ${options.model ?? '(không có model)'}: nguồn xem RESEARCH-RUN.txt; kết luận 1 nguồn = ước lượng, ≥2 nguồn độc lập mới mạnh`
    );
    return;
  }

  if (options.subcommand === 'submit') {
    if (!options.file) {
      console.log(
        'research submit <file>: nhận JSON theo schema { id, conclusion|kết luận, url, snippet|trích đoạn <= 300, accessedAt|ngày truy cập }; lưu như bằng chứng không tin cậy, không ghi router'
      );
      return;
    }
    const filePath = path.resolve(process.cwd(), options.file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    const rawFileStr = fs.readFileSync(filePath, 'utf8');
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawFileStr) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`Invalid JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const id = String(parsed['id'] ?? '').trim();
    const provider = typeof parsed['provider'] === 'string' ? parsed['provider'].trim() : undefined;
    const modelId = typeof parsed['modelId'] === 'string' ? parsed['modelId'].trim() : undefined;
    const conclusion = String(parsed['conclusion'] ?? parsed['kết luận'] ?? '').trim();
    const url = String(parsed['url'] ?? '').trim();
    const rawSnippet = String(parsed['quote'] ?? parsed['snippet'] ?? parsed['trích đoạn'] ?? '').trim();
    const accessedAt = String(
      parsed['accessedAt'] ?? parsed['ngày truy cập'] ?? new Date(options.nowMs ?? Date.now()).toISOString().slice(0, 10)
    ).trim();
    const publishedAt = typeof parsed['publishedAt'] === 'string' ? parsed['publishedAt'].trim() : undefined;
    const shutdownDate = typeof parsed['shutdownDate'] === 'string' ? parsed['shutdownDate'].trim() : undefined;
    const replacementModelId =
      typeof parsed['replacementModelId'] === 'string' ? parsed['replacementModelId'].trim() : undefined;
    const claimedSourceTier =
      parsed['claimedSourceTier'] === 'official' || parsed['claimedSourceTier'] === 'secondary'
        ? parsed['claimedSourceTier']
        : undefined;
    const sessionId =
      options.sessionId ??
      (typeof parsed['sessionId'] === 'string' && parsed['sessionId'].trim().length > 0
        ? parsed['sessionId'].trim()
        : undefined);

    if (!id && (!provider || !modelId)) {
      throw new Error('Schema validation error: missing or empty "id" field');
    }
    if (!conclusion && typeof parsed['verdict'] !== 'string') {
      throw new Error('Schema validation error: missing or empty "conclusion" field');
    }
    if (!url) {
      throw new Error('Schema validation error: "url" must be a valid https URL');
    }

    const sDir = options.stateDir ?? (process.env['ROUTERSYNC_STATE_DIR'] || path.join(process.cwd(), '.routersync'));
    const maxCap = resolveMaxWeeklySessionsFromConfig(options.configPath);

    // C45-WP8: Gate weekly research session budget BEFORE writing any evidence (kills M6)
    const sessionGate = assertWeeklyResearchSessionAllowed(sDir, {
      sessionId,
      nowMs: options.nowMs,
      maxWeeklyResearchSessions: maxCap,
    });

    let record;
    try {
      record = appendResearchEvidence(sDir, {
        id: id || undefined,
        provider,
        modelId,
        verdict:
          typeof parsed['verdict'] === 'string'
            ? (parsed['verdict'] as never)
            : mapConclusionToVerdict(conclusion),
        conclusion: conclusion || undefined,
        url,
        quote: rawSnippet,
        accessedAt,
        publishedAt,
        shutdownDate,
        replacementModelId,
        claimedSourceTier,
        submittedVia: 'cli',
      });
    } catch (err) {
      if (err instanceof ResearchValidationError) {
        throw new Error(`Schema validation error [${err.code}]: ${err.message}`);
      }
      throw err;
    }

    const nowIso = record.submittedAt;
    const inboxPath = path.join(sDir, 'inbox.json');
    let inboxObj: { updatedAt: string; items: Array<Record<string, unknown>> } = { updatedAt: nowIso, items: [] };
    if (fs.existsSync(inboxPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
        if (raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown[] }).items)) {
          inboxObj = raw as { updatedAt: string; items: Array<Record<string, unknown>> };
        } else if (Array.isArray(raw)) {
          inboxObj = { updatedAt: nowIso, items: raw as Array<Record<string, unknown>> };
        }
      } catch {
        /* start clean */
      }
    }
    const safeIdLabel = sanitizeUntrustedString(record.id, 120);
    const safeConclusion = record.conclusion;
    const safeSnippet = record.snippet;
    inboxObj.items.unshift({
      id: `research-${record.id.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}`,
      title: `[RESEARCH-SUBMIT] ${safeIdLabel}: ${safeConclusion}`,
      type: 'proposal',
      timestamp: nowIso,
      body: `Nghiên cứu web cho model ${safeIdLabel} (nguồn ${record.sourceTier}: ${record.url}): "${safeSnippet}" (ngày truy cập: ${record.accessedAt}).`,
      label: safeConclusion,
      sourceTier: record.sourceTier,
      domainVerified: record.domainVerified,
      proposed_by: { kind: 'user', source: 'research-submit' },
    });
    inboxObj.updatedAt = nowIso;
    atomicWriteFileSync(inboxPath, JSON.stringify(inboxObj, null, 2));

    const outLine = `RESEARCH-SUBMIT id=${record.id} conclusion=${record.conclusion} sourceTier=${record.sourceTier} url=${record.url} snippet_len=${record.snippet.length} sessionId=${sessionGate.sessionId} status=ACCEPTED (untrusted evidence saved, zero router writes)`;

    recordResearchSessionActivity(sDir, {
      sessionId: sessionGate.sessionId,
      source: 'cli',
      nowMs: options.nowMs,
      maxWeeklyResearchSessions: maxCap,
      submittedPayload: rawFileStr,
      returnedPayload: outLine,
      findingsDelta: 1,
    });

    console.log(outLine);
    return;
  }
}
