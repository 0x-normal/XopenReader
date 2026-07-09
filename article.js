/**
 * X Article support for X Open Reader.
 *
 * rettiwt-api has no article support, so we reuse its authenticated request
 * pipeline (cookies, CSRF, x-client-transaction-id, migration, proxy, retries) by
 * registering three custom GraphQL resources on its internal collections.
 *
 * How X articles work (reverse-engineered from the web client):
 *   - /i/article/{articleEntityId}  is a REDIRECT screen. ArticleRedirectScreenQuery
 *     resolves the entity id to a "seed tweet" rest id + author screen name, and the
 *     client redirects to /{screen_name}/article/{seedTweetId}.
 *   - The article body lives on the seed tweet's `article` field, fetched via
 *     TweetResultByRestId with the article fieldToggles enabled.
 *
 * The content body is a Draft.js raw content state (blocks + entityMap) which we
 * convert to Markdown / plain text / HTML.
 */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- resource registration ---------------- */

const R_REDIRECT = 'X_ARTICLE_REDIRECT';
const R_TWEET_ARTICLE = 'X_TWEET_ARTICLE';

let registered = false;

function registerResources() {
  if (registered) return;
  try {
    const { ResourceType } = require('rettiwt-api/dist/enums/Resource');
    const Groups = require('rettiwt-api/dist/collections/Groups');
    const { Requests } = require('rettiwt-api/dist/collections/Requests');

    const add = (name, builder) => {
      ResourceType[name] = name;
      if (!Groups.FetchResourcesGroup.includes(name)) Groups.FetchResourcesGroup.push(name);
      if (!Groups.AllowGuestAuthenticationGroup.includes(name)) Groups.AllowGuestAuthenticationGroup.push(name);
      Requests[name] = builder;
    };

    add(R_REDIRECT, (args) => ({
      method: 'get',
      url: 'https://x.com/i/api/graphql/zrSRXJmE1vj37AUmkh2oGg/ArticleRedirectScreenQuery',
      params: {
        variables: JSON.stringify({ articleEntityId: args.id }),
        features: JSON.stringify(NAV_FEATURES),
      },
      paramsSerializer: { encode: encodeURIComponent },
    }));

    add(R_TWEET_ARTICLE, (args) => ({
      method: 'get',
      url: 'https://x.com/i/api/graphql/aFvUsJm2c-oDkJV75blV6g/TweetResultByRestId',
      params: {
        variables: JSON.stringify({
          tweetId: args.id,
          referrer: 'home',
          with_rux_injections: false,
          includePromotedContent: false,
          withCommunity: false,
          withQuickPromoteEligibilityTweetFields: false,
          withBirdwatchNotes: false,
          withVoice: false,
          withV2Timeline: false,
        }),
        features: JSON.stringify(TWEET_FEATURES),
        fieldToggles: JSON.stringify({
          withArticleRichContentState: true,
          withArticlePlainText: true,
          withGrokAnalyze: false,
          withDisallowedReplyControls: false,
        }),
      },
      paramsSerializer: { encode: encodeURIComponent },
    }));

    registered = true;
  } catch (e) {
    console.error('[article] failed to register article resources:', e.message);
  }
}

const NAV_FEATURES = {
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

const TWEET_FEATURES = {
  creator_subscriptions_tweet_preview_api_enabled: true,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: false,
  responsive_web_jetfuel_frame: false,
  responsive_web_grok_share_attachment_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_analysis_button_from_backend: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: false,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

module.exports = {
  registerResources,
  extractArticle,
  fetchArticle,
  toMarkdown: articleToMarkdown,
  toText: articleToText,
  toHtml: articleToHtml,
};

/* remaining helpers are appended below */

/* ---------------- id extraction ---------------- */

/**
 * Detects an X article link and returns { id, isEntity } or null.
 *   /i/article/{id}        -> entity id (needs redirect resolution)
 *   /{user}/article/{id}   -> seed tweet id (direct)
 */
function extractArticle(input) {
  if (!input) return null;
  const s = String(input).trim();
  let m = s.match(/(?:twitter\.com|x\.com)\/i\/article\/(\d+)/i);
  if (m) return { id: m[1], isEntity: true };
  m = s.match(/(?:twitter\.com|x\.com)\/[^/]+\/article\/(\d+)/i);
  if (m) return { id: m[1], isEntity: false };
  return null;
}

/* ---------------- fetching ---------------- */

function pickTweetResult(data) {
  // TweetResultByRestId -> data.tweetResult.result
  const r = data && data.data && data.data.tweetResult && data.data.tweetResult.result;
  if (!r) return null;
  // tweets behind visibility wrappers nest the real tweet under .tweet
  return r.__typename === 'TweetWithVisibilityResults' ? r.tweet : r;
}

/** Resolve an article-entity id to its seed tweet id + author. */
async function resolveEntity(pool, entityId) {
  const res = await pool.exec((c) => c.tweet.request(R_REDIRECT, { id: entityId }));
  const result = res?.data?.data?.article_result_by_rest_id?.result;
  const meta = result?.metadata;
  const seedTweetId = meta?.tweet_results?.rest_id || null;
  const screenName = meta?.author_results?.result?.core?.screen_name || null;
  return { seedTweetId, screenName };
}

/**
 * Fetch an X article and return a normalized record.
 * @param pool - the CookiePool instance
 * @param ref  - { id, isEntity } from extractArticle
 */
async function fetchArticle(pool, ref) {
  registerResources();
  let seedTweetId = ref.id;
  let entityId = null;

  if (ref.isEntity) {
    entityId = ref.id;
    const { seedTweetId: sid } = await resolveEntity(pool, entityId);
    if (!sid) throw new Error(`Article ${entityId} not found (deleted, unpublished, or unavailable).`);
    seedTweetId = sid;
  }

  const res = await pool.exec((c) => c.tweet.request(R_TWEET_ARTICLE, { id: seedTweetId }));
  const tweet = pickTweetResult(res?.data);
  if (!tweet) throw new Error(`Article seed post ${seedTweetId} not found.`);

  const art = tweet.article?.article_results?.result;
  if (!art) throw new Error('That post does not contain an X Article.');

  const record = normalizeArticle(tweet, art, { seedTweetId, entityId, requestedId: ref.id });
  return record;
}

/* ---------------- normalization ---------------- */

function normalizeArticle(tweet, art, ids) {
  const user = tweet.core?.user_results?.result || {};
  const uCore = user.core || {};
  const uLegacy = user.legacy || {};
  const userName = uCore.screen_name || uLegacy.screen_name || 'i';
  const fullName = uCore.name || uLegacy.name || userName;

  const mediaMap = buildMediaMap(art.media_entities);
  const blocks = art.content_state ? blocksFromContentState(art.content_state, mediaMap) : [];

  const cover =
    art.cover_media?.media_info?.original_img_url ||
    art.cover_media?.media_url_https ||
    null;

  const publishedAt = art.metadata?.first_published_at_secs
    ? new Date(art.metadata.first_published_at_secs * 1000).toISOString()
    : null;

  const legacy = tweet.legacy || {};

  return {
    kind: 'article',
    id: ids.seedTweetId,
    requestedId: ids.requestedId,
    entityId: ids.entityId,
    canonicalUrl: `https://x.com/${userName}/article/${ids.seedTweetId}`,
    author: {
      userName,
      fullName,
      followers: uLegacy.followers_count ?? null,
    },
    title: art.title || '(untitled article)',
    previewText: art.preview_text || '',
    coverImage: cover,
    publishedAt,
    fetchedAt: new Date().toISOString(),
    count: 1,
    warning: null,
    blocks,
    plainText: art.plain_text || blocksToPlainText(blocks),
    stats: {
      likes: legacy.favorite_count ?? null,
      retweets: legacy.retweet_count ?? null,
      replies: legacy.reply_count ?? null,
      views: tweet.views?.count ?? null,
      bookmarks: legacy.bookmark_count ?? null,
    },
    // kept for compatibility with generic consumers
    posts: [{ text: art.plain_text || blocksToPlainText(blocks) }],
  };
}

function buildMediaMap(mediaEntities) {
  const map = {};
  if (!Array.isArray(mediaEntities)) return map;
  for (const m of mediaEntities) {
    const url = m.media_info?.original_img_url || m.media_url_https || null;
    if (m.media_id && url) {
      map[m.media_id] = {
        url,
        width: m.media_info?.original_img_width ?? null,
        height: m.media_info?.original_img_height ?? null,
      };
    }
  }
  return map;
}

/* ---------------- Draft.js content-state -> blocks ---------------- */

function entityValue(entityMap, key) {
  const e = entityMap && entityMap[String(key)];
  if (!e) return null;
  return e.value || e; // entries are { key, value: { data, type, mutability } }
}

/** Split a block's text into styled/linked segments. */
function segmentize(block, entityMap) {
  const text = block.text || '';
  const n = text.length;
  if (!n) return [];
  const flags = Array.from({ length: n }, () => ({ bold: false, italic: false, code: false, link: null }));

  for (const r of block.inlineStyleRanges || []) {
    const style = String(r.style || '');
    for (let i = r.offset; i < r.offset + r.length && i < n; i++) {
      if (/bold/i.test(style)) flags[i].bold = true;
      else if (/italic/i.test(style)) flags[i].italic = true;
      else if (/code/i.test(style)) flags[i].code = true;
    }
  }
  for (const r of block.entityRanges || []) {
    const val = entityValue(entityMap, r.key);
    if (val && val.type === 'LINK') {
      const url = val.data?.url || val.data?.href || null;
      for (let i = r.offset; i < r.offset + r.length && i < n; i++) flags[i].link = url;
    }
  }

  const segs = [];
  let cur = null;
  for (let i = 0; i < n; i++) {
    const f = flags[i];
    if (!cur || cur.bold !== f.bold || cur.italic !== f.italic || cur.code !== f.code || cur.link !== f.link) {
      cur = { bold: f.bold, italic: f.italic, code: f.code, link: f.link, text: '' };
      segs.push(cur);
    }
    cur.text += text[i];
  }
  return segs;
}

function mediaForBlock(block, entityMap, mediaMap) {
  for (const r of block.entityRanges || []) {
    const val = entityValue(entityMap, r.key);
    if (val && (val.type === 'MEDIA' || val.type === 'IMAGE')) {
      const items = val.data?.mediaItems || [];
      for (const it of items) {
        const hit = it.mediaId && mediaMap[it.mediaId];
        if (hit) return hit;
      }
      // direct url on the entity, if any
      if (val.data?.media_url_https) return { url: val.data.media_url_https };
      if (val.data?.url) return { url: val.data.url };
    }
  }
  return null;
}

const HEADING_LEVELS = {
  'header-one': 1,
  'header-two': 2,
  'header-three': 3,
  'header-four': 4,
  'header-five': 5,
  'header-six': 6,
};

function blocksFromContentState(cs, mediaMap) {
  const out = [];
  const blocks = Array.isArray(cs.blocks) ? cs.blocks : [];
  const entityMap = cs.entityMap || {};

  for (const b of blocks) {
    const type = b.type || 'unstyled';

    if (type === 'atomic') {
      const media = mediaForBlock(b, entityMap, mediaMap);
      if (media) out.push({ type: 'image', url: media.url, alt: '' });
      continue;
    }

    const segments = segmentize(b, entityMap);

    if (HEADING_LEVELS[type]) {
      out.push({ type: 'heading', level: HEADING_LEVELS[type], segments });
    } else if (type === 'blockquote') {
      out.push({ type: 'quote', segments });
    } else if (type === 'unordered-list-item') {
      out.push({ type: 'list', ordered: false, depth: b.depth || 0, segments });
    } else if (type === 'ordered-list-item') {
      out.push({ type: 'list', ordered: true, depth: b.depth || 0, segments });
    } else if (type === 'code-block') {
      out.push({ type: 'code', text: b.text || '' });
    } else {
      out.push({ type: 'paragraph', segments });
    }
  }
  return out;
}

function segsToPlain(segments) {
  return (segments || []).map((s) => s.text).join('');
}

function blocksToPlainText(blocks) {
  return blocks
    .map((b) => (b.type === 'image' ? '' : b.type === 'code' ? b.text : segsToPlain(b.segments)))
    .filter((l) => l !== '')
    .join('\n\n');
}

/* ---------------- renderers ---------------- */

function segsToMarkdown(segments) {
  return (segments || [])
    .map((s) => {
      let t = s.text;
      if (!t) return '';
      if (s.code) t = '`' + t + '`';
      if (s.bold) t = '**' + t + '**';
      if (s.italic) t = '*' + t + '*';
      if (s.link) t = `[${t}](${s.link})`;
      return t;
    })
    .join('');
}

function articleToMarkdown(rec) {
  const a = rec.author;
  const lines = [];
  lines.push(`# ${rec.title}`);
  lines.push('');
  lines.push(`*By ${a.fullName} (@${a.userName})${rec.publishedAt ? ` · ${rec.publishedAt.slice(0, 10)}` : ''}*`);
  lines.push('');
  lines.push(`- Source: ${rec.canonicalUrl}`);
  lines.push(`- Fetched: ${rec.fetchedAt}`);
  if (rec.warning) lines.push(`- Note: ${rec.warning}`);
  lines.push('');
  if (rec.coverImage) {
    lines.push(`![cover](${rec.coverImage})`);
    lines.push('');
  }

  let prevList = false;
  for (const b of rec.blocks) {
    const isList = b.type === 'list';
    if (prevList && !isList) lines.push('');
    switch (b.type) {
      case 'heading':
        lines.push('#'.repeat(Math.min(6, b.level + 1)) + ' ' + segsToMarkdown(b.segments));
        lines.push('');
        break;
      case 'quote':
        lines.push('> ' + segsToMarkdown(b.segments));
        lines.push('');
        break;
      case 'list': {
        const indent = '  '.repeat(b.depth || 0);
        lines.push(indent + (b.ordered ? '1. ' : '- ') + segsToMarkdown(b.segments));
        break;
      }
      case 'code':
        lines.push('```');
        lines.push(b.text);
        lines.push('```');
        lines.push('');
        break;
      case 'image':
        lines.push(`![${b.alt || 'image'}](${b.url})`);
        lines.push('');
        break;
      default:
        lines.push(segsToMarkdown(b.segments));
        lines.push('');
    }
    prevList = isList;
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function articleToText(rec) {
  const a = rec.author;
  const lines = [];
  lines.push(rec.title);
  lines.push(`By ${a.fullName} (@${a.userName})${rec.publishedAt ? ` · ${rec.publishedAt.slice(0, 10)}` : ''}`);
  lines.push(rec.canonicalUrl);
  lines.push('');
  lines.push('='.repeat(60));
  lines.push('');
  for (const b of rec.blocks) {
    switch (b.type) {
      case 'heading':
        lines.push(segsToPlain(b.segments).toUpperCase());
        lines.push('');
        break;
      case 'quote':
        lines.push('  " ' + segsToPlain(b.segments) + ' "');
        lines.push('');
        break;
      case 'list':
        lines.push('  '.repeat(b.depth || 0) + (b.ordered ? '  - ' : '  - ') + segsToPlain(b.segments));
        break;
      case 'code':
        lines.push(b.text);
        lines.push('');
        break;
      case 'image':
        lines.push(`[image: ${b.url}]`);
        lines.push('');
        break;
      default:
        lines.push(segsToPlain(b.segments));
        lines.push('');
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function segsToHtml(segments) {
  return (segments || [])
    .map((s) => {
      let t = esc(s.text);
      if (!s.text) return '';
      if (s.code) t = `<code>${t}</code>`;
      if (s.bold) t = `<strong>${t}</strong>`;
      if (s.italic) t = `<em>${t}</em>`;
      if (s.link) t = `<a href="${esc(s.link)}">${t}</a>`;
      return t;
    })
    .join('');
}

function articleToHtml(rec, baseUrl) {
  const a = rec.author;
  const body = [];
  let listBuf = null; // { ordered, items: [] }
  const flushList = () => {
    if (listBuf) {
      const tag = listBuf.ordered ? 'ol' : 'ul';
      body.push(`<${tag}>${listBuf.items.map((i) => `<li>${i}</li>`).join('')}</${tag}>`);
      listBuf = null;
    }
  };

  for (const b of rec.blocks) {
    if (b.type === 'list') {
      if (!listBuf || listBuf.ordered !== b.ordered) {
        flushList();
        listBuf = { ordered: b.ordered, items: [] };
      }
      listBuf.items.push(segsToHtml(b.segments));
      continue;
    }
    flushList();
    switch (b.type) {
      case 'heading': {
        const lvl = Math.min(6, b.level + 1);
        body.push(`<h${lvl}>${segsToHtml(b.segments)}</h${lvl}>`);
        break;
      }
      case 'quote':
        body.push(`<blockquote>${segsToHtml(b.segments)}</blockquote>`);
        break;
      case 'code':
        body.push(`<pre><code>${esc(b.text)}</code></pre>`);
        break;
      case 'image':
        body.push(`<figure><img src="${esc(b.url)}" alt="${esc(b.alt || '')}" loading="lazy"><figcaption>${esc(b.url)}</figcaption></figure>`);
        break;
      default: {
        const html = segsToHtml(b.segments);
        if (html.trim()) body.push(`<p>${html}</p>`);
      }
    }
  }
  flushList();

  const b = baseUrl || '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(rec.title)} — X Open Reader</title>
<meta name="description" content="${esc(rec.previewText.slice(0, 150))}">
<style>
  :root{--ink:#17233b;--dim:#5b6478;--paper:#f6f5f1;--card:#fffdf8;--line:#d8d4c8;--acc:#0e5e4a}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font:18px/1.75 Georgia,'Times New Roman',serif}
  .wrap{max-width:720px;margin:0 auto;padding:40px 22px 90px}
  header.top{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);border-bottom:2px solid var(--ink);padding-bottom:10px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px}
  h1.title{font-size:34px;line-height:1.2;margin:26px 0 10px}
  .byline{color:var(--dim);font-size:15px;margin-bottom:6px}
  .byline a{color:var(--acc)}
  .cover{width:100%;height:auto;margin:22px 0;border:1px solid var(--line)}
  article{font-size:18px}
  article h2{font-size:26px;margin:34px 0 10px}
  article h3{font-size:22px;margin:28px 0 8px}
  article h4,article h5,article h6{margin:22px 0 6px}
  article p{margin:0 0 20px}
  article a{color:var(--acc)}
  article blockquote{margin:22px 0;padding:8px 20px;border-left:3px solid var(--acc);color:var(--dim);font-style:italic}
  article ul,article ol{margin:0 0 20px;padding-left:28px}
  article li{margin:6px 0}
  article figure{margin:24px 0}
  article img{max-width:100%;height:auto;border:1px solid var(--line)}
  article figcaption{font-family:ui-monospace,monospace;font-size:11px;color:var(--dim);word-break:break-all;margin-top:6px}
  article pre{background:#f0eee7;border:1px solid var(--line);padding:14px;overflow:auto;font-size:14px}
  article code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.9em}
  .fmt{margin-top:44px;padding-top:16px;border-top:1px solid var(--line);font-family:ui-monospace,monospace;font-size:13px}
  .fmt a{color:var(--acc);margin-right:14px}
</style>
</head>
<body>
<div class="wrap">
  <header class="top"><span>X OPEN READER</span><span>article · fetched ${esc(rec.fetchedAt.slice(0, 10))}</span></header>
  <h1 class="title">${esc(rec.title)}</h1>
  <div class="byline">By ${esc(a.fullName)} (<a href="https://x.com/${esc(a.userName)}">@${esc(a.userName)}</a>)${rec.publishedAt ? ` · ${esc(rec.publishedAt.slice(0, 10))}` : ''}</div>
  <div class="byline"><a href="${esc(rec.canonicalUrl)}">original on X</a></div>
  ${rec.warning ? `<p style="color:#8a5300;font-size:14px">⚠ ${esc(rec.warning)}</p>` : ''}
  ${rec.coverImage ? `<img class="cover" src="${esc(rec.coverImage)}" alt="cover" loading="lazy">` : ''}
  <article>
    ${body.join('\n    ')}
  </article>
  <div class="fmt">machine formats:
    <a href="${b}/a/${rec.id}.md">markdown</a>
    <a href="${b}/a/${rec.id}.txt">plain text</a>
    <a href="${b}/a/${rec.id}.json">json</a>
  </div>
</div>
</body>
</html>`;
}
