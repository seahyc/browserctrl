// Which clicks can commit: words in many languages, structure, and doubt for the rest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commits, doubtful, saysCommit, commitQuestion } from '../lib/commit.mjs';

const btn = { role: 'button' };

test('English commit buttons, as before', () => {
  for (const l of ['Buy now', 'Place order', 'Submit', 'Confirm purchase', 'Cancel my subscription', 'Create an account', 'Log out']) assert.equal(commits(l, btn), true, l);
  for (const l of ['Bookmarks', 'Prime Video (purchase/rental)', 'Where to watch Prime Video Netflix Hulu purchase', 'Show results', 'Cancel']) assert.equal(commits(l, btn), false, l);
  assert.equal(commits('Order Now', { role: 'link', href: '/order' }), false, 'a link only opens the order page');
  assert.equal(commits('Submit', btn, { afterSearchFill: true }), false, 'Submit after a search runs the search');
});

test('commit buttons in other languages', () => {
  const yes = ['Jetzt kaufen', 'Zahlungspflichtig bestellen', 'Zur Kasse', 'Passer la commande', 'Acheter', 'Finalizar compra', 'Comprar ahora', 'Acquista ora', 'Afrekenen', 'Köp nu', 'Kup teraz', 'Satın al', 'Оформить заказ', 'Beli sekarang', 'Mua ngay', '立即购买', '提交订单', '注文を確定する', '今すぐ購入', '구매하기', '결제하기', 'ชำระเงิน', 'ادفع الآن', 'अभी खरीदें'];
  for (const l of yes) assert.equal(commits(l, btn), true, l);
  // Harmless words that look close, and labels where the verb does not lead.
  const no = ['Suchen', 'Weiter', 'Filtrer', 'Ver más', 'Daftar produk', 'Pesan', 'Mehr anzeigen', '查看更多', 'もっと見る', '더보기', 'Produkt (kaufen oder mieten)'];
  for (const l of no) assert.equal(commits(l, btn), false, l);
  assert.equal(commits('Suchen', btn, { afterSearchFill: true }), false);
  assert.equal(commits('Entfernen', { role: 'button', infilter: true }), false, 'removing a filter chip undoes nothing');
});

test('structure: a checkout form submit commits whatever it says', () => {
  assert.equal(commits('Weiter', { role: 'button', submit: true }, { checkout: true }), true);
  assert.equal(commits('Weiter', { role: 'button', submit: true }), false);
  assert.equal(commits('Weiter', { role: 'checkbox', submit: true }, { checkout: true }), false);
});

test('doubt: labels the word lists cannot judge are asked about', () => {
  assert.equal(doubtful('Αγορά τώρα', btn), true, 'Greek');
  assert.equal(doubtful('קנה עכשיו', btn), true, 'Hebrew');
  assert.equal(doubtful('Osta nyt', btn, { lang: 'fi' }), true, 'a page language the lists do not cover');
  assert.equal(doubtful('Show more', btn, { lang: 'en' }), false);
  assert.equal(doubtful('Weiter', btn, { lang: 'de' }), false);
  assert.equal(doubtful('Αγορά τώρα', { role: 'checkbox' }), false, 'ticking commits nothing');
  assert.equal(doubtful('Αγορά', { role: 'link', href: '/x' }), false, 'a real link only opens a page');
  assert.equal(doubtful('Jetzt kaufen', btn), false, 'already a commit by its words');
  const q = commitQuestion({ role: 'button', name: 'Αγορά τώρα' });
  assert.equal(q.type, 'noul');
  assert.match(q.instructions, /Αγορά τώρα/);
});

test('saysCommit reads only the start of the label', () => {
  assert.equal(saysCommit('Kaufen'), true);
  assert.equal(saysCommit('Mehr über dieses Produkt erfahren und dann kaufen'), false);
  assert.equal(saysCommit('这是一个很长的说明文字然后购买'), false);
});
