// Credential-shaped strings in what the CLI prints. A page that shows a new secret once
// (Cloudflare's "Create Token" result, a GitHub PAT, a cloud console key) would otherwise put
// it into the agent's context through read, text, find, grep, eval or a do report. Protected
// capture (vault-fill.mjs) saves such a secret without anyone reading it and taints the tab;
// this is the net under it for a page nobody captured, and redacts by shape, since the value
// is not known in advance. Known values (filled or captured) are redacted by the daemon.
//
// Two kinds of match:
//  - a known token format (provider prefixes, JWTs, Authorization headers, key=value pairs
//    named like a secret);
//  - a free-standing high-entropy word: 32-128 characters of [A-Za-z0-9_-] with upper and
//    lower case letters and digits, not part of a URL or path, not hex, not a UUID.
// Turn it off for a run with BROWSERCTRL_REDACT=0.

const MASK = '[redacted credential]';

const PREFIXED = [
  /\bsk-(?:ant-|proj-|live_|test_)?[A-Za-z0-9_-]{20,}/g, // OpenAI, Anthropic, Stripe-style
  /\b(?:rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g, /\bgithub_pat_[A-Za-z0-9_]{40,}/g, // GitHub
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
];
// The value after a word that says it is a secret: "Bearer X", "X-Auth-Key: X", "token=X".
const LABELLED = /(\b(?:Bearer|Basic|Token)\s+|\b(?:x-auth-key|x-api-key|api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|token)["']?\s*[:=]\s*["']?)([A-Za-z0-9._~+/=-]{16,})/gi;
// A free-standing word: not preceded or followed by a URL or path character.
const WORD = /(?<![A-Za-z0-9_\-/.=?&%#@:,+~])([A-Za-z0-9_-]{32,128})(?![A-Za-z0-9_\-/.=?&%#@~])/g;

function entropy(s) {
  const n = new Map();
  for (const c of s) n.set(c, (n.get(c) || 0) + 1);
  let h = 0;
  for (const k of n.values()) { const p = k / s.length; h -= p * Math.log2(p); }
  return h;
}

export function looksLikeSecretWord(w) {
  if (w.length < 32 || !/[a-z]/.test(w) || !/[A-Z]/.test(w) || !/\d/.test(w)) return false;
  if (/^[0-9a-f-]+$/i.test(w)) return false; // hex digests and UUIDs, either case
  // Words joined by - or _ (a slug, a CSS class, an id like "api_tokens_summary_button"):
  // a secret is one run, or has no part shorter than 8 between separators.
  const parts = w.split(/[-_]/);
  if (parts.length > 2 && parts.some(p => p.length < 8)) return false;
  return entropy(w) >= 4.2;
}

// The text with credential-shaped strings replaced, and how many were.
export function redactCredentials(text) {
  if (typeof text !== 'string' || text.length < 16) return { text, count: 0 };
  let count = 0;
  let s = text;
  for (const re of PREFIXED) s = s.replace(re, () => { count++; return MASK; });
  s = s.replace(LABELLED, (m, label, value) => {
    if (value === MASK || !/\d/.test(value) || value.length < 16) return m;
    count++;
    return label + MASK;
  });
  s = s.replace(WORD, (m, w) => { if (!looksLikeSecretWord(w)) return m; count++; return MASK; });
  return { text: s, count };
}

export const redactionOn = (env = process.env) => !/^(0|off|false|no)$/i.test(String(env.BROWSERCTRL_REDACT ?? '1'));

// Route a stream's text through the redactor. A note goes to stderr once per process when
// anything was redacted, saying how to keep a new secret without reading it.
export function guardStream(stream, { onRedact } = {}) {
  const write = stream.write.bind(stream);
  stream.write = (chunk, encoding, cb) => {
    if (typeof chunk === 'string' || (Buffer.isBuffer(chunk) && !hasBinary(chunk))) {
      const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const r = redactCredentials(str);
      if (r.count) { onRedact?.(r.count); return write(r.text, typeof encoding === 'function' ? encoding : 'utf8', typeof encoding === 'function' ? undefined : cb); }
    }
    return write(chunk, encoding, cb);
  };
  return () => { stream.write = write; };
}
const hasBinary = (b) => b.subarray(0, 512).includes(0);
