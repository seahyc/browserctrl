// A covered commit button may sit behind an inline picker. Dismiss only a nonmodal
// picker in the same dialog, with a real click on neutral dialog space; never Escape.
import * as ops from '../ops.mjs';
import { deepQuery, refLookupExpression } from '../refs.mjs';

export async function recoverCoveredClick(ctx, step, row, el, target) {
  if (row.coveredRecovery || step.action !== 'click' || el.role !== 'button' || !/^(save|done|apply|submit|confirm|update|create|continue|finish)\b/i.test(el.name || '')) return false;
  const find = target.selector ? deepQuery(target.selector) : refLookupExpression(target.ref, target.token);
  const point = await ops.evaluate(ctx.conn, ctx.tab, `(() => {
    const target = ${find};
    if (!target || typeof target === 'string' || target.ownerDocument !== document) return null;
    const dialog = target.closest('[role=dialog],dialog,[aria-modal=true]');
    if (!dialog) return null;
    const r = target.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || target.contains(hit)) return null;
    const popup = hit.closest('[role=listbox],[role=menu],[role=tree],[popover],.dropdown,.dropdown-menu,.picker,[class*="picker"],[class*="dropdown"]');
    if (!popup || !dialog.contains(popup) || popup === dialog || popup.matches('[aria-modal=true],dialog,[role=dialog]') || popup.querySelector('[aria-modal=true],dialog[open]')) return null;
    const d = dialog.getBoundingClientRect();
    const points = [[.05,.05],[.95,.05],[.05,.95],[.95,.95],[.5,.05],[.5,.95],[.05,.5],[.95,.5]];
    for (const [px, py] of points) {
      const x = d.left + d.width * px, y = d.top + d.height * py;
      const at = document.elementFromPoint(x,y);
      if (!at || !dialog.contains(at) || popup.contains(at)) continue;
      const control = at.closest('button,input,select,textarea,a,[role=button],[role=option],[role=checkbox],[role=link],[role=menuitem],[onclick],[tabindex],label,[contenteditable=true]');
      if (!control || control === dialog) return {x,y};
    }
    return null;
  })()`);
  if (!point) return false;
  row.coveredRecovery = true;
  await ops.click(ctx.conn, ctx.tab, point);
  row.how = `${row.how ? row.how + ', ' : ''}clicked neutral space inside the dialog to dismiss a covering picker; retried the target`;
  return true;
}
