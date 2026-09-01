"use strict";

const TZ = "Europe/Zagreb";
const CFG_KEY = "sws-config";
const WORKFLOW_FILE = "ping.yml";
const WINDOW_MS = 5 * 60 * 60 * 1000; // a usage window runs 5 hours
const DAY_MIN = 24 * 60;

// A slot can still fire this long after its time; must match WINDOW_MIN in
// scripts/check-and-ping.mjs. Past it with no ping, the slot was missed.
const FIRE_WINDOW_MIN = 120;

const $ = (id) => document.getElementById(id);

// Design preview: `?demo` on localhost renders sample data with no GitHub calls.
// Never active on a deployed origin.
const params = new URLSearchParams(location.search);
const DEMO =
  /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) && params.has("demo");
const DEMO_STATE = DEMO ? params.get("demo") || "ready" : null; // ready | empty | sheet

let cfg = loadCfg();
let schedule = null;
let scheduleSha = null;
let windowResetsAt = null; // ISO reset time of the current 5-hour window, or null
let activeTab = null; // plan shown by the segmented control below 880px

function loadCfg() {
  try {
    return JSON.parse(localStorage.getItem(CFG_KEY)) || null;
  } catch {
    return null;
  }
}

function setView(view) {
  document.body.dataset.view = view;
}

// ---------- GitHub API ----------

function gh(path, opts = {}) {
  return fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}${path}`, {
    ...opts,
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${cfg.pat}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.headers || {}),
    },
  });
}

function b64decode(content) {
  const bytes = Uint8Array.from(atob(content.replace(/\s/g, "")), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function b64encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function fetchFile(name) {
  const res = await gh(`/contents/${name}?ref=${cfg.branch}`);
  if (!res.ok) throw new Error(`Fetching ${name} failed (${res.status})`);
  const body = await res.json();
  return { data: JSON.parse(b64decode(body.content)), sha: body.sha };
}

async function putSchedule(message) {
  const res = await gh(`/contents/schedule.json`, {
    method: "PUT",
    body: JSON.stringify({
      message,
      branch: cfg.branch,
      content: b64encode(JSON.stringify(schedule, null, 2) + "\n"),
      sha: scheduleSha,
    }),
  });
  if (res.status === 409 || res.status === 422) return false; // sha conflict
  if (!res.ok) throw new Error(`Saving schedule failed (${res.status})`);
  scheduleSha = (await res.json()).content.sha;
  return true;
}

async function saveSchedule(message) {
  if (DEMO) return;
  if (await putSchedule(message)) return;
  // Someone else committed since our fetch: re-fetch sha and retry once.
  const fresh = await fetchFile("schedule.json");
  scheduleSha = fresh.sha;
  if (!(await putSchedule(message))) throw new Error("Saving schedule failed (conflict)");
}

// ---------- Time helpers ----------

function toast(msg, kind = "info", ms = 3200) {
  const el = $("toast");
  el.textContent = msg;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), ms);
}

function zagrebParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function fmtTime(date) {
  return new Date(date).toLocaleTimeString("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

function fmtDayTime(date) {
  return new Date(date).toLocaleString("en-GB", {
    timeZone: TZ,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

// Clock-style H:MM:SS for the hero, compact "3h 12m" elsewhere.
function fmtClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function fmtShort(ms) {
  const totalMin = Math.floor(Math.max(0, ms) / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return m === 0 ? `${h}h` : `${h}h ${m}m`;
  return `${m}m`;
}

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

// ---------- Plans ----------

const PLAN_KEYS = ["workDay", "weekend"];
const PLAN_LABELS = { workDay: "work days", weekend: "weekend" };

// Saturday and Sunday run the weekend plan, Monday to Friday the work-day one.
// Fixed on purpose: docs/adr/0001-two-day-plans.md. Reading the local calendar
// date as UTC midnight makes getUTCDay() exact, with no offset to reason about.
function planKeyFor(localDate) {
  const dow = new Date(`${localDate}T00:00:00Z`).getUTCDay(); // 0 Sun ... 6 Sat
  return dow === 0 || dow === 6 ? "weekend" : "workDay";
}

function addDays(localDate, n) {
  const d = new Date(`${localDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayLabel(localDate) {
  return new Date(`${localDate}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    timeZone: "UTC",
  });
}

// The slots of one plan. An absent or empty plan means no windows on those
// days; it never falls back to the other plan.
function planSlots(key) {
  return schedule?.plans?.[key] || [];
}

// When a plan's HH:MM next comes round, scanning up to seven days out. Seven is
// the true bound: the schedule repeats weekly, so anything not found inside a
// week does not exist at all, which makes "none set" a fact rather than a
// timeout.
function nextOccurrence(key, time, today, nowMin) {
  for (let offset = 0; offset <= 7; offset++) {
    const date = addDays(today, offset);
    if (planKeyFor(date) !== key) continue;
    const minutesAway = offset * DAY_MIN + toMinutes(time) - nowMin;
    if (minutesAway > 0) return { date, offset, minutesAway };
  }
  return null;
}

// The soonest enabled slot across both plans, or null when none is enabled.
function nextStart(today, nowMin) {
  let best = null;
  for (const key of PLAN_KEYS) {
    for (const slot of planSlots(key)) {
      if (!slot.enabled) continue;
      const occ = nextOccurrence(key, slot.time, today, nowMin);
      if (occ && (!best || occ.minutesAway < best.minutesAway)) {
        best = { ...occ, time: slot.time, plan: key };
      }
    }
  }
  return best;
}

// The mirror of nextOccurrence: when a plan's HH:MM last came round, scanning
// up to seven days back. Same weekly bound, so null is a fact, not a timeout.
function prevOccurrence(key, time, today, nowMin) {
  for (let offset = 0; offset <= 7; offset++) {
    const date = addDays(today, -offset);
    if (planKeyFor(date) !== key) continue;
    const minutesAgo = nowMin + offset * DAY_MIN - toMinutes(time);
    if (minutesAgo >= 0) return { date, offset, minutesAgo };
  }
  return null;
}

// The most recently passed enabled slot across both plans, or null when none is
// enabled.
function prevStart(today, nowMin) {
  let best = null;
  for (const key of PLAN_KEYS) {
    for (const slot of planSlots(key)) {
      if (!slot.enabled) continue;
      const occ = prevOccurrence(key, slot.time, today, nowMin);
      if (occ && (!best || occ.minutesAgo < best.minutesAgo)) {
        best = { ...occ, time: slot.time, plan: key };
      }
    }
  }
  return best;
}

// ---------- Rendering ----------

// The hero: how much of the current 5-hour window is left. Driven off the
// absolute resetsAt timestamp so it stays accurate between workflow runs.
function renderWindow() {
  const hero = document.querySelector(".hero");
  const count = $("hero-count");
  const sub = $("hero-sub");
  const fill = $("gauge-fill");
  const left = $("gauge-start");
  const right = $("gauge-end");
  const remaining = windowResetsAt ? new Date(windowResetsAt).getTime() - Date.now() : -1;

  if (remaining <= 0) {
    hero.classList.add("hero--idle");
    count.textContent = "no window";
    sub.textContent = windowResetsAt
      ? "No window running. The next start time opens one."
      : "No window recorded yet. Start one, or wait for a scheduled slot.";
    fill.style.setProperty("--p", 0);
    left.textContent = "—";
    right.textContent = "—";
    $("gauge").setAttribute("aria-label", "No window running");
    return;
  }

  const startedAt = new Date(windowResetsAt).getTime() - WINDOW_MS;
  const progress = Math.min(1, Math.max(0, (Date.now() - startedAt) / WINDOW_MS));

  hero.classList.remove("hero--idle");
  count.textContent = fmtClock(remaining);
  sub.textContent = `${fmtShort(remaining)} left · resets at ${fmtTime(windowResetsAt)}`;
  fill.style.setProperty("--p", progress.toFixed(4));
  left.textContent = `started ${fmtTime(startedAt)}`;
  right.textContent = fmtTime(windowResetsAt);
  $("gauge").setAttribute(
    "aria-label",
    `${Math.round(progress * 100)} percent of the window elapsed`,
  );
}

// A 24-hour rail: where today's plan sits, where the active window sits, where
// now is. It is labelled "Today", so it shows today's plan and nothing else --
// on a Friday evening an empty rail ahead of the now-marker is the correct
// answer rather than a missing one.
function renderTrack() {
  const { date: today, minutes: nowMin } = zagrebParts(new Date());
  const marks = $("track-marks");
  const next = schedule ? nextStart(today, nowMin) : null;
  // Only a start time later today can be the one highlighted on a Today rail.
  const nextToday = next && next.offset === 0 ? next.time : null;

  $("now-label").textContent = `${String(Math.floor(nowMin / 60)).padStart(2, "0")}:${String(nowMin % 60).padStart(2, "0")}`;
  $("track-now").hidden = false;
  $("track-now").style.setProperty("--x", (nowMin / DAY_MIN).toFixed(4));

  // Active window as a band; it splits when the window crosses midnight.
  const bands = [$("track-band"), $("track-band-2")];
  bands.forEach((b) => (b.hidden = true));
  const remaining = windowResetsAt ? new Date(windowResetsAt).getTime() - Date.now() : -1;
  if (remaining > 0) {
    const endMin = zagrebParts(new Date(windowResetsAt)).minutes;
    const startMin = zagrebParts(new Date(new Date(windowResetsAt).getTime() - WINDOW_MS)).minutes;
    const segments =
      endMin >= startMin
        ? [[startMin, endMin]]
        : [
            [startMin, DAY_MIN],
            [0, endMin],
          ];
    segments.forEach(([a, b], i) => {
      const el = bands[i];
      if (!el) return;
      el.style.setProperty("--a", (a / DAY_MIN).toFixed(4));
      el.style.setProperty("--b", (b / DAY_MIN).toFixed(4));
      el.hidden = false;
    });
  }

  marks.innerHTML = "";
  if (!schedule) return;

  const todayKey = planKeyFor(today);
  $("day-label").textContent = `Today \u00b7 ${PLAN_LABELS[todayKey]}`;

  $("track").setAttribute(
    "aria-label",
    `Day rail for ${PLAN_LABELS[todayKey]}. Now ${$("now-label").textContent}` +
      `${nextToday ? `, next start ${nextToday}` : ", nothing left today"}.`,
  );

  for (const slot of planSlots(todayKey)) {
    const x = toMinutes(slot.time) / DAY_MIN;
    const mark = document.createElement("div");
    mark.className = "track__mark";
    if (!slot.enabled) mark.classList.add("track__mark--off");
    if (slot.enabled && slot.time === nextToday) {
      mark.classList.add("track__mark--next");
      if (x < 0.06) mark.classList.add("track__mark--edge-start");
      if (x > 0.94) mark.classList.add("track__mark--edge-end");
      const label = document.createElement("span");
      label.className = "track__label";
      label.textContent = slot.time;
      mark.appendChild(label);
    }
    mark.style.setProperty("--x", x.toFixed(4));
    mark.title = `${slot.time}${slot.enabled ? "" : " (off)"}`;
    marks.appendChild(mark);
  }
}

function renderSkeletonSlots() {
  for (const key of PLAN_KEYS) {
    const section = document.querySelector(`.plan[data-plan="${key}"]`);
    const list = section.querySelector(".slots");
    list.innerHTML = "";
    section.querySelector(".empty").hidden = true;
    for (let i = 0; i < 3; i++) {
      const li = document.createElement("li");
      li.className = "slot--skel";
      list.appendChild(li);
    }
  }
}

// Below 880px one plan shows at a time and the segmented control picks which.
// At 880px and up CSS reveals both and hides the control, so this value is
// simply ignored -- no media query in JS, nothing to resync on resize.
function setActiveTab(key) {
  activeTab = key;
  $("plans").dataset.activePlan = key;
  for (const btn of document.querySelectorAll(".plan-tab")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.plan === key));
  }
}

// A weekend slot seen on a Tuesday is not "in 20h" -- it is however long until
// Saturday. Every countdown goes through nextOccurrence for that reason.
function relLabel(key, slot, today, nowMin) {
  if (!slot.enabled) return "off";
  const occ = nextOccurrence(key, slot.time, today, nowMin);
  return occ ? `in ${fmtShort(occ.minutesAway * 60000)}` : "\u2014";
}

function slotRow(key, slot, today, nowMin) {
  const li = document.createElement("li");
  li.className = "slot" + (slot.enabled ? "" : " slot--off");

  const row = document.createElement("div");
  row.className = "slot__row";

  const time = document.createElement("span");
  time.className = "slot__time";
  time.textContent = slot.time;

  const rel = document.createElement("span");
  rel.className = "slot__rel";
  rel.dataset.plan = key;
  rel.dataset.time = slot.time;
  rel.textContent = relLabel(key, slot, today, nowMin);

  const sw = document.createElement("label");
  sw.className = "switch";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = slot.enabled;
  cb.setAttribute("aria-label", `${slot.time} on ${PLAN_LABELS[key]} enabled`);
  cb.addEventListener("change", () => toggleSlot(key, slot.id, cb.checked));
  const pill = document.createElement("span");
  pill.className = "track-pill";
  sw.append(cb, pill);

  const del = document.createElement("button");
  del.type = "button";
  del.className = "icon-btn slot__del";
  del.setAttribute("aria-label", `Delete ${slot.time} from ${PLAN_LABELS[key]}`);
  del.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  del.addEventListener("click", () => {
    li.classList.add("is-confirming");
    li.querySelector(".slot__confirm .btn--danger").focus();
  });

  row.append(time, rel, sw, del);

  // Inline confirm instead of a browser dialog.
  const confirm = document.createElement("div");
  confirm.className = "slot__confirm";
  const question = document.createElement("p");
  question.innerHTML = `Delete <b>${slot.time}</b>?`;

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn btn--text";
  cancel.textContent = "Keep";
  cancel.addEventListener("click", () => {
    li.classList.remove("is-confirming");
    del.focus();
  });

  const confirmDel = document.createElement("button");
  confirmDel.type = "button";
  confirmDel.className = "btn btn--danger";
  confirmDel.textContent = "Delete";
  confirmDel.addEventListener("click", () => deleteSlot(key, slot.id, slot.time));

  confirm.append(question, cancel, confirmDel);
  li.append(row, confirm);
  return li;
}

function renderSlots() {
  const { date: today, minutes: nowMin } = zagrebParts(new Date());
  const todayKey = planKeyFor(today);

  setActiveTab(activeTab || todayKey);

  for (const key of PLAN_KEYS) {
    const section = document.querySelector(`.plan[data-plan="${key}"]`);
    const list = section.querySelector(".slots");
    const slots = [...planSlots(key)].sort((a, b) => a.time.localeCompare(b.time));

    section.classList.toggle("plan--today", key === todayKey);
    section.querySelector(".plan__today").hidden = key !== todayKey;
    section.querySelector(".empty").hidden = slots.length > 0;

    list.innerHTML = "";
    for (const slot of slots) list.appendChild(slotRow(key, slot, today, nowMin));
  }

  renderNextSlot();
  renderTrack();
}

function renderNextSlot() {
  if (!schedule) return;
  const { date: today, minutes: nowMin } = zagrebParts(new Date());
  const next = nextStart(today, nowMin);

  // A bare "10:00" is ambiguous once it can come from the other plan, so
  // anything that is not today carries its weekday.
  $("stat-next").textContent = next
    ? `${next.offset === 0 ? "" : dayLabel(next.date) + " "}${next.time} \u00b7 in ${fmtShort(next.minutesAway * 60000)}`
    : "none set";

  for (const el of document.querySelectorAll(".slot__rel[data-time]")) {
    if (el.textContent === "off") continue;
    const occ = nextOccurrence(el.dataset.plan, el.dataset.time, today, nowMin);
    el.textContent = occ ? `in ${fmtShort(occ.minutesAway * 60000)}` : "\u2014";
  }
}

// The most recent enabled slot whose fire window has closed with no ping at or
// after it. Derived live from the schedule and lastPing rather than read out of
// state.missed, so it also catches the case the workflow can never record: a
// slot with no run after it to notice the miss.
function lastMissedSlot(state) {
  if (!schedule || !state) return null;
  const { date: today, minutes: nowMin } = zagrebParts(new Date());
  const last = prevStart(today, nowMin);
  if (!last || last.minutesAgo < FIRE_WINDOW_MIN) return null;
  if (!state.lastPing?.at) return last;
  const pingMinutesAgo = (Date.now() - new Date(state.lastPing.at).getTime()) / 60000;
  return pingMinutesAgo > last.minutesAgo ? last : null;
}

function setHealth(state, text, href) {
  const pill = $("health");
  pill.dataset.state = state;
  $("health-text").textContent = text;
  if (href) pill.href = href;
  else pill.removeAttribute("href");
}

async function refreshStatus() {
  if ($("health").dataset.state === "unknown") setHealth("unknown", "checking");

  let state = null;
  try {
    ({ data: state } = await fetchFile("state.json"));
    $("stat-ping").textContent = state.lastPing
      ? `${fmtDayTime(state.lastPing.at)} · ${state.lastPing.trigger}`
      : "never";
    windowResetsAt = state.window?.resetsAt || null;
    renderWindow();
    renderTrack();
  } catch {
    $("stat-ping").textContent = "unknown";
  }

  try {
    const res = await gh(`/actions/workflows/${WORKFLOW_FILE}/runs?per_page=1`);
    if (!res.ok) throw new Error(res.status);
    const run = (await res.json()).workflow_runs?.[0];
    if (!run) {
      setHealth("stale", "no runs yet");
      return;
    }
    if (run.conclusion === "failure") {
      setHealth("fail", "run failed", run.html_url);
      return;
    }
    // Health is about slots firing, not about the workflow running. A green run
    // that pinged nothing is the exact failure this pill has to surface, so the
    // last passed slot is checked before the run's own age.
    const missed = lastMissedSlot(state);
    if (missed) {
      setHealth("fail", `missed ${missed.time}`, run.html_url);
      return;
    }
    const stale = (Date.now() - new Date(run.created_at)) / 3.6e6 > 24;
    setHealth(stale ? "stale" : "ok", stale ? "cron stale" : "healthy");
  } catch {
    setHealth("fail", "no connection");
  }
}

// ---------- Actions ----------

async function toggleSlot(key, id, enabled) {
  const slot = planSlots(key).find((s) => s.id === id);
  if (!slot) return;
  slot.enabled = enabled;
  renderSlots();
  try {
    await saveSchedule(
      `schedule: ${enabled ? "enable" : "disable"} ${slot.time} on ${PLAN_LABELS[key]}`,
    );
    toast(`${slot.time} ${enabled ? "enabled" : "disabled"} on ${PLAN_LABELS[key]}`);
  } catch (e) {
    toast(`Could not save: ${e.message}`, "error");
    init();
  }
}

async function deleteSlot(key, id, time) {
  schedule.plans[key] = planSlots(key).filter((s) => s.id !== id);
  renderSlots();
  try {
    await saveSchedule(`schedule: remove ${time} from ${PLAN_LABELS[key]}`);
    toast(`${time} removed from ${PLAN_LABELS[key]}`);
  } catch (e) {
    toast(`Could not save: ${e.message}`, "error");
    init();
  }
}

async function addSlot(event) {
  event.preventDefault();
  const form = event.target;
  const key = form.dataset.plan;
  const input = form.querySelector(".add__time");
  const err = form.closest(".plan").querySelector(".add__error");
  const time = input.value;

  err.hidden = true;
  if (!time) {
    err.textContent = "Pick a time first.";
    err.hidden = false;
    input.focus();
    return;
  }
  // Scoped to this plan: the same time legitimately exists in both.
  if (planSlots(key).some((s) => s.time === time)) {
    err.textContent = `${time} is already set for ${PLAN_LABELS[key]}.`;
    err.hidden = false;
    input.focus();
    return;
  }

  schedule.plans[key] = [
    ...planSlots(key),
    { id: Math.random().toString(36).slice(2, 8), time, enabled: true },
  ];
  renderSlots();
  input.value = "";
  try {
    await saveSchedule(`schedule: add ${time} to ${PLAN_LABELS[key]}`);
    toast(`${time} added to ${PLAN_LABELS[key]}`);
  } catch (e) {
    toast(`Could not save: ${e.message}`, "error");
    init();
  }
}

async function startNow() {
  const btn = $("start-now");
  const label = $("start-now-label");
  if (DEMO) {
    windowResetsAt = new Date(Date.now() + WINDOW_MS).toISOString();
    renderWindow();
    renderTrack();
    toast("Demo mode. Nothing was dispatched.");
    return;
  }
  btn.disabled = true;
  label.textContent = "Dispatching…";
  try {
    const res = await gh(`/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
      method: "POST",
      body: JSON.stringify({ ref: cfg.branch }),
    });
    if (res.status !== 204) throw new Error(`HTTP ${res.status}`);
    toast("Workflow dispatched. The window opens in a moment.");
    label.textContent = "Dispatched";
    setTimeout(() => {
      label.textContent = "Start window now";
      btn.disabled = false;
    }, 45000);
    setTimeout(refreshStatus, 45000);
  } catch (e) {
    toast(`Dispatch failed: ${e.message}`, "error");
    label.textContent = "Start window now";
    btn.disabled = false;
  }
}

// ---------- Settings sheet ----------

let lastFocus = null;

function openSheet() {
  lastFocus = document.activeElement;
  $("cfg-error").hidden = true;
  if (cfg) {
    $("cfg-owner").value = cfg.owner;
    $("cfg-repo").value = cfg.repo;
    $("cfg-branch").value = cfg.branch;
    $("pat-hint").hidden = !cfg.pat;
  }
  $("cfg-pat").value = ""; // never echoed back
  $("sheet-backdrop").hidden = false;
  $("setup-sheet").hidden = false;
  $("cfg-owner").focus();
}

function closeSheet() {
  $("sheet-backdrop").hidden = true;
  $("setup-sheet").hidden = true;
  if (lastFocus) lastFocus.focus();
}

function saveCfg(event) {
  event.preventDefault();
  const err = $("cfg-error");
  const owner = $("cfg-owner").value.trim();
  const repo = $("cfg-repo").value.trim();
  const branch = $("cfg-branch").value.trim() || "main";
  const pat = $("cfg-pat").value.trim() || cfg?.pat || "";

  err.hidden = true;
  if (!owner || !repo) {
    err.textContent = "Owner and repository are both required.";
    err.hidden = false;
    return;
  }
  if (!pat) {
    err.textContent = "Paste a fine-grained token with Contents and Actions access.";
    err.hidden = false;
    $("cfg-pat").focus();
    return;
  }

  cfg = { owner, repo, branch, pat };
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  $("cfg-pat").value = "";
  closeSheet();
  init();
}

function showFault(title, message) {
  $("fault").querySelector("h2").textContent = title;
  $("fault-msg").textContent = message;
  $("fault").hidden = false;
  setView("fault");
}

// ---------- Init ----------

async function init() {
  $("fault").hidden = true;

  if (DEMO) {
    const empty = DEMO_STATE === "empty";
    schedule = {
      timezone: TZ,
      plans: empty
        ? { workDay: [], weekend: [] }
        : {
            workDay: [
              { id: "a1", time: "06:45", enabled: true },
              { id: "b2", time: "12:15", enabled: true },
              { id: "c3", time: "17:20", enabled: false },
              { id: "d4", time: "22:40", enabled: true },
            ],
            weekend: [
              { id: "e5", time: "09:30", enabled: true },
              { id: "f6", time: "16:00", enabled: true },
            ],
          },
    };
    windowResetsAt = empty ? null : new Date(Date.now() + 2 * 3600e3 + 47 * 60e3).toISOString();
    setView("ready");
    renderSlots();
    renderWindow();
    $("stat-ping").textContent = empty
      ? "never"
      : `${fmtDayTime(Date.now() - 133 * 60e3)} · schedule`;
    setHealth(empty ? "stale" : "ok", empty ? "no runs yet" : "healthy");
    if (DEMO_STATE === "sheet") openSheet();
    return;
  }

  if (!cfg) {
    setHealth("unknown", "not connected");
    showFault(
      "Not connected yet",
      "Add your GitHub owner, repository and a fine-grained token to read and edit the schedule.",
    );
    openSheet();
    return;
  }

  $("actions-link").href = `https://github.com/${cfg.owner}/${cfg.repo}/actions`;
  setView("loading");
  renderSkeletonSlots();

  try {
    const fetched = await fetchFile("schedule.json");
    schedule = fetched.data;
    scheduleSha = fetched.sha;
  } catch (e) {
    setHealth("fail", "unreachable");
    showFault("Could not load your schedule", `${e.message}. Check the token scopes and the repository name.`);
    return;
  }

  setView("ready");
  renderSlots();
  renderWindow();
  await refreshStatus();
}

$("settings-btn").addEventListener("click", openSheet);
$("close-setup").addEventListener("click", closeSheet);
$("sheet-backdrop").addEventListener("click", closeSheet);
$("setup-form").addEventListener("submit", saveCfg);
$("plans").addEventListener("submit", (e) => {
  if (e.target.classList.contains("add")) addSlot(e);
});
$("plan-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".plan-tab");
  if (btn) setActiveTab(btn.dataset.plan);
});
$("start-now").addEventListener("click", startNow);
$("fault-retry").addEventListener("click", init);
$("fault-settings").addEventListener("click", openSheet);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("setup-sheet").hidden) closeSheet();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && cfg && schedule) refreshStatus();
});

// Keep the countdown, the relative labels and the now-marker live.
setInterval(() => {
  if (document.hidden) return;
  renderWindow();
  if (schedule) {
    renderNextSlot();
    renderTrack();
  }
}, 1000);

init();
