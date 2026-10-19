// Whether the page is a checkout: card fields, a payment provider's frame, or an amount to
// pay. Read from structure first, and from words only as a fallback.
() => {
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden'; };
  const fields = 'input[autocomplete^="cc-"],input[autocomplete="transaction-amount"],input[name*="card" i],input[id*="card" i],input[name*="cvc" i],input[name*="cvv" i],input[name*="iban" i],input[name*="expir" i]';
  if ([...document.querySelectorAll(fields)].some(shown)) return true;
  if ([...document.querySelectorAll('iframe[src]')].some(f => shown(f) && /pay|checkout|stripe|braintree|adyen|klarna|afterpay|square|recurly|chargebee|worldpay|cybersource|authorize\.net/i.test(f.src))) return true;
  // The page's own text, not the labels of its buttons and links: a "Complete purchase"
  // button on a product page is not a checkout.
  let text = document.body.innerText || '';
  for (const b of document.querySelectorAll('button,a,[role=button],[role=link],input[type=submit]')) { const t = (b.innerText || b.value || '').trim(); if (t) text = text.split(t).join(' '); }
  // In the languages the commit guard reads (lib/commit.mjs).
  return /\b(order total|subtotal|amount due|total due|total to pay|card number|payment method|billing address|place (your )?order|pay now|complete (your )?(purchase|order|booking)|gesamtsumme|zwischensumme|zahlungsart|total à payer|sous-total|moyen de paiement|importe total|método de pago|forma de pagamento|totale ordine|metodo di pagamento|totaalbedrag|betaalmethode|итого к оплате|способ оплаты|metode pembayaran|tổng thanh toán)\b|合计|小计|应付|支付方式|お支払い|合計金額|결제 수단|총 결제/i.test(text);
}
