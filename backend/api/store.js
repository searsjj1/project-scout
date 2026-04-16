/**
 * /api/store.js — Project Scout Shared Persistence API
 *
 * Serverless function. Deploys to Vercel alongside scan.js.
 * Provides shared key-value persistence for lead-state records
 * so they are no longer trapped in a single browser's localStorage.
 *
 * Backing store: Upstash Redis (via REST API — no native deps).
 * Falls back to in-memory (ephemeral) if Upstash is not configured.
 *
 * Environment variables required for shared persistence:
 *   UPSTASH_REDIS_REST_URL   — from Upstash console
 *   UPSTASH_REDIS_REST_TOKEN — from Upstash console
 *
 * Actions:
 *   GET  ?action=status       → Health check + store type
 *   GET  ?action=get&key=X    → Get a single key
 *   POST ?action=set          → Set a key: { key, value }
 *   POST ?action=sync         → Bulk sync: { records: { key: value, ... } }
 *   GET  ?action=keys         → List all ps_ keys
 *   GET  ?action=export       → Export all lead-state records
 */

const STORE_BUILD_ID = 'store-v1.2-20260416-shared-sources';

// ── Allowed keys (only lead-state records, not settings/config) ──
const ALLOWED_KEYS = new Set([
  'ps_leads',
  'ps_submitted',
  'ps_notpursued',
  'ps_pruning_review_queue',
  'ps_prune_memory',
  'ps_news_brief_archive', // v4-b29: shared weekly BD briefing archive
  'ps_sources',            // v4-b30: shared source registry for server-side scans
  'ps_taxonomy',           // v4-b30: shared taxonomy for server-side scans
  'ps_suppression_rules',  // v4-b35: shared suppression rules from Review queue
]);

// ── Upstash Redis REST client (zero deps, pure fetch) ──
let _redis = null;
function getRedis() {
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  _redis = {
    type: 'upstash',
    async get(key) {
      const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error(`Upstash GET failed: ${resp.status}`);
      const data = await resp.json();
      if (!data.result) return null;
      // Parse the stored JSON string back to the original value.
      // Handle legacy double-stringified data gracefully: if the first parse
      // returns a string (not array/object), try parsing again.
      let parsed = JSON.parse(data.result);
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch { /* keep as string */ }
      }
      return parsed;
    },
    async set(key, value) {
      // Upstash REST SET: POST {url}/set/{key} with the value as body.
      // We JSON.stringify the value ONCE so it's stored as a JSON string.
      // On GET, data.result is this string, and JSON.parse gives back the original.
      const serialized = JSON.stringify(value);
      const resp = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'text/plain',
        },
        body: serialized,
      });
      if (!resp.ok) throw new Error(`Upstash SET failed: ${resp.status}`);
      return true;
    },
    async keys(pattern) {
      const resp = await fetch(`${url}/keys/${encodeURIComponent(pattern)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error(`Upstash KEYS failed: ${resp.status}`);
      const data = await resp.json();
      return data.result || [];
    },
  };
  return _redis;
}

// ── In-memory fallback (ephemeral — lost on cold start) ──
const _memStore = {};
const memClient = {
  type: 'memory',
  async get(key) { return _memStore[key] || null; },
  async set(key, value) { _memStore[key] = value; return true; },
  async keys(pattern) {
    const prefix = pattern.replace('*', '');
    return Object.keys(_memStore).filter(k => k.startsWith(prefix));
  },
};

function getClient() {
  return getRedis() || memClient;
}

// ── CORS headers ──
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).setHeader('Access-Control-Allow-Origin', '*')
      .setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      .setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      .end();
  }

  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  const action = req.query?.action || req.body?.action;
  const client = getClient();

  try {
    // ── STATUS ──
    if (action === 'status') {
      const storeType = client.type || 'unknown';
      const testKey = await client.get('ps_store_health');
      return res.status(200).json({
        ok: true,
        build: STORE_BUILD_ID,
        storeType,
        configured: storeType === 'upstash',
        ts: new Date().toISOString(),
      });
    }

    // ── GET ──
    if (action === 'get') {
      const key = req.query?.key;
      if (!key) return res.status(400).json({ ok: false, error: 'key parameter required' });
      if (!ALLOWED_KEYS.has(key)) return res.status(403).json({ ok: false, error: `Key "${key}" not in allowed set` });
      const value = await client.get(key);
      return res.status(200).json({ ok: true, key, value, ts: new Date().toISOString() });
    }

    // ── SET ──
    if (action === 'set') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { key, value } = req.body || {};
      if (!key) return res.status(400).json({ ok: false, error: 'key required in body' });
      if (!ALLOWED_KEYS.has(key)) return res.status(403).json({ ok: false, error: `Key "${key}" not in allowed set` });
      await client.set(key, value);
      const count = Array.isArray(value) ? value.length : (value ? 1 : 0);
      return res.status(200).json({ ok: true, key, count, ts: new Date().toISOString() });
    }

    // ── SYNC (bulk set) ──
    if (action === 'sync') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });
      const { records } = req.body || {};
      if (!records || typeof records !== 'object') return res.status(400).json({ ok: false, error: 'records object required' });
      const results = {};
      for (const [key, value] of Object.entries(records)) {
        if (!ALLOWED_KEYS.has(key)) {
          results[key] = { ok: false, error: 'not allowed' };
          continue;
        }
        await client.set(key, value);
        results[key] = { ok: true, count: Array.isArray(value) ? value.length : 1 };
      }
      return res.status(200).json({ ok: true, results, ts: new Date().toISOString() });
    }

    // ── KEYS ──
    if (action === 'keys') {
      const keys = await client.keys('ps_*');
      const allowed = keys.filter(k => ALLOWED_KEYS.has(k));
      return res.status(200).json({ ok: true, keys: allowed, ts: new Date().toISOString() });
    }

    // ── EXPORT ──
    if (action === 'export') {
      const data = {};
      for (const key of ALLOWED_KEYS) {
        const value = await client.get(key);
        if (value !== null) data[key] = value;
      }
      return res.status(200).json({ ok: true, data, ts: new Date().toISOString() });
    }

    return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('[Store Error]', err);
    return res.status(500).json({ ok: false, error: err.message, ts: new Date().toISOString() });
  }
};
