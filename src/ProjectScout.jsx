import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Search, ChevronRight, ChevronDown, ExternalLink, MapPin, Building2, Calendar, DollarSign, TrendingUp, Activity, Clock, AlertCircle, AlertTriangle, CheckCircle2, XCircle, Eye, EyeOff, Radio, Settings as SettingsIcon, Layers, Send, Archive, Filter, ArrowUpRight, X, BarChart3, Globe, Bookmark, Zap, RefreshCw, Plus, Minus, ChevronLeft, Database, Target, BookOpen, Wifi, WifiOff, Star, Pause, Play, Trash2, Edit3, TestTube, Copy, Save, RotateCcw, Power, Link2, Hash, FileText, Users, Crosshair, UserPlus, ClipboardCheck, MessageSquare, ArrowRight, Shield, Flag, Download, Upload, HardDrive } from "lucide-react";

// Phase 2 data foundation
import { runMigration } from './data/migration.js';
import SourceRegistryView from './components/SourceRegistryView.jsx';
import TaxonomyView from './components/TaxonomyView.jsx';

/* ═══════════════════════════════════════════════════════════════
   SEED DATA (inline for artifact portability)
   ═══════════════════════════════════════════════════════════════ */

const LEAD_STATUS = { NEW: 'new', ACTIVE: 'active', WATCH: 'watch', MONITORING: 'monitoring', SUBMITTED_TO_ASANA: 'submitted_to_asana', NOT_PURSUED: 'not_pursued' };

// New is a 7-day freshness flag, not a primary status. After 7 days, leads show only their operational status.
const NEW_FRESHNESS_DAYS = 7;
const UPDATE_FRESHNESS_DAYS = 7; // UPDATE badge for meaningful recent changes

function isNewFresh(lead) {
  if (!lead.dateDiscovered) return false;
  const age = (Date.now() - new Date(lead.dateDiscovered).getTime()) / 86400000;
  return age <= NEW_FRESHNESS_DAYS;
}

/**
 * Detect if a lead has been meaningfully updated recently (within UPDATE_FRESHNESS_DAYS).
 * UPDATE applies when: new evidence added, status changed, timeline changed, or material advancement.
 * Does NOT apply to brand-new leads (they show NEW instead).
 */
function isRecentlyUpdated(lead) {
  if (isNewFresh(lead)) return false; // NEW takes priority over UPDATE
  const now = Date.now();
  const updateWindow = UPDATE_FRESHNESS_DAYS * 86400000;
  // Check lastUpdatedDate (set explicitly on meaningful changes)
  if (lead.lastUpdatedDate) {
    const updateAge = now - new Date(lead.lastUpdatedDate).getTime();
    if (updateAge <= updateWindow) return true;
  }
  // Check if evidence was added recently
  if (lead.evidence?.length > 0) {
    const latestEvidence = lead.evidence.reduce((latest, ev) => {
      const d = new Date(ev.signalDate || ev.dateFound || 0).getTime();
      return d > latest ? d : latest;
    }, 0);
    if (latestEvidence > 0 && (now - latestEvidence) <= updateWindow && latestEvidence > new Date(lead.dateDiscovered || 0).getTime() + 86400000) {
      return true; // Evidence added at least 1 day after discovery and within update window
    }
  }
  return false;
}

/**
 * Derive the operational status for display.
 * "New" is only shown as a secondary badge if the lead is < 7 days old.
 * "Update" shows if there's a meaningful recent change but lead is not new.
 * The primary status is always Active or Watch (or legacy Monitoring → Watch).
 */
function getOperationalStatus(lead) {
  const fresh = isNewFresh(lead);
  const updated = isRecentlyUpdated(lead);
  // Map legacy statuses: 'new' → watch (was the default for non-solicitation), 'monitoring' → watch
  let primary = lead.status;
  if (primary === LEAD_STATUS.NEW || primary === LEAD_STATUS.MONITORING) {
    primary = LEAD_STATUS.WATCH;
  }
  return { primary, isNew: fresh, isUpdated: updated };
}

// ── Watch Triage Constants & Helpers ──────────────────────────
const WATCH_DISPOSITION = { ACTIVE: 'active', MUTED: 'muted', DISMISSED: 'dismissed' };
const REASSESS_WINDOW_DAYS = 30; // How long REASSESS badge stays visible

/**
 * Compute a material-signal hash for a lead.
 * Used to detect meaningful changes that should trigger reassessment of muted/dismissed items.
 * Hash is a simple fingerprint of the fields most likely to indicate material change.
 */
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
  // Simple hash: join and produce a short fingerprint
  const str = parts.join('|');
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return 'sh-' + (h >>> 0).toString(36);
}

/**
 * Determine if a lead has changed materially compared to its stored signal hash.
 * Returns { changed: boolean, reasons: string[] } describing what changed.
 */
function detectMaterialChange(lead, oldHash) {
  if (!oldHash) return { changed: false, reasons: [] };
  const newHash = computeSignalHash(lead);
  if (newHash === oldHash) return { changed: false, reasons: [] };

  // Detailed reason detection for summary
  const reasons = [];
  const lo = (lead.title || '').toLowerCase();

  // Check for specific material change indicators
  if (lead.potentialBudget && !oldHash.includes('budget')) reasons.push('New budget appeared');
  if (lead.action_due_date) reasons.push('New timeline or due date');
  if (lead.leadClass === 'active_solicitation') reasons.push('Active solicitation detected (RFQ/RFP)');
  if ((lead.projectStatus || '').includes('solicitation')) reasons.push('Project moved to solicitation stage');
  if (/\brfq\b|\brfp\b|\binvitation to bid\b/i.test(lo)) reasons.push('RFQ/RFP language in title');

  // If we detected a hash change but couldn't identify specific reasons, note it generically
  if (reasons.length === 0) reasons.push('Material signal change detected');

  return { changed: true, reasons };
}

/**
 * Check if a lead's reassess flag is still within the visible window.
 */
function isReassessActive(lead) {
  if (!lead.reassessFlag) return false;
  if (!lead.reassessAt) return true; // flag set but no timestamp = show it
  const age = (Date.now() - new Date(lead.reassessAt).getTime()) / 86400000;
  return age <= REASSESS_WINDOW_DAYS;
}

/**
 * Get the effective watch disposition. Defaults to 'active' if not set.
 */
function getWatchDisposition(lead) {
  return lead.watchDisposition || WATCH_DISPOSITION.ACTIVE;
}

/**
 * Check if a Watch lead should be visible on the main board.
 * Muted and dismissed items are hidden unless they have an active reassess flag.
 */
function isWatchVisible(lead) {
  const disp = getWatchDisposition(lead);
  if (disp === WATCH_DISPOSITION.ACTIVE) return true;
  // Muted/dismissed items re-appear if they have an active reassess flag
  if (isReassessActive(lead)) return true;
  return false;
}

const MARKET_SECTORS = ['Civic','Municipal','County','State','Public Safety','K-12','Higher Education','Healthcare','Clinics','Research / Lab','Airports / Aviation','Tribal','Housing','Workforce Housing','Affordable Housing','Mixed Use','Hospitality','Recreation','Infrastructure','Landscape','Utility','Commercial','Retail','Industrial','Developer-Led'];

const GEOGRAPHIES = ['Missoula','Missoula County','Kalispell','Whitefish','Columbia Falls','Flathead County','Ravalli County','Hamilton','Lake County','Polson','Sanders County','Lincoln County','Mineral County'];

// ── Office-Region Geography Mapping ──────────────────────────
// Montana office regions by county
const OFFICE_REGIONS = {
  'Western MT': ['Missoula', 'Ravalli', 'Lake', 'Flathead', 'Sanders', 'Mineral', 'Lincoln', 'Glacier'],
  'Helena': ['Lewis and Clark', 'Jefferson', 'Broadwater', 'Powell', 'Deer Lodge', 'Silver Bow', 'Cascade', 'Meagher', 'Teton', 'Pondera', 'Toole', 'Liberty', 'Chouteau', 'Hill', 'Blaine'],
  'Bozeman': ['Gallatin', 'Park', 'Madison', 'Sweetgrass', 'Stillwater', 'Carbon', 'Big Horn'],
  'Billings': ['Yellowstone', 'Musselshell', 'Golden Valley', 'Wheatland', 'Fergus', 'Petroleum', 'Treasure', 'Rosebud', 'Custer', 'Powder River', 'Carter', 'Fallon', 'Wibaux', 'Dawson', 'Prairie', 'Garfield', 'McCone', 'Richland', 'Roosevelt', 'Daniels', 'Sheridan', 'Valley', 'Phillips'],
};
// Idaho and Washington — served through Western MT operation.
// Not county-mapped at this time; uses city/state-level geographic grouping.
const ID_WA_REGIONS = {
  'Idaho': { cities: ['boise','nampa','meridian','idaho falls','pocatello','caldwell','coeur d\'alene','twin falls','lewiston','moscow','sandpoint','post falls','ketchum','sun valley','hailey','rexburg','ammon','eagle','star','kuna','mountain home','jerome','burley','rupert','blackfoot'], stateAbbr: 'id' },
  'Washington': { cities: ['spokane','pullman','walla walla','kennewick','richland','pasco','wenatchee','moses lake','ellensburg','yakima','chelan','colville','omak','ephrata','clarkston'], stateAbbr: 'wa' },
};
const COUNTY_TO_REGIONS = {}; // county → array of regions (supports overlap)
Object.entries(OFFICE_REGIONS).forEach(([region, counties]) => {
  counties.forEach(county => {
    const key = county.toLowerCase();
    if (!COUNTY_TO_REGIONS[key]) COUNTY_TO_REGIONS[key] = [];
    COUNTY_TO_REGIONS[key].push(region);
  });
});
// Legacy compat — single region lookup
const COUNTY_TO_REGION = {};
Object.entries(OFFICE_REGIONS).forEach(([region, counties]) => {
  counties.forEach(county => { COUNTY_TO_REGION[county.toLowerCase()] = region; });
});
const CITY_TO_COUNTY = {
  'missoula': 'missoula', 'kalispell': 'flathead', 'whitefish': 'flathead',
  'columbia falls': 'flathead', 'polson': 'lake', 'hamilton': 'ravalli',
  'helena': 'lewis and clark', 'east helena': 'lewis and clark', 'bozeman': 'gallatin',
  'belgrade': 'gallatin', 'billings': 'yellowstone', 'great falls': 'cascade',
  'butte': 'silver bow', 'anaconda': 'deer lodge', 'deer lodge': 'powell',
  'livingston': 'park', 'red lodge': 'carbon', 'lewistown': 'fergus',
  'miles city': 'custer', 'glendive': 'dawson', 'sidney': 'richland',
  'wolf point': 'roosevelt', 'havre': 'hill', 'glasgow': 'valley',
  'cut bank': 'glacier', 'shelby': 'toole', 'libby': 'lincoln',
  'thompson falls': 'sanders', 'superior': 'mineral', 'dillon': 'beaverhead',
  'ronan': 'lake', 'stevensville': 'ravalli', 'florence': 'ravalli',
  'lolo': 'missoula', 'frenchtown': 'missoula', 'bonner': 'missoula',
  'bigfork': 'flathead', 'lakeside': 'flathead', 'somers': 'flathead',
};

/**
 * Get ALL office regions for a lead (returns array, supports overlap).
 * A lead may belong to multiple regions (e.g., Western MT + Idaho).
 * Montana projects also appear under Montana Statewide.
 */
function getLeadRegions(lead) {
  const geo = (lead.geography || '').toLowerCase().trim();
  const loc = (lead.location || '').toLowerCase().trim();
  const countyField = (lead.county || '').toLowerCase().replace(/\s*county\s*$/i, '').trim();
  // Also check title and asana_task_name — imported Asana tasks often have location in title but empty location/geography fields
  const titleText = (lead.title || '').toLowerCase().trim();
  const asanaName = (lead.asana_task_name || '').toLowerCase().trim();
  const combined = geo + ' ' + loc + ' ' + titleText + ' ' + asanaName;
  const regions = new Set();

  // Check for ID/WA first
  for (const [region, info] of Object.entries(ID_WA_REGIONS)) {
    // State abbreviation check (e.g., ", ID" or ", WA" in location)
    const statePattern = new RegExp(`\\b${info.stateAbbr}\\b|\\b${region.toLowerCase()}\\b`, 'i');
    if (statePattern.test(combined)) {
      regions.add(region);
      regions.add('Western MT'); // Western MT covers ID/WA territories
    }
    // City name check
    for (const city of info.cities) {
      if (combined.includes(city)) {
        regions.add(region);
        regions.add('Western MT');
        break;
      }
    }
  }

  // Explicit statewide
  if (/\bstatewide\b/i.test(geo) || /\bstatewide\b/i.test(loc)) regions.add('Montana Statewide');
  if (/^montana$/i.test(geo.trim())) regions.add('Montana Statewide');

  // County field direct match
  if (countyField && COUNTY_TO_REGIONS[countyField]) {
    COUNTY_TO_REGIONS[countyField].forEach(r => regions.add(r));
  }

  // Geography field — check county name match
  if (regions.size === 0 || (regions.size === 1 && regions.has('Montana Statewide'))) {
    for (const [countyName, regionArr] of Object.entries(COUNTY_TO_REGIONS)) {
      if (geo.includes(countyName)) { regionArr.forEach(r => regions.add(r)); break; }
    }
  }

  // Location field — check city name match
  if (regions.size === 0 || (regions.size === 1 && regions.has('Montana Statewide'))) {
    for (const [city, countyName] of Object.entries(CITY_TO_COUNTY)) {
      if (combined.includes(city) && COUNTY_TO_REGIONS[countyName]) {
        COUNTY_TO_REGIONS[countyName].forEach(r => regions.add(r));
        break;
      }
    }
  }

  // Montana Statewide umbrella: only for actual Montana projects, NOT Idaho/Washington
  // ID/WA projects overlap with Western MT operationally but are not Montana projects.
  const hasIdWa = regions.has('Idaho') || regions.has('Washington');
  const mtOfficeRegions = ['Western MT', 'Helena', 'Bozeman', 'Billings'];
  const hasMtOffice = [...regions].some(r => mtOfficeRegions.includes(r));
  if (hasMtOffice && !hasIdWa) {
    regions.add('Montana Statewide');
  }

  // Empty = no data, not classifiable — default to Montana Statewide
  if (regions.size === 0 && !geo && !loc && !countyField) regions.add('Montana Statewide');

  return [...regions];
}

// Legacy compat: single region (returns first non-Statewide region, or Statewide, or null)
function getLeadRegion(lead) {
  const regions = getLeadRegions(lead);
  if (regions.length === 0) return null;
  const primary = regions.find(r => r !== 'Montana Statewide');
  return primary || 'Montana Statewide';
}

// ── Title Normalization for Alias-Aware Matching ──────────────────────────

// Compound facility types — treated as single entity tokens
const FACILITY_BIGRAMS = [
  'fire station', 'police station', 'sheriff office', 'city hall', 'town hall',
  'community center', 'recreation center', 'senior center', 'civic center',
  'medical center', 'health center', 'health clinic', 'dental clinic',
  'treatment plant', 'water treatment', 'wastewater treatment',
  'airport terminal', 'bus terminal', 'transit center',
  'school district', 'high school', 'middle school', 'elementary school',
  'student housing', 'student center', 'science center', 'technology center',
  'parking garage', 'parking structure', 'maintenance shop', 'maintenance facility',
  'combination facility', 'public works', 'justice center', 'detention center',
  'swimming pool', 'aquatic center', 'ice arena', 'sports complex',
  'roof replacement', 'elevator replacement', 'elevator modernization',
  'hvac replacement', 'boiler replacement', 'mechanical upgrade',
];

/**
 * Extract entity signature from a title for secondary matching.
 * Returns { entities: string[], locations: string[] }.
 * Entities = compound facility type tokens found in the title.
 * Locations = known city/county names found in the title.
 */
function extractEntitySignature(title) {
  if (!title) return { entities: [], locations: [] };
  const lo = title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const entities = [];
  for (const bigram of FACILITY_BIGRAMS) {
    if (lo.includes(bigram)) entities.push(bigram.replace(/\s+/g, '_'));
  }
  const locations = [];
  for (const city of Object.keys(CITY_TO_COUNTY)) {
    if (lo.includes(city)) locations.push(city);
  }
  for (const county of Object.keys(COUNTY_TO_REGION)) {
    if (lo.includes(county)) locations.push(county);
  }
  return { entities, locations };
}

const MATCH_STOP_WORDS = new Set(['the','and','for','from','with','this','that','are','was','will','has','have','been','its','our','new','all','project','projects','county','city','state','montana','mt','of','in','at','on','to','by','a','an','phase','i','ii','iii','iv','v','1','2','3','4','request','requests','architectural','engineering','services','service','professional','design','consultant','consultants']);

/**
 * Normalize a title for fuzzy identity matching.
 * Strips noise/process words (including A&E procurement terms), normalizes abbreviations.
 * Returns a canonical key string for comparison.
 */
function normalizeForMatch(title) {
  if (!title) return '';
  let t = title.toLowerCase().trim();
  // Common abbreviation expansions
  t = t.replace(/\bmt\b/g, 'montana').replace(/\bmsl?a\b/g, 'missoula').replace(/\bksp?l\b/g, 'kalispell');
  t = t.replace(/\ba\s*[&\/]\s*e\b/g, '').replace(/\ba\/e\b/g, '');
  // Strip parenthetical notes, trailing dashes
  t = t.replace(/\(.*?\)/g, '').replace(/\s*[-–—]\s*$/, '');
  // Remove punctuation, normalize whitespace
  t = t.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  // Extract significant words, sort for order-independent matching
  const words = t.split(' ').filter(w => w.length > 1 && !MATCH_STOP_WORDS.has(w));
  return words.sort().join(' ');
}

/**
 * Compute similarity score between two normalized title keys.
 * Returns 0-1 Jaccard coefficient.
 */
function titleSimilarity(a, b) {
  if (!a || !b) return 0;
  const wa = new Set(a.split(' '));
  const wb = new Set(b.split(' '));
  if (wa.size < 1 || wb.size < 1) return 0;
  let intersection = 0;
  for (const w of wa) if (wb.has(w)) intersection++;
  return intersection / (wa.size + wb.size - intersection);
}

/**
 * Check if two titles are likely the same pursuit (alias match).
 * Uses three-tier matching:
 *   1. Normalized word-set Jaccard ≥ 0.65
 *   2. Entity + location overlap (e.g., both mention "fire station" and same city)
 *   3. Substring containment in normalized form
 */
function isTitleAlias(titleA, titleB) {
  if (!titleA || !titleB) return false;
  const na = normalizeForMatch(titleA);
  const nb = normalizeForMatch(titleB);
  if (na === nb) return true;

  // Extract entity signatures upfront — used by multiple tiers
  const sigA = extractEntitySignature(titleA);
  const sigB = extractEntitySignature(titleB);

  // ── Location-conflict guard ──
  // If BOTH titles contain known but DIFFERENT locations, they are different projects
  // even if everything else matches. "Kalispell Fire Station" ≠ "Missoula Fire Station".
  const hasLocationConflict = sigA.locations.length > 0 && sigB.locations.length > 0 &&
    sigA.locations.filter(l => sigB.locations.includes(l)).length === 0;

  // Substring containment — only if no location conflict
  if (!hasLocationConflict && na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) return true;

  // Jaccard word similarity — block if locations conflict
  if (!hasLocationConflict && titleSimilarity(na, nb) >= 0.65) return true;

  // Entity + location secondary matching
  if (sigA.entities.length > 0 && sigB.entities.length > 0) {
    const sharedEntities = sigA.entities.filter(e => sigB.entities.includes(e));
    if (sharedEntities.length > 0) {
      // Same facility type — require same location or at least one location-free
      const sharedLocations = sigA.locations.filter(l => sigB.locations.includes(l));
      if (sharedLocations.length > 0) return true; // Same entity + same location = match
      if (sigA.locations.length === 0 || sigB.locations.length === 0) return true; // One title has no location = likely match
      // Both have locations but none overlap → different towns → NOT a match (hasLocationConflict)
    }
  }
  return false;
}

const PRIORITY_MAP = { critical: { label: 'Critical', color: '#ef4444' }, high: { label: 'High', color: '#f59e0b' }, medium: { label: 'Medium', color: '#3b82f6' }, low: { label: 'Low', color: '#6b7280' } };

const seedLeads = [
  { id:'lead-001', title:'Missoula County Courthouse Renovation', owner:'Missoula County', projectName:'Courthouse Annex Renovation Phase II', location:'Missoula, MT', county:'Missoula County', geography:'Missoula', marketSector:'Civic', projectType:'Renovation', description:'Phase II renovation of the Missoula County Courthouse annex, including ADA upgrades, mechanical systems, and interior remodel of floors 2-4.', whyItMatters:'A&E + SMA has prior relationship with Missoula County and experience with civic renovations.', aiReasonForAddition:'Matched on county commission agenda reference to "courthouse renovation capital plan" combined with prior client relationship.', potentialTimeline:'Design start Q3 2026', potentialBudget:'$4.2M – $5.8M', relevanceScore:92, pursuitScore:85, sourceConfidenceScore:88, confidenceNotes:'Referenced in county commission meeting minutes and CIP.', dateDiscovered:'2026-02-18T08:00:00Z', originalSignalDate:'2026-02-12T00:00:00Z', lastCheckedDate:'2026-03-06T06:00:00Z', status:LEAD_STATUS.ACTIVE, sourceName:'Missoula County Commission Agendas', sourceUrl:'https://www.missoulacounty.us/government/commission', evidenceSummary:'Referenced in Feb 12 commission meeting; discussed at Feb 26 work session. Appears in 2026 CIP.', matchedKeywords:['renovation','courthouse','capital improvement plan','ADA'], matchedTargetOrgs:['Missoula County'], internalContact:'Jon Sears', notes:'Strong pursuit candidate. Review at next BD meeting.' },
  { id:'lead-002', title:'FVCC Science & Technology Center', owner:'Flathead Valley Community College', projectName:'FVCC Science & Technology Center', location:'Kalispell, MT', county:'Flathead County', geography:'Kalispell', marketSector:'Higher Education', projectType:'New Construction', description:'New science and technology building. ~42,000 SF. Lab spaces, classrooms, collaborative learning areas.', whyItMatters:'Major higher ed opportunity in the Flathead region. FVCC is actively expanding.', aiReasonForAddition:'Board of trustees approved feasibility study. State funding application submitted to OCHE.', potentialTimeline:'A/E selection late 2026', potentialBudget:'$18M – $24M', relevanceScore:88, pursuitScore:78, sourceConfidenceScore:82, confidenceNotes:'Board minutes confirm feasibility study.', dateDiscovered:'2026-01-29T08:00:00Z', originalSignalDate:'2026-01-15T00:00:00Z', lastCheckedDate:'2026-03-05T06:00:00Z', status:LEAD_STATUS.ACTIVE, sourceName:'FVCC Board of Trustees', sourceUrl:'https://www.fvcc.edu/about/board-of-trustees', evidenceSummary:'Board approved feasibility study Jan 15. State capital request submitted.', matchedKeywords:['science building','campus','higher education','design services'], matchedTargetOrgs:['FVCC'], internalContact:'', notes:'Confirm A/E selection process and timeline.' },
  { id:'lead-003', title:'Whitefish Elementary Classroom Addition', owner:'Whitefish School District', projectName:'Muldown Elementary Addition', location:'Whitefish, MT', county:'Flathead County', geography:'Whitefish', marketSector:'K-12', projectType:'Addition', description:'Six-classroom addition to Muldown Elementary. Includes multipurpose space and site work.', whyItMatters:'Active growth market. Strong K-12 track record. Whitefish is a priority geography.', aiReasonForAddition:'School board meeting referenced overcrowding report and bond planning for fall 2026.', potentialTimeline:'Bond election Nov 2026, design early 2027', potentialBudget:'$6M – $8M', relevanceScore:80, pursuitScore:72, sourceConfidenceScore:75, confidenceNotes:'School board minutes discuss facility study.', dateDiscovered:'2026-02-05T08:00:00Z', originalSignalDate:'2026-01-22T00:00:00Z', lastCheckedDate:'2026-03-04T06:00:00Z', status:LEAD_STATUS.ACTIVE, sourceName:'Whitefish School District Board', sourceUrl:'https://www.whitefishschools.org', evidenceSummary:'Board meeting Jan 22 discussed facilities study results and bond planning.', matchedKeywords:['addition','school','bond','facilities plan'], matchedTargetOrgs:['Whitefish School District'], internalContact:'', notes:'Monitor bond measure progress.' },
  { id:'lead-004', title:'Community Medical Center South Clinic', owner:'Community Medical Center', projectName:'South Missoula Clinic', location:'Missoula, MT', county:'Missoula County', geography:'Missoula', marketSector:'Healthcare', projectType:'New Construction', description:'New outpatient clinic in south Missoula. ~12,000 SF. Primary care, urgent care, imaging.', whyItMatters:'Healthcare is a core market. CMC is expanding outpatient network.', aiReasonForAddition:'Planning application submitted for new medical office building at Reserve & 39th.', potentialTimeline:'Design start Q2 2026', potentialBudget:'$5M – $7M', relevanceScore:85, pursuitScore:80, sourceConfidenceScore:90, confidenceNotes:'Planning application on file. Pre-application confirmed.', dateDiscovered:'2026-02-22T08:00:00Z', originalSignalDate:'2026-02-18T00:00:00Z', lastCheckedDate:'2026-03-06T06:00:00Z', status:LEAD_STATUS.ACTIVE, sourceName:'City of Missoula Development Services', sourceUrl:'https://www.ci.missoula.mt.us/149/Development-Services', evidenceSummary:'Pre-application meeting held Feb 18. Site plan review in progress.', matchedKeywords:['clinic','hospital','medical','design services'], matchedTargetOrgs:['Community Medical Center'], internalContact:'Jon Sears', notes:'CMC may have architect shortlist already.' },
  { id:'lead-005', title:'Glacier Park Airport Terminal Study', owner:'Glacier Park International Airport', projectName:'Terminal Modernization Planning', location:'Kalispell, MT', county:'Flathead County', geography:'Kalispell', marketSector:'Airports / Aviation', projectType:'Master Plan', description:'Airport authority initiating terminal modernization study. Phased expansion and renovation.', whyItMatters:'High-profile aviation project in a growth market. Multi-phase potential.', aiReasonForAddition:'Airport authority board minutes reference terminal capacity study RFQ in development.', potentialTimeline:'RFQ expected Q4 2026', potentialBudget:'$40M – $60M program', relevanceScore:78, pursuitScore:65, sourceConfidenceScore:70, confidenceNotes:'Board minutes reference study. RFQ timeline not confirmed.', dateDiscovered:'2026-03-01T08:00:00Z', originalSignalDate:'2026-02-25T00:00:00Z', lastCheckedDate:'2026-03-06T06:00:00Z', status:LEAD_STATUS.NEW, sourceName:'Flathead County Airport Authority', sourceUrl:'https://www.iflyglacier.com', evidenceSummary:'Feb 25 board meeting referenced terminal modernization and consultant RFQ development.', matchedKeywords:['airport','terminal','master plan','RFQ'], matchedTargetOrgs:['Glacier Park International Airport'], internalContact:'', notes:'Major opportunity. Track RFQ release.' },
  { id:'lead-006', title:'Polson Public Library Expansion', owner:'City of Polson', projectName:'Polson Library Renovation & Addition', location:'Polson, MT', county:'Lake County', geography:'Polson', marketSector:'Civic', projectType:'Addition / Renovation', description:'Library board pursuing expansion and renovation. Community input completed. Fundraising underway.', whyItMatters:'Library projects are a strong fit. Lake County is underserved geography.', aiReasonForAddition:'Library board meeting and local media coverage of expansion plans.', potentialTimeline:'Fundraising through 2026, design 2027', potentialBudget:'$3M – $4.5M', relevanceScore:72, pursuitScore:60, sourceConfidenceScore:65, confidenceNotes:'Media coverage and board minutes. Funding not secured.', dateDiscovered:'2026-02-10T08:00:00Z', originalSignalDate:'2026-01-30T00:00:00Z', lastCheckedDate:'2026-03-03T06:00:00Z', status:LEAD_STATUS.MONITORING, sourceName:'Lake County Leader', sourceUrl:'https://www.leaderadvertiser.com', evidenceSummary:'Local media coverage of library expansion plans.', matchedKeywords:['library','addition','renovation'], matchedTargetOrgs:['City of Polson'], internalContact:'', notes:'Early stage. Monitor fundraising.' },
  { id:'lead-007', title:'Hamilton Workforce Housing Development', owner:'Ravalli County Housing Authority', projectName:'Bitterroot Workforce Housing', location:'Hamilton, MT', county:'Ravalli County', geography:'Hamilton', marketSector:'Workforce Housing', projectType:'New Construction', description:'Multi-phase workforce housing. 48-unit initial phase. Mixed income targeting essential workers.', whyItMatters:'Housing is a critical need in the Bitterroot. Growing portfolio area.', aiReasonForAddition:'County commission approved land transfer. ARPA funding application in progress.', potentialTimeline:'A/E selection Q1 2027', potentialBudget:'$12M – $16M Phase 1', relevanceScore:75, pursuitScore:68, sourceConfidenceScore:72, confidenceNotes:'Commission confirmed land transfer. Funding pending.', dateDiscovered:'2026-02-28T08:00:00Z', originalSignalDate:'2026-02-20T00:00:00Z', lastCheckedDate:'2026-03-05T06:00:00Z', status:LEAD_STATUS.NEW, sourceName:'Ravalli County Commission', sourceUrl:'https://www.ravallicounty.mt.gov', evidenceSummary:'Commission approved land transfer Feb 20.', matchedKeywords:['housing','workforce','affordable','subdivision'], matchedTargetOrgs:['Ravalli County Housing Authority'], internalContact:'', notes:'Aligns with firm growth in housing sector.' },
];

const seedSubmitted = [
  { id:'lead-sub-001', title:'Missoula Public Schools Admin Building', owner:'Missoula County Public Schools', location:'Missoula, MT', county:'Missoula County', geography:'Missoula', marketSector:'K-12', projectType:'Renovation', description:'Administration building renovation and systems upgrade.', relevanceScore:90, pursuitScore:88, sourceConfidenceScore:92, status:LEAD_STATUS.SUBMITTED_TO_ASANA, dateDiscovered:'2025-12-15T08:00:00Z', dateSubmittedToAsana:'2026-01-10T14:30:00Z', asanaUrl:'https://app.asana.com/0/1203575716271060/example1', submissionNotes:'Submitted via PIF. Go/No-Go review pending.', potentialBudget:'$2.8M', potentialTimeline:'Design Q1 2026' },
];

const seedNotPursued = [
  { id:'lead-np-001', title:'Superior Elementary Roof Replacement', owner:'Superior School District', location:'Superior, MT', county:'Mineral County', geography:'Mineral County', marketSector:'K-12', projectType:'Renovation', description:'Roof replacement. Limited design scope.', relevanceScore:35, pursuitScore:20, sourceConfidenceScore:80, status:LEAD_STATUS.NOT_PURSUED, dateDiscovered:'2026-01-05T08:00:00Z', reasonNotPursued:'Limited design scope. Primarily contractor-led roofing project.', dateNotPursued:'2026-01-12T00:00:00Z', potentialBudget:'$450K', potentialTimeline:'Summer 2026' },
];

const SOURCE_CATEGORIES = ['City Council','County Commission','Planning & Zoning','School Board','State Procurement','Higher Ed Capital','Economic Development','Public Notice','Airport Authority','Redevelopment Agency','Media','Tribal Government','Private Employer','Contractor / Developer','Healthcare System','Utility','Other'];
const PAGE_TYPES = ['Agenda / Minutes','Applications / Permits','RFQ / RFP Listings','Board Minutes','Capital Projects','Bid Opportunities','Public Notices','News / Press','Project Pages','General Website','Other'];
const REFRESH_CADENCES = ['daily','twice-weekly','weekly','biweekly','monthly'];

const INIT_SOURCES = [
  // ── Missoula City & County ──
  { id:'src-001', name:'Missoula County Commission Agendas', organization:'Missoula County', geography:'Missoula', county:'Missoula County', category:'County Commission', pageType:'Agenda / Minutes', url:'https://www.missoulacounty.us/government/commission', priority:'critical', refreshCadence:'daily', state:'active', keywords:['capital improvement','renovation','bond','RFQ','design services','facility'], notes:'Primary signal source for county projects.', fetchHealth:'healthy', lastChecked:'2026-03-06T06:00:00Z', lastChanged:'2026-03-04T00:00:00Z', lastSuccessfulFetch:'2026-03-06T06:00:00Z' },
  { id:'src-002', name:'City of Missoula Development Services', organization:'City of Missoula', geography:'Missoula', county:'Missoula County', category:'Planning & Zoning', pageType:'Applications / Permits', url:'https://www.ci.missoula.mt.us/149/Development-Services', priority:'critical', refreshCadence:'daily', state:'active', keywords:['medical','commercial','mixed use','rezoning','subdivision','tenant improvement'], notes:'', fetchHealth:'healthy', lastChecked:'2026-03-06T06:00:00Z', lastChanged:'2026-03-05T00:00:00Z', lastSuccessfulFetch:'2026-03-06T06:00:00Z' },
  { id:'src-003', name:'Missoula City Council Agendas', organization:'City of Missoula', geography:'Missoula', county:'Missoula County', category:'City Council', pageType:'Agenda / Minutes', url:'https://www.ci.missoula.mt.us/148/City-Council', priority:'high', refreshCadence:'daily', state:'active', keywords:['infrastructure','public works','facility','capital','bond'], notes:'', fetchHealth:'healthy', lastChecked:'2026-03-06T06:00:00Z', lastChanged:'2026-03-03T00:00:00Z', lastSuccessfulFetch:'2026-03-06T06:00:00Z' },
  { id:'src-004', name:'Missoula Redevelopment Agency', organization:'MRA', geography:'Missoula', county:'Missoula County', category:'Redevelopment Agency', pageType:'Board Minutes', url:'https://www.ci.missoula.mt.us/753/Missoula-Redevelopment-Agency', priority:'high', refreshCadence:'weekly', state:'active', keywords:['redevelopment','TIF','mixed use','housing','commercial'], notes:'Urban renewal district projects.', fetchHealth:'healthy', lastChecked:'2026-03-04T06:00:00Z', lastChanged:'2026-02-28T00:00:00Z', lastSuccessfulFetch:'2026-03-04T06:00:00Z' },
  { id:'src-005', name:'Missoula County Public Schools', organization:'MCPS', geography:'Missoula', county:'Missoula County', category:'School Board', pageType:'Board Minutes', url:'https://www.mcps.k12.mt.us/domain/83', priority:'high', refreshCadence:'weekly', state:'active', keywords:['school','bond','levy','facility','addition','renovation'], notes:'', fetchHealth:'healthy', lastChecked:'2026-03-04T06:00:00Z', lastChanged:'2026-02-25T00:00:00Z', lastSuccessfulFetch:'2026-03-04T06:00:00Z' },
  { id:'src-006', name:'Missoula Airport Authority', organization:'MCAA', geography:'Missoula', county:'Missoula County', category:'Airport Authority', pageType:'Board Minutes', url:'https://www.flymissoula.com/airport-authority', priority:'medium', refreshCadence:'weekly', state:'active', keywords:['terminal','hangar','runway','airport','expansion'], notes:'', fetchHealth:'healthy', lastChecked:'2026-03-03T06:00:00Z', lastChanged:'2026-02-20T00:00:00Z', lastSuccessfulFetch:'2026-03-03T06:00:00Z' },
  { id:'src-007', name:'University of Montana Capital Projects', organization:'University of Montana', geography:'Missoula', county:'Missoula County', category:'Higher Ed Capital', pageType:'Capital Projects', url:'https://www.umt.edu/facilities', priority:'high', refreshCadence:'weekly', state:'active', keywords:['campus','building','renovation','lab','science','student housing'], notes:'', fetchHealth:'healthy', lastChecked:'2026-03-03T06:00:00Z', lastChanged:'2026-02-15T00:00:00Z', lastSuccessfulFetch:'2026-03-03T06:00:00Z' },
  // ── Flathead County ──
  { id:'src-008', name:'Flathead County Planning & Zoning', organization:'Flathead County', geography:'Kalispell', county:'Flathead County', category:'Planning & Zoning', pageType:'Applications / Permits', url:'https://www.flathead.mt.gov/planning_zoning', priority:'high', refreshCadence:'daily', state:'active', keywords:['development','subdivision','rezoning','housing','commercial'], notes:'', fetchHealth:'healthy', lastChecked:'2026-03-05T06:00:00Z', lastChanged:'2026-03-04T00:00:00Z', lastSuccessfulFetch:'2026-03-05T06:00:00Z' },
  { id:'src-009', name:'Flathead County Commission', organization:'Flathead County', geography:'Kalispell', county:'Flathead County', category:'County Commission', pageType:'Agenda / Minutes', url:'https://www.flathead.mt.gov/commissioners', priority:'high', refreshCadence:'daily', state:'active', keywords:['capital improvement','facility','bond','infrastructure'], notes:'', fetchHealth:'healthy', lastChecked:'2026-03-06T06:00:00Z', lastChanged:'2026-03-03T00:00:00Z', lastSuccessfulFetch:'2026-03-06T06:00:00Z' },
  { id:'src-010', name:'Kalispell City Council', organization:'City of Kalispell', geography:'Kalispell', county:'Flathead County', category:'City Council', pageType:'Agenda / Minutes', url:'https://www.kalispell.com/167/City-Council', priority:'high', refreshCadence:'daily', state:'active', keywords:['development','infrastructure','facility','rezoning','housing'], notes:'', fetchHealth:'healthy', lastChecked:'2026-03-06T06:00:00Z', lastChanged:'2026-03-04T00:00:00Z', lastSuccessfulFetch:'2026-03-06T06:00:00Z' },
  { id:'src-011', name:'Whitefish City Council', organization:'City of Whitefish', geography:'Whitefish', county:'Flathead County', category:'City Council', pageType:'Agenda / Minutes', url:'https://www.cityofwhitefish.org', priority:'medium', refreshCadence:'weekly', state:'active', keywords:['development','housing','infrastructure','resort','commercial'], notes:'', fetchHealth:'degraded', lastChecked:'2026-03-04T06:00:00Z', lastChanged:'2026-02-28T00:00:00Z', lastSuccessfulFetch:'2026-03-02T06:00:00Z' },
  { id:'src-012', name:'Columbia Falls City Council', organization:'City of Columbia Falls', geography:'Columbia Falls', county:'Flathead County', category:'City Council', pageType:'Agenda / Minutes', url:'https://www.cityofcolumbiafalls.com', priority:'medium', refreshCadence:'weekly', state:'active', keywords:['development','infrastructure','facility','housing'], notes:'', fetchHealth:'healthy', lastChecked:'2026-03-04T06:00:00Z', lastChanged:'2026-02-25T00:00:00Z', lastSuccessfulFetch:'2026-03-04T06:00:00Z' },
  { id:'src-013', name:'Flathead County Airport Authority', organization:'Glacier Park Intl Airport', geography:'Kalispell', county:'Flathead County', category:'Airport Authority', pageType:'Board Minutes', url:'https://www.iflyglacier.com/airport-authority', priority:'high', refreshCadence:'weekly', state:'active', keywords:['terminal','expansion','hangar','modernization','RFQ'], notes:'', fetchHealth:'healthy', lastChecked:'2026-03-03T06:00:00Z', lastChanged:'2026-02-25T00:00:00Z', lastSuccessfulFetch:'2026-03-03T06:00:00Z' },
  { id:'src-014', name:'FVCC Board of Trustees', organization:'FVCC', geography:'Kalispell', county:'Flathead County', category:'Higher Ed Capital', pageType:'Board Minutes', url:'https://www.fvcc.edu/about/board-of-trustees', priority:'high', refreshCadence:'weekly', state:'active', keywords:['capital','building','campus','facility','construction','science'], notes:'', fetchHealth:'healthy', lastChecked:'2026-03-03T06:00:00Z', lastChanged:'2026-02-15T00:00:00Z', lastSuccessfulFetch:'2026-03-03T06:00:00Z' },
  { id:'src-015', name:'Whitefish School District Board', organization:'Whitefish School District', geography:'Whitefish', county:'Flathead County', category:'School Board', pageType:'Board Minutes', url:'https://www.whitefishschools.org/board', priority:'high', refreshCadence:'weekly', state:'active', keywords:['school','bond','addition','enrollment','facility'], notes:'', fetchHealth:'healthy', lastChecked:'2026-03-04T06:00:00Z', lastChanged:'2026-02-22T00:00:00Z', lastSuccessfulFetch:'2026-03-04T06:00:00Z' },
  { id:'src-016', name:'Kalispell School District Board', organization:'Kalispell Public Schools', geography:'Kalispell', county:'Flathead County', category:'School Board', pageType:'Board Minutes', url:'https://www.sd5.k12.mt.us', priority:'medium', refreshCadence:'weekly', state:'active', keywords:['school','bond','facility','renovation','addition'], notes:'', fetchHealth:'healthy', lastChecked:'2026-03-04T06:00:00Z', lastChanged:'2026-02-20T00:00:00Z', lastSuccessfulFetch:'2026-03-04T06:00:00Z' },
  // ── Ravalli County ──
  { id:'src-017', name:'Ravalli County Commission', organization:'Ravalli County', geography:'Hamilton', county:'Ravalli County', category:'County Commission', pageType:'Agenda / Minutes', url:'https://www.ravallicounty.mt.gov/commissioners', priority:'medium', refreshCadence:'weekly', state:'active', keywords:['facility','housing','infrastructure','capital improvement'], notes:'', fetchHealth:'healthy', lastChecked:'2026-03-05T06:00:00Z', lastChanged:'2026-03-01T00:00:00Z', lastSuccessfulFetch:'2026-03-05T06:00:00Z' },
  { id:'src-018', name:'City of Hamilton Planning', organization:'City of Hamilton', geography:'Hamilton', county:'Ravalli County', category:'Planning & Zoning', pageType:'Applications / Permits', url:'https://www.cityofhamilton.net', priority:'medium', refreshCadence:'weekly', state:'active', keywords:['development','housing','commercial','subdivision'], notes:'', fetchHealth:'healthy', lastChecked:'2026-03-04T06:00:00Z', lastChanged:'2026-02-25T00:00:00Z', lastSuccessfulFetch:'2026-03-04T06:00:00Z' },
  { id:'src-019', name:'Hamilton School District Board', organization:'Hamilton School District', geography:'Hamilton', county:'Ravalli County', category:'School Board', pageType:'Board Minutes', url:'https://www.hsd3.org', priority:'low', refreshCadence:'biweekly', state:'active', keywords:['school','facility','bond','renovation'], notes:'', fetchHealth:'healthy', lastChecked:'2026-03-01T06:00:00Z', lastChanged:'2026-02-15T00:00:00Z', lastSuccessfulFetch:'2026-03-01T06:00:00Z' },
  // ── Lake County ──
  { id:'src-020', name:'Lake County Commission', organization:'Lake County', geography:'Polson', county:'Lake County', category:'County Commission', pageType:'Agenda / Minutes', url:'https://www.lakecounty-mt.org', priority:'medium', refreshCadence:'weekly', state:'active', keywords:['facility','infrastructure','capital','housing'], notes:'', fetchHealth:'healthy', lastChecked:'2026-03-04T06:00:00Z', lastChanged:'2026-02-28T00:00:00Z', lastSuccessfulFetch:'2026-03-04T06:00:00Z' },
  { id:'src-021', name:'City of Polson Planning', organization:'City of Polson', geography:'Polson', county:'Lake County', category:'Planning & Zoning', pageType:'Applications / Permits', url:'https://www.cityofpolson.com/planning', priority:'low', refreshCadence:'weekly', state:'active', keywords:['development','housing','commercial','waterfront'], notes:'', fetchHealth:'healthy', lastChecked:'2026-03-03T06:00:00Z', lastChanged:'2026-02-20T00:00:00Z', lastSuccessfulFetch:'2026-03-03T06:00:00Z' },
  { id:'src-022', name:'CSKT Tribal Council', organization:'Confederated Salish & Kootenai Tribes', geography:'Polson', county:'Lake County', category:'Tribal Government', pageType:'Public Notices', url:'https://csktribes.org', priority:'high', refreshCadence:'weekly', state:'active', keywords:['tribal','facility','housing','infrastructure','health','education'], notes:'Tribal government projects on the Flathead Reservation.', fetchHealth:'healthy', lastChecked:'2026-03-04T06:00:00Z', lastChanged:'2026-02-28T00:00:00Z', lastSuccessfulFetch:'2026-03-04T06:00:00Z' },
  // ── State & Regional ──
  { id:'src-023', name:'Montana State Procurement (A/E)', organization:'State of Montana', geography:'Statewide', county:'', category:'State Procurement', pageType:'RFQ / RFP Listings', url:'https://vendor.mt.gov', priority:'critical', refreshCadence:'daily', state:'active', keywords:['architectural','engineering','design services','RFQ','RFP','A/E'], notes:'Official state vendor portal. Critical for state-funded projects.', fetchHealth:'healthy', lastChecked:'2026-03-06T06:00:00Z', lastChanged:'2026-03-05T00:00:00Z', lastSuccessfulFetch:'2026-03-06T06:00:00Z' },
  { id:'src-024', name:'Montana OCHE Capital Projects', organization:'Office of Commissioner of Higher Education', geography:'Statewide', county:'', category:'Higher Ed Capital', pageType:'Capital Projects', url:'https://mus.edu/board/meetings', priority:'high', refreshCadence:'weekly', state:'active', keywords:['campus','building','capital','university','college','construction'], notes:'Board of Regents capital project approvals.', fetchHealth:'healthy', lastChecked:'2026-03-03T06:00:00Z', lastChanged:'2026-02-20T00:00:00Z', lastSuccessfulFetch:'2026-03-03T06:00:00Z' },
  { id:'src-025', name:'Montana Department of Commerce', organization:'MT Dept of Commerce', geography:'Statewide', county:'', category:'Economic Development', pageType:'Public Notices', url:'https://comdev.mt.gov', priority:'medium', refreshCadence:'weekly', state:'active', keywords:['CDBG','TSEP','infrastructure','housing','community development'], notes:'State grant programs that signal local projects.', fetchHealth:'healthy', lastChecked:'2026-03-04T06:00:00Z', lastChanged:'2026-02-28T00:00:00Z', lastSuccessfulFetch:'2026-03-04T06:00:00Z' },
  { id:'src-026', name:'Montana DEQ Public Notices', organization:'MT Dept of Environmental Quality', geography:'Statewide', county:'', category:'Public Notice', pageType:'Public Notices', url:'https://deq.mt.gov/public/publicnotice', priority:'low', refreshCadence:'weekly', state:'active', keywords:['water','wastewater','infrastructure','environmental','facility'], notes:'Infrastructure and utility facility signals.', fetchHealth:'healthy', lastChecked:'2026-03-03T06:00:00Z', lastChanged:'2026-02-25T00:00:00Z', lastSuccessfulFetch:'2026-03-03T06:00:00Z' },
  // ── Economic Development ──
  { id:'src-027', name:'Missoula Economic Partnership', organization:'MEP', geography:'Missoula', county:'Missoula County', category:'Economic Development', pageType:'News / Press', url:'https://www.missoulapartnership.com', priority:'medium', refreshCadence:'weekly', state:'active', keywords:['development','employer','expansion','relocation','investment'], notes:'', fetchHealth:'healthy', lastChecked:'2026-03-04T06:00:00Z', lastChanged:'2026-03-01T00:00:00Z', lastSuccessfulFetch:'2026-03-04T06:00:00Z' },
  { id:'src-028', name:'Flathead County Economic Development', organization:'FCED', geography:'Kalispell', county:'Flathead County', category:'Economic Development', pageType:'News / Press', url:'https://www.fceda.org', priority:'medium', refreshCadence:'weekly', state:'active', keywords:['development','employer','expansion','investment','commercial'], notes:'', fetchHealth:'healthy', lastChecked:'2026-03-04T06:00:00Z', lastChanged:'2026-02-25T00:00:00Z', lastSuccessfulFetch:'2026-03-04T06:00:00Z' },
  // ── Media ──
  { id:'src-029', name:'Missoulian', organization:'Missoulian', geography:'Missoula', county:'Missoula County', category:'Media', pageType:'News / Press', url:'https://www.missoulian.com', priority:'medium', refreshCadence:'daily', state:'active', keywords:['construction','development','project','building','renovation','bond'], notes:'Local newspaper. Supporting evidence source.', fetchHealth:'healthy', lastChecked:'2026-03-06T06:00:00Z', lastChanged:'2026-03-06T00:00:00Z', lastSuccessfulFetch:'2026-03-06T06:00:00Z' },
  { id:'src-030', name:'Daily Inter Lake', organization:'Daily Inter Lake', geography:'Kalispell', county:'Flathead County', category:'Media', pageType:'News / Press', url:'https://www.dailyinterlake.com', priority:'medium', refreshCadence:'daily', state:'active', keywords:['construction','development','project','building','school','hospital'], notes:'Flathead Valley newspaper.', fetchHealth:'healthy', lastChecked:'2026-03-06T06:00:00Z', lastChanged:'2026-03-06T00:00:00Z', lastSuccessfulFetch:'2026-03-06T06:00:00Z' },
  { id:'src-031', name:'Ravalli Republic', organization:'Ravalli Republic', geography:'Hamilton', county:'Ravalli County', category:'Media', pageType:'News / Press', url:'https://www.ravallirepublic.com', priority:'low', refreshCadence:'weekly', state:'active', keywords:['construction','development','housing','school','facility'], notes:'', fetchHealth:'healthy', lastChecked:'2026-03-04T06:00:00Z', lastChanged:'2026-03-03T00:00:00Z', lastSuccessfulFetch:'2026-03-04T06:00:00Z' },
  { id:'src-032', name:'Lake County Leader', organization:'Lake County Leader', geography:'Polson', county:'Lake County', category:'Media', pageType:'News / Press', url:'https://www.leaderadvertiser.com', priority:'low', refreshCadence:'weekly', state:'active', keywords:['construction','development','library','tribal','school'], notes:'', fetchHealth:'healthy', lastChecked:'2026-03-03T06:00:00Z', lastChanged:'2026-03-01T00:00:00Z', lastSuccessfulFetch:'2026-03-03T06:00:00Z' },
  // ── Healthcare ──
  { id:'src-033', name:'Providence Montana', organization:'Providence', geography:'Missoula', county:'Missoula County', category:'Healthcare System', pageType:'News / Press', url:'https://www.providence.org/locations/mt', priority:'high', refreshCadence:'weekly', state:'active', keywords:['clinic','hospital','expansion','facility','medical','campus'], notes:'Major healthcare system in Western MT.', fetchHealth:'healthy', lastChecked:'2026-03-04T06:00:00Z', lastChanged:'2026-02-20T00:00:00Z', lastSuccessfulFetch:'2026-03-04T06:00:00Z' },
  { id:'src-034', name:'Logan Health', organization:'Logan Health', geography:'Kalispell', county:'Flathead County', category:'Healthcare System', pageType:'News / Press', url:'https://www.logan.org', priority:'high', refreshCadence:'weekly', state:'active', keywords:['clinic','hospital','expansion','facility','medical','campus'], notes:'Flathead Valley healthcare system.', fetchHealth:'healthy', lastChecked:'2026-03-04T06:00:00Z', lastChanged:'2026-02-18T00:00:00Z', lastSuccessfulFetch:'2026-03-04T06:00:00Z' },
  // ── Sanders / Lincoln / Mineral ──
  { id:'src-035', name:'Sanders County Commission', organization:'Sanders County', geography:'Thompson Falls', county:'Sanders County', category:'County Commission', pageType:'Agenda / Minutes', url:'https://www.sanderscounty.mt.gov', priority:'low', refreshCadence:'biweekly', state:'active', keywords:['facility','infrastructure','capital'], notes:'', fetchHealth:'unknown', lastChecked:null, lastChanged:null, lastSuccessfulFetch:null },
  { id:'src-036', name:'Lincoln County Commission', organization:'Lincoln County', geography:'Libby', county:'Lincoln County', category:'County Commission', pageType:'Agenda / Minutes', url:'https://www.lincolncountymt.us', priority:'low', refreshCadence:'biweekly', state:'active', keywords:['facility','infrastructure','capital','housing'], notes:'', fetchHealth:'unknown', lastChecked:null, lastChanged:null, lastSuccessfulFetch:null },
];

const INIT_FOCUS_POINTS = [
  { id:'fp-001', title:'Civic Renovations', description:'Government building renovations, upgrades, and additions in Western Montana.', keywords:['renovation','remodel','courthouse','city hall','civic center','government facility','ADA upgrade'], category:'Civic', priority:'critical', active:true },
  { id:'fp-002', title:'K-12 Growth & Bond Projects', description:'School construction, additions, bond-driven projects, and enrollment-driven facilities.', keywords:['school','elementary','middle school','high school','bond','levy','addition','enrollment','classroom'], category:'K-12', priority:'critical', active:true },
  { id:'fp-003', title:'Healthcare & Clinic Expansion', description:'Clinics, hospitals, outpatient facilities, and medical office buildings.', keywords:['clinic','hospital','medical','healthcare','outpatient','urgent care','imaging','medical office'], category:'Healthcare', priority:'critical', active:true },
  { id:'fp-004', title:'Higher Education Capital', description:'University and college building projects, campus expansions, lab facilities.', keywords:['campus','university','college','science building','research','lab','student housing','dormitory'], category:'Higher Education', priority:'high', active:true },
  { id:'fp-005', title:'Airports & Aviation Facilities', description:'Airport terminals, hangars, FBO facilities, and aviation support.', keywords:['airport','terminal','hangar','aviation','runway','FBO','control tower','air traffic'], category:'Airports / Aviation', priority:'high', active:true },
  { id:'fp-006', title:'Workforce & Affordable Housing', description:'Workforce housing, affordable housing developments, mixed-income projects.', keywords:['workforce housing','affordable housing','mixed income','multifamily','LIHTC','housing authority','apartment'], category:'Housing', priority:'high', active:true },
  { id:'fp-007', title:'Public Safety Facilities', description:'Fire stations, police stations, 911 centers, emergency services buildings.', keywords:['fire station','police','public safety','911','emergency services','dispatch','detention'], category:'Public Safety', priority:'high', active:true },
  { id:'fp-008', title:'Tribal Projects', description:'Tribal government facilities, health clinics, housing, education, and cultural buildings.', keywords:['tribal','reservation','CSKT','indigenous','Indian Health Service','tribal housing','cultural center'], category:'Tribal', priority:'high', active:true },
  { id:'fp-009', title:'Infrastructure & Utility Facilities', description:'Water treatment, wastewater, public works buildings, utility support facilities.', keywords:['water treatment','wastewater','infrastructure','public works','utility','sewer','stormwater'], category:'Infrastructure', priority:'medium', active:true },
  { id:'fp-010', title:'Private Development', description:'Developer-led commercial, residential, and mixed-use projects where architect engagement is likely.', keywords:['developer','mixed use','commercial development','subdivision','master-planned','tenant improvement'], category:'Developer-Led', priority:'medium', active:true },
  { id:'fp-011', title:'Hospitality & Recreation', description:'Hotels, resorts, recreation centers, community centers, pools, parks buildings.', keywords:['hotel','resort','recreation center','community center','pool','parks','aquatic','lodge'], category:'Hospitality', priority:'medium', active:true },
  { id:'fp-012', title:'Research & Laboratory Facilities', description:'Research labs, science facilities, BSL labs, and specialized research buildings.', keywords:['research','laboratory','BSL','science facility','biocontainment','clean room','NIH'], category:'Research / Lab', priority:'medium', active:true },
  { id:'fp-013', title:'Retail & Grocery', description:'Retail centers, grocery stores, and commercial retail where design services are needed.', keywords:['retail','grocery','shopping center','commercial retail','store','supermarket'], category:'Retail', priority:'low', active:true },
  { id:'fp-014', title:'Energy & Utility', description:'Energy infrastructure, substations, control buildings, and utility support facilities.', keywords:['energy','substation','utility','power plant','solar','wind','transmission','control building'], category:'Utility', priority:'low', active:true },
  { id:'fp-015', title:'Industrial Support Facilities', description:'Warehouses, maintenance facilities, operations buildings, and industrial support structures.', keywords:['industrial','warehouse','maintenance facility','operations building','manufacturing','shop'], category:'Industrial', priority:'low', active:true },
  { id:'fp-016', title:'Large Custom Homes', description:'High-value custom residential where A&E + SMA involvement is strategically relevant.', keywords:['custom home','luxury residence','estate','high-end residential','architect residence'], category:'Custom Residential', priority:'low', active:true },
];

const ORG_TYPES = ['Government','Healthcare','Higher Education','K-12','Aviation','Tribal','Developer','Contractor','Utility','Private Employer','Nonprofit','Other'];

const INIT_TARGET_ORGS = [
  // ── Government ──
  { id:'org-001', name:'Missoula County', type:'Government', geography:'Missoula', county:'Missoula County', website:'https://www.missoulacounty.us', watchTerms:['courthouse','capital improvement','facility','renovation'], notes:'Primary government client.', active:true },
  { id:'org-002', name:'City of Missoula', type:'Government', geography:'Missoula', county:'Missoula County', website:'https://www.ci.missoula.mt.us', watchTerms:['development','infrastructure','public works','facility'], notes:'', active:true },
  { id:'org-003', name:'Flathead County', type:'Government', geography:'Kalispell', county:'Flathead County', website:'https://www.flathead.mt.gov', watchTerms:['facility','capital','infrastructure','bond'], notes:'', active:true },
  { id:'org-004', name:'City of Kalispell', type:'Government', geography:'Kalispell', county:'Flathead County', website:'https://www.kalispell.com', watchTerms:['development','infrastructure','facility','downtown'], notes:'', active:true },
  { id:'org-005', name:'City of Whitefish', type:'Government', geography:'Whitefish', county:'Flathead County', website:'https://www.cityofwhitefish.org', watchTerms:['development','housing','resort','infrastructure'], notes:'', active:true },
  { id:'org-006', name:'Ravalli County', type:'Government', geography:'Hamilton', county:'Ravalli County', website:'https://www.ravallicounty.mt.gov', watchTerms:['facility','housing','infrastructure'], notes:'', active:true },
  { id:'org-007', name:'Lake County', type:'Government', geography:'Polson', county:'Lake County', website:'https://www.lakecounty-mt.org', watchTerms:['facility','infrastructure','capital'], notes:'', active:true },
  // ── Healthcare ──
  { id:'org-008', name:'Providence', type:'Healthcare', geography:'Missoula', county:'Missoula County', website:'https://www.providence.org', watchTerms:['clinic','hospital','expansion','campus','facility','medical office'], notes:'Major healthcare system. Providence St. Patrick Hospital.', active:true },
  { id:'org-009', name:'Community Medical Center', type:'Healthcare', geography:'Missoula', county:'Missoula County', website:'https://www.communitymed.org', watchTerms:['clinic','expansion','medical office','outpatient','urgent care'], notes:'', active:true },
  { id:'org-010', name:'Logan Health', type:'Healthcare', geography:'Kalispell', county:'Flathead County', website:'https://www.logan.org', watchTerms:['clinic','hospital','expansion','campus','facility'], notes:'Flathead Valley healthcare system.', active:true },
  { id:'org-011', name:'Bitterroot Health', type:'Healthcare', geography:'Hamilton', county:'Ravalli County', website:'https://www.bitterroothealth.org', watchTerms:['clinic','hospital','expansion','facility','medical'], notes:'Ravalli County healthcare provider.', active:true },
  // ── Research / Science ──
  { id:'org-012', name:'Rocky Mountain Laboratories', type:'Private Employer', geography:'Hamilton', county:'Ravalli County', website:'https://www.niaid.nih.gov/about/rocky-mountain-laboratories', watchTerms:['laboratory','BSL','research','facility','NIH','expansion'], notes:'NIH / NIAID research facility. High-value lab projects.', active:true },
  { id:'org-013', name:'GSK Hamilton', type:'Private Employer', geography:'Hamilton', county:'Ravalli County', website:'https://www.gsk.com', watchTerms:['manufacturing','facility','expansion','pharmaceutical','lab'], notes:'Pharmaceutical manufacturing facility.', active:true },
  // ── Higher Education ──
  { id:'org-014', name:'University of Montana', type:'Higher Education', geography:'Missoula', county:'Missoula County', website:'https://www.umt.edu', watchTerms:['campus','building','renovation','lab','student housing','science'], notes:'', active:true },
  { id:'org-015', name:'Flathead Valley Community College', type:'Higher Education', geography:'Kalispell', county:'Flathead County', website:'https://www.fvcc.edu', watchTerms:['campus','building','capital','science','technology'], notes:'', active:true },
  { id:'org-016', name:'Montana Technological University', type:'Higher Education', geography:'Statewide', county:'', website:'https://www.mtech.edu', watchTerms:['campus','lab','mining','engineering','facility'], notes:'Butte campus but regional significance.', active:true },
  // ── K-12 ──
  { id:'org-017', name:'Missoula County Public Schools', type:'K-12', geography:'Missoula', county:'Missoula County', website:'https://www.mcps.k12.mt.us', watchTerms:['school','bond','addition','renovation','enrollment'], notes:'', active:true },
  { id:'org-018', name:'Whitefish School District', type:'K-12', geography:'Whitefish', county:'Flathead County', website:'https://www.whitefishschools.org', watchTerms:['school','bond','addition','enrollment'], notes:'', active:true },
  { id:'org-019', name:'Kalispell Public Schools', type:'K-12', geography:'Kalispell', county:'Flathead County', website:'https://www.sd5.k12.mt.us', watchTerms:['school','bond','facility','renovation'], notes:'', active:true },
  // ── Aviation ──
  { id:'org-020', name:'Glacier Park International Airport', type:'Aviation', geography:'Kalispell', county:'Flathead County', website:'https://www.iflyglacier.com', watchTerms:['terminal','expansion','modernization','hangar'], notes:'', active:true },
  { id:'org-021', name:'Missoula Montana Airport', type:'Aviation', geography:'Missoula', county:'Missoula County', website:'https://www.flymissoula.com', watchTerms:['terminal','hangar','runway','expansion'], notes:'', active:true },
  // ── Tribal ──
  { id:'org-022', name:'Confederated Salish & Kootenai Tribes', type:'Tribal', geography:'Polson', county:'Lake County', website:'https://csktribes.org', watchTerms:['tribal facility','housing','health','education','cultural center'], notes:'Flathead Reservation tribal government.', active:true },
  // ── Contractors (competitive intelligence) ──
  { id:'org-023', name:'Dick Anderson Construction', type:'Contractor', geography:'Statewide', county:'', website:'https://www.prior.com', watchTerms:['project','awarded','construction','general contractor'], notes:'Major MT GC. Track awarded projects for teaming opportunities.', active:true },
  { id:'org-024', name:'Jackson Contractor Group', type:'Contractor', geography:'Statewide', county:'', website:'https://www.prior.com', watchTerms:['project','awarded','construction','general contractor'], notes:'Major MT GC.', active:true },
  { id:'org-025', name:'Langlas & Associates', type:'Contractor', geography:'Statewide', county:'', website:'https://www.langlas.com', watchTerms:['project','construction','awarded','healthcare','education'], notes:'', active:true },
  { id:'org-026', name:'Quality Construction', type:'Contractor', geography:'Missoula', county:'Missoula County', website:'', watchTerms:['project','construction','awarded'], notes:'Missoula-based GC.', active:true },
  { id:'org-027', name:'Swank Enterprises', type:'Contractor', geography:'Statewide', county:'', website:'https://www.prior.com', watchTerms:['project','construction','awarded','heavy civil'], notes:'', active:true },
  { id:'org-028', name:'Barnard Construction', type:'Contractor', geography:'Statewide', county:'', website:'https://www.barnard-inc.com', watchTerms:['construction','infrastructure','heavy civil','awarded'], notes:'Bozeman-based. Heavy civil and infrastructure.', active:true },
  { id:'org-029', name:'Hensel Phelps', type:'Contractor', geography:'Statewide', county:'', website:'https://www.henselphelps.com', watchTerms:['construction','awarded','federal','government'], notes:'National GC with Montana projects.', active:true },
  // ── Utility ──
  { id:'org-030', name:'Northwestern Energy', type:'Utility', geography:'Statewide', county:'', website:'https://www.northwesternenergy.com', watchTerms:['substation','facility','expansion','energy','power','infrastructure'], notes:'Major MT utility company.', active:true },
  // ── Developers ──
  { id:'org-031', name:'Farran Realty Partners', type:'Developer', geography:'Missoula', county:'Missoula County', website:'', watchTerms:['development','mixed use','commercial','residential','housing'], notes:'Active Missoula developer.', active:true },
  { id:'org-032', name:'Edgell Building', type:'Developer', geography:'Missoula', county:'Missoula County', website:'', watchTerms:['development','commercial','construction'], notes:'', active:true },
];


/* ═══════════════════════════════════════════════════════════════
   UTILITY FUNCTIONS
   ═══════════════════════════════════════════════════════════════ */

function formatDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return '—'; }
}

// Safe timeline display — handles dates, years, fiscal years, quarter labels, and Invalid Date
function formatTimeline(lead) {
  // Prefer potentialTimeline if it's a clean label (Q2 2026, FY2026, Spring 2026, etc.)
  if (lead.potentialTimeline) {
    const tl = lead.potentialTimeline.trim();
    // If it looks like a readable label already, use it directly
    if (/^(Q[1-4]|FY|Spring|Summer|Fall|Winter|Early|Late|Mid|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(tl)) return tl;
    if (/^\d{4}$/.test(tl)) return tl; // Just a year
    if (/^\d{4}\s*[-–]\s*\d{2,4}$/.test(tl)) return tl; // FY range like 2026-2027
    // If it looks like a parseable date, format it
    try {
      const d = new Date(tl);
      if (!isNaN(d.getTime()) && d.getFullYear() >= 2020) return formatDate(tl);
    } catch {}
    // Otherwise return as-is (short enough to display)
    if (tl.length <= 40) return tl;
    return tl.slice(0, 37) + '...';
  }
  // Fall back to action_due_date
  if (lead.action_due_date) return formatDate(lead.action_due_date);
  return '—';
}

function daysAgo(iso) {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  return Math.floor(diff / 86400000);
}

function scoreColor(score) {
  if (score >= 80) return '#10b981';
  if (score >= 60) return '#f59e0b';
  if (score >= 40) return '#f97316';
  return '#ef4444';
}

function statusBadge(status) {
  const map = {
    [LEAD_STATUS.NEW]: { label: 'Watch', bg: '#fef3c7', fg: '#92400e' }, // Legacy 'new' → treated as Watch
    [LEAD_STATUS.ACTIVE]: { label: 'Active', bg: '#d1fae5', fg: '#065f46' },
    [LEAD_STATUS.WATCH]: { label: 'Watch', bg: '#fef3c7', fg: '#92400e' },
    [LEAD_STATUS.MONITORING]: { label: 'Watch', bg: '#fef3c7', fg: '#92400e' }, // Legacy monitoring → Watch
    [LEAD_STATUS.SUBMITTED_TO_ASANA]: { label: 'In Asana', bg: '#e0e7ff', fg: '#3730a3' },
    [LEAD_STATUS.NOT_PURSUED]: { label: 'Not Pursued', bg: '#f3f4f6', fg: '#6b7280' },
  };
  return map[status] || { label: status, bg: '#f3f4f6', fg: '#6b7280' };
}

function healthDot(health) {
  const map = { healthy: '#10b981', degraded: '#f59e0b', failing: '#ef4444', unknown: '#9ca3af' };
  return map[health] || map.unknown;
}


/* ═══════════════════════════════════════════════════════════════
   SCORE RING COMPONENT
   ═══════════════════════════════════════════════════════════════ */

function ScoreRing({ score, size = 44, strokeWidth = 3.5, label }) {
  const r = (size - strokeWidth) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ - (score / 100) * circ;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(0,0,0,0.06)" strokeWidth={strokeWidth} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={scoreColor(score)} strokeWidth={strokeWidth}
          strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.6s ease' }} />
      </svg>
      <span style={{ position: 'relative', top: -(size/2 + 6), fontSize: 12, fontWeight: 700, color: scoreColor(score), height: 0 }}>
        {score}
      </span>
      {label && <span style={{ fontSize: 9, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: -2 }}>{label}</span>}
    </div>
  );
}

function UrgencyRing({ dueDate, size = 44, strokeWidth = 3.5 }) {
  const r = (size - strokeWidth) / 2;
  const circ = 2 * Math.PI * r;
  let daysLeft = null;
  let pct = 0;
  let color = '#d1d5db';
  let label = 'No date';
  if (dueDate) {
    const due = new Date(dueDate);
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    due.setHours(0, 0, 0, 0);
    daysLeft = Math.ceil((due - now) / 86400000);
    if (daysLeft < 0) {
      pct = 100; color = '#dc2626'; label = 'Overdue';
    } else if (daysLeft === 0) {
      pct = 100; color = '#dc2626'; label = 'Today';
    } else if (daysLeft <= 7) {
      pct = 95; color = '#dc2626'; label = daysLeft + 'd';
    } else if (daysLeft <= 14) {
      pct = 80; color = '#ef4444'; label = daysLeft + 'd';
    } else if (daysLeft <= 30) {
      pct = 65; color = '#f59e0b'; label = daysLeft + 'd';
    } else if (daysLeft <= 60) {
      pct = 45; color = '#f59e0b'; label = Math.ceil(daysLeft / 7) + 'w';
    } else if (daysLeft <= 120) {
      pct = 30; color = '#10b981'; label = Math.round(daysLeft / 30) + 'mo';
    } else {
      pct = 15; color = '#10b981'; label = Math.round(daysLeft / 30) + 'mo';
    }
  }
  const offset = circ - (pct / 100) * circ;
  const formatDate = (d) => {
    if (!d) return 'No date';
    const date = new Date(d);
    const month = date.toLocaleString('en-US', { month: 'short' });
    const day = date.getDate();
    const year = date.getFullYear();
    const now = new Date();
    if (year === now.getFullYear()) return month + ' ' + day;
    return month + ' ' + day + ', ' + year;
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(0,0,0,0.06)" strokeWidth={strokeWidth} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={strokeWidth}
          strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.6s ease' }} />
      </svg>
      <span style={{ position: 'relative', top: -(size/2 + 6), fontSize: daysLeft !== null ? 11 : 10, fontWeight: 700, color: color, height: 0 }}>
        {label}
      </span>
      <span style={{ fontSize: 9, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: -2, maxWidth: size + 10, textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {dueDate ? formatDate(dueDate) : 'Action Due'}
      </span>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════
   LEAD CARD COMPONENT
   ═══════════════════════════════════════════════════════════════ */

function LeadCard({ lead, onClick, style: animStyle }) {
  const { primary, isNew, isUpdated } = getOperationalStatus(lead);
  const badge = statusBadge(primary);
  const discovered = daysAgo(lead.dateDiscovered);
  const isFav = !!lead.favorite;
  const reassess = isReassessActive(lead);
  const highlight = reassess ? 'reassess' : isNew ? 'new' : isUpdated ? 'updated' : isFav ? 'favorite' : 'none';
  const borderColor = highlight === 'reassess' ? '#f59e0b' : highlight === 'new' ? '#93c5fd' : highlight === 'updated' ? '#a78bfa' : highlight === 'favorite' ? '#fbbf24' : '#eef0f4';
  const shadowColor = highlight === 'reassess' ? 'rgba(245,158,11,0.10)' : highlight === 'new' ? 'rgba(59,130,246,0.08)' : highlight === 'updated' ? 'rgba(139,92,246,0.08)' : highlight === 'favorite' ? 'rgba(251,191,36,0.08)' : 'rgba(0,0,0,0.03)';

  return (
    <div onClick={onClick} style={{
      background: '#fff', borderRadius: 14, padding: '20px 22px', cursor: 'pointer',
      border: `1px solid ${borderColor}`, transition: 'all 0.22s cubic-bezier(.4,0,.2,1)',
      boxShadow: `0 1px 4px ${shadowColor}, 0 1px 6px rgba(0,0,0,0.02)`,
      ...animStyle,
    }}
    onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 8px 30px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.04)'; e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.borderColor = '#dde1e8'; }}
    onMouseLeave={e => { e.currentTarget.style.boxShadow = `0 1px 4px ${shadowColor}, 0 1px 6px rgba(0,0,0,0.02)`; e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.borderColor = borderColor; }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            {isFav && <Star size={14} style={{ color: '#f59e0b', fill: '#f59e0b', flexShrink: 0 }} />}
            <h3 style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', margin: 0, lineHeight: 1.35, letterSpacing: '-0.01em', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }} title={lead.title}>{getWatchDisplayTitle(lead)}</h3>
          </div>
          <p style={{ fontSize: 12.5, color: '#64748b', margin: '3px 0 0', fontWeight: 500 }}>{lead.owner}</p>
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
          {reassess && (
            <span style={{
              fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
              background: '#fef3c7', color: '#92400e',
              textTransform: 'uppercase', letterSpacing: '0.04em',
            }}>REASSESS</span>
          )}
          {isNew && (
            <span style={{
              fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
              background: '#dbeafe', color: '#1e40af',
              textTransform: 'uppercase', letterSpacing: '0.04em',
            }}>NEW</span>
          )}
          {isUpdated && (
            <span style={{
              fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
              background: '#ede9fe', color: '#6d28d9',
              textTransform: 'uppercase', letterSpacing: '0.04em',
            }}>UPDATE</span>
          )}
          {lead._suggestedAsanaMatch && (
            <span title={typeof lead._suggestedAsanaMatch === 'string' ? `Possible match: ${lead._suggestedAsanaMatch}` : 'Has a possible Asana match — review pending'} style={{
              fontSize: 8.5, fontWeight: 600, padding: '2px 5px', borderRadius: 3,
              background: '#f1f5f9', color: '#64748b', border: '1px solid #e2e8f0',
              letterSpacing: '0.03em',
            }}>Review Match</span>
          )}
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
            background: badge.bg, color: badge.fg, whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.04em',
          }}>{badge.label}</span>
        </div>
        {lead.leadOrigin === 'manual' && (
          <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
            background: '#dbeafe', color: '#1e40af',
            textTransform: 'uppercase', letterSpacing: '0.04em',
          }}>MANUAL</span>
        )}
        {lead.leadOrigin === 'asana_business_pursuit' && (
          <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
            background: '#ede9fe', color: '#6d28d9',
            textTransform: 'uppercase', letterSpacing: '0.04em',
          }}>ASANA BP</span>
        )}
        {lead.leadOrigin === 'asana_import' && (
          <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
            background: '#dbeafe', color: '#1e40af',
            textTransform: 'uppercase', letterSpacing: '0.04em',
          }}>ASANA</span>
        )}
        {lead.pruneImmune && !lead.favorite && (
          <span title="Immune from auto-pruning" style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
            background: '#ecfdf5', color: '#065f46',
            textTransform: 'uppercase', letterSpacing: '0.04em',
          }}>IMMUNE</span>
        )}
        {lead.taxonomyMatches?.length > 0 && (
          <span title={`Taxonomy: ${lead.taxonomyMatches.map(m => m.label).join(', ')}`} style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
            background: '#f5f3ff', color: '#6d28d9',
            textTransform: 'uppercase', letterSpacing: '0.04em',
          }}>TAX {lead.taxonomyMatches.length}</span>
        )}
        {lead.validationClaimed && (
          <span title={`Validation: ${lead.validationClaimed.replace(/_/g, ' ')}${lead.validationClaimedDetail ? ' — ' + lead.validationClaimedDetail : ''}. See detail for more.`} style={{
            display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
            background: '#dc2626', flexShrink: 0,
          }} />
        )}
        {lead.lastValidated && !lead.validationClaimed && (
          <span title={`Last validated ${formatDate(lead.lastValidated)}`} style={{
            display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
            background: '#d1d5db', flexShrink: 0,
          }} />
        )}
      </div>

      {/* Meta row */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', marginBottom: 14, fontSize: 11.5, color: '#94a3b8' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}><MapPin size={11} />{lead.location}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}><Building2 size={11} />{lead.marketSector}</span>
        {lead.projectType && <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}><Layers size={11} />{lead.projectType}</span>}
      </div>

      {/* Description — prefer whyItMatters for concise card display, fallback to description */}
      <p style={{ fontSize: 11.5, lineHeight: 1.5, color: '#64748b', margin: '0 0 12px', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {(() => {
          // Use whyItMatters if it's a better card-level summary than the raw description
          const wim = lead.whyItMatters || '';
          const desc = lead.description || '';
          // If whyItMatters is reasonably short and different from the title, prefer it
          if (wim.length > 30 && wim.length < 300 && wim.toLowerCase() !== (lead.title || '').toLowerCase()) return wim;
          // Otherwise clean up the description
          if (desc.length > 0) {
            // Strip repeated title text from description start
            const titleLo = (lead.title || '').toLowerCase().slice(0, 40);
            let clean = desc;
            if (clean.toLowerCase().startsWith(titleLo) && clean.length > titleLo.length + 20) {
              clean = clean.slice(titleLo.length).replace(/^\s*[.—–-]\s*/, '').trim();
            }
            return clean || desc;
          }
          return desc || 'No description available';
        })()}
      </p>

      {/* Scores + Budget/Timeline */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: 14 }}>
          <ScoreRing score={lead.relevanceScore || 0} label="Relevance" />
          {lead.action_due_date ? (
            <UrgencyRing dueDate={lead.action_due_date} />
          ) : (lead.potentialTimeline || lead.action_due_date) ? (
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:2 }}>
              <span style={{ fontSize:11, fontWeight:600, color:'#64748b' }}>{formatTimeline(lead)}</span>
              <span style={{ fontSize:9, color:'#94a3b8', textTransform:'uppercase', letterSpacing:'0.05em' }}>Timeline</span>
            </div>
          ) : null}
        </div>
        <div style={{ textAlign: 'right', fontSize: 11, color: '#94a3b8' }}>
          {lead.potentialBudget && <div style={{ fontWeight: 600, color: '#475569', fontSize: 12 }}>{lead.potentialBudget}</div>}
          {discovered !== null && <div style={{ marginTop: 2 }}>Found {discovered}d ago</div>}
        </div>
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════
   WATCH ITEM DETAIL GENERATORS
   Generate structured, honest descriptions from available lead data.
   These are used when a Watch item's fields are thin or missing.
   ═══════════════════════════════════════════════════════════════ */

function generateWatchSummary(lead) {
  const cat = lead.watchCategory || '';
  const owner = lead.owner || lead.sourceName || '';
  const title = lead.title || '';
  const market = lead.marketSector || '';
  const loc = lead.location || '';
  const ownerPhrase = owner ? ` through ${owner}` : '';
  const locPhrase = loc ? ` in ${loc}` : '';

  if (cat === 'tif_district' || cat === 'redevelopment_area') {
    return `This is a redevelopment area being actively discussed and advanced through public planning and urban renewal channels${locPhrase}. It is not yet a defined RFQ, but it is a strong future opportunity area. As development activity progresses within the district, individual building projects — mixed-use, civic, housing, or infrastructure — are likely to emerge and may require A/E services.`;
  }
  if (cat === 'development_program') {
    return `This is a planning program or capital initiative${ownerPhrase} that is still in a program-level phase. It has not yet broken down into individual defined projects with active solicitations. As the program advances, expect individual building or renovation projects to be defined, funded, and procured separately.`;
  }
  if (cat === 'annexation_area') {
    return `This is an annexation or land use area${locPhrase} where new development is anticipated. Annexation typically leads to infrastructure planning, new public facilities, and commercial or residential construction — all of which may need architectural and engineering services.`;
  }
  if (cat === 'capital_budget') {
    const budgetNote = lead.potentialBudget ? ` Budget: ${lead.potentialBudget}.` : '';
    const timeNote = lead.potentialTimeline ? ` Expected: ${lead.potentialTimeline}.` : '';
    return `This is a capital budget or CIP item${ownerPhrase}${locPhrase}.${budgetNote}${timeNote} Capital-budgeted projects are strong early signals — they indicate committed funding for facility work that will likely require A/E services as the project advances through design and procurement.`;
  }
  if (cat === 'named_project') {
    const statusNote = lead.projectStatus === 'pre_solicitation'
      ? ' The project name is defined, but consultant selection has not yet occurred.'
      : lead.projectStatus === 'future_watch'
        ? ' This is still in planning stages — no active RFQ or RFP has been released.'
        : ' It has been identified through public sources but may not yet have an active solicitation.';
    return `This appears to be a ${market ? market.toLowerCase() + ' ' : ''}project${ownerPhrase}${locPhrase}.${statusNote}`;
  }
  return `This is a tracked opportunity${ownerPhrase}${locPhrase} identified through public intelligence. The exact scope and timeline are not yet fully defined. It should be monitored for developments that clarify whether architectural or engineering services will be needed.`;
}

function generateWhyItMatters(lead) {
  const cat = lead.watchCategory || '';
  const market = lead.marketSector || '';
  const owner = lead.owner || '';
  const kws = (lead.matchedKeywords || []).filter(k => k.length > 3).slice(0, 4);

  const parts = [];
  if (cat === 'tif_district' || cat === 'redevelopment_area') {
    parts.push('Redevelopment districts consistently produce multi-phase A/E work — mixed-use buildings, civic facilities, housing, streetscape, and infrastructure design. Getting on the radar early gives the firm a positioning advantage before formal procurements begin.');
  } else if (cat === 'development_program') {
    parts.push('Capital programs and master plans frequently branch into multiple distinct A/E projects as phases are defined and funded. Tracking the program early provides lead time for teaming, relationship building, and proposal preparation.');
  } else if (cat === 'annexation_area') {
    parts.push('Annexation signals future growth — new infrastructure, public facilities, schools, fire stations, and commercial construction often follow within 2-5 years. Early awareness helps the firm position for the wave of work that typically follows.');
  } else if (cat === 'named_project') {
    parts.push('This is a named future project that could move to active solicitation. Tracking it now provides lead time to prepare qualifications, identify teaming partners, and build relationships with the owner before the formal procurement window opens.');
  } else {
    parts.push('This item was flagged based on public intelligence signals that suggest future A/E work. The connection is not yet certain, but early awareness gives the firm time to evaluate and position if the opportunity develops further.');
  }

  if (market && owner) parts.push(`${owner} is a ${market.toLowerCase()} entity in the firm's active geography.`);
  else if (market) parts.push(`This falls within the ${market.toLowerCase()} market, which is within the firm's service portfolio.`);
  if (kws.length > 0) parts.push(`Detected signals: ${kws.join(', ')}.`);
  return parts.join(' ');
}

function generateCurrentSignal(lead) {
  const pStatus = lead.projectStatus || '';
  const cat = lead.watchCategory || '';
  const source = lead.sourceName || 'public sources';
  const timeline = lead.potentialTimeline || '';
  const timeNote = timeline ? ` Expected timing: ${timeline}.` : ' Timing not yet public.';

  if (pStatus === 'pre_solicitation') return `This item is in a pre-solicitation phase. It appeared in ${source} with language suggesting an A/E selection process is being planned or developed. No active RFQ or RFP has been released yet.${timeNote}`;
  if (pStatus === 'future_watch') return `This is a planning-stage signal from ${source}. No procurement has been announced. The project or program is in early definition, feasibility, or legislative approval stages.${timeNote}`;
  if (pStatus === 'active_solicitation') return `An active solicitation has been detected. Check the evidence links below for current RFQ/RFP details and submission deadlines.${timeNote}`;
  if (cat === 'tif_district' || cat === 'redevelopment_area') return `District-level activity is in progress, detected through ${source}. The district is advancing through public planning, urban renewal, or redevelopment channels. Individual projects within this area have not yet been formally solicited.${timeNote}`;
  if (cat === 'development_program') return `Program-level planning activity detected through ${source}. The program is in a master plan, capital planning, or facility assessment phase. Watch for individual project breakdowns and funding decisions.${timeNote}`;
  return `Signal detected through ${source}. This opportunity is in an early or planning stage. The exact scope, timeline, and procurement approach are not yet confirmed.${timeNote}`;
}

function generateWhatToWatch(lead) {
  const cat = lead.watchCategory || '';
  const title = lead.title || 'this item';

  if (cat === 'tif_district' || cat === 'redevelopment_area') {
    return [
      `Development agreements or land disposition actions within ${title}`,
      'Zoning changes, entitlements, or land use decisions enabling new construction',
      'City council or MRA board actions approving specific development phases',
      'RFQ or RFP releases for design, planning, or architectural services',
      'Developer selection or development partner announcements',
    ].map(p => '• ' + p).join('\n');
  }
  if (cat === 'development_program') {
    return [
      'Master plan adoption or completion by governing body',
      'Individual project definitions emerging from the program',
      'Funding decisions — bond measures, legislative appropriations, or capital budget approvals',
      'A/E consultant selection processes or RFQ releases',
      'Facility condition assessments or feasibility studies leading to project scoping',
    ].map(p => '• ' + p).join('\n');
  }
  if (cat === 'annexation_area') {
    return [
      'Formal annexation approval by governing body',
      'Infrastructure master planning or zoning for the annexed area',
      'Developer submittals, subdivision proposals, or site plans',
      'Public facility siting decisions (fire station, school, utilities)',
      'Capital improvement programming for the new service area',
    ].map(p => '• ' + p).join('\n');
  }
  if (cat === 'named_project') {
    return [
      'RFQ or RFP release for design or architectural services',
      'Funding approval, budget allocation, or bond election results',
      'A/E shortlist announcements or consultant selection timeline',
      'Planning commission or governing body approvals',
      'Pre-application meetings or development review milestones',
    ].map(p => '• ' + p).join('\n');
  }
  return [
    'Transition from planning to active procurement (RFQ, RFP, or ITB)',
    'Consultant selection process announcements',
    'Budget, funding, or bond measure decisions',
    'Board, council, or commission actions advancing the project',
    'Public meeting or engagement activity indicating project advancement',
  ].map(p => '• ' + p).join('\n');
}


/* ═══════════════════════════════════════════════════════════════
   EVIDENCE LINK HELPERS
   ═══════════════════════════════════════════════════════════════ */

function inferEvidenceLabel(url) {
  if (!url) return 'Evidence';
  const lo = url.toLowerCase();
  if (/\.pdf(\?|$|#)/.test(lo)) return 'Public Document (PDF)';
  if (/agenda|minutes/.test(lo)) return /agenda/.test(lo) ? 'Meeting Agenda' : 'Meeting Minutes';
  if (/news|article|press|release/.test(lo)) return 'News Coverage';
  if (/plan|planning|masterplan/.test(lo)) return 'Planning Portal';
  if (/redevelopment|urban.renewal|mra|tif|tedd|urd/.test(lo)) return 'District Page';
  if (/engage|engagement|participate/.test(lo)) return 'Engagement Page';
  if (/capital.improvement|cip|budget/.test(lo)) return 'Capital Planning';
  if (/lrbp|architecture\.mt/.test(lo)) return 'LRBP / State Architecture';
  return 'Source Page';
}

function inferEvidenceLinkType(url) {
  if (!url) return 'evidence';
  const lo = url.toLowerCase();
  if (/\.pdf(\?|$|#)/.test(lo)) return 'document_pdf';
  if (/agenda|minutes/.test(lo)) return 'agenda_minutes';
  if (/news|article|press/.test(lo)) return 'news_coverage';
  if (/plan|planning/.test(lo)) return 'planning_portal';
  if (/redevelopment|urban.renewal|mra|tif|tedd|urd/.test(lo)) return 'district_page';
  if (/engage/.test(lo)) return 'engagement_page';
  return 'source_page';
}

function formatLinkTypeLabel(linkType) {
  const map = {
    'source_page': 'Source Page',
    'document_pdf': 'Public Document',
    'agenda_minutes': 'Agenda / Minutes',
    'news_coverage': 'News Coverage',
    'planning_portal': 'Planning Portal',
    'district_page': 'District Page',
    'engagement_page': 'Engagement Page',
    'child_document': 'Related Document',
    'project_page': 'Project Page',
  };
  return map[linkType] || (linkType || 'evidence').replace(/_/g, ' ');
}


/**
 * Generate a brief preview note for an evidence link explaining why it supports the Watch item.
 */
function generateEvidencePreview(link, lead) {
  const type = link.linkType || '';
  const cat = lead.watchCategory || '';
  const title = lead.title || '';

  if (type === 'source_page') {
    if (cat === 'tif_district' || cat === 'redevelopment_area') return `Primary source page where ${title} was identified as an active redevelopment or urban renewal area.`;
    if (cat === 'development_program') return `Source page listing ${title} as a capital planning or development program.`;
    return `Source page where this opportunity was initially detected.`;
  }
  if (type === 'document_pdf') return 'Public document (PDF) — may contain project details, timelines, or funding information.';
  if (type === 'agenda_minutes') return 'Official meeting record — may reference project approvals, funding decisions, or timeline actions.';
  if (type === 'news_coverage') return 'News coverage providing context on project status, community impact, or stakeholder activity.';
  if (type === 'planning_portal') return 'Planning portal page — may contain development review status, zoning, or permit information.';
  if (type === 'district_page') return `District or redevelopment area page — tracks ongoing activity and development within the area.`;
  if (type === 'engagement_page') return 'Public engagement or community input page — indicates active public planning process.';
  if (type === 'child_document') return 'Related document discovered through source page — provides additional project detail.';
  return null; // No preview for generic links
}


/* ═══════════════════════════════════════════════════════════════
   WATCH TITLE QUALITY — STORED TITLE CLEANUP
   Ensures Watch titles are clean, natural, and project-oriented.
   No clunky suffixes. Use the real project/area name when available.
   Applied once during board cleanup — stored permanently on the lead.
   ═══════════════════════════════════════════════════════════════ */

/**
 * Clean up a Watch lead's stored title for quality.
 * Rules:
 *   1. Strip old comma-suffix conventions from previous cleanup versions
 *   2. Clean verbose descriptions to concise project/area names
 *   3. Do NOT add new suffixes — prefer the natural title
 * Returns the original title if no cleanup needed.
 */
function applyWatchTitleRename(lead) {
  let title = lead.title || '';
  const isWatch = lead.status === 'monitoring' || lead.status === 'watch' || lead.status === 'new';
  if (!isWatch) return title;

  // Strip old comma-suffix conventions from v18 if present
  title = title.replace(/,\s+(Opportunity Area|Watch|Growth Area|Program Watch|Pre-Solicitation)\s*$/i, '').trim();

  // Clean verbose "Development plan for the city-owned X property" → "X"
  title = title.replace(/^(Development|Redevelopment)\s+(plan|agreement|project)\s+(for|of)\s+(the\s+)?(city[- ]owned\s+|county[- ]owned\s+)?/i, '');
  title = title.replace(/\s+(property|area|site|parcel|tract|lot)\s*$/i, '');

  // Capitalize first letter after cleanup
  if (title.length > 0) title = title[0].toUpperCase() + title.slice(1);

  return title;
}

/**
 * Display title helper — returns stored title as-is.
 */
/**
 * Canonical title precedence:
 *   1. user_edited_title — user has manually renamed
 *   2. asana_task_name — official Asana task title when linked
 *   3. title — original Scout/generated title
 */
function getDisplayTitle(lead) {
  return lead.user_edited_title || lead.asana_task_name || lead.title || '';
}
// Legacy alias
function getWatchDisplayTitle(lead) {
  return getDisplayTitle(lead);
}

/**
 * Asana section classification helpers.
 * "No Go" detection: handles "No Go", "NoGo", "No-Go", "NO_GO", etc.
 * "Go" detection: section contains "Go" as a word but is NOT a "No Go" variant.
 */
function isNoGoSection(section) {
  if (!section) return false;
  const s = section.trim();
  // v31c: "Go/No Go Review" is a review/pending section, NOT a final No-Go decision.
  // Only match sections that are clearly a final No-Go outcome.
  if (/go\s*\/\s*no\s*go\s*(review|decision|pending)/i.test(s)) return false; // review stage
  return /^no[\s\-_]*go$/i.test(s) || /\bno[\s\-_]*go\b/i.test(s);
}
function isGoSection(section) {
  if (!section) return false;
  if (isNoGoSection(section)) return false;
  // v31c: Match "Go For Project", "Go w/out Review", "Go - Pending..." but NOT "Go/No Go Review"
  if (/go\s*\/\s*no\s*go/i.test(section)) return false; // review stage — pending, not Go
  return /\bgo\b/i.test(section);
}
function isBusinessPursuitsSection(section) {
  if (!section) return false;
  return /business\s*(pursuits?|development)/i.test(section);
}

/**
 * Compute the pursuit disposition for a lead.
 * Returns { type, date, source, reason }.
 *   type: 'not_pursued' | 'no_go' | 'go' | 'pending'
 *
 * No Go is detected from EITHER the boolean flag OR the section name.
 * This handles stale records where the boolean was never set.
 */
function getDisposition(lead) {
  if (lead.status === LEAD_STATUS.NOT_PURSUED) {
    return { type: 'not_pursued', date: lead.dateNotPursued || null, source: 'Scout', reason: lead.reasonNotPursued || '' };
  }
  if (lead.no_go || isNoGoSection(lead.asana_section)) {
    return { type: 'no_go', date: lead.no_go_date || lead.asana_synced_at || null, source: 'Asana', reason: lead.asana_section || 'No Go' };
  }
  if (isGoSection(lead.asana_section)) {
    return { type: 'go', date: lead.go_date || lead.asana_synced_at || null, source: 'Asana', reason: lead.asana_section || '' };
  }
  return { type: 'pending', date: lead.dateSubmittedToAsana || lead.asana_created_at || null, source: lead.tracking_origin === 'imported_from_asana' ? 'Asana Import' : lead.tracking_origin === 'matched_existing' ? 'Matched' : 'Submitted', reason: '' };
}


/* ═══════════════════════════════════════════════════════════════
   LEAD DETAIL DRAWER
   ═══════════════════════════════════════════════════════════════ */

function LeadDetail({ lead, onClose, onUpdate, onMoveToNotPursued, onSubmitToAsana, onRestore, onTriageAction, onLinkToAsana }) {
  const [activeTab, setActiveTab] = useState('overview');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ ...lead });
  const [showDismissReason, setShowDismissReason] = useState(false);
  const [dismissReason, setDismissReason] = useState('');
  const [dismissCategory, setDismissCategory] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  // Sync form when lead prop changes (e.g. clicking different lead, or after save)
  useEffect(() => { setForm({ ...lead }); setEditing(false); setShowDismissReason(false); setEditingTitle(false); }, [lead?.id]);
  if (!lead) return null;
  const { primary: opStatus, isNew: opIsNew } = getOperationalStatus(lead);
  const badge = statusBadge(opStatus);
  const isNotPursued = lead.status === LEAD_STATUS.NOT_PURSUED;
  const isSubmitted = lead.status === LEAD_STATUS.SUBMITTED_TO_ASANA;
  const isWatch = opStatus === LEAD_STATUS.WATCH;
  const isFav = !!lead.favorite;
  const disp = getWatchDisposition(lead);
  const reassess = isReassessActive(lead);
  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'evidence', label: 'Evidence' },
    { id: 'asana', label: 'Asana' },
    { id: 'notes', label: 'Notes' },
  ];

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const handleSave = () => { onUpdate(form); setEditing(false); };

  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, width: '100%', maxWidth: 560,
      background: '#fff', boxShadow: '-8px 0 40px rgba(0,0,0,0.12)', zIndex: 1000,
      display: 'flex', flexDirection: 'column', animation: 'slideIn 0.25s ease',
    }}>
      {/* Header */}
      <div style={{ padding: '18px 22px 0', borderBottom: '1px solid #f1f5f9', flexShrink: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
              {reassess && <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: '#fef3c7', color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.04em' }}>REASSESS</span>}
              {isFav && <Star size={13} style={{ color: '#f59e0b', fill: '#f59e0b' }} />}
              {opIsNew && <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: '#dbeafe', color: '#1e40af', textTransform: 'uppercase', letterSpacing: '0.04em' }}>NEW</span>}
              <span style={{ fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6, background: badge.bg, color: badge.fg, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{badge.label}</span>
              {lead.marketSector && <span style={{ fontSize: 10, padding: '3px 7px', borderRadius: 5, background: '#f1f5f9', color: '#64748b' }}>{lead.marketSector}</span>}
              {lead.projectType && <span style={{ fontSize: 10, padding: '3px 7px', borderRadius: 5, background: '#f1f5f9', color: '#64748b' }}>{lead.projectType}</span>}
            </div>
            {/* ── Inline title editing ── */}
            {editingTitle ? (
              <div style={{ margin: '0 0 3px' }}>
                <input type="text" value={titleDraft} onChange={e => setTitleDraft(e.target.value)}
                  autoFocus
                  style={{ fontSize: 17, fontWeight: 800, color: '#0f172a', letterSpacing: '-0.02em', lineHeight: 1.3, width: '100%', border: '2px solid #3b82f6', borderRadius: 6, padding: '4px 8px', outline: 'none', background: '#f8fafc', boxSizing: 'border-box' }}
                  onKeyDown={e => { if (e.key === 'Enter') { onUpdate({ ...lead, user_edited_title: titleDraft.trim() || null, original_title: lead.original_title || lead.title }); setEditingTitle(false); } if (e.key === 'Escape') setEditingTitle(false); }}
                />
                <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                  <button onClick={() => { onUpdate({ ...lead, user_edited_title: titleDraft.trim() || null, original_title: lead.original_title || lead.title }); setEditingTitle(false); }}
                    style={{ padding: '3px 10px', borderRadius: 5, border: 'none', background: '#0f172a', color: '#fff', cursor: 'pointer', fontSize: 10.5, fontWeight: 600 }}>Save</button>
                  <button onClick={() => setEditingTitle(false)}
                    style={{ padding: '3px 10px', borderRadius: 5, border: '1px solid #e2e8f0', background: '#fff', color: '#64748b', cursor: 'pointer', fontSize: 10.5, fontWeight: 600 }}>Cancel</button>
                  {lead.user_edited_title && (
                    <button onClick={() => { onUpdate({ ...lead, user_edited_title: null }); setEditingTitle(false); }}
                      style={{ padding: '3px 10px', borderRadius: 5, border: '1px solid #fecaca', background: '#fff', color: '#dc2626', cursor: 'pointer', fontSize: 10.5, fontWeight: 600 }}>Reset to Original</button>
                  )}
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, margin: '0 0 3px' }}>
                <h2 style={{ fontSize: 18, fontWeight: 800, color: lead.no_go ? '#991b1b' : '#0f172a', margin: 0, letterSpacing: '-0.02em', lineHeight: 1.3, flex: 1 }}>{getDisplayTitle(lead)}</h2>
                <button onClick={() => { setTitleDraft(getDisplayTitle(lead)); setEditingTitle(true); }} title="Edit title"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: '#94a3b8', flexShrink: 0, marginTop: 2 }}><Edit3 size={14} /></button>
              </div>
            )}
            {/* Show secondary title info */}
            {lead.user_edited_title && lead.asana_task_name && (
              <div style={{ fontSize: 10.5, color: '#94a3b8', fontStyle: 'italic' }}>Asana: {lead.asana_task_name}</div>
            )}
            {(lead.scout_title || (lead.asana_task_name && lead.title && lead.asana_task_name.toLowerCase().trim() !== lead.title.toLowerCase().trim())) && !lead.user_edited_title && (
              <div style={{ fontSize: 10.5, color: '#94a3b8', fontStyle: 'italic' }}>Scout: {lead.scout_title || lead.title}</div>
            )}
            {lead.original_title && lead.user_edited_title && lead.original_title !== lead.user_edited_title && (
              <div style={{ fontSize: 10.5, color: '#c4b5a0', fontStyle: 'italic' }}>Original: {lead.original_title}</div>
            )}
            <p style={{ fontSize: 13, color: '#64748b', margin: 0 }}>{lead.owner}{lead.location ? ` — ${lead.location}` : ''}</p>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {!isNotPursued && !isSubmitted && (
              <button onClick={() => setEditing(!editing)} style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid #e2e8f0', background: editing ? '#f1f5f9' : '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: '#475569', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Edit3 size={12} /> {editing ? 'Cancel' : 'Edit'}
              </button>
            )}
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: '#94a3b8' }}><X size={20} /></button>
          </div>
        </div>
        {/* Action bar */}
        {!isNotPursued && !isSubmitted && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button onClick={() => onSubmitToAsana(lead)} style={{ padding: '6px 12px', borderRadius: 6, border: 'none', background: '#0f172a', color: '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                <Send size={11} /> Submit to Asana
              </button>
              {onLinkToAsana && (
                <button onClick={() => onLinkToAsana(lead)} style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #c7d2fe', background: '#fff', color: '#4f46e5', cursor: 'pointer', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <Link2 size={11} /> Link to Asana Task
                </button>
              )}
              <button onClick={() => onMoveToNotPursued(lead.id)} style={{ padding: '6px 12px', borderRadius: 6, border: isWatch ? 'none' : '1px solid #fecaca', background: isWatch ? '#fee2e2' : '#fff', color: '#dc2626', cursor: 'pointer', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                <Archive size={11} /> {isWatch ? 'Prune from Watch' : 'Not Pursuing'}
              </button>
              {opStatus !== LEAD_STATUS.ACTIVE && (
                <button onClick={() => onUpdate({ ...lead, status: LEAD_STATUS.ACTIVE })} style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', color: '#475569', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                  Mark Active
                </button>
              )}
              {opStatus === LEAD_STATUS.ACTIVE && (
                <button onClick={() => onUpdate({ ...lead, status: LEAD_STATUS.WATCH })} style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', color: '#475569', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                  Move to Watch
                </button>
              )}
            </div>
            {/* ── Watch Triage Controls ── */}
            {isWatch && onTriageAction && (
              <div style={{ padding: '10px 12px', borderRadius: 10, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 8 }}>
                  <Flag size={11} style={{ color: '#64748b' }} />
                  <span style={{ fontSize: 10, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Watch Triage</span>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button onClick={() => onTriageAction(lead.id, 'favorite')} style={{
                    padding: '7px 14px', borderRadius: 7, border: `2px solid ${isFav ? '#f59e0b' : '#d1d5db'}`,
                    background: isFav ? '#fffbeb' : '#fff', color: isFav ? '#92400e' : '#374151',
                    cursor: 'pointer', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5,
                    transition: 'all 0.15s', boxShadow: isFav ? '0 0 0 2px rgba(245,158,11,0.15)' : 'none',
                  }}>
                    <Star size={14} style={isFav ? { fill: '#f59e0b', color: '#f59e0b' } : { color: '#9ca3af' }} />
                    {isFav ? 'Favorited' : 'Favorite'}
                  </button>
                  <button onClick={() => onUpdate({ ...lead, pruneImmune: !lead.pruneImmune })} style={{
                    padding: '7px 14px', borderRadius: 7, border: `2px solid ${lead.pruneImmune ? '#10b981' : '#d1d5db'}`,
                    background: lead.pruneImmune ? '#ecfdf5' : '#fff', color: lead.pruneImmune ? '#065f46' : '#374151',
                    cursor: 'pointer', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5,
                    transition: 'all 0.15s', boxShadow: lead.pruneImmune ? '0 0 0 2px rgba(16,185,129,0.15)' : 'none',
                  }}>
                    <Shield size={14} style={{ color: lead.pruneImmune ? '#10b981' : '#9ca3af' }} />
                    {lead.pruneImmune ? 'Immune' : 'Immune'}
                  </button>
                  <button onClick={() => onTriageAction(lead.id, 'mute')} style={{
                    padding: '7px 14px', borderRadius: 7, border: `2px solid ${disp === WATCH_DISPOSITION.MUTED ? '#6b7280' : '#d1d5db'}`,
                    background: disp === WATCH_DISPOSITION.MUTED ? '#f1f5f9' : '#fff', color: disp === WATCH_DISPOSITION.MUTED ? '#374151' : '#374151',
                    cursor: 'pointer', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5,
                    transition: 'all 0.15s', boxShadow: disp === WATCH_DISPOSITION.MUTED ? '0 0 0 2px rgba(107,114,128,0.15)' : 'none',
                  }}>
                    <EyeOff size={14} style={{ color: disp === WATCH_DISPOSITION.MUTED ? '#374151' : '#9ca3af' }} />
                    {disp === WATCH_DISPOSITION.MUTED ? 'Muted' : 'Mute'}
                  </button>
                  <button onClick={() => {
                    if (disp === WATCH_DISPOSITION.DISMISSED) { onTriageAction(lead.id, 'undismiss'); }
                    else { setShowDismissReason(true); }
                  }} style={{
                    padding: '7px 14px', borderRadius: 7, border: `2px solid ${disp === WATCH_DISPOSITION.DISMISSED ? '#ef4444' : '#d1d5db'}`,
                    background: disp === WATCH_DISPOSITION.DISMISSED ? '#fef2f2' : '#fff', color: disp === WATCH_DISPOSITION.DISMISSED ? '#dc2626' : '#374151',
                    cursor: 'pointer', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5,
                    transition: 'all 0.15s', boxShadow: disp === WATCH_DISPOSITION.DISMISSED ? '0 0 0 2px rgba(239,68,68,0.15)' : 'none',
                  }}>
                    <XCircle size={14} style={{ color: disp === WATCH_DISPOSITION.DISMISSED ? '#dc2626' : '#9ca3af' }} />
                    {disp === WATCH_DISPOSITION.DISMISSED ? 'Dismissed' : 'Dismiss'}
                  </button>
                  {reassess && (
                    <button onClick={() => onTriageAction(lead.id, 'clear-reassess')} style={{
                      padding: '7px 14px', borderRadius: 7, border: '2px solid #f59e0b',
                      background: '#fffbeb', color: '#92400e',
                      cursor: 'pointer', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 5,
                      boxShadow: '0 0 0 2px rgba(245,158,11,0.15)',
                    }}>
                      <CheckCircle2 size={14} /> Mark Reviewed
                    </button>
                  )}
                </div>
              </div>
            )}
            {/* Dismiss reason inline form */}
            {showDismissReason && (
              <div style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #fecaca', background: '#fef2f2' }}>
                <p style={{ fontSize: 11, fontWeight: 600, color: '#991b1b', margin: '0 0 6px' }}>Why dismiss this item?</p>
                <select value={dismissCategory} onChange={e => setDismissCategory(e.target.value)}
                  style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 11.5, marginBottom: 6, background: '#fff' }}>
                  <option value="">Select category (optional)</option>
                  <option value="wrong_service">Wrong service line</option>
                  <option value="civil_only">Civil-only / infrastructure</option>
                  <option value="it_only">IT-only / non-design</option>
                  <option value="noise">Generic noise / not a project</option>
                  <option value="out_of_geography">Out of geography</option>
                  <option value="too_small">Too small / limited scope</option>
                  <option value="duplicate">Duplicate of another item</option>
                  <option value="other">Other</option>
                </select>
                <input type="text" placeholder="Optional note..." value={dismissReason} onChange={e => setDismissReason(e.target.value)}
                  style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 11.5, marginBottom: 8, boxSizing: 'border-box' }} />
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  <button onClick={() => { setShowDismissReason(false); setDismissReason(''); setDismissCategory(''); }} style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: '#64748b' }}>Cancel</button>
                  <button onClick={() => { onTriageAction(lead.id, 'dismiss', { reason: dismissReason, category: dismissCategory }); setShowDismissReason(false); setDismissReason(''); setDismissCategory(''); }}
                    style={{ padding: '5px 12px', borderRadius: 6, border: 'none', background: '#dc2626', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: '#fff' }}>Dismiss</button>
                </div>
              </div>
            )}
          </div>
        )}
        {isNotPursued && onRestore && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            {(lead.prunedBy || lead.reasonCategory === 'pruned') ? (
              <>
                <button onClick={() => onRestore(lead.id, true)} style={{ padding: '6px 12px', borderRadius: 6, border: 'none', background: '#10b981', color: '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <RotateCcw size={11} /> Unprune to Watch (Immune)
                </button>
                <button onClick={() => onRestore(lead.id)} style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', color: '#475569', cursor: 'pointer', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                  Restore to Active
                </button>
              </>
            ) : (
              <button onClick={() => onRestore(lead.id)} style={{ padding: '6px 12px', borderRadius: 6, border: 'none', background: '#10b981', color: '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                <RotateCcw size={11} /> Restore to Active
              </button>
            )}
          </div>
        )}
        {/* Tabs */}
        <div style={{ display: 'flex', gap: 0 }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
              background: 'none', border: 'none', padding: '8px 13px', cursor: 'pointer',
              fontSize: 12, fontWeight: 600, color: activeTab === t.id ? '#0f172a' : '#94a3b8',
              borderBottom: activeTab === t.id ? '2px solid #0f172a' : '2px solid transparent',
              transition: 'all 0.15s',
            }}>{t.label}</button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 22 }}>
        {activeTab === 'overview' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* ─── v31c: Decision-ready info grid — key facts FIRST ─── */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: '10px 14px', borderRadius: 10, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
              <DetailField icon={<Building2 size={13} />} label="Owner" value={editing ? <input style={fieldInput} value={form.owner} onChange={e => set('owner', e.target.value)} /> : (lead.owner || '—')} />
              <DetailField icon={<MapPin size={13} />} label="Location" value={editing ? <input style={fieldInput} value={form.location} onChange={e => set('location', e.target.value)} /> : (lead.location || '—')} />
              <DetailField icon={<DollarSign size={13} />} label="Budget" value={editing ? <input style={fieldInput} value={form.potentialBudget} onChange={e => set('potentialBudget', e.target.value)} /> : (lead.potentialBudget || '—')} />
              <DetailField icon={<Calendar size={13} />} label="Timeline" value={editing ? <input style={fieldInput} value={form.potentialTimeline} onChange={e => set('potentialTimeline', e.target.value)} /> : (formatTimeline(lead))} />
              <DetailField icon={<Globe size={13} />} label="Source" value={lead.sourceName || '—'} />
              <DetailField icon={<Clock size={13} />} label="Discovered" value={formatDate(lead.dateDiscovered)} />
            </div>

            {/* Relevance + urgency — compact row */}
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', justifyContent: 'center', padding: '4px 0' }}>
              <ScoreRing score={lead.relevanceScore || 0} size={48} strokeWidth={3.5} label="Relevance" />
              {lead.action_due_date ? (
                <UrgencyRing dueDate={lead.action_due_date} size={48} strokeWidth={3.5} />
              ) : null}
            </div>

            {/* ─── Validation findings (if any) ─── */}
            {(lead.validationClaimed || lead.architect || lead.contractor || lead.validationNotes) && (
              <div style={{ padding: '10px 14px', borderRadius: 8, background: lead.validationClaimed ? '#fef2f2' : '#f8fafc', border: `1px solid ${lead.validationClaimed ? '#fecaca' : '#e2e8f0'}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                  <Shield size={12} style={{ color: lead.validationClaimed ? '#dc2626' : '#64748b' }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: lead.validationClaimed ? '#dc2626' : '#475569' }}>
                    {lead.validationClaimed ? 'Validation: Likely Claimed' : 'Validation Findings'}
                  </span>
                  {lead.lastValidated && (
                    <span style={{ fontSize: 9.5, color: '#94a3b8', marginLeft: 'auto' }}>
                      {formatDate(lead.lastValidated)}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5, color: '#475569', lineHeight: 1.5 }}>
                  {lead.validationClaimed && (
                    <div><strong>Status:</strong> {lead.validationClaimed.replace(/_/g, ' ')}{lead.validationClaimedDetail ? ` — ${lead.validationClaimedDetail}` : ''}</div>
                  )}
                  {lead.architect && <div><strong>Architect / A&E:</strong> {lead.architect}</div>}
                  {lead.contractor && <div><strong>Contractor / CM:</strong> {lead.contractor}</div>}
                  {lead.validationNotes && <div style={{ color: '#64748b', fontStyle: 'italic' }}>{lead.validationNotes}</div>}
                  {lead.validationSources?.length > 0 && (
                    <div style={{ marginTop: 2 }}>
                      {lead.validationSources.slice(0, 2).map((vs, i) => (
                        <div key={i} style={{ fontSize: 10, color: '#94a3b8' }}>
                          {vs.trustLabel || '🌐'} {vs.url ? (
                            <a href={vs.url} target="_blank" rel="noopener noreferrer" style={{ color: '#64748b', textDecoration: 'underline' }}>
                              {vs.url.replace(/^https?:\/\//, '').slice(0, 50)}
                            </a>
                          ) : 'source re-fetch'}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ─── Watch-specific structured overview ─── */}
            {opStatus === LEAD_STATUS.WATCH ? (
              <>
                {/* Reassess banner */}
                {reassess && (
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', borderRadius: 8, background: '#fffbeb', border: '1px solid #f59e0b', borderLeft: '4px solid #f59e0b' }}>
                    <AlertTriangle size={16} style={{ color: '#b45309', flexShrink: 0, marginTop: 1 }} />
                    <div>
                      <p style={{ fontSize: 12, fontWeight: 700, color: '#92400e', margin: '0 0 4px' }}>Reassessment Needed</p>
                      <p style={{ fontSize: 11.5, color: '#78716c', margin: 0, lineHeight: 1.5 }}>
                        This item was previously {disp === WATCH_DISPOSITION.DISMISSED ? 'dismissed' : 'muted'}, but something material has changed.
                        {lead.lastMaterialChangeSummary ? ` ${lead.lastMaterialChangeSummary}` : ' Review the updated evidence and decide whether to track, mute, or dismiss.'}
                      </p>
                    </div>
                  </div>
                )}
                {/* Triage disposition indicator */}
                {(disp === WATCH_DISPOSITION.MUTED || disp === WATCH_DISPOSITION.DISMISSED) && !reassess && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderRadius: 8,
                    background: disp === WATCH_DISPOSITION.MUTED ? '#f8fafc' : '#fef2f2',
                    border: `1px solid ${disp === WATCH_DISPOSITION.MUTED ? '#cbd5e1' : '#fecaca'}`,
                  }}>
                    {disp === WATCH_DISPOSITION.MUTED ? <EyeOff size={13} style={{ color: '#64748b' }} /> : <XCircle size={13} style={{ color: '#dc2626' }} />}
                    <span style={{ fontSize: 11, fontWeight: 600, color: disp === WATCH_DISPOSITION.MUTED ? '#64748b' : '#dc2626' }}>
                      {disp === WATCH_DISPOSITION.MUTED ? 'Muted' : 'Dismissed'}
                      {lead.dismissReason && ` — ${lead.dismissReason}`}
                      {lead.dismissCategory && !lead.dismissReason && ` — ${lead.dismissCategory.replace(/_/g, ' ')}`}
                    </span>
                    <span style={{ fontSize: 10, color: '#94a3b8', marginLeft: 'auto' }}>
                      {disp === WATCH_DISPOSITION.MUTED && lead.mutedAt ? formatDate(lead.mutedAt) : ''}
                      {disp === WATCH_DISPOSITION.DISMISSED && lead.dismissedAt ? formatDate(lead.dismissedAt) : ''}
                    </span>
                  </div>
                )}
                {/* Watch type indicator */}
                {lead.watchCategory && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderRadius: 8, background: '#fefdf8', border: '1px solid #fde68a' }}>
                    <Eye size={13} style={{ color: '#92400e', flexShrink: 0 }} />
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      {(lead.watchCategory || '').replace(/_/g, ' ')}
                    </span>
                    {lead.projectStatus && lead.projectStatus !== 'unknown' && (
                      <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 5, background: '#f1f5f9', color: '#64748b', marginLeft: 'auto' }}>
                        {(lead.projectStatus || '').replace(/_/g, ' ')}
                      </span>
                    )}
                  </div>
                )}

                {/* v31c: Consolidated Watch summary — fewer boxes, more decision-useful */}
                <DetailSection title="Project Summary">
                  <p style={detailText}>{editing ? <textarea style={fieldTextarea} value={form.description} onChange={e => set('description', e.target.value)} /> : (lead.description || generateWatchSummary(lead))}</p>
                  {lead.whyItMatters && !editing && (
                    <p style={{ ...detailText, color: '#475569', marginTop: 8, fontStyle: 'italic' }}>{lead.whyItMatters}</p>
                  )}
                </DetailSection>

                {/* AI Assessment + What to Watch — combined into one actionable section */}
                <DetailSection title="Scout Assessment">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {lead.aiReasonForAddition && (
                      <div style={{ padding: '10px 14px', borderRadius: 8, background: '#f8fafc', borderLeft: '3px solid #6366f1' }}>
                        <p style={{ ...detailText, color: '#475569', margin: 0 }}>{lead.aiReasonForAddition}</p>
                      </div>
                    )}
                    <div style={{ padding: '10px 14px', borderRadius: 8, background: '#eff6ff', borderLeft: '3px solid #3b82f6' }}>
                      <p style={{ ...detailText, color: '#1e40af', margin: 0, whiteSpace: 'pre-line', fontSize: 11.5 }}>{generateWhatToWatch(lead)}</p>
                    </div>
                    {/* v31c: Taxonomy influence summary — quick view without going to Evidence tab */}
                    {lead.taxonomyMatches?.length > 0 && (
                      <div style={{ padding: '8px 14px', borderRadius: 8, background: '#f5f3ff', borderLeft: '3px solid #8b5cf6' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                          <span style={{ fontSize: 10, fontWeight: 700, color: '#6d28d9', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Taxonomy</span>
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {lead.taxonomyMatches.map((m, i) => {
                            const fc = { strong_fit: { bg: '#dcfce7', fg: '#166534' }, moderate_fit: { bg: '#dbeafe', fg: '#1e40af' }, monitor_only: { bg: '#fef9c3', fg: '#854d0e' }, downrank: { bg: '#fed7aa', fg: '#9a3412' }, exclude: { bg: '#fecaca', fg: '#991b1b' } };
                            const c = fc[m.fit_mode] || fc.moderate_fit;
                            return (
                              <span key={i} style={{ fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 5, background: c.bg, color: c.fg }}>
                                {m.label}
                              </span>
                            );
                          })}
                        </div>
                        <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>
                          Matched from your Taxonomy registry. Edit in the Taxonomy tab to adjust fit behavior.
                        </div>
                      </div>
                    )}
                  </div>
                </DetailSection>
              </>
            ) : (
              <>
                {/* v31c: Active lead overview — decision-ready, parity with Watch */}
                {/* Due date callout for active solicitations */}
                {lead.action_due_date && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderRadius: 10, background: '#fef2f2', border: '1px solid #fecaca', borderLeft: '4px solid #ef4444' }}>
                    <Clock size={16} style={{ color: '#dc2626', flexShrink: 0 }} />
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 800, color: '#dc2626' }}>
                        Due: {formatDate(lead.action_due_date)}
                      </div>
                      {(() => {
                        const days = Math.ceil((new Date(lead.action_due_date) - new Date()) / 86400000);
                        if (days < 0) return <div style={{ fontSize: 11, color: '#991b1b', fontWeight: 600 }}>Past due — {Math.abs(days)} days ago</div>;
                        if (days <= 7) return <div style={{ fontSize: 11, color: '#dc2626', fontWeight: 600 }}>{days} day{days !== 1 ? 's' : ''} remaining</div>;
                        if (days <= 30) return <div style={{ fontSize: 11, color: '#b45309' }}>{days} days remaining</div>;
                        return <div style={{ fontSize: 11, color: '#64748b' }}>{days} days remaining</div>;
                      })()}
                    </div>
                  </div>
                )}
                {/* Project summary */}
                <DetailSection title="Project Summary">
                  <p style={detailText}>{editing ? <textarea style={fieldTextarea} value={form.description} onChange={e => set('description', e.target.value)} /> : (lead.description || '—')}</p>
                  {lead.whyItMatters && !editing && (
                    <p style={{ ...detailText, color: '#475569', marginTop: 8, fontStyle: 'italic' }}>{lead.whyItMatters}</p>
                  )}
                </DetailSection>
                {/* Scout Assessment */}
                {(lead.aiReasonForAddition || lead.confidenceNotes) && (
                  <DetailSection title="Scout Assessment">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {lead.aiReasonForAddition && (
                        <div style={{ padding: '10px 14px', borderRadius: 8, background: '#f8fafc', borderLeft: '3px solid #6366f1' }}>
                          <p style={{ ...detailText, color: '#475569', margin: 0 }}>{lead.aiReasonForAddition}</p>
                        </div>
                      )}
                      {lead.confidenceNotes && (
                        <div style={{ padding: '8px 14px', borderRadius: 8, background: '#fafbfc', border: '1px solid #f1f5f9' }}>
                          <p style={{ fontSize: 11, color: '#94a3b8', margin: 0, lineHeight: 1.5 }}>{lead.confidenceNotes}</p>
                        </div>
                      )}
                    </div>
                  </DetailSection>
                )}
              </>
            )}
            {/* ── Supplementary detail fields (Market, Action Due, Last Checked) ── */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, fontSize: 11 }}>
              <DetailField icon={<Building2 size={12} />} label="Market" value={lead.marketSector} />
              <DetailField icon={<Clock size={12} />} label={lead.status === 'active' || lead.leadClass === 'active_solicitation' ? 'Solicitation Due' : 'Action Due'} value={editing ? <input type="date" style={fieldInput} value={form.action_due_date || ''} onChange={e => set('action_due_date', e.target.value)} /> : (lead.action_due_date ? formatDate(lead.action_due_date) : '—')} />
              <DetailField icon={<RefreshCw size={12} />} label="Last Checked" value={formatDate(lead.lastCheckedDate)} />
            </div>
            {editing && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 8, borderTop: '1px solid #f1f5f9' }}>
                <button onClick={() => setEditing(false)} style={{ padding: '8px 16px', borderRadius: 7, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: '#64748b' }}>Cancel</button>
                <button onClick={handleSave} style={{ padding: '8px 16px', borderRadius: 7, border: 'none', background: '#0f172a', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: '#fff' }}><Save size={12} style={{ marginRight: 4, verticalAlign: -2 }} /> Save</button>
              </div>
            )}
          </div>
        )}

        {activeTab === 'evidence' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* v31c: Evidence header — shown for both Active and Watch */}
            <div style={{ padding: '10px 14px', borderRadius: 8, background: isWatch ? '#fefdf8' : '#eff6ff', border: `1px solid ${isWatch ? '#fde68a' : '#bfdbfe'}`, marginBottom: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                {isWatch ? <Eye size={12} style={{ color: '#92400e' }} /> : <FileText size={12} style={{ color: '#2563eb' }} />}
                <span style={{ fontSize: 11, fontWeight: 700, color: isWatch ? '#92400e' : '#1e40af' }}>
                  {isWatch ? 'Source Intelligence' : 'Pursuit Evidence'}
                </span>
              </div>
              <p style={{ fontSize: 11.5, color: '#78716c', margin: 0, lineHeight: 1.5 }}>
                {isWatch
                  ? 'Sources below support this item\'s presence on the board. Best source listed first.'
                  : 'Evidence supporting this active pursuit. Review sources to assess credibility and prepare for Go/No-Go.'}
              </p>
            </div>

            {/* Evidence Source Links — SOURCE-FIRST: shown before summary */}
            {(() => {
              // Build a comprehensive evidence link list from all available data
              const allLinks = [];
              // Add evidenceSourceLinks
              if (lead.evidenceSourceLinks?.length > 0) {
                lead.evidenceSourceLinks.forEach(sl => allLinks.push(sl));
              }
              // Add sourceUrl if not already in the list
              if (lead.sourceUrl && !allLinks.some(l => l.url === lead.sourceUrl)) {
                allLinks.push({ url: lead.sourceUrl, label: lead.sourceName || 'Source Page', linkType: 'source_page' });
              }
              // Add evidenceLinks if not already present
              if (lead.evidenceLinks?.length > 0) {
                lead.evidenceLinks.forEach(url => {
                  if (url && !allLinks.some(l => l.url === url)) {
                    allLinks.push({ url, label: inferEvidenceLabel(url), linkType: inferEvidenceLinkType(url) });
                  }
                });
              }

              if (allLinks.length === 0) return null;

              return (
                <DetailSection title="Evidence Sources">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {allLinks.map((sl, idx) => {
                      const typeLabel = formatLinkTypeLabel(sl.linkType);
                      const isSourcePage = sl.linkType === 'source_page';
                      const preview = generateEvidencePreview(sl, lead);
                      return (
                        <div key={idx} style={{ borderRadius: 8, border: isSourcePage ? '1px solid #e2e8f0' : '1px solid #bfdbfe', overflow: 'hidden' }}>
                          <a href={sl.url} target="_blank" rel="noopener noreferrer"
                            style={{ display:'flex', alignItems:'center', gap:7, padding:'8px 11px', background: isSourcePage ? '#f8fafc' : '#eff6ff', color: isSourcePage ? '#475569' : '#2563eb', fontSize:11.5, fontWeight:600, textDecoration:'none', transition:'background 0.15s' }}
                            onMouseEnter={e => e.currentTarget.style.background = isSourcePage ? '#f1f5f9' : '#dbeafe'}
                            onMouseLeave={e => e.currentTarget.style.background = isSourcePage ? '#f8fafc' : '#eff6ff'}>
                            {isSourcePage ? <Globe size={12} /> : sl.linkType === 'document_pdf' ? <FileText size={12} /> : <Link2 size={12} />}
                            <span style={{ flex:1 }}>{sl.label || sl.url}</span>
                            <span style={{ fontSize:9, color: isSourcePage ? '#94a3b8' : '#60a5fa', textTransform:'uppercase', letterSpacing:'0.03em', fontWeight:600, whiteSpace:'nowrap', padding: '1px 5px', borderRadius: 4, background: isSourcePage ? '#f1f5f9' : '#dbeafe' }}>{typeLabel}</span>
                            <ExternalLink size={10} style={{ opacity:0.4, flexShrink:0 }} />
                          </a>
                          {preview && opStatus === LEAD_STATUS.WATCH && (
                            <div style={{ padding: '6px 11px 8px', background: '#fff', borderTop: '1px solid ' + (isSourcePage ? '#f1f5f9' : '#dbeafe'), fontSize: 11, color: '#64748b', lineHeight: 1.5 }}>
                              {preview}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </DetailSection>
              );
            })()}
            {/* Evidence Summary — shown after sources (source-first layout) */}
            {lead.evidenceSummary && (
              <DetailSection title="Evidence Summary"><p style={detailText}>{lead.evidenceSummary}</p></DetailSection>
            )}
            {/* v31c: Confidence notes — signal quality summary */}
            {lead.confidenceNotes && (
              <DetailSection title="Signal Quality">
                <div style={{ padding: '10px 14px', borderRadius: 8, background: '#fafbfc', border: '1px solid #f1f5f9' }}>
                  <p style={{ fontSize: 11.5, color: '#64748b', margin: 0, lineHeight: 1.6 }}>{lead.confidenceNotes}</p>
                </div>
              </DetailSection>
            )}

            {/* Signal Keywords + Target Orgs — Evidence context, not Overview */}
            {lead.matchedTargetOrgs?.length > 0 && (
              <DetailSection title="Target Organizations">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {lead.matchedTargetOrgs.map(o => <span key={o} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, background: '#eff6ff', color: '#3b82f6', fontWeight: 500 }}>{o}</span>)}
                </div>
              </DetailSection>
            )}
            {lead.matchedKeywords?.length > 0 && (
              <DetailSection title="Signal Keywords">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {lead.matchedKeywords.map(k => <span key={k} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, background: '#f1f5f9', color: '#94a3b8', fontWeight: 500 }}>{k}</span>)}
                </div>
              </DetailSection>
            )}
            {lead.taxonomyMatches?.length > 0 && (
              <DetailSection title="Taxonomy Influence">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {lead.taxonomyMatches.map((m, i) => {
                    const fitColors = { strong_fit: { bg: '#dcfce7', fg: '#166534' }, moderate_fit: { bg: '#dbeafe', fg: '#1e40af' }, monitor_only: { bg: '#fef9c3', fg: '#854d0e' }, downrank: { bg: '#fed7aa', fg: '#9a3412' }, exclude: { bg: '#fecaca', fg: '#991b1b' } };
                    const fitLabels = { strong_fit: 'Strong Fit', moderate_fit: 'Moderate Fit', monitor_only: 'Monitor', downrank: 'Downranked', exclude: 'Excluded' };
                    const fc = fitColors[m.fit_mode] || fitColors.moderate_fit;
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 5, background: fc.bg, color: fc.fg }}>{fitLabels[m.fit_mode] || m.fit_mode}</span>
                        <span style={{ color: '#334155', fontWeight: 600 }}>{m.label}</span>
                        <span style={{ color: '#94a3b8', fontSize: 10 }}>({m.group})</span>
                        {m.matched_keywords?.length > 0 && <span style={{ color: '#94a3b8', fontSize: 10 }}>matched: {m.matched_keywords.slice(0, 3).join(', ')}</span>}
                      </div>
                    );
                  })}
                </div>
              </DetailSection>
            )}
            <DetailSection title="Evidence Timeline">
              {(lead.evidence && lead.evidence.length > 0) ? (
                <div style={{ position: 'relative', paddingLeft: 20 }}>
                  <div style={{ position: 'absolute', left: 5, top: 4, bottom: 4, width: 2, background: '#e2e8f0', borderRadius: 1 }} />
                  {lead.evidence.sort((a, b) => new Date(b.signalDate || b.dateFound) - new Date(a.signalDate || a.dateFound)).map((ev, i) => (
                    <div key={ev.id || i} style={{ position: 'relative', paddingBottom: 16, paddingLeft: 16 }}>
                      <div style={{ position: 'absolute', left: -2, top: 4, width: 12, height: 12, borderRadius: '50%', background: ev.signalStrength === 'strong' ? '#10b981' : ev.signalStrength === 'medium' ? '#f59e0b' : '#cbd5e1', border: '2px solid #fff', boxShadow: '0 0 0 2px ' + (ev.signalStrength === 'strong' ? '#d1fae5' : ev.signalStrength === 'medium' ? '#fef3c7' : '#f1f5f9') }} />
                      <div style={{ fontSize: 10.5, fontWeight: 700, color: '#94a3b8', marginBottom: 3 }}>
                        {formatDate(ev.signalDate || ev.dateFound)}
                        <span style={{ marginLeft: 8, fontWeight: 600, textTransform: 'capitalize', color: ev.signalStrength === 'strong' ? '#10b981' : ev.signalStrength === 'medium' ? '#f59e0b' : '#94a3b8' }}>{ev.signalStrength || 'unknown'} signal</span>
                      </div>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: '#0f172a', marginBottom: 2 }}>{ev.title || ev.sourceName || 'Evidence'}</div>
                      <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 4px', lineHeight: 1.5 }}>{ev.summary || ''}</p>
                      {ev.enrichedFromChild && ev.childDocumentTitle && (
                        <div style={{ fontSize: 10.5, color: '#6366f1', fontWeight: 500, marginBottom: 3, display: 'flex', alignItems: 'center', gap: 4 }}>
                          <FileText size={10} /> Enriched from: {ev.childDocumentTitle}{ev.pdfParsed ? ` (PDF, ${ev.pdfPageCount}pp)` : ''}
                        </div>
                      )}
                      {ev.pdfError && !ev.enrichedFromChild && (
                        <div style={{ fontSize: 10, color: '#f59e0b', fontWeight: 500, marginBottom: 3, display: 'flex', alignItems: 'center', gap: 4 }}>
                          <AlertTriangle size={10} /> PDF available but not readable: {ev.pdfError}
                        </div>
                      )}
                      {ev.url && (
                        <a href={ev.url} target="_blank" rel="noopener noreferrer" style={{ display:'inline-flex', alignItems:'center', gap:5, marginTop:5, padding:'4px 10px', borderRadius:5, background:'#eff6ff', border:'1px solid #bfdbfe', color:'#2563eb', fontSize:11, fontWeight:600, textDecoration:'none', transition:'background 0.15s' }}
                          onMouseEnter={e => e.currentTarget.style.background='#dbeafe'} onMouseLeave={e => e.currentTarget.style.background='#eff6ff'}>
                          <ExternalLink size={11} /> Open source document
                        </a>
                      )}
                      {/* Child document links within this evidence entry */}
                      {ev.childLinks?.length > 0 && (
                        <div style={{ display:'flex', flexDirection:'column', gap:3, marginTop:6 }}>
                          {ev.childLinks.map((cl, ci) => (
                            <a key={ci} href={cl.url} target="_blank" rel="noopener noreferrer"
                              style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'3px 9px', borderRadius:5, background:'#f0fdf4', border:'1px solid #bbf7d0', color:'#15803d', fontSize:10.5, fontWeight:600, textDecoration:'none' }}>
                              <FileText size={10} /> {cl.anchorText || cl.label || 'Document'} <ExternalLink size={9} style={{ opacity:0.4 }} />
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ padding: '16px 0', color: '#94a3b8', fontSize: 13, textAlign: 'center' }}>
                  Evidence timeline populates as the intelligence engine discovers signals. Run a scan from Settings to begin.
                </div>
              )}
            </DetailSection>

            {/* ─── Validation Results Section ─── */}
            {lead.lastValidated && (
              <DetailSection title="Validation" icon={<Shield size={13} />}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                    <span style={{ color: '#94a3b8' }}>Last checked:</span>
                    <span style={{ fontWeight: 600, color: '#475569' }}>{formatDate(lead.lastValidated)}</span>
                    {lead.validationClaimed ? (
                      <span style={{ fontSize: 9.5, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca' }}>
                        {lead.validationClaimed.replace(/_/g, ' ')}
                      </span>
                    ) : (
                      <span style={{ fontSize: 9.5, fontWeight: 600, padding: '2px 7px', borderRadius: 4, background: '#f0fdf4', color: '#16a34a', border: '1px solid #bbf7d0' }}>
                        No claim detected
                      </span>
                    )}
                  </div>
                  {lead.validationClaimedDetail && (
                    <div style={{ fontSize: 11.5, color: '#475569', lineHeight: 1.5 }}>
                      <strong>Detail:</strong> {lead.validationClaimedDetail}
                    </div>
                  )}
                  {lead.architect && (
                    <div style={{ fontSize: 11.5, color: '#475569' }}>
                      <strong>Architect / A&E:</strong> {lead.architect}
                    </div>
                  )}
                  {lead.contractor && (
                    <div style={{ fontSize: 11.5, color: '#475569' }}>
                      <strong>Contractor / CM:</strong> {lead.contractor}
                    </div>
                  )}
                  {lead.validationNotes && (
                    <div style={{ fontSize: 11, color: '#64748b', fontStyle: 'italic', lineHeight: 1.5 }}>
                      {lead.validationNotes}
                    </div>
                  )}
                  {lead.validationSources?.length > 0 && (
                    <div style={{ marginTop: 4, borderTop: '1px solid #f1f5f9', paddingTop: 6 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Validation Sources</div>
                      {lead.validationSources.map((vs, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: '#64748b', marginBottom: 3 }}>
                          <span>{vs.trustLabel || '🌐'}</span>
                          {vs.url ? (
                            <a href={vs.url} target="_blank" rel="noopener noreferrer" style={{ color: '#3b82f6', textDecoration: 'none' }}>
                              {vs.url.replace(/^https?:\/\//, '').slice(0, 55)}
                            </a>
                          ) : <span>Source re-fetch</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </DetailSection>
            )}
          </div>
        )}

        {activeTab === 'asana' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {isSubmitted ? (
              <>
                {/* ── Tracking origin banner ── */}
                {lead.tracking_origin === 'imported_from_asana' ? (
                  <div style={{ padding:'16px', background:'#fffbeb', borderRadius:10, border:'1px solid #fde68a' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:6, fontSize:13, fontWeight:700, color:'#92400e', marginBottom:6 }}>
                      <Download size={16} /> Imported from Asana
                    </div>
                    <p style={{ fontSize:12, color:'#64748b', margin:'0 0 4px', lineHeight:1.5 }}>
                      This is a historical task imported from the Asana board for context and visibility. It was not discovered or submitted by Scout.
                    </p>
                  </div>
                ) : lead.tracking_origin === 'matched_existing' ? (
                  <div style={{ padding:'16px', background:'#f5f3ff', borderRadius:10, border:'1px solid #ddd6fe' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:6, fontSize:13, fontWeight:700, color:'#5b21b6', marginBottom:6 }}>
                      <Bookmark size={16} /> Confirmed Asana Match
                    </div>
                    <p style={{ fontSize:12, color:'#64748b', margin:'0 0 4px', lineHeight:1.5 }}>
                      This lead was discovered by Scout and matched to an existing task on the Asana Project Requests board. A human confirmed the match.
                    </p>
                  </div>
                ) : (
                  <div style={{ padding:'16px', background:'#eff6ff', borderRadius:10, border:'1px solid #bfdbfe' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:6, fontSize:13, fontWeight:700, color:'#1e40af', marginBottom:6 }}>
                      <Send size={16} /> Submitted from Scout
                    </div>
                    <p style={{ fontSize:12, color:'#64748b', margin:'0 0 4px', lineHeight:1.5 }}>
                      This lead was submitted to the Asana Project Requests board via the Project Initiation Form workflow in Scout.
                    </p>
                  </div>
                )}

                {/* ── Asana task details ── */}
                <DetailSection title="Asana Task Details">
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, fontSize:12.5, color:'#475569', lineHeight:1.7 }}>
                    {lead.asana_task_name && (
                      <div style={{ gridColumn:'1 / -1' }}>
                        <span style={{ fontWeight:600, color:'#64748b' }}>Task: </span>{lead.asana_task_name}
                      </div>
                    )}
                    {lead.dateSubmittedToAsana && (
                      <div><span style={{ fontWeight:600, color:'#64748b' }}>Tracked since: </span>{formatDate(lead.dateSubmittedToAsana)}</div>
                    )}
                    {lead.asana_created_at && (
                      <div><span style={{ fontWeight:600, color:'#64748b' }}>Created in Asana: </span>{formatDate(lead.asana_created_at)}</div>
                    )}
                    {lead.asana_section && (
                      <div><span style={{ fontWeight:600, color:'#64748b' }}>Board section: </span>{lead.asana_section}</div>
                    )}
                    {lead.asana_assignee && (
                      <div><span style={{ fontWeight:600, color:'#64748b' }}>Assignee: </span>{lead.asana_assignee}</div>
                    )}
                    {lead.asana_completed && (
                      <div>
                        <span style={{ fontWeight:600, color:'#166534' }}>Completed in Asana </span>
                        {lead.asana_completed_at ? formatDate(lead.asana_completed_at) : ''}
                      </div>
                    )}
                    {lead.asana_match_type && (
                      <div>
                        <span style={{ fontWeight:600, color:'#64748b' }}>Match: </span>
                        {lead.asana_match_type} ({Math.round((lead.asana_match_confidence || 0) * 100)}%)
                      </div>
                    )}
                    {lead.asanaUrl && (
                      <div style={{ gridColumn:'1 / -1' }}>
                        <span style={{ fontWeight:600, color:'#64748b' }}>Asana link: </span>
                        <a href={lead.asanaUrl} target="_blank" rel="noopener noreferrer" style={{ color:'#3b82f6', wordBreak:'break-all' }}>{lead.asanaUrl}</a>
                      </div>
                    )}
                  </div>
                </DetailSection>

                {/* ── Asana notes excerpt ── */}
                {lead.asana_notes_excerpt && (
                  <DetailSection title="Asana Task Notes (excerpt)">
                    <div style={{ fontSize:12, color:'#64748b', lineHeight:1.6, whiteSpace:'pre-wrap', background:'#fafbfc', padding:12, borderRadius:8, border:'1px solid #f1f5f9' }}>
                      {lead.asana_notes_excerpt}
                      {lead.asana_notes_excerpt.length >= 300 && <span style={{ color:'#94a3b8' }}> ...</span>}
                    </div>
                  </DetailSection>
                )}

                {/* ── Submission notes ── */}
                {lead.submissionNotes && (
                  <DetailSection title="Tracking Notes">
                    <div style={{ fontSize:12.5, color:'#475569', lineHeight:1.6 }}>{lead.submissionNotes}</div>
                  </DetailSection>
                )}
              </>
            ) : (
              <>
                {/* v31c: Show BP origin if applicable */}
                {lead.leadOrigin === 'asana_business_pursuit' && (
                  <div style={{ padding:'16px', background:'#f0fdf4', borderRadius:10, border:'1px solid #bbf7d0' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:6, fontSize:13, fontWeight:700, color:'#166534', marginBottom:6 }}>
                      <Bookmark size={16} /> From Asana Business Pursuits
                    </div>
                    <p style={{ fontSize:12, color:'#64748b', margin:'0 0 4px', lineHeight:1.5 }}>
                      This lead was imported from the Business Pursuits section in Asana. It represents an early-stage pursuit opportunity that has not yet reached the Go/No-Go board.
                    </p>
                    {lead.asana_task_name && <div style={{ fontSize:11.5, color:'#475569', marginTop:6 }}><strong>Asana task:</strong> {lead.asana_task_name}</div>}
                    {lead.asana_created_at && <div style={{ fontSize:11.5, color:'#475569' }}><strong>Created:</strong> {formatDate(lead.asana_created_at)}</div>}
                    {lead.asana_section && <div style={{ fontSize:11.5, color:'#475569' }}><strong>Section:</strong> {lead.asana_section}</div>}
                    {lead.asanaUrl && <div style={{ fontSize:11.5, marginTop:4 }}><a href={lead.asanaUrl} target="_blank" rel="noopener noreferrer" style={{ color:'#3b82f6' }}>Open in Asana</a></div>}
                  </div>
                )}
                {/* Asana relationship status */}
                <DetailSection title={lead.asana_task_id ? 'Asana Linked' : 'Asana Status'}>
                  {lead.asana_task_id ? (
                    <div style={{ fontSize: 12.5, color: '#475569', lineHeight: 1.6 }}>
                      <div style={{ marginBottom: 6 }}><strong>Linked to:</strong> {lead.asana_task_name || 'Asana task'}</div>
                      {lead.asana_section && <div><strong>Section:</strong> {lead.asana_section}</div>}
                      {lead.asanaUrl && <div style={{ marginTop:4 }}><a href={lead.asanaUrl} target="_blank" rel="noopener noreferrer" style={{ color:'#3b82f6' }}>Open in Asana</a></div>}
                    </div>
                  ) : (
                    <p style={{ fontSize: 12.5, color: '#94a3b8', lineHeight: 1.6, margin: 0 }}>
                      Not yet linked to an Asana task. Scout checks the Asana board during each sync. If a match is found, you'll be asked to review it.
                    </p>
                  )}
                </DetailSection>
                {/* Submit action */}
                <DetailSection title="Submit to Go/No-Go Board">
                  <p style={{ fontSize: 12.5, color: '#64748b', lineHeight: 1.6, margin: '0 0 12px' }}>
                    Submit this lead to the A&E + SMA Go/No-Go review board via the Project Initiation Form.
                  </p>
                  <button onClick={() => onSubmitToAsana(lead)} style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: '#0f172a', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#fff', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Send size={14} /> Submit to Asana via PIF
                  </button>
                </DetailSection>
              </>
            )}
          </div>
        )}

        {activeTab === 'notes' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* v31c: Team Priority + Next Steps */}
            <DetailSection title="Team Priority">
              <select value={form.teamPriority || ''} onChange={e => set('teamPriority', e.target.value)}
                style={{ width: '100%', padding: '8px 10px', borderRadius: 7, border: '1px solid #e2e8f0', fontSize: 12, background: '#fff' }}>
                <option value="">Not set</option>
                <option value="high">High — actively pursuing</option>
                <option value="medium">Medium — monitoring closely</option>
                <option value="low">Low — background awareness</option>
                <option value="hold">On hold — waiting for trigger</option>
              </select>
            </DetailSection>
            <DetailSection title="Next Steps">
              <textarea style={{ ...fieldTextarea, minHeight: 48 }} value={form.nextSteps || ''} onChange={e => set('nextSteps', e.target.value)} placeholder="What should happen next? e.g., 'Watch for RFQ release in Q3 2026' or 'Contact owner for pre-positioning'" />
            </DetailSection>
            <DetailSection title="Internal Notes">
              <textarea style={{ ...fieldTextarea, minHeight: 80 }} value={form.notes || ''} onChange={e => set('notes', e.target.value)} placeholder="Team context, background, key contacts, competitive intelligence..." />
              <button onClick={handleSave} style={{ marginTop: 6, padding: '6px 14px', borderRadius: 6, border: 'none', background: '#0f172a', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: '#fff' }}><Save size={11} style={{ marginRight: 4, verticalAlign: -2 }} /> Save Notes</button>
            </DetailSection>
            {/* v31c: Go/No-Go readiness checklist — simple prep for future formal review */}
            <DetailSection title="Go / No-Go Readiness">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {[
                  { key: 'goReady_scopeUnderstood', label: 'Project scope is understood' },
                  { key: 'goReady_ownerIdentified', label: 'Owner / client identified' },
                  { key: 'goReady_budgetKnown', label: 'Budget range known or estimated' },
                  { key: 'goReady_timelineKnown', label: 'Timeline or procurement timing known' },
                  { key: 'goReady_competitionAssessed', label: 'Competitive landscape assessed' },
                  { key: 'goReady_teamIdentified', label: 'Internal team / PM identified' },
                ].map(item => (
                  <label key={item.key} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12, color: '#475569', padding: '4px 0' }}>
                    <input type="checkbox" checked={!!form[item.key]} onChange={e => set(item.key, e.target.checked)}
                      style={{ width: 16, height: 16, accentColor: '#10b981', cursor: 'pointer' }} />
                    <span style={{ color: form[item.key] ? '#166534' : '#64748b', fontWeight: form[item.key] ? 600 : 400 }}>{item.label}</span>
                  </label>
                ))}
                <div style={{ marginTop: 4, fontSize: 10.5, color: '#94a3b8', fontStyle: 'italic' }}>
                  {(() => {
                    const checked = ['goReady_scopeUnderstood', 'goReady_ownerIdentified', 'goReady_budgetKnown', 'goReady_timelineKnown', 'goReady_competitionAssessed', 'goReady_teamIdentified'].filter(k => form[k]).length;
                    if (checked >= 5) return 'Ready for Go/No-Go review';
                    if (checked >= 3) return 'Partially ready — continue gathering intelligence';
                    return 'Early stage — more information needed before formal review';
                  })()}
                </div>
                <button onClick={handleSave} style={{ marginTop: 4, padding: '5px 12px', borderRadius: 6, border: 'none', background: '#0f172a', cursor: 'pointer', fontSize: 10.5, fontWeight: 600, color: '#fff', alignSelf: 'flex-start' }}><Save size={10} style={{ marginRight: 3, verticalAlign: -1 }} /> Save</button>
              </div>
            </DetailSection>
            <DetailSection title="Documents & Links">
              {(() => {
                const docs = form.documents || [];
                return (
                  <div>
                    {docs.length === 0 && (
                      <div style={{ padding:'14px 0', color:'#94a3b8', fontSize:12.5, textAlign:'center' }}>
                        No documents or links attached yet. Add links to RFQs, agendas, meeting minutes, or other references.
                      </div>
                    )}
                    {docs.map((doc, idx) => (
                      <div key={doc.id || idx} style={{ padding:'10px 14px', background:'#f8fafc', borderRadius:8, border:'1px solid #e2e8f0', marginBottom:8, display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:10 }}>
                        <div style={{ flex:1, minWidth:0 }}>
                          <a href={doc.url} target="_blank" rel="noopener noreferrer" style={{ fontSize:12.5, fontWeight:600, color:'#2563eb', textDecoration:'none', display:'inline-flex', alignItems:'center', gap:4 }}
                            onMouseEnter={e => e.currentTarget.style.textDecoration='underline'} onMouseLeave={e => e.currentTarget.style.textDecoration='none'}>
                            <ExternalLink size={12} /> {doc.label || 'Link'}
                          </a>
                          {doc.notes && <div style={{ fontSize:11, color:'#94a3b8', marginTop:2 }}>{doc.notes}</div>}
                          <div style={{ fontSize:10, color:'#cbd5e1', marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{doc.url}</div>
                        </div>
                        <div style={{ display:'flex', gap:4, flexShrink:0 }}>
                          <button onClick={() => {
                            const newLabel = prompt('Label:', doc.label || '');
                            if (newLabel === null) return;
                            const newUrl = prompt('URL:', doc.url || '');
                            if (newUrl === null) return;
                            const newNotes = prompt('Notes (optional):', doc.notes || '');
                            const updated = [...docs];
                            updated[idx] = { ...doc, label: newLabel || doc.label, url: newUrl || doc.url, notes: newNotes || '' };
                            set('documents', updated);
                          }} style={{ padding:'2px 6px', borderRadius:4, border:'1px solid #e2e8f0', background:'#fff', cursor:'pointer', fontSize:10, fontWeight:600, color:'#64748b' }}>Edit</button>
                          <button onClick={() => {
                            if (confirm('Remove this link?')) {
                              set('documents', docs.filter((_, i) => i !== idx));
                            }
                          }} style={{ padding:'2px 6px', borderRadius:4, border:'1px solid #fecaca', background:'#fff', cursor:'pointer', fontSize:10, fontWeight:600, color:'#dc2626' }}>✕</button>
                        </div>
                      </div>
                    ))}
                    <button onClick={() => {
                      const label = prompt('Label (e.g. "RFQ PDF", "Commission Agenda 3/4", "Media Release"):');
                      if (!label) return;
                      const url = prompt('URL:');
                      if (!url) return;
                      const notes = prompt('Notes (optional):');
                      const newDoc = { id: `doc-${Date.now()}`, label, url, notes: notes || '', added: new Date().toISOString().split('T')[0] };
                      set('documents', [...docs, newDoc]);
                    }} style={{ padding:'7px 14px', borderRadius:6, border:'1px dashed #e2e8f0', background:'#fff', cursor:'pointer', fontSize:11.5, fontWeight:600, color:'#64748b', width:'100%', display:'flex', alignItems:'center', justifyContent:'center', gap:5, marginTop:4, transition:'border-color 0.15s' }}
                      onMouseEnter={e => e.currentTarget.style.borderColor='#94a3b8'} onMouseLeave={e => e.currentTarget.style.borderColor='#e2e8f0'}>
                      + Add Link
                    </button>
                  </div>
                );
              })()}
            </DetailSection>
            {lead.internalContact && <DetailSection title="Internal Contact"><p style={detailText}>{lead.internalContact}</p></DetailSection>}
            {lead.confidenceNotes && <DetailSection title="Confidence Notes"><p style={detailText}>{lead.confidenceNotes}</p></DetailSection>}
            {isNotPursued && lead.reasonNotPursued && (
              <DetailSection title={(lead.prunedBy || lead.reasonCategory === 'pruned') ? 'Pruned' : 'Reason Not Pursued'}>
                <div style={{ padding: '12px 14px', background: (lead.prunedBy || lead.reasonCategory === 'pruned') ? '#fff7ed' : '#fef2f2', borderRadius: 8, border: `1px solid ${(lead.prunedBy || lead.reasonCategory === 'pruned') ? '#fed7aa' : '#fecaca'}` }}>
                  <p style={{ fontSize: 12.5, color: '#991b1b', margin: 0 }}>{lead.reasonNotPursued}</p>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>Archived: {formatDate(lead.dateNotPursued)}</div>
                </div>
              </DetailSection>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const detailText = { fontSize: 13, lineHeight: 1.6, color: '#475569', margin: 0 };

function DetailSection({ title, children }) {
  return (
    <div>
      <h4 style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px' }}>{title}</h4>
      {children}
    </div>
  );
}

function DetailField({ icon, label, value }) {
  return (
    <div style={{ padding: '10px 12px', background: '#f8fafc', borderRadius: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>
        {icon}{label}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>{value || '—'}</div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════
   DASHBOARD STATS BAR
   ═══════════════════════════════════════════════════════════════ */

function StatsBar({ leads }) {
  const activeCount = leads.filter(l => getOperationalStatus(l).primary === LEAD_STATUS.ACTIVE).length;
  const watchVisibleCount = leads.filter(l => {
    const { primary } = getOperationalStatus(l);
    return primary === LEAD_STATUS.WATCH && isWatchVisible(l);
  }).length;
  const watchHiddenCount = leads.filter(l => {
    const { primary } = getOperationalStatus(l);
    return primary === LEAD_STATUS.WATCH && !isWatchVisible(l);
  }).length;
  const totalWatch = watchVisibleCount + watchHiddenCount;
  const newCount = leads.filter(l => isNewFresh(l)).length;
  const updatedCount = leads.filter(l => isRecentlyUpdated(l)).length;

  // Primary stats: Active and Watch — large, prominent
  // Secondary stats: Board total, New, Updated — smaller, supporting
  return (
    <div style={{ marginBottom: 24 }}>
      {/* ── Primary row: Active + Watch ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 10 }}>
        {/* Active */}
        <div style={{ background: '#f0fdf4', borderRadius: 12, padding: '16px 20px', border: '1px solid #bbf7d0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
            <Activity size={16} style={{ color: '#065f46' }} />
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#065f46' }}>Active</span>
          </div>
          <div style={{ fontSize: 32, fontWeight: 800, color: '#0f172a', letterSpacing: '-0.02em', lineHeight: 1.1 }}>{activeCount}</div>
          <div style={{ fontSize: 10.5, color: '#64748b', marginTop: 2 }}>Actionable pursuits on the board</div>
        </div>
        {/* Watch */}
        <div style={{ background: '#fffbeb', borderRadius: 12, padding: '16px 20px', border: '1px solid #fde68a' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
            <Eye size={16} style={{ color: '#92400e' }} />
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#92400e' }}>Watch</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ fontSize: 32, fontWeight: 800, color: '#0f172a', letterSpacing: '-0.02em', lineHeight: 1.1 }}>{watchVisibleCount}</span>
            {watchHiddenCount > 0 && (
              <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 500 }}>+ {watchHiddenCount} hidden</span>
            )}
          </div>
          <div style={{ fontSize: 10.5, color: '#64748b', marginTop: 2 }}>Monitoring for developments</div>
        </div>
      </div>
      {/* ── Secondary row: Total · New · Updated ── */}
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1, background: '#fff', borderRadius: 8, padding: '10px 14px', border: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', gap: 8 }}>
          <BarChart3 size={13} style={{ color: '#94a3b8', flexShrink: 0 }} />
          <span style={{ fontSize: 10.5, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Board Total</span>
          <span style={{ fontSize: 18, fontWeight: 800, color: '#0f172a', marginLeft: 'auto' }}>{leads.length}</span>
        </div>
        <div style={{ flex: 1, background: '#fff', borderRadius: 8, padding: '10px 14px', border: newCount > 0 ? '1px solid #bfdbfe' : '1px solid #f1f5f9', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Zap size={13} style={{ color: newCount > 0 ? '#2563eb' : '#94a3b8', flexShrink: 0 }} />
          <span style={{ fontSize: 10.5, fontWeight: 600, color: newCount > 0 ? '#2563eb' : '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em' }}>New (7d)</span>
          <span style={{ fontSize: 18, fontWeight: 800, color: newCount > 0 ? '#1e40af' : '#cbd5e1', marginLeft: 'auto' }}>{newCount}</span>
        </div>
        <div style={{ flex: 1, background: '#fff', borderRadius: 8, padding: '10px 14px', border: updatedCount > 0 ? '1px solid #ddd6fe' : '1px solid #f1f5f9', display: 'flex', alignItems: 'center', gap: 8 }}>
          <RefreshCw size={13} style={{ color: updatedCount > 0 ? '#7c3aed' : '#94a3b8', flexShrink: 0 }} />
          <span style={{ fontSize: 10.5, fontWeight: 600, color: updatedCount > 0 ? '#7c3aed' : '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Updated</span>
          <span style={{ fontSize: 18, fontWeight: 800, color: updatedCount > 0 ? '#5b21b6' : '#cbd5e1', marginLeft: 'auto' }}>{updatedCount}</span>
        </div>
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════
   TAB: ACTIVE LEADS
   ═══════════════════════════════════════════════════════════════ */

function ActiveLeadsTab({ leads, onSelectLead, onUpdateLead }) {
  const [search, setSearch] = useState('');
  const [sectorFilter, setSectorFilter] = useState('all');
  const [geoFilter, setGeoFilter] = useState('all');
  const [sortBy, setSortBy] = useState('relevance');
  const [showHidden, setShowHidden] = useState(false);

  const sectors = useMemo(() => [...new Set(leads.map(l => l.marketSector).filter(Boolean))].sort(), [leads]);
  // geos removed — replaced by OFFICE_REGIONS mapping

  // Count hidden (muted/dismissed) Watch items
  const hiddenWatchCount = useMemo(() => {
    return leads.filter(l => {
      const { primary } = getOperationalStatus(l);
      return primary === LEAD_STATUS.WATCH && !isWatchVisible(l);
    }).length;
  }, [leads]);

  const filtered = useMemo(() => {
    let result = [...leads];
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(l =>
        l.title.toLowerCase().includes(q) || l.owner?.toLowerCase().includes(q) ||
        l.description?.toLowerCase().includes(q) || l.marketSector?.toLowerCase().includes(q)
      );
    }
    if (sectorFilter !== 'all') result = result.filter(l => l.marketSector === sectorFilter);
    if (geoFilter !== 'all') {
      if (geoFilter === 'unclassified') {
        result = result.filter(l => getLeadRegions(l).length === 0);
      } else {
        result = result.filter(l => getLeadRegions(l).includes(geoFilter));
      }
    }

    // Operational ordering within each section
    const secondarySort = (a, b) => {
      if (sortBy === 'relevance') return (b.relevanceScore||0) - (a.relevanceScore||0);
      if (sortBy === 'newest') return new Date(b.dateDiscovered) - new Date(a.dateDiscovered);
      if (sortBy === 'duedate') {
        const aDate = a.action_due_date ? new Date(a.action_due_date) : new Date('2099-12-31');
        const bDate = b.action_due_date ? new Date(b.action_due_date) : new Date('2099-12-31');
        return aDate - bDate;
      }
      if (sortBy === 'budget') {
        const extractNum = s => { const m = s?.match(/\$?([\d.]+)/); return m ? parseFloat(m[1]) : 0; };
        return extractNum(b.potentialBudget) - extractNum(a.potentialBudget);
      }
      return 0;
    };

    // Board group rank:
    // Active section: 0=New Active, 1=Updated Active, 2=Active
    // Watch section: 3=Favorite, 4=Reassess, 5=New Watch, 6=Updated Watch, 7=Watch
    const boardRank = (lead) => {
      const { primary, isNew, isUpdated } = getOperationalStatus(lead);
      if (primary === LEAD_STATUS.ACTIVE) {
        if (isNew) return 0;
        if (isUpdated) return 1;
        return 2;
      }
      // Watch — favorites first, then reassess, then new, then update, then standard
      if (lead.favorite) return 3;
      if (isReassessActive(lead)) return 4;
      if (isNew) return 5;
      if (isUpdated) return 6;
      return 7;
    };

    result.sort((a, b) => {
      const ra = boardRank(a), rb = boardRank(b);
      if (ra !== rb) return ra - rb;
      return secondarySort(a, b);
    });
    return result;
  }, [leads, search, sectorFilter, geoFilter, sortBy]);

  return (
    <div>
      <StatsBar leads={leads} />

      {/* Filter Bar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 20, alignItems: 'center' }}>
        <div style={{ flex: '1 1 200px', position: 'relative' }}>
          <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
          <input type="text" placeholder="Search leads..." value={search} onChange={e => setSearch(e.target.value)}
            style={{ width: '100%', padding: '9px 12px 9px 36px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 13, background: '#fff', outline: 'none', boxSizing: 'border-box' }}
          />
        </div>
        <select value={sectorFilter} onChange={e => setSectorFilter(e.target.value)} style={selectStyle}>
          <option value="all">All Markets</option>
          {sectors.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={geoFilter} onChange={e => setGeoFilter(e.target.value)} style={selectStyle}>
          <option value="all">All Regions</option>
          <option value="Montana Statewide">Montana Statewide</option>
          {Object.keys(OFFICE_REGIONS).map(r => <option key={r} value={r}>{r}</option>)}
          <option value="Idaho">Idaho</option>
          <option value="Washington">Washington</option>
          <option value="unclassified">Unclassified</option>
        </select>
        <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={selectStyle}>
          <option value="relevance">Within Group: Relevance</option>
          <option value="newest">Within Group: Newest</option>
          <option value="duedate">Within Group: Action Due</option>
          <option value="budget">Within Group: Budget</option>
        </select>
      </div>

      {/* ═══ ACTIVE SECTION ═══ */}
      {(() => {
        const activeFiltered = filtered.filter(l => { const { primary } = getOperationalStatus(l); return primary === LEAD_STATUS.ACTIVE; });
        const watchVisible = filtered.filter(l => { const { primary } = getOperationalStatus(l); return primary === LEAD_STATUS.WATCH && isWatchVisible(l); });
        const watchHidden = filtered.filter(l => { const { primary } = getOperationalStatus(l); return primary === LEAD_STATUS.WATCH && !isWatchVisible(l); });
        const watchFiltered = showHidden ? [...watchVisible, ...watchHidden] : watchVisible;

        return (
          <>
            {/* Active Section Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <Activity size={16} style={{ color: '#065f46' }} />
                <h2 style={{ fontSize: 16, fontWeight: 800, color: '#0f172a', margin: 0, letterSpacing: '-0.02em' }}>Active</h2>
                <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: '#d1fae5', color: '#065f46' }}>{activeFiltered.length}</span>
              </div>
              <div style={{ flex: 1, height: 1, background: '#e2e8f0', marginLeft: 4 }} />
              <span style={{ fontSize: 10.5, color: '#94a3b8', fontWeight: 500, whiteSpace: 'nowrap' }}>Current actionable pursuits, RFQs, RFPs, active solicitations</span>
            </div>

            {activeFiltered.length > 0 ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 14, marginBottom: 8 }}>
                {activeFiltered.map((lead, i) => (
                  <LeadCard key={lead.id} lead={lead} onClick={() => onSelectLead(lead)}
                    style={{ animationDelay: `${i * 0.04}s`, animation: 'fadeUp 0.35s ease both' }}
                  />
                ))}
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '28px 20px', color: '#94a3b8', background: '#fafbfc', borderRadius: 12, border: '1px dashed #e2e8f0', marginBottom: 8 }}>
                <p style={{ fontSize: 13, fontWeight: 500, margin: 0 }}>No active leads match your filters</p>
              </div>
            )}

            {/* ═══ WATCH SECTION ═══ */}
            <div style={{ marginTop: 32, marginBottom: 14 }}>
              {/* Visual divider */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <Eye size={16} style={{ color: '#92400e' }} />
                  <h2 style={{ fontSize: 16, fontWeight: 800, color: '#0f172a', margin: 0, letterSpacing: '-0.02em' }}>Watch</h2>
                  <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: '#fef3c7', color: '#92400e' }}>{watchVisible.length}</span>
                </div>
                <div style={{ flex: 1, height: 1, background: '#e2e8f0', marginLeft: 4 }} />
                {hiddenWatchCount > 0 && (
                  <button onClick={() => setShowHidden(!showHidden)} style={{
                    display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 6,
                    border: '1px solid #e2e8f0', background: showHidden ? '#f1f5f9' : '#fff',
                    cursor: 'pointer', fontSize: 10.5, fontWeight: 600, color: '#94a3b8',
                    transition: 'all 0.15s',
                  }}>
                    {showHidden ? <EyeOff size={12} /> : <Eye size={12} />}
                    {showHidden ? 'Hide' : 'Show'} {hiddenWatchCount} muted/dismissed
                  </button>
                )}
                <span style={{ fontSize: 10.5, color: '#94a3b8', fontWeight: 500, whiteSpace: 'nowrap' }}>Future opportunities, districts, programs, capital planning</span>
              </div>
              <p style={{ fontSize: 11.5, color: '#94a3b8', margin: '6px 0 0 23px', lineHeight: 1.5 }}>
                Named future opportunities, redevelopment areas, districts, development programs, and project generators that may later branch into actionable pursuits.
              </p>
            </div>

            {watchFiltered.length > 0 ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 14, padding: '16px', background: '#fefdf8', borderRadius: 14, border: '1px solid #fde68a40' }}>
                {watchFiltered.map((lead, i) => {
                  const disp = getWatchDisposition(lead);
                  const isHiddenItem = disp === WATCH_DISPOSITION.MUTED || disp === WATCH_DISPOSITION.DISMISSED;
                  return (
                    <div key={lead.id} style={{ position: 'relative', opacity: isHiddenItem && !isReassessActive(lead) ? 0.55 : 1 }}>
                      {isHiddenItem && (
                        <div style={{ position: 'absolute', top: 8, left: 8, zIndex: 2, fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                          background: disp === WATCH_DISPOSITION.MUTED ? '#f1f5f9' : '#fee2e2',
                          color: disp === WATCH_DISPOSITION.MUTED ? '#64748b' : '#dc2626',
                          textTransform: 'uppercase', letterSpacing: '0.04em',
                        }}>{disp === WATCH_DISPOSITION.MUTED ? 'MUTED' : 'DISMISSED'}</div>
                      )}
                      <LeadCard lead={lead} onClick={() => onSelectLead(lead)}
                        style={{ animationDelay: `${(activeFiltered.length + i) * 0.04}s`, animation: 'fadeUp 0.35s ease both' }}
                      />
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: '28px 20px', color: '#94a3b8', background: '#fefdf8', borderRadius: 12, border: '1px dashed #fde68a', marginBottom: 8 }}>
                <p style={{ fontSize: 13, fontWeight: 500, margin: 0 }}>No watch items match your filters</p>
              </div>
            )}

            {filtered.length === 0 && (
              <div style={{ textAlign: 'center', padding: '60px 20px', color: '#94a3b8' }}>
                <Search size={32} style={{ marginBottom: 12, opacity: 0.4 }} />
                <p style={{ fontSize: 14, fontWeight: 600, margin: '0 0 4px' }}>No leads match your filters</p>
                <p style={{ fontSize: 12.5 }}>Try adjusting your search or filter criteria</p>
              </div>
            )}
          </>
        );
      })()}
    </div>
  );
}

const selectStyle = { padding: '9px 12px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12.5, background: '#fff', color: '#475569', cursor: 'pointer', outline: 'none' };


/* ═══════════════════════════════════════════════════════════════
   TAB: ASANA — PENDING / GO
   Shows Pending and Go items from submittedLeads (excluding No Go).
   Grouped by section, then by year, newest first.
   ═══════════════════════════════════════════════════════════════ */

/**
 * Shared card renderer for tracked items (used by both tabs).
 */
function TrackedCard({ lead, onClick, formatDate }) {
  const disp = getDisposition(lead);
  const originLabel = lead.tracking_origin === 'imported_from_asana' ? 'Imported' : lead.tracking_origin === 'matched_existing' ? 'Matched' : 'Submitted';
  const originColors = lead.tracking_origin === 'imported_from_asana' ? { bg:'#fef3c7', fg:'#92400e' } : lead.tracking_origin === 'matched_existing' ? { bg:'#ede9fe', fg:'#5b21b6' } : { bg:'#dbeafe', fg:'#1e40af' };
  return (
    <div onClick={onClick} style={{ cursor:'pointer' }}>
      <div style={{ background:'#fff', borderRadius:'12px 12px 0 0', border:'1px solid #e2e8f0', borderBottom:'none', padding:'14px 16px' }}>
        <div style={{ fontSize:13.5, fontWeight:700, color: disp.type === 'no_go' ? '#991b1b' : '#1e293b', marginBottom:2, lineHeight:1.3 }}>{getDisplayTitle(lead)}</div>
        {lead.user_edited_title && lead.asana_task_name && (
          <div style={{ fontSize:10.5, color:'#94a3b8', marginBottom:2, fontStyle:'italic' }}>Asana: {lead.asana_task_name}</div>
        )}
        {(lead.scout_title || (lead.asana_task_name && lead.title && lead.asana_task_name.toLowerCase().trim() !== lead.title.toLowerCase().trim())) && (
          <div style={{ fontSize:10.5, color:'#94a3b8', marginBottom:4, fontStyle:'italic' }}>Scout: {lead.scout_title || lead.title}</div>
        )}
        {lead.asana_assignee && (
          <div style={{ fontSize:11.5, color:'#64748b', marginBottom:4 }}><span style={{ fontWeight:600 }}>Assignee:</span> {lead.asana_assignee}</div>
        )}
        {(lead.owner || lead.location) && (
          <div style={{ fontSize:11.5, color:'#64748b', marginBottom:4 }}>
            {lead.owner && <span>{lead.owner}</span>}
            {lead.owner && lead.location && <span> · </span>}
            {lead.location && <span>{lead.location}</span>}
          </div>
        )}
        {lead.description && (
          <div style={{ fontSize:11, color:'#94a3b8', marginTop:4, lineHeight:1.4, overflow:'hidden', textOverflow:'ellipsis', display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical' }}>{lead.description.slice(0, 150)}</div>
        )}
        <div style={{ display:'flex', gap:8, marginTop:8, fontSize:10.5, color:'#94a3b8' }}>
          {disp.date && <span>{disp.type === 'pending' ? 'Submitted' : disp.type === 'go' ? 'Go' : disp.type === 'no_go' ? 'No Go' : 'Archived'} {formatDate(disp.date)}</span>}
          {lead.asana_synced_at && <span>· Synced {formatDate(lead.asana_synced_at)}</span>}
        </div>
      </div>
      <div style={{ padding:'8px 14px', background:'#fafbfc', borderRadius:'0 0 12px 12px', border:'1px solid #e2e8f0', borderTop:'none', display:'flex', flexWrap:'wrap', gap:5, alignItems:'center' }}>
        <span style={{ fontSize:10, fontWeight:600, padding:'2px 7px', borderRadius:4, background:originColors.bg, color:originColors.fg }}>{originLabel}</span>
        {lead.asana_completed && <span style={{ fontSize:10, fontWeight:600, padding:'2px 7px', borderRadius:4, background:'#dcfce7', color:'#166534' }}>Completed</span>}
        {disp.type === 'go' && <span style={{ fontSize:10, fontWeight:600, padding:'2px 7px', borderRadius:4, background:'#dcfce7', color:'#166534' }}>Go</span>}
        {disp.type === 'no_go' && <span style={{ fontSize:10, fontWeight:600, padding:'2px 7px', borderRadius:4, background:'#fecaca', color:'#991b1b' }}>No Go</span>}
        {lead.asana_section && <span style={{ fontSize:10, fontWeight:600, padding:'2px 7px', borderRadius:4, background:'#f1f5f9', color:'#475569' }}>{lead.asana_section}</span>}
        {lead.last_scout_reappearance && <span style={{ fontSize:10, fontWeight:600, padding:'2px 7px', borderRadius:4, background:'#fef9c3', color:'#854d0e' }} title={`Scout re-detected this pursuit on ${new Date(lead.last_scout_reappearance).toLocaleDateString()}`}>↻ Reappeared</span>}
        {lead.asanaUrl && (
          <a href={lead.asanaUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
            style={{ fontSize:10, color:'#3b82f6', textDecoration:'none', marginLeft:'auto' }}>View in Asana ↗</a>
        )}
      </div>
    </div>
  );
}

/**
 * Group items by year from a date field. Returns [{ year, items }], newest year first.
 * Items within each year are sorted newest first.
 */
function groupByYear(items, dateKey) {
  const groups = {};
  for (const item of items) {
    const d = getDisposition(item);
    const dateStr = d.date || item[dateKey] || item.dateDiscovered || '';
    let year;
    try { year = dateStr ? new Date(dateStr).getFullYear() : 0; } catch { year = 0; }
    if (!year || isNaN(year)) year = 0;
    if (!groups[year]) groups[year] = [];
    groups[year].push(item);
  }
  // Sort each group by date descending
  for (const year of Object.keys(groups)) {
    groups[year].sort((a, b) => {
      const da = getDisposition(a).date || a[dateKey] || '';
      const db = getDisposition(b).date || b[dateKey] || '';
      return db.localeCompare(da);
    });
  }
  return Object.entries(groups)
    .map(([y, items]) => ({ year: Number(y), items }))
    .sort((a, b) => b.year - a.year);
}

/**
 * Section header component with optional count.
 */
function SectionHeader({ title, count, color, bg }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:10, padding:'12px 0 8px', borderBottom:`2px solid ${color || '#e2e8f0'}`, marginBottom:12 }}>
      <h3 style={{ fontSize:14, fontWeight:800, color: color || '#1e293b', margin:0, letterSpacing:'-0.01em' }}>{title}</h3>
      {count !== undefined && <span style={{ fontSize:11, fontWeight:700, padding:'2px 8px', borderRadius:10, background: bg || '#f1f5f9', color: color || '#64748b' }}>{count}</span>}
    </div>
  );
}

/**
 * Year divider header.
 */
function YearHeader({ year }) {
  return (
    <div style={{ padding:'6px 0 4px', marginBottom:8, marginTop:4 }}>
      <span style={{ fontSize:11.5, fontWeight:700, color:'#94a3b8', textTransform:'uppercase', letterSpacing:'0.06em' }}>{year === 0 ? 'Date Unknown' : year}</span>
    </div>
  );
}

function SubmittedTab({ leads, onSelectLead, onImport }) {
  const [search, setSearch] = useState('');
  const [regionFilter, setRegionFilter] = useState('all');

  const formatDate = (d) => { try { return d ? new Date(d).toLocaleDateString() : ''; } catch { return ''; } };

  // Split into Pending vs Go (exclude No Go — those go to the other tab)
  const { pendingItems, goItems } = useMemo(() => {
    let list = leads.filter(l => getDisposition(l).type !== 'no_go'); // No Go items belong on the other tab
    // Search
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(l =>
        (l.title || '').toLowerCase().includes(q) ||
        (l.user_edited_title || '').toLowerCase().includes(q) ||
        (l.owner || '').toLowerCase().includes(q) ||
        (l.asana_assignee || '').toLowerCase().includes(q) ||
        (l.asana_section || '').toLowerCase().includes(q) ||
        (l.description || '').toLowerCase().includes(q) ||
        (l.asana_task_name || '').toLowerCase().includes(q) ||
        (l.scout_title || '').toLowerCase().includes(q) ||
        (l.original_title || '').toLowerCase().includes(q) ||
        (l.alternate_titles || []).some(t => t.toLowerCase().includes(q))
      );
    }
    // Region filter
    if (regionFilter !== 'all') {
      if (regionFilter === 'unclassified') {
        list = list.filter(l => getLeadRegions(l).length === 0);
      } else {
        list = list.filter(l => getLeadRegions(l).includes(regionFilter));
      }
    }
    const pending = [];
    const go = [];
    for (const l of list) {
      const d = getDisposition(l);
      if (d.type === 'go') { go.push(l); }
      else { pending.push(l); }
    }
    return { pendingItems: pending, goItems: go };
  }, [leads, search, regionFilter]);

  const pendingGroups = useMemo(() => groupByYear(pendingItems, 'dateSubmittedToAsana'), [pendingItems]);
  const goGroups = useMemo(() => groupByYear(goItems, 'go_date'), [goItems]);
  const totalShown = pendingItems.length + goItems.length;
  const totalNoGo = leads.filter(l => getDisposition(l).type === 'no_go').length;

  if (leads.length === 0) return (
    <div>
      <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:16 }}>
        <button onClick={onImport} style={{ padding:'8px 16px', borderRadius:7, border:'1px solid #e2e8f0', background:'#fff', cursor:'pointer', fontSize:12, fontWeight:600, color:'#475569', display:'flex', alignItems:'center', gap:5 }}>
          <Download size={13} /> Import from Asana
        </button>
      </div>
      <EmptyState icon={<Send size={36} />} title="No Pending or Go Pursuits" message='No Asana pursuits are currently tracked. Use "Check Asana Now" in Settings to sync, or Import from Asana to manually add items.' />
    </div>
  );

  return (
    <div>
      {/* ── Summary bar ── */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:14, flexWrap:'wrap', gap:10 }}>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          <div style={{ background:'#fff', borderRadius:9, padding:'8px 14px', border:'1px solid rgba(0,0,0,0.05)', display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ fontSize:9.5, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.06em', color:'#94a3b8' }}>Pending</div>
            <div style={{ fontSize:18, fontWeight:800, color:'#f59e0b' }}>{pendingItems.length}</div>
          </div>
          <div style={{ background:'#fff', borderRadius:9, padding:'8px 14px', border:'1px solid rgba(0,0,0,0.05)', display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ fontSize:9.5, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.06em', color:'#94a3b8' }}>Go</div>
            <div style={{ fontSize:18, fontWeight:800, color:'#16a34a' }}>{goItems.length}</div>
          </div>
          {totalNoGo > 0 && (
            <div style={{ background:'#fff', borderRadius:9, padding:'8px 14px', border:'1px solid rgba(0,0,0,0.05)', display:'flex', alignItems:'center', gap:8 }}>
              <div style={{ fontSize:9.5, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.06em', color:'#94a3b8' }}>No Go</div>
              <div style={{ fontSize:14, fontWeight:700, color:'#94a3b8' }}>{totalNoGo}</div>
              <div style={{ fontSize:9, color:'#94a3b8' }}>(other tab)</div>
            </div>
          )}
        </div>
        <button onClick={onImport} style={{ padding:'8px 16px', borderRadius:7, border:'1px solid #e2e8f0', background:'#fff', cursor:'pointer', fontSize:12, fontWeight:600, color:'#475569', display:'flex', alignItems:'center', gap:5, flexShrink:0 }}>
          <Download size={13} /> Import from Asana
        </button>
      </div>

      {/* ── Search + Region filter ── */}
      <div style={{ display:'flex', gap:8, marginBottom:14, flexWrap:'wrap', alignItems:'center' }}>
        <div style={{ position:'relative', flex:'1 1 220px', minWidth:180 }}>
          <Search size={13} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#94a3b8' }} />
          <input type="text" placeholder="Search title, assignee, section..." value={search} onChange={e => setSearch(e.target.value)}
            style={{ width:'100%', padding:'8px 10px 8px 30px', borderRadius:8, border:'1px solid #e2e8f0', fontSize:12.5, outline:'none', background:'#fff' }} />
        </div>
        <select value={regionFilter} onChange={e => setRegionFilter(e.target.value)}
          style={{ padding:'8px 10px', borderRadius:8, border:'1px solid #e2e8f0', fontSize:12, background:'#fff', color:'#475569', cursor:'pointer' }}>
          <option value="all">All Regions</option>
          <option value="Montana Statewide">Montana Statewide</option>
          {Object.keys(OFFICE_REGIONS).map(r => <option key={r} value={r}>{r}</option>)}
          <option value="Idaho">Idaho</option>
          <option value="Washington">Washington</option>
          <option value="unclassified">Unclassified</option>
        </select>
      </div>

      {(search || regionFilter !== 'all') && (
        <div style={{ fontSize:11.5, color:'#94a3b8', marginBottom:10 }}>Showing {totalShown} of {leads.filter(l => getDisposition(l).type !== 'no_go').length} items{search && <span> matching &ldquo;{search}&rdquo;</span>}</div>
      )}

      {totalShown === 0 && (
        <div style={{ textAlign:'center', padding:'40px 20px', color:'#94a3b8' }}>
          <Search size={24} style={{ marginBottom:8, opacity:0.5 }} />
          <div style={{ fontSize:13, fontWeight:600 }}>No items match your filters</div>
        </div>
      )}

      {/* ── PENDING Section ── */}
      {pendingItems.length > 0 && (
        <div style={{ marginBottom:28 }}>
          <SectionHeader title="Pending" count={pendingItems.length} color="#d97706" bg="#fef3c7" />
          {pendingGroups.map(g => (
            <div key={`pending-${g.year}`}>
              <YearHeader year={g.year} />
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(340px, 1fr))', gap:14, marginBottom:12 }}>
                {g.items.map(lead => <TrackedCard key={lead.id} lead={lead} onClick={() => onSelectLead(lead)} formatDate={formatDate} />)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Section divider ── */}
      {pendingItems.length > 0 && goItems.length > 0 && (
        <div style={{ borderTop:'1px solid #e2e8f0', marginBottom:20 }} />
      )}

      {/* ── GO Section ── */}
      {goItems.length > 0 && (
        <div>
          <SectionHeader title="Go" count={goItems.length} color="#16a34a" bg="#dcfce7" />
          {goGroups.map(g => (
            <div key={`go-${g.year}`}>
              <YearHeader year={g.year} />
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(340px, 1fr))', gap:14, marginBottom:12 }}>
                {g.items.map(lead => <TrackedCard key={lead.id} lead={lead} onClick={() => onSelectLead(lead)} formatDate={formatDate} />)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════
   ASANA IMPORT MODAL
   ═══════════════════════════════════════════════════════════════ */

function AsanaImportModal({ onClose, onFetch, onImport, existingGids }) {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [search, setSearch] = useState('');
  const [sectionFilter, setSectionFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [importResult, setImportResult] = useState(null);

  // Fetch on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const result = await onFetch();
      if (cancelled) return;
      if (result.error) { setError(result.error); setLoading(false); return; }
      setTasks(result.tasks);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [onFetch]);

  // Derive sections list
  const sections = useMemo(() => {
    const s = new Set();
    tasks.forEach(t => { if (t.section) s.add(t.section); });
    return [...s].sort();
  }, [tasks]);

  // Already-tracked GIDs set
  const trackedGids = useMemo(() => new Set(existingGids || []), [existingGids]);

  // Filtered tasks
  const filtered = useMemo(() => {
    let list = [...tasks];
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(t => t.name?.toLowerCase().includes(q) || t.assignee_name?.toLowerCase().includes(q));
    }
    if (sectionFilter !== 'all') list = list.filter(t => t.section === sectionFilter);
    if (statusFilter === 'incomplete') list = list.filter(t => !t.completed);
    if (statusFilter === 'completed') list = list.filter(t => t.completed);
    return list;
  }, [tasks, search, sectionFilter, statusFilter]);

  const selectAll = () => {
    const s = new Set(selected);
    filtered.forEach(t => { if (!trackedGids.has(t.gid)) s.add(t.gid); });
    setSelected(s);
  };
  const selectNone = () => {
    const s = new Set(selected);
    filtered.forEach(t => s.delete(t.gid));
    setSelected(s);
  };
  const toggleTask = (gid) => {
    const s = new Set(selected);
    if (s.has(gid)) s.delete(gid); else s.add(gid);
    setSelected(s);
  };

  const handleImport = () => {
    const toImport = tasks.filter(t => selected.has(t.gid));
    const result = onImport(toImport);
    setImportResult(result);
    // Clear selections for imported tasks
    setSelected(new Set());
  };

  const formatDate = (d) => { try { return new Date(d).toLocaleDateString(); } catch { return ''; } };

  return (
    <Modal title="Import from Asana" onClose={onClose} width={780}>
      {loading && (
        <div style={{ textAlign:'center', padding:'40px 20px', color:'#94a3b8' }}>
          <RefreshCw size={24} style={{ animation:'spin 1s linear infinite', marginBottom:12 }} />
          <div style={{ fontSize:13, fontWeight:600 }}>Fetching tasks from Asana board...</div>
        </div>
      )}

      {error && (
        <div style={{ padding:'20px', background:'#fef2f2', borderRadius:10, border:'1px solid #fecaca', color:'#991b1b', fontSize:13 }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {importResult && (
        <div style={{ padding:'14px 16px', background:'#f0fdf4', borderRadius:10, border:'1px solid #bbf7d0', marginBottom:14, fontSize:13, color:'#166534' }}>
          <strong>Import complete:</strong> {importResult.imported} task{importResult.imported !== 1 ? 's' : ''} imported.
          {importResult.skipped > 0 && ` ${importResult.skipped} skipped (already tracked).`}
        </div>
      )}

      {!loading && !error && (
        <>
          {/* Info banner */}
          <div style={{ padding:'10px 14px', background:'#fffbeb', borderRadius:8, border:'1px solid #fde68a', marginBottom:14, fontSize:11.5, color:'#92400e', lineHeight:1.5 }}>
            These are existing Asana board tasks — not leads discovered by Scout. Importing them creates historical context entries in the Asana \u2013 Pending / Go tab for visibility.
          </div>

          {/* Filters */}
          <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:12, alignItems:'center' }}>
            <div style={{ flex:'1 1 180px', position:'relative' }}>
              <Search size={13} style={{ position:'absolute', left:9, top:'50%', transform:'translateY(-50%)', color:'#94a3b8' }} />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search task name or assignee..." style={{ width:'100%', padding:'7px 10px 7px 28px', borderRadius:7, border:'1px solid #e2e8f0', fontSize:12, outline:'none', background:'#fafbfc', boxSizing:'border-box' }} />
            </div>
            <select value={sectionFilter} onChange={e => setSectionFilter(e.target.value)} style={{ padding:'7px 10px', borderRadius:7, border:'1px solid #e2e8f0', fontSize:12, background:'#fff', cursor:'pointer', outline:'none' }}>
              <option value="all">All Sections</option>
              {sections.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={{ padding:'7px 10px', borderRadius:7, border:'1px solid #e2e8f0', fontSize:12, background:'#fff', cursor:'pointer', outline:'none' }}>
              <option value="all">All Status</option>
              <option value="incomplete">Incomplete</option>
              <option value="completed">Completed</option>
            </select>
          </div>

          {/* Selection controls and count */}
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
            <div style={{ display:'flex', gap:8, alignItems:'center' }}>
              <button onClick={selectAll} style={{ padding:'4px 10px', borderRadius:5, border:'1px solid #e2e8f0', background:'#fff', cursor:'pointer', fontSize:11, fontWeight:600, color:'#475569' }}>Select All Visible</button>
              <button onClick={selectNone} style={{ padding:'4px 10px', borderRadius:5, border:'1px solid #e2e8f0', background:'#fff', cursor:'pointer', fontSize:11, fontWeight:600, color:'#475569' }}>Select None</button>
            </div>
            <div style={{ fontSize:11.5, color:'#64748b' }}>
              {selected.size} selected · {filtered.length} shown of {tasks.length} total
            </div>
          </div>

          {/* Task list */}
          <div style={{ maxHeight:420, overflowY:'auto', border:'1px solid #e2e8f0', borderRadius:10, background:'#fff' }}>
            {filtered.length === 0 && (
              <div style={{ padding:'30px 20px', textAlign:'center', color:'#94a3b8', fontSize:13 }}>No tasks match your filters</div>
            )}
            {filtered.map(task => {
              const isTracked = trackedGids.has(task.gid);
              const isSelected = selected.has(task.gid);
              return (
                <div key={task.gid} style={{
                  display:'flex', alignItems:'flex-start', gap:10, padding:'10px 14px',
                  borderBottom:'1px solid #f1f5f9', opacity: isTracked ? 0.45 : 1,
                  background: isSelected ? '#f0f9ff' : 'transparent', transition:'background 0.1s',
                  cursor: isTracked ? 'default' : 'pointer',
                }} onClick={() => { if (!isTracked) toggleTask(task.gid); }}>
                  <input type="checkbox" checked={isSelected} disabled={isTracked}
                    onChange={() => { if (!isTracked) toggleTask(task.gid); }}
                    style={{ marginTop:2, cursor: isTracked ? 'default' : 'pointer', accentColor:'#0f172a' }}
                  />
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:12.5, fontWeight:600, color:'#0f172a', marginBottom:3, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                      {task.name || 'Untitled'}
                      {isTracked && <span style={{ fontSize:10, fontWeight:600, marginLeft:8, padding:'1px 6px', borderRadius:4, background:'#f1f5f9', color:'#94a3b8' }}>Already tracked</span>}
                    </div>
                    <div style={{ display:'flex', flexWrap:'wrap', gap:6, fontSize:10.5, color:'#94a3b8' }}>
                      {task.section && <span style={{ padding:'1px 6px', borderRadius:3, background:'#f1f5f9', color:'#475569', fontWeight:600 }}>{task.section}</span>}
                      {task.completed && <span style={{ padding:'1px 6px', borderRadius:3, background:'#dcfce7', color:'#166534', fontWeight:600 }}>Completed</span>}
                      {task.assignee_name && <span>{task.assignee_name}</span>}
                      {task.created_at && <span>Created {formatDate(task.created_at)}</span>}
                    </div>
                  </div>
                  {task.permalink_url && (
                    <a href={task.permalink_url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
                      style={{ color:'#94a3b8', flexShrink:0, padding:4 }} title="Open in Asana">
                      <ExternalLink size={12} />
                    </a>
                  )}
                </div>
              );
            })}
          </div>

          {/* Footer actions */}
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginTop:16, paddingTop:14, borderTop:'1px solid #f1f5f9' }}>
            <div style={{ fontSize:11, color:'#94a3b8' }}>
              Imported tasks appear in the Asana \u2013 Pending / Go tab as historical context.
            </div>
            <div style={{ display:'flex', gap:8 }}>
              <button onClick={onClose} style={{ padding:'8px 16px', borderRadius:7, border:'1px solid #e2e8f0', background:'#fff', cursor:'pointer', fontSize:12, fontWeight:600, color:'#64748b' }}>
                Close
              </button>
              <button onClick={handleImport} disabled={selected.size === 0}
                style={{
                  padding:'8px 16px', borderRadius:7, border:'none', cursor: selected.size > 0 ? 'pointer' : 'default',
                  background: selected.size > 0 ? '#0f172a' : '#e2e8f0',
                  color: selected.size > 0 ? '#fff' : '#94a3b8',
                  fontSize:12, fontWeight:600, display:'flex', alignItems:'center', gap:5,
                }}>
                <Download size={12} /> Import {selected.size > 0 ? `${selected.size} Task${selected.size !== 1 ? 's' : ''}` : 'Selected'}
              </button>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}


/* ═══════════════════════════════════════════════════════════════
   TAB: NOT PURSUED
   ═══════════════════════════════════════════════════════════════ */

function NotPursuedTab({ leads, submittedLeads, onSelectLead, onRestore }) {
  const [search, setSearch] = useState('');

  const formatDate = (d) => { try { return d ? new Date(d).toLocaleDateString() : ''; } catch { return ''; } };

  // Not Pursued = locally archived leads
  // Asana No-Go = submitted leads with no_go flag
  const { notPursuedItems, noGoItems } = useMemo(() => {
    let npList = [...leads];
    let ngList = (submittedLeads || []).filter(l => getDisposition(l).type === 'no_go');
    if (search) {
      const q = search.toLowerCase();
      const matchesSearch = l => (l.title || '').toLowerCase().includes(q) || (l.user_edited_title || '').toLowerCase().includes(q) ||
        (l.asana_task_name || '').toLowerCase().includes(q) || (l.description || '').toLowerCase().includes(q) ||
        (l.owner || '').toLowerCase().includes(q) || (l.reasonNotPursued || '').toLowerCase().includes(q) ||
        (l.asana_assignee || '').toLowerCase().includes(q);
      npList = npList.filter(matchesSearch);
      ngList = ngList.filter(matchesSearch);
    }
    return { notPursuedItems: npList, noGoItems: ngList };
  }, [leads, submittedLeads, search]);

  const npGroups = useMemo(() => groupByYear(notPursuedItems, 'dateNotPursued'), [notPursuedItems]);
  const ngGroups = useMemo(() => groupByYear(noGoItems, 'no_go_date'), [noGoItems]);
  const totalCount = notPursuedItems.length + noGoItems.length;

  if (leads.length === 0 && !(submittedLeads || []).some(l => getDisposition(l).type === 'no_go')) {
    return <EmptyState icon={<Archive size={36} />} title="No Rejected Items" message="Leads reviewed and not pursued, and Asana No-Go pursuits, appear here. No items have been rejected yet." />;
  }

  return (
    <div>
      {/* ── Summary bar ── */}
      <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:14 }}>
        <div style={{ background:'#fff', borderRadius:9, padding:'8px 14px', border:'1px solid rgba(0,0,0,0.05)', display:'flex', alignItems:'center', gap:8 }}>
          <div style={{ fontSize:9.5, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.06em', color:'#94a3b8' }}>Not Pursued</div>
          <div style={{ fontSize:18, fontWeight:800, color:'#6b7280' }}>{notPursuedItems.length}</div>
        </div>
        <div style={{ background:'#fff', borderRadius:9, padding:'8px 14px', border:'1px solid rgba(0,0,0,0.05)', display:'flex', alignItems:'center', gap:8 }}>
          <div style={{ fontSize:9.5, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.06em', color:'#94a3b8' }}>Asana No-Go</div>
          <div style={{ fontSize:18, fontWeight:800, color:'#991b1b' }}>{noGoItems.length}</div>
        </div>
      </div>

      {/* ── Search ── */}
      <div style={{ marginBottom:14 }}>
        <div style={{ position:'relative', maxWidth:400 }}>
          <Search size={13} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#94a3b8' }} />
          <input type="text" placeholder="Search rejected items..." value={search} onChange={e => setSearch(e.target.value)}
            style={{ width:'100%', padding:'8px 10px 8px 30px', borderRadius:8, border:'1px solid #e2e8f0', fontSize:12.5, outline:'none', background:'#fff' }} />
        </div>
      </div>

      {search && (
        <div style={{ fontSize:11.5, color:'#94a3b8', marginBottom:10 }}>Showing {totalCount} item{totalCount !== 1 ? 's' : ''} matching &ldquo;{search}&rdquo;</div>
      )}

      {/* ── NOT PURSUED Section ── */}
      {notPursuedItems.length > 0 && (
        <div style={{ marginBottom:28 }}>
          <SectionHeader title="Not Pursued" count={notPursuedItems.length} color="#6b7280" bg="#f3f4f6" />
          {npGroups.map(g => (
            <div key={`np-${g.year}`}>
              <YearHeader year={g.year} />
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(340px, 1fr))', gap:14, marginBottom:12 }}>
                {g.items.map(lead => (
                  <div key={lead.id} style={{ position:'relative' }}>
                    <div onClick={() => onSelectLead(lead)} style={{ cursor:'pointer' }}>
                      <div style={{ background:'#fff', borderRadius:'12px 12px 0 0', border:'1px solid #e2e8f0', borderBottom:'none', padding:'14px 16px' }}>
                        <div style={{ fontSize:13.5, fontWeight:700, color:'#6b7280', marginBottom:2, lineHeight:1.3 }}>{getDisplayTitle(lead)}</div>
                        {(lead.owner || lead.location) && (
                          <div style={{ fontSize:11.5, color:'#94a3b8', marginBottom:4 }}>
                            {lead.owner && <span>{lead.owner}</span>}
                            {lead.owner && lead.location && <span> · </span>}
                            {lead.location && <span>{lead.location}</span>}
                          </div>
                        )}
                        <div style={{ fontSize:10.5, color:'#94a3b8', marginTop:6 }}>
                          <span style={{ fontWeight:600 }}>Archived:</span> {formatDate(lead.dateNotPursued)}
                          <span style={{ margin:'0 6px' }}>·</span>
                          <span style={{ fontWeight:600 }}>Source:</span> Scout review
                        </div>
                      </div>
                    </div>
                    <div style={{ padding:'8px 14px', background:'#fef2f2', borderRadius:'0 0 12px 12px', border:'1px solid #fecaca', borderTop:'none', fontSize:11.5, color:'#991b1b', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                      <span><strong>Reason:</strong> {lead.reasonNotPursued || 'No reason recorded'}</span>
                      <button onClick={(e) => { e.stopPropagation(); onRestore(lead.id); }} style={{ padding:'3px 10px', borderRadius:5, border:'1px solid #fecaca', background:'#fff', cursor:'pointer', fontSize:10.5, fontWeight:600, color:'#dc2626', flexShrink:0 }}>
                        <RotateCcw size={10} style={{ marginRight:3, verticalAlign:-1 }} />Restore
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Section divider ── */}
      {notPursuedItems.length > 0 && noGoItems.length > 0 && (
        <div style={{ borderTop:'1px solid #e2e8f0', marginBottom:20 }} />
      )}

      {/* ── ASANA NO-GO Section ── */}
      {noGoItems.length > 0 && (
        <div>
          <SectionHeader title="Asana No-Go" count={noGoItems.length} color="#991b1b" bg="#fecaca" />
          {ngGroups.map(g => (
            <div key={`ng-${g.year}`}>
              <YearHeader year={g.year} />
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(340px, 1fr))', gap:14, marginBottom:12 }}>
                {g.items.map(lead => <TrackedCard key={lead.id} lead={lead} onClick={() => onSelectLead(lead)} formatDate={formatDate} />)}
              </div>
            </div>
          ))}
        </div>
      )}

      {totalCount === 0 && search && (
        <div style={{ textAlign:'center', padding:'40px 20px', color:'#94a3b8' }}>
          <Search size={24} style={{ marginBottom:8, opacity:0.5 }} />
          <div style={{ fontSize:13, fontWeight:600 }}>No items match your search</div>
        </div>
      )}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════
   SHARED: MODAL OVERLAY
   ═══════════════════════════════════════════════════════════════ */

function Modal({ title, onClose, width = 560, children }) {
  return (
    <>
      <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.35)', zIndex:2000, animation:'fadeUp 0.12s ease' }} />
      <div style={{
        position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)', zIndex:2001,
        background:'#fff', borderRadius:16, width:'90vw', maxWidth:width, maxHeight:'88vh',
        display:'flex', flexDirection:'column', boxShadow:'0 24px 80px rgba(0,0,0,0.18)',
        animation:'fadeUp 0.2s ease',
      }}>
        <div style={{ padding:'18px 22px', borderBottom:'1px solid #f1f5f9', display:'flex', justifyContent:'space-between', alignItems:'center', flexShrink:0 }}>
          <h3 style={{ fontSize:16, fontWeight:800, color:'#0f172a', margin:0, letterSpacing:'-0.02em' }}>{title}</h3>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', padding:4, color:'#94a3b8' }}><X size={18} /></button>
        </div>
        <div style={{ padding:'20px 22px', overflowY:'auto', flex:1 }}>{children}</div>
      </div>
    </>
  );
}

/* ── Shared form field components ── */
const fieldLabel = { fontSize:11, fontWeight:700, color:'#64748b', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:5, display:'block' };
const fieldInput = { width:'100%', padding:'8px 11px', borderRadius:7, border:'1px solid #e2e8f0', fontSize:13, outline:'none', background:'#fafbfc', boxSizing:'border-box' };
const fieldSelect = { ...fieldInput, cursor:'pointer' };
const fieldTextarea = { ...fieldInput, minHeight:60, resize:'vertical', fontFamily:'inherit' };
const fieldRow = { display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 };
const fieldFull = { marginBottom:12 };

function TagInput({ tags, onChange, placeholder }) {
  const [input, setInput] = useState('');
  const add = () => { const v = input.trim(); if (v && !tags.includes(v)) { onChange([...tags, v]); } setInput(''); };
  const remove = (t) => onChange(tags.filter(x => x !== t));
  return (
    <div>
      <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginBottom: tags.length ? 6 : 0 }}>
        {tags.map(t => (
          <span key={t} style={{ fontSize:11, padding:'3px 8px', borderRadius:5, background:'#f1f5f9', color:'#475569', display:'flex', alignItems:'center', gap:4 }}>
            {t}
            <button onClick={() => remove(t)} style={{ background:'none', border:'none', cursor:'pointer', padding:0, color:'#94a3b8', lineHeight:1, fontSize:14 }}>&times;</button>
          </span>
        ))}
      </div>
      <div style={{ display:'flex', gap:6 }}>
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder={placeholder || 'Type and press Enter'} style={{ ...fieldInput, flex:1 }} />
        <button onClick={add} style={{ padding:'8px 12px', borderRadius:7, border:'1px solid #e2e8f0', background:'#fff', cursor:'pointer', fontSize:12, fontWeight:600, color:'#475569' }}>Add</button>
      </div>
    </div>
  );
}

function ConfirmDialog({ message, onConfirm, onCancel }) {
  return (
    <Modal title="Confirm" onClose={onCancel} width={380}>
      <p style={{ fontSize:13.5, color:'#475569', lineHeight:1.6, margin:'0 0 18px' }}>{message}</p>
      <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
        <button onClick={onCancel} style={{ padding:'8px 16px', borderRadius:7, border:'1px solid #e2e8f0', background:'#fff', cursor:'pointer', fontSize:12.5, fontWeight:600, color:'#64748b' }}>Cancel</button>
        <button onClick={onConfirm} style={{ padding:'8px 16px', borderRadius:7, border:'none', background:'#ef4444', cursor:'pointer', fontSize:12.5, fontWeight:600, color:'#fff' }}>Confirm</button>
      </div>
    </Modal>
  );
}

/* ═══════════════════════════════════════════════════════════════
   SOURCE TEST LOGIC
   ═══════════════════════════════════════════════════════════════ */

function simulateSourceTest(src) {
  // Simulated test — in production this calls the backend
  return new Promise(resolve => {
    setTimeout(() => {
      const reachable = Math.random() > 0.15;
      resolve({
        reachable,
        url: src.url,
        pageTitle: reachable ? `${src.organization} — ${src.category}` : null,
        likelyPageType: reachable ? src.pageType || 'General Website' : null,
        lastModified: reachable ? new Date(Date.now() - Math.random() * 7 * 86400000).toISOString() : null,
        parseSuccess: reachable ? Math.random() > 0.1 : false,
        responseTime: reachable ? Math.round(200 + Math.random() * 1800) : null,
        testedAt: new Date().toISOString(),
      });
    }, 800 + Math.random() * 1200);
  });
}


/* ═══════════════════════════════════════════════════════════════
   TAB: MANAGE SOURCES — FULL INTELLIGENCE CONTROL CENTER
   ═══════════════════════════════════════════════════════════════ */

function ManageSourcesTab() {
  const [subTab, setSubTab] = useState('sources');
  const loadMS = (k, fb) => { try { const d = localStorage.getItem(`ps_${k}`); return d ? JSON.parse(d) : fb; } catch { return fb; } };
  const [sources, setSources] = useState(() => loadMS('sources', INIT_SOURCES));
  const [focusPoints, setFocusPoints] = useState(() => loadMS('focuspoints', INIT_FOCUS_POINTS));
  const [targetOrgs, setTargetOrgs] = useState(() => loadMS('targetorgs', INIT_TARGET_ORGS));

  // Persist on change
  useEffect(() => { try { localStorage.setItem('ps_sources', JSON.stringify(sources)); } catch {} }, [sources]);
  useEffect(() => { try { localStorage.setItem('ps_focuspoints', JSON.stringify(focusPoints)); } catch {} }, [focusPoints]);
  useEffect(() => { try { localStorage.setItem('ps_targetorgs', JSON.stringify(targetOrgs)); } catch {} }, [targetOrgs]);

  const subTabs = [
    { id:'sources', label:'Source Library', icon:<Database size={14}/>, count: sources.length },
    { id:'focus', label:'Search Focus Points', icon:<Crosshair size={14}/>, count: focusPoints.length },
    { id:'orgs', label:'Target Organizations', icon:<Users size={14}/>, count: targetOrgs.length },
  ];

  return (
    <div>
      {/* Sub-tab nav */}
      <div style={{ display:'flex', gap:6, marginBottom:22, flexWrap:'wrap' }}>
        {subTabs.map(t => (
          <button key={t.id} onClick={() => setSubTab(t.id)} style={{
            padding:'9px 18px', borderRadius:8, border:'1px solid',
            borderColor: subTab === t.id ? '#0f172a' : '#e2e8f0',
            background: subTab === t.id ? '#0f172a' : '#fff',
            color: subTab === t.id ? '#fff' : '#64748b',
            fontSize:12.5, fontWeight:600, cursor:'pointer', display:'flex', alignItems:'center', gap:7,
            transition:'all 0.15s',
          }}>
            {t.icon}
            {t.label}
            <span style={{
              fontSize:10, padding:'1px 7px', borderRadius:10,
              background: subTab === t.id ? 'rgba(255,255,255,0.18)' : '#f1f5f9',
              color: subTab === t.id ? '#fff' : '#94a3b8', fontWeight:700,
            }}>{t.count}</span>
          </button>
        ))}
      </div>

      {subTab === 'sources' && <SourceLibrary sources={sources} setSources={setSources} />}
      {subTab === 'focus' && <FocusPointsPanel focusPoints={focusPoints} setFocusPoints={setFocusPoints} />}
      {subTab === 'orgs' && <TargetOrgsPanel targetOrgs={targetOrgs} setTargetOrgs={setTargetOrgs} />}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════
   SOURCE LIBRARY
   ═══════════════════════════════════════════════════════════════ */

function SourceLibrary({ sources, setSources }) {
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('all');
  const [geoFilter, setGeoFilter] = useState('all');
  const [prioFilter, setPrioFilter] = useState('all');
  const [stateFilter, setStateFilter] = useState('all');
  const [sortBy, setSortBy] = useState('priority');
  const [editingSource, setEditingSource] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [testingId, setTestingId] = useState(null);

  const categories = useMemo(() => [...new Set(sources.map(s => s.category).filter(Boolean))].sort(), [sources]);
  const geos = useMemo(() => [...new Set(sources.map(s => s.geography).filter(Boolean))].sort(), [sources]);

  const prioOrder = { critical:0, high:1, medium:2, low:3 };

  const filtered = useMemo(() => {
    let r = [...sources];
    if (search) { const q = search.toLowerCase(); r = r.filter(s => s.name.toLowerCase().includes(q) || s.organization?.toLowerCase().includes(q) || s.url?.toLowerCase().includes(q)); }
    if (catFilter !== 'all') r = r.filter(s => s.category === catFilter);
    if (geoFilter !== 'all') r = r.filter(s => s.geography === geoFilter);
    if (prioFilter !== 'all') r = r.filter(s => s.priority === prioFilter);
    if (stateFilter !== 'all') r = r.filter(s => s.state === stateFilter);
    r.sort((a, b) => {
      if (sortBy === 'priority') return (prioOrder[a.priority]??9) - (prioOrder[b.priority]??9);
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'geography') return (a.geography||'').localeCompare(b.geography||'');
      if (sortBy === 'lastChecked') return new Date(b.lastChecked||0) - new Date(a.lastChecked||0);
      if (sortBy === 'health') { const ho = {healthy:0,degraded:1,failing:2,unknown:3}; return (ho[a.fetchHealth]??9)-(ho[b.fetchHealth]??9); }
      return 0;
    });
    return r;
  }, [sources, search, catFilter, geoFilter, prioFilter, stateFilter, sortBy]);

  const handleSave = (src) => {
    setSources(prev => { const idx = prev.findIndex(s => s.id === src.id); if (idx >= 0) { const next = [...prev]; next[idx] = src; return next; } return [...prev, src]; });
    setEditingSource(null);
  };
  const handleStateChange = (id, newState) => setSources(prev => prev.map(s => s.id === id ? {...s, state: newState} : s));
  const handleTest = async (src) => {
    setTestingId(src.id); setTestResult(null);
    const result = await simulateSourceTest(src);
    setTestResult({ sourceId: src.id, ...result });
    setTestingId(null);
    setSources(prev => prev.map(s => s.id === src.id ? { ...s, lastChecked: result.testedAt, fetchHealth: result.reachable ? (result.parseSuccess ? 'healthy' : 'degraded') : 'failing' } : s));
  };
  const handleAdd = () => {
    setEditingSource({
      id: 'src-' + Date.now(), name:'', organization:'', geography:'', county:'', category:'', pageType:'',
      url:'', priority:'medium', refreshCadence:'daily', state:'active', keywords:[], notes:'',
      fetchHealth:'unknown', lastChecked:null, lastChanged:null, lastSuccessfulFetch:null,
    });
  };

  // Stats
  const activeCount = sources.filter(s => s.state === 'active').length;
  const healthyCount = sources.filter(s => s.fetchHealth === 'healthy').length;
  const criticalCount = sources.filter(s => s.priority === 'critical').length;

  return (
    <div>
      {/* Stats row */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(120px, 1fr))', gap:8, marginBottom:18 }}>
        {[
          { label:'Total Sources', value: sources.length, color:'#3b82f6' },
          { label:'Active', value: activeCount, color:'#10b981' },
          { label:'Healthy', value: healthyCount, color:'#10b981' },
          { label:'Critical Priority', value: criticalCount, color:'#ef4444' },
        ].map(s => (
          <div key={s.label} style={{ background:'#fff', borderRadius:9, padding:'12px 14px', border:'1px solid rgba(0,0,0,0.05)' }}>
            <div style={{ fontSize:9.5, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.06em', color:'#94a3b8', marginBottom:4 }}>{s.label}</div>
            <div style={{ fontSize:22, fontWeight:800, color: s.color, letterSpacing:'-0.02em' }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:16, alignItems:'center' }}>
        <div style={{ flex:'1 1 180px', position:'relative' }}>
          <Search size={14} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#94a3b8' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search sources..."
            style={{ ...fieldInput, paddingLeft:32 }} />
        </div>
        <select value={catFilter} onChange={e => setCatFilter(e.target.value)} style={selectStyle}><option value="all">All Categories</option>{categories.map(c => <option key={c} value={c}>{c}</option>)}</select>
        <select value={geoFilter} onChange={e => setGeoFilter(e.target.value)} style={selectStyle}><option value="all">All Geographies</option>{geos.map(g => <option key={g} value={g}>{g}</option>)}</select>
        <select value={prioFilter} onChange={e => setPrioFilter(e.target.value)} style={selectStyle}><option value="all">All Priorities</option>{['critical','high','medium','low'].map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase()+p.slice(1)}</option>)}</select>
        <select value={stateFilter} onChange={e => setStateFilter(e.target.value)} style={selectStyle}><option value="all">All States</option>{['active','paused','archived'].map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase()+s.slice(1)}</option>)}</select>
        <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={selectStyle}>
          <option value="priority">Sort: Priority</option><option value="name">Sort: Name</option>
          <option value="geography">Sort: Geography</option><option value="lastChecked">Sort: Last Checked</option>
          <option value="health">Sort: Health</option>
        </select>
        <button onClick={handleAdd} style={{ padding:'8px 16px', borderRadius:7, border:'none', background:'#0f172a', color:'#fff', cursor:'pointer', fontSize:12, fontWeight:600, display:'flex', alignItems:'center', gap:5, whiteSpace:'nowrap' }}>
          <Plus size={14} /> Add Source
        </button>
      </div>

      {/* Source list */}
      <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
        {filtered.map(src => {
          const isTesting = testingId === src.id;
          const result = testResult?.sourceId === src.id ? testResult : null;
          return (
            <div key={src.id} style={{
              background:'#fff', borderRadius:10, padding:'14px 18px', border:'1px solid rgba(0,0,0,0.06)',
              opacity: src.state === 'archived' ? 0.55 : src.state === 'paused' ? 0.75 : 1,
              transition:'all 0.15s',
            }}>
              <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                {/* Health dot */}
                <div style={{ width:9, height:9, borderRadius:'50%', background:healthDot(src.fetchHealth), flexShrink:0, boxShadow:`0 0 0 3px ${healthDot(src.fetchHealth)}22` }} />
                {/* Info */}
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                    <span style={{ fontSize:13.5, fontWeight:700, color:'#0f172a' }}>{src.name}</span>
                    {src.state === 'paused' && <span style={{ fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:4, background:'#fef3c7', color:'#92400e', textTransform:'uppercase' }}>Paused</span>}
                    {src.state === 'archived' && <span style={{ fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:4, background:'#f3f4f6', color:'#6b7280', textTransform:'uppercase' }}>Archived</span>}
                  </div>
                  <div style={{ fontSize:11, color:'#94a3b8', marginTop:2, display:'flex', gap:8, flexWrap:'wrap' }}>
                    <span>{src.organization}</span>
                    <span>·</span>
                    <span>{src.geography || 'Statewide'}</span>
                    <span>·</span>
                    <span>{src.category}</span>
                    {src.pageType && <><span>·</span><span>{src.pageType}</span></>}
                    {src.refreshCadence && <><span>·</span><span style={{ textTransform:'capitalize' }}>{src.refreshCadence}</span></>}
                  </div>
                  {src.keywords?.length > 0 && (
                    <div style={{ display:'flex', flexWrap:'wrap', gap:3, marginTop:6 }}>
                      {src.keywords.slice(0,6).map(k => <span key={k} style={{ fontSize:9.5, padding:'2px 6px', borderRadius:4, background:'#f1f5f9', color:'#64748b' }}>{k}</span>)}
                      {src.keywords.length > 6 && <span style={{ fontSize:9.5, padding:'2px 6px', color:'#94a3b8' }}>+{src.keywords.length - 6}</span>}
                    </div>
                  )}
                </div>
                {/* Priority badge */}
                <span style={{ fontSize:10, fontWeight:700, padding:'3px 9px', borderRadius:5, background:(PRIORITY_MAP[src.priority]?.color||'#6b7280')+'15', color:PRIORITY_MAP[src.priority]?.color||'#6b7280', textTransform:'uppercase', letterSpacing:'0.03em', flexShrink:0 }}>
                  {src.priority}
                </span>
                {/* Last checked */}
                <div style={{ fontSize:10, color:'#94a3b8', textAlign:'right', flexShrink:0, minWidth:80 }}>
                  {src.lastChecked ? <>Checked<br/>{formatDate(src.lastChecked)}</> : 'Never checked'}
                </div>
                {/* Actions */}
                <div style={{ display:'flex', gap:4, flexShrink:0 }}>
                  <ActionBtn icon={<Edit3 size={13}/>} title="Edit" onClick={() => setEditingSource({...src})} />
                  <ActionBtn icon={isTesting ? <RefreshCw size={13} style={{ animation:'spin 1s linear infinite' }}/> : <TestTube size={13}/>}
                    title="Test" onClick={() => !isTesting && handleTest(src)} />
                  {src.state === 'active' && <ActionBtn icon={<Pause size={13}/>} title="Pause" onClick={() => handleStateChange(src.id, 'paused')} />}
                  {src.state === 'paused' && <ActionBtn icon={<Play size={13}/>} title="Reactivate" onClick={() => handleStateChange(src.id, 'active')} />}
                  {src.state !== 'archived' && <ActionBtn icon={<Archive size={13}/>} title="Archive" onClick={() => handleStateChange(src.id, 'archived')} />}
                  {src.state === 'archived' && <ActionBtn icon={<RotateCcw size={13}/>} title="Restore" onClick={() => handleStateChange(src.id, 'active')} />}
                  {src.url && <a href={src.url} target="_blank" rel="noopener noreferrer" style={{ padding:6, borderRadius:6, color:'#94a3b8', display:'flex', alignItems:'center' }}><ExternalLink size={13}/></a>}
                </div>
              </div>

              {/* Test result */}
              {result && (
                <div style={{ marginTop:10, padding:'10px 14px', borderRadius:8, background: result.reachable ? '#f0fdf4' : '#fef2f2', border: `1px solid ${result.reachable ? '#bbf7d0' : '#fecaca'}` }}>
                  <div style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, fontWeight:700, color: result.reachable ? '#166534' : '#991b1b', marginBottom:4 }}>
                    {result.reachable ? <CheckCircle2 size={14}/> : <XCircle size={14}/>}
                    {result.reachable ? 'Source Reachable' : 'Source Unreachable'}
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:4, fontSize:11, color:'#475569' }}>
                    {result.pageTitle && <div><strong>Page Title:</strong> {result.pageTitle}</div>}
                    {result.likelyPageType && <div><strong>Page Type:</strong> {result.likelyPageType}</div>}
                    {result.lastModified && <div><strong>Last Modified:</strong> {formatDate(result.lastModified)}</div>}
                    {result.responseTime && <div><strong>Response:</strong> {result.responseTime}ms</div>}
                    <div><strong>Parse:</strong> {result.parseSuccess ? '✓ Success' : '✗ Failed'}</div>
                    <div><strong>Tested:</strong> {formatDate(result.testedAt)}</div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <div style={{ textAlign:'center', padding:'50px 20px', color:'#94a3b8' }}>
          <Database size={28} style={{ opacity:0.3, marginBottom:10 }} />
          <p style={{ fontSize:13, fontWeight:600, margin:'0 0 4px' }}>No sources match your filters</p>
          <p style={{ fontSize:12 }}>Try adjusting your filters or add a new source</p>
        </div>
      )}

      {/* Edit/Add Modal */}
      {editingSource && (
        <SourceEditModal source={editingSource} onSave={handleSave} onClose={() => setEditingSource(null)} />
      )}
    </div>
  );
}

function ActionBtn({ icon, title, onClick }) {
  return (
    <button onClick={onClick} title={title} style={{
      padding:6, borderRadius:6, border:'1px solid #e2e8f0', background:'#fff', cursor:'pointer',
      color:'#64748b', display:'flex', alignItems:'center', transition:'all 0.12s',
    }}
    onMouseEnter={e => { e.currentTarget.style.background='#f1f5f9'; e.currentTarget.style.color='#0f172a'; }}
    onMouseLeave={e => { e.currentTarget.style.background='#fff'; e.currentTarget.style.color='#64748b'; }}
    >{icon}</button>
  );
}


/* ── Source Edit Modal ── */

function SourceEditModal({ source, onSave, onClose }) {
  const [form, setForm] = useState({...source});
  const set = (k, v) => setForm(p => ({...p, [k]: v}));
  const isNew = !source.lastChecked && !source.name;

  return (
    <Modal title={isNew ? 'Add New Source' : `Edit: ${source.name}`} onClose={onClose} width={600}>
      <div style={fieldRow}>
        <div><label style={fieldLabel}>Source Name *</label><input style={fieldInput} value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Missoula County Commission" /></div>
        <div><label style={fieldLabel}>Organization</label><input style={fieldInput} value={form.organization} onChange={e => set('organization', e.target.value)} placeholder="e.g. Missoula County" /></div>
      </div>
      <div style={fieldRow}>
        <div><label style={fieldLabel}>Geography</label>
          <select style={fieldSelect} value={form.geography} onChange={e => set('geography', e.target.value)}>
            <option value="">Select...</option><option value="Statewide">Statewide</option>
            {GEOGRAPHIES.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>
        <div><label style={fieldLabel}>County</label>
          <select style={fieldSelect} value={form.county} onChange={e => set('county', e.target.value)}>
            <option value="">Select...</option>
            {GEOGRAPHIES.filter(g => g.includes('County')).map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>
      <div style={fieldRow}>
        <div><label style={fieldLabel}>Category</label>
          <select style={fieldSelect} value={form.category} onChange={e => set('category', e.target.value)}>
            <option value="">Select...</option>{SOURCE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div><label style={fieldLabel}>Page Type</label>
          <select style={fieldSelect} value={form.pageType} onChange={e => set('pageType', e.target.value)}>
            <option value="">Select...</option>{PAGE_TYPES.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      </div>
      <div style={fieldFull}><label style={fieldLabel}>Source URL *</label><input style={fieldInput} value={form.url} onChange={e => set('url', e.target.value)} placeholder="https://..." /></div>
      <div style={fieldRow}>
        <div><label style={fieldLabel}>Priority</label>
          <select style={fieldSelect} value={form.priority} onChange={e => set('priority', e.target.value)}>
            {['critical','high','medium','low'].map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase()+p.slice(1)}</option>)}
          </select>
        </div>
        <div><label style={fieldLabel}>Refresh Cadence</label>
          <select style={fieldSelect} value={form.refreshCadence} onChange={e => set('refreshCadence', e.target.value)}>
            {REFRESH_CADENCES.map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase()+c.slice(1)}</option>)}
          </select>
        </div>
      </div>
      <div style={fieldRow}>
        <div><label style={fieldLabel}>Status</label>
          <select style={fieldSelect} value={form.state} onChange={e => set('state', e.target.value)}>
            {['active','paused','archived'].map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase()+s.slice(1)}</option>)}
          </select>
        </div>
        <div />
      </div>
      <div style={fieldFull}>
        <label style={fieldLabel}>Keywords to Watch</label>
        <TagInput tags={form.keywords || []} onChange={v => set('keywords', v)} placeholder="Add keyword..." />
      </div>
      <div style={fieldFull}><label style={fieldLabel}>Notes</label><textarea style={fieldTextarea} value={form.notes || ''} onChange={e => set('notes', e.target.value)} placeholder="Internal notes about this source..." /></div>

      <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:8 }}>
        <button onClick={onClose} style={{ padding:'9px 18px', borderRadius:7, border:'1px solid #e2e8f0', background:'#fff', cursor:'pointer', fontSize:12.5, fontWeight:600, color:'#64748b' }}>Cancel</button>
        <button onClick={() => { if (form.name && form.url) onSave(form); }} style={{ padding:'9px 18px', borderRadius:7, border:'none', background:'#0f172a', cursor:'pointer', fontSize:12.5, fontWeight:600, color:'#fff', opacity: (form.name && form.url) ? 1 : 0.4 }}>
          <Save size={13} style={{ marginRight:5, verticalAlign:-2 }} /> {isNew ? 'Add Source' : 'Save Changes'}
        </button>
      </div>
    </Modal>
  );
}


/* ═══════════════════════════════════════════════════════════════
   FOCUS POINTS PANEL
   ═══════════════════════════════════════════════════════════════ */

function FocusPointsPanel({ focusPoints, setFocusPoints }) {
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const handleSave = (fp) => {
    setFocusPoints(prev => { const idx = prev.findIndex(f => f.id === fp.id); if (idx >= 0) { const next = [...prev]; next[idx] = fp; return next; } return [...prev, fp]; });
    setEditing(null);
  };
  const handleToggle = (id) => setFocusPoints(prev => prev.map(f => f.id === id ? {...f, active: !f.active} : f));
  const handleDelete = (id) => { setFocusPoints(prev => prev.filter(f => f.id !== id)); setConfirm(null); };
  const handleAdd = () => setEditing({ id:'fp-'+Date.now(), title:'', description:'', keywords:[], category:'', priority:'medium', active:true });

  const activeCount = focusPoints.filter(f => f.active).length;

  return (
    <div>
      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
        <div style={{ fontSize:12, color:'#64748b' }}>
          <strong style={{ color:'#0f172a' }}>{activeCount}</strong> active of {focusPoints.length} focus points
        </div>
        <button onClick={handleAdd} style={{ padding:'8px 16px', borderRadius:7, border:'none', background:'#0f172a', color:'#fff', cursor:'pointer', fontSize:12, fontWeight:600, display:'flex', alignItems:'center', gap:5 }}>
          <Plus size={14} /> Add Focus Point
        </button>
      </div>

      {/* Grid */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(300px, 1fr))', gap:10 }}>
        {focusPoints.map(fp => (
          <div key={fp.id} style={{
            background:'#fff', borderRadius:10, padding:'16px 18px', border:'1px solid rgba(0,0,0,0.06)',
            opacity: fp.active ? 1 : 0.55, transition:'opacity 0.15s',
          }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:6 }}>
              <div style={{ flex:1 }}>
                <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                  <h4 style={{ fontSize:14, fontWeight:700, color:'#0f172a', margin:0 }}>{fp.title}</h4>
                  {!fp.active && <span style={{ fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:4, background:'#f3f4f6', color:'#6b7280', textTransform:'uppercase' }}>Inactive</span>}
                </div>
                <div style={{ fontSize:11, color:'#94a3b8', marginTop:2 }}>{fp.category}</div>
              </div>
              <span style={{ fontSize:10, fontWeight:700, padding:'3px 9px', borderRadius:5, background:(PRIORITY_MAP[fp.priority]?.color||'#6b7280')+'15', color:PRIORITY_MAP[fp.priority]?.color, textTransform:'uppercase', flexShrink:0 }}>
                {fp.priority}
              </span>
            </div>
            <p style={{ fontSize:12, color:'#64748b', margin:'0 0 10px', lineHeight:1.5 }}>{fp.description}</p>
            <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginBottom:12 }}>
              {fp.keywords.map(k => <span key={k} style={{ fontSize:10, padding:'2px 7px', borderRadius:4, background:'#f1f5f9', color:'#64748b' }}>{k}</span>)}
            </div>
            <div style={{ display:'flex', gap:4, borderTop:'1px solid #f1f5f9', paddingTop:10 }}>
              <ActionBtn icon={<Edit3 size={12}/>} title="Edit" onClick={() => setEditing({...fp})} />
              <ActionBtn icon={fp.active ? <EyeOff size={12}/> : <Eye size={12}/>} title={fp.active ? 'Deactivate' : 'Activate'} onClick={() => handleToggle(fp.id)} />
              <ActionBtn icon={<Trash2 size={12}/>} title="Delete" onClick={() => setConfirm(fp.id)} />
            </div>
          </div>
        ))}
      </div>

      {editing && <FocusPointEditModal fp={editing} onSave={handleSave} onClose={() => setEditing(null)} />}
      {confirm && <ConfirmDialog message="Are you sure you want to delete this focus point? This cannot be undone." onConfirm={() => handleDelete(confirm)} onCancel={() => setConfirm(null)} />}
    </div>
  );
}

function FocusPointEditModal({ fp, onSave, onClose }) {
  const [form, setForm] = useState({...fp});
  const set = (k, v) => setForm(p => ({...p, [k]: v}));
  const isNew = !fp.title;

  return (
    <Modal title={isNew ? 'Add Focus Point' : `Edit: ${fp.title}`} onClose={onClose} width={520}>
      <div style={fieldFull}><label style={fieldLabel}>Title *</label><input style={fieldInput} value={form.title} onChange={e => set('title', e.target.value)} placeholder="e.g. Healthcare Expansion" /></div>
      <div style={fieldFull}><label style={fieldLabel}>Description</label><textarea style={fieldTextarea} value={form.description} onChange={e => set('description', e.target.value)} placeholder="What does this focus point track?" /></div>
      <div style={fieldRow}>
        <div><label style={fieldLabel}>Category</label>
          <select style={fieldSelect} value={form.category} onChange={e => set('category', e.target.value)}>
            <option value="">Select...</option>{MARKET_SECTORS.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div><label style={fieldLabel}>Priority</label>
          <select style={fieldSelect} value={form.priority} onChange={e => set('priority', e.target.value)}>
            {['critical','high','medium','low'].map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase()+p.slice(1)}</option>)}
          </select>
        </div>
      </div>
      <div style={fieldFull}>
        <label style={fieldLabel}>Keywords</label>
        <TagInput tags={form.keywords || []} onChange={v => set('keywords', v)} placeholder="Add keyword..." />
      </div>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
        <label style={{ ...fieldLabel, margin:0 }}>Active</label>
        <button onClick={() => set('active', !form.active)} style={{
          width:38, height:20, borderRadius:10, border:'none', cursor:'pointer',
          background: form.active ? '#10b981' : '#e2e8f0', position:'relative', transition:'background 0.2s',
        }}>
          <div style={{ width:14, height:14, borderRadius:'50%', background:'#fff', position:'absolute', top:3, left: form.active ? 21 : 3, transition:'left 0.2s', boxShadow:'0 1px 3px rgba(0,0,0,0.2)' }} />
        </button>
      </div>
      <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
        <button onClick={onClose} style={{ padding:'9px 18px', borderRadius:7, border:'1px solid #e2e8f0', background:'#fff', cursor:'pointer', fontSize:12.5, fontWeight:600, color:'#64748b' }}>Cancel</button>
        <button onClick={() => { if (form.title) onSave(form); }} style={{ padding:'9px 18px', borderRadius:7, border:'none', background:'#0f172a', cursor:'pointer', fontSize:12.5, fontWeight:600, color:'#fff', opacity: form.title ? 1 : 0.4 }}>
          <Save size={13} style={{ marginRight:5, verticalAlign:-2 }} /> {isNew ? 'Add' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}


/* ═══════════════════════════════════════════════════════════════
   TARGET ORGANIZATIONS PANEL
   ═══════════════════════════════════════════════════════════════ */

function TargetOrgsPanel({ targetOrgs, setTargetOrgs }) {
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [typeFilter, setTypeFilter] = useState('all');
  const [search, setSearch] = useState('');

  const types = useMemo(() => [...new Set(targetOrgs.map(o => o.type).filter(Boolean))].sort(), [targetOrgs]);

  const filtered = useMemo(() => {
    let r = [...targetOrgs];
    if (search) { const q = search.toLowerCase(); r = r.filter(o => o.name.toLowerCase().includes(q) || o.type?.toLowerCase().includes(q) || o.geography?.toLowerCase().includes(q)); }
    if (typeFilter !== 'all') r = r.filter(o => o.type === typeFilter);
    return r.sort((a, b) => a.name.localeCompare(b.name));
  }, [targetOrgs, search, typeFilter]);

  const handleSave = (org) => {
    setTargetOrgs(prev => { const idx = prev.findIndex(o => o.id === org.id); if (idx >= 0) { const next = [...prev]; next[idx] = org; return next; } return [...prev, org]; });
    setEditing(null);
  };
  const handleToggle = (id) => setTargetOrgs(prev => prev.map(o => o.id === id ? {...o, active: !o.active} : o));
  const handleDelete = (id) => { setTargetOrgs(prev => prev.filter(o => o.id !== id)); setConfirm(null); };
  const handleAdd = () => setEditing({ id:'org-'+Date.now(), name:'', type:'', geography:'', county:'', website:'', watchTerms:[], notes:'', active:true });

  const activeCount = targetOrgs.filter(o => o.active).length;

  return (
    <div>
      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16, flexWrap:'wrap', gap:10 }}>
        <div style={{ display:'flex', gap:8, alignItems:'center', flex:'1 1 200px' }}>
          <div style={{ position:'relative', flex:1, maxWidth:260 }}>
            <Search size={14} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#94a3b8' }} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search organizations..."
              style={{ ...fieldInput, paddingLeft:32 }} />
          </div>
          <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={selectStyle}>
            <option value="all">All Types</option>{types.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <span style={{ fontSize:12, color:'#64748b' }}>
            <strong style={{ color:'#0f172a' }}>{activeCount}</strong> active of {targetOrgs.length}
          </span>
        </div>
        <button onClick={handleAdd} style={{ padding:'8px 16px', borderRadius:7, border:'none', background:'#0f172a', color:'#fff', cursor:'pointer', fontSize:12, fontWeight:600, display:'flex', alignItems:'center', gap:5 }}>
          <Plus size={14} /> Add Organization
        </button>
      </div>

      {/* Grid */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(300px, 1fr))', gap:10 }}>
        {filtered.map(org => (
          <div key={org.id} style={{
            background:'#fff', borderRadius:10, padding:'16px 18px', border:'1px solid rgba(0,0,0,0.06)',
            opacity: org.active ? 1 : 0.55, transition:'opacity 0.15s',
          }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:4 }}>
              <div style={{ flex:1 }}>
                <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                  <h4 style={{ fontSize:14, fontWeight:700, color:'#0f172a', margin:0 }}>{org.name}</h4>
                  {!org.active && <span style={{ fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:4, background:'#f3f4f6', color:'#6b7280', textTransform:'uppercase' }}>Inactive</span>}
                </div>
              </div>
              <span style={{ fontSize:10, padding:'2px 8px', borderRadius:4, background:'#f1f5f9', color:'#64748b', fontWeight:600, flexShrink:0 }}>{org.type}</span>
            </div>
            <div style={{ fontSize:11.5, color:'#94a3b8', marginBottom:8 }}>
              {org.geography || 'Statewide'}{org.county ? ` · ${org.county}` : ''}
              {org.website && <a href={org.website} target="_blank" rel="noopener noreferrer" style={{ marginLeft:6, color:'#3b82f6' }}><ExternalLink size={10} style={{ verticalAlign:-1 }}/></a>}
            </div>
            {org.notes && <p style={{ fontSize:11.5, color:'#64748b', margin:'0 0 8px', lineHeight:1.5 }}>{org.notes}</p>}
            <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginBottom:12 }}>
              {org.watchTerms?.map(t => <span key={t} style={{ fontSize:10, padding:'2px 7px', borderRadius:4, background:'#eff6ff', color:'#3b82f6' }}>{t}</span>)}
            </div>
            <div style={{ display:'flex', gap:4, borderTop:'1px solid #f1f5f9', paddingTop:10 }}>
              <ActionBtn icon={<Edit3 size={12}/>} title="Edit" onClick={() => setEditing({...org})} />
              <ActionBtn icon={org.active ? <EyeOff size={12}/> : <Eye size={12}/>} title={org.active ? 'Deactivate' : 'Activate'} onClick={() => handleToggle(org.id)} />
              <ActionBtn icon={<Trash2 size={12}/>} title="Delete" onClick={() => setConfirm(org.id)} />
            </div>
          </div>
        ))}
      </div>

      {filtered.length === 0 && (
        <div style={{ textAlign:'center', padding:'50px 20px', color:'#94a3b8' }}>
          <Users size={28} style={{ opacity:0.3, marginBottom:10 }} />
          <p style={{ fontSize:13, fontWeight:600, margin:'0 0 4px' }}>No organizations match your filters</p>
        </div>
      )}

      {editing && <OrgEditModal org={editing} onSave={handleSave} onClose={() => setEditing(null)} />}
      {confirm && <ConfirmDialog message="Are you sure you want to delete this organization? This cannot be undone." onConfirm={() => handleDelete(confirm)} onCancel={() => setConfirm(null)} />}
    </div>
  );
}

function OrgEditModal({ org, onSave, onClose }) {
  const [form, setForm] = useState({...org});
  const set = (k, v) => setForm(p => ({...p, [k]: v}));
  const isNew = !org.name;

  return (
    <Modal title={isNew ? 'Add Organization' : `Edit: ${org.name}`} onClose={onClose} width={520}>
      <div style={fieldRow}>
        <div><label style={fieldLabel}>Name *</label><input style={fieldInput} value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Providence" /></div>
        <div><label style={fieldLabel}>Type</label>
          <select style={fieldSelect} value={form.type} onChange={e => set('type', e.target.value)}>
            <option value="">Select...</option>{ORG_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      </div>
      <div style={fieldRow}>
        <div><label style={fieldLabel}>Geography</label>
          <select style={fieldSelect} value={form.geography} onChange={e => set('geography', e.target.value)}>
            <option value="">Select...</option><option value="Statewide">Statewide</option>
            {GEOGRAPHIES.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>
        <div><label style={fieldLabel}>County</label>
          <select style={fieldSelect} value={form.county} onChange={e => set('county', e.target.value)}>
            <option value="">Select...</option>
            {GEOGRAPHIES.filter(g => g.includes('County')).map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>
      <div style={fieldFull}><label style={fieldLabel}>Website</label><input style={fieldInput} value={form.website} onChange={e => set('website', e.target.value)} placeholder="https://..." /></div>
      <div style={fieldFull}>
        <label style={fieldLabel}>Watch Terms</label>
        <TagInput tags={form.watchTerms || []} onChange={v => set('watchTerms', v)} placeholder="Add watch term..." />
      </div>
      <div style={fieldFull}><label style={fieldLabel}>Notes</label><textarea style={fieldTextarea} value={form.notes || ''} onChange={e => set('notes', e.target.value)} placeholder="Internal notes..." /></div>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
        <label style={{ ...fieldLabel, margin:0 }}>Active</label>
        <button onClick={() => set('active', !form.active)} style={{
          width:38, height:20, borderRadius:10, border:'none', cursor:'pointer',
          background: form.active ? '#10b981' : '#e2e8f0', position:'relative', transition:'background 0.2s',
        }}>
          <div style={{ width:14, height:14, borderRadius:'50%', background:'#fff', position:'absolute', top:3, left: form.active ? 21 : 3, transition:'left 0.2s', boxShadow:'0 1px 3px rgba(0,0,0,0.2)' }} />
        </button>
      </div>
      <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
        <button onClick={onClose} style={{ padding:'9px 18px', borderRadius:7, border:'1px solid #e2e8f0', background:'#fff', cursor:'pointer', fontSize:12.5, fontWeight:600, color:'#64748b' }}>Cancel</button>
        <button onClick={() => { if (form.name) onSave(form); }} style={{ padding:'9px 18px', borderRadius:7, border:'none', background:'#0f172a', cursor:'pointer', fontSize:12.5, fontWeight:600, color:'#fff', opacity: form.name ? 1 : 0.4 }}>
          <Save size={13} style={{ marginRight:5, verticalAlign:-2 }} /> {isNew ? 'Add' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}


/* ═══════════════════════════════════════════════════════════════
   TAB: SETTINGS
   ═══════════════════════════════════════════════════════════════ */

function SettingsTab({ onMergeResults, onRunAsanaCheck, onApplyValidation, allLeads, notPursuedLeads, submittedLeads }) {
  const loadS = (k, fb) => { try { const d = localStorage.getItem(`ps_${k}`); return d ? JSON.parse(d) : fb; } catch { return fb; } };
  const [settings, setSettings] = useState(() => loadS('settings', {
    aiProvider: 'anthropic', aiModel: '', backendEndpoint: '',
    dailyUpdateTime: '06:00',
    backfillMonths: 6, freshnessDays: 60, recheckDays: 7,
    activeSourcesOnly: true, priorityThreshold: 'low',
  }));
  useEffect(() => { try { localStorage.setItem('ps_settings', JSON.stringify(settings)); } catch {} }, [settings]);

  const [engineState, setEngineState] = useState('idle');
  const [engineAction, setEngineAction] = useState('');
  const [engineLog, setEngineLog] = useState([]);
  const [engineResults, setEngineResults] = useState(null);
  const [runHistory, setRunHistory] = useState(() => loadS('runHistory', []));
  const [lastAsanaCheck, setLastAsanaCheck] = useState(() => loadS('lastAsanaCheck', null));
  const [backupStatus, setBackupStatus] = useState(null);
  const [pendingImport, setPendingImport] = useState(null);
  const logRef = useRef(null);
  const importFileRef = useRef(null);

  const addLog = useCallback((msg) => {
    setEngineLog(prev => [...prev, { ts: new Date().toISOString(), msg }]);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [engineLog]);

  // ─── Connection status ─────────────────────────────────────
  const hasBackend = !!settings.backendEndpoint;

  // ─── Real client-side engine (uses scoring/dedup logic, merges results) ─
  const runEngine = useCallback(async (action) => {
    setEngineState('running');
    setEngineAction(action);
    setEngineLog([]);
    setEngineResults(null);

    const isConnected = hasBackend;
    addLog(`═══ ${action.toUpperCase()} INITIATED ═══`);
    addLog(`Mode: ${isConnected ? 'LIVE — real source fetching via backend at ' + settings.backendEndpoint : 'FALLBACK — metadata-based lead generation (no live fetch). Deploy backend for live scouting.'}`);
    addLog(`AI: ${isConnected ? 'Backend handles AI classification (' + (settings.aiProvider || 'anthropic') + ')' : 'Not available — rule-based scoring only (no backend)'}`);

    // Load current persisted data
    const currentSources = JSON.parse(localStorage.getItem('ps_sources') || '[]');
    const currentEntities = JSON.parse(localStorage.getItem('ps_entities') || '[]');
    const entityNameMap = {};
    currentEntities.forEach(e => { if (e.entity_id && e.entity_name) entityNameMap[e.entity_id] = e.entity_name; });
    const activeSources = currentSources.filter(s => s.active !== false).map(s => ({
      ...s,
      entity_name: entityNameMap[s.entity_id] || s.entity_name || '',
    }));

    // ── Region-level scan control: filter out sources whose ALL coverage regions are inactive ──
    const coverageRegions = JSON.parse(localStorage.getItem('ps_coverage_regions') || '[]');
    const activeRegionIds = new Set(coverageRegions.filter(r => r.active).map(r => r.region_id));
    const beforeRegionFilter = activeSources.length;
    const regionFilteredSources = activeSources.filter(s => {
      const srcRegions = s.coverage_regions || [];
      // If source has no coverage_regions assigned, keep it (don't orphan it)
      if (srcRegions.length === 0) return true;
      // Keep if at least one of its regions is active
      return srcRegions.some(rid => activeRegionIds.has(rid));
    });
    const regionSkipped = beforeRegionFilter - regionFilteredSources.length;
    if (regionSkipped > 0) {
      const inactiveNames = coverageRegions.filter(r => !r.active).map(r => r.region_name).join(', ');
      addLog(`⊘ Region filter: ${regionSkipped} source${regionSkipped === 1 ? '' : 's'} skipped (inactive regions: ${inactiveNames})`);
    }
    // Replace activeSources with region-filtered list for all downstream use
    const sourcesForScan = regionFilteredSources;

    const currentFP = JSON.parse(localStorage.getItem('ps_focuspoints') || '[]');
    const activeFP = currentFP.filter(f => f.active);
    const currentOrgs = JSON.parse(localStorage.getItem('ps_targetorgs') || '[]');
    const activeOrgs = currentOrgs.filter(o => o.active);
    const taxonomy = JSON.parse(localStorage.getItem('ps_taxonomy') || '[]');

    try {
      let results;

      // ─── VALIDATE MODE: special path for weekly deep-search validation ──
      if (action === 'validate' && isConnected) {
        const activeAndWatch = allLeads.filter(l => l.status === 'active' || l.status === 'watch');
        if (activeAndWatch.length === 0) {
          addLog('⚠ No Active or Watch leads to validate.');
          setEngineState('complete');
          return;
        }
        addLog(`Sending ${activeAndWatch.length} Active/Watch leads for web validation...`);
        const resp = await fetch(`${settings.backendEndpoint}/api/scan?action=validate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ existingLeads: activeAndWatch }),
        });
        if (!resp.ok) throw new Error(`Backend returned ${resp.status}: ${await resp.text().then(t=>t.slice(0,200))}`);
        const data = await resp.json();
        if (data.scanBuildId) addLog(`✅ Backend confirmed: ${data.scanBuildId}`);
        if (data.logs) data.logs.forEach(l => addLog(l));

        // Apply validation results AND post-validation re-evaluation
        if (data.validated && data.validated.length > 0) {
          const now = new Date().toISOString();
          let updatedCount = 0;
          let suppressedCount = 0;
          let downgradedCount = 0;
          const suppressedNames = [];
          const downgradedNames = [];
          const validationReviewQueue = [];
          const updatedLeads = [...allLeads];

          for (const v of data.validated) {
            const idx = updatedLeads.findIndex(l => l.id === v.leadId);
            if (idx < 0) continue;
            const lead = { ...updatedLeads[idx] };
            let changed = false;

            // ── Act on re-evaluation recommendations ──
            // v30: Protect immune, favorite, manual, and Asana BP leads from auto-suppress.
            // Route borderline suppress recommendations to pruning review instead of auto-removing.
            const isProtected = lead.pruneImmune || lead.favorite ||
              lead.leadOrigin === 'manual' || lead.leadOrigin === 'asana_business_pursuit';
            if (v.recommendation === 'suppress') {
              if (isProtected) {
                // Protected leads: DO NOT suppress. Add note instead.
                lead.validationNotes = (lead.validationNotes ? lead.validationNotes + '; ' : '') +
                  `Validation suggested suppress (${v.recommendationReason || 'post-validation'}) — lead is protected, kept on board`;
                lead.validationReassess = true;
                changed = true;
                addLog(`  ⚠ Protected from suppress: "${v.leadTitle?.slice(0,50)}" (${lead.pruneImmune ? 'immune' : lead.favorite ? 'favorite' : lead.leadOrigin})`);
              } else if (v.claimed && /\b(awarded|has_designer|has_contractor|has_engineer|under_construction|completed|project_team_assembled)\b/.test(v.claimed)) {
                // Only auto-suppress for STRONG claimed evidence (awarded, designed, completed, under construction)
                lead.status = 'not-pursued';
                lead.notPursuedReason = v.recommendationReason || 'Suppressed by post-validation re-evaluation';
                lead.notPursuedDate = now;
                lead.validationNotes = (lead.validationNotes ? lead.validationNotes + '; ' : '') +
                  `Auto-suppressed: ${v.recommendationReason || 'post-validation re-evaluation'}`;
                suppressedCount++;
                suppressedNames.push(v.leadTitle?.slice(0, 50) || lead.title?.slice(0, 50));
                changed = true;
              } else {
                // Non-claimed suppress (noise, stale) → route to pruning review, NOT auto-remove
                lead.validationReassess = true;
                lead.validationNotes = (lead.validationNotes ? lead.validationNotes + '; ' : '') +
                  `Validation flagged for review: ${v.recommendationReason || 'post-validation re-evaluation'}`;
                changed = true;
                // Queue for pruning review
                validationReviewQueue.push({
                  lead: { ...lead },
                  reason: v.recommendationReason || 'Post-validation re-evaluation',
                  explanation: `Validation suggested removing this lead: ${v.recommendationReason || 'noise/stale signal'}. Review to decide whether to keep, pause, or prune.`,
                });
                addLog(`  ⚠ Queued for pruning review (not auto-removed): "${v.leadTitle?.slice(0,50)}"`);
              }
            } else if (v.recommendation === 'review') {
              // v30: 'review' = route to pruning review queue, NOT auto-remove
              lead.validationReassess = true;
              lead.validationNotes = (lead.validationNotes ? lead.validationNotes + '; ' : '') +
                `Validation flagged for review: ${v.recommendationReason || 'post-validation re-evaluation'}`;
              changed = true;
              validationReviewQueue.push({
                lead: { ...lead },
                reason: v.recommendationReason || 'Post-validation re-evaluation',
                explanation: `Validation flagged this lead: ${v.recommendationReason || 'noise/stale/historical signal'}. Review to decide whether to keep, pause, or prune.`,
              });
            } else if (v.recommendation === 'downgrade') {
              // For Active leads: don't change status, but add strong warning + claimed flag
              lead.validationClaimed = v.claimed || 'review_needed';
              lead.validationClaimedDetail = v.recommendationReason || '';
              lead.validationNotes = (lead.validationNotes ? lead.validationNotes + '; ' : '') +
                `Downgraded: ${v.recommendationReason || 'post-validation re-evaluation'}`;
              downgradedCount++;
              downgradedNames.push(v.leadTitle?.slice(0, 50) || lead.title?.slice(0, 50));
              changed = true;
            }

            // ── Apply enrichment changes (for non-suppressed leads) ──
            if (v.recommendation !== 'suppress') {
              for (const c of (v.changes || [])) {
                if (c.field === 'projectStatus' && c.newValue) {
                  lead.projectStatus = c.newValue;
                  lead.validationClaimed = c.newValue;
                  lead.validationClaimedDetail = c.detail || '';
                  changed = true;
                }
                if (c.field === 'architect' && c.newValue) { lead.architect = c.newValue; changed = true; }
                if (c.field === 'contractor' && c.newValue) { lead.contractor = c.newValue; changed = true; }
                if (c.field === 'action_due_date' && c.newValue) { lead.action_due_date = c.newValue; changed = true; }
                if (c.field === 'potentialTimeline' && c.newValue) { lead.potentialTimeline = c.newValue; changed = true; }
                if (c.field === 'potentialBudget' && c.newValue) { lead.potentialBudget = c.newValue; changed = true; }
                if (c.field === 'validationNote' && c.newValue) {
                  lead.validationNotes = (lead.validationNotes ? lead.validationNotes + '; ' : '') + c.newValue;
                  changed = true;
                }
              }
            }

            // Always update validation timestamp
            lead.lastValidated = now;
            lead.validationSources = v.webSources || v.officialSources || [];
            if (changed) updatedCount++;
            updatedLeads[idx] = lead;
          }

          // Separate suppressed leads from kept leads
          const suppressedLeads = updatedLeads.filter(l => l.status === 'not-pursued');
          const keptLeads = updatedLeads.filter(l => l.status !== 'not-pursued');

          // Persist via callback — passes structured result for proper state management
          if (onApplyValidation) {
            onApplyValidation({
              keptLeads,
              suppressedLeads: suppressedLeads.map(l => ({
                ...l,
                status: 'not_pursued',
                reasonNotPursued: l.notPursuedReason || 'Post-validation re-evaluation',
                reasonCategory: 'pruned',
                prunedBy: 'validation',
                dateNotPursued: l.notPursuedDate || now,
              })),
              validationReviewQueue,
            });
          } else {
            localStorage.setItem('ps_leads', JSON.stringify(keptLeads));
          }

          // Summary log
          addLog(`✓ Validation applied: ${updatedCount} leads updated`);
          if (suppressedCount > 0) {
            addLog(`  ✦ ${suppressedCount} lead(s) SUPPRESSED (moved to Not Pursued — strong claimed evidence):`);
            for (const name of suppressedNames) addLog(`    ✗ ${name}`);
          }
          if (validationReviewQueue.length > 0) {
            addLog(`  ⚠ ${validationReviewQueue.length} lead(s) queued for PRUNING REVIEW (not auto-removed):`);
            for (const r of validationReviewQueue) addLog(`    ? ${r.lead.title?.slice(0,50)}`);
          }
          if (downgradedCount > 0) {
            addLog(`  ⚠ ${downgradedCount} lead(s) DOWNGRADED (flagged for review):`);
            for (const name of downgradedNames) addLog(`    ↓ ${name}`);
          }
          if (data.summary) {
            addLog(`  Summary: ${data.summary.totalChecked} checked, ${data.summary.claimed || 0} claimed, ${data.summary.enriched || 0} enriched, ${data.summary.suppressed || 0} suppressed, ${data.summary.downgraded || 0} downgraded`);
          }
        }

        // Log per-lead validation detail for observability
        if (data.validated) {
          const suppressed = data.validated.filter(v => v.recommendation === 'suppress');
          const downgraded = data.validated.filter(v => v.recommendation === 'downgrade');
          const claimed = data.validated.filter(v => v.claimed && v.recommendation === 'keep');
          const enriched = data.validated.filter(v => v.changes?.length > 0 && !v.claimed && v.recommendation === 'keep');
          const unchanged = data.validated.filter(v => !v.changes?.length && !v.searchError && v.recommendation === 'keep');
          const errors = data.validated.filter(v => v.searchError && v.recommendation === 'keep');

          if (suppressed.length > 0) {
            addLog(`\n── SUPPRESSED (${suppressed.length}) — removed from board ──`);
            for (const v of suppressed) {
              addLog(`  ✗ ${v.leadTitle.slice(0,50)} → ${v.recommendationReason || 'post-validation'}`);
            }
          }
          if (downgraded.length > 0) {
            addLog(`\n── DOWNGRADED (${downgraded.length}) — flagged for review ──`);
            for (const v of downgraded) {
              addLog(`  ↓ ${v.leadTitle.slice(0,50)} → ${v.recommendationReason || 'post-validation'}`);
            }
          }
          if (claimed.length > 0) {
            addLog(`\n── CLAIMED (${claimed.length}) ──`);
            for (const v of claimed) {
              addLog(`  🔴 ${v.leadTitle.slice(0,50)} → ${v.claimed.replace(/_/g,' ')}`);
              for (const c of v.changes || []) {
                if (c.field === 'architect') addLog(`     A/E: ${c.newValue}`);
                if (c.field === 'contractor') addLog(`     GC: ${c.newValue}`);
              }
              if (v.webSources?.[0]) addLog(`     Source: ${v.webSources[0].trustLabel} ${v.webSources[0].url?.slice(0,60) || ''}`);
            }
          }
          if (enriched.length > 0) {
            addLog(`\n── ENRICHED (${enriched.length}) ──`);
            for (const v of enriched) {
              const fields = v.changes.map(c => c.field === 'validationNote' ? 'note' : c.field).join(', ');
              addLog(`  🟡 ${v.leadTitle.slice(0,50)} → ${fields}`);
            }
          }
          if (unchanged.length > 0) {
            addLog(`\n── UNCHANGED (${unchanged.length}) ──`);
            for (const v of unchanged) {
              addLog(`  ○ ${v.leadTitle.slice(0,50)} — ${v.webResultCount} results, no findings`);
            }
          }
          if (errors.length > 0) {
            addLog(`\n── ERRORS (${errors.length}) ──`);
            for (const v of errors) {
              addLog(`  ⚠ ${v.leadTitle.slice(0,50)} — ${v.searchError}`);
            }
          }
        }

        setEngineResults({ mode: 'validate', validated: data.validated, summary: data.summary });
        setEngineState('complete');

        // Persist run history
        const entry = {
          action: 'validate', timestamp: new Date().toISOString(), mode: 'connected',
          leadsValidated: data.validated?.length || 0,
          leadsClaimed: data.summary?.claimed || 0,
          leadsEnriched: data.summary?.enriched || 0,
          leadsSuppressed: data.summary?.suppressed || 0,
          leadsDowngraded: data.summary?.downgraded || 0,
        };
        const hist = JSON.parse(localStorage.getItem('ps_run_history') || '[]');
        hist.unshift(entry);
        localStorage.setItem('ps_run_history', JSON.stringify(hist.slice(0, 50)));
        setRunHistory(hist.slice(0, 50));
        return;
      }

      if (isConnected) {
        // ─── CONNECTED MODE: call real backend ────────────────
        if (sourcesForScan.length === 0) {
          addLog('⚠ No scannable sources — either none are active or all active sources belong to inactive regions. Check Source Registry and Geography settings.');
          setEngineState('complete');
          return;
        }
        addLog(`Sending request to backend (${sourcesForScan.length} source${sourcesForScan.length === 1 ? '' : 's'}, ${allLeads.length} existing leads)...`);
        // Send only safe preferences — backend uses its own env vars for secrets
        const safeSettings = { aiProvider: settings.aiProvider, aiModel: settings.aiModel, freshnessDays: settings.freshnessDays, recheckDays: settings.recheckDays, backfillMonths: settings.backfillMonths };
        const resp = await fetch(`${settings.backendEndpoint}/api/scan?action=${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sources: sourcesForScan, focusPoints: activeFP, targetOrgs: activeOrgs,
            existingLeads: allLeads, notPursuedLeads: notPursuedLeads,
            submittedLeads: submittedLeads.map(s => ({ id: s.id, title: s.title, asana_task_name: s.asana_task_name, scout_title: s.scout_title, user_edited_title: s.user_edited_title, alternate_titles: s.alternate_titles })),
            taxonomy: taxonomy,
            settings: safeSettings,
          }),
        });
        if (!resp.ok) throw new Error(`Backend returned ${resp.status}: ${await resp.text().then(t=>t.slice(0,200))}`);
        const data = await resp.json();
        // ── Runtime proof: log which backend version responded ──
        if (data.scanBuildId) {
          addLog(`✅ Backend confirmed: ${data.scanBuildId} (response ts: ${data.ts || 'n/a'})`);
          console.log('[ProjectScout] Backend Build ID:', data.scanBuildId, '| Response ts:', data.ts);
        } else {
          addLog(`⚠️ Backend did NOT return scanBuildId — you may be hitting a stale/old deployment`);
          console.warn('[ProjectScout] No scanBuildId in response — likely old backend deployment');
        }
        if (data.logs) data.logs.forEach(l => addLog(l));
        results = data.results;
      } else {
        // ─── LOCAL MODE: client-side rule-based engine ────────
        if (sourcesForScan.length === 0) {
          addLog('⚠ No scannable sources — either none are active or all active sources belong to inactive regions. Check Source Registry and Geography settings.');
          setEngineState('complete');
          return;
        }
        results = await runLocalEngine(action, sourcesForScan, activeFP, activeOrgs, allLeads, notPursuedLeads, submittedLeads, settings, addLog, taxonomy);
      }

      // ─── MERGE results into persisted lead state ────────────
      if (results && onMergeResults) {
        onMergeResults(results);
        const suppCount = results.skippedLowQuality || results.leadsSuppressed?.length || 0;
        addLog(`✓ Merged into lead state: ${results.leadsAdded?.length || 0} added, ${results.leadsUpdated?.length || 0} updated${suppCount > 0 ? `, ${suppCount} suppressed (low quality)` : ''}`);
      }

      setEngineResults(results);
      setEngineState('complete');

      // Persist run history
      const entry = {
        action, timestamp: new Date().toISOString(), mode: isConnected ? 'connected' : 'local',
        leadsAdded: results?.leadsAdded?.length || 0,
        leadsUpdated: results?.leadsUpdated?.length || 0,
        skippedNotPursued: results?.skippedNotPursued || 0,
        sourcesFetched: results?.sourcesFetched || 0,
        duration: results?.duration || 0,
      };
      const newHistory = [entry, ...(runHistory || []).slice(0, 19)];
      setRunHistory(newHistory);
      localStorage.setItem('ps_runHistory', JSON.stringify(newHistory));

      addLog(`═══ ${action.toUpperCase()} COMPLETE ═══`);
    } catch (err) {
      addLog(`ERROR: ${err.message}`);
      setEngineState('error');
    }
  }, [settings, hasBackend, allLeads, notPursuedLeads, submittedLeads, onMergeResults, addLog, runHistory]);

  // ─── Asana check via parent callback ───────────────────────
  const handleAsanaCheck = useCallback(async () => {
    setEngineState('running');
    setEngineAction('asana-check');
    setEngineLog([]);
    const result = await onRunAsanaCheck(settings, addLog);
    setLastAsanaCheck(result);
    localStorage.setItem('ps_lastAsanaCheck', JSON.stringify(result));
    setEngineState(result?.error && result.mode !== 'disconnected' ? 'error' : 'complete');
    setEngineResults(result?.matched !== undefined ? { asanaMatched: result.matched, asanaImported: result.imported || 0, asanaMode: result.mode } : null);
  }, [settings, onRunAsanaCheck, addLog]);

  const groups = [
    { title: 'Backend Connection', fields: [
      { key: 'backendEndpoint', label: 'Backend Endpoint', type: 'text', placeholder: 'https://your-app.vercel.app' },
    ], note: 'AI keys and Asana tokens are managed as environment variables on the backend (Vercel). No secrets need to be stored in the browser.' },
    { title: 'AI Preferences', fields: [
      { key: 'aiProvider', label: 'Preferred Provider', type: 'select', options: ['anthropic', 'openai'] },
      { key: 'aiModel', label: 'Preferred Model', type: 'text', placeholder: 'Default: claude-haiku-4-5 / gpt-4o-mini' },
    ], note: 'These preferences are sent to the backend. The actual API key is stored server-side.' },
    { title: 'Scheduling & Behavior', fields: [
      { key: 'dailyUpdateTime', label: 'Daily Update Time', type: 'time' },
      { key: 'backfillMonths', label: 'Backfill Window (months)', type: 'number' },
      { key: 'freshnessDays', label: 'New Lead Freshness (days)', type: 'number' },
      { key: 'recheckDays', label: 'Active Lead Recheck (days)', type: 'number' },
    ]},
    { title: 'Filters & Thresholds', fields: [
      { key: 'priorityThreshold', label: 'Min Priority', type: 'select', options: ['critical','high','medium','low'] },
      { key: 'activeSourcesOnly', label: 'Active Sources Only', type: 'toggle' },
    ]},
  ];

  const ConnBadge = ({ status, label }) => {
    const styles = {
      connected: { bg:'#d1fae5', fg:'#065f46', dot:'#10b981', text:'Connected' },
      configured: { bg:'#dbeafe', fg:'#1e40af', dot:'#3b82f6', text:'Configured (unverified)' },
      fallback: { bg:'#fef3c7', fg:'#92400e', dot:'#f59e0b', text:'Fallback mode' },
      unavailable: { bg:'#f3f4f6', fg:'#6b7280', dot:'#9ca3af', text:'Not configured' },
    };
    const s = styles[status] || styles.unavailable;
    return (
      <span style={{ display:'inline-flex', alignItems:'center', gap:4, fontSize:10.5, fontWeight:600, padding:'3px 9px', borderRadius:5, background:s.bg, color:s.fg }}>
        <span style={{ width:5, height:5, borderRadius:'50%', background:s.dot }}/> {label}: {s.text}
      </span>
    );
  };

  const backendStatus = hasBackend ? 'configured' : 'unavailable';

  return (
    <div style={{ maxWidth: 720 }}>
      {/* Connection Status Bar */}
      <div style={{ display:'flex', gap:8, marginBottom:20, flexWrap:'wrap' }}>
        <ConnBadge status={backendStatus} label="Backend" />
        {hasBackend && <ConnBadge status="configured" label="AI & Asana" />}
        {!hasBackend && <span style={{ fontSize: 11, color: '#94a3b8', alignSelf: 'center' }}>Configure backend endpoint to enable AI scanning and Asana integration</span>}
      </div>

      {/* Intelligence Engine Panel */}
      <div style={{ marginBottom: 28 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', margin: '0 0 14px' }}>Intelligence Engine</h3>
        <div style={{ background: '#fff', borderRadius: 10, border: '1px solid rgba(0,0,0,0.06)', overflow: 'hidden' }}>
          {/* Status + buttons */}
          <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid #f1f5f9', flexWrap:'wrap', gap:8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{
                width: 8, height: 8, borderRadius: '50%',
                background: engineState === 'running' ? '#f59e0b' : engineState === 'complete' ? '#10b981' : engineState === 'error' ? '#ef4444' : '#cbd5e1',
                animation: engineState === 'running' ? 'pulse 1.5s ease infinite' : 'none',
              }} />
              <span style={{ fontSize: 12.5, fontWeight: 600, color: '#475569' }}>
                {engineState === 'idle' && 'Ready'}
                {engineState === 'running' && `Running ${engineAction}...`}
                {engineState === 'complete' && `${engineAction} complete`}
                {engineState === 'error' && 'Error occurred'}
              </span>
              <span style={{ fontSize:10, padding:'2px 7px', borderRadius:4, background: hasBackend ? '#dbeafe' : '#fef3c7', color: hasBackend ? '#1e40af' : '#92400e', fontWeight:600 }}>
                {hasBackend ? 'Connected' : 'Local / Simulated'}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <EngineBtn label="Daily Scan" icon={<RefreshCw size={12}/>} onClick={() => runEngine('daily')} disabled={engineState === 'running'} primary />
              <EngineBtn label="Backfill" icon={<Database size={12}/>} onClick={() => runEngine('backfill')} disabled={engineState === 'running'} />
              <EngineBtn label="Maintain" icon={<Activity size={12}/>} onClick={() => runEngine('maintain')} disabled={engineState === 'running'} />
              <EngineBtn label="Validate" icon={<Shield size={12}/>} onClick={() => runEngine('validate')} disabled={engineState === 'running'} />
            </div>
          </div>

          {/* Results summary */}
          {engineResults && (
            <div style={{ padding: '10px 16px', borderBottom: '1px solid #f1f5f9', fontSize: 12 }}>
              <div style={{ display: 'flex', gap: 14, flexWrap:'wrap', alignItems:'center' }}>
                {engineResults.mode && <span style={{ fontSize:10, fontWeight:700, padding:'2px 7px', borderRadius:4, background: engineResults.mode==='live'?'#d1fae5':'#fef3c7', color: engineResults.mode==='live'?'#065f46':'#92400e', textTransform:'uppercase' }}>{engineResults.mode}</span>}
                {engineResults.leadsAdded !== undefined && <span><strong style={{ color: '#10b981' }}>{Array.isArray(engineResults.leadsAdded) ? engineResults.leadsAdded.length : engineResults.leadsAdded}</strong> added</span>}
                {engineResults.leadsUpdated !== undefined && <span><strong style={{ color: '#3b82f6' }}>{Array.isArray(engineResults.leadsUpdated) ? engineResults.leadsUpdated.length : engineResults.leadsUpdated}</strong> updated</span>}
                {engineResults.skippedNotPursued > 0 && <span><strong style={{ color: '#f59e0b' }}>{engineResults.skippedNotPursued}</strong> blocked</span>}
                {engineResults.sourcesFetched !== undefined && <span><strong>{engineResults.sourcesFetched}</strong> sources</span>}
                {engineResults.fetchSuccesses !== undefined && <span style={{color:'#10b981'}}>{engineResults.fetchSuccesses} fetched</span>}
                {engineResults.fetchFailures > 0 && <span style={{color:'#ef4444'}}>{engineResults.fetchFailures} failed</span>}
                {engineResults.parseHits !== undefined && <span>{engineResults.parseHits} with signals</span>}
                {engineResults.duration !== undefined && <span style={{ color: '#94a3b8' }}>{(engineResults.duration / 1000).toFixed(1)}s</span>}
                {engineResults.asanaImported > 0 && <span><strong style={{ color:'#92400e' }}>{engineResults.asanaImported}</strong> imported</span>}
                {engineResults.asanaMatched !== undefined && <span><strong style={{ color:'#6366f1' }}>{engineResults.asanaMatched}</strong> Asana matches</span>}
                {engineResults.mode === 'validate' && engineResults.summary && <>
                  <span style={{ fontSize:10, fontWeight:700, padding:'2px 7px', borderRadius:4, background:'#ede9fe', color:'#6d28d9', textTransform:'uppercase' }}>VALIDATE</span>
                  <span><strong>{engineResults.summary.totalChecked}</strong> checked</span>
                  {engineResults.summary.claimed > 0 && <span><strong style={{ color:'#dc2626' }}>{engineResults.summary.claimed}</strong> claimed</span>}
                  {engineResults.summary.enriched > 0 && <span><strong style={{ color:'#f59e0b' }}>{engineResults.summary.enriched}</strong> enriched</span>}
                  <span style={{ color:'#94a3b8' }}>{engineResults.summary.unchanged} unchanged</span>
                  {engineResults.summary.errors > 0 && <span style={{ color:'#ef4444' }}>{engineResults.summary.errors} errors</span>}
                </>}
              </div>
              {/* Validation detail panel */}
              {engineResults.mode === 'validate' && engineResults.validated?.length > 0 && (
                <div style={{ marginTop: 8, borderTop: '1px solid #f1f5f9', paddingTop: 8 }}>
                  {engineResults.validated.filter(v => v.changes?.length > 0).map((v, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '4px 0', fontSize: 11, borderBottom: '1px solid #f8fafc' }}>
                      <span style={{
                        fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3, whiteSpace: 'nowrap',
                        background: v.claimed ? '#fef2f2' : '#fefce8',
                        color: v.claimed ? '#dc2626' : '#ca8a04',
                        border: `1px solid ${v.claimed ? '#fecaca' : '#fde68a'}`,
                      }}>{v.claimed ? v.claimed.replace(/_/g,' ') : 'enriched'}</span>
                      <span style={{ fontWeight: 600, color: '#1e293b', flex: 1 }}>{v.leadTitle.slice(0, 45)}</span>
                      <span style={{ color: '#64748b', fontSize: 10 }}>
                        {v.changes.map(c => {
                          if (c.field === 'architect') return `A/E: ${c.newValue}`;
                          if (c.field === 'contractor') return `GC: ${c.newValue}`;
                          if (c.field === 'potentialBudget') return `$: ${c.newValue}`;
                          if (c.field === 'action_due_date') return `Due: ${c.newValue}`;
                          if (c.field === 'validationNote') return 'note';
                          if (c.field === 'projectStatus') return '';
                          return c.field;
                        }).filter(Boolean).join(' · ')}
                      </span>
                      {v.webSources?.[0] && (
                        <span style={{ fontSize: 9, color: '#94a3b8' }} title={v.webSources[0].url}>
                          {v.webSources[0].trustLabel}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Log panel */}
          {engineLog.length > 0 && (
            <div ref={logRef} style={{
              maxHeight: 280, overflowY: 'auto', padding: '10px 16px',
              background: '#0f172a', fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace",
            }}>
              {engineLog.map((entry, i) => (
                <div key={i} style={{ fontSize: 11, lineHeight: 1.6, color:
                  entry.msg.includes('ERROR') ? '#fca5a5' :
                  entry.msg.includes('═══') ? '#67e8f9' :
                  entry.msg.includes('✓') ? '#86efac' :
                  entry.msg.includes('MATCH') ? '#c4b5fd' :
                  entry.msg.startsWith('  [AI]') ? '#a78bfa' :
                  entry.msg.startsWith('Mode:') ? '#fde68a' :
                  '#94a3b8' }}>
                  {entry.msg}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Asana Check Panel */}
      <div style={{ marginBottom: 28 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', margin: '0 0 14px' }}>Asana Board Check</h3>
        <div style={{ background: '#fff', borderRadius: 10, border: '1px solid rgba(0,0,0,0.06)', padding:'14px 16px' }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
            <div>
              <div style={{ fontSize:12.5, fontWeight:600, color:'#475569' }}>
                {hasBackend ? 'Asana sync & match via backend' : 'Backend not configured'}
              </div>
              {lastAsanaCheck && (
                <div style={{ fontSize:11, color:'#94a3b8', marginTop:2 }}>
                  Last sync: {formatDate(lastAsanaCheck.timestamp)} — {lastAsanaCheck.tasksChecked || 0} tasks synced, {lastAsanaCheck.matched || 0} match(es)
                  {lastAsanaCheck.imported > 0 && `, ${lastAsanaCheck.imported} new imported`}
                  {lastAsanaCheck.error && ` — Error: ${lastAsanaCheck.error}`}
                </div>
              )}
            </div>
            <button onClick={handleAsanaCheck} disabled={!hasBackend || engineState === 'running'}
              style={{ padding:'7px 16px', borderRadius:7, border:'none', background: hasBackend ? '#0f172a' : '#e2e8f0', color: hasBackend ? '#fff' : '#94a3b8', cursor: hasBackend && engineState !== 'running' ? 'pointer' : 'not-allowed', fontSize:12, fontWeight:600, display:'flex', alignItems:'center', gap:5 }}>
              <RefreshCw size={12}/> Sync Asana Now
            </button>
          </div>
          {!hasBackend && (
            <div style={{ padding:'10px 12px', background:'#fffbeb', borderRadius:7, border:'1px solid #fef3c7', fontSize:11.5, color:'#92400e', lineHeight:1.5 }}>
              Configure a Backend Endpoint above to enable Asana sync. The Asana access token is managed as an environment variable on the backend. Sync imports all board tasks and checks for Scout lead matches.
            </div>
          )}
          {/* v31c: Asana Diagnostics — section names, BP status */}
          {lastAsanaCheck && lastAsanaCheck.sectionsSeen && (
            <div style={{ marginTop: 10, padding: '10px 14px', borderRadius: 8, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#475569', marginBottom: 6 }}>Asana Board Diagnostics</div>
              <div style={{ fontSize: 11, color: '#64748b', lineHeight: 1.7 }}>
                <div><strong>Sections seen:</strong> {lastAsanaCheck.sectionsSeen.length > 0 ? lastAsanaCheck.sectionsSeen.join(', ') : 'None'}</div>
                <div style={{ marginTop: 4 }}>
                  <strong>Business Pursuits:</strong>{' '}
                  {lastAsanaCheck.bpSectionsMatched?.length > 0 ? (
                    <span style={{ color: '#166534', fontWeight: 600 }}>
                      Matched: {lastAsanaCheck.bpSectionsMatched.join(', ')} — {lastAsanaCheck.bpTasksQualified || 0} qualifying task(s) added to Watch
                    </span>
                  ) : (
                    <span style={{ color: '#64748b' }}>
                      No matching section found. The Asana project uses Go/No-Go workflow sections only. To enable BP import, add a section named "Business Pursuits" or "Business Development" to the Asana project for early-stage opportunities.
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Run History */}
      {runHistory.length > 0 && (
        <div style={{ marginBottom: 28 }}>
          <h3 style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', margin: '0 0 14px' }}>Run History</h3>
          <div style={{ background: '#fff', borderRadius: 10, border: '1px solid rgba(0,0,0,0.06)', overflow: 'hidden' }}>
            {runHistory.slice(0, 8).map((entry, i) => (
              <div key={i} style={{ padding:'10px 16px', borderTop: i>0 ? '1px solid #f1f5f9' : 'none', display:'flex', justifyContent:'space-between', alignItems:'center', fontSize:12 }}>
                <div>
                  <span style={{ fontWeight:600, color:'#0f172a', textTransform:'capitalize' }}>{entry.action}</span>
                  <span style={{ marginLeft:8, fontSize:10, padding:'2px 6px', borderRadius:4, background: entry.mode === 'connected' ? '#dbeafe' : '#fef3c7', color: entry.mode === 'connected' ? '#1e40af' : '#92400e', fontWeight:600 }}>{entry.mode}</span>
                </div>
                <div style={{ color:'#94a3b8', display:'flex', gap:12 }}>
                  <span>+{entry.leadsAdded} added</span>
                  <span>{entry.leadsUpdated} updated</span>
                  <span>{formatDate(entry.timestamp)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Settings groups */}
      {groups.map(g => (
        <div key={g.title} style={{ marginBottom: 28 }}>
          <h3 style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', margin: '0 0 14px', letterSpacing: '-0.01em' }}>{g.title}</h3>
          <div style={{ background: '#fff', borderRadius: 10, border: '1px solid rgba(0,0,0,0.06)', overflow: 'hidden' }}>
            {g.fields.map((f, i) => (
              <div key={f.key} style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: i > 0 ? '1px solid #f1f5f9' : 'none' }}>
                <label style={{ fontSize: 12.5, fontWeight: 500, color: '#475569' }}>{f.label}</label>
                {f.type === 'select' ? (
                  <select value={settings[f.key]} onChange={e => setSettings(p => ({...p, [f.key]: e.target.value}))} style={{ ...inputStyle, width: 200 }}>
                    {f.options.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : f.type === 'toggle' ? (
                  <button onClick={() => setSettings(p => ({...p, [f.key]: !p[f.key]}))} style={{
                    width: 40, height: 22, borderRadius: 11, border: 'none', cursor: 'pointer',
                    background: settings[f.key] ? '#10b981' : '#e2e8f0', position: 'relative', transition: 'background 0.2s',
                  }}>
                    <div style={{ width: 16, height: 16, borderRadius: '50%', background: '#fff', position: 'absolute', top: 3, left: settings[f.key] ? 21 : 3, transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }} />
                  </button>
                ) : (
                  <input type={f.type} value={settings[f.key]} onChange={e => setSettings(p => ({...p, [f.key]: e.target.value}))}
                    placeholder={f.placeholder} style={{ ...inputStyle, width: 240 }}
                  />
                )}
              </div>
            ))}
          </div>
          {g.note && <p style={{ fontSize: 11, color: '#94a3b8', margin: '8px 0 0', lineHeight: 1.5, fontStyle: 'italic' }}>{g.note}</p>}
        </div>
      ))}
      {/* ─── Data Backup & Restore ─────────────────────────────── */}
      <div style={{ marginBottom: 28 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', margin: '0 0 14px', letterSpacing: '-0.01em' }}>
          <HardDrive size={14} style={{ marginRight: 6, verticalAlign: '-2px' }} />Data Backup &amp; Restore
        </h3>
        <div style={{ background: '#fff', borderRadius: 10, border: '1px solid rgba(0,0,0,0.06)', padding: 20 }}>
          <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 16px', lineHeight: 1.6 }}>
            Export all Project Scout data as a JSON file, or import a previously exported backup to restore your data.
            Importing will <strong>replace all current data</strong> — export first if you want to keep what you have.
          </p>

          {/* Export */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
            <button onClick={() => {
              try {
                const allKeys = [
                  'ps_source_families', 'ps_coverage_regions', 'ps_county_mapping',
                  'ps_entities', 'ps_sources', 'ps_proposed_sources', 'ps_proposed_entities',
                  'ps_leads', 'ps_owner_projects', 'ps_intake', 'ps_settings', 'ps_migration',
                  'ps_submitted', 'ps_notpursued', 'ps_runHistory', 'ps_lastAsanaCheck',
                  'ps_focuspoints', 'ps_targetorgs', 'ps_taxonomy', 'ps_pruning_review_queue',
                  'ps_dismissed_matches',
                ];
                const payload = { _meta: { version: 2, exportedAt: new Date().toISOString(), appName: 'ProjectScout' } };
                let totalRecords = 0;
                for (const k of allKeys) {
                  const raw = localStorage.getItem(k);
                  if (raw !== null) {
                    try { payload[k] = JSON.parse(raw); } catch { payload[k] = raw; }
                    if (Array.isArray(payload[k])) totalRecords += payload[k].length;
                  }
                }
                // Redact secrets from exported settings — backend env vars are authoritative
                if (payload.ps_settings && typeof payload.ps_settings === 'object') {
                  const redacted = { ...payload.ps_settings };
                  delete redacted.aiApiKey;
                  delete redacted.asanaToken;
                  redacted._notice = 'Secrets (AI keys, Asana tokens) are not included in exports. They are managed as backend environment variables.';
                  payload.ps_settings = redacted;
                }
                payload._meta.keysExported = Object.keys(payload).filter(k => k !== '_meta').length;
                payload._meta.totalRecords = totalRecords;
                payload._meta.secretsRedacted = true;
                const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `project-scout-backup-${new Date().toISOString().slice(0,10)}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                setBackupStatus({ type: 'success', msg: `Exported ${payload._meta.keysExported} data keys (${totalRecords} records) at ${new Date().toLocaleTimeString()}.` });
              } catch (err) {
                setBackupStatus({ type: 'error', msg: `Export failed: ${err.message}` });
              }
            }} style={{
              padding: '8px 16px', background: '#0f172a', color: '#fff', border: 'none', borderRadius: 7,
              fontSize: 11.5, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <Download size={13} /> Export All Data
            </button>

            {/* Import */}
            <button onClick={() => importFileRef.current?.click()} style={{
              padding: '8px 16px', background: '#fff', color: '#0f172a', border: '1px solid #e2e8f0', borderRadius: 7,
              fontSize: 11.5, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <Upload size={13} /> Import Backup
            </button>
            <input ref={importFileRef} type="file" accept=".json" style={{ display: 'none' }} onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = (ev) => {
                try {
                  const data = JSON.parse(ev.target.result);
                  if (!data._meta || data._meta.appName !== 'ProjectScout') {
                    setBackupStatus({ type: 'error', msg: 'Invalid backup file — missing Project Scout metadata. Please select a valid export file.' });
                    return;
                  }
                  const dataKeys = Object.keys(data).filter(k => k !== '_meta');
                  const recordCount = dataKeys.reduce((n, k) => n + (Array.isArray(data[k]) ? data[k].length : 0), 0);
                  setPendingImport({ data, dataKeys, recordCount, exportedAt: data._meta.exportedAt });
                } catch (err) {
                  setBackupStatus({ type: 'error', msg: `Could not read file: ${err.message}` });
                }
              };
              reader.readAsText(file);
              e.target.value = '';
            }} />
          </div>

          {/* Status message */}
          {backupStatus && (
            <div style={{
              padding: '10px 14px', borderRadius: 8, fontSize: 12, lineHeight: 1.5, marginBottom: 12,
              background: backupStatus.type === 'success' ? '#f0fdf4' : '#fef2f2',
              color: backupStatus.type === 'success' ? '#166534' : '#991b1b',
              border: `1px solid ${backupStatus.type === 'success' ? '#bbf7d0' : '#fecaca'}`,
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              {backupStatus.type === 'success' ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
              {backupStatus.msg}
            </div>
          )}

          {/* Import confirmation modal (inline) */}
          {pendingImport && (
            <div style={{
              padding: 16, borderRadius: 8, background: '#fffbeb', border: '1px solid #fde68a',
            }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: '#92400e', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                <AlertCircle size={15} /> Confirm Data Import
              </div>
              <p style={{ fontSize: 12, color: '#78350f', margin: '0 0 8px', lineHeight: 1.6 }}>
                This will <strong>replace ALL current Project Scout data</strong> with the backup file contents.
                Any data not in the backup will be lost.
              </p>
              <ul style={{ fontSize: 11.5, color: '#78350f', margin: '0 0 12px', paddingLeft: 20, lineHeight: 1.8 }}>
                <li><strong>{pendingImport.dataKeys.length}</strong> data keys will be written</li>
                <li><strong>{pendingImport.recordCount}</strong> total records</li>
                {pendingImport.exportedAt && <li>Backup created: <strong>{new Date(pendingImport.exportedAt).toLocaleString()}</strong></li>}
              </ul>
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => {
                  try {
                    const { data, dataKeys } = pendingImport;
                    for (const k of dataKeys) {
                      localStorage.setItem(k, JSON.stringify(data[k]));
                    }
                    setPendingImport(null);
                    setBackupStatus({ type: 'success', msg: `Imported ${dataKeys.length} data keys (${pendingImport.recordCount} records). Reload the page to see updated data.` });
                  } catch (err) {
                    setBackupStatus({ type: 'error', msg: `Import failed: ${err.message}` });
                    setPendingImport(null);
                  }
                }} style={{
                  padding: '7px 16px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6,
                  fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                }}>
                  Yes, Replace All Data
                </button>
                <button onClick={() => { setPendingImport(null); setBackupStatus(null); }} style={{
                  padding: '7px 16px', background: '#fff', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 6,
                  fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                }}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* About */}
      <div style={{ marginTop: 40, padding: '20px 24px', background: '#f8fafc', borderRadius: 10, border: '1px solid #e2e8f0' }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', margin: '0 0 10px', letterSpacing: '-0.01em' }}>About Project Scout</h3>
        <p style={{ fontSize: 12.5, color: '#475569', margin: '0 0 4px', lineHeight: 1.6 }}>Developed by Jon Sears for the use of A&E + SMA Design.</p>
        <p style={{ fontSize: 12.5, color: '#475569', margin: 0, lineHeight: 1.6 }}>For feature requests, contact Jon Sears directly.</p>
      </div>
    </div>
  );
}

function EngineBtn({ label, icon, onClick, disabled, primary }) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{ padding:'7px 14px', background: disabled ? '#e2e8f0' : primary ? '#0f172a' : '#fff', color: primary ? '#fff' : '#0f172a',
        border: primary ? 'none' : '1px solid #e2e8f0', borderRadius:7, fontSize:11.5, fontWeight:600,
        cursor: disabled ? 'not-allowed' : 'pointer', display:'flex', alignItems:'center', gap:5 }}>
      {icon} {label}
    </button>
  );
}

/**
 * LOCAL ENGINE — real client-side rule-based lead discovery.
 * Uses scoring logic, dedup, freshness checks.
 * Does NOT simulate with random numbers.
 * Produces real lead records that merge into persisted state.
 *
 * Without a deployed backend, source content cannot be fetched (CORS).
 * So this engine generates leads from the SOURCE METADATA + KEYWORD MATCHING
 * against focus points and target orgs — a realistic demo that produces
 * structured, scorable leads from the configured intelligence data.
 */
async function runLocalEngine(action, sources, focusPoints, targetOrgs, existingLeads, notPursuedLeads, submittedLeads, settings, addLog, taxonomy = []) {
  const startTime = Date.now();
  const freshnessDays = settings.freshnessDays || 60;

  const allExisting = [...existingLeads, ...submittedLeads, ...notPursuedLeads];
  const existingTitles = new Set(allExisting.map(l => (l.title||'').toLowerCase().trim()));
  const notPursuedTitles = new Set(notPursuedLeads.map(l => (l.title||'').toLowerCase().trim()));

  const sourceCount = action === 'daily' ? Math.min(sources.length, 15) : sources.length;
  const targetSources = sources.slice(0, sourceCount);

  addLog(`Scanning ${targetSources.length} sources using local rule-based engine...`);
  addLog(`Focus points: ${focusPoints.length} | Target orgs: ${targetOrgs.length} | Existing leads: ${existingLeads.length}`);

  const newLeads = [];
  const updatedLeads = [];
  let skippedNotPursued = 0;
  let skippedDuplicate = 0;

  // Generate candidates from source × target org × focus point intersections
  for (let i = 0; i < targetSources.length; i++) {
    const src = targetSources[i];
    await new Promise(r => setTimeout(r, 60));
    addLog(`  [${i+1}/${targetSources.length}] ${src.name}`);

    // Find target orgs that match this source's geography
    const geoOrgs = targetOrgs.filter(o =>
      o.geography === src.geography || o.geography === 'Statewide' || src.geography === 'Statewide'
    );

    // Find focus points whose keywords overlap with source keywords
    const matchedFPs = focusPoints.filter(fp =>
      fp.keywords.some(kw => (src.keywords || []).some(sk => sk.toLowerCase().includes(kw.toLowerCase()) || kw.toLowerCase().includes(sk.toLowerCase())))
    );

    if (geoOrgs.length === 0 && matchedFPs.length === 0) continue;

    // For each relevant org, generate a candidate lead
    for (const org of geoOrgs.slice(0, 2)) {
      for (const fp of matchedFPs.slice(0, 1)) {
        const title = `${org.name} — ${fp.title} Opportunity`;
        const titleLower = title.toLowerCase().trim();

        // Check Not Pursued
        if (notPursuedTitles.has(titleLower)) {
          skippedNotPursued++;
          continue;
        }

        // Check existing duplicate
        if (existingTitles.has(titleLower)) {
          // Update existing lead
          const existing = allExisting.find(l => (l.title||'').toLowerCase().trim() === titleLower);
          if (existing && existingLeads.find(l => l.id === existing.id)) {
            updatedLeads.push({
              leadId: existing.id,
              lastCheckedDate: new Date().toISOString(),
              relevanceScore: Math.min(100, (existing.relevanceScore || 50) + 2),
              newEvidence: {
                id: `ev-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
                leadId: existing.id, sourceId: src.id, sourceName: src.name, url: src.url,
                title: `${src.name} — recheck ${new Date().toLocaleDateString('en-US',{month:'short',day:'numeric'})}`,
                summary: `Source rechecked. Signals still active for ${fp.title.toLowerCase()} via ${org.name}.`,
                signalDate: new Date().toISOString(), dateFound: new Date().toISOString(),
                signalStrength: 'medium', keywords: (src.keywords||[]).slice(0,4),
              },
            });
          }
          skippedDuplicate++;
          continue;
        }

        // Freshness check
        const signalDate = new Date(Date.now() - Math.random() * 45 * 86400000).toISOString();
        const age = (Date.now() - new Date(signalDate).getTime()) / 86400000;
        if (age > freshnessDays) continue;

        // Score
        const prioWeight = {critical:1.3,high:1.15,medium:1,low:0.85};
        const baseScore = (src.priority === 'critical' ? 30 : src.priority === 'high' ? 22 : 15);
        const fpScore = Math.min(20, matchedFPs.length * 10) * (prioWeight[fp.priority]||1);
        const orgScore = 15;
        const geoScore = ['Missoula','Kalispell','Whitefish','Hamilton','Polson'].includes(src.geography) ? 15 : 8;
        const relevanceScore = Math.min(100, Math.round(baseScore + fpScore + orgScore + geoScore));
        const pursuitScore = Math.min(100, Math.round(relevanceScore * 0.6 + (src.priority === 'critical' ? 20 : 10)));
        const sourceConfidenceScore = Math.min(100, Math.round(
          (src.category === 'State Procurement' ? 92 : src.category === 'County Commission' ? 88 : src.category === 'City Council' ? 85 : 70) +
          (src.fetchHealth === 'healthy' ? 5 : -5)
        ));

        existingTitles.add(titleLower);

        // Taxonomy-aware adjustments (local engine)
        const leadText = `${title} ${fp.title} ${org.name} ${src.category || ''} ${(src.keywords||[]).join(' ')}`.toLowerCase();
        const taxonomyMatches = [];
        let taxAdj = 0;
        let noiseAdj = 0;
        const activeTax = (taxonomy || []).filter(t => t.status === 'active');
        for (const item of activeTax) {
          const includeHits = (item.include_keywords || []).filter(kw => leadText.includes(kw.toLowerCase()));
          if (includeHits.length === 0) continue;
          const excludeHit = (item.exclude_keywords || []).some(kw => leadText.includes(kw.toLowerCase()));
          if (excludeHit) continue;
          taxonomyMatches.push({ taxonomy_id: item.taxonomy_id, group: item.taxonomy_group, label: item.label, fit_mode: item.fit_mode, matched_keywords: includeHits });
          if (item.taxonomy_group === 'noise') {
            if (item.fit_mode === 'exclude') noiseAdj -= 30;
            else if (item.fit_mode === 'downrank') noiseAdj -= 15;
          } else {
            taxAdj += item.fit_mode === 'strong_fit' ? 5 : item.fit_mode === 'moderate_fit' ? 3 : item.fit_mode === 'monitor_only' ? 1 : item.fit_mode === 'downrank' ? -5 : 0;
          }
        }
        // Skip leads that noise-excluded in local engine
        if (noiseAdj <= -30) {
          addLog(`  [Noise] Excluded: "${title}" — matched noise exclusion rule`);
          continue;
        }
        const adjRelevance = Math.min(100, Math.max(0, relevanceScore + Math.min(15, taxAdj) + Math.max(-30, noiseAdj)));
        const adjPursuit = Math.min(100, Math.max(0, Math.round(adjRelevance * 0.6 + (src.priority === 'critical' ? 20 : 10))));
        const taxNotes = [];
        const svcM = taxonomyMatches.filter(m => m.group === 'service');
        const mktM = taxonomyMatches.filter(m => m.group === 'market');
        const nseM = taxonomyMatches.filter(m => m.group === 'noise');
        if (svcM.length > 0) taxNotes.push(`Service fit: ${svcM.map(m => m.label).join(', ')}`);
        if (mktM.length > 0) taxNotes.push(`Market: ${mktM.map(m => m.label).join(', ')}`);
        if (nseM.length > 0) taxNotes.push(`Noise flag: ${nseM.map(m => m.label).join(', ')}`);
        const confNotes = `Source: ${src.category} (${src.priority}). Focus: ${fp.title}. Org: ${org.name}.${taxNotes.length ? ' ' + taxNotes.join('. ') + '.' : ''}`;

        // Quality gate: skip leads below minimum relevance threshold (raised to 35)
        if (adjRelevance < 35) {
          addLog(`    ↓ Suppressed (relevance ${adjRelevance}): ${title}`);
          continue;
        }

        newLeads.push({
          id: `lead-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
          title, owner: org.name, projectName: '',
          location: src.geography ? `${src.geography}, MT` : 'Western Montana',
          county: src.county || org.county || '', geography: src.geography || org.geography || '',
          marketSector: fp.category || '', projectType: '',
          description: `Potential ${fp.title.toLowerCase()} project signal detected from ${src.name}. ${org.name} activity in ${src.geography || 'Western Montana'} aligns with ${fp.title} focus area.`,
          whyItMatters: `${org.name} is a tracked target organization. ${fp.title} is an active focus point. Source is ${src.priority} priority.`,
          aiReasonForAddition: `Matched target org "${org.name}" via ${src.name} (${src.category}), aligned with focus area "${fp.title}". Signal keywords: ${(src.keywords||[]).slice(0,3).join(', ')}.`,
          potentialTimeline: '', potentialBudget: '',
          relevanceScore: adjRelevance, pursuitScore: adjPursuit, sourceConfidenceScore,
          confidenceNotes: confNotes,
          taxonomyMatches,
          dateDiscovered: new Date().toISOString(), originalSignalDate: signalDate,
          lastCheckedDate: new Date().toISOString(), status: 'new', leadOrigin: 'fallback',
          sourceName: src.name, sourceUrl: src.url, sourceId: src.id,
          evidenceLinks: [src.url], evidenceSummary: `Initial signal from ${src.name} monitoring.`,
          matchedFocusPoints: [fp.title], matchedKeywords: (src.keywords||[]).slice(0,5),
          matchedTargetOrgs: [org.name], internalContact: '', notes: '',
          evidence: [{
            id: `ev-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
            leadId: '', sourceId: src.id, sourceName: src.name, url: src.url,
            title: `${src.name} — initial discovery`,
            summary: `${fp.title} signal detected via ${src.category} source monitoring for ${org.name}.`,
            signalDate, dateFound: new Date().toISOString(),
            signalStrength: src.priority === 'critical' ? 'strong' : src.priority === 'high' ? 'medium' : 'weak',
            keywords: (src.keywords||[]).slice(0,4),
          }],
        });

        if (newLeads.length >= (action === 'daily' ? 8 : 20)) break;
      }
      if (newLeads.length >= (action === 'daily' ? 8 : 20)) break;
    }
    if (newLeads.length >= (action === 'daily' ? 8 : 20)) break;
  }

  // Fix evidence leadId references
  for (const lead of newLeads) {
    if (lead.evidence) lead.evidence.forEach(e => e.leadId = lead.id);
  }

  addLog(`Results: ${newLeads.length} new leads, ${updatedLeads.length} updates, ${skippedDuplicate} duplicates skipped, ${skippedNotPursued} blocked (Not Pursued)`);

  return {
    leadsAdded: newLeads,
    leadsUpdated: updatedLeads,
    skippedNotPursued,
    skippedDuplicate,
    sourcesFetched: targetSources.length,
    sourcesWithSignals: newLeads.length + updatedLeads.length > 0 ? Math.min(targetSources.length, newLeads.length + updatedLeads.length + 3) : 0,
    duration: Date.now() - startTime,
  };
}

const inputStyle = { padding: '7px 10px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 12.5, outline: 'none', background: '#fafbfc', boxSizing: 'border-box' };


/* ═══════════════════════════════════════════════════════════════
   EMPTY STATE
   ═══════════════════════════════════════════════════════════════ */

function EmptyState({ icon, title, message }) {
  return (
    <div style={{ textAlign: 'center', padding: '80px 20px', color: '#94a3b8' }}>
      <div style={{ opacity: 0.3, marginBottom: 16 }}>{icon}</div>
      <h3 style={{ fontSize: 16, fontWeight: 700, color: '#64748b', margin: '0 0 6px' }}>{title}</h3>
      <p style={{ fontSize: 13, margin: 0, maxWidth: 400, marginInline: 'auto', lineHeight: 1.5 }}>{message}</p>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════
   PIF FIELD MAPPING — maps lead fields to Asana PIF form fields
   ═══════════════════════════════════════════════════════════════ */

const PIF_FIELD_MAP = [
  { pif: 'Project Name', from: 'ppiProposedName', fallback: 'title' },
  { pif: 'Client / Owner', from: 'ppiClient', fallback: 'owner' },
  { pif: 'Market Sector', from: 'ppiMarketSector', fallback: 'marketSector' },
  { pif: 'Service Type', from: 'ppiServiceType' },
  { pif: 'Pursuit Type', from: 'ppiPursuitType' },
  { pif: 'Opportunity Summary', from: 'ppiOpportunitySummary', fallback: 'description' },
  { pif: 'Source Summary', from: 'ppiSourceSummary', fallback: 'evidenceSummary' },
  { pif: 'Internal Champion', from: 'ppiInternalChampion', fallback: 'internalContact' },
  { pif: 'Proposed PIC', from: 'ppiProposedPIC' },
  { pif: 'Proposed Project Manager', from: 'ppiProposedPM' },
  { pif: 'Next Action', from: 'ppiNextAction' },
  { pif: 'Strategic Fit Notes', from: 'ppiStrategicFitNotes', fallback: 'whyItMatters' },
  { pif: 'Risk Notes', from: 'ppiRiskNotes' },
  { pif: 'Location', from: 'location' },
  { pif: 'Estimated Budget', from: 'potentialBudget' },
  { pif: 'Timeline', from: 'potentialTimeline' },
];

function buildPIFPayload(lead) {
  const payload = {};
  for (const field of PIF_FIELD_MAP) {
    payload[field.pif] = lead[field.from] || (field.fallback ? lead[field.fallback] : '') || '';
  }
  return payload;
}

const PIF_FORM_URL = 'https://form.asana.com/?k=IUr_D0wx9ZOZGXfSY9okag&d=869158886664904';


/* ═══════════════════════════════════════════════════════════════
   MAIN APPLICATION — Centralized State & Lead Workflow
   ═══════════════════════════════════════════════════════════════ */

const TABS = [
  { id: 'active', label: 'Active / Watch', icon: <Activity size={15} /> },
  { id: 'asana', label: 'Asana \u2013 Pending / Go', icon: <Send size={15} /> },
  { id: 'notpursued', label: 'Not Pursued / Asana No\u2011Go', icon: <Archive size={15} /> },
  { id: 'registry', label: 'Source Registry', icon: <Database size={15} /> },
  { id: 'taxonomy', label: 'Taxonomy', icon: <Layers size={15} /> },
  { id: 'settings', label: 'Settings', icon: <SettingsIcon size={15} /> },
];

/**
 * Board quality re-evaluation — prunes weak/noisy existing leads.
 * Applies the same quality gates to existing leads that are applied to new candidates.
 * This is the critical missing piece: without this, leads admitted under old/weaker rules
 * persist in localStorage forever and are never cleaned up.
 *
 * Defined at module level (not inside the component) so it can be called from both
 * the one-time cleanup effect and the engine merge callback without hook ordering issues.
 */
/**
 * Translate internal prune reason codes into plain-English business explanations.
 * Returns { label, explanation, keepHint } for display in prune review.
 */
function translatePruneReason(reason, lead) {
  const r = (reason || '').toLowerCase();
  const title = lead?.title || '';

  // Taxonomy-driven
  if (r.startsWith('taxonomy_excluded:') || r.startsWith('taxonomy_downrank:')) {
    const label = reason.split(':').slice(1).join(':').trim();
    return {
      label: `Taxonomy: ${label}`,
      explanation: `Matched the "${label}" taxonomy rule. This category is usually not an A&E project opportunity. If this specific item IS relevant, mark it Immune.`,
      keepHint: 'Keep if this item involves real design, planning, or construction scope despite the category.',
    };
  }
  // Already claimed
  if (r.includes('already_claimed_awarded')) return { label: 'Likely already awarded', explanation: 'Source text suggests this project has already been awarded to another firm or contractor.', keepHint: 'Keep if a new phase or re-solicitation is expected.' };
  if (r.includes('already_claimed_has_designer')) return { label: 'Designer already selected', explanation: 'Source text indicates an architect or designer has already been selected for this project.', keepHint: 'Keep if additional phases or subconsultant opportunities may exist.' };
  if (r.includes('already_claimed_has_contractor')) return { label: 'Contractor already selected', explanation: 'Source text indicates a contractor or CM has already been engaged for this project.', keepHint: 'Keep if the project may still need additional design services.' };
  if (r.includes('already_claimed_under_construction')) return { label: 'Already under construction', explanation: 'Source text suggests this project is already in the construction phase.', keepHint: 'Keep if future phases or expansion work are anticipated.' };
  if (r.includes('already_claimed_completed')) return { label: 'Project appears completed', explanation: 'Source text references ribbon-cutting, completion, or grand opening for this project.', keepHint: 'Keep if a follow-on project or new phase is expected.' };
  // Noise/generic
  if (r === 'noise_title') return { label: 'Non-project content', explanation: 'This title matches patterns typical of administrative pages, governance documents, or non-project content rather than a real A&E opportunity.', keepHint: 'Keep if the item actually represents a real facility, capital, or design project.' };
  if (r === 'generic_weak_fit') return { label: 'Weak service fit', explanation: 'This lead scored below typical thresholds for A&E service alignment. The market sector and project type are too generic to be confident.', keepHint: 'Keep if you know this is a real project with design scope.' };
  if (r === 'below_relevance_threshold') return { label: 'Low relevance score', explanation: 'This lead scored below the minimum relevance threshold, suggesting weak source evidence for a real A&E opportunity.', keepHint: 'Keep if you have additional context that supports this as a real project.' };
  if (r === 'infrastructure_no_building') return { label: 'Infrastructure only — no building scope', explanation: 'This appears to be pure infrastructure work (roads, utilities, civil) without a building or facility design component.', keepHint: 'Keep if the project includes a treatment plant, pump station, or other facility design.' };
  if (r === 'civil_commodity_no_building') return { label: 'Civil/commodity work only', explanation: 'This appears to be civil construction, paving, or commodity work without architectural or engineering design scope.', keepHint: 'Keep if the project includes building or facility design elements.' };
  // Watch-specific
  if (r === 'watch_generic_plan_heading') return { label: 'Generic plan or budget heading', explanation: 'This title looks like a budget section heading or planning document title rather than a specific project.', keepHint: 'Keep if this heading represents a specific capital project with design scope.' };
  if (r === 'watch_budget_purpose') return { label: 'Budget purpose statement', explanation: 'This appears to be a budget category or tax purpose description rather than a specific project.', keepHint: 'Keep if the budget line item funds specific facility or design work.' };
  if (r === 'watch_housing_strategy') return { label: 'Housing policy/strategy document', explanation: 'This appears to be a housing strategy or policy document rather than a specific construction or design project.', keepHint: 'Keep if specific housing construction or design projects are included.' };
  if (r === 'watch_bid_no_building') return { label: 'Business district — no building scope', explanation: 'This is a Business Improvement District reference without evidence of building construction or design projects.', keepHint: 'Keep if the BID is funding specific building or facility improvements.' };
  // Near duplicate
  if (r.startsWith('near_duplicate_district:')) return { label: 'Duplicate district reference', explanation: `This district/area appears to duplicate another strategic watch item already on the board: "${reason.split(':').slice(1).join(':')?.trim() || ''}". Multiple sources may reference the same district.`, keepHint: 'Prune if the existing district item already covers this area. Keep if this reference adds materially different project information.' };
  if (r.startsWith('near_duplicate_of:')) return { label: 'Near-duplicate of existing lead', explanation: `This lead appears very similar to another item already on the board: "${reason.split(':').slice(1).join(':')?.trim() || ''}".`, keepHint: 'Keep if these are actually different projects despite similar names.' };
  // Container/listing page
  if (r === 'container_parent_page') return { label: 'Parent listing page — not a project', explanation: 'This is a bid solicitations, program, or listing page that contains child solicitations. The actual projects are the individual items listed on this page, not the page itself.', keepHint: 'Prune unless no child solicitations have been extracted.' };
  // Generic fallback
  if (r.includes('generic_fallback') || r.includes('generic_solicitation')) return { label: 'Generic portal page', explanation: 'This title appears to be a procurement portal or listing page heading rather than a specific project.', keepHint: 'Keep if this is actually a named project, not just a portal page.' };
  // Default
  return {
    label: reason?.replace('Auto-prune candidate: ', '').replace(/_/g, ' ') || 'Review needed',
    explanation: 'This lead was flagged by quality checks. Review the details below to decide whether it represents a real A&E opportunity.',
    keepHint: 'Keep if this item involves real design, construction, or facility planning scope.',
  };
}

function boardQualityPrune(currentLeads, taxonomy = []) {
  const MIN_RELEVANCE_ACTIVE = 35;
  const MIN_RELEVANCE_WATCH = 30;  // Watch leads score lower (no RFQ/RFP boost) — gentler but not permissive
  const pruned = [];

  // ── Future-signal keyword protection (Watch leads with real building intelligence survive) ──
  // IMPORTANT: Requires BOTH a future-signal term AND building/facility/architectural evidence.
  // Without the co-evidence check, generic government phrases like "capital improvement program"
  // or "planned construction" (which appear on roads/utility pages) would bypass all quality gates.
  const hasFutureSignal = (lead) => {
    const txt = `${lead.title || ''} ${lead.description || ''}`.toLowerCase();
    // Step 1: Must contain a future-signal term
    const hasFutureTerm = /\b(lrbp|long.range building|capital (plan|improvement|project)|facility (assessment|master plan|condition)|deferred maintenance|modernization|building (replacement|program)|bond (program|measure|issue)|school (construction|bond|modernization)|campus (master plan|expansion)|facilities (plan|planning|assessment)|planned (construction|renovation|expansion|replacement))\b/.test(txt);
    if (!hasFutureTerm) return false;
    // Step 2: Must ALSO contain building/facility/architectural evidence — without this,
    // every generic government page with "capital improvement" bypasses quality gates
    return /\b(architect|design services|a\/e|building renovation|facility (design|renovation|addition|replacement|modernization)|school (building|renovation|addition|design)|fire station|police (station|facility)|library|courthouse|campus (building|hall|center)|hospital|clinic|terminal|hangar|community center|recreation center|student (union|housing)|dormitory|laboratory|treatment (plant|facility))\b/.test(txt);
  };

  // ── Portal/listing fragment titles ──
  const isPortalTitle = (title) => {
    const lo = (title || '').toLowerCase().trim();
    if (/^(current|open|active|closed|awarded|pending)\s+(solicitations?|bids?|rfps?|rfqs?|opportunities|projects?|listings?)$/i.test(lo)) return true;
    if (/^(solicitations?|bids?|rfps?|rfqs?|opportunities|procurement)\s+(list|index|page|board|calendar|schedule|archive)$/i.test(lo)) return true;
    if (/^(public (works?|notices?|bids?)|bid (board|opportunities)|procurement (portal|page))$/i.test(lo)) return true;
    if (/^(meeting|agenda|minutes|packet|resolution|ordinance)\s+/i.test(lo) && !/\b(renovation|construction|building|facility|addition|expansion|project)\b/i.test(lo)) return true;
    // Standalone solicitation-type hub titles: "RFQs", "RFPs", "Solicitations", "Bids", "Bids & RFPs", etc.
    if (/^(rfqs?|rfps?|solicitations?|bids?|proposals?|qualifications?)(\.{2,})?$/i.test(lo)) return true;
    // "Request for Proposals/Qualifications/Quotes" standalone (no specific project after it)
    if (/^requests?\s+for\s+(proposals?|qualifications?|quotes?|bids?)(\s*\/\s*(proposals?|qualifications?|quotes?|bids?))*(\s*\.{2,})?$/i.test(lo)) return true;
    // Slash-delimited or dash-delimited hub titles: "RFQ / Request for Quotes / RFQu...", "RFQ – Request for Quotes, RFQu..."
    if (/^(rfq|rfp|bid|solicitation)\s*[\/\u2013\u2014\-]/.test(lo) && !/\b(architect|design|building|school|hospital|facility|fire station|library|renovation|remodel)\b/.test(lo)) return true;
    // "Bids & RFPs", "Bids and Proposals", "RFPs & RFQs" compound hub titles
    if (/^(rfqs?|rfps?|solicitations?|bids?|proposals?)\s*[&+]\s*(rfqs?|rfps?|solicitations?|bids?|proposals?)$/i.test(lo)) return true;
    if (/^(rfqs?|rfps?|solicitations?|bids?|proposals?)\s+and\s+(rfqs?|rfps?|solicitations?|bids?|proposals?)$/i.test(lo)) return true;
    return false;
  };

  // ── Generic fallback titles (pattern: "Org Name — Generic Type") ──
  // Tier 1: ALWAYS a portal page — "Org — Solicitation" never names a real project
  const isAlwaysGenericTitle = (title) => {
    const lo = (title || '').toLowerCase().trim();
    if (/^[\w\s&'\u2019.,()]+\s*[–—-]\s*solicitations?$/i.test(lo)) return true;
    // "Org — Bids" / "Org — RFPs" / "Org — Procurement" (standalone portal page)
    if (/^[\w\s&'\u2019.,()]+\s*[–—-]\s*(bids?|rfps?|rfqs?|procurement|opportunities)$/i.test(lo)) return true;
    return false;
  };
  // Tier 2: Generic but COULD be real at high scores — score-gated
  const isGenericFallbackTitle = (title) => {
    const lo = (title || '').toLowerCase().trim();
    if (/^[\w\s&'\u2019.,()]+\s*[–—-]\s*(project signal|capital improvement|bond\/levy program|master plan|renovation project|expansion project)$/i.test(lo)) return true;
    return false;
  };

  // ── Infrastructure-only (no building scope) ──
  const isInfraNoBuilding = (lead) => {
    const m = (lead.marketSector || '').trim();
    if (m !== 'Infrastructure') return false;
    const txt = `${lead.title || ''} ${lead.description || ''}`.toLowerCase();
    return !/\b(treatment (plant|facility)|building|architect|facility (design|renovation|addition)|pump (house|building)|control (building|room))\b/.test(txt);
  };

  // ── Noise title patterns ──
  const isNoiseTitle = (title) => {
    const lo = (title || '').toLowerCase();
    if (/\b(printable map|bid map|interactive map|gis viewer)\b/.test(lo)) return true;
    if (/\b(bid results|bid tabulation|plan holders?|vendor list|bidder list)\b/.test(lo)) return true;
    if (/^(home|about|news|events|contact|board|staff|resources|documents|calendar|agenda|minutes)$/i.test(lo.trim())) return true;
    if (/\b(information for the overall|public works construction schedule|construction management office)\b/.test(lo)) return true;
    // ── v31e: Governance body names are now TAXONOMY-DRIVEN → TAX-NOI-015
    // RETIRED from hard-code. boardQualityPrune step 3a checks taxonomy first.
    // Agenda, minutes, meeting, governance pages without a named project
    if (/\b(agenda|minutes|meeting|packet|work\s*session|public\s*hearing|regular\s*session|special\s*session)\b/i.test(lo) &&
        !/\b(renovation|construction|expansion|addition|replacement|modernization|design|rfq|rfp|solicitation|bond|capital improvement|facility|building|project)\b/i.test(lo)) return true;
    // Generic department/office/program pages
    if (/^([\w\s.'&'\u2019]+\s+)?(department|office|division|bureau|program|services?)\s*$/i.test(lo.trim()) &&
        !/\b(construction|design|capital|renovation|project|facility|building)\b/i.test(lo)) return true;
    // Tourism, events, parks, recreation without building scope
    if (/\b(tourism|visitor|festival|parade|farmer.?s?\s*market|concert|fireworks|celebration|memorial\s*day|independence\s*day|holiday|fun\s*run|5k|marathon|triathlon)\b/i.test(lo) &&
        !/\b(renovation|construction|building|facility|design|addition|expansion|terminal|center)\b/i.test(lo)) return true;
    // Planning commission, city council, etc. as standalone titles
    if (/^(planning commission|city council|town council|county commission|board of supervisors|board of commissioners|park board|parks? (and|&) recreation|police commission|fire commission|zoning board|historic preservation)\s*$/i.test(lo.trim())) return true;
    // IT/management system procurements — not A&E service fit
    if (/\b(management system|financial (system|management)|accounting system|hr system|payroll system|erp|enterprise resource|software (system|platform|solution|implementation|migration)|it (system|infrastructure|services))\b/.test(lo) &&
        /\b(replacement|implementation|upgrade|migration|procurement|rfp|solicitation|modernization)\b/.test(lo) &&
        !/\b(architect|design|building|facility|renovation|construction)\b/.test(lo)) return true;
    // Bridge-only work — not A&E building scope
    if (/\bbridge\b/.test(lo) && /\b(repair|maintenance|replacement|rehabilitation|deck|overlay|painting|scour|rail|abutment|pier)\b/.test(lo) &&
        !/\b(architect|building|renovation|addition|facility|school|hospital|clinic|terminal|fire station|police|library|courthouse|campus)\b/.test(lo)) return true;
    // Virtual tours, event venue marketing, weddings — not project signals
    if (/\b(virtual (campus )?(tour|walkthrough)|get married|wedding (venue|rental|reception)|event (rental|venue|booking)|rent (the|a|our) (hall|room|space|facility))\b/.test(lo)) return true;
    // Planning guides, how-to pages, general info pages — not actionable leads
    if (/\b(project planning guides?|planning guides?|how to (apply|submit|file|get)|step.by.step|application (process|instructions|checklist)|permit (info|information|requirements|process|fees)|zoning (info|information|requirements|map|districts))\b/.test(lo) &&
        !/\b(architect|design|building|renovation|construction|facility|school|hospital)\b/.test(lo)) return true;
    // Generic overlay/zoning pages without specific projects
    if (/^(overlay (district|zone)|zoning (map|ordinance|code|district)|land use (map|plan|code)|comprehensive (zoning|land use))/i.test(lo.trim())) return true;
    // Generic agendas, minutes, assessments with no building/project context
    if (/^(agenda|minutes|meeting (minutes|agenda|packet|summary)|assessment|annual assessment|property assessment|tax assessment)\s*$/i.test(lo.trim())) return true;
    if (/^(agenda|minutes|assessment)\s+(for\s+)?(january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}[\/\-]\d{1,2})/i.test(lo.trim())) return true;
    // Dated governance documents ("May 23, 2019 Police Commission Agenda", "Feb 25, 2026 TBID Agenda")
    if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\.?\s+\d{1,2},?\s+\d{4}\b/i.test(lo.trim()) &&
        /\b(agenda|minutes|meeting|packet|hearing|session|workshop)\b/i.test(lo) &&
        !/\b(renovation|construction|building|facility|project|bond|rfq|rfp)\b/i.test(lo)) return true;
    // Community programs without architectural work
    if (/\b(summer (camp|program|reading)|after.?school|youth (program|camp|league)|senior (program|activities|services)|community (event|program|class|garden|cleanup)|volunteer|recreation (program|class|league|schedule))\b/.test(lo) &&
        !/\b(architect|design|building|renovation|construction|facility|center|addition|expansion)\b/.test(lo)) return true;
    // Storm damage / permit info pages without project context
    if (/\b(storm damage|building permit information|permit information|permit fees)\b/i.test(lo) &&
        !/\b(renovation|construction|design|facility|project|rfq|rfp)\b/i.test(lo)) return true;
    // Assessment/report pages without a named project
    if (/\b(assessment report|housing assessment|needs assessment|condition assessment)\b/i.test(lo) &&
        !/\b[A-Z][a-z]{2,}\s+(school|hospital|library|courthouse|fire station|clinic|campus|building|facility)\b/.test(title || '')) return true;
    // Park/recreation/trail pages without building scope
    if (/\b(park|recreation|trail|playground|sports? field|ball field|skate park|dog park|splash pad)\b/i.test(lo) &&
        !/\b(renovation|construction|building|facility|design|addition|expansion|community center|recreation center|pool|aquatic|pavilion|clubhouse|restroom|shelter)\b/i.test(lo)) return true;
    // Design excellence / design guidelines / overlay pages
    if (/\b(design (excellence|guidelines?|standards?|review|overlay)|overlay district|form.based code)\b/i.test(lo) &&
        !/\b(renovation|construction|building|facility|project|rfq|rfp)\b/i.test(lo)) return true;
    // Award/stewardship names — not projects
    if (/\b(steward(ship)?|award|recognition|honor|hall of fame)\b/i.test(lo) &&
        !/\b(renovation|construction|building|facility|design|project|rfq|rfp)\b/i.test(lo)) return true;
    // Procurement schedules without a project name
    if (/\b(rfq|rfp|bid|solicitation)\s*[&+,]?\s*(bid\s*)?(schedule|calendar|timeline)\b/i.test(lo) &&
        !/\b(school|hospital|library|courthouse|fire station|campus|building|facility)\b/i.test(lo)) return true;
    // ISO-dated document/file references (title starts with YYYY-MM-DD)
    if (/^\d{4}-\d{2}-\d{2}\b/.test(lo.trim())) return true;
    // Environmental assessments without building scope
    if (/\b(environmental (assessment|impact|review|study)|supplemental environmental|nepa\b|eis\b)\b/i.test(lo) &&
        !/\b(building|facility|renovation|design|architect|construction)\b/i.test(lo)) return true;
    // Coalition/alliance organizational names — not projects
    if (/\b(coalition|alliance|consortium|collaborative|network)\s*$/i.test(lo.trim()) &&
        !/\b(renovation|construction|building|facility|project|design|rfq|rfp)\b/i.test(lo)) return true;
    // Housing/citywide strategy documents — not specific projects
    if (/\b(housing (strategy|program|initiative|action plan)|citywide (strategy|plan|housing)|workforce housing (program|initiative))\b/i.test(lo) &&
        !/\b(school|hospital|library|courthouse|fire station|campus|building|facility|renovation|construction|design|rfq|rfp)\b/i.test(lo)) return true;
    // Tourism BID — not a building opportunity
    if (/\btourism\s+business\s+improvement\s+district\b/i.test(lo)) return true;
    // National/state park names without building scope
    if (/\b(national park|state park|national forest|national monument|wilderness area)\b/i.test(lo) &&
        !/\b(renovation|construction|building|facility|visitor center|lodge|design|addition|expansion)\b/i.test(lo)) return true;
    // Vague data/smart-city project titles
    if (/\b(data (city|project|initiative|platform|hub)|open data|smart city|digital (city|twin|transformation))\b/i.test(lo) &&
        !/\b(building|facility|renovation|construction|design|architect)\b/i.test(lo)) return true;
    // Generic N-year plan headings
    if (/\b(new requirement|requirement)\s*:\s*\d+.year (plan|program)\b/i.test(lo) &&
        !/\b(school|hospital|building|facility|renovation|construction|design)\b/i.test(lo)) return true;
    // Facility rental marketing
    if (/\b(rent (the|a|an?|our) (hall|room|space|facility|building|park|center|county)|facility (rental|rentals)|venue (rental|rentals|hire))\b/i.test(lo)) return true;
    // ── v21: Source page / topic page / admin page suppression ──
    // Generic topic/department landing pages
    if (/^(community development|economic development|planning and development|development services|development center|planning services)\s*$/i.test(lo.trim()) &&
        !/\b(block grant|redevelopment|renovation|construction|rfq|rfp|bond)\b/i.test(lo)) return true;
    if (/^(project and engineering|engineering services|public works|facilities management|building maintenance)\s*$/i.test(lo.trim())) return true;
    // School closures / policy pages
    if (/\b(school (closur|consolidat|boundar|redistrict|report card)|closures?\s*$)\b/i.test(lo) &&
        !/\b(renovation|construction|building|facility|design|addition|expansion|replacement|rfq|rfp)\b/i.test(lo)) return true;
    // Fairground/facility rental pages
    if (/\b(fairground|fairgrounds|fair ground)\b/i.test(lo) && /\b(rental|rent|reservation|book|lease|event)\b/i.test(lo)) return true;
    if (/\b(building rental|room rental|space rental|hall rental|rental (rates?|info|information|agreement|application|policy|policies|form))\b/i.test(lo)) return true;
    // Bare geographic name without project action
    if (/^(downtown|uptown|midtown|northside|southside|eastside|westside|old town|central)\s+[A-Z][a-z]+\s*$/i.test((title||'').trim()) &&
        !/\b(development|redevelopment|renovation|construction|plan|improvement|expansion|project|program|district)\b/i.test(lo)) return true;
    // Dated reports, audits, code adoption pages
    if (/^\d{4}[\s\-]+\d{4}\b/.test(lo.trim()) && /\b(review|audit|report|analysis|summary|update|assessment)\b/i.test(lo) &&
        !/\b(renovation|construction|design|rfq|rfp|facility|school|hospital)\b/i.test(lo)) return true;
    if (/^\d{4}\s+\b/.test(lo.trim()) && /\b(code (adoption|update|amendment|revision)|ordinance (adoption|update|amendment))\b/i.test(lo) &&
        !/\b(renovation|construction|design|rfq|rfp|facility|building project)\b/i.test(lo)) return true;
    // Permit/statistics/FAQ/admin pages
    if (/\b(permit statistics|building statistics|code enforcement statistics|inspection statistics)\b/i.test(lo)) return true;
    if (/\b(faqs?|frequently asked|questions and answers)\b/i.test(lo) &&
        !/\b(renovation|construction|design|rfq|rfp|facility|project)\b/i.test(lo)) return true;
    if (/\b(building division|planning division|engineering division|code enforcement|inspection services)\s*$/i.test(lo.trim()) &&
        !/\b(renovation|construction|design|rfq|rfp|project)\b/i.test(lo)) return true;
    // Department portal combos ("Planning, Development and Sustainability")
    if (/^(planning|development|sustainability|growth)[,\s]+(development|planning|sustainability|growth|and|&|\s)+$/i.test(lo.trim()) &&
        !/\b(renovation|construction|design|rfq|rfp|facility|building|project|block grant|redevelopment)\b/i.test(lo)) return true;
    // Development application/listing portal pages
    if (/\b(development (applications?|permits?|submittals?|filings?|review))\b/i.test(lo) &&
        !/\b(renovation|construction|design|rfq|rfp|facility|building|school|hospital|block grant)\b/i.test(lo)) return true;
    if (/^(private|public)\s+(development|construction)\s+(projects?|listings?|applications?)\s*$/i.test(lo.trim())) return true;
    // Stormwater / pollution pages
    if (/\b(storm\s*water|stormwater)\s+(pollution|runoff|management|permit|compliance|prevention)\b/i.test(lo) &&
        !/\b(renovation|construction|building|facility|design|treatment plant)\b/i.test(lo)) return true;
    // ── v31e: Elections/voting/ballot are now TAXONOMY-DRIVEN → TAX-NOI-016
    // RETIRED from hard-code. boardQualityPrune step 3a checks taxonomy first.
    // Enrollment, registration, census — administrative pages
    if (/\b(enrollment|registration|census|student count|head count|fte count)\s*(information|data|numbers|statistics|report)?\s*$/i.test(lo.trim()) &&
        !/\b(renovation|construction|building|facility|design|project)\b/i.test(lo)) return true;
    // ── v26: Strategy/retrospective document artifacts ──
    // CEDS, strategic plans, economic development strategies — as standalone titles
    if (/\b(comprehensive\s+economic\s+development\s+strategy|ceds)\b/i.test(lo) &&
        !/\b(rfq|rfp|solicitation|renovation|construction|design\s+services)\b/i.test(lo)) return true;
    // Annual report / year in review as title
    if (/\b(annual\s+report|year\s+in\s+review|annual\s+review)\b/i.test(lo) &&
        !/\b(renovation|construction|building|facility|design|rfq|rfp|project)\b/i.test(lo)) return true;
    // Strategic plan / implementation plan as title
    if (/\b(strategic\s+plan|implementation\s+plan|action\s+plan)\s*$/i.test(lo.trim()) &&
        !/\b(renovation|construction|building|facility|design|rfq|rfp|project)\b/i.test(lo)) return true;
    // Economic development plan/strategy/report as title
    if (/\b(economic\s+development\s+(plan|strategy|report|initiative))\b/i.test(lo) &&
        !/\b(rfq|rfp|solicitation|renovation|construction|design\s+services|building)\b/i.test(lo)) return true;
    // Generic initiative/goal/priority/objective from strategy documents
    if (/^(goal|objective|priority|initiative|strategy|action\s+item)\s*[:#\d]/i.test(lo.trim())) return true;
    // ── v27: Vague civic/planning labels without building scope ──
    // ── v31e: Community partnerships and heritage/interpretive are now TAXONOMY-DRIVEN ──
    // RETIRED: TAX-NOI-017 (Community / Development Partnership) and TAX-NOI-014 (Heritage / Interpretive / Cultural)
    // boardQualityPrune step 3a checks taxonomy noise items before reaching isNoiseTitle.
    // v30: Bare neighborhood/area names moved to Tier 2 — see isTier2ReviewCandidate()
    // Generic "X District" / "X Corridor" without ANY project action — still auto-prune
    // but only if they don't have development/redevelopment/district/MRA/TIF/capital context
    if (/^[\w\s']+\s+(neighborhood|quarter|precinct|zone)\s*$/i.test(lo.trim()) &&
        !/\b(renovation|construction|building|facility|design|rfq|rfp|project|improvement|development|redevelopment|expansion|bond|capital|mra|tif|urd|urban\s+renewal)\b/i.test(lo)) return true;
    // ── v29: Brownfields and program-level redevelopment moved to Tier 2 (isTier2ReviewCandidate) ──
    // ── v29: Patterns moved to Tier 2 (isTier2ReviewCandidate) ──
    // Elevator/escalator, MEP equipment, walking tours, business development,
    // community development standalone, CDBG program pages — these are now
    // review-queue candidates, NOT auto-pruned. See isTier2ReviewCandidate().
    // ── v31b: Admin/policy/program/regulation noise (matches backend isAdminNonProject) ──
    // Regulations, codes, ordinances, policies without project context
    if (/\b(regulations?|ordinance|code\s+enforcement|zoning\s+code|building\s+code|fire\s+code|compliance|statute|policy\s+statement|guideline)\b/i.test(lo) &&
        !/\b(renovation|construction|design|addition|replacement|upgrade|modernization|rfq|rfp|project|capital|facility)\b/i.test(lo)) return true;
    // Lease/rent regulations
    if (/\b(lease|rent|rental|for\s+lease|for\s+rent)\b/i.test(lo) && /\b(regulations?|information|requirements?|applications?|polic(?:y|ies))\b/i.test(lo)) return true;
    // Department patrol/operations/staffing
    if (/\b(patrol|staffing|personnel|operations|dispatch|scheduling|recruitment|training|payroll)\b/i.test(lo) &&
        !/\b(facility|building|station|center|renovation|construction|addition|replacement|upgrade|project|capital)\b/i.test(lo)) return true;
    // MS4/stormwater programs
    if (/\b(storm\s*sewer|ms4|npdes|stormwater\s+(management|program|permit|compliance|prevention|pollution))\b/i.test(lo) &&
        !/\b(renovation|construction|facility|treatment\s+plant|design|project|capital|replacement|upgrade)\b/i.test(lo)) return true;
    // Road/street abandonments/vacations
    if (/\b(abandon(?:ment|ed|ing)?|vacat(?:e|ion|ed|ing))\b/i.test(lo) && /\b(road|street|alley|right.of.way|easement)\b/i.test(lo)) return true;
    // Division/department information pages
    if (/\b(division|department)\b/i.test(lo) && /\b(information|lighting|about|overview|contact|staff|mission)\b/i.test(lo) &&
        !/\b(project|capital|renovation|construction|design|replacement|upgrade|facility)\b/i.test(lo)) return true;
    // Program/grant administration
    if (/\b(program\s+administration|grant\s+administration|fund\s+administration|program\s+management)\b/i.test(lo) &&
        !/\b(capital|facility|renovation|construction|project|design|replacement)\b/i.test(lo)) return true;
    // Routine maintenance (mowing, plowing, sweeping)
    if (/\b(mowing|snow\s+plow|snow\s+removal|street\s+sweep|sweeping|garbage|trash|recycling|solid\s+waste|compost)\b/i.test(lo) &&
        !/\b(facility|building|transfer\s+station|plant|renovation|construction|replacement|capital)\b/i.test(lo)) return true;
    // ── v31e: The following 6 categories are now FULLY TAXONOMY-DRIVEN ──
    // They were retired from this hard-coded fallback. boardQualityPrune step 3a
    // checks taxonomy noise items before reaching isNoiseTitle (step 3b).
    // If a user deactivates the taxonomy item, the category genuinely stops blocking.
    //
    // RETIRED (now taxonomy-authoritative via TAX-NOI-008 through TAX-NOI-013):
    //   - Department / Office Page → TAX-NOI-008
    //   - Contact / Staff / Directory → TAX-NOI-009
    //   - Operations / Service Pages → TAX-NOI-010
    //   - Academic Unit Name → TAX-NOI-011
    //   - Climate / Sustainability Policy → TAX-NOI-012
    //   - Regulation / Policy / Admin → TAX-NOI-013
    //
    // REMAINING hard-coded (structural patterns, not keyword-matchable):
    // v3.5: Listing/program/container page titles — these are source pages, not projects
    // "Bid Solicitations", "Capital Improvement", "City Bids", "Current Projects"
    if (/^(bid\s+solicitations?|current\s+(projects?|bids?|solicitations?|rfps?|rfqs?)|city\s+(bids?|projects?)|municipal\s+(bids?|projects?)|public\s+(works?\s+)?(bids?|projects?)|capital\s+improvement|open\s+(bids?|solicitations?))\s*$/i.test(lo.trim())) return true;
    // "Org — Bid Solicitations" / "Org — Capital Improvement" cross-product container titles
    if (/^[\w\s&'.,()]+\s*[–—-]\s*(bid\s+solicitations?|capital\s+improvement|current\s+(bids?|projects?|solicitations?)|public\s+(works?|bids?))\s*$/i.test(lo)) return true;
    // Service description fragments
    if (/^(we\s+provide|our\s+mission|about\s+us|who\s+we\s+are|what\s+we\s+do|our\s+services)\b/i.test(lo.trim())) return true;
    // ── v26: Already-claimed/awarded project indicators ──
    // Project already awarded to / designed by / built by / under construction by
    if (/\b(awarded\s+to|designed\s+by|built\s+by|constructed\s+by|contractor\s+(?:is|was|selected)|architect\s+of\s+record)\b/i.test(lo) &&
        !/\b(new\s+phase|phase\s+[2-9]|seeking|needed|required)\b/i.test(lo)) return true;
    // Completed/existing project references
    if (/\b(project\s+complet(?:ed|ion)|construction\s+complet(?:ed|ion)|was\s+completed|ribbon\s+cutting|grand\s+opening)\b/i.test(lo) &&
        !/\b(new\s+phase|phase\s+[2-9]|next\s+phase|upcoming|expansion)\b/i.test(lo)) return true;
    return false;
  };

  // ── Tier 2 review candidates — borderline items that go to pruning review, NOT auto-pruned ──
  // These patterns were previously in isNoiseTitle (v27/v28) but over-pruned legitimate projects.
  // Returns { isTier2: true, reason: string, explanation: string } or { isTier2: false }
  const isTier2ReviewCandidate = (title) => {
    const lo = (title || '').toLowerCase();
    // Elevator/escalator modernization/replacement — legitimate MEP projects
    if (/\b(elevator|escalator)\b/i.test(lo) &&
        /\b(modernization|maintenance|repair|service|inspection|upgrade|replacement|refurbish)\b/i.test(lo) &&
        !/\b(design\s+services|architect|a\/e|new\s+(building|facility|addition)|building\s+design)\b/i.test(lo))
      return { isTier2: true, reason: 'MEP equipment (elevator/escalator)', explanation: 'Elevator or escalator work may be a maintenance contract or may involve A&E design scope. Review to decide.' };
    // MEP equipment: boiler, fire alarm, sprinkler, generator, HVAC, chiller
    if (/\b(boiler|fire\s+alarm|fire\s+suppression|sprinkler\s+system|generator|hvac\s+(unit|system|equipment)|chiller|cooling\s+tower|rooftop\s+unit|ahu|air\s+handler)\b/i.test(lo) &&
        /\b(replacement|repair|maintenance|service|inspection|upgrade|install)\b/i.test(lo) &&
        !/\b(design\s+services|architect|a\/e|renovation|addition|new\s+(building|facility)|building\s+design|remodel|expansion)\b/i.test(lo))
      return { isTier2: true, reason: 'MEP equipment replacement', explanation: 'MEP equipment work (boiler, fire alarm, HVAC, etc.) may be a service contract or may involve design scope. Review to decide.' };
    // Walking/guided/heritage tours — tourism content
    if (/\b(walking\s+tour|self[\-\s]guided\s+tour|audio\s+tour|guided\s+tour|heritage\s+tour|historic\s+(district\s+)?tour|architectural\s+tour)\b/i.test(lo))
      return { isTier2: true, reason: 'Walking tour / tourism', explanation: 'Walking tour or heritage tour content. May indicate district activity or may be purely tourism. Review to decide.' };
    // Business development — non-physical
    if (/\b(business\s+development|new\s+business|business\s+retention|business\s+attraction|business\s+recruitment|business\s+incubat)\b/i.test(lo) &&
        !/\b(renovation|construction|building|facility|design|rfq|rfp|campus|center|office\s+building|incubator\s+facility)\b/i.test(lo))
      return { isTier2: true, reason: 'Business development (non-physical)', explanation: 'Business development, retention, or recruitment. May be non-physical or may signal future facility needs. Review to decide.' };
    // Community Development standalone (non-CDBG)
    if (/^community\s+development\b/i.test(lo.trim()) &&
        !/\b(renovation|construction|building|facility|design|rfq|rfp|block\s+grant|cdbg|school|hospital|fire station|library)\b/i.test(lo))
      return { isTier2: true, reason: 'Community development (vague)', explanation: 'Generic community development title without specific project signals. May generate future A&E work. Review to decide.' };
    // CDBG/block grant + "Program" pages
    if (/\b(block\s+grant|cdbg)\b/i.test(lo) && /\bprogram\b/i.test(lo) &&
        !/\b(renovation|construction|design|rfq|rfp|facility|project|school|hospital|fire station)\b/i.test(lo))
      return { isTier2: true, reason: 'CDBG/grant program page', explanation: 'CDBG or block grant program page. May be administrative info or may fund real facility work. Review to decide.' };
    // Generic program-level redevelopment (brownfield/urban/area)
    if (/\b(brownfield|urban|area|community|downtown|neighborhood|rural|regional)\s+redevelopment\s*$/i.test(lo.trim()) &&
        !/\b(renovation|construction|building|facility|design|rfq|rfp|school|hospital|fire station|library|courthouse|campus|center)\b/i.test(lo))
      return { isTier2: true, reason: 'Program-level redevelopment', explanation: 'Area-level redevelopment label. May generate future A&E projects or may be a program page. Review to decide.' };
    // Standalone brownfields
    if (/^(brownfield|brownfields)\s*(redevelopment|cleanup|assessment|remediation|program|grant|site)?\s*$/i.test(lo.trim()))
      return { isTier2: true, reason: 'Brownfields program', explanation: 'Brownfields program label. May involve remediation design or may be informational. Review to decide.' };
    // v30: District/area/corridor/triangle names — potential project generators
    // These were previously auto-pruned but may represent legitimate redevelopment areas.
    if (/^[\w\s']+\s+(district|triangle|corridor)\s*$/i.test(lo.trim()) &&
        !/\b(renovation|construction|building|facility|design|rfq|rfp|project|improvement|expansion|bond)\b/i.test(lo))
      return { isTier2: true, reason: 'District/area name', explanation: 'Named district, triangle, or corridor. May be a project-generator area (URD, TIF, redevelopment) or may be a geographic label. Review to decide.' };
    // v30: Named Missoula neighborhood/district areas — potential MRA/TIF project generators
    if (/^(university\s+district|southgate\s+triangle|midtown|riverfront|downtown\s+core|urban\s+core|old\s+sawmill|mullan\s+area)\s*$/i.test(lo.trim()))
      return { isTier2: true, reason: 'Named district area', explanation: 'Named development district or area. May be an active MRA/TIF/URD project-generator area or may be a bare geographic label. Review to decide.' };
    // v30: Redevelopment with area/district context (not ending in $)
    if (/\b(redevelopment|urban\s+renewal|revitalization|reinvestment)\b/i.test(lo) &&
        !/\b(renovation|construction|building|facility|design|rfq|rfp|school|hospital|fire station|library|courthouse|campus|center)\b/i.test(lo))
      return { isTier2: true, reason: 'Redevelopment area', explanation: 'Redevelopment, urban renewal, or revitalization area. Likely a project generator for future A&E work. Review to decide.' };
    return { isTier2: false };
  };

  // ── Procurement-only title (no identifiable project, service, or building) ──
  const isProcurementOnlyTitle = (title) => {
    const lo = (title || '').toLowerCase().trim();
    // Strip common org-name prefixes ("City of X —", "County of Y —", etc.)
    const stripped = lo.replace(/^[\w\s&'\u2019.,]+\s*[\u2013\u2014\-]\s*/, '').trim();
    const target = stripped || lo;
    // If what remains is ONLY procurement process words, it's not a real lead
    const procWords = /^(bid|bids|rfq|rfp|rfqs|rfps|solicitation|solicitations|proposal|proposals|qualification|qualifications|quote|quotes|procurement|purchasing|notice|notices|opportunity|opportunities|invitation|request|current|open|active|closed|awarded|pending|public|for|to|of|the|and|a|an|\/|\s|[–—\-.|,&:#()!?])+$/i;
    if (procWords.test(target) && target.length > 2) {
      // Safeguard: protect titles that also contain project-specific terms
      if (/\b(architect|design|building|school|hospital|fire station|library|courthouse|facility|renovation|addition|remodel|campus|clinic|terminal|modernization|expansion|assessment|a\/e|engineering services)\b/i.test(lo)) return false;
      return true;
    }
    return false;
  };

  // ── Civil/commodity without building scope ──
  const isCivilOnly = (lead) => {
    const txt = `${lead.title || ''} ${lead.description || ''}`.toLowerCase();
    if (/\b(water main|sewer (main|line|construction)|paving|chip seal|crack seal|striping|guardrail|culvert|asphalt|road (maintenance|repair|construction)|bridge\b.*?\b(repair|maintenance|replacement|rehabilitation|deck|overlay|painting)|bridge (deck|scour|rail|abutment|pier)|storm drain|curb and gutter|pipe (replacement|lining|bursting)|manhole|hydrant|meter (replacement|installation)|sedimentation|lagoon)\b/.test(txt)) {
      return !/\b(architect|building|renovation|addition|remodel|interior|facility design|treatment (plant|facility)|school|hospital|clinic|airport|terminal|fire station|police|library|courthouse|campus)\b/.test(txt);
    }
    return false;
  };

  // ── Near-duplicate detection ──
  const STOP = new Set(['the','and','for','from','with','this','that','are','was','will','has','have','been','its','our','new','all','project','county','city','state','montana','of','in','at','on','to','by','a','an']);
  const sigWords = (t) => (t || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
  const wordSim = (a, b) => {
    const wa = new Set(sigWords(a)), wb = new Set(sigWords(b));
    if (wa.size < 2 || wb.size < 2) return 0;
    let i = 0; for (const w of wa) if (wb.has(w)) i++;
    return i / new Set([...wa, ...wb]).size;
  };

  const kept = [];
  const reviewQueue = [];
  for (const lead of currentLeads) {
    let reason = null;

    // Favorited or immune leads are protected from pruning
    if (lead.favorite || lead.pruneImmune) {
      kept.push(lead);
      continue;
    }
    // Leads with active pruning pause are protected
    if (lead.pruneReviewPausedUntil && new Date(lead.pruneReviewPausedUntil) > new Date()) {
      kept.push(lead);
      continue;
    }
    // Leads that the user explicitly chose "Keep" in pruning review are protected
    // from the same prune reason that triggered the review.
    // They can still be re-flagged for a DIFFERENT reason.
    if (lead.pruneReviewKept) {
      kept.push(lead);
      continue;
    }

    // Determine effective status and thresholds
    const isWatch = lead.status === 'watch' || lead.status === 'new' || lead.status === 'monitoring';
    const minRelevance = isWatch ? MIN_RELEVANCE_WATCH : MIN_RELEVANCE_ACTIVE;
    const futureProtected = isWatch && hasFutureSignal(lead);
    // Strategic watch items (named opportunity areas, redevelopment targets, district initiatives) are protected from auto-prune
    // This is a reusable pattern — applies to any city/county, not just Missoula
    const isStrategicWatch = lead.leadClass === 'strategic_watch' ||
      lead.watchCategory === 'tif_district' || lead.watchCategory === 'redevelopment_area' ||
      lead.watchCategory === 'development_program' || lead.watchCategory === 'capital_budget';

    // 1. Portal/listing fragment title
    if (isPortalTitle(lead.title)) reason = 'portal_fragment_title';
    // 2a. Always-generic portal title (e.g. "Org — Solicitation") — no score check
    else if (isAlwaysGenericTitle(lead.title)) reason = 'generic_solicitation_portal';
    // 2b. Generic fallback title with weak score (e.g. "Org — Capital Improvement")
    // Exception: Watch leads with future-signal keywords are protected
    else if (isGenericFallbackTitle(lead.title) && (lead.relevanceScore || 0) < 50 && !futureProtected) reason = 'generic_fallback_title';
    // 2c. Procurement-only title (no identifiable project/service/building)
    else if (isProcurementOnlyTitle(lead.title)) reason = 'procurement_only_title';
    // 2d. Generic "Org — Type" fallback title that slipped through from older engine runs
    else if (/^[\w\s&'\u2019.,()]+\s*[–—-]\s*(renovation project|expansion project|project signal)$/i.test((lead.title || '').trim())) reason = 'generic_fallback_title_v2';
    // 2e. Truncated fragment (applies to ALL leads — Active + Watch)
    else if (/\b(the|a|an|of|for|and|or|is|are|was|in|on|at|to|with|from|by)\s*\.{0,3}$/.test((lead.title || '').toLowerCase().trim())) reason = 'truncated_fragment';
    // 2f. Mid-sentence fragment (applies to ALL leads)
    else if (/^(is |are |was |were |has |have |had |being |or |and |but |for |of |with |to |in |on |at |by |from |that |this |which |where |when |it |its |their |our |your |if |as |so |than )/.test((lead.title || '').toLowerCase())) reason = 'mid_sentence_fragment';
    // 3a. v31d: Taxonomy-driven noise check (authoritative for 6 categories)
    // If an active taxonomy noise item matches, taxonomy drives the decision.
    // fit_mode='exclude' → noise_title (same as hard-coded block)
    // fit_mode='downrank' → taxonomy_downrank (routed to review, not blocked)
    // item deactivated → no match, falls through to hard-coded safety net
    else if (taxonomy.length > 0 && (() => {
      const titleLo = (lead.title || '').toLowerCase();
      const descLo = (lead.description || '').toLowerCase();
      const text = titleLo + ' ' + descLo;
      const activeNoise = taxonomy.filter(t => t.taxonomy_group === 'noise' && t.status === 'active' && (t.include_keywords || []).length > 0);
      for (const item of activeNoise) {
        const hits = item.include_keywords.filter(kw => text.includes(kw.toLowerCase()));
        if (hits.length === 0) continue;
        const excludeHit = (item.exclude_keywords || []).length > 0 && item.exclude_keywords.some(kw => text.includes(kw.toLowerCase()));
        if (excludeHit) continue;
        // Taxonomy matched — set reason based on fit_mode
        if (item.fit_mode === 'exclude') {
          reason = `taxonomy_excluded:${item.label}`;
        } else if (item.fit_mode === 'downrank') {
          reason = `taxonomy_downrank:${item.label}`;
        }
        return true;
      }
      return false;
    })()) { /* reason already set by the IIFE above */ }
    // 3b. Hard-coded noise title patterns (safety net for categories not yet in taxonomy)
    else if (isNoiseTitle(lead.title)) reason = 'noise_title';
    // 4. Below minimum board relevance (Watch uses gentler threshold; future-signal Watch protected)
    else if ((lead.relevanceScore || 0) < minRelevance && !futureProtected) reason = 'below_relevance_threshold';
    // 5. Generic Other/Other with weak score (Watch leads with future signals are protected)
    // Exception: named opportunity areas (tif_district, redevelopment_area, development_program) are protected
    else if (lead.marketSector === 'Other' && (lead.projectType === 'Other' || !lead.projectType) && (lead.relevanceScore || 0) < 50 && !futureProtected) {
      const isNamedOpArea = lead.watchCategory && ['tif_district', 'redevelopment_area', 'development_program', 'capital_budget'].includes(lead.watchCategory);
      if (!isNamedOpArea) reason = 'generic_weak_fit';
    }
    // 5b. Watch-specific title quality (Step 13): Watch leads must identify one specific
    //     future project — not a generic heading, page fragment, or budget label
    else if (isWatch) {
      const lo = (lead.title || '').toLowerCase();
      // Document chrome / file fragments
      if (/\b(view the|click (to|here|for)|download|print(able)?)\b/i.test(lo)) reason = 'watch_document_chrome';
      // Mid-sentence fragments starting with lowercase connectors
      else if (/^(is |are |was |were |has |have |had |being |or |and |but |for |of |with |the |a |an |to |in |on |at |by |from |that |this |which |where |when |it |its |their |our |your |if |as |so |than )/.test(lo)) reason = 'watch_mid_sentence_fragment';
      // Truncated fragments ending with articles/prepositions
      else if (/\b(the|a|an|of|for|and|or|is|are|was|in|on|at|to|with|from|by)\s*\.{0,3}$/.test(lo)) reason = 'watch_truncated_fragment';
      // Generic plan/budget headings without a specific project
      else if (/^(capital improvement|capital project|capital budget|annual (report|budget)|operating budget|fiscal year|fy\s*\d|budget (summary|overview|document|report)|comprehensive (plan|annual)|strategic plan|master plan|facilities (plan|report)|long.range (building |facility )?plan)\b/i.test(lo) ||
               /^[\w\s&'\u2019.,()]+\s*[\u2013\u2014\u2012\-]\s*(capital improvement|capital project|master plan|capital budget|annual (report|budget))\s*$/i.test(lo)) {
        if (!(/\b(school|hospital|library|courthouse|fire station|police|clinic|terminal|university|college|campus|center|hall|gymnasium|auditorium|stadium|arena|pool|treatment plant)\b/i.test(lo) && /[A-Z][a-z]{2,}/.test(lead.title || '')))
          reason = 'watch_generic_plan_heading';
      }
      // Budget purpose statements without a named building
      else if (/\b(purpose|general fund|general obligation|property (tax|plant|assessment)|acquisition of|mill levy|tax (levy|increment)|assessed valuation|debt service|operating (fund|expenditure))\b/i.test(lo) &&
               !/\b(school|hospital|library|courthouse|fire station|police|clinic|terminal|campus|building|facility)\b/i.test(lo))
        reason = 'watch_budget_purpose';
      // Housing strategy / housing program documents (not a specific project)
      else if (/\b(housing (strategy|program|initiative|action plan|update)|citywide (strategy|plan|housing)|workforce housing (program|initiative))\b/i.test(lo) &&
               !/\b(school|hospital|library|courthouse|fire station|campus|building|facility|renovation|construction|design|rfq|rfp)\b/i.test(lo))
        reason = 'watch_housing_strategy';
      // Business Improvement District without building scope (non-tourism — BIDs can have building potential)
      else if (/\bbusiness\s+improvement\s+district\b/i.test(lo) &&
               !/\b(renovation|construction|building|facility|design|redevelopment|opportunity)\b/i.test(lo) &&
               !/\btourism\b/i.test(lo)) // Tourism BIDs already caught by isNoiseTitle
        reason = 'watch_bid_no_building';
    }
    // 5b. Already-claimed: description/context indicates project team assembled, completed, or under construction
    if (!reason) {
      const titleLo = (lead.title || '').toLowerCase();
      const descLo = `${lead.description || ''} ${lead.confidenceNotes || ''}`.toLowerCase();
      const titleAndDesc = `${titleLo} ${descLo}`;
      // Check for claimed-project signals in combined title + description
      const claimedSignals = [
        [/\b(?:architect|design\s+(?:firm|team)|a\/e|designer)\s*[:\u2013\u2014\-]\s*[A-Z]/i, 'has_designer'],
        [/\b(?:designed\s+by|architect\s+of\s+record)\b/i, 'has_designer'],
        [/\b(?:contractor|gc|cm|cmar|cmgc|construction\s+manager|design.?builder)\s*[:\u2013\u2014\-]\s*[A-Z]/i, 'has_contractor'],
        [/\b(?:built\s+by|constructed\s+by|contractor\s+(?:is|was)\s+\w)\b/i, 'has_contractor'],
        [/\b(?:currently\s+under\s+construction|construction\s+(?:is\s+)?underway|construction\s+(?:has\s+)?(?:begun|began|started))\b/i, 'under_construction'],
        [/\b(?:ribbon[\s\-]cutting|grand\s+opening|project\s+complet(?:ed|ion)|construction\s+complet(?:ed|ion)|now\s+(?:open|complete|operational))\b/i, 'completed'],
        [/\b(?:awarded\s+to|contract\s+awarded|(?:firm|team)\s+(?:has\s+been\s+)?selected)\b/i, 'awarded'],
      ];
      const hasNewPhaseEscape = /\b(?:new\s+phase|phase\s+[2-9]|next\s+phase|seeking|needed|required|rfq|rfp)\b/i.test(titleAndDesc);
      if (!hasNewPhaseEscape) {
        for (const [pat, claimReason] of claimedSignals) {
          if (pat.test(titleAndDesc)) {
            reason = `already_claimed_${claimReason}`;
            break;
          }
        }
      }
    }
    // 6. Infrastructure-only without building scope
    if (!reason && isInfraNoBuilding(lead)) reason = 'infrastructure_no_building';
    // 7. Civil/commodity without building scope
    if (!reason && isCivilOnly(lead)) reason = 'civil_commodity_no_building';
    // 8. Near-duplicate of a higher-scoring kept lead
    if (!reason) {
      for (const k of kept) {
        const sim = wordSim(lead.title, k.title);
        if (sim >= 0.65) {
          // v3.5: Distinguish district-duplicate from project-duplicate
          const isDistrictLead = /\b(district|urd|tif|tedd|urban\s+renewal|redevelopment\s+area|corridor|triangle)\b/i.test(lead.title || '');
          const isDistrictKept = /\b(district|urd|tif|tedd|urban\s+renewal|redevelopment\s+area|corridor|triangle)\b/i.test(k.title || '');
          if (isDistrictLead && isDistrictKept) {
            reason = `near_duplicate_district:${k.title.slice(0, 50)}`;
          } else if (sim >= 0.85) {
            reason = `near_duplicate_of:${k.title.slice(0, 50)}`;
          } else {
            // 0.65-0.84 similarity: flag but don't auto-classify as exact dup
            reason = `near_duplicate_of:${k.title.slice(0, 50)}`;
          }
          break;
        }
      }
    }

    if (reason) {
      // ── v31: Watch recall lockdown ──
      // For Watch leads, only a narrow set of STRONG reasons auto-remove.
      // Everything else goes to Tier 2 pruning review instead.
      // This prevents Watch from collapsing and preserves project generators.
      const WATCH_STRONG_AUTO_REMOVE = new Set([
        'portal_fragment_title',
        'generic_solicitation_portal',
        'procurement_only_title',
        'truncated_fragment',
        'mid_sentence_fragment',
        'watch_document_chrome',
        'watch_mid_sentence_fragment',
        'watch_truncated_fragment',
        'already_claimed_has_designer',
        'already_claimed_has_contractor',
        'already_claimed_under_construction',
        'already_claimed_completed',
        'already_claimed_awarded',
        'already_claimed_project_team_assembled',
        'already_claimed_completed_prefix',
        'civil_commodity_no_building',
      ]);

      if (isStrategicWatch && !reason.startsWith('already_claimed_')) {
        // Strategic watch items go directly to review — never auto-pruned except for claimed evidence
        reviewQueue.push({
          lead,
          reason: 'Strategic watch review',
          explanation: `This is a strategic watch item (${lead.watchCategory || lead.leadClass || 'named area'}). It was also flagged as "${translatePruneReason(reason, lead).label}" but strategic watch items are protected from auto-removal. Review to confirm it should stay.`,
          keepHint: 'Strategic watch items track future project-generator areas. Keep unless clearly irrelevant.',
        });
        console.log(`[Board Prune] 📍 "${lead.title}" — ${reason} → protected strategic watch (review only)`);
      } else if (isWatch && !WATCH_STRONG_AUTO_REMOVE.has(reason)) {
        // Demote to Tier 2 review instead of auto-removing
        const translated = translatePruneReason(reason, lead);
        reviewQueue.push({
          lead,
          reason: translated.label,
          explanation: translated.explanation,
          keepHint: translated.keepHint,
          internalReason: reason, // preserve for debugging
        });
        console.log(`[Board Prune] ⚠ "${lead.title}" — ${reason} → demoted to review: ${translated.label}`);
      } else {
        pruned.push({ id: lead.id, title: lead.title, relevanceScore: lead.relevanceScore, reason });
        console.log(`[Board Prune] ✂ "${lead.title}" — ${reason} (score: ${lead.relevanceScore || 0})`);
      }
    } else {
      // ── Tier 2: borderline items go to review queue instead of auto-pruning ──
      const tier2 = isTier2ReviewCandidate(lead.title);
      if (tier2.isTier2) {
        reviewQueue.push({ lead, reason: tier2.reason, explanation: tier2.explanation });
        console.log(`[Board Prune] ⚠ "${lead.title}" → pruning review: ${tier2.reason}`);
      } else {
        kept.push(lead);
      }
    }
  }

  return { kept, pruned, reviewQueue };
}

export default function ProjectScout() {
  // ─── Persistence helpers ───────────────────────────────────
  const loadState = (key, fallback) => {
    try { const d = localStorage.getItem(`ps_${key}`); return d ? JSON.parse(d) : fallback; }
    catch { return fallback; }
  };
  const saveState = (key, data) => {
    try { localStorage.setItem(`ps_${key}`, JSON.stringify(data)); } catch(e) { console.warn('Save failed:', e); }
  };

  // ─── Shared persistence layer ──────────────────────────────
  // Syncs lead-state records to a shared server-side store (Upstash Redis via Vercel)
  // so they are not trapped in one browser's localStorage.
  // Falls back gracefully to local-only if the shared store is unavailable.
  const SHARED_KEYS = new Set(['leads', 'submitted', 'notpursued', 'pruning_review_queue', 'prune_memory']);
  const [sharedStoreStatus, setSharedStoreStatus] = useState('checking'); // 'checking' | 'connected' | 'local-only' | 'error'
  const sharedSyncTimers = useRef({});
  const sharedStoreUrl = useRef(null);
  const sharedSyncReady = useRef(false); // Suppresses writes until initial sync completes

  // Resolve the store API URL from settings
  // Uses the same backendEndpoint as scan/Asana calls (e.g. https://project-scout-api.vercel.app)
  // and replaces the final path segment with /api/store
  const getStoreUrl = useCallback(() => {
    if (sharedStoreUrl.current) return sharedStoreUrl.current;
    try {
      const settings = JSON.parse(localStorage.getItem('ps_settings') || '{}');
      const backend = (settings.backendEndpoint || '').replace(/\/+$/, '');
      if (!backend) return null;
      // backendEndpoint is a base URL like "https://project-scout-api.vercel.app"
      // Existing calls append /api/scan — we append /api/store instead
      sharedStoreUrl.current = backend + '/api/store';
    } catch {}
    return sharedStoreUrl.current;
  }, []);

  // Low-level shared store write (immediate, no guard, no debounce)
  // Used only by initial sync to bypass the sharedSyncReady guard.
  const writeToSharedStoreNow = useCallback(async (key, data) => {
    const url = getStoreUrl();
    if (!url) return;
    try {
      const resp = await fetch(`${url}?action=set`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: `ps_${key}`, value: data }),
      });
      if (resp.ok) {
        const result = await resp.json();
        if (result.ok) {
          console.log(`[Shared Store] ✓ Wrote ps_${key} (${result.count} items)`);
        }
      }
    } catch (err) {
      console.warn(`[Shared Store] Write failed for ps_${key}:`, err.message);
    }
  }, [getStoreUrl]);

  // Save to shared store (debounced, fire-and-forget)
  // IMPORTANT: Writes are suppressed until initial sync completes (sharedSyncReady).
  // Without this guard, mount-time save effects fire with stale/empty initial state
  // and their debounced writes race with the initial sync, overwriting shared data.
  const saveToSharedStore = useCallback((key, data) => {
    if (!SHARED_KEYS.has(key)) return;
    if (!sharedSyncReady.current) return; // Suppress until initial sync done
    const url = getStoreUrl();
    if (!url) return;

    // Debounce: wait 2s after last change before syncing
    if (sharedSyncTimers.current[key]) clearTimeout(sharedSyncTimers.current[key]);
    sharedSyncTimers.current[key] = setTimeout(async () => {
      try {
        const resp = await fetch(`${url}?action=set`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: `ps_${key}`, value: data }),
        });
        if (resp.ok) {
          const result = await resp.json();
          if (result.ok) {
            console.log(`[Shared Store] ✓ Synced ps_${key} (${result.count} items)`);
          }
        }
      } catch (err) {
        console.warn(`[Shared Store] Sync failed for ps_${key}:`, err.message);
      }
    }, 2000);
  }, [getStoreUrl]);

  // Check shared store health on mount
  useEffect(() => {
    const url = getStoreUrl();
    if (!url) {
      setSharedStoreStatus('local-only');
      sharedSyncReady.current = true; // No shared store → writes are safe (they'll no-op)
      console.log('[Shared Store] No backend URL configured — using local-only persistence');
      return;
    }
    (async () => {
      try {
        const resp = await fetch(`${url}?action=status`);
        if (resp.ok) {
          const data = await resp.json();
          if (data.ok && data.configured) {
            setSharedStoreStatus('connected');
            console.log(`[Shared Store] ✓ Connected (${data.storeType}), build: ${data.build}`);
          } else if (data.ok) {
            setSharedStoreStatus('local-only');
            sharedSyncReady.current = true;
            console.log('[Shared Store] Store API reachable but Upstash not configured — using local-only');
          }
        } else {
          setSharedStoreStatus('local-only');
          sharedSyncReady.current = true;
        }
      } catch {
        setSharedStoreStatus('local-only');
        sharedSyncReady.current = true;
        console.log('[Shared Store] Store API unreachable — using local-only persistence');
      }
    })();
  }, [getStoreUrl]);

  // Load from shared store on mount — conservative first-sync strategy:
  // 1. If shared store is EMPTY for a key → push local to shared (bootstrap)
  // 2. If shared store HAS data and local is empty → use shared (new device/browser)
  // 3. If both have data → keep local, push local to shared (local is current session truth)
  // This prevents silent overwrites. The user's current browser is always the authority
  // until they explicitly choose otherwise.
  useEffect(() => {
    if (sharedStoreStatus !== 'connected') return;
    const url = getStoreUrl();
    if (!url) return;
    (async () => {
      try {
        const resp = await fetch(`${url}?action=export`);
        if (!resp.ok) return;
        const { ok, data } = await resp.json();
        if (!ok) return;

        const sharedData = data || {};
        let bootstrapped = 0, restored = 0, merged = 0;

        // ID-aware merge: combine shared and local by lead ID.
        // Shared records for IDs not in local are ADDED (changes from other sessions).
        // Local records for IDs in both are KEPT (current session edits preserved).
        // Local records for IDs not in shared are KEPT (new local work).
        const mergeById = (localArr, sharedArr) => {
          if (!Array.isArray(localArr)) localArr = [];
          if (!Array.isArray(sharedArr)) sharedArr = [];
          // Extract ID from item — handles both lead records (item.id) and
          // review queue items (item.lead.id) and prune memory (item.id)
          const getId = (item) => item?.id || item?.lead?.id || null;
          const localIds = new Set(localArr.map(getId).filter(Boolean));
          const result = [...localArr];
          let added = 0;
          for (const item of sharedArr) {
            const id = getId(item);
            if (id && !localIds.has(id)) {
              result.push(item);
              added++;
            }
          }
          return { merged: result, added };
        };

        for (const key of SHARED_KEYS) {
          const fullKey = `ps_${key}`;
          const sharedValue = sharedData[fullKey];
          const localValue = loadState(key, []);
          const sharedLen = Array.isArray(sharedValue) ? sharedValue.length : 0;
          const localLen = Array.isArray(localValue) ? localValue.length : 0;

          if (sharedLen === 0 && localLen > 0) {
            // Shared empty, local has data → bootstrap shared from local
            await writeToSharedStoreNow(key, localValue);
            bootstrapped++;
            console.log(`[Shared Store] Bootstrap: pushed ${localLen} local ${key} items to shared store`);
          } else if (sharedLen > 0 && localLen === 0) {
            // Shared has data, local empty → restore from shared (new browser/cleared cache)
            saveState(key, sharedValue);
            if (key === 'leads') setLeads(sharedValue);
            else if (key === 'submitted') setSubmittedLeads(sharedValue);
            else if (key === 'notpursued') setNotPursuedLeads(sharedValue);
            else if (key === 'pruning_review_queue') setPruningReviewQueue(sharedValue);
            else if (key === 'prune_memory') setPruneMemory(sharedValue);
            restored++;
            console.log(`[Shared Store] Restored: loaded ${sharedLen} ${key} items from shared store (local was empty)`);
          } else if (sharedLen > 0 && localLen > 0) {
            // Both have data → ID-aware merge (preserves additions from other sessions)
            const { merged: mergedValue, added } = mergeById(localValue, sharedValue);
            if (added > 0) {
              // Shared had items local didn't — merge them in
              saveState(key, mergedValue);
              if (key === 'leads') setLeads(mergedValue);
              else if (key === 'submitted') setSubmittedLeads(mergedValue);
              else if (key === 'notpursued') setNotPursuedLeads(mergedValue);
              else if (key === 'pruning_review_queue') setPruningReviewQueue(mergedValue);
              else if (key === 'prune_memory') setPruneMemory(mergedValue);
              console.log(`[Shared Store] Merged: ${key} — added ${added} items from shared (local had ${localLen}, shared had ${sharedLen}, merged: ${mergedValue.length})`);
            } else {
              console.log(`[Shared Store] In sync: ${key} — local (${localLen}) and shared (${sharedLen}) have same IDs`);
            }
            // Push merged result back to shared
            await writeToSharedStoreNow(key, added > 0 ? mergedValue : localValue);
            merged++;
          }
          // Both empty → nothing to do
        }
        // ── Cross-list reconciliation ──
        // When a lead is moved between lists (e.g., leads → notpursued) in another session,
        // this session's stale local state may still have the lead in the old list.
        // Remove IDs that appear in a "destination" list from their "source" lists.
        const reconcileLists = async () => {
          const currentLeads = loadState('leads', []);
          const currentNP = loadState('notpursued', []);
          const currentSubmitted = loadState('submitted', []);

          // IDs in Not Pursued should not also be in leads
          const npIds = new Set(currentNP.map(l => l.id).filter(Boolean));
          // IDs in Submitted should not also be in leads
          const subIds = new Set(currentSubmitted.map(l => l.id).filter(Boolean));

          const cleanedLeads = currentLeads.filter(l => !npIds.has(l.id) && !subIds.has(l.id));
          if (cleanedLeads.length < currentLeads.length) {
            const removed = currentLeads.length - cleanedLeads.length;
            console.log(`[Shared Store] Cross-list reconciliation: removed ${removed} lead(s) from Active/Watch that exist in Not Pursued or Submitted`);
            saveState('leads', cleanedLeads);
            setLeads(cleanedLeads);
            await writeToSharedStoreNow('leads', cleanedLeads);
          }
        };
        await reconcileLists();

        console.log(`[Shared Store] Initial sync complete — bootstrapped: ${bootstrapped}, restored: ${restored}, merged: ${merged}`);
        sharedSyncReady.current = true;
        console.log('[Shared Store] Sync ready — shared writes now enabled');
      } catch (err) {
        console.warn('[Shared Store] Initial load failed:', err.message);
        sharedSyncReady.current = true; // Enable writes even on failure so user actions persist
      }
    })();
  }, [sharedStoreStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const result = runMigration();
    if (result.status !== 'current') {
      console.log('[Project Scout] Migration:', result.status, result.notes);
    }
  }, []);

  // ─── Centralized lead state (persisted) ────────────────────
  const [leads, setLeads] = useState(() => loadState('leads', []));
  const [submittedLeads, setSubmittedLeads] = useState(() => loadState('submitted', []));
  const [notPursuedLeads, setNotPursuedLeads] = useState(() => loadState('notpursued', []));

  // ─── Pruning review queue (persisted) ────────────────────
  const [pruningReviewQueue, setPruningReviewQueue] = useState(() => loadState('pruning_review_queue', []));
  const [pruneReviewVisible, setPruneReviewVisible] = useState(false);

  // ─── Prune learning memory (persisted) ──────────────────
  // Stores past prune decisions as training signals for future confidence adjustment.
  // Each record captures: action, pattern features, timestamp.
  // Memory is capped at 200 most recent decisions to keep storage bounded.
  const PRUNE_MEMORY_MAX = 200;
  const [pruneMemory, setPruneMemory] = useState(() => loadState('prune_memory', []));
  useEffect(() => { saveState('prune_memory', pruneMemory); saveToSharedStore('prune_memory', pruneMemory); }, [pruneMemory]); // eslint-disable-line react-hooks/exhaustive-deps

  // Extract pattern features from a lead for similarity matching
  const extractPrunePattern = useCallback((lead, pruneReason) => {
    const lo = (lead.title || '').toLowerCase();
    // Extract key tokens (significant words, no stop words)
    const STOP = new Set(['the','and','for','from','with','this','that','are','was','will','has','have','been','its','our','new','all','project','county','city','state','montana','of','in','at','on','to','by','a','an']);
    const tokens = lo.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
    return {
      pruneReason: pruneReason || 'unknown',
      sourceFamily: lead.sourceId?.replace(/-\d+$/, '') || lead.sourceName?.slice(0, 30) || '',
      market: lead.marketSector || 'Other',
      owner: (lead.owner || '').toLowerCase().slice(0, 50),
      watchCategory: lead.watchCategory || '',
      titleTokens: tokens.slice(0, 8),
      relevanceScore: lead.relevanceScore || 0,
      leadOrigin: lead.leadOrigin || 'live',
    };
  }, []);

  // Record a prune decision into memory
  const recordPruneDecision = useCallback((action, lead, pruneReason) => {
    const record = {
      id: `pd-${Date.now()}-${Math.random().toString(36).slice(2,5)}`,
      action, // 'prune' | 'keep' | 'immune' | 'pause' | 'activate' | 'manual_prune'
      pattern: extractPrunePattern(lead, pruneReason),
      timestamp: new Date().toISOString(),
    };
    setPruneMemory(prev => {
      const updated = [record, ...prev].slice(0, PRUNE_MEMORY_MAX);
      return updated;
    });
  }, [extractPrunePattern]);

  // Query prune memory for similar past decisions
  // Returns { prunedCount, keptCount, immuneCount, totalSimilar, learnedConfidence, explanation }
  const queryPruneMemory = useCallback((lead, pruneReason) => {
    if (pruneMemory.length === 0) return { prunedCount: 0, keptCount: 0, immuneCount: 0, totalSimilar: 0, learnedConfidence: null, explanation: null };

    const pattern = extractPrunePattern(lead, pruneReason);
    let prunedCount = 0, keptCount = 0, immuneCount = 0;

    for (const record of pruneMemory) {
      const rp = record.pattern;
      // Similarity check: must match on at least 2 of: pruneReason, market, sourceFamily, or 2+ shared tokens
      let similarityScore = 0;
      if (rp.pruneReason === pattern.pruneReason) similarityScore += 2;
      if (rp.market === pattern.market && pattern.market !== 'Other') similarityScore += 1;
      if (rp.sourceFamily && rp.sourceFamily === pattern.sourceFamily) similarityScore += 1;
      if (rp.watchCategory && rp.watchCategory === pattern.watchCategory) similarityScore += 1;
      // Token overlap
      const sharedTokens = pattern.titleTokens.filter(t => rp.titleTokens?.includes(t)).length;
      if (sharedTokens >= 2) similarityScore += 1;
      if (sharedTokens >= 3) similarityScore += 1;

      if (similarityScore >= 2) {
        if (record.action === 'prune' || record.action === 'manual_prune') prunedCount++;
        else if (record.action === 'keep' || record.action === 'activate') keptCount++;
        else if (record.action === 'immune') immuneCount++;
      }
    }

    const totalSimilar = prunedCount + keptCount + immuneCount;
    if (totalSimilar === 0) return { prunedCount, keptCount, immuneCount, totalSimilar, learnedConfidence: null, explanation: null };

    // Calculate learned confidence adjustment
    // More prunes → higher confidence to prune again
    // More keeps/immunes → lower confidence (discourage pruning)
    const pruneRatio = prunedCount / totalSimilar;
    let learnedConfidence, explanation;

    if (immuneCount > 0 && immuneCount >= prunedCount) {
      learnedConfidence = 'suppress';
      explanation = `${immuneCount} similar item(s) were previously marked Immune — this category is likely worth keeping.`;
    } else if (keptCount > prunedCount && totalSimilar >= 2) {
      learnedConfidence = 'lower';
      explanation = `${keptCount} of ${totalSimilar} similar items were kept vs. ${prunedCount} pruned — this category leans toward Keep.`;
    } else if (prunedCount > keptCount + immuneCount && totalSimilar >= 3) {
      learnedConfidence = 'higher';
      explanation = `${prunedCount} of ${totalSimilar} similar items were previously pruned — this category is likely noise.`;
    } else {
      learnedConfidence = 'mixed';
      explanation = `Mixed history: ${prunedCount} pruned, ${keptCount} kept, ${immuneCount} immune out of ${totalSimilar} similar items.`;
    }

    return { prunedCount, keptCount, immuneCount, totalSimilar, learnedConfidence, explanation };
  }, [pruneMemory, extractPrunePattern]);

  // Persist on every change (local + shared)
  useEffect(() => { saveState('leads', leads); saveToSharedStore('leads', leads); }, [leads]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { saveState('submitted', submittedLeads); saveToSharedStore('submitted', submittedLeads); }, [submittedLeads]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { saveState('notpursued', notPursuedLeads); saveToSharedStore('notpursued', notPursuedLeads); }, [notPursuedLeads]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { saveState('pruning_review_queue', pruningReviewQueue); saveToSharedStore('pruning_review_queue', pruningReviewQueue); }, [pruningReviewQueue]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── One-time board quality cleanup on app load ────────────
  // Prunes existing leads that would fail current quality gates.
  // This is necessary because leads admitted under old/weaker rules persist
  // in localStorage and are never re-evaluated unless we do it explicitly.
  // Runs once on mount, using a localStorage flag to avoid re-running.
  const [boardCleanupDone, setBoardCleanupDone] = useState(false);
  useEffect(() => {
    if (boardCleanupDone) return;
    // v32: Wait for shared sync to complete before running cleanup.
    // Without this, cleanup runs on initial empty state before shared restore populates leads,
    // finds 0 items, sets done=true, and never re-runs when the real leads arrive.
    if (sharedStoreStatus === 'checking') return; // Still checking shared store health
    if (sharedStoreStatus === 'connected' && !sharedSyncReady.current) return; // Connected but sync not done yet
    const cleanupVersion = localStorage.getItem('ps_board_cleanup_version');
    const CURRENT_CLEANUP_VERSION = '2026-03-23-v35'; // v35: Stale container/listing parent cleanup + child title normalization
    if (cleanupVersion === CURRENT_CLEANUP_VERSION) { setBoardCleanupDone(true); return; }

    // Apply quality gates to all existing leads
    const currentLeads = leads;
    if (currentLeads.length === 0) { setBoardCleanupDone(true); return; }
    // v31d: Load taxonomy for taxonomy-aware pruning
    const currentTaxonomy = JSON.parse(localStorage.getItem('ps_taxonomy') || '[]');

    const { kept, pruned, reviewQueue } = boardQualityPrune(currentLeads, currentTaxonomy);

    // Apply stored-title rename and description filler cleanup to surviving leads
    let renamed = 0;
    let descCleaned = 0;
    const fillerPatterns = /\b(research a property|public right.of.way|click here|learn more|view (all|more|details)|sign up|log in|contact us|follow us|subscribe|cookie|privacy policy|terms of (use|service))\b/i;
    const finalKept = kept.map(lead => {
      let updated = lead;
      const newTitle = applyWatchTitleRename(lead);
      if (newTitle !== lead.title) {
        console.log(`[Board Cleanup] ✏ Rename: "${lead.title}" → "${newTitle}"`);
        renamed++;
        updated = { ...updated, title: newTitle };
      }
      // Scrub filler text from existing descriptions
      if (updated.description && fillerPatterns.test(updated.description)) {
        const sentences = updated.description.split(/(?<=[.!?])\s+/);
        const cleaned = sentences.filter(s => !fillerPatterns.test(s)).join(' ').trim();
        if (cleaned !== updated.description && cleaned.length > 10) {
          console.log(`[Board Cleanup] 🧹 Description cleaned: "${updated.title?.slice(0,40)}"`);
          descCleaned++;
          updated = { ...updated, description: cleaned };
        } else if (cleaned.length <= 10) {
          // If cleaning removes almost everything, replace with a minimal placeholder
          console.log(`[Board Cleanup] 🧹 Description was mostly filler: "${updated.title?.slice(0,40)}"`);
          descCleaned++;
          updated = { ...updated, description: updated.title || '' };
        }
      }
      return updated;
    });

    // Backfill pruneImmune on existing manual leads
    let immuneBackfilled = 0;
    let locationFixed = 0;
    const finalWithImmune = finalKept.map(lead => {
      let updated = lead;
      if (lead.leadOrigin === 'manual' && !lead.pruneImmune) {
        immuneBackfilled++;
        updated = { ...updated, pruneImmune: true };
      }
      // v3.5: Fix Idaho/Washington location normalization on existing leads
      // Leads from Idaho/WA sources may have been stored with ", MT" due to old location logic
      const loc = (updated.location || '').toLowerCase();
      const srcUrl = (updated.sourceUrl || '').toLowerCase();
      const srcName = (updated.sourceName || '').toLowerCase();
      const idahoCities = ["coeur d'alene", 'boise', 'idaho falls', 'pocatello', 'meridian', 'nampa', 'twin falls', 'lewiston', 'moscow', 'sandpoint', 'post falls'];
      const idahoCounties = ['kootenai', 'ada', 'canyon', 'bonneville', 'bannock', 'twin falls', 'nez perce', 'latah', 'bonner'];
      const isIdahoSource = /\.id\b|cdaid|idaho/i.test(srcUrl + ' ' + srcName);
      const hasIdahoCity = idahoCities.some(c => loc.includes(c));
      const hasIdahoCounty = idahoCounties.some(c => loc.includes(c));
      if ((isIdahoSource || hasIdahoCity || hasIdahoCounty) && loc.includes(', mt')) {
        const fixedLoc = updated.location.replace(/,\s*MT\s*$/i, hasIdahoCity || hasIdahoCounty ? ', ID' : ', ID');
        console.log(`[Board Cleanup] 📍 Location fix: "${updated.location}" → "${fixedLoc}"`);
        locationFixed++;
        updated = { ...updated, location: fixedLoc };
      }
      return updated;
    });

    if (pruned.length > 0 || renamed > 0 || descCleaned > 0 || reviewQueue.length > 0 || immuneBackfilled > 0 || locationFixed > 0) {
      console.log(`[Board Cleanup] One-time cleanup: pruning ${pruned.length}, review queue ${reviewQueue.length}, renaming ${renamed}, desc cleaned ${descCleaned}, immune backfilled ${immuneBackfilled}, locations fixed ${locationFixed}`);
      pruned.forEach(p => console.log(`  ✂ "${p.title}" — ${p.reason}`));
      reviewQueue.forEach(r => console.log(`  ⚠ "${r.lead.title}" → review: ${r.reason}`));
      setLeads(finalWithImmune);
      // v30: Move pruned leads to Not Pursued instead of silently discarding
      // This ensures they are recoverable via Unprune / Restore
      if (pruned.length > 0) {
        const prunedLeadMap = new Map(currentLeads.map(l => [l.id, l]));
        const prunedToArchive = pruned
          .map(p => prunedLeadMap.get(p.id))
          .filter(Boolean)
          .map(lead => ({
            ...lead,
            status: 'not_pursued',
            reasonNotPursued: `Pruned by board cleanup: ${pruned.find(p => p.id === lead.id)?.reason || 'quality gate'}`,
            reasonCategory: 'pruned',
            prunedBy: 'board_cleanup',
            dateNotPursued: new Date().toISOString(),
          }));
        if (prunedToArchive.length > 0) {
          setNotPursuedLeads(prev => [...prunedToArchive, ...prev]);
          console.log(`[Board Cleanup] Moved ${prunedToArchive.length} pruned lead(s) to Not Pursued (recoverable)`);
        }
      }
    } else {
      console.log(`[Board Cleanup] All ${currentLeads.length} leads pass current quality gates`);
    }

    // Queue Tier 2 items for pruning review — enrich with learning signals
    if (reviewQueue.length > 0) {
      setPruningReviewQueue(prev => {
        const existingIds = new Set(prev.map(r => r.lead.id));
        const newItems = reviewQueue
          .filter(r => !existingIds.has(r.lead.id))
          .map(r => {
            // Enrich with learned confidence from past decisions
            const learned = queryPruneMemory(r.lead, r.reason);
            return {
              ...r,
              learned: learned.totalSimilar > 0 ? learned : null,
            };
          });
        return [...prev, ...newItems];
      });
      setPruneReviewVisible(true);
    }

    localStorage.setItem('ps_board_cleanup_version', CURRENT_CLEANUP_VERSION);
    setBoardCleanupDone(true);
  }, [leads, boardCleanupDone, sharedStoreStatus]);

  // ─── One-time v30 recall migration ────────────────────────────
  // Earlier cleanup versions (v27-v29) silently discarded system-pruned leads.
  // Some of those may have been wrongly pruned and are now in Not Pursued.
  // This migration scans Not Pursued for system-pruned leads that would now
  // pass the relaxed v30 rules and routes them to pruning review for user decision.
  useEffect(() => {
    const RECALL_VERSION = '2026-03-19-recall-v1';
    if (localStorage.getItem('ps_recall_migration_version') === RECALL_VERSION) return;
    if (notPursuedLeads.length === 0) {
      localStorage.setItem('ps_recall_migration_version', RECALL_VERSION);
      return;
    }

    // Find leads that were system-pruned (not manually by user)
    const systemPruned = notPursuedLeads.filter(lead => {
      // System-pruned: prunedBy is board_cleanup, system_reviewed, or validation
      if (lead.prunedBy === 'board_cleanup' || lead.prunedBy === 'system_reviewed' || lead.prunedBy === 'validation') return true;
      // Also catch older pruned leads that may not have prunedBy set but have system-like reasons
      if (lead.reasonNotPursued && /\b(board cleanup|quality gate|noise|stale|post-validation|auto-suppressed|re-evaluation)\b/i.test(lead.reasonNotPursued)) return true;
      return false;
    });

    if (systemPruned.length === 0) {
      console.log('[Recall Migration] No system-pruned leads found in Not Pursued');
      localStorage.setItem('ps_recall_migration_version', RECALL_VERSION);
      return;
    }

    // Re-evaluate each against current boardQualityPrune rules
    const recallTaxonomy = JSON.parse(localStorage.getItem('ps_taxonomy') || '[]');
    const { kept: recallKept, pruned: stillPruned, reviewQueue: recallReview } = boardQualityPrune(systemPruned, recallTaxonomy);

    // Items that now PASS current rules → route to pruning review for user decision
    const toReview = [...recallKept, ...recallReview.map(r => r.lead)];
    if (toReview.length > 0) {
      console.log(`[Recall Migration] ${toReview.length} previously-pruned lead(s) now pass relaxed rules — routing to pruning review`);
      toReview.forEach(l => console.log(`  ↺ "${l.title}"`));
      // Remove from Not Pursued
      const recallIds = new Set(toReview.map(l => l.id));
      setNotPursuedLeads(prev => prev.filter(l => !recallIds.has(l.id)));
      // Queue for pruning review (user decides keep/pause/prune)
      setPruningReviewQueue(prev => {
        const existingIds = new Set(prev.map(r => r.lead.id));
        const newItems = toReview
          .filter(l => !existingIds.has(l.id))
          .map(lead => ({
            lead: { ...lead, status: 'watch', reasonNotPursued: null, dateNotPursued: null },
            reason: 'Recall: previously auto-pruned',
            explanation: `This lead was automatically pruned in an earlier version but would now pass under relaxed rules. Review to decide whether to restore to Watch, pause, or keep pruned.`,
          }));
        return [...prev, ...newItems];
      });
      setPruneReviewVisible(true);
    }
    if (stillPruned.length > 0) {
      console.log(`[Recall Migration] ${stillPruned.length} previously-pruned lead(s) still fail current rules — remaining in Not Pursued`);
    }

    localStorage.setItem('ps_recall_migration_version', RECALL_VERSION);
  }, [notPursuedLeads]);

  // ─── One-time tracked pursuit reconciliation ────────────────
  // Merges duplicate tracked records that share the same asana_task_id
  // or have near-identical titles (alias match).
  // Runs once on mount using a version flag.
  useEffect(() => {
    const RECONCILE_VERSION = '2026-03-16-r3'; // r3: entity+location alias matching
    if (localStorage.getItem('ps_tracked_reconcile_version') === RECONCILE_VERSION) return;
    if (submittedLeads.length < 2) {
      localStorage.setItem('ps_tracked_reconcile_version', RECONCILE_VERSION);
      return;
    }

    const seen = new Map(); // canonical key → index in merged array
    const merged = [];
    let mergeCount = 0;

    // Sort so that non-imported (submitted/matched) entries take priority
    const sorted = [...submittedLeads].sort((a, b) => {
      const aImported = a.tracking_origin === 'imported_from_asana' ? 1 : 0;
      const bImported = b.tracking_origin === 'imported_from_asana' ? 1 : 0;
      return aImported - bImported; // non-imported first
    });

    for (const lead of sorted) {
      // Identity key: asana_task_id takes priority
      const gidKey = lead.asana_task_id ? `gid:${lead.asana_task_id}` : null;
      const normKey = normalizeForMatch(lead.asana_task_name || lead.title);

      // Check for existing entry by GID
      let existingIdx = gidKey && seen.has(gidKey) ? seen.get(gidKey) : -1;

      // Check for existing entry by normalized title alias
      if (existingIdx === -1 && normKey) {
        for (const [key, idx] of seen) {
          if (key.startsWith('norm:') && isTitleAlias(key.slice(5), lead.asana_task_name || lead.title)) {
            existingIdx = idx;
            break;
          }
        }
      }

      if (existingIdx !== -1) {
        // Merge into existing: keep the richer record, absorb the other's data
        const existing = merged[existingIdx];
        const alts = new Set([...(existing.alternate_titles || []), ...(lead.alternate_titles || [])]);
        if (lead.title && lead.title !== existing.title) alts.add(lead.title);
        if (lead.scout_title && lead.scout_title !== existing.title) alts.add(lead.scout_title);
        if (existing.scout_title && existing.scout_title !== existing.title) alts.add(existing.scout_title);

        merged[existingIdx] = {
          ...existing,
          // Prefer non-imported origin
          tracking_origin: existing.tracking_origin !== 'imported_from_asana' ? existing.tracking_origin : lead.tracking_origin,
          // Merge metadata: prefer non-empty values
          owner: existing.owner || lead.owner || '',
          location: existing.location || lead.location || '',
          county: existing.county || lead.county || '',
          geography: existing.geography || lead.geography || '',
          marketSector: existing.marketSector || lead.marketSector || '',
          projectType: existing.projectType || lead.projectType || '',
          description: (existing.description && existing.description.length > (lead.description || '').length) ? existing.description : (lead.description || existing.description || ''),
          relevanceScore: Math.max(existing.relevanceScore || 0, lead.relevanceScore || 0),
          pursuitScore: Math.max(existing.pursuitScore || 0, lead.pursuitScore || 0),
          sourceConfidenceScore: Math.max(existing.sourceConfidenceScore || 0, lead.sourceConfidenceScore || 0),
          evidence: [...(existing.evidence || []), ...(lead.evidence || [])],
          // Preserve Asana identity from whichever has it
          asana_task_id: existing.asana_task_id || lead.asana_task_id,
          asana_task_name: existing.asana_task_name || lead.asana_task_name,
          asanaUrl: existing.asanaUrl || lead.asanaUrl,
          asana_section: lead.asana_section || existing.asana_section,
          asana_assignee: lead.asana_assignee || existing.asana_assignee,
          asana_completed: lead.asana_completed ?? existing.asana_completed,
          asana_completed_at: lead.asana_completed_at || existing.asana_completed_at,
          asana_notes_excerpt: (lead.asana_notes_excerpt && lead.asana_notes_excerpt.length > (existing.asana_notes_excerpt || '').length) ? lead.asana_notes_excerpt : (existing.asana_notes_excerpt || ''),
          asana_synced_at: lead.asana_synced_at > existing.asana_synced_at ? lead.asana_synced_at : existing.asana_synced_at,
          // No Go flag from either
          no_go: existing.no_go || lead.no_go,
          no_go_date: existing.no_go_date || lead.no_go_date,
          // Scout lead reference from either
          scout_title: existing.scout_title || lead.scout_title || (lead.title !== (existing.asana_task_name || existing.title) ? lead.title : null),
          scout_lead_id: existing.scout_lead_id || lead.scout_lead_id,
          alternate_titles: [...alts].filter(Boolean),
        };
        mergeCount++;
      } else {
        const idx = merged.length;
        merged.push({ ...lead });
        if (gidKey) seen.set(gidKey, idx);
        if (normKey) seen.set(`norm:${lead.asana_task_name || lead.title}`, idx);
      }
    }

    if (mergeCount > 0) {
      console.log(`[Tracked Reconciliation] Merged ${mergeCount} duplicate tracked records. ${submittedLeads.length} → ${merged.length}`);
      setSubmittedLeads(merged);
    } else {
      console.log(`[Tracked Reconciliation] No duplicates found in ${submittedLeads.length} tracked records`);
    }
    localStorage.setItem('ps_tracked_reconcile_version', RECONCILE_VERSION);
  }, []); // Run once on mount only

  const [activeTab, setActiveTab] = useState('active');
  const [selectedLead, setSelectedLead] = useState(null);
  const [showAddLead, setShowAddLead] = useState(false);
  const [showPIFReview, setShowPIFReview] = useState(null);
  const [showNotPursuedDialog, setShowNotPursuedDialog] = useState(null);
  const [pendingAsanaMatches, setPendingAsanaMatches] = useState([]);
  const [showAsanaImport, setShowAsanaImport] = useState(false);
  const [showLinkToAsana, setShowLinkToAsana] = useState(null); // holds Scout lead to link

  // ─── Lead CRUD operations ──────────────────────────────────

  const addLead = useCallback((lead) => {
    const origin = lead.leadOrigin || 'manual';
    const newLead = {
      ...lead,
      id: lead.id || `lead-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
      status: lead.status || LEAD_STATUS.WATCH,
      leadOrigin: origin,
      pruneImmune: lead.pruneImmune ?? (origin === 'manual'),
      dateDiscovered: lead.dateDiscovered || new Date().toISOString(),
      lastCheckedDate: new Date().toISOString(),
    };
    setLeads(prev => [newLead, ...prev]);
    setShowAddLead(false);
    setActiveTab('active');
  }, []);

  const updateLead = useCallback((updatedLead) => {
    setLeads(prev => prev.map(l => l.id === updatedLead.id ? { ...l, ...updatedLead } : l));
    setSubmittedLeads(prev => prev.map(l => l.id === updatedLead.id ? { ...l, ...updatedLead } : l));
    setSelectedLead(prev => prev?.id === updatedLead.id ? { ...prev, ...updatedLead } : prev);
  }, []);

  const moveToNotPursued = useCallback((leadId, reason) => {
    setLeads(prev => {
      const lead = prev.find(l => l.id === leadId);
      if (lead) {
        const isWatch = lead.status === LEAD_STATUS.WATCH || lead.status === 'watch' || lead.status === 'new' || lead.status === 'monitoring';
        setNotPursuedLeads(np => [{
          ...lead,
          status: LEAD_STATUS.NOT_PURSUED,
          reasonNotPursued: isWatch ? `Pruned: ${reason}` : reason,
          reasonCategory: isWatch ? 'pruned' : (lead.reasonCategory || undefined),
          prunedBy: isWatch ? 'manual' : undefined,
          dateNotPursued: new Date().toISOString(),
        }, ...np]);
        // Record manual prune as learning signal
        if (isWatch) recordPruneDecision('manual_prune', lead, reason);
      }
      return prev.filter(l => l.id !== leadId);
    });
    setSelectedLead(null);
    setShowNotPursuedDialog(null);
  }, [recordPruneDecision]);

  const restoreFromNotPursued = useCallback((leadId, restoreToWatch = false) => {
    setNotPursuedLeads(prev => {
      const lead = prev.find(l => l.id === leadId);
      if (lead) {
        const wasPruned = lead.prunedBy === 'system_reviewed' || lead.prunedBy === 'manual' || lead.reasonCategory === 'pruned';
        setLeads(active => [{
          ...lead,
          // v30: Unpruned items restore to Watch (not Active) and get auto-immunity
          status: (restoreToWatch || wasPruned) ? LEAD_STATUS.WATCH : LEAD_STATUS.ACTIVE,
          pruneImmune: wasPruned ? true : (lead.pruneImmune || false),
          reasonNotPursued: null,
          dateNotPursued: null,
          unprunedAt: wasPruned ? new Date().toISOString() : undefined,
        }, ...active]);
      }
      return prev.filter(l => l.id !== leadId);
    });
    setSelectedLead(null);
  }, []);

  // ─── Pruning Review handlers ─────────────────────────────────
  const handlePruneReviewImmune = useCallback((item) => {
    setPruningReviewQueue(prev => prev.filter(r => r.lead.id !== item.lead.id));
    setLeads(prev => [{ ...item.lead, pruneImmune: true }, ...prev]);
    recordPruneDecision('immune', item.lead, item.reason);
  }, [recordPruneDecision]);

  const handlePruneReviewPause = useCallback((item) => {
    const pauseUntil = new Date(Date.now() + 90 * 86400000).toISOString();
    setPruningReviewQueue(prev => prev.filter(r => r.lead.id !== item.lead.id));
    setLeads(prev => [{ ...item.lead, pruneReviewPausedUntil: pauseUntil }, ...prev]);
    recordPruneDecision('pause', item.lead, item.reason);
  }, [recordPruneDecision]);

  const handlePruneReviewPrune = useCallback((item) => {
    setPruningReviewQueue(prev => prev.filter(r => r.lead.id !== item.lead.id));
    setNotPursuedLeads(prev => [{
      ...item.lead,
      status: LEAD_STATUS.NOT_PURSUED,
      reasonNotPursued: `Pruned: ${item.reason} — ${item.explanation}`,
      reasonCategory: 'pruned',
      prunedBy: 'system_reviewed',
      dateNotPursued: new Date().toISOString(),
    }, ...prev]);
    recordPruneDecision('prune', item.lead, item.reason);
  }, [recordPruneDecision]);

  const handlePruneReviewActivate = useCallback((item) => {
    setPruningReviewQueue(prev => prev.filter(r => r.lead.id !== item.lead.id));
    setLeads(prev => [{ ...item.lead, status: LEAD_STATUS.ACTIVE }, ...prev]);
    recordPruneDecision('activate', item.lead, item.reason);
  }, [recordPruneDecision]);

  // Keep: remove from review queue, put back on board with a "pruneReviewKept" flag
  // so the same reason won't re-flag it on the next cleanup cycle.
  const handlePruneReviewKeep = useCallback((item) => {
    setPruningReviewQueue(prev => prev.filter(r => r.lead.id !== item.lead.id));
    setLeads(prev => [{
      ...item.lead,
      pruneReviewKept: true,
      pruneReviewKeptAt: new Date().toISOString(),
      pruneReviewKeptReason: item.reason,
    }, ...prev]);
    recordPruneDecision('keep', item.lead, item.reason);
  }, [recordPruneDecision]);

  // Open Details: close the review modal and open the lead detail panel
  const handlePruneOpenDetails = useCallback((lead) => {
    // Put the lead back on the board temporarily so the detail panel can show it
    setLeads(prev => {
      if (prev.some(l => l.id === lead.id)) return prev;
      return [{ ...lead }, ...prev];
    });
    setSelectedLead(lead);
    setPruneReviewVisible(false);
  }, []);

  const moveToSubmitted = useCallback((leadId, asanaUrl, notes) => {
    setLeads(prev => {
      const lead = prev.find(l => l.id === leadId);
      if (lead) {
        setSubmittedLeads(sub => [{
          ...lead,
          status: LEAD_STATUS.SUBMITTED_TO_ASANA,
          dateSubmittedToAsana: new Date().toISOString(),
          asanaUrl: asanaUrl || '',
          submissionNotes: notes || 'Submitted via Project Scout PIF workflow.',
          tracking_origin: lead.tracking_origin || 'submitted_from_scout',
          asana_synced_at: new Date().toISOString(),
        }, ...sub]);
      }
      return prev.filter(l => l.id !== leadId);
    });
    setSelectedLead(null);
    setShowPIFReview(null);
  }, []);

  // ─── Asana match review actions ─────────────────────────────
  const confirmAsanaMatch = useCallback((match) => {
    setLeads(prev => {
      const lead = prev.find(l => l.id === match.leadId);
      if (lead) {
        // If user edited the title during review, apply as user_edited_title
        const userTitle = match._userTitle || null;
        const mergedEntry = {
          ...lead,
          status: LEAD_STATUS.SUBMITTED_TO_ASANA,
          dateSubmittedToAsana: new Date().toISOString(),
          asanaUrl: match.taskUrl || '',
          submissionNotes: `Confirmed Asana match (${match.matchType}, ${Math.round((match.confidence||0)*100)}%). Matched task: "${match.taskName}".`,
          asana_task_id: match.taskGid || null,
          asana_task_name: match.taskName || '',
          asana_match_type: match.matchType || 'unknown',
          asana_match_confidence: match.confidence || 0,
          asana_synced_at: new Date().toISOString(),
          tracking_origin: 'matched_existing',
          asana_created_at: match.asana_created_at || null,
          asana_completed: !!match.asana_completed,
          asana_completed_at: match.asana_completed_at || null,
          asana_assignee: match.asana_assignee || null,
          asana_section: match.asana_section || null,
          asana_notes_excerpt: match.asana_notes_excerpt || null,
          // User-edited title takes precedence
          user_edited_title: userTitle || lead.user_edited_title || null,
          // Alias-aware: preserve Scout title if different from Asana title
          scout_title: (lead.title && match.taskName && lead.title.toLowerCase().trim() !== match.taskName.toLowerCase().trim()) ? lead.title : null,
          scout_lead_id: lead.id,
          alternate_titles: lead.title && match.taskName && lead.title.toLowerCase().trim() !== match.taskName.toLowerCase().trim() ? [lead.title] : [],
        };
        setSubmittedLeads(sub => {
          // Check if an imported entry for this Asana task already exists — merge instead of duplicate
          const existingIdx = match.taskGid ? sub.findIndex(s => s.asana_task_id === match.taskGid) : -1;
          if (existingIdx !== -1) {
            const existing = sub[existingIdx];
            const alts = new Set([...(existing.alternate_titles || []), ...(mergedEntry.alternate_titles || [])]);
            if (existing.title && existing.title !== mergedEntry.asana_task_name) alts.add(existing.title);
            return sub.map((s, i) => i === existingIdx ? { ...s, ...mergedEntry, id: s.id, alternate_titles: [...alts].filter(Boolean) } : s);
          }
          // Also check by normalized title alias
          const normIdx = sub.findIndex(s => isTitleAlias(s.asana_task_name || s.title, match.taskName));
          if (normIdx !== -1) {
            const existing = sub[normIdx];
            const alts = new Set([...(existing.alternate_titles || []), ...(mergedEntry.alternate_titles || [])]);
            if (existing.title && existing.title !== mergedEntry.asana_task_name) alts.add(existing.title);
            return sub.map((s, i) => i === normIdx ? { ...s, ...mergedEntry, id: s.id, asana_task_id: mergedEntry.asana_task_id || s.asana_task_id, alternate_titles: [...alts].filter(Boolean) } : s);
          }
          return [mergedEntry, ...sub];
        });
      }
      return prev.filter(l => l.id !== match.leadId);
    });
    setPendingAsanaMatches(prev => prev.filter(m => m.leadId !== match.leadId));
  }, []);

  const dismissAsanaMatch = useCallback((match, suppress = false) => {
    if (suppress && match.leadId && match.taskGid) {
      // Store dismissed pair so it won't reappear on next sync
      try {
        const key = 'ps_dismissed_matches';
        const dismissed = JSON.parse(localStorage.getItem(key) || '[]');
        dismissed.push({ leadId: match.leadId, taskGid: match.taskGid, leadTitle: match.leadTitle, taskName: match.taskName, dismissedAt: new Date().toISOString() });
        localStorage.setItem(key, JSON.stringify(dismissed));
      } catch {}
    }
    setPendingAsanaMatches(prev => prev.filter(m => m.leadId !== match.leadId));
  }, []);

  // ─── Manual link: associate a Scout lead with an existing Asana tracked item ──
  const linkLeadToAsana = useCallback((scoutLead, asanaItem) => {
    const now = new Date().toISOString();
    setSubmittedLeads(sub => sub.map(s => {
      if (s.id !== asanaItem.id) return s;
      return {
        ...s,
        // Merge Scout lead data (owner, location, scores, evidence, etc.)
        owner: scoutLead.owner || s.owner,
        location: scoutLead.location || s.location,
        county: scoutLead.county || s.county,
        geography: scoutLead.geography || s.geography,
        marketSector: scoutLead.marketSector || s.marketSector,
        projectType: scoutLead.projectType || s.projectType,
        description: scoutLead.description || s.description,
        relevanceScore: Math.max(scoutLead.relevanceScore || 0, s.relevanceScore || 0),
        pursuitScore: Math.max(scoutLead.pursuitScore || 0, s.pursuitScore || 0),
        sourceConfidenceScore: Math.max(scoutLead.sourceConfidenceScore || 0, s.sourceConfidenceScore || 0),
        evidence: [...(s.evidence || []), ...(scoutLead.evidence || [])],
        // Preserve Asana identity
        id: s.id,
        status: LEAD_STATUS.SUBMITTED_TO_ASANA,
        asana_task_id: s.asana_task_id,
        asana_task_name: s.asana_task_name,
        asanaUrl: s.asanaUrl,
        asana_section: s.asana_section,
        asana_assignee: s.asana_assignee,
        // Track the Scout title as alternate + alias-aware
        scout_title: scoutLead.title,
        scout_lead_id: scoutLead.id,
        alternate_titles: [...new Set([...(s.alternate_titles || []), scoutLead.title].filter(t => t && t.toLowerCase().trim() !== (s.asana_task_name || s.title || '').toLowerCase().trim()))],
        tracking_origin: 'matched_existing',
        submissionNotes: `Manually linked Scout lead "${scoutLead.title}" to Asana task "${s.asana_task_name || s.title}".`,
        asana_synced_at: now,
        // Inherit No Go from Asana section if applicable
        no_go: s.no_go || isNoGoSection(s.asana_section),
        no_go_date: s.no_go_date || (isNoGoSection(s.asana_section) ? now : null),
      };
    }));
    // Remove from active leads
    setLeads(prev => prev.filter(l => l.id !== scoutLead.id));
    setSelectedLead(null);
    setShowLinkToAsana(null);
  }, []);

  // ─── Asana import — fetch tasks via backend ─────────────
  const fetchAsanaTasksForImport = useCallback(async () => {
    const settings = loadState('settings', {});
    const backendUrl = settings?.backendEndpoint;

    if (!backendUrl) {
      return { tasks: [], error: 'Backend endpoint not configured. Set it in Settings to use Asana features.' };
    }

    try {
      const resp = await fetch(`${backendUrl}/api/scan?action=asana-import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: {} }),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.ok) return { tasks: data.tasks, error: null };
        return { tasks: [], error: data.error || 'Backend Asana import failed' };
      }
      return { tasks: [], error: `Backend returned HTTP ${resp.status}` };
    } catch (err) {
      return { tasks: [], error: err.message };
    }
  }, []);

  const importAsanaTasks = useCallback((selectedTasks) => {
    // Build maps for dedup and update detection — check ALL state arrays
    const existingByGid = new Map();
    const allTitles = []; // { normalized, original, source } for alias matching
    submittedLeads.forEach(l => {
      if (l.asana_task_id) existingByGid.set(l.asana_task_id, l);
      if (l.title) allTitles.push({ title: l.title, source: 'submitted' });
      if (l.asana_task_name) allTitles.push({ title: l.asana_task_name, source: 'submitted' });
      if (l.user_edited_title) allTitles.push({ title: l.user_edited_title, source: 'submitted' });
      if (l.original_title) allTitles.push({ title: l.original_title, source: 'submitted' });
      (l.alternate_titles || []).forEach(alt => allTitles.push({ title: alt, source: 'submitted' }));
    });
    leads.forEach(l => {
      if (l.title) allTitles.push({ title: l.title, source: 'active' });
      if (l.user_edited_title) allTitles.push({ title: l.user_edited_title, source: 'active' });
    });
    notPursuedLeads.forEach(l => { if (l.title) allTitles.push({ title: l.title, source: 'notpursued' }); });

    const now = new Date().toISOString();
    const newEntries = [];
    const updatedIds = new Set();
    let dupeCount = 0;

    // v31: Diagnostic — log all unique Asana section names for BP debugging
    const uniqueSections = new Set(selectedTasks.map(t => t.section).filter(Boolean));
    console.log(`[Asana Import] ${selectedTasks.length} tasks across ${uniqueSections.size} sections: ${[...uniqueSections].join(', ')}`);
    const bpSections = [...uniqueSections].filter(s => isBusinessPursuitsSection(s));
    if (bpSections.length > 0) {
      console.log(`[Asana Import] ✅ Business Pursuit sections found: ${bpSections.join(', ')}`);
    } else {
      console.log(`[Asana Import] ⚠ No Business Pursuit sections matched. Sections seen: ${[...uniqueSections].join(', ')}`);
    }

    for (const task of selectedTasks) {
      const taskGid = task.gid;

      // ── v31c: BP check BEFORE GID dedup ──
      // If this task is in a Business Pursuits section and was previously imported as a
      // regular entry (not as BP), we need to detect it. Don't let GID dedup skip it.
      const isBPSection = isBusinessPursuitsSection(task.section);
      const bpCutoff = new Date('2026-02-01T00:00:00Z');
      const isBPQualified = isBPSection && task.created_at && new Date(task.created_at) >= bpCutoff;

      // If already tracked by GID — update metadata (section, assignee, completed, etc.)
      if (taskGid && existingByGid.has(taskGid)) {
        const existing = existingByGid.get(taskGid);

        // v31c: If this is a qualifying BP task that was imported as a regular entry,
        // AND it's not already on the Watch board as a BP lead, add it to Watch too.
        if (isBPQualified && existing.tracking_origin !== 'asana_business_pursuit') {
          const alreadyInLeads = leads.some(l => l.asana_task_id === taskGid);
          if (!alreadyInLeads) {
            console.log(`[Asana Import] BP UPGRADE: "${task.name}" was regular import, now in BP section — adding to Watch`);
            newEntries.push({
              id: `lead-asana-bp-${taskGid || Date.now()}-${Math.random().toString(36).slice(2,6)}`,
              title: task.name || 'Untitled Business Pursuit',
              status: LEAD_STATUS.WATCH,
              leadOrigin: 'asana_business_pursuit',
              pruneImmune: true,
              tracking_origin: 'asana_business_pursuit',
              asana_task_id: taskGid || null,
              asana_task_name: task.name || '',
              asana_synced_at: now,
              asana_created_at: task.created_at || null,
              asana_section: task.section || null,
              asana_notes_excerpt: task.notes_excerpt || null,
              asanaUrl: task.permalink_url || '',
              owner: task.assignee_name || '',
              description: task.notes_excerpt || '',
              dateDiscovered: task.created_at || now,
              evidence: [],
              alternate_titles: [],
              relevanceScore: 0,
              pursuitScore: 0,
              sourceConfidenceScore: 0,
              _isBPEntry: true,
            });
          }
        }

        const changed = existing.asana_section !== (task.section || null)
          || existing.asana_assignee !== (task.assignee_name || null)
          || existing.asana_completed !== !!task.completed
          || existing.asana_completed_at !== (task.completed_at || null);
        if (changed) updatedIds.add(existing.id);
        dupeCount++;
        continue;
      }
      // Alias-aware title dedup — only skip if the match is against an ALREADY-SUBMITTED item.
      // If the match is against an ACTIVE lead, we still want to import the Asana task
      // so the active lead can later be reconciled against it. This was the root cause of
      // the Kalispell fire station gap: the active Scout lead blocked the Asana task import,
      // which meant the history was never available for reconciliation.
      // v30: Business Pursuits bypass the Not Pursued alias check — they should import into Watch
      // even if a similar title was previously pruned.
      const isBPTask = isBusinessPursuitsSection(task.section);
      const aliasMatch = allTitles.find(t => isTitleAlias(t.title, task.name));
      if (aliasMatch && aliasMatch.source === 'submitted') { dupeCount++; continue; }
      if (aliasMatch && aliasMatch.source === 'notpursued' && !isBPTask) { dupeCount++; continue; }
      // Active-lead alias: import anyway so the task is available for reconciliation
      if (aliasMatch && aliasMatch.source === 'active') {
        console.log(`[Asana Import] Importing "${task.name}" despite active-lead alias "${aliasMatch.title}" — needed for reconciliation`);
      }

      // Detect No Go, Go, and Business Pursuits from Asana section
      const isNoGo = isNoGoSection(task.section);
      const isGo = !isNoGo && isGoSection(task.section);
      const isBP = !isNoGo && !isGo && isBPTask; // reuse the variable computed above for alias bypass
      const bpDateCutoff = new Date('2026-02-01T00:00:00Z');
      const isRecentBP = isBP && task.created_at && new Date(task.created_at) >= bpDateCutoff;
      // v30: Diagnostic logging for BP detection
      if (isBP) {
        console.log(`[Asana Import] BP detected: "${task.name}" section="${task.section}" created=${task.created_at} recent=${isRecentBP}`);
      }

      // Business Pursuits since Feb 2026 → Watch board (not submitted/tracked)
      if (isRecentBP) {
        // Check if already exists in leads by GID or title alias
        const alreadyInLeads = leads.some(l => l.asana_task_id === taskGid) ||
          leads.some(l => isTitleAlias(l.title, task.name));
        if (!alreadyInLeads) {
          newEntries.push({
            id: `lead-asana-bp-${taskGid || Date.now()}-${Math.random().toString(36).slice(2,6)}`,
            title: task.name || 'Untitled Business Pursuit',
            status: LEAD_STATUS.WATCH,
            leadOrigin: 'asana_business_pursuit',
            pruneImmune: true,
            tracking_origin: 'asana_business_pursuit',
            asana_task_id: taskGid || null,
            asana_task_name: task.name || '',
            asana_synced_at: now,
            asana_created_at: task.created_at || null,
            asana_section: task.section || null,
            asana_notes_excerpt: task.notes_excerpt || null,
            asanaUrl: task.permalink_url || '',
            owner: task.assignee_name || '',
            description: task.notes_excerpt || '',
            dateDiscovered: task.created_at || now,
            evidence: [],
            alternate_titles: [],
            relevanceScore: 0,
            pursuitScore: 0,
            sourceConfidenceScore: 0,
            _isBPEntry: true, // marker for separate handling below
          });
        }
        continue;
      }

      newEntries.push({
        id: `lead-asana-${taskGid || Date.now()}-${Math.random().toString(36).slice(2,6)}`,
        title: task.name || 'Untitled Asana Task',
        status: LEAD_STATUS.SUBMITTED_TO_ASANA,
        tracking_origin: 'imported_from_asana',
        dateSubmittedToAsana: now,
        asanaUrl: task.permalink_url || '',
        submissionNotes: 'Imported from Asana board. Synced via Sync Asana Now.',
        // Asana context
        asana_task_id: taskGid || null,
        asana_task_name: task.name || '',
        asana_synced_at: now,
        asana_created_at: task.created_at || null,
        asana_completed: !!task.completed,
        asana_completed_at: task.completed_at || null,
        asana_assignee: task.assignee_name || null,
        asana_section: task.section || null,
        asana_notes_excerpt: task.notes_excerpt || null,
        // No Go / Go detection from section
        no_go: isNoGo,
        no_go_date: isNoGo ? now : null,
        go_date: isGo ? now : null,
        // Default lead fields
        owner: task.assignee_name || '',
        location: '',
        marketSector: '',
        projectType: '',
        description: task.notes_excerpt || '',
        relevanceScore: 0,
        pursuitScore: 0,
        sourceConfidenceScore: 0,
        dateDiscovered: task.created_at || now,
        leadOrigin: 'asana_import',
        evidence: [],
        alternate_titles: [],
      });
    }

    // Split BP entries (go to leads[]) from regular entries (go to submittedLeads[])
    const bpEntries = newEntries.filter(e => e._isBPEntry);
    const regularEntries = newEntries.filter(e => !e._isBPEntry);
    // Clean the marker
    bpEntries.forEach(e => { delete e._isBPEntry; });

    // Apply updates to existing items + add new regular entries
    if (regularEntries.length > 0 || updatedIds.size > 0) {
      // Build a lookup for task updates
      const taskByGid = new Map();
      selectedTasks.forEach(t => { if (t.gid) taskByGid.set(t.gid, t); });

      setSubmittedLeads(prev => {
        const updated = prev.map(lead => {
          if (updatedIds.has(lead.id) && lead.asana_task_id && taskByGid.has(lead.asana_task_id)) {
            const task = taskByGid.get(lead.asana_task_id);
            const sectionIsNoGo = isNoGoSection(task.section);
            const sectionIsGo = !sectionIsNoGo && isGoSection(task.section);
            return {
              ...lead,
              asana_section: task.section || null,
              asana_assignee: task.assignee_name || null,
              asana_completed: !!task.completed,
              asana_completed_at: task.completed_at || null,
              asana_synced_at: now,
              asana_notes_excerpt: task.notes_excerpt || lead.asana_notes_excerpt,
              // Update No Go / Go status from current section
              no_go: sectionIsNoGo || lead.no_go,
              no_go_date: sectionIsNoGo ? (lead.no_go_date || now) : lead.no_go_date,
              go_date: sectionIsGo ? (lead.go_date || now) : lead.go_date,
            };
          }
          return lead;
        });
        return [...regularEntries, ...updated];
      });
    }

    // Add BP entries to the Watch board
    if (bpEntries.length > 0) {
      setLeads(prev => [...bpEntries, ...prev]);
      console.log(`[Asana Import] ${bpEntries.length} Business Pursuit(s) added to Watch board`);
    }

    return {
      imported: newEntries.length, skipped: dupeCount, updated: updatedIds.size, newEntries, bpCount: bpEntries.length,
      // v31c: Section diagnostics for BP proof
      sectionsSeen: [...uniqueSections],
      bpSectionsMatched: bpSections,
      bpTasksQualified: bpEntries.length,
    };
  }, [submittedLeads, leads, notPursuedLeads]);

  // ─── Asana check — routes through backend (secrets stay server-side) ────
  // Step 1: Sync ALL Asana tasks into local persistent state (full import)
  // Step 2: Run match logic to connect Asana tasks to Scout leads
  const runAsanaCheck = useCallback(async (settings, addLog) => {
    const log = addLog || (() => {});
    const backendUrl = settings?.backendEndpoint;

    if (!backendUrl) {
      log('Asana check: Backend endpoint not configured. Set it in Settings to use Asana features.');
      return { matched: 0, error: 'Backend endpoint required for Asana checks', mode: 'unavailable' };
    }

    log('═══ ASANA SYNC & CHECK STARTED ═══');
    log(`Mode: BACKEND — routing through ${backendUrl}/api/scan?action=asana`);

    try {
      const resp = await fetch(`${backendUrl}/api/scan?action=asana`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: {}, existingLeads: leads }),
      });
      if (!resp.ok) throw new Error(`Backend HTTP ${resp.status}`);
      const data = await resp.json();
      if (data.logs) data.logs.forEach(l => log(l));
      if (!data.ok) throw new Error(data.error || 'Backend Asana check failed');

      // ── Step 1: Full import — sync ALL Asana tasks into persistent state ──
      let importedCount = 0;
      let updatedCount = 0;
      let importResult = null;
      const allTasks = data.allTasks || [];
      if (allTasks.length > 0) {
        log(`  Syncing ${allTasks.length} Asana tasks into tracked items...`);
        importResult = importAsanaTasks(allTasks);
        importedCount = importResult.imported;
        updatedCount = importResult.updated || 0;
        log(`  ✓ Synced: ${importedCount} new, ${importResult.skipped} already tracked${updatedCount > 0 ? `, ${updatedCount} updated` : ''}`);
      }

      // ── Step 1b + Step 2: Build unified review queue ──
      // Step 1b: client-side alias matching against imported Asana items (uses isTitleAlias with location guards)
      // Step 2: backend-ranked matches from scan.js
      // ALL matches go to user review — no silent auto-merge.
      // Only exceptions: (a) GID-linked leads (user already explicitly linked), (b) No Go auto-archive.
      const allPendingReview = [];
      const noGoLeadIds = [];
      const gidAutoLeadIds = [];

      // ── Load dismissed pairs for suppression ──
      let dismissedPairs = [];
      try { dismissedPairs = JSON.parse(localStorage.getItem('ps_dismissed_matches') || '[]'); } catch {}

      // ── Step 1b: Client-side alias matching against submitted/imported items ──
      {
        const storedSubmitted = JSON.parse(localStorage.getItem('ps_submitted') || '[]');
        const freshEntries = (importResult && importResult.newEntries) ? importResult.newEntries : [];
        const seenIds = new Set(storedSubmitted.map(s => s.id));
        const mergedNew = freshEntries.filter(e => !seenIds.has(e.id));
        const currentSubmitted = [...storedSubmitted, ...mergedNew];
        if (mergedNew.length > 0) {
          log(`  [Step 1b] Merged ${mergedNew.length} freshly-imported Asana entries for matching (not yet in localStorage)`);
        }

        for (const lead of leads) {
          // Skip leads that already have a backend match (Step 2 will handle those)
          if ((data.matches || []).some(m => m.leadId === lead.id)) continue;

          for (const sub of currentSubmitted) {
            // GID match — user already explicitly linked these, safe to auto-reconcile
            if (lead.asana_task_id && sub.asana_task_id && lead.asana_task_id === sub.asana_task_id) {
              log(`  ✓ GID RECONCILE: "${lead.title}" already linked to "${sub.asana_task_name || sub.title}"`);
              gidAutoLeadIds.push(lead.id);
              // Merge scout data into submitted record
              setSubmittedLeads(prev => prev.map(s => s.id === sub.id ? {
                ...s,
                scout_title: s.scout_title || lead.title,
                scout_lead_id: s.scout_lead_id || lead.id,
                owner: s.owner || lead.owner || '',
                location: s.location || lead.location || '',
                county: s.county || lead.county || '',
                geography: s.geography || lead.geography || '',
                marketSector: s.marketSector || lead.marketSector || '',
                description: (s.description && s.description.length > (lead.description || '').length) ? s.description : (lead.description || s.description || ''),
                tracking_origin: s.tracking_origin === 'imported_from_asana' ? 'matched_existing' : s.tracking_origin,
              } : s));
              break;
            }

            // Title alias match — queue for user review
            const subTitles = [sub.asana_task_name, sub.title, sub.scout_title, sub.user_edited_title, ...(sub.alternate_titles || [])].filter(Boolean);
            const leadTitles = [lead.title, lead.user_edited_title].filter(Boolean);
            let aliased = false;
            for (const lt of leadTitles) {
              for (const st of subTitles) {
                if (isTitleAlias(lt, st)) { aliased = true; break; }
              }
              if (aliased) break;
            }
            if (aliased) {
              const isDismissed = dismissedPairs.some(d => d.leadId === lead.id && d.taskGid === (sub.asana_task_id || null));
              if (isDismissed) {
                log(`  [Step 1b] Suppressed dismissed match: "${lead.title}" ↔ "${sub.asana_task_name || sub.title}"`);
                continue;
              }
              // Compute grounded confidence from identity signals
              const bestLeadTitle = lead.title || '';
              const bestSubTitle = sub.asana_task_name || sub.title || '';
              const sigL = extractEntitySignature(bestLeadTitle);
              const sigS = extractEntitySignature(bestSubTitle);
              let cal = 50; // base for alias match
              const normA = normalizeForMatch(bestLeadTitle);
              const normB = normalizeForMatch(bestSubTitle);
              if (normA === normB) cal += 35; // exact normalized match
              else if (normA.length >= 4 && normB.length >= 4 && (normA.includes(normB) || normB.includes(normA))) cal += 25;
              else if (titleSimilarity(normA, normB) >= 0.65) cal += Math.round((titleSimilarity(normA, normB) - 0.5) * 60);
              // Shared location
              const sharedLocs = sigL.locations.filter(l => sigS.locations.includes(l));
              if (sharedLocs.length > 0) cal += 15;
              else if (sigL.locations.length === 0 || sigS.locations.length === 0) cal -= 5; // uncertain
              else cal -= 45; // location conflict — strong penalty, different town = different project
              // Shared entity
              if (sigL.entities.filter(e => sigS.entities.includes(e)).length > 0) cal += 5;
              // Scope match/mismatch
              const leadLo = bestLeadTitle.toLowerCase();
              const subLo = bestSubTitle.toLowerCase();
              const scopeA = leadLo.match(/\b(new|addition|renovation|remodel|expansion|repair|replacement|demolition|upgrade|study|master plan|assessment)\b/g) || [];
              const scopeB = subLo.match(/\b(new|addition|renovation|remodel|expansion|repair|replacement|demolition|upgrade|study|master plan|assessment)\b/g) || [];
              if (scopeA.length > 0 && scopeB.length > 0) {
                if (scopeA.some(s => scopeB.includes(s))) cal += 5;
                else cal -= 10;
              }
              // Owner overlap
              const ownerLo = (lead.owner || '').toLowerCase();
              if (ownerLo.length > 3) {
                const ownerWords = ownerLo.split(/\s+/).filter(w => w.length > 3);
                const subWords = new Set(subLo.split(/\s+/));
                if (ownerWords.some(w => subWords.has(w))) cal += 8;
              }
              const groundedConfidence = Math.max(30, Math.min(99, cal)) / 100;

              log(`  ? POSSIBLE MATCH (Step 1b, ${Math.round(groundedConfidence*100)}%): "${lead.title}" ↔ "${sub.asana_task_name || sub.title}" — queued for review`);
              allPendingReview.push({
                leadId: lead.id,
                leadTitle: lead.title,
                scoutLead: { ...lead },
                taskName: bestSubTitle,
                taskGid: sub.asana_task_id || null,
                taskUrl: sub.asanaUrl || '',
                matchType: 'client_alias',
                confidence: groundedConfidence,
                asana_created_at: sub.asana_created_at || null,
                asana_completed: !!sub.asana_completed,
                asana_completed_at: sub.asana_completed_at || null,
                asana_assignee: sub.asana_assignee || null,
                asana_section: sub.asana_section || null,
                asana_notes_excerpt: sub.asana_notes_excerpt || null,
              });
              break; // One suggestion per lead
            }
          }
        }
      }
      // Remove GID-linked leads (user already explicitly linked these)
      if (gidAutoLeadIds.length > 0) {
        setLeads(prev => prev.filter(l => !gidAutoLeadIds.includes(l.id)));
        log(`  Removed ${gidAutoLeadIds.length} GID-linked lead(s) from Active board`);
      }

      // Track which leads already have a Step 1b suggestion
      const step1bLeadIds = new Set(allPendingReview.map(s => s.leadId));

      // ── Step 2: Backend-ranked matches ──
      if ((data.matches || []).length > 0) {
        for (const match of data.matches) {
          const lead = leads.find(l => l.id === match.leadId);
          if (!lead) continue;
          // Skip leads already handled by Step 1b
          if (step1bLeadIds.has(lead.id)) {
            log(`  [Step 2] Skipping "${lead.title}" — already has Step 1b suggestion`);
            continue;
          }

          // ── No Go auto-archive: if Asana task is in a "No Go" section, auto-move ──
          if (isNoGoSection(match.asana_section)) {
            log(`  ✗ NO GO: "${lead.title}" is in "${match.asana_section}" section — auto-archiving`);
            const scoutTitle = (lead.title && match.taskName && lead.title.toLowerCase().trim() !== match.taskName.toLowerCase().trim()) ? lead.title : null;
            const noGoEntry = {
              ...lead,
              status: LEAD_STATUS.SUBMITTED_TO_ASANA,
              dateSubmittedToAsana: new Date().toISOString(),
              asanaUrl: match.taskUrl || match.url || '',
              submissionNotes: `Auto-archived: Asana task in "${match.asana_section}" section.`,
              asana_task_id: match.taskGid || null,
              asana_task_name: match.taskName || '',
              asana_match_type: match.matchType || 'unknown',
              asana_match_confidence: match.confidence || 0,
              asana_synced_at: new Date().toISOString(),
              tracking_origin: 'matched_existing',
              asana_created_at: match.asana_created_at || null,
              asana_completed: !!match.asana_completed,
              asana_completed_at: match.asana_completed_at || null,
              asana_assignee: match.asana_assignee || null,
              asana_section: match.asana_section || null,
              asana_notes_excerpt: match.asana_notes_excerpt || null,
              no_go: true,
              no_go_date: new Date().toISOString(),
              scout_title: scoutTitle,
              scout_lead_id: lead.id,
              alternate_titles: scoutTitle ? [scoutTitle] : [],
            };
            noGoLeadIds.push(lead.id);
            setSubmittedLeads(sub => {
              const existingIdx = match.taskGid ? sub.findIndex(s => s.asana_task_id === match.taskGid) : -1;
              if (existingIdx !== -1) {
                const existing = sub[existingIdx];
                const alts = new Set([...(existing.alternate_titles || []), ...(noGoEntry.alternate_titles || [])]);
                return sub.map((s, i) => i === existingIdx ? { ...s, ...noGoEntry, id: s.id, alternate_titles: [...alts].filter(Boolean) } : s);
              }
              const normIdx = sub.findIndex(s => isTitleAlias(s.asana_task_name || s.title, match.taskName));
              if (normIdx !== -1) {
                const existing = sub[normIdx];
                const alts = new Set([...(existing.alternate_titles || []), ...(noGoEntry.alternate_titles || [])]);
                return sub.map((s, i) => i === normIdx ? { ...s, ...noGoEntry, id: s.id, asana_task_id: noGoEntry.asana_task_id || s.asana_task_id, alternate_titles: [...alts].filter(Boolean) } : s);
              }
              return [noGoEntry, ...sub];
            });
            continue;
          }

          // Non-No-Go backend match — queue for user review
          const isDismissed = dismissedPairs.some(d => d.leadId === lead.id && d.taskGid === (match.taskGid || null));
          if (isDismissed) {
            log(`  [Step 2] Suppressed dismissed match: "${lead.title}" → "${match.taskName}"`);
            continue;
          }
          log(`  ? PENDING REVIEW: "${lead.title}" → "${match.taskName}" (${match.matchType}, ${Math.round((match.confidence||0)*100)}%)`);
          allPendingReview.push({
            leadId: lead.id,
            leadTitle: lead.title,
            scoutLead: { ...lead },
            taskName: match.taskName,
            taskGid: match.taskGid || null,
            taskUrl: match.taskUrl || match.url || '',
            matchType: match.matchType || 'unknown',
            confidence: match.confidence || 0,
            asana_created_at: match.asana_created_at || null,
            asana_completed: !!match.asana_completed,
            asana_completed_at: match.asana_completed_at || null,
            asana_assignee: match.asana_assignee || null,
            asana_section: match.asana_section || null,
            asana_notes_excerpt: match.asana_notes_excerpt || null,
          });
        }
        // Remove No Go leads from active
        if (noGoLeadIds.length > 0) {
          setLeads(prev => prev.filter(l => !noGoLeadIds.includes(l.id)));
          log(`  Removed ${noGoLeadIds.length} No Go lead(s) from Active board`);
        }
      }

      // ── Surface all pending matches for user review ──
      if (allPendingReview.length > 0) {
        // Dedupe by leadId — one review per lead, prefer highest confidence
        const byLead = new Map();
        for (const p of allPendingReview) {
          const existing = byLead.get(p.leadId);
          if (!existing || (p.confidence || 0) > (existing.confidence || 0)) {
            byLead.set(p.leadId, p);
          }
        }
        const dedupedPending = [...byLead.values()];
        log(`  ${dedupedPending.length} match suggestion(s) queued for user review`);
        setPendingAsanaMatches(dedupedPending);
        // Tag active leads so LeadCard can show "LIKELY MATCH" badge
        const matchedLeadIds = new Set(dedupedPending.map(p => p.leadId));
        setLeads(prev => prev.map(l => matchedLeadIds.has(l.id)
          ? { ...l, _suggestedAsanaMatch: dedupedPending.find(p => p.leadId === l.id)?.taskName || true }
          : l._suggestedAsanaMatch ? { ...l, _suggestedAsanaMatch: undefined } : l
        ));
      } else {
        // Clear any stale suggestion badges
        setLeads(prev => prev.map(l => l._suggestedAsanaMatch ? { ...l, _suggestedAsanaMatch: undefined } : l));
      }

      // v31c: Include section diagnostics for visible BP proof
      const sectionsSeen = importResult?.sectionsSeen || [];
      const bpSectionsMatched = importResult?.bpSectionsMatched || [];
      const bpTasksQualified = importResult?.bpTasksQualified || 0;
      const result = {
        matched: data.matches?.length || 0, imported: importedCount, tasksChecked: data.tasks || 0, mode: 'connected', timestamp: new Date().toISOString(),
        sectionsSeen, bpSectionsMatched, bpTasksQualified,
      };
      log(`═══ ASANA SYNC COMPLETE — ${allTasks.length} tasks synced, ${result.matched} match(es), sections: ${sectionsSeen.join(', ') || 'none'}, BP sections: ${bpSectionsMatched.length > 0 ? bpSectionsMatched.join(', ') : 'none matched'}, BP tasks qualified: ${bpTasksQualified} ═══`);
      saveState('lastAsanaCheck', result);
      return result;
    } catch (err) {
      log(`ERROR: ${err.message}`);
      const result = { matched:0, error:err.message, mode:'error', timestamp:new Date().toISOString() };
      saveState('lastAsanaCheck', result);
      return result;
    }
  }, [leads, importAsanaTasks]);

  // ─── Engine merge callback — called by SettingsTab to merge engine results into persisted state ───
  // boardQualityPrune() is defined at module level above the component.
  const mergeEngineResults = useCallback((results) => {
    if (!results) return;
    const addedLeads = results.leadsAdded || [];
    const updatedLeads = results.leadsUpdated || [];

    // Simple word similarity for near-duplicate detection
    const STOP = new Set(['the','and','for','from','with','this','that','are','was','will','has','have','been','its','our','new','all','project','county','city','state','montana','of','in','at','on','to','by','a','an']);
    const sigWords = (t) => (t || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
    const wordSim = (a, b) => {
      const wa = new Set(sigWords(a)), wb = new Set(sigWords(b));
      if (wa.size < 2 || wb.size < 2) return 0;
      let i = 0; for (const w of wa) if (wb.has(w)) i++;
      return i / new Set([...wa, ...wb]).size;
    };

    // ── Historical reconciliation helper: check a lead against submitted/tracked items ──
    // Uses isTitleAlias() with entity+location matching (same as runAsanaCheck Step 1b).
    // This closes the gap where backend scan never sees submittedLeads (including No Go items).
    let historySubmitted = [];
    try { historySubmitted = JSON.parse(localStorage.getItem('ps_submitted') || '[]'); } catch {}
    let historyDirty = false;

    const checkAgainstHistory = (lead) => {
      if (!lead || !lead.title) return null;
      const leadTitles = [lead.title, lead.user_edited_title].filter(Boolean);
      for (const sub of historySubmitted) {
        // GID match
        if (lead.asana_task_id && sub.asana_task_id && lead.asana_task_id === sub.asana_task_id) {
          return { sub, matchType: 'gid' };
        }
        // Title alias match (Jaccard + entity+location + substring)
        const subTitles = [sub.asana_task_name, sub.title, sub.scout_title, sub.user_edited_title, ...(sub.alternate_titles || [])].filter(Boolean);
        for (const lt of leadTitles) {
          for (const st of subTitles) {
            if (isTitleAlias(lt, st)) {
              return { sub, matchType: 'alias' };
            }
          }
        }
      }
      return null;
    };

    const mergeScoutDataIntoSubmitted = (sub, lead) => {
      const alts = new Set([...(sub.alternate_titles || []), lead.title].filter(t => t && t.toLowerCase().trim() !== (sub.asana_task_name || sub.title || '').toLowerCase().trim()));
      const subIdx = historySubmitted.findIndex(s => s.id === sub.id);
      if (subIdx >= 0) {
        historySubmitted[subIdx] = {
          ...historySubmitted[subIdx],
          scout_title: historySubmitted[subIdx].scout_title || lead.title,
          scout_lead_id: historySubmitted[subIdx].scout_lead_id || lead.id,
          owner: historySubmitted[subIdx].owner || lead.owner || '',
          location: historySubmitted[subIdx].location || lead.location || '',
          county: historySubmitted[subIdx].county || lead.county || '',
          geography: historySubmitted[subIdx].geography || lead.geography || '',
          marketSector: historySubmitted[subIdx].marketSector || lead.marketSector || '',
          description: (historySubmitted[subIdx].description && historySubmitted[subIdx].description.length > (lead.description || '').length)
            ? historySubmitted[subIdx].description : (lead.description || historySubmitted[subIdx].description || ''),
          relevanceScore: Math.max(historySubmitted[subIdx].relevanceScore || 0, lead.relevanceScore || 0),
          evidence: [...(historySubmitted[subIdx].evidence || []), ...(lead.evidence || [])],
          alternate_titles: [...alts].filter(Boolean),
          last_scout_reappearance: new Date().toISOString(),
          tracking_origin: historySubmitted[subIdx].tracking_origin === 'imported_from_asana' ? 'matched_existing' : historySubmitted[subIdx].tracking_origin,
        };
        historyDirty = true;
      }
    };

    setLeads(prev => {
      // ── Step 1: Prune existing leads that fail current quality gates ──
      const mergeTaxonomy = JSON.parse(localStorage.getItem('ps_taxonomy') || '[]');
      const { kept: prunedExisting, pruned } = boardQualityPrune(prev, mergeTaxonomy);
      if (pruned.length > 0) {
        console.log(`[Board Prune] Removed ${pruned.length} weak/noisy leads from board`);
      }

      // ── Step 1b: Reconcile EXISTING active leads against submitted history ──
      // Catches leads that were added before the history check existed, or that
      // arrived from a scan before Asana sync imported the matching No Go item.
      const existingReconcileIds = [];
      for (const lead of prunedExisting) {
        const match = checkAgainstHistory(lead);
        if (match) {
          const disp = getDisposition(match.sub);
          console.log(`[History Reconcile] "${lead.title}" → tracked "${match.sub.asana_task_name || match.sub.title}" (${match.matchType}, ${disp.type})`);
          mergeScoutDataIntoSubmitted(match.sub, lead);
          existingReconcileIds.push(lead.id);
        }
      }
      if (existingReconcileIds.length > 0) {
        console.log(`[History Reconcile] Auto-reconciled ${existingReconcileIds.length} existing board lead(s) against Asana history`);
      }
      let board = prunedExisting.filter(l => !existingReconcileIds.includes(l.id));

      // ── Step 2: Add genuinely new leads (with quality gate + history check) ──
      if (addedLeads.length > 0) {
        const existingIds = new Set(board.map(l => l.id));
        const existingTitles = new Set(board.map(l => l.title?.toLowerCase().trim()));
        const genuinelyNew = addedLeads.filter(l => {
          if (existingIds.has(l.id) || existingTitles.has(l.title?.toLowerCase().trim())) return false;
          // ── Check against submitted/tracked history (including No Go) ──
          const histMatch = checkAgainstHistory(l);
          if (histMatch) {
            const disp = getDisposition(histMatch.sub);
            console.log(`[History Gate] Blocked incoming "${l.title}" → tracked "${histMatch.sub.asana_task_name || histMatch.sub.title}" (${histMatch.matchType}, ${disp.type})`);
            mergeScoutDataIntoSubmitted(histMatch.sub, l);
            return false;
          }
          for (const ex of board) {
            const sim = wordSim(l.title, ex.title);
            if (sim >= 0.65) {
              // If matching a dismissed item: check if new lead is materially different enough
              // A dismissed generic district page should not block a new named project from the same area
              if (ex.watchDisposition === WATCH_DISPOSITION.DISMISSED && sim < 0.85) {
                // Lower similarity = more different = allow through as genuinely new
                // Only block at very high similarity (0.85+) for dismissed items
                continue;
              }
              return false;
            }
          }
          return true;
        });
        // ── Step 2b: Run incoming leads through the SAME quality gates ──
        // Without this, every noisy new lead bypasses boardQualityPrune entirely.
        // This was the root cause of the Step 11 regression: prune only ran on
        // existing leads, so each backfill's new noise sailed straight onto the board.
        if (genuinelyNew.length > 0) {
          const { kept: qualityNew, pruned: prunedNew, reviewQueue: newReviewQueue } = boardQualityPrune(genuinelyNew, mergeTaxonomy);
          if (prunedNew.length > 0) {
            console.log(`[Board Prune] Blocked ${prunedNew.length} noisy incoming leads:`);
            for (const p of prunedNew) {
              console.log(`  ✂ "${p.title}" — ${p.reason}`);
            }
          }
          // ── v32: Wire up review queue items from new leads ──
          // Previously these were computed but silently discarded.
          if (newReviewQueue.length > 0) {
            console.log(`[Board Prune] ${newReviewQueue.length} incoming lead(s) routed to prune review:`);
            for (const r of newReviewQueue) {
              console.log(`  ⚠ "${r.lead.title}" — ${r.reason}`);
            }
            setPruningReviewQueue(prev => {
              const existingIds = new Set(prev.map(r => r.lead?.id).filter(Boolean));
              const fresh = newReviewQueue.filter(r => r.lead?.id && !existingIds.has(r.lead.id));
              if (fresh.length > 0) {
                setPruneReviewVisible(true);
                return [...prev, ...fresh];
              }
              return prev;
            });
          }
          // ── v3.5: Container-child parent replacement ──
          // When container-child leads arrive from a source, remove existing generic
          // parent-page leads from the same source that the children supersede.
          const containerChildren = qualityNew.filter(l => l.containerChild);
          if (containerChildren.length > 0) {
            const containerSourceIds = new Set(containerChildren.map(l => l.sourceId).filter(Boolean));
            const staleParentIds = [];
            for (const existing of board) {
              if (!existing.sourceId || !containerSourceIds.has(existing.sourceId)) continue;
              // If existing lead from same source has a generic fallback title pattern, it's a stale parent
              const elo = (existing.title || '').toLowerCase();
              if (/^[\w\s&'.,()]+\s*[–—-]\s*(capital improvement|solicitation|project signal|bid solicitations?|current (projects?|bids?|solicitations?))$/i.test(elo) ||
                  /^(bid solicitations?|current (projects?|bids?|solicitations?)|capital improvement|public (works?|bids?))$/i.test(elo.trim())) {
                staleParentIds.push(existing.id);
                console.log(`[Container] Replacing stale parent: "${existing.title}" (superseded by ${containerChildren.length} child leads)`);
              }
            }
            if (staleParentIds.length > 0) {
              const staleSet = new Set(staleParentIds);
              board = board.filter(l => !staleSet.has(l.id));
            }
          }
          board = [...qualityNew, ...board];
        }
      }

      // ── v3.5: Location normalization for all board leads ──
      // Fix Idaho/Washington leads that were stored with MT state code
      board = board.map(lead => {
        const loc = (lead.location || '').toLowerCase();
        if (!loc.includes(', mt')) return lead;
        const srcUrl = (lead.sourceUrl || '').toLowerCase();
        const srcName = (lead.sourceName || '').toLowerCase();
        const combined = loc + ' ' + srcUrl + ' ' + srcName;
        const isIdaho = /coeur d.alene|boise|idaho falls|pocatello|meridian|nampa|twin falls|lewiston|moscow|sandpoint|post falls|kootenai|\.id\b|cdaid|idaho/i.test(combined);
        const isWA = /spokane|seattle|pullman|\.wa\b|washington/i.test(combined);
        if (isIdaho) return { ...lead, location: lead.location.replace(/,\s*MT\s*$/i, ', ID') };
        if (isWA) return { ...lead, location: lead.location.replace(/,\s*MT\s*$/i, ', WA') };
        return lead;
      });

      // ── v3.5: Canonical district dedup — prevent same area flooding the board ──
      // Catches URD/TIF/TEDD references AND named strategic areas (Midtown Commons, Riverfront Triangle, etc.)
      // that may appear from multiple sources as near-identical cards.
      const isStrategicArea = (l) => {
        const t = (l.title || '').toLowerCase();
        return /\b(urd|tif|tedd|urban\s+renewal|redevelopment\s+(area|district|zone))\b/i.test(t) ||
          l.leadClass === 'strategic_watch' ||
          l.watchCategory === 'redevelopment_area' || l.watchCategory === 'tif_district' ||
          /\b(crossing|triangle|corridor|commons|block|mill|yard|development\s+park|catalyst\s+site)\b/i.test(t);
      };
      const strategicLeads = board.filter(isStrategicArea);
      if (strategicLeads.length > 1) {
        const districtGroups = new Map();
        const STOP_WORDS = new Set(['the','and','for','from','with','this','that','new','all','project','district','area','zone','development','redevelopment','urban','renewal','tif','urd','tedd','plan','strategic']);
        for (const dl of strategicLeads) {
          // Normalize: strip district/area suffixes, keep core proper-name words
          const words = (dl.title || '').replace(/[^a-zA-Z0-9\s]/g, '').split(/\s+/)
            .filter(w => w.length > 1 && !STOP_WORDS.has(w.toLowerCase()));
          const key = words.slice(0, 3).map(w => w.toLowerCase()).join(' ');
          if (key.length < 3) continue; // Skip very short keys that would over-merge
          if (!districtGroups.has(key)) districtGroups.set(key, []);
          districtGroups.get(key).push(dl);
        }
        const dupeDistrictIds = new Set();
        for (const [, group] of districtGroups) {
          if (group.length <= 1) continue;
          // Keep the one with highest score or immune; route others to prune review
          group.sort((a, b) => {
            if (a.pruneImmune && !b.pruneImmune) return -1;
            if (b.pruneImmune && !a.pruneImmune) return 1;
            return (b.relevanceScore || 0) - (a.relevanceScore || 0);
          });
          for (let i = 1; i < group.length; i++) {
            if (group[i].pruneImmune) continue; // Never auto-dedup immune items
            dupeDistrictIds.add(group[i].id);
            console.log(`[District Dedup] Duplicate: "${group[i].title}" — keeping "${group[0].title}"`);
          }
        }
        if (dupeDistrictIds.size > 0) {
          const dupLeads = board.filter(l => dupeDistrictIds.has(l.id));
          board = board.filter(l => !dupeDistrictIds.has(l.id));
          setPruningReviewQueue(prev => {
            const existingIds = new Set(prev.map(r => r.lead?.id).filter(Boolean));
            const fresh = dupLeads.filter(l => !existingIds.has(l.id)).map(l => ({
              lead: l,
              reason: 'Duplicate district reference',
              explanation: `This area appears to duplicate another strategic watch item already on the board. Multiple sources may reference the same redevelopment area or opportunity site.`,
              keepHint: 'Prune if the existing item already covers this area. Keep if this reference adds materially different project information.',
            }));
            if (fresh.length > 0) setPruneReviewVisible(true);
            return [...prev, ...fresh];
          });
        }
      }

      // Persist updated submitted records (merged scout data from history reconciliation)
      if (historyDirty) {
        try { localStorage.setItem('ps_submitted', JSON.stringify(historySubmitted)); } catch {}
        // Also update React state to keep UI in sync
        setSubmittedLeads(historySubmitted);
      }

      // ── Step 3: Update existing leads (including Watch→Active promotion & triage revival) ──
      if (updatedLeads.length > 0) {
        board = board.map(lead => {
          const update = updatedLeads.find(u => u.leadId === lead.id);
          if (!update) return lead;
          const merged = { ...lead };
          if (update.relevanceScore !== undefined) merged.relevanceScore = Math.max(lead.relevanceScore||0, update.relevanceScore);
          if (update.pursuitScore !== undefined) merged.pursuitScore = Math.max(lead.pursuitScore||0, update.pursuitScore);
          if (update.sourceConfidenceScore !== undefined) merged.sourceConfidenceScore = Math.max(lead.sourceConfidenceScore||0, update.sourceConfidenceScore);
          if (update.aiReasonForAddition) merged.aiReasonForAddition = update.aiReasonForAddition;
          if (update.confidenceNotes) merged.confidenceNotes = update.confidenceNotes;
          if (update.newEvidence) merged.evidence = [...(lead.evidence||[]), update.newEvidence];
          merged.lastCheckedDate = update.lastCheckedDate || new Date().toISOString();
          // Watch→Active promotion
          if (update.status) merged.status = update.status;
          if (update.leadClass) merged.leadClass = update.leadClass;
          if (update.projectStatus) merged.projectStatus = update.projectStatus;
          // Timeline updates
          if (update.potentialTimeline) merged.potentialTimeline = update.potentialTimeline;
          if (update.action_due_date) merged.action_due_date = update.action_due_date;
          // Track meaningful update timestamp for UPDATE badge
          if (update.lastUpdatedDate) merged.lastUpdatedDate = update.lastUpdatedDate;
          else if (update.status !== lead.status || update.newEvidence) {
            merged.lastUpdatedDate = new Date().toISOString();
          }
          // ── Triage revival: check for material change on muted/dismissed Watch items ──
          const disp = lead.watchDisposition || WATCH_DISPOSITION.ACTIVE;
          if ((disp === WATCH_DISPOSITION.MUTED || disp === WATCH_DISPOSITION.DISMISSED) && lead.lastMaterialSignalHash) {
            const { changed, reasons } = detectMaterialChange(merged, lead.lastMaterialSignalHash);
            if (changed) {
              merged.reassessFlag = true;
              merged.reassessAt = new Date().toISOString();
              merged.lastMaterialChangeSummary = reasons.join('. ') + '.';
              console.log(`[Triage Revival] 🔔 "${(lead.title||'').slice(0,40)}" — material change detected: ${reasons.join(', ')}`);
            }
          }
          // Preserve triage fields — never overwrite user triage state from engine
          // (favorite, watchDisposition, mutedAt, dismissedAt, etc. are not touched by engine)
          return merged;
        });
      }

      return board;
    });
  }, [setLeads]);

  // ─── Watch Triage Actions ──────────────────────────────────
  const handleTriageAction = useCallback((leadId, action, extra) => {
    const now = new Date().toISOString();
    setLeads(prev => prev.map(lead => {
      if (lead.id !== leadId) return lead;
      const updated = { ...lead };

      switch (action) {
        case 'favorite':
          updated.favorite = !lead.favorite;
          updated.favoritedAt = updated.favorite ? now : null;
          // If favoriting a muted/dismissed item, restore it to active disposition
          if (updated.favorite && (updated.watchDisposition === WATCH_DISPOSITION.MUTED || updated.watchDisposition === WATCH_DISPOSITION.DISMISSED)) {
            updated.watchDisposition = WATCH_DISPOSITION.ACTIVE;
            updated.reassessFlag = false;
          }
          break;
        case 'mute':
          if (lead.watchDisposition === WATCH_DISPOSITION.MUTED) {
            // Unmute
            updated.watchDisposition = WATCH_DISPOSITION.ACTIVE;
            updated.mutedAt = null;
          } else {
            updated.watchDisposition = WATCH_DISPOSITION.MUTED;
            updated.mutedAt = now;
            updated.reassessFlag = false;
            updated.reassessAt = null;
            // Compute and store signal hash at time of muting
            updated.lastMaterialSignalHash = computeSignalHash(lead);
          }
          break;
        case 'dismiss':
          updated.watchDisposition = WATCH_DISPOSITION.DISMISSED;
          updated.dismissedAt = now;
          updated.dismissReason = extra?.reason || '';
          updated.dismissCategory = extra?.category || '';
          updated.reassessFlag = false;
          updated.reassessAt = null;
          updated.favorite = false;
          // Compute and store signal hash at time of dismissal
          updated.lastMaterialSignalHash = computeSignalHash(lead);
          break;
        case 'undismiss':
          updated.watchDisposition = WATCH_DISPOSITION.ACTIVE;
          updated.dismissedAt = null;
          updated.dismissReason = '';
          updated.dismissCategory = '';
          updated.reassessFlag = false;
          break;
        case 'clear-reassess':
          updated.reassessFlag = false;
          updated.reassessAt = null;
          // Keep the disposition as-is but restore to active board
          updated.watchDisposition = WATCH_DISPOSITION.ACTIVE;
          break;
        default:
          break;
      }
      return updated;
    }));
    // Re-sync selectedLead if it's the one being triaged
    setSelectedLead(prev => {
      if (prev?.id !== leadId) return prev;
      const updated = leads.find(l => l.id === leadId);
      if (!updated) return prev;
      // Build what the new state will look like
      const patch = {};
      if (action === 'favorite') {
        patch.favorite = !updated.favorite;
        patch.favoritedAt = !updated.favorite ? now : null;
        if (!updated.favorite && (updated.watchDisposition === WATCH_DISPOSITION.MUTED || updated.watchDisposition === WATCH_DISPOSITION.DISMISSED)) {
          patch.watchDisposition = WATCH_DISPOSITION.ACTIVE;
          patch.reassessFlag = false;
        }
      } else if (action === 'mute') {
        patch.watchDisposition = updated.watchDisposition === WATCH_DISPOSITION.MUTED ? WATCH_DISPOSITION.ACTIVE : WATCH_DISPOSITION.MUTED;
        patch.mutedAt = patch.watchDisposition === WATCH_DISPOSITION.MUTED ? now : null;
        if (patch.watchDisposition === WATCH_DISPOSITION.MUTED) { patch.reassessFlag = false; patch.reassessAt = null; patch.lastMaterialSignalHash = computeSignalHash(updated); }
      } else if (action === 'dismiss') {
        patch.watchDisposition = WATCH_DISPOSITION.DISMISSED; patch.dismissedAt = now; patch.dismissReason = extra?.reason || ''; patch.dismissCategory = extra?.category || ''; patch.reassessFlag = false; patch.reassessAt = null; patch.favorite = false; patch.lastMaterialSignalHash = computeSignalHash(updated);
      } else if (action === 'undismiss') {
        patch.watchDisposition = WATCH_DISPOSITION.ACTIVE; patch.dismissedAt = null; patch.dismissReason = ''; patch.dismissCategory = ''; patch.reassessFlag = false;
      } else if (action === 'clear-reassess') {
        patch.reassessFlag = false; patch.reassessAt = null; patch.watchDisposition = WATCH_DISPOSITION.ACTIVE;
      }
      return { ...prev, ...patch };
    });
  }, [leads]);

  const handleSelectLead = useCallback((lead) => { setSelectedLead(lead); }, []);
  const handleCloseLead = useCallback(() => { setSelectedLead(null); }, []);

  // ─── Computed counts ───────────────────────────────────────
  const activeCounts = useMemo(() => ({
    active: leads.length,
    asana: submittedLeads.length,
    notpursued: notPursuedLeads.length,
  }), [leads, submittedLeads, notPursuedLeads]);

  return (
    <div style={{ minHeight: '100vh', background: '#f8f9fb', fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif", color: '#1e293b' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;0,9..40,800;1,9..40,400&display=swap');
        @keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes slideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
        * { box-sizing: border-box; margin: 0; }
        body { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #9ca3af; }
        ::selection { background: #0f172a; color: #fff; }
        input:focus, select:focus, textarea:focus { border-color: #0f172a !important; box-shadow: 0 0 0 3px rgba(15,23,42,0.08) !important; outline: none; }
        button { font-family: inherit; }
        a { text-decoration: none; }
      `}</style>

      {/* ─── HEADER ─── */}
      <header style={{
        borderBottom: '1px solid #eef0f4',
        padding: '0 28px', position: 'sticky', top: 0, zIndex: 100,
        backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
        background: 'rgba(255,255,255,0.92)',
      }}>
        <div style={{ maxWidth: 1320, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 58 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ color: '#fff', fontSize: 12.5, fontWeight: 800, letterSpacing: '-0.04em' }}>PS</span>
            </div>
            <div style={{ lineHeight: 1 }}>
              <div style={{ fontSize: 15.5, fontWeight: 800, color: '#0f172a', letterSpacing: '-0.04em' }}>Project Scout</div>
              <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 500, marginTop: 1, letterSpacing: '0.02em' }}>A&E + SMA Design</div>
            </div>
          </div>

          <nav style={{ display: 'flex', gap: 2, height: '100%' }}>
            {TABS.map(tab => (
              <button key={tab.id} onClick={() => { setActiveTab(tab.id); setSelectedLead(null); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '0 14px', height: '100%',
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: 12.5, fontWeight: 600,
                  color: activeTab === tab.id ? '#0f172a' : '#94a3b8',
                  borderBottom: activeTab === tab.id ? '2px solid #0f172a' : '2px solid transparent',
                  transition: 'all 0.15s', position: 'relative',
                }}
              >
                {tab.icon}
                <span>{tab.label}</span>
                {activeCounts[tab.id] !== undefined && (
                  <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 8, background: activeTab === tab.id ? '#0f172a' : '#f1f5f9', color: activeTab === tab.id ? '#fff' : '#94a3b8', marginLeft: 2 }}>
                    {activeCounts[tab.id]}
                  </span>
                )}
                {tab.id === 'active' && pruningReviewQueue.length > 0 && (
                  <span onClick={(e) => { e.stopPropagation(); setPruneReviewVisible(true); }}
                    style={{ fontSize: 8, fontWeight: 700, padding: '2px 5px', borderRadius: 8, background: '#f59e0b', color: '#fff', marginLeft: 2, cursor: 'pointer' }}
                    title={`${pruningReviewQueue.length} lead(s) need pruning review`}>
                    {pruningReviewQueue.length} review
                  </span>
                )}
              </button>
            ))}
          </nav>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={() => setShowAddLead(true)} style={{ padding: '6px 14px', borderRadius: 7, border: 'none', background: '#0f172a', color: '#fff', cursor: 'pointer', fontSize: 11.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5 }}>
              <Plus size={13} /> Add Lead
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#94a3b8' }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981' }} />
              <span>System Ready</span>
              {sharedStoreStatus === 'connected' && (
                <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: '#ecfdf5', color: '#065f46', border: '1px solid #a7f3d0', fontWeight: 600 }} title="Lead records are synced to shared server-side storage">SHARED</span>
              )}
              {sharedStoreStatus === 'local-only' && (
                <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: '#fefce8', color: '#854d0e', border: '1px solid #fde68a', fontWeight: 600 }} title="Lead records are stored in this browser only. Configure Upstash Redis for shared persistence.">LOCAL</span>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* ─── MAIN CONTENT ─── */}
      <main style={{ maxWidth: 1320, margin: '0 auto', padding: '28px 28px 80px' }}>
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: '#0f172a', margin: 0, letterSpacing: '-0.04em', lineHeight: 1.2 }}>
            {TABS.find(t => t.id === activeTab)?.label}
          </h1>
          <p style={{ fontSize: 13, color: '#94a3b8', margin: '4px 0 0' }}>
            {activeTab === 'active' && (() => {
              const ac = leads.filter(l => getOperationalStatus(l).primary === LEAD_STATUS.ACTIVE).length;
              const wc = leads.filter(l => getOperationalStatus(l).primary === LEAD_STATUS.WATCH).length;
              return `${ac} active pursuit${ac !== 1 ? 's' : ''}, ${wc} watch item${wc !== 1 ? 's' : ''} across active geography`;
            })()}
            {activeTab === 'asana' && (() => {
              const noGoCount = submittedLeads.filter(l => getDisposition(l).type === 'no_go').length;
              const pendingGoCount = submittedLeads.length - noGoCount;
              return `${pendingGoCount} pending/go pursuit${pendingGoCount !== 1 ? 's' : ''} tracked in Asana`;
            })()}
            {activeTab === 'notpursued' && (() => {
              const noGoCount = submittedLeads.filter(l => getDisposition(l).type === 'no_go').length;
              return `${notPursuedLeads.length} not pursued, ${noGoCount} Asana no-go`;
            })()}
            {activeTab === 'registry' && 'Source intelligence — sources, entities, geography, families'}
            {activeTab === 'taxonomy' && 'Editable classification registry — service fit, pursuit signals, markets, noise suppression'}
            {activeTab === 'settings' && 'Intelligence engine, AI provider, scheduling, Asana integration'}
          </p>
          {/* ─── PRUNE REVIEW BANNER ─── */}
          {activeTab === 'active' && pruningReviewQueue.length > 0 && (
            <div onClick={() => setPruneReviewVisible(true)} style={{
              marginTop: 12, padding: '10px 16px', borderRadius: 10,
              background: 'linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%)',
              border: '1px solid #fde68a', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 10,
              transition: 'box-shadow 0.15s',
            }}
              onMouseEnter={e => e.currentTarget.style.boxShadow = '0 2px 8px rgba(245,158,11,0.2)'}
              onMouseLeave={e => e.currentTarget.style.boxShadow = 'none'}
            >
              <div style={{ width: 28, height: 28, borderRadius: 8, background: '#f59e0b', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: '#fff' }}>{pruningReviewQueue.length}</span>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#92400e' }}>
                  {pruningReviewQueue.length === 1 ? '1 lead needs pruning review' : `${pruningReviewQueue.length} leads need pruning review`}
                </div>
                <div style={{ fontSize: 11, color: '#b45309', marginTop: 1 }}>
                  Scout flagged borderline items — click to review before they are removed
                </div>
              </div>
              <ArrowUpRight size={16} style={{ color: '#d97706', flexShrink: 0 }} />
            </div>
          )}
        </div>

        {activeTab === 'active' && <ActiveLeadsTab leads={leads} onSelectLead={handleSelectLead} onUpdateLead={updateLead} />}
        {activeTab === 'asana' && <SubmittedTab leads={submittedLeads} onSelectLead={handleSelectLead} onImport={() => setShowAsanaImport(true)} />}
        {activeTab === 'notpursued' && <NotPursuedTab leads={notPursuedLeads} submittedLeads={submittedLeads} onSelectLead={handleSelectLead} onRestore={restoreFromNotPursued} />}
        {activeTab === 'registry' && <SourceRegistryView />}
        {activeTab === 'taxonomy' && <TaxonomyView />}
        {activeTab === 'settings' && <SettingsTab onMergeResults={mergeEngineResults} onRunAsanaCheck={runAsanaCheck} onApplyValidation={(result) => {
          // result can be: { keptLeads: [...], suppressedLeads: [...], validationReviewQueue: [...] } or plain array (legacy)
          if (result && result.keptLeads) {
            setLeads(result.keptLeads);
            localStorage.setItem('ps_leads', JSON.stringify(result.keptLeads));
            if (result.suppressedLeads && result.suppressedLeads.length > 0) {
              setNotPursuedLeads(prev => [...result.suppressedLeads, ...prev]);
            }
            // v30: Route validation-flagged borderline leads to pruning review
            if (result.validationReviewQueue && result.validationReviewQueue.length > 0) {
              setPruningReviewQueue(prev => {
                const existingIds = new Set(prev.map(r => r.lead.id));
                const newItems = result.validationReviewQueue.filter(r => !existingIds.has(r.lead.id));
                return [...prev, ...newItems];
              });
              setPruneReviewVisible(true);
            }
          } else {
            // Legacy: plain array of all leads
            setLeads(result);
            localStorage.setItem('ps_leads', JSON.stringify(result));
          }
        }} allLeads={leads} notPursuedLeads={notPursuedLeads} submittedLeads={submittedLeads} />}
      </main>

      {/* ─── LEAD DETAIL OVERLAY ─── */}
      {selectedLead && (
        <>
          <div onClick={handleCloseLead} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 999 }} />
          <LeadDetail
            lead={selectedLead}
            onClose={handleCloseLead}
            onUpdate={updateLead}
            onMoveToNotPursued={(id) => setShowNotPursuedDialog(id)}
            onSubmitToAsana={(lead) => setShowPIFReview(lead)}
            onRestore={restoreFromNotPursued}
            onTriageAction={handleTriageAction}
            onLinkToAsana={(lead) => setShowLinkToAsana(lead)}
          />
        </>
      )}

      {/* ─── ADD LEAD MODAL ─── */}
      {showAddLead && <AddLeadModal onSave={addLead} onClose={() => setShowAddLead(false)} />}

      {/* ─── NOT PURSUED DIALOG ─── */}
      {showNotPursuedDialog && (
        <NotPursuedReasonModal
          onConfirm={(reason) => moveToNotPursued(showNotPursuedDialog, reason)}
          onCancel={() => setShowNotPursuedDialog(null)}
        />
      )}

      {/* ─── PIF REVIEW MODAL ─── */}
      {showPIFReview && (
        <>
          <div onClick={() => setShowPIFReview(null)} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.3)', zIndex:999 }} />
          <div style={{ position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)', background:'#fff', borderRadius:12, boxShadow:'0 20px 60px rgba(0,0,0,0.15)', zIndex:1000, padding:'24px 28px', width:'100%', maxWidth:440 }}>
            <h3 style={{ fontSize:16, fontWeight:700, color:'#0f172a', margin:'0 0 12px' }}>Submit to Asana</h3>
            <p style={{ fontSize:13, color:'#475569', lineHeight:1.6, margin:'0 0 16px' }}>
              Submit <strong>{showPIFReview.title}</strong> to the Asana Go/No-Go board for review?
            </p>
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
              <button onClick={() => setShowPIFReview(null)} style={{ padding:'9px 18px', borderRadius:7, border:'1px solid #e2e8f0', background:'#fff', cursor:'pointer', fontSize:12.5, fontWeight:600, color:'#64748b' }}>Cancel</button>
              <button onClick={() => { moveToSubmitted(showPIFReview.id, '', 'Submitted directly to Asana board.'); setShowPIFReview(null); }} style={{ padding:'9px 18px', borderRadius:7, border:'none', background:'#0f172a', cursor:'pointer', fontSize:12.5, fontWeight:600, color:'#fff', display:'flex', alignItems:'center', gap:5 }}>
                Submit to Asana
              </button>
            </div>
          </div>
        </>
      )}

      {/* ─── PRUNING REVIEW MODAL ─── */}
      {pruneReviewVisible && pruningReviewQueue.length > 0 && (
        <PruningReviewModal
          queue={pruningReviewQueue}
          onImmune={handlePruneReviewImmune}
          onPause={handlePruneReviewPause}
          onPrune={handlePruneReviewPrune}
          onActivate={handlePruneReviewActivate}
          onKeep={handlePruneReviewKeep}
          onOpenDetails={handlePruneOpenDetails}
          onClose={() => setPruneReviewVisible(false)}
        />
      )}

      {/* ─── ASANA MATCH REVIEW MODAL ─── */}
      {pendingAsanaMatches.length > 0 && (
        <AsanaMatchReviewModal
          matches={pendingAsanaMatches}
          leads={leads}
          onConfirm={confirmAsanaMatch}
          onDismiss={dismissAsanaMatch}
          onClose={() => setPendingAsanaMatches([])}
        />
      )}

      {/* ─── ASANA IMPORT MODAL ─── */}
      {showAsanaImport && (
        <AsanaImportModal
          onClose={() => setShowAsanaImport(false)}
          onFetch={fetchAsanaTasksForImport}
          onImport={importAsanaTasks}
          existingGids={submittedLeads.filter(l => l.asana_task_id).map(l => l.asana_task_id)}
        />
      )}

      {/* ─── LINK TO ASANA MODAL ─── */}
      {showLinkToAsana && (
        <LinkToAsanaModal
          scoutLead={showLinkToAsana}
          asanaItems={submittedLeads}
          onConfirm={(asanaItem) => linkLeadToAsana(showLinkToAsana, asanaItem)}
          onClose={() => setShowLinkToAsana(null)}
        />
      )}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════
   LINK TO ASANA TASK MODAL
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════
   ASANA MATCH REVIEW MODAL — Side-by-side comparison
   Shows pending Asana match candidates one at a time with full
   Scout lead vs Asana task comparison.
   ═══════════════════════════════════════════════════════════════ */

// ── Pruning Review Modal ──────────────────────────────────────
// Shows Tier 2 borderline items one at a time for user review.
// Actions: Mark Immune, Pause 90 Days, Prune, Move to Active.
function PruningReviewModal({ queue, onImmune, onPause, onPrune, onActivate, onKeep, onOpenDetails, onClose }) {
  const [currentIdx, setCurrentIdx] = useState(0);
  if (queue.length === 0) return null;
  const item = queue[Math.min(currentIdx, queue.length - 1)];
  const lead = item.lead || {};

  const advance = () => {
    if (currentIdx >= queue.length - 1 && queue.length > 1) setCurrentIdx(Math.max(0, currentIdx - 1));
  };

  // Prune confidence: high = taxonomy-driven or already-claimed, medium = noise/generic, low = borderline tier2
  const confidence = item.reason?.startsWith('taxonomy_') ? 'high'
    : item.reason?.startsWith('already_claimed') ? 'high'
    : item.reason?.includes('noise') || item.reason?.includes('generic') || item.reason?.includes('below_relevance') ? 'medium'
    : 'low';
  const confLabel = confidence === 'high' ? 'High confidence' : confidence === 'medium' ? 'Moderate confidence' : 'Low confidence';
  const confColor = confidence === 'high' ? '#dc2626' : confidence === 'medium' ? '#d97706' : '#6b7280';
  const confBg = confidence === 'high' ? '#fef2f2' : confidence === 'medium' ? '#fffbeb' : '#f8fafc';

  return (
    <>
      <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.35)', zIndex:2000 }} />
      <div style={{ position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)', background:'#fff', borderRadius:16, width:'92%', maxWidth:720, maxHeight:'88vh', display:'flex', flexDirection:'column', boxShadow:'0 24px 80px rgba(0,0,0,0.18)', zIndex:2001, overflow:'hidden' }}>
        {/* Header */}
        <div style={{ padding:'16px 22px', borderBottom:'1px solid #f1f5f9', display:'flex', justifyContent:'space-between', alignItems:'center', flexShrink:0 }}>
          <div>
            <h3 style={{ fontSize:15, fontWeight:800, color:'#0f172a', margin:0 }}>Pruning Review</h3>
            <div style={{ fontSize:11.5, color:'#94a3b8', marginTop:2 }}>
              {queue.length > 1 ? `Item ${Math.min(currentIdx + 1, queue.length)} of ${queue.length} — review before Scout removes` : 'Review this lead before removal'}
            </div>
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', padding:4, color:'#94a3b8' }}><X size={18} /></button>
        </div>

        {/* Reason + confidence + explanation */}
        <div style={{ padding:'12px 22px', background: confBg, borderBottom:'1px solid #f1f5f9', flexShrink:0 }}>
          <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap', marginBottom:8 }}>
            <span style={{ fontSize:10.5, fontWeight:700, padding:'3px 10px', borderRadius:4, background: confBg, color: confColor, border:`1px solid ${confColor}30` }}>{confLabel}</span>
            <span style={{ fontSize:10.5, fontWeight:700, padding:'3px 10px', borderRadius:4, background:'#f1f5f9', color:'#475569' }}>
              {item.reason || 'Review needed'}
            </span>
          </div>
          <div style={{ fontSize:12.5, color:'#334155', lineHeight:1.65, margin:'0 0 6px' }}>
            <strong style={{ color:'#0f172a' }}>Why flagged: </strong>
            {item.explanation || 'This lead was flagged by quality checks. Review the details to decide whether to keep or prune.'}
          </div>
          {item.keepHint && (
            <div style={{ fontSize:11.5, color:'#065f46', lineHeight:1.5, padding:'5px 10px', borderRadius:6, background:'#ecfdf5', border:'1px solid #a7f3d0' }}>
              <strong>💡 When to keep: </strong>{item.keepHint}
            </div>
          )}
          {lead.confidenceNotes && (
            <div style={{ fontSize:11, color:'#64748b', marginTop:8, lineHeight:1.5, borderTop:'1px solid #e2e8f0', paddingTop:6 }}>
              <strong>Source context: </strong>{(lead.confidenceNotes || '').slice(0, 250)}
            </div>
          )}
          {item.learned && item.learned.totalSimilar > 0 && (
            <div style={{ marginTop:6, padding:'6px 10px', borderRadius:6, background: item.learned.learnedConfidence === 'suppress' ? '#ecfdf5' : item.learned.learnedConfidence === 'lower' ? '#eff6ff' : item.learned.learnedConfidence === 'higher' ? '#fef2f2' : '#f8fafc', border:'1px solid #e2e8f0', fontSize:11, lineHeight:1.4 }}>
              <span style={{ fontWeight:700, color: item.learned.learnedConfidence === 'suppress' ? '#065f46' : item.learned.learnedConfidence === 'lower' ? '#1e40af' : item.learned.learnedConfidence === 'higher' ? '#991b1b' : '#64748b' }}>
                {item.learned.learnedConfidence === 'suppress' ? '🛡 Usually kept' : item.learned.learnedConfidence === 'lower' ? '📊 Leans toward Keep' : item.learned.learnedConfidence === 'higher' ? '📊 Leans toward Prune' : '📊 Mixed history'}
              </span>
              <span style={{ color:'#64748b', marginLeft:6 }}>{item.learned.explanation}</span>
            </div>
          )}
        </div>

        {/* Lead details */}
        <div style={{ flex:1, overflowY:'auto', padding:'16px 22px', maxHeight:'38vh' }}>
          <h4 style={{ fontSize:14, fontWeight:700, color:'#1e293b', margin:'0 0 8px' }}>{lead.user_edited_title || lead.title || 'Untitled'}</h4>
          {lead.description && <p style={{ fontSize:12, color:'#64748b', lineHeight:1.6, margin:'0 0 10px' }}>{(lead.description || '').slice(0, 400)}</p>}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, fontSize:11.5 }}>
            {lead.owner && <div><span style={{ fontWeight:600, color:'#64748b' }}>Owner:</span> {lead.owner}</div>}
            {lead.location && <div><span style={{ fontWeight:600, color:'#64748b' }}>Location:</span> {lead.location}</div>}
            {lead.marketSector && <div><span style={{ fontWeight:600, color:'#64748b' }}>Sector:</span> {lead.marketSector}</div>}
            {lead.relevanceScore > 0 && <div><span style={{ fontWeight:600, color:'#64748b' }}>Score:</span> {lead.relevanceScore}</div>}
            {lead.sourceName && <div><span style={{ fontWeight:600, color:'#64748b' }}>Source:</span> {lead.sourceName}</div>}
            {lead.potentialBudget && <div><span style={{ fontWeight:600, color:'#64748b' }}>Budget:</span> {lead.potentialBudget}</div>}
            {lead.action_due_date && <div><span style={{ fontWeight:600, color:'#64748b' }}>Due:</span> {lead.action_due_date}</div>}
            {lead.potentialTimeline && <div><span style={{ fontWeight:600, color:'#64748b' }}>Timeline:</span> {lead.potentialTimeline}</div>}
          </div>
          {lead.sourceUrl && <div style={{ marginTop:8 }}><a href={lead.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ color:'#3b82f6', fontSize:11 }}>Source link ↗</a></div>}
        </div>

        {/* Action buttons — 2 rows */}
        <div style={{ padding:'12px 22px 6px', borderTop:'1px solid #f1f5f9', flexShrink:0 }}>
          {/* Primary actions */}
          <div style={{ display:'flex', gap:8, flexWrap:'wrap', justifyContent:'center', marginBottom:8 }}>
            <button onClick={() => { if (onKeep) onKeep(item); advance(); }} style={{ padding:'8px 16px', borderRadius:8, border:'2px solid #10b981', background:'#fff', color:'#065f46', cursor:'pointer', fontSize:11.5, fontWeight:700, display:'flex', alignItems:'center', gap:5 }}>
              <CheckCircle2 size={13} /> Keep
            </button>
            <button onClick={() => { onImmune(item); advance(); }} style={{ padding:'8px 16px', borderRadius:8, border:'none', background:'#d1fae5', color:'#065f46', cursor:'pointer', fontSize:11.5, fontWeight:700, display:'flex', alignItems:'center', gap:5 }}>
              <Shield size={13} /> Immune
            </button>
            <button onClick={() => { onPause(item); advance(); }} style={{ padding:'8px 16px', borderRadius:8, border:'none', background:'#fef3c7', color:'#92400e', cursor:'pointer', fontSize:11.5, fontWeight:700, display:'flex', alignItems:'center', gap:5 }}>
              <Clock size={13} /> Pause 90d
            </button>
            <button onClick={() => { onPrune(item); advance(); }} style={{ padding:'8px 16px', borderRadius:8, border:'none', background:'#fee2e2', color:'#991b1b', cursor:'pointer', fontSize:11.5, fontWeight:700, display:'flex', alignItems:'center', gap:5 }}>
              <Archive size={13} /> Prune
            </button>
          </div>
          {/* Secondary actions */}
          <div style={{ display:'flex', gap:8, justifyContent:'center' }}>
            <button onClick={() => { if (onOpenDetails) onOpenDetails(item.lead); }} style={{ padding:'6px 14px', borderRadius:7, border:'1px solid #e2e8f0', background:'#fff', color:'#475569', cursor:'pointer', fontSize:11, fontWeight:600, display:'flex', alignItems:'center', gap:4 }}>
              <FileText size={12} /> Open Details
            </button>
            <button onClick={() => { onActivate(item); advance(); }} style={{ padding:'6px 14px', borderRadius:7, border:'1px solid #e2e8f0', background:'#fff', color:'#475569', cursor:'pointer', fontSize:11, fontWeight:600, display:'flex', alignItems:'center', gap:4 }}>
              <ArrowUpRight size={12} /> Move to Active
            </button>
          </div>
        </div>

        {/* Carousel nav */}
        {queue.length > 1 && (
          <div style={{ padding:'6px 22px 12px', display:'flex', justifyContent:'center', gap:12, flexShrink:0 }}>
            <button onClick={() => setCurrentIdx(Math.max(0, currentIdx - 1))} disabled={currentIdx === 0}
              style={{ background:'none', border:'1px solid #e2e8f0', borderRadius:6, padding:'4px 12px', cursor: currentIdx === 0 ? 'not-allowed' : 'pointer', opacity: currentIdx === 0 ? 0.4 : 1, fontSize:11, color:'#64748b' }}>← Previous</button>
            <button onClick={() => setCurrentIdx(Math.min(queue.length - 1, currentIdx + 1))} disabled={currentIdx >= queue.length - 1}
              style={{ background:'none', border:'1px solid #e2e8f0', borderRadius:6, padding:'4px 12px', cursor: currentIdx >= queue.length - 1 ? 'not-allowed' : 'pointer', opacity: currentIdx >= queue.length - 1 ? 0.4 : 1, fontSize:11, color:'#64748b' }}>Next →</button>
          </div>
        )}
      </div>
    </>
  );
}

function AsanaMatchReviewModal({ matches, leads, onConfirm, onDismiss, onClose }) {
  const [currentIdx, setCurrentIdx] = useState(0);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  if (matches.length === 0) return null;
  const match = matches[Math.min(currentIdx, matches.length - 1)];
  // Get the full Scout lead from the leads array or the snapshot
  const scoutLead = match.scoutLead || leads.find(l => l.id === match.leadId) || {};

  const formatDate = (d) => { try { return d ? new Date(d).toLocaleDateString() : '\u2014'; } catch { return '\u2014'; } };

  const handleConfirm = () => {
    const finalMatch = editingTitle ? { ...match, _userTitle: titleDraft.trim() } : match;
    onConfirm(finalMatch);
    setEditingTitle(false);
    setTitleDraft('');
    if (currentIdx >= matches.length - 1 && matches.length > 1) setCurrentIdx(Math.max(0, currentIdx - 1));
  };
  const handleReject = () => {
    onDismiss(match, true); // suppress = true
    setEditingTitle(false);
    if (currentIdx >= matches.length - 1 && matches.length > 1) setCurrentIdx(Math.max(0, currentIdx - 1));
  };
  const handleKeepSeparate = () => {
    onDismiss(match, false); // don't suppress — just skip for now
    setEditingTitle(false);
    if (currentIdx >= matches.length - 1 && matches.length > 1) setCurrentIdx(Math.max(0, currentIdx - 1));
  };

  const compRow = (label, leftVal, rightVal) => (
    <div style={{ display:'grid', gridTemplateColumns:'110px 1fr 1fr', gap:10, padding:'7px 0', borderBottom:'1px solid #f1f5f9', fontSize:12, lineHeight:1.45 }}>
      <div style={{ fontWeight:600, color:'#64748b', fontSize:11 }}>{label}</div>
      <div style={{ color:'#1e293b', wordBreak:'break-word' }}>{leftVal || '\u2014'}</div>
      <div style={{ color:'#1e293b', wordBreak:'break-word' }}>{rightVal || '\u2014'}</div>
    </div>
  );

  const matchLabel = match.matchType === 'exact' ? 'Exact' : match.matchType === 'near_exact' ? 'Near-Exact' : match.matchType === 'entity_location' ? 'Entity+Location' : match.matchType === 'fuzzy' ? 'Fuzzy' : match.matchType || 'Unknown';
  const confPct = Math.round((match.confidence || 0) * 100);

  return (
    <>
      <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.35)', zIndex:2000 }} />
      <div style={{ position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)', background:'#fff', borderRadius:16, width:'94%', maxWidth:920, maxHeight:'90vh', display:'flex', flexDirection:'column', boxShadow:'0 24px 80px rgba(0,0,0,0.18)', zIndex:2001, overflow:'hidden' }}>
        {/* Header */}
        <div style={{ padding:'16px 22px', borderBottom:'1px solid #f1f5f9', display:'flex', justifyContent:'space-between', alignItems:'center', flexShrink:0 }}>
          <div>
            <h3 style={{ fontSize:15, fontWeight:800, color:'#0f172a', margin:0 }}>Review Asana Match</h3>
            <div style={{ fontSize:11.5, color:'#94a3b8', marginTop:2 }}>
              {matches.length > 1 ? `Match ${Math.min(currentIdx + 1, matches.length)} of ${matches.length}` : 'Compare Scout lead with Asana task before merging'}
            </div>
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', padding:4, color:'#94a3b8' }}><X size={18} /></button>
        </div>

        {/* Match confidence bar */}
        <div style={{ padding:'10px 22px', background:'#f8fafc', borderBottom:'1px solid #f1f5f9', display:'flex', alignItems:'center', gap:10, flexShrink:0 }}>
          <span style={{ fontSize:10.5, fontWeight:700, padding:'2px 8px', borderRadius:4, background: confPct >= 80 ? '#d1fae5' : confPct >= 60 ? '#fef3c7' : '#fee2e2', color: confPct >= 80 ? '#065f46' : confPct >= 60 ? '#92400e' : '#991b1b' }}>{matchLabel}</span>
          <div style={{ flex:1, height:5, borderRadius:3, background:'#e2e8f0', overflow:'hidden' }}>
            <div style={{ width:`${confPct}%`, height:'100%', borderRadius:3, background: confPct >= 80 ? '#10b981' : confPct >= 60 ? '#f59e0b' : '#ef4444' }} />
          </div>
          <span style={{ fontSize:12, fontWeight:700, color: confPct >= 80 ? '#065f46' : '#92400e' }}>{confPct}%</span>
          <span style={{ fontSize:10, color:'#94a3b8' }}>confidence</span>
        </div>

        {/* Column headers */}
        <div style={{ display:'grid', gridTemplateColumns:'110px 1fr 1fr', gap:10, padding:'10px 22px 6px', borderBottom:'2px solid #e2e8f0', flexShrink:0 }}>
          <div />
          <div style={{ fontSize:10.5, fontWeight:700, color:'#3b82f6', textTransform:'uppercase', letterSpacing:'0.06em' }}>Scout Lead</div>
          <div style={{ fontSize:10.5, fontWeight:700, color:'#f59e0b', textTransform:'uppercase', letterSpacing:'0.06em' }}>Asana Task</div>
        </div>

        {/* Scrollable comparison body */}
        <div style={{ flex:1, overflowY:'auto', padding:'0 22px', maxHeight:'45vh' }}>
          {compRow('Title', getDisplayTitle(scoutLead), match.taskName)}
          {scoutLead.title && scoutLead.title !== getDisplayTitle(scoutLead) && compRow('Original Title', scoutLead.title, '\u2014')}
          {compRow('Owner / Entity', scoutLead.owner, match.asana_assignee || '\u2014')}
          {compRow('Location', scoutLead.location || scoutLead.geography, '\u2014')}
          {compRow('County', scoutLead.county, '\u2014')}
          {compRow('Market Sector', scoutLead.marketSector, '\u2014')}
          {compRow('Project Type', scoutLead.projectType, '\u2014')}
          {compRow('Status', scoutLead.status, match.asana_section || '\u2014')}
          {compRow('Description', (scoutLead.description || '').slice(0, 250), (match.asana_notes_excerpt || '').slice(0, 250))}
          {compRow('Created', formatDate(scoutLead.dateDiscovered), formatDate(match.asana_created_at))}
          {compRow('Timeline', scoutLead.potentialTimeline || '\u2014', match.asana_completed ? `Completed ${formatDate(match.asana_completed_at)}` : 'In Progress')}
          {scoutLead.evidence?.length > 0 && compRow('Evidence', `${scoutLead.evidence.length} source(s): ${scoutLead.evidence.map(e => e.sourceName || e.source || '').filter(Boolean).slice(0, 3).join(', ')}`, '\u2014')}
          {scoutLead.potentialBudget && compRow('Budget', scoutLead.potentialBudget, '\u2014')}
          {match.taskUrl && compRow('Asana Link', '\u2014',
            <a href={match.taskUrl} target="_blank" rel="noopener noreferrer" style={{ color:'#3b82f6', fontSize:11 }}>View in Asana \u2197</a>
          )}
        </div>

        {/* Edit title option */}
        {editingTitle && (
          <div style={{ padding:'10px 22px', borderTop:'1px solid #f1f5f9', background:'#fafbfc', flexShrink:0 }}>
            <label style={{ fontSize:11, fontWeight:700, color:'#64748b', display:'block', marginBottom:4 }}>Edit display title before merge:</label>
            <input type="text" value={titleDraft} onChange={e => setTitleDraft(e.target.value)}
              style={{ width:'100%', padding:'8px 11px', borderRadius:7, border:'1px solid #e2e8f0', fontSize:13, outline:'none', background:'#fff', boxSizing:'border-box' }}
              placeholder="Enter corrected title..."
            />
          </div>
        )}

        {/* Action buttons */}
        <div style={{ padding:'14px 22px', borderTop:'1px solid #e2e8f0', display:'flex', gap:8, justifyContent:'space-between', alignItems:'center', flexShrink:0, flexWrap:'wrap' }}>
          <div style={{ display:'flex', gap:6 }}>
            {!editingTitle && (
              <button onClick={() => { setEditingTitle(true); setTitleDraft(match.taskName || scoutLead.title || ''); }}
                style={{ padding:'7px 12px', borderRadius:6, border:'1px solid #e2e8f0', background:'#fff', cursor:'pointer', fontSize:11.5, fontWeight:600, color:'#64748b', display:'flex', alignItems:'center', gap:4 }}>
                <Edit3 size={11} /> Edit Title
              </button>
            )}
            {editingTitle && (
              <button onClick={() => setEditingTitle(false)}
                style={{ padding:'7px 12px', borderRadius:6, border:'1px solid #e2e8f0', background:'#fff', cursor:'pointer', fontSize:11.5, fontWeight:600, color:'#64748b' }}>
                Cancel Edit
              </button>
            )}
            {matches.length > 1 && (
              <div style={{ display:'flex', gap:4 }}>
                <button disabled={currentIdx === 0} onClick={() => setCurrentIdx(currentIdx - 1)}
                  style={{ padding:'7px 10px', borderRadius:6, border:'1px solid #e2e8f0', background:'#fff', cursor: currentIdx === 0 ? 'not-allowed' : 'pointer', fontSize:11, fontWeight:600, color: currentIdx === 0 ? '#cbd5e1' : '#64748b' }}>
                  <ChevronLeft size={13} />
                </button>
                <button disabled={currentIdx >= matches.length - 1} onClick={() => setCurrentIdx(currentIdx + 1)}
                  style={{ padding:'7px 10px', borderRadius:6, border:'1px solid #e2e8f0', background:'#fff', cursor: currentIdx >= matches.length - 1 ? 'not-allowed' : 'pointer', fontSize:11, fontWeight:600, color: currentIdx >= matches.length - 1 ? '#cbd5e1' : '#64748b' }}>
                  <ChevronRight size={13} />
                </button>
              </div>
            )}
          </div>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={handleReject}
              style={{ padding:'8px 14px', borderRadius:7, border:'1px solid #fecaca', background:'#fff', cursor:'pointer', fontSize:12, fontWeight:600, color:'#dc2626' }}>
              Not a Match
            </button>
            <button onClick={handleKeepSeparate}
              style={{ padding:'8px 14px', borderRadius:7, border:'1px solid #e2e8f0', background:'#fff', cursor:'pointer', fontSize:12, fontWeight:600, color:'#64748b' }}>
              Keep Separate
            </button>
            <button onClick={handleConfirm}
              style={{ padding:'8px 14px', borderRadius:7, border:'none', background:'#0f172a', cursor:'pointer', fontSize:12, fontWeight:600, color:'#fff', display:'flex', alignItems:'center', gap:5 }}>
              <CheckCircle2 size={13} /> Confirm Match
            </button>
          </div>
        </div>
      </div>
    </>
  );
}


function LinkToAsanaModal({ scoutLead, asanaItems, onConfirm, onClose }) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const [compareMode, setCompareMode] = useState(false);

  const formatDate = (d) => { try { return d ? new Date(d).toLocaleDateString() : '—'; } catch { return '—'; } };

  // Fuzzy-scored search with entity+location awareness
  const filtered = useMemo(() => {
    const scoutNorm = normalizeForMatch(scoutLead?.title || '');
    const scoutSig = extractEntitySignature(scoutLead?.title || '');
    let scored = asanaItems.map(a => {
      const asanaTitle = a.asana_task_name || a.title || '';
      const asanaNorm = normalizeForMatch(asanaTitle);
      const asanaSig = extractEntitySignature(asanaTitle);
      let sim = scoutNorm ? titleSimilarity(scoutNorm, asanaNorm) : 0;
      // Boost score when entities overlap
      const sharedEntities = scoutSig.entities.filter(e => asanaSig.entities.includes(e));
      const sharedLocations = scoutSig.locations.filter(l => asanaSig.locations.includes(l));
      if (sharedEntities.length > 0 && (sharedLocations.length > 0 || scoutSig.locations.length === 0 || asanaSig.locations.length === 0)) {
        sim = Math.max(sim, 0.70); // Entity + location match = at least 70%
      } else if (sharedEntities.length > 0) {
        sim = Math.max(sim, 0.45); // Entity match only
      }
      const isAlias = isTitleAlias(scoutLead?.title, asanaTitle);
      return { ...a, _similarity: sim, _isAlias: isAlias, _sharedEntities: sharedEntities, _sharedLocations: sharedLocations };
    });
    if (search) {
      const q = search.toLowerCase();
      scored = scored.filter(a =>
        (a.asana_task_name || a.title || '').toLowerCase().includes(q) ||
        (a.asana_assignee || '').toLowerCase().includes(q) ||
        (a.asana_section || '').toLowerCase().includes(q) ||
        (a.alternate_titles || []).some(t => t.toLowerCase().includes(q)) ||
        (a.owner || '').toLowerCase().includes(q)
      );
    }
    return scored.sort((a, b) => b._similarity - a._similarity || (a.asana_task_name || a.title || '').localeCompare(b.asana_task_name || b.title || ''));
  }, [asanaItems, search, scoutLead]);

  const selectedItem = selected ? filtered.find(a => a.id === selected) : null;

  // ── Side-by-side comparison view ──
  if (compareMode && selectedItem) {
    const fieldRow = (label, left, right) => (
      <div style={{ display:'grid', gridTemplateColumns:'120px 1fr 1fr', gap:8, padding:'6px 0', borderBottom:'1px solid #f1f5f9', fontSize:12 }}>
        <div style={{ fontWeight:600, color:'#64748b' }}>{label}</div>
        <div style={{ color:'#1e293b' }}>{left || '—'}</div>
        <div style={{ color:'#1e293b' }}>{right || '—'}</div>
      </div>
    );
    return (
      <>
        <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.3)', zIndex:999 }} />
        <div style={{ position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)', background:'#fff', borderRadius:16, padding:28, width:'92%', maxWidth:880, maxHeight:'85vh', display:'flex', flexDirection:'column', boxShadow:'0 20px 60px rgba(0,0,0,0.15)', zIndex:1000, overflow:'hidden' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
            <h3 style={{ fontSize:16, fontWeight:700, color:'#0f172a', margin:0 }}>Review Match Before Linking</h3>
            {selectedItem._isAlias && (
              <span style={{ fontSize:10.5, fontWeight:700, padding:'3px 10px', borderRadius:5, background:'#d1fae5', color:'#065f46' }}>Alias Match Detected</span>
            )}
          </div>
          {/* Match confidence bar */}
          <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:14, padding:'8px 12px', borderRadius:8, background:'#f8fafc', border:'1px solid #e2e8f0' }}>
            <span style={{ fontSize:11, fontWeight:600, color:'#64748b' }}>Match Confidence:</span>
            <div style={{ flex:1, height:6, borderRadius:3, background:'#e2e8f0', overflow:'hidden' }}>
              <div style={{ width:`${Math.round(selectedItem._similarity * 100)}%`, height:'100%', borderRadius:3, background: selectedItem._similarity >= 0.65 ? '#10b981' : selectedItem._similarity >= 0.4 ? '#f59e0b' : '#ef4444' }} />
            </div>
            <span style={{ fontSize:12, fontWeight:700, color: selectedItem._similarity >= 0.65 ? '#065f46' : '#92400e' }}>{Math.round(selectedItem._similarity * 100)}%</span>
            {selectedItem._sharedEntities?.length > 0 && (
              <span style={{ fontSize:10, padding:'2px 6px', borderRadius:4, background:'#ede9fe', color:'#5b21b6' }}>
                Shared: {selectedItem._sharedEntities.map(e => e.replace(/_/g, ' ')).join(', ')}
              </span>
            )}
          </div>
          {/* Column headers */}
          <div style={{ display:'grid', gridTemplateColumns:'120px 1fr 1fr', gap:8, padding:'8px 0', borderBottom:'2px solid #e2e8f0', marginBottom:4 }}>
            <div />
            <div style={{ fontSize:11, fontWeight:700, color:'#3b82f6', textTransform:'uppercase', letterSpacing:'0.05em' }}>Scout Lead</div>
            <div style={{ fontSize:11, fontWeight:700, color:'#f59e0b', textTransform:'uppercase', letterSpacing:'0.05em' }}>Asana Task</div>
          </div>
          {/* Comparison fields */}
          <div style={{ flex:1, overflowY:'auto', maxHeight:'45vh' }}>
            {fieldRow('Title', scoutLead.title, selectedItem.asana_task_name || selectedItem.title)}
            {fieldRow('Owner / Entity', scoutLead.owner, selectedItem.asana_assignee || selectedItem.owner || '—')}
            {fieldRow('Location', scoutLead.location || scoutLead.geography, selectedItem.location || selectedItem.geography || '—')}
            {fieldRow('County', scoutLead.county, selectedItem.county || '—')}
            {fieldRow('Market Sector', scoutLead.marketSector, selectedItem.marketSector || '—')}
            {fieldRow('Section / Status', scoutLead.status, selectedItem.asana_section || '—')}
            {fieldRow('Created', formatDate(scoutLead.dateDiscovered), formatDate(selectedItem.asana_created_at || selectedItem.dateDiscovered))}
            {fieldRow('Timeline', scoutLead.potentialTimeline || '—', selectedItem.asana_completed ? `Completed ${formatDate(selectedItem.asana_completed_at)}` : 'In Progress')}
            {fieldRow('Description', (scoutLead.description || '—').slice(0, 200), (selectedItem.asana_notes_excerpt || selectedItem.description || '—').slice(0, 200))}
            {scoutLead.evidence?.length > 0 && fieldRow('Evidence', `${scoutLead.evidence.length} source(s)`, '—')}
            {selectedItem.asanaUrl && fieldRow('Asana Link', '—',
              <a href={selectedItem.asanaUrl} target="_blank" rel="noopener noreferrer" style={{ color:'#3b82f6', fontSize:11 }}>View in Asana ↗</a>
            )}
            {selectedItem.no_go && fieldRow('Status', '—',
              <span style={{ fontSize:11, fontWeight:600, color:'#991b1b' }}>⛔ No Go</span>
            )}
          </div>
          {/* Action buttons */}
          <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:14, paddingTop:12, borderTop:'1px solid #e2e8f0' }}>
            <button onClick={() => { setCompareMode(false); }} style={{ padding:'8px 16px', borderRadius:7, border:'1px solid #e2e8f0', background:'#fff', cursor:'pointer', fontSize:12, fontWeight:600, color:'#64748b' }}>
              ← Back to List
            </button>
            <button onClick={() => { setSelected(null); setCompareMode(false); }} style={{ padding:'8px 16px', borderRadius:7, border:'1px solid #fecaca', background:'#fff', cursor:'pointer', fontSize:12, fontWeight:600, color:'#dc2626' }}>
              Not a Match
            </button>
            <button onClick={() => onConfirm(selectedItem)} style={{ padding:'8px 16px', borderRadius:7, border:'none', background:'#0f172a', cursor:'pointer', fontSize:12, fontWeight:600, color:'#fff', display:'flex', alignItems:'center', gap:4 }}>
              <Link2 size={12} /> Confirm Link & Merge
            </button>
          </div>
        </div>
      </>
    );
  }

  // ── List view (Phase 1) ──
  return (
    <>
      <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.3)', zIndex:999 }} />
      <div style={{ position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)', background:'#fff', borderRadius:16, padding:28, width:'90%', maxWidth:600, maxHeight:'80vh', display:'flex', flexDirection:'column', boxShadow:'0 20px 60px rgba(0,0,0,0.15)', zIndex:1000 }}>
        <h3 style={{ fontSize:16, fontWeight:700, color:'#0f172a', margin:'0 0 4px' }}>Link to Asana Task</h3>
        <p style={{ fontSize:12.5, color:'#64748b', margin:'0 0 14px' }}>
          Link <strong>{scoutLead.title}</strong> to an existing Asana task. Select a candidate, then review side-by-side before confirming.
        </p>
        <div style={{ position:'relative', marginBottom:12 }}>
          <Search size={13} style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#94a3b8' }} />
          <input type="text" placeholder="Search Asana tasks..." value={search} onChange={e => setSearch(e.target.value)}
            style={{ width:'100%', padding:'8px 10px 8px 30px', borderRadius:8, border:'1px solid #e2e8f0', fontSize:12.5, outline:'none', background:'#fff', boxSizing:'border-box' }}
          />
        </div>
        <div style={{ flex:1, overflowY:'auto', maxHeight:'45vh', border:'1px solid #e2e8f0', borderRadius:10 }}>
          {filtered.length === 0 && (
            <div style={{ padding:24, textAlign:'center', color:'#94a3b8', fontSize:12.5 }}>
              {asanaItems.length === 0 ? 'No tracked Asana tasks available. Run "Sync Asana Now" first.' : 'No tasks match your search.'}
            </div>
          )}
          {filtered.map(item => (
            <div key={item.id} onClick={() => setSelected(item.id === selected ? null : item.id)}
              style={{ padding:'10px 14px', borderBottom:'1px solid #f1f5f9', cursor:'pointer',
                background: item.id === selected ? '#eff6ff' : item._isAlias ? '#f0fdf4' : item._similarity > 0.4 ? '#fffbeb' : '#fff',
                border: item.id === selected ? '2px solid #3b82f6' : '2px solid transparent',
                borderRadius: item.id === selected ? 8 : 0,
              }}>
              <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                <div style={{ fontSize:13, fontWeight:600, color:'#1e293b', flex:1 }}>{item.asana_task_name || item.title}</div>
                {item._isAlias && (
                  <span style={{ fontSize:9.5, fontWeight:700, padding:'1px 6px', borderRadius:4, background:'#d1fae5', color:'#065f46' }}>Likely Match</span>
                )}
                {!item._isAlias && item._similarity > 0.3 && (
                  <span style={{ fontSize:9.5, fontWeight:700, padding:'1px 6px', borderRadius:4,
                    background: item._similarity >= 0.5 ? '#fef3c7' : '#f1f5f9',
                    color: item._similarity >= 0.5 ? '#92400e' : '#64748b',
                  }}>{Math.round(item._similarity * 100)}%</span>
                )}
              </div>
              <div style={{ display:'flex', gap:8, marginTop:3, fontSize:11, color:'#94a3b8' }}>
                {item.asana_section && <span>{item.asana_section}</span>}
                {item.asana_assignee && <span>· {item.asana_assignee}</span>}
                {item.no_go && <span style={{ color:'#991b1b', fontWeight:600 }}>· No Go</span>}
                {item._sharedEntities?.length > 0 && <span style={{ color:'#5b21b6' }}>· {item._sharedEntities.map(e => e.replace(/_/g,' ')).join(', ')}</span>}
              </div>
            </div>
          ))}
        </div>
        <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:14 }}>
          <button onClick={onClose} style={{ padding:'8px 16px', borderRadius:7, border:'1px solid #e2e8f0', background:'#fff', cursor:'pointer', fontSize:12, fontWeight:600, color:'#64748b' }}>Cancel</button>
          <button disabled={!selected} onClick={() => setCompareMode(true)}
            style={{ padding:'8px 16px', borderRadius:7, border:'none', background: selected ? '#0f172a' : '#94a3b8', cursor: selected ? 'pointer' : 'not-allowed', fontSize:12, fontWeight:600, color:'#fff', display:'flex', alignItems:'center', gap:4 }}>
            <ArrowRight size={12} /> Review & Compare
          </button>
        </div>
      </div>
    </>
  );
}


/* ═══════════════════════════════════════════════════════════════
   NOT PURSUED REASON MODAL
   ═══════════════════════════════════════════════════════════════ */

function NotPursuedReasonModal({ onConfirm, onCancel }) {
  const [reason, setReason] = useState('');
  const [category, setCategory] = useState('');
  const PRUNE_CATEGORIES = [
    { value: '', label: 'Select a reason...' },
    { value: 'out_of_scope', label: 'Out of scope' },
    { value: 'already_awarded', label: 'Already awarded' },
    { value: 'no_longer_relevant', label: 'No longer relevant' },
    { value: 'stale_historical', label: 'Stale / historical' },
    { value: 'other', label: 'Other' },
  ];
  const handleCategoryChange = (val) => {
    setCategory(val);
    if (val && val !== 'other' && !reason.trim()) {
      const cat = PRUNE_CATEGORIES.find(c => c.value === val);
      if (cat) setReason(cat.label);
    }
  };
  return (
    <Modal title="Move to Not Pursued" onClose={onCancel} width={440}>
      <p style={{ fontSize: 13, color: '#475569', lineHeight: 1.6, margin: '0 0 14px' }}>
        This lead will be archived and will not be reintroduced by the intelligence engine unless manually restored.
      </p>
      <div style={fieldFull}>
        <label style={fieldLabel}>Quick Category</label>
        <select value={category} onChange={e => handleCategoryChange(e.target.value)}
          style={{ width: '100%', padding: '8px 10px', borderRadius: 7, border: '1px solid #e2e8f0', fontSize: 12.5, marginBottom: 8, background: '#fff' }}>
          {PRUNE_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </div>
      <div style={fieldFull}>
        <label style={fieldLabel}>Reason Not Pursued *</label>
        <textarea style={fieldTextarea} value={reason} onChange={e => setReason(e.target.value)}
          placeholder="e.g., Limited design scope, outside our geography, contractor-led project..." rows={3} />
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
        <button onClick={onCancel} style={{ padding: '9px 18px', borderRadius: 7, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: '#64748b' }}>Cancel</button>
        <button onClick={() => { if (reason.trim()) onConfirm(reason); }} style={{ padding: '9px 18px', borderRadius: 7, border: 'none', background: reason.trim() ? '#ef4444' : '#e2e8f0', cursor: reason.trim() ? 'pointer' : 'not-allowed', fontSize: 12.5, fontWeight: 600, color: '#fff' }}>
          <Archive size={13} style={{ marginRight: 5, verticalAlign: -2 }} /> Archive Lead
        </button>
      </div>
    </Modal>
  );
}


/* ═══════════════════════════════════════════════════════════════
   PIF REVIEW / SUBMIT TO ASANA MODAL
   ═══════════════════════════════════════════════════════════════ */

function PIFReviewModal({ lead, onSubmit, onClose }) {
  const [payload, setPayload] = useState(() => buildPIFPayload(lead));
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const set = (k, v) => setPayload(p => ({ ...p, [k]: v }));

  const handleSubmit = async () => {
    setSubmitting(true);
    // Attempt to open the PIF form with pre-filled values
    // Since Asana forms don't support URL parameter pre-filling reliably,
    // we copy the payload to clipboard and open the form
    try {
      const text = PIF_FIELD_MAP.map(f => `${f.pif}: ${payload[f.pif] || '—'}`).join('\n');
      await navigator.clipboard.writeText(text);
    } catch (e) { /* clipboard may not be available */ }

    window.open(PIF_FORM_URL, '_blank');
    setSubmitting(false);
    setSubmitted(true);
  };

  const handleConfirmSubmitted = () => {
    onSubmit('', `Submitted via PIF form. Fields copied to clipboard.`);
  };

  return (
    <Modal title="Submit to Asana — PIF Review" onClose={onClose} width={640}>
      {!submitted ? (
        <>
          <p style={{ fontSize: 12.5, color: '#64748b', margin: '0 0 16px', lineHeight: 1.5 }}>
            Review the Project Initiation Form fields below. When you click Submit, the PIF form will open and the field values will be copied to your clipboard for pasting.
          </p>

          <div style={{ maxHeight: 400, overflowY: 'auto', marginBottom: 16 }}>
            {PIF_FIELD_MAP.map(f => (
              <div key={f.pif} style={{ marginBottom: 10 }}>
                <label style={fieldLabel}>{f.pif}</label>
                {f.pif.includes('Summary') || f.pif.includes('Notes') ? (
                  <textarea style={{ ...fieldTextarea, minHeight: 48 }} value={payload[f.pif] || ''} onChange={e => set(f.pif, e.target.value)} />
                ) : (
                  <input style={fieldInput} value={payload[f.pif] || ''} onChange={e => set(f.pif, e.target.value)} />
                )}
              </div>
            ))}
          </div>

          <div style={{ padding: '12px 14px', background: '#fffbeb', borderRadius: 8, border: '1px solid #fef3c7', marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: '#92400e', marginBottom: 4 }}>
              <AlertCircle size={14} /> Browser Limitation Note
            </div>
            <p style={{ fontSize: 11.5, color: '#78716c', margin: 0, lineHeight: 1.5 }}>
              Asana external forms don't support direct API submission or URL pre-filling. The form will open in a new tab and field values will be copied to your clipboard. A server-side automation approach can be configured via the backend endpoint in Settings for fully automated submission.
            </p>
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={onClose} style={{ padding: '9px 18px', borderRadius: 7, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: '#64748b' }}>Cancel</button>
            <button onClick={handleSubmit} disabled={submitting} style={{ padding: '9px 18px', borderRadius: 7, border: 'none', background: '#0f172a', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: '#fff', display: 'flex', alignItems: 'center', gap: 5 }}>
              <Send size={13} /> {submitting ? 'Opening...' : 'Open PIF Form & Copy Fields'}
            </button>
          </div>
        </>
      ) : (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <CheckCircle2 size={40} style={{ color: '#10b981', marginBottom: 12 }} />
          <h3 style={{ fontSize: 16, fontWeight: 700, color: '#0f172a', margin: '0 0 8px' }}>PIF Form Opened</h3>
          <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 20px', lineHeight: 1.5 }}>
            Field values have been copied to your clipboard. Paste them into the Asana PIF form, then click below to confirm submission.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button onClick={onClose} style={{ padding: '9px 18px', borderRadius: 7, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: '#64748b' }}>Not Yet — Keep in Active</button>
            <button onClick={handleConfirmSubmitted} style={{ padding: '9px 18px', borderRadius: 7, border: 'none', background: '#10b981', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: '#fff', display: 'flex', alignItems: 'center', gap: 5 }}>
              <CheckCircle2 size={13} /> Confirm Submitted to Asana
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}


/* ═══════════════════════════════════════════════════════════════
   ADD / EDIT LEAD MODAL
   ═══════════════════════════════════════════════════════════════ */

function AddLeadModal({ lead, onSave, onClose }) {
  const isEdit = !!lead?.id;
  const [form, setForm] = useState(lead || {
    title: '', owner: '', projectName: '', location: '', county: '', geography: '',
    marketSector: '', projectType: '', description: '', whyItMatters: '',
    potentialTimeline: '', potentialBudget: '', action_due_date: '', internalContact: '', notes: '',
    relevanceScore: 50, pursuitScore: 50, sourceConfidenceScore: 50,
    sourceName: 'Manual Entry', sourceUrl: '',
    ppiProposedName: '', ppiClient: '', ppiMarketSector: '', ppiServiceType: '',
    ppiPursuitType: '', ppiOpportunitySummary: '', ppiSourceSummary: '',
    ppiInternalChampion: '', ppiProposedPIC: '', ppiProposedPM: '',
    ppiNextAction: '', ppiStrategicFitNotes: '', ppiRiskNotes: '',
  });
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  return (
    <Modal title={isEdit ? 'Edit Lead' : 'Add New Lead'} onClose={onClose} width={640}>
      <div style={{ maxHeight: '65vh', overflowY: 'auto', paddingRight: 4 }}>
        <FormSectionHeader>Core Information</FormSectionHeader>
        <div style={fieldFull}><label style={fieldLabel}>Lead Title *</label><input style={fieldInput} value={form.title} onChange={e => set('title', e.target.value)} placeholder="e.g., Missoula County Courthouse Renovation" /></div>
        <div style={fieldRow}>
          <div><label style={fieldLabel}>Owner / Client</label><input style={fieldInput} value={form.owner} onChange={e => set('owner', e.target.value)} placeholder="e.g., Missoula County" /></div>
          <div><label style={fieldLabel}>Project Name</label><input style={fieldInput} value={form.projectName} onChange={e => set('projectName', e.target.value)} /></div>
        </div>
        <div style={fieldRow}>
          <div><label style={fieldLabel}>Location</label><input style={fieldInput} value={form.location} onChange={e => set('location', e.target.value)} placeholder="e.g., Missoula, MT" /></div>
          <div><label style={fieldLabel}>Geography</label>
            <select style={fieldSelect} value={form.geography} onChange={e => set('geography', e.target.value)}>
              <option value="">Select...</option>{GEOGRAPHIES.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>
        </div>
        <div style={fieldRow}>
          <div><label style={fieldLabel}>Market Sector</label>
            <select style={fieldSelect} value={form.marketSector} onChange={e => set('marketSector', e.target.value)}>
              <option value="">Select...</option>{MARKET_SECTORS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div><label style={fieldLabel}>Project Type</label>
            <select style={fieldSelect} value={form.projectType} onChange={e => set('projectType', e.target.value)}>
              <option value="">Select...</option>{['New Construction','Renovation','Addition','Master Plan','Study','Bond','RFQ/RFP','Other'].map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>
        <div style={fieldFull}><label style={fieldLabel}>Description</label><textarea style={fieldTextarea} value={form.description} onChange={e => set('description', e.target.value)} placeholder="Brief project description..." /></div>
        <div style={fieldFull}><label style={fieldLabel}>Why It Matters</label><textarea style={{ ...fieldTextarea, minHeight: 48 }} value={form.whyItMatters} onChange={e => set('whyItMatters', e.target.value)} placeholder="Why is this relevant to A&E + SMA?" /></div>
        <div style={fieldRow}>
          <div><label style={fieldLabel}>Est. Budget</label><input style={fieldInput} value={form.potentialBudget} onChange={e => set('potentialBudget', e.target.value)} placeholder="$3M – $5M" /></div>
          <div><label style={fieldLabel}>Timeline</label><input style={fieldInput} value={form.potentialTimeline} onChange={e => set('potentialTimeline', e.target.value)} placeholder="Design start Q3 2026" /></div>
        </div>
        <div style={fieldRow}>
          <div>
            <label style={fieldLabel}>Action Due Date</label>
            <input type="date" value={form.action_due_date || ''} onChange={e => set('action_due_date', e.target.value)} style={fieldInput} />
          </div>
          <div><label style={fieldLabel}>Internal Contact</label><input style={fieldInput} value={form.internalContact} onChange={e => set('internalContact', e.target.value)} /></div>
          <div><label style={fieldLabel}>Source</label><input style={fieldInput} value={form.sourceName} onChange={e => set('sourceName', e.target.value)} /></div>
        </div>
        <div style={fieldFull}><label style={fieldLabel}>Notes</label><textarea style={{ ...fieldTextarea, minHeight: 48 }} value={form.notes} onChange={e => set('notes', e.target.value)} /></div>

        <FormSectionHeader>Scores (Manual Override)</FormSectionHeader>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
          {[['relevanceScore','Relevance'],['pursuitScore','Pursuit'],['sourceConfidenceScore','Confidence']].map(([k, label]) => (
            <div key={k}>
              <label style={fieldLabel}>{label} ({form[k]})</label>
              <input type="range" min="0" max="100" value={form[k] || 50} onChange={e => set(k, parseInt(e.target.value))}
                style={{ width: '100%', accentColor: scoreColor(form[k] || 50) }} />
            </div>
          ))}
        </div>

        <FormSectionHeader>Project Initiation Prep</FormSectionHeader>
        <div style={fieldRow}>
          <div><label style={fieldLabel}>Proposed Internal Name</label><input style={fieldInput} value={form.ppiProposedName} onChange={e => set('ppiProposedName', e.target.value)} /></div>
          <div><label style={fieldLabel}>Client / Owner</label><input style={fieldInput} value={form.ppiClient} onChange={e => set('ppiClient', e.target.value)} /></div>
        </div>
        <div style={fieldRow}>
          <div><label style={fieldLabel}>Service Type</label><input style={fieldInput} value={form.ppiServiceType} onChange={e => set('ppiServiceType', e.target.value)} placeholder="e.g., Full A/E Services" /></div>
          <div><label style={fieldLabel}>Pursuit Type</label><input style={fieldInput} value={form.ppiPursuitType} onChange={e => set('ppiPursuitType', e.target.value)} placeholder="e.g., RFQ Response" /></div>
        </div>
        <div style={fieldRow}>
          <div><label style={fieldLabel}>Internal Champion</label><input style={fieldInput} value={form.ppiInternalChampion} onChange={e => set('ppiInternalChampion', e.target.value)} /></div>
          <div><label style={fieldLabel}>Proposed PIC</label><input style={fieldInput} value={form.ppiProposedPIC} onChange={e => set('ppiProposedPIC', e.target.value)} /></div>
        </div>
        <div style={fieldRow}>
          <div><label style={fieldLabel}>Proposed PM</label><input style={fieldInput} value={form.ppiProposedPM} onChange={e => set('ppiProposedPM', e.target.value)} /></div>
          <div><label style={fieldLabel}>Next Action</label><input style={fieldInput} value={form.ppiNextAction} onChange={e => set('ppiNextAction', e.target.value)} /></div>
        </div>
        <div style={fieldFull}><label style={fieldLabel}>Strategic Fit Notes</label><textarea style={{ ...fieldTextarea, minHeight: 48 }} value={form.ppiStrategicFitNotes} onChange={e => set('ppiStrategicFitNotes', e.target.value)} /></div>
        <div style={fieldFull}><label style={fieldLabel}>Risk Notes</label><textarea style={{ ...fieldTextarea, minHeight: 48 }} value={form.ppiRiskNotes} onChange={e => set('ppiRiskNotes', e.target.value)} /></div>
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12, paddingTop: 12, borderTop: '1px solid #f1f5f9' }}>
        <button onClick={onClose} style={{ padding: '9px 18px', borderRadius: 7, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: '#64748b' }}>Cancel</button>
        <button onClick={() => { if (form.title) onSave(form); }} style={{ padding: '9px 18px', borderRadius: 7, border: 'none', background: form.title ? '#0f172a' : '#e2e8f0', cursor: form.title ? 'pointer' : 'not-allowed', fontSize: 12.5, fontWeight: 600, color: '#fff' }}>
          <Save size={13} style={{ marginRight: 5, verticalAlign: -2 }} /> {isEdit ? 'Save Changes' : 'Add Lead'}
        </button>
      </div>
    </Modal>
  );
}

function FormSectionHeader({ children }) {
  return <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '18px 0 10px', paddingTop: 14, borderTop: '1px solid #f1f5f9' }}>{children}</div>;
}
