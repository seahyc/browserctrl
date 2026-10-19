// Every wait browserctrl makes on a page, in one place, with why it is that long. Values are
// in milliseconds. Pages run their own timers slowly in background tabs, so all of these are
// measured from here (the CLI or daemon), not inside the page.

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------------ settle ----
// How long to wait for a page to be ready for the next thing, by use. One settle (ops.settle)
// takes these presets; mode picks what "ready" means.
//   loading: nothing on screen looks like loading any more (skeletons, spinners, progress
//            bars), for read and rec, which want the finished page.
//   quiet:   the DOM stopped changing and the page's own requests answered, for do and visit,
//            which want the result of the input they just sent.
export const SETTLE = {
  // Before a read: up to 8 s, polling every 250 ms. Placeholders that hold still for 2 s (4 s
  // while requests are in flight) are decoration; 1 s of only readyState is a stalled pixel.
  read: { mode: 'loading', timeoutMs: 8000, intervalMs: 250, stableMs: 2000, busyStableMs: 4000, quietMs: 1000 },
  // After a step's input: 300 ms without a DOM change, at most 4 s.
  step: { mode: 'quiet', quietMs: 300, maxMs: 4000 },
  // After fill or type: search-as-you-type waits 250-500 ms after the last key before it fetches.
  typing: { mode: 'quiet', quietMs: 700, maxMs: 4000 },
  // A date picker opening or paging a month: it draws fast, and a step waits on it often.
  picker: { mode: 'quiet', quietMs: 250, maxMs: 2000 },
  // A section, list or picker this step opened or closed on its own way to the target.
  section: { mode: 'quiet', quietMs: 250, maxMs: 1500 },
  // After a keyboard pick in a custom list: the list closes and the control redraws.
  keyed: { mode: 'quiet', quietMs: 250, maxMs: 1200 },
  // Before grounding a step again (a redrawn control, a toggle's state read again).
  reground: { mode: 'quiet', quietMs: 300, maxMs: 1500 },
  // After closing an overlay.
  dismiss: { mode: 'quiet', quietMs: 300, maxMs: 2500 },
  // Between reads while waiting for a page's content to fill in.
  content: { mode: 'quiet', quietMs: 300, maxMs: 1500 },
  // A page opened by visit: it has just loaded, give its scripts time to draw.
  visit: { mode: 'quiet', quietMs: 300, maxMs: 5000 },
};

// Inside a quiet settle.
export const QUIET = {
  // How often the CLI asks the page about a request, a load or a navigation it is waiting on
  // (the page cannot be trusted to time itself in a background tab).
  POLL: 80,
  // While the DOM is still changing, the next look is timed for when the quiet window would
  // close, but never sooner than this.
  MIN_WAIT: 20,
  // A navigation during settle: the new document gets this long in all to load and go quiet,
  // and a navigation the page started longer ago than this is taken as one that never came.
  NAV_MAX: 12000,
  // Each probe of the page is short; a page that does not answer is in transition.
  PROBE: 3000,
  // Requests started since the step hold the wait for at most this long (apps poll in the
  // background).
  BUSY_MAX: 2500,
  // A page that never reports complete (endless trackers) is settled once it has been quiet
  // this long and the step is at least AGE_MIN old.
  NEVER_COMPLETE_QUIET: 600,
  AGE_MIN: 800,
  // A request counts as the step's when it began up to this long before the step's settle.
  BEFORE_STEP: 300,
  // A request open longer than this is a long poll or a stream, not a pending render.
  LONG_POLL: 3000,
};

// Inside a loading settle (read).
export const LOADING = {
  // Each probe of the page's loading signals.
  PROBE: 5000,
  // Requests the page started this recently that have not answered are still loading
  // something; one that answered this recently is still being rendered.
  REQUEST_OPEN: 10000,
  REQUEST_DONE: 1000,
};

// --------------------------------------------------------------- content ----
// A single-page app can sit quiet on its empty shell: wait until its text holds still.
export const CONTENT = {
  // A page read for the first time.
  WAIT: 15000,
  // The start of a do plan: a page still on its loading shell.
  PLAN_WAIT: 10000,
  // Between two reads of the text length.
  POLL: 500,
  // A page with fewer characters than this is probably still a shell.
  MIN_CHARS: 200,
};

// ------------------------------------------------------------------ input ----
export const INPUT = {
  // An input event that starts a navigation can lose its acknowledgement from the old page;
  // the next read sees what it did.
  ACK: 6000,
  // A cover over a click target that is only passing (a panel animating after the last
  // click) clears by itself: look again before scrolling.
  COVER_RECHECK: 300,
  // After scrolling a covered target to the middle of the screen.
  AFTER_SCROLL: 150,
  // A target is still once two readings this far apart agree (at most STILL_READS).
  STILL_POLL: 50,
  STILL_READS: 20,
  // A file picker opened by a button: how long to wait for it, and how often to look.
  CHOOSER_WAIT: 5000,
  CHOOSER_POLL: 150,
};

// --------------------------------------------------------------- navigate ----
export const NAV = {
  // A nav step, and the default for navigate and reload.
  TIMEOUT: 30000,
  // A tab that does not answer within this long of a navigation is stuck and is recovered.
  ANSWER: 8000,
  ANSWER_PROBE: 2000,
  ANSWER_POLL: 250,
  // Recovering a stuck tab: each stage answers fast or not at all.
  RECOVER: 6000,
  // How often to read readyState while waiting for a load.
  READY_POLL: 100,
  // Network idle: no new resource entries for this long.
  IDLE: 500,
};

// Recovering a tab, reloading it, and asking whether it is alive.
export const RECOVERY = {
  // Give each recovery stage time to load the replacement document.
  TIMEOUT: 20000,
  // Bound an ordinary reload even when the caller supplies its own deadline.
  RELOAD_MAX: 120000,
  // A CDP call to a tab that may be frozen or crashed: terminateExecution, Page.crash,
  // Page.setWebLifecycleState and the readyState check. Each answers fast or not at all.
  CALL: 3000,
  // Asking a thawed tab to evaluate `1`: a busy page may take a moment, a hung one never answers.
  DIAGNOSE_PROBE: 4000,
  // Reading a tab's address or closing it.
  TARGET_CALL: 5000,
  // The most a Page.navigate to the recovery address may take.
  NAVIGATE_MAX: 10000,
  // After Page.crash: the renderer needs this long to be gone before the address loads again.
  CRASH_SETTLE: 500,
  // A recovered page must still answer this long after it first did (one that wedges again
  // right after loading is not recovered), and is polled this often until it answers.
  STILL_ANSWERS: 1000,
  ANSWER_POLL: 250,
  // Reload: how often to look for the new document's loader id and for new resource entries.
  RELOAD_POLL: 100,
};

// waitFor: the default bound and how often it checks.
export const WAIT_FOR = { TIMEOUT: 15000, POLL: 150 };

// The keyboard walks a custom list at most this many options down (a count, not a time).
export const LIST_WALK_MAX = 80;

// -------------------------------------------------------------------- do ----
export const STEP = {
  // A wait step: its default, and the most a plan can sleep in one step.
  WAIT: 1000,
  WAIT_MAX: 10000,
  // A step that finds nothing settles once more and asks again: this long, and shorter in a
  // repeat loop, where a missing Next button usually means the last page.
  RETRY: 2500,
  RETRY_REPEAT: 1200,
  // A challenge handed to the person: how long they get by default.
  HANDOFF: 300000,
  // The location.href and other one-off probes during a plan.
  PROBE: 3000,
  // A pause after opening a custom list, before typing into it or walking it.
  LIST_OPEN: 300,
  // --show: time for the person watching to read what Jev was shown, and what it answered.
  SHOW_CANDIDATES: 500,
  SHOW_ANSWER: 700,
};

// Screenshot grounding runs only after text grounding cannot act.
export const VISION = {
  CAPTURE_MS: 3000,
  REQUEST_MS: 10000,
  MAX_SIDE: 1568,
  MIN_SIDE: 280,
  MIN_VISIBLE: 0.75,
  MIN_CONFIDENCE: 0.6,
  MAX_AREA: 0.15,
  MAX_ELEMENT_AREA_RATIO: 4,
  MIN_ELEMENT_IOU: 0.2,
  SURE_VISIBLE: 0.9,
  SURE_CONFIDENCE: 0.85,
};

// Reading back what a step did.
export const OUTCOME = {
  // A toggle that reads unticked: web components set aria-checked late, and filter lists
  // redraw unticked until their results arrive. Read again for this long...
  TOGGLE: 2000,
  // ...pausing this long between reads.
  TOGGLE_POLL: 250,
  // A disclosure that did not change yet: one more read after this.
  DISCLOSURE: 400,
  // A picker that animates or fills its field a moment later: one more read after this.
  DATE: 500,
  // An option may update its control after closing the list.
  OPTION: 2000,
};

// Calendars.
export const DATE = {
  // The picker the previous step opened may still be rendering: wait up to this long, in
  // steps of DRAW_POLL, before looking for a control that opens it.
  DRAW: 2500,
  DRAW_POLL: 250,
  // After opening a candidate date control: a short wait for it to draw.
  OPENED: 750,
  // Months a date step pages toward its day at most (a count, not a time).
  MAX_MONTHS: 12,
};

// Sliders moved by keys.
export const SLIDER = {
  // A busy page applies a key a moment late: read again once after this.
  KEY_LATE: 150,
  // The whole key walk, and its press count.
  KEYS_MAX: 12000,
  PRESSES_MAX: 400,
  // Nudging one key at a time near the value, waiting this long for each.
  NUDGE: 300,
};

// ----------------------------------------------------------------- visit ----
export const VISIT = {
  // Pages of one site are started at least this far apart (many at once look like a crawler).
  STAGGER: 500,
  // Each page's load and content wait.
  TIMEOUT: 20000,
  // --show: time to see each page before it is read.
  SHOW: 600,
};
