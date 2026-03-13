/**
 * /api/scan.js — Project Scout Intelligence Engine
 *
 * Self-contained serverless function. No external imports required.
 * Deploys to Vercel as-is. Uses Node.js native fetch (Node 18+).
 *
 * Actions:
 *   GET  ?action=status      → Last run info + health check
 *   POST ?action=fetch-one   → Fetch + analyze one source (smoke test)
 *   POST ?action=daily       → Daily scan (up to 15 sources)
 *   POST ?action=backfill    → Full backfill (all active sources)
 *   POST ?action=asana       → Check Asana board for matches
 *
 * All POST bodies: { source?, sources?, focusPoints?, targetOrgs?,
 *                     existingLeads?, notPursuedLeads?, settings? }
 */

// ── CORS preflight handler ──────────────────────────────────
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// ── Signal terms for pre-filtering ──────────────────────────
const SIGNALS = [
  'rfq','rfp','invitation to bid','design services','architect','a/e services',
  'capital improvement','bond','levy','facilities plan','master plan',
  'addition','renovation','remodel','campus','clinic','hospital',
  'airport','hangar','terminal','school','housing','subdivision',
  'rezoning','redevelopment','public works','infrastructure',
  'construction','building','facility','development','expansion',
];

// ── Fetch a URL server-side ─────────────────────────────────
async function fetchUrl(url, timeout = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'ProjectScout/1.0 (A&E+SMA Design)',
        'Accept': 'text/html,application/xhtml+xml,*/*',
      },
    });
    clearTimeout(t);
    const raw = await r.text();
    const content = raw
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
      .replace(/&nbsp;/g,' ').replace(/&#?\w+;/g,' ')
      .replace(/\s+/g,' ').trim();
    const tm = raw.match(/<title[^>]*>(.*?)<\/title>/i);
    return {
      ok: r.status >= 200 && r.status < 400,
      status: r.status,
      content: content.slice(0, 50000),
      rawHtml: raw.slice(0, 200000), // Preserve raw HTML for link extraction
      title: tm ? tm[1].trim() : null,
      length: content.length,
      lastMod: r.headers.get('last-modified'),
      err: null,
    };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, status: null, content: null, rawHtml: null, title: null, length: 0, lastMod: null,
      err: e.name === 'AbortError' ? `Timeout (${timeout}ms)` : e.message };
  }
}

// ── Extract child document links from raw HTML ──────────────
// Finds links to RFQ/RFP detail pages, meeting minutes, CIP documents, bid pages, etc.
// Returns array of { url, anchorText, linkType, relevanceHint }
function extractChildLinks(rawHtml, sourceUrl) {
  if (!rawHtml) return [];
  const links = [];
  const seen = new Set();
  let baseUrl;
  try { baseUrl = new URL(sourceUrl); } catch { return []; }

  // Match <a href="...">text</a> patterns
  const linkPat = /<a\s[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of rawHtml.matchAll(linkPat)) {
    let href = m[1].trim();
    const anchor = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!href || href.startsWith('javascript:') || href.startsWith('mailto:')) continue;
    if (anchor.length < 5 || anchor.length > 200) continue;

    // Resolve relative URLs
    try {
      const resolved = new URL(href, sourceUrl);
      href = resolved.href;
    } catch { continue; }

    if (seen.has(href)) continue;
    seen.add(href);

    const lo = anchor.toLowerCase();
    const hrefLo = href.toLowerCase();

    // Classify link type by anchor text and URL patterns
    let linkType = null;
    let relevanceHint = 0;

    // RFQ/RFP/solicitation detail pages
    if (/\b(rfq|rfp|request for|solicitation|invitation to bid)\b/.test(lo) ||
        /\b(bid|rfq|rfp|solicitation)\b/.test(hrefLo)) {
      linkType = 'solicitation_detail';
      relevanceHint = 10;
    }
    // Meeting minutes/agendas with dates
    else if (/\b(minutes|agenda|meeting)\b/.test(lo) && /\d{1,2}[\/-]\d{1,2}|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d/i.test(lo + ' ' + hrefLo)) {
      linkType = 'meeting_document';
      relevanceHint = 7;
    }
    // CIP/budget/capital plan documents
    else if (/\b(capital improvement|cip|budget|capital plan|facilities plan)\b/.test(lo)) {
      linkType = 'capital_document';
      relevanceHint = 8;
    }
    // Project detail pages
    else if (/\b(project detail|project page|view project|project info)\b/.test(lo) ||
             /\b(bid(ID|id|_id|detail)|projectid|project_id)\b/.test(hrefLo)) {
      linkType = 'project_detail';
      relevanceHint = 9;
    }
    // PDF documents that look like project documents
    else if (/\.pdf$/i.test(hrefLo) && /\b(rfq|rfp|bid|plan|design|capital|renovation|addition|facility)\b/.test(lo)) {
      linkType = 'document_pdf';
      relevanceHint = 8;
    }
    // Board/commission packets
    else if (/\b(packet|attachment|exhibit|appendix)\b/.test(lo) && /\.pdf$/i.test(hrefLo)) {
      linkType = 'board_packet';
      relevanceHint = 6;
    }

    if (linkType) {
      links.push({ url: href, anchorText: anchor, linkType, relevanceHint });
    }
  }

  // Sort by relevance hint (highest first)
  links.sort((a, b) => b.relevanceHint - a.relevanceHint);
  return links.slice(0, 20); // Cap at 20 links
}

// ── Follow the best child link for enrichment ───────────────
// Fetches the single best child page to extract richer project detail.
// Returns { enrichedContent, childUrl, childTitle, childLinkType, childAnchorText,
//           childDates, childBudget, childDescription } or null on failure.
// Safe: 10s timeout, returns null on any error, never fabricates.
async function enrichFromChildLink(bestLink) {
  if (!bestLink) return null;

  try {
    const f = await fetchUrl(bestLink.url, 10000);
    if (!f.ok || !f.content || f.content.length < 100) return null;
    const content = f.content.slice(0, 20000);

    // Extract dates from child content
    const childDates = extractDates(content);

    // Extract budget from child content
    const childBudget = extractBudget(content);

    // Extract a description: best sentences mentioning project substance
    const sentences = content.split(/(?<=[.!?])\s+/).filter(s => s.length > 25 && s.length < 300);
    const projectSentences = sentences.filter(s => {
      const sl = s.toLowerCase();
      return /\b(project|design|construction|renovation|scope|services?|building|facility|phase|architect|engineer)\b/.test(sl);
    });
    const childDescription = projectSentences.slice(0, 3).join(' ').slice(0, 500).trim() || null;

    return {
      enrichedContent: content,
      childUrl: bestLink.url,
      childTitle: f.title || bestLink.anchorText,
      childLinkType: bestLink.linkType,
      childAnchorText: bestLink.anchorText,
      childDates,
      childBudget,
      childDescription,
    };
  } catch {
    return null;
  }
}

/**
 * Select the single best child link for a specific lead candidate.
 * Prioritizes: solicitation_detail > project_detail > capital_document > document_pdf > meeting_document > board_packet.
 * Within a type, prefers links whose anchor text overlaps with the matched lead text.
 * Returns the single best link object, or null.
 */
function selectBestChildLink(childLinks, matchText, title) {
  if (!childLinks || childLinks.length === 0) return null;
  const textLo = `${matchText || ''} ${title || ''}`.toLowerCase();
  const textWords = textLo.split(/\s+/).filter(w => w.length > 3);

  // Score each child link: relevanceHint + text overlap bonus
  let best = null, bestScore = -1;
  for (const link of childLinks) {
    let score = link.relevanceHint || 0;
    const anchorLo = link.anchorText.toLowerCase();
    // Text overlap bonus: each matching word adds 1 point
    for (const w of textWords) {
      if (anchorLo.includes(w)) score += 1;
    }
    if (score > bestScore) { bestScore = score; best = link; }
  }

  // Only return if there's a meaningful match (link type was classified, scored at least 6)
  return (best && bestScore >= 6) ? best : null;
}

// ── Keyword pre-filter ──────────────────────────────────────
function preFilter(content, src) {
  if (!content) return { pass: false, n: 0, kw: [] };
  const lo = content.toLowerCase();
  const s = new Set();
  for (const t of SIGNALS) if (lo.includes(t)) s.add(t);
  for (const k of (src.keywords||[])) if (lo.includes(k.toLowerCase())) s.add(k);
  const arr = [...s];
  const hi = ['State Procurement','County Commission','City Council','Planning & Zoning','School Board'];
  return { pass: arr.length >= (hi.includes(src.category) ? 1 : 2), n: arr.length, kw: arr };
}

// ─── NAVIGATION / JUNK TEXT PATTERNS ─────────────────────────
// These patterns indicate page chrome, menus, footer text, or other
// non-project content that should never become a lead title.
const NAV_JUNK_PATTERNS = [
  /expand for details/i, /collapse for details/i, /click here/i,
  /read more/i, /learn more/i, /view all/i, /see more/i,
  /skip to (?:content|main|navigation)/i, /toggle navigation/i,
  /breadcrumb/i, /footer/i, /sidebar/i, /menu/i,
  /cookie\s*(?:policy|consent|notice)/i, /privacy policy/i,
  /terms (?:of|and) (?:use|service)/i, /accessibility/i,
  /copyright\s*©?\s*\d{4}/i, /all rights reserved/i,
  /powered by/i, /site map/i, /contact us/i,
  /sign in|log ?in|sign up|register|subscribe/i,
  /search results|no results|page not found/i,
  /^\s*home\s*[|>\/]/i, /^\s*back to /i,
];

// Minimum quality bar: a title must have at least one real project word
const PROJECT_TITLE_WORDS = /\b(renovation|addition|construction|expansion|improvement|upgrade|remodel|replacement|modernization|building|facility|project|design|study|plan|bond|levy|rfq|rfp|solicitation|bid|proposal|school|clinic|hospital|courthouse|library|terminal|hangar|housing|campus|laboratory|water|sewer|bridge|road|park|fire station|police)\b/i;

/**
 * Check if text looks like navigation / junk rather than a real project signal.
 */
function isNavigationJunk(text) {
  if (!text || text.length < 15) return true;
  // Fail if text matches common nav patterns
  for (const pat of NAV_JUNK_PATTERNS) {
    if (pat.test(text)) return true;
  }
  // Fail if mostly short words strung together (menu items)
  const words = text.split(/\s+/).filter(w => w.length > 0);
  if (words.length > 3) {
    const capWords = words.filter(w => /^[A-Z]/.test(w) && w.length < 8);
    if (capWords.length / words.length > 0.7) return true; // Mostly short capitalized menu items
  }
  // Fail if it doesn't contain at least one real project-related word
  if (!PROJECT_TITLE_WORDS.test(text)) return true;
  return false;
}

/**
 * Extract a clean project title from matched context.
 * Prefers: RFQ/RFP titles, project names, specific descriptions.
 * Falls back to: "Owner — ProjectType Signal" if context is weak.
 */
function extractProjectTitle(ctx, src) {
  // 1. Try to find an explicit project name in quotes or after "for:"
  const quotedName = ctx.match(/[""]([^""]{10,80})[""]/);
  if (quotedName && !isNavigationJunk(quotedName[1])) return quotedName[1].trim();

  const forClause = ctx.match(/(?:rfq|rfp|request for (?:qualifications?|proposals?))\s+(?:for|:|–|—)\s*([^.]{10,80})/i);
  if (forClause && !isNavigationJunk(forClause[1])) return forClause[1].trim();

  // 2. Try the first meaningful clause of the context
  const clauses = ctx.replace(/\s+/g, ' ').trim().split(/[;—–|]/);
  for (const clause of clauses) {
    const c = clause.trim();
    if (c.length >= 15 && c.length <= 90 && !isNavigationJunk(c)) return c;
  }

  // 3. Use the full context if short enough and clean
  const clean = ctx.replace(/\s+/g, ' ').trim();
  if (clean.length <= 80 && !isNavigationJunk(clean)) return clean;
  if (clean.length > 80 && clean.length <= 120 && !isNavigationJunk(clean)) return clean.slice(0, 77) + '...';

  // 4. Conservative fallback — use source org + generic type
  const type = /rfq|rfp/i.test(ctx) ? 'Solicitation' : /renovation|remodel/i.test(ctx) ? 'Renovation Project'
    : /addition|expansion/i.test(ctx) ? 'Expansion Project' : /bond|levy/i.test(ctx) ? 'Bond/Levy Program'
    : /capital improvement/i.test(ctx) ? 'Capital Improvement' : /master plan/i.test(ctx) ? 'Master Plan'
    : 'Project Signal';
  return `${src.organization || src.name || 'Unknown'} — ${type}`;
}

/**
 * Classify a lead as Active (actionable solicitation) or Watch (future signal).
 * Returns { leadClass, status }
 *   Active: RFQ, RFP, ITB, or explicit call for A/E services with a deadline
 *   Watch: Budget item, CIP entry, future project, planning signal
 */
function classifyActiveWatch(ctx, kws) {
  const lo = (ctx || '').toLowerCase();
  const activePhrases = [
    /\brfq\b/, /\brfp\b/, /\binvitation to bid\b/, /\brequest for (?:qualifications?|proposals?)\b/,
    /\bsolicitation\b/, /\bcall for\b.*\bservices?\b/, /\bstatement of qualifications\b/,
    /\bsubmit(?:tal)?\s+(?:by|before|due|deadline)\b/,
    /\bresponses?\s+(?:due|requested|accepted)\b/,
    /\bselection\s+(?:process|committee|panel)\b/,
    /\bshortlist/,
    /\brequest for a\/e\b/, /\brequest for architect/,
    /\bqualification.based\s+selection\b/, /\bqbs\b/,
  ];
  for (const p of activePhrases) {
    if (p.test(lo)) return { leadClass: 'active_solicitation', status: 'active' };
  }
  // If critical procurement keywords are present but no explicit solicitation language, still Active
  const criticalKws = (kws || []).filter(k => /^(rfq|rfp|invitation to bid|design services|architect)$/i.test(k));
  if (criticalKws.length >= 2) return { leadClass: 'active_solicitation', status: 'active' };

  // Everything else is Watch — future project, budget item, planning signal
  return { leadClass: 'watch_signal', status: 'watch' };
}

/**
 * Noise suppression: detect items that are clearly not real A&E pursuit leads.
 * Returns true if the candidate should be suppressed.
 */
function isNoiseLead(title, ctx, src) {
  const lo = (title || '').toLowerCase();
  const ctxLo = (ctx || '').toLowerCase();

  // Printable maps, bid map pages, generic map/GIS content
  if (/\b(printable map|bid map|interactive map|gis viewer|map viewer|plat map)\b/.test(lo)) return true;
  if (/\b(printable map|bid map|interactive map|gis viewer|map viewer)\b/.test(ctxLo) && !/\b(project|facility|building|renovation|construction)\b/.test(ctxLo)) return true;

  // Generic archive/reference/index pages
  if (/\b(archive|archived|back issues?|past (meetings?|agendas?|minutes))\b/.test(lo) && lo.length < 60) return true;

  // Generic category/listing pages without a distinct project
  if (/\b(bid results|bid tabulation|plan holders?|planholders? list|vendor list|bidder list)\b/.test(lo)) return true;
  if (/\b(all (bids|rfps?|rfqs?|solicitations?))\b/.test(lo) && !/\bfor\b/.test(lo)) return true;

  // Non-A&E supply/contractor notices
  if (/\b(janitorial|custodial|mowing|snow removal|snow plow|fuel (bid|contract)|office supplies|copier|vehicle (bid|purchase)|fleet|uniform)\b/.test(ctxLo)) return true;
  if (/\b(food service|catering|vending|pest control|elevator maintenance|hvac maintenance contract)\b/.test(ctxLo) && !/\b(design|renovation|construction|addition|facility)\b/.test(ctxLo)) return true;

  // Extremely short/generic titles that slipped through junk filter
  if (/^(home|about|news|events|contact|board|staff|resources|documents|calendar|agenda|minutes)$/i.test(lo.trim())) return true;

  return false;
}

/**
 * Extract dates from context: due dates for solicitations, timeline signals for projects.
 * Returns { action_due_date, potentialTimeline }
 */
function extractDates(ctx) {
  const result = { action_due_date: '', potentialTimeline: '' };
  if (!ctx) return result;

  // 1. Try to find explicit due/deadline dates
  const duePats = [
    /(?:due|deadline|submit(?:tal)?s?\s+(?:by|before)|responses?\s+(?:due|by)|closes?)\s*:?\s*(\w+\s+\d{1,2},?\s*\d{4})/i,
    /(?:due|deadline|submit(?:tal)?s?\s+(?:by|before)|responses?\s+(?:due|by)|closes?)\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
    /(?:due|deadline)\s*:?\s*(\w+\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{4})/i,
  ];
  for (const pat of duePats) {
    const m = ctx.match(pat);
    if (m) {
      const parsed = new Date(m[1]);
      if (!isNaN(parsed.getTime()) && parsed > new Date('2024-01-01')) {
        result.action_due_date = parsed.toISOString().split('T')[0];
        break;
      }
    }
  }

  // 2. Try to find timeline signals
  const tlPats = [
    /(?:design\s+(?:start|begin)|a\/e\s+selection|architect\s+selection)\s*(?:in|by|:)?\s*(Q[1-4]\s*\d{4}|\w+\s*\d{4})/i,
    /(?:construction\s+(?:start|begin))\s*(?:in|by|:)?\s*(Q[1-4]\s*\d{4}|\w+\s*\d{4}|spring|summer|fall|winter\s*\d{4})/i,
    /(?:project\s+(?:timeline|schedule))\s*:?\s*([^.]{10,60})/i,
    /(?:anticipated|expected|planned)\s+(?:start|completion|opening)\s*:?\s*([^.]{5,40})/i,
    /(Q[1-4]\s*20[2-3]\d)/i,
    /(?:FY|fiscal year)\s*(20[2-3]\d)/i,
  ];
  for (const pat of tlPats) {
    const m = ctx.match(pat);
    if (m) {
      result.potentialTimeline = m[1] ? m[1].trim() : m[0].trim();
      break;
    }
  }

  return result;
}

/**
 * Extract budget information from context.
 */
function extractBudget(ctx) {
  if (!ctx) return '';
  const budgetPats = [
    /\$\s*([\d,.]+)\s*(million|mil|m\b)/i,
    /\$\s*([\d,.]+)\s*(thousand|k\b)/i,
    /\$\s*([\d,.]+(?:\s*(?:–|-|to)\s*\$?\s*[\d,.]+)?)\s*(?:million|mil|m\b)/i,
    /(?:budget|estimated\s+cost|project\s+cost|estimated\s+value)\s*(?:of|:)?\s*\$\s*([\d,.]+[mkb]?(?:\s*(?:–|-|to)\s*\$?\s*[\d,.]+[mkb]?)?)/i,
    /\$\s*([\d,]+(?:\.\d+)?)/,
  ];
  for (const pat of budgetPats) {
    const m = ctx.match(pat);
    if (m) {
      // Only return if it looks like a significant amount (> $10K)
      const raw = m[0].replace(/[^0-9.kmb$–\-to ]/gi, '');
      if (/million|mil|\dm\b/i.test(m[0])) return m[0].trim();
      const num = parseFloat(m[1]?.replace(/,/g, '') || '0');
      if (num >= 10000 || /\dk\b/i.test(m[0])) return m[0].trim();
    }
  }
  return '';
}

/**
 * Infer A&E market sector from content context.
 * Uses hierarchical keyword matching for better accuracy.
 */
function inferMarket(ctx) {
  const lo = (ctx || '').toLowerCase();
  // Check most specific first, then broaden
  if (/\b(elementary|middle school|high school|classroom|gymnasium|school district|k-12|k–12)\b/.test(lo)) return 'K-12';
  if (/\b(university|college|campus|dormitor|student housing|higher ed|oche)\b/.test(lo)) return 'Higher Education';
  if (/\b(hospital|medical center|clinic|outpatient|healthcare|urgent care|imaging|surgical)\b/.test(lo)) return 'Healthcare';
  if (/\b(airport|terminal|hangar|aviation|runway|taxiway|apron)\b/.test(lo)) return 'Airports / Aviation';
  if (/\b(fire station|police|public safety|911|dispatch|jail|detention|corrections)\b/.test(lo)) return 'Public Safety';
  if (/\b(courthouse|city hall|government center|civic|municipal|county building|commission)\b/.test(lo)) return 'Civic';
  if (/\b(library|community center|senior center|recreation|pool|aquatic|arena|stadium)\b/.test(lo)) return 'Recreation';
  if (/\b(affordable housing|workforce housing|multifamily|apartment|residential|housing authority)\b/.test(lo)) return 'Housing';
  if (/\b(tribal|reservation|indian)\b/.test(lo)) return 'Tribal';
  if (/\b(water|wastewater|sewer|storm ?water|utility|treatment plant)\b/.test(lo)) return 'Infrastructure';
  if (/\b(hotel|resort|lodge|hospitality)\b/.test(lo)) return 'Hospitality';
  if (/\b(lab|laboratory|research|science)\b/.test(lo)) return 'Research / Lab';
  if (/\b(retail|commercial|office|mixed.?use)\b/.test(lo)) return 'Commercial';
  return 'Other';
}

/**
 * Infer project type from context.
 */
function inferType(ctx) {
  const lo = (ctx || '').toLowerCase();
  if (/\brfq\b|\brfp\b|\binvitation to bid\b|\bsolicitation\b/.test(lo)) return 'RFQ/RFP';
  if (/\bmaster plan\b|\bstrategic plan\b|\bfeasibility\b|\bstudy\b/.test(lo)) return 'Master Plan';
  if (/\bbond\b|\blevy\b/.test(lo)) return 'Bond';
  if (/\baddition\b|\bexpansion\b|\bextend\b/.test(lo)) return 'Addition';
  if (/\brenovation\b|\bremodel\b|\bupgrade\b|\bretrofit\b|\breplacement\b/.test(lo)) return 'Renovation';
  if (/\bnew construction\b|\bnew building\b|\bnew facility\b|\bnew (?:school|clinic|library|fire station)\b/.test(lo)) return 'New Construction';
  if (/\bcapital improvement\b|\bcip\b/.test(lo)) return 'Capital Improvement';
  return 'Other';
}

/**
 * Build a source-type description for evidence, e.g. "City Council meeting agenda" or "County procurement listing"
 */
function describeSourceType(src) {
  const cat = src.category || '';
  const page = src.pageType || '';
  if (cat.includes('Commission')) return 'county commission proceedings';
  if (cat.includes('City Council')) return 'city council proceedings';
  if (cat.includes('Planning')) return 'planning & zoning records';
  if (cat.includes('School Board')) return 'school board proceedings';
  if (cat === 'State Procurement') return 'state procurement portal';
  if (cat.includes('Airport')) return 'airport authority proceedings';
  if (cat.includes('Higher Ed')) return 'higher education capital planning';
  if (cat.includes('Redevelopment')) return 'redevelopment agency records';
  if (page.includes('Bid') || page.includes('RFQ')) return 'bid/procurement listings';
  if (page.includes('Agenda')) return 'meeting agendas and minutes';
  if (page.includes('Capital')) return 'capital project records';
  return `${cat || 'source'} records`;
}

/**
 * Score a candidate with A&E-relevant multi-factor analysis.
 * Returns 0-100 scores that meaningfully differentiate leads.
 *
 * Scoring factors (relevance):
 *   Signal quality (0-35): weighted by keyword tier
 *   Geography fit (0-20): core/county/outer/statewide
 *   Source credibility (0-15): by category
 *   Focus/org match (0-15): configured watch targets
 *   Project type fit (0-15): A&E-relevant project types
 */
function scoreCandidate(ctx, src, kws, fps, orgs) {
  const lo = (ctx || '').toLowerCase();

  // 1. Signal quality (0-35) — weighted by keyword tier
  let sigScore = 0;
  const criticalHits = (kws || []).filter(k => /^(rfq|rfp|invitation to bid|design services|architect|a\/e services)$/i.test(k));
  const highHits = (kws || []).filter(k => /^(capital improvement|bond|levy|facilities plan|master plan)$/i.test(k));
  sigScore += criticalHits.length * 8;
  sigScore += highHits.length * 5;
  sigScore += Math.max(0, (kws || []).length - criticalHits.length - highHits.length) * 2;
  sigScore = Math.min(35, sigScore);

  // 2. Geography fit (0-20)
  let geoScore = 0;
  const srcGeo = (src.geography || '').toLowerCase();
  const coreGeos = ['missoula', 'kalispell', 'whitefish', 'columbia falls', 'hamilton', 'polson'];
  const countyGeos = ['missoula county', 'flathead county', 'ravalli county', 'lake county'];
  const outerGeos = ['cascade county', 'lewis and clark', 'gallatin', 'yellowstone', 'sanders', 'lincoln', 'mineral'];
  if (coreGeos.some(g => srcGeo.includes(g) || lo.includes(g))) geoScore = 20;
  else if (countyGeos.some(g => srcGeo.includes(g) || lo.includes(g))) geoScore = 16;
  else if (outerGeos.some(g => srcGeo.includes(g) || lo.includes(g))) geoScore = 10;
  else geoScore = 5; // Statewide or unknown

  // 3. Source credibility (0-15)
  const credMap = { 'State Procurement':15, 'County Commission':14, 'City Council':13, 'Planning & Zoning':13,
    'School Board':12, 'Airport Authority':12, 'Higher Ed Capital':12, 'Redevelopment Agency':11,
    'Economic Development':10, 'Public Notice':10, 'Tribal Government':11, 'Healthcare System':9, 'Utility':8, 'Media':5 };
  const credScore = credMap[src.category] || 6;

  // 4. Focus/org match (0-15)
  const mOrgs = (orgs || []).filter(o => o.active !== false && lo.includes((o.name || '').toLowerCase()));
  const mFPs = (fps || []).filter(f => f.active !== false && (f.keywords || []).some(k => lo.includes(k.toLowerCase())));
  const matchScore = Math.min(15, mOrgs.length * 6 + mFPs.length * 5);

  // 5. Project type fit for A&E (0-15)
  let typeScore = 0;
  if (/\brfq\b.*(?:architect|design|a\/e)/i.test(lo)) typeScore = 15;
  else if (/\brfq\b|\brfp\b/i.test(lo)) typeScore = 12;
  else if (/\bnew (?:construction|building|facility|school|clinic)\b/i.test(lo)) typeScore = 13;
  else if (/\brenovation\b|\baddition\b|\bremodel\b/i.test(lo)) typeScore = 11;
  else if (/\bmaster plan\b|\bfeasibility\b|\bstudy\b/i.test(lo)) typeScore = 10;
  else if (/\bbond\b|\blevy\b|\bcapital improvement\b/i.test(lo)) typeScore = 8;
  else if (/\bconstruction\b|\bbuilding\b|\bfacility\b/i.test(lo)) typeScore = 5;
  else typeScore = 2;

  const relevanceScore = Math.min(100, Math.max(0, sigScore + geoScore + credScore + matchScore + typeScore));

  // Pursuit score: relevance-based + actionability signals
  let pursuitBase = relevanceScore * 0.45;
  if (/\brfq\b|\brfp\b|\binvitation to bid\b|\bsolicitation\b/i.test(lo)) pursuitBase += 22;
  if (/\b(20[2-3]\d|q[1-4]|phase|deadline|selection|submit)\b/i.test(lo)) pursuitBase += 12;
  if (/\$[\d,.]+|\bmillion\b|\bbudget\b/i.test(lo)) pursuitBase += 10;
  if (/\bdesign\s+(?:services?|team|firm|architect)\b/i.test(lo)) pursuitBase += 8;
  const pursuitScore = Math.min(100, Math.max(0, Math.round(pursuitBase)));

  // Source confidence: based on source category credibility
  const baseConf = { 'State Procurement':92, 'County Commission':88, 'City Council':85, 'Planning & Zoning':85,
    'School Board':82, 'Airport Authority':80, 'Higher Ed Capital':80, 'Redevelopment Agency':78,
    'Economic Development':75, 'Public Notice':78, 'Tribal Government':78, 'Healthcare System':70 };
  const sourceConfidenceScore = baseConf[src.category] || 60;

  return {
    relevanceScore, pursuitScore, sourceConfidenceScore,
    matchedOrgs: mOrgs, matchedFPs: mFPs,
  };
}

// ── A&E + SMA service-fit assessment ────────────────────────
// Based on publicly listed services: Architecture, Brand Development, Environmental
// Graphic Design, Historic Preservation, Interior Design, Landscape Architecture
// Markets: Commercial, Hospitality, K-12, Residential, Healthcare, Higher Education, Military
const AE_SERVICES = {
  strong: [
    /\b(architect\w*|design services?|a\/e services?|interior design|landscape architect\w*|historic preservation|environmental graphic)\b/i,
    /\b(new (?:construction|building|facility)|renovation|remodel|addition|expansion|modernization)\b/i,
    /\b(master plan|feasibility study|space (?:plan|needs|study)|programming|schematic design)\b/i,
  ],
  moderate: [
    /\b(tenant improvement|adaptive reuse|wayfinding|signage program|branding)\b/i,
    /\b(site (?:planning|design)|campus plan|facility assessment)\b/i,
  ],
  weak: [
    /\b(engineering services?|civil engineer|structural engineer|mep)\b/i,
    /\b(construction management|cm at risk|design.build)\b/i,
  ],
};
const AE_MARKETS = {
  core: ['K-12','Higher Education','Healthcare','Civic','Hospitality','Commercial','Housing','Recreation'],
  secondary: ['Public Safety','Airports / Aviation','Tribal','Infrastructure','Research / Lab'],
  peripheral: ['Industrial','Retail','Developer-Led','Other'],
};

function assessServiceFit(ctx, market) {
  const lo = (ctx || '').toLowerCase();
  let fit = 0;
  let reasons = [];
  for (const p of AE_SERVICES.strong) { if (p.test(lo)) { fit += 15; reasons.push('architectural/design services alignment'); break; } }
  for (const p of AE_SERVICES.moderate) { if (p.test(lo)) { fit += 8; reasons.push('related design discipline'); break; } }
  for (const p of AE_SERVICES.weak) { if (p.test(lo)) { fit += 3; break; } }
  if (AE_MARKETS.core.includes(market)) { fit += 12; reasons.push(`${market} is a core A&E + SMA market`); }
  else if (AE_MARKETS.secondary.includes(market)) { fit += 6; reasons.push(`${market} is a secondary market`); }
  else { fit += 1; }
  return { fit: Math.min(30, fit), reasons };
}

// ── Better location extraction from content ─────────────────
function extractLocation(ctx, src) {
  const lo = (ctx || '').toLowerCase();
  // Try to find a specific city/town mention
  const mtCities = [
    'Missoula','Kalispell','Whitefish','Columbia Falls','Hamilton','Polson',
    'Helena','Great Falls','Billings','Bozeman','Butte','Anaconda',
    'Libby','Thompson Falls','Superior','Ronan','Pablo','St. Ignatius',
    'Stevensville','Florence','Lolo','Frenchtown','Seeley Lake','Bigfork',
    'Lakeside','Somers','Eureka','Troy','Plains','Hot Springs',
  ];
  for (const city of mtCities) {
    if (lo.includes(city.toLowerCase())) {
      // Try to find the county too
      const countyPat = new RegExp(city + '[^.]{0,30}(\\w+ county)', 'i');
      const cm = ctx.match(countyPat);
      return cm ? `${city}, ${cm[1]}, MT` : `${city}, MT`;
    }
  }
  // Fall back to county if available
  const countyPat = /\b(\w+(?:\s+\w+)?\s+county)\b/i;
  const cm = lo.match(countyPat);
  if (cm) return `${cm[1].replace(/\b\w/g, c => c.toUpperCase())}, MT`;
  // Fall back to source geography
  if (src.geography && src.geography !== 'Statewide') return `${src.geography}, MT`;
  if (src.county) return `${src.county}, MT`;
  return 'Montana';
}

// ── Generate a real project description (not just regex match) ──
function generateDescription(matchText, fullContext, leadClass, market, projectType, budget, timeline, src) {
  const parts = [];

  // Core: what is the project?
  const cleanMatch = matchText.replace(/\s+/g, ' ').trim();
  // Try to extract a meaningful sentence from fullContext
  const sentences = fullContext.split(/(?<=[.!])\s+/).filter(s => s.length > 20 && s.length < 250);
  const bestSentence = sentences.find(s => {
    const sl = s.toLowerCase();
    return /\b(project|construction|renovation|addition|building|facility|design|plan)\b/.test(sl);
  }) || sentences[0] || cleanMatch;

  // Don't repeat the title — use the sentence if it adds information
  if (bestSentence.length > 30) {
    parts.push(bestSentence.slice(0, 250).trim());
  } else {
    parts.push(cleanMatch.slice(0, 250).trim());
  }

  // Add budget and timeline if available and not already in the sentence
  const extras = [];
  if (budget && !parts[0].includes('$')) extras.push(`Estimated budget: ${budget}`);
  if (timeline && !parts[0].toLowerCase().includes(timeline.toLowerCase())) extras.push(`Timeline: ${timeline}`);
  if (extras.length > 0) parts.push(extras.join('. '));

  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 400);
}

// ── Generate meaningful "Why It Matters" ────────────────────
function generateWhyItMatters(leadClass, market, location, scores, src, serviceFit) {
  const parts = [];

  // Service/market fit
  if (serviceFit.reasons.length > 0) {
    parts.push(serviceFit.reasons[0].charAt(0).toUpperCase() + serviceFit.reasons[0].slice(1));
  }
  if (serviceFit.reasons.length > 1) parts.push(serviceFit.reasons[1]);

  // Geography relevance
  const coreGeos = ['missoula','kalispell','whitefish','columbia falls','hamilton','polson'];
  const locLo = (location || '').toLowerCase();
  if (coreGeos.some(g => locLo.includes(g))) {
    parts.push('Located in a core A&E + SMA service area');
  } else if (/\b(flathead|ravalli|lake|missoula)\b/.test(locLo)) {
    parts.push('Located in Western Montana, within the firm\'s primary region');
  }

  // Solicitation urgency
  if (leadClass === 'active_solicitation') {
    parts.push('Active solicitation — may require near-term response');
  }

  // Target org
  if (scores.matchedOrgs.length > 0) {
    parts.push(`${scores.matchedOrgs.map(o => o.name).join(', ')} is a tracked target organization`);
  }

  if (parts.length === 0) parts.push('Potential A&E project opportunity identified through source monitoring');
  return parts.join('. ') + '.';
}

// ── Generate meaningful AI Assessment ───────────────────────
function generateAIAssessment(leadClass, market, projectType, scores, serviceFit, location, budget) {
  const parts = [];

  // Opportunity characterization
  if (leadClass === 'active_solicitation') {
    parts.push(`This appears to be an active ${projectType !== 'Other' ? projectType.toLowerCase() + ' ' : ''}solicitation`);
    if (market !== 'Other') parts.push(`in the ${market} sector`);
  } else {
    parts.push(`This is a planning-stage ${projectType !== 'Other' ? projectType.toLowerCase() + ' ' : ''}signal`);
    if (market !== 'Other') parts.push(`in the ${market} sector`);
  }

  // Service alignment assessment
  if (serviceFit.fit >= 20) {
    parts.push('Strong alignment with A&E + SMA capabilities');
  } else if (serviceFit.fit >= 10) {
    parts.push('Moderate alignment with firm capabilities');
  } else {
    parts.push('Limited alignment with A&E + SMA core services — review whether pursuit is warranted');
  }

  // Practical advice
  if (leadClass === 'active_solicitation' && serviceFit.fit >= 15) {
    parts.push('Recommend reviewing the solicitation documents and assessing go/no-go');
  } else if (leadClass === 'watch_signal') {
    parts.push('Monitor for solicitation release or further development');
  }

  // Budget context
  if (budget) parts.push(`Budget information present (${budget}), suggesting a funded project`);

  return parts.join('. ') + '.';
}

// ── Extract leads from real fetched content ─────────────────
async function extractLeads(content, src, kws, fps, orgs, childLinks, log = () => {}) {
  if (!content || content.length < 50) return [];

  // ── Step 1: Clean content — remove obvious nav/menu/footer text
  const cleanContent = content
    .replace(/(?:Skip to (?:content|main|navigation)|Toggle navigation|Breadcrumb)[^.]{0,50}/gi, '')
    .replace(/(?:Home|About|Contact|FAQ|Staff|Board|Administration)\s*[|>\/]\s*/gi, '')
    .replace(/(?:Expand|Collapse)\s+(?:for|all)\s+\w+/gi, '')
    .replace(/(?:Copyright|©)\s*\d{4}[^.]{0,80}/gi, '')
    .replace(/(?:Privacy Policy|Terms of (?:Use|Service)|Accessibility)[^.]{0,40}/gi, '');

  const lo = cleanContent.toLowerCase();

  // ── Step 2: Extract candidate matches with broader patterns
  const pats = [
    // Solicitations: RFQ, RFP, ITB with following context
    /(?:rfq|rfp|invitation to bid|request for (?:qualifications?|proposals?))\s*(?:#\s*\w+[-\d]*\s*)?(?:for|:|–|—)\s*([^.]{10,150})/gi,
    // Explicit A/E services needed
    /(?:design services?|architectural services?|engineering services?|a\/e services?)\s+(?:for|needed|required|sought)[^.]{5,120}/gi,
    // Capital improvement / bond / levy programs
    /(?:capital improvement|bond|levy)\s+(?:plan|project|program|package|measure)[^.]{5,120}/gi,
    // Planned/proposed projects
    /(?:proposed|planned|approved|upcoming|new)\s+(?:construction|renovation|addition|building|facility|expansion)\s+(?:of|for|at|on)\s+[^.]{10,120}/gi,
    // Projects with named subjects: "Renovation of the [name]", "Construction of [name]"
    /(?:renovation|construction|expansion|addition|modernization|replacement|upgrade)\s+of\s+(?:the\s+)?[^.]{10,100}/gi,
    // Budget line items: "$X for [project]" or "$X million [project]"
    /\$[\d,.]+\s*(?:million|mil|m|k)?\s+(?:for|toward|allocated)\s+[^.]{10,100}/gi,
    // Specific facility mentions with action: "[Facility] renovation/construction/expansion"
    /(?:(?:[\w\s]{5,40})\s+(?:renovation|construction|expansion|addition|modernization|replacement))\b[^.]{0,80}/gi,
  ];

  const candidates = [];
  const seen = new Set();

  for (const p of pats) {
    for (const m of cleanContent.matchAll(p)) {
      let ctx = m[0].trim();

      // Expand context: grab surrounding sentence for richer description
      const idx = m.index;
      const sentStart = Math.max(0, cleanContent.lastIndexOf('.', Math.max(0, idx - 1)) + 1);
      const sentEnd = Math.min(cleanContent.length, cleanContent.indexOf('.', idx + ctx.length));
      const fullSentence = cleanContent.slice(sentStart, sentEnd > idx ? sentEnd : idx + ctx.length).trim();

      // Quality checks
      if (isNavigationJunk(ctx)) continue;
      if (ctx.length < 20) continue;

      // Deduplicate by normalized prefix
      const key = ctx.slice(0, 50).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (seen.has(key)) continue;
      seen.add(key);

      candidates.push({
        matchText: ctx,
        fullContext: fullSentence.length > ctx.length ? fullSentence : ctx,
        patternIndex: pats.indexOf(p),
      });
    }
  }

  // ── Step 3: Build lead records from valid candidates
  const leads = [];
  const now = new Date().toISOString();
  const MAX_CHILD_FETCHES_PER_SOURCE = 2; // Limit child-page fetches to control latency
  let childFetchCount = 0;

  for (const cand of candidates) {
    if (leads.length >= 5) break; // Cap per source

    const { matchText, fullContext } = cand;
    const title = extractProjectTitle(matchText, src);

    // Skip if title is still junk after cleanup
    if (isNavigationJunk(title) || title.length < 10) continue;

    // Noise suppression: skip items that are clearly not A&E pursuit leads
    if (isNoiseLead(title, fullContext, src)) continue;

    // Classify Active vs Watch
    const { leadClass, status } = classifyActiveWatch(fullContext, kws);

    // Extract dates and budget
    const dates = extractDates(fullContext);
    const budget = extractBudget(fullContext);

    // Infer market and project type
    const market = inferMarket(fullContext);
    const projectType = inferType(fullContext);

    // Score
    const scores = scoreCandidate(fullContext, src, kws, fps, orgs);

    // Service-fit assessment
    const serviceFit = assessServiceFit(fullContext, market);

    // Adjust relevance by service fit (replaces pure keyword weighting)
    const adjustedRelevance = Math.min(100, Math.max(0, Math.round(
      scores.relevanceScore * 0.7 + serviceFit.fit * 1.0
    )));
    const adjustedPursuit = Math.min(100, Math.max(0, Math.round(
      scores.pursuitScore * 0.8 + (serviceFit.fit >= 15 ? 12 : serviceFit.fit >= 8 ? 5 : 0)
    )));

    // Better location
    const location = extractLocation(fullContext, src);

    // Build description from context — prefer meaningful summary over raw match
    const description = generateDescription(matchText, fullContext, leadClass, market, projectType, budget, dates.potentialTimeline, src);

    // Build evidence with useful context
    const sourceDesc = describeSourceType(src);
    const id = `lead-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // ── Child-document enrichment ────────────────────────────
    // Find all relevant child links for this lead
    const relevantChildLinks = (childLinks || []).filter(link => {
      const al = link.anchorText.toLowerCase();
      const tl = title.toLowerCase();
      const words = tl.split(/\s+/).filter(w => w.length > 3);
      return words.some(w => al.includes(w)) || link.relevanceHint >= 9;
    });

    // Select the single best child link for enrichment fetch
    const bestChildLink = selectBestChildLink(relevantChildLinks.length > 0 ? relevantChildLinks : childLinks, matchText, title);

    // Fetch child page content if we have a strong link and haven't blown our per-source budget
    let childEnrichment = null;
    if (bestChildLink && childFetchCount < MAX_CHILD_FETCHES_PER_SOURCE) {
      childFetchCount++;
      childEnrichment = await enrichFromChildLink(bestChildLink);
      if (childEnrichment) {
        log(`    ↳ child enrichment: ${bestChildLink.linkType} "${bestChildLink.anchorText.slice(0, 50)}"`);
      }
    }

    // ── Merge child enrichment into lead fields ─────────────
    // Dates: prefer child dates if they add new information
    let finalDates = dates;
    let finalBudget = budget;
    let finalDescription = description;

    if (childEnrichment) {
      // Dates: child page may have more specific deadline
      if (childEnrichment.childDates) {
        if (!finalDates.action_due_date && childEnrichment.childDates.action_due_date) {
          finalDates = { ...finalDates, action_due_date: childEnrichment.childDates.action_due_date };
        }
        if (!finalDates.potentialTimeline && childEnrichment.childDates.potentialTimeline) {
          finalDates = { ...finalDates, potentialTimeline: childEnrichment.childDates.potentialTimeline };
        }
      }
      // Budget: prefer child-sourced budget if parent didn't have one
      if (!finalBudget && childEnrichment.childBudget) {
        finalBudget = childEnrichment.childBudget;
      }
      // Description: prefer child description if it's substantially richer
      if (childEnrichment.childDescription && childEnrichment.childDescription.length > (finalDescription || '').length * 0.6) {
        finalDescription = childEnrichment.childDescription;
      }
    }

    // Action Due: for Active leads use solicitation due date; for Watch use timeline
    let actionDue = '';
    if (status === 'active' && finalDates.action_due_date) {
      actionDue = finalDates.action_due_date; // Actual solicitation deadline
    }
    // For Watch leads, leave action_due_date blank — timeline is shown separately

    // Evidence: use child link if available, else fall back to source page
    const evidenceUrl = bestChildLink ? bestChildLink.url : src.url;
    const evidenceLabel = bestChildLink
      ? `${bestChildLink.linkType === 'solicitation_detail' ? 'Solicitation' : bestChildLink.linkType === 'meeting_document' ? 'Meeting document' : bestChildLink.linkType === 'capital_document' ? 'Capital plan document' : bestChildLink.linkType === 'project_detail' ? 'Project detail' : bestChildLink.linkType === 'document_pdf' ? 'Project document (PDF)' : 'Source document'} found via ${src.name}`
      : `Signal detected in ${sourceDesc}`;
    const evTitle = leadClass === 'active_solicitation'
      ? `Active solicitation: ${evidenceLabel}`
      : `Project signal: ${evidenceLabel}`;

    // Build evidence summary with more detail
    const evDetailParts = [];
    evDetailParts.push(evTitle);
    if (bestChildLink) evDetailParts.push(`Direct document: "${bestChildLink.anchorText}"`);
    if (childEnrichment) evDetailParts.push('Enriched from child document');
    evDetailParts.push(matchText.slice(0, 180).trim());
    const evSummary = evDetailParts.join('. ') + (matchText.length > 180 ? '...' : '.');

    // Better why-it-matters
    const whyItMatters = generateWhyItMatters(leadClass, market, location, scores, src, serviceFit);

    // Better AI assessment
    const aiReasonForAddition = generateAIAssessment(leadClass, market, projectType, scores, serviceFit, location, finalBudget);

    // Build confidence notes
    const confParts = [];
    confParts.push(`Source: ${src.category || 'Unknown'} (${src.priority || 'standard'} priority)`);
    if (serviceFit.fit >= 15) confParts.push('Strong A&E service alignment');
    else if (serviceFit.fit >= 8) confParts.push('Moderate A&E service alignment');
    else confParts.push('Limited A&E service alignment');
    if (leadClass === 'active_solicitation') confParts.push('Active solicitation detected');
    if (actionDue) confParts.push(`Solicitation due: ${actionDue}`);
    if (finalBudget) confParts.push('Budget information present');
    if (childEnrichment) confParts.push('Enriched from child document');
    else if (bestChildLink) confParts.push('Direct document link available');

    // Build all evidence source links (source page + child links)
    const evidenceSourceLinks = [{ url: src.url, label: src.name, linkType: 'source_page' }];
    for (const cl of relevantChildLinks.slice(0, 5)) {
      evidenceSourceLinks.push({ url: cl.url, label: cl.anchorText, linkType: cl.linkType });
    }

    leads.push({
      id, title,
      owner: src.organization || '',
      projectName: title !== `${src.organization || src.name} — ${inferType(matchText)}` ? title : '',
      location,
      county: src.county || '', geography: src.geography || '',
      marketSector: market,
      projectType,
      description: finalDescription,
      whyItMatters,
      aiReasonForAddition,
      potentialTimeline: finalDates.potentialTimeline,
      potentialBudget: finalBudget,
      action_due_date: actionDue,
      relevanceScore: adjustedRelevance,
      pursuitScore: adjustedPursuit,
      sourceConfidenceScore: scores.sourceConfidenceScore,
      confidenceNotes: confParts.join('. ') + '.',
      dateDiscovered: now, originalSignalDate: now,
      lastCheckedDate: now,
      status, leadClass, leadOrigin: 'live',
      sourceName: src.name, sourceUrl: src.url, sourceId: src.id,
      evidenceLinks: [...new Set([evidenceUrl, src.url])],
      evidenceSourceLinks,
      evidenceSummary: evSummary,
      matchedFocusPoints: scores.matchedFPs.map(f => f.title),
      matchedKeywords: kws.slice(0, 10),
      matchedTargetOrgs: scores.matchedOrgs.map(o => o.name),
      internalContact: '', notes: '',
      evidence: [{
        id: `ev-${id}`, leadId: id, sourceId: src.id, sourceName: src.name,
        url: evidenceUrl,
        title: evTitle,
        summary: evSummary,
        signalDate: now, dateFound: now,
        signalStrength: leadClass === 'active_solicitation' ? 'strong' : (adjustedRelevance > 60 ? 'medium' : 'weak'),
        keywords: kws.slice(0, 8),
        childLinks: relevantChildLinks.slice(0, 3).map(cl => ({ url: cl.url, label: cl.anchorText, type: cl.linkType })),
      }],
    });
  }

  return leads;
}

// ── Persistent status (in-memory, resets on cold start) ─────
let lastRun = null;

// ── HANDLER ─────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS
  Object.entries(corsHeaders()).forEach(([k,v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query?.action || 'status';
  const body = req.body || {};
  const logs = [];
  const log = m => { logs.push(m); console.log(`[PS] ${m}`); };

  try {
    // ── STATUS ──────────────────────────────────────────────
    if (req.method === 'GET' || action === 'status') {
      return res.status(200).json({ ok: true, lastRun, time: new Date().toISOString(), version: '1.0.0' });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

    // ── FETCH-ONE (smoke test) ──────────────────────────────
    if (action === 'fetch-one') {
      const { source } = body;
      if (!source?.url) return res.status(400).json({ error: 'body.source.url required' });
      log(`fetch-one: ${source.url}`);
      const f = await fetchUrl(source.url);
      log(f.ok ? `✓ HTTP ${f.status} — ${f.length} chars — "${f.title||'(no title)'}"` : `✗ ${f.err}`);
      let kw = null, leads = [];
      if (f.ok && f.content) {
        kw = preFilter(f.content, source);
        log(`Keywords: ${kw.n} (${kw.pass?'PASS':'BELOW THRESHOLD'}): ${kw.kw.slice(0,6).join(', ')}`);
        if (kw.pass) {
          const childLinks = extractChildLinks(f.rawHtml, source.url);
          log(`Found ${childLinks.length} child document links`);
          leads = await extractLeads(f.content, source, kw.kw, body.focusPoints||[], body.targetOrgs||[], childLinks, log);
          log(`Extracted ${leads.length} lead(s)`);
        } else {
          log('No leads — keyword threshold not met');
        }
      }
      return res.status(200).json({ ok: f.ok, fetch: { status:f.status, title:f.title, length:f.length, lastMod:f.lastMod, error:f.err },
        keywords: kw, leads, logs, ts: new Date().toISOString() });
    }

    // ── ASANA IMPORT — fetch all tasks for import panel ─────
    if (action === 'asana-import') {
      const token = process.env.ASANA_ACCESS_TOKEN || body.settings?.asanaToken;
      if (!token) {
        return res.status(200).json({ ok: false, error: 'No Asana access token configured.', logs, ts: new Date().toISOString() });
      }
      const proj = process.env.ASANA_PROJECT_ID || body.settings?.asanaProjectId || '1203575716271060';
      log(`Asana import: fetching all tasks from project ${proj}...`);
      let tasks = [], offset = null;
      do {
        const u = `https://app.asana.com/api/1.0/projects/${proj}/tasks?opt_fields=name,permalink_url,created_at,completed,completed_at,assignee.name,notes,memberships.section.name&limit=100${offset?`&offset=${offset}`:''}`;
        const r = await fetch(u, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!r.ok) { const t = await r.text(); throw new Error(`Asana HTTP ${r.status}: ${t.slice(0,200)}`); }
        const d = await r.json();
        if (d.errors?.length) throw new Error(d.errors[0].message);
        tasks.push(...(d.data||[]));
        offset = d.next_page?.offset || null;
      } while (offset);
      log(`Asana import: ${tasks.length} tasks fetched`);
      const taskSection = (task) => {
        const m = (task.memberships || []).find(mb => mb.section?.name);
        return m ? m.section.name : null;
      };
      const mapped = tasks.map(t => ({
        gid: t.gid,
        name: t.name || '',
        permalink_url: t.permalink_url || '',
        created_at: t.created_at || null,
        completed: !!t.completed,
        completed_at: t.completed_at || null,
        assignee_name: t.assignee?.name || null,
        section: taskSection(t),
        notes_excerpt: t.notes ? t.notes.slice(0, 300) : null,
      }));
      return res.status(200).json({ ok:true, tasks:mapped, count:mapped.length, logs, ts:new Date().toISOString() });
    }

    // ── ASANA CHECK ─────────────────────────────────────────
    if (action === 'asana') {
      const token = process.env.ASANA_ACCESS_TOKEN || body.settings?.asanaToken;
      if (!token) {
        log('Asana: no token configured — set ASANA_ACCESS_TOKEN environment variable');
        return res.status(200).json({ ok: false, error: 'No Asana access token. Set ASANA_ACCESS_TOKEN in backend environment variables.', mode: 'unavailable', logs, ts: new Date().toISOString() });
      }
      const proj = process.env.ASANA_PROJECT_ID || body.settings?.asanaProjectId || '1203575716271060';
      log(`Asana: fetching project ${proj}...`);
      let tasks = [], offset = null;
      do {
        const u = `https://app.asana.com/api/1.0/projects/${proj}/tasks?opt_fields=name,permalink_url,created_at,completed,completed_at,assignee.name,notes,memberships.section.name&limit=100${offset?`&offset=${offset}`:''}`;
        const r = await fetch(u, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!r.ok) { const t = await r.text(); throw new Error(`Asana HTTP ${r.status}: ${t.slice(0,200)}`); }
        const d = await r.json();
        if (d.errors?.length) throw new Error(d.errors[0].message);
        tasks.push(...(d.data||[]));
        offset = d.next_page?.offset || null;
      } while (offset);
      log(`Asana: ${tasks.length} tasks`);

      const norm = t => (t||'').toLowerCase().replace(/[^a-z0-9\s]/g,'').replace(/\s+/g,' ').trim();
      // Stop words that inflate Jaccard similarity on short titles
      const STOP_WORDS = new Set(['the','and','for','from','with','this','that','are','was','will','has','have','been','its','our','new','all','project','county','city','state','montana']);
      const significantWords = (text) => norm(text).split(' ').filter(w => w.length > 2 && !STOP_WORDS.has(w));
      const wsim = (a,b) => {
        const wa=new Set(significantWords(a));
        const wb=new Set(significantWords(b));
        if(wa.size < 2 || wb.size < 2) return 0; // Require at least 2 significant words each
        let i=0; for(const w of wa) if(wb.has(w)) i++;
        return i / new Set([...wa,...wb]).size;
      };
      // Extract section name from memberships array
      const taskSection = (task) => {
        const m = (task.memberships || []).find(mb => mb.section?.name);
        return m ? m.section.name : null;
      };

      const matches = [];
      for (const lead of (body.existingLeads||[])) {
        for (const task of tasks) {
          const na=norm(lead.title), nb=norm(task.name);
          let hit = null;
          // Exact match: normalized titles are identical
          if (na === nb) {
            hit = { confidence:0.95, matchType:'exact' };
            log(`  ✓ EXACT: "${lead.title}" → "${task.name}"`);
          }
          // Near-exact: one fully contains the other AND the shorter has 4+ words
          else if ((nb.includes(na) || na.includes(nb)) && Math.min(na.split(' ').length, nb.split(' ').length) >= 4) {
            hit = { confidence:0.90, matchType:'near_exact' };
            log(`  ✓ NEAR-EXACT: "${lead.title}" → "${task.name}"`);
          }
          // Fuzzy: raised threshold from 0.5 to 0.65 to reduce false positives
          else {
            const s = wsim(lead.title, task.name);
            if (s >= 0.65) {
              hit = { confidence:Math.round(s*100)/100, matchType:'fuzzy' };
              log(`  ~ FUZZY (${Math.round(s*100)}%): "${lead.title}" → "${task.name}"`);
            }
          }
          if (hit) {
            // Use permalink_url if available; otherwise mark as board-level link (not a direct task link)
            const hasPermalink = !!(task.permalink_url);
            matches.push({
              leadId: lead.id,
              taskName: task.name,
              taskGid: task.gid || null,
              taskUrl: hasPermalink ? task.permalink_url : '',
              taskUrlIsPermalink: hasPermalink,
              confidence: hit.confidence,
              matchType: hit.matchType,
              // Richer Asana context for history display
              asana_created_at: task.created_at || null,
              asana_completed: !!task.completed,
              asana_completed_at: task.completed_at || null,
              asana_assignee: task.assignee?.name || null,
              asana_section: taskSection(task),
              asana_notes_excerpt: task.notes ? task.notes.slice(0, 300) : null,
            });
            break;
          }
        }
      }
      log(`Asana: ${matches.length} matches`);
      return res.status(200).json({ ok:true, matches, tasks:tasks.length, mode:'connected', logs, ts:new Date().toISOString() });
    }

    // ── DAILY / BACKFILL ────────────────────────────────────
    const { sources, focusPoints, targetOrgs, existingLeads, notPursuedLeads, settings } = body;
    if (!sources?.length) return res.status(400).json({ error: 'body.sources required (array)' });

    const active = sources.filter(s => s.active !== false);

    // Normalize V2 source fields to what the engine expects
    const normalize = (src) => ({
      ...src,
      name: src.source_name || src.name || '',
      url: src.source_url || src.url || '',
      id: src.source_id || src.id || '',
      keywords: src.keywords_to_watch || src.keywords || [],
      category: src.source_family || src.category || '',
      priority: src.priority_tier || src.priority || 'medium',
      organization: src.entity_name || src.organization || src.source_name || src.name || '',
    });
    const activeNorm = active.map(normalize);

    const list = action === 'daily' ? activeNorm.slice(0, 15) : activeNorm;
    const freshDays = settings?.freshnessDays || 60;

    log(`═══ ${action.toUpperCase()} — ${list.length} of ${activeNorm.length} active sources ═══`);

    const allEx = [...(existingLeads||[]), ...(notPursuedLeads||[])];
    const npSet = new Set((notPursuedLeads||[]).map(l => (l.title||'').toLowerCase().trim()));
    const exSet = new Set(allEx.map(l => (l.title||'').toLowerCase().trim()));

    const added = [], updated = [];
    let skipNP = 0, skipDupe = 0, fetchOk = 0, fetchFail = 0, parseHits = 0;
    const start = Date.now();

    for (let i = 0; i < list.length; i++) {
      const src = list[i];
      log(`[${i+1}/${list.length}] ${src.name} (${src.url})`);

      const f = await fetchUrl(src.url);
      if (!f.ok) { log(`  ✗ ${f.err||'HTTP '+f.status}`); fetchFail++; continue; }
      fetchOk++;
      log(`  ✓ ${f.length} chars — "${f.title||'(no title)'}"`);

      const { pass, n, kw } = preFilter(f.content, src);
      if (!pass) { log(`  — ${n} keywords (below threshold)`); continue; }
      parseHits++;
      log(`  → ${n} keywords: ${kw.slice(0,5).join(', ')}`);

      const childLinks = extractChildLinks(f.rawHtml, src.url);
      if (childLinks.length > 0) log(`  → ${childLinks.length} child document links found`);

      const cands = await extractLeads(f.content, src, kw, focusPoints||[], targetOrgs||[], childLinks, log);
      log(`  → ${cands.length} candidate(s)`);

      for (const c of cands) {
        const tl = (c.title||'').toLowerCase().trim();
        if (npSet.has(tl)) { skipNP++; log(`    ⊘ blocked (Not Pursued)`); continue; }
        if (exSet.has(tl)) {
          const ex = allEx.find(l => (l.title||'').toLowerCase().trim() === tl);
          if (ex && (existingLeads||[]).find(l => l.id === ex.id)) {
            updated.push({
              leadId: ex.id,
              lastCheckedDate: new Date().toISOString(),
              relevanceScore: Math.min(100, (ex.relevanceScore||50) + 3),
              newEvidence: c.evidence?.[0] || null,
              aiReasonForAddition: c.aiReasonForAddition,
            });
            log(`    ↻ updated existing lead`);
          }
          skipDupe++; continue;
        }
        exSet.add(tl);
        added.push(c);
        log(`    ✚ NEW: ${c.title.slice(0,60)}`);
      }
      if (added.length >= (action === 'daily' ? 10 : 25)) { log('  — lead cap reached'); break; }
    }

    const dur = Date.now() - start;
    const results = {
      leadsAdded: added, leadsUpdated: updated,
      skippedNotPursued: skipNP, skippedDuplicate: skipDupe,
      sourcesFetched: fetchOk + fetchFail, fetchSuccesses: fetchOk, fetchFailures: fetchFail,
      parseHits, duration: dur, mode: 'live',
    };

    log(`═══ DONE in ${(dur/1000).toFixed(1)}s ═══`);
    log(`Sources: ${fetchOk} ok, ${fetchFail} failed | Signals: ${parseHits} sources with hits`);
    log(`Leads: +${added.length} new, ${updated.length} updated, ${skipNP} blocked, ${skipDupe} duped`);

    lastRun = { action, ok: true, ts: new Date().toISOString(), added: added.length, updated: updated.length, dur };
    return res.status(200).json({ ok: true, action, results, logs, ts: new Date().toISOString() });

  } catch (err) {
    log(`FATAL: ${err.stack || err.message}`);
    lastRun = { action, ok: false, ts: new Date().toISOString(), error: err.message };
    return res.status(500).json({ ok: false, error: err.message, logs, ts: new Date().toISOString() });
  }
};
