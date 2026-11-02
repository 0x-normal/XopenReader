/**
 * Rotating cookie pool for rettiwt-api.
 *
 * Sources (first found wins, can be combined):
 *   1. env RETTIWT_API_KEYS   - multiple keys, separated by comma or newline (use on Vercel)
 *   2. env RETTIWT_API_KEY    - single key (backward compatible)
 *   3. cookies.json           - local/VPS file: ["key-or-cookie-string", ...]
 *
 * Entries can be either:
 *   - a ready rettiwt API key (base64), or
 *   - a raw cookie string "kdt=...;twid=...;ct0=...;auth_token=..." (auto-encoded)
 *
 * Rotation: round-robin across healthy keys.
 * Failure handling: 429 -> 15 min cooldown; 401/403 -> 6 h cooldown (likely dead cookie).
 */

const fs = require('fs');
const path = require('path');
const { Rettiwt } = require('rettiwt-api');

const COOLDOWN_RATE_MS = 15 * 60 * 1000; // 429
const COOLDOWN_AUTH_MS = 6 * 60 * 60 * 1000; // 401/403

function toApiKey(entry) {
  const s = String(entry).trim();
  if (!s) return null;
  // raw cookie string -> base64 encode; already-encoded keys pass through
  if (s.includes('auth_token=') || s.includes('ct0=')) return Buffer.from(s).toString('base64');
  return s;
}

function loadKeys() {
  const keys = [];
  if (process.env.RETTIWT_API_KEYS) {
    process.env.RETTIWT_API_KEYS.split(/[\n,]+/).forEach((k) => keys.push(k));
  }
  if (process.env.RETTIWT_API_KEY) keys.push(process.env.RETTIWT_API_KEY);
  const file = path.join(__dirname, 'cookies.json');
  if (fs.existsSync(file)) {
    try {
      const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(arr)) arr.forEach((k) => keys.push(k));
    } catch (e) {
      console.error('cookies.json is not valid JSON:', e.message);
    }
  }
  return [...new Set(keys.map(toApiKey).filter(Boolean))];
}

function statusOf(err) {
  return (
    err?.response?.status ||
    err?.status ||
    (/429|TOO_MANY_REQUESTS/i.test(err?.message || '') ? 429 : null) ||
    (/401|403|AUTHENTICATION|UNAUTHORIZED|FORBIDDEN/i.test(err?.message || '') ? 401 : null)
  );
}

class CookiePool {
  constructor() {
    this.proxy = process.env.PROXY_URL || undefined;
    const keys = loadKeys();
    this.slots = keys.map((key, i) => ({
      idx: i,
      key,
      client: null, // built lazily; a malformed cookie must not crash the app
      dead: false,
      cooldownUntil: 0,
      fails: 0,
      uses: 0,
    }));
    if (this.slots.length === 0) {
      // guest fallback: single posts usually work, threads won't
      this.slots.push({
        idx: 0,
        key: null,
        client: null,
        dead: false,
        cooldownUntil: 0,
        fails: 0,
        uses: 0,
        guest: true,
      });
    }
    this.cursor = 0;
  }

  buildClient(slot) {
    if (slot.client || slot.dead) return slot.client;
    try {
      const cfg = {};
      if (slot.key) cfg.apiKey = slot.key;
      if (this.proxy) cfg.proxy = this.proxy;
      slot.client = new Rettiwt(cfg);
    } catch (e) {
      slot.dead = true;
      console.error(`[pool] cookie #${slot.idx} is malformed, marked dead: ${e.message}`);
    }
    return slot.client;
  }

  get size() {
    return this.slots.length;
  }

  get authed() {
    return !this.slots[0]?.guest;
  }

  healthyCount(now = Date.now()) {
    return this.slots.filter((s) => !s.dead && s.cooldownUntil <= now).length;
  }

  next() {
    const now = Date.now();
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[(this.cursor + i) % this.slots.length];
      if (!slot.dead && slot.cooldownUntil <= now) {
        this.cursor = (slot.idx + 1) % this.slots.length;
        slot.uses++;
        return slot;
      }
    }
    // all cooling down or dead: pick the live one that recovers soonest rather than hard-failing
    const alive = this.slots.filter((s) => !s.dead);
    if (alive.length === 0) return null;
    const soonest = alive.sort((a, b) => a.cooldownUntil - b.cooldownUntil)[0];
    soonest.uses++;
    return soonest;
  }

  penalize(idx, err) {
    const slot = this.slots[idx];
    if (!slot) return;
    const st = statusOf(err);
    slot.fails++;
    slot.cooldownUntil = Date.now() + (st === 429 ? COOLDOWN_RATE_MS : COOLDOWN_AUTH_MS);
    console.warn(
      `[pool] cookie #${idx} cooled down (${st || 'auth'}), ${this.healthyCount()}/${this.size} healthy`
    );
  }

  /** Run an API call with rotation + retry on auth/rate errors. */
  async exec(fn) {
    let lastErr = new Error('No usable cookies in pool');
    const attempts = Math.min(this.size, 3) || 1;
    for (let i = 0; i < attempts; i++) {
      const slot = this.next();
      if (!slot) break;
      const client = this.buildClient(slot);
      if (!client) continue; // malformed key, marked dead — try next
      try {
        return await fn(client);
      } catch (e) {
        lastErr = e;
        if (statusOf(e)) {
          this.penalize(slot.idx, e);
          continue; // rotate to next cookie
        }
        // rettiwt-api masks every non-HTTP failure as "Unknown error"; in practice that is
        // x-client-transaction-id failing to parse x.com after an X site change
        if (e?.message === 'Unknown error') {
          throw new Error(
            'rettiwt-api failed before reaching X (likely x-client-transaction-id broke after an X site change) — update rettiwt-api'
          );
        }
        throw e; // not-found / network errors: don't burn other cookies
      }
    }
    throw lastErr;
  }

  summary() {
    const now = Date.now();
    return {
      total: this.size,
      healthy: this.healthyCount(now),
      guest: Boolean(this.slots[0]?.guest),
      slots: this.slots.map((s) => ({
        idx: s.idx,
        uses: s.uses,
        fails: s.fails,
        dead: s.dead,
        coolingDown: s.cooldownUntil > now,
        recoversInSec: s.cooldownUntil > now ? Math.round((s.cooldownUntil - now) / 1000) : 0,
      })),
    };
  }
}

module.exports = { CookiePool };
