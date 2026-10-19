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
  return /\b(order total|subtotal|amount due|total due|total to pay|card number|payment method|billing address|place (your )?order|pay now|complete (your )?(purchase|order|booking))\b/i.test(text);
}
