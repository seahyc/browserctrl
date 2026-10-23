# browserctrl

[![Tests](https://github.com/seahyc/browserctrl/actions/workflows/test.yml/badge.svg)](https://github.com/seahyc/browserctrl/actions/workflows/test.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

browserctrl gives an AI agent a better pair of hands for websites. It's meant for the annoying sites: filters that hide inside drawers, calendars, sliders, little checkboxes, and fine print you only see after three clicks.

I tested it the only way I trust: same AI, same task, same browser, once with Codex's own built-in browser and once with browserctrl. Here's Kaggle, a site browserctrl had never been tuned on. The task was "find the ongoing competition with the highest prize, and the code that got the most votes in it". Codex's own browser is on the left and took 3 min 25 s. Codex with browserctrl is on the right and took 1 min 40 s.

![Codex using its own browser (left) and Codex with browserctrl (right) on the Kaggle task, at 4x speed](docs/media/kaggle.webp)

*4x speed, startup cut. A green caption marks the one step where Jev picked the control: the agent wrote "Code" and Jev chose the tab "Code, 3 of 7". [Real-time video](https://seahyingcong.com/browserctrl/media/kaggle.mp4).*

Over 21 hard tasks on 17 sites it had never seen, it got as many right as Codex's own browser, and was faster on most of them:

| 21 hard tasks, 17 unseen sites | Codex's own browser | Codex + browserctrl |
| --- | --- | --- |
| Tasks done right (checked by hand) | 17 | 18 |
| Total time on the 15 tasks both got right | 45.8 min | 40.0 min |
| Median task | 2 min 48 s | 2 min 20 s |
| Faster on | 6 of 15 | 9 of 15 |
| Tokens read | 17.7 million | 11.9 million |

Both sides used the same model (`gpt-6.1-sol` at low reasoning), the same browser and the same machine, one try each. It's a small sample, and below I go through [how I kept it fair](#keeping-it-fair), [the runs it lost](#the-runs-it-lost) and [every single run](docs/results/om2w-2026-10.runs.md).

## What it does

The AI writes a short plan, like *open Filter, pick size M, pick Black, show the results*, and browserctrl carries out all of it in one go. Codex's own browser does one click per turn, and each turn means reading the page again and thinking for a few seconds. Most of the time saved comes from that.

After the plan runs, browserctrl tells the AI what changed: "Results: 51 items → 3 items", "Black: now ticked". So the AI can answer without reading the whole page again.

It checks its own work. If a box didn't tick, a section didn't open or the page shows an error, it stops there and says so, instead of carrying on three steps later as if all was fine. When it's unsure it picked the right button, it says that too.

It won't press buttons that look like they spend money or send something (Buy, Pay, Book, Send, Place order, Delete, and so on) unless the plan marks that step on purpose. To be clear about how that works: it's still a word list, now covering about 20 languages, plus some page structure. Ticking, choosing and following a link never count, and the submit button of a checkout form always does. A button whose label is in a script or language the list doesn't cover goes to Jev as a yes/no question before it's clicked. So it can miss a button with an unusual label, and it sometimes blocks a harmless "Submit" on a quiz.

For sites it already knows, a *recipe* skips the clicking and asks the site's own API. A whole Shopee order history comes back in about 7 seconds that way.

It doesn't record a run unless you ask. A recording is about 1 MB for 3 minutes and replays as a video, which is how every clip on this page was made. It does keep a short log of each plan, capped in size, so you can see later what a plan did.

## More runs, on very different sites

I picked these to cover different kinds of sites, including two where browserctrl lost. Each one is a real benchmark run, with Codex's own browser on the left and browserctrl on the right, on one shared clock, shown at 4x with the agent's startup cut. Captions on the right describe each browserctrl step, and they turn green when Jev picked the control. Codex's own browser leaves no log of its steps, so its side has no captions.

**League of Legends.** "Browse the final skin in the list for the champion Ahri." Own browser 3:37, browserctrl 1:19.

![League of Legends side by side, 4x speed](docs/media/leagueoflegends.webp)

*4x speed, startup cut. No step needed Jev here: every control the agent named exists by that name. [Real-time video](https://seahyingcong.com/browserctrl/media/leagueoflegends.mp4).*

**WebMD.** "Find the best audiologist within 50 miles of New York, NY, with a rating of 4 and above." Own browser 2:48, browserctrl 1:02.

![WebMD side by side, 4x speed](docs/media/webmd-doctors.webp)

*4x speed, startup cut. No step needed Jev: every control was named exactly. [Real-time video](https://seahyingcong.com/browserctrl/media/webmd-doctors.mp4).*

**Stanford.** "Browse the class schedule of graduate-level chemistry courses on Monday afternoons in the winter of 2023." Own browser 3:28, browserctrl 2:01.

![Stanford side by side, 4x speed](docs/media/stanford.webp)

*4x speed, startup cut. No step needed Jev: every control was named exactly. [Real-time video](https://seahyingcong.com/browserctrl/media/stanford.mp4).*

**Google Maps.** "Find the top-rated hotel in Manhattan, NY, suitable for 4 guests, and identify the fastest public transportation option from the hotel to LGA airport." Own browser 5:55, browserctrl 3:42.

![Google Maps side by side, 4x speed](docs/media/googlemaps.webp)

*4x speed, startup cut. Jev picked 3 controls (the green captions), among them "Sort by" and "Guest rating"; the rest were named exactly. [Real-time video](https://seahyingcong.com/browserctrl/media/googlemaps.mp4).*

### The runs it lost

**Chase.** "How much can I have in my 401(k) at retirement, working from 22 to 65, at 3% a year, with $8,000 from me and $8,000 from my employer every year?" Own browser 2:24, browserctrl 4:50.

![Chase side by side, 4x speed](docs/media/chase.webp)

*4x speed, startup cut. No step needed Jev; the time went into the sliders, below. [Real-time video](https://seahyingcong.com/browserctrl/media/chase.mp4).*

The calculator is five sliders drawn inside web components, and browserctrl's slider command couldn't see inside those, so the AI ended up pressing arrow keys one at a time. I fixed that afterwards. The same five settings now take 4 seconds in one call.

**FlightAware.** "Find United or American flights from London to New York that arrive between 8 and 11 PM." Own browser 2:32, browserctrl 5:05.

![FlightAware side by side, 4x speed](docs/media/flightaware.webp)

*4x speed, startup cut. Jev picked 3 controls (the green captions), among them the airport suggestions "New York, NY / All Airports" and "London, England, UK / All Airports". [Real-time video](https://seahyingcong.com/browserctrl/media/flightaware.mp4).*

The airport boxes suggest matches as you type, and the AI spent several plans getting London and New York to stick. Then it struggled with the airline and arrival-time filters, until it typed the filtered web address directly.

Two more browserctrl runs ran out of their 15 minutes: Statista, on a greyed-out Apply button, and Steam, on a playtime slider that the `set` command couldn't reach. Steam's is fixed now and takes one step. arXiv also answered "Rate exceeded" to one run.

Codex's own browser lost the same Statista task, plus three more to its own safety rules. It refused to open BabyCenter at all, twice, and it refused to press "I agree" on YouTube Kids.

## Where Jev comes in

browserctrl uses two models. The AI agent, Codex in these tests, plans, reads results and decides when the task is done. Jev is a small, fast model that answers one narrow question: given a page and a list of its controls, which control does this step mean? It answers in about a third of a second.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/how-jev-fits-dark.svg">
  <img alt="The agent writes a plan; for each step browserctrl reads the page, acts at once when a control is named exactly, and otherwise asks Jev which control the step means; it acts, flags or stops depending on Jev's confidence, checks the result, and sends one report back" src="docs/media/how-jev-fits-light.svg" width="860">
</picture>

Jev gets a few lines of text, with no screenshot. Below is the exact input from one real step: the agent wrote `click "Sort by"` on Google Maps, and Jev got the page's address, title, visible text and its 57 clickable controls by role and name. It put 99% on the right button, in 340 ms.

![The exact text Jev was given for one step on Google Maps, and its answer: 99% on button "Sort by" in 340 ms](docs/media/jev-card-googlemaps.png)

Here's what that looks like while it runs. browserctrl can draw on the page as it works: every control Jev was offered gets a numbered box, its pick gets a red outline, and a panel in the corner logs each step. Steps the agent named exactly say "exact name match, no model call". At each Jev call the clip stops on the card, so you can read what went in and what came out.

![Jev choosing controls on Google Maps: the page at 4x, pausing on each call to show what Jev was given and what it answered](docs/media/jev-googlemaps.webp)

*4x speed. At each Jev call the clip pauses on what Jev was given and what it answered. [Real-time video](https://seahyingcong.com/browserctrl/media/jev-googlemaps.mp4).*

On Uniqlo, one plan picked men's blazers, size M, in black. Five of its seven steps named a control exactly and needed no model. Jev picked "Filter" (the button is actually called "Filter 1") at 94%, and "View results" (the button says "VIEW ITEMS (3)") at 97%. The report ended with "Results: 51 items → 3 items" and the new heading "Men's Blazers (M, BLACK)", which was everything the agent needed.

![A seven-step plan on Uniqlo at 4x, pausing on the two steps Jev resolved](docs/media/jev-uniqlo.webp)

*4x speed, pausing on the two Jev calls. [Real-time video](https://seahyingcong.com/browserctrl/media/jev-uniqlo.mp4).*

Across 95 browserctrl runs in this benchmark, agents wrote 926 plans. About 3 steps in 4 named a control exactly and went straight through. About 1 in 4 needed Jev, for names an agent can't know in advance: "Filter 1", "VIEW ITEMS (3)", or a YouTube Kids age card whose real name is "Younger. Ages 5 to 8. Hit Enter to select." Jev's typical confidence was 98%. About 1 pick in 9 came in under 75%, and browserctrl still acts on those but marks them ⚠ so the agent checks. When nothing fits, it stops and lists the closest controls instead of guessing.

Exact matches are cheaper than asking Jev, so I try to make more of them. Google's "Sort by" button is really named "Sort by" plus an icon character, and that one invisible character sent the step to Jev. browserctrl now ignores icon characters, so that step needs no model at all.

### Why not let Jev drive?

That was the first thing I tried. In an earlier benchmark I gave Jev whole tasks, like filtering a search, opening a chat or adding an item to a cart, and let the agent finish whatever Jev left. Over 21 runs on 7 tasks, Jev finished none of them. It would make 1 to 7 moves and then stop at the first control outside what it was allowed to do: a sort menu, a filter, a chat button, even an "Add to cart" it had been given permission for. On pages that change as you use them it looped, retrying 30 times on one Shopee search without acting. And it doesn't read, while most of an agent's time goes into reading results and checking the answer. So the agent read everything anyway, and Jev was never 30% faster on any task, which was the bar I set before running.

Then I flipped it around. The agent plans and reads, and Jev only picks the control each step means, inside browserctrl. Under the same rule, that won 5 of the same 7 tasks. Each win was a chain of clicks and fills that used to cost the agent one turn per step, and the 2 ties were tasks that are mostly reading one list. In a later round on 6 new sites, plans were never less accurate. They lost where the page has a web address the agent can guess, like a Hacker News item or a Stack Overflow tag, because going straight there beats any clicking. The details are in [bench/RESULTS.md](bench/RESULTS.md).

My takeaway: a small fast model is very good at a narrow question where every possible answer is listed, like "which of these 57 controls is 'Sort by'?". It's poor at open questions like "what should happen next, and are we done?". So each model gets the question it's good at.

### Reading answers off a page

A plan can also read. `extract "the latest Python version" as $py` asks Jev which line of the page answers the question, and binds that line exactly as the page shows it. `answer "${py}"` fills a template from what was bound. Here is the same five-step plan with the code from before this round (left) and now (right):

![The same plan run twice on one clock: on the left the old code stops at step 2 on python.org because no line clearly answered; on the right the new code reads "Download Python 3.15.0", reads 40300 from "40.3k forks" on GitHub, and answers in 7 seconds](docs/media/extract-before-after.webp)

*Real time. The left run stopped because Jev's vote split between "Python 3.15.0" and "Download Python 3.15.0", the same version said two ways. Lines that say the same value now pool their vote. [Video](https://seahyingcong.com/browserctrl/media/extract-before-after.mp4).*

A wrong answer is worse than no answer, so extraction stops whenever it isn't sure, and a stop says which lines it saw and how close they came. To measure that, [bench/extract-eval](bench/extract-eval/README.md) asks 37 questions on public pages: GitHub stars, forks, languages, licenses and release tags, Wikipedia facts in English, German, French, Japanese and Chinese, the current Python and npm versions, a price, questions asked in Chinese and Spanish, paraphrases, and two questions whose answer isn't on the page. Each expected answer is read independently from the page before Jev runs, and any wrong binding fails the whole run.

The page doesn't have to be in the question's language. Here the question is in English and the page is German Wikipedia:

![The same plan on German Wikipedia's Singapore page, run twice on one clock: on the left the older code reads the population with the footnote marker still attached and then stops on the currency; on the right the current code reads "Einwohnerzahl: 5.640.000 (2025)" and "Singapur-Dollar" and answers in 5 seconds](docs/media/xlang-before-after.webp)

*Real time. Table and infobox rows now get a share of the lines offered to Jev whatever the question's language, numbers and dates are read in the page's own format (5.640.000, 1965年8月9日, 9. August 1965), and footnote markers stay out of values. [Video](https://seahyingcong.com/browserctrl/media/xlang-before-after.mp4).*

| 37 cases | Correct | Wrong answer | Stopped though the answer was there | Couldn't load |
| --- | ---: | ---: | ---: | ---: |
| Headless Chrome, before the cross-language work | 17 | 0 | 15 | 3 |
| Headless Chrome, now | 27 | 0 | 6 | 2 |
| Dia, signed in, now | 27 | 0 | 7 | 1 |

Earlier, on the first 27 of these cases, a normal Chrome window with a fresh profile scored 17 against Dia's 19, within the run-to-run noise of about two answers, so nothing here depends on Dia. Headless Chrome is treated as a bot by some sites: npm shows it a "Just a moment..." check.

None of the reported runs bound a wrong answer. Experiments during the work bound four, and were changed before they shipped: Node's 122,500 stars read as 123000 from the rounded "123k" on a button, and three answers that carried extra text along with the right value ("Capitale: Paris 48° 52′ N…", "v1.64.1 Latest Oct 14", and a Node release title with its date). What still stops most often: some GitHub star counts, Singapore's founding and independence dates, and a price written as "$0 USD per user/month".

## Keeping it fair

The tasks come from [Online-Mind2Web](https://github.com/OSU-NLP-Group/Online-Mind2Web), a public test of AI agents on real, live websites. I used only its hard tasks, the ones most published agents (OpenAI Operator, Claude Computer Use, Browser Use and others) get wrong.

I split the tasks by website with a fixed random seed into sites I could study and fix against, and sites I couldn't ([splits.json](bench/om2w/splits.json), [split.py](bench/om2w/split.py)). The 21 final tasks came from the second group and were run once. Every fix on this page that mentions those sites was made after that run.

The only difference between the two sides was the tool. Same model and settings, same browser (Chrome for Testing on New York time), same machine, cookies cleared before each run, and the same screenshots recorded for both. This took me a while to get right. In early rounds browserctrl carried extra settings on every command and waited on its own screenshots, and it looked slower than it was.

I also used only websites that load directly from Singapore. Through a VPN, about a third of runs never got past a Cloudflare check ([access.json](bench/om2w/access.json)).

The benchmark's automatic judge grades from screenshots, and it made a lot of mistakes. On the final set it passed 11 browserctrl runs and 10 native runs, and failed 14 runs whose own logs show the task was done. Usually the screenshot had caught a page still loading. Once, it passed one side and failed the other on the same evidence. It never passed a run that was wrong. So I re-checked all 42 runs against their logs ([handcheck.json](bench/om2w/handcheck.json)). Three of my calls are debatable: both WebMD runs read "best" as best-rated, and one arXiv run skipped a sort the judge wanted. Counting those three as failures makes it 17 to 15.

Two problems outside the methods got their runs redone, and I marked them. Codex's own browser tool stopped responding for about 20 minutes, so three of its runs were redone. I redid one browserctrl run because a test I ran on the same machine restarted its background process mid-run. Both versions of each are in [the run list](docs/results/om2w-2026-10.runs.md).

## Earlier rounds

Before the final set, I took 13 hard tasks and ran them in rounds. Each time, I watched where browserctrl got in the way, fixed that, and ran them all again. Tasks done right went from 5 of 13 to 10 of 12. These are the sites the fixes were made on, so treat them as a picture of what fixing can do on familiar sites.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/rounds-dark.svg">
  <img alt="Hard tasks done right: 5 of 13 in round 1, 8 of 13 in round 2, 8 of 12 in round 3, 10 of 12 in round 4" src="docs/media/rounds-light.svg" width="720">
</picture>

On those same sites, against Codex's own browser:

| Task | Codex's own browser | Codex + browserctrl |
| --- | --- | --- |
| Booking.com package, New York to San Francisco | 5:03, 33 actions, 3.7M tokens | 3:10, 18 actions, 1.1M tokens |
| StubHub: NHL games in Boston | 2:12, 12 actions, 0.69M tokens | 1:56, 11 actions, 0.60M tokens |
| Airbnb: Cleveland, 3 nights, kids, a pet, parking, washer, gym | 2:21, 17 actions | 3:43, 26 actions |
| The same Airbnb task after fixes | ran out of its 15 minutes | 2:40, 17 actions |

The Booking.com run:

![Booking.com side by side, 4x speed](docs/media/booking.webp)

*4x speed, startup cut. Jev picked 5 controls here (green captions). [Real-time video](https://seahyingcong.com/browserctrl/media/booking.mp4).*

And the first Airbnb run, where browserctrl lost. Its clicks scrolled the page a little, and Airbnb hides its search bar whenever the page scrolls.

![The first Airbnb run side by side, 4x speed](docs/media/airbnb.webp)

*4x speed, startup cut. [Real-time video](https://seahyingcong.com/browserctrl/media/airbnb.mp4).*

Three held-out rounds on fresh sites came before the final set, and I studied and retired each one. That's where most of the lessons on this page came from: my test setup was slowing browserctrl down, many failures were websites blocking automated browsers, and the automatic judge makes mistakes. Once the setup was fixed, round 3 already showed the two sides close on accuracy, with browserctrl a little faster (6 of 6 tasks in 11.5 minutes, against 6 of 6 in 13.1).

I also tried letting browserctrl keep notes about how each site works, for the next AI that visits. It didn't help yet. On 8 new tasks on sites it had explored, runs with notes passed 7 and runs without passed 8, in about the same time. The new tasks mostly used parts of each site the notes didn't cover.

## Things I learned the hard way

Graders need the run's own evidence. A third of the final runs were graded wrong from screenshots alone, and a run's own log of what it set and what the page said back settled almost every dispute in seconds.

Codex's built-in browser has rules of its own. It refused BabyCenter outright and refused a consent button on YouTube Kids. A tool that drives an ordinary browser doesn't hit those walls, which also means more of the responsibility sits with you.

Small mismatches cost minutes. An icon character in a button's name, a sticky bar covering the first of three "Blazers" tabs, sliders hidden inside components, a filter panel that closes when the mouse leaves it. Each one turned a one-step action into several agent turns, and each fix was a few lines.

Most of the time goes to the agent thinking. Across the final set, browserctrl's `do` plans took under a fifth of its total run time. What actually speeds a run up is fewer and smaller turns: a whole plan in one call, and a short "what changed" report instead of a full page read.

## Try it

Copy and paste this into your coding agent:

> Please install browserctrl (`@seahyc/browserctrl` on npm, source at https://github.com/seahyc/browserctrl). Read its instructions, check my operating system and Node.js version, and set up the CLI and an optional agent skill. Tell me what you configured. Ask which browser I want to use, and get my permission before enabling browser access or restarting any browser. Tell me what data browserctrl sends out and stores before you turn anything on. Verify setup on a disposable test page, then show me how to use and uninstall it.

To set it up yourself, the steps are: install it, turn on remote debugging in one browser, then connect your agent.

### 1. Install

browserctrl needs [Node.js 22 or newer](https://nodejs.org/) on macOS, Linux or Windows. It checks this when it starts.

```sh
npx -y @seahyc/browserctrl browsers     # try it without installing
npm i -g @seahyc/browserctrl            # or install the browserctrl command
```

The package is not on npm yet. Until it is, install from a clone:

```sh
git clone https://github.com/seahyc/browserctrl.git
cd browserctrl
npm ci
npm link                                # puts browserctrl on your PATH
browserctrl help
```

`browserctrl where` prints the install folder and the folders where browserctrl keeps its data, config, state and runtime files. On macOS that is `~/Library/Application Support/browserctrl`, on Linux the XDG data, config and state folders, and on Windows `%LOCALAPPDATA%` and `%APPDATA%`. `BROWSERCTRL_HOME=<folder>` puts everything in one folder. Every setting is listed in [references/settings.md](references/settings.md).

### 2. Turn on remote debugging in a browser

browserctrl talks to Chromium browsers (Chrome, Dia, Brave, Edge, Chromium, Arc) over their debugging port, and to Safari 27 or later through Apple's automation interface. It never picks a browser for you: run `browserctrl browsers` to see which are ready, then name one with `--browser <name>` or set `BROWSERCTRL_BROWSER` once. There are two ways to get a debugging port.

- **Your normal Chrome, on any OS:** open `chrome://inspect/#remote-debugging` and switch the toggle on. Chrome asks you to allow each new connection.
- **A separate profile, on any OS:** `browserctrl launch chrome` starts a separate Chrome with its own empty profile and the debugging port on (on macOS add `--user-data-dir <folder>`). On Linux and Windows this is how `launch` always works, and it never touches a browser you already have open. By hand, it is the same as running the browser with `--remote-debugging-port=9222 --user-data-dir=<a new folder>`, then using `--port 9222`. Sign in inside that profile if you need to.
- **macOS, other browsers:** `browserctrl launch dia` (or `brave`, `edge`, `chromium`, `arc`) quits that browser and reopens it with the port on, so only run it when you are happy to restart it. Chrome 136 and later refuses a debugging port on its real profile, so use the toggle or `--user-data-dir` there.
- **Safari:** enable Settings > Advanced > Show features for web developers, then Settings > Developer > Allow remote automation and external agents. browserctrl does not enable this for you.

### 3. Connect your agent

Put `browserctrl` on PATH using the install steps above. Any agent that can run terminal commands can use it. Check that the agent can run `browserctrl help`.

**Agent skill.** Harnesses that load a `SKILL.md` need the package folder in their skills folder under the name `browserctrl`. A link or a copy both work. For example, Claude Code reads `~/.claude/skills`, and Codex and some other harnesses read `~/.agents/skills`:

```sh
ln -s "$(npm root -g)/@seahyc/browserctrl" ~/.claude/skills/browserctrl
```

From a clone, link the clone's folder instead. [SKILL.md](SKILL.md) is the short guide the agent reads, and it points at [the references](references/) when a task needs more. On Windows, copy the folder or use a junction.

**Python:** `pip install ./python` from a clone gives the `browserctrl` package. It starts a Node sidecar, so Node 22+ and the npm package must be installed. See [the Python README](python/README.md).

### What leaves your computer, and what it keeps

**Jev sends a little page text to TypeSafe.** When a `do` step, an `--intent` or a `check` names a control in words that are not its exact name, browserctrl asks Jev, a model run by [TypeSafe](https://typesafe.ai) at api.typesafe.ai, which control is meant. For that call it sends the page address, the page title, up to about 3,000 characters of the page's visible text, and each candidate control's role and name (with its current value, link path and nearby label when it has them). It sends no screenshot. Exact names, refs and CSS selectors never go to Jev, and they work with no key at all. Without a key, a step that needs Jev stops with a message saying so. The commit guard may also send one button label to Jev as a yes/no question (see below).

Jev needs `TYPESAFE_API_KEY`, set either in the environment of the agent, or in a `jev.env` file in the config folder (`TYPESAFE_API_KEY=...`). `BROWSERCTRL_JEV_ENV` names another file. `BROWSERCTRL_JEV_LOG=<file>` writes every call's exact input and answer, so you can see what was sent.

**What stays on your machine.**

- A trace of each `do` plan (targets, expectations, notices, address changes) is on by default, capped at 2 MB per tab and 50 MB in all. `browserctrl trace off` stops it.
- Capturing fetch/XHR traffic, with bodies, headers and tokens, is off by default. Only `browserctrl capture on` starts it, and it is capped at 200 MB.
- Recordings only happen when you start one.
- Flow notes, tab claims, and short connection logs (lifecycle events, no page content) are kept locally. `BROWSERCTRL_TELEMETRY=0` turns the connection logs off.
- A local bridge on 127.0.0.1 serves the annotation overlay, the tab tray and recordings. It refuses any request without a per-install token. The URLs the CLI prints carry the token.
- Shared recipe repositories ("taps") are pinned to the commit you accepted. `browserctrl recipe tap update` shows what changed, and `--accept` applies it.

If you loaded the optional extension before this version, remove it and load it again. The bridge now trusts it by its fixed extension id.

### Uninstall

1. Run `browserctrl where` and note the folders. Stop the background processes: `browserctrl stop --browser <name>` for each browser you used.
2. Remove the package: `npm rm -g @seahyc/browserctrl` (from a clone: `npm unlink -g @seahyc/browserctrl`). `pip uninstall browserctrl` if you installed the Python client.
3. Remove the skill link or copy from the skills folder.
4. Delete the data, config, state and runtime folders from step 1. This removes your notes, recordings, traces, recipes, Jev key file and any separate browser profile that `launch` made.
5. Remove the extension from `chrome://extensions`, and switch off the `chrome://inspect/#remote-debugging` toggle if you turned it on.

## For developers

### Using the CLI

Pick a browser by name; browserctrl never guesses:

```sh
browserctrl browsers
browserctrl open https://example.com --browser chrome
browserctrl read <tab> --browser chrome            # the page, with refs like ref_2
browserctrl click <tab> ref_2 --browser chrome
browserctrl fill <tab> ref_3 "Example" --browser chrome
```

`read` waits for a loading page and says how long it waited. A ref keeps meaning what your last `read` showed; if the page changed, browserctrl says the ref is stale instead of clicking something else. It never replays an action whose result is uncertain, and a stuck page can be recovered with `reload`. Give each agent its own identity with `BROWSERCTRL_AGENT_ID` so two agents never share a tab claim. Without it, the parent process ID stands in, and a claim whose owner has gone counts as released.

### Plans with `do`, and finding things

```sh
browserctrl do <tab> 'fill "Where" = "Cleveland"' 'key Enter' 'date 2026-10-17' 'date 2026-10-20' \
  'click "Increase Pets"' 'click "Search"' --then items --browser chrome
```

Each step names an element in words (or by ref or CSS selector). `do` matches exact names itself and asks Jev for the rest, waits for each result, and stops at the first step it can't do with confidence: a missing element, an unsure pick (marked ⚠), a checkbox that didn't change, an error on the page, or anything that would commit a purchase (`click!` marks a step you mean to commit). `date YYYY-MM-DD` picks a day in any calendar, and `set "<slider>" = 30-65` moves sliders, including ones inside web components. `=> "<expected>"` checks a result, `--dismiss` closes cookie banners, and `--repeat … --until …` pages through lists. Plans can also branch and loop: `if "<page shows…>" { … } else { … }`, `for top 3 { extract "price"; extract "cancellation" }` and `each "rated 4 or more" up to 3 { … }` open each list item in their own background tab and close it after, `pick "lowest price" top 3 as $choices` ranks without opening, `try pick "<criterion>" up to 3 => "<expected>"` moves to the next candidate when the check fails (never for a commit, a cart change or a message), and `same page { fill …; fill … }` grounds a form's fills in one request. Each report shows `changed on the page:` (states that flipped, result counts, notices, controls that appeared or went; `--no-diff` drops it), and its last line is the outcome, `✓ done: 5/5 steps` or `✗ stopped at step 2/5: <why>`, so an agent that only reads the tail of the output still sees whether the plan worked.

`find <tab> "<words>"` searches the whole page, hidden sections and web components included, and says what hides a match and which control opens it; `fields <tab>` lists every form field and its current value. `BROWSERCTRL_JEV_LOG=<file>` records each Jev call's exact input and answer, which is how the Jev card above was made ([make_jev_card.mjs](docs/media/make_jev_card.mjs)).

### Recipes, notes, profiles and captchas

**Recipes** call a site's own API from a tab on that site instead of driving its UI. A recipe is a small JSON file that runs inside your logged-in tab, so it holds no credentials. Shared recipes come from git repositories called taps, such as [browserctrl-recipes](https://github.com/seahyc/browserctrl-recipes):

```sh
browserctrl recipe tap add https://github.com/seahyc/browserctrl-recipes
browserctrl site shopee.sg                         # the site's recipes and notes in one lookup
browserctrl recipe run shopee.sg/orders --browser chrome
```

Recipes use sites' internal APIs, which can change without notice; you are responsible for using them within each site's terms. The format is in [references/recipes.md](references/recipes.md).

**Notes** are short facts about how a site works, written by agents after a task (`notes add <site> "<fact>"`) and checked by Jev so a note can't carry the task's answer or personal data. They are shown as hints, passed to Jev as context in `do`, and can carry runnable steps: `--reveal "<target>" '<step>'` runs when a target is hidden, `--on "<situation>" '<step>'` when a situation appears. Notes that run are confirmed or contradicted automatically, and unused ones expire after 90 days. They are off by default, since my test found no gain; `BROWSERCTRL_NOTES=on` turns them on and `=quiet` records without hinting. They stay local, in the `notes` folder of the data folder (`browserctrl where`).

**Profiles:** `profiles --browser chrome` lists a Chromium browser's profiles; `open <url> --profile <name>` opens a tab in one.

**Captchas:** `captcha <tab>` tries a plain drag-to-the-end slider once, otherwise notifies you and waits until you clear the challenge.

### Recordings and videos

```sh
browserctrl rec start <tab> --browser chrome       # rrweb DOM events + one still per action
browserctrl rec stop <tab> --browser chrome
browserctrl replay <dir>                           # an HTML replay with a clickable step timeline
browserctrl replay <dir> --video run.mp4 --gif run.gif
browserctrl replay --side-by-side <a> <b> --labels "Before,After" --video ab.mp4 --gif ab.gif
```

Nothing is recorded unless you start it. A recording is the page's DOM changes (brotli) plus a small JPEG per action, about 1 MB for a 3-minute run. Videos replay it at real speed with captions in plain words and a clock; every clip in this README was made that way. `node bench/om2w/export.mjs` turns a recording into Online-Mind2Web judge input (it lives with the benchmark). rrweb 2.1.7 is vendored in `vendor/rrweb/` (MIT).

Recordings in the default folder are capped at 1 GB in total (oldest deleted first), and one recording stops growing at 300 MB. Two logs sit alongside them. `do` keeps a short trace of every plan for `browserctrl trace <tab>`: it's on by default, capped at 2 MB per tab and 50 MB in all, and `browserctrl trace off` stops it. `browserctrl capture on` keeps the fetch/XHR traffic of tabs you drive (bodies, headers and tokens included), which `recipe endpoints` reads when you build a recipe. It's off by default and capped at 200 MB. Each cap can be changed with `BROWSERCTRL_TRACE_MAX_MB`, `BROWSERCTRL_REC_MAX_MB` or `BROWSERCTRL_CAPTURE_MAX_MB`.

### Sharing a browser safely

The CLI and Python client share one long-lived connection per browser debugging port, so console messages and network errors stay available across commands. Agents claim a tab while they work on it; claims expire after 15 minutes unless renewed. Claims coordinate agents that use browserctrl, but they don't hide your browser data or control other tools. `browserctrl activity --browser chrome` shows who owns which tab and what they're doing, and `activity pause --owner <id>` pauses an agent.

browserctrl supports Chromium browsers (Chrome, Dia, Brave, Edge, Chromium, Arc) on macOS, Linux and Windows. Firefox is not supported. An optional extension adds tab groups and other browser-level features; Dia also has native controls for dormant tabs. Details and test evidence are in [compatibility](docs/compatibility.md).

**Safari** 27 or later on macOS works through Apple's own automation interface, in a separate automation session with its own element IDs. Enable Settings → Advanced → Show features for web developers, then Settings → Developer → Allow remote automation and external agents. browserctrl does not enable this for you.
Protected username/password/TOTP entry is supported in a fresh owned Safari automation tab. It closes that tab after submission and keeps console/network inspection private for the native session. See [Safari credential entry](references/vault-entry.md#safari-27) for setup, session continuity and recovery limits.


```mermaid
flowchart LR
    CLI[Terminal commands] --> Shared[Shared browser connection]
    Py[Python client] --> Shared
    Shared --> Chromium[Chosen Chromium browser]
    CLI --> SafariPool[Shared Safari adapter]
    SafariPool --> Apple[Apple Safari MCP]
    Shared -. optional .-> Ext[Extension for browser-level features]
```

Full command usage: `browserctrl help`. See also [contributing](CONTRIBUTING.md) and [security reporting](SECURITY.md).

## Thanks

browserctrl grew from [Petr Baudis's `chrome-cdp-skill`](https://github.com/pasky/chrome-cdp-skill), a small, dependency-light way to control Chromium. Thank you, Petr, for creating and sharing it. If its focused CLI does what you need, choose it: browserctrl adds a shared connection, a Python client, `do` plans with Jev, recipes, recordings and Safari support, and with them more code and dependencies.

## License

MIT, like the upstream project. See [LICENSE](LICENSE).
