// A stand-in for Jev in tests: answers each question by rules the test gives, and records
// what it was asked. A choice rule returns the id of the option to choose (or 'none'); a noul
// rule returns a probability. Without a rule: choice 'none', noul 0.04 (nothing matches,
// nothing is wrong), the answers a page with no surprises gets.
//   const jev = fakeJev({ choice: (q, id) => …, noul: (q, id) => … });
//   runSteps(conn, tab, steps, { jev, noNotes: true })
export function fakeJev({ choice, noul, fail } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (fail) throw new Error(typeof fail === 'string' ? fail : 'Jev is unreachable');
    const body = JSON.parse(init.body);
    calls.push(body);
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      if (q.type === 'noul') answers[id] = { type: 'noul', noul: noul?.(q, id, body.state) ?? 0.04 };
      else {
        const pick = choice?.(q, id, body.state) ?? 'none';
        answers[id] = { type: 'choice', choice: pick, probabilities: { [pick]: 0.9, ...(pick === 'none' ? {} : { none: 0.1 }) }, confidence: 0.9 };
      }
    }
    return { ok: true, status: 200, json: async () => ({ answers, model: 'fake' }) };
  };
  return { cfg: { key: 'fake', model: 'fake' }, fetchImpl, calls };
}

// The id of the option whose text (or its text field) includes `words`.
export function optionWith(q, words) {
  for (const [id, c] of Object.entries(q.criteria || {})) {
    const text = typeof c === 'string' ? c : `${c.text || ''} ${c.name || ''}`;
    if (id !== 'none' && text.includes(words)) return id;
  }
  return 'none';
}
