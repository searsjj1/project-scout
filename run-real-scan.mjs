#!/usr/bin/env node
/**
 * run-real-scan.mjs — Local scan runner for real-case validation
 *
 * Imports the scan.js handler directly, creates mock req/res objects,
 * and runs a real backfill scan against live Missoula source URLs.
 *
 * Usage: node run-real-scan.mjs
 *
 * No API keys needed — the scan engine uses regex/heuristic extraction,
 * not an external AI model, for the core lead generation pipeline.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import the scan handler
const scanModule = await import('./backend/api/scan.js');
const handler = scanModule.default;

// Import seed data for sources
const seedModule = await import('./src/data/seedData.js');
const { SEED_SOURCES, SEED_VERSION } = seedModule;

// Get active sources
const activeSources = SEED_SOURCES.filter(s => s.active !== false && !s.v4_deactivated);

console.log(`\n═══ REAL SCAN RUNNER ═══`);
console.log(`Seed Version: ${SEED_VERSION}`);
console.log(`Active sources: ${activeSources.length}`);
console.log(`Scanning all active sources...\n`);

// Create mock request/response
const mockReq = {
  method: 'POST',
  query: { action: 'backfill' },
  body: {
    sources: activeSources,
    focusPoints: [],
    targetOrgs: [],
    existingLeads: [],
    notPursuedLeads: [],
    submittedLeads: [],
    taxonomy: [],
    settings: {
      freshnessDays: 60,
      recheckDays: 7,
    },
  },
};

let responseData = null;
const mockRes = {
  setHeader: () => mockRes,
  status: (code) => {
    mockRes._statusCode = code;
    return mockRes;
  },
  json: (data) => {
    responseData = data;
    return mockRes;
  },
  end: () => mockRes,
  _statusCode: 200,
};

// Run the scan
const startTime = Date.now();
try {
  await handler(mockReq, mockRes);
} catch (err) {
  console.error('Scan failed:', err.message);
  process.exit(1);
}
const duration = ((Date.now() - startTime) / 1000).toFixed(1);

if (!responseData) {
  console.error('No response data received');
  process.exit(1);
}

console.log(`\n═══ SCAN COMPLETE (${duration}s) ═══\n`);

const results = responseData.results || {};
const leads = results.leadsAdded || [];
const suppressed = results.leadsSuppressed || [];

// ── Summary stats ──
console.log('── LEAD COUNTS ──');
console.log(`  Total leads added: ${leads.length}`);
console.log(`  Total suppressed:  ${suppressed.length}`);
console.log(`  Sources fetched:   ${results.sourcesFetched || 0}`);
console.log(`  Fetch successes:   ${results.fetchSuccesses || 0}`);
console.log(`  Fetch failures:    ${results.fetchFailures || 0}`);
console.log(`  Parse hits:        ${results.parseHits || 0}`);
console.log();

// ── Leads by lane ──
const laneCount = {};
for (const l of leads) {
  const lane = l.dashboard_lane || 'active_leads';
  laneCount[lane] = (laneCount[lane] || 0) + 1;
}
console.log('── LEADS BY LANE ──');
for (const [lane, count] of Object.entries(laneCount).sort()) {
  console.log(`  ${lane}: ${count}`);
}
console.log();

// ── Leads by status ──
const statusCount = {};
for (const l of leads) {
  const st = l.status || 'unknown';
  statusCount[st] = (statusCount[st] || 0) + 1;
}
console.log('── LEADS BY STATUS ──');
for (const [st, count] of Object.entries(statusCount).sort()) {
  console.log(`  ${st}: ${count}`);
}
console.log();

// ── Quality gate breakdown ──
console.log('── QUALITY GATE COUNTS ──');
console.log(`  Generic title:       ${results.skippedGenericTitle || 0}`);
console.log(`  Portal title:        ${results.skippedPortalTitle || 0}`);
console.log(`  Not project-specific:${results.skippedNotProjectSpecific || 0}`);
console.log(`  Low quality:         ${results.skippedLowQuality || 0}`);
console.log(`  Duplicates:          ${results.skippedDuplicate || 0}`);
console.log(`  Total blocked:       ${results.totalQualityBlocked || 0}`);
console.log();

// ── Suppression reasons breakdown ──
const reasonCounts = {};
for (const s of suppressed) {
  const r = s.reason || 'unknown';
  reasonCounts[r] = (reasonCounts[r] || 0) + 1;
}
console.log('── SUPPRESSION REASONS ──');
for (const [reason, count] of Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${reason}: ${count}`);
}
console.log();

// ── ALL SURVIVING LEADS (full detail) ──
console.log('── SURVIVING LEADS ──');
for (let i = 0; i < leads.length; i++) {
  const l = leads[i];
  const src = l.sourceId || l.source_id || '?';
  const lane = l.dashboard_lane || 'active_leads';
  const desc = (l.description || '').slice(0, 120);
  console.log(`  [${i+1}] ${l.title}`);
  console.log(`      Source: ${src} | Lane: ${lane} | Score: ${l.relevanceScore || '?'} | Status: ${l.status || '?'}`);
  console.log(`      Evidence: ${desc}${desc.length >= 120 ? '...' : ''}`);
  console.log();
}

// ── ALL SUPPRESSED LEADS (first 40) ──
console.log('── SUPPRESSED LEADS (sample) ──');
const suppSample = suppressed.slice(0, 40);
for (let i = 0; i < suppSample.length; i++) {
  const s = suppSample[i];
  console.log(`  [${i+1}] "${s.title}" | Score: ${s.relevanceScore || '?'} | Reason: ${s.reason}`);
}
if (suppressed.length > 40) {
  console.log(`  ... and ${suppressed.length - 40} more`);
}
console.log();

// ── News lane analysis ──
const newsLeads = leads.filter(l => l.dashboard_lane === 'news');
console.log('── NEWS LANE ANALYSIS ──');
console.log(`  Total news leads: ${newsLeads.length}`);
for (const nl of newsLeads) {
  console.log(`  📰 "${nl.title}"`);
  console.log(`     Source: ${nl.sourceId || '?'} | Score: ${nl.relevanceScore || '?'}`);
}
console.log();

// ── Dev potentials lane analysis ──
const devLeads = leads.filter(l => l.dashboard_lane === 'development_potentials');
console.log('── DEVELOPMENT POTENTIALS LANE ──');
console.log(`  Total dev leads: ${devLeads.length}`);
for (const dl of devLeads) {
  console.log(`  🔮 "${dl.title}"`);
  console.log(`     Source: ${dl.sourceId || '?'} | Score: ${dl.relevanceScore || '?'}`);
}
console.log();

// ── Write results to JSON for further analysis ──
const outputPath = join(__dirname, 'scan-results.json');
const output = {
  timestamp: new Date().toISOString(),
  seedVersion: SEED_VERSION,
  duration: `${duration}s`,
  sourcesScanned: results.sourcesFetched,
  fetchSuccesses: results.fetchSuccesses,
  fetchFailures: results.fetchFailures,
  leadsAdded: leads.length,
  leadsSuppressed: suppressed.length,
  laneBreakdown: laneCount,
  statusBreakdown: statusCount,
  qualityGates: {
    genericTitle: results.skippedGenericTitle,
    portalTitle: results.skippedPortalTitle,
    notProjectSpecific: results.skippedNotProjectSpecific,
    lowQuality: results.skippedLowQuality,
    duplicate: results.skippedDuplicate,
    totalBlocked: results.totalQualityBlocked,
  },
  suppressionReasons: reasonCounts,
  leads: leads.map(l => ({
    title: l.title,
    sourceId: l.sourceId || l.source_id,
    lane: l.dashboard_lane || 'active_leads',
    status: l.status,
    relevanceScore: l.relevanceScore,
    pursuitScore: l.pursuitScore,
    description: (l.description || '').slice(0, 300),
    evidence: (l.evidenceSummary || '').slice(0, 200),
    location: l.location,
    marketSector: l.marketSector,
    projectType: l.projectType,
    leadClass: l.leadClass,
    watchCategory: l.watchCategory,
  })),
  suppressed: suppressed.map(s => ({
    title: s.title,
    reason: s.reason,
    relevanceScore: s.relevanceScore,
  })),
};

import { writeFileSync } from 'fs';
writeFileSync(outputPath, JSON.stringify(output, null, 2));
console.log(`\n📄 Full results written to: ${outputPath}`);
console.log(`\nDone.`);
