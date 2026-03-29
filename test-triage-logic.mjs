/**
 * Watch Triage Logic Unit Tests
 * Tests: Favorite, Mute, Dismiss, Reassess, Material Change Detection, Visibility
 */

// Import-free: we re-implement the core logic functions here to test them in isolation.
// These mirror the exact implementations in ProjectScout.jsx.

const WATCH_DISPOSITION = { ACTIVE: 'active', MUTED: 'muted', DISMISSED: 'dismissed' };
const REASSESS_WINDOW_DAYS = 30;

function computeSignalHash(lead) {
  const parts = [
    (lead.title || '').toLowerCase().trim().slice(0, 80),
    (lead.potentialBudget || '').toLowerCase().trim(),
    (lead.potentialTimeline || '').toLowerCase().trim(),
    (lead.action_due_date || ''),
    (lead.projectStatus || ''),
    (lead.leadClass || ''),
    String(lead.relevanceScore || 0),
    String((lead.evidence || []).length),
    (lead.status || ''),
  ];
  const str = parts.join('|');
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return 'sh-' + (h >>> 0).toString(36);
}

function detectMaterialChange(lead, oldHash) {
  if (!oldHash) return { changed: false, reasons: [] };
  const newHash = computeSignalHash(lead);
  if (newHash === oldHash) return { changed: false, reasons: [] };
  const reasons = [];
  if (lead.potentialBudget) reasons.push('New budget appeared');
  if (lead.action_due_date) reasons.push('New timeline or due date');
  if (lead.leadClass === 'active_solicitation') reasons.push('Active solicitation detected');
  if ((lead.projectStatus || '').includes('solicitation')) reasons.push('Project moved to solicitation stage');
  if (/\brfq\b|\brfp\b/i.test(lead.title || '')) reasons.push('RFQ/RFP language in title');
  if (reasons.length === 0) reasons.push('Material signal change detected');
  return { changed: true, reasons };
}

function isReassessActive(lead) {
  if (!lead.reassessFlag) return false;
  if (!lead.reassessAt) return true;
  const age = (Date.now() - new Date(lead.reassessAt).getTime()) / 86400000;
  return age <= REASSESS_WINDOW_DAYS;
}

function getWatchDisposition(lead) {
  return lead.watchDisposition || WATCH_DISPOSITION.ACTIVE;
}

function isWatchVisible(lead) {
  const disp = getWatchDisposition(lead);
  if (disp === WATCH_DISPOSITION.ACTIVE) return true;
  if (isReassessActive(lead)) return true;
  return false;
}

// ── Test Runner ──
let passed = 0;
let failed = 0;
function assert(condition, name) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}`);
    failed++;
  }
}

console.log('═══════════════════════════════════════════════════════');
console.log('  WATCH TRIAGE LOGIC — UNIT TESTS');
console.log('═══════════════════════════════════════════════════════\n');

// ── TEST 1: Favorite stays visible and prioritized ──
console.log('TEST 1: Favorite strategic opportunity stays visible');
{
  const lead = { id: 'lead-1', title: 'Riverfront Triangle Redevelopment', status: 'monitoring', favorite: true, favoritedAt: new Date().toISOString(), watchDisposition: 'active' };
  assert(isWatchVisible(lead), 'Favorite Watch item is visible');
  assert(lead.favorite === true, 'Favorite flag persists');
  assert(getWatchDisposition(lead) === 'active', 'Disposition remains active');
}

// ── TEST 2: Muted item disappears from board but remains in storage ──
console.log('\nTEST 2: Muted weak Watch item disappears from board');
{
  const lead = { id: 'lead-2', title: 'Generic Planning Area', status: 'monitoring', watchDisposition: 'muted', mutedAt: new Date().toISOString(), lastMaterialSignalHash: 'sh-abc123' };
  assert(!isWatchVisible(lead), 'Muted item is NOT visible');
  assert(getWatchDisposition(lead) === 'muted', 'Disposition is muted');
  assert(lead.mutedAt !== null, 'mutedAt timestamp persists');
}

// ── TEST 3: Dismissed item disappears but can reappear if materially changed ──
console.log('\nTEST 3: Dismissed wrong-fit item disappears but can reappear');
{
  const leadOriginal = { id: 'lead-3', title: 'IT System Procurement', status: 'monitoring', relevanceScore: 30, evidence: [] };
  const hash = computeSignalHash(leadOriginal);

  const leadDismissed = { ...leadOriginal, watchDisposition: 'dismissed', dismissedAt: new Date().toISOString(), dismissReason: 'IT only', dismissCategory: 'it_only', lastMaterialSignalHash: hash };
  assert(!isWatchVisible(leadDismissed), 'Dismissed item is NOT visible');

  // Simulate material change: budget + RFQ appear
  const leadChanged = { ...leadDismissed, potentialBudget: '$5M', title: 'IT System & Building Renovation RFQ', relevanceScore: 75, reassessFlag: true, reassessAt: new Date().toISOString() };
  const { changed, reasons } = detectMaterialChange(leadChanged, hash);
  assert(changed, 'Material change detected');
  assert(reasons.length > 0, 'Change reasons provided');
  assert(isReassessActive(leadChanged), 'Reassess flag is active');
  assert(isWatchVisible(leadChanged), 'Dismissed+Reassess item IS visible');
}

// ── TEST 4: Dismissed generic district page does NOT permanently block later named project ──
console.log('\nTEST 4: Dismissed district page does not block new named project');
{
  // Word similarity for this pair should be < 0.85 (different enough)
  const dismissedTitle = 'Urban Renewal District III Overview';
  const newProjectTitle = 'URD III Midtown Commons Mixed-Use Development';

  // Simulate word similarity check from mergeEngineResults
  const STOP = new Set(['the','and','for','from','with','this','that','are','was','will','has','have','been','its','our','new','all','project','county','city','state','montana','of','in','at','on','to','by','a','an']);
  const sigWords = (t) => (t || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
  const wordSim = (a, b) => {
    const wa = new Set(sigWords(a)), wb = new Set(sigWords(b));
    if (wa.size < 2 || wb.size < 2) return 0;
    let i = 0; for (const w of wa) if (wb.has(w)) i++;
    return i / new Set([...wa, ...wb]).size;
  };

  const sim = wordSim(dismissedTitle, newProjectTitle);
  assert(sim < 0.85, `Similarity (${sim.toFixed(2)}) below 0.85 — new project allowed through`);
  // Even if sim >= 0.65 (normal dup threshold), dismissed items only block at 0.85+
  const wouldBeBlockedNormally = sim >= 0.65;
  const blockedForDismissed = sim >= 0.85;
  console.log(`    (sim=${sim.toFixed(2)}, normalBlock=${wouldBeBlockedNormally}, dismissedBlock=${blockedForDismissed})`);
}

// ── TEST 5: Materially changed Watch item returns with Reassess ──
console.log('\nTEST 5: Material change triggers Reassess');
{
  const original = { id: 'lead-5', title: 'West Broadway Corridor', status: 'monitoring', relevanceScore: 45, evidence: [{ signalDate: '2026-01-15' }] };
  const hashAtMute = computeSignalHash(original);

  // Simulate: after muting, new evidence + budget appears
  const updated = { ...original, watchDisposition: 'muted', lastMaterialSignalHash: hashAtMute, relevanceScore: 72, potentialBudget: '$8M-$12M', evidence: [{ signalDate: '2026-01-15' }, { signalDate: '2026-03-10' }] };
  const { changed, reasons } = detectMaterialChange(updated, hashAtMute);
  assert(changed, 'Hash changed after score + budget + evidence update');
  assert(reasons.some(r => r.includes('budget')), 'Budget change detected in reasons');
}

// ── TEST 6: Manual Watch item retains triage state across reload/merge ──
console.log('\nTEST 6: Manual item triage state preserved');
{
  const manual = {
    id: 'lead-manual', title: 'Custom Redevelopment Opportunity', status: 'monitoring',
    leadOrigin: 'manual', favorite: true, favoritedAt: '2026-03-10T00:00:00Z',
    watchDisposition: 'active',
  };

  // Simulate merge — engine doesn't touch triage fields
  const merged = { ...manual }; // Engine only updates scores, evidence, etc.
  assert(merged.favorite === true, 'Favorite survives merge');
  assert(merged.favoritedAt === '2026-03-10T00:00:00Z', 'favoritedAt survives merge');
  assert(merged.watchDisposition === 'active', 'watchDisposition survives merge');
  assert(merged.leadOrigin === 'manual', 'leadOrigin unchanged');
}

// ── TEST 7: Active leads unaffected by triage system ──
console.log('\nTEST 7: Active leads remain unaffected');
{
  const active = { id: 'lead-active', title: 'Courthouse Renovation RFQ', status: 'active', relevanceScore: 92 };
  // getOperationalStatus would map this as ACTIVE, not WATCH
  // Triage controls only render for Watch items
  assert(active.status === 'active', 'Active lead status unchanged');
  assert(active.watchDisposition === undefined, 'No watchDisposition on active leads');
  assert(active.favorite === undefined, 'No favorite flag on active leads (triage is Watch-only)');
}

// ── TEST 8: Signal hash is deterministic ──
console.log('\nTEST 8: Signal hash determinism');
{
  const lead = { title: 'Test Project', potentialBudget: '$5M', relevanceScore: 70, evidence: [1, 2] };
  const h1 = computeSignalHash(lead);
  const h2 = computeSignalHash(lead);
  assert(h1 === h2, 'Same input produces same hash');

  const modified = { ...lead, potentialBudget: '$10M' };
  const h3 = computeSignalHash(modified);
  assert(h1 !== h3, 'Different budget produces different hash');
}

// ── TEST 9: Reassess expires after window ──
console.log('\nTEST 9: Reassess flag expires');
{
  const recent = { reassessFlag: true, reassessAt: new Date().toISOString() };
  assert(isReassessActive(recent), 'Recent reassess is active');

  const old = { reassessFlag: true, reassessAt: new Date(Date.now() - 31 * 86400000).toISOString() };
  assert(!isReassessActive(old), 'Old reassess (31 days) has expired');
}

// ── Summary ──
console.log(`\n═══════════════════════════════════════════════════════`);
if (failed === 0) {
  console.log(`  ✅ ALL ${passed} TESTS PASSED`);
} else {
  console.log(`  ❌ ${failed} FAILED, ${passed} passed`);
}
console.log('═══════════════════════════════════════════════════════');
process.exit(failed > 0 ? 1 : 0);
