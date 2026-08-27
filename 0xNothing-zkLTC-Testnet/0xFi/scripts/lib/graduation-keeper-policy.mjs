export function parseBoundedInteger(value, { name, defaultValue, min, max }) {
  const candidate = String(value ?? "").trim() || String(defaultValue);
  if (!/^[0-9]+$/.test(candidate)) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  const parsed = Number(candidate);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

export function keeperScanFailed(state) {
  return !state?.operational
    || state.statusReadFailures?.length > 0
    || state.graduationFailures?.length > 0;
}
