// The compact outcome stored with a do step's still, independent of its screenshot.
const clip = (value, max = 120) => {
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
};

export function stepResult(row) {
  if (row.stopped || row.stop) {
    let reason = row.stop || row.reason || row.error;
    if (!reason) return undefined;
    if (/no offered line answers/.test(reason)) reason = 'no line clearly answers it';
    if (/Required extraction is missing or uncertain/.test(reason)) {
      const best = reason.match(/candidates:\s*(".*?")\s*\(p=([\d.]+)\)/);
      reason = 'no line clearly answers it' + (best ? ` (best: ${best[1]}, ${Math.round(Number(best[2]) * 100)}%)` : '');
    }
    return clip(reason);
  }
  if (row.answer !== undefined) return clip(row.answer, 240);
  const extracted = row.binding || row.extracted;
  if (extracted?.value == null) return undefined;
  const value = typeof extracted.value === 'string' ? extracted.value : JSON.stringify(extracted.value);
  return clip(value + (extracted.type === 'number' && extracted.raw ? ` from “${extracted.raw}”` : ''), 240);
}

export function stepRecordingOptions(row) {
  const result = stepResult(row);
  const pick = row.how?.match(/jev p=([\d.]+)/);
  return {
    status: row.stopped ? 'FAILED' : row.skipped ? 'SKIPPED' : 'SUCCESS',
    extra: {
      ...(row.step != null ? { doStep: row.step } : {}),
      ...(result !== undefined ? { result } : {}),
      ...(pick && row.target ? { jev: { target: row.target, p: Number(pick[1]) } } : {}),
    },
  };
}
