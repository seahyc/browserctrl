// Exact answer checks for the feature tasks, no model judge.
//   expect: { type: 'number', value, tol }   some number in the answer is within tol of value
//           { type: 'text', value, wrong: [...] }  the answer names value and none of wrong
// Numbers are read with thousands separators and currency signs stripped.
const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
export const numbersIn = (s) => (String(s ?? '').replace(/(\d),(?=\d{3}\b)/g, '$1').match(/-?\d+(?:\.\d+)?/g) || []).map(Number);

export function checkAnswer(task, answer) {
  const e = task.expect;
  if (!e) return null;
  if (e.type === 'number') {
    const nums = numbersIn(answer);
    const hit = nums.find((n) => Math.abs(n - e.value) <= (e.tol ?? 0) + 1e-9);
    return { success: hit !== undefined, expected: e.value, found: nums.slice(0, 12) };
  }
  const a = norm(answer);
  const has = (v) => a.includes(norm(v));
  const named = [e.value, ...(e.aliases || [])].some(has);
  const wrong = (e.wrong || []).filter((w) => has(w) && !norm(e.value).includes(norm(w)));
  return { success: named && !wrong.length, expected: e.value, ...(wrong.length ? { also_named: wrong } : {}) };
}
