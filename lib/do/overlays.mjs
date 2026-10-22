// Overlays during a plan: is a dialog or popup blocking the page, is the step's target inside
// it, and closing it when the plan listed its kind (--dismiss).
import * as ops from '../ops.mjs';
import * as jev from '../jev.mjs';
import { page } from '../page/index.mjs';
import { settle } from './wait.mjs';
import { clip, noul, describeEl } from './context.mjs';
import { newNotices } from './outcome.mjs';

// Controls that are fine for closing an overlay. Anything that commits, signs up, installs
// or buys is never offered; links only when they read as "close" or "not now".
// In the languages the commit guard reads (lib/commit.mjs).
const DISMISS_UNSAFE = /(?<![\p{L}\p{N}])(subscribe|sign ?up|register|join|upgrade|start (a |your )?(free )?trial|get (the )?app|open (in )?(the )?app|install|download|allow|enable|continue|buy|pay|order|add to (cart|bag|basket)|claim|redeem|shop now|learn more|settings|preferences|customi[sz]e|manage|abonnieren|registrieren|herunterladen|installieren|zulassen|erlauben|kaufen|bestellen|einstellungen|weiter|s'abonner|s'inscrire|télécharger|installer|autoriser|acheter|commander|paramètres|continuer|suscribirse|registrarse|descargar|instalar|permitir|comprar|configuración|continuar|assinar|cadastrar|baixar|configurações|iscriviti|scarica|installa|consenti|acquista|impostazioni|continua|abonneren|registreren|downloaden|installeren|toestaan|kopen|instellingen|doorgaan|подписаться|зарегистрироваться|скачать|установить|разрешить|купить|настройки|продолжить|berlangganan|unduh|izinkan|beli|pengaturan|lanjutkan)(?![\p{L}\p{N}])|订阅|注册|下载|安装|允许|购买|设置|继续|ダウンロード|インストール|許可|購入|設定|続行|구독|가입|다운로드|설치|허용|구매|설정|계속/iu;
const CLOSE = 'close|dismiss|no,? thanks|not now|maybe later|later|skip|×|✕|x|schließen|nein,? danke|später|nicht jetzt|fermer|non,? merci|plus tard|cerrar|no,? gracias|más tarde|ahora no|fechar|não,? obrigad[oa]|agora não|mais tarde|chiudi|no,? grazie|più tardi|sluiten|nee,? bedankt|stäng|luk|lukk|zamknij|kapat|закрыть|не сейчас|позже|关闭|以后再说|稍后|閉じる|後で|닫기|나중에|tutup|nanti|đóng|để sau|ปิด';
const CLOSE_WORDS = new RegExp(`^(${CLOSE})$`, 'iu');
const PANEL_CLOSE_WORDS = /^(close|dismiss|×|✕|x|no,? thanks|maybe later)$/iu;
// What closes a notice or coachmark without choosing anything.
export const DISMISS_WORDS = new RegExp(`^(got it|ok|okay|done|understood|verstanden|alles klar|compris|d'accord|entendido|entendi|ho capito|begrepen|понятно|好的|知道了|了解|확인|mengerti|${CLOSE})$`, 'iu');
const NOT_CLICKY = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'select', 'listbox', 'checkbox', 'radio', 'file', 'switch', 'option']);
export const safeToDismiss = (e) => !e.disabled && !e.hidden && !NOT_CLICKY.has(e.role) && (e.name || '').trim() &&
  !jev.commits(e.name, e) && !DISMISS_UNSAFE.test(e.name) && (e.role !== 'link' || CLOSE_WORDS.test(e.name.trim()));

export const blockerQuestion = (next) => noul(
  `Is a dialog, overlay or popup (for example a cookie banner, sign-up or newsletter prompt, app-install prompt) covering the page and blocking it? ` +
  `Answer no when the dialog or panel is what the next step${next ? ` ("${next}")` : ''} works in, and no for small toasts or banners that leave the page usable.`);

// Is the element inside the open dialog or overlay (so acting on it is not blocked by it)?
export async function inOverlay(ctx, el, snap) {
  if (snap?.modal && el.ref && !el.inert) return true;
  if (el.ref) return (await ops.evaluate(ctx.conn, ctx.tab, page('overlay-refs')).catch(() => [])).includes(el.ref);
  if (!el.selector) return false;
  return ops.evaluate(ctx.conn, ctx.tab, page('in-overlay', { selector: el.selector })).catch(() => false);
}

// A blocking overlay: dismiss it when its kind is listed, else stop with its text and
// controls. One Jev request picks the kind and the closing control together.
export async function dismissOverlay(ctx, row, { categories: allowed = ctx.categories } = {}) {
  const { conn, tab, report } = ctx;
  const snap = await ctx.readPage();
  const consent = /cookie|consent/i.test(snap.modal?.name || '') && !/settings|preferences|customi[sz]/i.test(snap.modal?.name || '');
  const automatic = !allowed.length && consent && !row.consentRetried;
  const categories = allowed.length ? allowed : automatic ? ['cookie or consent banner'] : [];
  if (automatic) row.consentRetried = true;
  const inside = new Set(await ops.evaluate(conn, tab, page('overlay-refs')).catch(() => []));
  const controls = snap.elements.filter(e => inside.has(e.ref) && !e.hidden);
  const safe = controls.filter(e => !e.submit && safeToDismiss(e) && (snap.modal || PANEL_CLOSE_WORDS.test(e.name.trim())));
  const text = clip(ctx.view.overlay, 400);
  const blocked = (reason, extra = {}) => ({
    reason: snap.modal ? `${snap.modal.role} "${clip(snap.modal.name || 'unnamed', 80)}" is blocking the page; ${reason}` : reason, overlay: text, controls: controls.map(describeEl).slice(0, 15), ...extra,
  });
  if (!categories.length) return { stop: blocked('A dialog or popup is blocking the page; dismiss it (or pass --dismiss "<kinds>") and re-plan') };
  const criteria = Object.fromEntries(categories.map((c, i) => [`c${i + 1}`, c]));
  criteria.other = 'Something else: none of the listed kinds';
  const questions = { category: { type: 'choice', instructions: 'Which kind of overlay is covering the page?', criteria } };
  const cq = safe.length ? jev.targetQuestion({ elements: safe }, { intent: 'close or dismiss this overlay without agreeing to buy, subscribe, sign up or install anything', action: 'click' }) : null;
  if (cq?.question) questions.control = cq.question;
  let r;
  try { r = await ctx.ask({ page: jev.viewState(ctx.view), task: 'close a popup that blocks the page' }, questions); }
  catch (e) { return { stop: blocked(e.message) }; }
  const cat = r.answers.category;
  const kind = cat?.choice && cat.choice !== 'other' && cat.choice in criteria ? criteria[cat.choice] : null;
  const kindP = cat?.probabilities?.[cat?.choice];
  if (!kind || (kindP ?? 0) < 0.5) return { stop: blocked(`An overlay that is not one of the listed kinds (${categories.join(', ')}) is blocking the page`) };
  const pick = cq?.question ? jev.readTarget(r.answers.control, cq.cands) : { pick: null };
  if (!pick.pick || (pick.p ?? 0) < ctx.minP) return { stop: blocked(`A ${kind} is blocking the page and no safe control closes it`, { category: kind }) };
  await ops.click(conn, tab, { ref: pick.pick.ref, token: snap.token });
  await settle(conn, tab, 'dismiss');
  const ev = { type: 'dismissed', after_step: ctx.lastRow?.step ?? 0, category: kind, text: clip(text, 200), control: describeEl(pick.pick), p: pick.p };
  (row.dismissed ||= []).push(ev);
  report.events.push(ev);
  row.how = `${row.how || ''}${row.how ? ', ' : ''}dismissed ${kind} with ${describeEl(pick.pick)}`;
  const before = ctx.view;
  ctx.view = await ctx.look();
  if (clip(ctx.view.overlay, 400) && clip(ctx.view.overlay, 400) === text) return { stop: blocked(`The ${kind} stayed after clicking ${describeEl(pick.pick)}`) };
  for (const t of newNotices(before, ctx.view)) ctx.notice(row, t);
  return {};
}
