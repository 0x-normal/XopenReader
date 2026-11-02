/**
 * X Open Reader
 * Paste an X post link -> pulls it via rettiwt-api -> serves it as a clean,
 * server-rendered page any AI agent can fetch without authentication.
 *
 * Endpoints:
 *   GET  /                     UI (paste link, get share links)
 *   POST /api/fetch            { url, thread: bool } -> fetches + caches
 *   GET  /t/:id                Human/AI readable HTML (no JS required to read)
 *   GET  /t/:id.md             Markdown (best for AI agents)
 *   GET  /t/:id.txt            Plain text
 *   GET  /t/:id.json           Raw structured JSON
 *
 * Env:
 *   RETTIWT_API_KEY   rettiwt API key (base64 cookie string). Optional:
 *                     without it, guest mode is used (single posts usually
 *                     work; thread expansion needs auth).
 *   PORT              default 3000
 *   BASE_URL          public base URL used in generated share links,
 *                     e.g. https://reader.yourdomain.com (default: request host)
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const IS_SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const DATA_DIR = IS_SERVERLESS ? '/tmp/x-reader' : path.join(__dirname, 'data');
const MAX_THREAD_LEN = 60;

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* read-only fs edge case */ }

const MEM_CACHE = new Map(); // survives warm serverless invocations

const { CookiePool } = require('./pool');
const pool = new CookiePool();
const AUTHED = pool.authed;
console.log(`[pool] loaded ${pool.size} cookie(s)${AUTHED ? '' : ' — guest mode'}`);

const article = require('./article');
article.registerResources();


const app = express();
app.use(express.json());

/* ---------------- helpers ---------------- */

function extractId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^\d{5,25}$/.test(s)) return s;
  const m = s.match(/(?:twitter\.com|x\.com)\/[^/]+\/status(?:es)?\/(\d+)/i);
  return m ? m[1] : null;
}

function normalize(t) {
  if (!t) return null;
  return {
    id: t.id,
    url: t.url || `https://x.com/${t.tweetBy?.userName || 'i'}/status/${t.id}`,
    author: {
      userName: t.tweetBy?.userName || null,
      fullName: t.tweetBy?.fullName || null,
      followers: t.tweetBy?.followersCount ?? null,
    },
    createdAt: t.createdAt || null,
    text: t.fullText || '',
    lang: t.lang || null,
    conversationId: t.conversationId || null,
    replyTo: t.replyTo || null,
    quotedId: t.quoted || null,
    media: Array.isArray(t.media)
      ? t.media.map((m) => ({ type: m.type || 'unknown', url: m.url || m.thumbnailUrl || null }))
      : [],
    stats: {
      likes: t.likeCount ?? null,
      retweets: t.retweetCount ?? null,
      replies: t.replyCount ?? null,
      views: t.viewCount ?? null,
      bookmarks: t.bookmarkCount ?? null,
    },
  };
}

async function getDetails(id) {
  const t = await pool.exec((c) => c.tweet.details(id));
  if (!t) throw new Error(`Post ${id} not found (deleted, protected, or blocked in guest mode)`);
  return t;
}

/** Walk UP the replyTo chain collecting same-author ancestors (handles "link to last post of thread"). */
async function walkUp(tweet) {
  const chain = [];
  let cur = tweet;
  let hops = 0;
  while (cur.replyTo && hops < MAX_THREAD_LEN) {
    let parent;
    try {
      parent = await getDetails(cur.replyTo);
    } catch {
      break;
    }
    if (!parent || parent.tweetBy?.userName !== tweet.tweetBy?.userName) break;
    chain.unshift(parent);
    cur = parent;
    hops++;
  }
  return chain;
}

/** Walk DOWN: at each step find the same-author reply that points at the current post. */
async function walkDown(tweet) {
  const chain = [];
  const author = tweet.tweetBy?.userName;
  let cur = tweet;
  let hops = 0;
  while (hops < MAX_THREAD_LEN) {
    let replies;
    try {
      const page = await pool.exec((c) => c.tweet.replies(cur.id));
      replies = page?.list || [];
    } catch (e) {
      // replies endpoint usually needs auth; degrade gracefully
      if (chain.length === 0) chain.warning = e.message;
      break;
    }
    const next = replies.find(
      (r) => r.tweetBy?.userName === author && (r.replyTo === cur.id || !r.replyTo)
    ) || replies.find((r) => r.tweetBy?.userName === author);
    if (!next) break;
    chain.push(next);
    cur = next;
    hops++;
  }
  return chain;
}

/**
 * A /status/ link to an X Article is a post whose only content is a t.co link to
 * /i/article/{entityId}. Returns the extractArticle() ref for that link, or null.
 */
function articleRefOfPost(t) {
  const urls = t?.entities?.urls || [];
  const leftover = String(t?.fullText || '').replace(/https?:\/\/t\.co\/\S+/g, '').trim();
  if (leftover) return null;
  for (const u of urls) {
    const ref = article.extractArticle(u);
    if (ref) return ref;
  }
  return null;
}

async function fetchPost(id, asThread, prefetched) {
  const main = prefetched || (await getDetails(id));
  let posts = [normalize(main)];
  let warning = null;

  if (asThread) {
    const up = await walkUp(main);
    const down = await walkDown(main);
    if (down.warning) warning = `Thread expansion incomplete: ${down.warning}`;
    posts = [...up.map(normalize), normalize(main), ...down.map(normalize)];
    // de-dupe just in case
    const seen = new Set();
    posts = posts.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  }

  // resolve quoted posts (one level)
  for (const p of posts) {
    if (p.quotedId) {
      try {
        p.quotedPost = normalize(await getDetails(p.quotedId));
      } catch {
        p.quotedPost = null;
      }
    }
  }

  const record = {
    kind: posts.length > 1 ? 'thread' : 'post',
    id: posts[0].id, // canonical id = first post
    requestedId: id,
    author: posts[0].author,
    fetchedAt: new Date().toISOString(),
    count: posts.length,
    warning,
    posts,
  };
  MEM_CACHE.set(record.id, record);
  if (record.requestedId !== record.id) MEM_CACHE.set(record.requestedId, { alias: record.id });
  try {
    fs.writeFileSync(path.join(DATA_DIR, `${record.id}.json`), JSON.stringify(record, null, 2));
    // also index by the requested id if it differs (mid-thread links)
    if (record.requestedId !== record.id) {
      fs.writeFileSync(
        path.join(DATA_DIR, `${record.requestedId}.json`),
        JSON.stringify({ alias: record.id }, null, 2)
      );
    }
  } catch { /* serverless disk may be unavailable; memory cache still works */ }
  return record;
}

function loadRecord(id) {
  const mem = MEM_CACHE.get(id);
  if (mem) return mem.alias ? loadRecord(mem.alias) : mem;
  try {
    const f = path.join(DATA_DIR, `${id}.json`);
    if (!fs.existsSync(f)) return null;
    const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (rec.alias) return loadRecord(rec.alias);
    return rec;
  } catch {
    return null;
  }
}

/** Cache-or-fetch: serverless share links must work after cold starts. */
async function getRecord(id, thread) {
  const cached = loadRecord(id);
  if (cached) return cached;
  const cleanId = extractId(id);
  if (!cleanId) return null;
  try {
    return await fetchPost(cleanId, thread);
  } catch {
    return null;
  }
}

/* ---------------- article cache helpers ---------------- */

function persist(record, aliases = []) {
  MEM_CACHE.set(record.id, record);
  for (const alias of aliases) {
    if (alias && alias !== record.id) MEM_CACHE.set(alias, { alias: record.id });
  }
  try {
    fs.writeFileSync(path.join(DATA_DIR, `${record.id}.json`), JSON.stringify(record, null, 2));
    for (const alias of aliases) {
      if (alias && alias !== record.id) {
        fs.writeFileSync(path.join(DATA_DIR, `${alias}.json`), JSON.stringify({ alias: record.id }, null, 2));
      }
    }
  } catch { /* serverless disk may be unavailable; memory cache still works */ }
}

/** Fetch (or serve cached) an article from an extractArticle() ref. */
async function getArticleRecord(ref) {
  const cached = loadRecord(ref.id);
  if (cached && cached.kind === 'article') return cached;
  const rec = await article.fetchArticle(pool, ref);
  persist(rec, [ref.id, rec.entityId, rec.requestedId]);
  return rec;
}

/** Serve a cached article by its canonical id, or fetch it as a seed tweet on cold start. */
async function getArticleById(id) {
  const cached = loadRecord(id);
  if (cached && cached.kind === 'article') return cached;
  try {
    const rec = await article.fetchArticle(pool, { id, isEntity: false });
    persist(rec, [id, rec.entityId, rec.requestedId]);
    return rec;
  } catch {
    return null;
  }
}

function baseUrl(req) {
  return process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- renderers ---------------- */

function toMarkdown(rec) {
  const lines = [];
  const a = rec.author;
  lines.push(`# ${rec.kind === 'thread' ? `Thread (${rec.count} posts)` : 'X post'} by ${a.fullName} (@${a.userName})`);
  lines.push('');
  lines.push(`- Source: https://x.com/${a.userName}/status/${rec.id}`);
  lines.push(`- Fetched: ${rec.fetchedAt}`);
  if (rec.warning) lines.push(`- Note: ${rec.warning}`);
  lines.push('');
  rec.posts.forEach((p, i) => {
    if (rec.kind === 'thread') lines.push(`## ${i + 1}/${rec.count}`);
    lines.push(p.text);
    if (p.quotedPost) {
      lines.push('');
      lines.push(`> Quoting @${p.quotedPost.author.userName}:`);
      p.quotedPost.text.split('\n').forEach((l) => lines.push(`> ${l}`));
    }
    if (p.media.length) {
      lines.push('');
      p.media.forEach((m) => lines.push(`![${m.type}](${m.url})`));
    }
    const s = p.stats;
    lines.push('');
    lines.push(
      `*${p.createdAt || ''} — ${s.views ?? '?'} views · ${s.likes ?? '?'} likes · ${s.retweets ?? '?'} reposts · ${s.replies ?? '?'} replies*`
    );
    lines.push('');
  });
  return lines.join('\n');
}

function toText(rec) {
  return rec.posts
    .map((p, i) => (rec.kind === 'thread' ? `[${i + 1}/${rec.count}]\n${p.text}` : p.text))
    .join('\n\n---\n\n');
}

function toHtml(rec, req) {
  const a = rec.author;
  const b = baseUrl(req);
  const postBlocks = rec.posts
    .map((p, i) => {
      const media = p.media
        .map((m) =>
          m.type === 'photo' || m.type === 'unknown'
            ? `<a class="media" href="${esc(m.url)}">${esc(m.type)}: ${esc(m.url)}</a>`
            : `<a class="media" href="${esc(m.url)}">${esc(m.type)}: ${esc(m.url)}</a>`
        )
        .join('');
      const quoted = p.quotedPost
        ? `<blockquote><span class="qa">Quoting @${esc(p.quotedPost.author.userName)}</span>${esc(p.quotedPost.text)}</blockquote>`
        : '';
      const s = p.stats;
      return `<article>
        ${rec.kind === 'thread' ? `<span class="n">${i + 1}/${rec.count}</span>` : ''}
        <p class="body">${esc(p.text).replace(/\n/g, '<br>')}</p>
        ${quoted}
        ${media}
        <footer>${esc(p.createdAt || '')} · ${s.views ?? '?'} views · ${s.likes ?? '?'} likes · ${s.retweets ?? '?'} reposts · ${s.replies ?? '?'} replies</footer>
      </article>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(rec.kind === 'thread' ? 'Thread' : 'Post')} by @${esc(a.userName)} — X Open Reader</title>
<meta name="description" content="${esc(rec.posts[0].text.slice(0, 150))}">
<style>
  :root{--ink:#17233b;--dim:#5b6478;--paper:#f6f5f1;--card:#fffdf8;--line:#d8d4c8;--acc:#0e5e4a}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.65 Georgia,'Times New Roman',serif}
  .wrap{max-width:680px;margin:0 auto;padding:40px 20px 80px}
  header.top{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);border-bottom:2px solid var(--ink);padding-bottom:10px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px}
  h1{font-size:22px;margin:22px 0 2px}
  .handle{color:var(--dim);font-family:ui-monospace,Menlo,monospace;font-size:14px}
  article{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--acc);padding:20px 22px;margin:18px 0;position:relative}
  .n{position:absolute;top:14px;right:16px;font-family:ui-monospace,monospace;font-size:12px;color:var(--dim)}
  .body{margin:0;white-space:normal;font-size:17px}
  blockquote{margin:14px 0 0;padding:10px 14px;border-left:3px solid var(--line);color:var(--dim);font-size:15px}
  .qa{display:block;font-family:ui-monospace,monospace;font-size:11px;text-transform:uppercase;letter-spacing:.1em;margin-bottom:4px}
  .media{display:block;margin-top:10px;font-family:ui-monospace,monospace;font-size:13px;color:var(--acc);word-break:break-all}
  footer{margin-top:14px;font-family:ui-monospace,monospace;font-size:12px;color:var(--dim)}
  .fmt{margin-top:30px;font-family:ui-monospace,monospace;font-size:13px}
  .fmt a{color:var(--acc);margin-right:14px}
  a{color:var(--acc)}
</style>
</head>
<body>
<div class="wrap">
  <header class="top"><span>X OPEN READER</span><span>${esc(rec.kind)} · ${rec.count} post${rec.count > 1 ? 's' : ''} · fetched ${esc(rec.fetchedAt.slice(0, 10))}</span></header>
  <h1>${esc(a.fullName || a.userName)}</h1>
  <div class="handle">@${esc(a.userName)} · <a href="https://x.com/${esc(a.userName)}/status/${esc(rec.id)}">original on X</a></div>
  ${rec.warning ? `<p style="color:#8a5300;font-size:14px">⚠ ${esc(rec.warning)}</p>` : ''}
  ${postBlocks}
  <div class="fmt">machine formats:
    <a href="${b}/t/${rec.id}.md${rec.kind === 'thread' ? '?thread=1' : ''}">markdown</a>
    <a href="${b}/t/${rec.id}.txt${rec.kind === 'thread' ? '?thread=1' : ''}">plain text</a>
    <a href="${b}/t/${rec.id}.json${rec.kind === 'thread' ? '?thread=1' : ''}">json</a>
  </div>
</div>
</body>
</html>`;
}

/* ---------------- routes ---------------- */

function articleResponse(rec, req) {
  const b = baseUrl(req);
  return {
    ok: true,
    kind: 'article',
    title: rec.title,
    author: rec.author,
    warning: rec.warning,
    preview: (rec.previewText || rec.plainText || '').slice(0, 240),
    links: {
      page: `${b}/a/${rec.id}`,
      markdown: `${b}/a/${rec.id}.md`,
      text: `${b}/a/${rec.id}.txt`,
      json: `${b}/a/${rec.id}.json`,
    },
  };
}

app.post('/api/fetch', async (req, res) => {
  try {
    // Articles first: /i/article/:id or /:user/article/:id
    const artRef = article.extractArticle(req.body?.url);
    if (artRef) return res.json(articleResponse(await getArticleRecord(artRef), req));

    const id = extractId(req.body?.url);
    if (!id) return res.status(400).json({ error: 'Could not find a post or article ID in that link.' });
    const isThread = Boolean(req.body?.thread);
    const main = await getDetails(id);

    // /status/ link whose post is just an X Article
    const linkedRef = articleRefOfPost(main);
    if (linkedRef) {
      let rec;
      try {
        // the post is usually the article's own seed post: one request, works in guest mode
        rec = await getArticleRecord({ id, isEntity: false });
      } catch {
        // a post sharing someone else's article: resolve the linked article instead
        rec = await getArticleRecord(linkedRef);
      }
      return res.json(articleResponse(rec, req));
    }

    const rec = await fetchPost(id, isThread, main);
    const b = baseUrl(req);
    const q = isThread ? '?thread=1' : ''; // keeps share links thread-aware after serverless cold starts
    res.json({
      ok: true,
      kind: rec.kind,
      count: rec.count,
      author: rec.author,
      warning: rec.warning,
      preview: rec.posts[0].text.slice(0, 240),
      links: {
        page: `${b}/t/${rec.id}${q}`,
        markdown: `${b}/t/${rec.id}.md${q}`,
        text: `${b}/t/${rec.id}.txt${q}`,
        json: `${b}/t/${rec.id}.json${q}`,
      },
    });
  } catch (e) {
    res.status(502).json({ error: e.message || String(e) });
  }
});

const wantsThread = (req) => req.query.thread === '1' || req.query.thread === 'true';

// ---- article routes (order matters: extension routes before the bare :id route) ----
app.get('/a/:id.md', async (req, res) => {
  const rec = await getArticleById(req.params.id);
  if (!rec) return res.status(404).type('text/plain').send('Article not found or could not be fetched.');
  res.type('text/markdown; charset=utf-8').send(article.toMarkdown(rec));
});
app.get('/a/:id.txt', async (req, res) => {
  const rec = await getArticleById(req.params.id);
  if (!rec) return res.status(404).type('text/plain').send('Article not found or could not be fetched.');
  res.type('text/plain; charset=utf-8').send(article.toText(rec));
});
app.get('/a/:id.json', async (req, res) => {
  const rec = await getArticleById(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Article not found or could not be fetched.' });
  res.json(rec);
});
app.get('/a/:id', async (req, res) => {
  const rec = await getArticleById(req.params.id);
  if (!rec) return res.status(404).type('text/plain').send('Article not found or could not be fetched.');
  res.type('html').send(article.toHtml(rec, baseUrl(req)));
});

// order matters: extension routes before the bare :id route
app.get('/t/:id.md', async (req, res) => {
  const rec = await getRecord(req.params.id, wantsThread(req));
  if (!rec) return res.status(404).type('text/plain').send('Post not found or could not be fetched.');
  res.type('text/markdown; charset=utf-8').send(toMarkdown(rec));
});
app.get('/t/:id.txt', async (req, res) => {
  const rec = await getRecord(req.params.id, wantsThread(req));
  if (!rec) return res.status(404).type('text/plain').send('Post not found or could not be fetched.');
  res.type('text/plain; charset=utf-8').send(toText(rec));
});
app.get('/t/:id.json', async (req, res) => {
  const rec = await getRecord(req.params.id, wantsThread(req));
  if (!rec) return res.status(404).json({ error: 'Post not found or could not be fetched.' });
  res.json(rec);
});
app.get('/t/:id', async (req, res) => {
  const rec = await getRecord(req.params.id, wantsThread(req));
  if (!rec) return res.status(404).type('text/plain').send('Post not found and could not be fetched.');
  res.type('html').send(toHtml(rec, req));
});

// convenience: /read?url=<x link>&thread=1 -> redirects to the page
app.get('/read', async (req, res) => {
  try {
    const id = extractId(req.query.url);
    if (!id) return res.status(400).type('text/plain').send('Bad or missing ?url=');
    const rec = await fetchPost(id, req.query.thread === '1' || req.query.thread === 'true');
    res.redirect(`/t/${rec.id}`);
  } catch (e) {
    res.status(502).type('text/plain').send(e.message);
  }
});

app.get('/pool', (req, res) => res.json(pool.summary()));

app.get('/', (req, res) => {
  const s = pool.summary();
  const label = s.guest
    ? 'guest mode — single posts only, add cookies for threads'
    : `${s.healthy}/${s.total} cookies healthy · rotating`;
  res.type('html').send(HOME_HTML.replace('__AUTH__', label));
});

/* ---------------- home page ---------------- */

const HOME_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>X Open Reader</title>
<style>
  :root{--ink:#17233b;--dim:#5b6478;--paper:#f6f5f1;--card:#fffdf8;--line:#d8d4c8;--acc:#0e5e4a;--err:#a33a2a}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 Georgia,'Times New Roman',serif;min-height:100vh}
  .wrap{max-width:640px;margin:0 auto;padding:48px 20px}
  .masthead{font-family:ui-monospace,Menlo,Consolas,monospace;letter-spacing:.14em;text-transform:uppercase;font-size:12px;color:var(--dim);border-bottom:2px solid var(--ink);padding-bottom:10px;display:flex;justify-content:space-between}
  h1{font-size:30px;margin:26px 0 6px}
  .sub{color:var(--dim);margin:0 0 30px;font-size:15px}
  .row{display:flex;gap:10px;flex-wrap:wrap}
  input[type=text]{flex:1;min-width:240px;padding:13px 14px;border:1px solid var(--line);background:var(--card);font:15px ui-monospace,Menlo,monospace;color:var(--ink)}
  input[type=text]:focus{outline:2px solid var(--acc);outline-offset:1px}
  button{padding:13px 22px;border:none;background:var(--ink);color:var(--paper);font:600 14px ui-monospace,monospace;letter-spacing:.06em;cursor:pointer}
  button:hover{background:var(--acc)}
  button:disabled{opacity:.5;cursor:wait}
  .opt{margin:14px 0 0;font-size:14px;color:var(--dim);display:flex;align-items:center;gap:8px;font-family:ui-monospace,monospace}
  #out{margin-top:30px}
  .card{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--acc);padding:18px 20px}
  .card.err{border-left-color:var(--err);color:var(--err)}
  .preview{white-space:pre-wrap;font-size:15px;margin:0 0 14px}
  .links a{display:block;font-family:ui-monospace,monospace;font-size:13px;color:var(--acc);margin:4px 0;word-break:break-all}
  .copy{margin-top:12px;font-size:12px;font-family:ui-monospace,monospace;background:none;border:1px solid var(--line);color:var(--ink);padding:8px 12px}
  .status{margin-top:40px;font-family:ui-monospace,monospace;font-size:11px;color:var(--dim);letter-spacing:.08em;text-transform:uppercase}
  label{user-select:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="masthead"><span>X OPEN READER</span><span>off the wire, for machines</span></div>
  <h1>Make any X post or article readable by any AI.</h1>
  <p class="sub">Paste a post or Article link. It gets pulled, cached, and republished at a clean URL that agents can fetch without login — in HTML, Markdown, plain text, or JSON.</p>

  <div class="row">
    <input type="text" id="url" placeholder="https://x.com/user/status/1234...  or  /i/article/1234..." autofocus>
    <button id="go">Pull</button>
  </div>
  <div class="opt">
    <input type="checkbox" id="thread"><label for="thread">Whole thread (walks up and down from the linked post)</label>
  </div>

  <div id="out"></div>
  <div class="status">rettiwt-api · __AUTH__</div>
</div>
<script>
const out = document.getElementById('out');
const btn = document.getElementById('go');
async function pull(){
  const url = document.getElementById('url').value.trim();
  if(!url) return;
  btn.disabled = true; btn.textContent = 'Pulling…';
  out.innerHTML = '';
  try{
    const r = await fetch('/api/fetch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url, thread: document.getElementById('thread').checked})});
    const d = await r.json();
    if(!r.ok) throw new Error(d.error || 'Fetch failed');
    out.innerHTML = '<div class="card">'
      + (d.kind==='article' && d.title ? '<p style="font-weight:bold;font-size:17px;margin:0 0 8px">' + escapeHtml(d.title) + '</p>' : '')
      + '<p class="preview">' + escapeHtml(d.preview) + (d.kind==='thread' ? '\\n\\n[' + d.count + '-post thread]' : (d.kind==='article' ? '\\n\\n[X Article]' : '')) + '</p>'
      + (d.warning ? '<p style="color:#8a5300;font-size:13px">⚠ ' + escapeHtml(d.warning) + '</p>' : '')
      + '<div class="links">'
      + '<a href="'+d.links.page+'" target="_blank">'+d.links.page+'</a>'
      + '<a href="'+d.links.markdown+'" target="_blank">'+d.links.markdown+'</a>'
      + '<a href="'+d.links.text+'" target="_blank">'+d.links.text+'</a>'
      + '<a href="'+d.links.json+'" target="_blank">'+d.links.json+'</a>'
      + '</div>'
      + '<button class="copy" onclick="navigator.clipboard.writeText(\\''+d.links.markdown+'\\');this.textContent=\\'Copied\\'">Copy Markdown link for AI</button>'
      + '</div>';
  }catch(e){
    out.innerHTML = '<div class="card err">' + escapeHtml(e.message) + '</div>';
  }finally{
    btn.disabled = false; btn.textContent = 'Pull post';
  }
}
function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
btn.addEventListener('click', pull);
document.getElementById('url').addEventListener('keydown', e=>{ if(e.key==='Enter') pull(); });
</script>
</body>
</html>`;

module.exports = app;
module.exports.AUTHED = AUTHED;
