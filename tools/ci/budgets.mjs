#!/usr/bin/env node
// Shared budget derivation for CI measurements.
// Formula: max(ceil(1.25 * median), ceil(1.1 * maxObserved), floor).

export const DEFAULT_FLOORS = Object.freeze({ ms: 1000, mb: 40 });

export function median(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('median requires at least one number');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

export function deriveBudget(samples, floors = DEFAULT_FLOORS) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error('budget derivation requires at least one sample');
  }

  const durations = samples.map((sample) => sample.ms);
  const memory = samples.map((sample) => sample.mb);
  const medianMs = median(durations);
  const medianRssMB = median(memory);
  const maxObservedMs = Math.max(...durations);
  const maxObservedRssMB = Math.max(...memory);

  return {
    samples: samples.length,
    medianMs,
    maxObservedMs,
    budgetMs: Math.max(Math.ceil(1.25 * medianMs), Math.ceil(1.1 * maxObservedMs), floors.ms),
    medianRssMB,
    maxObservedRssMB,
    budgetRssMB: Math.max(Math.ceil(1.25 * medianRssMB), Math.ceil(1.1 * maxObservedRssMB), floors.mb),
  };
}

export function summarizeSamplesByRunner(samples) {
  const groups = new Map();
  for (const sample of samples) {
    const key = `${sample.runner}/${sample.arch}`;
    const group = groups.get(key) ?? {
      runner: sample.runner,
      arch: sample.arch,
      count: 0,
    };
    group.count += 1;
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) =>
    `${left.runner}/${left.arch}`.localeCompare(`${right.runner}/${right.arch}`),
  );
}
