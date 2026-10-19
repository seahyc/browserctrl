import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStep } from '../lib/do/parse.mjs';
import { parsePlan, walkPlan } from '../lib/do/plan.mjs';
test('blocks, paths and quote-protected syntax', () => {
  const p = parsePlan(['if "shown { ; => | }" { fill "Name" = "a;b"; extract "price" as number currency SGD as $p; if $p < 200 { answer "${p}" } } else { click "Other" }']);
  assert.equal(p[0].then[0].value, 'a;b');
  assert.equal(p[0].then[2].then[0].path, '1.then.3.then.1');
  assert.equal(walkPlan(p).length, 6);
});
test('variables, record extraction, inline and literal dollars', () => {
  const p = parsePlan(['extract { price: number currency SGD, cancellation: text } as $offer', 'fill "Name" = $offer', 'type "$offer"', 'if "shown" then extract "price" as $p']);
  assert.equal(p[0].fields[0].currency, 'SGD');
  assert.equal(p[1].valueRef, 'offer');
  assert.equal(p[2].targetRef, undefined);
  assert.equal(p[3].then.binding, 'p');
});
test('reject undefined, escaped scope, duplicate, depth and unsupported forms with locations', () => {
  for (const lines of [['fill "X" = $missing'], ['if "x" { extract "x" as $x }; type $x'], ['extract "x" as $x', 'extract "y" as $x'], ['if "x" { if "y" { if "z" { click "a" } } }'], ['for top 11 { click "x" }'], ['answer "${missing}"'], ['if "x" { click "a"']]) {
    assert.throws(() => parsePlan(lines), /step .*line \d+, column \d+/);
  }
  assert.doesNotThrow(() => parsePlan(['answer "\\${missing}"']));
});
test('existing step forms remain supported', () => {
  const forms = ['click! "Submit"', 'optional hover "Help"', 'fill "Name" = "Ada"', 'select Sort = Price', 'key Enter', 'type "text"', 'scroll down', 'nav https://example.org', 'expect "shown"', 'wait 1500', 'date 2026-10-17', 'set "Price" = 300-900', 'extract "price"', 'pick "cheapest"', 'if "shown" then click "Go"', 'click "A" | "B" => "shown"'];
  assert.equal(parsePlan(forms).length, forms.length);
});

const withoutMetadata = node => Object.fromEntries(Object.entries(node).filter(([k]) => !['path', 'source'].includes(k)).map(([k, v]) => [k, k === 'then' ? withoutMetadata(v) : v]));
test('legacy grammar outputs match parseStep exactly', () => {
  const forms = [
    'click! "Submit"', 'select! Sort = Price', 'optional hover "Help" => "shown"',
    'fill "a=b" = "literal $x; { } => |"', 'fill input[name=x] = "Ada"',
    'select Sort = Price', 'key Enter', 'type "text"', 'scroll down',
    'nav https://example.org', 'expect "shown"', 'wait 1500', 'date 2026-10-17',
    'set "Price" = "$300-$900"', 'extract "price as number"', 'extract "as $p"',
    'pick "cheapest"', 'if "shown" then click "Go" => "a => b"',
    'click "A" | "B" => "shown"', 'click ref_25', 'click i140', 'hover #target',
    `click "Men's shoes"`, "click Men's shoes", 'fill "Name" = "Ada"',
  ];
  for (const form of forms) assert.deepEqual(withoutMetadata(parsePlan([form])[0]), parseStep(form), form);
});
test('quote-aware variables and syntax diagnostics', () => {
  const plan = parsePlan(['extract "value" as $x', 'fill "a=b" = $x', 'select input[name=x] = $x', 'type $x', 'fill "v" = "$x"', 'click "$x"']);
  assert.equal(plan[1].valueRef, 'x');
  assert.equal(plan[2].valueRef, 'x');
  assert.equal(plan[3].targetRef, 'x');
  assert.equal(plan[4].valueRef, undefined);
  assert.equal(plan[5].target, '$x');
  for (const source of ['click $x', 'hover prefix $x', 'fill $x = "v"', 'fill "v" = prefix $x', 'if $missing == 1 {wait 1}', 'click { x }', 'if "x" {wait 1} click "x"', 'if "x" {wait 1} else {wait 2} click "x"', 'extract "price" as number currency sgd as $p']) {
    assert.throws(() => parsePlan([source]), /step 1, line 1, column \d+:/, source);
  }
  assert.throws(() => parsePlan(['if "x" {\n wait 1;\n type $missing\n}']), /step 1\.then\.2, line 3, column 2:/);
  assert.doesNotThrow(() => parsePlan(['if "before then after" { if "nested" { wait 1 } }']));
  assert.throws(() => parsePlan(['if "x" { if "y" { if "z" {wait 1} } }']), /step 1\.then\.1\.then\.1/);
});

test('comparison operators inside quoted literals stay text', () => {
  const plan = parsePlan(['extract "x" as $x', 'if "a > b" == $x { wait 1 }', 'if "a" == "b" { wait 1 }']);
  assert.deepEqual(plan[1].comparison.left, { value: 'a > b', type: 'text' });
  assert.equal(plan[2].comparison.op, '==');
  assert.throws(() => parsePlan(['answer "a" garbage "b"']), /step 1, line 1, column 1:/);
});
test('each legacy argument preserves unquoted separators in its value', () => {
  const forms = ['type first; second', 'type first\nsecond', 'fill "Name" = first; second', 'fill "Name" = first\nsecond'];
  const plan = parsePlan(forms);
  assert.equal(plan.length, forms.length);
  for (let i = 0; i < forms.length; i++) assert.deepEqual(withoutMetadata(plan[i]), parseStep(forms[i]));
  assert.equal(parsePlan(['if "ready" { wait 1; wait 2 }; type final'])[1].target, 'final');
});
test('bound, typed and record extractions retain external expectations', () => {
  const forms = ['extract "price" as $p => "shown"', 'extract "price" as number currency SGD as $p => "shown => still shown"', 'extract { price: number currency SGD } as $offer => "shown"'];
  const nodes = forms.map(source => parsePlan([source])[0]);
  assert.equal(nodes[0].binding, 'p');
  assert.equal(nodes[0].expect, 'shown');
  assert.equal(nodes[1].extraction.currency, 'SGD');
  assert.equal(nodes[1].expect, 'shown => still shown');
  assert.equal(nodes[2].fields[0].name, 'price');
  assert.equal(nodes[2].expect, 'shown');
  assert.equal(parsePlan(['if "ready" then extract "price" as $p => "shown"'])[0].expect, 'shown');
});
