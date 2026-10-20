import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan, walkPlan } from '../lib/do/plan.mjs';

test('retry preserves the parsed attempt, explicit expectation and bounded literal', () => {
  const [pick, click] = parsePlan(['try pick "price; { free => cancellation }" up to 3\n => "the price is right"', 'try click "Reviews tab" up to 2 => "reviews shown"']);
  assert.equal(pick.action, 'try');
  assert.equal(pick.limit, 3);
  assert.equal(pick.attempt.target, 'price; { free => cancellation }');
  assert.equal(pick.attempt.expect, 'the price is right');
  assert.equal(pick.attempt.path, '1.attempt[]');
  assert.equal(click.attempt.action, 'click');
  assert.equal(click.limit, 2);
  assert.deepEqual(walkPlan([pick, click]).map(n => n.action), ['try', 'pick', 'try', 'click']);
});

test('retry refuses missing expectations, invalid bounds and forbidden action syntax', () => {
  for (const source of [
    'try pick "hotel" up to 2', 'try click "Reviews" up to 2 =>',
    ...['0', '4', '-1', '1.5', '$n', 'two'].map(n => `try pick "hotel" up to ${n} => "right"`),
    'try click! "Reviews" up to 2 => "shown"',
    'try select! "Size" = "M" up to 2 => "shown"',
    'try click ref_12 up to 2 => "shown"', 'try click "ref_12" up to 2 => "shown"',
    'try click i12 up to 2 => "shown"', 'try click "i12" up to 2 => "shown"',
    'try click "#reviews" up to 2 => "shown"',
    ...['Submit', 'Send message', 'Buy now', 'Add to cart', 'Delete'].map(name => `try click "${name}" up to 2 => "shown"`),
    'try fill "Name" = "Ada" up to 2 => "shown"', 'optional try click "Reviews" up to 2 => "shown"',
  ]) assert.throws(() => parsePlan(source), /step .*line \d+, column \d+:/, source);
});

test('same-page blocks contain fills and preserve variable scope and traversal', () => {
  const plan = parsePlan('extract "name" as $name; if "ready" { same page { fill "First" = $name; fill "Last" = "Love; {lace}" } }');
  const block = plan[1].then[0];
  assert.equal(block.action, 'samePage');
  assert.equal(block.body[0].valueRef, 'name');
  assert.equal(block.body[0].path, '2.then.1.1');
  assert.equal(block.body[1].value, 'Love; {lace}');
  assert.equal(walkPlan(plan).length, 5);
});

test('same-page syntax rejects commits, checks, optional fills, nesting and non-fills', () => {
  for (const source of [
    'same page {}', 'same page { click! "Submit" }', 'same page { select "Tag" = "A" }',
    'same page { optional fill "First" = "Ada" }', 'same page { fill "First" = "Ada" => "valid" }',
    'same page { expect "valid" }', 'same page { if "ready" { fill "First" = "Ada" } }',
    'same page { same page { fill "First" = "Ada" } }', 'same page { fill "First" = $missing }',
    'same page { fill "First" = "Ada" } click "Continue"', 'same form { fill "First" = "Ada" }',
  ]) assert.throws(() => parsePlan(source), /step .*line \d+, column \d+:/, source);
});

test('retries and same-page blocks nest in existing loops and block conditions', () => {
  const plan = parsePlan('for top 1 { try click "Reviews tab" up to 1 => "shown"; same page { fill "Search" = "x" } }; if "ready" { try pick "hotel" up to 2 => "right" }');
  assert.equal(plan[0].body[0].path, '1.item[].1');
  assert.equal(plan[1].then[0].action, 'try');
  assert.equal(plan[1].then[0].attempt.expect, 'right');
});
