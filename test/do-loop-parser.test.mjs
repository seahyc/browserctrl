import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan, walkPlan } from '../lib/do/plan.mjs';

test('loop modes, stable template paths and comma extraction shorthand', () => {
  const plan = parsePlan(['for top 3 { extract "price", "cancellation"; if "shown" { extract "policy" } }', 'each "rated >= 4; { organic }" up to 10 { extract "name" }']);
  assert.equal(plan[0].action, 'loop');
  assert.equal(plan[0].mode, 'top');
  assert.equal(plan[0].limit, 3);
  assert.deepEqual(plan[0].body.slice(0, 2).map(n => [n.target, n.path]), [['price', '1.item[].1'], ['cancellation', '1.item[].2']]);
  assert.equal(plan[0].body[2].then[0].path, '1.item[].3.then.1');
  assert.equal(plan[1].mode, 'each');
  assert.equal(plan[1].target, 'rated >= 4; { organic }');
  assert.equal(walkPlan(plan).length, 7);
});

test('literal loop bounds, nesting through branches and commits rejected before execution', () => {
  for (const source of [
    'for top 0 { wait 1 }', 'for top 11 { wait 1 }', 'for top -1 { wait 1 }',
    'for top 1.5 { wait 1 }', 'for top $n { wait 1 }', 'each "x" up to 200 { wait 1 }',
    'for top 2 { for top 1 { wait 1 } }',
    'for top 2 { if "ready" { each "x" up to 1 { wait 1 } } }',
    'for top 2 { click! "Submit" }', 'for top 2 { if "ready" then select! "Size" = "M" }',
    'each "x" up to 2 { if "ready" { wait 1 } else { click! "Submit" } }',
    'for top 1 { wait 1 } click "Continue"',
  ]) assert.throws(() => parsePlan([source]), /step .*line \d+, column \d+:/, source);
  assert.doesNotThrow(() => parsePlan(['if "ready" { for top 1 { if "x" { wait 1 } } }']));
});

test('each loop has a child immutable binding scope', () => {
  const plan = parsePlan(['extract "shared" as $shared', 'for top 2 { extract "price" as $price; fill "Max" = $price; type $shared }', 'extract "other" as $price']);
  assert.equal(plan[1].body[1].valueRef, 'price');
  for (const source of [
    'for top 2 { extract "x" as $x }; type $x',
    'extract "x" as $x\nfor top 2 { extract "y" as $x }',
    'for top 2 { extract "x" as $x; extract "y" as $x }',
  ]) assert.throws(() => parsePlan([source]), /unknown variable|immutable variable/);
});

test('ranked picks bind records with literal bounded limits', () => {
  const plan = parsePlan(['pick "lowest listed price with free cancellation" top 3 as $choices', 'answer "${choices}"']);
  assert.deepEqual(plan[0], { action: 'rankedPick', target: 'lowest listed price with free cancellation', limit: 3, binding: 'choices', path: '1', source: 'pick "lowest listed price with free cancellation" top 3 as $choices' });
  assert.equal(parsePlan(['pick "top quality"'])[0].action, 'pick');
  for (const source of ['pick "price" top 0 as $x', 'pick "price" top 11 as $x', 'pick "price" top $k as $x', 'pick "price" top 2', 'pick "price" top 1 as $x\npick "date" top 2 as $x']) {
    assert.throws(() => parsePlan([source]), /step .*line \d+, column \d+:/, source);
  }
});
