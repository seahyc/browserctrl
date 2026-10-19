// A stand-in for Jev in tests: answers each question by rules the test gives, and records
// what it was asked. A choice rule returns the id of the option to choose (or 'none'), or
// { choice, p, confidence } to also say how sure Jev is (p is the chosen option's
// probability, the rest share what is left); a noul rule returns a probability. Without a
// rule: choice 'none', noul 0.04 (nothing matches, nothing is wrong), the answers a page
// with no surprises gets.
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
        const rule = choice?.(q, id, body.state) ?? 'none';
        const { choice: pick, p, confidence } = typeof rule === 'string' ? { choice: rule } : rule;
        if (p == null) answers[id] = { type: 'choice', choice: pick, probabilities: { [pick]: 0.9, ...(pick === 'none' ? {} : { none: 0.1 }) }, confidence: 0.9 };
        else {
          const keys = Object.keys(q.criteria);
          answers[id] = { type: 'choice', choice: pick, probabilities: Object.fromEntries(keys.map(k => [k, k === pick ? p : (1 - p) / (keys.length - 1)])), confidence: confidence ?? p };
        }
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

// A choice rule for plans: `targets` maps what a step asks for (the quoted words in the
// question) to [pattern for the option's name, probability]. A question that names none of
// them gets 'none' at 0.9. With near, the pattern also tests each option's `near` context.
export function intents(targets = {}, { near = false } = {}) {
  return (q) => {
    const intent = Object.keys(targets).find(k => q.instructions.includes(`"${k}"`));
    const [re, p] = intent ? targets[intent] : [null, 0.9];
    const text = (c) => `${c.name || ''}${near ? ` ${c.near || ''}` : ''}`;
    const pick = (re && Object.keys(q.criteria).find(k => k !== 'none' && re.test(text(q.criteria[k])))) || 'none';
    return { choice: pick, p };
  };
}

// The blocker question is yes when the page state shows an overlay (blocks: false leaves
// overlays alone, as a dialog that holds the target does); every other yes/no is no.
export const blockerOnOverlay = (blocks = true) => (q, id, state) => (id === 'blocker' && blocks && state?.page?.overlay ? 0.93 : 0.04);

// A fake Jev for plans: intents() for choices and an overlay that blocks.
export function planJev(targets = {}, { near = false, blocks = true } = {}) {
  return fakeJev({ choice: intents(targets, { near }), noul: blockerOnOverlay(blocks) });
}

// A fake Jev for whole scenarios. `targets` maps an intent to a pattern for the element name
// it should pick; `nouls` maps text found in a yes/no's instructions to a test over the
// state; the blocker is yes whenever the state shows an overlay; `category` names the
// overlay kind; for a closing control it reaches for "subscribe" first, to prove that is
// never offered.
export function scenarioJev({ targets = {}, nouls = {}, category = null } = {}) {
  const byName = (q, re) => Object.keys(q.criteria).find(k => k !== 'none' && re.test(q.criteria[k].name || '')) || 'none';
  const sure = (choice) => ({ choice, p: 0.94, confidence: 0.9 });
  return fakeJev({
    noul: (q, id, state) => {
      const rule = id !== 'blocker' && Object.entries(nouls).find(([k]) => q.instructions.includes(k));
      const yes = rule ? rule[1](JSON.stringify(state), state) : id === 'blocker' ? Boolean(state.page?.overlay) : false;
      return yes ? 0.93 : 0.04;
    },
    choice: (q, id) => {
      if (id === 'target') {
        const intent = Object.keys(targets).find(k => q.instructions.includes(`"${k}"`));
        return sure(intent ? byName(q, targets[intent]) : 'none');
      }
      if (id === 'category') return sure(Object.keys(q.criteria).find(k => q.criteria[k] === category) || 'other');
      if (id === 'control') {
        const sub = byName(q, /subscribe|buy/i);
        return sure(sub !== 'none' ? sub : byName(q, /accept|close|no thanks|not now/i));
      }
      return 'none';
    },
  });
}
