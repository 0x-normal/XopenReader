# X Open Reader

Paste an X post link → pulls it via `rettiwt-api` → republishes it at a clean URL that **any AI agent can read without authentication** (X itself blocks all bots via robots.txt + login walls).

Supports single posts, **full threads** (walks the reply chain up AND down from whichever post you link, so mid-thread links work), and **X Articles** (long-form posts).

## Endpoints

### Posts & threads

| URL | What it serves |
|---|---|
| `/` | UI: paste link, get share links |
| `/t/:id` | Clean server-rendered HTML (readable by humans + AI fetchers, zero JS needed) |
| `/t/:id.md` | **Markdown — best format to hand to an AI agent** |
| `/t/:id.txt` | Plain text |
| `/t/:id.json` | Full structured data (stats, media, quoted posts) |
| `/read?url=<x link>&thread=1` | One-shot fetch + redirect (bookmarklet-friendly) |

### Articles

Paste either article link form and it resolves automatically:
`https://x.com/i/article/:id` (redirect/entity link) or `https://x.com/:user/article/:id`.

| URL | What it serves |
|---|---|
| `/a/:id` | Clean server-rendered article HTML (headings, lists, quotes, images) |
| `/a/:id.md` | **Markdown — full article body, best for AI agents** |
| `/a/:id.txt` | Plain text |
| `/a/:id.json` | Structured data (title, author, cover, published date, parsed blocks, plain text) |

`:id` in the article routes is the article's **seed post id** (the canonical id returned by `/api/fetch`).

Everything fetched is cached in `data/` as JSON, so share links keep working even if the post is later deleted or your cookie dies.

### How article fetching works

`rettiwt-api` has no article support, so `article.js` reuses its authenticated request pipeline (cookies, CSRF, transaction id, proxy, retries) by registering custom GraphQL resources. An `/i/article/:id` link is an entity/redirect id: it's resolved via `ArticleRedirectScreenQuery` to a seed post, whose `article` field carries the body as a Draft.js content state that gets converted to Markdown/text/HTML.

## Deploy on Vercel (no VPS needed)

The repo is Vercel-ready (`api/index.js` + `vercel.json`).

```bash
npm i -g vercel
vercel                      # from the project folder, accept defaults
vercel env add RETTIWT_API_KEY   # paste your key
vercel env add PROXY_URL         # OPTIONAL — only if X blocks Vercel's IPs
vercel --prod
```

Then set `BASE_URL` env to your deployment URL (e.g. `https://x-reader.vercel.app`) and redeploy, so share links are generated correctly.

**Serverless behavior notes:**
- No persistent disk → posts are cached in memory (warm invocations) + `/tmp`. Cold starts simply **refetch live** — share links still work, they carry a `?thread=1` flag when needed.
- Long threads = many sequential X calls. `vercel.json` sets `maxDuration: 60`; very long threads may still time out on the Hobby plan.
- **X may block Vercel's AWS egress IPs** (403/429 on fetch). If that happens, set `PROXY_URL` to a residential proxy (your Decodo setup works: `http://user:pass@host:port`).
- Your `RETTIWT_API_KEY` is a session cookie for an X account — treat the deployment URL as semi-private if you care about others burning your rate limits, or add a simple token check.

## Setup (local / VPS)

```bash
cd x-open-reader
npm install
```

### Cookies — multi-account pool with rotation

The app rotates across all cookies you give it, round-robin. On a **429** the cookie cools down 15 min; on **401/403** (dead cookie) it's benched for 6 h; malformed cookies are skipped without crashing. Check live pool health at **`/pool`**.

Provide cookies via any of these (all can be combined, duplicates removed):

**A) `cookies.json` file (local / VPS)** — copy `cookies.example.json` to `cookies.json`:
```json
[
  "kdt=...;twid=...;ct0=...;auth_token=...",
  "kdt=...;twid=...;ct0=...;auth_token=..."
]
```
Raw cookie strings are auto-encoded — paste them straight from your pool. Already-encoded rettiwt API keys also work. The file is gitignored.

**B) env `RETTIWT_API_KEYS` (Vercel)** — comma or newline separated:
```bash
vercel env add RETTIWT_API_KEYS
# paste: key1,key2,key3
```

**C) env `RETTIWT_API_KEY`** — single key, backward compatible.

To generate a key from a cookie manually:
```bash
node -e "console.log(Buffer.from('kdt=<KDT>;twid=<TWID>;ct0=<CT0>;auth_token=<AUTH_TOKEN>').toString('base64'))"
```
Or log in via CLI: `npx rettiwt-api auth login "<email>" "<username>" "<password>"`

### Run

```bash
RETTIWT_API_KEY="<key>" PORT=3000 BASE_URL="http://<your-vps-ip>:3000" node server.js
```

Without `RETTIWT_API_KEY` it runs in guest mode: single posts usually work, thread expansion (`tweet.replies`) requires auth.

### PM2 (recommended)

```bash
pm2 start server.js --name x-reader \
  --env RETTIWT_API_KEY="<key>" \
  --env BASE_URL="http://<your-vps-ip>:3000"
pm2 save
```

If you later put it behind a domain + nginx/caddy, set `BASE_URL` to that domain so generated share links are correct.

## Workflow with an AI

1. Open the UI, paste `https://x.com/user/status/123...`, tick **Whole thread** if needed.
2. Click **Copy Markdown link for AI**.
3. Paste that link to Claude / any agent → it fetches the `.md` and reads the full post/thread, stats included.

## Notes

- Thread walk is capped at 60 posts per direction.
- Quoted posts are resolved one level deep and included inline.
- Media is included as direct `pbs.twimg.com` URLs (these are publicly fetchable).
- Uses one account's cookie for read-only fetching of public posts — very low risk, but use a farm/burner cookie rather than a main account if you want zero exposure.
