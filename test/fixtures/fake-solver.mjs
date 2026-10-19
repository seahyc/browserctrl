// A captcha solver plugin for tests: "solves" an element marked data-fake-challenge by
// removing it, on sites listed in its options. Shows the plugin interface end to end.
export const name = 'fake';
export const kinds = ['fake-challenge'];
export const detectSource = () => `(document.querySelector('[data-fake-challenge]') ? { kind: 'fake-challenge' } : null)`;
export async function solve(conn, targetId, found, { url, api }) {
  if (process.env.FAKE_SOLVER_OFF) return { attempted: false, reason: 'off' };
  await api.ops.evaluate(conn, targetId, `document.querySelector('[data-fake-challenge]').remove(), true`);
  return { attempted: true, url };
}
export const cli = (args) => ({ args });
