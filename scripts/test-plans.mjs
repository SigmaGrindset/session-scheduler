// Lifts the Plans block straight out of app.js and exercises it, so this tests
// the shipped code rather than a copy of it.
import { readFileSync } from "node:fs";

const src = readFileSync("app.js", "utf8");
const block = src.slice(
  src.indexOf("// ---------- Plans ----------"),
  src.indexOf("// ---------- Rendering ----------"),
);

const DAY_MIN = 24 * 60;
const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

let schedule = null;
const api = new Function(
  "DAY_MIN",
  "toMinutes",
  "getSchedule",
  `const schedule = getSchedule();
   ${block}
   return { planKeyFor, addDays, dayLabel, planSlots, nextOccurrence, nextStart,
            prevOccurrence, prevStart };`,
);

const load = (s) => {
  schedule = s;
  return api(DAY_MIN, toMinutes, () => schedule);
};

let pass = 0;
const fail = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else fail.push(`${name}\n    expected ${e}\n    actual   ${a}`);
}

// ---- planKeyFor across a known week (2026-08-24 is a Monday) ----
{
  const p = load({ plans: { workDay: [], weekend: [] } });
  check(
    "planKeyFor Mon-Sun",
    ["24", "25", "26", "27", "28", "29", "30"].map((d) => p.planKeyFor(`2026-08-${d}`)),
    ["workDay", "workDay", "workDay", "workDay", "workDay", "weekend", "weekend"],
  );
  check("addDays crosses month end", p.addDays("2026-08-31", 1), "2026-09-01");
  check("dayLabel", p.dayLabel("2026-08-29"), "Sat");
}

// ---- Friday 19:30, weekend plan opens at 10:00 ----
{
  const p = load({
    plans: {
      workDay: [{ id: "a", time: "19:00", enabled: true }],
      weekend: [{ id: "b", time: "10:00", enabled: true }],
    },
  });
  const n = p.nextStart("2026-08-28", toMinutes("19:30")); // Friday
  check("Fri 19:30 -> next is Sat 10:00", [n.time, n.offset, n.date], ["10:00", 1, "2026-08-29"]);
  check("Fri 19:30 -> 14h30m away", n.minutesAway, 870);
}

// ---- Friday 19:30 with an EMPTY weekend plan: must reach Monday ----
{
  const p = load({
    plans: {
      workDay: [{ id: "a", time: "08:00", enabled: true }],
      weekend: [],
    },
  });
  const n = p.nextStart("2026-08-28", toMinutes("19:30"));
  check("empty weekend -> next is Mon 08:00", [n.time, n.offset, n.date], ["08:00", 3, "2026-08-31"]);
  check("empty weekend -> 60h30m away", n.minutesAway, 3630);
}

// ---- a weekend slot viewed on a Tuesday is days away, not hours ----
{
  const p = load({
    plans: { workDay: [], weekend: [{ id: "b", time: "10:00", enabled: true }] },
  });
  const occ = p.nextOccurrence("weekend", "10:00", "2026-08-25", toMinutes("09:00")); // Tuesday
  check("Tue -> weekend 10:00 is 4 days out", [occ.offset, occ.date], [4, "2026-08-29"]);
}

// ---- today's slot still ahead wins, and offset 0 means no day prefix ----
{
  const p = load({
    plans: {
      workDay: [
        { id: "a", time: "08:00", enabled: true },
        { id: "b", time: "13:30", enabled: true },
      ],
      weekend: [{ id: "c", time: "09:00", enabled: true }],
    },
  });
  const n = p.nextStart("2026-08-26", toMinutes("09:00")); // Wednesday
  check("later today wins", [n.time, n.offset], ["13:30", 0]);
}

// ---- a passed slot rolls to the plan's next day, not to today ----
{
  const p = load({
    plans: { workDay: [{ id: "a", time: "08:00", enabled: true }], weekend: [] },
  });
  const n = p.nextStart("2026-08-28", toMinutes("09:00")); // Friday, 08:00 gone
  check("Fri after 08:00 -> Mon, skipping the weekend", [n.offset, n.date], [3, "2026-08-31"]);
}

// ---- disabled slots are invisible; nothing enabled means null ----
{
  const p = load({
    plans: {
      workDay: [{ id: "a", time: "08:00", enabled: false }],
      weekend: [{ id: "b", time: "10:00", enabled: false }],
    },
  });
  check("all disabled -> none set", p.nextStart("2026-08-26", 60), null);
}

// ---- an absent plan key is empty, never a fallback to the other plan ----
{
  const p = load({ plans: { workDay: [{ id: "a", time: "08:00", enabled: true }] } });
  check("absent weekend plan is empty", p.planSlots("weekend"), []);
  const n = p.nextStart("2026-08-29", toMinutes("07:00")); // Saturday
  check("Saturday with no weekend plan -> Mon", [n.offset, n.date], [2, "2026-08-31"]);
}

// ---- the same time in both plans is legitimate and resolves per day ----
{
  const p = load({
    plans: {
      workDay: [{ id: "a", time: "08:00", enabled: true }],
      weekend: [{ id: "b", time: "08:00", enabled: true }],
    },
  });
  const n = p.nextStart("2026-08-28", toMinutes("09:00")); // Friday after 08:00
  check("shared time -> tomorrow's weekend one", [n.plan, n.offset], ["weekend", 1]);
}

// ---- prevStart: the slot the health check measures the last ping against ----
{
  const p = load({
    plans: {
      workDay: [
        { id: "a", time: "13:00", enabled: true },
        { id: "b", time: "18:30", enabled: true },
      ],
      weekend: [
        { id: "c", time: "08:00", enabled: true },
        { id: "d", time: "13:30", enabled: true },
        { id: "e", time: "19:00", enabled: true },
      ],
    },
  });

  // Sunday 15:00: the 13:30 slot passed 90 minutes ago.
  const a = p.prevStart("2026-08-30", toMinutes("15:00"));
  check("Sun 15:00 -> 13:30, 90m ago", [a.time, a.offset, a.minutesAgo], ["13:30", 0, 90]);

  // Sunday 07:00: nothing has passed today, so it reaches back to Saturday.
  const b = p.prevStart("2026-08-30", toMinutes("07:00"));
  check("Sun 07:00 -> Sat 19:00", [b.time, b.offset, b.date], ["19:00", 1, "2026-08-29"]);
  check("Sun 07:00 -> 12h ago", b.minutesAgo, 720);

  // Monday 09:00: the work-day slots are still ahead, so the last one that
  // passed belongs to the weekend plan. A miss must not be attributed to today.
  const c = p.prevStart("2026-08-31", toMinutes("09:00"));
  check("Mon 09:00 -> Sun 19:00", [c.time, c.plan, c.date], ["19:00", "weekend", "2026-08-30"]);
}

// ---- prevStart mirrors nextStart on the empty and disabled cases ----
{
  const p = load({
    plans: {
      workDay: [{ id: "a", time: "08:00", enabled: false }],
      weekend: [{ id: "b", time: "10:00", enabled: false }],
    },
  });
  check("all disabled -> nothing passed", p.prevStart("2026-08-30", 600), null);
}

{
  const p = load({ plans: { workDay: [{ id: "a", time: "08:00", enabled: true }] } });
  // Sunday with no weekend plan: the last slot that passed is Friday's.
  const n = p.prevStart("2026-08-30", toMinutes("12:00"));
  check("Sun, no weekend plan -> Fri 08:00", [n.offset, n.date], [2, "2026-08-28"]);
}

console.log(`${pass} passed, ${fail.length} failed`);
for (const f of fail) console.error("  FAIL " + f);
process.exit(fail.length ? 1 : 0);
