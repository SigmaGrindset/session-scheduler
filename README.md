# Claude Session Window Scheduler

Schedule when your Claude Pro 5-hour usage windows begin. You set start times
in a small mobile-friendly web UI; at those times a GitHub Actions workflow
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
                    ├─ finds due slots (Europe/Zagreb, DST-safe)
                    ├─ claude -p "…"   (CLAUDE_CODE_OAUTH_TOKEN secret)
                    └─ commits state.json  (prevents double-firing)
```

A slot fires at most once per local date, and only within 45 minutes after its
scheduled time (GitHub cron is routinely 5–20 minutes late; that's expected
and fine for this use case).

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

Open the deployed page → enter GitHub owner, repo, branch (`main`) and the
PAT → Save. Add your start times; toggle or delete them any time.

## Notes

- **Timezone**: all times are Europe/Zagreb (set in `schedule.json`;
  DST handled automatically).
- **Manual start**: the ▶ button dispatches the workflow immediately,
  regardless of the schedule.
- **Health**: the status card shows the last ping time and turns yellow if no
  workflow run happened in 24h, red if the latest run failed (with a link).
- **Usage / reset time**: after a ping, the workflow makes one extra minimal
  request and reads Claude's `anthropic-ratelimit-unified-*` response headers,
  recording the exact 5-hour and weekly window reset times and utilization into
  `state.json`. The UI shows a live countdown to the 5-hour reset and usage
  meters. (These headers are undocumented; the read is best-effort and never
  fails the ping.)
- **Cron auto-disable**: GitHub disables scheduled workflows after 60 days
  without repo activity. The workflow's own `state.json` commits count as
  activity, so normal use keeps it alive; if you stop using it for two months,
  re-enable it in the Actions tab.
- **Testing locally**:
  `node scripts/check-and-ping.mjs --dry-run` (optionally with
  `SWS_FAKE_NOW=2026-07-19T06:10:00Z`) prints the firing decision without
  pinging or writing anything.
