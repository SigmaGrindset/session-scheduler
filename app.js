"use strict";

const TZ = "Europe/Zagreb";
const CFG_KEY = "sws-config";
const WORKFLOW_FILE = "ping.yml";

const $ = (id) => document.getElementById(id);

let cfg = loadCfg();
let schedule = null;
let scheduleSha = null;

function loadCfg() {
  try {
    return JSON.parse(localStorage.getItem(CFG_KEY)) || null;
  } catch {
    return null;
  }
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
  if (await putSchedule(message)) return;
  // Someone else committed since our fetch: re-fetch sha and retry once.
  const fresh = await fetchFile("schedule.json");
  scheduleSha = fresh.sha;
  if (!(await putSchedule(message))) throw new Error("Saving schedule failed (conflict)");
}

// ---------- Rendering ----------

function toast(msg, ms = 3000) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), ms);
}

function fmtZagreb(iso) {
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: TZ,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    day: "numeric",
    month: "short",
  });
}

function nowInZagrebMinutes() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return get("hour") * 60 + get("minute");
}

function renderSlots() {
  const list = $("slot-list");
  list.innerHTML = "";
  const slots = [...schedule.slots].sort((a, b) => a.time.localeCompare(b.time));
  if (slots.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No start times yet.";
    li.style.color = "var(--muted)";
    list.appendChild(li);
  }
  for (const slot of slots) {
    const li = document.createElement("li");

    const time = document.createElement("span");
    time.className = "slot-time" + (slot.enabled ? "" : " disabled");
    time.textContent = slot.time;

    const sw = document.createElement("label");
    sw.className = "switch";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = slot.enabled;
    cb.addEventListener("change", () => toggleSlot(slot.id, cb.checked));
    const track = document.createElement("span");
    track.className = "track";
    sw.append(cb, track);

    const del = document.createElement("button");
    del.className = "delete-btn";
    del.textContent = "✕";
    del.setAttribute("aria-label", `Delete ${slot.time}`);
    del.addEventListener("click", () => deleteSlot(slot.id, slot.time));

    li.append(time, sw, del);
    list.appendChild(li);
  }
  renderNextSlot();
}

function renderNextSlot() {
  const enabled = schedule.slots.filter((s) => s.enabled).map((s) => s.time).sort();
  let text = "Next start: —";
  if (enabled.length > 0) {
    const nowMin = nowInZagrebMinutes();
    const next = enabled.find((t) => {
      const [h, m] = t.split(":").map(Number);
      return h * 60 + m > nowMin;
    });
    text = next ? `Next start: today ${next}` : `Next start: tomorrow ${enabled[0]}`;
  }
  $("next-slot").textContent = text;
}

async function refreshStatus() {
  const dot = $("health-dot");
  const runLink = $("run-link");
  runLink.hidden = true;

  try {
    const { data: state } = await fetchFile("state.json");
    $("last-ping").textContent = state.lastPing
      ? `Last ping: ${fmtZagreb(state.lastPing.at)} (${state.lastPing.trigger})`
      : "Last ping: never";
  } catch {
    $("last-ping").textContent = "Last ping: unknown";
  }

  try {
    const res = await gh(`/actions/workflows/${WORKFLOW_FILE}/runs?per_page=1`);
    if (!res.ok) throw new Error(res.status);
    const run = (await res.json()).workflow_runs?.[0];
    if (!run) {
      dot.className = "dot stale";
      $("health-text").textContent = "No workflow runs yet";
      return;
    }
    const ageH = (Date.now() - new Date(run.created_at)) / 3.6e6;
    if (run.conclusion === "failure") {
      dot.className = "dot fail";
      $("health-text").textContent = "Last workflow run failed";
      runLink.href = run.html_url;
      runLink.hidden = false;
    } else if (ageH > 24) {
      dot.className = "dot stale";
      $("health-text").textContent = "Workflow stale — no run in 24h (cron may be disabled)";
    } else {
      dot.className = "dot ok";
      $("health-text").textContent = "Workflow healthy";
    }
  } catch {
    dot.className = "dot fail";
    $("health-text").textContent = "Could not reach GitHub";
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
    toast(`Save failed: ${e.message}`);
    init();
  }
}

async function deleteSlot(id, time) {
  if (!confirm(`Delete ${time}?`)) return;
  schedule.slots = schedule.slots.filter((s) => s.id !== id);
  renderSlots();
  try {
    await saveSchedule(`schedule: remove ${time}`);
    toast(`${time} removed`);
  } catch (e) {
    toast(`Save failed: ${e.message}`);
    init();
  }
}

async function addSlot() {
  const time = $("new-time").value;
  if (!time) return toast("Pick a time first");
  if (schedule.slots.some((s) => s.time === time)) return toast(`${time} already exists`);
  schedule.slots.push({ id: Math.random().toString(36).slice(2, 8), time, enabled: true });
  renderSlots();
  $("new-time").value = "";
  try {
    await saveSchedule(`schedule: add ${time}`);
    toast(`${time} added`);
  } catch (e) {
    toast(`Save failed: ${e.message}`);
    init();
  }
}

async function startNow() {
  const btn = $("start-now");
  btn.disabled = true;
  btn.textContent = "Dispatching…";
  try {
    const res = await gh(`/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
      method: "POST",
      body: JSON.stringify({ ref: cfg.branch }),
    });
    if (res.status !== 204) throw new Error(`HTTP ${res.status}`);
    toast("Workflow dispatched — window starting shortly");
    setTimeout(refreshStatus, 45000);
  } catch (e) {
    toast(`Dispatch failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "▶ Start window now";
  }
}

// ---------- Setup ----------

function showSetup(show) {
  $("setup-card").hidden = !show;
  $("status-card").hidden = show;
  $("slots-card").hidden = show;
  $("start-now").hidden = show;
  if (show && cfg) {
    $("cfg-owner").value = cfg.owner;
    $("cfg-repo").value = cfg.repo;
    $("cfg-branch").value = cfg.branch;
    // PAT intentionally not echoed back into the field.
  }
}

function saveCfg() {
  const owner = $("cfg-owner").value.trim();
  const repo = $("cfg-repo").value.trim();
  const branch = $("cfg-branch").value.trim() || "main";
  const pat = $("cfg-pat").value.trim() || cfg?.pat || "";
  if (!owner || !repo || !pat) return toast("Owner, repo and PAT are required");
  cfg = { owner, repo, branch, pat };
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  $("cfg-pat").value = "";
  init();
}

// ---------- Init ----------

async function init() {
  if (!cfg) {
    showSetup(true);
    return;
  }
  showSetup(false);
  try {
    const fetched = await fetchFile("schedule.json");
    schedule = fetched.data;
    scheduleSha = fetched.sha;
    renderSlots();
  } catch (e) {
    toast(`Could not load schedule: ${e.message}`);
    showSetup(true);
    return;
  }
  refreshStatus();
}

$("settings-btn").addEventListener("click", () => showSetup(true));
$("save-cfg").addEventListener("click", saveCfg);
$("add-slot").addEventListener("click", addSlot);
$("start-now").addEventListener("click", startNow);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && cfg && schedule) refreshStatus();
});

init();
