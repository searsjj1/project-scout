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
  const highCred = ['State Procurement', 'County Commission', 'City Council', 'Planning & Zoning'];
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
      leads = ruleBasedExtraction(result.content, source, matchedTerms);
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
  results.leadsDiscovered = allCandidates.length;

  // Step 4: Score all candidates
  log('Step 3: Scoring candidates...');
  const scoredCandidates = allCandidates.map(c => {
    const scores = scoreLead(c, c._source, focusPoints, targetOrgs, settings);
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

    // Score the new content against this lead
    const newScores = scoreLead(
      { title: lead.title, description: lead.description, sourceContent: result.content },
      linkedSource, focusPoints, targetOrgs, settings
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


/**
 * Rule-based lead extraction (no AI required).
 * Extracts candidates from content using keyword patterns and structure.
 */
function ruleBasedExtraction(content, source, matchedTerms) {
  if (!content) return [];

  const leads = [];
  const lower = content.toLowerCase();

  // Look for project-like mentions: "[Entity] + [action term] + [project term]"
  const projectPatterns = [
    /(?:proposed|planned|approved|new|upcoming)\s+(?:construction|renovation|addition|building|facility|project|development|expansion)\b/gi,
    /(?:rfq|rfp|invitation to bid|request for qualifications?)\s+(?:for|:)\s+([^.]{10,80})/gi,
    /(?:capital improvement|bond|levy)\s+(?:plan|project|program)/gi,
    /(?:design services?|architectural services?|engineering services?)\s+(?:for|needed|required)/gi,
  ];

  for (const pattern of projectPatterns) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      // Find surrounding context (the sentence containing the match)
      const idx = match.index;
      const start = Math.max(0, content.lastIndexOf('.', idx) + 1);
      const end = Math.min(content.length, content.indexOf('.', idx + match[0].length) + 1 || content.length);
      const context = content.slice(start, end).trim();

      if (context.length > 30 && context.length < 500) {
        leads.push({
          title: generateTitleFromContext(context, source),
          owner: source.organization || '',
          description: context,
          location: source.geography ? `${source.geography}, MT` : 'Western Montana',
          marketSector: inferMarketSector(context),
          projectType: inferProjectType(context),
          signalStrength: matchedTerms.length > 3 ? 'strong' : 'medium',
        });
      }
    }
  }

  // Deduplicate within this source's results
  const uniqueLeads = [];
  const seen = new Set();
  for (const lead of leads) {
    const key = lead.title.toLowerCase().slice(0, 40);
    if (!seen.has(key)) {
      seen.add(key);
      uniqueLeads.push(lead);
    }
  }

  return uniqueLeads.slice(0, 5); // Cap per source
}

/**
 * Generate a lead title from context text.
 */
function generateTitleFromContext(context, source) {
  // Try to extract a meaningful project name
  const trimmed = context.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= 80) return trimmed;

  // Take first meaningful clause
  const clauses = trimmed.split(/[,;—–]/);
  for (const clause of clauses) {
    const c = clause.trim();
    if (c.length > 15 && c.length < 80) return c;
  }

  return `${source.organization || 'Unknown'} — Project Signal`;
}

/**
 * Infer market sector from content.
 */
function inferMarketSector(text) {
  const lower = text.toLowerCase();
  if (/school|education|classroom|elementary|middle school|high school/.test(lower)) return 'K-12';
  if (/university|college|campus|dormitor/.test(lower)) return 'Higher Education';
  if (/hospital|clinic|medical|healthcare|outpatient/.test(lower)) return 'Healthcare';
  if (/airport|terminal|hangar|aviation/.test(lower)) return 'Airports / Aviation';
  if (/housing|apartment|multifamily|residential/.test(lower)) return 'Housing';
  if (/courthouse|city hall|government|civic/.test(lower)) return 'Civic';
  if (/fire station|police|public safety|911/.test(lower)) return 'Public Safety';
  if (/water|wastewater|sewer|infrastructure/.test(lower)) return 'Infrastructure';
  if (/tribal|reservation/.test(lower)) return 'Tribal';
  if (/hotel|resort|recreation/.test(lower)) return 'Hospitality';
  if (/retail|grocery|commercial/.test(lower)) return 'Commercial';
  if (/lab|research|science/.test(lower)) return 'Research / Lab';
  return 'Other';
}

/**
 * Infer project type from content.
 */
function inferProjectType(text) {
  const lower = text.toLowerCase();
  if (/\brfq\b|\brfp\b|invitation to bid/.test(lower)) return 'RFQ/RFP';
  if (/master plan|strategic plan|feasibility/.test(lower)) return 'Master Plan';
  if (/bond|levy/.test(lower)) return 'Bond';
  if (/addition|expansion|extend/.test(lower)) return 'Addition';
  if (/renovation|remodel|upgrade|retrofit/.test(lower)) return 'Renovation';
  if (/new construction|new building|new facility/.test(lower)) return 'New Construction';
  return 'Other';
}

/**
 * Build a complete lead record from a scored candidate.
 */
function buildLeadRecord(candidate) {
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
    relevanceScore: candidate.relevanceScore || 0,
    pursuitScore: candidate.pursuitScore || 0,
    sourceConfidenceScore: candidate.sourceConfidenceScore || 0,
    confidenceNotes: candidate.confidenceNotes || '',
    dateDiscovered: new Date().toISOString(),
    originalSignalDate: candidate.originalSignalDate || new Date().toISOString(),
    lastCheckedDate: new Date().toISOString(),
    status: 'new',
    sourceName: candidate.sourceName || '',
    sourceUrl: candidate.sourceUrl || '',
    sourceId: candidate.sourceId || '',
    evidenceLinks: candidate.sourceUrl ? [candidate.sourceUrl] : [],
    evidenceSummary: '',
    matchedFocusPoints: candidate.matchedFocusPoints || [],
    matchedKeywords: candidate.matchedKeywords || [],
    matchedTargetOrgs: candidate.matchedTargetOrgs || [],
    internalContact: '',
    notes: '',
    submissionState: '',
    submissionNotes: '',
    dateSubmittedToAsana: null,
    asanaUrl: null,
    reasonNotPursued: null,
    dateNotPursued: null,
    evidence: [],
  };
}
