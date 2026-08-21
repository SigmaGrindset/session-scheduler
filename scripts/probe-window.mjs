// Asks: can we learn the current 5-hour window's reset time WITHOUT starting a
// window? A normal /v1/messages request starts one, so it can't be polled — see
// README "Detecting windows started elsewhere".
//
// This script only sends requests that should not run inference, and prints
// every anthropic-* response header each one returns. None of them should start
// a window; the point of running it is to find out which (if any) still carry
// `anthropic-ratelimit-unified-5h-reset`.
//
//   node scripts/probe-window.mjs        (needs CLAUDE_CODE_OAUTH_TOKEN)
//
// Run it via the "probe-window" workflow, where the token is already a secret.

const TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
if (!TOKEN) {
  console.error("CLAUDE_CODE_OAUTH_TOKEN is not set.");
  process.exit(1);
}

const MODEL = "claude-haiku-4-5";
const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  "anthropic-beta": "oauth-2025-04-20",
  "anthropic-version": "2023-06-01",
  "content-type": "application/json",
};

const probes = [
  {
    name: "count_tokens",
    note: "free endpoint, no inference, no billing",
    url: "https://api.anthropic.com/v1/messages/count_tokens",
    init: {
      method: "POST",
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }),
    },
  },
  {
    name: "invalid-request",
    note: "rejected at validation, before any inference runs",
    url: "https://api.anthropic.com/v1/messages",
    init: {
      method: "POST",
      // max_tokens must be >= 1, so this 400s without generating anything.
      body: JSON.stringify({ model: MODEL, max_tokens: -1, messages: [{ role: "user", content: "hi" }] }),
    },
  },
  {
    name: "list-models",
    note: "plain GET on the same authenticated path",
    url: "https://api.anthropic.com/v1/models?limit=1",
    init: { method: "GET" },
  },
];

const isoFromEpoch = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? new Date(n * 1000).toISOString() : null;
};

console.log(`probing at ${new Date().toISOString()}\n`);

let found = false;

for (const probe of probes) {
  console.log(`── ${probe.name} (${probe.note})`);
  try {
    const res = await fetch(probe.url, {
      ...probe.init,
      headers: HEADERS,
      signal: AbortSignal.timeout(30_000),
    });

    console.log(`   HTTP ${res.status}`);

    const interesting = [...res.headers.entries()]
      .filter(([k]) => k.startsWith("anthropic-") || k === "retry-after")
      .sort(([a], [b]) => a.localeCompare(b));

    if (interesting.length === 0) {
      console.log("   no anthropic-* headers returned");
    }
    for (const [key, value] of interesting) {
      const iso = key.endsWith("-reset") ? isoFromEpoch(value) : null;
      console.log(`   ${key}: ${value}${iso ? `  → ${iso}` : ""}`);
      if (key === "anthropic-ratelimit-unified-5h-reset") found = true;
    }
  } catch (err) {
    console.log(`   failed: ${err.message}`);
  }
  console.log("");
}

console.log("─".repeat(64));
if (found) {
  console.log(
    "A probe returned anthropic-ratelimit-unified-5h-reset.\n\n" +
      "Before trusting it, confirm it did NOT start a window: run this when you\n" +
      "have not used Claude for over 5 hours. If the reset it reports is roughly\n" +
      "5h from now, the probe started a window and is NOT safe to poll. If it\n" +
      "reports a reset consistent with no window (or omits the header), it is safe\n" +
      "to call every 5 minutes and the app can detect windows you started anywhere.",
  );
} else {
  console.log(
    "No probe returned anthropic-ratelimit-unified-5h-reset.\n\n" +
      "That means the reset time is only observable on a real /v1/messages call,\n" +
      "which itself starts a window — so automatic detection of externally started\n" +
      "windows is not possible through the API alone.",
  );
}
