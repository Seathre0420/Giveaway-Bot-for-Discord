import ms from 'ms';

export function parseDuration(input) {
  if (!input) return null;
  let total = 0;
  const parts = String(input).split(/\s+/);
  for (const p of parts) {
    const n = ms(p);
    if (typeof n === 'number') total += n;
    else if (/^\d+$/.test(p)) total += Number(p) * 60 * 1000; // minutes
  }
  return total > 0 ? total : null;
}

export function maskKey(key) {
  if (!key) return '';
  if (key.length <= 6) return '***';
  return key.slice(0, 3) + '***' + key.slice(-3);
}
