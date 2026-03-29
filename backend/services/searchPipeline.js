/**
 * Project Scout — Search Pipeline
 *
 * The master orchestrator for all intelligence operations.
 * Coordinates source fetching, content analysis, scoring,
 * deduplication, evidence creation, and lead management.
 *
 * Three primary operations:
 *   1. runBackfill()   — Initial 6-month historical search
 *   2. runDailyScan()  — Daily discovery of new leads
 *   3. runMaintenance() — Refresh active leads with recent evidence
 *
 * ARCHITECTURE:
 *   Sources → Fetch → Pre-filter (keywords) → Classify (AI if needed)
 *     → Score → Deduplicate → Create/Update Leads → Generate Evidence
 *
 * COST CONTROL STRATEGY:
 *   1. Keywords and rules screen content BEFORE AI is called
 *   2. Cache all fetch and AI results
 *   3. Only call AI on content that passes keyword pre-filters
 *   4. Use cheapest model (Haiku/GPT-4o-mini) for routine classification
 *   5. Batch operations to minimize API calls
 */

import { scoreLead, isLeadFresh, needsRecheck, isStrongerEvidence } from './scoringEngine.js';
import { findDuplicate, deduplicateBatch } from './deduplication.js';
import { classifyContent, enrichLead, summarizeEvidence, callAI, PROMPTS } from './aiService.js';
import { fetchSource, batchFetch, isDueForRefresh, updateSourceHealth } from './sourceFetcher.js';
import { createEvidenceRecord, appendEvidence, isEvidenceStronger } from './evidenceEngine.js';

// ─── SIGNAL TERMS FOR PRE-FILTERING ──────────────────────────
const ALL_SIGNAL_TERMS = [
  'rfq', 'rfp', 'invitation to bid', 'design services', 'architect',
  'capital improvement', 'bond', 'levy', 'facilities plan', 'master plan',
  'addition', 'renovation', 'remodel', 'campus', 'clinic', 'hospital',
  'airport', 'hangar', 'terminal', 'school', 'housing', 'subdivision',
  'annexation', 'rezoning', 'redevelopment', 'tenant improvement',
  'public works', 'utility', 'infrastructure', 'construction',
  'building', 'facility', 'project', 'development', 'expansion',
  // Future-signal / Watch keywords — LRBP, capital planning, facility programs
  'lrbp', 'long-range building', 'capital plan', 'deferred maintenance',
  'facility assessment', 'modernization', 'building replacement', 'building program',
  'facilities planning', 'campus master plan',
  // EDO / strategic-planning Watch keywords — only specific terms
  'CEDS', 'site selection', 'business park', 'industrial park',
];

/**
 * Pre-filter content using keywords before calling AI.
 * Returns true if content likely contains project signals.
 */
function passesKeywordPreFilter(content, source) {
  if (!content) return false;
  const lower = content.toLowerCase();

  // Count keyword hits
  let hits = 0;
  const matched = [];
  for (const term of ALL_SIGNAL_TERMS) {
    if (lower.includes(term)) {
      hits++;
      matched.push(term);
    }
  }

  // Also check source-specific keywords
  for (const kw of (source.keywords || [])) {
    if (lower.includes(kw.toLowerCase())) hits++;
  }

  // Require at least 2 signal terms for most sources
  // High-credibility sources only need 1
  const highCred = ['State Procurement', 'County Commission', 'City Council', 'Planning & Zoning', 'School Board', 'Economic Development', 'Capital Planning'];
  const threshold = highCred.includes(source.category) ? 1 : 2;

  return { passes: hits >= threshold, hitCount: hits, matchedTerms: matched };
}


/**
 * Extract keyword-matched content segments from a larger text.
 * Returns the most relevant chunks for AI classification.
 */
function extractRelevantSegments(content, maxLength = 4000) {
  if (!content || content.length <= maxLength) return content || '';

  const sentences = content.split(/[.!?\n]+/);
  const scored = sentences.map(s => {
    const lower = s.toLowerCase();
    let score = 0;
    for (const term of ALL_SIGNAL_TERMS) {
      if (lower.includes(term)) score++;
    }
    return { text: s.trim(), score };
  }).filter(s => s.score > 0 && s.text.length > 20);

  scored.sort((a, b) => b.score - a.score);

  let result = '';
  for (const s of scored) {
    if (result.length + s.text.length > maxLength) break;
    result += s.text + '. ';
  }

  return result || content.slice(0, maxLength);
}


/**
 * ═══════════════════════════════════════════════════════════════
 * BACKFILL — Initial 6-month historical search
 * ═══════════════════════════════════════════════════════════════
 *
 * Steps:
 * 1. Fetch all active sources
 * 2. Pre-filter content with keywords
 * 3. Classify passing content with AI (or rules if AI unavailable)
 * 4. Score all candidates
 * 5. Deduplicate against existing leads
 * 6. Create lead records with evidence
 * 7. Return new leads
 */
export async function runBackfill({
  sources,
  focusPoints,
  targetOrgs,
  existingLeads = [],
  notPursuedLeads = [],
  taxonomy = [],
  settings,
  onProgress = null,
  onLog = null,
}) {
  const log = onLog || console.log;
  const startTime = Date.now();
  const results = {
    leadsDiscovered: 0,
    leadsAdded: [],
    leadsUpdated: [],
    skippedDuplicate: 0,
    skippedNotPursued: 0,
    sourcesFetched: 0,
    sourcesWithSignals: 0,
    aiCallsMade: 0,
    errors: [],
    duration: 0,
  };

  log('═══ BACKFILL STARTED ═══');
  log(`Searching ${sources.filter(s => s.state === 'active').length} active sources`);
  log(`Backfill window: ${settings.backfillMonths || 6} months`);

  const activeSources = sources.filter(s => s.state === 'active');

  // Step 1: Fetch all sources
  log('Step 1: Fetching sources...');
  const fetchResults = await batchFetch(
    activeSources,
    { concurrency: 2, delayMs: 300, backendEndpoint: settings.backendEndpoint },
    (done, total, src, res) => {
      if (onProgress) onProgress({ phase: 'fetch', done, total, source: src.name, success: res.success });
      log(`  [${done}/${total}] ${src.name}: ${res.success ? 'OK' : 'FAILED — ' + (res.error || res.statusCode)}`);
    }
  );

  results.sourcesFetched = fetchResults.length;

  // Step 2-3: Pre-filter and classify
  log('Step 2: Analyzing content...');
  const allCandidates = [];

  for (const { source, result } of fetchResults) {
    if (!result.success || !result.content) continue;

    const { passes, hitCount, matchedTerms } = passesKeywordPreFilter(result.content, source);
    if (!passes) continue;

    results.sourcesWithSignals++;

    // Try AI classification if configured
    let leads = [];
    const hasAI = settings.aiApiKey || settings.backendEndpoint;

    if (hasAI && hitCount >= 3) {
      try {
        const relevant = extractRelevantSegments(result.content);
        leads = await classifyContent(relevant, source, settings);
        results.aiCallsMade++;
        log(`  [AI] ${source.name}: ${leads.length} lead(s) classified`);
      } catch (err) {
        log(`  [AI ERROR] ${source.name}: ${err.message}`);
        results.errors.push({ source: source.name, error: err.message });
      }
    }

    // Fall back to rule-based extraction if AI isn't available or returned nothing
    if (leads.length === 0) {
      leads = ruleBasedExtraction(result.content, source, matchedTerms, taxonomy);
      log(`  [Rules] ${source.name}: ${leads.length} candidate(s) from keyword matching`);
    }

    // Attach source metadata to each candidate
    for (const lead of leads) {
      allCandidates.push({
        ...lead,
        sourceName: source.name,
        sourceUrl: source.url,
        sourceId: source.id,
        geography: lead.location?.replace(/, MT$/, '') || source.geography || '',
        county: source.county || '',
        originalSignalDate: result.lastModified || new Date().toISOString(),
        _source: source,
        _content: result.content,
        _matchedTerms: matchedTerms,
      });
    }
  }

  log(`Found ${allCandidates.length} total candidates from ${results.sourcesWithSignals} sources with signals`);

  // Step 2b: Taxonomy noise pre-filter — exclude candidates matching noise/exclude taxonomy items
  const noiseExclusions = (taxonomy || []).filter(t => t.status === 'active' && t.taxonomy_group === 'noise' && t.fit_mode === 'exclude' && t.include_keywords.length > 0);
  let noiseFiltered = 0;
  const filteredCandidates = noiseExclusions.length > 0 ? allCandidates.filter(c => {
    const text = `${c.title || ''} ${c.description || ''}`.toLowerCase();
    for (const noise of noiseExclusions) {
      const includeHit = noise.include_keywords.some(kw => text.includes(kw.toLowerCase()));
      if (!includeHit) continue;
      const excludeHit = noise.exclude_keywords.length > 0 && noise.exclude_keywords.some(kw => text.includes(kw.toLowerCase()));
      if (excludeHit) continue;
      // Matched noise exclusion — suppress this candidate
      noiseFiltered++;
      log(`  [Noise] Excluded: "${c.title}" — matched noise rule "${noise.label}"`);
      return false;
    }
    return true;
  }) : allCandidates;

  if (noiseFiltered > 0) log(`Noise filter removed ${noiseFiltered} candidate(s)`);
  results.noiseFiltered = noiseFiltered;
  results.leadsDiscovered = filteredCandidates.length;

  // Step 4: Score all candidates (taxonomy-aware)
  log('Step 3: Scoring candidates...');
  const scoredCandidates = filteredCandidates.map(c => {
    const scores = scoreLead(c, c._source, focusPoints, targetOrgs, settings, taxonomy);
    return { ...c, ...scores };
  });

  // Step 5: Deduplicate
  log('Step 4: Deduplicating...');
  const { newLeads, updatedLeads, skippedNotPursued } = deduplicateBatch(
    scoredCandidates, existingLeads, notPursuedLeads
  );

  results.skippedDuplicate = scoredCandidates.length - newLeads.length - updatedLeads.length - skippedNotPursued.length;
  results.skippedNotPursued = skippedNotPursued.length;

  log(`  New leads: ${newLeads.length}`);
  log(`  Updates to existing: ${updatedLeads.length}`);
  log(`  Skipped (not pursued): ${skippedNotPursued.length}`);
  log(`  Skipped (duplicate): ${results.skippedDuplicate}`);

  // Step 6: Create lead records
  log('Step 5: Creating lead records...');
  for (const candidate of newLeads) {
    const lead = buildLeadRecord(candidate);
    const evidence = createEvidenceRecord({
      leadId: lead.id,
      source: candidate._source,
      content: candidate._content,
      matchedKeywords: candidate.matchedKeywords || candidate._matchedTerms || [],
      signalDate: candidate.originalSignalDate,
      summary: candidate.evidenceSummary || '',
    });
    lead.evidence = [evidence];
    lead.evidenceSummary = evidence.summary;
    results.leadsAdded.push(lead);
  }

  // Step 6b: Update existing leads with new evidence
  for (const { candidate, existingLead } of updatedLeads) {
    const evidence = createEvidenceRecord({
      leadId: existingLead.id,
      source: candidate._source,
      content: candidate._content,
      matchedKeywords: candidate.matchedKeywords || candidate._matchedTerms || [],
      signalDate: candidate.originalSignalDate,
    });
    results.leadsUpdated.push({
      leadId: existingLead.id,
      newEvidence: evidence,
      scoreUpdate: {
        relevanceScore: Math.max(existingLead.relevanceScore, candidate.relevanceScore),
        pursuitScore: Math.max(existingLead.pursuitScore, candidate.pursuitScore),
        sourceConfidenceScore: Math.max(existingLead.sourceConfidenceScore, candidate.sourceConfidenceScore),
      },
    });
  }

  results.duration = Date.now() - startTime;
  log(`═══ BACKFILL COMPLETE ═══`);
  log(`Duration: ${(results.duration / 1000).toFixed(1)}s | New leads: ${results.leadsAdded.length} | Updated: ${results.leadsUpdated.length} | AI calls: ${results.aiCallsMade}`);

  return results;
}


/**
 * ═══════════════════════════════════════════════════════════════
 * DAILY SCAN — Discover new leads
 * ═══════════════════════════════════════════════════════════════
 *
 * Similar to backfill but:
 * - Only fetches sources due for refresh
 * - Only adds leads ≤60 days old (freshness threshold)
 * - Does not reintroduce not-pursued leads
 */
export async function runDailyScan({
  sources,
  focusPoints,
  targetOrgs,
  existingLeads = [],
  notPursuedLeads = [],
  taxonomy = [],
  settings,
  onProgress = null,
  onLog = null,
}) {
  const log = onLog || console.log;
  const freshnessDays = settings.freshnessDays || 60;

  log('═══ DAILY SCAN STARTED ═══');

  // Only fetch sources due for refresh
  const dueSources = sources.filter(s => s.state === 'active' && isDueForRefresh(s));
  log(`${dueSources.length} sources due for refresh`);

  if (dueSources.length === 0) {
    log('No sources need refresh. Scan complete.');
    return { leadsAdded: [], leadsUpdated: [], sourcesFetched: 0, duration: 0 };
  }

  // Run through the same pipeline as backfill
  const results = await runBackfill({
    sources: dueSources.map(s => ({ ...s })), // Use only due sources
    focusPoints,
    targetOrgs,
    existingLeads,
    notPursuedLeads,
    taxonomy,
    settings,
    onProgress,
    onLog: log,
  });

  // Apply freshness filter — remove leads with signals older than threshold
  results.leadsAdded = results.leadsAdded.filter(lead => {
    return isLeadFresh(lead.originalSignalDate, freshnessDays);
  });

  log(`After freshness filter: ${results.leadsAdded.length} new leads`);
  return results;
}


/**
 * ═══════════════════════════════════════════════════════════════
 * MAINTENANCE — Refresh active leads
 * ═══════════════════════════════════════════════════════════════
 *
 * Rechecks active leads by re-fetching their linked sources.
 * Appends new evidence, updates scores, refreshes AI notes.
 */
export async function runMaintenance({
  leads,
  sources,
  focusPoints,
  targetOrgs,
  taxonomy = [],
  evidence = {},
  settings,
  onProgress = null,
  onLog = null,
}) {
  const log = onLog || console.log;
  const recheckDays = settings.recheckDays || 7;
  const startTime = Date.now();

  log('═══ LEAD MAINTENANCE STARTED ═══');

  // Find leads needing recheck
  const activeLeads = leads.filter(l =>
    (l.status === 'active' || l.status === 'new' || l.status === 'monitoring') &&
    needsRecheck(l, recheckDays)
  );

  log(`${activeLeads.length} active leads need rechecking`);

  const updates = [];

  for (let i = 0; i < activeLeads.length; i++) {
    const lead = activeLeads[i];
    if (onProgress) onProgress({ phase: 'maintenance', done: i + 1, total: activeLeads.length, leadTitle: lead.title });

    // Find the source linked to this lead
    const linkedSource = sources.find(s => s.id === lead.sourceId || s.name === lead.sourceName);
    if (!linkedSource) {
      log(`  [${lead.title}] No linked source found, skipping`);
      continue;
    }

    // Fetch the source
    const result = await fetchSource(linkedSource, { backendEndpoint: settings.backendEndpoint });
    if (!result.success) {
      log(`  [${lead.title}] Source fetch failed: ${result.error}`);
      continue;
    }

    // Check for new signals
    const { passes, matchedTerms } = passesKeywordPreFilter(result.content, linkedSource);
    if (!passes) {
      updates.push({ leadId: lead.id, lastCheckedDate: new Date().toISOString() });
      continue;
    }

    // Score the new content against this lead (taxonomy-aware)
    const newScores = scoreLead(
      { title: lead.title, description: lead.description, sourceContent: result.content },
      linkedSource, focusPoints, targetOrgs, settings, taxonomy
    );

    // Create evidence if signals found
    const newEvidence = createEvidenceRecord({
      leadId: lead.id,
      source: linkedSource,
      content: result.content,
      matchedKeywords: matchedTerms,
      signalDate: result.lastModified || new Date().toISOString(),
    });

    const leadEvidence = evidence[lead.id] || [];
    const stronger = isEvidenceStronger(leadEvidence, newEvidence);

    const update = {
      leadId: lead.id,
      lastCheckedDate: new Date().toISOString(),
      newEvidence,
    };

    // Update scores if new evidence is stronger
    if (stronger || isStrongerEvidence(lead.relevanceScore, newScores.relevanceScore)) {
      update.relevanceScore = Math.max(lead.relevanceScore, newScores.relevanceScore);
      update.pursuitScore = Math.max(lead.pursuitScore, newScores.pursuitScore);
      update.sourceConfidenceScore = Math.max(lead.sourceConfidenceScore, newScores.sourceConfidenceScore);
      update.aiReasonForAddition = newScores.aiReasonForAddition;
      update.confidenceNotes = newScores.confidenceNotes;
      log(`  [${lead.title}] Stronger evidence found — scores updated`);
    } else {
      log(`  [${lead.title}] Rechecked — no score change`);
    }

    updates.push(update);
  }

  const duration = Date.now() - startTime;
  log(`═══ MAINTENANCE COMPLETE ═══`);
  log(`Duration: ${(duration / 1000).toFixed(1)}s | Leads checked: ${activeLeads.length} | Updates: ${updates.length}`);

  return { updates, duration, leadsChecked: activeLeads.length };
}


// ─── NAVIGATION / JUNK TEXT DETECTION ────────────────────────
const NAV_JUNK_RE = [
  /expand for details/i, /collapse for details/i, /click here/i,
  /read more/i, /learn more/i, /view all/i, /see more/i,
  /skip to (?:content|main|navigation)/i, /toggle navigation/i,
  /breadcrumb/i, /footer/i, /sidebar/i, /cookie\s*(?:policy|consent)/i,
  /privacy policy/i, /terms (?:of|and) (?:use|service)/i,
  /copyright\s*©?\s*\d{4}/i, /all rights reserved/i,
  /powered by/i, /site map/i, /sign in|log ?in|sign up/i,
  /search results|page not found/i, /^\s*home\s*[|>\/]/i,
];
const PROJECT_WORDS_RE = /\b(renovation|addition|construction|expansion|improvement|upgrade|remodel|replacement|modernization|building|facility|project|design|study|plan|bond|levy|rfq|rfp|solicitation|bid|proposal|school|clinic|hospital|courthouse|library|terminal|hangar|housing|campus|water|sewer|bridge|park|fire station|police)\b/i;

function isJunkText(text) {
  if (!text || text.length < 15) return true;
  for (const pat of NAV_JUNK_RE) { if (pat.test(text)) return true; }
  if (!PROJECT_WORDS_RE.test(text)) return true;
  return false;
}

/**
 * Check if a lead title looks like a portal/listing fragment.
 */
function isPortalFragmentTitle(title) {
  const lo = (title || '').toLowerCase().trim();
  if (/^(current|open|active|closed|awarded|pending)\s+(solicitations?|bids?|rfps?|rfqs?|opportunities|projects?|listings?)$/i.test(lo)) return true;
  if (/^(solicitations?|bids?|rfps?|rfqs?|opportunities|procurement)\s+(list|index|page|board|calendar|schedule|archive)$/i.test(lo)) return true;
  if (/^(public (works?|notices?|bids?)|bid (board|opportunities)|procurement (portal|page))$/i.test(lo)) return true;
  if (/^[\w\s&]+\s*[–—-]\s*(solicitations?|bids?|rfps?|rfqs?|opportunities|procurement|public notices?)$/i.test(lo)) return true;
  if (/^(meeting|agenda|minutes|packet|resolution|ordinance)\s+/i.test(lo) && !/\b(renovation|construction|building|facility|addition|expansion|project)\b/i.test(lo)) return true;
  return false;
}

/**
 * Check if candidate has enough architectural-scope evidence.
 */
function hasArchitecturalScope(ctx, market) {
  const lo = (ctx || '').toLowerCase();
  const buildingMarkets = ['K-12', 'Higher Education', 'Healthcare', 'Civic', 'Public Safety',
    'Housing', 'Hospitality', 'Recreation', 'Commercial', 'Research / Lab', 'Tribal'];
  if (buildingMarkets.includes(market)) return true;
  if (market === 'Airports / Aviation') return /\b(terminal|hangar|building|facility|renovation|addition|fbo)\b/i.test(lo);
  if (market === 'Infrastructure') return /\b(treatment (plant|facility)|building|architect|facility (design|renovation|addition)|pump (house|building)|control (building|room))\b/i.test(lo);
  return /\b(architect|building|facility|renovation|addition|remodel|interior|design services|a\/e|construction of (?:a |the )?(?:new )?(?:building|facility|school|clinic|station|center|library|courthouse)|floor plan|square (feet|foot|ft)|sf\b)/i.test(lo);
}

/**
 * Classify context as Active (solicitation) vs Watch (future signal).
 */
function classifyLeadType(context, matchedTerms) {
  const lo = (context || '').toLowerCase();
  const activePatterns = [
    /\brfq\b/, /\brfp\b/, /\binvitation to bid\b/, /\brequest for (?:qualifications?|proposals?)\b/,
    /\bsolicitation\b/, /\bcall for\b.*\bservices?\b/, /\bstatement of qualifications\b/,
    /\bsubmit(?:tal)?\s+(?:by|before|due|deadline)\b/, /\bresponses?\s+(?:due|requested)\b/,
    /\bselection\s+(?:process|committee|panel)\b/, /\bshortlist/,
  ];
  for (const p of activePatterns) {
    if (p.test(lo)) return { leadClass: 'active_solicitation', status: 'active' };
  }
  const critKws = (matchedTerms || []).filter(k => /^(rfq|rfp|invitation to bid|design services|architect)$/i.test(k));
  if (critKws.length >= 2) return { leadClass: 'active_solicitation', status: 'active' };
  return { leadClass: 'watch_signal', status: 'new' };
}

/**
 * Extract dates from context text.
 */
function extractDatesFromContext(context) {
  const result = { action_due_date: '', potentialTimeline: '' };
  if (!context) return result;
  const duePats = [
    /(?:due|deadline|submit(?:tal)?s?\s+(?:by|before)|responses?\s+(?:due|by)|closes?)\s*:?\s*(\w+\s+\d{1,2},?\s*\d{4})/i,
    /(?:due|deadline|submit(?:tal)?s?\s+(?:by|before))\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
  ];
  for (const pat of duePats) {
    const m = context.match(pat);
    if (m) { const d = new Date(m[1]); if (!isNaN(d.getTime()) && d > new Date('2024-01-01')) { result.action_due_date = d.toISOString().split('T')[0]; break; } }
  }
  const tlPats = [
    /(?:design\s+(?:start|begin)|a\/e\s+selection)\s*(?:in|by|:)?\s*(Q[1-4]\s*\d{4}|\w+\s*\d{4})/i,
    /(?:construction\s+(?:start|begin))\s*(?:in|by|:)?\s*(Q[1-4]\s*\d{4}|\w+\s*\d{4})/i,
    /(Q[1-4]\s*20[2-3]\d)/i,
  ];
  for (const pat of tlPats) {
    const m = context.match(pat); if (m) { result.potentialTimeline = (m[1] || m[0]).trim(); break; }
  }
  return result;
}

/**
 * Extract budget from context.
 */
function extractBudgetFromContext(context) {
  if (!context) return '';
  const pats = [
    /\$\s*([\d,.]+)\s*(million|mil|m\b)/i,
    /(?:budget|estimated\s+cost|project\s+cost)\s*(?:of|:)?\s*\$\s*([\d,.]+[mkb]?)/i,
    /\$\s*([\d,]+(?:\.\d+)?)/,
  ];
  for (const pat of pats) {
    const m = context.match(pat);
    if (m) { const num = parseFloat((m[1] || '').replace(/,/g, '') || '0'); if (num >= 10000 || /million|mil|\dm\b/i.test(m[0])) return m[0].trim(); }
  }
  return '';
}

/**
 * Clean a raw title: strip trailing dates/numbers, normalize whitespace, capitalize.
 */
function cleanTitleText(raw) {
  let t = (raw || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(the|a|an|for|of|in|at|on|to|and|or)\s+/i, '');
  t = t.replace(/\s*\(?\d{1,2}\/\d{1,2}\/\d{2,4}\)?$/, '');
  t = t.replace(/\s*#\s*\d[\w-]*$/, '');
  t = t.replace(/[,;:\-–—]+$/, '').trim();
  if (t.length > 0) t = t[0].toUpperCase() + t.slice(1);
  return t;
}

/**
 * Rule-based lead extraction (no AI required).
 * Improved: filters nav junk, classifies Active/Watch, extracts dates/budgets,
 * builds richer descriptions and evidence.
 */
function ruleBasedExtraction(content, source, matchedTerms, taxonomy) {
  if (!content) return [];

  // Clean nav/menu text before extraction
  const cleaned = content
    .replace(/(?:Skip to (?:content|main|navigation)|Toggle navigation)[^.]{0,50}/gi, '')
    .replace(/(?:Expand|Collapse)\s+(?:for|all)\s+\w+/gi, '')
    .replace(/(?:Copyright|©)\s*\d{4}[^.]{0,80}/gi, '');

  const leads = [];

  const projectPatterns = [
    /(?:rfq|rfp|invitation to bid|request for qualifications?)\s+(?:for|:|–|—)\s+([^.]{10,120})/gi,
    /(?:design services?|architectural services?|engineering services?)\s+(?:for|needed|required|sought)[^.]{5,120}/gi,
    /(?:proposed|planned|approved|upcoming|new)\s+(?:construction|renovation|addition|building|facility|project|development|expansion)\s+(?:of|for|at|on)\s+[^.]{10,120}/gi,
    /(?:capital improvement|bond|levy)\s+(?:plan|project|program)[^.]{5,100}/gi,
    /(?:renovation|construction|expansion|addition|modernization|replacement)\s+of\s+(?:the\s+)?[^.]{10,100}/gi,
  ];

  for (const pattern of projectPatterns) {
    const matches = cleaned.matchAll(pattern);
    for (const match of matches) {
      const idx = match.index;
      const start = Math.max(0, cleaned.lastIndexOf('.', idx) + 1);
      const end = Math.min(cleaned.length, cleaned.indexOf('.', idx + match[0].length) + 1 || cleaned.length);
      const context = cleaned.slice(start, end).trim();

      if (context.length < 30 || context.length > 500) continue;
      if (isJunkText(match[0])) continue;

      // Extract a clean title
      const quotedName = match[0].match(/[""]([^""]{10,80})[""]/);
      const forClause = match[0].match(/(?:rfq|rfp|request for (?:qualifications?|proposals?))\s+(?:for|:|–|—)\s*([^.]{10,80})/i);
      let title = '';
      if (quotedName && !isJunkText(quotedName[1])) title = cleanTitleText(quotedName[1]);
      else if (forClause && !isJunkText(forClause[1])) title = cleanTitleText(forClause[1]);
      else {
        const trimmed = match[0].replace(/\s+/g, ' ').trim();
        if (trimmed.length <= 80 && !isJunkText(trimmed)) title = cleanTitleText(trimmed);
        else {
          const clauses = trimmed.split(/[;—–|]/);
          for (const c of clauses) { if (c.trim().length > 15 && c.trim().length < 80 && !isJunkText(c.trim())) { title = cleanTitleText(c); break; } }
        }
      }
      if (!title || isJunkText(title)) {
        // Step 11: Skip leads where no project-specific title could be extracted.
        // Generic "Org — Type" titles pollute the board with non-actionable leads.
        continue;
      }

      // Skip portal fragment titles
      if (isPortalFragmentTitle(title)) continue;

      // Classify, extract dates/budget
      const { leadClass, status } = classifyLeadType(context, matchedTerms);
      const dates = extractDatesFromContext(context);
      const budget = extractBudgetFromContext(context);

      // Architectural scope gate
      const mktSector = inferMarketSector(context, taxonomy);
      if (!hasArchitecturalScope(context, mktSector)) continue;

      leads.push({
        title,
        owner: source.organization || '',
        description: context,
        whyItMatters: leadClass === 'active_solicitation'
          ? `Active solicitation from ${source.category || 'source'} in ${source.geography || 'Montana'}. May require A/E response.`
          : `Project signal from ${source.category || 'source'} in ${source.geography || 'Montana'}.`,
        location: source.geography ? `${source.geography}, MT` : 'Montana',
        marketSector: inferMarketSector(context, taxonomy),
        projectType: inferProjectType(context),
        signalStrength: leadClass === 'active_solicitation' ? 'strong' : (matchedTerms.length > 3 ? 'medium' : 'weak'),
        leadClass, status,
        potentialTimeline: dates.potentialTimeline,
        potentialBudget: budget,
        action_due_date: dates.action_due_date,
      });
    }
  }

  // Deduplicate within this source's results
  const uniqueLeads = [];
  const seen = new Set();
  for (const lead of leads) {
    const key = lead.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
    if (!seen.has(key)) {
      seen.add(key);
      uniqueLeads.push(lead);
    }
  }

  return uniqueLeads.slice(0, 5);
}

/**
 * Generate a lead title from context text.
 * Improved: filters nav junk, prefers structured titles.
 */
function generateTitleFromContext(context, source) {
  const trimmed = context.replace(/\s+/g, ' ').trim();
  if (isJunkText(trimmed)) return `${source.organization || 'Unknown'} — Project Signal`;

  // Try to extract a named project
  const quotedName = trimmed.match(/[""]([^""]{10,80})[""]/);
  if (quotedName && !isJunkText(quotedName[1])) return quotedName[1].trim();

  const forClause = trimmed.match(/(?:rfq|rfp|request for (?:qualifications?|proposals?))\s+(?:for|:|–|—)\s*([^.]{10,80})/i);
  if (forClause && !isJunkText(forClause[1])) return forClause[1].trim();

  if (trimmed.length <= 80 && !isJunkText(trimmed)) return trimmed;

  const clauses = trimmed.split(/[,;—–|]/);
  for (const clause of clauses) {
    const c = clause.trim();
    if (c.length > 15 && c.length < 80 && !isJunkText(c)) return c;
  }

  return `${source.organization || 'Unknown'} — Project Signal`;
}

/**
 * Infer market sector from content.
 * Checks market taxonomy keywords first, then falls back to hardcoded patterns.
 */
function inferMarketSector(text, taxonomy) {
  // Try market taxonomy first
  if (taxonomy && Array.isArray(taxonomy)) {
    const marketItems = taxonomy.filter(t => t.taxonomy_group === 'market' && t.status === 'active' && t.include_keywords.length > 0);
    const lower = text.toLowerCase();
    let bestMatch = null;
    let bestHits = 0;
    for (const item of marketItems) {
      const hits = item.include_keywords.filter(kw => lower.includes(kw.toLowerCase())).length;
      const excludeHit = item.exclude_keywords.length > 0 && item.exclude_keywords.some(kw => lower.includes(kw.toLowerCase()));
      if (hits > bestHits && !excludeHit) {
        bestMatch = item.label;
        bestHits = hits;
      }
    }
    if (bestMatch) return bestMatch;
  }

  // Fallback to hardcoded patterns
  const lower = text.toLowerCase();
  if (/\b(elementary|middle school|high school|classroom|gymnasium|school district|k-12)\b/.test(lower)) return 'K-12';
  if (/\b(university|college|campus|dormitor|student housing|higher ed)\b/.test(lower)) return 'Higher Education';
  if (/\b(hospital|medical center|clinic|outpatient|healthcare|urgent care|imaging|surgical)\b/.test(lower)) return 'Healthcare';
  if (/\b(airport|terminal|hangar|aviation|runway)\b/.test(lower)) return 'Airports / Aviation';
  if (/\b(fire station|police|public safety|911|dispatch|jail|detention)\b/.test(lower)) return 'Public Safety';
  if (/\b(courthouse|city hall|government center|civic|municipal)\b/.test(lower)) return 'Civic';
  if (/\b(library|community center|senior center|recreation|pool|aquatic|arena)\b/.test(lower)) return 'Recreation';
  if (/\b(affordable housing|workforce housing|multifamily|apartment|residential|housing authority)\b/.test(lower)) return 'Housing';
  if (/\b(tribal|reservation|indian)\b/.test(lower)) return 'Tribal';
  if (/\b(water|wastewater|sewer|storm ?water|utility|treatment plant)\b/.test(lower)) return 'Infrastructure';
  if (/\b(hotel|resort|lodge|hospitality)\b/.test(lower)) return 'Hospitality';
  if (/\b(lab|laboratory|research|science)\b/.test(lower)) return 'Research / Lab';
  if (/\b(retail|commercial|office|mixed.?use)\b/.test(lower)) return 'Commercial';
  return 'Other';
}

/**
 * Infer project type from content.
 */
function inferProjectType(text) {
  const lower = text.toLowerCase();
  if (/\brfq\b|\brfp\b|\binvitation to bid\b|\bsolicitation\b/.test(lower)) return 'RFQ/RFP';
  if (/\bmaster plan\b|\bstrategic plan\b|\bfeasibility\b|\bstudy\b/.test(lower)) return 'Master Plan';
  if (/\bbond\b|\blevy\b/.test(lower)) return 'Bond';
  if (/\baddition\b|\bexpansion\b|\bextend\b/.test(lower)) return 'Addition';
  if (/\brenovation\b|\bremodel\b|\bupgrade\b|\bretrofit\b|\breplacement\b/.test(lower)) return 'Renovation';
  if (/\bnew construction\b|\bnew building\b|\bnew facility\b/.test(lower)) return 'New Construction';
  if (/\bcapital improvement\b|\bcip\b/.test(lower)) return 'Capital Improvement';
  return 'Other';
}

/**
 * Build a complete lead record from a scored candidate.
 * Improved: includes leadClass, action_due_date, richer whyItMatters.
 */
function buildLeadRecord(candidate) {
  // Determine Active vs Watch classification if not already set
  const classification = candidate.leadClass
    ? { leadClass: candidate.leadClass, status: candidate.status || 'new' }
    : classifyLeadType(candidate.description || candidate.title || '', candidate._matchedTerms || []);

  return {
    id: `lead-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: candidate.title || 'Untitled Lead',
    owner: candidate.owner || '',
    projectName: candidate.projectName || '',
    location: candidate.location || '',
    county: candidate.county || '',
    geography: candidate.geography || '',
    marketSector: candidate.marketSector || '',
    projectType: candidate.projectType || '',
    description: candidate.description || '',
    whyItMatters: candidate.whyItMatters || '',
    aiReasonForAddition: candidate.aiReasonForAddition || '',
    potentialTimeline: candidate.potentialTimeline || '',
    potentialBudget: candidate.potentialBudget || '',
    action_due_date: candidate.action_due_date || '',
    relevanceScore: candidate.relevanceScore || 0,
    pursuitScore: candidate.pursuitScore || 0,
    sourceConfidenceScore: candidate.sourceConfidenceScore || 0,
    confidenceNotes: candidate.confidenceNotes || '',
    dateDiscovered: new Date().toISOString(),
    originalSignalDate: candidate.originalSignalDate || new Date().toISOString(),
    lastCheckedDate: new Date().toISOString(),
    status: classification.status,
    leadClass: classification.leadClass,
    leadOrigin: candidate.leadOrigin || 'pipeline',
    sourceName: candidate.sourceName || '',
    sourceUrl: candidate.sourceUrl || '',
    sourceId: candidate.sourceId || '',
    evidenceLinks: candidate.sourceUrl ? [candidate.sourceUrl] : [],
    evidenceSummary: '',
    matchedFocusPoints: candidate.matchedFocusPoints || [],
    matchedKeywords: candidate.matchedKeywords || candidate._matchedTerms || [],
    matchedTargetOrgs: candidate.matchedTargetOrgs || [],
    internalContact: '',
    notes: '',
    submissionState: '',
    submissionNotes: '',
    dateSubmittedToAsana: null,
    asanaUrl: null,
    reasonNotPursued: null,
    dateNotPursued: null,
    taxonomyMatches: candidate.taxonomyMatches || [],
    evidence: [],
  };
}
