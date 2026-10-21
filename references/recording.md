# Recording: runs, replay and video, plays, annotation

Part of the [browserctrl skill](../SKILL.md).

## Annotation: point at elements for the agent

```bash
browserctrl overlay <tab> --browser dia   # arm it; the human presses option+A in the page
browserctrl annotations                   # what they marked
browserctrl annotations --consume         # once you have acted on them
```

In annotate mode, hovering outlines elements and clicking one opens a note
field. Each annotation carries the note, the element's role, accessible name,
test id and several selectors, a cropped screenshot, and which tab it was.
Annotating a tab marks it too.

Use `browserctrl annotations` to read the queue, and `--consume` after acting
on it.

When Dia's ordinary tab list omits a dormant tab, or a task needs exact
native-tab selection and grouping, read the [Dia native tab reference](dia-native.md).
It covers adapter capabilities and background-first grouping. Native focus fallback
requires explicit `--allow-focus`; use it only when temporary foreground selection
is within the user's requested scope.

Transport note, because it is not obvious: the overlay hands data back through
a **CDP binding**, not `fetch`. Current Chromium blocks an HTTPS page from
calling loopback (Local Network Access), so an HTTP bridge call from a real
site silently hangs. The extension path uses its background worker instead,
which is exempt.

## Recording a play

```bash
browserctrl record arm --browser dia      # optional: opens the capture device now, so
                                  # `start` is instant and the first ~2s are on film
browserctrl record start --browser dia --video --label "shortlist flow"
# ... drive the browser, and anything else on screen ...
browserctrl record stop
browserctrl recording <id> --steps        # readable steps with element identity
browserctrl annotate <id> --browser dia   # opens the annotator page (its URL carries the bridge token)
browserctrl recording <id>                # marks resolved to real events
```

The annotator, the tray and the recording API are served by a local bridge that needs a
per-install token. The CLI prints URLs that already carry it; open those rather than typing the
address. The extension is trusted by its fixed id, so an extension loaded before that id was
fixed must be removed and loaded again.

`record arm` is opt-in on purpose: an armed capture writes video continuously
whether or not you ever record. `browserctrl record status` says whether one is warm,
`browserctrl record disarm` stops it.

Three layers on one clock: browser events with element identity, an optional
screen video, and a frontmost-app sample each second so time spent outside the
browser is still legible. A mark at 0:42 comes back as "click on button
'Confirm and apply' [data-testid=wb-confirm]", not as a frame number.

## Recording a run to watch later

`record` above captures a person's play across the browser. To keep an agent's run
on one tab, small enough to keep every run, use `rec`:

```bash
browserctrl rec start <tab> --browser dia [--out DIR] [--label L]   # until stopped, across navigations
# ... drive the tab with any browserctrl command ...
browserctrl rec stop <tab> --browser dia      # prints the directory and its size
browserctrl replay DIR                        # one self-contained HTML: DOM replay + step timeline
browserctrl replay DIR --video run.mp4 --gif run.gif   # real-time video: plain-words captions, clock, "Thinking…" gaps
browserctrl replay --side-by-side DIR_A DIR_B --labels "Without,With" --video ab.mp4 --gif ab.gif   # one clock, "Done in m:ss"
```

A recording is rrweb DOM events (`rrweb.ndjson.br`, brotli) plus one 1280-px JPEG
still per action (`trajectory/`, listed in `steps.jsonl`). Every acting command (and
`do`, per step) takes a still after waiting (up to 4 s) for the page to stop loading;
`read`, `text` and `items` add one when the page changed since the last still (address,
title or visible text). End a recorded task with one `read` so the final state is
captured. A 13-step
PyPI run came to 0.74 MB: 170 KB of events and 560 KB of stills. Stills show what DOM
replay cannot: canvas and cross-origin iframes. Videos are rendered in a private headless Chrome by seeking the
replay to each frame's time, so they keep the run's real timing however busy the machine
is; frames that did not change cost nothing. Pages load their images from the live site
during rendering: if the run went through a proxy (a geo-blocked site), pass the same one
with `--proxy socks5://…` (or `BROWSERCTRL_VIDEO_PROXY`). The GIF is sped up 4× by
default (`--gif-speed`) and kept under 8 MB; the MP4 stays real-time. Needs ffmpeg. The Online-Mind2Web judge input is made by
`node bench/om2w/export.mjs <recording dir> <out dir> --task-id ID --task "…" [--answer "…"]`,
which lives with the benchmark and is not part of the CLI. Recordings go to the data folder
(`browserctrl where`), capped at 1 GB in total. The bench harness records every run into `bench/runs/<run>/rec/`.

When a recorded `do` plan opens its own background tabs for item loops or candidate attempts, their DOM events and stills are saved as child tracks in the same recording. Replay and video follow the active tab, with an item or attempt label and host in the header, then return to the source. Child recording stops before a tab closes and when the plan ends; unrelated tabs are never recorded.
