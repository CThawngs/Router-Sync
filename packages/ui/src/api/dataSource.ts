/**
 * packages/ui/src/api/dataSource.ts
 *
 * R16-2.1: where the numbers on screen come from.
 *
 * The shell (top bar, sidebar, banners) is a SCREEN too, so it must obey the
 * same rule as the rest of the UI: it may only state what the client really
 * knows. The three states are derived from the client, never hard-coded in
 * JSX:
 *
 *  - `sample`      the client is the MockApi, or the payload says `sample`;
 *  - `live`        the daemon answered;
 *  - `unreachable` the daemon could not be reached at all.
 */

export type DataSource = 'sample' | 'live' | 'unreachable';

export function resolveDataSource(
  isMock: boolean,
  payloadSource: 'live' | 'sample' | 'unavailable' | undefined,
  daemonReachable: boolean
): DataSource {
  if (isMock) return 'sample';
  if (payloadSource === 'sample') return 'sample';
  if (!daemonReachable) return 'unreachable';
  return 'live';
}
