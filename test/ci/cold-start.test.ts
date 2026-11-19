import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { parseArgs } = require('../../tools/ci/cold-start.mjs');

describe('C17 T5: cold-start measurement contract', () => {
  it('publishes phase increments only from cumulative milestones in one process', () => {
    const source = fs.readFileSync('tools/ci/cold-start.mjs', 'utf8');

    expect(source).not.toContain('phaseDeltas');
    expect(source).not.toContain('cliDispatchDeltaMs');
    expect(source).not.toContain('verifyExecutionDeltaMs');
    expect(source).toContain('cumulativePhases');
    expect(source).toContain('same fresh process');
  });
  it('requires at least ten samples per batch', () => {
    expect(() => parseArgs(['--samples-per-batch', '9'])).toThrow(/integer >= 10/);
    expect(parseArgs(['--samples-per-batch', '10']).samplesPerBatch).toBe(10);
  });

  it('cannot shorten the three-minute gap between batches', () => {
    expect(() => parseArgs(['--rest-ms', '0'])).toThrow(/at least 180000/);
    expect(() => parseArgs(['--rest-ms', '179999'])).toThrow(/at least 180000/);
    expect(parseArgs(['--rest-ms', '180000']).restMs).toBe(180000);
  });
});
