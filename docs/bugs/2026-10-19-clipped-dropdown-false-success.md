# Dropdown click reports success when the option is clipped by its scroll container

## Summary

`browserctrl do` can click a container behind a clipped dropdown option and report success. The role picker keeps its previous value. In a GitLab membership workflow, an invitation submitted after a reported Developer selection created Guest memberships instead.

The diagnostic reproduction confirms the wrong-target click in the membership role editor. The original invitation failure was observed, but its exact cause remains unconfirmed. A later invitation-picker test succeeded.

## Environment

- Observed on 2026-10-19 using the signed-in Dia session and `--browser dia`.
- Repository HEAD at investigation: `91caf2ec8cc7fe0a180cae3325fd207fbec47bd4`.
- Installed CLI resolves through `~/.agents/bin/browserctrl` to `~/.agents/skills/browserctrl/bin/browserctrl.mjs`. The skill directory links to this repository.
- Browser viewport: 1908 × 995 CSS pixels.
- Site: `https://gitlab.glints.com/groups/glints/-/group_members`.
- Component: GitLab role details drawer, custom combobox with `li[role=option]` entries and an internally scrolling `ul`.

## Confirmed reproduction

Use an existing Developer membership. Do not save role changes during diagnosis.

1. Open the member's role details drawer by clicking its Developer button.
2. Open the Developer combobox. GitLab scrolls the list toward the selected option.
3. Inspect the Guest option, which is above the scroll container's visible area.
4. Run the following command against that tab:

```sh
browserctrl --browser dia do <tab> 'click "[data-testid=listbox-item-GUEST]"'
```

Observed output:

```text
✓ 1. click "[data-testid=listbox-item-GUEST]" → option "Guest No code access. View and comment on issues and epics." (selector)

changed on the page:
  combobox "Developer": open → closed
  − 8 gone: option ...
```

The role remained Developer. Closing the dropdown was an outside click, not a successful selection.

### Geometry captured before the click

| Element | Top | Bottom | Other state |
| --- | ---: | ---: | --- |
| Guest option | 253.992 | 303.992 | x=1468, width=385, height=50 |
| Dropdown `ul` | 398.992 | 670.992 | overflow=auto, scrollTop=201, clientHeight=272, scrollHeight=502 |

The option's rectangle is inside the browser viewport but outside the dropdown's visible scroll area. `document.elementFromPoint(1660.5, 278.992)` returns the drawer's Account container, not the option.

The hit container's `contains(option)` returned `true`. The option's `contains(hit)` returned `false`.

### Captured input events

Before the click, a temporary capture listener recorded `pointerdown`, `mousedown`, `mouseup`, and `click` on `document`. All four events had:

```json
{
  "x": 1661,
  "y": 279,
  "trusted": true,
  "target": "<div><h5 class=\"gl-mr-6\">Account</h5> ...</div>"
}
```

`event.target.closest('[role=option]')` returned no option. This confirms that real pointer events hit the wrong element. It is not merely a stale text snapshot or an incorrect model choice.

Capture equivalent evidence with this page expression before clicking:

```js
window.__roleProbe = [];
for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
	document.addEventListener(type, event => {
		window.__roleProbe.push({
			type,
			x: event.clientX,
			y: event.clientY,
			trusted: event.isTrusted,
			target: event.target.outerHTML.slice(0, 400),
			option: event.target.closest('[role=option]')?.getAttribute('data-testid'),
		});
	}, true);
}
```

Read `window.__roleProbe` after the command. Close the drawer without saving and reload the page to remove these temporary listeners.

## Source references and diagnosis

Line numbers below refer to the inspected HEAD.

1. [`IN_VIEW_POINT`, `lib/steps.mjs:309-319`](../../lib/steps.mjs#L309) checks the browser viewport, not ancestor scroll clipping. Line 318 accepts either `el.contains(hit)` or `hit.contains(el)`. The latter accepts the Account container as a valid hit for its clipped descendant.
2. [`clickSel`, `lib/steps.mjs:1050-1052`](../../lib/steps.mjs#L1050) passes the returned coordinates directly to `ops.click`. This skips the slower reference-resolution path when the fast path incorrectly accepts the point.
3. [Reference resolution, `lib/refs.mjs:998-1005`](../../lib/refs.mjs#L998) scrolls when the element is outside the browser viewport. An option clipped by an ancestor can still pass this check.
4. [`owns(hit)`, `lib/refs.mjs:1056-1061`](../../lib/refs.mjs#L1056) also accepts `hit.contains(el)`. Fixing only the `do` fast path leaves the same broad ancestor acceptance in the shared resolver. Earlier in this session, a standalone click by ref also failed to select Developer.
5. [Click outcome setup, `lib/steps.mjs:1628-1633`](../../lib/steps.mjs#L1628) verifies checkbox and radio state, but explicitly excludes ordinary options from the checked-state path. A click on an option can therefore receive a success marker without a selection change.
6. [`click`, `lib/ops.mjs:508-520`](../../lib/ops.mjs#L508) returns click coordinates after dispatching mouse events. That result does not prove the intended element received the event or the application accepted the choice.

The confirmed mechanism is clipped geometry plus overly broad hit acceptance plus missing selection verification. The reproduced failure does not require a moving element, stale model choice, or network failure.

## Original workflow and limits of the evidence

The original invitation selected three existing accounts, opened Role Guest, then ran:

```sh
browserctrl --browser dia do <tab> 'click "Developer"' 'click! "Invite"'
```

The report identified the Developer option with `jev p=0.99` and GitLab displayed `Members were successfully added.` Subsequent member-page reads showed Guest for all three accounts.

In the correction workflow, ordinary clicks in the role editor also failed. Calling the exact option's DOM `.click()` selected Developer and revealed Update role:

```js
document.querySelector('[data-testid=listbox-item-DEVELOPER]').click();
```

Saving Update role then produced `Role was successfully updated.` and displayed Developer for each account. All three memberships were corrected.

The later diagnostic test of the invitation picker, with no recipients selected, successfully selected Developer through `do`. Its option center was just outside the list's visible bottom edge, but the shared resolver found a visible point at y=517. This test did not recreate the original three-recipient layout, so it does not settle the original invitation failure's cause.

DOM `.click()` is a diagnostic workaround, not the proposed default. It bypasses pointer hit-testing and can activate options a user cannot currently click.

## Expected behavior and suggested verification

The command should scroll the dropdown's own container to expose the requested option, click an actual visible part of that option, and confirm selection. If it cannot do so, it should stop before the next commit step.

Suggested regression coverage:

- A fixture with an internally scrolling listbox and an option clipped above the list but still inside the browser viewport. Reproduce the Account-container ancestor relationship.
- The equivalent case clipped below the list, including partial visibility.
- Both `do` selector clicks and shared ref clicks. Record the actual event target, not just the command result.
- A fully visible option still selects successfully.
- A failed option selection prevents the following submit step from executing.
- Existing label, shadow DOM, and slotted-control handling remains valid when tightening ancestor hit acceptance.

Do not implement selection verification solely as dropdown closure. The reproduced wrong-target click closed the dropdown while keeping the previous role.

## Investigation state

No source code was changed and no regression tests were added. Diagnostic dialogs were cancelled, and the page was reloaded to clear temporary listeners. No permissions were saved during diagnosis.
