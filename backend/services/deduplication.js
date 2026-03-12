/**
 * Project Scout — Deduplication Engine
 *
 * Prevents duplicate leads from entering the system.
 * Uses multiple signals: title similarity, URL matching,
 * owner+geography combinations, and source overlap.
 *
 * HOW THE APP USES THIS:
 *   - Before any lead is added to Active Leads, it passes through dedup
 *   - Daily updates check new discoveries against all existing leads
 *   - Backfill checks against everything including Not Pursued
 *   - If a match is found, new evidence is appended rather than creating a duplicate
 */

/**
 * Normalize text for comparison — lowercase, strip punctuation, collapse whitespace.
 */
function normalize(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Simple word-overlap similarity (Jaccard-like).
 * Returns 0-1 score.
 */
function wordSimilarity(a, b) {
  const wordsA = new Set(normalize(a).split(' ').filter(w => w.length > 2));
  const wordsB = new Set(normalize(b).split(' ').filter(w => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  
  const union = new Set([...wordsA, ...wordsB]).size;
  return intersection / union;
}

/**
 * Check if two URLs point to the same resource.
 */
function urlMatch(urlA, urlB) {
  if (!urlA || !urlB) return false;
  try {
    const a = new URL(urlA);
    const b = new URL(urlB);
    return a.hostname === b.hostname && a.pathname === b.pathname;
  } catch {
    return normalize(urlA) === normalize(urlB);
  }
}

/**
 * Find an existing lead that matches a candidate.
 *
 * @param {Object} candidate - The new lead candidate
 * @param {Array}  existingLeads - All leads (active, submitted, not pursued)
 * @param {Object} options - { includeNotPursued: boolean }
 * @returns {Object|null} The matched existing lead, or null if no match
 */
export function findDuplicate(candidate, existingLeads, options = {}) {
  const { includeNotPursued = true } = options;
  
  const candidateTitle = normalize(candidate.title || '');
  const candidateOwner = normalize(candidate.owner || '');
  const candidateGeo = normalize(candidate.geography || candidate.location || '');

  for (const lead of existingLeads) {
    // Skip not-pursued unless explicitly included
    if (!includeNotPursued && lead.status === 'not_pursued') continue;

    // ─── Exact title match ────────────────────────────────────
    if (candidateTitle && normalize(lead.title) === candidateTitle) {
      return { lead, matchType: 'exact_title', confidence: 1.0 };
    }

    // ─── URL match ────────────────────────────────────────────
    if (candidate.sourceUrl && urlMatch(candidate.sourceUrl, lead.sourceUrl)) {
      return { lead, matchType: 'exact_url', confidence: 0.95 };
    }

    // ─── High title similarity ────────────────────────────────
    const titleSim = wordSimilarity(candidate.title || '', lead.title || '');
    if (titleSim > 0.7) {
      return { lead, matchType: 'similar_title', confidence: titleSim };
    }

    // ─── Same owner + geography + similar description ─────────
    if (candidateOwner && candidateGeo) {
      const ownerMatch = normalize(lead.owner) === candidateOwner;
      const geoMatch = normalize(lead.geography || lead.location || '').includes(candidateGeo) ||
                       candidateGeo.includes(normalize(lead.geography || lead.location || ''));
      if (ownerMatch && geoMatch) {
        const descSim = wordSimilarity(candidate.description || '', lead.description || '');
        if (descSim > 0.4) {
          return { lead, matchType: 'owner_geo_desc', confidence: 0.75 + descSim * 0.2 };
        }
      }
    }

    // ─── Project name match ───────────────────────────────────
    if (candidate.projectName && lead.projectName) {
      const projSim = wordSimilarity(candidate.projectName, lead.projectName);
      if (projSim > 0.6) {
        return { lead, matchType: 'project_name', confidence: projSim };
      }
    }
  }

  return null;
}

/**
 * Deduplicate a batch of candidates against existing leads.
 * Returns { newLeads: [], updatedLeads: [], skippedNotPursued: [] }
 */
export function deduplicateBatch(candidates, existingLeads, notPursuedLeads) {
  const allLeads = [...existingLeads, ...notPursuedLeads];
  const newLeads = [];
  const updatedLeads = [];
  const skippedNotPursued = [];
  const seenTitles = new Set();

  for (const candidate of candidates) {
    // Internal batch dedup
    const normTitle = normalize(candidate.title);
    if (seenTitles.has(normTitle)) continue;
    seenTitles.add(normTitle);

    const match = findDuplicate(candidate, allLeads);

    if (match) {
      if (match.lead.status === 'not_pursued') {
        // Do not reintroduce not-pursued leads
        skippedNotPursued.push({ candidate, matchedLead: match.lead, reason: 'Already in Not Pursued' });
      } else {
        // Existing lead — update with new evidence
        updatedLeads.push({ candidate, existingLead: match.lead, matchType: match.matchType, confidence: match.confidence });
      }
    } else {
      newLeads.push(candidate);
    }
  }

  return { newLeads, updatedLeads, skippedNotPursued };
}
