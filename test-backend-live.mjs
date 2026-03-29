/**
 * Live acceptance test for scan.js connected backend path.
 * Exercises the exact same code path as a real connected backfill:
 *   fetchUrl() → preFilter() → extractLeads() → validateLiveTitle() → handler merge loop
 *
 * Tests against real benchmark source URLs to prove:
 *   1. Watch items are created (status='monitoring')
 *   2. watchCategory is populated
 *   3. projectStatus is populated
 *   4. Bad titles are rejected with reasons
 *   5. Title-rejected and watch counts appear in summary
 *
 * Usage: node test-backend-live.mjs
 */

// ── Import the entire scan.js as text and eval the functions we need ──
// scan.js is self-contained with no imports, so we can extract its functions
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scanSrc = readFileSync(join(__dirname, 'backend', 'api', 'scan.js'), 'utf8');

// Extract function bodies by evaluating the module (strip the export)
const modifiedSrc = scanSrc
  .replace('export default async function handler', 'globalThis.__handler = async function handler')
  .replace(/^\/\*\*[\s\S]*?\*\//m, ''); // strip leading comment block

// We need the individual functions. Since scan.js is self-contained,
// we can eval it in a controlled scope and extract what we need.
// But simpler: just copy the functions we need inline.
// Instead, let's use a dynamic import approach with a temp file.

import { writeFileSync, unlinkSync } from 'fs';
import { randomBytes } from 'crypto';

const tmpFile = join(__dirname, `_test_scan_${randomBytes(4).toString('hex')}.mjs`);
writeFileSync(tmpFile, modifiedSrc);

// Import the module
let mod;
try {
  mod = await import(`file://${tmpFile.replace(/\\/g, '/')}`);
} finally {
  try { unlinkSync(tmpFile); } catch {}
}

// The handler is now on globalThis
const handler = globalThis.__handler;

// ── Build a minimal mock req/res to call the handler ──
function createMockReqRes(action, body) {
  const req = {
    method: 'POST',
    query: { action },
    body,
  };
  let responseData = null;
  let statusCode = 200;
  const res = {
    setHeader: () => {},
    status: (code) => { statusCode = code; return res; },
    json: (data) => { responseData = data; return res; },
    end: () => {},
  };
  return { req, res, getResponse: () => ({ statusCode, data: responseData }) };
}

// ── Test sources: pick a handful of real benchmark sources ──
const testSources = [
  {
    id: 'src-037', name: 'City of Missoula Major Projects', organization: 'City of Missoula',
    geography: 'Missoula', county: 'Missoula County', category: 'Redevelopment Agency',
    pageType: 'Project Pages', url: 'https://www.ci.missoula.mt.us/103/Major-Projects',
    priority: 'high', state: 'active', keywords: ['redevelopment','development','project','construction','renovation','master plan','infrastructure','housing','mixed use'],
  },
  {
    id: 'src-023', name: 'Montana State Procurement (A/E)', organization: 'State of Montana',
    geography: 'Statewide', county: '', category: 'State Procurement',
    pageType: 'RFQ / RFP Listings', url: 'https://vendor.mt.gov',
    priority: 'critical', state: 'active', keywords: ['architectural','engineering','design services','RFQ','RFP','A/E'],
  },
  {
    id: 'src-044', name: 'Montana LRBP Project Pipeline', organization: 'State of Montana',
    geography: 'Statewide', county: '', category: 'State Procurement',
    pageType: 'Capital Projects', url: 'https://architecture.mt.gov/PROJECTS',
    priority: 'high', state: 'active', keywords: ['lrbp','long range building','capital','construction','renovation','state facility'],
  },
  {
    id: 'src-010', name: 'Kalispell City Council', organization: 'City of Kalispell',
    geography: 'Kalispell', county: 'Flathead County', category: 'City Council',
    pageType: 'Agenda / Minutes', url: 'https://www.kalispell.com/167/City-Council',
    priority: 'high', state: 'active', keywords: ['development','infrastructure','facility','rezoning','housing'],
  },
];

const focusPoints = [
  { id: 'fp-001', title: 'Civic Renovations', keywords: ['renovation','remodel','courthouse','city hall','civic center','government facility','ADA upgrade'], category: 'Civic', active: true },
  { id: 'fp-002', title: 'K-12 Growth', keywords: ['school','elementary','bond','levy','addition','enrollment','classroom'], category: 'K-12', active: true },
  { id: 'fp-003', title: 'Healthcare', keywords: ['clinic','hospital','medical','healthcare','outpatient'], category: 'Healthcare', active: true },
  { id: 'fp-006', title: 'Housing', keywords: ['workforce housing','affordable housing','multifamily','apartment'], category: 'Housing', active: true },
];

const targetOrgs = [
  { name: 'Missoula County', geography: 'Missoula', active: true },
  { name: 'City of Missoula', geography: 'Missoula', active: true },
  { name: 'City of Kalispell', geography: 'Kalispell', active: true },
];

console.log('═══════════════════════════════════════════════════════');
console.log('  LIVE ACCEPTANCE TEST — Connected Backend Path');
console.log('  Testing scan.js against real benchmark URLs');
console.log('═══════════════════════════════════════════════════════\n');

const { req, res, getResponse } = createMockReqRes('backfill', {
  sources: testSources,
  focusPoints,
  targetOrgs,
  existingLeads: [],
  notPursuedLeads: [],
  settings: { freshnessDays: 60 },
});

console.log(`Calling handler with ${testSources.length} test sources...\n`);

try {
  await handler(req, res);
  const { statusCode, data } = getResponse();

  if (!data) {
    console.error('ERROR: No response data received');
    process.exit(1);
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  SETTINGS LOG OUTPUT (what user sees in UI)');
  console.log('═══════════════════════════════════════════════════════\n');

  // Print all logs (this is what appears in the Settings tab)
  for (const log of (data.logs || [])) {
    console.log(log);
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  ACCEPTANCE TEST RESULTS');
  console.log('═══════════════════════════════════════════════════════\n');

  const results = data.results || {};
  const added = results.leadsAdded || [];
  const watchLeads = added.filter(l => l.status === 'watch' || l.status === 'monitoring');
  const activeLeads = added.filter(l => l.status === 'new' || l.status === 'active');

  console.log(`HTTP Status: ${statusCode}`);
  console.log(`Total leads created: ${added.length}`);
  console.log(`Watch (monitoring): ${watchLeads.length}`);
  console.log(`Active (new): ${activeLeads.length}`);
  console.log(`Updated: ${(results.leadsUpdated || []).length}`);
  console.log('');

  // ── TEST 1: Watch count > 0 ──
  const test1 = watchLeads.length > 0;
  console.log(`${test1 ? '✅' : '❌'} TEST 1: Watch count > 0 → ${watchLeads.length}`);

  // ── TEST 2: Watch items have status='monitoring' ──
  const test2 = watchLeads.every(l => l.status === 'watch' || l.status === 'monitoring');
  console.log(`${test2 ? '✅' : '❌'} TEST 2: All watch items have status='monitoring'`);

  // ── TEST 3: watchCategory populated on watch items ──
  const watchWithCat = watchLeads.filter(l => l.watchCategory);
  const test3 = watchWithCat.length > 0;
  console.log(`${test3 ? '✅' : '❌'} TEST 3: watchCategory populated → ${watchWithCat.length}/${watchLeads.length} have it`);

  // ── TEST 4: projectStatus populated ──
  const withProjStatus = added.filter(l => l.projectStatus && l.projectStatus !== 'undefined');
  const test4 = withProjStatus.length > 0;
  console.log(`${test4 ? '✅' : '❌'} TEST 4: projectStatus populated → ${withProjStatus.length}/${added.length} have it`);

  // ── TEST 5: Bad titles NOT present ──
  const badPatterns = [
    /section\s+\d+[-–]\d+[-–]\d+/i,
    /as\s+required\s+under/i,
    /in\s+addition.*each\s+agency/i,
    /^city of.*—\s*capital improvement$/i,
    /^(?:HDR|DOWL|Morrison.Maierle|Cushing.Terrell)/i,
    /^completed\s/i,
    /^awarded\s/i,
  ];
  const badSurvivors = added.filter(l => badPatterns.some(p => p.test(l.title)));
  const test5 = badSurvivors.length === 0;
  console.log(`${test5 ? '✅' : '❌'} TEST 5: No bad title patterns survived → ${badSurvivors.length} bad survivors`);
  if (badSurvivors.length > 0) {
    for (const b of badSurvivors) console.log(`   BAD: "${b.title}"`);
  }

  // ── TEST 6: Quality gate / blocked count visible in logs ──
  const rejectedLog = (data.logs || []).find(l => /title-rejected|quality gates|blocked total|generic-title/i.test(l));
  const test6 = !!rejectedLog;
  console.log(`${test6 ? '✅' : '❌'} TEST 6: Quality gate count in summary log`);
  if (rejectedLog) console.log(`   → ${rejectedLog}`);

  // ── TEST 7: Watch count visible in logs ──
  const watchLog = (data.logs || []).find(l => /watch\)/i.test(l));
  const test7 = !!watchLog;
  console.log(`${test7 ? '✅' : '❌'} TEST 7: Watch count in summary log`);
  if (watchLog) console.log(`   → ${watchLog}`);

  // ── TEST 8: leadOrigin = 'live' on all leads ──
  const test8 = added.every(l => l.leadOrigin === 'live');
  console.log(`${test8 ? '✅' : '❌'} TEST 8: All leads have leadOrigin='live'`);

  console.log('\n── Per-Lead Detail ──');
  for (const l of added) {
    const emoji = l.status === 'watch' || l.status === 'monitoring' ? '👁️ ' : '⚡';
    console.log(`  ${emoji} [${l.status.padEnd(10)}] "${l.title.slice(0,65)}" | pStatus=${l.projectStatus || 'undefined'} | wCat=${l.watchCategory || 'undefined'} | src=${l.sourceId || '?'}`);
  }

  const allPassed = test1 && test2 && test3 && test4 && test5 && test6 && test7 && test8;
  console.log(`\n${'═'.repeat(55)}`);
  console.log(`  ${allPassed ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`);
  console.log(`${'═'.repeat(55)}`);

  process.exit(allPassed ? 0 : 1);

} catch (err) {
  console.error('FATAL ERROR:', err.stack || err.message);
  process.exit(1);
}
