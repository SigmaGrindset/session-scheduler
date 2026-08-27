# Claude Session Window Scheduler

Schedule when your Claude Pro 5-hour usage windows begin. You set start times
in a small mobile-first web UI; at those times a GitHub Actions workflow
sends a minimal one-shot prompt through Claude Code (using your Pro
subscription), which starts the window — so it's already running when you sit
down to work.

Everything runs on free tiers: static UI on Vercel Hobby, execution on GitHub
Actions in this **public** repo. No servers, no databases, no API credits.

## How it works

```
Phone browser ──> Static UI on Vercel
                    │  GitHub REST API (fine-grained PAT, stored in localStorage)
                    ├─ read/write  schedule.json
                    ├─ read        state.json + workflow run status
                    └─ POST        workflow_dispatch  ("Start window now")

GitHub Actions (every 15 min) ──> scripts/check-and-ping.mjs
                    ├─ picks today's plan (work day or weekend)
                    ├─ finds due slots (Europe/Zagreb, DST-safe)
                    ├─ claude -p "…"   (CLAUDE_CODE_OAUTH_TOKEN secret)
                    └─ commits state.json  (prevents double-firing)
```

A slot fires at most once per local date, and only within 45 minutes after its
scheduled time (GitHub cron is routinely 5–20 minutes late; that's expected
and fine for this use case).

## Work days and weekends

Start times live in one of two **plans**. Monday to Friday runs the work-day
plan, Saturday and Sunday the weekend plan, and the mapping is fixed in code —
see [ADR 0001](docs/adr/0001-two-day-plans.md) for why it isn't per-slot day
tags. `schedule.json`:

```json
{
  "timezone": "Europe/Zagreb",
  "plans": {
    "workDay": [{ "id": "07bcmz", "time": "08:00", "enabled": true }],
    "weekend": [{ "id": "w4k2ph", "time": "10:00", "enabled": true }]
  }
}
```

An empty plan means **no windows on those days**; it never falls back to the
other plan, so leaving `weekend` empty is how you say "no sessions at the
weekend." The same time may appear in both plans — any given date belongs to
exactly one of them, so there is no ambiguity.

In the UI both plans show side by side on a wide screen; below 880px a
segmented control switches between them, opening on whichever applies today.

**Nothing sensitive is ever committed.** The repo is public; credentials live
only in GitHub Actions secrets and your browser's localStorage.

## Setup

### 1. Create the repo

Create a **public** GitHub repository (public = unlimited Actions minutes) and
push this code to it:

```sh
git init
git add .
git commit -m "initial"
git branch -M main
git remote add origin https://github.com/YOUR_USER/session-scheduler.git
git push -u origin main
```

### 2. Add the Claude Code OAuth token (repo secret)

On a machine where Claude Code is installed and logged in with your Pro
account:

```sh
claude setup-token
```

Copy the token it prints, then in the GitHub repo go to
**Settings → Secrets and variables → Actions → New repository secret** and add
it as `CLAUDE_CODE_OAUTH_TOKEN`.

### 3. Create the fine-grained PAT (for the UI)

GitHub → **Settings → Developer settings → Personal access tokens →
Fine-grained tokens → Generate new token**:

- **Repository access**: Only select repositories → this repo only
- **Permissions → Repository permissions**:
  - **Contents: Read and write** (edit the schedule)
  - **Actions: Read and write** (read run status + trigger "Start window now")

Copy the `github_pat_…` value — you'll paste it into the UI once; it is stored
only in that browser's localStorage.

### 4. Deploy the UI to Vercel

1. [vercel.com/new](https://vercel.com/new) → import this repo.
2. Framework preset: **Other**. No build command, no output directory changes
   (it's a plain static page).
3. Deploy. Open the resulting URL on your phone and consider adding it to your
   home screen.

The included `vercel.json` skips redeploys for the workflow's `state.json`
commits, so the every-15-minutes bot activity doesn't churn deployments.

### 5. Configure the UI

Open the deployed page. The settings panel opens on first load: enter GitHub
owner, repo, branch (`main`) and the PAT, then **Save and connect**. Add start
times under **Work days** or **Weekend**; toggle or delete them any time.
Reopen the panel from the icon in the top right.

## Notes

- **Timezone**: all times are Europe/Zagreb (set in `schedule.json`;
  DST handled automatically).
- **Manual start**: **Start window now** dispatches the workflow immediately,
  regardless of the schedule.
- **Health**: the pill in the header reads *healthy*, turns amber if no workflow
  run happened in 24h, and turns red and links to the run when the latest one
  failed.
- **Day rail**: the *Today* panel plots today's plan — its enabled start times,
  the running window and the current time across 24 hours — so gaps in the day
  are obvious. It shows today only, so on a Friday evening an empty rail ahead
  of the now-marker means the work day's starts are done.
- **Next start**: scans up to seven days ahead and carries a weekday prefix
  (`Sat 10:00`) whenever the next start isn't today, which happens as soon as
  the two plans differ. Seven days is the true bound: the schedule repeats
  weekly, so *none set* means nothing is scheduled at all.
- **5-hour window reset**: after a ping, the workflow makes one extra minimal
  request and reads Claude's `anthropic-ratelimit-unified-5h-reset` response
  header, recording the exact reset time of the current 5-hour usage window into
  `state.json`. The countdown at the top of the UI runs against it, with a meter
  showing how much of the 5 hours is spent; it falls back to "no window" once the
  window elapses. The header is undocumented; the read is best-effort and never
  fails the ping.
- **Cron auto-disable**: GitHub disables scheduled workflows after 60 days
  without repo activity. The workflow's own `state.json` commits count as
  activity, so normal use keeps it alive; if you stop using it for two months,
  re-enable it in the Actions tab.
- **Testing locally**:
  `node scripts/check-and-ping.mjs --dry-run` (optionally with
  `SWS_FAKE_NOW=2026-07-19T06:10:00Z`) prints the firing decision without
  pinging or writing anything. The output names the resolved plan, so pointing
  `SWS_FAKE_NOW` at a Saturday is enough to check the weekend plan.
  `node scripts/test-plans.mjs` checks plan resolution and the seven-day
  next-start scan; it lifts those functions straight out of `app.js`, so it
  needs no dependencies and no test runner.
- **Previewing the UI**: `node scripts/serve.mjs` serves the page on
  <http://localhost:4321>. Adding `?demo` (also `?demo=empty`, `?demo=sheet`)
  renders sample data with no GitHub calls — it only works on localhost, so
  the deployed page is unaffected.

## Detecting windows started elsewhere

The UI only knows about windows this repo started. If you open a window yourself
— Claude Code on your laptop, the app, the web — the countdown keeps saying
"no window" until the next scheduled ping happens to land inside it.

That is not an oversight in the UI: the exact reset time is only ever returned
in the `anthropic-ratelimit-unified-5h-reset` response header, and a normal
`/v1/messages` request **starts a window if none is running**. So the schedule
cannot simply poll for "is a window open?" — on a quiet afternoon the poll
itself would open one, which is the opposite of the point.

Automatic detection is therefore possible only if some endpoint returns that
header *without* running inference. Run the **probe-window** workflow
(Actions → probe-window → Run workflow) to find out. It sends no inference
request and writes nothing; it just prints the `anthropic-*` headers returned by
`count_tokens`, a rejected request, and `GET /v1/models`.

Read the result like this:

- **A probe returns the header, and running it while no window is open does not
  create one** → poll that endpoint from the 5-minute cron and record `window`
  in `state.json`. The UI then shows every window regardless of who started it.
- **A probe returns the header but the reported reset is ~5h out when nothing
  was running** → the probe started a window. Do not poll it.
- **No probe returns the header** → the reset time is observable only on a real
  request, and windows started outside this repo cannot be detected through the
  API. Record them by hand instead.

Whatever the outcome, the ping path is unaffected — it already reads the header
on the request it was going to make anyway.
