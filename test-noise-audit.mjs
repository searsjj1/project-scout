/**
 * Noise Audit — Tests all user-reported noisy titles against the full filter chain.
 * Mirrors the exact logic in boardQualityPrune from ProjectScout.jsx.
 */

// ── Reproduce all filter functions from ProjectScout.jsx ──

const isPortalTitle = (title) => {
  const lo = (title || '').toLowerCase().trim();
  if (/^(current|open|active|closed|awarded|pending)\s+(solicitations?|bids?|rfps?|rfqs?|opportunities|projects?|listings?)$/i.test(lo)) return true;
  if (/^(solicitations?|bids?|rfps?|rfqs?|opportunities|procurement)\s+(list|index|page|board|calendar|schedule|archive)$/i.test(lo)) return true;
  if (/^(public (works?|notices?|bids?)|bid (board|opportunities)|procurement (portal|page))$/i.test(lo)) return true;
  if (/^(meeting|agenda|minutes|packet|resolution|ordinance)\s+/i.test(lo) && !/\b(renovation|construction|building|facility|addition|expansion|project)\b/i.test(lo)) return true;
  if (/^(rfqs?|rfps?|solicitations?|bids?|proposals?|qualifications?)(\.{2,})?$/i.test(lo)) return true;
  if (/^requests?\s+for\s+(proposals?|qualifications?|quotes?|bids?)(\s*\/\s*(proposals?|qualifications?|quotes?|bids?))*(\s*\.{2,})?$/i.test(lo)) return true;
  if (/^(rfq|rfp|bid|solicitation)\s*[\/\u2013\u2014\-]/.test(lo) && !/\b(architect|design|building|school|hospital|facility|fire station|library|renovation|remodel)\b/.test(lo)) return true;
  if (/^(rfqs?|rfps?|solicitations?|bids?|proposals?)\s*[&+]\s*(rfqs?|rfps?|solicitations?|bids?|proposals?)$/i.test(lo)) return true;
  if (/^(rfqs?|rfps?|solicitations?|bids?|proposals?)\s+and\s+(rfqs?|rfps?|solicitations?|bids?|proposals?)$/i.test(lo)) return true;
  return false;
};

const isNoiseTitle = (title) => {
  const lo = (title || '').toLowerCase();
  if (/\b(printable map|bid map|interactive map|gis viewer)\b/.test(lo)) return true;
  if (/\b(bid results|bid tabulation|plan holders?|vendor list|bidder list)\b/.test(lo)) return true;
  if (/^(home|about|news|events|contact|board|staff|resources|documents|calendar|agenda|minutes)$/i.test(lo.trim())) return true;
  if (/\b(information for the overall|public works construction schedule|construction management office)\b/.test(lo)) return true;
  // Governance body names
  const govBody = /^([\w\s.'&'\u2019]+\s+)?(commission|committee|council|board|authority|task\s*force|advisory\s*(board|committee|group|panel)|work\s*(group|session)|subcommittee|caucus)(\s+(of|for|on)\s+[\w\s.'&'\u2019]+)?(\s+(meeting|agenda|minutes|session|hearing|workshop|retreat|report|update))?$/i;
  if (govBody.test(lo.trim()) && !/\b(renovation|construction|expansion|addition|replacement|modernization|design|facility|building|project|bond|capital|rfq|rfp|solicitation)\b/i.test(lo)) return true;
  // Agenda/minutes/meeting pages
  if (/\b(agenda|minutes|meeting|packet|work\s*session|public\s*hearing|regular\s*session|special\s*session)\b/i.test(lo) &&
      !/\b(renovation|construction|expansion|addition|replacement|modernization|design|rfq|rfp|solicitation|bond|capital improvement|facility|building|project)\b/i.test(lo)) return true;
  // Generic department/office/program pages
  if (/^([\w\s.'&'\u2019]+\s+)?(department|office|division|bureau|program|services?)\s*$/i.test(lo.trim()) &&
      !/\b(construction|design|capital|renovation|project|facility|building)\b/i.test(lo)) return true;
  // Tourism/events
  if (/\b(tourism|visitor|festival|parade|farmer.?s?\s*market|concert|fireworks|celebration|memorial\s*day|independence\s*day|holiday|fun\s*run|5k|marathon|triathlon)\b/i.test(lo) &&
      !/\b(renovation|construction|building|facility|design|addition|expansion|terminal|center)\b/i.test(lo)) return true;
  // Explicit governance title list
  if (/^(planning commission|city council|town council|county commission|board of supervisors|board of commissioners|park board|parks? (and|&) recreation|police commission|fire commission|zoning board|historic preservation)\s*$/i.test(lo.trim())) return true;
  // IT systems
  if (/\b(management system|financial (system|management)|accounting system|hr system|payroll system|erp|enterprise resource|software (system|platform|solution|implementation|migration)|it (system|infrastructure|services))\b/.test(lo) &&
      /\b(replacement|implementation|upgrade|migration|procurement|rfp|solicitation|modernization)\b/.test(lo) &&
      !/\b(architect|design|building|facility|renovation|construction)\b/.test(lo)) return true;
  // Bridge-only
  if (/\bbridge\b/.test(lo) && /\b(repair|maintenance|replacement|rehabilitation|deck|overlay|painting|scour|rail|abutment|pier)\b/.test(lo) &&
      !/\b(architect|building|renovation|addition|facility|school|hospital|clinic|terminal|fire station|police|library|courthouse|campus)\b/.test(lo)) return true;
  // Virtual tours, weddings
  if (/\b(virtual (campus )?(tour|walkthrough)|get married|wedding (venue|rental|reception)|event (rental|venue|booking)|rent (the|a|our) (hall|room|space|facility))\b/.test(lo)) return true;
  // Planning guides
  if (/\b(project planning guides?|planning guides?|how to (apply|submit|file|get)|step.by.step|application (process|instructions|checklist)|permit (info|information|requirements|process|fees)|zoning (info|information|requirements|map|districts))\b/.test(lo) &&
      !/\b(architect|design|building|renovation|construction|facility|school|hospital)\b/.test(lo)) return true;
  // Generic overlay/zoning
  if (/^(overlay (district|zone)|zoning (map|ordinance|code|district)|land use (map|plan|code)|comprehensive (zoning|land use))/i.test(lo.trim())) return true;
  // Generic agendas with dates
  if (/^(agenda|minutes|meeting (minutes|agenda|packet|summary)|assessment|annual assessment|property assessment|tax assessment)\s*$/i.test(lo.trim())) return true;
  if (/^(agenda|minutes|assessment)\s+(for\s+)?(january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}[\/\-]\d{1,2})/i.test(lo.trim())) return true;
  // Dated governance documents
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\.?\s+\d{1,2},?\s+\d{4}\b/i.test(lo.trim()) &&
      /\b(agenda|minutes|meeting|packet|hearing|session|workshop)\b/i.test(lo) &&
      !/\b(renovation|construction|building|facility|project|bond|rfq|rfp)\b/i.test(lo)) return true;
  // Community programs
  if (/\b(summer (camp|program|reading)|after.?school|youth (program|camp|league)|senior (program|activities|services)|community (event|program|class|garden|cleanup)|volunteer|recreation (program|class|league|schedule))\b/.test(lo) &&
      !/\b(architect|design|building|renovation|construction|facility|center|addition|expansion)\b/.test(lo)) return true;
  // Storm damage / permit info pages
  if (/\b(storm damage|building permit information|permit information|permit fees)\b/i.test(lo) &&
      !/\b(renovation|construction|design|facility|project|rfq|rfp)\b/i.test(lo)) return true;
  // Assessment/report pages without a named project
  if (/\b(assessment report|housing assessment|needs assessment|condition assessment)\b/i.test(lo) &&
      !/\b[A-Z][a-z]{2,}\s+(school|hospital|library|courthouse|fire station|clinic|campus|building|facility)\b/.test(title || '')) return true;
  // Park/recreation pages without building scope
  if (/\b(park|recreation|trail|playground|sports? field|ball field|skate park|dog park|splash pad)\b/i.test(lo) &&
      !/\b(renovation|construction|building|facility|design|addition|expansion|community center|recreation center|pool|aquatic|pavilion|clubhouse|restroom|shelter)\b/i.test(lo)) return true;
  // Design excellence / design guidelines / overlay pages
  if (/\b(design (excellence|guidelines?|standards?|review|overlay)|overlay district|form.based code)\b/i.test(lo) &&
      !/\b(renovation|construction|building|facility|project|rfq|rfp)\b/i.test(lo)) return true;
  // ── NEW v18 patterns ──
  // Award/stewardship names
  if (/\b(steward(ship)?|award|recognition|honor|hall of fame)\b/i.test(lo) &&
      !/\b(renovation|construction|building|facility|design|project|rfq|rfp)\b/i.test(lo)) return true;
  // Procurement schedules without a project name
  if (/\b(rfq|rfp|bid|solicitation)\s*[&+,]?\s*(bid\s*)?(schedule|calendar|timeline)\b/i.test(lo) &&
      !/\b(school|hospital|library|courthouse|fire station|campus|building|facility)\b/i.test(lo)) return true;
  // ISO-dated document/file references
  if (/^\d{4}-\d{2}-\d{2}\b/.test(lo.trim())) return true;
  // Environmental assessments without building scope
  if (/\b(environmental (assessment|impact|review|study)|supplemental environmental|nepa\b|eis\b)\b/i.test(lo) &&
      !/\b(building|facility|renovation|design|architect|construction)\b/i.test(lo)) return true;
  // Coalition/alliance organizational names
  if (/\b(coalition|alliance|consortium|collaborative|network)\s*$/i.test(lo.trim()) &&
      !/\b(renovation|construction|building|facility|project|design|rfq|rfp)\b/i.test(lo)) return true;
  // Housing/citywide strategy documents
  if (/\b(housing (strategy|program|initiative|action plan)|citywide (strategy|plan|housing)|workforce housing (program|initiative))\b/i.test(lo) &&
      !/\b(school|hospital|library|courthouse|fire station|campus|building|facility|renovation|construction|design|rfq|rfp)\b/i.test(lo)) return true;
  // Tourism BID
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
  return false;
};

// ── Test the user's exact noise list ──
const testCases = [
  // ── Original v17 suppression cases ──
  { title: 'Police Commission', expect: 'suppress', why: 'governance body name' },
  { title: 'Get Married at the Courthouse!', expect: 'suppress', why: 'event/wedding marketing' },
  { title: 'Project Planning Guides', expect: 'suppress', why: 'generic planning guide page' },
  { title: 'Design Excellence Overlay', expect: 'suppress', why: 'design guidelines/overlay page' },
  { title: 'Housing Assessment Report', expect: 'suppress', why: 'generic assessment without named project' },
  { title: 'Marshall Mountain Park', expect: 'suppress', why: 'park page without building scope' },
  { title: 'Police Department', expect: 'suppress', why: 'generic department page' },
  { title: 'Storm Damage and Building Permit Information', expect: 'suppress', why: 'permit info page' },
  { title: 'May 23, 2019 Police Commission Agenda', expect: 'suppress', why: 'dated governance agenda' },
  { title: 'Feb 25, 2026 Tourism Business Improvement District Agenda', expect: 'suppress', why: 'dated TBID agenda' },
  // ── NEW v18 suppression cases ──
  { title: 'Park Steward Award', expect: 'suppress', why: 'award/stewardship name' },
  { title: 'LRBP RFQ & Bid Schedule', expect: 'suppress', why: 'procurement schedule page' },
  { title: '2023-12-11 01 Associated Construction Engineering', expect: 'suppress', why: 'ISO-dated document reference' },
  { title: '2019 Supplemental Environmental Assessment for the Glacier Rail Park', expect: 'suppress', why: 'environmental assessment without building scope' },
  { title: '2017 Environmental Assessment for the Glacier Rail Park', expect: 'suppress', why: 'environmental assessment without building scope' },
  { title: 'At-Risk Housing Coalition', expect: 'suppress', why: 'coalition name without project' },
  { title: 'Workforce Housing Program', expect: 'suppress', why: 'housing strategy/program document' },
  { title: 'Rent a County Facility', expect: 'suppress', why: 'facility rental marketing' },
  { title: 'Kalispell Tourism Business Improvement District', expect: 'suppress', why: 'tourism BID' },
  { title: 'Glacier National Park', expect: 'suppress', why: 'national park without building scope' },
  { title: 'Big Sky Park Stewardship Committee', expect: 'suppress', why: 'stewardship committee (gov body)' },
  { title: 'Citywide Housing Strategy', expect: 'suppress', why: 'housing strategy document' },
  { title: '2025 Housing Strategy Update', expect: 'suppress', why: 'housing strategy update' },
  { title: 'New Requirement: 6-Year Plan', expect: 'suppress', why: 'generic N-year plan heading' },
  { title: 'Fort Missoula Regional Park', expect: 'suppress', why: 'park without building scope' },
  { title: 'City of Missoula Data City project', expect: 'suppress', why: 'vague data/smart-city project' },
  // ── Sanity checks — these MUST survive ──
  { title: 'Greater Missoula Downtown Master Plan', expect: 'keep', why: 'named plan/project' },
  { title: 'Redevelopment of the Former Library Block', expect: 'keep', why: 'named redevelopment area' },
  { title: 'West Broadway River Corridor Plan', expect: 'keep', why: 'named plan' },
  { title: 'Missoula County Courthouse Renovation', expect: 'keep', why: 'named facility + project action' },
  { title: 'FVCC Science & Technology Center', expect: 'keep', why: 'named facility project' },
  { title: 'Kalispell Combination Facility', expect: 'keep', why: 'named facility project' },
  { title: 'Mazurek Elevator Modernization', expect: 'keep', why: 'named facility + project action' },
  { title: 'Lambing Barn Renovation & Safety Upgrades', expect: 'keep', why: 'named facility + project action' },
  { title: 'Fire Alarm Replacement, Multiple Buildings', expect: 'keep', why: 'specific A&E scope' },
  { title: 'Elevator Repair / Replacement', expect: 'keep', why: 'specific A&E scope' },
  { title: 'Great Falls Combination Facility', expect: 'keep', why: 'named facility project' },
  { title: 'Wastewater Facility', expect: 'keep', why: 'named facility (watch-category rename applies)' },
];

console.log('═══════════════════════════════════════════════════════');
console.log('  NOISE TITLE AUDIT — Full Board Audit (v18)');
console.log('═══════════════════════════════════════════════════════\n');

let passed = 0, failed = 0;
for (const { title, expect: exp, why } of testCases) {
  const caughtByPortal = isPortalTitle(title);
  const caughtByNoise = isNoiseTitle(title);
  const caught = caughtByPortal || caughtByNoise;
  const result = caught ? 'suppress' : 'keep';
  const ok = result === exp;
  const filter = caughtByPortal ? 'isPortalTitle' : caughtByNoise ? 'isNoiseTitle' : '—';

  if (ok) {
    console.log(`  ✅ ${result.toUpperCase().padEnd(8)} "${title}"`);
    console.log(`     ${why} ${caught ? `[caught by ${filter}]` : '[passes all filters]'}`);
    passed++;
  } else {
    console.log(`  ❌ GOT ${result.toUpperCase().padEnd(8)} EXPECTED ${exp.toUpperCase()} — "${title}"`);
    console.log(`     ${why} ${caught ? `[caught by ${filter}]` : '[NOT caught — needs new filter]'}`);
    failed++;
  }
}

console.log(`\n═══════════════════════════════════════════════════════`);
if (failed === 0) {
  console.log(`  ✅ ALL ${passed} CASES CORRECT`);
} else {
  console.log(`  ❌ ${failed} FAILED, ${passed} passed`);
}
console.log('═══════════════════════════════════════════════════════');
process.exit(failed > 0 ? 1 : 0);
