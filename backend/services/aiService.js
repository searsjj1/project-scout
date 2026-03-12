/**
 * Project Scout — AI Service
 *
 * Handles all AI interactions with cost control.
 * Rules and keywords run first; AI is called only when:
 *   - New content needs classification beyond keyword matching
 *   - Evidence summaries need human-readable synthesis
 *   - Score enrichment is needed for borderline leads
 *
 * Supports switching between Anthropic and OpenAI.
 * Uses the cheapest practical model for routine tasks.
 *
 * HOW THE APP USES THIS:
 *   - During backfill: AI classifies content that passes keyword pre-filters
 *   - During daily runs: AI enriches leads with new evidence
 *   - During lead maintenance: AI updates reason-for-addition when evidence strengthens
 */

// ─── CACHE ────────────────────────────────────────────────────
const aiCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

function getCached(key) {
  const entry = aiCache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.value;
  aiCache.delete(key);
  return null;
}

function setCache(key, value) {
  aiCache.set(key, { value, ts: Date.now() });
  // Evict old entries if cache grows too large
  if (aiCache.size > 500) {
    const oldest = [...aiCache.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 100);
    for (const [k] of oldest) aiCache.delete(k);
  }
}

// ─── PROMPT TEMPLATES ─────────────────────────────────────────

export const PROMPTS = {

  /**
   * CLASSIFY: Determine if source content contains a project lead.
   * Used during backfill and daily scans.
   * Input: raw text from a source page.
   * Output: structured JSON with extracted fields.
   */
  classify: (sourceContent, sourceName, geography) => ({
    system: `You are a lead intelligence analyst for A&E + SMA Design, an architecture and design firm in Western Montana. Your job is to identify potential building, renovation, or infrastructure project leads from government and institutional source content.

Focus on projects that would need architectural or engineering design services: buildings, renovations, additions, master plans, facility studies, campus projects, clinics, schools, government buildings, housing developments, airport facilities, and similar.

Ignore routine maintenance, minor repairs, policy discussions without project signals, personnel matters, and items clearly outside design services.

Respond ONLY with valid JSON. No markdown, no explanation.`,

    user: `Source: ${sourceName}
Geography: ${geography}

Content to analyze:
"""
${(sourceContent || '').slice(0, 4000)}
"""

Extract any project leads found. Return JSON:
{
  "leads": [
    {
      "title": "Short descriptive project title",
      "owner": "Organization or entity that owns the project",
      "projectName": "Official project name if stated, else empty",
      "location": "City and state",
      "marketSector": "One of: Civic, K-12, Higher Education, Healthcare, Airports/Aviation, Housing, Infrastructure, Commercial, Mixed Use, Recreation, Tribal, Other",
      "projectType": "One of: New Construction, Renovation, Addition, Master Plan, Study, Bond, RFQ/RFP, Other",
      "description": "2-3 sentence description of the project",
      "whyItMatters": "Why this matters for an architecture firm",
      "potentialTimeline": "Any timeline information found",
      "potentialBudget": "Any budget information found",
      "signalStrength": "strong, medium, or weak"
    }
  ],
  "noLeadsFound": true/false
}`
  }),

  /**
   * ENRICH: Add detail and context to a lead that was found via rules.
   * Used to improve AI reason for addition and evidence summary.
   */
  enrich: (lead, newEvidenceText) => ({
    system: `You are a lead intelligence analyst for A&E + SMA Design. You are updating an existing project lead with new evidence. Be concise and factual.

Respond ONLY with valid JSON. No markdown.`,

    user: `Existing lead:
Title: ${lead.title}
Owner: ${lead.owner}
Description: ${lead.description}
Current AI assessment: ${lead.aiReasonForAddition}

New evidence found:
"""
${(newEvidenceText || '').slice(0, 3000)}
"""

Return JSON:
{
  "updatedDescription": "Updated 2-3 sentence description if new info warrants it, else empty string",
  "updatedAIReason": "Updated single sentence explaining why this lead matters, incorporating new evidence",
  "evidenceSummary": "1-2 sentence summary of what the new evidence shows",
  "timelineUpdate": "Any new timeline info, else empty",
  "budgetUpdate": "Any new budget info, else empty",
  "signalStrengthChange": "stronger, same, or weaker"
}`
  }),

  /**
   * SUMMARIZE: Create a readable evidence summary from multiple evidence records.
   */
  summarize: (evidenceRecords) => ({
    system: `You are a lead intelligence analyst. Synthesize evidence records into a clear, concise timeline summary. 2-4 sentences max. Respond with plain text only.`,

    user: `Summarize these evidence records chronologically:
${evidenceRecords.map((e, i) => `${i + 1}. [${e.signalDate || e.dateFound}] ${e.title}: ${e.summary}`).join('\n')}`
  }),
};


// ─── AI PROVIDER INTERFACE ────────────────────────────────────

/**
 * Call the AI provider (Anthropic or OpenAI).
 * Automatically selects the cheapest practical model.
 *
 * @param {Object} prompt - { system, user }
 * @param {Object} settings - App settings with aiProvider, aiModel, aiApiKey, backendEndpoint
 * @returns {string} Raw response text
 */
export async function callAI(prompt, settings) {
  const cacheKey = JSON.stringify({ s: prompt.system?.slice(0, 50), u: prompt.user?.slice(0, 200) });
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const { aiProvider, aiModel, aiApiKey, backendEndpoint } = settings;

  if (!aiApiKey && !backendEndpoint) {
    throw new Error('No AI API key or backend endpoint configured');
  }

  let response;

  if (backendEndpoint) {
    // Proxy through backend (preferred for serverless deployment)
    response = await fetch(`${backendEndpoint}/api/classify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, provider: aiProvider, model: aiModel }),
    });
    const data = await response.json();
    const result = data.content || data.text || data.choices?.[0]?.message?.content || '';
    setCache(cacheKey, result);
    return result;
  }

  // Direct API call (for development / when no backend is deployed)
  if (aiProvider === 'anthropic') {
    const model = aiModel || 'claude-haiku-4-5-20251001'; // Cheapest practical model
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': aiApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
      }),
    });
    const data = await response.json();
    const result = data.content?.[0]?.text || '';
    setCache(cacheKey, result);
    return result;

  } else if (aiProvider === 'openai') {
    const model = aiModel || 'gpt-4o-mini'; // Cheapest practical model
    response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${aiApiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
      }),
    });
    const data = await response.json();
    const result = data.choices?.[0]?.message?.content || '';
    setCache(cacheKey, result);
    return result;
  }

  throw new Error(`Unknown AI provider: ${aiProvider}`);
}

/**
 * Parse AI JSON response safely.
 */
export function parseAIResponse(raw) {
  try {
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.warn('[AI] Failed to parse response:', e.message);
    return null;
  }
}

/**
 * Classify source content using AI.
 * Returns array of extracted lead candidates.
 */
export async function classifyContent(sourceContent, source, settings) {
  const prompt = PROMPTS.classify(sourceContent, source.name, source.geography || 'Western Montana');
  const raw = await callAI(prompt, settings);
  const parsed = parseAIResponse(raw);
  
  if (!parsed || !parsed.leads) return [];
  return parsed.leads;
}

/**
 * Enrich an existing lead with new evidence via AI.
 */
export async function enrichLead(lead, newEvidenceText, settings) {
  const prompt = PROMPTS.enrich(lead, newEvidenceText);
  const raw = await callAI(prompt, settings);
  return parseAIResponse(raw);
}

/**
 * Summarize evidence records via AI.
 */
export async function summarizeEvidence(evidenceRecords, settings) {
  if (!evidenceRecords || evidenceRecords.length === 0) return '';
  const prompt = PROMPTS.summarize(evidenceRecords);
  return await callAI(prompt, settings);
}

/**
 * Clear the AI cache (for testing or manual refresh).
 */
export function clearCache() {
  aiCache.clear();
}
