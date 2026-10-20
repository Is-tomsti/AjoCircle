export function positiveAmount(value, field) {
  const normalized = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof normalized !== 'string' || !/^[1-9][0-9]*$/.test(normalized)) throw new Error(`${field} must be a positive integer base-unit value`);
  return normalized;
}
