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
// Covers GitHub cron lateness without re-firing hours later.
const WINDOW_MIN = 45;

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

const fired = state.fired || {};
const dueSlots = (schedule.slots || []).filter((slot) => {
  if (!slot.enabled) return false;
  const slotMin = toMinutes(slot.time);
  const late = nowMin - slotMin;
  return late >= 0 && late < WINDOW_MIN && fired[slot.time] !== today;
});

console.log(
  `now=${now.toISOString()} local=${today} ${String(Math.floor(nowMin / 60)).padStart(2, "0")}:${String(nowMin % 60).padStart(2, "0")} (${tz})` +
    ` event=${process.env.GITHUB_EVENT_NAME || "local"}` +
    ` due=[${dueSlots.map((s) => s.time).join(", ")}]`,
);

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
}

// Record the ping. Entries from previous days are pruned; the guard only
// ever compares against today's date.
const newFired = {};
for (const [time, date] of Object.entries(fired)) {
  if (date === today) newFired[time] = date;
}
for (const slot of dueSlots) newFired[slot.time] = today;

const newState = {
  fired: newFired,
  lastPing: {
    at: new Date().toISOString(),
    slot: dueSlots[0]?.time ?? null,
    trigger: FORCED ? "manual" : "schedule",
  },
};

writeFileSync("state.json", JSON.stringify(newState, null, 2) + "\n");
console.log("state.json updated.");
