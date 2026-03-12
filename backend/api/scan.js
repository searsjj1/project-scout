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
      title: tm ? tm[1].trim() : null,
      length: content.length,
      lastMod: r.headers.get('last-modified'),
      err: null,
    };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, status: null, content: null, title: null, length: 0, lastMod: null,
      err: e.name === 'AbortError' ? `Timeout (${timeout}ms)` : e.message };
  }
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

// ── Extract leads from real fetched content ─────────────────
function extractLeads(content, src, kws, fps, orgs) {
  if (!content || content.length < 50) return [];
  const lo = content.toLowerCase();
  const mOrgs = (orgs||[]).filter(o => o.active !== false && lo.includes(o.name.toLowerCase()));
  const mFPs = (fps||[]).filter(f => f.active !== false && (f.keywords||[]).some(k => lo.includes(k.toLowerCase())));
  const pats = [
    /(?:proposed|planned|approved|new|upcoming)\s+(?:construction|renovation|addition|building|facility|project|development|expansion)\b[^.]{10,150}/gi,
    /(?:rfq|rfp|invitation to bid|request for)\s+(?:qualifications?|proposals?)\s*(?:for|:)[^.]{10,120}/gi,
    /(?:capital improvement|bond|levy)\s+(?:plan|project|program)[^.]{5,100}/gi,
    /(?:design services?|architectural services?|engineering services?)\s+(?:for|needed|required)[^.]{5,100}/gi,
  ];
  const leads = [], seen = new Set();
  for (const p of pats) {
    for (const m of content.matchAll(p)) {
      const ctx = m[0].trim();
      const key = ctx.slice(0,40).toLowerCase();
      if (ctx.length < 25 || seen.has(key)) continue;
      seen.add(key);
      const geo = ['Missoula','Kalispell','Whitefish','Hamilton','Polson'].some(g=>(src.geography||'').includes(g)) ? 15 : 8;
      const rel = Math.min(100, geo + Math.min(25,kws.length*4) + Math.min(20,mFPs.length*10) + Math.min(15,mOrgs.length*8) + (src.priority==='critical'?10:src.priority==='high'?7:4));
      const pur = Math.min(100, Math.round(rel*0.6 + (/rfq|rfp|bid/i.test(ctx)?20:5)));
      const conf = Math.min(100, ({'State Procurement':92,'County Commission':88,'City Council':85,'Planning & Zoning':85,'School Board':82,'Airport Authority':80}[src.category]||65));
      const id = `lead-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
      leads.push({
        id, title:`${src.organization||src.name} — ${ctx.length>80?ctx.slice(0,77)+'...':ctx}`,
        owner:src.organization||'', projectName:'',
        location:src.geography?`${src.geography}, MT`:'Western Montana',
        county:src.county||'', geography:src.geography||'',
        marketSector:mFPs[0]?.category||'Other',
        projectType:/rfq|rfp|bid/i.test(ctx)?'RFQ/RFP':/renovation|remodel/i.test(ctx)?'Renovation':/addition|expansion/i.test(ctx)?'Addition':'Other',
        description:`Live source: "${ctx}"`,
        whyItMatters:`${src.category} signal in ${src.geography||'Western Montana'}.`,
        aiReasonForAddition:`Live from ${src.name}. KW: ${kws.slice(0,4).join(', ')}.${mOrgs.length?' Org: '+mOrgs.map(o=>o.name).join(', ')+'.':''}`,
        potentialTimeline:'', potentialBudget:'',
        relevanceScore:rel, pursuitScore:pur, sourceConfidenceScore:conf,
        confidenceNotes:`Live. ${kws.length}kw ${mFPs.length}fp ${mOrgs.length}org`,
        dateDiscovered:new Date().toISOString(), originalSignalDate:new Date().toISOString(),
        lastCheckedDate:new Date().toISOString(), status:'new', leadOrigin:'live',
        sourceName:src.name, sourceUrl:src.url, sourceId:src.id,
        evidenceLinks:[src.url], evidenceSummary:`"${ctx.slice(0,150)}"`,
        matchedFocusPoints:mFPs.map(f=>f.title), matchedKeywords:kws.slice(0,8),
        matchedTargetOrgs:mOrgs.map(o=>o.name), internalContact:'', notes:'',
        evidence:[{id:`ev-${id}`,leadId:id,sourceId:src.id,sourceName:src.name,url:src.url,
          title:`Live — ${src.name}`,summary:ctx.slice(0,200),
          signalDate:new Date().toISOString(),dateFound:new Date().toISOString(),
          signalStrength:rel>70?'strong':rel>45?'medium':'weak',keywords:kws.slice(0,5)}],
      });
      if (leads.length >= 3) break;
    }
    if (leads.length >= 3) break;
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
          leads = extractLeads(f.content, source, kw.kw, body.focusPoints||[], body.targetOrgs||[]);
          log(`Extracted ${leads.length} lead(s)`);
        } else {
          log('No leads — keyword threshold not met');
        }
      }
      return res.status(200).json({ ok: f.ok, fetch: { status:f.status, title:f.title, length:f.length, lastMod:f.lastMod, error:f.err },
        keywords: kw, leads, logs, ts: new Date().toISOString() });
    }

    // ── ASANA CHECK ─────────────────────────────────────────
    if (action === 'asana') {
      const token = body.settings?.asanaToken || process.env.ASANA_ACCESS_TOKEN;
      if (!token) {
        log('Asana: no token configured');
        return res.status(200).json({ ok: false, error: 'No Asana access token. Set in Settings or ASANA_ACCESS_TOKEN env var.', mode: 'unavailable', logs, ts: new Date().toISOString() });
      }
      const proj = body.settings?.asanaProjectId || process.env.ASANA_PROJECT_ID || '1203575716271060';
      log(`Asana: fetching project ${proj}...`);
      let tasks = [], offset = null;
      do {
        const u = `https://app.asana.com/api/1.0/projects/${proj}/tasks?opt_fields=name,permalink_url&limit=100${offset?`&offset=${offset}`:''}`;
        const r = await fetch(u, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!r.ok) { const t = await r.text(); throw new Error(`Asana HTTP ${r.status}: ${t.slice(0,200)}`); }
        const d = await r.json();
        if (d.errors?.length) throw new Error(d.errors[0].message);
        tasks.push(...(d.data||[]));
        offset = d.next_page?.offset || null;
      } while (offset);
      log(`Asana: ${tasks.length} tasks`);

      const norm = t => (t||'').toLowerCase().replace(/[^a-z0-9\s]/g,'').replace(/\s+/g,' ').trim();
      const wsim = (a,b) => {
        const wa=new Set(norm(a).split(' ').filter(w=>w.length>2));
        const wb=new Set(norm(b).split(' ').filter(w=>w.length>2));
        if(!wa.size||!wb.size) return 0;
        let i=0; for(const w of wa) if(wb.has(w)) i++;
        return i / new Set([...wa,...wb]).size;
      };

      const matches = [];
      for (const lead of (body.existingLeads||[])) {
        for (const task of tasks) {
          const na=norm(lead.title), nb=norm(task.name);
          if (na===nb || nb.includes(na) || na.includes(nb)) {
            matches.push({ leadId:lead.id, taskName:task.name, taskUrl:task.permalink_url||'', confidence:0.95, matchType:'exact' });
            log(`  ✓ EXACT: "${lead.title}" → "${task.name}"`);
            break;
          }
          const s = wsim(lead.title, task.name);
          if (s > 0.5) {
            matches.push({ leadId:lead.id, taskName:task.name, taskUrl:task.permalink_url||'', confidence:Math.round(s*100)/100, matchType:'fuzzy' });
            log(`  ~ FUZZY (${Math.round(s*100)}%): "${lead.title}" → "${task.name}"`);
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
      organization: src.entity_id || src.organization || '',
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

      const cands = extractLeads(f.content, src, kw, focusPoints||[], targetOrgs||[]);
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
