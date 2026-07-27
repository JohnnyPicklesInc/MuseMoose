// MuseMoose — shared AI generation gateway (Cloudflare Worker).
//
// POST /api/generate  { app, prompt, turnstileToken? }  -> { manifest }  (app's structured object)
// GET  /health        -> { ok: true }
//
// Order of gates (cheapest first — inference only runs if everything passes):
//   CORS/origin -> method/body -> Turnstile(optional) -> per-IP rate limit ->
//   per-app daily cap -> cache -> Workers AI -> validate -> cache put.
//
// Isolation: this Worker only has the `AI` and `RL` bindings from wrangler.toml.
// It cannot reach any other app's data and holds no account API token.

import { APPS } from "./apps.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (url.pathname === "/health") return json({ ok: true }, 200, cors);
    if (url.pathname !== "/api/generate") return json({ error: "not found" }, 404, cors);
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405, cors);
    if (!originAllowed(origin, env)) return json({ error: "origin not allowed" }, 403, cors);

    // ---- parse + validate input ----
    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "bad json" }, 400, cors); }
    const app = APPS[body && body.app];
    if (!app) return json({ error: "unknown app" }, 400, cors);
    const prompt = String((body && body.prompt) || "").trim();
    const maxChars = int(env.MAX_PROMPT_CHARS, 2000);
    if (!prompt) return json({ error: "empty prompt" }, 400, cors);
    if (prompt.length > maxChars) return json({ error: "prompt too long (max " + maxChars + " chars)" }, 400, cors);

    // ---- edit vs generate: a `manifest` in the body means "change this existing
    // site" (prompt = the edit instruction), otherwise "generate a new one". ----
    const editing = !!(body && body.manifest && typeof body.manifest === "object");
    let manifestStr = "";
    if (editing) {
      if (!app.editSystem) return json({ error: "this app does not support editing" }, 400, cors);
      manifestStr = JSON.stringify(body.manifest);
      // The MAX_PROMPT_CHARS check above only covers `prompt`, so guard the
      // manifest separately (a large site would otherwise sail into the model).
      const maxManifest = int(env.MAX_MANIFEST_CHARS, 20000);
      if (manifestStr.length > maxManifest) return json({ error: "site is too large to edit with AI (max " + maxManifest + " chars) — try editing by hand" }, 400, cors);
    }

    // ---- human check (only enforced if a secret is configured) ----
    if (env.TURNSTILE_SECRET) {
      const ip = request.headers.get("CF-Connecting-IP") || "";
      const ok = await verifyTurnstile(env.TURNSTILE_SECRET, body.turnstileToken, ip);
      if (!ok) return json({ error: "verification failed" }, 403, cors);
    }

    // ---- rate limits: per-IP/hour AND a per-app/day cap ----
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const hour = Math.floor(Date.now() / 3.6e6);
    const day = Math.floor(Date.now() / 8.64e7);
    const perIp = await bump(env.RL, "ip:" + ip + ":" + hour, 3600);
    if (perIp > int(env.RATE_PER_IP_HOUR, 20)) return json({ error: "rate limited — try again later" }, 429, cors);
    // Each app gets its OWN daily budget (key includes body.app), so a spike on
    // one app can't exhaust another's — and each app's worst-case spend is bounded.
    const appDay = await bump(env.RL, "app:" + body.app + ":" + day, 86400);
    if (appDay > int(env.RATE_PER_APP_DAY, 1000)) return json({ error: "daily limit reached — back tomorrow" }, 429, cors);

    // ---- cache: identical requests served for free. Edit results are keyed by
    // (manifest + instruction) so they never collide with generation results. ----
    const cacheSeed = editing ? ("edit\n" + manifestStr + "\n" + prompt) : prompt;
    const key = "cache:" + body.app + ":" + (await sha256(body.app + "\n" + cacheSeed));
    const cached = await env.RL.get(key);
    if (cached) {
      try { return json({ manifest: JSON.parse(cached), cached: true }, 200, cors); } catch (e) { /* fall through */ }
    }

    // ---- inference ----
    let manifest;
    try {
      const messages = editing
        ? [
            { role: "system", content: app.editSystem },
            { role: "user", content: "CURRENT MANIFEST:\n" + manifestStr + "\n\nEDIT REQUEST:\n" + prompt }
          ]
        : [
            { role: "system", content: app.system },
            { role: "user", content: prompt }
          ];
      // A full-manifest rewrite needs more room than a fresh generation.
      const maxTokens = editing ? int(env.MAX_OUTPUT_TOKENS_EDIT, 4096) : int(env.MAX_OUTPUT_TOKENS, 2048);
      const out = await env.AI.run(env.MODEL || "@cf/qwen/qwen2.5-coder-32b-instruct", {
        messages: messages,
        max_tokens: maxTokens
      });
      manifest = extractJson(out && (out.response != null ? out.response : out));
    } catch (e) {
      return json({ error: "model error: " + (e && e.message || e) }, 502, cors);
    }
    if (!manifest) return json({ error: "model did not return valid JSON — try rephrasing" }, 502, cors);

    const bad = app.validate ? app.validate(manifest) : null;
    if (bad) return json({ error: "generated site was invalid (" + bad + ") — try again" }, 502, cors);

    // ---- cache the good result (1 day) ----
    try { await env.RL.put(key, JSON.stringify(manifest), { expirationTtl: 86400 }); } catch (e) {}
    return json({ manifest: manifest }, 200, cors);
  }
};

// ---------- helpers ----------
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: Object.assign({ "content-type": "application/json" }, headers || {})
  });
}
function int(v, d) { var n = parseInt(v, 10); return isNaN(n) ? d : n; }

function corsHeaders(origin, env) {
  var h = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Vary": "Origin"
  };
  if (originAllowed(origin, env)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
function originAllowed(origin, env) {
  if (!origin) return false;
  var list = String(env.ALLOWED_ORIGINS || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  return list.indexOf(origin) >= 0;
}

// KV get/put counter with TTL. Note: KV isn't atomic, so under heavy concurrency
// this can under-count slightly — fine as a cost guardrail. For strict limits,
// swap RL for a Durable Object counter.
async function bump(kv, key, ttl) {
  var cur = int(await kv.get(key), 0) + 1;
  await kv.put(key, String(cur), { expirationTtl: ttl });
  return cur;
}

async function sha256(str) {
  var buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [].slice.call(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

// Pull the first JSON object out of the model's text (tolerates ``` fences / stray prose).
function extractJson(text) {
  if (text == null) return null;
  if (typeof text === "object") return text; // some models return parsed JSON
  var s = String(text).replace(/```json\s*|\s*```/g, "");
  var start = s.indexOf("{");
  if (start < 0) return null;
  // find the matching closing brace
  var depth = 0, inStr = false, esc = false;
  for (var i = start; i < s.length; i++) {
    var c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch (e) { return null; } } }
  }
  return null;
}

async function verifyTurnstile(secret, token, ip) {
  if (!token) return false;
  try {
    var form = new FormData();
    form.append("secret", secret);
    form.append("response", token);
    if (ip) form.append("remoteip", ip);
    var res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    var data = await res.json();
    return !!(data && data.success);
  } catch (e) { return false; }
}
