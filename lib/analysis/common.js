export const DataState = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  MISSING: 'MISSING',
  INSUFFICIENT_SAMPLE: 'INSUFFICIENT_SAMPLE',
  NOT_SUPPORTED: 'NOT_SUPPORTED',
});

export function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function probabilityOrNull(value) {
  const n = finiteOrNull(value);
  if (n === null) return null;
  return Math.min(1, Math.max(0, n));
}
