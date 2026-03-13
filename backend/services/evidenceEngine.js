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
 * Improved: uses top 2 sentences, adds keyword context, avoids nav junk.
 */
function generateEvidenceSummary(content, keywords) {
  if (!content) return 'Signal detected from source monitoring.';

  // Filter out obvious navigation / junk sentences
  const navPatterns = /expand for details|collapse|skip to|toggle navigation|copyright|privacy policy|terms of use|all rights reserved|powered by|sign in|log in/i;

  const sentences = content.split(/[.!?]+/).filter(s => {
    const t = s.trim();
    return t.length > 25 && t.length < 400 && !navPatterns.test(t);
  });

  const scored = sentences.map(s => {
    const lower = s.toLowerCase();
    let score = 0;
    const criticalTerms = ['rfq', 'rfp', 'invitation to bid', 'design services', 'architect', 'a/e'];
    const highTerms = ['capital improvement', 'bond', 'levy', 'master plan', 'facilities plan'];
    for (const kw of keywords) {
      const kl = kw.toLowerCase();
      if (criticalTerms.includes(kl)) score += 3;
      else if (highTerms.includes(kl)) score += 2;
      else if (lower.includes(kl)) score += 1;
    }
    return { sentence: s.trim(), score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

  if (scored.length >= 2) {
    const s1 = scored[0].sentence;
    const s2 = scored[1].sentence;
    const combined = `${s1}. ${s2}`;
    return combined.length > 350 ? `${s1.slice(0, 250)}...` : combined + '.';
  }

  if (scored.length === 1) {
    const top = scored[0].sentence;
    return top.length > 250 ? top.slice(0, 247) + '...' : top + '.';
  }

  // Fallback: mention which keywords were found
  if (keywords.length > 0) {
    return `Source content contains signal keywords: ${keywords.slice(0, 5).join(', ')}. Review source page for project details.`;
  }

  return 'Signal detected from source monitoring. Review source page for details.';
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
