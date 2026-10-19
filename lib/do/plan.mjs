import { parseStep } from './parse.mjs';

const NAME = '[A-Za-z_][A-Za-z0-9_]*';
const refPattern = new RegExp(`^\\$(${NAME})$`);
const quoted = s => /^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')$/s.test(s);
const unquote = s => s.replace(/^(["'])([\s\S]*)\1$/, '$2');

function outsideQuotes(s) {
  let quote = null, masked = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      masked += ' ';
      if (c === '\\' && i + 1 < s.length) { masked += ' '; i++; }
      else if (c === quote) quote = null;
    } else if ((c === '"' || c === "'") && (i === 0 || /[\s=:,]/.test(s[i - 1]))) { quote = c; masked += ' '; }
    else masked += c;
  }
  return masked;
}

export function walkPlan(nodes) {
  return nodes.flatMap(n => [n, ...(n.action === 'branch' ? [...walkPlan(n.then), ...walkPlan(n.else)] : n.action === 'if' ? walkPlan([n.then]) : [])]);
}

export function parsePlan(lines) {
  const args = (Array.isArray(lines) ? lines : [lines]).map(String);
  const text = args.join('\n');
  let offset = 0;
  const ranges = args.map(arg => {
    const range = { start: offset, end: offset + arg.length, structured: /[{}]/.test(outsideQuotes(arg)) };
    offset = range.end + 1;
    return range;
  });
  let at = 0;
  function fail(message, path, pos = at) {
    const before = text.slice(0, pos), line = before.split('\n').length;
    throw new Error(`step ${path}, line ${line}, column ${pos - before.lastIndexOf('\n')}: ${message}`);
  }
  function spaces() { while (/\s/.test(text[at] || '') && at < text.length) at++; }
  function separators() { while (at < text.length && /[\s;]/.test(text[at])) at++; }
  function known(name, scope, path, pos) { if (!scope.has(name)) fail(`unknown variable $${name}`, path, pos); }
  function operand(raw, scope, path, pos) {
    raw = raw.trim();
    const r = raw.match(refPattern);
    if (r) { known(r[1], scope, path, pos); return { ref: r[1] }; }
    if (/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw)) return { value: Number(raw), type: 'number' };
    if (quoted(raw)) return { value: unquote(raw), type: 'text' };
    fail('comparison requires a variable, number or quoted text', path, pos);
  }
  function leaf(raw, path, scope, pos) {
    let node;
    const inline = raw.match(/^(optional\s+)?if\s+(".*?"|'.*?')\s+then\s+([\s\S]+)$/);
    if (inline) {
      let base;
      try { base = parseStep(raw); } catch (e) { fail(e.message, path, pos); }
      let child = inline[3];
      if (base.expect) {
        // parseStep owns an inline expectation on the enclosing conditional.
        const marker = outsideQuotes(child).lastIndexOf('=>');
        if (marker >= 0) child = child.slice(0, marker).trim();
      }
      node = { ...base, then: leaf(child, `${path}.then.1`, new Set(scope), pos) };
    } else if (/^answer\b/.test(raw)) {
      const m = raw.match(/^answer\s+(["'])([\s\S]*)\1$/);
      if (!m || !quoted(raw.slice(7).trim())) fail('write answer "<template>"', path, pos);
      for (const match of m[2].matchAll(/(?<!\\)\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) known(match[1], scope, path, pos);
      node = { action: 'answer', target: m[2] };
    } else {
      let core = raw, binding, extraction, fields, expectation = '';
      if (/^(optional\s+)?extract\b/.test(raw)) {
        const marker = outsideQuotes(core).lastIndexOf('=>');
        if (marker >= 0) { expectation = ' ' + core.slice(marker); core = core.slice(0, marker).trim(); }
        const bind = core.match(new RegExp(`\\s+as\\s+\\$(${NAME})\\s*$`));
        if (bind) { binding = bind[1]; core = core.slice(0, bind.index); }
        else if (/\s+as\s+\$/.test(outsideQuotes(core))) fail('invalid binding name', path, pos);
        const record = core.match(/^(optional\s+)?extract\s*\{([\s\S]*)\}$/);
        if (record) {
          if (!binding) fail('record extraction requires a binding', path, pos);
          fields = record[2].split(',').map(field => {
            const m = field.trim().match(new RegExp(`^(${NAME}):\\s*(text|number|date)(?:\\s+currency\\s+([A-Z]{3}))?$`));
            if (!m || (m[3] && m[2] !== 'number')) fail('invalid extraction field', path, pos);
            return { name: m[1], type: m[2], ...(m[3] ? { currency: m[3] } : {}) };
          });
          if (new Set(fields.map(f => f.name)).size !== fields.length) fail('duplicate extraction field', path, pos);
          core = `${record[1] || ''}extract "record"`;
        } else {
          const typed = core.match(/\s+as\s+(text|number|date)(?:\s+currency\s+([A-Z]{3}))?$/);
          if (typed) {
            if (!binding || (typed[2] && typed[1] !== 'number')) fail('typed extraction requires a binding and valid currency', path, pos);
            extraction = { type: typed[1], ...(typed[2] ? { currency: typed[2] } : {}) };
            core = core.slice(0, typed.index);
          } else if (/\s+as\s+(?:text|number|date)\b/.test(outsideQuotes(core))) fail('invalid typed extraction', path, pos);
        }
      }
      try { node = parseStep(core + expectation); } catch (e) { fail(e.message, path, pos); }
      if (binding) {
        if (scope.has(binding)) fail(`immutable variable $${binding} already bound`, path, pos);
        scope.add(binding);
        node.binding = binding;
      }
      if (extraction) node.extraction = extraction;
      if (fields) node.fields = fields;
      // Only an entire unquoted value is substituted. Quoted dollars are literal.
      const expectedAt = outsideQuotes(core).lastIndexOf('=>');
      const input = expectedAt < 0 ? core : core.slice(0, expectedAt).trim();
      const rest = input.replace(/^(optional\s+)?\w+!?\s*/, '');
      const assignment = ['fill', 'select'].includes(node.action) ? rest.match(/^(".*?"|'.*?'|(?:[^=\[]|\[[^\]]*\])+?)\s*=\s*(.*)$/s) : null;
      const valueRaw = assignment ? assignment[2].trim() : node.action === 'type' ? rest.trim() : null;
      const ref = valueRaw?.match(refPattern);
      const refs = [...outsideQuotes(core).matchAll(new RegExp(`\\$(${NAME})`, 'g'))];
      if (refs.length && (!ref || refs.length !== 1)) fail('variables are only allowed as whole input values', path, pos);
      if (ref) { known(ref[1], scope, path, pos); node[node.action === 'type' ? 'targetRef' : 'valueRef'] = ref[1]; }
    }
    return { ...node, path, source: raw };
  }
  function sequence(prefix, scope, depth, enclosed) {
    const nodes = [];
    while (true) {
      separators();
      const path = prefix ? `${prefix}.${nodes.length + 1}` : String(nodes.length + 1), pos = at;
      if (at >= text.length) { if (enclosed) fail('missing closing brace', path, pos); return nodes; }
      if (text[at] === '}') { if (!enclosed) fail('unexpected closing brace', path); at++; return nodes; }
      const range = ranges.find(r => pos >= r.start && pos < r.end);
      let q = null, brace = 0, block = false;
      for (; at < text.length; at++) {
        if (!enclosed && at === range?.end) break;
        const c = text[at];
        if (q) { if (c === '\\') { at++; continue; } if (c === q) q = null; continue; }
        if ((c === '"' || c === "'") && (at === pos || /[\s=:,]/.test(text[at - 1]))) { q = c; continue; }
        if (c === '{') {
          const header = outsideQuotes(text.slice(pos, at));
          if (/^(optional\s+)?if\b/.test(header) && !/\s+then\s+/.test(header)) { block = true; break; }
          if (brace || !/(?:^|\s+then\s+)(?:optional\s+)?extract\s*$/.test(header)) fail('unexpected opening brace', path, at);
          brace++;
        } else if (c === '}') { if (!brace) break; brace--; }
        if (!brace && (enclosed || range?.structured) && (c === ';' || c === '\n')) break;
      }
      if (q || brace) fail(q ? 'unterminated quote' : 'unclosed extraction record', path, pos);
      const raw = text.slice(pos, at).trim();
      if (block) {
        if (depth >= 2) fail('at most two nested block levels', path, pos);
        const m = raw.match(/^(optional\s+)?if\s+([\s\S]+)$/);
        if (!m) fail('invalid block condition', path, pos);
        const cond = m[2].trim();
        let condition;
        if (quoted(cond)) condition = { target: unquote(cond) };
        else {
          const comparison = outsideQuotes(cond).match(/==|!=|<=|>=|<|>/);
          if (!comparison) fail('invalid comparison', path, pos);
          const left = cond.slice(0, comparison.index), right = cond.slice(comparison.index + comparison[0].length);
          condition = { comparison: { left: operand(left, scope, path, pos), op: comparison[0], right: operand(right, scope, path, pos) } };
        }
        at++;
        const then = sequence(`${path}.then`, new Set(scope), depth + 1, true);
        let boundary = at;
        spaces();
        let otherwise = [];
        if (/^else\b/.test(text.slice(at))) { at += 4; spaces(); if (text[at] !== '{') fail('else requires a block', path); at++; otherwise = sequence(`${path}.else`, new Set(scope), depth + 1, true); boundary = at; spaces(); }
        if (at < text.length && !/[;}]/.test(text[at]) && !text.slice(boundary, at).includes('\n')) fail('steps require a newline or semicolon separator', path, at);
        nodes.push({ action: 'branch', ...condition, then, else: otherwise, path, source: text.slice(pos, at).trim(), ...(m[1] ? { optional: true } : {}) });
      } else {
        if (/^(for|each|try|same)\b/.test(raw)) fail('unsupported loop, retry or same-page block', path, pos);
        if (!raw) fail('expected step', path, pos);
        nodes.push(leaf(raw, path, scope, pos));
      }
    }
  }
  return sequence('', new Set(), 0, false);
}
