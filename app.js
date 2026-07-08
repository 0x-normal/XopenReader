/**
 * X Open Reader
 * Paste an X post or article link -> pulls it via rettiwt-api / GraphQL -> serves it as a clean,
 * server-rendered page any AI agent can fetch without authentication.
 *
 * Endpoints:
 *   GET  /                     UI (paste link, get share links)
 *   POST /api/fetch            { url, thread: bool } -> fetches + caches (posts & articles)
 *   GET  /t/:id                Human/AI readable HTML for posts (no JS required to read)
 *   GET  /t/:id.md             Markdown (best for AI agents)
 *   GET  /t/:id.txt            Plain text
 *   GET  /t/:id.json           Raw structured JSON
 *   GET  /a/:id                Human/AI readable HTML for articles
 *   GET  /a/:id.md             Article in Markdown
 *   GET  /a/:id.txt            Article in plain text
 *   GET  /a/:id.json           Article structured JSON
 *
 * Env:
 *   RETTIWT_API_KEY   rettiwt API key (base64 cookie string). Optional:
 *                     without it, guest mode is used (single posts usually
 *                     work; thread expansion and articles need auth).
 *   PORT              default 3000
 *   BASE_URL          public base URL used in generated share links,
 *                     e.g. https://reader.yourdomain.com (default: request host)
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');

const IS_SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const DATA_DIR = IS_SERVERLESS ? '/tmp/x-reader' : path.join(__dirname, 'data');
const MAX_THREAD_LEN = 60;

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* read-only fs edge case */ }

const MEM_CACHE = new Map(); // survives warm serverless invocations

const { CookiePool } = require('./pool');
const pool = new CookiePool();
const AUTHED = pool.authed;
console.log(`[pool] loaded ${pool.size} cookie(s)${AUTHED ? '' : ' — guest mode'}`);


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

function extractArticleId(input) {
  if (!input) return null;
  const s = String(input).trim();
  const m = s.match(/(?:twitter\.com|x\.com)\/i\/article\/(\d+)/i);
  return m ? m[1] : null;
}

function isArticleUrl(input) {
  if (!input) return false;
  return /(?:twitter\.com|x\.com)\/i\/article\/\d+/i.test(String(input).trim());
}

/* ------------- Article fetcher (direct GraphQL) ------------- */

const X_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

/** Decode a base64 rettiwt api key back into cookie string, or use raw cookie string */
function keyToCookieStr(slot) {
  if (!slot || !slot.key) return null;
  const key = slot.key;
  try {
    const decoded = Buffer.from(key, 'base64').toString('utf8');
    // if it looks like a cookie string, return it
    if (decoded.includes('auth_token=') || decoded.includes('ct0=')) return decoded;
  } catch {}
  // If key itself is a raw cookie string
  if (key.includes('auth_token=') || key.includes('ct0=')) return key;
  return null;
}

/** Parse a cookie string into an object */
function parseCookies(cookieStr) {
  const cookies = {};
  if (!cookieStr) return cookies;
  cookieStr.split(';').forEach((pair) => {
    const [k, ...v] = pair.trim().split('=');
    if (k) cookies[k.trim()] = v.join('=').trim();
  });
  return cookies;
}

/** Fetch an article via X's internal GraphQL endpoint */
async function fetchArticleGraphQL(articleId, cookieStr) {
  const cookies = parseCookies(cookieStr);
  const ct0 = cookies.ct0;
  if (!ct0) throw new Error('Cookie missing ct0 token, cannot fetch article');

  const variables = JSON.stringify({
    articleId: articleId,
    withArticleRichContentState: true,
    withArticlePlainText: true,
  });
  const features = JSON.stringify({
    creator_subscriptions_tweet_preview_api_enabled: true,
    premium_content_api_read_enabled: true,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: false,
    responsive_web_grok_share_attachment_enabled: false,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    responsive_web_home_pinned_timelines_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    rweb_video_timestamps_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_enhance_cards_enabled: false,
  });

  const params = new URLSearchParams({ variables, features });
  const url = `https://x.com/i/api/graphql/6st2IttU9oFnZrTQ71OiYA/ArticleTimeline?${params.toString()}`;

  return new Promise((resolve, reject) => {
    const options = {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${X_BEARER}`,
        'Cookie': cookieStr,
        'X-Csrf-Token': ct0,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'X-Twitter-Active-User': 'yes',
        'X-Twitter-Auth-Type': 'OAuth2Session',
        'X-Twitter-Client-Language': 'en',
        'Referer': `https://x.com/i/article/${articleId}`,
      },
    };

    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Article API returned ${res.statusCode}: ${data.slice(0, 300)}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Failed to parse article response'));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Extract readable content from the GraphQL article response */
function parseArticleResponse(raw, articleId) {
  // Navigate the nested timeline structure
  const instructions =
    raw?.data?.article_timeline_v2?.timeline?.instructions || [];

  let title = '';
  let coverImageUrl = null;
  let authorName = null;
  let authorHandle = null;
  let createdAt = null;
  let blocks = [];

  for (const instruction of instructions) {
    const entries = instruction?.entries || [];
    for (const entry of entries) {
      const content = entry?.content;
      if (!content) continue;

      // Article header entry
      if (content?.entryType === 'TimelineTimelineItem' || content?.__typename === 'TimelineTimelineItem') {
        const itemContent = content?.itemContent;
        if (!itemContent) continue;

        // Article cover/metadata
        if (itemContent?.article_results || itemContent?.articleResults) {
          const articleResult = itemContent?.article_results?.result || itemContent?.articleResults?.result;
          if (articleResult) {
            title = articleResult.title || title;
            coverImageUrl = articleResult.cover_image?.media_info?.original_img_url ||
                           articleResult.cover_image?.url || coverImageUrl;
            createdAt = articleResult.created_at || createdAt;
            if (articleResult.author) {
              authorName = articleResult.author?.name || authorName;
              authorHandle = articleResult.author?.screen_name || authorHandle;
            }
          }
        }

        // Tweet items within the article
        const tweetResults = itemContent?.tweet_results?.result;
        if (tweetResults) {
          const legacy = tweetResults.legacy || tweetResults.tweet?.legacy;
          if (legacy?.full_text) {
            blocks.push({ type: 'tweet', text: legacy.full_text });
          }
        }
      }

      // Module entries (grouped content)
      if (content?.entryType === 'TimelineTimelineModule' || content?.__typename === 'TimelineTimelineModule') {
        const items = content?.items || [];
        for (const item of items) {
          const ic = item?.item?.itemContent;
          if (!ic) continue;
          const tr = ic?.tweet_results?.result;
          if (tr) {
            const legacy = tr.legacy || tr.tweet?.legacy;
            if (legacy?.full_text) {
              blocks.push({ type: 'tweet', text: legacy.full_text });
            }
          }
        }
      }
    }
  }

  // Also try to extract plain text / rich content from the response
  const articleData = raw?.data?.article_timeline_v2?.article ||
                     raw?.data?.articleResult?.result ||
                     null;
  if (articleData) {
    title = articleData.title || title;
    coverImageUrl = articleData.cover_image?.media_info?.original_img_url || coverImageUrl;
    createdAt = articleData.created_at || createdAt;
    if (articleData.author) {
      authorName = articleData.author?.name || authorName;
      authorHandle = articleData.author?.screen_name || authorHandle;
    }
    // Plain text content
    if (articleData.plain_text) {
      blocks = [{ type: 'text', text: articleData.plain_text }];
    }
    // Rich content (array of content blocks)
    if (articleData.rich_content_state) {
      try {
        const rich = typeof articleData.rich_content_state === 'string'
          ? JSON.parse(articleData.rich_content_state)
          : articleData.rich_content_state;
        if (rich.blocks && Array.isArray(rich.blocks)) {
          blocks = rich.blocks.map((b) => ({
            type: b.type || 'text',
            text: b.text || '',
            inlineStyles: b.inlineStyleRanges || [],
            entityRanges: b.entityRanges || [],
          }));
        }
      } catch {}
    }
  }

  // Deeply search for article content in any nested structure
  if (blocks.length === 0) {
    const deepSearch = (obj, depth = 0) => {
      if (!obj || depth > 8) return;
      if (typeof obj !== 'object') return;
      if (obj.plain_text && !title) {
        blocks = [{ type: 'text', text: obj.plain_text }];
      }
      if (obj.title && !title) title = obj.title;
      if (obj.rich_content_state && blocks.length === 0) {
        try {
          const rich = typeof obj.rich_content_state === 'string'
            ? JSON.parse(obj.rich_content_state)
            : obj.rich_content_state;
          if (rich.blocks && Array.isArray(rich.blocks)) {
            blocks = rich.blocks.map((b) => ({
              type: b.type || 'text',
              text: b.text || '',
            }));
          }
        } catch {}
      }
      if (obj.name && !authorName) authorName = obj.name;
      if (obj.screen_name && !authorHandle) authorHandle = obj.screen_name;
      for (const key of Object.keys(obj)) {
        if (key === 'plain_text' || key === 'title') continue;
        if (typeof obj[key] === 'object' && obj[key] !== null) {
          deepSearch(obj[key], depth + 1);
          if (blocks.length > 0 && title) return;
        }
      }
    };
    deepSearch(raw);
  }

  return {
    kind: 'article',
    id: articleId,
    requestedId: articleId,
    title: title || 'Untitled Article',
    coverImage: coverImageUrl,
    author: {
      userName: authorHandle || null,
      fullName: authorName || null,
      followers: null,
    },
    createdAt: createdAt || null,
    fetchedAt: new Date().toISOString(),
    count: blocks.length,
    warning: blocks.length === 0 ? 'Could not extract article content — the response structure may have changed' : null,
    blocks,
    // Store raw for debugging (don't serve this publicly)
    _raw: raw,
  };
}

async function fetchArticle(articleId) {
  // Try each slot in the pool until one works
  const slots = pool.slots.filter((s) => !s.guest && !s.dead);
  if (slots.length === 0) throw new Error('Article fetching requires authenticated cookies — no valid cookies available');

  let lastErr = new Error('No usable cookies');
  for (const slot of slots) {
    const cookieStr = keyToCookieStr(slot);
    if (!cookieStr) continue;
    try {
      const raw = await fetchArticleGraphQL(articleId, cookieStr);
      const parsed = parseArticleResponse(raw, articleId);
      // Cache it
      MEM_CACHE.set(`article:${articleId}`, parsed);
      try {
        const cacheData = { ...parsed };
        delete cacheData._raw;
        fs.writeFileSync(path.join(DATA_DIR, `article_${articleId}.json`), JSON.stringify(cacheData, null, 2));
      } catch {}
      return parsed;
    } catch (e) {
      lastErr = e;
      if (/429|rate/i.test(e.message)) continue;
      if (/401|403/i.test(e.message)) continue;
      throw e;
    }
  }
  throw lastErr;
}

function loadArticle(articleId) {
  const mem = MEM_CACHE.get(`article:${articleId}`);
  if (mem) return mem;
  try {
    const f = path.join(DATA_DIR, `article_${articleId}.json`);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

async function getArticle(articleId) {
  const cached = loadArticle(articleId);
  if (cached) return cached;
  return await fetchArticle(articleId);
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

async function fetchPost(id, asThread) {
  const main = await getDetails(id);
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

function baseUrl(req) {
  return process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- renderers ---------------- */

function articleToMarkdown(rec) {
  const lines = [];
  lines.push(`# ${rec.title}`);
  lines.push('');
  if (rec.author.fullName || rec.author.userName) {
    lines.push(`By ${rec.author.fullName || ''}${rec.author.userName ? ` (@${rec.author.userName})` : ''}`);
    lines.push('');
  }
  lines.push(`- Source: https://x.com/i/article/${rec.id}`);
  lines.push(`- Fetched: ${rec.fetchedAt}`);
  if (rec.createdAt) lines.push(`- Published: ${rec.createdAt}`);
  if (rec.warning) lines.push(`- Note: ${rec.warning}`);
  lines.push('');
  if (rec.coverImage) {
    lines.push(`![Cover](${rec.coverImage})`);
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  for (const block of rec.blocks) {
    if (block.type === 'header-one' || block.type === 'header-two' || block.type === 'header-three') {
      const level = block.type === 'header-one' ? '##' : block.type === 'header-two' ? '###' : '####';
      lines.push(`${level} ${block.text}`);
    } else if (block.type === 'blockquote') {
      block.text.split('\n').forEach((l) => lines.push(`> ${l}`));
    } else if (block.type === 'unordered-list-item') {
      lines.push(`- ${block.text}`);
    } else if (block.type === 'ordered-list-item') {
      lines.push(`1. ${block.text}`);
    } else if (block.type === 'code-block') {
      lines.push('```');
      lines.push(block.text);
      lines.push('```');
    } else if (block.type === 'tweet') {
      lines.push(`> 🐦 ${block.text}`);
    } else {
      lines.push(block.text);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function articleToText(rec) {
  const lines = [];
  lines.push(rec.title);
  lines.push('='.repeat(rec.title.length));
  if (rec.author.fullName || rec.author.userName) {
    lines.push(`By ${rec.author.fullName || ''}${rec.author.userName ? ` (@${rec.author.userName})` : ''}`);
  }
  lines.push('');
  for (const block of rec.blocks) {
    lines.push(block.text);
    lines.push('');
  }
  return lines.join('\n');
}

function articleToHtml(rec, req) {
  const b = baseUrl(req);
  const contentBlocks = rec.blocks.map((block) => {
    if (block.type === 'header-one') return `<h2>${esc(block.text)}</h2>`;
    if (block.type === 'header-two') return `<h3>${esc(block.text)}</h3>`;
    if (block.type === 'header-three') return `<h4>${esc(block.text)}</h4>`;
    if (block.type === 'blockquote') return `<blockquote>${esc(block.text)}</blockquote>`;
    if (block.type === 'unordered-list-item') return `<ul><li>${esc(block.text)}</li></ul>`;
    if (block.type === 'ordered-list-item') return `<ol><li>${esc(block.text)}</li></ol>`;
    if (block.type === 'code-block') return `<pre><code>${esc(block.text)}</code></pre>`;
    if (block.type === 'tweet') return `<blockquote class="tweet-embed">🐦 ${esc(block.text)}</blockquote>`;
    return `<p class="body">${esc(block.text).replace(/\n/g, '<br>')}</p>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(rec.title)} — X Open Reader</title>
<meta name="description" content="${esc((rec.blocks[0]?.text || '').slice(0, 150))}">
<style>
  :root{--ink:#17233b;--dim:#5b6478;--paper:#f6f5f1;--card:#fffdf8;--line:#d8d4c8;--acc:#0e5e4a}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.65 Georgia,'Times New Roman',serif}
  .wrap{max-width:680px;margin:0 auto;padding:40px 20px 80px}
  header.top{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);border-bottom:2px solid var(--ink);padding-bottom:10px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px}
  h1{font-size:26px;margin:22px 0 6px;line-height:1.3}
  .meta{color:var(--dim);font-family:ui-monospace,Menlo,monospace;font-size:13px;margin-bottom:20px}
  .cover{width:100%;max-height:360px;object-fit:cover;border-radius:4px;margin:16px 0}
  .content{margin-top:24px}
  .content p{margin:0 0 16px;font-size:17px}
  .content h2,.content h3,.content h4{margin:28px 0 10px}
  .content blockquote{margin:14px 0;padding:10px 14px;border-left:3px solid var(--line);color:var(--dim);font-size:15px}
  .content .tweet-embed{border-left-color:var(--acc);background:var(--card);padding:14px;font-size:15px}
  .content pre{background:var(--card);border:1px solid var(--line);padding:14px;overflow-x:auto;font-size:13px}
  .content ul,.content ol{margin:0 0 16px;padding-left:24px}
  .fmt{margin-top:30px;font-family:ui-monospace,monospace;font-size:13px}
  .fmt a{color:var(--acc);margin-right:14px}
  a{color:var(--acc)}
</style>
</head>
<body>
<div class="wrap">
  <header class="top"><span>X OPEN READER</span><span>article · fetched ${esc(rec.fetchedAt.slice(0, 10))}</span></header>
  <h1>${esc(rec.title)}</h1>
  <div class="meta">${rec.author.fullName ? esc(rec.author.fullName) : ''}${rec.author.userName ? ` @${esc(rec.author.userName)}` : ''}${rec.createdAt ? ` · ${esc(rec.createdAt)}` : ''} · <a href="https://x.com/i/article/${esc(rec.id)}">original on X</a></div>
  ${rec.coverImage ? `<img class="cover" src="${esc(rec.coverImage)}" alt="Cover">` : ''}
  ${rec.warning ? `<p style="color:#8a5300;font-size:14px">⚠ ${esc(rec.warning)}</p>` : ''}
  <div class="content">${contentBlocks}</div>
  <div class="fmt">machine formats:
    <a href="${b}/a/${rec.id}.md">markdown</a>
    <a href="${b}/a/${rec.id}.txt">plain text</a>
    <a href="${b}/a/${rec.id}.json">json</a>
  </div>
</div>
</body>
</html>`;
}

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

app.post('/api/fetch', async (req, res) => {
  try {
    const url = req.body?.url;

    // Check if it's an article URL
    if (isArticleUrl(url)) {
      const articleId = extractArticleId(url);
      if (!articleId) return res.status(400).json({ error: 'Could not find an article ID in that link.' });
      const rec = await fetchArticle(articleId);
      const b = baseUrl(req);
      return res.json({
        ok: true,
        kind: 'article',
        title: rec.title,
        author: rec.author,
        warning: rec.warning,
        preview: (rec.blocks[0]?.text || '').slice(0, 240),
        links: {
          page: `${b}/a/${rec.id}`,
          markdown: `${b}/a/${rec.id}.md`,
          text: `${b}/a/${rec.id}.txt`,
          json: `${b}/a/${rec.id}.json`,
        },
      });
    }

    const id = extractId(url);
    if (!id) return res.status(400).json({ error: 'Could not find a post ID in that link.' });
    const isThread = Boolean(req.body?.thread);
    const rec = await fetchPost(id, isThread);
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

/* ------------- Article routes ------------- */
app.get('/a/:id.md', async (req, res) => {
  try {
    const rec = await getArticle(req.params.id);
    if (!rec) return res.status(404).type('text/plain').send('Article not found or could not be fetched.');
    res.type('text/markdown; charset=utf-8').send(articleToMarkdown(rec));
  } catch (e) {
    res.status(502).type('text/plain').send(e.message);
  }
});
app.get('/a/:id.txt', async (req, res) => {
  try {
    const rec = await getArticle(req.params.id);
    if (!rec) return res.status(404).type('text/plain').send('Article not found or could not be fetched.');
    res.type('text/plain; charset=utf-8').send(articleToText(rec));
  } catch (e) {
    res.status(502).type('text/plain').send(e.message);
  }
});
app.get('/a/:id.json', async (req, res) => {
  try {
    const rec = await getArticle(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Article not found or could not be fetched.' });
    const { _raw, ...clean } = rec;
    res.json(clean);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
app.get('/a/:id', async (req, res) => {
  try {
    const rec = await getArticle(req.params.id);
    if (!rec) return res.status(404).type('text/plain').send('Article not found and could not be fetched.');
    res.type('html').send(articleToHtml(rec, req));
  } catch (e) {
    res.status(502).type('text/plain').send(e.message);
  }
});

// convenience: /read?url=<x link>&thread=1 -> redirects to the page
app.get('/read', async (req, res) => {
  try {
    const url = req.query.url;
    // Check if it's an article URL
    if (isArticleUrl(url)) {
      const articleId = extractArticleId(url);
      if (!articleId) return res.status(400).type('text/plain').send('Bad article URL');
      const rec = await fetchArticle(articleId);
      return res.redirect(`/a/${rec.id}`);
    }
    const id = extractId(url);
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
  <h1>Make any X post readable by any AI.</h1>
  <p class="sub">Paste a post or article link. It gets pulled, cached, and republished at a clean URL that agents can fetch without login — in HTML, Markdown, plain text, or JSON.</p>

  <div class="row">
    <input type="text" id="url" placeholder="https://x.com/user/status/1234... or https://x.com/i/article/1234..." autofocus>
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
      + '<p class="preview">' + escapeHtml(d.preview) + (d.kind==='thread' ? '\\n\\n[' + d.count + '-post thread]' : d.kind==='article' ? '\\n\\n[Article: ' + escapeHtml(d.title||'') + ']' : '') + '</p>'
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
    btn.disabled = false; btn.textContent = 'Pull';
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
