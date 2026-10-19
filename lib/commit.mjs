// Which clicks can commit something: spend money, book, order, send, publish, sign up, delete.
// `do` never makes such a click unless the plan marks the step (click!) and names the control
// exactly; a click by ref is deliberate and passes.
//
// Three layers, so a page in any language is covered:
//   1. Structure: ticking, choosing, typing and following a real link commit nothing; a
//      form's submit button on a page that shows payment fields always commits.
//   2. Words: commit verbs in the languages most sites use. They must lead the label, as on
//      real commit buttons ("Buy now", "Jetzt kaufen", "立即购买").
//   3. Doubt: a button whose label the word lists cannot judge (a script or language they
//      do not cover, or a page whose lang is not one they cover) goes to Jev as a yes/no
//      question before it is clicked (commitQuestion).

// Choosing an option, ticking a box or following a link commits nothing by itself: a link
// to /order or /checkout only opens that page, where the real button waits.
const NEVER_COMMITS = new Set(['checkbox', 'radio', 'switch', 'option', 'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem', 'textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'select', 'listbox']);

// Commit verbs and phrases by language. Words that also mean something harmless are left out
// or kept only in a phrase ("daftar" is "list" in Indonesian; "daftar sekarang" signs up;
// 확인 is every Korean OK button).
const WORDS = {
  en: ['send', 'submit', 'post', 'publish', 'pay', 'purchase', 'buy', 'checkout', 'check out', 'place order', 'order now', 'book', 'reserve', 'donate', 'subscribe', 'unsubscribe', 'sign up', 'register', 'create account', 'create an account', 'delete', 'remove', ...['', 'my ', 'your '].flatMap(w => ['order', 'booking', 'subscription', 'account'].map(o => `cancel ${w}${o}`)),'confirm', 'transfer', 'withdraw', 'sign out', 'log out'],
  de: ['kaufen', 'jetzt kaufen', 'bestellen', 'zahlungspflichtig bestellen', 'bezahlen', 'zahlen', 'zur kasse', 'buchen', 'reservieren', 'senden', 'absenden', 'abschicken', 'veröffentlichen', 'löschen', 'entfernen', 'abonnieren', 'registrieren', 'konto erstellen', 'bestätigen', 'überweisen', 'spenden', 'kündigen', 'abmelden'],
  fr: ['acheter', 'commander', 'passer la commande', 'valider la commande', 'payer', 'réserver', 'envoyer', 'publier', 'supprimer', "s'abonner", "s'inscrire", 'créer un compte', 'confirmer', 'faire un don', 'se déconnecter', 'virement'],
  es: ['comprar', 'pagar', 'realizar pedido', 'hacer pedido', 'tramitar pedido', 'finalizar compra', 'reservar', 'enviar', 'publicar', 'eliminar', 'borrar', 'suscribirse', 'suscribirme', 'registrarse', 'registrarme', 'crear cuenta', 'confirmar', 'transferir', 'donar', 'cerrar sesión'],
  pt: ['comprar', 'pagar', 'finalizar compra', 'fazer pedido', 'reservar', 'enviar', 'publicar', 'excluir', 'apagar', 'assinar', 'inscrever-se', 'cadastrar', 'cadastre-se', 'criar conta', 'confirmar', 'transferir', 'doar', 'sair da conta'],
  it: ['acquista', 'compra', 'paga', 'ordina', 'prenota', 'invia', 'pubblica', 'elimina', 'cancella', 'iscriviti', 'abbonati', 'registrati', 'crea account', 'conferma', 'trasferisci', 'dona', 'esci'],
  nl: ['kopen', 'koop', 'bestellen', 'betalen', 'afrekenen', 'boeken', 'reserveren', 'verzenden', 'versturen', 'publiceren', 'verwijderen', 'abonneren', 'registreren', 'account aanmaken', 'bevestigen', 'overmaken', 'doneren', 'uitloggen'],
  nordic: ['köp', 'betala', 'beställ', 'boka', 'skicka', 'radera', 'prenumerera', 'registrera', 'bekräfta', 'logga ut', 'køb', 'kjøp', 'betal', 'bestil', 'bestill', 'slet', 'slett', 'tilmeld', 'bekræft', 'bekreft', 'log ud', 'logg ut'],
  pl: ['kup', 'kupuję', 'zapłać', 'płacę', 'zamów', 'zamawiam', 'zarezerwuj', 'wyślij', 'opublikuj', 'usuń', 'subskrybuj', 'zarejestruj', 'potwierdź', 'przelej', 'wyloguj'],
  tr: ['satın al', 'öde', 'ödeme yap', 'sipariş ver', 'rezervasyon yap', 'gönder', 'yayınla', 'sil', 'abone ol', 'kaydol', 'üye ol', 'onayla', 'bağış yap', 'çıkış yap'],
  ru: ['купить', 'оплатить', 'заказать', 'оформить заказ', 'забронировать', 'отправить', 'опубликовать', 'удалить', 'подписаться', 'зарегистрироваться', 'подтвердить', 'перевести', 'пожертвовать', 'выйти', 'купити', 'оплатити', 'замовити', 'відправити', 'видалити', 'підтвердити'],
  id: ['beli', 'beli sekarang', 'bayar', 'pesan sekarang', 'buat pesanan', 'kirim', 'terbitkan', 'hapus', 'berlangganan', 'daftar sekarang', 'konfirmasi', 'donasi', 'keluar'],
  vi: ['mua', 'mua ngay', 'thanh toán', 'đặt hàng', 'đặt phòng', 'đặt vé', 'gửi', 'đăng bài', 'xóa', 'đăng ký', 'xác nhận', 'chuyển khoản', 'đăng xuất'],
  // Scripts written without spaces between words: matched inside the label's first characters.
  zh: ['购买', '立即购买', '买', '支付', '付款', '结算', '去结算', '下单', '提交订单', '预订', '预定', '发送', '发布', '删除', '订阅', '注册', '确认支付', '确认订单', '转账', '捐赠', '退出登录', '購買', '結帳', '下單', '預訂', '發送', '發佈', '刪除', '訂閱', '註冊', '轉帳'],
  ja: ['購入', '支払', '注文', '予約', '送信', '投稿', '公開する', '削除', '登録', '購読', '確定', '振込', '寄付', 'ログアウト'],
  ko: ['구매', '구입', '결제', '주문', '예약', '보내기', '전송', '게시', '삭제', '구독', '가입', '송금', '기부', '로그아웃'],
  th: ['ซื้อ', 'ชำระเงิน', 'สั่งซื้อ', 'จอง', 'ส่ง', 'ลบ', 'สมัคร', 'ยืนยัน', 'ออกจากระบบ'],
  ar: ['شراء', 'اشتر', 'ادفع', 'دفع', 'اطلب', 'حجز', 'إرسال', 'ارسال', 'نشر', 'حذف', 'اشتراك', 'تسجيل', 'تأكيد', 'تحويل', 'تبرع'],
  hi: ['खरीदें', 'भुगतान', 'ऑर्डर करें', 'बुक करें', 'भेजें', 'हटाएं', 'सदस्यता', 'पंजीकरण', 'पुष्टि'],
};
const UNSPACED = new Set(['zh', 'ja', 'ko', 'th']);
const COVERED_LANGS = new Set(['en', 'de', 'fr', 'es', 'pt', 'it', 'nl', 'sv', 'da', 'no', 'nb', 'nn', 'pl', 'tr', 'ru', 'uk', 'id', 'ms', 'vi', 'zh', 'ja', 'ko', 'th', 'ar', 'hi']);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const spaced = Object.entries(WORDS).filter(([k]) => !UNSPACED.has(k)).flatMap(([, w]) => w);
// Letters and digits on both sides stop a match, in any script ("Bookmarks" is not "book").
const SPACED_RE = new RegExp(`(?<![\\p{L}\\p{N}])(${[...new Set(spaced)].sort((a, b) => b.length - a.length).map(esc).join('|')})(?![\\p{L}\\p{N}])`, 'iu');
const UNSPACED_WORDS = Object.entries(WORDS).filter(([k]) => UNSPACED.has(k)).flatMap(([, w]) => w);

// The verb has to lead the label: a commit button says what it does in its first words
// ("Buy now", "Place order", "Confirm purchase"). A long accordion or filter label that
// mentions "(purchase/rental)" in passing is not one; parenthesized asides never count.
const strip = (label) => String(label || '').replace(/\([^)]*\)|（[^）]*）/g, ' ').replace(/[-]/g, ' ').trim();
const head = (label) => strip(label).split(/\s+/).slice(0, 4).join(' ');
const headChars = (label) => strip(label).replace(/\s+/g, '').slice(0, 8);

/** @param {string} label */
export function saysCommit(label) {
  if (SPACED_RE.test(head(label))) return true;
  const h = headChars(label);
  return UNSPACED_WORDS.some(w => h.includes(w));
}

// Removing a search filter or token undoes nothing that matters: "Remove", "Delete" or
// "Clear" inside a search or filter area is not a commit (the row carries infilter).
const UNDOABLE = /^\s*(remove|delete|clear|entfernen|löschen|supprimer|eliminar|borrar|excluir|rimuovi|elimina|verwijderen|usuń|sil|удалить|hapus|xóa|删除|刪除|削除|삭제)(\s+(the\s+)?(filter|filters|token|tag|chip|search|selection|all))?\s*$/iu;
// A bare "Submit" or "Search" right after typing into a search, place or date field runs
// that search; the same word under a contact or payment form still commits.
const SEARCHY = /^\s*(submit|search|go|find|apply|update|show results|suchen|rechercher|buscar|pesquisar|cerca|cercare|zoeken|sök|søk|szukaj|ara|найти|поиск|cari|tìm kiếm|搜索|搜尋|検索|검색|ค้นหา|بحث|खोजें|enviar|envoyer|senden|invia|verzenden)\s*$/iu;
const SEARCH_FIELD = /(?<![\p{L}\p{N}])(search|where|destination|zip|postal|location|city|keyword|query|suche|recherche|buscar|búsqueda|pesquisa|cerca|zoeken|szukaj|поиск|cari|搜索|検索|검색)(?![\p{L}\p{N}])/iu;
/** @param {import('./types.js').SnapElement | null | undefined} e */
export const searchField = (e) => Boolean(e) && (['searchbox', 'combobox'].includes(e.role) || SEARCH_FIELD.test(`${e.name || ''} ${e.placeholder || ''}`));

// ctx: afterSearchFill (the plan just typed into a search-like field), checkout (the page
// shows payment fields or a payment provider's frame).
/**
 * @param {string} label
 * @param {Partial<import('./types.js').SnapElement>} [el]
 * @param {import('./types.js').CommitContext} [ctx]
 * @returns {boolean}
 */
export function commits(label, el, { afterSearchFill, checkout } = {}) {
  const text = String(label || '');
  if (el && NEVER_COMMITS.has(el.role)) return false;
  if (el && el.role === 'link' && el.href && !/^javascript:/i.test(el.href)) return false;
  // On a checkout, the button that sends the form commits whatever it says.
  if (checkout && el?.submit) return true;
  // A name borrowed from the row an icon button sits in says nothing about what the button
  // does ("Sign up to our emails… (unnamed button)" was a popup's close button). Such a
  // button commits when it sends its form, and only then; a search form's is a search.
  // (A name read from the button's own test id does describe it, and is judged as usual.)
  if (el && el.borrowed) return Boolean(el.submit) && !afterSearchFill && !SEARCH_FIELD.test(text);
  if (!saysCommit(text)) return false;
  if (el?.infilter && UNDOABLE.test(text)) return false;
  if (afterSearchFill && SEARCHY.test(text)) return false;
  return true;
}

// A control the word lists cannot vouch for either way: a button-like control, not already
// judged a commit, whose label is in a script or page language the lists do not cover.
// Such a click is asked about first (commitQuestion). English and the covered languages
// are trusted to the lists, so most clicks cost nothing extra.
const BUTTONISH = new Set(['button', 'clickable', 'menuitem', 'generic', 'img', 'link']);
/**
 * @param {string} label
 * @param {Partial<import('./types.js').SnapElement>} [el]
 * @param {import('./types.js').CommitContext} [ctx]
 * @returns {boolean}
 */
export function doubtful(label, el, { lang, afterSearchFill } = {}) {
  if (!el || NEVER_COMMITS.has(el.role) || !BUTTONISH.has(el.role)) return false;
  if (el.role === 'link' && el.href && !/^javascript:/i.test(el.href)) return false;
  const text = strip(label);
  if (!/\p{L}/u.test(text) || commits(label, el, { afterSearchFill })) return false;
  if (afterSearchFill && SEARCHY.test(text)) return false;
  const base = String(lang || '').toLowerCase().split(/[-_]/)[0];
  if (base && !COVERED_LANGS.has(base)) return true;
  // Letters outside the scripts the lists are written in (Latin, Cyrillic, Han, kana,
  // Hangul, Thai, Arabic, Devanagari): Greek, Hebrew, Bengali, Tamil and so on.
  return /[^\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Arabic}\p{Script=Devanagari}\P{L}]/u.test(text);
}

// The Jev yes/no question for a doubtful control. A yes at 0.5 or more is treated as a commit.
/**
 * @param {Partial<import('./types.js').SnapElement>} el
 * @returns {import('./types.js').JevQuestion}
 */
export function commitQuestion(el) {
  return {
    type: 'noul',
    instructions: `Would clicking the ${el.role || 'control'} named "${String(el.name || '').slice(0, 120)}" on this page complete something consequential (a purchase, payment, order, booking, sending a message, publishing, signing up, or deleting), rather than only opening a page, a form, a menu, a filter or the next step?`,
  };
}

// A button that only opens an ordering or booking flow ("Order now", "Book now", "Reserve a
// table", "Start an order"): it commits nothing until the page is a checkout.
export const ORDER_ENTRY = /^\s*((order|book|reserve|rent|hire)\s+(now|online|here|ahead|today|instantly|a table|a ride|a room|tickets?)|(start|begin|create|new)\s+(an?\s+|your\s+|a\s+new\s+|new\s+)*(order|booking|reservation|cart|basket))(\s+(at|from|for|with|in)\s.*)?\s*$/i;

// Is the page a checkout? Read from structure first (card fields, a payment provider's frame),
// and from the page's own words only as a fallback, in the languages above.
export const CHECKOUT_STATE = `(() => {
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden'; };
  const fields = 'input[autocomplete^="cc-"],input[autocomplete="transaction-amount"],input[name*="card" i],input[id*="card" i],input[name*="cvc" i],input[name*="cvv" i],input[name*="iban" i],input[name*="expir" i]';
  if ([...document.querySelectorAll(fields)].some(shown)) return true;
  if ([...document.querySelectorAll('iframe[src]')].some(f => shown(f) && /pay|checkout|stripe|braintree|adyen|klarna|afterpay|square|recurly|chargebee|worldpay|cybersource|authorize\\.net/i.test(f.src))) return true;
  // The page's own text, not the labels of its buttons and links: a "Complete purchase"
  // button on a product page is not a checkout.
  let text = document.body.innerText || '';
  for (const b of document.querySelectorAll('button,a,[role=button],[role=link],input[type=submit]')) { const t = (b.innerText || b.value || '').trim(); if (t) text = text.split(t).join(' '); }
  return /\\b(order total|subtotal|amount due|total due|total to pay|card number|payment method|billing address|place (your )?order|pay now|complete (your )?(purchase|order|booking)|gesamtsumme|zwischensumme|zahlungsart|total à payer|sous-total|moyen de paiement|importe total|método de pago|forma de pagamento|totale ordine|metodo di pagamento|totaalbedrag|betaalmethode|итого к оплате|способ оплаты|metode pembayaran|tổng thanh toán)\\b|合计|小计|应付|支付方式|お支払い|合計金額|결제 수단|총 결제/i.test(text);
})()`;
