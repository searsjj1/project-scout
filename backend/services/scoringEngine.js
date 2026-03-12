/**
 * Project Scout — Scoring Engine
 * 
 * Implements a rules-first, multi-factor scoring system.
 * AI is only called when rules can't resolve or for enrichment.
 * 
 * Three scores per lead (0-100):
 *   relevanceScore      — how relevant is this to A&E + SMA's work
 *   pursuitScore        — how actionable / ready to pursue
 *   sourceConfidenceScore — how trustworthy is the evidence
 *
 * HOW THE APP USES THESE:
 *   - Active Leads are sorted by relevance by default
 *   - Pursuit score drives go/no-go readiness
 *   - Source confidence flags leads needing verification
 *   - Leads below Settings.priorityThreshold are deprioritized
 */

// ─── HIGH-VALUE SIGNAL TERMS (from master brief §15) ──────────
const SIGNAL_TERMS = {
  critical: [
    'rfq', 'rfp', 'invitation to bid', 'design services',
    'architect', 'a/e', 'architectural', 'engineering services',
  ],
  high: [
    'capital improvement plan', 'bond', 'levy', 'facilities plan',
    'master plan', 'strategic plan', 'owner\'s representative',
  ],
  medium: [
    'addition', 'renovation', 'remodel', 'campus', 'clinic',
    'hospital', 'airport', 'hangar', 'terminal', 'school',
    'housing', 'subdivision', 'annexation', 'rezoning',
    'redevelopment', 'tenant improvement', 'public works',
    'utility', 'infrastructure',
  ],
  low: [
    'construction', 'building', 'facility', 'project',
    'development', 'expansion', 'upgrade', 'improvement',
  ],
};

// ─── SOURCE CREDIBILITY BY CATEGORY ────────────────────────────
const SOURCE_CREDIBILITY = {
  'State Procurement': 95,
  'County Commission': 90,
  'City Council': 88,
  'Planning & Zoning': 88,
  'School Board': 85,
  'Airport Authority': 85,
  'Higher Ed Capital': 85,
  'Redevelopment Agency': 82,
  'Tribal Government': 82,
  'Economic Development': 78,
  'Public Notice': 80,
  'Healthcare System': 72,
  'Utility': 70,
  'Media': 55,
  'Contractor / Developer': 50,
  'Private Employer': 48,
  'Other': 40,
};

// ─── PRIORITY WEIGHT ──────────────────────────────────────────
const PRIORITY_WEIGHT = { critical: 1.3, high: 1.15, medium: 1.0, low: 0.85 };


/**
 * Score a candidate lead against the full intelligence configuration.
 *
 * @param {Object} candidate  - Parsed lead candidate { title, description, sourceContent, url, ... }
 * @param {Object} source     - The source record it came from
 * @param {Array}  focusPoints - All active focus points
 * @param {Array}  targetOrgs  - All active target organizations
 * @param {Object} settings    - App settings
 * @returns {Object} { relevanceScore, pursuitScore, sourceConfidenceScore, matchedKeywords, matchedFocusPoints, matchedTargetOrgs, confidenceNotes, aiReasonForAddition }
 */
export function scoreLead(candidate, source, focusPoints, targetOrgs, settings) {
  const text = `${candidate.title || ''} ${candidate.description || ''} ${candidate.sourceContent || ''}`.toLowerCase();
  
  // ─── 1. Keyword Signal Score (0-30 pts of relevance) ────────
  let keywordScore = 0;
  const matchedKeywords = [];
  
  for (const [tier, terms] of Object.entries(SIGNAL_TERMS)) {
    const weight = tier === 'critical' ? 8 : tier === 'high' ? 5 : tier === 'medium' ? 3 : 1;
    for (const term of terms) {
      if (text.includes(term)) {
        keywordScore += weight;
        matchedKeywords.push(term);
      }
    }
  }
  keywordScore = Math.min(30, keywordScore);

  // ─── 2. Focus Point Match Score (0-25 pts of relevance) ─────
  let focusScore = 0;
  const matchedFocusPointsList = [];

  for (const fp of focusPoints.filter(f => f.active)) {
    const fpWeight = PRIORITY_WEIGHT[fp.priority] || 1;
    let fpHits = 0;
    for (const kw of fp.keywords) {
      if (text.includes(kw.toLowerCase())) fpHits++;
    }
    if (fpHits > 0) {
      focusScore += Math.min(8, fpHits * 3) * fpWeight;
      matchedFocusPointsList.push(fp.title);
    }
  }
  focusScore = Math.min(25, focusScore);

  // ─── 3. Target Organization Match (0-20 pts of relevance) ───
  let orgScore = 0;
  const matchedTargetOrgsList = [];

  for (const org of targetOrgs.filter(o => o.active)) {
    const nameMatch = text.includes(org.name.toLowerCase());
    let termHits = 0;
    for (const term of org.watchTerms || []) {
      if (text.includes(term.toLowerCase())) termHits++;
    }
    if (nameMatch) {
      orgScore += 12;
      matchedTargetOrgsList.push(org.name);
    } else if (termHits >= 2) {
      orgScore += 6;
      matchedTargetOrgsList.push(org.name);
    }
  }
  orgScore = Math.min(20, orgScore);

  // ─── 4. Geography Fit (0-15 pts of relevance) ───────────────
  let geoScore = 0;
  const coreGeos = ['missoula', 'kalispell', 'whitefish', 'columbia falls', 'hamilton', 'polson'];
  const countyGeos = ['missoula county', 'flathead county', 'ravalli county', 'lake county'];
  const outerGeos = ['sanders county', 'lincoln county', 'mineral county'];

  for (const g of coreGeos) { if (text.includes(g)) { geoScore = 15; break; } }
  if (!geoScore) { for (const g of countyGeos) { if (text.includes(g)) { geoScore = 12; break; } } }
  if (!geoScore) { for (const g of outerGeos) { if (text.includes(g)) { geoScore = 8; break; } } }
  if (!geoScore && source?.geography) {
    const sg = source.geography.toLowerCase();
    if (coreGeos.some(g => sg.includes(g))) geoScore = 12;
    else if (countyGeos.some(g => sg.includes(g))) geoScore = 10;
    else geoScore = 5;
  }

  // ─── 5. Source-level priority bonus (0-10 pts) ──────────────
  const sourcePrioBonus = source ? Math.round(10 * (PRIORITY_WEIGHT[source.priority] || 1) - 10 + 5) : 0;

  // ─── RELEVANCE SCORE ────────────────────────────────────────
  const relevanceScore = Math.min(100, Math.max(0, Math.round(
    keywordScore + focusScore + orgScore + geoScore + Math.min(10, sourcePrioBonus)
  )));

  // ─── SOURCE CONFIDENCE SCORE ────────────────────────────────
  const baseCredibility = source ? (SOURCE_CREDIBILITY[source.category] || 50) : 40;
  const healthBonus = source?.fetchHealth === 'healthy' ? 5 : source?.fetchHealth === 'degraded' ? -5 : -15;
  const repeatedMentionBonus = matchedKeywords.length > 3 ? 5 : 0;
  const sourceConfidenceScore = Math.min(100, Math.max(0, Math.round(
    baseCredibility + healthBonus + repeatedMentionBonus
  )));

  // ─── PURSUIT SCORE ──────────────────────────────────────────
  // Based on: relevance, timeline clarity, budget signals, source confidence
  let pursuitBase = relevanceScore * 0.5;
  const hasTimeline = /\b(20[2-3]\d|q[1-4]|phase|start|selection|deadline)\b/i.test(text);
  const hasBudget = /\$[\d,.]+[mk]?|\bmillion\b|\bbudget\b/i.test(text);
  const hasRFQ = /\b(rfq|rfp|invitation to bid|selection)\b/i.test(text);
  if (hasTimeline) pursuitBase += 15;
  if (hasBudget) pursuitBase += 12;
  if (hasRFQ) pursuitBase += 18;
  pursuitBase += sourceConfidenceScore * 0.15;
  const pursuitScore = Math.min(100, Math.max(0, Math.round(pursuitBase)));

  // ─── Confidence Notes ───────────────────────────────────────
  const notes = [];
  if (matchedKeywords.length > 0) notes.push(`${matchedKeywords.length} signal keywords matched`);
  if (matchedFocusPointsList.length > 0) notes.push(`Focus: ${matchedFocusPointsList.join(', ')}`);
  if (matchedTargetOrgsList.length > 0) notes.push(`Org match: ${matchedTargetOrgsList.join(', ')}`);
  if (geoScore >= 12) notes.push('Strong geography fit');
  if (hasRFQ) notes.push('RFQ/RFP signal detected');
  if (hasBudget) notes.push('Budget information present');
  if (hasTimeline) notes.push('Timeline information present');

  // ─── AI Reason (rule-generated, enriched by AI later) ───────
  const aiReasonForAddition = generateAIReason(candidate, matchedKeywords, matchedFocusPointsList, matchedTargetOrgsList, source);

  return {
    relevanceScore,
    pursuitScore,
    sourceConfidenceScore,
    matchedKeywords: [...new Set(matchedKeywords)],
    matchedFocusPoints: matchedFocusPointsList,
    matchedTargetOrgs: matchedTargetOrgsList,
    confidenceNotes: notes.join('. ') + (notes.length ? '.' : ''),
    aiReasonForAddition,
  };
}

/**
 * Generate a human-readable reason for why this lead was added.
 * This is the rule-based version; AI enrichment happens in aiService.
 */
function generateAIReason(candidate, keywords, focusPoints, targetOrgs, source) {
  const parts = [];

  if (targetOrgs.length > 0) {
    parts.push(`Matched target organization${targetOrgs.length > 1 ? 's' : ''}: ${targetOrgs.join(', ')}`);
  }
  if (focusPoints.length > 0) {
    parts.push(`aligns with focus ${focusPoints.length > 1 ? 'areas' : 'area'}: ${focusPoints.join(', ')}`);
  }
  if (keywords.length > 0) {
    const topKeywords = keywords.slice(0, 4);
    parts.push(`signal keywords include "${topKeywords.join('", "')}"`);
  }
  if (source) {
    parts.push(`discovered via ${source.name}`);
  }

  if (parts.length === 0) return 'Added based on general keyword and geography match.';
  return parts[0].charAt(0).toUpperCase() + parts.join('; ').slice(1) + '.';
}


/**
 * Check if a lead should be considered "fresh" enough to add as new.
 * Per master brief: up to 60 days old and not already in Not Pursued.
 */
export function isLeadFresh(signalDate, freshnessDays = 60) {
  if (!signalDate) return true;
  const age = (Date.now() - new Date(signalDate).getTime()) / 86400000;
  return age <= freshnessDays;
}


/**
 * Check if an active lead needs rechecking.
 * Per master brief: recheck using source activity from last 7 days.
 */
export function needsRecheck(lead, recheckDays = 7) {
  if (!lead.lastCheckedDate) return true;
  const age = (Date.now() - new Date(lead.lastCheckedDate).getTime()) / 86400000;
  return age >= recheckDays;
}


/**
 * Determine if new evidence is "stronger" than existing.
 */
export function isStrongerEvidence(existingScore, newScore) {
  return newScore > existingScore + 5;
}
