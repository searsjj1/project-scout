/**
 * Test: Tracked Pursuit Reconciliation v3
 * Entity+location matching, alias detection, geography arrays, title precedence
 */

// ── Inline the functions under test ──────────────────────────

const CITY_TO_COUNTY = {
  'missoula': 'missoula', 'kalispell': 'flathead', 'whitefish': 'flathead',
  'columbia falls': 'flathead', 'polson': 'lake', 'hamilton': 'ravalli',
  'helena': 'lewis and clark', 'east helena': 'lewis and clark', 'bozeman': 'gallatin',
  'belgrade': 'gallatin', 'billings': 'yellowstone', 'great falls': 'cascade',
  'butte': 'silver bow', 'anaconda': 'deer lodge', 'coeur d\'alene': 'kootenai',
  'sandpoint': 'bonner', 'moscow': 'latah', 'spokane': 'spokane',
};

const OFFICE_REGIONS = {
  'Western MT': ['Missoula', 'Ravalli', 'Lake', 'Flathead', 'Sanders', 'Mineral', 'Lincoln', 'Glacier'],
  'Helena': ['Lewis and Clark', 'Jefferson', 'Broadwater', 'Powell', 'Deer Lodge', 'Silver Bow', 'Cascade', 'Meagher', 'Teton', 'Pondera', 'Toole', 'Liberty', 'Chouteau', 'Hill', 'Blaine'],
  'Bozeman': ['Gallatin', 'Park', 'Madison', 'Sweetgrass', 'Stillwater', 'Carbon', 'Big Horn'],
  'Billings': ['Yellowstone', 'Musselshell', 'Golden Valley', 'Wheatland', 'Fergus', 'Petroleum', 'Treasure', 'Rosebud', 'Custer', 'Powder River', 'Carter', 'Fallon', 'Wibaux', 'Dawson', 'Prairie', 'Garfield', 'McCone', 'Richland', 'Roosevelt', 'Daniels', 'Sheridan', 'Valley', 'Phillips'],
};

const ID_WA_REGIONS = {
  'Idaho': { cities: ['boise','nampa','meridian','idaho falls','pocatello','caldwell','coeur d\'alene','twin falls','lewiston','moscow','sandpoint','post falls','ketchum','sun valley','hailey'], stateAbbr: 'id' },
  'Washington': { cities: ['spokane','pullman','walla walla','kennewick','richland','pasco','wenatchee','moses lake','ellensburg','yakima','chelan','colville','omak','ephrata','clarkston'], stateAbbr: 'wa' },
};

const COUNTY_TO_REGIONS = {};
Object.entries(OFFICE_REGIONS).forEach(([region, counties]) => {
  counties.forEach(county => {
    const key = county.toLowerCase();
    if (!COUNTY_TO_REGIONS[key]) COUNTY_TO_REGIONS[key] = [];
    COUNTY_TO_REGIONS[key].push(region);
  });
});
const COUNTY_TO_REGION = {};
Object.entries(OFFICE_REGIONS).forEach(([region, counties]) => {
  counties.forEach(county => { COUNTY_TO_REGION[county.toLowerCase()] = region; });
});

function getLeadRegions(lead) {
  const geo = (lead.geography || '').toLowerCase().trim();
  const loc = (lead.location || '').toLowerCase().trim();
  const countyField = (lead.county || '').toLowerCase().replace(/\s*county\s*$/i, '').trim();
  const titleText = (lead.title || '').toLowerCase().trim();
  const asanaName = (lead.asana_task_name || '').toLowerCase().trim();
  const combined = geo + ' ' + loc + ' ' + titleText + ' ' + asanaName;
  const regions = new Set();
  for (const [region, info] of Object.entries(ID_WA_REGIONS)) {
    const statePattern = new RegExp(`\\b${info.stateAbbr}\\b|\\b${region.toLowerCase()}\\b`, 'i');
    if (statePattern.test(combined)) { regions.add(region); regions.add('Western MT'); }
    for (const city of info.cities) {
      if (combined.includes(city)) { regions.add(region); regions.add('Western MT'); break; }
    }
  }
  if (/\bstatewide\b/i.test(geo) || /\bstatewide\b/i.test(loc)) regions.add('Montana Statewide');
  if (/^montana$/i.test(geo.trim())) regions.add('Montana Statewide');
  if (countyField && COUNTY_TO_REGIONS[countyField]) {
    COUNTY_TO_REGIONS[countyField].forEach(r => regions.add(r));
  }
  if (regions.size === 0 || (regions.size === 1 && regions.has('Montana Statewide'))) {
    for (const [countyName, regionArr] of Object.entries(COUNTY_TO_REGIONS)) {
      if (geo.includes(countyName)) { regionArr.forEach(r => regions.add(r)); break; }
    }
  }
  if (regions.size === 0 || (regions.size === 1 && regions.has('Montana Statewide'))) {
    for (const [city, countyName] of Object.entries(CITY_TO_COUNTY)) {
      if (combined.includes(city) && COUNTY_TO_REGIONS[countyName]) {
        COUNTY_TO_REGIONS[countyName].forEach(r => regions.add(r));
        break;
      }
    }
  }
  // Montana Statewide umbrella: only for actual Montana projects, NOT Idaho/Washington
  const hasIdWa = regions.has('Idaho') || regions.has('Washington');
  const mtOfficeRegions = ['Western MT', 'Helena', 'Bozeman', 'Billings'];
  const hasMtOffice = [...regions].some(r => mtOfficeRegions.includes(r));
  if (hasMtOffice && !hasIdWa) regions.add('Montana Statewide');
  if (regions.size === 0 && !geo && !loc && !countyField) regions.add('Montana Statewide');
  return [...regions];
}

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

function normalizeForMatch(title) {
  if (!title) return '';
  let t = title.toLowerCase().trim();
  t = t.replace(/\bmt\b/g, 'montana').replace(/\bmsl?a\b/g, 'missoula').replace(/\bksp?l\b/g, 'kalispell');
  t = t.replace(/\ba\s*[&\/]\s*e\b/g, '').replace(/\ba\/e\b/g, '');
  t = t.replace(/\(.*?\)/g, '').replace(/\s*[-–—]\s*$/, '');
  t = t.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = t.split(' ').filter(w => w.length > 1 && !MATCH_STOP_WORDS.has(w));
  return words.sort().join(' ');
}

function titleSimilarity(a, b) {
  if (!a || !b) return 0;
  const wa = new Set(a.split(' ')), wb = new Set(b.split(' '));
  if (wa.size < 1 || wb.size < 1) return 0;
  let i = 0; for (const w of wa) if (wb.has(w)) i++;
  return i / (wa.size + wb.size - i);
}

function isTitleAlias(titleA, titleB) {
  if (!titleA || !titleB) return false;
  const na = normalizeForMatch(titleA);
  const nb = normalizeForMatch(titleB);
  if (na === nb) return true;

  const sigA = extractEntitySignature(titleA);
  const sigB = extractEntitySignature(titleB);
  // Location-conflict guard: different known locations → different projects
  const hasLocationConflict = sigA.locations.length > 0 && sigB.locations.length > 0 &&
    sigA.locations.filter(l => sigB.locations.includes(l)).length === 0;

  if (!hasLocationConflict && na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) return true;
  if (!hasLocationConflict && titleSimilarity(na, nb) >= 0.65) return true;
  // Entity + location secondary matching
  if (sigA.entities.length > 0 && sigB.entities.length > 0) {
    const sharedEntities = sigA.entities.filter(e => sigB.entities.includes(e));
    if (sharedEntities.length > 0) {
      const sharedLocations = sigA.locations.filter(l => sigB.locations.includes(l));
      if (sharedLocations.length > 0) return true;
      if (sigA.locations.length === 0 || sigB.locations.length === 0) return true;
    }
  }
  return false;
}

function getDisplayTitle(lead) {
  return lead.user_edited_title || lead.asana_task_name || lead.title || '';
}

// ── Test Harness ──────────────────────────
let failures = 0;
function test(name, actual, expected) {
  const val = typeof actual === 'function' ? actual() : actual;
  const pass = JSON.stringify(val) === JSON.stringify(expected);
  if (!pass) {
    console.log(`  ❌ FAIL - ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(val)}`);
    failures++;
  } else {
    console.log(`  ✅ PASS - ${name}`);
  }
}

// ═══════════════════════════════════════════════════════════════
console.log('=== ENTITY + LOCATION MATCHING (Kalispell Fire Station) ===');
const scoutFire = 'Architectural and Engineering Services for a new Fire Station';
const asanaFire = 'New Fire Station for City of Kalispell';
const sigScout = extractEntitySignature(scoutFire);
const sigAsana = extractEntitySignature(asanaFire);
console.log(`  Scout entities: ${JSON.stringify(sigScout.entities)}, locations: ${JSON.stringify(sigScout.locations)}`);
console.log(`  Asana entities: ${JSON.stringify(sigAsana.entities)}, locations: ${JSON.stringify(sigAsana.locations)}`);
test('Fire station entity extracted from Scout title', sigScout.entities.includes('fire_station'), true);
test('Fire station entity extracted from Asana title', sigAsana.entities.includes('fire_station'), true);
test('Kalispell location extracted from Asana title', sigAsana.locations.includes('kalispell'), true);
test('Scout title has no location (services RFP)', sigScout.locations.length, 0);
test('isTitleAlias matches fire station (entity + no-location fallback)', isTitleAlias(scoutFire, asanaFire), true);

console.log('');
console.log('=== HIGHLANDS ROOF REPLACEMENT ===');
test('Highlands exact match', isTitleAlias('Highlands College Roof Replacement', 'Roof Replacement - Highlands College'), true);
test('Highlands entity extraction', extractEntitySignature('Highlands College Roof Replacement').entities.includes('roof_replacement'), true);

console.log('');
console.log('=== SHOULD NOT ALIAS (DIFFERENT PURSUITS) ===');
test('Different facilities same city', isTitleAlias('Kalispell Fire Station', 'Kalispell Police Station'), false);
test('Different projects same entity', isTitleAlias('FVCC Science Center', 'FVCC Student Housing'), false);
test('Completely different', isTitleAlias('Missoula Courthouse', 'Billings Airport Terminal'), false);
test('Short ambiguous', isTitleAlias('Roof', 'Renovation'), false);

console.log('');
console.log('=== LOCATION-CONFLICT GUARD (different towns same scope) ===');
test('Same facility different town: fire station', isTitleAlias('Kalispell Fire Station', 'Missoula Fire Station'), false);
test('Same facility different town: community center', isTitleAlias('Helena Community Center Renovation', 'Bozeman Community Center Renovation'), false);
test('Same facility different town: roof replacement', isTitleAlias('Billings High School Roof Replacement', 'Missoula High School Roof Replacement'), false);
test('Same town same facility: still matches', isTitleAlias('Kalispell Fire Station Renovation', 'New Fire Station for City of Kalispell'), true);
test('One no-location still matches (generic RFQ)', isTitleAlias('Fire Station Design Services', 'Kalispell Fire Station'), true);
test('Same scope different state: Helena vs Spokane', isTitleAlias('Helena Community Center', 'Spokane Community Center'), false);

console.log('');
console.log('=== NORMALIZATION (STOP WORDS UPDATED) ===');
test('Strips A&E procurement words', normalizeForMatch('Architectural and Engineering Services for Fire Station'), 'fire station');
test('Strips professional/consultant', normalizeForMatch('Professional Design Consultant Services'), '');
test('Keeps facility type words', normalizeForMatch('Kalispell Fire Station Replacement'), 'fire kalispell replacement station');

console.log('');
console.log('=== TITLE PRECEDENCE ===');
test('user_edited_title wins', getDisplayTitle({ user_edited_title: 'My Title', asana_task_name: 'Asana Title', title: 'Scout Title' }), 'My Title');
test('asana_task_name second', getDisplayTitle({ asana_task_name: 'Asana Title', title: 'Scout Title' }), 'Asana Title');
test('title fallback', getDisplayTitle({ title: 'Scout Title' }), 'Scout Title');
test('empty fallback', getDisplayTitle({}), '');

console.log('');
console.log('=== GEOGRAPHY REGIONS (ARRAY-BASED) ===');
test('Missoula → [Western MT, Montana Statewide]', getLeadRegions({ geography: 'Missoula' }).sort(), ['Montana Statewide', 'Western MT']);
test('Kalispell → [Western MT, Montana Statewide]', getLeadRegions({ location: 'Kalispell, MT' }).sort(), ['Montana Statewide', 'Western MT']);
test('Helena → [Helena, Montana Statewide]', getLeadRegions({ county: 'Lewis and Clark County' }).sort(), ['Helena', 'Montana Statewide']);
test('Bozeman → [Bozeman, Montana Statewide]', getLeadRegions({ geography: 'Bozeman' }).sort(), ['Bozeman', 'Montana Statewide']);
test('Billings → [Billings, Montana Statewide]', getLeadRegions({ county: 'Yellowstone County' }).sort(), ['Billings', 'Montana Statewide']);
test('Statewide → [Montana Statewide]', getLeadRegions({ geography: 'Statewide' }), ['Montana Statewide']);
test('Empty → [Montana Statewide]', getLeadRegions({}), ['Montana Statewide']);

console.log('');
console.log('=== IDAHO / WASHINGTON OVERLAP ===');
// Proof case 8: Idaho project → both Idaho and Western MT
test('Coeur d\'Alene → [Idaho, Western MT] (no Montana Statewide)', getLeadRegions({ location: 'Coeur d\'Alene, ID' }).sort(), ['Idaho', 'Western MT']);
test('Idaho by state abbr → [Idaho, Western MT]', getLeadRegions({ location: 'Boise, ID' }).includes('Idaho'), true);
test('Idaho also in Western MT', getLeadRegions({ location: 'Boise, ID' }).includes('Western MT'), true);
test('Idaho NOT in Montana Statewide', getLeadRegions({ location: 'Boise, ID' }).includes('Montana Statewide'), false);
// Proof case 9: Washington project → both Washington and Western MT (not Montana Statewide)
test('Spokane → [Washington, Western MT] (no Montana Statewide)', getLeadRegions({ location: 'Spokane, WA' }).sort(), ['Washington', 'Western MT']);
test('Washington by state abbr', getLeadRegions({ location: 'Pullman, WA' }).includes('Washington'), true);
test('Washington also in Western MT', getLeadRegions({ location: 'Pullman, WA' }).includes('Western MT'), true);

console.log('');
console.log('=== PROOF CASE 10: Montana project in both region + Statewide ===');
test('Missoula in Montana Statewide', getLeadRegions({ geography: 'Missoula' }).includes('Montana Statewide'), true);
test('Missoula in Western MT', getLeadRegions({ geography: 'Missoula' }).includes('Western MT'), true);
test('Great Falls in Montana Statewide', getLeadRegions({ location: 'Great Falls, MT' }).includes('Montana Statewide'), true);
test('Great Falls in Helena region', getLeadRegions({ location: 'Great Falls, MT' }).includes('Helena'), true);

console.log('');
console.log('=== NOISE TITLE: School Elections Information ===');
// Test the election noise pattern
const electionPattern = /\b(election|elections|voting|ballot|voter|poll|polling|caucus|primary|general election|trustee election|mill levy election|election (information|results|schedule|calendar|dates|day))\b/i;
const projectSafeguard = /\b(renovation|construction|building|facility|design|addition|expansion|replacement|modernization|rfq|rfp|fire station|hospital|courthouse|library|bond (issue|measure|project|program|construction|building))\b/i;
const isElectionNoise = (t) => electionPattern.test(t) && !projectSafeguard.test(t);
test('"School Elections Information" is noise', isElectionNoise('School Elections Information'), true);
test('"Bond Election for New Fire Station" is NOT noise', isElectionNoise('Bond Election for New Fire Station'), false);
test('"Voter Information" is noise', isElectionNoise('Voter Information'), true);
test('"Bond Election — Construction Program" is NOT noise', isElectionNoise('Bond Election — Construction Program'), false);

console.log('');
console.log('=== BUG FIX: Title-based region detection for imported Asana tasks ===');
// Proof case: Asana task with city in title but empty location/geography fields
test('Title "New Fire Station for City of Kalispell" → Western MT via title', getLeadRegions({ title: 'New Fire Station for City of Kalispell', location: '', geography: '' }).includes('Western MT'), true);
test('Title "New Fire Station for City of Kalispell" → also Montana Statewide (MT city)', getLeadRegions({ title: 'New Fire Station for City of Kalispell', location: '', geography: '' }).includes('Montana Statewide'), true);
test('Asana task name "Boise Public Library Renovation" → Idaho', getLeadRegions({ asana_task_name: 'Boise Public Library Renovation', location: '', geography: '' }).includes('Idaho'), true);
test('Asana task name "Boise Public Library Renovation" → also Western MT', getLeadRegions({ asana_task_name: 'Boise Public Library Renovation', location: '', geography: '' }).includes('Western MT'), true);
test('Asana task name "Boise Public Library Renovation" → NOT Montana Statewide', getLeadRegions({ asana_task_name: 'Boise Public Library Renovation', location: '', geography: '' }).includes('Montana Statewide'), false);
test('Asana task "Spokane Transit Center Design" → Washington', getLeadRegions({ asana_task_name: 'Spokane Transit Center Design', location: '' }).includes('Washington'), true);
test('Asana task "Spokane Transit Center Design" → also Western MT', getLeadRegions({ asana_task_name: 'Spokane Transit Center Design', location: '' }).includes('Western MT'), true);
test('Asana task "Spokane Transit Center Design" → NOT Montana Statewide', getLeadRegions({ asana_task_name: 'Spokane Transit Center Design', location: '' }).includes('Montana Statewide'), false);

console.log('');
console.log('=== BUG FIX: Idaho/Washington overlap — appears in both state + Western MT ===');
test('Idaho project in Idaho + Western MT, NOT Montana Statewide', () => {
  const regions = getLeadRegions({ title: 'Idaho Falls Community Center', location: '' });
  return regions.includes('Idaho') && regions.includes('Western MT') && !regions.includes('Montana Statewide');
}, true);
test('WA project in Washington + Western MT, NOT Montana Statewide', () => {
  const regions = getLeadRegions({ title: 'Walla Walla Courthouse Renovation', location: '' });
  return regions.includes('Washington') && regions.includes('Western MT') && !regions.includes('Montana Statewide');
}, true);

console.log('');
console.log('=== BUG FIX: Backend entity+location matching ===');
// Simulate backend matching logic
const BACKEND_STOP_WORDS = new Set(['the','and','for','from','with','this','that','are','was','will','has','have','been','its','our','new','all','project','county','city','state','montana',
  'architectural','engineering','services','service','professional','design','consultant','consultants','construction','renovation','replacement','improvement','improvements']);
const backendNorm = t => (t||'').toLowerCase().replace(/[^a-z0-9\s]/g,'').replace(/\s+/g,' ').trim();
const backendSigWords = (text) => backendNorm(text).split(' ').filter(w => w.length > 2 && !BACKEND_STOP_WORDS.has(w));
const backendWsim = (a,b) => {
  const wa=new Set(backendSigWords(a)), wb=new Set(backendSigWords(b));
  if(wa.size < 2 || wb.size < 2) return 0;
  let i=0; for(const w of wa) if(wb.has(w)) i++;
  return i / new Set([...wa,...wb]).size;
};
test('Backend Jaccard: fire station titles with A&E stop words stripped',
  backendWsim('Architectural and Engineering Services for a new Fire Station', 'New Fire Station for City of Kalispell') >= 0.40, true);
// The entity+location match is the real fix — verify it catches the fire station case
test('Fire station entity+location match catches Kalispell case', isTitleAlias('Architectural and Engineering Services for a new Fire Station', 'New Fire Station for City of Kalispell'), true);

// ═══ Backend Ranked Match — Kalispell proof case ═══
console.log('');
console.log('=== BUG FIX: Backend ranked match — same-town wins over generic ===');

// Simulate the backend rankScore function (uses extractEntitySignature which matches extractEntLoc)
// Returns { score, calibratedConfidence } matching the backend
const rankScore = (leadTitle, leadOwner, taskName) => {
  const lead = { title: leadTitle, owner: leadOwner || '' };
  const task = { name: taskName };
  const hit = { confidence: 0.80 };
  let score = hit.confidence * 100;
  let identityBonus = 0, identityPenalty = 0;
  const sigL = extractEntitySignature(lead.title);
  const sigT = extractEntitySignature(task.name);
  const leadLo = (lead.title || '').toLowerCase();
  const taskLo = (task.name || '').toLowerCase();
  const sharedLocs = sigL.locations.filter(l => sigT.locations.includes(l));
  if (sharedLocs.length > 0) { score += 40; identityBonus += 20; }
  const sharedEnts = sigL.entities.filter(e => sigT.entities.includes(e));
  if (sharedEnts.length > 0) { score += 10; identityBonus += 5; }
  if (sigL.locations.length > 0 && sigT.locations.length > 0 && sharedLocs.length === 0) { score -= 30; identityPenalty += 45; }
  if ((sigL.locations.length === 0) !== (sigT.locations.length === 0)) { identityPenalty += 8; }
  const scopeA = leadLo.match(/\b(new|addition|renovation|remodel|expansion|repair|replacement|demolition|upgrade|study|master plan|assessment)\b/g) || [];
  const scopeB = taskLo.match(/\b(new|addition|renovation|remodel|expansion|repair|replacement|demolition|upgrade|study|master plan|assessment)\b/g) || [];
  if (scopeA.length > 0 && scopeB.length > 0) {
    if (scopeA.some(s => scopeB.includes(s))) { identityBonus += 5; }
    else { score -= 15; identityPenalty += 12; }
  }
  const leadStNum = leadLo.match(/station\s+(\d+)/);
  const taskStNum = taskLo.match(/station\s+(\d+)/);
  if (leadStNum && taskStNum && leadStNum[1] !== taskStNum[1]) { score -= 20; identityPenalty += 15; }
  if (!leadStNum && taskStNum) { score -= 5; identityPenalty += 5; }
  const ownerLo = (lead.owner || '').toLowerCase();
  if (ownerLo.length > 3) {
    const ownerWords = ownerLo.split(/\s+/).filter(w => w.length > 3 && !BACKEND_STOP_WORDS.has(w));
    const taskWords = new Set(taskLo.split(/\s+/));
    const ownerHits = ownerWords.filter(w => taskWords.has(w));
    if (ownerHits.length > 0) { score += 15; identityBonus += 10; }
  }
  let cal = hit.confidence * 100 + identityBonus - identityPenalty;
  cal = Math.max(30, Math.min(99, cal));
  return { score, calibratedConfidence: Math.round(cal) / 100 };
};

// The Kalispell Scout lead
const kalispellLead = 'Architectural and Engineering Services for a new Fire Station Request for Qualif';
const kalispellOwner = 'City of Kalispell';

// Candidate A (WRONG): generic fire station remodel in different context
const wrongCandidate = 'Fire Station 5 Bathroom Remodel';
// Candidate B (CORRECT): same-town fire station
const correctCandidate = 'New Fire Station for City of Kalispell';

const resultWrong = rankScore(kalispellLead, kalispellOwner, wrongCandidate);
const resultCorrect = rankScore(kalispellLead, kalispellOwner, correctCandidate);

test('Kalispell fire station: correct candidate outranks wrong candidate',
  resultCorrect.score > resultWrong.score, true);
test(`  Score: "${correctCandidate}" = ${resultCorrect.score} > "${wrongCandidate}" = ${resultWrong.score}`,
  resultCorrect.score > resultWrong.score, true);

// Additional proof: scope mismatch penalty applies to "remodel" vs "new"
test('Scope mismatch: "new" vs "remodel" gets penalized',
  resultWrong.score < 90, true);

// Same-town same-facility should score well above baseline (80 base + 40 location + 10 entity - owner bonus varies)
test('Same-town same-facility scores high (≥ 100)',
  resultCorrect.score >= 100, true);

// Cross-town fire station should not beat same-town
const crossTownCandidate = 'Missoula Fire Station Renovation';
const resultCrossTown = rankScore(kalispellLead, kalispellOwner, crossTownCandidate);
test('Cross-town fire station scores lower than same-town',
  resultCorrect.score > resultCrossTown.score, true);

// Numbered station mismatch
const numberedStation = 'Fire Station 3 Expansion';
const resultNumbered = rankScore(kalispellLead, kalispellOwner, numberedStation);
test('Numbered station (no lead number) gets small penalty',
  resultNumbered.score < resultCorrect.score, true);

console.log('');
console.log('=== LOCATION-CONFLICT CONFIDENCE (stronger penalty) ===');

// Different-town same-keyword: should have LOW confidence
const diffTownResult = rankScore('New Fire Station for City of Kalispell', '', 'Missoula Fire Station Renovation');
test('Different-town fire station: confidence < 50%',
  diffTownResult.calibratedConfidence < 0.50, true);
test(`  Confidence: ${Math.round(diffTownResult.calibratedConfidence*100)}%`,
  diffTownResult.calibratedConfidence < 0.50, true);

// Different-town same-keyword with owner overlap: still should not reach 80%
const diffTownOwner = rankScore('New Fire Station for City of Kalispell', 'Anderson Construction', 'Missoula Fire Station Anderson');
test('Different-town + owner overlap: confidence still < 60%',
  diffTownOwner.calibratedConfidence < 0.60, true);
test(`  Confidence: ${Math.round(diffTownOwner.calibratedConfidence*100)}%`,
  diffTownOwner.calibratedConfidence < 0.60, true);

// Same-town same-facility: should remain strong
const sameTownResult = rankScore('New Fire Station for City of Kalispell', '', 'New Fire Station for City of Kalispell');
test('Same-town same-facility: confidence >= 80%',
  sameTownResult.calibratedConfidence >= 0.80, true);
test(`  Confidence: ${Math.round(sameTownResult.calibratedConfidence*100)}%`,
  sameTownResult.calibratedConfidence >= 0.80, true);

// One side missing location (generic): moderate confidence, not penalized as conflict
// Should be meaningfully lower than same-town (99%) but not crushed like conflict (30%)
const missingLocResult = rankScore('Architectural Services for Fire Station', '', 'Kalispell Fire Station Design');
test('Missing location (generic lead): confidence between 40-80%',
  missingLocResult.calibratedConfidence >= 0.40 && missingLocResult.calibratedConfidence <= 0.80, true);
test(`  Confidence: ${Math.round(missingLocResult.calibratedConfidence*100)}%`,
  missingLocResult.calibratedConfidence >= 0.40 && missingLocResult.calibratedConfidence <= 0.80, true);

// Different-town + scope mismatch: should be very low
const diffTownScopeMismatch = rankScore('New Fire Station for City of Kalispell', '', 'Helena Fire Station Bathroom Remodel');
test('Different-town + scope mismatch: confidence < 40%',
  diffTownScopeMismatch.calibratedConfidence < 0.40, true);
test(`  Confidence: ${Math.round(diffTownScopeMismatch.calibratedConfidence*100)}%`,
  diffTownScopeMismatch.calibratedConfidence < 0.40, true);

console.log('');
if (failures === 0) {
  console.log(`✅ ALL TESTS PASS (0 failures)`);
} else {
  console.log(`❌ ${failures} failure(s)`);
}
