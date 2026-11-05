// Credential-shaped strings are redacted from CLI output; ordinary page text, ids, hashes and
// links are not. The tokens below are random strings of each shape, not real credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { redactCredentials, looksLikeSecretWord, redactionOn, guardStream } from '../lib/credentials.mjs';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const rand = (n, chars = ALNUM + '_-') => Array.from(crypto.randomBytes(n), b => chars[b % chars.length]).join('');
// A Cloudflare-style API token: 40 mixed-case characters with digits, alone on its line.
const cfToken = () => { for (;;) { const t = rand(40); if (looksLikeSecretWord(t)) return t; } };

test('a token shown once on a page is redacted, alone, in a curl command and in JSON', () => {
  const tok = cfToken();
  const page = `Your API token\nCopy this token to access the Cloudflare API.\n${tok}\nCopy`;
  const r = redactCredentials(page);
  assert.equal(r.count, 1);
  assert.ok(!r.text.includes(tok));
  assert.match(r.text, /Cloudflare API\.\n\[redacted credential\]\nCopy/);
  const curl = `curl "https://api.cloudflare.com/client/v4/user/tokens/verify" -H "Authorization: Bearer ${tok}"`;
  assert.ok(!redactCredentials(curl).text.includes(tok));
  assert.match(redactCredentials(curl).text, /Bearer \[redacted credential\]"/);
  assert.ok(!redactCredentials(JSON.stringify({ value: tok })).text.includes(tok));
});

test('known token formats are redacted', () => {
  for (const s of [
    'ghp_' + rand(36, ALNUM), 'github_pat_' + rand(60, ALNUM + '_'), 'glpat-' + rand(20, ALNUM),
    'sk-ant-api03-' + rand(80), 'xoxb-' + rand(30, ALNUM + '-'), 'AKIA' + rand(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'),
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.' + rand(43),
  ]) {
    const r = redactCredentials(`key: ${s} end`);
    assert.ok(!r.text.includes(s), s);
    assert.ok(r.count >= 1, s);
  }
  const r = redactCredentials('X-Auth-Key: 0123456789abcdef0123456789abcdef01234');
  assert.match(r.text, /X-Auth-Key: \[redacted credential\]/);
});

test('ids, hashes, links, slugs and prose are left alone', () => {
  const keep = [
    '7142451B4A863B9DDA8D7E95035B3F5A', // a tab id
    'current tab: 7142451B4A863B9DDA8D7E95035B3F5A',
    'token: 1793791748069:3od6y3   scroll 0/1133',
    '0f3c2a9d8b7e6f5a4c3b2a1908f7e6d5c4b3a291', // sha1
    'b6fb17d8164be6988c26d3c2a1f0e9d8', // a Cloudflare account id
    '123e4567-e89b-12d3-a456-426614174000',
    'https://dash.cloudflare.com/b6fb17d8164be6988c26d3c2/workers/services/view/AbCdEfGh1234567890IjKlMnOpQrStUvWx',
    'https://lh3.googleusercontent.com/a/ACg8ocJ4mFqZx9QwErTyUiOp1234567890AbCdEfGh=s96-c',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk',
    ' ref_39   e91   button     Continue to summary                                          [api_tokens_summary_button]',
    'sidebar-nav-route-navigation.profile.access_management.authentication',
    'kumo-user-dropdown-button classic-sidebar-nav-trigger',
    'Internationalization and localization are supercalifragilisticexpialidocious words',
    'password: ********',
  ];
  for (const s of keep) assert.deepEqual(redactCredentials(s), { text: s, count: 0 }, s);
});

test('BROWSERCTRL_REDACT=0 turns it off', () => {
  assert.equal(redactionOn({}), true);
  assert.equal(redactionOn({ BROWSERCTRL_REDACT: '0' }), false);
  assert.equal(redactionOn({ BROWSERCTRL_REDACT: 'off' }), false);
});

test('a guarded stream redacts what is written to it, and says so once', () => {
  const tok = cfToken();
  const written = [];
  let notes = 0;
  const stream = { write(chunk, enc, cb) { written.push(String(chunk)); return true; } };
  const restore = guardStream(stream, { onRedact: () => notes++ });
  stream.write(`text\n${tok}\n`);
  stream.write(Buffer.from(`{"value":"${tok}"}\n`));
  stream.write('nothing secret here\n');
  restore();
  assert.equal(written.join('').includes(tok), false, written.join(''));
  assert.equal(written.filter(w => w.includes('[redacted credential]')).length, 2);
  assert.equal(written[2], 'nothing secret here\n');
  assert.equal(notes, 2);
});
