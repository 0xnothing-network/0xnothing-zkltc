const UINT256_MAX = (1n << 256n) - 1n;
const SCALE = 10n ** 18n;

export function parseDoge(value) {
  if (typeof value !== 'string' || value.length > 128 || !/^(?:\d+(?:\.\d{0,18})?|\.\d{1,18})$/.test(value.trim())) {
    throw new Error('Enter a decimal DOGE amount with at most 18 decimal places.');
  }
  const [whole, fraction = ''] = value.trim().split('.');
  const amount = BigInt(whole || '0') * SCALE + BigInt(fraction.padEnd(18, '0'));
  if (amount <= 0n || amount > UINT256_MAX) throw new Error('Enter a positive DOGE amount within the supported range.');
  return amount;
}

/** Format native currency without losing wei or rounding small values to zero. */
export function formatDoge(value) {
  const amount = BigInt(value);
  const absolute = amount < 0n ? -amount : amount;
  const whole = (absolute / SCALE).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (absolute % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return (amount < 0n ? '-' : '') + whole + (fraction ? '.' + fraction : '');
}
