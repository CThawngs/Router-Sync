/**
 * packages/cli/src/sync/step-exists.ts
 * C3k K2c: a step may only claim EXISTS-IN-SCAN from a valid (HTTP 200) scan
 * conclusion of the same router|provider pair. A pair whose conclusion is
 * UNSUPPORTED / QUOTA / UNKNOWN-NO-SIGNAL / NOT-SCANNED yields NOT-SCANNED or
 * STALE-SCAN, never EXISTS-IN-SCAN / ABSENT-UNCONFIRMED. The bzl case:
 * 9router|bzl had HTTP 0 yet health showed EXISTS-IN-SCAN -- that was a
 * stale catalog file from an older scan, not a live conclusion.
 */
export function stepExistsLabel(
  status: number | undefined,
  set: ReadonlySet<string> | null,
  step: string,
  model: string,
  opts?: { conclusion?: string | undefined } | undefined
): 'NOT-SCANNED' | 'STALE-SCAN' | 'QUOTA-NO-LIST' | 'EXISTS-IN-SCAN' | 'ABSENT-UNCONFIRMED' | 'UNSTABLE' {
  if (!set) return 'NOT-SCANNED';
  if (opts?.conclusion === 'UNSTABLE') return 'UNSTABLE';
  // C3s S4d: catalog bị 429 (QUOTA) không có danh sách id -> QUOTA-NO-LIST,
  // không gọi là STALE-SCAN.
  if (status === 429) return 'QUOTA-NO-LIST';
  // C3m M1: catalog có nhưng conclusion lỗi mạng/chưa quét = STALE-SCAN, không kết luận vắng/có.
  if (status !== 200) return 'STALE-SCAN';
  // L1(a): namespace models/ is notation, not identity. Only strip models/.
  // Variant suffixes (-free, :free, -sale, -preview) never stripped here.
  const bare = model.replace(/^models\//, '');
  const normSet = new Set([...set].map((s) => s.replace(/^models\//, '')));
  return set.has(step) || set.has(model) || normSet.has(step.replace(/^models\//, '')) || normSet.has(bare) ? 'EXISTS-IN-SCAN' : 'ABSENT-UNCONFIRMED';
}
