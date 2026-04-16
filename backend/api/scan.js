/**
 * /api/scan.js — Project Scout Intelligence Engine
 *
 * Serverless function. Deploys to Vercel as-is. Uses Node.js native fetch (Node 18+).
 * PDF text extraction via unpdf (serverless-optimized PDF.js).
 *
 * Actions:
 *   GET  ?action=status      → Last run info + health check
 *   POST ?action=fetch-one   → Fetch + analyze one source (smoke test)
 *   POST ?action=daily       → Daily scan (up to 15 sources)
 *   POST ?action=backfill    → Full backfill (all active sources)
 *   POST ?action=asana       → Check Asana board for matches
 *
 * All POST bodies: { source?, sources?, focusPoints?, targetOrgs?,
 *                     existingLeads?, notPursuedLeads?, taxonomy?, settings? }
 */

// ── BUILD ID — change this value to verify which backend is running ──
const SCAN_BUILD_ID = 'scan-v4.29-20260416-structured-evidence-b34';

// ── v4-b29: Server-side weekly brief publish (to Upstash Redis) ─────
// Computes a weekly brief snapshot from the scan's lead corpus and stores it
// in the same Upstash Redis that store.js uses, so any browser can read it.

const BRIEF_REDIS_KEY = 'ps_news_brief_archive';

function serverComputeWeekId(timestamp) {
  const DAY = 86400000;
  const dt = new Date(timestamp); dt.setHours(0, 0, 0, 0);
  dt.setDate(dt.getDate() + 3 - ((dt.getDay() + 6) % 7));
  const jan4 = new Date(dt.getFullYear(), 0, 4);
  const wk = 1 + Math.round(((dt - jan4) / DAY + (jan4.getDay() + 6) % 7 - 3) / 7);
  return `${dt.getFullYear()}-W${String(wk).padStart(2, '0')}`;
}

function serverComputeWeekLabel(timestamp) {
  const dt = new Date(timestamp); dt.setHours(0, 0, 0, 0);
  const dayOfWeek = (dt.getDay() + 6) % 7;
  const mon = new Date(dt); mon.setDate(dt.getDate() - dayOfWeek);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `Week of ${fmt(mon)} – ${fmt(sun)}, ${mon.getFullYear()}`;
}

async function serverPublishWeeklyBrief(addedLeads, callerExistingLeads, log) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) { log('  ⚠ Brief publish skipped — no Upstash configured'); return null; }

  // Helper: read a key from Upstash Redis
  const redisGet = async (key) => {
    try {
      const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return null;
      const d = await r.json();
      if (!d.result) return null;
      let parsed = JSON.parse(d.result);
      if (typeof parsed === 'string') try { parsed = JSON.parse(parsed); } catch {}
      return parsed;
    } catch { return null; }
  };
  const redisSet = async (key, value) => {
    const r = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: JSON.stringify(value),
    });
    return r.ok;
  };

  const DAY = 86400000;
  const now = Date.now();
  const weekId = serverComputeWeekId(now);
  const weekLabel = serverComputeWeekLabel(now);

  // Read current brief archive from Redis
  let archive = [];
  const archiveData = await redisGet(BRIEF_REDIS_KEY);
  if (Array.isArray(archiveData)) archive = archiveData;

  // Check if this week already published
  const existingBrief = archive.find(s => s.weekId === weekId);
  if (existingBrief) { log(`  Brief: ${weekId} already published — skipping`); return null; }

  // ── FULL CORPUS: Read the shared lead state from Upstash Redis ──
  // This is the authoritative lead corpus — same data that store.js serves and the frontend syncs.
  // Falls back to caller-provided existingLeads only if Redis read fails.
  let sharedLeads = await redisGet('ps_leads');
  let corpusSource = 'upstash';
  if (!Array.isArray(sharedLeads) || sharedLeads.length === 0) {
    // Fallback to caller-provided leads (browser-driven scans send existingLeads in the POST body)
    sharedLeads = callerExistingLeads || [];
    corpusSource = sharedLeads.length > 0 ? 'caller' : 'empty';
  }

  // Merge: shared corpus + freshly added leads from this scan (deduped by id)
  const seenIds = new Set(sharedLeads.map(l => l.id));
  const freshNew = (addedLeads || []).filter(l => l.id && !seenIds.has(l.id));
  const allLeads = [...sharedLeads, ...freshNew];

  log(`  Brief corpus: ${sharedLeads.length} shared (${corpusSource}) + ${freshNew.length} new from scan = ${allLeads.length} total`);

  // Simple lead-tab classification (mirrors frontend getLeadTab)
  const isNews = (l) => {
    if (l.leadClass === 'active_solicitation' || l.status === 'active') return false;
    if (l.dashboard_lane === 'news') return true;
    if (/news|media/i.test(l.sourceName || '')) return true;
    return false;
  };
  const isProject = (l) => !isNews(l) && l.status !== 'active' && l.leadClass !== 'active_solicitation';

  const newsLeads = allLeads.filter(isNews);
  const projectLeads = allLeads.filter(isProject);
  const allItems = [...newsLeads, ...projectLeads];

  const getItemDate = (l) => {
    const d = l.originalSignalDate || l.emailDate || l.dateDiscovered || l.dateAdded || l.lastCheckedDate;
    return d ? new Date(d).getTime() : 0;
  };
  const within7d = allItems.filter(l => (now - getItemDate(l)) <= 7 * DAY);
  const within30d = allItems.filter(l => (now - getItemDate(l)) <= 30 * DAY);

  if (within7d.length === 0 && within30d.length === 0) {
    log('  Brief: no items in 7d/30d window — skipping');
    return null;
  }

  const high = within7d.filter(l => l.projectPotential === 'high');
  const med = within7d.filter(l => l.projectPotential === 'medium');
  const signalCount = high.length + med.length;

  let narrative = signalCount > 0
    ? `${signalCount} project-relevant signal${signalCount !== 1 ? 's' : ''} in the last 7 days.`
    : `${within7d.length} item${within7d.length !== 1 ? 's' : ''} scanned in the last 7 days.`;
  if (high.length > 0) {
    narrative += ` Key: ${high.slice(0, 3).map(l => l.title).join(', ')}.`;
  }
  const budgetLeads = within7d.filter(l => l.potentialBudget);
  if (budgetLeads.length > 0) narrative += ` Funding: ${budgetLeads[0].potentialBudget} for ${budgetLeads[0].title}.`;

  // Extract active owner/entity themes
  const ORG_PATS = [
    [/\b(city\s+of\s+missoula|city\s+council)\b/i, 'City of Missoula'],
    [/\b(missoula\s+county|county\s+commission)\b/i, 'Missoula County'],
    [/\b(mra|missoula\s+redevelopment)\b/i, 'MRA'],
    [/\b(mep|missoula\s+economic)\b/i, 'MEP'],
    [/\b(housing\s+authority|mha)\b/i, 'Housing Authority'],
    [/\b(mcps|school\s+board|school\s+district)\b/i, 'MCPS'],
    [/\b(airport\s+authority|missoula\s+airport)\b/i, 'Airport Authority'],
    [/\b(university\s+of\s+montana)\b/i, 'University of Montana'],
  ];
  const orgCounts = new Map();
  for (const l of within7d) {
    const txt = `${l.title || ''} ${l.owner || ''} ${l.sourceName || ''} ${l.description || ''}`;
    for (const [pat, name] of ORG_PATS) { if (pat.test(txt)) orgCounts.set(name, (orgCounts.get(name) || 0) + 1); }
  }
  const activeOrgs = [...orgCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n]) => n);
  if (activeOrgs.length > 0) narrative += ` Active: ${activeOrgs.join(', ')}.`;

  const snapshot = {
    date: new Date().toISOString(),
    weekId,
    weekLabel,
    titles7d: within7d.map(l => l.title || ''),
    titles30d: within30d.map(l => l.title || ''),
    high: high.length,
    med: med.length,
    total7d: within7d.length,
    total30d: within30d.length,
    narrative7d: narrative,
    trigger: 'server-scan',
    scanBuildId: SCAN_BUILD_ID,
    corpusSource,
    corpusSize: allLeads.length,
    activeOrgs,
  };

  // Save — replace same-week, keep last 8
  const others = archive.filter(s => s.weekId !== weekId);
  const updated = [...others.slice(-7), snapshot];

  const saved = await redisSet(BRIEF_REDIS_KEY, updated);
  if (!saved) { log('  ⚠ Brief Redis SET failed'); return null; }

  log(`  ✓ Brief published: ${weekId} (${within7d.length} items, ${high.length} high, corpus: ${allLeads.length} from ${corpusSource}) — server-scan`);
  return snapshot;
}

// ── V4: SOURCE PROFILE ENGINE ─────────────────────────────────
// Each source has a profile that controls how the scan engine reads it.
// Profile types: budget, agenda, procurement, redevelopment, media, employer, contractor, institutional
const SOURCE_PROFILES = {
  budget: {
    container_behavior: 'container',
    max_child_fetches: 5,
    max_leads: 10,
    prefer_child_types: ['capital_document', 'document_pdf', 'project_detail'],
    allowed_object_types: ['solicitation', 'project', 'district', 'site', 'development_potential'],
    blocked_object_types: ['department', 'program', 'topic', 'organization'],
    dashboard_lane: 'active_leads',
    ignore_patterns: ['general fund', 'operating budget', 'personnel', 'staffing', 'payroll', 'insurance', 'benefits', 'salary'],
  },
  agenda: {
    container_behavior: 'container',
    max_child_fetches: 5,
    max_leads: 8,
    prefer_child_types: ['meeting_document', 'document_pdf', 'board_packet'],
    allowed_object_types: ['solicitation', 'project', 'district', 'site', 'news_item'],
    blocked_object_types: ['department', 'program', 'topic', 'organization'],
    dashboard_lane: 'active_leads',
    ignore_patterns: ['consent agenda', 'roll call', 'pledge of allegiance', 'approval of minutes', 'public comment period', 'adjournment', 'proclamation'],
  },
  procurement: {
    container_behavior: 'container',
    max_child_fetches: 6,
    max_leads: 12,
    prefer_child_types: ['solicitation_detail', 'document_pdf', 'project_detail'],
    allowed_object_types: ['solicitation', 'project'],
    blocked_object_types: ['department', 'program', 'topic', 'organization'],
    dashboard_lane: 'active_leads',
    ignore_patterns: ['fuel bid', 'chip seal', 'mowing', 'snow removal', 'janitorial', 'custodial', 'uniform', 'vehicle purchase', 'parts list'],
  },
  redevelopment: {
    container_behavior: 'hybrid',
    max_child_fetches: 4,
    max_leads: 12,
    prefer_child_types: ['project_detail', 'document_pdf', 'meeting_document'],
    allowed_object_types: ['district', 'site', 'development_potential', 'project'],
    blocked_object_types: ['department', 'topic', 'organization'],
    dashboard_lane: 'development_potentials',
    ignore_patterns: ['general policy', 'mission statement', 'about us', 'contact us'],
  },
  media: {
    container_behavior: 'direct',
    max_child_fetches: 0,
    max_leads: 5,
    prefer_child_types: [],
    allowed_object_types: ['news_item', 'project'],
    blocked_object_types: ['department', 'program', 'topic'],
    dashboard_lane: 'news',
    ignore_patterns: ['sports', 'entertainment', 'obituary', 'opinion', 'letter to the editor', 'classified', 'horoscope', 'comics'],
  },
  employer: {
    container_behavior: 'direct',
    max_child_fetches: 2,
    max_leads: 5,
    prefer_child_types: ['project_detail'],
    allowed_object_types: ['news_item', 'project', 'development_potential'],
    blocked_object_types: ['department', 'program', 'topic'],
    dashboard_lane: 'news',
    ignore_patterns: ['job posting', 'career', 'hiring', 'employment', 'benefits', 'hr', 'apply now'],
  },
  contractor: {
    container_behavior: 'direct',
    max_child_fetches: 2,
    max_leads: 5,
    prefer_child_types: ['project_detail'],
    allowed_object_types: ['news_item', 'project'],
    blocked_object_types: ['department', 'program', 'topic', 'organization'],
    dashboard_lane: 'news',
    ignore_patterns: ['job posting', 'career', 'hiring', 'about us', 'mission', 'values', 'safety record'],
  },
  institutional: {
    container_behavior: 'hybrid',
    max_child_fetches: 3,
    max_leads: 8,
    prefer_child_types: ['capital_document', 'project_detail', 'document_pdf'],
    allowed_object_types: ['project', 'development_potential'],
    blocked_object_types: ['department', 'program', 'topic', 'organization'],
    dashboard_lane: 'active_leads',
    ignore_patterns: ['academic program', 'student services', 'admissions', 'tuition', 'course catalog', 'financial aid'],
  },
  // v4-b15: Public notice sources — fetched via Column.us API, not HTTP
  public_notice: {
    container_behavior: 'api',
    max_child_fetches: 0,
    max_leads: 10,
    prefer_child_types: [],
    allowed_object_types: ['solicitation', 'project', 'development_potential', 'news_item'],
    blocked_object_types: [],
    dashboard_lane: 'active_leads',
    ignore_patterns: ['notice to creditors', 'estate notice', 'foreclosure', 'trustee sale', 'abandoned vehicle', 'name change', 'summons'],
  },
  // v4-b24: Gmail intake — reads labeled emails from a dedicated Gmail account
  gmail_intake: {
    container_behavior: 'api',
    max_child_fetches: 0,
    max_leads: 15,
    prefer_child_types: [],
    allowed_object_types: ['solicitation', 'project', 'development_potential', 'news_item'],
    blocked_object_types: [],
    dashboard_lane: 'news', // default — overridden by label classification
    ignore_patterns: [],
  },
};

function getSourceProfile(src) {
  // Check for explicit profile_type on the source
  if (src.source_profile?.profile_type && SOURCE_PROFILES[src.source_profile.profile_type]) {
    return { ...SOURCE_PROFILES[src.source_profile.profile_type], ...src.source_profile };
  }
  // Infer from source_family and name — always include profile_type so logs show the actual type
  const family = src.source_family || '';
  const name = (src.source_name || src.name || '').toLowerCase();
  const url = (src.source_url || src.url || '').toLowerCase();
  if (/SF-01/.test(family) || /procurement|bid|rfq|rfp/i.test(name)) return { ...SOURCE_PROFILES.procurement, profile_type: 'procurement' };
  if (/SF-02/.test(family) || /agenda|meeting|minutes|commission/i.test(name)) return { ...SOURCE_PROFILES.agenda, profile_type: 'agenda' };
  if (/SF-08/.test(family) || /budget|cip|capital|opengov/i.test(name) || /opengov\.com/.test(url)) return { ...SOURCE_PROFILES.budget, profile_type: 'budget' };
  if (/SF-09/.test(family) || /redevelopment|mra|urban renewal|development (authority|partnership)/i.test(name)) return { ...SOURCE_PROFILES.redevelopment, profile_type: 'redevelopment' };
  if (/SF-07/.test(family) || /facilit|campus|university|college|school/i.test(name)) return { ...SOURCE_PROFILES.institutional, profile_type: 'institutional' };
  if (/news|missoulian|current|kpax|media/i.test(name) || /missoulian\.com|missoulacurrent|kpax/i.test(url)) return { ...SOURCE_PROFILES.media, profile_type: 'media' };
  if (/contractor|construction co|dac|quality|jackson|martel|langlas/i.test(name)) return { ...SOURCE_PROFILES.contractor, profile_type: 'contractor' };
  if (/employer|hospital|bank|providence|community medical/i.test(name)) return { ...SOURCE_PROFILES.employer, profile_type: 'employer' };
  return { ...SOURCE_PROFILES.institutional, profile_type: 'institutional' }; // default
}

function profileMatchesIgnore(profile, text) {
  if (!profile?.ignore_patterns?.length || !text) return false;
  const lo = text.toLowerCase();
  return profile.ignore_patterns.some(pat => lo.includes(pat));
}

function profileAllowsObjectType(profile, objectType) {
  if (!profile || !objectType) return true;
  if (profile.blocked_object_types?.includes(objectType)) return false;
  if (profile.allowed_object_types?.length > 0) return profile.allowed_object_types.includes(objectType);
  return true;
}

// ── v4-b15: Public-notice ingestion via Column.us API ────────
// Fetches newspaper public notices directly from the Column.us Elasticsearch API.
// No headless browser needed — the API is publicly accessible.
const COLUMN_API_URL = 'https://us-central1-enotice-production.cloudfunctions.net/api/search/public-notices';

// Notice types relevant to A&E BD
const PROCUREMENT_NOTICE_TYPES = ['Invitation to Bid', 'Request for Proposal', 'RFQ (Request for Qualifications)'];
const DEVELOPMENT_NOTICE_TYPES = ['Notice of Hearing', 'Notice of Development', 'Notice of Election', 'Notice of Proposed Budget'];
const ALL_RELEVANT_NOTICE_TYPES = [...PROCUREMENT_NOTICE_TYPES, ...DEVELOPMENT_NOTICE_TYPES];

async function fetchPublicNotices(src, log = () => {}) {
  const profile = src.source_profile || {};
  const newspaperName = profile.newspaper_name || 'Missoulian';
  const noticeTypes = profile.notice_types || PROCUREMENT_NOTICE_TYPES;
  const daysBack = profile.days_back || 30;
  const pageSize = profile.max_notices || 20;

  const now = Date.now();
  const startTs = now - (daysBack * 24 * 60 * 60 * 1000);

  const body = {
    search: '',
    allFilters: [
      { publishedtimestamp: { from: startTs, to: now } },
      { noticetype: noticeTypes },
      { newspapername: [newspaperName] },
    ],
    noneFilters: [],
    sort: [{ publishedtimestamp: 'desc' }],
    pageSize,
    current: 1,
    isDemo: false,
  };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const resp = await fetch(COLUMN_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      log(`  ✗ Column API HTTP ${resp.status}`);
      return { ok: false, err: `HTTP ${resp.status}`, notices: [] };
    }

    const data = await resp.json();
    if (!data.success || !data.results) {
      log(`  ✗ Column API returned no results`);
      return { ok: false, err: 'No results', notices: [] };
    }

    const notices = data.results.map(r => ({
      text: r.text || '',
      noticeType: r.noticetype || '',
      newspaper: r.newspapername || '',
      county: r.county || '',
      state: r.state || '',
      publishedTimestamp: r.publishedtimestamp || 0,
      publishedDate: r.publishedtimestamp ? new Date(r.publishedtimestamp).toISOString().split('T')[0] : '',
      pdfUrl: r.pdfurl || '',
      noticeId: r.id || '',
    }));

    log(`  ✓ Column API: ${notices.length} notices (of ${data.page?.total_results || '?'} total)`);
    return { ok: true, notices, totalResults: data.page?.total_results || notices.length };
  } catch (err) {
    log(`  ✗ Column API error: ${err.message}`);
    return { ok: false, err: err.message, notices: [] };
  }
}

// Extract a lead from a public notice
function extractLeadFromNotice(notice, src) {
  const text = (notice.text || '').trim();
  if (text.length < 20) return null;

  // Extract title: first line or first sentence
  const firstLine = text.split('\n').find(l => l.trim().length > 10) || '';
  let title = cleanTitle(firstLine.trim().slice(0, 150));

  // If title still looks like the notice type prefix, extract the real project name
  if (/^(invitation to bid|rfp|rfq|request for|notice of)\s*[-–—:]\s*/i.test(title)) {
    title = title.replace(/^(invitation to bid|rfp|rfq|request for\s+\w+|notice of\s+\w+)\s*[-–—:]\s*/i, '').trim();
  }
  if (!title || title.length < 8) return null;

  // Validate title
  const vlt = validateLiveTitle(title);
  if (!vlt.pass) return null;
  if (isNavigationJunk(title)) return null;

  // Extract description: remaining text after first line, max 400 chars
  const descLines = text.split('\n').slice(1).join(' ').replace(/\s+/g, ' ').trim();
  const description = descLines.slice(0, 400);

  // Extract dates
  const dueDateMatch = text.match(/(?:due|deadline|received|submit)\s+(?:by|before|no later than|until)\s+([A-Z][a-z]+\.?\s+\d{1,2},?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  const actionDueDate = dueDateMatch ? dueDateMatch[1] : '';

  // Determine lane routing based on notice type
  const isProcurement = PROCUREMENT_NOTICE_TYPES.includes(notice.noticeType);
  const isDevelopment = DEVELOPMENT_NOTICE_TYPES.includes(notice.noticeType);
  const dashboardLane = isProcurement ? 'active_leads' : isDevelopment ? 'development_potentials' : 'news';

  // Determine lead class
  const leadClass = isProcurement ? 'active_solicitation' : 'watch_signal';
  const status = isProcurement ? 'active' : 'watch';

  // Infer market from text
  const lo = text.toLowerCase();
  let marketSector = 'Other';
  if (/\b(school|elementary|middle school|high school|k-12)\b/.test(lo)) marketSector = 'K-12';
  else if (/\b(university|college|campus)\b/.test(lo)) marketSector = 'Higher Education';
  else if (/\b(hospital|clinic|medical|healthcare)\b/.test(lo)) marketSector = 'Healthcare';
  else if (/\b(fire station|police|public safety)\b/.test(lo)) marketSector = 'Public Safety';
  else if (/\b(courthouse|city hall|civic|municipal|county)\b/.test(lo)) marketSector = 'Civic';
  else if (/\b(housing|affordable|residential|apartment)\b/.test(lo)) marketSector = 'Housing';
  else if (/\b(redevelopment|urban renewal|tif|urd)\b/.test(lo)) marketSector = 'Mixed Use';
  else if (/\b(construction|renovation|building|facility|project)\b/.test(lo)) marketSector = 'Civic';

  // A&E relevance check — skip non-A&E notices
  // v4-b16: Tighter A&E relevance — require real building/facility/design signals
  const hasAERelevance = /\b(construction|renovation|building|facility|design|architect|engineer|capital|infrastructure|school|hospital|campus|housing|treatment\s+plant|fire\s+station|library|courthouse)\b/i.test(lo);
  // Allow through if it explicitly mentions RFQ/RFP for design/architect services
  const hasDesignRFP = /\b(rfq|rfp)\b/i.test(lo) && /\b(design|architect|engineer|a\/e|building|facility|renovation|construction)\b/i.test(lo);
  if (!hasAERelevance && !hasDesignRFP) return null;
  // Suppress concession/food/service-only notices
  if (/\b(concession|food\s+service|catering|vending|custodial|janitorial|pest\s+control|elevator\s+maintenance)\b/i.test(lo) &&
      !/\b(renovation|construction|design|architect|building|facility)\b/i.test(lo)) return null;
  // Suppress inspection/testing-only service contracts (not A&E building scope)
  if (/\b(inspection\s+(and|&)\s+testing|testing\s+services?|inspection\s+services?)\b/i.test(lo) &&
      !/\b(renovation|construction|design|architect|building|facility|school|hospital|campus)\b/i.test(lo)) return null;

  const id = `lead-notice-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const now = new Date().toISOString();

  return {
    id,
    title,
    owner: notice.newspaper || 'Missoulian',
    projectName: title,
    location: notice.county ? `${notice.county}, ${notice.state || 'MT'}` : (src.city ? `${src.city}, MT` : 'Missoula, MT'),
    county: notice.county || src.county || 'Missoula',
    marketSector,
    projectType: isProcurement ? 'RFQ/RFP' : 'Other',
    description: description ? `${description} — Source: Newspaper public notice (${notice.newspaper})` : `Public notice: ${title}`,
    whyItMatters: isProcurement
      ? `Public notice published in ${notice.newspaper} — active procurement opportunity. Review scope and deadline.`
      : `Public notice published in ${notice.newspaper} — development/planning signal for monitoring.`,
    aiReasonForAddition: `Newspaper public notice (${notice.noticeType}) published ${notice.publishedDate}. Source: ${notice.newspaper}.`,
    potentialTimeline: '',
    potentialBudget: '',
    action_due_date: actionDueDate,
    relevanceScore: isProcurement ? 65 : 40,
    pursuitScore: isProcurement ? 45 : 20,
    sourceConfidenceScore: 70,
    confidenceNotes: `Public notice from ${notice.newspaper} (${notice.noticeType}). Published ${notice.publishedDate}.`,
    dateDiscovered: now,
    originalSignalDate: notice.publishedDate || now,
    lastCheckedDate: now,
    status,
    leadClass,
    leadOrigin: 'public_notice',
    dashboard_lane: dashboardLane,
    watchCategory: isProcurement ? 'named_project' : 'development_program',
    projectStatus: isProcurement ? 'active_solicitation' : 'future_watch',
    extractionPath: 'public_notice_api',
    sourceName: src.name || src.source_name || 'Missoulian Public Notices',
    sourceUrl: src.url || src.source_url || '',
    sourceId: src.id || src.source_id || '',
    evidenceLinks: [src.url || src.source_url || 'https://missoulian.column.us/search'],
    evidenceSourceLinks: [{ url: 'https://missoulian.column.us/search', label: 'Missoulian Public Notices', linkType: 'public_notice_portal' }],
    evidenceSummary: `Public notice (${notice.noticeType}): ${title}. Published ${notice.publishedDate} in ${notice.newspaper}. ${description.slice(0, 200)}`,
    matchedFocusPoints: [],
    matchedKeywords: [],
    matchedTargetOrgs: [],
    taxonomyMatches: [],
    internalContact: '',
    notes: '',
    evidence: [{
      id: `ev-${id}`,
      leadId: id,
      sourceId: src.id || src.source_id || '',
      sourceName: notice.newspaper,
      url: 'https://missoulian.column.us/search',
      title: `Public notice: ${title}`,
      summary: `${notice.noticeType} published ${notice.publishedDate}. ${description.slice(0, 200)}`,
      signalDate: notice.publishedDate || now,
      dateFound: now,
      signalStrength: isProcurement ? 'strong' : 'medium',
      keywords: [],
    }],
  };
}

// ── v4-b25: Gmail intake via Gmail API — full-body + link-following + attachments ──
// Reads labeled emails from a dedicated Gmail account.
// Requires GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN env vars.
// Labels: Work/Scout/News → news, Work/Scout/RFP → active_leads, Work/Scout/Projects → development_potentials
// Now reads full message body (text/plain + text/html), follows linked URLs (HTML + PDF),
// and detects/parses PDF attachments.

const GMAIL_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GMAIL_MAX_LINK_FOLLOWS = 3;       // Max links to fetch per email
const GMAIL_LINK_FETCH_TIMEOUT = 12000; // 12s per linked URL

async function getGmailAccessToken() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;
  try {
    const resp = await fetch(GMAIL_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.access_token || null;
  } catch { return null; }
}

// Decode base64url (Gmail's encoding for message body parts)
function decodeBase64Url(str) {
  if (!str) return '';
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  try { return Buffer.from(padded, 'base64').toString('utf-8'); } catch { return ''; }
}

// Recursively extract body text and attachments from a MIME payload
function parseMimeParts(payload, result = { textPlain: '', textHtml: '', attachments: [] }) {
  if (!payload) return result;
  const mime = (payload.mimeType || '').toLowerCase();
  const filename = payload.filename || '';

  // Leaf part with body data
  if (payload.body?.data) {
    if (mime === 'text/plain' && !filename) {
      result.textPlain += decodeBase64Url(payload.body.data);
    } else if (mime === 'text/html' && !filename) {
      result.textHtml += decodeBase64Url(payload.body.data);
    }
  }
  // Attachment (has filename or attachmentId)
  if (filename && payload.body?.attachmentId) {
    result.attachments.push({
      filename,
      mimeType: mime,
      attachmentId: payload.body.attachmentId,
      size: payload.body.size || 0,
    });
  }
  // Recurse into multipart children
  if (payload.parts) {
    for (const part of payload.parts) parseMimeParts(part, result);
  }
  return result;
}

// Strip HTML to text (simplified — for extracting readable content from email HTML)
function htmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#?\w+;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Extract all http/https links from HTML content (from href attributes + plain-text URLs)
function extractLinksFromHtml(html) {
  if (!html) return [];
  const links = new Set();
  // From href attributes
  const hrefPat = /href=["'](https?:\/\/[^"'#]+)["']/gi;
  for (const m of html.matchAll(hrefPat)) links.add(m[1].replace(/&amp;/g, '&'));
  // From plain text (fallback for text/plain bodies)
  const urlPat = /https?:\/\/[^\s<>"')\]]+/g;
  for (const m of html.matchAll(urlPat)) links.add(m[0].replace(/[.,;:!?)]+$/, ''));
  return [...links];
}

// Filter links to only those worth following (project docs, meeting minutes, PDFs, bid pages)
function isFollowableGmailLink(url) {
  if (!url) return false;
  const lo = url.toLowerCase();
  // Skip social, unsubscribe, tracking, login, generic web
  if (/\b(unsubscribe|email-preferences|tracking|click\.|mailchimp|constantcontact|facebook|twitter|linkedin|instagram|youtube|google\.com\/(maps|search)|yelp|tripadvisor|mailto:|tel:)\b/.test(lo)) return false;
  if (/\.(jpg|jpeg|png|gif|ico|svg|woff|css|js)(\?|$)/i.test(lo)) return false;
  // Prioritize document-like links
  if (/\.pdf(\?|$)/i.test(lo)) return true;
  if (/\b(filestream|document|agenda|minutes|memo|attachment|report|bid|rfp|rfq|proposal|meeting|escribemeetings|legistar|granicus|civicplus|boarddocs)\b/i.test(lo)) return true;
  if (/\b(missoula|missoulacounty|ci\.missoula|mra|engagemissoula|mcps|umt|mountainline)\b/i.test(lo)) return true;
  // Government / institutional domains are generally worth following
  if (/\.(gov|edu|org|us)[\/?]/i.test(lo)) return true;
  return false;
}

// Build the Gmail query dynamically by fetching labels and finding Scout-related ones
async function buildGmailQuery(token, days = 7, log = () => {}) {
  try {
    const labelsResp = await fetch(`${GMAIL_API_BASE}/labels`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!labelsResp.ok) {
      log('  ⚠ Could not fetch Gmail labels — falling back to broad query');
      return `newer_than:${days}d`;
    }
    const labelsData = await labelsResp.json();
    const allLabels = labelsData.labels || [];

    // Find labels containing "scout" (case-insensitive)
    const scoutLabels = allLabels.filter(l => /scout/i.test(l.name));
    if (scoutLabels.length === 0) {
      log('  ⚠ No Scout labels found in Gmail — using broad query');
      return `newer_than:${days}d`;
    }

    // Build query: convert label names to Gmail query format
    // Gmail query uses label names with / replaced by - and lowercased
    const labelQueries = scoutLabels.map(l => {
      const queryName = l.name.toLowerCase().replace(/\//g, '-').replace(/\s+/g, '-');
      return `label:${queryName}`;
    });

    const query = `(${labelQueries.join(' OR ')}) newer_than:${days}d`;
    log(`  Gmail query (dynamic): ${query}`);
    log(`  Scout labels: ${scoutLabels.map(l => l.name).join(', ')}`);
    return query;
  } catch (e) {
    log(`  ⚠ Label fetch error: ${e.message} — falling back`);
    return `newer_than:${days}d`;
  }
}

// Classify an email's Scout label from the label IDs + fetched label name map
function classifyScoutLabel(labelIds, labelNameMap) {
  for (const lid of labelIds) {
    const name = (labelNameMap[lid] || '').toLowerCase();
    if (name.includes('scout') && name.includes('rfp')) return 'rfp';
    if (name.includes('scout') && name.includes('project')) return 'projects';
    if (name.includes('scout') && name.includes('news')) return 'news';
  }
  // Fallback: any Scout label defaults to news
  for (const lid of labelIds) {
    if (/scout/i.test(labelNameMap[lid] || '')) return 'news';
  }
  return 'news';
}

async function fetchGmailMessages(src, log = () => {}) {
  const token = await getGmailAccessToken();
  if (!token) {
    log('  ⚠ Gmail not configured — skipping (set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN)');
    return { ok: false, err: 'Gmail credentials not configured', messages: [], unconfigured: true };
  }

  const profile = src.source_profile || {};
  const maxResults = profile.max_messages || 20;
  const days = profile.gmail_days || 7;

  // Step 1: Build query dynamically from actual Gmail labels
  const query = await buildGmailQuery(token, days, log);

  // Build label-name map for classification
  let labelNameMap = {};
  try {
    const lr = await fetch(`${GMAIL_API_BASE}/labels`, { headers: { Authorization: `Bearer ${token}` } });
    if (lr.ok) {
      const ld = await lr.json();
      for (const l of (ld.labels || [])) labelNameMap[l.id] = l.name;
    }
  } catch {}

  try {
    // Step 2: List matching message IDs
    const listUrl = `${GMAIL_API_BASE}/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`;
    const listResp = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!listResp.ok) {
      log(`  ✗ Gmail API list error: HTTP ${listResp.status}`);
      return { ok: false, err: `HTTP ${listResp.status}`, messages: [] };
    }
    const listData = await listResp.json();
    const messageIds = (listData.messages || []).map(m => m.id);

    if (messageIds.length === 0) {
      log(`  ✓ Gmail: 0 messages matching query "${query}"`);
      return { ok: true, messages: [], totalResults: 0 };
    }
    log(`  Gmail: ${messageIds.length} message IDs found (query: "${query.slice(0, 80)}")`);

    // Step 3: Fetch each message with format=full to get the entire body
    const messages = [];
    for (const msgId of messageIds.slice(0, maxResults)) {
      try {
        const msgUrl = `${GMAIL_API_BASE}/messages/${msgId}?format=full`;
        const msgResp = await fetch(msgUrl, { headers: { Authorization: `Bearer ${token}` } });
        if (!msgResp.ok) { log(`    ✗ Message ${msgId}: HTTP ${msgResp.status}`); continue; }
        const msg = await msgResp.json();

        const headers = msg.payload?.headers || [];
        const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
        const labelIds = msg.labelIds || [];

        // Parse MIME structure → get text/plain, text/html, and attachments
        const mime = parseMimeParts(msg.payload);
        const bodyText = mime.textPlain || htmlToText(mime.textHtml) || msg.snippet || '';
        const bodyHtml = mime.textHtml || '';

        // Classify via label name map
        const scoutLabel = classifyScoutLabel(labelIds, labelNameMap);

        // Extract links from full body (HTML preferred, fall back to plain text)
        const allLinks = bodyHtml
          ? extractLinksFromHtml(bodyHtml)
          : (bodyText.match(/https?:\/\/[^\s<>"')\]]+/g) || []).map(u => u.replace(/[.,;:!?)]+$/, ''));
        const followableLinks = allLinks.filter(isFollowableGmailLink);

        // Step 4: Follow linked URLs (HTML pages + PDFs)
        const linkedContent = [];
        for (const linkUrl of followableLinks.slice(0, GMAIL_MAX_LINK_FOLLOWS)) {
          try {
            const isPdf = /\.pdf(\?|$)/i.test(linkUrl) || /filestream|documentid/i.test(linkUrl);
            if (isPdf) {
              log(`    📄 Following PDF link: ${linkUrl.slice(0, 80)}...`);
              const pdfResult = await fetchPdfContent(linkUrl);
              if (pdfResult.ok) {
                log(`      ✓ PDF: ${pdfResult.pageCount} pages, ${pdfResult.content.length} chars`);
                linkedContent.push({ url: linkUrl, type: 'pdf', title: pdfResult.title, content: pdfResult.content.slice(0, 15000), pageCount: pdfResult.pageCount });
              } else {
                log(`      ✗ PDF: ${pdfResult.err}`);
              }
            } else {
              log(`    🔗 Following HTML link: ${linkUrl.slice(0, 80)}...`);
              const htmlResult = await fetchUrl(linkUrl, GMAIL_LINK_FETCH_TIMEOUT);
              if (htmlResult.ok && htmlResult.content && htmlResult.content.length > 100) {
                log(`      ✓ HTML: ${htmlResult.length} chars — "${(htmlResult.title||'').slice(0,50)}"`);
                linkedContent.push({ url: linkUrl, type: 'html', title: htmlResult.title, content: htmlResult.content.slice(0, 15000) });
              } else {
                log(`      ✗ HTML: ${htmlResult.err || 'too short'}`);
              }
            }
          } catch (e) { log(`      ✗ Link error: ${e.message}`); }
        }

        // Step 5: Fetch PDF attachments
        const attachmentContent = [];
        for (const att of mime.attachments) {
          if (!/pdf/i.test(att.mimeType)) { log(`    📎 Skipping non-PDF attachment: ${att.filename} (${att.mimeType})`); continue; }
          if (att.size > 5 * 1024 * 1024) { log(`    📎 Skipping large PDF: ${att.filename} (${Math.round(att.size/1024)}KB)`); continue; }
          try {
            log(`    📎 Fetching PDF attachment: ${att.filename}`);
            const attUrl = `${GMAIL_API_BASE}/messages/${msgId}/attachments/${att.attachmentId}`;
            const attResp = await fetch(attUrl, { headers: { Authorization: `Bearer ${token}` } });
            if (!attResp.ok) { log(`      ✗ Attachment fetch: HTTP ${attResp.status}`); continue; }
            const attData = await attResp.json();
            const attBytes = Buffer.from((attData.data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');

            const unpdf = await getUnpdf();
            if (!unpdf) { log('      ✗ unpdf not available'); continue; }
            const pdf = await unpdf.getDocumentProxy(new Uint8Array(attBytes));
            const { totalPages, text } = await unpdf.extractText(pdf, { mergePages: true });
            const cleanText = (typeof text === 'string' ? text : '').replace(/\s+/g, ' ').trim();
            if (cleanText.length > 200) {
              log(`      ✓ PDF attachment: ${totalPages} pages, ${cleanText.length} chars`);
              attachmentContent.push({ filename: att.filename, type: 'pdf', content: cleanText.slice(0, 15000), pageCount: totalPages });
            } else {
              log(`      ⚠ PDF attachment text too short (${cleanText.length} chars) — likely scanned`);
            }
          } catch (e) { log(`      ✗ Attachment parse error: ${e.message}`); }
        }

        const subject = getHeader('Subject');
        log(`    ✉ "${subject.slice(0,70)}" [${scoutLabel}] body=${bodyText.length}ch links=${followableLinks.length} linked=${linkedContent.length} att=${attachmentContent.length}`);

        messages.push({
          id: msg.id,
          threadId: msg.threadId,
          subject,
          from: getHeader('From'),
          date: getHeader('Date'),
          snippet: msg.snippet || '',
          bodyText: bodyText.slice(0, 20000),
          bodyHtml,
          links: followableLinks,
          linkedContent,
          attachmentContent,
          scoutLabel,
          labelIds,
          internalDate: msg.internalDate,
        });
      } catch (e) { log(`    ✗ Message error: ${e.message}`); }
    }

    log(`  ✓ Gmail: ${messages.length} messages fully processed`);
    return { ok: true, messages, totalResults: listData.resultSizeEstimate || messages.length };
  } catch (err) {
    log(`  ✗ Gmail API error: ${err.message}`);
    return { ok: false, err: err.message, messages: [] };
  }
}

function extractLeadFromEmail(email, src) {
  const subject = (email.subject || '').trim();
  if (!subject || subject.length < 5) return null;

  // Use subject as title, but relax validation for email subjects (they're usually meaningful)
  let title = cleanTitle(subject);
  if (!title || title.length < 8) title = subject.slice(0, 200);
  if (!title || title.length < 5) return null;

  // Build the richest possible combined text from body + linked content + attachments
  const bodyText = email.bodyText || email.snippet || '';
  const linkedTexts = (email.linkedContent || []).map(lc => lc.content || '').join('\n\n');
  const attachTexts = (email.attachmentContent || []).map(ac => ac.content || '').join('\n\n');
  const fullText = `${subject}\n\n${bodyText}\n\n${linkedTexts}\n\n${attachTexts}`.slice(0, 40000);
  const combinedText = `${subject} ${bodyText.slice(0, 2000)}`;

  // Classification based on Gmail label + content analysis
  const isRFP = email.scoutLabel === 'rfp' ||
    /\b(rfq|rfp|invitation\s+to\s+bid|request\s+for\s+(qualifications?|proposals?)|solicitation|bid\s+opportunity)\b/i.test(combinedText);
  const isProject = email.scoutLabel === 'projects' ||
    /\b(tedd|urd|urban\s+renewal|redevelopment|development\s+(project|plan|update)|capital\s+improvement|bond|master\s+plan|mra\s+board|funding\s+reservation|design\s+and\s+engineering)\b/i.test(combinedText);

  const dashboardLane = isRFP ? 'active_leads' : isProject ? 'development_potentials' : 'news';
  const leadClass = isRFP ? 'active_solicitation' : 'watch_signal';
  const status = isRFP ? 'active' : 'watch';

  // Extract due date from full text
  const dueDateMatch = combinedText.match(/(?:due|deadline|submit|received)\s+(?:by|before|no later than|until)\s+([A-Z][a-z]+\.?\s+\d{1,2},?\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  const actionDueDate = dueDateMatch ? dueDateMatch[1] : '';

  const fromName = (email.from || '').replace(/<[^>]+>/, '').trim() || email.from || 'Email';

  // Market sector from combined text
  const lo = combinedText.toLowerCase();
  let marketSector = 'Other';
  if (/\b(school|elementary|k-12|mcps)\b/.test(lo)) marketSector = 'K-12';
  else if (/\b(university|college|campus)\b/.test(lo)) marketSector = 'Higher Education';
  else if (/\b(hospital|clinic|medical)\b/.test(lo)) marketSector = 'Healthcare';
  else if (/\b(fire station|police|public safety)\b/.test(lo)) marketSector = 'Public Safety';
  else if (/\b(courthouse|city hall|civic|municipal|city\s+council)\b/.test(lo)) marketSector = 'Civic';
  else if (/\b(tedd|urd|redevelopment|mixed.?use|development\s+district)\b/.test(lo)) marketSector = 'Mixed Use';
  else if (/\b(housing|affordable|residential|apartment|rental\s+unit)\b/.test(lo)) marketSector = 'Housing';
  else if (/\b(construction|renovation|building|facility|project|infrastructure|water\s+main)\b/.test(lo)) marketSector = 'Civic';

  // Extract budget signals from full text
  const budgetMatch = fullText.match(/\$[\d,]+(?:\.\d{1,2})?(?:\s*(?:million|m|k))?\b/i);
  const potentialBudget = budgetMatch ? budgetMatch[0] : '';

  const emailDate = email.internalDate
    ? new Date(parseInt(email.internalDate)).toISOString().split('T')[0]
    : new Date().toISOString().split('T')[0];

  // Build rich description from body (not just snippet)
  const descriptionBody = bodyText.slice(0, 800).trim();
  const linkedSummary = (email.linkedContent || []).slice(0, 2).map(lc =>
    `[Linked ${lc.type.toUpperCase()}: ${(lc.title || lc.url || '').slice(0, 60)}] ${(lc.content || '').slice(0, 300)}`
  ).join('\n');
  const attachSummary = (email.attachmentContent || []).slice(0, 2).map(ac =>
    `[Attachment: ${ac.filename}] ${(ac.content || '').slice(0, 300)}`
  ).join('\n');
  const fullDescription = [descriptionBody, linkedSummary, attachSummary].filter(Boolean).join('\n\n').slice(0, 2000);

  // Relevance scoring: emails with body content + linked docs get higher scores
  let relevanceScore = isRFP ? 60 : 35;
  if (bodyText.length > 500) relevanceScore += 10;  // rich body content
  if ((email.linkedContent || []).length > 0) relevanceScore += 10;  // followed links
  if ((email.attachmentContent || []).length > 0) relevanceScore += 5;  // parsed attachments
  if (budgetMatch) relevanceScore += 5;  // has budget signal
  relevanceScore = Math.min(relevanceScore, 85);

  const id = `lead-gmail-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const now = new Date().toISOString();

  const evidenceLinks = (email.links || []).slice(0, 5);
  const evidenceEntries = [
    {
      id: `ev-${id}`,
      leadId: id,
      sourceId: src.id || src.source_id || '',
      sourceName: fromName,
      url: evidenceLinks[0] || '',
      title: `Email: ${title}`,
      summary: `${email.scoutLabel} email from ${fromName}, ${emailDate}. ${descriptionBody.slice(0, 300)}`,
      signalDate: emailDate,
      dateFound: now,
      signalStrength: relevanceScore >= 55 ? 'strong' : 'medium',
      keywords: [],
    },
  ];
  // Add evidence entries for followed links
  for (const lc of (email.linkedContent || []).slice(0, 3)) {
    evidenceEntries.push({
      id: `ev-${id}-link-${evidenceEntries.length}`,
      leadId: id,
      sourceId: src.id || src.source_id || '',
      sourceName: lc.title || lc.url,
      url: lc.url,
      title: lc.title || `Linked ${lc.type.toUpperCase()}`,
      summary: (lc.content || '').slice(0, 400),
      signalDate: emailDate,
      dateFound: now,
      signalStrength: 'medium',
      keywords: [],
    });
  }
  // Add evidence for attachments
  for (const ac of (email.attachmentContent || []).slice(0, 2)) {
    evidenceEntries.push({
      id: `ev-${id}-att-${evidenceEntries.length}`,
      leadId: id,
      sourceId: src.id || src.source_id || '',
      sourceName: ac.filename,
      url: '',
      title: `PDF Attachment: ${ac.filename}`,
      summary: (ac.content || '').slice(0, 400),
      signalDate: emailDate,
      dateFound: now,
      signalStrength: 'medium',
      keywords: [],
    });
  }

  return {
    id,
    title,
    owner: fromName,
    projectName: title,
    location: 'Missoula, MT',
    county: 'Missoula',
    marketSector,
    projectType: isRFP ? 'RFQ/RFP' : 'Other',
    description: `${fullDescription} — Source: Email (${fromName})`,
    whyItMatters: isRFP
      ? `Procurement notice received via email from ${fromName}. Review scope and deadline.`
      : `Development update received via email from ${fromName}. ${potentialBudget ? `Budget signal: ${potentialBudget}. ` : ''}Monitor for project opportunities.`,
    aiReasonForAddition: `Email intake (${email.scoutLabel}) from ${fromName}, received ${emailDate}. Body: ${bodyText.length} chars. Linked docs: ${(email.linkedContent||[]).length}. Attachments: ${(email.attachmentContent||[]).length}.`,
    potentialTimeline: '',
    potentialBudget,
    action_due_date: actionDueDate,
    relevanceScore,
    pursuitScore: isRFP ? 40 : 15,
    sourceConfidenceScore: 75,
    confidenceNotes: `Email from ${fromName}. Label: Scout/${email.scoutLabel}. Received ${emailDate}. Body ${bodyText.length} chars. ${(email.linkedContent||[]).length} linked doc(s). ${(email.attachmentContent||[]).length} attachment(s).`,
    dateDiscovered: now,
    originalSignalDate: emailDate,
    lastCheckedDate: now,
    status,
    leadClass,
    leadOrigin: 'gmail_intake',
    dashboard_lane: dashboardLane,
    watchCategory: isRFP ? 'named_project' : isProject ? 'development_program' : 'named_project',
    projectStatus: isRFP ? 'active_solicitation' : 'future_watch',
    extractionPath: 'gmail_api_full',
    gmailMessageId: email.id,
    emailFrom: email.from,
    emailDate,
    sourceName: src.name || src.source_name || 'Gmail Intake',
    sourceUrl: '',
    sourceId: src.id || src.source_id || '',
    evidenceLinks,
    evidenceSourceLinks: [
      { url: '', label: `Email from ${fromName}`, linkType: 'email' },
      ...(email.linkedContent || []).slice(0, 3).map(lc => ({ url: lc.url, label: lc.title || lc.url, linkType: lc.type })),
    ],
    evidenceSummary: `Email intake (${email.scoutLabel}): ${title}. From ${fromName}, received ${emailDate}. ${fullDescription.slice(0, 500)}`,
    matchedFocusPoints: [],
    matchedKeywords: [],
    matchedTargetOrgs: [],
    taxonomyMatches: [],
    internalContact: '',
    notes: '',
    evidence: evidenceEntries,
  };
}

// ── v4-b25: Multi-highlight extraction from emails ─────────────
// Splits a rich email (or web article) into multiple project-focused highlights.
// Each highlight has: normalized title, brief summary, project potential, why it matters, what to watch.

// Known project-signal patterns for splitting multi-topic content
const HIGHLIGHT_SPLIT_PATTERNS = [
  // Named projects / locations
  /(?:^|\n)\s*(?:#{1,3}\s*)?(?:\d+[\.\)]\s*)?([A-Z][A-Za-z0-9\s\/\-']+(?:Crossing|Triangle|District|Avenue|Street|Creek|Park|Building|Center|Campus|Station|Bridge|Main|Corridor|Block|Heights|Place|Square|Village|Landing|Terrace|Meadows|Ranch|Trail|Complex|Hub|Mill|Point|Reservoir|Plant|Facility))\b/g,
  // "Request for/to" patterns (board actions)
  /(?:request\s+(?:for|to)\s+(?:approve|fund|authorize|solicit|extend|modify|amend|designate)\s+)([^.;]{15,120})/gi,
  // Dollar amounts attached to named items
  /(\$[\d,.]+\s*(?:million|M|k)?\s+(?:for|to|toward|requested|allocated|approved|budgeted)\s+[^.;]{10,100})/gi,
  // "Action Item:" or "Resolution:" style
  /(?:action\s*item|resolution|motion|ordinance|approval|authorization)\s*(?:\d+)?[:\-]\s*([^.;\n]{15,150})/gi,
];

// Signal phrases that indicate project potential level
const HIGH_POTENTIAL_SIGNALS = /\b(rfq|rfp|solicitation|bid|procurement|design\s+contract|engineering\s+services|construction\s+(?:contract|funding|bid)|consultant\s+selection|awarded|design.build|pre.?design|schematic\s+design|groundbreaking)\b/i;
const MEDIUM_POTENTIAL_SIGNALS = /\b(funding\s+(?:reservation|request|application|approved)|bond|levy|capital\s+(?:improvement|budget|project)|master\s+plan|feasibility|site\s+(?:selection|plan)|development\s+(?:agreement|review)|rezoning|annexation|conditional\s+use|subdivision|infrastructure|water\s+main|sewer|utility)\b/i;

// Map signal types to "why it matters" and "what to watch" suggestions
function inferWhyAndWatch(text) {
  const lo = (text || '').toLowerCase();
  let whyItMatters = '';
  let whatToWatch = '';
  if (/\b(rfq|rfp|solicitation|bid\s+opportunity|invitation\s+to\s+bid)\b/.test(lo)) {
    whyItMatters = 'Active procurement signal — potential A&E opportunity';
    whatToWatch = 'RFP/RFQ release, submission deadline, scope details';
  } else if (/\bfunding\s+(reservation|request|approved|application)\b/.test(lo)) {
    whyItMatters = 'Funding milestone advancing project toward design/construction';
    whatToWatch = 'Funding approval, design contract, scope definition';
  } else if (/\bdesign\s+and\s+engineering\b|\bengineering\s+services\b|\bconsultant\s+selection\b/.test(lo)) {
    whyItMatters = 'Design and engineering services authorized — near-term A&E opportunity';
    whatToWatch = 'Scope/design contract, RFP/RFQ release, consultant shortlist';
  } else if (/\b(bond|levy|capital\s+improvement)\b/.test(lo)) {
    whyItMatters = 'Capital funding mechanism progressing — future project pipeline';
    whatToWatch = 'Bond/levy vote, CIP prioritization, project list release';
  } else if (/\b(rezoning|annexation|subdivision|conditional\s+use|land\s+use)\b/.test(lo)) {
    whyItMatters = 'Planning or land use milestone — development likely to follow';
    whatToWatch = 'Development review, site plan approval, building permit';
  } else if (/\b(redevelopment|urban\s+renewal|tedd|urd|mra)\b/.test(lo)) {
    whyItMatters = 'Redevelopment program activity — public infrastructure and development';
    whatToWatch = 'City Council approval, development agreements, infrastructure scope';
  } else if (/\b(infrastructure|water\s+main|sewer|utility|street|bridge|road)\b/.test(lo)) {
    whyItMatters = 'Infrastructure scope tied to future development';
    whatToWatch = 'Engineering scope definition, design contract, construction funding';
  } else if (/\b(housing|affordable|residential|mixed.?use|rental)\b/.test(lo)) {
    whyItMatters = 'Housing/mixed-use development advancing';
    whatToWatch = 'Development review, funding applications, design contract';
  } else if (/\b(approved|authorized|passed|adopted|granted|awarded)\b/.test(lo)) {
    whyItMatters = 'Board/council action advancing project';
    whatToWatch = 'Next implementation steps, scope definition, procurement timeline';
  } else {
    whyItMatters = 'Development or project intelligence signal';
    whatToWatch = 'Monitor for procurement or design opportunity';
  }
  return { whyItMatters, whatToWatch };
}

function scoreProjectPotential(text) {
  if (HIGH_POTENTIAL_SIGNALS.test(text)) return 'high';
  if (MEDIUM_POTENTIAL_SIGNALS.test(text)) return 'medium';
  return 'low';
}

/**
 * v4-b33: Extract structured evidence facts from lead content.
 * Returns an array of { type, value, confidence, sourceUrl, sourceLabel, sourceType, excerpt }.
 * Conservative: only extracts facts clearly supported by text. Honest blanks preferred over false certainty.
 */
function extractEvidenceFacts(lead) {
  const facts = [];
  const title = lead.title || '';
  const desc = lead.description || '';
  const summary = lead.highlightSummary || lead.evidenceSummary || '';
  const combined = `${title} ${desc} ${summary} ${lead.whyItMatters || ''}`;
  const lo = combined.toLowerCase();

  // Determine primary source artifact for attribution
  const primaryUrl = lead.evidenceLinks?.[0] || lead.sourceUrl || '';
  const primaryLabel = lead.sourceName || 'Source';
  const primaryType = lead.extractionPath === 'gmail_api_highlights' || lead.extractionPath === 'gmail_api_full' ? 'email'
    : /\.pdf/i.test(primaryUrl) ? 'pdf' : lead.leadOrigin === 'public_notice' ? 'public_notice' : 'html';

  const addFact = (type, value, excerpt, confidence = 'extracted') => {
    if (!value) return;
    facts.push({ type, value, confidence, sourceUrl: primaryUrl, sourceLabel: primaryLabel, sourceType: primaryType, excerpt: (excerpt || '').slice(0, 200) });
  };

  // ── Budget / funding ──
  const budgetPatterns = [
    /\$[\d,]+(?:\.\d+)?(?:\s*(?:million|M|billion|B|k))?\s+(?:for|to|toward|requested|allocated|approved|budgeted|reserved|funded)\s+([^.;]{5,80})/i,
    /(?:budget|funding|cost|allocation|reservation)\s+(?:of\s+)?\$[\d,]+(?:\.\d+)?(?:\s*(?:million|M|k))?/i,
  ];
  if (lead.potentialBudget) {
    const excerpt = combined.match(new RegExp(lead.potentialBudget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^.;]{0,80}', 'i'));
    addFact('budget', lead.potentialBudget, excerpt ? excerpt[0] : '', 'source_verified');
  } else {
    for (const pat of budgetPatterns) {
      const m = combined.match(pat);
      if (m) { addFact('budget', m[0].slice(0, 80).trim(), m[0], 'extracted'); break; }
    }
  }

  // ── Scope ──
  const scopeMatch = combined.match(/\b(\d[\d,]*\s*(?:unit|bed|room|seat|square\s*f(?:oo|ee)t|sf|gsf|acre|lot|parcel|stor(?:y|ies)|phase|building|structure|site)s?)\b/i);
  if (scopeMatch) {
    const ctx = combined.slice(Math.max(0, combined.indexOf(scopeMatch[0]) - 30), combined.indexOf(scopeMatch[0]) + scopeMatch[0].length + 50);
    addFact('scope', scopeMatch[0].trim(), ctx.trim());
  }

  // ── Due date / timing ──
  if (lead.action_due_date) addFact('due_date', lead.action_due_date, '', 'source_verified');
  const timeMatch = combined.match(/\b(Q[1-4]\s*20\d{2}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*20\d{2}|(?:spring|summer|fall|winter)\s+20\d{2}|FY\s*20\d{2,4})\b/i);
  if (timeMatch && !lead.action_due_date) {
    const ctx = combined.slice(Math.max(0, combined.indexOf(timeMatch[0]) - 40), combined.indexOf(timeMatch[0]) + timeMatch[0].length + 60);
    addFact('timing', timeMatch[0], ctx.trim());
  }

  // ── Approval / authorization status ──
  const statusPatterns = [
    { pat: /\b(approved|authorized|adopted|passed|granted)\b.*?\b(by\s+(?:city\s+council|board|commission|mra|county|voters?|governing body))\b/i, conf: 'source_verified' },
    { pat: /\b(awarded|selected|contracted)\b.*?\b(to|for)\s+([A-Z][\w\s&]+)/i, conf: 'source_verified' },
    { pat: /\b(funded|funded at|funding approved|funding authorized|bond\s+(?:passed|approved))\b/i, conf: 'source_verified' },
  ];
  for (const { pat, conf } of statusPatterns) {
    const m = combined.match(pat);
    if (m) { addFact('status', m[0].slice(0, 100).trim(), m[0], conf); break; }
  }

  // ── Design / engineering ──
  const aeMatch = combined.match(/\b(design\s+(?:and\s+)?engineering|architectural services|a\/e\s+services|consultant selection|design services|pre-?design|schematic design|design development)\b[^.;]{0,60}/i);
  if (aeMatch) addFact('ae_signal', aeMatch[0].trim(), aeMatch[0]);

  // ── Procurement ──
  const procMatch = combined.match(/\b(rfq|rfp|solicitation|invitation to bid|request for (?:proposal|qualification|quote))\b[^.;]{0,80}/i);
  if (procMatch) addFact('procurement', procMatch[0].trim(), procMatch[0]);

  // ── Owner / partners ──
  const ownerPatterns = [
    /\b(City of Missoula|Missoula County|Missoula Redevelopment Agency|MRA|Missoula Housing Authority|MCPS|Airport Authority|University of Montana|Mountain Line|MEP|MDA)\b/i,
    /\b(developer|owner|partner|applicant|client)\s*:\s*([A-Z][\w\s&',]+)/i,
  ];
  for (const pat of ownerPatterns) {
    const m = combined.match(pat);
    if (m) { addFact('owner', (m[2] || m[1] || m[0]).trim(), m[0], 'extracted'); break; }
  }

  // ── Project stage ──
  const stageMap = [
    { pat: /\b(under construction|construction underway|groundbreaking|site work begun)\b/i, stage: 'Construction' },
    { pat: /\b(awarded|contract awarded|designer selected|architect selected)\b/i, stage: 'Awarded' },
    { pat: /\b(rfq|rfp|solicitation|invitation to bid)\b/i, stage: 'Procurement' },
    { pat: /\b(schematic design|design development|construction documents|pre-?design)\b/i, stage: 'Design' },
    { pat: /\b(feasibility|master plan|programming|condition assessment)\b/i, stage: 'Planning' },
    { pat: /\b(bond|levy|funding\s+(approved|request|reservation)|capital\s+(budget|improvement))\b/i, stage: 'Funding' },
    { pat: /\b(rezoning|annexation|subdivision|conditional use|development review)\b/i, stage: 'Entitlements' },
  ];
  for (const { pat, stage } of stageMap) {
    const m = combined.match(pat);
    if (m) {
      const ctx = combined.slice(Math.max(0, combined.indexOf(m[0]) - 30), combined.indexOf(m[0]) + m[0].length + 50);
      addFact('stage', stage, ctx.trim());
      break;
    }
  }

  // ── Location ──
  if (lead.location && lead.location !== 'Missoula, MT' && lead.location.length > 5) {
    addFact('location', lead.location, '', 'lead_field');
  }
  const addrMatch = combined.match(/\b(\d{2,5}\s+(?:North|South|East|West|N|S|E|W\.?)?\s*[A-Z][\w\s]{3,30}(?:Avenue|Street|Road|Drive|Boulevard|Way|Lane|Court|Place|Circle|Highway|Blvd|Ave|St|Rd|Dr|Ln|Ct|Pl|Hwy))\b/i);
  if (addrMatch) addFact('address', addrMatch[0].trim(), addrMatch[0]);

  return facts;
}

// Generate a brief 2-4 sentence highlight summary
function generateHighlightSummary(title, bodyChunk, budget) {
  const sentences = bodyChunk
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .filter(s => s.length > 20 && s.length < 300)
    .filter(s => !/^(click|view|read|subscribe|unsubscribe|forward|share|follow|visit|learn more)/i.test(s.trim()));

  // Pick the most informative sentences (those mentioning the title words or key signals)
  const titleWords = title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const scored = sentences.map(s => {
    const lo = s.toLowerCase();
    let score = 0;
    for (const w of titleWords) if (lo.includes(w)) score += 2;
    if (/\$[\d,]+/.test(s)) score += 3;
    if (/\b(approved|authorized|funded|awarded|requested|proposed|planned|design|construct|renovate|build)\b/i.test(s)) score += 2;
    if (/\b(rfp|rfq|solicitation|bid|contract|procurement)\b/i.test(s)) score += 3;
    return { s, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored.slice(0, 3).map(x => x.s.trim());

  let summary = best.join(' ').slice(0, 400);
  if (budget && !summary.includes(budget)) summary += ` Budget signal: ${budget}.`;
  return summary || `${title} — project intelligence from Missoula County sources.`;
}

// Normalize a title: prefer project/location name over generic newsletter subject
function normalizeHighlightTitle(rawTitle, bodyChunk) {
  // If the raw title is already a specific project name (< 80 chars, not a generic pattern), keep it
  if (rawTitle.length < 80 && !/\b(quick take|action summary|newsletter|edition|update|digest|bulletin|weekly|monthly|daily|roundup|recap)\b/i.test(rawTitle)) {
    return rawTitle;
  }

  // Try to extract a project name from the body chunk
  const lo = bodyChunk.toLowerCase();
  // Named crossing / district / facility / building patterns
  const namedMatch = bodyChunk.match(/\b([A-Z][A-Za-z0-9\s\/\-']{5,60}(?:Crossing|Triangle|District|Avenue|Street|Creek|Park|Building|Center|Campus|Station|Bridge|Corridor|Block|Heights|Place|Village|Landing|Complex|Hub|Mill|Point|Facility|Plant|Main))\b/);
  if (namedMatch) return namedMatch[1].trim();

  // "Franklin Crossing / 1919 North Avenue West" style
  const slashName = bodyChunk.match(/\b([A-Z][A-Za-z]+\s+(?:Crossing|Park|Center|Village|Heights|Landing|Station|Bridge|Place|Block|Hub)\s*\/\s*[^.;\n]{5,60})/);
  if (slashName) return slashName[1].trim();

  // Fall back to cleaned raw title
  return rawTitle.replace(/^(the\s+)?quick\s+take:\s*/i, '').replace(/\s*edition\s*.*$/i, '').replace(/\s+for\s+\d{1,2}\/\d{1,2}\/\d{2,4}$/i, '').trim() || rawTitle;
}

/**
 * Extract multiple project highlights from a single email.
 * Returns an array of highlight-lead objects (can be 1 or more).
 * Each has enriched fields: highlightSummary, projectPotential, whyItMatters, whatToWatch.
 */
// v4-b31: Sender-based and subject-based Gmail suppression
// Emails from these senders or with these subject patterns are almost never A&E-relevant.
function isGmailSuppressed(email) {
  const from = (email.from || '').toLowerCase();
  const subj = (email.subject || '').toLowerCase();
  const body = (email.bodyText || email.snippet || '').toLowerCase().slice(0, 500);
  // Sender suppression: general newsletters, advocacy, media digests, non-project senders
  if (/\b(thepulp|mountainjournal|substack|mailchimp|constantcontact|actionnetwork|everyaction|change\.org|moveon|indivisible|petitions?|gofundme|kickstarter|patreon)\b/.test(from)) return 'newsletter_sender';
  // Subject suppression: roundups, most-read, opinion/editorial, generic digests
  if (/\b(most read|top stories|weekly roundup|daily digest|morning brief|evening brief|what you missed|in case you missed|icymi|breaking news|opinion|editorial|letter to the editor|year in review|best of \d{4}|holiday|weekend events?|things to do|restaurant|dining|recipe|film|movie|concert|festival|gallery|exhibit|obituar|memorial|tribute)\b/.test(subj)) return 'generic_subject';
  // Content suppression: no A&E signal in body
  const hasSignal = /\b(construction|renovation|design|building|facility|development|redevelopment|housing|infrastructure|capital|bond|rfp|rfq|solicitation|procurement|bid|project|master plan|feasibility|engineering|architect|permit|rezoning|annexation|subdivision|school|hospital|campus|airport|fire station|library|courthouse)\b/.test(body);
  if (!hasSignal && body.length > 200) return 'no_ae_signal';
  return null;
}

function extractHighlightsFromEmail(email, src, existingLeads = []) {
  const subject = (email.subject || '').trim();
  if (!subject || subject.length < 5) return [];

  // v4-b31: Early suppression of low-value emails
  const suppressed = isGmailSuppressed(email);
  if (suppressed) return [];

  const bodyText = email.bodyText || email.snippet || '';
  const linkedTexts = (email.linkedContent || []).map(lc => lc.content || '').join('\n\n');
  const attachTexts = (email.attachmentContent || []).map(ac => ac.content || '').join('\n\n');
  const fullText = `${bodyText}\n\n${linkedTexts}\n\n${attachTexts}`;
  const combinedShort = `${subject} ${bodyText.slice(0, 3000)}`;

  const fromName = (email.from || '').replace(/<[^>]+>/, '').trim() || 'Email';
  const emailDate = email.internalDate
    ? new Date(parseInt(email.internalDate)).toISOString().split('T')[0]
    : new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();

  // Detect if this is a multi-topic newsletter/digest (vs a single-topic email)
  const isNewsletter = /\b(quick take|action summary|newsletter|digest|bulletin|roundup|recap|board meeting edition)\b/i.test(subject);

  // Step 1: Try to split into multiple highlight chunks
  const chunks = [];
  if (isNewsletter && fullText.length > 300) {
    // Split by section headers, numbered items, horizontal rules, or major topic breaks
    const sections = fullText.split(/(?:\n\s*(?:#{1,3}\s+|(?:\d+[\.\)]\s+)|(?:—{3,}|-{3,}|={3,}|_{3,})\s*\n|\n\s*\n\s*(?=[A-Z][A-Za-z\s\/]{10,60}(?:\n|:))))/);
    for (const sec of sections) {
      const trimmed = sec.trim();
      if (trimmed.length < 80) continue; // too short to be meaningful
      // Check if this section has project-relevant content
      if (/\b(project|construction|design|renovation|building|facility|development|housing|infrastructure|funding|capital|rfp|rfq|solicitation|bond|water main|sewer|street|bridge|park|school|campus|hospital|courthouse|library|fire station|mixed.use|affordable|rezoning|subdivision|permit|master plan)\b/i.test(trimmed)) {
        chunks.push(trimmed);
      }
    }
  }

  // If no meaningful chunks found from splitting, treat entire email as one chunk
  if (chunks.length === 0) {
    chunks.push(fullText.slice(0, 10000));
  }

  // Step 2: Generate a highlight lead for each chunk
  const highlights = [];
  for (const chunk of chunks.slice(0, 5)) { // Cap at 5 highlights per email
    const chunkLo = chunk.toLowerCase();

    // Skip chunks that are purely boilerplate
    if (/^(click|view|read more|subscribe|unsubscribe|forward|share|follow us|visit our|copyright|disclaimer)/i.test(chunk.trim())) continue;
    if (chunk.trim().length < 100) continue;

    // Classification
    const isRFP = email.scoutLabel === 'rfp' ||
      /\b(rfq|rfp|invitation\s+to\s+bid|request\s+for\s+(qualifications?|proposals?)|solicitation|bid\s+opportunity)\b/i.test(chunkLo);
    const isProject = email.scoutLabel === 'projects' ||
      /\b(tedd|urd|urban\s+renewal|redevelopment|development\s+(project|plan|update)|capital\s+improvement|bond|master\s+plan|mra\s+board|funding\s+reservation|design\s+and\s+engineering|water\s+main|infrastructure)\b/i.test(chunkLo);

    const dashboardLane = isRFP ? 'active_leads' : isProject ? 'development_potentials' : 'news';
    const leadClass = isRFP ? 'active_solicitation' : 'watch_signal';
    const status = isRFP ? 'active' : 'watch';

    // Title: normalize from chunk content, not email subject
    const rawTitle = (chunks.length > 1) ? normalizeHighlightTitle(subject, chunk) : normalizeHighlightTitle(subject, fullText);
    let title = rawTitle;
    if (!title || title.length < 5) title = cleanTitle(subject) || subject.slice(0, 120);

    // Budget
    const budgetMatch = chunk.match(/\$[\d,]+(?:\.\d{1,2})?(?:\s*(?:million|M|k))?\b/i);
    const potentialBudget = budgetMatch ? budgetMatch[0] : '';

    // Highlight fields
    const projectPotential = scoreProjectPotential(chunk);
    const { whyItMatters, whatToWatch } = inferWhyAndWatch(chunk);
    const highlightSummary = generateHighlightSummary(title, chunk, potentialBudget);

    // Market sector
    let marketSector = 'Other';
    if (/\b(school|k-12|mcps)\b/i.test(chunkLo)) marketSector = 'K-12';
    else if (/\b(university|college|campus)\b/i.test(chunkLo)) marketSector = 'Higher Education';
    else if (/\b(hospital|clinic|medical)\b/i.test(chunkLo)) marketSector = 'Healthcare';
    else if (/\b(courthouse|city hall|civic|municipal|council)\b/i.test(chunkLo)) marketSector = 'Civic';
    else if (/\b(tedd|urd|redevelopment|mixed.?use)\b/i.test(chunkLo)) marketSector = 'Mixed Use';
    else if (/\b(housing|affordable|residential|apartment|rental)\b/i.test(chunkLo)) marketSector = 'Housing';
    else if (/\b(infrastructure|water|sewer|utility|street|bridge)\b/i.test(chunkLo)) marketSector = 'Civic';
    else if (/\b(construction|renovation|building|facility|project)\b/i.test(chunkLo)) marketSector = 'Civic';

    // Relevance scoring
    let relevanceScore = isRFP ? 60 : (isProject ? 45 : 35);
    if (bodyText.length > 500) relevanceScore += 5;
    if ((email.linkedContent || []).length > 0) relevanceScore += 8;
    if ((email.attachmentContent || []).length > 0) relevanceScore += 5;
    if (budgetMatch) relevanceScore += 5;
    if (projectPotential === 'high') relevanceScore += 10;
    else if (projectPotential === 'medium') relevanceScore += 5;
    relevanceScore = Math.min(relevanceScore, 90);

    // Enrich-existing check: see if this highlight matches an existing lead
    let enrichTarget = null;
    const titleLo = title.toLowerCase().trim();
    for (const ex of existingLeads) {
      const exTitleLo = (ex.title || '').toLowerCase().trim();
      if (titleSimilarity(title, ex.title) >= 0.55 || titleLo.includes(exTitleLo) || exTitleLo.includes(titleLo)) {
        enrichTarget = ex;
        break;
      }
    }

    const id = `lead-gmail-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const evidenceLinks = (email.links || []).slice(0, 5);
    const evidenceEntries = [{
      id: `ev-${id}`,
      leadId: id,
      sourceId: src.id || src.source_id || '',
      sourceName: fromName,
      url: evidenceLinks[0] || '',
      title: `Email: ${subject.slice(0, 80)}`,
      summary: highlightSummary.slice(0, 400),
      signalDate: emailDate,
      dateFound: now,
      signalStrength: projectPotential === 'high' ? 'strong' : 'medium',
      keywords: [],
    }];
    // Evidence from linked content
    for (const lc of (email.linkedContent || []).slice(0, 2)) {
      evidenceEntries.push({
        id: `ev-${id}-lnk-${evidenceEntries.length}`,
        leadId: id,
        sourceId: src.id || src.source_id || '',
        sourceName: lc.title || lc.url,
        url: lc.url,
        title: lc.title || `Linked ${lc.type}`,
        summary: (lc.content || '').slice(0, 300),
        signalDate: emailDate,
        dateFound: now,
        signalStrength: 'medium',
        keywords: [],
      });
    }

    highlights.push({
      id,
      title,
      owner: fromName,
      projectName: title,
      location: 'Missoula, MT',
      county: 'Missoula',
      marketSector,
      projectType: isRFP ? 'RFQ/RFP' : 'Other',
      description: highlightSummary + (potentialBudget ? ` Budget signal: ${potentialBudget}.` : '') + ` — Source: Email (${fromName})`,
      highlightSummary,
      projectPotential,
      whyItMatters,
      whatToWatch,
      potentialTimeline: '',
      potentialBudget,
      action_due_date: '',
      relevanceScore,
      pursuitScore: isRFP ? 40 : 15,
      sourceConfidenceScore: 75,
      confidenceNotes: `Email from ${fromName}. Label: Scout/${email.scoutLabel}. ${emailDate}. Potential: ${projectPotential}.`,
      dateDiscovered: now,
      originalSignalDate: emailDate,
      lastCheckedDate: now,
      status,
      leadClass,
      leadOrigin: 'gmail_intake',
      dashboard_lane: dashboardLane,
      watchCategory: isRFP ? 'named_project' : isProject ? 'development_program' : 'named_project',
      projectStatus: isRFP ? 'active_solicitation' : 'future_watch',
      extractionPath: 'gmail_api_highlights',
      gmailMessageId: email.id,
      emailFrom: email.from,
      emailDate,
      sourceName: src.name || src.source_name || 'Gmail Intake',
      sourceUrl: '',
      sourceId: src.id || src.source_id || '',
      evidenceLinks,
      evidenceSourceLinks: [
        { url: '', label: `Email from ${fromName}`, linkType: 'email' },
        ...(email.linkedContent || []).slice(0, 2).map(lc => ({ url: lc.url, label: lc.title || lc.url, linkType: lc.type })),
      ],
      evidenceSummary: highlightSummary.slice(0, 500),
      matchedFocusPoints: [],
      matchedKeywords: [],
      matchedTargetOrgs: [],
      taxonomyMatches: [],
      internalContact: '',
      notes: '',
      evidence: evidenceEntries,
      // Enrichment metadata
      _enrichTarget: enrichTarget ? enrichTarget.id : null,
    });
  }

  return highlights;
}

// ── v4-b6: News relevance filter ─────────────────────────────
// News leads must contain actual development/building/project intelligence.
// Generic civic, crime, weather, sports, lifestyle, dining, opinion, and
// retrospective articles are not useful for A&E business development.
function isNewsRelevant(title, context) {
  const lo = (title || '').toLowerCase();
  const ctx = (context || '').toLowerCase().slice(0, 600);
  const combined = lo + ' ' + ctx;

  // Must contain at least one A&E-relevant signal in title or context
  const hasRelevantSignal = /\b(construction|renovation|building|facility|expansion|addition|replacement|project|design|architect|engineer|development|redevelopment|housing|school|hospital|campus|bond|levy|capital|cip|rfq|rfp|solicitation|permit|zoning|rezoning|subdivision|annexation|demolition|infrastructure|treatment plant|fire station|library|courthouse|police station|community center|recreation center|mixed.use|affordable housing|student housing|senior housing|apartment|condo|townhome|commercial|industrial|warehouse|office building|data center|hotel|resort|restoration|rehabilitation|modernization|remodel|upgrade|retrofit|master plan|feasibility|site selection|groundbreaking|foundation|steel|concrete|framing|crane|excavation)\b/.test(combined);

  if (!hasRelevantSignal) return false;

  // Block pure opinion/commentary even if they mention development words
  const isOpinionCommentary = /\b(should\s+(be|have|consider|build|invest)|residents\s+(want|oppose|support|demand|urge)|editorial|opinion|letter\s+to\s+(the\s+)?editor|debate\s+over|controversy|critics?\s+say|opponents?\s+say|supporters?\s+say|rally\s+(against|for|to)|protest|petition)\b/.test(combined);
  if (isOpinionCommentary && !/\b(rfq|rfp|solicitation|bid|groundbreaking|approved|funding|awarded|contract)\b/.test(combined)) return false;

  // Block retrospective/completed articles without forward-looking signals
  const isRetrospective = /\b(was\s+(built|completed|constructed|opened|demolished|renovated)|completed\s+in\s+\d{4}|opened\s+(in|last|this)\s|built\s+in\s+\d{4}|a\s+look\s+back|year\s+in\s+review|looking\s+back|decades?\s+ago)\b/.test(combined);
  if (isRetrospective && !/\b(new\s+phase|phase\s+[2-9]|upcoming|planned|proposed|future|next|seeking|will\s+be|is\s+expected|anticipated|scheduled)\b/.test(combined)) return false;

  return true;
}

// ── v4-b6: Retrospective/historical language filter ──────────
// Titles that describe completed/past events are not forward-looking leads.
function isRetrospectiveTitle(title) {
  const lo = (title || '').toLowerCase();
  // "X Was Built/Completed/Opened/Demolished in YYYY"
  if (/\b(was\s+(built|completed|constructed|opened|demolished|renovated)|completed\s+in\s+\d{4}|opened\s+(in|last)\s|built\s+in\s+\d{4})\b/.test(lo)) {
    return !/\b(new\s+phase|phase\s+[2-9]|upcoming|planned|proposed|expansion|future|next|seeking)\b/.test(lo);
  }
  // "A Look Back at X" / "Year in Review" / "Looking Back"
  if (/\b(a\s+look\s+back|year\s+in\s+review|looking\s+back|years?\s+ago|decade\s+later)\b/.test(lo)) return true;
  // "X Celebrates N Years" / "Anniversary"
  if (/\b(celebrates?\s+\d+\s+years?|anniversary|milestone)\b/.test(lo) &&
      !/\b(renovation|expansion|construction|project|design)\b/.test(lo)) return true;
  return false;
}

// ── v4-b6: Generic news headline filter ──────────────────────
// Catches news-style titles that are too vague or broad to be actionable leads.
function isGenericNewsHeadline(title) {
  const lo = (title || '').toLowerCase();
  // Market trend commentary
  if (/\b(market|industry|sector)\s+(continues?|expected|projected|forecast|trending|slowing|growing|evolving|struggling|booming|recovering)\b/.test(lo)) return true;
  // "Report: X" / "Study: X" etc
  if (/^(report|study|survey|analysis|overview|update|recap|summary|review|roundup|preview|profile|spotlight|feature|opinion|editorial|letter|column|podcast|video|webinar|workshop):/i.test(lo)) return true;
  // Conversational / engagement patterns
  if (/\b(what\s+you\s+need\s+to\s+know|everything\s+you|here.?s\s+what|what\s+to\s+expect|things?\s+to\s+know|in\s+case\s+you\s+missed|icymi)\b/.test(lo)) return true;
  // "How X Is Changing Y" / "Why X Matters"
  if (/^(how|why)\s+.{5,}\s+(is|are|was|were|matters?|affects?|impacts?|changes?|work)\b/i.test(lo) &&
      !/\b(rfq|rfp|solicitation|renovation|construction|design|project|building|facility)\b/.test(lo)) return true;
  // List-style
  if (/^(top\s+\d+|\d+\s+(things?|ways?|reasons?|tips?|facts?|trends?)|best|worst|biggest|most)\s+/i.test(lo) &&
      !/\b(construction|project|renovation|building|facility|development)\b/.test(lo)) return true;
  // v4-b31: Newsletter subjects, generic agenda notifications, cultural/lifestyle
  if (/\b(newsletter|digest|bulletin|weekly wrap|daily wrap|morning (edition|update)|evening (edition|update)|weekend (edition|guide)|most read|breaking news)\b/.test(lo)) return true;
  if (/\b(agenda published|agenda (available|posted)|meeting (scheduled|notice|reminder)|public (hearing|comment)\s+(period|notice|opportunity))\b/.test(lo) &&
      !/\b(rfq|rfp|solicitation|project|design|construction|renovation|building|facility|capital|bond|budget)\b/.test(lo)) return true;
  // Cultural, lifestyle, recreation, dining, entertainment — not A&E project signals
  if (/\b(restaurant|dining|recipe|chef|food|brew|beer|wine|concert|festival|gallery|exhibit|art show|film|movie|theater|theatre|museum|trail run|marathon|rodeo|parade|celebration|holiday|christmas|thanksgiving|halloween|valentines)\b/.test(lo) &&
      !/\b(construction|renovation|design|building|facility|development|expansion)\b/.test(lo)) return true;
  // Trial, crime, court, lawsuit, obituary, memorial
  if (/\b(trial\s+by|trial\s+for|trial\s+of|court\s+(case|ruling|hearing)|lawsuit|defendant|accused|sentenced|arrested|obituar|memorial|tribute|funeral|missing person|amber alert|silver alert)\b/.test(lo)) return true;
  return false;
}

// ── PDF text extraction (lazy-loaded) ───────────────────────
// Uses unpdf — a serverless-optimized PDF.js wrapper with zero native dependencies.
// Lazy import so the main scan path doesn't pay the cost until a PDF is actually encountered.
let _unpdf = null;
async function getUnpdf() {
  if (!_unpdf) {
    try {
      _unpdf = await import('unpdf');
    } catch {
      _unpdf = false; // Mark as unavailable so we don't retry
    }
  }
  return _unpdf || null;
}

// ── PDF size and quality limits ─────────────────────────────
const PDF_MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB — skip giant documents
const PDF_FETCH_TIMEOUT = 12000;             // 12s — slightly longer than HTML (PDFs are larger)
const PDF_MIN_USEFUL_CHARS = 200;            // Below this, extracted text is likely junk
const PDF_MAX_PAGES = 30;                    // Don't parse enormous documents

/**
 * Fetch a PDF and extract text content.
 * Returns { ok, content, title, pageCount, err } or a failure object.
 * Safe: timeout-guarded, size-limited, returns null-like on any failure.
 */
async function fetchPdfContent(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PDF_FETCH_TIMEOUT);

  try {
    // Fetch as binary
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ProjectScout/1.0)',
        'Accept': 'application/pdf,*/*',
      },
    });
    clearTimeout(t);

    if (r.status < 200 || r.status >= 400) {
      return { ok: false, content: null, title: null, pageCount: 0, err: `HTTP ${r.status}` };
    }

    // Verify content type is actually PDF
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('pdf') && !url.toLowerCase().endsWith('.pdf')) {
      return { ok: false, content: null, title: null, pageCount: 0, err: 'Not a PDF (content-type: ' + ct + ')' };
    }

    // Check content length if available
    const cl = r.headers.get('content-length');
    if (cl && parseInt(cl) > PDF_MAX_SIZE_BYTES) {
      return { ok: false, content: null, title: null, pageCount: 0, err: `PDF too large (${Math.round(parseInt(cl)/1024/1024)}MB > 5MB limit)` };
    }

    const buf = await r.arrayBuffer();
    if (buf.byteLength > PDF_MAX_SIZE_BYTES) {
      return { ok: false, content: null, title: null, pageCount: 0, err: `PDF too large (${Math.round(buf.byteLength/1024/1024)}MB)` };
    }
    if (buf.byteLength < 100) {
      return { ok: false, content: null, title: null, pageCount: 0, err: 'PDF too small / empty' };
    }

    // Parse with unpdf
    const unpdf = await getUnpdf();
    if (!unpdf) {
      return { ok: false, content: null, title: null, pageCount: 0, err: 'unpdf not available' };
    }

    const pdf = await unpdf.getDocumentProxy(new Uint8Array(buf));
    if (pdf.numPages > PDF_MAX_PAGES) {
      return { ok: false, content: null, title: null, pageCount: pdf.numPages,
        err: `PDF has ${pdf.numPages} pages (>${PDF_MAX_PAGES} limit)` };
    }

    const { totalPages, text } = await unpdf.extractText(pdf, { mergePages: true });

    // Get metadata for title
    let pdfTitle = null;
    try {
      const meta = await unpdf.getMeta(pdf);
      pdfTitle = meta?.info?.Title || null;
    } catch { /* metadata is optional */ }

    // Clean extracted text
    const cleanText = (typeof text === 'string' ? text : '')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (cleanText.length < PDF_MIN_USEFUL_CHARS) {
      return { ok: false, content: null, title: pdfTitle, pageCount: totalPages,
        err: `Extracted text too short (${cleanText.length} chars) — likely scanned/image PDF` };
    }

    return {
      ok: true,
      content: cleanText.slice(0, 30000), // Cap at 30K chars (PDFs can be verbose)
      title: pdfTitle,
      pageCount: totalPages,
      err: null,
    };
  } catch (e) {
    clearTimeout(t);
    const msg = e.name === 'AbortError' ? `PDF timeout (${PDF_FETCH_TIMEOUT}ms)` : `PDF parse error: ${e.message}`;
    return { ok: false, content: null, title: null, pageCount: 0, err: msg };
  }
}

/**
 * Validate that extracted PDF text is actually useful project content,
 * not garbled binary, OCR noise, or table-of-contents spam.
 * Returns true if the text appears to contain real readable content.
 */
function isPdfTextUseful(text) {
  if (!text || text.length < PDF_MIN_USEFUL_CHARS) return false;

  // Check ratio of printable ASCII to total chars (garbled binary will be low)
  const printable = text.replace(/[^\x20-\x7E\n]/g, '').length;
  if (printable / text.length < 0.7) return false;

  // Check that there are actual words (not just numbers/symbols)
  const words = text.match(/[a-zA-Z]{3,}/g) || [];
  if (words.length < 20) return false;

  // Check for at least some project-relevant content
  const lo = text.toLowerCase();
  const hasProjectSignal = /\b(project|design|construction|renovation|building|facility|scope|services|architect|engineer|rfq|rfp|solicitation|bid|qualifications|budget|schedule|timeline|deadline|submittal)\b/.test(lo);
  if (!hasProjectSignal) return false;

  return true;
}

// ── Title validation gate (ported from V1 — catches garbage before quality gates) ──
function validateLiveTitle(title) {
  if (!title || typeof title !== 'string') return { pass: false, reason: 'empty' };
  const t = title.trim();
  const tLo = t.toLowerCase();
  if (t.length < 5) return { pass: false, reason: 'too_short' };
  if (t.length > 200) return { pass: false, reason: 'too_long' };
  // Generic heading patterns
  if (/^(?:major |capital |current |planned |completed? |awarded? |active )?(?:projects?|bids?|contracts?|listings?|updates?|pages?|programs?)$/i.test(t)) return { pass: false, reason: 'generic_heading' };
  if (/^capital\s+improvement\s+(?:plan|program|projects?)$/i.test(t)) return { pass: false, reason: 'generic_heading' };
  // Statute/regulation reference
  if (/section\s+\d+[-–]\d+[-–]\d+|as\s+required\s+under|pursuant\s+to|in\s+accordance\s+with/i.test(t)) return { pass: false, reason: 'statute_reference' };
  // Cross-product: "Org — Generic Label"
  if (/^(?:\[.*?\]\s*)?.+\s+—\s+.+\s+(?:Opportunity|Signal)$/i.test(t)) return { pass: false, reason: 'synthetic_cross_product' };
  if (/^.+\s+—\s+(?:Capital Improvement|Civic Renovations?|Healthcare|K-12|Higher Education|Infrastructure|Public Safety|Housing|Private Development|Project Signal)\s*$/i.test(t)) return { pass: false, reason: 'synthetic_cross_product' };
  // Consultant/firm name as title
  if (/^(?:HDR|DOWL|Morrison.Maierle|MMW|Cushing.Terrell|CTA|LPW|Stahly|Robert.Peccia|WGM|Jackola)\b/i.test(t)) return { pass: false, reason: 'consultant_name' };
  // UI / navigation fragment
  if (/^(?:click|read|learn|view|download|submit|register|login|home|contact|about|search|menu|sitemap|vendor|skip|email|visit|go\s+to|back\s+to|return\s+to|sign\s+in|log\s+in|sign\s+up)\b/i.test(tLo)) return { pass: false, reason: 'ui_fragment' };
  // Generic hub/portal/page references
  if (/\b(?:registration|portal|hub|links|divisions?|resources?)\s*(?:page)?$/i.test(t) || /^procurement\s/i.test(t)) return { pass: false, reason: 'generic_page' };
  if (/\bpage\.?$/i.test(t)) return { pass: false, reason: 'page_reference' };
  if (/\.\s*$/.test(t)) return { pass: false, reason: 'trailing_period' };
  // Nav headings
  if (/^[A-Z]{2,6}\s+(?:Home|Links|Divisions?|Resources?|Services?|Forms?|News)$/i.test(t)) return { pass: false, reason: 'nav_heading' };
  // Generic bid/procurement headings
  if (/^(?:current|active|open|closed|past|upcoming|recent)\s+(?:bid|rfq|rfp|solicitation|procurement)/i.test(tLo)) return { pass: false, reason: 'generic_bid_heading' };
  if (/^(?:bid|rfq|rfp)\s+(?:schedule|opportunities|listings?|results?|tabulations?)$/i.test(tLo)) return { pass: false, reason: 'generic_bid_heading' };
  // Payment / admin pages
  if (/^(?:payment|billing|payroll|accounting|purchasing)\s+(?:center|office|department|division|portal|system)/i.test(t)) return { pass: false, reason: 'admin_page' };
  // Directory / registry
  if (/\b(?:directory|registry|roster)\b/i.test(tLo)) return { pass: false, reason: 'registry_page' };
  // Boilerplate
  if (/\bcookies?\b.*\b(?:analytics|policy|consent|tracking)/i.test(tLo) || /\bgoogle\s+analytics/i.test(tLo) || /^(?:privacy|terms|disclaimer|accessibility|copyright)/i.test(tLo)) return { pass: false, reason: 'boilerplate' };
  // Office names
  if (/^(?:governor|mayor|president|director|manager)(?:'s)?\s+office$/i.test(t)) return { pass: false, reason: 'office_name' };
  // Paired nav headings
  if (/^(?:programs?|applications?|services?|resources?|forms?|documents?|publications?)\s*(?:&|and)\s*(?:programs?|applications?|services?|resources?|forms?|documents?|publications?)$/i.test(t)) return { pass: false, reason: 'generic_nav_heading' };
  // Non-core service items
  if (/^bridge\s+(?:deck|replacement|repair|painting)/i.test(t) || /\bit\s+(?:network|system|upgrade|modernization)/i.test(t) || /\bsoftware\s+(?:system|replacement|upgrade|modernization)/i.test(t) || /\bnetwork\s+(?:upgrade|replacement|modernization)/i.test(t)) return { pass: false, reason: 'non_core_service' };
  // Non-A&E broadband/telecom
  if (/\b(?:broadband|telecom|fiber\s+optic|internet\s+service|wireless\s+network)/i.test(tLo) && !/\b(?:building|facility|center|office|campus)\b/i.test(tLo)) return { pass: false, reason: 'non_core_telecom' };
  // Completed/awarded prefix
  if (/^(?:completed|awarded|closed|expired|archived|past)\s/i.test(tLo)) return { pass: false, reason: 'completed_prefix' };
  // v4-b6r2: Single-letter fragment starts: "S Urban Renewal Districts..."
  if (/^[A-Z]\s+[A-Z]/.test(t) && !/^[A-Z]\s+(Street|Avenue|Building|Block|Phase|Wing|Unit|Tower|Hall|Park)\b/.test(t)) return { pass: false, reason: 'single_letter_fragment' };
  // Must have at least 2 meaningful words
  const words = t.split(/\s+/).filter(w => w.length > 2);
  if (words.length < 2) return { pass: false, reason: 'too_few_words' };
  // Explicitly truncated display titles — page truncation artifact (e.g. "Reet Master plan...", "Dous potential…")
  if (/\.{2,}\s*$|…\s*$/.test(t)) return { pass: false, reason: 'truncated_ellipsis' };
  // v4-b6r2: Leading ellipsis — fragment detected by cleanTitle partial-word check
  if (/^…/.test(t)) return { pass: false, reason: 'truncated_ellipsis' };
  // Sentence fragments
  if (/^(?:in\s+addition|each\s+agency|year\s+plan|the\s+following|as\s+part\s+of|for\s+the\s+purpose|in\s+order\s+to|to\s+be\s+submitted|all\s+agencies|please\s+)/i.test(tLo)) return { pass: false, reason: 'sentence_fragment' };
  // Explanatory purpose clauses — not project names (e.g. "City of Missoula in 2020 to encourage development")
  if (/\b(?:to\s+encourage|to\s+promote|to\s+support\s+(?:the|local|community)|to\s+provide\s+(?:a|the|additional)|was\s+established|has\s+been\s+established|will\s+be\s+used\s+to|that\s+supports\s+the|which\s+supports|in\s+an\s+effort\s+to|in\s+response\s+to\s+(?:the|a)|to\s+meet\s+the\s+(?:needs|goals|demand|requirements))\b/i.test(tLo)) return { pass: false, reason: 'explanatory_clause' };
  // "City/County of X in [year] [verb phrase]" pattern — organizational sentence fragment, not a project
  if (/^(?:city|county|town|state)\s+of\s+\w+\s+in\s+\d{4}\b/i.test(t)) return { pass: false, reason: 'org_year_clause' };
  // "Org — context" where context is problematic
  const dashMatch = t.match(/^(.+?)\s+—\s+(.+)$/);
  if (dashMatch) {
    const rest = dashMatch[2].trim();
    if (/^[a-z]/.test(rest) && !/^(?:proposed|planned|new|upcoming|rfq|rfp|design|architectural|engineering|invitation)\b/i.test(rest)) return { pass: false, reason: 'org_context_fragment' };
    if (/section\s+\d+|as\s+required|pursuant\s+to/i.test(rest)) return { pass: false, reason: 'statute_in_context' };
    if (/^capital\s+improvement\s+(?:plan|program)/i.test(rest)) return { pass: false, reason: 'generic_cip_context' };
    if (/^(?:bid|solicitation|procurement|vendor|active bids|open bids|bid postings?|bid schedule)/i.test(rest)) return { pass: false, reason: 'generic_bid_context' };
  }
  return { pass: true, reason: 'ok' };
}

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
  // Future-signal / Watch keywords — LRBP, capital planning, facility programs
  'lrbp','long-range building','capital plan','deferred maintenance',
  'facility assessment','modernization','building replacement','building program',
  'facilities planning','campus master plan',
  // EDO / strategic-planning Watch keywords — only terms specific enough to avoid false matches
  // REMOVED (too generic, matched every government page): 'economic development', 'annual report',
  // 'strategic plan', 'transformation', 'workforce development', 'development project'
  'CEDS','site selection','business park','industrial park',
];

// ── Fetch a URL server-side ─────────────────────────────────
async function fetchUrl(url, timeout = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  // v4-b20: Some government board portals (escribemeetings.com) have incomplete
  // SSL certificate chains. Temporarily relax TLS for those domains.
  const needsRelaxedTLS = /escribemeetings\.com/i.test(url);
  if (needsRelaxedTLS) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ProjectScout/1.0)',
        'Accept': 'text/html,application/xhtml+xml,*/*',
      },
    });
    if (needsRelaxedTLS) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
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
    if (needsRelaxedTLS) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
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
    // Skip obvious nav/chrome links: language selectors, social media, generic nav
    if (/\b(select this as your preferred|language|cookie|privacy|accessibility|terms of use|sign in|log ?in)\b/i.test(anchor)) continue;

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

    // RFQ/RFP/BID/SOQ/solicitation detail pages
    if (/\b(rfq|rfp|soq|bid|request for|solicitation|invitation to bid)\b/.test(lo) ||
        /\b(bid|rfq|rfp|soq|solicitation)\b/.test(hrefLo)) {
      linkType = 'solicitation_detail';
      relevanceHint = 10;
    }
    // Meeting minutes/agendas with dates
    else if (/\b(minutes|agenda|meeting|packet)\b/.test(lo) && /\d{1,2}[\/-]\d{1,2}|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d/i.test(lo + ' ' + hrefLo)) {
      linkType = 'meeting_document';
      relevanceHint = 7;
    }
    // Meeting detail/action pages (CivicClerk, Granicus, Legistar)
    else if (/\b(agenda|packet|meeting|minutes)\b/i.test(lo) && /\b(detail|view|download|open)\b/i.test(lo + ' ' + hrefLo)) {
      linkType = 'meeting_document';
      relevanceHint = 6;
    }
    // Staff reports, memos, supporting documents
    else if (/\b(staff\s+report|memo|memorandum|supporting\s+document|backup\s+material|supplemental)\b/i.test(lo)) {
      linkType = 'meeting_document';
      relevanceHint = 7;
    }
    // CIP/budget/capital plan documents
    else if (/\b(capital improvement|cip|budget|capital plan|facilities plan|lrbp|long.range building|deferred maintenance|facility assessment|building program)\b/.test(lo)) {
      linkType = 'capital_document';
      relevanceHint = 8;
    }
    // Strategic planning documents (CEDS, annual reports, strategic plans)
    else if (/\b(ceds|annual report|strategic plan|economic development strategy|comprehensive plan|growth policy)\b/.test(lo)) {
      linkType = 'capital_document';
      relevanceHint = 7;
    }
    // Project detail pages
    else if (/\b(project detail|project page|view project|project info)\b/.test(lo) ||
             /\b(bid(ID|id|_id|detail)|projectid|project_id)\b/.test(hrefLo)) {
      linkType = 'project_detail';
      relevanceHint = 9;
    }
    // PDF documents that look like project documents
    else if (/\.pdf$/i.test(hrefLo) && /\b(rfq|rfp|bid|plan|design|capital|renovation|addition|facility|lrbp|assessment|modernization|deferred|building program|annual report|ceds|strategic)\b/.test(lo)) {
      linkType = 'document_pdf';
      relevanceHint = 8;
    }
    // Board/commission packets
    else if (/\b(packet|attachment|exhibit|appendix)\b/.test(lo) && /\.pdf$/i.test(hrefLo)) {
      linkType = 'board_packet';
      relevanceHint = 6;
    }
    // DocumentCenter / download links that indicate PDF content
    // Covers CivicEngage DocumentCenter, Granicus, and similar municipal CMS patterns
    else if (/\b(pdf|download|document)\b/i.test(lo) &&
             /\b(DocumentCenter|ViewFile|AgendaCenter|ArchiveCenter)\b/i.test(hrefLo)) {
      linkType = 'document_pdf';
      relevanceHint = 7;
    }
    // BoardDocs portal — used by school districts and municipal boards
    else if (/boarddocs\.com/i.test(hrefLo)) {
      linkType = 'meeting_document';
      relevanceHint = 8;
    }
    // Press release / notice items with facility/project/procurement keywords
    else if (/\b(announcement|notice|release|news)\b/i.test(lo + ' ' + hrefLo) &&
             /\b(rfq|rfp|rfb|bid|project|terminal|expansion|construction|renovation|facility|capital)\b/i.test(lo)) {
      linkType = 'project_detail';
      relevanceHint = 7;
    }
    // v4-b7: Development/housing/district project pages
    else if (/\b(development|housing|redevelopment|district|corridor|master plan|facility|capital|improvement|renovation|construction)\b/i.test(lo) &&
             /\b(project|detail|plan|update|phase|proposal|development|site)\b/i.test(lo + ' ' + hrefLo) &&
             anchor.length >= 12 && anchor.length <= 150) {
      linkType = 'project_detail';
      relevanceHint = 6;
    }
    // v4-b7: Budget/CIP detail pages and amendment docs
    else if (/\b(budget|cip|capital|amendment|appropriation)\b/i.test(lo) &&
             /\b(detail|item|project|facility|department|update)\b/i.test(lo + ' ' + hrefLo) &&
             !/\b(operating|general fund|personnel|payroll|insurance)\b/i.test(lo)) {
      linkType = 'capital_document';
      relevanceHint = 5;
    }

    // v4-b9: CivicEngage-specific link patterns — /{number}/{Slug-Name} URLs
    // These are the primary navigation pattern for ci.missoula.mt.us and similar CivicEngage CMS sites.
    // District, project, and plan pages use this format but don't match generic classifiers.
    if (!linkType && /\/\d+\/[\w-]+/.test(hrefLo)) {
      // Named URD/district/renewal pages — high value for redevelopment leads
      if (/\b(urd|urban.renewal|district|front.street|riverfront|hellgate|north.reserve|scott.street|midtown)\b/i.test(lo + ' ' + hrefLo)) {
        linkType = 'project_detail';
        relevanceHint = 8;
      }
      // Named project/plan/development pages
      else if (/\b(major.projects?|capital.project|development.project|renewal.plan|master.plan|workforce.housing|affordable.housing)\b/i.test(lo + ' ' + hrefLo)) {
        linkType = 'project_detail';
        relevanceHint = 7;
      }
      // Department project/facility pages with development keywords
      else if (/\b(project|facility|improvement|renovation|construction|capital|development)\b/i.test(lo) &&
               anchor.length >= 8 && anchor.length <= 100) {
        linkType = 'project_detail';
        relevanceHint = 5;
      }
    }

    // v4-b9: Housing authority project pages (non-CivicEngage — flat slug pattern)
    if (!linkType && /missoulahousing\.org/i.test(href)) {
      if (/\/(development|bristlecone|villagio|trinity|project)/i.test(hrefLo)) {
        linkType = 'project_detail';
        relevanceHint = 7;
      }
    }

    // v4-b17: Engage Missoula project pages
    if (!linkType && /engagemissoula\.com/i.test(href)) {
      if (/\/(scott|triangle|corridor|library|block|crossing|hotel|mrl|park|north|west|south)/i.test(hrefLo) &&
          anchor.length >= 8) {
        linkType = 'project_detail';
        relevanceHint = 8;
      }
    }

    // v4-b17: OnBoardGOV meeting portal links (boards.missoulacounty.us)
    if (!linkType && /boards\.missoulacounty\.us/i.test(href)) {
      if (/\b(agenda|minutes|meeting|video)\b/i.test(lo + ' ' + hrefLo)) {
        linkType = 'meeting_document';
        relevanceHint = 6;
      }
    }

    // v4-b17: Missoula County TEDD PDF links
    if (!linkType && /missoulacounty\.gov\/media\//i.test(hrefLo) && /\.pdf$/i.test(hrefLo)) {
      if (/\b(tedd|development.plan|tax.increment|bonner|wye|grant.creek)\b/i.test(lo)) {
        linkType = 'document_pdf';
        relevanceHint = 7;
      }
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
async function enrichFromChildLink(bestLink, src, log = () => {}, taxonomy = []) {
  if (!bestLink) return null;

  try {
    // Determine if this is a PDF link
    const isPdf = bestLink.linkType === 'document_pdf' || bestLink.linkType === 'board_packet' ||
                  bestLink.url.toLowerCase().endsWith('.pdf');

    let content = null;
    let title = null;
    let pdfParsed = false;
    let pdfPageCount = 0;

    if (isPdf) {
      // ── PDF path: fetch binary and extract text ──
      const pf = await fetchPdfContent(bestLink.url);
      if (pf.ok && pf.content && isPdfTextUseful(pf.content)) {
        content = pf.content;
        title = pf.title || bestLink.anchorText;
        pdfParsed = true;
        pdfPageCount = pf.pageCount;
        log(`    ↳ PDF parsed: ${pf.pageCount} pages, ${pf.content.length} chars`);
      } else {
        // PDF fetch/parse failed — log reason but return link metadata only
        log(`    ↳ PDF not parseable: ${pf.err || 'unknown'}`);
        return {
          enrichedContent: null,
          childUrl: bestLink.url,
          childTitle: bestLink.anchorText,
          childLinkType: bestLink.linkType,
          childAnchorText: bestLink.anchorText,
          childDates: null, childBudget: null, childLocation: null, childMarket: null,
          childDescription: null, evidenceSnippet: null,
          pdfParsed: false,
          pdfError: pf.err || 'Parse failed',
          pdfPageCount: pf.pageCount || 0,
        };
      }
    } else {
      // ── HTML path ──
      const f = await fetchUrl(bestLink.url, 10000);
      if (!f.ok || !f.content || f.content.length < 100) return null;
      content = f.content.slice(0, 20000);
      title = f.title || bestLink.anchorText;

      // v4-b8: Two-level child following for redevelopment/housing/district sources.
      // If the first child page is still an index/container (lots of links, few project sentences),
      // follow one more level to a project-specific child page.
      const profileType = src?.source_profile?.profile_type || '';
      const allowSecondLevel = ['redevelopment', 'institutional'].includes(profileType) ||
        /\b(housing|development|district|corridor|renewal)\b/i.test(bestLink.anchorText || '');

      if (allowSecondLevel && f.rawHtml) {
        // Detect if child page is still a container: check if it has many project links
        const childChildLinks = extractChildLinks(f.rawHtml, bestLink.url);
        const projectChildLinks = childChildLinks.filter(cl =>
          cl.relevanceHint >= 5 &&
          /\b(project|development|district|plan|renovation|construction|facility|site|phase|housing|urd|renewal|redevelopment|capital|improvement|corridor|triangle|reserve)\b/i.test(cl.anchorText.toLowerCase())
        );

        // Only go deeper if: 1) child has project-bearing links, 2) content has few project sentences
        const projectSentences = content.split(/(?<=[.!?\n])\s+/).filter(s =>
          s.length > 30 && /\b(construction|renovation|project|facility|development|building|design|budget|funded)\b/i.test(s.toLowerCase())
        );

        if (projectChildLinks.length >= 1 && projectSentences.length < 3) {
          // Pick the best second-level link
          const best2 = projectChildLinks[0]; // Already sorted by relevanceHint
          log(`    ↳ 2nd-level follow: "${best2.anchorText.slice(0, 50)}" (${best2.linkType}, hint=${best2.relevanceHint})`);

          try {
            const isPdf2 = best2.linkType === 'document_pdf' || best2.url.toLowerCase().endsWith('.pdf');
            if (isPdf2) {
              const pf2 = await fetchPdfContent(best2.url);
              if (pf2.ok && pf2.content && isPdfTextUseful(pf2.content)) {
                content = pf2.content;
                title = pf2.title || best2.anchorText || title;
                pdfParsed = true;
                pdfPageCount = pf2.pageCount;
                log(`    ↳ 2nd-level PDF parsed: ${pf2.pageCount} pages, ${pf2.content.length} chars`);
              }
            } else {
              const f2 = await fetchUrl(best2.url, 10000);
              if (f2.ok && f2.content && f2.content.length > 200) {
                // Check if the second-level page has more project content than the first
                const content2 = f2.content.slice(0, 20000);
                const ps2 = content2.split(/(?<=[.!?\n])\s+/).filter(s =>
                  s.length > 30 && /\b(construction|renovation|project|facility|development|building|design|budget|funded|acres|square\s+feet)\b/i.test(s.toLowerCase())
                );
                // v4-b9: Use second-level content if it has more project substance
                // OR if first level had almost no project content (< 2 sentences)
                if (ps2.length > projectSentences.length || (ps2.length >= 1 && projectSentences.length < 2)) {
                  content = content2;
                  title = f2.title || best2.anchorText || title;
                  log(`    ↳ 2nd-level content used: ${content2.length} chars, ${ps2.length} project sentences (was ${projectSentences.length})`);
                }
              }
            }
          } catch { /* second-level fetch failure is non-fatal */ }
        }
      }
    }

    // ── Common enrichment extraction (works for both HTML and PDF text) ──
    const childDates = extractDates(content);
    const childBudget = extractBudget(content);
    const childLocation = extractLocation(content, src);
    const childMarket = inferMarket(content, taxonomy);

    // Extract a description: best sentences mentioning project substance
    // Skip nav/chrome text that CivicEngage and similar CMS platforms inject
    const sentences = content.split(/(?<=[.!?\n])\s+/).filter(s => {
      if (s.length < 25 || s.length > 300) return false;
      const sl = s.toLowerCase();
      // Skip obvious CMS chrome: menus, breadcrumbs, footers, alerts, disclaimers
      if (/skip to main|search government|how do i|sign up to receive|departments|read on\.\.\./i.test(sl)) return false;
      if (/^\s*(home|print|search|menu|close|back)\b/i.test(sl)) return false;
      if (/accessibility|privacy statement|disclaimer|site map|copyright|all rights reserved|powered by/i.test(sl)) return false;
      if (/select this as your preferred|cookie|terms of (use|service)/i.test(sl)) return false;
      return true;
    });
    // Rank sentences by specificity: scope/purpose > procurement > budget/CIP > development > generic
    // v4-b7: Expanded scoring for Watch-quality leads (budgets, CIP, development, timelines)
    const scoreSentence = (s) => {
      const sl = s.toLowerCase();
      let sc = 0;
      if (/\b(scope of (work|services)|project (scope|description|overview|summary)|purpose of this)\b/.test(sl)) sc += 5;
      if (/\b(seeking|is soliciting|invites|requests)\s+(qualif|proposal|statement|a\/e|architect|design|engineering)\b/.test(sl)) sc += 4;
      if (/\b(services? (for|include)|work (includes?|consists?)|project (includes?|involves?))\b/.test(sl)) sc += 3;
      if (/\b(approximately|estimated|budget|square (feet|foot)|sf\b|gsf\b|acres?)\b/.test(sl)) sc += 2;
      if (/\b(construction|renovation|addition|expansion|replacement|remodel|new (building|facility|construction))\b/.test(sl)) sc += 2;
      if (/\b(design|architect|engineer|qualifications?|solicitation|rfq|rfp)\b/.test(sl)) sc += 1;
      if (/\b(project|building|facility|phase|campus|site)\b/.test(sl)) sc += 1;
      // v4-b7: Budget/CIP/capital language (important for Watch leads from budget sources)
      if (/\b(capital\s+improvement|cip\s+|capital\s+project|capital\s+budget|funded|budgeted|appropriat|bond\s+(issue|measure|election|funding)|levy|mill\s+levy|tif\s+(funded|district|revenue)|urban\s+renewal\s+district)\b/.test(sl)) sc += 3;
      // v4-b7: Dollar amounts in sentences signal real budget context
      if (/\$[\d,.]+\s*(million|mil|m\b|k\b|thousand)?/i.test(sl)) sc += 3;
      // v4-b7: Development/planning language (important for redevelopment/MEP sources)
      if (/\b(planned\s+(development|construction|expansion)|proposed\s+(development|project|facility|building)|development\s+(project|agreement|proposal|plan)|master\s+plan\s+(update|amendment|phase)|redevelopment\s+(project|plan|area|district))\b/.test(sl)) sc += 3;
      // v4-b7: Timeline/scheduling signals
      if (/\b(scheduled\s+for|anticipated\s+(start|completion|opening)|planned\s+for\s+\d|expected\s+(to|in)\s+\d|fy\s*\d{2,4}|phase\s+[1-9]|groundbreaking|under\s+design|design\s+phase)\b/.test(sl)) sc += 2;
      // v4-b7: Named facility references (strong Watch signals)
      if (/\b(fire\s+station|police\s+station|library|courthouse|school|hospital|clinic|treatment\s+(plant|facility)|community\s+center|recreation\s+center|senior\s+center|student\s+union|aquatic|natatorium|fieldhouse|arena|stadium|museum|terminal|hangar)\b/.test(sl)) sc += 2;
      return sc;
    };
    const scoredSentences = sentences.map(s => ({ text: s, score: scoreSentence(s) }))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score);
    // Build child description from top 2-3 non-redundant sentences
    const usedSnippets = new Set();
    const dedupedSentences = scoredSentences.filter(s => {
      const norm = s.text.toLowerCase().slice(0, 50);
      if ([...usedSnippets].some(u => u.startsWith(norm.slice(0, 25)) || norm.startsWith(u.slice(0, 25)))) return false;
      usedSnippets.add(norm);
      return true;
    });
    const childDescription = dedupedSentences.slice(0, 3).map(s => s.text).join(' ').slice(0, 500).trim() || null;

    // Evidence snippet: top 2 non-redundant sentences for richer context
    const evidenceSnippet = dedupedSentences.slice(0, 2).map(s => s.text).join(' ').slice(0, 350).trim() || null;

    return {
      enrichedContent: content,
      childUrl: bestLink.url,
      childTitle: title,
      childLinkType: bestLink.linkType,
      childAnchorText: bestLink.anchorText,
      childDates,
      childBudget,
      childLocation,
      childMarket,
      childDescription,
      evidenceSnippet,
      pdfParsed,
      pdfPageCount,
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
  // Stop words that shouldn't count for overlap
  const linkStopWords = new Set(['the','and','for','from','with','this','that','city','county','state','project','services','request']);

  // Score each child link: relevanceHint + text overlap bonus
  let best = null, bestScore = -1;
  for (const link of childLinks) {
    let score = link.relevanceHint || 0;
    const anchorLo = link.anchorText.toLowerCase();
    // Text overlap bonus: each matching non-stop word adds 1.5 points
    for (const w of textWords) {
      if (!linkStopWords.has(w) && anchorLo.includes(w)) score += 1.5;
    }
    // Bonus for direct solicitation/project PDFs (most likely to be the real artifact)
    if ((link.linkType === 'solicitation_detail' || link.linkType === 'document_pdf') && /\.pdf/i.test(link.url)) {
      score += 1;
    }
    if (score > bestScore) { bestScore = score; best = link; }
  }

  // v4-b7: Lower threshold for non-procurement sources — development pages, housing, CIP often
  // have project-relevant links that score 4-5 because they don't use procurement language
  return (best && bestScore >= 4) ? best : null;
}

// ── Keyword pre-filter ──────────────────────────────────────
function preFilter(content, src) {
  if (!content) return { pass: false, n: 0, kw: [] };
  const lo = content.toLowerCase();
  const s = new Set();
  for (const t of SIGNALS) if (lo.includes(t)) s.add(t);
  for (const k of (src.keywords||[])) if (lo.includes(k.toLowerCase())) s.add(k);
  const arr = [...s];
  const hi = ['State Procurement','County Commission','City Council','Planning & Zoning','School Board','Economic Development','Capital Planning'];
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
  // Exception: text with known strategic area keywords (TEDD, URD, TIF) is not menu junk
  const words = text.split(/\s+/).filter(w => w.length > 0);
  if (words.length > 3) {
    const capWords = words.filter(w => /^[A-Z]/.test(w) && w.length < 8);
    if (capWords.length / words.length > 0.7) {
      // v4-b21: Don't kill titles with known strategic district keywords
      if (!/\b(tedd|urd|tif|urban\s+renewal|redevelopment|development\s+park|crossing|corridor|triangle|commons)\b/i.test(text)) {
        return true;
      }
    }
  }
  // Fail if it doesn't contain at least one real project-related word
  // Also allow Watch-quality development/redevelopment area names with proper nouns
  if (!PROJECT_TITLE_WORDS.test(text)) {
    const hasWatchAreaWord = /\b(redevelopment|development|revitalization|corridor|triangle|commons|crossing|downtown|midtown|district|quarter|village|landing|heights|terrace|urban renewal|master plan|mill|yard|log\s*yard|station|depot|junction|plaza|block|square|project|site|phase|parcel|park|tedd|urd|tif)\b/i.test(text);
    const hasProperNoun = /[A-Z][a-z]{2,}/.test(text);
    if (!(hasWatchAreaWord && hasProperNoun)) return true;
  }
  return false;
}

/**
 * Clean a raw title candidate: remove leading/trailing junk, normalize whitespace,
 * strip trailing dates/numbers, and cap length.
 */
function cleanTitle(raw) {
  let t = raw.replace(/\s+/g, ' ').trim();
  // Pre-flight: if the raw title starts or ends with an ellipsis, it is a mid-page text fragment
  // and cannot be salvaged by cleaning — return the truncated form so validateLiveTitle can reject it.
  if (/^[.…]|[.…]$/.test(t.replace(/\s/g, ''))) {
    // Normalize to a canonical truncation marker so validateLiveTitle catches it
    if (/\.{2,}\s*$|…\s*$/.test(t)) return t; // tail truncation — return as-is for rejection
    if (/^\s*\.{2,}|^\s*…/.test(t)) return '…' + t.replace(/^\s*\.{2,}|^\s*…/, '').trim(); // head truncation
  }
  // v4-b6r2: Strip "(opens in new window/tab)" and similar document chrome
  t = t.replace(/\s*\(opens?\s+(in\s+)?(a?\s*new\s+)?(window|tab)[\/\s)]*\)/gi, '');
  t = t.replace(/\s*\(opens?\s+new\s+window\/tab\)/gi, '');
  t = t.replace(/\s*\(PDF\)\s*/gi, '');
  t = t.replace(/\s*\(external\s+link\)\s*/gi, '');
  // Strip leading junk: "RFQ #123 for " → keep just the project part handled elsewhere
  // Strip leading articles/prepositions if they start the title
  t = t.replace(/^(the|a|an|for|of|in|at|on|to|and|or)\s+/i, '');
  // v4-b18: Strip "Click here to read/view/download the..." FIRST (before other lead-in stripping)
  t = t.replace(/^click\s+here\s+to\s+(read|view|download|see|open)\s+(the\s+)?/i, '');
  // Strip filler lead-ins that create weak Watch titles
  // "Information About the Library Renovation" → "Library Renovation"
  t = t.replace(/^(information (about|on|regarding)|overview of|guide to|introduction to|summary of|update on|status of|details (on|about|of)|learn (more )?about)\s+(?:the\s+)?/i, '');
  // v4-b20: Strip trailing period BEFORE TEDD suffix matching (anchor text often ends with "Plan.")
  if (/[^.]\.$/.test(t)) t = t.replace(/\.$/, '').trim();
  // v4-b21: Strip TEDD/district plan document suffixes — use "TEDD District" for minimum length
  t = t.replace(/\s+Tax\s+Increment\s+Financing\s+Industrial\s+District\s+Plan\s*$/i, ' TEDD District');
  t = t.replace(/\s+Comprehensive\s+Development\s+Plan\s*$/i, ' TEDD District');
  // Clean up double "District" if the name already contains it
  t = t.replace(/\s+District\s+TEDD\s+District\s*$/i, ' TEDD District');
  // Step 15: Strip "Construction of" / "Renovation of" lead-in when followed by a proper name
  // "Construction of Kings Bridge Deck Replacement" → "Kings Bridge Deck Replacement"
  t = t.replace(/^(construction|renovation|expansion|replacement|modernization|upgrade|restoration)\s+of\s+(?:the\s+)?/i, '');
  // Strip verbose "Development plan for the city-owned X property" → "X"
  t = t.replace(/^(development|redevelopment)\s+(plan|agreement|project)\s+(for|of)\s+(the\s+)?(city[- ]owned\s+|county[- ]owned\s+|state[- ]owned\s+)?/i, '');
  // Strip trailing "property", "area", "site", "parcel" when preceded by a proper name
  t = t.replace(/\s+(property|area|site|parcel|tract|lot)\s*$/i, '');
  // Strip trailing dates, reference numbers, parenthetical codes
  t = t.replace(/\s*\(?\d{1,2}\/\d{1,2}\/\d{2,4}\)?$/, '');
  t = t.replace(/\s*#\s*\d[\w-]*$/, '');
  t = t.replace(/\s*\(\s*\d+\s*\)$/, '');
  // Step 15: Strip parenthetical office file references: "(OFFICE FILE 1863)", "(FILE NO. xxx)", "(Project #xxx)"
  t = t.replace(/\s*\(\s*(?:OFFICE FILE|FILE NO\.?|PROJECT #?)\s*[\w\-]+\s*\)/gi, '');
  // Strip trailing punctuation including periods (titles shouldn't end with period)
  // Note: do NOT strip ellipsis here — validateLiveTitle rejects truncated titles
  t = t.replace(/[,;:\-–—]+$/, '').trim();
  // Strip a single trailing period only (not ellipsis — those are caught by validateLiveTitle)
  if (/[^.]\.$/.test(t)) t = t.replace(/\.$/, '').trim();
  // Strip trailing articles/prepositions that suggest mid-sentence truncation
  t = t.replace(/\s+(the|a|an|of|for|in|at|on|to|and|or|with|from|by|is|are|was|were|has|have)$/i, '').trim();
  // v4-b9: Strip trailing person-name fragments ("Phyllis J", "Robert K", "James L")
  // These indicate mid-text truncation where a person's name was cut off
  t = t.replace(/\s+[A-Z][a-z]+\s+[A-Z]\.?$/g, '').trim();
  // v4-b6r2: Detect partial-word fragments BEFORE capitalization
  // If the first word is lowercase and 1-5 chars, and not a known valid lowercase starter,
  // it's likely a mid-text extraction artifact ("reet Master plan", "dous potential")
  if (/^[a-z]{1,5}\s/.test(t)) {
    const fw = t.split(/\s+/)[0];
    const validLowerStarters = new Set(['via','per','pre','non','sub','mid','bid','new','old','big','all',
      'air','bay','dam','gap','key','lab','map','oak','oil','red','run','sea','sun','top','van','war','zoo',
      'ada','ave','day','due','end','inn','job','kit','log','low','max','net','off','one','out','raw','set',
      'six','tax','two','use','way','yes','bus','gym','hub','lot','mix','pod','pub','rec','row','spa','vet']);
    if (!validLowerStarters.has(fw)) {
      // Return truncation marker so validateLiveTitle rejects it
      return '…' + t;
    }
  }
  // Capitalize first letter
  if (t.length > 0) t = t[0].toUpperCase() + t.slice(1);
  return t;
}

/**
 * Check if a title is project-specific enough to be a real lead.
 * A project-specific title identifies ONE concrete project, service, or facility.
 * Generic titles like "Solicitation", "Capital Improvement", "Project Signal" fail this.
 */
function isProjectSpecificTitle(title) {
  if (!title || title.length < 12) return false;
  const lo = title.toLowerCase();

  // "Org — GenericType" pattern is never project-specific
  if (/^[\w\s&'.,]+\s*[–—-]\s*(solicitation|project signal|capital improvement|bond\/levy program|master plan|renovation project|expansion project)$/i.test(lo)) return false;
  // v32b: Standalone program/category headings — not a specific project
  // "Capital Improvement", "Bid Solicitations", "Current Projects", "City Bids"
  if (/^(capital improvement|bid solicitations?|current (projects?|solicitations?|bids?)|city (bids?|projects?)|municipal (bids?|projects?)|public (works?|bids?|projects?))$/i.test(lo.trim())) return false;

  // Must contain at least one named-project indicator:
  //   a) A proper noun (capitalized word not at start, or multiple caps)
  //   b) A specific facility type (school, hospital, fire station, etc.)
  //   c) A specific action + subject (e.g., "roof replacement", "HVAC upgrade")
  const hasNamedFacility = /\b(school|elementary|middle|high school|university|college|hospital|clinic|courthouse|library|fire station|police station|terminal|hangar|community center|recreation center|student union|dormitory|laboratory|treatment plant|city hall|town hall|armory|fieldhouse|natatorium|auditorium|gymnasium|stadium|arena|museum|gallery|theater|theatre|chapel|church|parish|wellness center|health center|senior center|youth center|detention|corrections|jail|prison)\b/i.test(lo);
  const hasSpecificAction = /\b(roof|hvac|mechanical|electrical|plumbing|interior|exterior|seismic|ada|accessibility|elevator|boiler|chiller|window|door|flooring|ceiling|foundation|structural|fire (alarm|suppression|sprinkler)|parking (garage|structure)|site (work|development)|landscape|playground|athletic|track|field|pool|aquatic)\b/i.test(lo);
  const hasProperName = /[A-Z][a-z]{2,}/.test(title) && title.split(/\s+/).filter(w => /^[A-Z][a-z]/.test(w)).length >= 2;
  const hasProjectAction = /\b(renovation|addition|construction|expansion|replacement|modernization|remodel|upgrade|improvement|restoration|retrofit|conversion|demolition and (re)?construction|new (construction|building|facility))\b/i.test(lo);

  // Need at least: (facility + action) OR (proper name + action) OR (specific action)
  if (hasNamedFacility && hasProjectAction) return true;
  if (hasProperName && hasProjectAction) return true;
  if (hasNamedFacility && hasSpecificAction) return true;
  if (hasSpecificAction && hasProjectAction) return true;
  if (hasProperName && hasNamedFacility) return true;
  // RFQ/RFP/A&E with a subject is project-specific enough
  if (/\b(rfq|rfp|a\/e|design services)\b/i.test(lo) && (hasNamedFacility || hasProperName || hasSpecificAction)) return true;
  // "A/E for [something]" or "Design Services for [something]" with enough specificity
  if (/\b(rfq|rfp|a\/e|design services)\s+(for|:)\s+/i.test(lo) && lo.length >= 25) return true;

  // Watch-quality development patterns: proper name + development/redevelopment/master plan/corridor/district
  // These are named opportunity areas and planning-stage projects, legitimate Watch items
  const hasDevelopmentAction = /\b(development|redevelopment|revitalization|master plan|corridor plan|district plan|urban renewal)\b/i.test(lo);
  if (hasProperName && hasDevelopmentAction) return true;
  // Named areas without explicit action words but with recognized area-type indicators
  // e.g., "Midtown Commons", "Riverfront Triangle", "Southgate Crossing"
  // Named development areas — must be specific area-type names, not generic geographic words.
  // "Midtown Commons", "Riverfront Triangle", "Southgate Crossing" are valid.
  // "Silver Park", "Cedar Point", "Pine Ridge" are just place names, not projects.
  const hasAreaIndicator = /\b(commons|crossing|triangle|corridor|square|plaza|block|district|quarter|village|landing|heights|terrace|junction|mill|yard|log\s*yard|station|depot|warehouse|annex)\b/i.test(lo);
  if (hasProperName && hasAreaIndicator && lo.length >= 12) return true;
  // Named development/redevelopment targets — "Scott Street Project", "Bonner Mill", "Wye 2"
  const hasDevelopmentTarget = /\b(project|site|development|redevelopment|phase|parcel)\b/i.test(lo);
  if (hasProperName && hasDevelopmentTarget && lo.length >= 10) return true;

  return false;
}

/**
 * Step 13: Watch-specific title quality check.
 * Watch titles must identify ONE specific future project, program item, or bounded
 * opportunity. Generic budget headings, page fragments, broad plan references, and
 * truncated mid-sentence text are not acceptable Watch titles.
 *
 * Returns { pass: boolean, reason?: string }
 */
function isWatchTitleAcceptable(title) {
  if (!title || title.length < 12) return { pass: false, reason: 'too_short' };
  const lo = title.toLowerCase();

  // ── Block: address-only titles ──
  // "123 Main Street", "456 N Reserve St", "PO Box 1234"
  if (/^\d+\s+[A-Z]/i.test(title.trim()) && /\b(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|ct|court|pl|place|hwy|highway)\b/i.test(lo) &&
      !/\b(renovation|construction|design|project|replacement|upgrade|addition|expansion|facility|building)\b/i.test(lo))
    return { pass: false, reason: 'address_only' };
  if (/^p\.?o\.?\s*box\s+\d/i.test(lo.trim()))
    return { pass: false, reason: 'address_only' };

  // ── Block: phone/fax/email-only fragments ──
  if (/^\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/.test(lo.trim()))
    return { pass: false, reason: 'phone_fragment' };
  if (/^[\w.+-]+@[\w.-]+\.\w{2,}$/.test(lo.trim()))
    return { pass: false, reason: 'email_fragment' };

  // ── Block: standalone person names (First Last format) without project context ──
  // "John Smith", "Mary Johnson" — but allow "Smith Block Building", "Johnson Library",
  // and strategic area names like "Riverfront Triangle", "Grant Creek Crossing"
  if (/^[A-Z][a-z]+\s+[A-Z][a-z]+\s*$/.test(title.trim()) && title.split(/\s+/).length === 2 &&
      !/\b(building|library|school|center|hall|facility|station|park|bridge|tower|plaza|court|triangle|crossing|corridor|commons|block|mill|yard|junction|square|depot|gateway|development|project|redevelopment)\b/i.test(lo))
    return { pass: false, reason: 'person_name_only' };

  // ── Block: page/document chrome that leaked into title ──
  // "View the FY25-26_Approved_Budget", "Click to download", file references
  if (/\b(view the|click (to|here|for)|download|log ?in|sign ?up|subscribe|print(able)?|page \d|see (more|all|details)|skip to|back to top|read more)\b/i.test(lo))
    return { pass: false, reason: 'document_chrome' };
  // "(opens in new window/tab)" or "(opens new window)" — nav chrome
  if (/\(opens?\s+(in\s+)?(a?\s*new\s+)?(window|tab)/i.test(lo))
    return { pass: false, reason: 'document_chrome' };

  // ── Block: URL fragments that leaked into title ──
  if (/^https?:\/\//i.test(lo.trim()) || /^www\./i.test(lo.trim()))
    return { pass: false, reason: 'url_fragment' };

  // ── Block: standalone date/time strings ──
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}\s*$/i.test(lo.trim()) || /^\d{1,2}:\d{2}\s*(am|pm)?\s*$/i.test(lo.trim()))
    return { pass: false, reason: 'datetime_only' };

  // ── Block: very short generic words that aren't project titles ──
  if (/^(overview|details|summary|information|more|resources|forms|links|media|photos|gallery|map|maps|search|results|listings|archive|list)\s*$/i.test(lo.trim()))
    return { pass: false, reason: 'generic_nav_word' };

  // File name fragments: "FY25-26_Approved_Budget", "2026_CIP_Report"
  if (/\b\w+_\w+_\w+\b/.test(title) && !/\b(renovation|construction|addition|expansion|replacement|modernization)\b/i.test(lo))
    return { pass: false, reason: 'file_name_fragment' };

  // ── Block: truncated mid-sentence fragments ──
  // Starts with lowercase or a conjunction/preposition (suggesting mid-sentence extraction)
  if (/^(is |are |was |were |has |have |had |being |or |and |but |for |of |with |the |a |an |to |in |on |at |by |from |that |this |which |where |when |it |its |their |our |your |if |as |so |than )/.test(lo))
    return { pass: false, reason: 'mid_sentence_fragment' };

  // Ends with "the", "a", "of", "for", "and", "or", "is" — truncated
  if (/\b(the|a|an|of|for|and|or|is|are|was|in|on|at|to|with|from|by)\s*\.{0,3}$/.test(lo))
    return { pass: false, reason: 'truncated_fragment' };

  // ── v31: Capital plan/budget/CIP headings now PASS for Watch ──
  // Capital improvement plans, CIPs, capital budgets, facilities plans, and master plans
  // are project generators. They should be Watch items, not suppressed.
  // Only block: annual reports, operating budgets, strategic plans, fiscal year documents
  // (these are admin/governance, not project generators)
  const adminHeadingMatch = /^(annual (report|budget)|operating budget|fiscal year|fy\s*\d|budget (summary|overview|document|report)|comprehensive annual|strategic plan)\b/i.test(lo) ||
    /^[\w\s&'\u2019.,()]+\s*[\u2013\u2014\-]\s*(annual (report|budget))\s*$/i.test(lo);
  if (adminHeadingMatch) {
    // Exception: if it names a specific project/facility context
    if (/\b(school|hospital|library|courthouse|fire station|police|clinic|terminal|university|college|campus|center|hall|gymnasium|auditorium|stadium|arena|pool|treatment plant|water|sewer|wastewater|facility|building|renovation|replacement|upgrade|expansion|addition|modernization|construction|capital)\b/i.test(lo) &&
        /[A-Z][a-z]{2,}/.test(title)) {
      return { pass: true };
    }
    return { pass: false, reason: 'admin_heading' };
  }

  // ── v31: Budget purpose statements — only block pure fiscal/admin language ──
  // Allow through if there's any capital/project/facility/development context
  if (/\b(purpose|purpose of|general fund|general obligation|assessed valuation|debt service|operating (fund|expenditure))\b/i.test(lo) &&
      !/\b(school|hospital|library|courthouse|fire station|police|clinic|terminal|campus|building|facility|renovation|replacement|construction|redevelopment|development|project|capital|improvement|upgrade|modernization|expansion|addition|district|bond)\b/i.test(lo))
    return { pass: false, reason: 'budget_purpose_statement' };

  // ── Block: broad construction/development mentions without a named subject ──
  // "income development is under construction on a portion of the site"
  // Must have at least one proper-noun subject OR named facility
  const hasNamedSubject = /[A-Z][a-z]{2,}/.test(title) && title.split(/\s+/).filter(w => /^[A-Z][a-z]/.test(w)).length >= 2;
  const hasNamedFacility = /\b(school|elementary|middle|high school|university|college|hospital|clinic|courthouse|library|fire station|police station|terminal|hangar|community center|recreation center|dormitory|laboratory|treatment plant|city hall|town hall|armory|auditorium|gymnasium|stadium|arena|museum|theater|senior center|wellness center)\b/i.test(lo);
  const hasProjectAction = /\b(renovation|addition|construction|expansion|replacement|modernization|remodel|upgrade|restoration|retrofit|new construction)\b/i.test(lo);

  // If the title has a project action but no named subject or facility, it's too vague for Watch
  if (hasProjectAction && !hasNamedSubject && !hasNamedFacility) {
    // Exception: specific-enough action phrases like "roof replacement" or "HVAC upgrade"
    if (/\b(roof|hvac|mechanical|electrical|plumbing|elevator|boiler|chiller|window|seismic|ada|fire (alarm|suppression|sprinkler))\b/i.test(lo))
      return { pass: true };
    return { pass: false, reason: 'no_named_subject' };
  }

  // ── Block: organizational entity names — agencies, departments, authorities ──
  // "Missoula Redevelopment Agency" is an org, not a project — BUT it's a project generator.
  // v31: Allow when title contains redevelopment/development/renewal/capital context.
  if (/\b(agency|authority|department|bureau|division|office|administration|corporation)\s*$/i.test(lo.trim()) &&
      !/\b(renovation|construction|building|facility|project|design|rfq|rfp|solicitation|plan|development|redevelopment|renewal|capital|improvement)\b/i.test(lo))
    return { pass: false, reason: 'organizational_entity' };

  // ── Block: standalone URD/TIF/district abbreviation names without a project ──
  // "Riverfront Triangle URD" is a district name, not a project.
  // "Riverfront Triangle Development" IS a project. Allow titles with development/plan/project action.
  // v30: Also allow URD/TIF when combined with area names — these are project-generator districts.
  // Only block truly bare abbreviations like "URD" or "TIF III" alone.
  if (/^(URD|TIF|TEDD|BID)\s*(I{1,3}V?|V?I{0,3}|[A-Z])?\s*$/i.test(title.trim()))
    return { pass: false, reason: 'standalone_district_name' };

  // ── Block: standalone governance / committee / board / commission names ──
  // These are organizational bodies, not projects. "Police Commission" is a body;
  // "Police Station Renovation" is a project. Block the former, allow the latter.
  const govBody = /^([\w\s.'&\u2019]+\s+)?(commission|committee|council|board|authority|task\s*force|advisory\s*(board|committee|group|panel)|work\s*(group|session)|subcommittee|caucus)(\s+(of|for|on)\s+[\w\s.'&\u2019]+)?(\s+(meeting|agenda|minutes|session|hearing|workshop|retreat|report|update))?$/i;
  if (govBody.test(lo.trim())) {
    // Exception: if it also contains a specific project/facility action word, allow it
    if (/\b(renovation|construction|expansion|addition|replacement|modernization|design|facility|building|project|bond|capital|rfq|rfp|solicitation)\b/i.test(lo))
      return { pass: true };
    return { pass: false, reason: 'governance_body_name' };
  }

  // ── Block: agenda/minutes/governance page titles without a named project ──
  if (/\b(agenda|minutes|meeting|packet|work\s*session|public\s*hearing|regular\s*session|special\s*session)\b/i.test(lo) &&
      !/\b(renovation|construction|expansion|addition|replacement|modernization|design|rfq|rfp|solicitation|bond|capital improvement|facility|building|project)\b/i.test(lo))
    return { pass: false, reason: 'governance_page_title' };

  // ── Block: generic department/office pages ──
  if (/^([\w\s.'&\u2019]+\s+)?(department|office|division|bureau|program|services?)\s*$/i.test(lo.trim()) &&
      !/\b(construction|design|capital|renovation|project|facility|building)\b/i.test(lo))
    return { pass: false, reason: 'generic_department_page' };

  // ── Block: tourism/parks/recreation/events without building scope ──
  if (/\b(tourism|visitor|festival|parade|farmer.?s?\s*market|concert|fireworks|celebration|memorial\s*day|independence\s*day|holiday|fun\s*run|5k|marathon|triathlon)\b/i.test(lo) &&
      !/\b(renovation|construction|building|facility|design|addition|expansion|terminal|center)\b/i.test(lo))
    return { pass: false, reason: 'tourism_event_page' };

  // ── Block: dated governance documents ("May 23, 2019 Police Commission Agenda") ──
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\.?\s+\d{1,2},?\s+\d{4}\b/i.test(lo.trim()) &&
      /\b(agenda|minutes|meeting|packet|hearing|session|workshop)\b/i.test(lo) &&
      !/\b(renovation|construction|building|facility|project|bond|rfq|rfp)\b/i.test(lo))
    return { pass: false, reason: 'dated_governance_document' };

  // ── Block: planning guides, permit info pages ──
  if (/\b(project planning guides?|planning guides?|permit (info|information|requirements|process|fees)|storm damage|building permit information)\b/i.test(lo) &&
      !/\b(architect|design|building|renovation|construction|facility|school|hospital|project|rfq|rfp)\b/i.test(lo))
    return { pass: false, reason: 'info_page' };

  // ── Block: assessment/report pages without a named project ──
  if (/\b(assessment report|housing assessment|needs assessment|condition assessment)\b/i.test(lo) &&
      !/\b[A-Z][a-z]{2,}\s+(school|hospital|library|courthouse|fire station|clinic|campus|building|facility)\b/.test(title))
    return { pass: false, reason: 'generic_assessment' };

  // ── Block: park/recreation/trail without building scope ──
  // Exception: "development park", "industrial park", "business park", "technology park" are redevelopment zones, not recreational parks
  if (/\b(park|recreation|trail|playground|sports? field|ball field|skate park|dog park|splash pad)\b/i.test(lo) &&
      !/\b(renovation|construction|building|facility|design|addition|expansion|community center|recreation center|pool|aquatic|pavilion|clubhouse|restroom|shelter)\b/i.test(lo) &&
      !/\b(development\s+park|industrial\s+park|business\s+park|technology\s+park|commerce\s+park|research\s+park)\b/i.test(lo))
    return { pass: false, reason: 'park_recreation_no_building' };

  // ── Block: design excellence / guidelines / overlay pages ──
  if (/\b(design (excellence|guidelines?|standards?|review|overlay)|overlay district|form.based code)\b/i.test(lo) &&
      !/\b(renovation|construction|building|facility|project|rfq|rfp)\b/i.test(lo))
    return { pass: false, reason: 'design_guidelines_page' };

  // ── Block: wedding / event venue / facility rental marketing ──
  if (/\b(get married|wedding (venue|rental|reception)|event (rental|venue|booking)|rent (the|a|an?|our) (hall|room|space|facility|building|park|center)|facility (rental|rentals)|venue (rental|rentals|hire))\b/i.test(lo))
    return { pass: false, reason: 'event_marketing' };

  // ── Block: award/stewardship names — not projects ──
  if (/\b(steward(ship)?|award|recognition|honor|hall of fame)\b/i.test(lo) &&
      !/\b(renovation|construction|building|facility|design|project|rfq|rfp)\b/i.test(lo))
    return { pass: false, reason: 'award_stewardship' };

  // ── Block: procurement schedules without a project name ──
  if (/\b(rfq|rfp|bid|solicitation)\s*[&+,]?\s*(bid\s*)?(schedule|calendar|timeline)\b/i.test(lo) &&
      !/\b(school|hospital|library|courthouse|fire station|campus|building|facility)\b/i.test(lo))
    return { pass: false, reason: 'procurement_schedule' };

  // ── Block: ISO-dated document/file references (title starts with YYYY-MM-DD) ──
  if (/^\d{4}-\d{2}-\d{2}\b/.test(lo.trim()))
    return { pass: false, reason: 'dated_document_reference' };

  // ── Block: environmental assessments without building scope ──
  if (/\b(environmental (assessment|impact|review|study)|supplemental environmental|nepa\b|eis\b)\b/i.test(lo) &&
      !/\b(building|facility|renovation|design|architect|construction)\b/i.test(lo))
    return { pass: false, reason: 'environmental_assessment' };

  // ── Block: coalition/alliance organizational names — not projects ──
  if (/\b(coalition|alliance|consortium|collaborative|network)\s*$/i.test(lo.trim()) &&
      !/\b(renovation|construction|building|facility|project|design|rfq|rfp)\b/i.test(lo))
    return { pass: false, reason: 'coalition_name' };

  // ── Block: housing/citywide strategy documents — not specific projects ──
  if (/\b(housing (strategy|program|initiative|action plan)|citywide (strategy|plan|housing)|workforce housing (program|initiative))\b/i.test(lo) &&
      !/\b(school|hospital|library|courthouse|fire station|campus|building|facility|renovation|construction|design|rfq|rfp)\b/i.test(lo))
    return { pass: false, reason: 'housing_strategy_document' };

  // ── Block: tourism BID / generic BID without building scope ──
  if (/\btourism\s+business\s+improvement\s+district\b/i.test(lo))
    return { pass: false, reason: 'tourism_bid' };
  if (/\bbusiness\s+improvement\s+district\b/i.test(lo) &&
      !/\b(renovation|construction|building|facility|design|redevelopment|opportunity)\b/i.test(lo))
    return { pass: false, reason: 'bid_no_building' };

  // ── Block: national/state park names without building scope ──
  if (/\b(national park|state park|national forest|national monument|wilderness area)\b/i.test(lo) &&
      !/\b(renovation|construction|building|facility|visitor center|lodge|design|addition|expansion)\b/i.test(lo))
    return { pass: false, reason: 'national_state_park' };

  // ── Block: vague data/smart-city project titles ──
  if (/\b(data (city|project|initiative|platform|hub)|open data|smart city|digital (city|twin|transformation))\b/i.test(lo) &&
      !/\b(building|facility|renovation|construction|design|architect)\b/i.test(lo))
    return { pass: false, reason: 'vague_data_project' };

  // ── Block: generic N-year plan headings ──
  if (/\b(new requirement|requirement)\s*:\s*\d+.year (plan|program)\b/i.test(lo) &&
      !/\b(school|hospital|building|facility|renovation|construction|design)\b/i.test(lo))
    return { pass: false, reason: 'generic_plan_heading' };

  // ── Block: generic topic/department/portal landing pages ──
  // "Community Development", "Development Center", "Project and Engineering"
  // These are source pages, not project cards. Exception: named place + development action
  // or specific block grant / project references.
  if (/^(community development|economic development|planning and development|development services|development center|planning services)\s*$/i.test(lo.trim()) &&
      !/\b(block grant|redevelopment|renovation|construction|rfq|rfp|bond)\b/i.test(lo))
    return { pass: false, reason: 'generic_topic_page' };
  if (/^(project and engineering|engineering services|public works|facilities management|building maintenance)\s*$/i.test(lo.trim()))
    return { pass: false, reason: 'generic_topic_page' };

  // ── Block: school closures, school consolidation, etc. — policy pages, not projects ──
  if (/\b(school (closur|consolidat|boundar|redistrict|report card)|closures?\s*$)\b/i.test(lo) &&
      !/\b(renovation|construction|building|facility|design|addition|expansion|replacement|rfq|rfp)\b/i.test(lo))
    return { pass: false, reason: 'policy_page' };

  // ── Block: fairground/facility rental pages ──
  if (/\b(fairground|fairgrounds|fair ground)\b/i.test(lo) && /\b(rental|rent|reservation|book|lease|event)\b/i.test(lo))
    return { pass: false, reason: 'facility_rental_page' };
  if (/\b(building rental|room rental|space rental|hall rental|rental (rates?|info|information|agreement|application|policy|policies|form))\b/i.test(lo))
    return { pass: false, reason: 'facility_rental_page' };

  // ── Block: bare geographic names without a project/development action ──
  // "Downtown Kalispell" alone is a location, not a project.
  // "Downtown Kalispell Redevelopment" IS a project — allow it.
  if (/^(downtown|uptown|midtown|northside|southside|eastside|westside|old town|central)\s+[A-Z][a-z]+\s*$/i.test(title.trim()) &&
      !/\b(development|redevelopment|renovation|construction|plan|improvement|expansion|project|program|district)\b/i.test(lo))
    return { pass: false, reason: 'bare_geographic_name' };

  // ── Block: dated reports, audits, review documents — not project cards ──
  // "2023-2024 Development Review Audit", "2021 Building Code Adoption"
  if (/^\d{4}[\s\-]+\d{4}\b/.test(lo.trim()) && /\b(review|audit|report|analysis|summary|update|assessment)\b/i.test(lo) &&
      !/\b(renovation|construction|design|rfq|rfp|facility|school|hospital)\b/i.test(lo))
    return { pass: false, reason: 'dated_report' };
  if (/^\d{4}\s+\b/.test(lo.trim()) && /\b(code (adoption|update|amendment|revision)|ordinance (adoption|update|amendment))\b/i.test(lo) &&
      !/\b(renovation|construction|design|rfq|rfp|facility|building project)\b/i.test(lo))
    return { pass: false, reason: 'code_adoption_page' };

  // ── Block: permit/statistics/FAQ/admin pages — not project cards ──
  if (/\b(permit statistics|building statistics|code enforcement statistics|inspection statistics)\b/i.test(lo))
    return { pass: false, reason: 'statistics_page' };
  if (/\b(faqs?|frequently asked|questions and answers)\b/i.test(lo) &&
      !/\b(renovation|construction|design|rfq|rfp|facility|project)\b/i.test(lo))
    return { pass: false, reason: 'faq_page' };
  if (/\b(building division|planning division|engineering division|code enforcement|inspection services)\s*$/i.test(lo.trim()) &&
      !/\b(renovation|construction|design|rfq|rfp|project)\b/i.test(lo))
    return { pass: false, reason: 'admin_division_page' };

  // ── Block: "Planning, Development and Sustainability" — department portal page ──
  if (/^(planning|development|sustainability|growth)[,\s]+(development|planning|sustainability|growth|and|&|\s)+$/i.test(lo.trim()) &&
      !/\b(renovation|construction|design|rfq|rfp|facility|building|project|block grant|redevelopment)\b/i.test(lo))
    return { pass: false, reason: 'department_portal' };

  // ── Block: "Private Development Projects", "Engage Missoula Development Applications" — portal/listing pages ──
  if (/\b(development (applications?|permits?|submittals?|filings?|review))\b/i.test(lo) &&
      !/\b(renovation|construction|design|rfq|rfp|facility|building|school|hospital|block grant)\b/i.test(lo))
    return { pass: false, reason: 'development_application_portal' };
  if (/^(private|public)\s+(development|construction)\s+(projects?|listings?|applications?)\s*$/i.test(lo.trim()))
    return { pass: false, reason: 'development_listing_portal' };

  // ── Block: storm water / pollution pages — environmental, not building scope ──
  if (/\b(storm\s*water|stormwater)\s+(pollution|runoff|management|permit|compliance|prevention)\b/i.test(lo) &&
      !/\b(renovation|construction|building|facility|design|treatment plant)\b/i.test(lo))
    return { pass: false, reason: 'stormwater_page' };

  // ── Block: bare proper-name + generic civic word — not a project ──
  // "Missoula Housing", "Flathead County Planning", "Helena Infrastructure"
  // These are topics or departments, not specific projects. Allow if project action present.
  if (/^[A-Z][\w\s.'&\u2019]+\s+(housing|planning|zoning|infrastructure|transportation|utilities|services|operations|administration|management|information|safety|compliance|personnel|staffing)\s*$/i.test(title.trim()) &&
      !/\b(renovation|construction|building|facility|design|project|rfq|rfp|bond|development|redevelopment|expansion|addition|replacement|improvement|plan)\b/i.test(lo))
    return { pass: false, reason: 'generic_civic_topic' };

  // ── Block: non-physical "development" — staff development, income development, etc. ──
  // Allow: redevelopment, development of [place], [Place] Development (with area indicator)
  if (/\b(staff|workforce|professional|economic|income|revenue|resource|software|curriculum|leadership|organizational|career|personal|talent|capacity)\s+development\b/i.test(lo) &&
      !/\b(building|facility|renovation|construction|design|rfq|rfp|redevelopment|site|campus|block|corridor|district)\b/i.test(lo))
    return { pass: false, reason: 'non_physical_development' };

  // ── Block: vague area/neighborhood references without a project action ──
  // "North Reserve Street Area", "South Hills Neighborhood", "Midtown Area"
  // These are geographic references, not projects. Allow "North Reserve Street Redevelopment".
  if (/\b(area|neighborhood|vicinity|zone|sector|precinct|ward|annexation area)\s*$/i.test(lo.trim()) &&
      !/\b(renovation|construction|building|facility|design|project|rfq|rfp|development|redevelopment|expansion|improvement|plan|bond)\b/i.test(lo))
    return { pass: false, reason: 'vague_area_reference' };

  // ── Block: titles that are just a geographic name + "update" or "report" ──
  // "Helena Update", "Billings Report", "Flathead County Update"
  if (/^[A-Z][\w\s.'&\u2019]+\s+(update|report|overview|summary|profile|snapshot|brief|bulletin|newsletter)\s*$/i.test(title.trim()) &&
      !/\b(renovation|construction|building|facility|design|project|rfq|rfp|development|bond|capital|crossing|triangle|corridor|commons|mill|yard|site|redevelopment)\b/i.test(lo))
    return { pass: false, reason: 'geographic_report_title' };

  // ── Block: "information about" / "overview of" / "guide to" filler titles ──
  if (/^(information (about|on|regarding)|overview of|guide to|introduction to|summary of|update on|status of|details (on|about|of))\s+/i.test(lo) &&
      !/\b(renovation|construction|building|facility|design|project|rfq|rfp|development|bond|capital)\b/i.test(lo))
    return { pass: false, reason: 'filler_title_prefix' };

  return { pass: true };
}

/**
 * Extract a clean project title from matched context.
 * Prefers: RFQ/RFP titles, project names, specific descriptions.
 * Falls back to: "Owner — ProjectType Signal" if context is weak.
 * Step 11: Returns null for generic fallback titles instead of fabricating them.
 */
function extractProjectTitle(ctx, src) {
  // 1. Try to find an explicit project name in quotes or after "for:"
  const quotedName = ctx.match(/[""\u201c\u201d]([^""\u201c\u201d]{10,80})[""\u201c\u201d]/);
  if (quotedName && !isNavigationJunk(quotedName[1])) return cleanTitle(quotedName[1]);

  // Try "RFQ/RFP for [Project Name]" — extract the project part
  const forClause = ctx.match(/(?:rfq|rfp|request for (?:qualifications?|proposals?))\s*(?:#\s*[\w-]+\s*)?(?:for|:|–|—)\s*([^.]{10,80})/i);
  if (forClause && !isNavigationJunk(forClause[1])) {
    const projectPart = cleanTitle(forClause[1]);
    // If the project part is informative enough, use it standalone
    if (projectPart.length >= 15 && PROJECT_TITLE_WORDS.test(projectPart)) return projectPart;
    // Otherwise prefix with RFQ/RFP context
    const prefix = /rfq/i.test(ctx) ? 'RFQ' : 'RFP';
    return `${prefix}: ${projectPart}`;
  }

  // 2. Try "Solicitation/RFQ/RFP: Title" pattern (colon-delimited)
  const colonTitle = ctx.match(/(?:rfq|rfp|solicitation|bid|invitation to bid)\s*(?:#\s*[\w-]+\s*)?:\s*([^.]{10,90})/i);
  if (colonTitle && !isNavigationJunk(colonTitle[1])) return cleanTitle(colonTitle[1]);

  // Step 14: Helper — reject truncated fragments and mid-sentence starts
  const isTitleFragment = (t) => {
    const tlo = t.toLowerCase();
    // Ends with an article/preposition (truncated mid-sentence)
    if (/\b(the|a|an|of|for|and|or|is|are|was|in|on|at|to|with|from|by)\s*\.{0,3}$/.test(tlo)) return true;
    // Starts with a lowercase connector (mid-sentence extraction)
    if (/^(is |are |was |were |has |have |had |being |or |and |but |for |of |with |to |in |on |at |by |from |that |this |which |where |when |it |its |their )/.test(tlo)) return true;
    return false;
  };

  // 3. Try the first meaningful clause of the context
  const clauses = ctx.replace(/\s+/g, ' ').trim().split(/[;—–|]/);
  for (const clause of clauses) {
    const c = cleanTitle(clause);
    if (c.length >= 15 && c.length <= 85 && !isNavigationJunk(c) && !isTitleFragment(c)) return c;
  }

  // 4. Use the full context if short enough and clean
  const clean = cleanTitle(ctx);
  if (clean.length >= 15 && clean.length <= 80 && !isNavigationJunk(clean) && !isTitleFragment(clean)) return clean;
  if (clean.length > 80 && clean.length <= 120 && !isNavigationJunk(clean)) {
    // Try to break at a natural boundary
    const breakPt = clean.lastIndexOf(' ', 77);
    return (breakPt > 40 ? clean.slice(0, breakPt) : clean.slice(0, 77)) + '...';
  }

  // 5. Generic fallback — return null to signal the caller that no project-specific
  //    title could be extracted. The caller should skip this candidate unless child
  //    enrichment provides a better title. This prevents "Org — Solicitation" noise.
  return null;
}

/**
 * Classify a lead as Active (actionable solicitation) or Watch (future signal).
 * Returns { leadClass, status }
 *   Active: RFQ, RFP, ITB, or explicit call for A/E services with a deadline
 *   Watch: Budget item, CIP entry, future project, planning signal
 */
function classifyActiveWatch(ctx) {
  const lo = (ctx || '').toLowerCase();
  // Active phrases — these must appear in the CANDIDATE's own context, not page-level keywords
  const activePhrases = [
    { p: /\brfq\b/, tag: 'rfq' },
    { p: /\brfp\b/, tag: 'rfp' },
    { p: /\binvitation to bid\b/, tag: 'itb' },
    { p: /\brequest for (?:qualifications?|proposals?)\b/, tag: 'rfq/rfp_phrase' },
    { p: /\bsolicitation\b/, tag: 'solicitation' },
    { p: /\bcall for\b.*\bservices?\b/, tag: 'call_for_services' },
    { p: /\bstatement of qualifications\b/, tag: 'soq' },
    { p: /\bsubmit(?:tal)?\s+(?:by|before|due|deadline)\b/, tag: 'submittal_deadline' },
    { p: /\bresponses?\s+(?:due|requested|accepted)\b/, tag: 'response_due' },
    { p: /\bselection\s+(?:process|committee|panel)\b/, tag: 'selection_process' },
    { p: /\bshortlist/, tag: 'shortlist' },
    { p: /\brequest for a\/e\b/, tag: 'ae_request' },
    { p: /\brequest for architect/, tag: 'architect_request' },
    { p: /\bqualification.based\s+selection\b/, tag: 'qbs' },
    { p: /\bqbs\b/, tag: 'qbs_abbr' },
  ];
  for (const { p, tag } of activePhrases) {
    if (p.test(lo)) return { leadClass: 'active_solicitation', status: 'active', reason: tag };
  }

  // NOTE: Removed page-level kws check — it was promoting every candidate on a page
  // to 'active' just because the page contained rfq/rfp/design services anywhere.
  // Classification must be based on the candidate's own context only.

  // Everything else is Watch — future project, budget item, planning signal
  return { leadClass: 'watch_signal', status: 'watch', reason: 'no_active_phrases' };
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

  // Generic category/listing/portal pages without a distinct project
  if (/\b(bid results|bid tabulation|plan holders?|planholders? list|vendor list|bidder list)\b/.test(lo)) return true;
  if (/\b(all (bids|rfps?|rfqs?|solicitations?))\b/.test(lo) && !/\bfor\b/.test(lo)) return true;
  // Portal / index / landing page titles
  if (/^(current (solicitations?|bids?|rfps?|rfqs?|opportunities)|open (solicitations?|bids?|rfps?)|bid (board|opportunities|listings?|calendar)|solicitation (list|index)|public (notices?|bids?)|procurement (opportunities|listings?))$/i.test(lo.trim())) return true;
  if (/\b(bid schedule|bid calendar|solicitation schedule|procurement calendar|public notice board)\b/i.test(lo) && !/\bfor\b/.test(lo)) return true;

  // Non-A&E supply/contractor/commodity notices
  if (/\b(janitorial|custodial|mowing|snow removal|snow plow|fuel (bid|contract)|office supplies|copier|vehicle (bid|purchase)|fleet|uniform)\b/.test(ctxLo)) return true;
  if (/\b(food service|catering|vending|pest control|elevator maintenance|hvac maintenance contract)\b/.test(ctxLo) && !/\b(design|renovation|construction|addition|facility)\b/.test(ctxLo)) return true;

  // IT, software, professional services that are not A&E
  if (/\b(software (license|purchase|upgrade|implementation)|it services|managed services|network (upgrade|services)|cybersecurity|erp|payroll|accounting services)\b/.test(ctxLo) && !/\b(design|architect|building|facility|renovation)\b/.test(ctxLo)) return true;
  if (/\b(audit(ing)? services|financial advis|legal services|insurance (broker|services)|banking services|investment services)\b/.test(ctxLo) && !/\b(design|architect|building|facility)\b/.test(ctxLo)) return true;
  // Step 15: Management/financial/HR system replacements — IT projects, not A&E
  if (/\b(management system|financial (system|management)|accounting system|hr system|payroll system|inventory system|erp system|enterprise (system|resource)|crm|asset management (system|software))\b/.test(ctxLo) && /\b(replacement|implementation|upgrade|migration|procurement)\b/.test(ctxLo) && !/\b(design|architect|building|facility|renovation|construction of)\b/.test(ctxLo)) return true;

  // Pure civil/commodity work with no building component
  // NOTE: escape clause uses "building" not "construction" or "facility" — those are too broad and let pure civil work through
  if (/\b(paving|chip seal|crack seal|striping|guardrail|culvert replacement|gravel|asphalt overlay|road (maintenance|repair|construction)|bridge\b.*?\b(repair|maintenance|replacement|rehabilitation|deck|overlay|painting)|bridge (deck|scour|rail|abutment|pier)|sidewalk|curb and gutter|storm drain|retaining wall)\b/.test(ctxLo) && !/\b(design|architect|building|renovation|addition|school|hospital|clinic|airport|terminal|fire station|police|library|courthouse)\b/.test(ctxLo)) return true;
  if (/\b(well ?drilling|pump (replacement|station)|lift station|water (main|line) (replacement|extension|construction)|sewer (main|line) (replacement|extension|construction)|manhole|hydrant|water (tank|reservoir)|sedimentation|lagoon)\b/.test(ctxLo) && !/\b(design|architect|building|renovation|addition|treatment plant|school|hospital|clinic)\b/.test(ctxLo)) return true;
  // Pipe, utility, and excavation work
  if (/\b(pipe (replacement|installation|lining|bursting)|trenchless|directional drill|utility (relocation|extension)|meter (replacement|installation))\b/.test(ctxLo) && !/\b(architect|building|renovation|facility design)\b/.test(ctxLo)) return true;

  // Demolition-only, abatement-only (no design component)
  if (/\b(demolition only|abatement only|asbestos (abatement|removal)|lead (abatement|paint removal)|hazmat)\b/.test(ctxLo) && !/\b(design|renovation|new construction|replacement|addition)\b/.test(ctxLo)) return true;

  // Security, cleaning, grounds
  if (/\b(security (guard|services|patrol)|armed guard|cleaning (services|contract)|grounds (maintenance|keeping)|landscaping (services|maintenance|contract))\b/.test(ctxLo) && !/\b(design|architect|landscape architect|renovation)\b/.test(ctxLo)) return true;

  // Sale / property / finance / levy notices that are not architectural opportunities
  if (/\b(property (for sale|sale|auction|listing)|real estate (listing|sale|auction)|tax (lien|deed) sale|foreclosure|surplus property (sale|auction))\b/.test(ctxLo)) return true;
  if (/\b(tax levy|mill levy|assessment (notice|roll)|property (tax|assessment)|tax (rate|increase))\b/.test(ctxLo) && !/\b(bond|capital improvement|facility|building|renovation|construction|school|design)\b/.test(ctxLo)) return true;
  if (/\b(budget (hearing|adoption|amendment|resolution)|appropriation (resolution|ordinance)|fiscal year (budget|appropriation))\b/.test(ctxLo) && !/\b(capital improvement|facility|building|renovation|construction|school|project)\b/.test(ctxLo)) return true;

  // Equipment-only procurement (no design scope)
  if (/\b(equipment (purchase|bid|procurement|lease)|vehicle (purchase|lease)|apparatus (purchase|bid)|fire (truck|engine|apparatus) (purchase|bid))\b/.test(ctxLo) && !/\b(design|architect|building|facility|renovation|addition|station)\b/.test(ctxLo)) return true;

  // v4-b31: Operating/admin budget items with no A&E project character
  if (/\b(operating (budget|expense|cost)|personnel (cost|budget)|salary|wages|benefits|health insurance|retirement|pension|workers.?\s*comp|wellness program|training (budget|program)|professional development|subscription|membership (fee|dues)|software (license|subscription)|office (supplies|lease|rent)|utilities?\s+(budget|cost)|fuel (budget|cost)|fleet (maintenance|replacement)|vehicle (maintenance|replacement))\b/.test(ctxLo) && !/\b(design|architect|building|facility|renovation|construction|addition|expansion|capital improvement|new (building|facility|school|station|campus))\b/.test(ctxLo)) return true;

  // Permits, regulatory, and administrative — not A&E project signals
  if (/\b(building permit|commercial permit|residential permit|permit (application|fee|process|requirement)|permit renewal)\b/i.test(ctxLo) && !/\b(design|architect|renovation|construction of|new (building|facility|school|station))\b/.test(ctxLo)) return true;
  if (/\b(weed control|weed district|noxious weed|mosquito control|mosquito district|pest district)\b/i.test(ctxLo)) return true;
  if (/\b(hazard mitigation plan|hazard mitigation update|pre-?disaster mitigation|threat assessment|risk assessment plan|emergency management plan)\b/i.test(ctxLo) && !/\b(design|architect|building|facility|renovation|shelter|safe room|fire station)\b/.test(ctxLo)) return true;
  // Right-of-way research/clearing is not A&E scope
  if (/\b(right.of.way|r\.?o\.?w\.?\b|public right of way|property right.of.way|easement (acquisition|research|review))\b/i.test(ctxLo) && !/\b(design|architect|building|facility|renovation|improvement project)\b/.test(ctxLo)) return true;

  // v31e: Heritage/interpretive and community partnerships are now TAXONOMY-DRIVEN
  // RETIRED: TAX-NOI-014 (Heritage / Interpretive / Cultural) and TAX-NOI-017 (Community / Development Partnership)
  // These are now handled by matchTaxonomy() at extraction time.
  // Elevator/escalator — service contracts, not A&E design
  // v30: Relaxed — elevator/escalator modernization/replacement in named buildings may need A&E.
  // Only suppress if clearly a maintenance contract with NO building/facility context.
  if (/\b(elevator|escalator)\b/i.test(ctxLo) && /\b(maintenance|service|inspection)\b/i.test(ctxLo) &&
      !/\b(modernization|replacement|upgrade|refurbish|design\s+services|architect|a\/e|new\s+(building|facility)|building\s+design|renovation|capital|project)\b/.test(ctxLo)) return true;
  // MEP equipment-only replacements — boiler, fire alarm, HVAC, generator
  // v30: Relaxed — replacement/upgrade in named buildings may need engineering design.
  // Only suppress if clearly maintenance/service with NO building/project/capital context.
  if (/\b(boiler|fire\s+alarm|fire\s+suppression|sprinkler\s+system|generator|hvac\s+(unit|system|equipment)|chiller|cooling\s+tower)\b/i.test(ctxLo) && /\b(maintenance|service|inspection)\b/i.test(ctxLo) &&
      !/\b(replacement|upgrade|design\s+services|architect|a\/e|renovation|addition|new\s+(building|facility)|remodel|expansion|capital|project)\b/.test(ctxLo)) return true;
  // Walking/guided tours — tourism, not A&E
  if (/\b(walking\s+tour|self[\-\s]guided\s+tour|audio\s+tour|guided\s+tour|heritage\s+tour|historic\s+(district\s+)?tour)\b/i.test(ctxLo)) return true;
  // Business development — non-physical
  if (/\b(business\s+development|new\s+business|business\s+retention|business\s+attraction|business\s+recruitment)\b/i.test(ctxLo) && !/\b(renovation|construction|building|facility|design|rfq|rfp|campus|center|office\s+building)\b/.test(ctxLo)) return true;
  // CDBG/grant "Program" pages — admin, not a project
  if (/\b(block\s+grant|cdbg)\b/i.test(ctxLo) && /\bprogram\b/i.test(ctxLo) && !/\b(renovation|construction|design|rfq|rfp|facility|project|school|hospital)\b/.test(ctxLo)) return true;
  // Standalone brownfields titles
  // v30: Relaxed — brownfields redevelopment is a legitimate project generator for A&E.
  // Only suppress pure brownfields cleanup/assessment/remediation without redevelopment/development/project context.
  if (/\b(brownfield|brownfields)\s*(cleanup|assessment|remediation)\b/i.test(lo) && !/\b(design|architect|building|facility|renovation|rfq|rfp|school|hospital|redevelopment|development|project|capital)\b/.test(ctxLo)) return true;

  // Extremely short/generic titles that slipped through junk filter
  if (/^(home|about|news|events|contact|board|staff|resources|documents|calendar|agenda|minutes)$/i.test(lo.trim())) return true;

  return false;
}

/**
 * Classify a document as strategy/retrospective vs. procurement/project.
 * Strategy documents (CEDS, annual reports, strategic plans, master plans,
 * economic development reports) should not generate normal leads from
 * named initiatives alone — they are intelligence context, not procurement feeds.
 *
 * Returns { isStrategy, documentType, signals[] }
 */
function classifyDocumentType(content) {
  if (!content || content.length < 200) return { isStrategy: false, documentType: 'unknown', signals: [] };
  const lo = content.toLowerCase();
  const signals = [];

  // ── Strong strategy-document indicators ──
  // CEDS / Comprehensive Economic Development Strategy
  if (/\bcomprehensive\s+economic\s+development\s+strategy\b/.test(lo) || /\bceds\b/.test(lo) && /\beconomic\s+development\b/.test(lo)) {
    signals.push('ceds');
  }
  // Annual report / year in review
  if (/\bannual\s+report\b/.test(lo) && (/\bfiscal\s+year\b/.test(lo) || /\byear\s+in\s+review\b/.test(lo) || /\baccomplishments?\b/.test(lo))) {
    signals.push('annual_report');
  }
  // Strategic plan document (not just a mention)
  if (/\bstrategic\s+plan\b/.test(lo) && (/\bgoals?\s+(?:and\s+)?(?:objectives?|strategies|priorities|actions?)\b/.test(lo) || /\bvision\b/.test(lo) && /\bmission\b/.test(lo))) {
    signals.push('strategic_plan');
  }
  // Implementation plan / action plan (community-level)
  if (/\bimplementation\s+(?:plan|strategy|framework)\b/.test(lo) && /\b(?:goals?|objectives?|strategies|priorities|action\s+items?)\b/.test(lo) && /\b(?:community|economic|workforce|regional)\b/.test(lo)) {
    signals.push('implementation_plan');
  }
  // Economic development report / plan
  if (/\beconomic\s+development\b/.test(lo) && (/\b(?:strategic|comprehensive|annual|five.year|ten.year|long.term)\s+(?:plan|report|strategy)\b/.test(lo) || /\bswot\b/.test(lo) || /\bstakeholder\b/.test(lo) && /\binput\b/.test(lo))) {
    signals.push('economic_development_plan');
  }
  // Community master plan / comprehensive plan (document-level, not project-level)
  if (/\b(?:comprehensive|community|growth)\s+(?:master\s+)?plan\b/.test(lo) && (/\bland\s+use\b/.test(lo) || /\bzoning\b/.test(lo) || /\bfuture\s+development\b/.test(lo) || /\bgoals?\s+(?:and\s+)?(?:policies|objectives)\b/.test(lo))) {
    signals.push('community_master_plan');
  }
  // District plans / corridor plans
  if (/\b(?:district|corridor|downtown|neighborhood)\s+plan\b/.test(lo) && (/\bvision\b/.test(lo) || /\bgoals?\s+(?:and\s+)?(?:objectives?|strategies|policies)\b/.test(lo)) && content.length > 3000) {
    signals.push('district_plan');
  }
  // Retrospective / accomplishments / progress report
  if (/\b(?:accomplishments?|achievements?|milestones?|progress\s+report|year\s+in\s+review|highlights?)\b/.test(lo) && /\b(?:fiscal\s+year|fy\s*\d|calendar\s+year|\d{4}\s+(?:annual|report|review))\b/.test(lo)) {
    signals.push('retrospective');
  }
  // Funding / priority list (community direction, not procurement)
  if (/\b(?:priority|priorities)\s+(?:list|projects?|initiatives?|areas?)\b/.test(lo) && /\b(?:community|economic|regional|strategic)\b/.test(lo) && !/\b(?:rfq|rfp|solicitation|invitation\s+to\s+bid)\b/.test(lo)) {
    signals.push('priority_list');
  }

  // ── Determine if this is a strategy document ──
  // Require at least 1 strong signal AND absence of active procurement language
  const hasProcurement = /\b(?:rfq|rfp|invitation\s+to\s+bid|request\s+for\s+(?:qualifications?|proposals?)|solicitation\s+#|bid\s+#|submit\s+(?:qualifications?|proposals?)\s+by|due\s+date|closing\s+date|selection\s+committee)\b/.test(lo);

  const isStrategy = signals.length >= 1 && !hasProcurement;

  return {
    isStrategy,
    documentType: signals.length > 0 ? signals[0] : 'standard',
    signals,
  };
}

// ── Entity+location matching — module scope ──
// Used by both Asana matching AND scan dedup to detect same-facility same-town matches.
const FACILITY_BIGRAMS = [
  'fire station','police station','sheriff office','city hall','town hall',
  'community center','recreation center','senior center','civic center',
  'medical center','health center','health clinic','dental clinic',
  'treatment plant','water treatment','wastewater treatment',
  'airport terminal','bus terminal','transit center',
  'school district','high school','middle school','elementary school',
  'student housing','student center','science center','technology center',
  'parking garage','parking structure','maintenance shop','maintenance facility',
  'combination facility','public works','justice center','detention center',
  'swimming pool','aquatic center','ice arena','sports complex',
  'roof replacement','elevator replacement','elevator modernization',
  'hvac replacement','boiler replacement','mechanical upgrade',
];
const KNOWN_LOCATIONS = [
  'missoula','kalispell','whitefish','columbia falls','polson','hamilton',
  'helena','east helena','bozeman','belgrade','billings','great falls',
  'butte','anaconda','deer lodge','livingston','red lodge','lewistown',
  'miles city','glendive','sidney','wolf point','havre','glasgow',
  'cut bank','shelby','libby','thompson falls','superior','dillon',
  'ronan','stevensville','florence','lolo','frenchtown','bonner',
  'bigfork','lakeside','somers','boise','nampa','meridian',
  'idaho falls','pocatello','spokane','pullman','walla walla',
  'kennewick','richland','pasco','wenatchee','yakima',
];
function extractEntLoc(title) {
  if (!title) return { entities: [], locations: [] };
  const lo = title.toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
  const entities = [];
  for (const b of FACILITY_BIGRAMS) { if (lo.includes(b)) entities.push(b); }
  const locations = [];
  for (const loc of KNOWN_LOCATIONS) { if (lo.includes(loc)) locations.push(loc); }
  return { entities, locations };
}
function entityLocationMatch(sigA, sigB) {
  if (sigA.entities.length === 0 || sigB.entities.length === 0) return false;
  const sharedEntities = sigA.entities.filter(e => sigB.entities.includes(e));
  if (sharedEntities.length === 0) return false;
  // Shared entity + shared location = match
  const sharedLocs = sigA.locations.filter(l => sigB.locations.includes(l));
  if (sharedLocs.length > 0) return true;
  // Shared entity + at least one side has no location (generic title) = match
  if (sigA.locations.length === 0 || sigB.locations.length === 0) return true;
  // Both have locations but no overlap = different towns = NOT a match
  return false;
}

/**
 * Check if a lead's context indicates the project is already claimed —
 * already awarded, already has a designer/contractor, under construction,
 * or completed. These should not be promoted as new leads.
 *
 * Accepts multiple context strings and checks all of them. This allows
 * callers to pass narrow context (sentence), wide context (surrounding page),
 * and child-document content together for comprehensive detection.
 *
 * Returns { isClaimed, reason, detail } or { isClaimed: false }
 */
function isAlreadyClaimed(title, ...contexts) {
  // Merge all context strings into one searchable block
  const lo = contexts.map(c => (c || '')).join(' ').toLowerCase();
  const tlo = (title || '').toLowerCase();

  // ── Procurement escape: if context clearly contains an OPEN solicitation, skip claimed checks ──
  // This prevents false suppression when a page describes both past work and a new open RFQ/RFP.
  const hasOpenSolicitation = /\b(?:rfq|rfp|invitation\s+to\s+bid|request\s+for\s+(?:qualifications?|proposals?))\s*(?:#\s*\w+[-\d]*\s*)?(?:for|:|–|—)\s/.test(lo) ||
    /\b(?:submit\s+(?:qualifications?|proposals?|statements?)\s+(?:by|before|no\s+later))\b/.test(lo) ||
    /\b(?:solicitation\s+(?:is\s+)?(?:now\s+)?open|currently\s+(?:seeking|soliciting|accepting))\b/.test(lo);

  // ── Already awarded to a specific entity ──
  if (/\b(?:awarded\s+to|contract\s+awarded\s+to|contract\s+(?:has\s+been\s+)?awarded|award(?:ed)?\s+(?:the\s+)?contract)\b/.test(lo) ||
      /\b(?:selected\s+(?:firm|team|consultant|contractor|vendor|architect|designer|engineer))\b/.test(lo) ||
      /\b(?:firm\s+(?:has\s+been\s+)?selected|team\s+(?:has\s+been\s+)?selected)\b/.test(lo)) {
    if (!/\b(?:to\s+be\s+awarded|will\s+be\s+awarded|pending\s+award|award\s+pending)\b/.test(lo)) {
      if (hasOpenSolicitation) return { isClaimed: false };
      return { isClaimed: true, reason: 'awarded_to_entity', detail: 'Contract awarded or firm/team selected' };
    }
  }

  // ── Already has a designer/architect (broad patterns) ──
  // NOTE: No trailing \b — patterns ending with [A-Z] match the first letter of a firm name,
  // and \b would fail because the next char is also a letter.
  const designerMatch =
    /\b(?:designed\s+by|design(?:ed)?\s+by|architect\s+of\s+record|project\s+architect\s*[:\s])\b/i.test(lo) ||
    /\b(?:architect|designer|design\s+team|design\s+firm|a\/e\s+firm|a\/e\s+team|a\/e\s+consultant|a\/e|architectural\s+firm|architectural\s+team|architectural\s+consultant|design\s+consultant)\s*[:\u2013\u2014\-]\s*[A-Z]/i.test(lo) ||
    /\barchitect(?:s)?\s+(?:is|are|was|were)\s+\w/i.test(lo) ||
    /\b(?:designer|design\s+(?:firm|team|consultant))\s+(?:is|was|selected)\b/i.test(lo) ||
    /\ba\/e\s+(?:firm|team|consultant)\s+(?:is|was|selected)\b/i.test(lo) ||
    /\bdesign.?build(?:er|(?:\s+(?:firm|team|contractor)))\s*[:\u2013\u2014\-]\s*[A-Z]/i.test(lo);
  if (designerMatch) {
    if (!/\b(?:seeking|needed|required|wanted|looking\s+for|select(?:ing)?)\b/i.test(lo)) {
      if (hasOpenSolicitation) return { isClaimed: false };
      return { isClaimed: true, reason: 'has_designer', detail: 'Architect/designer identified or selected' };
    }
  }

  // ── Already has an engineer of record ──
  const engineerMatch =
    /\bengineer\s+of\s+record\b/i.test(lo) ||
    /\b(?:engineer|engineering\s+firm|engineering\s+team|engineering\s+consultant)\s*[:\u2013\u2014\-]\s*[A-Z]/i.test(lo) ||
    /\bengineering\s+(?:firm|team|consultant)\s+(?:is|was|selected)\b/i.test(lo) ||
    /\bengineer\s+(?:is|was|selected)\b/i.test(lo);
  if (engineerMatch) {
    if (!/\b(?:seeking|needed|required|wanted|looking\s+for)\b/i.test(lo)) {
      if (hasOpenSolicitation) return { isClaimed: false };
      return { isClaimed: true, reason: 'has_engineer', detail: 'Engineer of record identified' };
    }
  }

  // ── Already has a contractor / CM / CMAR / GC ──
  const contractorMatch =
    /\b(?:contractor|general\s+contractor)\s*[:\u2013\u2014\-]\s*[A-Z]/i.test(lo) ||
    /\b(?:contractor|general\s+contractor)\s+(?:is|was|selected)\b/i.test(lo) ||
    /\b(?:gc|cm|cm\/gc|cmar|cmgc|design.?build(?:er)?)\s*[:\u2013\u2014\-]\s*[A-Z]/i.test(lo) ||
    /\b(?:construction\s+(?:manager|management))\s*[:\u2013\u2014\-]\s*[A-Z]/i.test(lo) ||
    /\b(?:cm|construction\s+manager)\s+(?:firm|team)\s+(?:is|was|selected)\b/i.test(lo) ||
    /\b(?:built\s+by|constructed\s+by)\b/i.test(lo) ||
    /\bconstruction\s+(?:by|contractor)\s*[:\u2013\u2014\-]?\s*(?:is|was)\b/i.test(lo) ||
    /\bconstruction\s+contractor\s*[:\u2013\u2014\-]\s*[A-Z]/i.test(lo);
  if (contractorMatch) {
    if (!/\b(?:seeking|needed|required|soliciting|looking\s+for|select(?:ing)?)\b/i.test(lo)) {
      if (hasOpenSolicitation) return { isClaimed: false };
      return { isClaimed: true, reason: 'has_contractor', detail: 'Contractor/CM/GC identified or selected' };
    }
  }

  // ── Already under construction ──
  if (/\b(?:under\s+construction|construction\s+(?:is\s+)?underway|construction\s+(?:has\s+)?(?:begun|began|started|commenced)|broke\s+ground|groundbreaking\s+(?:was|held|ceremony|event)|currently\s+(?:under\s+construction|being\s+(?:built|constructed|renovated))|construction\s+(?:is\s+)?in\s+progress|(?:is|are)\s+(?:currently\s+)?under\s+construction)\b/.test(lo)) {
    if (!/\b(?:new\s+phase|phase\s+[2-9]|next\s+phase|additional\s+scope|expansion\s+of|future\s+phase)\b/.test(lo)) {
      if (hasOpenSolicitation) return { isClaimed: false };
      return { isClaimed: true, reason: 'under_construction', detail: 'Construction underway or groundbreaking held' };
    }
  }

  // ── Already completed ──
  if (/\b(?:project\s+complet(?:ed|ion)|construction\s+complet(?:ed|ion)|(?:was|has\s+been)\s+completed|completed\s+in\s+\d{4}|opened\s+in\s+\d{4}|ribbon[\s\-]cutting|grand\s+opening|(?:was|has\s+been)\s+(?:finished|built|constructed|renovated|remodeled)|now\s+(?:open|complete|operational)|substantially\s+complete)\b/.test(lo)) {
    if (!/\b(?:new\s+phase|phase\s+[2-9]|next\s+phase|additional|upcoming|future\s+phase)\b/.test(lo)) {
      if (hasOpenSolicitation) return { isClaimed: false };
      return { isClaimed: true, reason: 'completed', detail: 'Project completed or opened' };
    }
  }

  // ── Project team section (multiple roles named) ──
  // If context names 2+ team roles, the project team is assembled — not an open pursuit
  const teamRoles = [
    /\b(?:architect|architectural\s+firm)\s*[:\u2013\u2014\-]\s*[A-Z]/i,
    /\b(?:contractor|general\s+contractor|gc)\s*[:\u2013\u2014\-]\s*[A-Z]/i,
    /\b(?:engineer(?:ing)?(?:\s+firm)?)\s*[:\u2013\u2014\-]\s*[A-Z]/i,
    /\b(?:cm|cmar|cmgc|construction\s+manager)\s*[:\u2013\u2014\-]\s*[A-Z]/i,
    /\b(?:design.?build(?:er)?)\s*[:\u2013\u2014\-]\s*[A-Z]/i,
    /\b(?:owner(?:'s)?\s+rep(?:resentative)?)\s*[:\u2013\u2014\-]\s*[A-Z]/i,
  ];
  const rolesFound = teamRoles.filter(r => r.test(lo)).length;
  if (rolesFound >= 2) {
    if (!/\b(?:seeking|needed|required|soliciting|looking\s+for|select(?:ing)?)\b/.test(lo)) {
      if (hasOpenSolicitation) return { isClaimed: false };
      return { isClaimed: true, reason: 'project_team_assembled', detail: `${rolesFound} team roles named — project team already assembled` };
    }
  }

  // ── Title starts with completed/awarded prefix ──
  if (/^(?:completed|awarded|closed|expired|archived|past|existing)[:\s]/i.test(tlo)) {
    return { isClaimed: true, reason: 'completed_prefix', detail: 'Title begins with completion/award prefix' };
  }

  // v4-b14: Standalone status labels — CivicEngage and similar pages show status as a label
  // "Status: Awarded", "Awarded", "Solicitation Period Closed", "Closed", etc.
  // These appear near the project title in the page content, not necessarily as "awarded to [firm]"
  if (/\b(?:status\s*:\s*awarded|status\s*:\s*closed|solicitation\s+(?:period\s+)?closed|bid\s+(?:period\s+)?closed|submission\s+(?:period\s+)?closed|no\s+longer\s+accepting)\b/i.test(lo)) {
    if (hasOpenSolicitation) return { isClaimed: false };
    return { isClaimed: true, reason: 'status_closed', detail: 'Solicitation status shows Awarded or Closed' };
  }
  // Standalone "Awarded" near the title (within first 500 chars of context — likely a status field)
  const nearTitle = lo.slice(0, 500);
  if (/\bawarded\b/i.test(nearTitle) && !/\b(?:to\s+be\s+awarded|will\s+be\s+awarded|pending|not\s+yet|awaiting)\b/i.test(nearTitle)) {
    // Only suppress if the word "Awarded" appears close to the title (status-like position)
    // and the context does NOT contain open solicitation language
    if (hasOpenSolicitation) return { isClaimed: false };
    return { isClaimed: true, reason: 'status_awarded', detail: 'Awarded status detected near project title' };
  }

  return { isClaimed: false };
}

/**
 * Detect if content appears to be a multi-project listing/index page
 * rather than a single-project page. Returns true if the content
 * has many distinct solicitation/project items listed.
 */
function isListingPage(content, childLinks) {
  if (!content || content.length < 200) return false;
  const lo = content.toLowerCase();

  // Count distinct solicitation-like entries (RFQ #xxx, RFP #xxx, Bid #xxx, Solicitation #xxx)
  const solicitationRefs = lo.match(/\b(rfq|rfp|bid|solicitation|itb)\s*#?\s*\d[\w-]*/gi) || [];
  const uniqueRefs = new Set(solicitationRefs.map(r => r.replace(/\s+/g, '').toLowerCase()));
  if (uniqueRefs.size >= 4) return true;

  // Count "invitation to bid" / "request for" occurrences
  const invitations = lo.match(/\b(invitation to bid|request for (qualifications?|proposals?))\b/gi) || [];
  if (invitations.length >= 4) return true;

  // Count distinct "Due Date:" or "Close Date:" entries (bid listings have many)
  const dueDates = lo.match(/\b(due date|close date|closing date|deadline)\s*:/gi) || [];
  if (dueDates.length >= 3) return true;

  // Count distinct project-like headings or bullet entries
  const projectBullets = lo.match(/(?:^|\n)\s*(?:\d+[\.\)]\s*|•\s*|–\s*|—\s*)(?:rfq|rfp|bid|project|construction|renovation|replacement|improvement)\b/gim) || [];
  if (projectBullets.length >= 4) return true;

  // v32b: Count solicitation-type CHILD LINKS — if the page has 3+ solicitation/project links,
  // it's a listing page even if the body text doesn't match the patterns above.
  // This catches pages like Coeur d'Alene Bid Solicitations where projects are all <a> links.
  if (childLinks && childLinks.length > 0) {
    const solLinks = childLinks.filter(cl =>
      cl.linkType === 'solicitation_detail' || cl.linkType === 'project_detail' ||
      /\b(rfq|rfp|soq|bid|solicitation)\b/i.test(cl.anchorText)
    );
    if (solLinks.length >= 3) return true;
  }

  // Count multiple distinct RFQ/RFP/BID/SOQ mentions in text (without # numbers)
  const solMentions = lo.match(/\b(rfq|rfp|soq|bid)\s*[-–—:]\s*[a-z]/gi) || [];
  if (solMentions.length >= 3) return true;

  // v3.5: Meeting/agenda portals with multiple meeting links
  if (childLinks && childLinks.length > 0) {
    const meetingLinks = childLinks.filter(cl =>
      cl.linkType === 'meeting_document' || /\b(agenda|minutes|packet|meeting)\b/i.test(cl.anchorText)
    );
    if (meetingLinks.length >= 3) return true;
  }

  // Page title/heading patterns that indicate a listing/portal
  if (/\b(bid solicitations?|current (bids?|solicitations?|rfps?|rfqs?)|open (bids?|solicitations?))\b/i.test(lo) &&
      (lo.match(/\b(rfq|rfp|bid|soq|solicitation)\b/gi) || []).length >= 2) return true;

  return false;
}

/**
 * Check if a lead title looks like a portal/listing fragment rather than
 * a specific project name. These are titles that identify a PAGE or CATEGORY
 * rather than an identifiable project.
 */
function isPortalFragmentTitle(title) {
  const lo = (title || '').toLowerCase().trim();

  // Generic portal/listing titles
  if (/^(current|open|active|closed|awarded|pending)\s+(solicitations?|bids?|rfps?|rfqs?|opportunities|projects?|listings?)$/i.test(lo)) return true;
  if (/^(solicitations?|bids?|rfps?|rfqs?|opportunities|procurement)\s+(list|index|page|board|calendar|schedule|archive)$/i.test(lo)) return true;
  if (/^(public (works?|notices?|bids?)|bid (board|opportunities)|procurement (portal|page))$/i.test(lo)) return true;

  // Titles that are just organizational names with generic suffixes
  if (/^[\w\s&'\u2019.,()]+\s*[\u2013\u2014\-]\s*(solicitations?|bids?|rfps?|rfqs?|opportunities|procurement|public notices?)$/i.test(lo)) return true;

  // Titles that are just dates, numbers, or meeting references
  if (/^(meeting|agenda|minutes|packet|resolution|ordinance)\s+/i.test(lo) && !/\b(renovation|construction|building|facility|addition|expansion|project)\b/i.test(lo)) return true;

  return false;
}

/**
 * Check if a candidate has enough architectural-scope evidence to be
 * a real A&E pursuit lead. Returns true if there is at least some
 * building/design/facility signal.
 */
function hasArchitecturalScope(ctx, market) {
  const lo = (ctx || '').toLowerCase();

  // Markets that inherently involve buildings — always pass
  const buildingMarkets = ['K-12', 'Higher Education', 'Healthcare', 'Civic', 'Public Safety',
    'Housing', 'Hospitality', 'Recreation', 'Commercial', 'Mixed Use', 'Research / Lab', 'Tribal'];
  if (buildingMarkets.includes(market)) return true;

  // Airports: pass if terminal/hangar/building scope, not just runway/taxiway
  if (market === 'Airports / Aviation') {
    return /\b(terminal|hangar|building|facility|renovation|addition|fbo)\b/i.test(lo);
  }

  // Infrastructure: only pass if there's a building/facility component
  if (market === 'Infrastructure') {
    return /\b(treatment (plant|facility)|building|architect|facility (design|renovation|addition)|pump (house|building)|control (building|room))\b/i.test(lo);
  }

  // For Other / unknown markets, require explicit building/design/A&E evidence
  // OR redevelopment/planning/housing/capital signals that imply future A&E work
  // v31: Added replacement, upgrade, modernization, deferred maintenance, CIP for budget-derived items
  return /\b(architect|building|facility|renovation|addition|remodel|interior|design services|a\/e|construction of (?:a |the )?(?:new )?(?:building|facility|school|clinic|station|center|library|courthouse)|floor plan|square (feet|foot|ft)|sf\b|redevelopment|mixed.use|housing units?|development (?:plan|agreement|project)|urban renewal|master plan|capital (?:improvement|project|budget)|campus|dormitor|civic center|community center|town hall|city hall|replacement|upgrade|modernization|deferred maintenance|cip\b|adopted budget|preliminary budget|bond (program|measure|issue))/i.test(lo);
}

/**
 * Simple word-overlap similarity (Jaccard-like) for near-duplicate detection.
 * Returns 0-1 score. Filters stop words for better accuracy.
 */
function titleSimilarity(titleA, titleB) {
  const STOP = new Set(['the','and','for','from','with','this','that','are','was','will','has',
    'have','been','its','our','new','all','project','county','city','state','montana','of','in','at','on','to','by','a','an']);
  const words = (t) => (t || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
  const wa = new Set(words(titleA));
  const wb = new Set(words(titleB));
  if (wa.size < 2 || wb.size < 2) return 0;
  let i = 0;
  for (const w of wa) if (wb.has(w)) i++;
  return i / new Set([...wa, ...wb]).size;
}

/**
 * Extract dates from context: due dates for solicitations, timeline signals for projects.
 * Returns { action_due_date, potentialTimeline }
 */
function extractDates(ctx) {
  const result = { action_due_date: '', potentialTimeline: '' };
  if (!ctx) return result;

  // 1. Try to find explicit due/deadline dates — broadened patterns
  const duePats = [
    /(?:due|deadline|submit(?:tal)?s?\s+(?:by|before|due|deadline)|responses?\s+(?:due|by)|closes?|soq\s+(?:due|deadline|submittal))\s*:?\s*(\w+\s+\d{1,2},?\s*\d{4})/i,
    /(?:due|deadline|submit(?:tal)?s?\s+(?:by|before|due|deadline)|responses?\s+(?:due|by)|closes?|soq\s+(?:due|deadline|submittal))\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
    /(?:due|deadline)\s*:?\s*(\w+\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{4})/i,
    // "Submittal Deadline: March 28, 2026" or "Submission Date: 4/15/2026"
    /(?:submittal|submission|response)\s+(?:deadline|date|due)\s*:?\s*(\w+\s+\d{1,2},?\s*\d{4})/i,
    /(?:submittal|submission|response)\s+(?:deadline|date|due)\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
    // "Proposals are due March 28, 2026"
    /(?:proposals?|qualifications?|statements?)\s+(?:are\s+)?due\s+(\w+\s+\d{1,2},?\s*\d{4})/i,
    // "Close Date: March 28, 2026"
    /(?:close|closing|end)\s+date\s*:?\s*(\w+\s+\d{1,2},?\s*\d{4})/i,
    /(?:close|closing|end)\s+date\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
    // "Responses must be received by March 28, 2026"
    /(?:must be received|must be submitted|to be received|to be submitted)\s+(?:by|before|no later than)\s+(\w+\s+\d{1,2},?\s*\d{4})/i,
    /(?:must be received|must be submitted|to be received|to be submitted)\s+(?:by|before|no later than)\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
    // "no later than March 28, 2026" or "on or before March 28, 2026"
    /(?:no later than|on or before)\s+(\w+\s+\d{1,2},?\s*\d{4})/i,
    /(?:no later than|on or before)\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
    // ISO-format dates near due context: "Due: 2026-03-28"
    /(?:due|deadline|close)\s*:?\s*(\d{4}-\d{2}-\d{2})/i,
    // "due by [time] on March 28, 2026"
    /due\s+(?:by\s+)?\d{1,2}:\d{2}\s*(?:am|pm|[AP]\.?M\.?)?\s+(?:on\s+)?(\w+\s+\d{1,2},?\s*\d{4})/i,
  ];
  // Collect ALL matching dates, then pick the best (nearest future date)
  const now = new Date();
  const minDate = new Date('2024-01-01');
  const candidateDates = [];
  for (const pat of duePats) {
    const m = ctx.match(pat);
    if (m) {
      const parsed = new Date(m[1]);
      if (!isNaN(parsed.getTime()) && parsed > minDate) {
        candidateDates.push(parsed);
      }
    }
  }
  // Pick the nearest future date; if none are future, pick the most recent past date
  if (candidateDates.length > 0) {
    const futureDates = candidateDates.filter(d => d >= now).sort((a, b) => a - b);
    const bestDate = futureDates.length > 0 ? futureDates[0] : candidateDates.sort((a, b) => b - a)[0];
    result.action_due_date = bestDate.toISOString().split('T')[0];
  }

  // 2. Try to find timeline signals
  const tlPats = [
    /(?:design\s+(?:start|begin)|a\/e\s+selection|architect\s+selection)\s*(?:in|by|:)?\s*(Q[1-4]\s*\d{4}|\w+\s*\d{4})/i,
    /(?:construction\s+(?:start|begin))\s*(?:in|by|:)?\s*(Q[1-4]\s*\d{4}|\w+\s*\d{4}|spring|summer|fall|winter\s*\d{4})/i,
    /(?:project\s+(?:timeline|schedule))\s*:?\s*([^.]{10,60})/i,
    /(?:anticipated|expected|planned)\s+(?:start|completion|opening|solicitation|rfq|rfp)\s*:?\s*([^.]{5,40})/i,
    /(?:construction\s+(?:completion|complete|finish))\s*:?\s*([^.]{5,40})/i,
    /(?:occupancy|move.in|substantial completion)\s*:?\s*([^.]{5,40})/i,
    // "Bond election November 2026", "Voter approval Spring 2026"
    /(?:bond\s+election|voter\s+approval|ballot\s+measure)\s*:?\s*(\w+\s*\d{4})/i,
    // "Bid opening: March 28, 2026"
    /(?:bid\s+opening|pre-bid\s+(?:conference|meeting))\s*:?\s*(\w+\s+\d{1,2},?\s*\d{4})/i,
    // "Selection: Q2 2026" or "Award: Spring 2026"
    /(?:selection|award|contract award)\s*:?\s*(Q[1-4]\s*\d{4}|\w+\s*\d{4})/i,
    /(Q[1-4]\s*20[2-3]\d)/i,
    /(?:FY|fiscal year)\s*(20[2-3]\d)/i,
    // Fiscal year ranges: "FY2026-2027", "FY 2025-26"
    /(?:FY|fiscal year)\s*(20[2-3]\d\s*[-–]\s*(?:20)?[2-3]\d)/i,
    // "Planned for 2026" or "Scheduled for Spring 2027"
    /(?:planned|scheduled|programmed|budgeted)\s+(?:for|in)\s+((?:spring|summer|fall|winter|early|late|mid)?\s*20[2-3]\d)/i,
    // v4-b9: Redevelopment status signals
    /(?:approved|adopted|amended|extended)\s+(?:in|on|by)\s*:?\s*(\w+\s*\d{1,2},?\s*\d{4}|\w+\s*\d{4})/i,
    /(?:tif|urd|district)\s+(?:expires?|sunset|extended? (?:to|through|until))\s*:?\s*(\d{4}|[^.]{5,30})/i,
    // "Under review" / "Pending approval" / "In design phase"
    /(?:currently|presently)\s+(under\s+(?:review|design|construction|development)|in\s+(?:design|planning|construction)\s+phase|pending\s+(?:approval|review|funding))/i,
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
    /(?:budget|estimated\s+cost|project\s+cost|estimated\s+value|construction\s+cost|total\s+cost)\s*(?:of|:)?\s*\$\s*([\d,.]+[mkb]?(?:\s*(?:–|-|to)\s*\$?\s*[\d,.]+[mkb]?)?)/i,
    // "$1.2M" or "$500K" shorthand
    /\$\s*([\d,.]+)\s*([MK])\b/,
    /\$\s*([\d,]+(?:\.\d+)?)/,
  ];
  for (const pat of budgetPats) {
    const m = ctx.match(pat);
    if (m) {
      // Normalize to readable format
      if (/million|mil/i.test(m[0]) || (m[2] && /^m$/i.test(m[2]))) {
        const num = parseFloat(m[1]?.replace(/,/g, '') || '0');
        if (num > 0) return `$${num}M`;
      }
      if (/thousand/i.test(m[0]) || (m[2] && /^k$/i.test(m[2]))) {
        const num = parseFloat(m[1]?.replace(/,/g, '') || '0');
        if (num > 0) return `$${num}K`;
      }
      const num = parseFloat(m[1]?.replace(/,/g, '') || '0');
      if (num >= 1000000) return `$${(num / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
      if (num >= 10000) return `$${Math.round(num / 1000)}K`;
    }
  }
  return '';
}

/**
 * Infer A&E market sector from content context.
 * Checks market taxonomy keywords first, then falls back to hardcoded patterns.
 */
function inferMarket(ctx, taxonomy) {
  // Try market taxonomy first (if available)
  if (taxonomy && Array.isArray(taxonomy)) {
    const marketItems = taxonomy.filter(t => t.taxonomy_group === 'market' && t.status === 'active' && (t.include_keywords || []).length > 0);
    const lower = (ctx || '').toLowerCase();
    let bestMatch = null;
    let bestHits = 0;
    for (const item of marketItems) {
      const hits = item.include_keywords.filter(kw => lower.includes(kw.toLowerCase())).length;
      const excludeHit = (item.exclude_keywords || []).length > 0 && item.exclude_keywords.some(kw => lower.includes(kw.toLowerCase()));
      if (hits > bestHits && !excludeHit) {
        bestMatch = item.label;
        bestHits = hits;
      }
    }
    if (bestMatch) return bestMatch;
  }

  // Fallback to hardcoded patterns
  const lo = (ctx || '').toLowerCase();
  // Check most specific first, then broaden
  if (/\b(elementary|middle school|high school|classroom|gymnasium|school district|k-12|k–12)\b/.test(lo)) return 'K-12';
  if (/\b(university|college|campus|dormitor|student housing|higher ed|oche)\b/.test(lo)) return 'Higher Education';
  if (/\b(hospital|medical center|clinic|outpatient|healthcare|urgent care|imaging|surgical)\b/.test(lo)) return 'Healthcare';
  // v4-b20: Check TEDD/URD/redevelopment BEFORE airport — TEDD pages often mention
  // "Airport Industrial Development District" in historical context, which causes
  // misclassification. TEDD/URD/redevelopment signals should take priority.
  if (/\b(tedd\b|tif\b|urd\b|urban renewal|tax increment|redevelopment\s+(area|district|zone|project)|development\s+(park|district)|mixed.?use|revitalization|midtown|riverfront|downtown\s+(development|redevelopment|master\s+plan))\b/.test(lo)) return 'Mixed Use';
  if (/\b(airport|terminal|hangar|aviation|runway|taxiway|apron)\b/.test(lo)) return 'Airports / Aviation';
  if (/\b(fire station|police|public safety|911|dispatch|jail|detention|corrections)\b/.test(lo)) return 'Public Safety';
  if (/\b(courthouse|city hall|government center|civic|municipal|county building|commission)\b/.test(lo)) return 'Civic';
  if (/\b(affordable housing|workforce housing|multifamily|apartment|residential|housing authority|housing development|housing project)\b/.test(lo)) return 'Housing';
  if (/\b(library|community center|senior center|recreation|pool|aquatic|arena|stadium)\b/.test(lo)) return 'Recreation';
  if (/\b(tribal|reservation|indian)\b/.test(lo)) return 'Tribal';
  if (/\b(water|wastewater|sewer|storm ?water|utility|treatment plant)\b/.test(lo)) return 'Infrastructure';
  if (/\b(hotel|resort|lodge|hospitality)\b/.test(lo)) return 'Hospitality';
  if (/\b(lab|laboratory|research|science)\b/.test(lo)) return 'Research / Lab';
  if (/\b(retail|commercial|office)\b/.test(lo)) return 'Commercial';
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
  if (cat.includes('Economic Development') || cat.includes('EDO')) return 'economic development intelligence';
  if (cat.includes('Capital Planning')) return 'capital planning documents';
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
  const highHits = (kws || []).filter(k => /^(capital improvement|bond|levy|facilities plan|master plan|lrbp|long-range building|capital plan|deferred maintenance|facility assessment|modernization|building program|facilities planning|CEDS|site selection)$/i.test(k));
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
    'Economic Development':10, 'Capital Planning':11, 'Public Notice':10, 'Tribal Government':11, 'Healthcare System':9, 'Utility':8, 'Media':5 };
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
  else if (/\bbond\b|\blevy\b|\bcapital improvement\b|\blrbp\b|\blong.range building\b|\bcapital plan\b|\bfacility assessment\b|\bdeferred maintenance\b|\bmodernization\b/i.test(lo)) typeScore = 8;
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
    'School Board':82, 'Airport Authority':80, 'Higher Ed Capital':80, 'Capital Planning':80, 'Redevelopment Agency':78,
    'Economic Development':75, 'Public Notice':78, 'Tribal Government':78, 'Healthcare System':70 };
  const sourceConfidenceScore = baseConf[src.category] || 60;

  return {
    relevanceScore, pursuitScore, sourceConfidenceScore,
    matchedOrgs: mOrgs, matchedFPs: mFPs,
  };
}

// ── Taxonomy matching helper ─────────────────────────────────
// Matches lead text against active taxonomy items.
// Returns { matches, taxonomyAdjustment, noiseAdjustment, isNoiseExcluded }
// Safe: returns empty/zero when taxonomy is missing or empty.
function matchTaxonomy(text, taxonomy) {
  const result = { matches: [], taxonomyAdjustment: 0, noiseAdjustment: 0, isNoiseExcluded: false };
  if (!taxonomy || !Array.isArray(taxonomy) || taxonomy.length === 0) return result;

  const lo = (text || '').toLowerCase();
  const active = taxonomy.filter(t => t.status === 'active');

  for (const item of active) {
    const includeKws = item.include_keywords || [];
    if (includeKws.length === 0) continue;

    const includeHits = includeKws.filter(kw => lo.includes(kw.toLowerCase()));
    if (includeHits.length === 0) continue;

    const excludeHit = (item.exclude_keywords || []).length > 0 &&
      item.exclude_keywords.some(kw => lo.includes(kw.toLowerCase()));
    if (excludeHit) continue;

    result.matches.push({
      taxonomy_id: item.taxonomy_id,
      group: item.taxonomy_group,
      label: item.label,
      fit_mode: item.fit_mode,
      matched_keywords: includeHits,
    });

    if (item.taxonomy_group === 'noise') {
      if (item.fit_mode === 'exclude') result.noiseAdjustment -= 30;
      else if (item.fit_mode === 'downrank') result.noiseAdjustment -= 15;
    } else {
      const fitBonus = item.fit_mode === 'strong_fit' ? 5
        : item.fit_mode === 'moderate_fit' ? 3
        : item.fit_mode === 'monitor_only' ? 1
        : item.fit_mode === 'downrank' ? -5
        : 0;
      result.taxonomyAdjustment += fitBonus;
    }
  }

  // Cap adjustments to prevent wild swings
  result.taxonomyAdjustment = Math.min(15, result.taxonomyAdjustment);
  result.noiseAdjustment = Math.max(-30, result.noiseAdjustment);
  result.isNoiseExcluded = result.noiseAdjustment <= -30;

  return result;
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

  // v32b: Multi-state city lookup — Montana, Idaho, Washington
  const cityMap = [
    // Idaho cities
    { city: "Coeur d'Alene", state: 'ID', county: 'Kootenai' },
    { city: 'Boise', state: 'ID', county: 'Ada' },
    { city: 'Idaho Falls', state: 'ID', county: 'Bonneville' },
    { city: 'Pocatello', state: 'ID', county: 'Bannock' },
    { city: 'Meridian', state: 'ID', county: 'Ada' },
    { city: 'Nampa', state: 'ID', county: 'Canyon' },
    { city: 'Twin Falls', state: 'ID', county: 'Twin Falls' },
    { city: 'Lewiston', state: 'ID', county: 'Nez Perce' },
    { city: 'Moscow', state: 'ID', county: 'Latah' },
    { city: 'Sandpoint', state: 'ID', county: 'Bonner' },
    { city: 'Post Falls', state: 'ID', county: 'Kootenai' },
    // Washington cities
    { city: 'Spokane', state: 'WA', county: 'Spokane' },
    { city: 'Seattle', state: 'WA', county: 'King' },
    { city: 'Pullman', state: 'WA', county: 'Whitman' },
    // Montana cities
    { city: 'Missoula', state: 'MT' }, { city: 'Kalispell', state: 'MT' },
    { city: 'Whitefish', state: 'MT' }, { city: 'Columbia Falls', state: 'MT' },
    { city: 'Hamilton', state: 'MT' }, { city: 'Polson', state: 'MT' },
    { city: 'Helena', state: 'MT' }, { city: 'Great Falls', state: 'MT' },
    { city: 'Billings', state: 'MT' }, { city: 'Bozeman', state: 'MT' },
    { city: 'Butte', state: 'MT' }, { city: 'Anaconda', state: 'MT' },
    { city: 'Libby', state: 'MT' }, { city: 'Thompson Falls', state: 'MT' },
    { city: 'Superior', state: 'MT' }, { city: 'Ronan', state: 'MT' },
    { city: 'Pablo', state: 'MT' }, { city: 'St. Ignatius', state: 'MT' },
    { city: 'Stevensville', state: 'MT' }, { city: 'Florence', state: 'MT' },
    { city: 'Lolo', state: 'MT' }, { city: 'Frenchtown', state: 'MT' },
    { city: 'Seeley Lake', state: 'MT' }, { city: 'Bigfork', state: 'MT' },
    { city: 'Lakeside', state: 'MT' }, { city: 'Somers', state: 'MT' },
    { city: 'Eureka', state: 'MT' }, { city: 'Troy', state: 'MT' },
    { city: 'Plains', state: 'MT' }, { city: 'Hot Springs', state: 'MT' },
  ];

  // Also detect state from URL or source name
  const srcUrl = (src.url || src.source_url || '').toLowerCase();
  const srcName = (src.name || src.source_name || '').toLowerCase();
  const urlState = /\.id\b|idaho/i.test(srcUrl + ' ' + srcName) ? 'ID'
    : /\.wa\b|washington/i.test(srcUrl + ' ' + srcName) ? 'WA'
    : null;

  for (const entry of cityMap) {
    if (lo.includes(entry.city.toLowerCase())) {
      const st = entry.state;
      if (entry.county) return `${entry.city}, ${entry.county} County, ${st}`;
      // Try to find county in context
      const countyPat = new RegExp(entry.city.replace(/'/g, '.') + '[^.]{0,30}(\\w+ county)', 'i');
      const cm = ctx.match(countyPat);
      return cm ? `${entry.city}, ${cm[1]}, ${st}` : `${entry.city}, ${st}`;
    }
  }

  // Fall back to county + state detection
  const countyPat = /\b(\w+(?:\s+\w+)?\s+county)\b/i;
  const cm = lo.match(countyPat);
  if (cm) {
    const county = cm[1].replace(/\b\w/g, c => c.toUpperCase());
    // Check if known Idaho/WA county
    const idCounties = ['kootenai','ada','canyon','bonneville','bannock','twin falls','nez perce','latah','bonner','boundary','shoshone','benewah'];
    const waCounties = ['spokane','king','whitman','pierce','clark','snohomish'];
    const countyLo = county.toLowerCase().replace(' county', '').trim();
    if (idCounties.includes(countyLo) || urlState === 'ID') return `${county}, ID`;
    if (waCounties.includes(countyLo) || urlState === 'WA') return `${county}, WA`;
    return `${county}, MT`;
  }

  // Fall back to source geography or URL-detected state
  if (urlState === 'ID') return src.geography ? `${src.geography}, ID` : 'Idaho';
  if (urlState === 'WA') return src.geography ? `${src.geography}, WA` : 'Washington';
  if (src.geography && src.geography !== 'Statewide') return `${src.geography}, MT`;
  if (src.county) return `${src.county}, MT`;
  // v4-b8: Source entity/URL location fallback — if the source clearly serves a specific city
  // (e.g., ci.missoula.mt.us, missoulahousing.org, missoulacounty.gov), use that city
  const srcAll = (srcUrl + ' ' + srcName + ' ' + (src.organization || '') + ' ' + (src.entity_name || '')).toLowerCase();
  if (/missoula|engagemissoula|boards\.missoulacounty|missoulacountyvoice/i.test(srcAll)) return 'Missoula, MT';
  if (/kalispell/i.test(srcAll)) return 'Kalispell, MT';
  if (/whitefish/i.test(srcAll)) return 'Whitefish, MT';
  if (/hamilton/i.test(srcAll)) return 'Hamilton, MT';
  if (/helena/i.test(srcAll)) return 'Helena, MT';
  if (/great\s*falls/i.test(srcAll)) return 'Great Falls, MT';
  if (/billings/i.test(srcAll)) return 'Billings, MT';
  if (/bozeman/i.test(srcAll)) return 'Bozeman, MT';
  return 'Montana';
}

// ── Generate a real project description (not just regex match) ──
function generateDescription(matchText, fullContext, leadClass, market, projectType, budget, timeline, src, title) {
  // ── Sentence scoring (shared with child enrichment) ──
  // v4-b7: Expanded scoring for Watch-quality leads (budgets, CIP, development, timelines)
  const scoreSentence = (s) => {
    const sl = s.toLowerCase();
    let sc = 0;
    if (/\b(scope of (work|services)|project (scope|description|overview|summary)|purpose of this)\b/.test(sl)) sc += 5;
    if (/\b(seeking|is soliciting|invites|requests)\s+(qualif|proposal|statement|a\/e|architect|design|engineering)\b/.test(sl)) sc += 4;
    if (/\b(services? (for|include)|work (includes?|consists?)|project (includes?|involves?))\b/.test(sl)) sc += 3;
    if (/\b(approximately|estimated|budget|square (feet|foot)|sf\b|gsf\b|acres?)\b/.test(sl)) sc += 2;
    if (/\b(construction|renovation|addition|expansion|replacement|remodel|new (building|facility|construction))\b/.test(sl)) sc += 2;
    if (/\b(design|architect|engineer|qualifications?|solicitation|rfq|rfp)\b/.test(sl)) sc += 1;
    if (/\b(project|building|facility|phase|campus|site)\b/.test(sl)) sc += 1;
    // v4-b7: Budget/CIP/capital language
    if (/\b(capital\s+improvement|cip\s+|capital\s+project|capital\s+budget|funded|budgeted|appropriat|bond\s+(issue|measure|election|funding)|levy|mill\s+levy|tif\s+(funded|district|revenue)|urban\s+renewal\s+district)\b/.test(sl)) sc += 3;
    if (/\$[\d,.]+\s*(million|mil|m\b|k\b|thousand)?/i.test(sl)) sc += 3;
    // v4-b7: Development/planning language
    if (/\b(planned\s+(development|construction|expansion)|proposed\s+(development|project|facility|building)|development\s+(project|agreement|proposal|plan)|master\s+plan\s+(update|amendment|phase)|redevelopment\s+(project|plan|area|district))\b/.test(sl)) sc += 3;
    // v4-b7: Timeline/scheduling signals
    if (/\b(scheduled\s+for|anticipated\s+(start|completion|opening)|planned\s+for\s+\d|expected\s+(to|in)\s+\d|fy\s*\d{2,4}|phase\s+[1-9]|groundbreaking|under\s+design|design\s+phase)\b/.test(sl)) sc += 2;
    // v4-b7: Named facility references
    if (/\b(fire\s+station|police\s+station|library|courthouse|school|hospital|clinic|treatment\s+(plant|facility)|community\s+center|recreation\s+center|senior\s+center|aquatic|natatorium|fieldhouse|arena|stadium|museum|terminal|hangar)\b/.test(sl)) sc += 2;
    return sc;
  };

  const fillerPatterns = /\b(research a property|public right.of.way|click here|learn more|view (all|more|details)|sign up|log in|contact us|follow us|subscribe|cookie|privacy policy|terms of (use|service)|skip to|breadcrumb|navigation|menu|footer|header|sidebar)\b/i;
  const sentences = fullContext.split(/(?<=[.!?\n])\s+/).filter(s => s.length > 20 && s.length < 300 && !fillerPatterns.test(s));
  const titleLo = (title || matchText || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const titleWords = new Set(titleLo.split(/\s+/).filter(w => w.length > 3));

  // Score and rank, but also penalize sentences that just repeat the title
  const ranked = sentences.map(s => {
    let score = scoreSentence(s);
    // Penalize title repetition: if >60% of title words appear, it's too similar
    const sLo = s.toLowerCase();
    const overlap = [...titleWords].filter(w => sLo.includes(w)).length;
    if (titleWords.size > 0 && overlap / titleWords.size > 0.6) score -= 3;
    return { text: s.trim(), score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

  // Build description from top 2 non-redundant sentences
  const parts = [];
  const used = new Set();
  for (const r of ranked) {
    if (parts.length >= 2) break;
    // Skip near-duplicates of already-used sentences
    const rNorm = r.text.toLowerCase().slice(0, 60);
    if ([...used].some(u => u.startsWith(rNorm.slice(0, 30)) || rNorm.startsWith(u.slice(0, 30)))) continue;
    parts.push(r.text.slice(0, 220));
    used.add(rNorm);
  }

  // Fallback: use cleaned match text if no good sentences found
  if (parts.length === 0) {
    const cleanMatch = matchText.replace(/\s+/g, ' ').trim();
    if (cleanMatch.length > 15) parts.push(cleanMatch.slice(0, 220));
  }

  // Append structured metadata (budget, timeline, source type) if not already present
  const desc = parts.join(' ');
  const extras = [];
  if (budget && !desc.includes('$')) extras.push(`Budget: ${budget}`);
  if (timeline && !desc.toLowerCase().includes(timeline.toLowerCase())) extras.push(`Timeline: ${timeline}`);
  // v4-b6: Add source type context — richer annotation for operational trust
  const srcType = src?.category || src?.source_family || '';
  const profileType = src?.source_profile?.profile_type || '';
  if (profileType === 'procurement' && !/procurement|solicitation|rfq|rfp|bid/i.test(desc)) {
    extras.push('Source: Procurement posting');
  } else if (profileType === 'agenda' && !/agenda|meeting|council|commission/i.test(desc)) {
    extras.push('Source: Public meeting/agenda');
  } else if (profileType === 'budget' && !/budget|capital|cip/i.test(desc)) {
    extras.push('Source: Capital/CIP planning');
  } else if (profileType === 'redevelopment' && !/redevelopment|mra|urban renewal/i.test(desc)) {
    extras.push('Source: Redevelopment/economic development');
  } else if (profileType === 'media' && !/news|article|report/i.test(desc)) {
    extras.push('Source: News/media');
  } else if (profileType === 'contractor' && !/contractor|portfolio/i.test(desc)) {
    extras.push('Source: Contractor portfolio');
  } else if (profileType === 'institutional' && !/campus|university|institutional/i.test(desc)) {
    extras.push('Source: Institutional/campus');
  } else if (srcType && /capital|budget|cip/i.test(srcType) && !/budget|capital/i.test(desc)) {
    extras.push('Source: Capital/CIP planning');
  }

  const result = extras.length > 0 ? `${desc} — ${extras.join('. ')}` : desc;
  return result.replace(/\s+/g, ' ').trim().slice(0, 500);
}

// ── Generate meaningful "Why It Matters" ────────────────────
function generateWhyItMatters(leadClass, market, location, scores, src, serviceFit) {
  const parts = [];
  const orgName = src.organization || src.name || 'the source';

  // Lead with the most actionable point — in business language
  if (leadClass === 'active_solicitation' && serviceFit.fit >= 15) {
    parts.push(`${orgName} is actively seeking A&E or design services — review scope and deadline for go/no-go`);
  } else if (leadClass === 'active_solicitation') {
    parts.push(`${orgName} has an open solicitation — review scope to determine if it aligns with our services`);
  } else if (leadClass === 'strategic_watch') {
    parts.push(`This is a strategic development area that may generate future design and construction opportunities`);
  }

  // Market context — in plain terms
  if (market && market !== 'Other') {
    parts.push(`${market} sector — ${['K-12','Higher Education','Healthcare','Civic','Public Safety'].includes(market) ? 'a core market for A&E + SMA' : 'within our service capabilities'}`);
  }

  // Geography relevance — be specific
  const coreGeos = ['missoula','kalispell','whitefish','columbia falls','hamilton','polson','great falls','helena','bozeman','billings','butte','coeur d\'alene','idaho falls','boise'];
  const locLo = (location || '').toLowerCase();
  if (coreGeos.some(g => locLo.includes(g))) {
    const city = coreGeos.find(g => locLo.includes(g));
    parts.push(`Located in ${city.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')} — within our service area`);
  }

  // Target org
  if (scores.matchedOrgs.length > 0) {
    parts.push(`${scores.matchedOrgs.map(o => o.name).join(', ')} is an existing client or tracked target`);
  }

  // What to do next — honest and practical
  if (leadClass === 'active_solicitation') {
    parts.push('Obtain the solicitation documents and assess scope, schedule, and team availability');
  } else if (leadClass === 'watch_signal' || leadClass === 'strategic_watch') {
    parts.push('Monitor for solicitation release, funding approval, or new design scope');
  }

  if (parts.length === 0) parts.push(`Project opportunity identified from ${orgName} — review for relevance to our services`);
  return parts.join('. ') + '.';
}

// ── Generate meaningful AI Assessment ───────────────────────
function generateAIAssessment(leadClass, market, projectType, scores, serviceFit, location, budget) {
  const parts = [];

  // 1. What is this opportunity? Be direct.
  const typeStr = projectType !== 'Other' ? projectType.toLowerCase() : 'project';
  const marketStr = market !== 'Other' ? ` in ${market}` : '';
  if (leadClass === 'active_solicitation') {
    parts.push(`Active ${typeStr} solicitation${marketStr}`);
  } else {
    parts.push(`Planning-stage ${typeStr} signal${marketStr}`);
  }

  // 2. Service fit — the most important BD question: "Can we do this work?"
  if (serviceFit.fit >= 20) {
    const reason = serviceFit.reasons[0] || 'strong service alignment';
    parts.push(`Strong firm fit: ${reason}`);
  } else if (serviceFit.fit >= 10) {
    parts.push('Moderate firm fit — review scope details to confirm alignment with A&E + SMA capabilities');
  } else {
    parts.push('Weak firm fit — scope may not align with A&E + SMA core services');
  }

  // 3. Practical next step — the most important actionable part
  if (leadClass === 'active_solicitation') {
    if (serviceFit.fit >= 15) {
      parts.push('Recommended action: obtain solicitation documents and assess go/no-go');
    } else {
      parts.push('Review scope before investing pursuit time');
    }
  } else {
    if (budget) {
      parts.push(`Funded (${budget}) — monitor for solicitation release`);
    } else {
      parts.push('Monitor for funding confirmation or solicitation release');
    }
  }

  // 4. Geography context if it adds value
  const locLo = (location || '').toLowerCase();
  if (locLo !== 'montana' && locLo.length > 3) {
    const coreGeos = ['missoula','kalispell','whitefish','columbia falls','hamilton','polson'];
    if (coreGeos.some(g => locLo.includes(g))) {
      parts.push('Core service area');
    }
  }

  return parts.join('. ') + '.';
}

// ── Extract leads from real fetched content ─────────────────
async function extractLeads(content, src, kws, fps, orgs, childLinks, log = () => {}, taxonomy = [], rawHtml = '', sourceProfile = null) {
  if (!content || content.length < 50) return [];

  // ── V4: Source profile — controls container behavior, child fetches, object types, ignores ──
  const profile = sourceProfile || getSourceProfile(src);
  const profileType = profile.container_behavior || 'hybrid';
  log(`    📋 Source profile: ${profile.profile_type || 'inferred'} (container: ${profileType}, max children: ${profile.max_child_fetches || '?'}, lane: ${profile.dashboard_lane || '?'})`);

  // ── Step 0: Listing page detection ────────────────────────
  // Profile can force container behavior
  const isProfileContainer = profileType === 'container';
  const listingPage = isProfileContainer || isListingPage(content, childLinks);
  if (listingPage) {
    log(`    ⚡ ${isProfileContainer ? 'Profile-driven' : 'Auto-detected'} container — will decompose into child artifacts`);
  } else {
    // v3.5: Diagnostic — show why listing detection failed
    const solChildCount = (childLinks || []).filter(cl =>
      cl.linkType === 'solicitation_detail' || cl.linkType === 'project_detail' ||
      /\b(rfq|rfp|soq|bid|solicitation)\b/i.test(cl.anchorText)
    ).length;
    if (solChildCount > 0) {
      log(`    ℹ️ Not a listing page (${solChildCount} sol-type child links, need ≥3). childLinks total: ${(childLinks||[]).length}`);
    }
  }

  // ── Step 0a: Container decomposition for listing pages ──────
  // When a page is a bid/solicitation listing with many child links,
  // create lead candidates directly from the child solicitation links
  // instead of (or in addition to) extracting from the parent page text.
  // This ensures "RFQ for AWTF Facility Plan Update" becomes the lead,
  // not "City of Coeur d'Alene — Capital Improvement".
  const containerChildCandidates = [];
  if (listingPage && childLinks && childLinks.length > 0) {
    const preferredChildTypes = new Set(profile.prefer_child_types || []);
    const solicitationLinks = childLinks.filter(cl =>
      cl.linkType === 'solicitation_detail' || cl.linkType === 'project_detail' ||
      (cl.linkType === 'document_pdf' && /\b(rfq|rfp|soq|bid|solicitation|engineering|architect|design)\b/i.test(cl.anchorText)) ||
      (preferredChildTypes.size > 0 && preferredChildTypes.has(cl.linkType) && cl.relevanceHint >= 6)
    );
    log(`    📋 Container decomposition: ${solicitationLinks.length} child solicitation links found (preferred types: ${[...preferredChildTypes].join(', ') || 'none'})`);
    for (const cl of solicitationLinks.slice(0, 15)) {
      // v3.5: Apply cleanTitle to child anchor text before validation.
      // Raw anchor texts often have trailing periods, leading whitespace, or
      // HTML-entity artifacts that cause title validation to reject them.
      const rawAnchor = cl.anchorText.trim();
      const anchor = cleanTitle(rawAnchor);
      if (anchor.length < 8 || anchor.length > 200) continue;
      if (isNavigationJunk(anchor)) continue;
      // Skip obvious non-A&E items early: fuel bids, chip seal, mowing, etc.
      const anchorLo = anchor.toLowerCase();
      if (/\b(fuel (services?|bid)|chip seal|mowing|snow plow|janitorial|custodial|uniform|vehicle purchase|parts list)\b/i.test(anchorLo)) continue;
      // v4-b14: Include parent page context near the child link anchor text
      // so isAlreadyClaimed can detect status labels like "Awarded" and "Closed"
      const anchorIdx = content.toLowerCase().indexOf(anchorLo.slice(0, 30));
      const parentContext = anchorIdx >= 0
        ? content.slice(Math.max(0, anchorIdx - 100), Math.min(content.length, anchorIdx + anchorLo.length + 200))
        : anchor;
      containerChildCandidates.push({
        matchText: anchor,
        fullContext: parentContext,
        wideContext: parentContext,
        patternIndex: -1,
        extractionPath: 'container_child',
        headingTitle: anchor, // already cleaned by cleanTitle above
        childLink: cl, // preserve direct link for evidence
      });
    }
    if (containerChildCandidates.length > 0) {
      log(`    📋 ${containerChildCandidates.length} child solicitation candidates extracted from listing page`);
    }
  }

  // ── Step 0c: Profile-level named-child decomposition ──────────
  // v4-b10: For sources with decompose_named_children config, create leads
  // from named child links (URD districts, housing projects) instead of one
  // generic parent lead. This is profile-driven, not generic crawling.
  const decompConfig = profile.decompose_named_children;
  const decompChildCandidates = [];
  if (decompConfig?.enabled && childLinks && childLinks.length > 0) {
    const patterns = (decompConfig.child_patterns || []).map(p => p.toLowerCase());
    const maxChildren = decompConfig.max_children || 6;

    // Find child links whose anchor text or URL matches the named patterns
    const matchingLinks = childLinks.filter(cl => {
      const anchorLo = (cl.anchorText || '').toLowerCase();
      const urlLo = (cl.url || '').toLowerCase();
      return patterns.some(p => anchorLo.includes(p) || urlLo.includes(p));
    });

    // Filter out links that are duplicates or clearly not useful
    // Note: we bypass isNavigationJunk here because the profile's child_patterns
    // already validate these are known named districts/projects (e.g., "URD II" is 6 chars
    // but is a legitimate named district). The pattern-match is the quality gate.
    const qualifiedLinks = matchingLinks.filter(cl => {
      const anchor = cleanTitle(cl.anchorText || '');
      if (anchor.length < 3 || anchor.length > 120) return false;
      // Must not be the parent page itself
      if (cl.url === src.url) return false;
      // Skip obvious non-project content
      if (/^(home|about|contact|staff|board|agenda|minutes|maps?)$/i.test(anchor.trim())) return false;
      return true;
    }).slice(0, maxChildren);

    if (qualifiedLinks.length > 0) {
      log(`    🔀 Profile decomposition: ${qualifiedLinks.length} named children found from ${matchingLinks.length} matching links`);
      for (const cl of qualifiedLinks) {
        const anchor = cleanTitle(cl.anchorText || '');
        // v4-b18: Use parent page content as context for decomposed children
        // so inferMarket and hasArchitecturalScope have enough text to work with
        decompChildCandidates.push({
          matchText: anchor,
          fullContext: anchor + ' ' + content.slice(0, 500),
          wideContext: content.slice(0, 1000),
          patternIndex: -1,
          extractionPath: 'decompose_named_child',
          headingTitle: anchor,
          childLink: cl,
        });
        log(`      → "${anchor}" (${cl.linkType || 'link'}, hint=${cl.relevanceHint || 0})`);
      }
    }

    // Also extract named projects directly from page content if configured
    if (decompConfig.extract_from_content && content) {
      const contentLo = content.toLowerCase();
      for (const pattern of patterns) {
        // Look for pattern in content with surrounding project context
        const patIdx = contentLo.indexOf(pattern);
        if (patIdx >= 0) {
          // Extract a sentence-sized chunk around the match
          const start = Math.max(0, patIdx - 50);
          const end = Math.min(content.length, patIdx + pattern.length + 150);
          const chunk = content.slice(start, end).replace(/\s+/g, ' ').trim();
          // Try to extract a project name from the chunk
          const nameMatch = chunk.match(new RegExp(`((?:[A-Z][\\w'-]+\\s+){0,3}${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s+[A-Z][\\w'-]+){0,3})`, 'i'));
          if (nameMatch) {
            const projectName = cleanTitle(nameMatch[1].trim());
            // Check it's not already in decompChildCandidates
            const alreadyHave = decompChildCandidates.some(c =>
              c.headingTitle.toLowerCase().includes(projectName.toLowerCase().slice(0, 15)) ||
              projectName.toLowerCase().includes(c.headingTitle.toLowerCase().slice(0, 15))
            );
            if (!alreadyHave && projectName.length >= 5 && projectName.length <= 80 && !isNavigationJunk(projectName)) {
              decompChildCandidates.push({
                matchText: chunk,
                fullContext: chunk,
                wideContext: content.slice(Math.max(0, patIdx - 300), Math.min(content.length, patIdx + 500)),
                patternIndex: -1,
                extractionPath: 'decompose_content_extract',
                headingTitle: projectName,
                childLink: null,
              });
              log(`      → content-extracted: "${projectName}"`);
            }
          }
        }
      }
    }
  }

  // ── Step 0b: Strategy/retrospective document classification ──
  // CEDS, annual reports, strategic plans, etc. should not generate normal
  // pursuit leads from named initiatives alone. They are intelligence context.
  const docType = classifyDocumentType(content);
  if (docType.isStrategy) {
    log(`    📄 Strategy document detected (${docType.documentType}: ${docType.signals.join(', ')}) — applying stricter lead gates`);
  }

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
    // ── Watch-signal patterns (redevelopment, planning, master plan, development) ──
    // Redevelopment/development plans and agreements
    /(?:redevelopment|development|revitalization)\s+(?:plan|agreement|project|area|district|proposal|initiative)\s*(?:for|of|at|–|—|:)?\s*[^.]{5,120}/gi,
    // Master plan / facility plan / campus plan references
    /(?:[\w\s]{5,40})\s+(?:master plan|facility plan|campus plan|long.range (?:building |facility )?plan|facilities assessment)\b[^.]{0,80}/gi,
    // Under construction / in development / in planning
    /(?:under construction|in development|in planning|under design|in design phase|under review)\s*(?:at|on|for|–|—|:)?\s*[^.]{5,100}/gi,
    // Urban renewal / TIF / TEDD district references
    /(?:urban renewal|tax increment|tif|tedd|targeted economic)\s+(?:district|area|zone|financing|plan)[^.]{5,100}/gi,
    // Mixed-use / workforce housing / affordable housing development
    /(?:mixed.use|workforce housing|affordable housing|multi.?family)\s+(?:development|project|construction|proposal)[^.]{5,100}/gi,
    // Development agreement / development plan with named context
    /(?:development agreement|development plan|redevelopment plan)\s+(?:for|with|between|involving)\s+[^.]{10,100}/gi,

    // ── v31: Budget / CIP project-line-item patterns ──
    // Named facility + action verb (common in budget line items)
    /(?:[A-Z][\w\s]{3,40})\s+(?:replacement|renovation|upgrade|modernization|expansion|addition|remodel|rehabilitation|improvement|retrofit|restoration)\s*(?:\$[\d,.]+[kKmM]?)?[^.]{0,80}/g,
    // Budget line items: "Project: [name]" or "Project Name: [name]"
    /(?:project(?:\s+name)?|facility|building|improvement)\s*:\s*([^.|\n]{10,120})/gi,
    // CIP/budget section items: "[FacilityType] [Name] — $X" or "[FacilityType] [Name] (FYxxxx)"
    /(?:school|library|courthouse|fire station|police|hospital|clinic|facility|building|park|pool|center|hall|arena|stadium|terminal|plant|museum|campus)\s+[\w\s]{3,40}(?:\s*[-–—]\s*\$[\d,.]+[kKmM]?|\s*\(FY\s*\d{2,4}\))[^.]{0,60}/gi,
    // Deferred maintenance / major maintenance items
    /(?:deferred maintenance|major maintenance|critical maintenance|facility condition)\s+(?:at|for|of|–|—|:)\s*[^.]{10,100}/gi,
    // Funded/budgeted/appropriated project references
    /(?:funded|budgeted|appropriated|allocated|approved)\s+(?:for|to)\s+(?:the\s+)?[^.]{10,100}/gi,
    // TIF/URD/TEDD funded projects
    /(?:TIF|tax increment|urban renewal)\s+(?:funded|financed|supported|assistance|investment)\s+[^.]{10,100}/gi,
    // MRA/TIF assistance patterns: "$X in TIF funds for [project]" or "TIF assistance for [project]"
    /\$[\d,.]+\s*(?:million|mil|m|k)?\s+in\s+(?:TIF|tax increment|urban renewal|URD|MRA|redevelopment)\s+(?:funds?|financing|assistance|investment)[^.]{5,100}/gi,
    // District improvement items: "[District Name] improvement" or "[Area Name] infrastructure"
    /(?:[A-Z][\w\s]{3,30})\s+(?:district|URD|corridor|downtown|midtown)\s+(?:improvement|infrastructure|development|project|investment)[^.]{5,80}/gi,

    // ── v3.5: OpenGov budget book fund-line patterns ──
    // "NNNN - FUND NAME" format common in OpenGov budget book data
    // Only extract strategic/capital fund lines, not general revenue/admin
    /\b\d{4}\s*-\s*((?:BONNER|WYE|DEVELOPMENT PARK|CAPITAL|DETENTION|LIBRARY|FAIR|PARTNERSHIP HEALTH|TECHNOLOGY)[A-Z &/()-]*(?:TAX INCREMENT|TEDD|DISTRICT|IMPROVEMENT|FUND|FACILITY|CENTER|PLANT)?)\b/g,

    // ── v32: Agenda / minutes / staff-report strategic-watch patterns ──
    // "Discussion of [Named Area/Project]" — common in meeting agendas
    /(?:discussion|update|presentation|report|review|consideration)\s+(?:of|on|regarding)\s+(?:the\s+)?([A-Z][\w\s]{5,60}(?:project|development|crossing|triangle|corridor|commons|block|mill|yard|park|district|plan|site|phase|area))\b/gi,
    // "Staff report on [Named Area]" or "Staff presented [Named Project]"
    /(?:staff\s+(?:report|update|presentation|memo|memorandum))\s+(?:on|regarding|for|about)\s+(?:the\s+)?([A-Z][\w\s]{5,80})/gi,
    // Named opportunity/development/catalyst site references
    /(?:opportunity\s+(?:site|zone|area)|catalyst\s+site|development\s+(?:site|target|opportunity))\s*(?::|–|—|for)?\s*([A-Z][\w\s]{3,60})/gi,
    // "[Named Place] development" or "[Named Place] redevelopment" — reusable across cities
    /([A-Z][\w\s]{3,40})\s+(?:development|redevelopment|revitalization|renewal|improvement|investment|initiative|master plan)\b[^.]{0,60}/gi,
  ];

  let candidates = [];
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

      // Compute wider context window (±800 chars around match) for claimed-project checks.
      // fullContext is the surrounding sentence; wideContext captures nearby paragraphs
      // where architect/contractor info often appears adjacent to the project name.
      const wideStart = Math.max(0, idx - 800);
      const wideEnd = Math.min(cleanContent.length, idx + ctx.length + 800);
      const wideContext = cleanContent.slice(wideStart, wideEnd).trim();

      candidates.push({
        matchText: ctx,
        fullContext: fullSentence.length > ctx.length ? fullSentence : ctx,
        wideContext,
        patternIndex: pats.indexOf(p),
        extractionPath: 'pattern',
      });
    }
  }

  // ── Step 2b: HTML heading/link extraction for project-list pages ──
  // If the source is a Project Pages, Capital Projects, or Redevelopment type,
  // extract project names from HTML headings (<h2>–<h4>) and significant links.
  // This catches pages like MRA Major Projects where projects are listed as headings.
  const headingCategories = ['Redevelopment Agency', 'Economic Development', 'Capital Planning',
    'Project Pages', 'Capital Projects', 'Planning & Zoning', 'City Council',
    'County Commission', 'School Board', 'Community Development', 'Development Authority'];
  const isProjectPage = headingCategories.some(c => (src.category||'').includes(c)) ||
    /major.?project|redevelopment|capital.?project|master.?plan|development.?(district|opportunity|park)|urban.?renewal|economic.?development|community.?development/i.test(src.name || '');

  // v31: Also detect budget/CIP source pages for enhanced HTML extraction
  const isBudgetSource = /SF-08|Capital Planning/i.test(src.source_family || src.category || '') ||
    /\b(budget|cip|capital (improvement|project|plan)|facilities (plan|assessment)|deferred maintenance|major maintenance|opengov)\b/i.test(src.name || '') ||
    /opengov\.com/i.test(src.url || src.source_url || '');

  if ((isProjectPage || isBudgetSource) && rawHtml) {
    const stripHtml = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/&#?\w+;/g,' ').replace(/\s+/g, ' ').trim();

    // Extract from headings: <h2>, <h3>, <h4>
    const headingRe = /<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/gi;
    // Extract from significant <a> tags (project-list pages often use links as project names)
    const linkRe = /<a[^>]*>([\s\S]*?)<\/a>/gi;
    // Extract from <strong>/<b> tags that look like project names
    const strongRe = /<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi;
    // v31: Extract from <li> items (bulleted/numbered lists — common in budget/CIP pages)
    const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    // v31: Extract from <td> cells (table-format project lists — common in CIP documents)
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    // v31: Extract from <dt>/<dd> definition list items
    const dtRe = /<d[td][^>]*>([\s\S]*?)<\/d[td]>/gi;

    // ── v31c: Table ROW correlator — combine adjacent cells into richer candidates ──
    // Budget/CIP tables have project data split across cells:
    //   <tr><td>Courthouse HVAC</td><td>$2.5M</td><td>FY2027</td><td>Cascade County</td></tr>
    // Extract the whole row as one combined candidate instead of individual cells.
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    for (const trMatch of rawHtml.matchAll(trRe)) {
      const rowHtml = trMatch[1];
      const cells = [];
      for (const cellMatch of rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
        cells.push(stripHtml(cellMatch[1]).trim());
      }
      if (cells.length < 2) continue;

      // Find the cell most likely to be the project name (longest cell with project words)
      let bestCell = null, bestScore = 0;
      for (const cell of cells) {
        if (cell.length < 5 || cell.length > 200) continue;
        if (/^\s*[\$\d,.\s%()-]+\s*$/.test(cell)) continue; // pure number
        if (/^\s*(FY\s*\d{2,4}|Q[1-4]|20\d{2})\s*$/i.test(cell.trim())) continue; // pure date
        let sc = cell.length;
        if (PROJECT_TITLE_WORDS.test(cell) || /\b(replacement|upgrade|modernization|renovation|expansion|addition|maintenance|improvement|repair)\b/i.test(cell)) sc += 100;
        if (/[A-Z][a-z]{2,}/.test(cell)) sc += 20; // has proper noun
        if (sc > bestScore) { bestScore = sc; bestCell = cell; }
      }
      if (!bestCell || bestScore < 50) continue; // no project-name cell found
      if (isNavigationJunk(bestCell) || isPortalFragmentTitle(bestCell)) continue;

      // Assemble combined context from all cells
      const combinedRow = cells.filter(c => c.length > 0).join(' — ');
      // Extract dollar amounts, fiscal years, and owner/facility names from sibling cells
      const amountCell = cells.find(c => /\$[\d,.]+/i.test(c));
      const yearCell = cells.find(c => /\b(FY\s*\d{2,4}|20[2-3]\d)\b/i.test(c));
      const rowAmount = amountCell ? amountCell.match(/\$[\d,.]+\s*(?:million|mil|m|k)?/i)?.[0] : null;
      const rowYear = yearCell ? yearCell.match(/(?:FY\s*\d{2,4}|20[2-3]\d)/i)?.[0] : null;

      const key = bestCell.slice(0, 50).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (seen.has(key)) continue;
      seen.add(key);

      const headingLo = bestCell.toLowerCase();
      const ctxIdx = lo.indexOf(headingLo);
      const nearbyCtx = ctxIdx >= 0 ? cleanContent.slice(ctxIdx, ctxIdx + 500).trim() : combinedRow;
      const htmlWideStart = ctxIdx >= 0 ? Math.max(0, ctxIdx - 800) : 0;
      const htmlWideEnd = ctxIdx >= 0 ? Math.min(cleanContent.length, ctxIdx + 800) : 0;
      const htmlWideCtx = ctxIdx >= 0 ? cleanContent.slice(htmlWideStart, htmlWideEnd).trim() : '';

      candidates.push({
        matchText: combinedRow,
        fullContext: nearbyCtx.length > combinedRow.length ? nearbyCtx : combinedRow,
        wideContext: htmlWideCtx || nearbyCtx || combinedRow,
        patternIndex: -1,
        extractionPath: 'html_table_row',
        headingTitle: bestCell,
        rowAmount,
        rowYear,
      });
      log(`    📊 table_row candidate: "${bestCell}" ${rowAmount || ''} ${rowYear || ''}`);
    }

    // ── v31c: Heading+detail correlator — combine heading with following list/paragraph ──
    // Budget pages often have: <h3>Capital Projects</h3><ul><li>Roof Replacement...</li>...
    // The heading provides context and the list items are the actual projects.
    // This is already handled by the individual <li>/<h2-h4> extraction above,
    // but we also want to grab heading context for individual element candidates.

    const htmlPatterns = [
      { re: headingRe, tag: 'heading' },
      { re: linkRe, tag: 'link' },
      { re: strongRe, tag: 'strong' },
      { re: liRe, tag: 'list_item' },
      { re: dtRe, tag: 'deflist' },
      // NOTE: <td> cells are now handled by the table row correlator above.
      // Individual <td> extraction is removed to avoid duplicating row-correlated candidates.
    ];

    for (const { re, tag } of htmlPatterns) {
      for (const hm of rawHtml.matchAll(re)) {
        const headingText = stripHtml(hm[1]);
        // v3.5: Lower min length for econ-dev sources to catch short site names like "Wye"
        const isEconDevSrcLen = /economic.?development|economic.?partnership|redevelopment|development.?authority/i.test(src.name || src.category || '');
        const minLen = isEconDevSrcLen ? 3 : (tag === 'deflist') ? 8 : 10;
        if (headingText.length < minLen || headingText.length > 200) continue;
        if (isNavigationJunk(headingText)) continue;
        if (isPortalFragmentTitle(headingText)) continue;
        if (/^(home|about|contact|news|calendar|staff|board|faq|login|register|search|sitemap|skip|menu)$/i.test(headingText.trim())) continue;
        if (/^(https?:|mailto:|www\.)/i.test(headingText.trim())) continue;
        if (/^\s*[\$\d,.\s%()-]+\s*$/.test(headingText)) continue;
        if (/^\s*(FY\s*\d{2,4}|Q[1-4]|20\d{2})\s*$/i.test(headingText.trim())) continue;
        const needsProjectWord = tag === 'link' || tag === 'list_item' || tag === 'deflist';
        // v3.5: For econ-dev/MEP/redevelopment sources, relax the project-word requirement
        // to allow named site/opportunity links through (e.g., "Bonner Mill", "Wye 2")
        const isEconDevSrc = /economic.?development|economic.?partnership|redevelopment|development.?authority|community.?development/i.test(src.name || src.category || '');
        const isLikelyEntityNotSite = /\b(architect\w*|engineering|design\s+(firm|group)|construction|contracting|consulting|hospital|health|medical|university|college|foundation|association|partnership|chamber|council|agency|authority|commission|corporation|inc\.?|llc|ltd|group|associates|services)\b/i.test(headingText.toLowerCase());
        if (needsProjectWord && !isEconDevSrc) {
          if (!PROJECT_TITLE_WORDS.test(headingText) && !/\b(redevelopment|development|corridor|triangle|downtown|midtown|district|commons|crossing|replacement|upgrade|modernization|renovation|expansion|addition|maintenance|improvement|repair|rehabilitation|restoration|retrofit|mill|yard|park|gateway|interchange|site)\b/i.test(headingText)) continue;
        } else if (needsProjectWord && isEconDevSrc) {
          // For econ-dev sources: allow proper-named items but block entity/company names
          if (isLikelyEntityNotSite) continue;
          if (!/[A-Z][a-z]{2,}/.test(headingText)) continue; // must have a proper name
          if (headingText.split(/\s+/).length > 8) continue; // too long for a site name
        }

        const key = headingText.slice(0, 50).toLowerCase().replace(/[^a-z0-9]/g, '');
        if (seen.has(key)) continue;
        seen.add(key);

        const headingLo = headingText.toLowerCase();
        const ctxIdx = lo.indexOf(headingLo);
        const nearbyCtx = ctxIdx >= 0 ? cleanContent.slice(ctxIdx, ctxIdx + 400).trim() : headingText;
        const htmlWideStart = ctxIdx >= 0 ? Math.max(0, ctxIdx - 800) : 0;
        const htmlWideEnd = ctxIdx >= 0 ? Math.min(cleanContent.length, ctxIdx + 800) : 0;
        const htmlWideCtx = ctxIdx >= 0 ? cleanContent.slice(htmlWideStart, htmlWideEnd).trim() : '';

        candidates.push({
          matchText: nearbyCtx || headingText,
          fullContext: nearbyCtx || headingText,
          wideContext: htmlWideCtx || nearbyCtx || headingText,
          patternIndex: -1,
          extractionPath: `html_${tag}`,
          headingTitle: headingText,
        });
        log(`    🏷️ ${tag} candidate: "${headingText}"`);
      }
    }
  }

  // ── Step 2c: Container-child injection + parent suppression ──
  // When container children exist, they ARE the real leads. Parent-page-derived
  // candidates (pattern-based or HTML heading-based) are just the listing page itself
  // and should be suppressed to avoid "City X — Capital Improvement" as a lead.
  if (containerChildCandidates.length > 0) {
    const parentCount = candidates.length;
    // Keep ONLY container children + any pattern-based candidates that match a specific
    // child solicitation (e.g., pattern picked up "RFQ for X" from page text that also
    // has a child link for X). Suppress generic parent-page heading candidates.
    const containerChildTitles = new Set(containerChildCandidates.map(c =>
      (c.headingTitle || '').toLowerCase().slice(0, 40).replace(/[^a-z0-9]/g, '')
    ));
    candidates = candidates.filter(c => {
      // Keep if this candidate matches a container child (avoid duplicating)
      const key = (c.headingTitle || c.matchText || '').toLowerCase().slice(0, 40).replace(/[^a-z0-9]/g, '');
      if (containerChildTitles.has(key)) return false; // will be in containerChildCandidates
      // Keep if it's a very specific project-named candidate (not a generic heading)
      if (c.extractionPath === 'pattern' && /\b(rfq|rfp|soq|bid)\s+[-–—:]\s+/i.test(c.matchText || '')) return true;
      // v4-b19: Keep named strategic project/area candidates from redevelopment/institutional pages
      // These are exactly the critical project leads that should survive container decomposition
      const ht = (c.headingTitle || '').toLowerCase();
      const isNamedStrategicProject =
        /\b(redevelopment|development|corridor|triangle|crossing|commons|block|mill|yard|plan|master plan|tedd|urd|renewal)\b/i.test(ht) &&
        /[A-Z][a-z]{2,}/.test(c.headingTitle || '') &&
        (c.headingTitle || '').split(/\s+/).length >= 2 &&
        !/^(home|about|contact|staff|board|improve|programs?|workforce|community\s*&?\s*economic|located\s+in|urban\s+renewal\s+district)\b/i.test(ht) &&
        !/\b(page|portal|hub|directory|registry|listing)\b/i.test(ht);
      if (isNamedStrategicProject && (c.extractionPath || '').startsWith('html_')) {
        // v4-b20: Enrich context with parent page text so inferMarket works
        if (c.fullContext && c.fullContext.length < 100) {
          c.fullContext = c.fullContext + ' ' + content.slice(0, 500);
          c.wideContext = content.slice(0, 1000);
        }
        log(`    📍 Named strategic project preserved in container mode: "${c.headingTitle}"`);
        return true;
      }
      // Suppress generic heading/link candidates from the listing page
      return false;
    });
    candidates.unshift(...containerChildCandidates);
    log(`    📋 Container decomposition: suppressed ${parentCount - candidates.length + containerChildCandidates.length} parent candidates, promoted ${containerChildCandidates.length} child candidates`);
  }

  // ── Step 0c merge: Profile decomposition children replace parent candidates ──
  if (decompChildCandidates.length > 0) {
    const decompTitles = new Set(decompChildCandidates.map(c =>
      (c.headingTitle || '').toLowerCase().slice(0, 30).replace(/[^a-z0-9]/g, '')
    ));
    const preDecompCount = candidates.length;
    if (decompConfig?.suppress_parent) {
      // When suppress_parent is true, replace ALL parent candidates with decomp children
      candidates = decompChildCandidates;
      log(`    🔀 Profile decomposition: replaced ${preDecompCount} parent candidates with ${decompChildCandidates.length} named children`);
    } else {
      // Otherwise, add decomp children while removing duplicates
      candidates = candidates.filter(c => {
        const key = (c.headingTitle || c.matchText || '').toLowerCase().slice(0, 30).replace(/[^a-z0-9]/g, '');
        return !decompTitles.has(key);
      });
      candidates.unshift(...decompChildCandidates);
      log(`    🔀 Profile decomposition: added ${decompChildCandidates.length} named children, ${preDecompCount - candidates.length + decompChildCandidates.length} parent candidates replaced`);
    }
  }

  // v4-b19: Include decomposed named children so they use their cleaned anchor text as title
  const isHtmlExtracted = (ep) => ep && (ep.startsWith('html_') || ep === 'container_child' || ep === 'decompose_named_child' || ep === 'decompose_content_extract');
  candidates.sort((a, b) => {
    // Decomposed named children and container children first, then HTML-extracted, then pattern-based
    const aDecomp = a.extractionPath === 'decompose_named_child' || a.extractionPath === 'decompose_content_extract';
    const bDecomp = b.extractionPath === 'decompose_named_child' || b.extractionPath === 'decompose_content_extract';
    if (aDecomp && !bDecomp) return -1;
    if (bDecomp && !aDecomp) return 1;
    if (a.extractionPath === 'container_child' && b.extractionPath !== 'container_child') return -1;
    if (b.extractionPath === 'container_child' && a.extractionPath !== 'container_child') return 1;
    const aHtml = isHtmlExtracted(a.extractionPath);
    const bHtml = isHtmlExtracted(b.extractionPath);
    if (aHtml && !bHtml) return -1;
    if (!aHtml && bHtml) return 1;
    return 0;
  });

  // ── Step 3: Build lead records from valid candidates
  const leads = [];
  const now = new Date().toISOString();
  // V4: Use source profile for child fetch budget and max leads
  const MAX_CHILD_FETCHES_PER_SOURCE = profile.max_child_fetches ?? 2;
  let childFetchCount = 0;
  const maxLeadsPerSource = profile.max_leads ?? 8;
  const isMeetingSource = /SF-02|Agenda|Meeting|Minutes|Commission/i.test(src.source_family || src.category || src.name || '');
  const isDistrictSource = /redevelopment|urban renewal|tif|tedd|urd|major.?project|development.?(district|park|opportunity)/i.test(src.name || src.category || '');

  for (const cand of candidates) {
    if (leads.length >= maxLeadsPerSource) break;

    const { matchText, fullContext, wideContext, extractionPath, headingTitle, rowAmount, rowYear } = cand;

    // For HTML-extracted candidates (headings, links, strong), use the heading text directly as title
    let title = (headingTitle && isHtmlExtracted(extractionPath)) ? headingTitle : extractProjectTitle(matchText, src);
    let titleFromChild = false;

    // extractProjectTitle returns null when only a generic fallback is available.
    // We'll defer the skip decision until after child enrichment — a child page
    // may provide a project-specific title that rescues this candidate.
    const titleIsGenericFallback = (title === null);
    if (titleIsGenericFallback) {
      // Set a temporary placeholder — will be replaced by child title or skipped
      const type = /rfq|rfp/i.test(matchText) ? 'Solicitation' : /renovation|remodel/i.test(matchText) ? 'Renovation Project'
        : /addition|expansion/i.test(matchText) ? 'Expansion Project' : /bond|levy/i.test(matchText) ? 'Bond/Levy Program'
        : /capital improvement/i.test(matchText) ? 'Capital Improvement' : /master plan/i.test(matchText) ? 'Master Plan'
        : 'Project Signal';
      title = `${src.organization || src.name || 'Unknown'} — ${type}`;
    }

    // Skip if title is still junk after cleanup
    if (isNavigationJunk(title) || title.length < 10) continue;

    // Skip portal/listing fragment titles (e.g. "Current Solicitations", "Bid Opportunities")
    if (isPortalFragmentTitle(title)) {
      log(`    ⊘ Portal fragment title skipped: "${title}"`);
      continue;
    }

    // On listing pages, require stronger project-specific evidence
    if (listingPage) {
      // Agenda-profile sources: allow meeting_document / board_packet child candidates through
      // without the project-specific title gate — child enrichment will extract the real content.
      const isMeetingDocChild = (cand.childLink?.linkType === 'meeting_document' || cand.childLink?.linkType === 'board_packet');
      const isAgendaSource = profile.profile_type === 'agenda';
      if (isMeetingDocChild && isAgendaSource) {
        log(`    📋 Meeting document child (${cand.childLink.linkType}) — deferring title quality to child enrichment`);
      } else if (!isProjectSpecificTitle(title)) {
        log(`    ⊘ Listing page — not project-specific: "${title}"`);
        continue;
      }
    }

    // Noise suppression: skip items that are clearly not A&E pursuit leads
    if (isNoiseLead(title, fullContext, src)) continue;

    // ── v31b: Administrative/policy/program precision filter ──
    // Catches weak non-project content that passes noise filters because it contains
    // project-adjacent words (building, system, development, improvement) but is actually
    // regulatory, policy, program administration, or departmental information.
    const titleLo = (title || '').toLowerCase();
    const ctxLo2 = (fullContext || '').toLowerCase();
    const isAdminNonProject = (() => {
      // Regulations, codes, ordinances, policies, standards (not projects)
      if (/\b(regulation|ordinance|code enforcement|zoning code|building code|fire code|compliance|statute|rule|policy statement|guideline|standard)\b/i.test(titleLo) &&
          !/\b(renovation|construction|design|addition|replacement|upgrade|modernization|rfq|rfp|project|capital)\b/i.test(titleLo)) return true;
      // Lease, rent, rental regulations (not projects)
      if (/\b(lease|rent|rental|for lease|for rent)\b/i.test(titleLo) && /\b(regulations?|information|requirements?|applications?|polic(?:y|ies))\b/i.test(titleLo)) return true;
      // Department patrol, operations, administration, staffing (not projects)
      if (/\b(patrol|staffing|personnel|operations|dispatch|scheduling|recruitment|training|payroll)\b/i.test(titleLo) &&
          !/\b(facility|building|station|center|renovation|construction|addition|replacement|upgrade|project|capital)\b/i.test(titleLo)) return true;
      // Storm sewer / stormwater programs (MS4, NPDES, compliance — not projects)
      if (/\b(storm\s*sewer|ms4|npdes|stormwater\s+(management|program|permit|compliance|prevention|pollution))\b/i.test(titleLo) &&
          !/\b(renovation|construction|facility|treatment plant|design|project|capital|replacement|upgrade)\b/i.test(titleLo)) return true;
      // Road abandonment, vacation, right-of-way abandonment (admin process, not project)
      if (/\b(abandon(ment|ed|ing)?|vacat(e|ion|ed|ing))\b/i.test(titleLo) && /\b(road|street|alley|right.of.way|easement)\b/i.test(titleLo)) return true;
      // Division / department information pages
      if (/\b(division|department)\b/i.test(titleLo) && /\b(information|lighting|about|overview|contact|staff|mission)\b/i.test(titleLo) &&
          !/\b(project|capital|renovation|construction|design|replacement|upgrade|facility)\b/i.test(titleLo)) return true;
      // Climate / sustainability / environmental policy goals (not projects)
      if (/\b(climate (change|action|goal|plan|commitment)|carbon (neutral|footprint|reduction)|greenhouse gas|sustainability (plan|goal|initiative|report)|reducing.+(contribution|emissions|impact))\b/i.test(ctxLo2) &&
          !/\b(renovation|construction|facility|building|design|project|capital|replacement|upgrade|energy retrofit|solar|mechanical)\b/i.test(titleLo)) return true;
      // Program administration, grant administration, fund administration
      if (/\b(program\s+administration|grant\s+administration|fund\s+administration|program\s+management)\b/i.test(titleLo) &&
          !/\b(capital|facility|renovation|construction|project|design|replacement)\b/i.test(titleLo)) return true;
      // Routine maintenance schedules (mowing, plowing, cleaning, sweeping — not capital projects)
      if (/\b(mowing|snow\s+plow|snow\s+removal|street\s+sweep|sweeping|garbage|trash|recycling|solid\s+waste|compost)\b/i.test(titleLo) &&
          !/\b(facility|building|transfer\s+station|plant|renovation|construction|replacement|capital)\b/i.test(titleLo)) return true;
      // ── v31d: Taxonomy-authoritative rules ──
      // The following 6 categories are now driven by editable Taxonomy noise items
      // (TAX-NOI-008 through TAX-NOI-013). They are handled by matchTaxonomy() at line ~2370.
      // Users can edit them in the Taxonomy tab (Noise / Exclusion group) to change behavior.
      //
      // RETIRED from hard-code (now taxonomy-driven):
      //   - Department / Office Page (TAX-NOI-008)
      //   - Contact / Staff / Directory (TAX-NOI-009)
      //   - Operations / Service Pages (TAX-NOI-010)
      //   - Academic Unit Name (TAX-NOI-011)
      //   - Climate / Sustainability Policy (TAX-NOI-012)
      //   - Regulation / Policy / Admin (TAX-NOI-013)
      //
      // REMAINING hard-coded safety nets (no taxonomy equivalent):
      // Pure phone/fax numbers that leaked into titles
      if (/^\s*\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}\s*$/.test(titleLo.trim())) return true;
      // "We provide" / "Our mission" / "About us" service description fragments
      if (/^(we\s+provide|our\s+mission|about\s+us|who\s+we\s+are|what\s+we\s+do|our\s+services)\b/i.test(titleLo.trim())) return true;
      // Standalone facility type without project action (e.g., "Heating Plant" as a building name, not a project)
      if (/^(heating\s+plant|power\s+plant|utility\s+plant|boiler\s+house|central\s+plant|chiller\s+plant)\s*$/i.test(titleLo.trim()) &&
          !/\b(renovation|replacement|upgrade|expansion|construction|project|design|capital)\b/i.test(ctxLo2)) return true;
      return false;
    })();
    if (isAdminNonProject) {
      log(`    ⊘ Admin/policy/program (not a project): "${title.slice(0,60)}"`);
      continue;
    }

    // ── v3.5: Lead specificity gate ──
    // Catch items that pass basic noise/admin filters but are still too generic to be real leads.
    // A surviving lead should identify a specific project, solicitation, site, or opportunity target.
    const isNonSpecificLead = (() => {
      // Company/firm/consultant names — not projects
      if (/\b(architecture|architects?|engineering|engineers?|consulting|consultants?|design\s+(?:group|studio|firm|inc|llc|pllc))\b/i.test(titleLo) &&
          !/\b(renovation|construction|replacement|upgrade|expansion|project|rfq|rfp|solicitation|facility|building|school|hospital)\b/i.test(titleLo)) return true;
      // Organization + generic suffix only: "Missoula Economic Partnership", "Providence St. Patrick Hospital" as org mention
      if (/\b(partnership|foundation|association|coalition|alliance|consortium|corporation|company|inc\b|llc\b|pllc\b|group\b)\s*$/i.test(titleLo.trim()) &&
          !/\b(development|redevelopment|project|renovation|construction|facility|replacement|upgrade|expansion)\b/i.test(titleLo)) return true;
      // Generic department/program names without project identity
      if (/^(building\s+(&|and)\s+grounds?\s+maintenance|planning[,\s]+design[,\s]+(&|and)\s+construction|facilities?\s+(management|services?|operations?)|research\s+development)\s*$/i.test(titleLo.trim())) return true;
      // Generic program/initiative/strategy text without a named project
      if (/^(reducing|identifying|increasing|improving|ensuring|supporting|enhancing|maintaining|addressing)\s+/i.test(titleLo) &&
          !/\b[A-Z][a-z]{2,}\s+(school|hospital|library|courthouse|station|center|building|facility|plant|hall|arena|stadium|campus|bridge|road)\b/.test(title || '')) return true;
      // Address + phone number fragments
      if (/\d+\s+\w+\s+(drive|street|avenue|road|way|blvd|boulevard)\b/i.test(titleLo) && /\(\d{3}\)\s*\d{3}[-.]?\d{4}/.test(titleLo)) return true;
      // Bare address as title (number + street + city/state)
      if (/^\d+\s+\w+\s+(dr|st|ave|rd|way|blvd|ln|ct|pl)\b.*\b(mt|id|wa|or)\b/i.test(titleLo) &&
          !/\b(renovation|construction|project|replacement|upgrade|facility|building)\b/i.test(titleLo)) return true;
      // Generic block grant / program without project scope
      if (/^(community\s+development\s+block\s+grant|cdbg)\b/i.test(titleLo) &&
          !/\b(renovation|construction|project|facility|building|school|hospital|replacement|upgrade|design)\b/i.test(ctxLo2.slice(0, 300))) return true;
      // Generic "research" or "development" as standalone department/topic
      if (/^(research\s+development|research\s+&\s+development|r\s*&\s*d)\s*$/i.test(titleLo.trim())) return true;
      // Climate/sustainability policy without project
      if (/\b(climate\s+change|carbon\s+(footprint|reduction|neutral)|greenhouse|sustainability\s+(plan|program|goal|initiative|strategy))\b/i.test(titleLo) &&
          !/\b(renovation|construction|building|facility|project|replacement|upgrade|solar|wind|geothermal|energy\s+retrofit)\b/i.test(titleLo)) return true;
      return false;
    })();
    if (isNonSpecificLead) {
      log(`    ⊘ Non-specific lead (no clear project/site/opportunity identity): "${title.slice(0,60)}"`);
      continue;
    }

    // ── v3.5: Lead object typing ──
    // Positive classification: what valid lead type IS this?
    // Only valid types survive. Everything else is blocked.
    const classifyLeadObject = (t, ctx, lc) => {
      const tlo = (t || '').toLowerCase();
      const clo = (ctx || '').toLowerCase().slice(0, 500);
      // 1. Solicitation — has RFQ/RFP/SOQ/BID/ITB language
      if (/\b(rfq|rfp|soq|bid|itb|invitation\s+to\s+bid|request\s+for\s+(qualifications?|proposals?)|solicitation)\b/i.test(tlo)) return 'solicitation';
      if (lc === 'active_solicitation') return 'solicitation';
      // 2. Named project — has a project action word + named subject OR is from a container child
      if (/\b(renovation|construction|replacement|upgrade|modernization|expansion|addition|remodel|retrofit|restoration|demolition|rehabilitation|repair|reroof|reroofing|improvements?)\b/i.test(tlo)) return 'project';
      if (extractionPath === 'container_child') return 'project';
      // 3. Strategic district — URD/TIF/TEDD/redevelopment/urban renewal
      if (/\b(urd|tif|tedd|urban\s+renewal|tax\s+increment|redevelopment\s+(area|district|zone|project))\b/i.test(tlo)) return 'district';
      if (/\b(millsite|log\s+yard|development\s+park)\s+(tax\s+increment|tedd|district|non.incremnt)/i.test(tlo)) return 'district';
      if (lc === 'strategic_watch') return 'district';
      // 4. Named site / opportunity area — has a place-type word + proper name
      if (/\b(crossing|triangle|corridor|commons|block|mill|yard|junction|plaza|square|depot|development\s+park|log\s+yard|interchange|gateway|business\s+park|industrial\s+park|catalyst\s+site|opportunity\s+(site|zone|area))\b/i.test(tlo) && /[A-Z][a-z]{2,}/.test(t)) return 'site';
      // 5. Named facility with identifiable building type
      if (/\b(school|hospital|library|courthouse|fire\s+station|police\s+station|terminal|community\s+center|recreation\s+center|treatment\s+plant|city\s+hall|town\s+hall|armory|auditorium|gymnasium|stadium|arena|museum|dormitory|laboratory|wellness\s+center|storage\s+building|operations\s+facility|maintenance\s+facility)\b/i.test(tlo) && /[A-Z][a-z]{2,}/.test(t)) return 'project';
      // 6. Named building/facility with proper name (e.g., "Smith Block Building", "Flathead Lake Station")
      if (/\b(building|facility|station|center|hall|plant|tower)\b/i.test(tlo) && /[A-Z][a-z]{2,}/.test(t) && t.split(/\s+/).length >= 2) return 'project';
      // 7. Capital/CIP/budget item with specific scope language in context
      if (/\b(capital\s+(improvement|project)|cip|deferred\s+maintenance|major\s+maintenance|facility\s+(assessment|condition)|bond\s+(program|measure))\b/i.test(tlo) &&
          /\b(building|facility|school|hospital|library|courthouse|station|center|plant|campus)\b/i.test(clo)) return 'project';
      // 8. Development/master plan with named subject
      if (/\b(development|master\s+plan|campus\s+plan|facility\s+plan|long.range\s+plan)\b/i.test(tlo) && /[A-Z][a-z]{2,}/.test(t) &&
          !/^(community\s+development|economic\s+development|staff\s+development|workforce\s+development)\s*$/i.test(tlo.trim())) return 'project';
      // 9. Equipment/MEP with named facility
      if (/\b(elevator|boiler|hvac|chiller|fire\s+alarm|generator|roof|window|mechanical|electrical|plumbing)\b/i.test(tlo) &&
          /\b(replacement|upgrade|modernization|repair|install)\b/i.test(tlo)) return 'project';
      // 10. "[Proper Name] Project" — explicit project word with proper name
      if (/\bproject\b/i.test(tlo) && /[A-Z][a-z]{2,}/.test(t) && t.split(/\s+/).length >= 2 &&
          !/^(community|economic|staff|workforce|software|research)\s+/i.test(tlo)) return 'project';
      // 11. Named property/site development (from econ-dev sources)
      if (/\b(property\s+(development|redevelopment)|site\s+(development|redevelopment))\b/i.test(tlo) && /[A-Z][a-z]{2,}/.test(t)) return 'site';
      // 12. "[Proper Name] Development" with proper name (not generic "Community Development")
      if (/\bdevelopment\b/i.test(tlo) && /[A-Z][a-z]{2,}/.test(t) && t.split(/\s+/).length >= 2 &&
          !/^(community|economic|staff|workforce|software|business|professional|organizational|curriculum|resource)\s+development\s*$/i.test(tlo.trim())) return 'site';
      // Unclassifiable — no valid lead type
      return null;
    };
    // Lead object typing moved below — needs leadClass which is declared at classifyActiveWatch

    // ── Already-claimed suppression ──
    // Block projects that already have a designer, contractor, are under construction, or completed.
    // Pass both narrow context (sentence) and wide context (±800 chars) so claimed-team info
    // in adjacent paragraphs is detected even when the project name is in a different sentence.
    const claimedCheck = isAlreadyClaimed(title, fullContext, wideContext || '');
    if (claimedCheck.isClaimed) {
      log(`    ⊘ Already claimed (${claimedCheck.reason}): "${title}" — ${claimedCheck.detail || ''}`);
      continue;
    }

    // ── Strategy-document gate ──
    // If this document is a CEDS/annual report/strategic plan, require the candidate
    // to have its own active procurement signal (RFQ/RFP/solicitation/bid/deadline).
    // Named initiatives, goals, and districts in strategy docs are intelligence context,
    // not fresh leads, unless they independently reference a live procurement event.
    if (docType.isStrategy) {
      const candidateLo = (matchText || '').toLowerCase();
      const hasOwnProcurement = /\b(?:rfq|rfp|invitation\s+to\s+bid|request\s+for\s+(?:qualifications?|proposals?)|solicitation|bid\s+#|submit\s+by|due\s+date|closing\s+date|selection\s+committee|design\s+services\s+(?:for|needed|required|sought))\b/.test(candidateLo);
      // Exception: named local opportunity areas / redevelopment targets in strategy docs
      // should still surface as strategic Watch items (they are intelligence signals even without active RFQ)
      const isNamedOpArea = /\b(crossing|triangle|corridor|commons|block|mill|yard|junction|plaza|square|station|depot|development\s+park|log\s+yard|interchange|gateway|town\s*center|business\s+park|industrial\s+park|commerce\s+park|technology\s+park|catalyst\s+site|opportunity\s+(site|zone|area))\b/i.test(candidateLo) && /[A-Z][a-z]{2,}/.test(matchText || '');
      const isNamedRedevelopment = /\b(urd|tif|tedd|urban\s+renewal|tax\s+increment|redevelopment\s+(area|district|zone|project))\b/i.test(candidateLo);
      // v3.5: Source-aware escape — if this is from an economic development / MEP / redevelopment source,
      // allow named headings AND named link items through even if they don't match the place-type keyword list,
      // as long as they have a proper name and look like a real named area/site (not an entity/company)
      const isEconDevSource = /economic.?development|economic.?partnership|redevelopment|development.?authority|community.?development/i.test(src.name || src.category || '');
      // Entity/company name filter — block firm names, hospital systems, orgs, partnerships, chambers
      const isEntityName = /\b(architect\w*|engineering|design\s+(firm|group|studio)|construction|contracting|consulting|hospital|health\s+system|medical|university|college|foundation|association|partnership|chamber|council|agency|authority|commission|corporation|inc\.?|llc|ltd|pllc|pllp|group|associates|services|bank|credit\s+union|insurance|realty|real\s+estate|law\s+(firm|office)|attorney|accounting)\b/i.test(candidateLo);
      const isNamedSite = isEconDevSource &&
        extractionPath && (extractionPath.startsWith('html_') || extractionPath === 'container_child') &&
        /[A-Z][a-z]{2,}/.test(matchText || '') && (matchText || '').split(/\s+/).length <= 8 &&
        !isEntityName &&
        !/\b(about|contact|staff|board|mission|department|office|faq|resources|links|events|calendar|home|login|sign\s+in|subscribe|newsletter)\b/i.test(candidateLo);
      if (!hasOwnProcurement && !isNamedOpArea && !isNamedRedevelopment && !isNamedSite) {
        log(`    ⊘ Strategy-doc suppressed (no own procurement signal): "${title}"`);
        continue;
      }
      if ((isNamedOpArea || isNamedRedevelopment || isNamedSite) && !hasOwnProcurement) {
        log(`    📍 Strategy-doc: named opportunity area "${title}" allowed as strategic watch (${isNamedOpArea ? 'opArea' : isNamedRedevelopment ? 'redev' : 'namedSite'})`);
      }
    }

    // v31d: Taxonomy-driven noise suppression — authoritative for categories with editable taxonomy items
    const taxResult = matchTaxonomy(`${title} ${fullContext}`, taxonomy);
    if (taxResult.isNoiseExcluded) {
      const noiseLabel = taxResult.matches.filter(m => m.group === 'noise').map(m => m.label).join(', ');
      log(`    ⊘ TAXONOMY EXCLUDED: "${title}" — matched: ${noiseLabel} (editable in Taxonomy → Noise / Exclusion)`);
      continue;
    }

    // Classify Active vs Watch — uses MATCH TEXT only (not expanded fullContext which
    // can pull in solicitation words from adjacent sentences on the same page)
    let { leadClass, status, reason: classifyReason } = classifyActiveWatch(matchText);

    // Override classification for named opportunity areas from strategy docs
    if (docType.isStrategy) {
      const candidateLo2 = (matchText || '').toLowerCase();
      const isOpArea2 = /\b(crossing|triangle|corridor|commons|block|mill|yard|junction|plaza|square|station|depot|development\s+park|log\s+yard|interchange|gateway|town\s*center|business\s+park|industrial\s+park|commerce\s+park|technology\s+park|catalyst\s+site|opportunity\s+(site|zone|area))\b/i.test(candidateLo2) && /[A-Z][a-z]{2,}/.test(matchText || '');
      const isRedev2 = /\b(urd|tif|tedd|urban\s+renewal|tax\s+increment|redevelopment\s+(area|district|zone|project))\b/i.test(candidateLo2);
      const isEconDevSrc2 = /economic.?development|economic.?partnership|redevelopment|development.?authority/i.test(src.name || src.category || '');
      const isEntity2 = /\b(architect\w*|engineering|design\s+(firm|group|studio)|construction|contracting|consulting|hospital|health\s+system|medical|university|college|foundation|association|partnership|chamber|council|agency|authority|commission|corporation|inc\.?|llc|ltd|group|associates|services)\b/i.test(candidateLo2);
      const isNamedSite2 = isEconDevSrc2 &&
        extractionPath && (extractionPath.startsWith('html_') || extractionPath === 'container_child') &&
        /[A-Z][a-z]{2,}/.test(matchText || '') && (matchText || '').split(/\s+/).length <= 8 && !isEntity2;
      const hasProc2 = /\b(?:rfq|rfp|solicitation|bid\s+#|due\s+date)\b/.test(candidateLo2);
      if ((isOpArea2 || isRedev2 || isNamedSite2) && !hasProc2) {
        status = 'watch';
        leadClass = 'strategic_watch';
      }
    }
    log(`    📋 classify: "${title.slice(0,50)}" → ${status} (${classifyReason}) | match: "${matchText.slice(0,80).replace(/\n/g,' ')}"`);

    // ── v3.5: Lead object typing — positive classification gate ──
    // Now that leadClass is known, classify the lead object type.
    const leadObjectType = classifyLeadObject(title, fullContext, leadClass);
    if (!leadObjectType) {
      log(`    ⊘ No valid lead object type: "${title.slice(0,60)}" — suppressed (not solicitation/project/site/district)`);
      continue;
    }

    // V4: Profile-driven object type filter
    if (!profileAllowsObjectType(profile, leadObjectType)) {
      log(`    ⊘ Profile blocks object type "${leadObjectType}" for ${profile.profile_type || 'unknown'} source: "${title.slice(0,60)}"`);
      continue;
    }

    // V4: Profile-driven ignore pattern check
    if (profileMatchesIgnore(profile, title) || profileMatchesIgnore(profile, matchText)) {
      log(`    ⊘ Profile ignore pattern matched: "${title.slice(0,60)}" (${profile.profile_type || 'unknown'} source)`);
      continue;
    }

    // Step 13: Watch-specific title quality gate
    // Watch leads must identify one specific future project — not a generic heading
    if (status === 'watch' && !titleIsGenericFallback) {
      const watchCheck = isWatchTitleAcceptable(title);
      if (!watchCheck.pass) {
        log(`    ⊘ Watch title not specific enough: "${title}" (${watchCheck.reason})`);
        continue;
      }
    }

    // Extract dates and budget
    const dates = extractDates(fullContext);
    let budget = extractBudget(fullContext);
    // v31c: Table-row correlation may provide budget/year from adjacent cells
    if (!budget && rowAmount) budget = rowAmount;
    if (!dates.potentialTimeline && rowYear) dates.potentialTimeline = rowYear;

    // ── Stale-date scrutiny ──
    // If the only date/budget references are materially old, this is likely stale
    const now = new Date();
    const currentYear = now.getFullYear();
    const ctxForStale = fullContext.toLowerCase();
    // Find all 4-digit years mentioned in context
    const yearMatches = ctxForStale.match(/\b(20\d{2})\b/g) || [];
    const years = yearMatches.map(Number);
    const maxYear = years.length > 0 ? Math.max(...years) : null;
    const minYear = years.length > 0 ? Math.min(...years) : null;
    // Check if ALL year references are stale (≥3 years old) with no recent or future year
    const isStaleByYears = maxYear && maxYear <= (currentYear - 3);
    // Check for explicit old budget context like "$X million (2010-2014)"
    const hasOldBudgetRange = /\b(20[01]\d)\s*[-–]\s*(20[01]\d)\b/.test(ctxForStale);
    // Check for "completed" year references
    const hasCompletedOldYear = /\b(completed|finished|opened|built)\s+in\s+(20[01]\d|19\d{2})\b/i.test(ctxForStale);

    if (status === 'watch') {
      // v31: Only suppress Watch for VERY strong stale evidence: completed + old years
      // Moderate stale (just old years) should NOT suppress Watch — many budget/CIP docs
      // reference prior-year context while describing future work.
      if (isStaleByYears && hasCompletedOldYear && hasOldBudgetRange) {
        log(`    ⊘ Stale Watch: "${title.slice(0,50)}" — years ${minYear}-${maxYear}, completed + old budget context`);
        continue;
      }
    }

    // For Active leads, stale years reduce relevance but don't suppress (may be reissued)

    // Infer market and project type
    const market = inferMarket(fullContext, taxonomy);
    const projectType = inferType(fullContext);

    // Architectural scope gate: suppress leads with no building/design evidence
    if (!hasArchitecturalScope(fullContext, market)) {
      log(`    ⊘ No architectural scope: "${title}" (market: ${market})`);
      continue;
    }

    // Score
    const scores = scoreCandidate(fullContext, src, kws, fps, orgs);

    // Service-fit assessment
    const serviceFit = assessServiceFit(fullContext, market);

    // Adjust relevance by service fit (replaces pure keyword weighting)
    const adjustedRelevance = Math.min(100, Math.max(0, Math.round(
      scores.relevanceScore * 0.7 + serviceFit.fit * 1.0 + taxResult.taxonomyAdjustment + taxResult.noiseAdjustment
    )));
    const adjustedPursuit = Math.min(100, Math.max(0, Math.round(
      scores.pursuitScore * 0.8 + (serviceFit.fit >= 15 ? 12 : serviceFit.fit >= 8 ? 5 : 0) + Math.round(taxResult.taxonomyAdjustment * 0.5)
    )));

    // Better location
    const location = extractLocation(fullContext, src);

    // Build description from context — prefer meaningful summary over raw match
    const description = generateDescription(matchText, fullContext, leadClass, market, projectType, budget, dates.potentialTimeline, src, title);

    // Build evidence with useful context
    const sourceDesc = describeSourceType(src);
    const id = `lead-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // ── Child-document enrichment ────────────────────────────
    // v32b: Container-child candidates already have their direct child link
    // Use it as the primary evidence and enrichment source.
    const isContainerChild = (extractionPath === 'container_child' || extractionPath === 'decompose_named_child') && cand.childLink;

    // Find all relevant child links for this lead
    const relevantChildLinks = isContainerChild
      ? [cand.childLink] // Container-child: use the direct link
      : (childLinks || []).filter(link => {
          const al = link.anchorText.toLowerCase();
          const tl = title.toLowerCase();
          const words = tl.split(/\s+/).filter(w => w.length > 3);
          return words.some(w => al.includes(w)) || link.relevanceHint >= 9;
        });

    // Select the single best child link for enrichment fetch
    const bestChildLink = isContainerChild ? cand.childLink : selectBestChildLink(relevantChildLinks.length > 0 ? relevantChildLinks : childLinks, matchText, title);

    // Fetch child page content if we have a strong link and haven't blown our per-source budget
    let childEnrichment = null;
    if (bestChildLink && childFetchCount < MAX_CHILD_FETCHES_PER_SOURCE) {
      childFetchCount++;
      childEnrichment = await enrichFromChildLink(bestChildLink, src, log, taxonomy);
      if (childEnrichment && childEnrichment.enrichedContent) {
        log(`    ↳ child enrichment: ${bestChildLink.linkType} "${bestChildLink.anchorText.slice(0, 50)}" (${childEnrichment.enrichedContent.length} chars${childEnrichment.pdfParsed ? ', PDF ' + childEnrichment.pdfPageCount + 'pp' : ''})`);
      } else if (childEnrichment && !childEnrichment.enrichedContent) {
        // PDF link was found but couldn't be parsed — keep link metadata for evidence
        log(`    ↳ child link preserved (unreadable): ${bestChildLink.linkType} "${bestChildLink.anchorText.slice(0, 50)}"`);
      }
    }

    // ── Merge child enrichment: child-first, parent as fallback ──
    // When a child document was fetched successfully, prefer its data
    // for all fields where it provides better or missing information.
    let finalDates = dates;
    let finalBudget = budget;
    let finalDescription = description;
    let finalLocation = location;
    let finalMarket = market;
    let finalServiceFit = serviceFit;
    let childEnriched = false;

    if (childEnrichment && childEnrichment.enrichedContent) {
      // Child document was fetched and parsed successfully — use its data
      childEnriched = true;

      // ── Step 11: Child-title preference ──
      // If the child document has a more project-specific title than the parent page,
      // prefer it. This rescues leads from generic listing pages where the child
      // PDF or detail page has the actual project name.
      if (childEnrichment.childTitle) {
        const childTitleClean = cleanTitle(childEnrichment.childTitle);
        // Also try extracting a title from the child content itself
        // Use first 1500 chars — project name often appears after preamble/header
        const childExtracted = extractProjectTitle(
          childEnrichment.enrichedContent.slice(0, 1500), src
        );
        const bestChildTitle = childExtracted || childTitleClean;

        if (bestChildTitle && bestChildTitle.length >= 12 && !isNavigationJunk(bestChildTitle) && !isPortalFragmentTitle(bestChildTitle)) {
          const childIsSpecific = isProjectSpecificTitle(bestChildTitle);
          const parentIsSpecific = isProjectSpecificTitle(title);
          // Prefer child title when: parent is generic/fallback, or child is more specific
          // v4-b9: Also prefer child when it contains a named district, URD, or specific area
          const childHasNamedDistrict = /\b(urd|urban\s+renewal|district|front\s+street|riverfront|hellgate|north\s+reserve|scott\s+street|midtown|southgate|bristlecone|villagio|trinity)\b/i.test(bestChildTitle);
          const parentIsGenericContainer = /^(urban\s+renewal\s+districts?|development\s+projects?|major\s+projects?|capital\s+projects?)$/i.test(title.trim());
          if (titleIsGenericFallback || (!parentIsSpecific && childIsSpecific) || (childHasNamedDistrict && parentIsGenericContainer)) {
            log(`    ↳ child title preferred: "${bestChildTitle}" (was: "${title}")`);
            title = bestChildTitle;
            titleFromChild = true;
          }
        }
      }

      // (entity enrichment moved to after child-enrichment block — v4-b9)

      // Dates: child page is the primary source for deadlines (it's the actual document)
      if (childEnrichment.childDates) {
        // Child due date takes priority — it's from the actual solicitation/project page
        if (childEnrichment.childDates.action_due_date) {
          finalDates = { ...finalDates, action_due_date: childEnrichment.childDates.action_due_date };
        }
        if (childEnrichment.childDates.potentialTimeline) {
          finalDates = { ...finalDates, potentialTimeline: childEnrichment.childDates.potentialTimeline };
        }
      }

      // Budget: prefer child-sourced budget (actual document likely more specific)
      if (childEnrichment.childBudget) {
        finalBudget = childEnrichment.childBudget;
      }

      // Description: prefer child description if it has real substance (>40 chars)
      // The child document (RFQ, project page, PDF) is the primary artifact and
      // its description is almost always more specific than the parent landing page.
      if (childEnrichment.childDescription && childEnrichment.childDescription.length > 40) {
        finalDescription = childEnrichment.childDescription;
        log(`    ↳ description from child artifact (${childEnrichment.childDescription.length} chars)`);
      }

      // Location: prefer child if it found a specific city (not just "Montana")
      if (childEnrichment.childLocation && childEnrichment.childLocation !== 'Montana' &&
          (finalLocation === 'Montana' || !finalLocation)) {
        finalLocation = childEnrichment.childLocation;
      }

      // Market: prefer child market if parent was generic "Other"
      if (childEnrichment.childMarket && childEnrichment.childMarket !== 'Other' && finalMarket === 'Other') {
        finalMarket = childEnrichment.childMarket;
      }

      // Re-assess service fit using child content if it's richer
      if (childEnrichment.enrichedContent.length > fullContext.length) {
        const childServiceFit = assessServiceFit(childEnrichment.enrichedContent, finalMarket);
        if (childServiceFit.fit > finalServiceFit.fit) {
          finalServiceFit = childServiceFit;
        }
      }
    }
    // Note: if childEnrichment exists but enrichedContent is null (PDF link found but
    // not parseable), we still have the link metadata for evidence but don't merge any
    // content — parent-page data is used as-is. This is honest: no fabrication.

    // ── Post-enrichment claimed check ──
    // If child document content reveals the project team, suppress now.
    // This catches cases where the parent page had a clean project name but
    // the child PDF/page shows "Architect: XYZ, Contractor: ABC".
    if (childEnriched && childEnrichment.enrichedContent) {
      const childClaimedCheck = isAlreadyClaimed(title, childEnrichment.enrichedContent);
      if (childClaimedCheck.isClaimed) {
        log(`    ⊘ Already claimed via child doc (${childClaimedCheck.reason}): "${title}" — ${childClaimedCheck.detail || ''}`);
        continue;
      }
    }

    // v4-b9: Entity enrichment for ALL leads (moved from inside child-enrichment block)
    // Applies to short generic titles regardless of whether child enrichment succeeded
    if (title && title.split(/\s+/).length <= 3) {
      const titleLo2 = title.toLowerCase();
      const isGenericShort = /^(treatment\s+facility|development\s+projects?|capital\s+projects?|master\s+plan|urban\s+renewal|improvement\s+projects?)$/i.test(titleLo2.trim());
      if (isGenericShort) {
        const orgName = src.organization || src.name || '';
        const cleanOrg = orgName.replace(/\s*[–—-]\s*.+$/, '').replace(/^(city|county|town)\s+of\s+/i, '').trim();
        if (cleanOrg && cleanOrg.length >= 3 && cleanOrg.length <= 50) {
          const enrichedTitle = `${cleanOrg} — ${title}`;
          log(`    ↳ title enriched with entity context: "${enrichedTitle}" (was: "${title}")`);
          title = enrichedTitle;
        }
      }
    }

    // v4-b16: Budget title normalization — format budget/CIP-derived leads as "Budget — Entity — Project"
    if (profile.profile_type === 'budget' || /SF-08/.test(src.source_family || '')) {
      const orgName = src.organization || src.name || '';
      const cleanOrg = orgName.replace(/\s*[–—-]\s*.+$/, '').replace(/^(city|county|town)\s+of\s+/i, '').trim();
      // Only apply if not already prefixed with "Budget"
      if (!/^budget\s/i.test(title) && cleanOrg && title.length > 5) {
        title = `Budget — ${cleanOrg} — ${title}`;
        log(`    ↳ budget title normalized: "${title}"`);
      }
    }

    // v4-b16: Sentence-like title cleanup
    // Titles starting with dollar amounts or numbers should be restructured
    if (/^\d+\s+million\s/i.test(title)) {
      // "3 million fire station..." → "Fire Station — $3M New Construction"
      const dollarMatch = title.match(/^(\d+)\s+million\s+(.+)/i);
      if (dollarMatch) {
        const amount = `$${dollarMatch[1]}M`;
        const rest = dollarMatch[2].trim();
        const orgName = src.organization || src.name || '';
        const cleanOrg = orgName.replace(/\s*[–—-]\s*.+$/, '').replace(/^(city|county|town)\s+of\s+/i, '').trim();
        title = cleanOrg ? `${cleanOrg} — ${rest} (${amount})` : `${rest} (${amount})`;
        // Capitalize first letter of rest
        title = title.charAt(0).toUpperCase() + title.slice(1);
        log(`    ↳ sentence title restructured: "${title}"`);
      }
    }

    // ── Step 11: Single-project gate ──
    // After child enrichment had a chance to improve the title, reject leads
    // whose titles are still generic fallback ("Org — Solicitation" etc.).
    // This is the key gate that prevents multi-project pages and generic portals
    // from producing leads with fabricated titles.
    if (titleIsGenericFallback && !titleFromChild) {
      log(`    ⊘ Generic fallback title — no project-specific title found: "${title}"`);
      continue;
    }

    // Re-compute adjusted scores with potentially updated service fit
    let finalAdjustedRelevance = (childEnriched && finalServiceFit !== serviceFit) ?
      Math.min(100, Math.max(0, Math.round(scores.relevanceScore * 0.7 + finalServiceFit.fit * 1.0))) :
      adjustedRelevance;
    let finalAdjustedPursuit = (childEnriched && finalServiceFit !== serviceFit) ?
      Math.min(100, Math.max(0, Math.round(scores.pursuitScore * 0.8 + (finalServiceFit.fit >= 15 ? 12 : finalServiceFit.fit >= 8 ? 5 : 0)))) :
      adjustedPursuit;

    // Strategy-document penalty: leads that survived the procurement-signal gate
    // still get a confidence penalty because they originate from a planning/strategy document
    if (docType.isStrategy) {
      finalAdjustedRelevance = Math.max(0, finalAdjustedRelevance - 15);
      finalAdjustedPursuit = Math.max(0, finalAdjustedPursuit - 10);
      log(`    📉 Strategy-doc penalty applied (-15 rel, -10 pursuit): "${title.slice(0,50)}" → rel=${finalAdjustedRelevance}, pursuit=${finalAdjustedPursuit}`);
    }

    // Action Due: for Active leads use solicitation due date; for Watch use timeline
    let actionDue = '';
    if (status === 'active' && finalDates.action_due_date) {
      actionDue = finalDates.action_due_date; // Actual solicitation deadline
    }
    // For Watch leads, leave action_due_date blank — timeline is shown separately

    // Evidence: use child link if available, else fall back to source page
    const evidenceUrl = bestChildLink ? bestChildLink.url : src.url;
    const childTypeLabel = (linkType) => {
      if (linkType === 'solicitation_detail') return 'Solicitation';
      if (linkType === 'meeting_document') return 'Meeting document';
      if (linkType === 'capital_document') return 'Capital plan document';
      if (linkType === 'project_detail') return 'Project detail';
      if (linkType === 'document_pdf') return 'Project document (PDF)';
      return 'Source document';
    };
    // v4-b8: Include source profile type in evidence label for artifact trust
    const profileLabel = src.source_profile?.profile_type || '';
    const srcTypeContext = profileLabel === 'procurement' ? 'procurement portal'
      : profileLabel === 'agenda' ? 'public meeting records'
      : profileLabel === 'budget' ? 'capital/CIP budget'
      : profileLabel === 'redevelopment' ? 'redevelopment/economic development'
      : profileLabel === 'media' ? 'news/media'
      : profileLabel === 'contractor' ? 'contractor portfolio'
      : profileLabel === 'institutional' ? 'institutional/campus records'
      : profileLabel === 'employer' ? 'employer/system records'
      : sourceDesc;
    // v4-b10: Enhanced evidence labels for decomposed leads
    const isDecomposedLead = extractionPath === 'decompose_named_child' || extractionPath === 'decompose_content_extract';
    const evidenceLabel = bestChildLink
      ? `${isDecomposedLead ? 'Named district/project page' : childTypeLabel(bestChildLink.linkType)} found via ${src.name} (${srcTypeContext})`
      : `Signal detected in ${src.name} (${srcTypeContext})`;
    const evTitle = leadClass === 'active_solicitation'
      ? `Active solicitation: ${evidenceLabel}`
      : isDecomposedLead
        ? `Strategic area: ${evidenceLabel}`
        : `Project signal: ${evidenceLabel}`;

    // v4-b7: Build evidence summary — lead with what was found and why it matters
    const evDetailParts = [];
    evDetailParts.push(evTitle);
    if (bestChildLink) {
      const docLabel = childTypeLabel(bestChildLink.linkType).toLowerCase();
      evDetailParts.push(`Direct ${docLabel}: "${bestChildLink.anchorText.slice(0, 80)}"`);
    }
    // v4-b9: Artifact path — show how the lead was reached
    if (childEnriched && bestChildLink) {
      const pathParts = [src.name];
      if (bestChildLink.anchorText && bestChildLink.anchorText !== title) {
        pathParts.push(bestChildLink.anchorText.slice(0, 50));
      }
      if (childEnrichment?.childTitle && childEnrichment.childTitle !== bestChildLink.anchorText) {
        pathParts.push(childEnrichment.childTitle.slice(0, 50));
      }
      if (pathParts.length >= 2) {
        evDetailParts.push(`Artifact path: ${pathParts.join(' → ')}`);
      }
    }
    // v4-b7: Prefer child enrichment evidence snippet, then best scored sentence from description
    if (childEnrichment?.evidenceSnippet) {
      evDetailParts.push(`Key finding: ${childEnrichment.evidenceSnippet}`);
    } else if (finalDescription && finalDescription.length > 30 && finalDescription !== matchText) {
      // Use the best description content (already sentence-scored) instead of raw match text
      const descSnippet = finalDescription.replace(/\s*—\s*Source:.+$/, '').trim().slice(0, 250);
      if (descSnippet.length > 20) evDetailParts.push(`Key finding: ${descSnippet}`);
    } else if (matchText.length > 20) {
      const trimmed = matchText.replace(/\s+/g, ' ').trim().slice(0, 200);
      evDetailParts.push(`Source context: ${trimmed}`);
    }
    // v4-b7: Surface budget, timeline, and dates more prominently
    if (finalDates.action_due_date) evDetailParts.push(`Due: ${finalDates.action_due_date}`);
    if (finalDates.potentialTimeline && !finalDates.action_due_date) evDetailParts.push(`Timeline: ${finalDates.potentialTimeline}`);
    if (finalBudget) evDetailParts.push(`Budget: ${finalBudget}`);
    // v4-b7: Surface bond/grant/TIF funding references from context
    const fundingCtx = (childEnrichment?.enrichedContent || fullContext || '').toLowerCase().slice(0, 2000);
    if (!finalBudget) {
      if (/\b(bond\s+(measure|issue|election|funding|revenue))\b/.test(fundingCtx)) evDetailParts.push('Funding: Bond-funded');
      else if (/\b(tif\s+(funded|revenue|district)|tax\s+increment\s+financ)\b/.test(fundingCtx)) evDetailParts.push('Funding: TIF district');
      else if (/\b(grant\s+(funded|award|recipient)|federal\s+grant|state\s+grant|cdbg)\b/.test(fundingCtx)) evDetailParts.push('Funding: Grant-funded');
      else if (/\b(mill\s+levy|levy\s+funded|voter.approved)\b/.test(fundingCtx)) evDetailParts.push('Funding: Levy/voter-approved');
    }
    if (finalLocation && !evDetailParts.some(p => p.includes(finalLocation))) evDetailParts.push(`Location: ${finalLocation}`);
    const evSummary = evDetailParts.join('. ').slice(0, 700) + '.';

    // Why-it-matters and AI assessment use final (possibly child-improved) data
    const whyItMatters = generateWhyItMatters(leadClass, finalMarket, finalLocation, scores, src, finalServiceFit);
    const aiReasonForAddition = generateAIAssessment(leadClass, finalMarket, projectType, scores, finalServiceFit, finalLocation, finalBudget);

    // Build confidence notes — layman-readable, not internal jargon
    const confParts = [];
    // Source context in plain English
    const orgName = src.organization || src.name || '';
    if (leadClass === 'active_solicitation') {
      confParts.push(`${orgName} has an active solicitation${actionDue ? ` due ${actionDue}` : ''}`);
    } else if (leadClass === 'strategic_watch') {
      confParts.push(`Strategic development/redevelopment area monitored from ${orgName}`);
    } else {
      confParts.push(`Project signal found via ${orgName}`);
    }
    // Service fit in plain English
    if (finalServiceFit.fit >= 15) confParts.push('Likely involves architectural, engineering, or planning services');
    else if (finalServiceFit.fit >= 8) confParts.push('May involve design or engineering services — review scope');
    else confParts.push('Design scope unclear — verify whether A&E services are needed');
    if (finalBudget) confParts.push(`Estimated budget: ${finalBudget}`);
    if (childEnriched) {
      const typeDesc = childTypeLabel(bestChildLink?.linkType || 'source_document').toLowerCase();
      if (childEnrichment?.pdfParsed) {
        confParts.push(`Enriched from ${typeDesc} (PDF, ${childEnrichment.pdfPageCount} pages)`);
      } else {
        confParts.push(`Enriched from ${typeDesc}`);
      }
    } else if (childEnrichment && !childEnrichment.enrichedContent) {
      confParts.push(`PDF document linked but not parseable: ${childEnrichment.pdfError || 'unknown reason'}`);
    } else if (bestChildLink) {
      confParts.push('Direct document link available (not yet fetched)');
    }
    // Taxonomy match transparency
    if (taxResult.matches.length > 0) {
      const svcM = taxResult.matches.filter(m => m.group === 'service');
      const mktM = taxResult.matches.filter(m => m.group === 'market');
      const nseM = taxResult.matches.filter(m => m.group === 'noise');
      const prsM = taxResult.matches.filter(m => m.group === 'pursuit');
      if (svcM.length > 0) confParts.push(`Service fit: ${svcM.map(m => m.label).join(', ')}`);
      if (mktM.length > 0) confParts.push(`Market: ${mktM.map(m => m.label).join(', ')}`);
      if (prsM.length > 0) confParts.push(`Pursuit: ${prsM.map(m => m.label).join(', ')}`);
      if (nseM.length > 0) confParts.push(`Noise flag: ${nseM.map(m => m.label).join(', ')}`);
    }
    if (docType.isStrategy) {
      confParts.push(`Source document: ${docType.documentType.replace(/_/g, ' ')} (intelligence context — procurement signal required)`);
    }

    // Build all evidence source links (source page + child links)
    const evidenceSourceLinks = [{ url: src.url, label: src.name, linkType: 'source_page' }];
    for (const cl of relevantChildLinks.slice(0, 5)) {
      evidenceSourceLinks.push({ url: cl.url, label: cl.anchorText, linkType: cl.linkType });
    }

    // Detect watchCategory from context
    let watchCategory = undefined;
    const wcCtx = (fullContext || '').toLowerCase();
    const srcFamily = src.source_family || src.category || '';
    if (/tif|tax increment|urban renewal|tedd|targeted economic|urd/i.test(wcCtx)) watchCategory = 'tif_district';
    else if (/redevelopment|renewal|revitalization|catalyst\s+site/i.test(wcCtx)) watchCategory = 'redevelopment_area';
    else if (/\b(development\s+(park|opportunity|target)|industrial\s+park|business\s+park|commerce\s+park|technology\s+park)\b/i.test(wcCtx)) watchCategory = 'redevelopment_area';
    else if (/\b(major\s+project|corridor\s+(plan|development|improvement)|downtown\s+(plan|development|improvement)|riverfront\s+(plan|development|improvement))\b/i.test(wcCtx)) watchCategory = 'redevelopment_area';
    else if (/annexation/i.test(wcCtx)) watchCategory = 'annexation_area';
    else if (/master plan|long.?range|lrbp|campus/i.test(wcCtx)) watchCategory = 'development_program';
    // v31: Budget/CIP-derived items get a clear label
    else if (srcFamily === 'SF-08' || /\b(capital improvement|cip|capital budget|capital plan|adopted budget|preliminary budget|capital project)\b/i.test(wcCtx)) watchCategory = 'capital_budget';
    // Strategic watch: named opportunity areas with proper names (reusable across cities/counties)
    else if (leadClass === 'strategic_watch') watchCategory = 'redevelopment_area';
    else if (status === 'watch') watchCategory = 'named_project';

    // Detect projectStatus from context
    let projectStatus = 'unknown';
    if (/\brfq\b|\brfp\b|\bsolicitation\b|\binvitation to bid\b/i.test(wcCtx)) projectStatus = 'active_solicitation';
    else if (/\bpre.?solicitation\b|\bplanning\b|\bfeasibility\b|\bpre.?design\b/i.test(wcCtx)) projectStatus = 'pre_solicitation';
    else if (/\bawarded\b|\bcontract awarded\b|\bselected\b/i.test(wcCtx)) projectStatus = 'awarded';
    else if (/\bcompleted?\b|\bfinished\b|\bsubstantial completion\b/i.test(wcCtx)) projectStatus = 'completed';
    else if (/\bfuture\b|\bproposed\b|\bplanned\b|\bbond\b|\blevy\b|\bcip\b|\bcapital improvement\b/i.test(wcCtx)) projectStatus = 'future_watch';

    // ── ProjectStatus-based suppression ──
    // If projectStatus is 'awarded' or 'completed' AND there is no open solicitation signal,
    // this is a historical reference, not a fresh opportunity. Suppress it.
    if ((projectStatus === 'awarded' || projectStatus === 'completed') && status !== 'active') {
      const hasActiveSolicitation = /\b(?:rfq|rfp|invitation\s+to\s+bid|request\s+for\s+(?:qualifications?|proposals?))\b/i.test(wcCtx);
      if (!hasActiveSolicitation) {
        log(`    ⊘ ProjectStatus suppressed (${projectStatus}, no active solicitation): "${title}"`);
        continue;
      }
    }

    leads.push({
      id, title,
      owner: src.organization || '',
      projectName: title !== `${src.organization || src.name} — ${inferType(matchText)}` ? title : '',
      location: finalLocation,
      county: src.county || '', geography: src.geography || '',
      marketSector: finalMarket,
      projectType,
      description: finalDescription,
      whyItMatters,
      aiReasonForAddition,
      potentialTimeline: finalDates.potentialTimeline,
      potentialBudget: finalBudget,
      action_due_date: actionDue,
      relevanceScore: finalAdjustedRelevance,
      pursuitScore: finalAdjustedPursuit,
      sourceConfidenceScore: scores.sourceConfidenceScore,
      confidenceNotes: confParts.join('. ') + '.',
      dateDiscovered: now, originalSignalDate: now,
      lastCheckedDate: now,
      status, leadClass, leadOrigin: 'live',
      source_document_type: docType.isStrategy ? docType.documentType : 'standard',
      watchCategory, projectStatus, extractionPath: extractionPath || 'pattern',
      leadObjectType: leadObjectType || 'unknown',
      // V4: Dashboard lane routing — profile takes priority, then object-type default
      // v4-b12: Fixed field name: frontend reads dashboard_lane (snake_case)
      dashboard_lane: profile.dashboard_lane || (
        leadObjectType === 'solicitation' || leadObjectType === 'project' ? 'active_leads'
        : leadObjectType === 'district' || leadObjectType === 'site' || leadObjectType === 'development_potential' ? 'development_potentials'
        : leadObjectType === 'news_item' ? 'news'
        : 'active_leads'
      ),
      containerChild: extractionPath === 'container_child' || false,
      sourceName: src.name, sourceUrl: src.url, sourceId: src.id,
      evidenceLinks: [...new Set([evidenceUrl, src.url])],
      evidenceSourceLinks,
      evidenceSummary: evSummary,
      matchedFocusPoints: scores.matchedFPs.map(f => f.title),
      matchedKeywords: kws.slice(0, 10),
      matchedTargetOrgs: scores.matchedOrgs.map(o => o.name),
      taxonomyMatches: taxResult.matches,
      internalContact: '', notes: '',
      evidence: [{
        id: `ev-${id}`, leadId: id, sourceId: src.id, sourceName: src.name,
        url: evidenceUrl,
        title: evTitle,
        summary: evSummary,
        signalDate: now, dateFound: now,
        signalStrength: leadClass === 'active_solicitation' ? 'strong' : (finalAdjustedRelevance > 60 ? 'medium' : 'weak'),
        keywords: kws.slice(0, 8),
        childLinks: relevantChildLinks.slice(0, 3).map(cl => ({ url: cl.url, label: cl.anchorText, type: cl.linkType })),
        enrichedFromChild: childEnriched,
        childDocumentTitle: childEnrichment?.childTitle || null,
        pdfParsed: childEnrichment?.pdfParsed || false,
        pdfPageCount: childEnrichment?.pdfPageCount || 0,
        pdfError: (!childEnriched && childEnrichment?.pdfError) ? childEnrichment.pdfError : null,
      }],
    });
  }

  // ── v32: District-level parent lead ──
  // If the source is a named redevelopment district / opportunity area and we extracted
  // subproject-level leads, also emit the district itself as a strategic_watch parent.
  // This preserves both layers: the district as a strategic geography + individual projects.
  if (isDistrictSource && leads.length > 0) {
    const srcName = (src.name || '').trim();
    const srcOrg = (src.organization || '').trim();
    // Check if the source name itself is a meaningful district/area name (not generic)
    const isNamedDistrict = /\b(urd|tif|tedd|urban renewal|redevelopment|district|development (park|opportunity)|major.?project|corridor|triangle|crossing|commons)\b/i.test(srcName);
    // Only add if we don't already have a lead with a very similar title
    const districtTitle = srcName.length >= 12 ? cleanTitle(srcName) : null;
    const alreadyHasDistrict = districtTitle && leads.some(l => {
      const normA = (l.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
      const normB = districtTitle.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
      return normA === normB || normA.includes(normB) || normB.includes(normA);
    });

    if (isNamedDistrict && districtTitle && !alreadyHasDistrict && districtTitle.length >= 12) {
      const districtId = `lead-${Date.now()}-district-${Math.random().toString(36).slice(2,7)}`;
      const subprojectNames = leads.map(l => l.title).filter(Boolean).slice(0, 5);
      const districtDesc = subprojectNames.length > 0
        ? `Strategic redevelopment area with ${leads.length} associated project(s): ${subprojectNames.join(', ')}. Source: ${srcOrg || srcName}.`
        : `Strategic redevelopment area monitored for future A&E opportunities. Source: ${srcOrg || srcName}.`;

      leads.push({
        id: districtId,
        title: districtTitle,
        owner: srcOrg || '',
        projectName: districtTitle,
        location: src.location || '', county: src.county || '', geography: src.geography || '',
        marketSector: 'Mixed Use',
        projectType: 'Other',
        description: districtDesc,
        whyItMatters: `Named strategic redevelopment area that may generate future A&E work across multiple projects.`,
        aiReasonForAddition: 'Strategic district/area watch — monitors a redevelopment geography for future pursuit opportunities.',
        potentialTimeline: '', potentialBudget: '',
        action_due_date: '',
        relevanceScore: 40, pursuitScore: 25, sourceConfidenceScore: 50,
        confidenceNotes: `Strategic district watch. Source: ${src.category || 'Unknown'}. Contains ${leads.length - 1} associated project leads.`,
        dateDiscovered: now, originalSignalDate: now, lastCheckedDate: now,
        status: 'watch', leadClass: 'strategic_watch', leadOrigin: 'live',
        watchCategory: 'redevelopment_area', projectStatus: 'future_watch',
        extractionPath: 'district_parent',
        dashboard_lane: 'development_potentials',
        sourceName: src.name, sourceUrl: src.url, sourceId: src.id,
        evidenceLinks: [src.url],
        evidenceSourceLinks: [{ url: src.url, label: src.name, linkType: 'source_page' }],
        evidenceSummary: `Strategic district: ${districtTitle}. ${districtDesc}`,
        matchedFocusPoints: [], matchedKeywords: [], matchedTargetOrgs: [],
        taxonomyMatches: [],
        internalContact: '', notes: '',
        evidence: [{
          id: `ev-${districtId}`, leadId: districtId, sourceId: src.id, sourceName: src.name,
          url: src.url, title: `Strategic district: ${districtTitle}`,
          summary: districtDesc, signalDate: now, dateFound: now,
          signalStrength: 'medium', keywords: [],
          childLinks: [], enrichedFromChild: false,
        }],
      });
      log(`  📍 District parent lead added: "${districtTitle}" (${leads.length - 1} subprojects)`);
    }
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
    // ── STATUS (GET with no action or explicit status) ──────
    if (req.method === 'GET' && (action === 'status' || !req.query?.action)) {
      return res.status(200).json({ ok: true, lastRun, time: new Date().toISOString(), version: '1.0.0', scanBuildId: SCAN_BUILD_ID });
    }

    // ── v4-b30: SERVER-SIDE DAILY SCAN (GET ?action=daily) ──
    // Triggered by Vercel cron. Reads sources + leads from Upstash Redis,
    // runs a real scan, merges results back to shared storage, publishes brief.
    if (req.method === 'GET' && action === 'daily') {
      const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
      const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (!redisUrl || !redisToken) {
        log('⚠ Server-side daily scan: no Upstash configured — cannot run without shared storage');
        return res.status(200).json({ ok: false, error: 'Upstash not configured', logs, scanBuildId: SCAN_BUILD_ID, ts: new Date().toISOString() });
      }

      // Helper: read from Upstash
      const redisGet = async (key) => {
        try {
          const r = await fetch(`${redisUrl}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${redisToken}` } });
          if (!r.ok) return null;
          const d = await r.json();
          if (!d.result) return null;
          let parsed = JSON.parse(d.result);
          if (typeof parsed === 'string') try { parsed = JSON.parse(parsed); } catch {}
          return parsed;
        } catch { return null; }
      };
      const redisSet = async (key, value) => {
        try {
          const r = await fetch(`${redisUrl}/set/${encodeURIComponent(key)}`, {
            method: 'POST', headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'text/plain' },
            body: JSON.stringify(value),
          });
          return r.ok;
        } catch { return false; }
      };

      log('═══ SERVER-SIDE DAILY SCAN ═══');
      log(`🔧 Backend Build: ${SCAN_BUILD_ID} | Server Time: ${new Date().toISOString()}`);

      // Step 1: Load sources from shared store
      let sources = await redisGet('ps_sources');
      if (!Array.isArray(sources) || sources.length === 0) {
        log('⚠ No sources in shared store (ps_sources) — the frontend must sync sources first');
        log('  → Open Project Scout in a browser, then run a scan from Settings to sync sources to shared storage');
        return res.status(200).json({ ok: false, error: 'No sources in shared store. Run a browser-driven scan first to sync sources.', logs, scanBuildId: SCAN_BUILD_ID, ts: new Date().toISOString() });
      }

      // Filter to active sources only
      const activeSources = sources.filter(s => s.active !== false);
      log(`Sources: ${activeSources.length} active of ${sources.length} total from shared store`);

      // Step 2: Load existing leads, not-pursued, submitted from shared store
      const existingLeads = (await redisGet('ps_leads')) || [];
      const notPursuedLeads = (await redisGet('ps_notpursued')) || [];
      const submittedLeads = (await redisGet('ps_submitted')) || [];
      const taxonomy = (await redisGet('ps_taxonomy')) || [];
      log(`Shared state: ${existingLeads.length} leads, ${notPursuedLeads.length} not-pursued, ${submittedLeads.length} submitted, ${taxonomy.length} taxonomy`);

      // Step 3: Normalize sources (same logic as POST daily/backfill)
      const familyCategoryMap = {
        'SF-01': 'State Procurement', 'SF-02': 'County Commission', 'SF-03': 'County Commission',
        'SF-04': 'County Commission', 'SF-05': 'Planning & Zoning', 'SF-06': 'Capital Planning',
        'SF-07': 'Capital Planning', 'SF-08': 'Capital Planning', 'SF-09': 'Economic Development',
        'SF-10': 'Capital Planning', 'SF-11': 'Capital Planning', 'SF-12': 'Public Safety',
        'SF-13': 'Capital Planning', 'SF-14': 'State Procurement', 'SF-15': 'Other', 'SF-16': 'Other',
      };
      const normalize = (src) => ({
        ...src,
        name: src.source_name || src.name || '',
        url: src.source_url || src.url || '',
        id: src.source_id || src.id || '',
        keywords: src.keywords_to_watch || src.keywords || [],
        category: familyCategoryMap[src.source_family] || src.source_family || src.category || '',
        priority: src.priority_tier || src.priority || 'medium',
        organization: src.entity_name || src.organization || src.source_name || src.name || '',
      });
      const activeNorm = activeSources.map(normalize);
      const list = activeNorm.slice(0, 15); // Daily = top 15

      // Step 4: Dedup sets (same as POST path)
      const allSubmittedTitles = [];
      for (const s of submittedLeads) {
        for (const t of [s.title, s.asana_task_name, s.scout_title, s.user_edited_title, ...(s.alternate_titles || [])].filter(Boolean)) {
          allSubmittedTitles.push(t.toLowerCase().trim());
        }
      }
      const submittedSet = new Set(allSubmittedTitles);
      const allEx = [...existingLeads, ...notPursuedLeads];
      const npSet = new Set(notPursuedLeads.map(l => (l.title||'').toLowerCase().trim()));
      const exSet = new Set([...allEx.map(l => (l.title||'').toLowerCase().trim()), ...allSubmittedTitles]);

      log(`═══ DAILY — ${list.length} of ${activeNorm.length} active sources ═══`);

      // Step 5: Run the scan (reuse the same scan loop as POST path)
      const added = [], updated = [], suppressed = [];
      let skipNP = 0, skipDupe = 0, skipLowQuality = 0, fetchOk = 0, fetchFail = 0, parseHits = 0;
      let skipGenericTitle = 0, skipPortalTitle = 0, skipWeakAEFit = 0, skipInfraOnly = 0, skipNotProjectSpecific = 0;
      const MIN_BOARD_RELEVANCE_ACTIVE = 35;
      const MIN_BOARD_RELEVANCE_WATCH = 22;
      const addedTitles = [];
      const start = Date.now();
      const sourceHealthMap = [];
      const focusPoints = [];
      const targetOrgs = [];
      const settings = { freshnessDays: 60 };
      const freshDays = 60;

      for (let i = 0; i < list.length; i++) {
        const src = list[i];
        log(`[${i+1}/${list.length}] ${src.name} (${src.url})`);

        const earlyProfile = getSourceProfile(src);

        // Public notice sources
        if (earlyProfile.profile_type === 'public_notice') {
          const noticeResult = await fetchPublicNotices(src, log);
          sourceHealthMap.push({ sourceId: src.id, status: noticeResult.ok ? 'healthy' : 'failing', error: noticeResult.err || null });
          if (noticeResult.ok) {
            fetchOk++;
            parseHits++;
            let noticeAdded = 0;
            for (const notice of noticeResult.notices) {
              const lead = extractLeadFromNotice(notice, src);
              if (!lead) continue;
              const tl = lead.title.toLowerCase().trim();
              if (exSet.has(tl) || npSet.has(tl) || submittedSet.has(tl)) { skipDupe++; continue; }
              const isDupe = addedTitles.some(at => titleSimilarity(lead.title, at) >= 0.65);
              if (isDupe) { skipDupe++; continue; }
              if (isGenericNewsHeadline(lead.title)) { skipGenericTitle++; continue; }
              if (isRetrospectiveTitle(lead.title)) { skipNotProjectSpecific++; continue; }
              exSet.add(tl); addedTitles.push(lead.title); added.push(lead); noticeAdded++;
              log(`    ✚ [${lead.status}] "${lead.title.slice(0,60)}"`);
            }
            log(`  → ${noticeAdded} notice lead(s) added`);
          } else { fetchFail++; }
          continue;
        }

        // Gmail intake
        if (earlyProfile.profile_type === 'gmail_intake') {
          const gmailResult = await fetchGmailMessages(src, log);
          if (gmailResult.unconfigured) { sourceHealthMap.push({ sourceId: src.id, status: 'unconfigured', error: 'Gmail credentials not configured' }); continue; }
          sourceHealthMap.push({ sourceId: src.id, status: gmailResult.ok ? 'healthy' : 'failing', error: gmailResult.err || null });
          if (gmailResult.ok) {
            fetchOk++;
            if (gmailResult.messages.length > 0) parseHits++;
            let gmailAdded = 0;
            for (const email of gmailResult.messages) {
              const highlights = extractHighlightsFromEmail(email, src, existingLeads);
              if (highlights.length === 0) { const lead = extractLeadFromEmail(email, src); if (lead) highlights.push(lead); }
              for (const lead of highlights) {
                const gmailDupe = added.some(a => a.gmailMessageId === email.id && titleSimilarity(a.title, lead.title) >= 0.65) ||
                  existingLeads.some(ex => ex.gmailMessageId === email.id && titleSimilarity(ex.title, lead.title) >= 0.65);
                if (gmailDupe) { skipDupe++; continue; }
                if (lead._enrichTarget) { delete lead._enrichTarget; }
                const tl = lead.title.toLowerCase().trim();
                if (exSet.has(tl) || npSet.has(tl) || submittedSet.has(tl)) { skipDupe++; continue; }
                const isDupe = addedTitles.some(at => titleSimilarity(lead.title, at) >= 0.65);
                if (isDupe) { skipDupe++; continue; }
                exSet.add(tl); addedTitles.push(lead.title); added.push(lead); gmailAdded++;
                log(`    ✚ [${lead.status}] "${lead.title.slice(0,60)}" | ${lead.projectPotential || '?'} potential`);
              }
            }
            log(`  → ${gmailAdded} highlight(s) added (${gmailResult.messages.length} messages)`);
          } else { fetchFail++; }
          continue;
        }

        // Standard HTTP source fetch
        if (!src.url) { log('  ⊘ no URL — skipping'); continue; }
        const f = await fetchUrl(src.url);
        if (!f.ok) { log(`  ✗ ${f.err||'HTTP '+f.status}`); fetchFail++; sourceHealthMap.push({ sourceId: src.id, status: 'failing', error: f.err || `HTTP ${f.status}` }); continue; }
        fetchOk++;
        sourceHealthMap.push({ sourceId: src.id, status: 'healthy', httpStatus: f.status, contentLength: f.length });
        log(`  ✓ ${f.length} chars — "${f.title||'(no title)'}"`);

        const { pass, n, kw } = preFilter(f.content, src);
        if (!pass) { log(`  — ${n} keywords (below threshold)`); continue; }
        parseHits++;
        log(`  → ${n} keywords: ${kw.slice(0,5).join(', ')}`);

        const childLinks = extractChildLinks(f.rawHtml, src.url);
        if (childLinks.length > 0) log(`  → ${childLinks.length} child document links found`);

        const srcProfile = getSourceProfile(src);
        const cands = await extractLeads(f.content, src, kw, focusPoints, targetOrgs, childLinks, log, taxonomy, f.rawHtml||'', srcProfile);
        log(`  → ${cands.length} candidate(s)`);

        for (const c of cands) {
          const tl = (c.title||'').toLowerCase().trim();
          if (npSet.has(tl)) { skipNP++; continue; }
          if (exSet.has(tl)) { skipDupe++; continue; }
          const nearDupe = addedTitles.some(at => titleSimilarity(c.title, at) >= 0.65) ||
            allEx.some(ex => titleSimilarity(c.title, ex.title) >= 0.65);
          if (nearDupe) { skipDupe++; continue; }
          if (isGenericNewsHeadline(c.title)) { skipGenericTitle++; continue; }
          if (isRetrospectiveTitle(c.title)) { skipNotProjectSpecific++; continue; }
          if (isNavigationJunk(c.title)) { skipGenericTitle++; continue; }
          const minScore = (c.status === 'active') ? MIN_BOARD_RELEVANCE_ACTIVE : MIN_BOARD_RELEVANCE_WATCH;
          if ((c.relevanceScore || 0) < minScore) { skipLowQuality++; continue; }
          exSet.add(tl); addedTitles.push(c.title); added.push(c);
          log(`    ✚ [${c.status}] "${c.title.slice(0,60)}" | score=${c.relevanceScore}`);
        }
        if (added.length >= 10) { log('  — lead cap reached'); break; }
      }

      const dur = Date.now() - start;
      log(`═══ SERVER DAILY DONE in ${(dur/1000).toFixed(1)}s ═══`);
      log(`Sources: ${fetchOk} ok, ${fetchFail} failed | Signals: ${parseHits} sources with hits`);
      log(`Leads: +${added.length} new, ${updated.length} updated, ${skipNP} not-pursued, ${skipDupe} duped, ${skipLowQuality} low-quality`);

      // Step 6: Merge added leads into shared lead corpus
      if (added.length > 0) {
        const mergedLeads = [...added, ...existingLeads];
        const saved = await redisSet('ps_leads', mergedLeads);
        if (saved) {
          log(`  ✓ Merged ${added.length} new leads into shared store (${mergedLeads.length} total)`);
        } else {
          log('  ⚠ Failed to save merged leads to shared store');
        }
      }

      // Step 7: Post-process: add highlight fields + structured evidence facts
      for (const lead of added) {
        if (!lead.projectPotential) {
          const combined = `${lead.title || ''} ${lead.description || ''}`;
          lead.projectPotential = scoreProjectPotential(combined);
        }
        if (!lead.whyItMatters || lead.whyItMatters.length < 10) {
          const signals = inferWhyAndWatch(`${lead.title || ''} ${lead.description || ''}`);
          if (!lead.whyItMatters || lead.whyItMatters.length < 10) lead.whyItMatters = signals.whyItMatters;
          if (!lead.whatToWatch) lead.whatToWatch = signals.whatToWatch;
        }
        if (!lead.evidenceFacts || lead.evidenceFacts.length === 0) {
          lead.evidenceFacts = extractEvidenceFacts(lead);
        }
      }

      // Step 8: Publish weekly brief from full corpus
      let briefResult = null;
      try {
        briefResult = await serverPublishWeeklyBrief(added, existingLeads, log);
      } catch (e) { log(`  ⚠ Brief publish error: ${e.message}`); }

      const results = {
        leadsAdded: added, leadsUpdated: updated,
        sourcesFetched: fetchOk + fetchFail, fetchSuccesses: fetchOk, fetchFailures: fetchFail,
        parseHits, duration: dur, mode: 'server-daily',
        skippedNotPursued: skipNP, skippedDuplicate: skipDupe, skippedLowQuality: skipLowQuality,
        sourceHealth: sourceHealthMap,
        briefPublished: !!briefResult, briefWeekId: briefResult?.weekId || null,
        corpusSize: existingLeads.length + added.length,
      };

      lastRun = { action: 'server-daily', ok: true, ts: new Date().toISOString(), added: added.length, updated: updated.length, dur };
      return res.status(200).json({ ok: true, action: 'server-daily', results, logs, ts: new Date().toISOString(), scanBuildId: SCAN_BUILD_ID });
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
          const srcProfile = getSourceProfile(source);
          leads = await extractLeads(f.content, source, kw.kw, body.focusPoints||[], body.targetOrgs||[], childLinks, log, body.taxonomy||[], f.rawHtml||'', srcProfile);
          log(`Extracted ${leads.length} lead(s)`);
        } else {
          log('No leads — keyword threshold not met');
        }
      }
      return res.status(200).json({ ok: f.ok, fetch: { status:f.status, title:f.title, length:f.length, lastMod:f.lastMod, error:f.err },
        keywords: kw, leads, logs, ts: new Date().toISOString() });
    }

    // ── v4-b32: CLEANUP — retroactive quality prune of shared lead corpus ─────
    if (action === 'cleanup') {
      log('═══ RETROACTIVE LEAD CLEANUP ═══');
      log(`🔧 Backend Build: ${SCAN_BUILD_ID} | Server Time: ${new Date().toISOString()}`);

      const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
      const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (!redisUrl || !redisToken) {
        return res.status(200).json({ ok: false, error: 'Upstash not configured', logs, scanBuildId: SCAN_BUILD_ID, ts: new Date().toISOString() });
      }
      const redisGet = async (key) => { try { const r = await fetch(`${redisUrl}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${redisToken}` } }); if (!r.ok) return null; const d = await r.json(); if (!d.result) return null; let p = JSON.parse(d.result); if (typeof p === 'string') try { p = JSON.parse(p); } catch {} return p; } catch { return null; } };
      const redisSet = async (key, value) => { try { const r = await fetch(`${redisUrl}/set/${encodeURIComponent(key)}`, { method: 'POST', headers: { Authorization: `Bearer ${redisToken}`, 'Content-Type': 'text/plain' }, body: JSON.stringify(value) }); return r.ok; } catch { return false; } };

      // Load shared state
      const leads = (await redisGet('ps_leads')) || [];
      const notPursued = (await redisGet('ps_notpursued')) || [];
      log(`Loaded: ${leads.length} leads, ${notPursued.length} not-pursued`);

      if (leads.length === 0) {
        return res.status(200).json({ ok: true, message: 'No leads to clean', leads: 0, pruned: 0, logs, scanBuildId: SCAN_BUILD_ID, ts: new Date().toISOString() });
      }

      const now = new Date().toISOString();
      const kept = [];
      const pruned = [];

      for (const lead of leads) {
        const title = (lead.title || '');
        const desc = (lead.description || '');
        const combined = `${title} ${desc}`;

        // Skip immune leads
        if (lead.pruneImmune || lead.favorite) { kept.push(lead); continue; }

        let reason = null;

        // 1. Generic news headline
        if (isGenericNewsHeadline(title)) reason = 'generic_news_headline';
        // 2. Noise lead (full check)
        if (!reason && isNoiseLead(title, combined, lead.sourceUrl || '')) reason = 'noise_lead';
        // 3. Retrospective
        if (!reason && isRetrospectiveTitle(title)) reason = 'retrospective';
        // 4. Navigation junk
        if (!reason && isNavigationJunk(title)) reason = 'navigation_junk';
        // 5. Very low relevance
        if (!reason && (lead.relevanceScore || 0) < 20) reason = 'very_low_relevance';
        // 6. Generic portal/listing title
        if (!reason && /^(current|open|active)\s+(solicitations?|bids?|rfps?|rfqs?)$/i.test(title.trim())) reason = 'portal_title';
        // 7. Standalone department/office page
        if (!reason && /^[\w\s&']+\s+(department|office|division|bureau|program)$/i.test(title.trim()) && !/\b(construction|design|capital|renovation|project|facility|building)\b/i.test(combined)) reason = 'generic_department';
        // 8. Vague strategic area with no substance
        if (!reason && lead.watchCategory === 'redevelopment_area' && (lead.relevanceScore || 0) < 35 && !lead.potentialBudget && !/\b(rfq|rfp|design|construction|renovation|funded|approved|authorized)\b/i.test(combined)) reason = 'weak_strategic_area';

        if (reason) {
          pruned.push({ ...lead, status: 'not_pursued', reasonNotPursued: `Retroactive cleanup: ${reason}`, dateNotPursued: now, reasonCategory: 'quality_cleanup' });
          log(`  ✂ "${title.slice(0,60)}" — ${reason}`);
        } else {
          kept.push(lead);
        }
      }

      log(`Result: ${kept.length} kept, ${pruned.length} pruned`);

      // Write back
      if (pruned.length > 0) {
        const updatedNP = [...pruned, ...notPursued];
        await redisSet('ps_leads', kept);
        await redisSet('ps_notpursued', updatedNP);
        log(`✓ Saved: ${kept.length} leads, ${updatedNP.length} not-pursued`);
      }

      return res.status(200).json({
        ok: true,
        action: 'cleanup',
        leads: kept.length,
        pruned: pruned.length,
        prunedItems: pruned.map(p => ({ title: p.title, reason: p.reasonNotPursued })),
        logs, scanBuildId: SCAN_BUILD_ID, ts: new Date().toISOString(),
      });
    }

    // ── GMAIL-TEST — diagnostic endpoint to verify Gmail pipeline ─────
    if (action === 'gmail-test') {
      log('═══ GMAIL DIAGNOSTIC TEST ═══');
      const token = await getGmailAccessToken();
      if (!token) {
        log('✗ Gmail auth FAILED — could not obtain access token');
        log('  Check GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN env vars');
        return res.status(200).json({
          ok: false, error: 'Gmail auth failed — no access token obtained',
          diagnosis: {
            hasClientId: !!process.env.GMAIL_CLIENT_ID,
            hasClientSecret: !!process.env.GMAIL_CLIENT_SECRET,
            hasRefreshToken: !!process.env.GMAIL_REFRESH_TOKEN,
          },
          logs, ts: new Date().toISOString(),
        });
      }
      log('✓ Gmail auth SUCCESS — access token obtained');

      // 1. List all labels to check if "Scout" exists
      let labels = [];
      try {
        const labelsResp = await fetch(`${GMAIL_API_BASE}/labels`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (labelsResp.ok) {
          const labelsData = await labelsResp.json();
          labels = (labelsData.labels || []).map(l => ({ id: l.id, name: l.name, type: l.type }));
          const scoutLabels = labels.filter(l => /scout/i.test(l.name));
          log(`✓ Found ${labels.length} total labels`);
          if (scoutLabels.length > 0) {
            log(`✓ Scout labels found: ${scoutLabels.map(l => l.name).join(', ')}`);
          } else {
            log('⚠ No "Scout" label found — create labels "Scout", "Scout/News", "Scout/RFP", "Scout/Projects" in Gmail');
          }
        } else {
          log(`✗ Labels API returned HTTP ${labelsResp.status}`);
        }
      } catch (e) { log(`✗ Labels fetch error: ${e.message}`); }

      // 2. Run the dynamic Scout query (same logic the scan engine uses)
      const scoutQuery = await buildGmailQuery(token, 7, log);
      let scoutResults = 0;
      try {
        const scoutResp = await fetch(`${GMAIL_API_BASE}/messages?q=${encodeURIComponent(scoutQuery)}&maxResults=5`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (scoutResp.ok) {
          const scoutData = await scoutResp.json();
          scoutResults = (scoutData.messages || []).length;
          log(`Scout query "${scoutQuery}": ${scoutResults} messages (estimate: ${scoutData.resultSizeEstimate || 0})`);
        }
      } catch (e) { log(`✗ Scout query error: ${e.message}`); }

      // 3. Run a broader query to see if ANY recent messages exist
      const broadQuery = 'newer_than:14d';
      let broadResults = 0;
      let sampleSubjects = [];
      try {
        const broadResp = await fetch(`${GMAIL_API_BASE}/messages?q=${encodeURIComponent(broadQuery)}&maxResults=5`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (broadResp.ok) {
          const broadData = await broadResp.json();
          broadResults = broadData.resultSizeEstimate || (broadData.messages || []).length;
          log(`Broad query "${broadQuery}": ~${broadResults} messages`);
          // Fetch subjects of first few
          for (const m of (broadData.messages || []).slice(0, 5)) {
            try {
              const mResp = await fetch(`${GMAIL_API_BASE}/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`, {
                headers: { Authorization: `Bearer ${token}` },
              });
              if (mResp.ok) {
                const mData = await mResp.json();
                const hdrs = mData.payload?.headers || [];
                const subj = hdrs.find(h => h.name === 'Subject')?.value || '(no subject)';
                const from = hdrs.find(h => h.name === 'From')?.value || '';
                const labelNames = (mData.labelIds || []).join(', ');
                sampleSubjects.push({ subject: subj.slice(0, 120), from: from.slice(0, 80), labels: labelNames });
                log(`  → "${subj.slice(0, 80)}" from ${from.slice(0, 50)} [${labelNames}]`);
              }
            } catch {}
          }
        }
      } catch (e) { log(`✗ Broad query error: ${e.message}`); }

      // 4. Pipeline depth assessment (v4-b25: updated to reflect full ingestion)
      log('');
      log('── Gmail Pipeline Depth Assessment (v4-b25) ──');
      log('✓ Auth: working (OAuth2 refresh → access token)');
      log(`✓ Query: dynamic label matching (${scoutQuery.slice(0, 80)})`);
      log(`${scoutResults > 0 ? '✓' : '⚠'} Messages: ${scoutResults} matching Scout query`);
      log('✓ Fetch format: FULL (text/plain + text/html MIME decoded)');
      log('✓ Full body parsing: IMPLEMENTED — reads entire email body');
      log('✓ Link following: IMPLEMENTED — follows gov/edu/org links + PDFs (up to 3 per email)');
      log('✓ PDF parsing: IMPLEMENTED — uses unpdf for linked PDFs + attachments');
      log('✓ Attachment handling: IMPLEMENTED — detects and parses PDF attachments');
      log('');
      if (scoutResults === 0 && broadResults > 0) {
        log('DIAGNOSIS: Auth works, mailbox has messages, but none match the dynamic Scout query.');
        log(`The query used was: ${scoutQuery}`);
        log('ACTION: Label at least one email with Work/Scout/News (or /RFP or /Projects) and re-run.');
      } else if (scoutResults === 0 && broadResults === 0) {
        log('DIAGNOSIS: Auth works but the mailbox appears empty (no messages in last 14 days).');
        log('ACTION: Send a test email to the Scout Gmail account, label it with a Scout label, then re-run.');
      } else {
        log('DIAGNOSIS: Gmail pipeline is receiving messages and will process them with full-depth ingestion.');
      }

      return res.status(200).json({
        ok: true,
        diagnosis: {
          authWorking: true,
          totalLabels: labels.length,
          scoutLabelsFound: labels.filter(l => /scout/i.test(l.name)).map(l => l.name),
          scoutQueryResults: scoutResults,
          broadQueryResults: broadResults,
          sampleMessages: sampleSubjects,
          pipelineDepth: {
            auth: 'working',
            messageQuery: 'dynamic_label_matching',
            messageFetch: 'full (text/plain + text/html MIME decoded)',
            bodyParsing: 'IMPLEMENTED (base64url decode, MIME recursion)',
            linkFollowing: 'IMPLEMENTED (HTML + PDF, up to 3 per email)',
            attachmentHandling: 'IMPLEMENTED (PDF attachments parsed via unpdf)',
          },
        },
        logs, ts: new Date().toISOString(),
      });
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
        const u = `https://app.asana.com/api/1.0/projects/${proj}/tasks?opt_fields=name,permalink_url,created_at,completed,completed_at,assignee.name,notes,memberships.section.name&completed_since=2020-01-01T00:00:00Z&limit=100${offset?`&offset=${offset}`:''}`;
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

    // ── VALIDATE — weekly deep-search validation of Active & Watch leads ──
    // Runs a targeted web search for each lead to detect:
    //   - project awarded / designer selected / contractor selected
    //   - project under construction or completed
    //   - new phase or reissued solicitation
    //   - stronger dates, budget, owner, or location
    // Returns per-lead validation results with audit trail.
    if (action === 'validate') {
      const leadsToValidate = body.existingLeads || [];
      if (leadsToValidate.length === 0) {
        return res.status(200).json({ ok: true, validated: [], logs, ts: new Date().toISOString() });
      }
      log(`═══ VALIDATE: ${leadsToValidate.length} leads ═══`);
      log(`  Strategy: direct source re-fetch (DDG blocked from serverless IPs)`);

      // Helper: fetch a URL and return cleaned text + metadata
      const valFetch = async (url, label) => {
        if (!url || url.length < 10) return null;
        try {
          const f = await fetchUrl(url, 10000);
          if (!f.ok) { log(`    ✗ ${label}: HTTP ${f.status || 'err'} — ${(f.err || '').slice(0, 60)}`); return null; }
          if (!f.content || f.content.length < 50) { log(`    ✗ ${label}: too short (${f.content?.length || 0} chars)`); return null; }
          log(`    ✓ ${label}: ${f.content.length} chars — "${(f.title || '').slice(0, 50)}"`);
          return { url, content: f.content.slice(0, 20000), title: f.title || '', length: f.content.length };
        } catch (e) { log(`    ✗ ${label}: ${e.message?.slice(0, 60)}`); return null; }
      };

      // Helper: extract firm/entity names — case-insensitive
      const extractFirmName = (text, pattern) => {
        const m = text.match(pattern);
        if (!m) return null;
        const after = text.slice(m.index + m[0].length, m.index + m[0].length + 100);
        let firm = after.match(/^\s*:?\s*([A-Z][\w&'.,()\/\- ]{2,55})/);
        if (!firm) firm = after.match(/^\s*:?\s*([\w&'.,()\/\- ]{3,55})/);
        if (!firm) return null;
        let name = firm[1].replace(/[.,\s]+$/, '').trim();
        name = name.replace(/\s+(is|was|has|have|will|for|the|and|or|in|on|at|to|of|by)$/i, '').trim();
        if (name.length < 3 || /^(the|a|an|for|and|is|was|has|are|not|no|this|that|from|with)\b/i.test(name)) return null;
        return name;
      };

      // Helper: assess source trust from URL
      const sourceTrust = (url) => {
        const u = (url || '').toLowerCase();
        if (/\.gov\b|\.edu\b|\.state\.\w+|\.us\//.test(u)) return 'official';
        if (/architecture\.mt\.gov/i.test(u)) return 'official';
        if (/bidexpress|questcdn|planroom|procure|procurement|bonfire|buildingconnected/i.test(u)) return 'bid_portal';
        if (/missoulian|bozemandaily|helenair|billingsgazette|flatheadbeacon|mtstandard|greatfallstribune/i.test(u)) return 'local_news';
        return 'web';
      };
      const trustLabel = (t) => ({ official: '🏛 Official', bid_portal: '📋 Bid Portal', local_news: '📰 Local News', web: '🌐 Web' }[t] || '🌐 Web');

      // Known Montana official portals to check for project info
      const MT_OFFICIAL_PORTALS = [
        'https://architecture.mt.gov',
        'https://svc.mt.gov/doa/bidandsolicitations',
      ];

      const validated = [];
      const MAX_VALIDATES = 15;
      const leadsSlice = leadsToValidate.slice(0, MAX_VALIDATES);
      if (leadsToValidate.length > MAX_VALIDATES) {
        log(`  ⚠ Capping at ${MAX_VALIDATES} leads (${leadsToValidate.length} submitted)`);
      }

      for (const lead of leadsSlice) {
        const title = lead.user_edited_title || lead.title || '';
        if (!title || title.length < 8) continue;

        log(`  ▸ Validating: "${title.slice(0, 55)}"`);

        // Collect all known URLs for this lead
        const urlsToFetch = new Set();
        if (lead.sourceUrl) urlsToFetch.add(lead.sourceUrl);
        if (lead.evidenceLinks) lead.evidenceLinks.forEach(u => { if (u) urlsToFetch.add(u); });
        if (lead.evidenceSourceLinks) {
          (Array.isArray(lead.evidenceSourceLinks) ? lead.evidenceSourceLinks : []).forEach(sl => {
            if (sl?.url) urlsToFetch.add(sl.url);
          });
        }

        // Also try MT A&E portal search page with project keywords
        const titleWords = title.replace(/[^a-zA-Z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3).slice(0, 3).join('+');
        if (titleWords.length > 5) {
          urlsToFetch.add(`https://architecture.mt.gov/DoingBusiness/BuildingCodes`);
        }

        log(`    ${urlsToFetch.size} source URL(s) to re-fetch`);

        // Fetch all known URLs
        const fetched = [];
        const allSources = [];
        let fetchIdx = 0;
        for (const url of urlsToFetch) {
          if (fetchIdx >= 4) break; // Cap at 4 fetches per lead
          const trust = sourceTrust(url);
          const label = `${trustLabel(trust)} ${url.slice(0, 60)}`;
          const result = await valFetch(url, label);
          if (result) {
            fetched.push({ ...result, trust });
            allSources.push({
              url,
              title: result.title,
              snippet: result.content.slice(0, 250),
              trust,
              trustLabel: trustLabel(trust),
            });
          }
          fetchIdx++;
        }

        if (fetched.length === 0) {
          log(`    ○ No fetchable sources — running re-evaluation on existing context only`);
          // Even without new web data, re-evaluate against current noise/stale rules
          const noFetchStatus = (lead.status || '').toLowerCase();
          const noFetchCtx = [title, lead.description || ''].join(' ');
          let noFetchRec = 'keep';
          let noFetchReason = '';

          // v30: Noise and stale checks now recommend 'review' instead of 'suppress'
          // for Watch leads. Only strong claimed evidence should auto-suppress.
          // Noise check
          if (isNoiseLead(title, noFetchCtx, lead.sourceUrl || '')) {
            noFetchRec = 'review';
            noFetchReason = 'Out-of-scope: matched noise filter on re-evaluation — queued for review';
            log(`    ⚑ Re-eval (no sources): review — noise filter`);
          }
          // Stale-date check
          if (noFetchRec === 'keep') {
            const nfCtx = noFetchCtx.toLowerCase();
            const nfYears = (nfCtx.match(/\b(20\d{2})\b/g) || []).map(Number);
            const nfMaxYear = nfYears.length > 0 ? Math.max(...nfYears) : null;
            const nfCurrentYear = new Date().getFullYear();
            const nfStale = nfMaxYear && nfMaxYear <= (nfCurrentYear - 3);
            const nfEscape = /\b(new phase|reissue|upcoming|future|planned|proposed|2025|2026|2027|2028)\b/.test(nfCtx);
            if (nfStale && !nfEscape) {
              noFetchRec = 'review';
              noFetchReason = `Stale: most recent year reference is ${nfMaxYear} — queued for review`;
              log(`    ⚑ Re-eval (no sources): review — stale (max year ${nfMaxYear})`);
            }
          }

          validated.push({
            leadId: lead.id,
            leadTitle: title,
            validated: true,
            webResultCount: 0,
            deepFetchCount: 0,
            validationDate: new Date().toISOString(),
            changes: [],
            webSources: [],
            searchError: 'no fetchable sources',
            recommendation: noFetchRec,
            recommendationReason: noFetchReason,
          });
          continue;
        }

        // Combine all fetched text
        const combinedText = fetched.map(f => f.content).join('\n');
        const combinedLo = combinedText.toLowerCase();

        // Run claimed detection
        const claimedCheck = isAlreadyClaimed(title, combinedText);
        const changes = [];

        // ── Detect project status ──
        if (claimedCheck.isClaimed) {
          const bestSource = fetched.find(f => f.trust === 'official') || fetched[0];
          changes.push({
            field: 'projectStatus',
            oldValue: lead.projectStatus || lead.status || 'unknown',
            newValue: claimedCheck.reason,
            detail: claimedCheck.detail || '',
            confidence: 'source_verified',
            source: bestSource?.url || 'source re-fetch',
            sourceTrust: bestSource?.trust || 'web',
          });
          log(`    ✦ CLAIMED: ${claimedCheck.reason}${claimedCheck.detail ? ' — ' + claimedCheck.detail.slice(0, 60) : ''} [source-verified]`);
        }

        // ── Extract architect/designer ──
        const archPatterns = [
          /architect(?:ural)?\s*(?:firm|of record)?\s*:?\s*/i,
          /design(?:ed)?\s+by\s*/i,
          /(?:a[\/ ]?e|a&e)\s*(?:firm|:)\s*/i,
          /(?:selected|chosen)\s+(?:firm|architect|designer|design team)\s*:?\s*/i,
          /design\s+team\s*:?\s*/i,
          /project\s+architect\s*:?\s*/i,
        ];
        let detectedArchitect = null;
        let archSourceUrl = null;
        for (const f of fetched) {
          for (const pat of archPatterns) {
            const firm = extractFirmName(f.content, pat);
            if (firm) { detectedArchitect = firm; archSourceUrl = f.url; break; }
          }
          if (detectedArchitect) break;
        }
        if (detectedArchitect && !lead.architect) {
          const trust = sourceTrust(archSourceUrl);
          changes.push({
            field: 'architect',
            oldValue: null,
            newValue: detectedArchitect,
            confidence: 'source_verified',
            source: archSourceUrl,
            sourceTrust: trust,
          });
          log(`    ✦ Architect: ${detectedArchitect} [from ${trustLabel(trust)}]`);
        }

        // ── Extract contractor / CM / GC ──
        const gcPatterns = [
          /(?:general\s+)?contractor\s*:?\s*/i,
          /(?:cm|gc|cm\/gc|cmar)\s*:?\s*/i,
          /design[\- ]?build(?:er)?\s*:?\s*/i,
          /(?:built|constructed)\s+by\s*/i,
          /(?:apparent\s+)?low\s+bidder\s*:?\s*/i,
          /construction\s+(?:manager|management)\s*:?\s*/i,
        ];
        let detectedContractor = null;
        let gcSourceUrl = null;
        for (const f of fetched) {
          for (const pat of gcPatterns) {
            const firm = extractFirmName(f.content, pat);
            if (firm) { detectedContractor = firm; gcSourceUrl = f.url; break; }
          }
          if (detectedContractor) break;
        }
        if (detectedContractor && !lead.contractor) {
          const trust = sourceTrust(gcSourceUrl);
          changes.push({
            field: 'contractor',
            oldValue: null,
            newValue: detectedContractor,
            confidence: 'source_verified',
            source: gcSourceUrl,
            sourceTrust: trust,
          });
          log(`    ✦ Contractor: ${detectedContractor} [from ${trustLabel(trust)}]`);
        }

        // ── Dates, budget, phase ──
        const webDates = extractDates(combinedText);
        if (webDates.action_due_date && !lead.action_due_date) {
          changes.push({ field: 'action_due_date', oldValue: null, newValue: webDates.action_due_date, confidence: 'source_verified', source: fetched[0]?.url });
          log(`    ✦ Due date: ${webDates.action_due_date}`);
        }
        if (webDates.potentialTimeline && !lead.potentialTimeline) {
          changes.push({ field: 'potentialTimeline', oldValue: null, newValue: webDates.potentialTimeline, confidence: 'source_verified', source: fetched[0]?.url });
        }
        if (!lead.potentialBudget) {
          const webBudget = extractBudget(combinedText);
          if (webBudget) {
            changes.push({ field: 'potentialBudget', oldValue: null, newValue: webBudget, confidence: 'source_verified', source: fetched[0]?.url });
            log(`    ✦ Budget: ${webBudget}`);
          }
        }
        if (/\b(reissue|re-?solicitation?|new phase|phase (2|ii|two|3|iii|three)|re-?advertis)/i.test(combinedLo)) {
          changes.push({ field: 'validationNote', oldValue: null, newValue: 'Possible new phase or reissued solicitation detected', confidence: 'source_verified', source: fetched[0]?.url });
          log(`    ✦ Possible reissue/new phase`);
        }
        if (/\b(board\s+approv|funding\s+approv|bond\s+(passed|approved)|voter\s+approv|council\s+approv)/i.test(combinedLo) && !claimedCheck.isClaimed) {
          changes.push({ field: 'validationNote', oldValue: null, newValue: 'Board or funding approval detected — project may be advancing', confidence: 'source_verified', source: fetched[0]?.url });
          log(`    ✦ Funding/board approval`);
        }

        // ── Post-validation re-evaluation ──
        // Re-evaluate this lead against current suppression rules.
        // Leads already in localStorage may predate newer noise/stale filters.
        const leadStatus = (lead.status || '').toLowerCase();
        const leadCtx = [title, lead.description || '', combinedText].join(' ');
        let recommendation = 'keep';
        let recommendationReason = '';

        // 1. Claimed leads: recommend suppression for Watch, downgrade for Active
        if (claimedCheck.isClaimed) {
          if (leadStatus === 'watch') {
            recommendation = 'suppress';
            recommendationReason = `Claimed: ${claimedCheck.reason} — ${claimedCheck.detail || 'already awarded/designed/completed'}`;
          } else {
            recommendation = 'downgrade';
            recommendationReason = `Claimed: ${claimedCheck.reason} — ${claimedCheck.detail || 'already awarded/designed/completed'}`;
          }
          log(`    ⚑ Re-eval: ${recommendation} — ${recommendationReason}`);
        }

        // v30: Noise and stale checks recommend 'review' instead of 'suppress' for Watch.
        // Only strong claimed evidence (step 1 above) can recommend 'suppress'.
        // 2. Noise check: run isNoiseLead against combined context
        if (recommendation === 'keep') {
          const noiseCheck = isNoiseLead(title, leadCtx, lead.sourceUrl || '');
          if (noiseCheck) {
            recommendation = 'review';
            recommendationReason = 'Out-of-scope: matched noise filter on re-evaluation — queued for review';
            log(`    ⚑ Re-eval: review — noise filter match`);
          }
        }

        // 3. Stale-date check: look for all-old year references
        if (recommendation === 'keep') {
          const reEvalCtx = leadCtx.toLowerCase();
          const reYears = (reEvalCtx.match(/\b(20\d{2})\b/g) || []).map(Number);
          const reMaxYear = reYears.length > 0 ? Math.max(...reYears) : null;
          const reCurrentYear = new Date().getFullYear();
          const reIsStale = reMaxYear && reMaxYear <= (reCurrentYear - 3);
          const reHasEscape = /\b(new phase|reissue|upcoming|future|planned|proposed|2025|2026|2027|2028)\b/.test(reEvalCtx);

          if (reIsStale && !reHasEscape) {
            recommendation = 'review';
            recommendationReason = `Stale: most recent year reference is ${reMaxYear} — queued for review`;
            log(`    ⚑ Re-eval: review — stale (max year ${reMaxYear})`);
          }
        }

        // 4. Historical/retrospective signals in validation text
        if (recommendation === 'keep' && fetched.length > 0) {
          const historicalPatterns = /\b(was completed|project completed|construction completed|has been completed|ribbon.cutting was held|grand opening was held|opened in \d{4}|built in \d{4}|project (was|is) (finished|done|complete))\b/i;
          if (historicalPatterns.test(combinedLo) && !/\b(new phase|phase [2-9]|next phase|expansion|additional|reissue|upcoming)\b/i.test(combinedLo)) {
            recommendation = 'review';
            recommendationReason = 'Historical: validation sources indicate project may be completed — queued for review';
            log(`    ⚑ Re-eval: review — historical/completed signals`);
          }
        }

        // Summary
        if (changes.length === 0 && recommendation === 'keep') {
          log(`    ○ No actionable findings (${fetched.length} source(s) checked)`);
        } else {
          const recLabel = recommendation !== 'keep' ? ` | recommendation: ${recommendation}` : '';
          log(`    ► ${changes.length} finding(s)${recLabel}`);
        }

        validated.push({
          leadId: lead.id,
          leadTitle: title,
          validated: true,
          webResultCount: fetched.length,
          deepFetchCount: fetched.length,
          validationDate: new Date().toISOString(),
          changes,
          webSources: allSources.slice(0, 5),
          claimed: claimedCheck.isClaimed ? claimedCheck.reason : null,
          recommendation,
          recommendationReason,
        });

        // Small delay between leads
        if (leadsSlice.indexOf(lead) < leadsSlice.length - 1) {
          await new Promise(r => setTimeout(r, 300));
        }
      }

      const claimedCount = validated.filter(v => v.claimed).length;
      const enrichedCount = validated.filter(v => v.changes.length > 0 && !v.claimed).length;
      const unchangedCount = validated.filter(v => v.changes.length === 0 && !v.searchError).length;
      const errorCount = validated.filter(v => v.searchError).length;
      const suppressCount = validated.filter(v => v.recommendation === 'suppress').length;
      const downgradeCount = validated.filter(v => v.recommendation === 'downgrade').length;
      log(`═══ VALIDATE COMPLETE ═══`);
      log(`  ${validated.length} checked | ${claimedCount} claimed | ${enrichedCount} enriched | ${unchangedCount} unchanged | ${errorCount} no sources`);
      if (suppressCount > 0 || downgradeCount > 0) {
        log(`  Re-evaluation: ${suppressCount} suppress, ${downgradeCount} downgrade`);
      }

      return res.status(200).json({
        ok: true,
        validated,
        summary: {
          totalChecked: validated.length,
          claimed: claimedCount,
          enriched: enrichedCount,
          unchanged: unchangedCount,
          errors: errorCount,
          suppressed: suppressCount,
          downgraded: downgradeCount,
        },
        logs,
        scanBuildId: SCAN_BUILD_ID,
        ts: new Date().toISOString(),
      });
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
        const u = `https://app.asana.com/api/1.0/projects/${proj}/tasks?opt_fields=name,permalink_url,created_at,completed,completed_at,assignee.name,notes,memberships.section.name&completed_since=2020-01-01T00:00:00Z&limit=100${offset?`&offset=${offset}`:''}`;
        const r = await fetch(u, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!r.ok) { const t = await r.text(); throw new Error(`Asana HTTP ${r.status}: ${t.slice(0,200)}`); }
        const d = await r.json();
        if (d.errors?.length) throw new Error(d.errors[0].message);
        tasks.push(...(d.data||[]));
        offset = d.next_page?.offset || null;
      } while (offset);
      log(`Asana: ${tasks.length} tasks`);

      // ── Diagnostic: log section discovery ──
      const sectionNames = new Set();
      let tasksWithSection = 0, tasksWithoutSection = 0;
      for (const t of tasks) {
        const sec = (t.memberships || []).find(mb => mb.section?.name);
        if (sec) {
          sectionNames.add(sec.section.name);
          tasksWithSection++;
        } else {
          tasksWithoutSection++;
        }
      }
      log(`Asana sections found: ${sectionNames.size > 0 ? [...sectionNames].join(', ') : '(none)'}`);
      log(`Asana tasks with section: ${tasksWithSection}, without: ${tasksWithoutSection}`);
      if (tasksWithoutSection > 0 && tasksWithSection === 0) {
        // Log raw memberships from first 3 tasks for debugging
        const sample = tasks.slice(0, 3).map(t => ({
          name: (t.name || '').slice(0, 50),
          memberships: t.memberships,
          memberships_count: (t.memberships || []).length,
        }));
        log(`Asana membership debug (first 3 tasks): ${JSON.stringify(sample)}`);
      }

      const norm = t => (t||'').toLowerCase().replace(/[^a-z0-9\s]/g,'').replace(/\s+/g,' ').trim();
      // Stop words — includes A&E procurement terms that inflate Jaccard on facility-type titles
      const STOP_WORDS = new Set(['the','and','for','from','with','this','that','are','was','will','has','have','been','its','our','new','all','project','county','city','state','montana',
        'architectural','engineering','services','service','professional','design','consultant','consultants','construction','renovation','replacement','improvement','improvements']);
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

      // ── Ranked match: evaluate ALL candidates per lead, pick the best ──
      // rankScore computes a composite score for ordering AND a calibrated confidence for display.
      // Returns { score, calibratedConfidence } so the displayed % reflects actual identity alignment.
      const rankScore = (lead, task, hit) => {
        let score = hit.confidence * 100; // base: 65-95
        const sigL = extractEntLoc(lead.title);
        const sigT = extractEntLoc(task.name);
        const leadLo = (lead.title || '').toLowerCase();
        const taskLo = (task.name || '').toLowerCase();

        // ── Identity signal tracking (for calibrated confidence) ──
        let identityBonus = 0;   // positive signals
        let identityPenalty = 0; // negative signals

        // Shared location (same town) — strong identity signal
        const sharedLocs = sigL.locations.filter(l => sigT.locations.includes(l));
        if (sharedLocs.length > 0) { score += 40; identityBonus += 20; }
        // Shared entity type (fire station, etc.)
        const sharedEnts = sigL.entities.filter(e => sigT.entities.includes(e));
        if (sharedEnts.length > 0) { score += 10; identityBonus += 5; }
        // Both have locations but NO overlap — likely different projects
        // This is a STRONG negative signal: different towns = almost certainly different projects.
        // Penalty must be large enough that generic entity/scope/owner overlap cannot recover it.
        if (sigL.locations.length > 0 && sigT.locations.length > 0 && sharedLocs.length === 0) {
          score -= 30; identityPenalty += 45;
        }
        // One side missing location — weaken confidence (not a negative, but not a positive)
        if ((sigL.locations.length === 0) !== (sigT.locations.length === 0)) {
          identityPenalty += 8; // uncertain — location can't be confirmed
        }
        // Scope mismatch — "new fire station" vs "bathroom remodel" etc.
        const scopeA = leadLo.match(/\b(new|addition|renovation|remodel|expansion|repair|replacement|demolition|upgrade|study|master plan|assessment)\b/g) || [];
        const scopeB = taskLo.match(/\b(new|addition|renovation|remodel|expansion|repair|replacement|demolition|upgrade|study|master plan|assessment)\b/g) || [];
        if (scopeA.length > 0 && scopeB.length > 0) {
          const scopeOverlap = scopeA.some(s => scopeB.includes(s));
          if (!scopeOverlap) { score -= 15; identityPenalty += 12; }
          else { identityBonus += 5; }
        }
        // Station number mismatch
        const leadStNum = leadLo.match(/station\s+(\d+)/);
        const taskStNum = taskLo.match(/station\s+(\d+)/);
        if (leadStNum && taskStNum && leadStNum[1] !== taskStNum[1]) { score -= 20; identityPenalty += 15; }
        if (!leadStNum && taskStNum) { score -= 5; identityPenalty += 5; }
        // Owner/entity name overlap
        const ownerLo = (lead.owner || '').toLowerCase();
        if (ownerLo.length > 3) {
          const ownerWords = ownerLo.split(/\s+/).filter(w => w.length > 3 && !STOP_WORDS.has(w));
          const taskWords = new Set(taskLo.split(/\s+/));
          const ownerHits = ownerWords.filter(w => taskWords.has(w));
          if (ownerHits.length > 0) { score += 15; identityBonus += 10; }
        }

        // ── Calibrated confidence ──
        // Start from the match-tier base, then adjust based on identity signals.
        // This replaces the flat 0.80/0.90/0.95 with a signal-aware number.
        let cal = hit.confidence * 100; // 65-95
        cal += identityBonus;
        cal -= identityPenalty;
        // Clamp to [30, 99]
        cal = Math.max(30, Math.min(99, cal));
        const calibratedConfidence = Math.round(cal) / 100;

        return { score, calibratedConfidence };
      };

      const matches = [];
      const existingLeads = body.existingLeads || [];
      log(`Asana matching: ${existingLeads.length} existing leads to match against ${tasks.length} tasks`);
      if (existingLeads.length > 0) {
        log(`  First lead: "${(existingLeads[0].title || '').slice(0, 60)}" (id: ${existingLeads[0].id || 'none'})`);
      }
      for (const lead of existingLeads) {
        let bestHit = null;
        let bestTask = null;
        let bestScore = -Infinity;
        for (const task of tasks) {
          const na=norm(lead.title), nb=norm(task.name);
          let hit = null;
          // Exact match: normalized titles are identical
          if (na === nb) {
            hit = { confidence:0.95, matchType:'exact' };
          }
          // Near-exact: one fully contains the other AND the shorter has 4+ words
          else if ((nb.includes(na) || na.includes(nb)) && Math.min(na.split(' ').length, nb.split(' ').length) >= 4) {
            hit = { confidence:0.90, matchType:'near_exact' };
          }
          // Fuzzy: Jaccard ≥ 0.65
          else {
            const s = wsim(lead.title, task.name);
            if (s >= 0.65) {
              hit = { confidence:Math.round(s*100)/100, matchType:'fuzzy' };
            }
          }
          // Tier 2: Entity+location matching (fire station + kalispell, etc.)
          if (!hit && entityLocationMatch(extractEntLoc(lead.title), extractEntLoc(task.name))) {
            hit = { confidence:0.80, matchType:'entity_location' };
          }
          if (hit) {
            const ranked = rankScore(lead, task, hit);
            if (ranked.score > bestScore) {
              bestScore = ranked.score;
              bestHit = { ...hit, confidence: ranked.calibratedConfidence };
              bestTask = task;
            }
          }
        }
        if (bestHit && bestTask) {
          const hasPermalink = !!(bestTask.permalink_url);
          log(`  ✓ BEST ${bestHit.matchType.toUpperCase()} (rank ${Math.round(bestScore)}): "${lead.title}" → "${bestTask.name}"`);
          matches.push({
            leadId: lead.id,
            taskName: bestTask.name,
            taskGid: bestTask.gid || null,
            taskUrl: hasPermalink ? bestTask.permalink_url : '',
            taskUrlIsPermalink: hasPermalink,
            confidence: bestHit.confidence,
            matchType: bestHit.matchType,
            rankScore: Math.round(bestScore),
            // Richer Asana context for history display
            asana_created_at: bestTask.created_at || null,
            asana_completed: !!bestTask.completed,
            asana_completed_at: bestTask.completed_at || null,
            asana_assignee: bestTask.assignee?.name || null,
            asana_section: taskSection(bestTask),
            asana_notes_excerpt: bestTask.notes ? bestTask.notes.slice(0, 300) : null,
          });
        }
      }
      log(`Asana: ${matches.length} matches`);
      // Also return all tasks for full import (so frontend can sync in one call)
      const allTasks = tasks.map(t => ({
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
      return res.status(200).json({ ok:true, matches, allTasks, tasks:tasks.length, mode:'connected', logs, ts:new Date().toISOString() });
    }

    // ── DAILY / BACKFILL ────────────────────────────────────
    const { sources, focusPoints, targetOrgs, existingLeads, notPursuedLeads, taxonomy, settings } = body;
    if (!sources?.length) return res.status(400).json({ error: 'body.sources required (array)' });

    const active = sources.filter(s => s.active !== false);

    // Step 15: Map source_family IDs to readable category names for high-credibility matching
    const familyCategoryMap = {
      'SF-01': 'State Procurement', 'SF-02': 'County Commission', 'SF-03': 'County Commission',
      'SF-04': 'County Commission', 'SF-05': 'Planning & Zoning', 'SF-06': 'Capital Planning',
      'SF-07': 'Capital Planning', 'SF-08': 'Capital Planning', 'SF-09': 'Economic Development',
      'SF-10': 'Capital Planning', 'SF-11': 'Capital Planning', 'SF-12': 'Public Safety',
      'SF-13': 'Capital Planning', 'SF-14': 'State Procurement', 'SF-15': 'Other', 'SF-16': 'Other',
    };
    // Normalize V2 source fields to what the engine expects
    const normalize = (src) => ({
      ...src,
      name: src.source_name || src.name || '',
      url: src.source_url || src.url || '',
      id: src.source_id || src.id || '',
      keywords: src.keywords_to_watch || src.keywords || [],
      category: familyCategoryMap[src.source_family] || src.source_family || src.category || '',
      priority: src.priority_tier || src.priority || 'medium',
      organization: src.entity_name || src.organization || src.source_name || src.name || '',
    });
    const activeNorm = active.map(normalize);

    const list = action === 'daily' ? activeNorm.slice(0, 15) : activeNorm;
    const freshDays = settings?.freshnessDays || 60;

    const activeTaxCount = (taxonomy || []).filter(t => t.status === 'active').length;
    log(`═══ ${action.toUpperCase()} — ${list.length} of ${activeNorm.length} active sources ═══`);
    log(`🔧 Backend Build: ${SCAN_BUILD_ID} | Server Time: ${new Date().toISOString()}`);
    if (activeTaxCount > 0) log(`Taxonomy: ${activeTaxCount} active items loaded`);

    // Include submittedLeads (tracked/No Go items) in dedup so the backend doesn't
    // re-generate leads that already exist in Asana tracking or were marked No Go.
    const submittedLeads = body.submittedLeads || [];
    const allSubmittedTitles = [];
    for (const s of submittedLeads) {
      for (const t of [s.title, s.asana_task_name, s.scout_title, s.user_edited_title, ...(s.alternate_titles || [])].filter(Boolean)) {
        allSubmittedTitles.push(t.toLowerCase().trim());
      }
    }
    const submittedSet = new Set(allSubmittedTitles);

    const allEx = [...(existingLeads||[]), ...(notPursuedLeads||[])];
    const npSet = new Set((notPursuedLeads||[]).map(l => (l.title||'').toLowerCase().trim()));
    const exSet = new Set([...allEx.map(l => (l.title||'').toLowerCase().trim()), ...allSubmittedTitles]);

    const added = [], updated = [], suppressed = [];
    let skipNP = 0, skipDupe = 0, skipLowQuality = 0, fetchOk = 0, fetchFail = 0, parseHits = 0;
    // Step 12: Observability counters for quality gates
    let skipGenericTitle = 0, skipPortalTitle = 0, skipWeakAEFit = 0, skipInfraOnly = 0, skipNotProjectSpecific = 0;
    // v31: Separate thresholds — Watch uses a lower bar to preserve project generators
    // v4-b6: Raised Watch from 15 to 22 — geography alone (20) plus 1 keyword (2) now barely passes.
    // This prevents items with zero signal beyond geography from surviving.
    const MIN_BOARD_RELEVANCE_ACTIVE = 35;
    const MIN_BOARD_RELEVANCE_WATCH = 22;
    // Track added titles for near-duplicate detection within this scan
    const addedTitles = [];
    const start = Date.now();

    // v4-b13: Per-source health tracking
    const sourceHealthMap = [];

    for (let i = 0; i < list.length; i++) {
      const src = list[i];
      log(`[${i+1}/${list.length}] ${src.name} (${src.url})`);

      // v4-b15: Public-notice sources use Column.us API instead of HTTP fetch
      const earlyProfile = getSourceProfile(src);
      if (earlyProfile.profile_type === 'public_notice') {
        const noticeResult = await fetchPublicNotices(src, log);
        sourceHealthMap.push({ sourceId: src.id, status: noticeResult.ok ? 'healthy' : 'failing', error: noticeResult.err || null });
        if (noticeResult.ok) {
          fetchOk++;
          parseHits++;
          let noticeAdded = 0;
          for (const notice of noticeResult.notices) {
            const lead = extractLeadFromNotice(notice, src);
            if (!lead) continue;
            // Dedup against existing leads
            const tl = lead.title.toLowerCase().trim();
            if (exSet.has(tl) || npSet.has(tl) || submittedSet.has(tl)) { skipDupe++; continue; }
            // Dedup against already-added leads in this scan
            const isDupe = addedTitles.some(at => titleSimilarity(lead.title, at) >= 0.65);
            if (isDupe) { skipDupe++; continue; }
            // Title quality gates
            if (isGenericNewsHeadline(lead.title)) { skipGenericTitle++; continue; }
            if (isRetrospectiveTitle(lead.title)) { skipNotProjectSpecific++; continue; }
            exSet.add(tl);
            addedTitles.push(lead.title);
            added.push(lead);
            noticeAdded++;
            log(`    ✚ [${lead.status}] "${lead.title.slice(0,60)}" | type=${notice.noticeType} | lane=${lead.dashboard_lane} | pub=${notice.publishedDate}`);
          }
          log(`  → ${noticeAdded} notice lead(s) added (${noticeResult.notices.length} notices fetched)`);
        } else {
          fetchFail++;
        }
        continue;
      }

      // v4-b25: Gmail intake — multi-highlight extraction with enrichment
      if (earlyProfile.profile_type === 'gmail_intake') {
        const gmailResult = await fetchGmailMessages(src, log);
        if (gmailResult.unconfigured) {
          sourceHealthMap.push({ sourceId: src.id, status: 'unconfigured', error: 'Gmail credentials not configured' });
          continue;
        }
        sourceHealthMap.push({ sourceId: src.id, status: gmailResult.ok ? 'healthy' : 'failing', error: gmailResult.err || null });
        if (gmailResult.ok) {
          fetchOk++;
          if (gmailResult.messages.length > 0) parseHits++;
          let gmailAdded = 0, gmailEnriched = 0;
          for (const email of gmailResult.messages) {
            // Extract multiple highlights from each email
            const highlights = extractHighlightsFromEmail(email, src, existingLeads || []);
            if (highlights.length === 0) {
              // Fallback to single-lead extraction for simple emails
              const lead = extractLeadFromEmail(email, src);
              if (lead) highlights.push(lead);
            }
            for (const lead of highlights) {
              // Dedup by Gmail message ID + title (allow multiple highlights from same message)
              const gmailTitleKey = `${email.id}:${lead.title}`;
              const gmailDupe = added.some(a => a.gmailMessageId === email.id && titleSimilarity(a.title, lead.title) >= 0.65) ||
                (existingLeads || []).some(ex => ex.gmailMessageId === email.id && titleSimilarity(ex.title, lead.title) >= 0.65);
              if (gmailDupe) { skipDupe++; continue; }

              // Enrich-existing if a match was found
              if (lead._enrichTarget) {
                const ex = (existingLeads || []).find(l => l.id === lead._enrichTarget);
                if (ex) {
                  updated.push({
                    leadId: ex.id,
                    lastCheckedDate: now,
                    lastUpdatedDate: now,
                    relevanceScore: Math.min(90, (ex.relevanceScore || 50) + 5),
                    newEvidence: lead.evidence?.[0] || null,
                    highlightSummary: lead.highlightSummary,
                    projectPotential: lead.projectPotential,
                    whyItMatters: lead.whyItMatters,
                    whatToWatch: lead.whatToWatch,
                  });
                  gmailEnriched++;
                  log(`    ↻ enriched existing "${ex.title?.slice(0,50)}" with "${lead.title?.slice(0,50)}" | potential=${lead.projectPotential}`);
                  continue;
                }
              }
              delete lead._enrichTarget;

              // Standard dedup by title
              const tl = lead.title.toLowerCase().trim();
              if (exSet.has(tl) || npSet.has(tl) || submittedSet.has(tl)) { skipDupe++; continue; }
              const isDupe = addedTitles.some(at => titleSimilarity(lead.title, at) >= 0.65);
              if (isDupe) { skipDupe++; continue; }

              exSet.add(tl);
              addedTitles.push(lead.title);
              added.push(lead);
              gmailAdded++;
              log(`    ✚ [${lead.status}] "${lead.title.slice(0,60)}" | ${lead.projectPotential || '?'} potential | lane=${lead.dashboard_lane} | from=${(email.from||'').slice(0,30)}`);
            }
          }
          log(`  → ${gmailAdded} highlight(s) added, ${gmailEnriched} enriched (${gmailResult.messages.length} messages)`);
        } else {
          fetchFail++;
        }
        continue;
      }

      const f = await fetchUrl(src.url);
      if (!f.ok) {
        log(`  ✗ ${f.err||'HTTP '+f.status}`);
        fetchFail++;
        sourceHealthMap.push({ sourceId: src.id, status: 'failing', error: f.err || `HTTP ${f.status}`, httpStatus: f.status });
        continue;
      }
      fetchOk++;
      sourceHealthMap.push({ sourceId: src.id, status: 'healthy', httpStatus: f.status, contentLength: f.length });
      log(`  ✓ ${f.length} chars — "${f.title||'(no title)'}"`);

      const { pass, n, kw } = preFilter(f.content, src);
      if (!pass) { log(`  — ${n} keywords (below threshold)`); continue; }
      parseHits++;
      log(`  → ${n} keywords: ${kw.slice(0,5).join(', ')}`);

      const childLinks = extractChildLinks(f.rawHtml, src.url);
      if (childLinks.length > 0) log(`  → ${childLinks.length} child document links found`);

      const srcProfile = getSourceProfile(src);
      const cands = await extractLeads(f.content, src, kw, focusPoints||[], targetOrgs||[], childLinks, log, taxonomy||[], f.rawHtml||'', srcProfile);
      log(`  → ${cands.length} candidate(s)`);

      for (const c of cands) {
        const tl = (c.title||'').toLowerCase().trim();
        if (npSet.has(tl)) { skipNP++; log(`    ⊘ blocked (Not Pursued)`); continue; }

        // Exact title dedup — with Watch→Active promotion check
        if (exSet.has(tl)) {
          const ex = allEx.find(l => (l.title||'').toLowerCase().trim() === tl);
          if (ex && (existingLeads||[]).find(l => l.id === ex.id)) {
            const updatePayload = {
              leadId: ex.id,
              lastCheckedDate: new Date().toISOString(),
              lastUpdatedDate: new Date().toISOString(),
              relevanceScore: Math.min(100, (ex.relevanceScore||50) + 3),
              newEvidence: c.evidence?.[0] || null,
              aiReasonForAddition: c.aiReasonForAddition,
            };
            // Watch→Active promotion: if existing lead is Watch and new scan found active solicitation
            const exIsWatch = ex.status === 'watch' || ex.status === 'monitoring' || ex.status === 'new';
            const newIsActive = c.status === 'active' && c.leadClass === 'active_solicitation';
            if (exIsWatch && newIsActive) {
              updatePayload.status = 'active';
              updatePayload.leadClass = 'active_solicitation';
              updatePayload.projectStatus = c.projectStatus || 'active_solicitation';
              if (c.action_due_date) updatePayload.action_due_date = c.action_due_date;
              if (c.potentialTimeline) updatePayload.potentialTimeline = c.potentialTimeline;
              log(`    ⬆ PROMOTED Watch→Active: "${(c.title||'').slice(0,50)}"`);
            } else {
              // Still update timeline and status info if improved
              if (c.potentialTimeline && !ex.potentialTimeline) updatePayload.potentialTimeline = c.potentialTimeline;
              if (c.action_due_date && !ex.action_due_date) updatePayload.action_due_date = c.action_due_date;
              log(`    ↻ updated existing lead`);
            }
            updated.push(updatePayload);
          }
          skipDupe++; continue;
        }

        // Near-duplicate check: word similarity against existing leads AND already-added leads
        // v4-b10: Profile-decomposed leads (named districts/projects) are exempt from
        // cross-source dedup — "Riverfront Triangle URD" from MRA is strategically distinct
        // from "Riverfront Triangle" from MEP investment promotion
        const isDecompLead = c.extractionPath === 'decompose_named_child' || c.extractionPath === 'decompose_content_extract';
        let nearDupe = false;
        if (!isDecompLead) {
          for (const ex of allEx) {
            if (titleSimilarity(c.title, ex.title) >= 0.65) {
              log(`    ⊘ near-duplicate of existing: "${c.title.slice(0,50)}" ≈ "${ex.title.slice(0,50)}"`);
              nearDupe = true;
              skipDupe++;
              break;
            }
          }
        }
        if (!nearDupe && !isDecompLead) {
          // v4-b6: Use a lower similarity threshold for news-lane leads (0.50 vs 0.65)
          const isNewsLead = c.dashboard_lane === 'news' || (srcProfile.dashboard_lane === 'news' && !c.dashboard_lane);
          const crossSourceThreshold = isNewsLead ? 0.50 : 0.65;
          for (const at of addedTitles) {
            if (titleSimilarity(c.title, at) >= crossSourceThreshold) {
              log(`    ⊘ near-duplicate of new lead: "${c.title.slice(0,50)}" ≈ "${at.slice(0,50)}"`);
              nearDupe = true;
              skipDupe++;
              break;
            }
          }
        }
        // Also check against submitted/tracked items using entity+location matching
        // This catches cases like "Kalispell Fire Station" vs "Kalispell Fire Station Renovation"
        // where word similarity may be below 0.65 but entity+location match is definitive.
        if (!nearDupe && submittedLeads.length > 0) {
          const candEntLoc = extractEntLoc(c.title);
          if (candEntLoc.entities.length > 0) {
            for (const sub of submittedLeads) {
              const subTitles = [sub.title, sub.asana_task_name, sub.scout_title, sub.user_edited_title, ...(sub.alternate_titles || [])].filter(Boolean);
              for (const st of subTitles) {
                if (entityLocationMatch(candEntLoc, extractEntLoc(st))) {
                  log(`    ⊘ entity+location match to tracked item: "${c.title.slice(0,50)}" ≈ "${st.slice(0,50)}"`);
                  nearDupe = true;
                  skipDupe++;
                  break;
                }
              }
              if (nearDupe) break;
            }
          }
        }
        if (nearDupe) continue;

        // ── Step 12: Title-quality gates (handler level) ──
        // These gates catch generic/portal/non-project titles that extractLeads
        // allowed through. Previously these gates only existed in boardQualityPrune
        // (client-side), so the handler showed "0 blocked" while adding obvious noise.
        if (isPortalFragmentTitle(c.title)) {
          skipPortalTitle++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'portal_fragment_title' });
          log(`    ⊘ BLOCKED (portal title): ${c.title.slice(0,60)}`);
          continue;
        }
        // validateLiveTitle: comprehensive title quality gate (catches statutes, fragments, cross-products, consultant names, etc.)
        const vlt = validateLiveTitle(c.title);
        if (!vlt.pass) {
          skipGenericTitle++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: `vlt_${vlt.reason}` });
          log(`    ⊘ BLOCKED (title validation — ${vlt.reason}): ${c.title.slice(0,60)}`);
          continue;
        }
        // Generic "Org — Solicitation/Type" fallback titles
        const clo = (c.title || '').toLowerCase().trim();
        if (/^[\w\s&'\u2019.,()]+\s*[\u2013\u2014\-]\s*(solicitations?|bids?|rfps?|rfqs?|procurement|opportunities|project signal|capital improvement|bond\/levy program|master plan|renovation project|expansion project|public notices?)$/i.test(clo)) {
          skipGenericTitle++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'generic_fallback_title' });
          log(`    ⊘ BLOCKED (generic title): ${c.title.slice(0,60)}`);
          continue;
        }
        // Procurement-only titles (no identifiable project/service/building)
        {
          const stripped = clo.replace(/^[\w\s&'\u2019.,]+\s*[\u2013\u2014\-]\s*/, '').trim();
          const target = stripped || clo;
          const procWords = /^(bid|bids|rfq|rfp|rfqs|rfps|solicitation|solicitations|proposal|proposals|qualification|qualifications|quote|quotes|procurement|purchasing|notice|notices|opportunity|opportunities|invitation|request|current|open|active|closed|awarded|pending|public|for|to|of|the|and|a|an|\/|\s|[–—\-.|,&:#()!?])+$/i;
          if (procWords.test(target) && target.length > 2 &&
              !/\b(architect|design|building|school|hospital|fire station|library|courthouse|facility|renovation|addition|remodel|campus|clinic|terminal|modernization|expansion|assessment|a\/e|engineering services)\b/i.test(clo)) {
            skipPortalTitle++;
            suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'procurement_only_title' });
            log(`    ⊘ BLOCKED (procurement-only title): ${c.title.slice(0,60)}`);
            continue;
          }
        }
        // Slash-delimited or truncated hub titles: "RFQ / Request for Quotes / RFQu..."
        if (/^(rfq|rfp|bid|solicitation)\s*[\/\u2013\u2014\-]/i.test(clo) && !/\b(architect|design|building|school|hospital|facility|fire station|library|renovation|remodel)\b/i.test(clo)) {
          skipPortalTitle++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'hub_title' });
          log(`    ⊘ BLOCKED (hub title): ${c.title.slice(0,60)}`);
          continue;
        }
        // "Public Notice(s) #xxx" — numbered notices without project content
        if (/^public\s+notices?\s*#/i.test(clo) && !/\b(architect|design|building|school|hospital|facility|renovation|construction)\b/i.test(clo)) {
          skipPortalTitle++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'public_notice_number' });
          log(`    ⊘ BLOCKED (numbered public notice): ${c.title.slice(0,60)}`);
          continue;
        }
        // Noise title patterns (maps, bid results, nav pages)
        if (/\b(printable map|bid map|interactive map|gis viewer)\b/i.test(clo) ||
            /\b(bid results|bid tabulation|plan holders?|vendor list|bidder list)\b/i.test(clo) ||
            /^(home|about|news|events|contact|board|staff|resources|documents|calendar|agenda|minutes)$/i.test(clo.trim()) ||
            /\b(information for the overall|public works construction schedule|construction management office)\b/i.test(clo)) {
          skipGenericTitle++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'noise_title' });
          log(`    ⊘ BLOCKED (noise title): ${c.title.slice(0,60)}`);
          continue;
        }

        // Step 14x: v4-b6r2 — Real-scan-driven noise patterns
        // Standalone school name links — "[Name] Elementary/Middle/High School" without project action
        if (/^[\w\s.']+\s+(elementary|middle|high)\s+school\s*$/i.test(clo.trim()) &&
            !/\b(renovation|construction|design|rfq|rfp|addition|replacement|upgrade|expansion|remodel|bond|modernization|project)\b/i.test(clo)) {
          skipGenericTitle++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'standalone_school_name' });
          log(`    ⊘ BLOCKED (standalone school name): ${c.title.slice(0,60)}`);
          continue;
        }
        // "High School and Dual Enrollment" — school program, not a project
        if (/\b(dual\s+enrollment|high\s+school\s+and\s+dual)\b/i.test(clo) &&
            !/\b(renovation|construction|design|rfq|rfp|building|facility|project)\b/i.test(clo)) {
          skipGenericTitle++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'school_admin_content' });
          log(`    ⊘ BLOCKED (school admin): ${c.title.slice(0,60)}`);
          continue;
        }
        // Scholarship, school supply, transfer info, recreation programs
        if (/\b(scholarships?|school\s+supplies|transfer\s+information|student\s+data\s+privacy|student\s+forms|suicide\s+prevention|safe\s+firearm|traffic\s+education|volunteer\s+resources)\b/i.test(clo) &&
            !/\b(renovation|construction|design|rfq|rfp|addition|replacement|upgrade|building\s+project)\b/i.test(clo)) {
          skipGenericTitle++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'school_admin_content' });
          log(`    ⊘ BLOCKED (school admin content): ${c.title.slice(0,60)}`);
          continue;
        }
        // Recreation programs/activities — not A&E projects
        if (/\b(afterschool|after.?school|ropes?\s+course|team\s+building|summer\s+camp|folf|pickleball|tennis\s+rx|trails?\s+shuttle|recreation\s+guide|sports?\s+turf\s+dashboard|resident\s+discount|dual\s+enrollment|school.?s?\s+out)\b/i.test(clo) &&
            !/\b(renovation|construction|design|rfq|rfp|addition|replacement|facility\s+(design|renovation|construction))\b/i.test(clo) &&
            !/\bbuild(ing)?\b/i.test(clo.replace(/\bteam\s+building\b/gi, ''))) {
          skipGenericTitle++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'recreation_program' });
          log(`    ⊘ BLOCKED (recreation program): ${c.title.slice(0,60)}`);
          continue;
        }
        // Permit fee schedules, inspection fees
        if (/\b(fire\s+inspection\s+and\s+plan\s+check\s+fees|permit\s+fees?|fee\s+schedule|inspection\s+fees)\b/i.test(clo) &&
            !/\b(renovation|construction|design|rfq|rfp|project|building\s+project)\b/i.test(clo)) {
          skipGenericTitle++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'fee_schedule' });
          log(`    ⊘ BLOCKED (fee schedule): ${c.title.slice(0,60)}`);
          continue;
        }
        // IT/Website modernization — not A&E scope
        if (/\bwebsite\s+(modernization|redesign|replacement|upgrade|migration|overhaul)\b/i.test(clo) &&
            !/\b(architect|building|facility|a\/e|design\s+services)\b/i.test(clo)) {
          skipGenericTitle++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'it_website_project' });
          log(`    ⊘ BLOCKED (IT/website project): ${c.title.slice(0,60)}`);
          continue;
        }
        // Facility rental marketing pages
        if (/\b(rent\s+a\s+(county|city|town)\s+facility|facility\s+rental|venue\s+rental|get\s+married\s+at)\b/i.test(clo)) {
          skipGenericTitle++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'facility_rental' });
          log(`    ⊘ BLOCKED (facility rental): ${c.title.slice(0,60)}`);
          continue;
        }
        // Annual report titles without project specifics
        if (/\b(annual\s+report|year\s+in\s+review|annual\s+review)\b/i.test(clo) &&
            !/\b(renovation|construction|design|rfq|rfp|project|facility|building)\b/i.test(clo)) {
          skipGenericTitle++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'annual_report' });
          log(`    ⊘ BLOCKED (annual report): ${c.title.slice(0,60)}`);
          continue;
        }
        // Chapter/section headings from documents
        if (/^chapter\s+\d+\s*[-–—:]/i.test(clo)) {
          skipGenericTitle++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'chapter_heading' });
          log(`    ⊘ BLOCKED (chapter heading): ${c.title.slice(0,60)}`);
          continue;
        }
        // Very old master plan references (pre-2015)
        if (/^(19\d{2}|200\d|201[0-4])\s+master\s+plan\b/i.test(clo)) {
          skipGenericTitle++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'outdated_plan' });
          log(`    ⊘ BLOCKED (outdated plan): ${c.title.slice(0,60)}`);
          continue;
        }
        // v4-b23: Testimonial/marketing language suppression
        if (/\b(excellent choice|great experience|highly recommend|wonderful|amazing|fantastic|pleasure to work|look forward to|thank you for|trusted partner|premier|leading provider|best in class)\b/i.test(clo) &&
            !/\b(rfq|rfp|solicitation|renovation|construction|design|project|facility|building)\b/i.test(clo)) {
          skipGenericTitle++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'testimonial_marketing' });
          log(`    ⊘ BLOCKED (testimonial/marketing): ${c.title.slice(0,60)}`);
          continue;
        }
        // v4-b23: Out-of-Missoula contractor/news items — suppress leads with explicit non-Missoula locations
        if (/\b(billings|bozeman|helena|great falls|kalispell|butte|spokane|boise|idaho falls|coeur d.alene|seattle)\b/i.test(c.location || '')) {
          // Allow through only if title explicitly mentions Missoula
          if (!/missoula/i.test(c.title || '')) {
            skipGenericTitle++;
            suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'out_of_missoula_geography' });
            log(`    ⊘ BLOCKED (out of Missoula geography: ${c.location}): ${c.title.slice(0,60)}`);
            continue;
          }
        }
        // Contractor portfolio nav lists — multiple project names with dates concatenated
        if (/\d{4}\s+[\w\s']+\s+\d{4}\s+[\w\s']+\d{4}/i.test(clo) || /\w+\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4}/i.test(clo)) {
          if (clo.length > 60 && (clo.match(/\d{4}/g) || []).length >= 2) {
            skipGenericTitle++;
            suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'nav_list_concat' });
            log(`    ⊘ BLOCKED (nav list concatenation): ${c.title.slice(0,60)}`);
            continue;
          }
        }
        // Parks synthetic turf/equipment replacement — not A&E building scope
        if (/\b(synthetic\s+turf|sports?\s+field\s+lighting|tennis\s+and\s+pickleball|turf\s+and\s+equip)\b/i.test(clo) &&
            !/\b(architect|building|facility|renovation|design\s+services|a\/e)\b/i.test(clo)) {
          skipGenericTitle++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'park_equipment' });
          log(`    ⊘ BLOCKED (park equipment): ${c.title.slice(0,60)}`);
          continue;
        }
        // Standalone organization names as titles
        if (/^(missoula\s+redevelopment\s+agency|community\s+planning[,\s&]+development[,\s&]*(innovation|sustainability)?|development\s+opportunities)$/i.test(clo.trim())) {
          skipGenericTitle++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'org_name_title' });
          log(`    ⊘ BLOCKED (organization name): ${c.title.slice(0,60)}`);
          continue;
        }
        // Educational/comparison pages (not a project)
        if (/\b(vs\.?\s+outside|within\s+an?\s+urban\s+renewal\s+district\s+vs|benefits?\s+of\s+an?\s+urd|how\s+(do|does)\s+an?\s+urd\s+work)\b/i.test(clo)) {
          skipGenericTitle++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'educational_comparison' });
          log(`    ⊘ BLOCKED (educational/comparison page): ${c.title.slice(0,60)}`);
          continue;
        }
        // Storm damage / permit information (not a project)
        if (/\b(storm\s+damage\s+and\s+building\s+permit\s+information|building\s+permit\s+information)\b/i.test(clo)) {
          skipGenericTitle++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'permit_info_page' });
          log(`    ⊘ BLOCKED (permit info page): ${c.title.slice(0,60)}`);
          continue;
        }

        // v4-b16: Non-project service/concession/operational items
        if (/\b(concession\s+(operator|contract|services?)|food\s+service|catering|vending\s+(machine|service)|janitorial|custodial\s+services?|pest\s+control|elevator\s+maintenance|trash\s+(collection|hauling)|snow\s+removal\s+contract|mowing\s+contract)\b/i.test(clo) &&
            !/\b(renovation|construction|design|architect|building|facility\s+(design|renovation|construction))\b/i.test(clo)) {
          skipGenericTitle++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'service_contract' });
          log(`    ⊘ BLOCKED (service/concession contract): ${c.title.slice(0,60)}`);
          continue;
        }
        // v4-b20: Contractor portfolio nav-list concatenations
        // "YMCA Wellness Center Addition Tamarack Brewing Co" — multiple project names mashed together
        if (clo.length > 40 && !/\b(rfq|rfp|bid|solicitation)\b/i.test(clo)) {
          const capWords = (c.title || '').match(/[A-Z][a-z]+/g) || [];
          const wordCount = clo.split(/\s+/).length;
          if (capWords.length >= 4 && wordCount >= 6 && /\b(addition|renovation|improvement)\b/i.test(clo) &&
              capWords.filter(w => w.length >= 4).length >= 4) {
            skipGenericTitle++;
            suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'nav_list_concat' });
            log(`    ⊘ BLOCKED (nav list concatenation): ${c.title.slice(0,60)}`);
            continue;
          }
        }
        // v4-b20: Role/representation descriptions (not projects)
        // "Representing Bonner Mill TIF Industrial District" is a board-member role description
        if (/^representing\s+/i.test(clo)) {
          skipGenericTitle++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'role_description' });
          log(`    ⊘ BLOCKED (role description): ${c.title.slice(0,60)}`);
          continue;
        }
        // v4-b17: Meeting venue / location strings (not projects)
        if (/^location\s*:/i.test(clo)) {
          skipGenericTitle++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'meeting_venue' });
          log(`    ⊘ BLOCKED (meeting venue string): ${c.title.slice(0,60)}`);
          continue;
        }
        // v4-b17: Board member titles (not projects)
        if (/^(member|chair|vice.chair|secretary|treasurer|alternate|ex.officio)\s*[-–—:]/i.test(clo)) {
          skipGenericTitle++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'board_member' });
          log(`    ⊘ BLOCKED (board member): ${c.title.slice(0,60)}`);
          continue;
        }
        // v4-b16: Community development partnerships / programs (not projects)
        if (/^community\s+development\s+partnerships?\s*$/i.test(clo.trim())) {
          skipGenericTitle++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'program_not_project' });
          log(`    ⊘ BLOCKED (program, not project): ${c.title.slice(0,60)}`);
          continue;
        }
        // v4-b16: Generic MSO / airport invitation without project name
        if (/^mso\s*[-–—]\s*(invitation\s+to\s+bid|itb|bid)\s*$/i.test(clo.trim())) {
          // Try to extract a better title from description
          const descLo = (c.description || '').toLowerCase();
          const airportProjectMatch = descLo.match(/\b(airport\s+improvement|terminal|runway|taxiway|apron|hangar|parking|concourse|security)\s+\w+/i);
          if (airportProjectMatch) {
            c.title = `MSO Airport — ${airportProjectMatch[0].trim().replace(/^\w/, ch => ch.toUpperCase())}`;
            log(`    ↳ airport title improved: "${c.title}"`);
          }
        }

        // Step 14a: v4-b6 — Retrospective/historical title filter
        // Titles describing completed/past events are not forward-looking leads.
        if (isRetrospectiveTitle(c.title)) {
          skipNotProjectSpecific++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'retrospective_title' });
          log(`    ⊘ BLOCKED (retrospective title): ${c.title.slice(0,60)}`);
          continue;
        }
        // Step 14b: v4-b6 — Generic news headline filter
        // Catches market-commentary, listicle, and vague trend titles.
        if (isGenericNewsHeadline(c.title)) {
          skipGenericTitle++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'generic_news_headline' });
          log(`    ⊘ BLOCKED (generic news headline): ${c.title.slice(0,60)}`);
          continue;
        }

        // Step 14: Universal title quality gates (Active + Watch)
        // These checks apply to ALL leads — a truncated mid-sentence fragment is never
        // an acceptable lead title regardless of Active/Watch classification.
        // Truncated fragments ending with articles/prepositions/connectors
        if (/\b(the|a|an|of|for|and|or|is|are|was|in|on|at|to|with|from|by|vs|vs\.)\s*\.{0,3}$/.test(clo)) {
          skipNotProjectSpecific++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'truncated_fragment' });
          log(`    ⊘ BLOCKED (truncated fragment): ${c.title.slice(0,60)}`);
          continue;
        }
        // Mid-sentence fragments starting with lowercase connectors
        if (/^(is |are |was |were |has |have |had |being |or |and |but |for |of |with |to |in |on |at |by |from |that |this |which |where |when |it |its |their |our |your |if |as |so |than )/.test(clo)) {
          skipNotProjectSpecific++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'mid_sentence_fragment' });
          log(`    ⊘ BLOCKED (mid-sentence fragment): ${c.title.slice(0,60)}`);
          continue;
        }

        // Step 13: Watch-specific title quality gate (handler level)
        // Watch leads must identify one specific future project — not a generic heading,
        // page fragment, budget purpose statement, or broad plan reference
        if (c.status === 'watch' || c.status === 'new' || c.status === 'monitoring') {
          const watchCheck = isWatchTitleAcceptable(c.title);
          if (!watchCheck.pass) {
            skipNotProjectSpecific++;
            suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: `watch_not_specific:${watchCheck.reason}` });
            log(`    ⊘ BLOCKED (Watch not specific — ${watchCheck.reason}): ${c.title.slice(0,60)}`);
            continue;
          }
        }

        // Step 15: v4-b6 — News relevance gate
        // News-lane leads must contain actual development/building/project intelligence.
        // Generic civic, crime, opinion, retrospective news is filtered.
        if (c.dashboard_lane === 'news' || (srcProfile.dashboard_lane === 'news' && !c.dashboard_lane)) {
          if (!isNewsRelevant(c.title, c.description || '')) {
            skipNotProjectSpecific++;
            suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, reason: 'news_not_relevant' });
            log(`    ⊘ BLOCKED (news not A&E relevant): ${c.title.slice(0,60)}`);
            continue;
          }
        }

        exSet.add(tl);
        // v31: Quality gate — Watch uses a lower relevance threshold (monitoring layer, not cleanup)
        const isWatchCandidate = c.status === 'watch' || c.status === 'new' || c.status === 'monitoring';
        const minRelevance = isWatchCandidate ? MIN_BOARD_RELEVANCE_WATCH : MIN_BOARD_RELEVANCE_ACTIVE;
        if ((c.relevanceScore || 0) < minRelevance) {
          skipLowQuality++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, marketSector: c.marketSector, reason: 'below_relevance_threshold' });
          log(`    ↓ SUPPRESSED (relevance ${c.relevanceScore} < ${minRelevance}): ${c.title.slice(0,60)}`);
          continue;
        }
        // v31: Generic Other/Other gate — only suppress Active leads; Watch leads survive at any score
        if (!isWatchCandidate && c.marketSector === 'Other' && (c.projectType === 'Other' || !c.projectType) && (c.relevanceScore || 0) < 50) {
          skipLowQuality++;
          suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, marketSector: c.marketSector, reason: 'generic_weak_fit' });
          log(`    ↓ SUPPRESSED (generic/weak ${c.relevanceScore}): ${c.title.slice(0,60)}`);
          continue;
        }
        // v31: Infrastructure gate — only suppress Active leads; Watch infrastructure survives
        if (!isWatchCandidate && c.marketSector === 'Infrastructure' && (c.relevanceScore || 0) < 50) {
          const hasBuilding = /\b(treatment (plant|facility)|building|architect|pump (house|building)|control (building|room)|facility (design|renovation))\b/i.test((c.description || '').toLowerCase());
          if (!hasBuilding) {
            skipLowQuality++;
            suppressed.push({ title: c.title, relevanceScore: c.relevanceScore, marketSector: c.marketSector, reason: 'infrastructure_no_building' });
            log(`    ↓ SUPPRESSED (infrastructure/no building ${c.relevanceScore}): ${c.title.slice(0,60)}`);
            continue;
          }
        }
        // Attach dashboard_lane from source profile if not already set
        if (!c.dashboard_lane && srcProfile.dashboard_lane) {
          c.dashboard_lane = srcProfile.dashboard_lane;
        }
        addedTitles.push(c.title);
        added.push(c);
        log(`    ✚ [${c.status}] "${c.title.slice(0,60)}" | pStatus=${c.projectStatus||'?'} | wCat=${c.watchCategory||'?'} | lane=${c.dashboard_lane||'active_leads'} | path=${c.extractionPath||'pattern'} | src=${src.id||src.name}`);
      }
      if (added.length >= (action === 'daily' ? 10 : 40)) { log('  — lead cap reached'); break; }
    }

    // v4-b33: Post-process all added leads with highlight fields + structured evidence facts
    for (const lead of added) {
      if (!lead.projectPotential) {
        const combined = `${lead.title || ''} ${lead.description || ''} ${lead.whyItMatters || ''}`;
        lead.projectPotential = scoreProjectPotential(combined);
      }
      if (!lead.whyItMatters || lead.whyItMatters.length < 10) {
        const combined = `${lead.title || ''} ${lead.description || ''}`;
        const signals = inferWhyAndWatch(combined);
        if (!lead.whyItMatters || lead.whyItMatters.length < 10) lead.whyItMatters = signals.whyItMatters;
        if (!lead.whatToWatch) lead.whatToWatch = signals.whatToWatch;
      }
      if (!lead.highlightSummary && lead.description) {
        const sentences = (lead.description || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).filter(s => s.length > 20 && s.length < 300);
        lead.highlightSummary = sentences.slice(0, 3).join(' ').slice(0, 350);
      }
      // v4-b33: Extract and attach structured evidence facts
      if (!lead.evidenceFacts || lead.evidenceFacts.length === 0) {
        lead.evidenceFacts = extractEvidenceFacts(lead);
      }
    }

    const dur = Date.now() - start;
    const results = {
      leadsAdded: added, leadsUpdated: updated, leadsSuppressed: suppressed,
      skippedNotPursued: skipNP, skippedDuplicate: skipDupe, skippedLowQuality: skipLowQuality,
      skippedGenericTitle: skipGenericTitle, skippedPortalTitle: skipPortalTitle,
      skippedWeakAEFit: skipWeakAEFit, skippedInfraOnly: skipInfraOnly,
      skippedNotProjectSpecific: skipNotProjectSpecific,
      totalQualityBlocked: skipGenericTitle + skipPortalTitle + skipWeakAEFit + skipInfraOnly + skipNotProjectSpecific,
      sourcesFetched: fetchOk + fetchFail, fetchSuccesses: fetchOk, fetchFailures: fetchFail,
      parseHits, duration: dur, mode: 'live',
      // v4-b13: Per-source health for frontend source registry updates
      sourceHealth: sourceHealthMap,
    };

    log(`═══ DONE in ${(dur/1000).toFixed(1)}s ═══`);
    log(`Sources: ${fetchOk} ok, ${fetchFail} failed | Signals: ${parseHits} sources with hits`);
    const activeCount = added.filter(l => l.status === 'active').length;
    const watchCount = added.filter(l => l.status === 'watch' || l.status === 'monitoring').length;
    log(`Leads: +${added.length} new (${activeCount} active, ${watchCount} watch), ${updated.length} updated, ${skipNP} not-pursued, ${skipDupe} duped, ${skipLowQuality} low-quality`);
    const totalBlocked = skipGenericTitle + skipPortalTitle + skipWeakAEFit + skipInfraOnly + skipNotProjectSpecific;
    log(`Quality gates: ${totalBlocked} blocked total — ${skipGenericTitle} generic-title, ${skipPortalTitle} portal/procurement-only, ${skipWeakAEFit} weak-A&E, ${skipInfraOnly} infra-only, ${skipNotProjectSpecific} not-project-specific`);

    lastRun = { action, ok: true, ts: new Date().toISOString(), added: added.length, updated: updated.length, dur };

    // ── v4-b29: Server-side weekly brief auto-publish ──
    // After a successful scan, compute and publish the weekly brief snapshot to shared storage.
    // Uses the same Upstash Redis that store.js uses, so the frontend can fetch it.
    try {
      const briefPublished = await serverPublishWeeklyBrief(added, existingLeads || [], log);
      if (briefPublished) {
        results.briefPublished = true;
        results.briefWeekId = briefPublished.weekId;
      }
    } catch (briefErr) {
      log(`⚠ Brief auto-publish error: ${briefErr.message}`);
    }

    return res.status(200).json({ ok: true, action, results, logs, ts: new Date().toISOString(), scanBuildId: SCAN_BUILD_ID });

  } catch (err) {
    log(`FATAL: ${err.stack || err.message}`);
    lastRun = { action, ok: false, ts: new Date().toISOString(), error: err.message };
    return res.status(500).json({ ok: false, error: err.message, logs, ts: new Date().toISOString() });
  }
};
