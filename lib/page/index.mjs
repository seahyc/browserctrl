// Code that runs in the page lives in real files here, one function expression per file
// taking one args object: lib/page/<name>.js. page(name, args) turns one into an expression
// for Runtime.evaluate: `(<source>)(<args as JSON>)`.
//
// Helpers several scripts share (and a few Node shares too, such as parseDateText) live once
// in shared.mjs. A script uses one by its name; the loader puts the helper's source, and the
// helpers it uses in turn, in front of the script. The page never sees an import.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as shared from './shared.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const sources = new Map();

// The file's function, read once. A trailing semicolon would end the expression early.
export function source(name) {
  let src = sources.get(name);
  if (src === undefined) {
    src = fs.readFileSync(path.join(DIR, `${name}.js`), 'utf8').trim().replace(/;+$/, '');
    sources.set(name, src);
  }
  return src;
}

// One helper as page source: a function keeps its own text, anything else becomes a const.
function declare(name, v) {
  if (typeof v === 'function') {
    const s = v.toString();
    return new RegExp(`^(async\\s+)?function\\s*\\*?\\s*${name}\\s*\\(`).test(s) ? s : `const ${name} = ${s};`;
  }
  return `const ${name} = ${v instanceof RegExp ? v.toString() : JSON.stringify(v)};`;
}

const NAMES = Object.keys(shared);
const uses = (src, name) => new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(src);
const helperCache = new Map();
// Every helper a source names, directly or through other helpers, in a stable order.
function helpersFor(src) {
  const need = new Set();
  const visit = (text) => {
    for (const n of NAMES) if (!need.has(n) && uses(text, n)) { need.add(n); visit(declare(n, shared[n])); }
  };
  visit(src);
  return NAMES.filter(n => need.has(n));
}
function preamble(name, src) {
  let p = helperCache.get(name);
  if (p === undefined) {
    p = helpersFor(src).map(n => declare(n, shared[n])).join('\n');
    helperCache.set(name, p);
  }
  return p;
}

// The expression that runs lib/page/<name>.js with args in the page.
export function page(name, args = {}) {
  const src = source(name);
  const json = JSON.stringify(args ?? {});
  const pre = preamble(name, src);
  return pre ? `(() => {\n${pre}\nreturn (${src})(${json});\n})()` : `(${src})(${json})`;
}

// Page source of shared helpers by name, with what they use, for code that still builds its
// page script by hand (an expression in lib/ops.mjs that embeds a lookup).
export function helperSource(...names) {
  const need = new Set();
  const visit = (n) => { if (need.has(n)) return; need.add(n); const text = declare(n, shared[n]); for (const m of NAMES) if (m !== n && uses(text, m)) visit(m); };
  names.forEach(visit);
  return NAMES.filter(n => need.has(n)).map(n => declare(n, shared[n])).join('\n');
}

// Every page script's name, for the parse test.
export function pageNames() {
  return fs.readdirSync(DIR).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3)).sort();
}
