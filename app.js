"use strict";

const TZ = "Europe/Zagreb";
const CFG_KEY = "sws-config";
const WORKFLOW_FILE = "ping.yml";
const WINDOW_MS = 5 * 60 * 60 * 1000; // a usage window runs 5 hours
const DAY_MIN = 24 * 60;

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

// Minutes from now until the next occurrence of a local HH:MM.
function minutesUntil(hhmm, nowMin) {
  const diff = toMinutes(hhmm) - nowMin;
  return diff > 0 ? diff : diff + DAY_MIN;
}

function enabledSlots() {
  return schedule.slots
    .filter((s) => s.enabled)
    .map((s) => s.time)
    .sort();
}

function nextSlotTime(nowMin) {
  const enabled = enabledSlots();
  if (enabled.length === 0) return null;
  return enabled.reduce((best, t) =>
    minutesUntil(t, nowMin) < minutesUntil(best, nowMin) ? t : best,
  );
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

// A 24-hour rail: where the slots sit, where the active window sits, where now is.
function renderTrack() {
  const { minutes: nowMin } = zagrebParts(new Date());
  const marks = $("track-marks");
  const next = schedule ? nextSlotTime(nowMin) : null;

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

  $("track").setAttribute(
    "aria-label",
    `Day rail. Now ${$("now-label").textContent}${next ? `, next start ${next}` : ", no start times enabled"}.`,
  );

  for (const slot of schedule.slots) {
    const x = toMinutes(slot.time) / DAY_MIN;
    const mark = document.createElement("div");
    mark.className = "track__mark";
    if (!slot.enabled) mark.classList.add("track__mark--off");
    if (slot.enabled && slot.time === next) {
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
  const list = $("slot-list");
  list.innerHTML = "";
  $("slot-empty").hidden = true;
  for (let i = 0; i < 3; i++) {
    const li = document.createElement("li");
    li.className = "slot--skel";
    list.appendChild(li);
  }
}

function renderSlots() {
  const list = $("slot-list");
  const { minutes: nowMin } = zagrebParts(new Date());
  const slots = [...schedule.slots].sort((a, b) => a.time.localeCompare(b.time));

  list.innerHTML = "";
  $("slot-empty").hidden = slots.length > 0;

  for (const slot of slots) {
    const li = document.createElement("li");
    li.className = "slot" + (slot.enabled ? "" : " slot--off");

    const row = document.createElement("div");
    row.className = "slot__row";

    const time = document.createElement("span");
    time.className = "slot__time";
    time.textContent = slot.time;

    const rel = document.createElement("span");
    rel.className = "slot__rel";
    rel.dataset.time = slot.time;
    rel.textContent = slot.enabled ? `in ${fmtShort(minutesUntil(slot.time, nowMin) * 60000)}` : "off";

    const sw = document.createElement("label");
    sw.className = "switch";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = slot.enabled;
    cb.setAttribute("aria-label", `${slot.time} enabled`);
    cb.addEventListener("change", () => toggleSlot(slot.id, cb.checked));
    const pill = document.createElement("span");
    pill.className = "track-pill";
    sw.append(cb, pill);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "icon-btn slot__del";
    del.setAttribute("aria-label", `Delete ${slot.time}`);
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
    confirmDel.addEventListener("click", () => deleteSlot(slot.id, slot.time));

    confirm.append(question, cancel, confirmDel);
    li.append(row, confirm);
    list.appendChild(li);
  }

  renderNextSlot();
  renderTrack();
}

function renderNextSlot() {
  if (!schedule) return;
  const { minutes: nowMin } = zagrebParts(new Date());
  const next = nextSlotTime(nowMin);
  $("stat-next").textContent = next
    ? `${next} · in ${fmtShort(minutesUntil(next, nowMin) * 60000)}`
    : "none set";

  for (const el of document.querySelectorAll(".slot__rel[data-time]")) {
    if (el.textContent === "off") continue;
    el.textContent = `in ${fmtShort(minutesUntil(el.dataset.time, nowMin) * 60000)}`;
  }
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
  try {
    const { data: state } = await fetchFile("state.json");
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
    const ageH = (Date.now() - new Date(run.created_at)) / 3.6e6;
    if (run.conclusion === "failure") {
      setHealth("fail", "run failed", run.html_url);
    } else if (ageH > 24) {
      setHealth("stale", "cron stale");
    } else {
      setHealth("ok", "healthy");
    }
  } catch {
    setHealth("fail", "no connection");
  }
}

// ---------- Actions ----------

async function toggleSlot(id, enabled) {
  const slot = schedule.slots.find((s) => s.id === id);
  if (!slot) return;
  slot.enabled = enabled;
  renderSlots();
  try {
    await saveSchedule(`schedule: ${enabled ? "enable" : "disable"} ${slot.time}`);
    toast(`${slot.time} ${enabled ? "enabled" : "disabled"}`);
  } catch (e) {
    toast(`Could not save: ${e.message}`, "error");
    init();
  }
}

async function deleteSlot(id, time) {
  schedule.slots = schedule.slots.filter((s) => s.id !== id);
  renderSlots();
  try {
    await saveSchedule(`schedule: remove ${time}`);
    toast(`${time} removed`);
  } catch (e) {
    toast(`Could not save: ${e.message}`, "error");
    init();
  }
}

async function addSlot(event) {
  event.preventDefault();
  const input = $("new-time");
  const err = $("add-error");
  const time = input.value;

  err.hidden = true;
  if (!time) {
    err.textContent = "Pick a time first.";
    err.hidden = false;
    input.focus();
    return;
  }
  if (schedule.slots.some((s) => s.time === time)) {
    err.textContent = `${time} is already scheduled.`;
    err.hidden = false;
    input.focus();
    return;
  }

  schedule.slots.push({ id: Math.random().toString(36).slice(2, 8), time, enabled: true });
  renderSlots();
  input.value = "";
  try {
    await saveSchedule(`schedule: add ${time}`);
    toast(`${time} added`);
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
      slots: empty
        ? []
        : [
            { id: "a1", time: "06:45", enabled: true },
            { id: "b2", time: "12:15", enabled: true },
            { id: "c3", time: "17:20", enabled: false },
            { id: "d4", time: "22:40", enabled: true },
          ],
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
$("add-form").addEventListener("submit", addSlot);
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
