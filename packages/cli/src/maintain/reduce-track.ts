/**
 * packages/cli/src/maintain/reduce-track.ts
 *
 * Pure function reducing tracker state and events into maintain inputs (R1–R11).
 * Strictly pure: No filesystem, no network calls, deterministic, immutable inputs.
 */

export interface TrackEvent {
  type: string;
  provider?: string;
  models?: string[];
  timestamp?: string | number;
  t?: string | number;
  run?: string;
  [key: string]: unknown;
}

export interface ProviderStateItem {
  status?: string;
  lastScanAt?: string;
  models?: string[];
  pendingRemoval?: Record<string, number>;
  [key: string]: unknown;
}

export interface TrackerStateInput {
  providers?: Record<string, ProviderStateItem>;
  run?: number;
  [key: string]: unknown;
}

export interface ReduceTrackInput {
  state?: TrackerStateInput;
  events?: TrackEvent[];
  nowMs?: number;
  sinceMs?: number;
  staleMs?: number;
}

export interface ReducedProviderOutput {
  status: string;
  added: Array<{ id: string }>;
  removed: string[];
}

export interface ReduceTrackOutput {
  providers: Record<string, ReducedProviderOutput>;
  ignoredEvents: number;
}

const VALID_EVENT_TYPES = new Set([
  'model_added',
  'model_removed',
  'baseline',
  'provider_frozen',
  'model_pending',
  'model_recovered',
  'provider_auth_error',
  'provider_unreachable',
]);

const DEFAULT_SINCE_MS = 7 * 24 * 3600 * 1000; // 7 days
const DEFAULT_STALE_MS = 3 * 24 * 3600 * 1000; // 3 days

/**
 * Reduce tracker state and events to computePlan inputs.
 */
export function reduceTrack(input: ReduceTrackInput = {}): ReduceTrackOutput {
  const nowMs = typeof input.nowMs === 'number' ? input.nowMs : Date.now();
  const sinceMs = typeof input.sinceMs === 'number' ? input.sinceMs : DEFAULT_SINCE_MS;
  const staleMs = typeof input.staleMs === 'number' ? input.staleMs : DEFAULT_STALE_MS;

  const rawState = input.state?.providers || {};
  const rawEvents = Array.isArray(input.events) ? input.events : [];

  let ignoredEvents = 0;

  // Track all providers mentioned in state or valid events
  const providerNames = new Set<string>(Object.keys(rawState));

  // Filter valid events and extract timestamp
  interface ValidatedEvent {
    provider: string;
    type: string;
    models: string[];
    timeMs: number;
    originalIndex: number;
  }

  const validEvents: ValidatedEvent[] = [];

  for (let idx = 0; idx < rawEvents.length; idx++) {
    const ev = rawEvents[idx];
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
      ignoredEvents++;
      continue;
    }

    const provider = typeof ev.provider === 'string' ? ev.provider.trim() : '';
    if (!provider) {
      ignoredEvents++;
      continue;
    }

    if (!VALID_EVENT_TYPES.has(ev.type)) {
      ignoredEvents++;
      continue;
    }

    const rawTime = ev.timestamp ?? ev.t;
    if (rawTime === undefined || rawTime === null) {
      ignoredEvents++;
      continue;
    }

    const timeMs = typeof rawTime === 'number' ? rawTime : Date.parse(String(rawTime));
    if (Number.isNaN(timeMs)) {
      ignoredEvents++;
      continue;
    }

    if (ev.type === 'model_added' || ev.type === 'model_removed') {
      if (!Array.isArray(ev.models)) {
        ignoredEvents++;
        continue;
      }
    }

    providerNames.add(provider);

    const validModels = Array.isArray(ev.models)
      ? ev.models.filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
      : [];

    validEvents.push({
      provider,
      type: ev.type,
      models: validModels,
      timeMs,
      originalIndex: idx,
    });
  }

  // Sort events chronologically. For same timeMs, preserve relative input order.
  validEvents.sort((a, b) => {
    if (a.timeMs !== b.timeMs) {
      return a.timeMs - b.timeMs;
    }
    return a.originalIndex - b.originalIndex;
  });

  // Per provider: track latest action on each raw model ID
  const modelStatesByProvider = new Map<string, Map<string, { type: 'model_added' | 'model_removed'; timeMs: number }>>();

  for (const ev of validEvents) {
    if (ev.type !== 'model_added' && ev.type !== 'model_removed') {
      continue;
    }
    let pMap = modelStatesByProvider.get(ev.provider);
    if (!pMap) {
      pMap = new Map();
      modelStatesByProvider.set(ev.provider, pMap);
    }
    for (const rawModel of ev.models) {
      pMap.set(rawModel, { type: ev.type as 'model_added' | 'model_removed', timeMs: ev.timeMs });
    }
  }

  const sortedProviderKeys = Array.from(providerNames).sort((a, b) => a.localeCompare(b));
  const providersOutput: Record<string, ReducedProviderOutput> = {};

  for (const p of sortedProviderKeys) {
    let status = 'unknown';

    if (p in rawState) {
      const stateItem = rawState[p];
      const recordedStatus = stateItem?.status;

      if (recordedStatus && recordedStatus !== 'ok') {
        // Keep error/special status intact (auth_error, unreachable, frozen, skipped)
        status = recordedStatus;
      } else {
        // Check staleness of lastScanAt
        const scanMs = stateItem?.lastScanAt ? Date.parse(stateItem.lastScanAt) : NaN;
        if (Number.isNaN(scanMs) || nowMs - scanMs > staleMs) {
          status = 'stale';
        } else {
          status = 'ok';
        }
      }
    }

    const addedList: Array<{ id: string }> = [];
    const removedList: string[] = [];

    const pModels = modelStatesByProvider.get(p);
    if (pModels) {
      for (const [rawId, mState] of pModels.entries()) {
        const fullId = `${p}/${rawId}`;
        if (mState.type === 'model_added') {
          // Window sinceMs only applies to added
          if (nowMs - mState.timeMs <= sinceMs) {
            addedList.push({ id: fullId });
          }
        } else if (mState.type === 'model_removed') {
          // Removed is kept regardless of time
          removedList.push(fullId);
        }
      }
    }

    addedList.sort((a, b) => a.id.localeCompare(b.id));
    removedList.sort((a, b) => a.localeCompare(b));

    providersOutput[p] = {
      status,
      added: addedList,
      removed: removedList,
    };
  }

  return {
    providers: providersOutput,
    ignoredEvents,
  };
}
