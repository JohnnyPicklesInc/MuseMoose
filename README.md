# MuseMoose

A shared **AI generation gateway** — one small Cloudflare Worker that turns a
natural-language request into an app's structured object (e.g. a Website Wombat
site manifest, later an InvoiceIguana invoice, a NoteNewt note). One model, one
set of guardrails, many front-ends.

## What it does

`POST /api/generate` with `{ "app": "website-wombat", "prompt": "a painting business in Philly…" }`
→ `{ "manifest": { …the app's structured object… } }`.

Gates run cheapest-first, so the **open model only runs if everything passes**:

1. **CORS / origin allowlist** — only your app domains (`ALLOWED_ORIGINS`).
2. **Turnstile** (optional) — proof-of-human, enforced only if `TURNSTILE_SECRET` is set.
3. **Per-IP rate limit** + a **hard global daily cap** — the global cap bounds worst-case spend.
4. **Cache** — identical `(app, prompt)` requests are served for free.
5. **Workers AI** (open-weight model) with the app's system prompt + schema.
6. **Validation** — a plausible object back, or a clean error (the client re-normalizes fully).

## Security / isolation

The Worker has **only** two bindings (`AI`, `RL`) — no other app's D1/KV/R2 and
**no account API token**. A Worker can only touch what you bind, so it's walled
off from your other projects by construction. Never add a Cloudflare API token here.

## Run it

```sh
npm install

# 1. create the KV namespace and paste the ids into wrangler.toml
npx wrangler kv namespace create RL
npx wrangler kv namespace create RL --preview

# 2. (optional) turn on human verification
npx wrangler secret put TURNSTILE_SECRET

# 3. local dev — Workers AI needs --remote (real binding) + a Cloudflare login
npm run dev            # wrangler dev --remote

# 4. deploy
npm run deploy
```

Then point each app at the deployed URL and add its origin to `ALLOWED_ORIGINS`.

## Config (`wrangler.toml` [vars])

| var | meaning |
|---|---|
| `MODEL` | Workers AI model id. Default `@cf/qwen/qwen2.5-coder-32b-instruct` (strong at structured JSON). Alternatives: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (all-round) or `@cf/meta/llama-3.1-8b-instruct` (cheapest). |
| `ALLOWED_ORIGINS` | comma-separated origins allowed to call the API |
| `RATE_PER_IP_HOUR` / `RATE_GLOBAL_DAY` | abuse limits (global cap = worst-case spend bound) |
| `MAX_PROMPT_CHARS` / `MAX_OUTPUT_TOKENS` | per-request size caps |

## Adding another app

Add an entry to [`src/apps.js`](src/apps.js): a `system` prompt describing that
app's structured object (+ a compact example) and a light `validate()`. The
gateway code doesn't change.

## Notes / next steps

- KV counters are eventually-consistent (can under-count under heavy concurrency).
  For strict limits, swap `RL` for a Durable Object counter.
- Output is best-effort JSON (robust-parsed). For a hard guarantee of valid
  nested structure, move inference to a stack that supports **grammar-constrained
  decoding** (llama.cpp GBNF / vLLM guided decoding); the recursive manifest
  schema is why Workers AI JSON mode alone isn't a guarantee.
