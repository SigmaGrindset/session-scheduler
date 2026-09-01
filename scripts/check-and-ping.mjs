// Runs on a GitHub Actions cron. Decides whether a scheduled session-window
// ping is due, fires it via Claude Code, and records it in state.json so the
// same slot never fires twice on the same local date.
//
// Usage:
//   node scripts/check-and-ping.mjs            normal run (pings if due)
//   node scripts/check-and-ping.mjs --dry-run  print decision, no ping/write
//
// Test hooks:
//   SWS_FAKE_NOW=2026-07-19T06:10:00Z  pretend "now" is this instant
//   SWS_SKIP_PING=1                    skip the claude call but still write state

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// A slot only fires within this many minutes after its scheduled time.
// Covers GitHub cron lateness without re-firing hours later. GitHub delivers
// this repo's five-minute cron with multi-hour gaps, so the previous 45 was
// narrower than the real jitter and dropped slots that had merely arrived late.
const WINDOW_MIN = 120;

// How many missed slots state.json keeps, newest last, so the file cannot grow
// without bound.
const MISSED_KEEP = 20;

const PING_PROMPT = "Reply with exactly: ok";

const DRY_RUN = process.argv.includes("--dry-run");
const FORCED = process.env.GITHUB_EVENT_NAME === "workflow_dispatch";

const now = process.env.SWS_FAKE_NOW
  ? new Date(process.env.SWS_FAKE_NOW)
  : new Date();
if (Number.isNaN(now.getTime())) {
  console.error(`Invalid SWS_FAKE_NOW: ${process.env.SWS_FAKE_NOW}`);
  process.exit(1);
}

const schedule = JSON.parse(readFileSync("schedule.json", "utf8"));
const state = JSON.parse(readFileSync("state.json", "utf8"));
const tz = schedule.timezone || "Europe/Zagreb";

// Current local date (YYYY-MM-DD) and minutes since local midnight, DST-safe.
function localNow(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

const { date: today, minutes: nowMin } = localNow(now, tz);

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

// Saturday and Sunday run the weekend plan, Monday to Friday the work-day one.
// The mapping is fixed here on purpose: docs/adr/0001-two-day-plans.md.
// Parsing the local calendar date as UTC midnight makes getUTCDay() exact,
// with no timezone or DST offset to reason about.
function planKeyFor(localDate) {
  const dow = new Date(`${localDate}T00:00:00Z`).getUTCDay(); // 0 Sun ... 6 Sat
  return dow === 0 || dow === 6 ? "weekend" : "workDay";
}

// The single place a date turns into the slots that apply to it. Date-specific
// overrides (holidays, "skip tomorrow") belong here and nowhere else.
// An absent or empty plan means no windows that day; it never falls back to
// the other plan.
function slotsFor(localDate) {
  if (schedule.plans) return schedule.plans[planKeyFor(localDate)] || [];
  return schedule.slots || []; // pre-plans format: one list, applies every day
}

const fired = state.fired || {};
const enabledToday = slotsFor(today).filter((slot) => slot.enabled);

const dueSlots = enabledToday.filter((slot) => {
  const late = nowMin - toMinutes(slot.time);
  return late >= 0 && late < WINDOW_MIN && fired[slot.time] !== today;
});

// A slot is missed once its fire window has closed with nothing recorded
// against it today. Only a run landing after that close can observe it, so a
// local date with no run at all after a slot leaves no entry here; the
// dashboard's last-ping check is what covers that case.
const missedSlots = enabledToday.filter((slot) => {
  const late = nowMin - toMinutes(slot.time);
  return late >= WINDOW_MIN && fired[slot.time] !== today;
});

const missedLog = Array.isArray(state.missed) ? state.missed : [];
const alreadyLogged = new Set(missedLog.map((m) => `${m.date} ${m.time}`));
const newMissed = missedSlots
  .filter((slot) => !alreadyLogged.has(`${today} ${slot.time}`))
  .map((slot) => ({
    date: today,
    time: slot.time,
    plan: planKeyFor(today),
    noticedAt: new Date().toISOString(),
  }));
const missed = [...missedLog, ...newMissed].slice(-MISSED_KEEP);

// Entries from previous days are pruned; the guard only ever compares against
// today's date.
const prunedFired = Object.fromEntries(
  Object.entries(fired).filter(([, date]) => date === today),
);

// The single place state.json is written, so a ping and a bare missed-slot
// record produce the same shape.
function writeState({ lastPing, window: win }) {
  const next = { fired: prunedFired, lastPing };
  if (win) next.window = win;
  if (missed.length) next.missed = missed;
  writeFileSync("state.json", JSON.stringify(next, null, 2) + "\n");
  console.log("state.json updated.");
}

console.log(
  `now=${now.toISOString()} local=${today} ${String(Math.floor(nowMin / 60)).padStart(2, "0")}:${String(nowMin % 60).padStart(2, "0")} (${tz})` +
    ` event=${process.env.GITHUB_EVENT_NAME || "local"}` +
    ` plan=${planKeyFor(today)}` +
    ` due=[${dueSlots.map((s) => s.time).join(", ")}]` +
    ` missed=[${missedSlots.map((s) => s.time).join(", ")}]`,
);

// A missed slot is recorded even on a run with nothing to ping, so the failure
// leaves a trace instead of exiting green and silent.
if (newMissed.length > 0) {
  const label = newMissed.map((m) => m.time).join(", ");
  console.log(
    `::warning title=Missed slot::No ping fired for ${label} on ${today} (${tz}).` +
      ` The ${WINDOW_MIN} min fire window closed with no workflow run inside it.`,
  );
  if (!DRY_RUN && !FORCED && dueSlots.length === 0) {
    writeState({ lastPing: state.lastPing ?? null, window: state.window });
  }
}

if (!FORCED && dueSlots.length === 0) {
  console.log("Nothing due. Exiting.");
  process.exit(0);
}

if (DRY_RUN) {
  console.log(
    `[dry-run] Would ping (${FORCED ? "manual dispatch" : `slots: ${dueSlots.map((s) => s.time).join(", ")}`}).`,
  );
  process.exit(0);
}

// After the ping starts the window, read Claude's unified rate-limit header to
// capture the exact 5-hour window reset time for the UI. Undocumented header,
// best-effort: a failure here never fails the ping, and the previous value is
// kept.
const WINDOW_MODEL = "claude-haiku-4-5";

async function readWindow(token) {
  if (!token) throw new Error("no CLAUDE_CODE_OAUTH_TOKEN");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: WINDOW_MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    }),
  });

  const reset = Number(res.headers.get("anthropic-ratelimit-unified-5h-reset"));
  if (!Number.isFinite(reset)) {
    throw new Error(`no 5h-reset header (HTTP ${res.status})`);
  }
  return {
    readAt: new Date().toISOString(),
    resetsAt: new Date(reset * 1000).toISOString(),
  };
}

let win = null;

if (process.env.SWS_SKIP_PING === "1") {
  console.log("Ping skipped (SWS_SKIP_PING=1).");
} else {
  try {
    // One ping starts the window regardless of how many slots are due.
    const output = execFileSync(
      "claude",
      ["-p", PING_PROMPT, "--output-format", "text"],
      { encoding: "utf8", timeout: 5 * 60 * 1000, stdio: ["ignore", "pipe", "inherit"] },
    );
    console.log(`Ping sent. Claude replied: ${output.trim()}`);
  } catch (err) {
    console.error(`Ping failed: ${err.message}`);
    process.exit(1);
  }

  // The ping just started (or refreshed) the window; capture its reset time.
  win = await readWindow(process.env.CLAUDE_CODE_OAUTH_TOKEN).catch((err) => {
    console.error(`Window read failed (non-fatal): ${err.message}`);
    return null;
  });
  if (win) console.log(`5-hour window resets ${win.resetsAt}`);
}

// Record the ping. One ping covers every slot that was due, so all of them
// are marked fired for today.
for (const slot of dueSlots) prunedFired[slot.time] = today;

writeState({
  lastPing: {
    at: new Date().toISOString(),
    slot: dueSlots[0]?.time ?? null,
    trigger: FORCED ? "manual" : "schedule",
  },
  // Keep the previous window reset if this run couldn't read a fresh one.
  window: win ?? state.window,
});
