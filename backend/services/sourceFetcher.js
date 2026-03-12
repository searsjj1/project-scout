/**
 * Project Scout — Source Fetcher
 *
 * Fetches and parses content from intelligence sources.
 * Handles caching, rate limiting, health tracking, and error recovery.
 *
 * HOW THE APP USES THIS:
 *   - Backfill: Fetches all active sources, parses content
 *   - Daily scan: Fetches sources due for refresh based on cadence
 *   - Test Source: Single fetch with diagnostics
 *   - Active lead maintenance: Re-fetches sources linked to active leads
 */

// ─── FETCH CACHE ──────────────────────────────────────────────
const fetchCache = new Map();
const FETCH_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function getCachedFetch(url) {
  const entry = fetchCache.get(url);
  if (entry && Date.now() - entry.ts < FETCH_CACHE_TTL) return entry;
  fetchCache.delete(url);
  return null;
}

// ─── CADENCE CHECK ────────────────────────────────────────────
const CADENCE_HOURS = {
  daily: 20,        // Allow some overlap
  'twice-weekly': 72,
  weekly: 144,
  biweekly: 312,
  monthly: 672,
};

/**
 * Check if a source is due for refresh based on its cadence.
 */
export function isDueForRefresh(source) {
  if (!source.lastChecked) return true;
  if (source.state !== 'active') return false;
  const hoursSinceCheck = (Date.now() - new Date(source.lastChecked).getTime()) / 3600000;
  const threshold = CADENCE_HOURS[source.refreshCadence] || CADENCE_HOURS.daily;
  return hoursSinceCheck >= threshold;
}

/**
 * Fetch content from a source URL.
 *
 * @param {Object} source - Source record
 * @param {Object} options - { timeout, backendEndpoint }
 * @returns {Object} { success, content, title, lastModified, statusCode, fetchedAt, error }
 */
export async function fetchSource(source, options = {}) {
  const { timeout = 15000, backendEndpoint } = options;

  // Check cache first
  const cached = getCachedFetch(source.url);
  if (cached) {
    return { ...cached.value, fromCache: true };
  }

  const fetchedAt = new Date().toISOString();

  try {
    let content, title, lastModified, statusCode;

    if (backendEndpoint) {
      // Use backend proxy to avoid CORS issues
      const resp = await fetch(`${backendEndpoint}/api/fetch-source`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: source.url, timeout }),
        signal: AbortSignal.timeout(timeout),
      });
      const data = await resp.json();
      content = data.content;
      title = data.title;
      lastModified = data.lastModified;
      statusCode = data.statusCode || resp.status;
    } else {
      // Direct fetch (works in Node.js serverless, may hit CORS in browser)
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const resp = await fetch(source.url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'ProjectScout/1.0 (A&E + SMA Design Lead Intelligence)',
          'Accept': 'text/html, application/json, text/plain',
        },
      });

      clearTimeout(timer);
      statusCode = resp.status;
      lastModified = resp.headers.get('last-modified');
      const raw = await resp.text();

      // Extract text content from HTML
      content = extractTextFromHTML(raw);
      title = extractTitle(raw);
    }

    const result = {
      success: statusCode >= 200 && statusCode < 400,
      content: content?.slice(0, 50000) || '', // Cap at 50K chars
      title,
      lastModified,
      statusCode,
      fetchedAt,
      error: null,
    };

    // Cache successful fetches
    if (result.success) {
      fetchCache.set(source.url, { value: result, ts: Date.now() });
    }

    return result;

  } catch (err) {
    return {
      success: false,
      content: null,
      title: null,
      lastModified: null,
      statusCode: null,
      fetchedAt,
      error: err.name === 'AbortError' ? 'Timeout' : err.message,
    };
  }
}

/**
 * Extract readable text from HTML, stripping tags and scripts.
 */
function extractTextFromHTML(html) {
  if (!html) return '';
  return html
    // Remove scripts and styles
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    // Remove HTML tags
    .replace(/<[^>]+>/g, ' ')
    // Decode common entities
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract page title from HTML.
 */
function extractTitle(html) {
  if (!html) return null;
  const match = html.match(/<title[^>]*>(.*?)<\/title>/i);
  return match ? match[1].trim() : null;
}

/**
 * Batch fetch multiple sources with rate limiting.
 *
 * @param {Array} sources - Array of source records
 * @param {Object} options - { concurrency, delayMs, backendEndpoint }
 * @param {Function} onProgress - Callback (completed, total, source, result)
 * @returns {Array} Array of { source, result }
 */
export async function batchFetch(sources, options = {}, onProgress = null) {
  const { concurrency = 3, delayMs = 500, backendEndpoint } = options;
  const results = [];
  const queue = [...sources];

  async function worker() {
    while (queue.length > 0) {
      const source = queue.shift();
      const result = await fetchSource(source, { backendEndpoint });
      results.push({ source, result });
      if (onProgress) onProgress(results.length, sources.length, source, result);
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    }
  }

  // Launch concurrent workers
  const workers = Array.from({ length: Math.min(concurrency, sources.length) }, () => worker());
  await Promise.all(workers);

  return results;
}

/**
 * Update source health based on fetch result.
 */
export function updateSourceHealth(source, result) {
  const updates = {
    lastChecked: result.fetchedAt || new Date().toISOString(),
  };

  if (result.success) {
    updates.lastSuccessfulFetch = result.fetchedAt;
    updates.fetchHealth = 'healthy';
    if (result.lastModified) {
      updates.lastChanged = result.lastModified;
    }
  } else {
    // Track consecutive failures
    const wasHealthy = source.fetchHealth === 'healthy';
    updates.fetchHealth = wasHealthy ? 'degraded' : 'failing';
  }

  return { ...source, ...updates };
}

/**
 * Clear the fetch cache.
 */
export function clearFetchCache() {
  fetchCache.clear();
}
