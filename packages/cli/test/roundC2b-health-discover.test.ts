import { describe, it, expect } from 'vitest';
import {
  headRowLabel,
  headEvidenceString,
  comboHeadWarning,
  noLogsLabel,
  isSharedConnectionError,
} from '../src/commands/health.js';
import { groupDiscoverCandidates, isChatModel } from '../src/commands/discover.js';

describe('C2b A8 HEAD-HEALTH labels', () => {
  it('noLogsLabel is UNKNOWN, never NO-LOGS', () => {
    expect(noLogsLabel()).toBe('UNKNOWN');
  });

  it('shared 404 => CONNECTION-ERROR', () => {
    const label = headRowLabel('ag/model-a', { errorCode: 404 }, undefined, 3);
    expect(label).toMatch(/CONNECTION-ERROR/);
    expect(
      isSharedConnectionError([
        { model: 'a', errorCode: 404, lastErrorAt: '2026-11-04T00:00:00Z' },
        { model: 'b', errorCode: 404, lastErrorAt: '2026-11-04T00:00:00Z' },
      ])
    ).toBe(true);
  });

  it('live successes => LIVE-SUCCESS(n, lần cuối)', () => {
    const label = headRowLabel('crouton-alpha/x', undefined, {
      lastSuccess: '2026-11-04T10:00:00Z',
      success: 4,
    });
    expect(label).toContain('LIVE-SUCCESS (4, lần cuối 2026-11-04T10:00:00Z)');
  });

  it('no data => UNKNOWN', () => {
    expect(headRowLabel('x/y', undefined, undefined)).toBe('UNKNOWN');
  });

  it('evidence states status/time/source table', () => {
    expect(headEvidenceString(undefined, { errorCode: 429, lastErrorAt: 't' })).toContain(
      'source=providerConnections.data'
    );
    expect(headEvidenceString({ flag: 'OK', lastSuccess: 't2' }, undefined)).toContain(
      'source=own-log'
    );
    expect(headEvidenceString(undefined, undefined)).toMatch(/UNKNOWN/);
  });

  it('combo-head warning: null when healthy, non-null on quota/unknown', () => {
    expect(comboHeadWarning('c', ['LIVE-SUCCESS (2, lần cuối t)'])).toBeNull();
    expect(comboHeadWarning('c', ['QUOTA', 'UNKNOWN'])).toContain('WARNING combo c');
  });
});

describe('C2b B6 discover grouping', () => {
  it('canonical <=5/group, non-chat excluded', () => {
    const cands = [
      ...Array.from({ length: 7 }, (_, i) => ({ providerId: 'p', modelId: `m-${i}` })),
      { providerId: 'p', modelId: 'embed-model' },
      { providerId: 'p', modelId: 'speech-tts' },
    ];
    const groups = groupDiscoverCandidates(cands);
    for (const arr of groups.values()) {
      expect(arr.length).toBeLessThanOrEqual(5);
      for (const c of arr) expect(isChatModel(c.modelId)).toBe(true);
    }
  });

  it('isChatModel filters non-chat', () => {
    expect(isChatModel('gpt-4')).toBe(true);
    expect(isChatModel('text-embedding-ada')).toBe(false);
    expect(isChatModel('whisper-1')).toBe(false);
  });
});
