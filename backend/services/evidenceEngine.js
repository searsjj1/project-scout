/**
 * Project Scout — Evidence Engine
 *
 * Manages evidence records attached to leads.
 * Each lead maintains a timeline of evidence showing the signals
 * that caused it to be discovered and tracked.
 *
 * HOW THE APP USES THIS:
 *   - Evidence tab in lead detail shows chronological timeline
 *   - Stronger evidence triggers score refresh and AI reason update
 *   - Evidence links provide audit trail for go/no-go decisions
 *   - Source confidence is partially derived from evidence quality
 */

/**
 * Create an evidence record from a source fetch result.
 *
 * @param {Object} params
 * @param {string} params.leadId - The lead this evidence belongs to
 * @param {Object} params.source - The source record
 * @param {string} params.content - The relevant content excerpt
 * @param {Array}  params.matchedKeywords - Keywords found
 * @param {string} params.signalDate - When the signal originated
 * @returns {Object} Evidence record
 */
export function createEvidenceRecord({
  leadId,
  source,
  content,
  matchedKeywords = [],
  signalDate = null,
  title = '',
  summary = '',
}) {
  const signalStrength = determineSignalStrength(matchedKeywords, source);

  return {
    id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    leadId,
    sourceId: source?.id || '',
    sourceName: source?.name || '',
    url: source?.url || '',
    title: title || `${source?.name || 'Unknown'} — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
    summary: summary || generateEvidenceSummary(content, matchedKeywords),
    signalDate: signalDate || new Date().toISOString(),
    dateFound: new Date().toISOString(),
    signalStrength,
    keywords: matchedKeywords.slice(0, 10),
    contentExcerpt: (content || '').slice(0, 500),
  };
}

/**
 * Determine signal strength based on keyword quality and source credibility.
 */
function determineSignalStrength(keywords, source) {
  const criticalTerms = ['rfq', 'rfp', 'invitation to bid', 'design services', 'architect', 'a/e'];
  const highTerms = ['capital improvement plan', 'bond', 'levy', 'master plan', 'facilities plan'];

  const hasCritical = keywords.some(k => criticalTerms.includes(k.toLowerCase()));
  const hasHigh = keywords.some(k => highTerms.includes(k.toLowerCase()));

  const highCredSources = ['State Procurement', 'County Commission', 'City Council', 'Planning & Zoning', 'School Board'];
  const isHighCredSource = source && highCredSources.includes(source.category);

  if (hasCritical && isHighCredSource) return 'strong';
  if (hasCritical || (hasHigh && isHighCredSource)) return 'strong';
  if (hasHigh || isHighCredSource) return 'medium';
  return 'weak';
}

/**
 * Generate a brief evidence summary from content and keywords.
 * This is the rule-based version; AI can enrich later.
 */
function generateEvidenceSummary(content, keywords) {
  if (!content) return 'Signal detected from source monitoring.';

  // Find sentence(s) containing the highest-value keywords
  const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 20);
  const scored = sentences.map(s => {
    const lower = s.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw.toLowerCase())) score++;
    }
    return { sentence: s.trim(), score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

  if (scored.length > 0) {
    const top = scored[0].sentence;
    return top.length > 200 ? top.slice(0, 197) + '...' : top + '.';
  }

  return `Source content contains ${keywords.length} matching signal${keywords.length !== 1 ? 's' : ''}.`;
}

/**
 * Append new evidence to a lead's evidence timeline.
 * Returns the updated evidence array.
 *
 * @param {Array} existingEvidence - Current evidence records for this lead
 * @param {Object} newEvidence - New evidence record to add
 * @returns {Array} Updated evidence array, deduplicated by source+date
 */
export function appendEvidence(existingEvidence = [], newEvidence) {
  // Check for duplicate evidence (same source, same date)
  const isDuplicate = existingEvidence.some(e =>
    e.sourceId === newEvidence.sourceId &&
    e.signalDate === newEvidence.signalDate
  );

  if (isDuplicate) return existingEvidence;

  return [...existingEvidence, newEvidence].sort(
    (a, b) => new Date(b.signalDate) - new Date(a.signalDate)
  );
}

/**
 * Determine if new evidence is stronger than existing evidence for a lead.
 */
export function isEvidenceStronger(existingEvidence, newEvidence) {
  const strengthOrder = { strong: 3, medium: 2, weak: 1 };
  const maxExisting = existingEvidence.reduce(
    (max, e) => Math.max(max, strengthOrder[e.signalStrength] || 0), 0
  );
  const newStrength = strengthOrder[newEvidence.signalStrength] || 0;
  return newStrength > maxExisting;
}

/**
 * Build a display-ready evidence timeline for the UI.
 */
export function buildEvidenceTimeline(evidenceRecords) {
  return (evidenceRecords || [])
    .sort((a, b) => new Date(a.signalDate) - new Date(b.signalDate))
    .map(e => ({
      ...e,
      displayDate: new Date(e.signalDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      strengthColor: e.signalStrength === 'strong' ? '#10b981' : e.signalStrength === 'medium' ? '#f59e0b' : '#94a3b8',
    }));
}
