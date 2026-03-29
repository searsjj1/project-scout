/**
 * Test: Source page vs project card audit
 * Tests the user's specific examples against isNoiseTitle and isWatchTitleAcceptable
 */

function isNoiseTitle(title) {
  const lo = (title || '').toLowerCase();
  if (/\b(printable map|bid map|interactive map|gis viewer)\b/.test(lo)) return true;
  if (/\b(bid results|bid tabulation|plan holders|vendor list|bidder list)\b/.test(lo)) return true;
  if (/^(home|about|news|events|contact|board|staff|resources|documents|calendar|agenda|minutes)$/i.test(lo.trim())) return true;
  const govBody = /^([\w\s.&]+\s+)?(commission|committee|council|board|authority|task\s*force|advisory\s*(board|committee|group|panel)|work\s*(group|session)|subcommittee|caucus)(\s+(of|for|on)\s+[\w\s.&]+)?(\s+(meeting|agenda|minutes|session|hearing|workshop|retreat|report|update))?$/i;
  if (govBody.test(lo.trim()) && !/\b(renovation|construction|expansion|addition|replacement|modernization|design|facility|building|project|bond|capital|rfq|rfp|solicitation)\b/i.test(lo)) return true;
  if (/\b(agenda|minutes|meeting|packet|work\s*session|public\s*hearing)\b/i.test(lo) && !/\b(renovation|construction|expansion|addition|replacement|modernization|design|rfq|rfp|solicitation|bond|capital improvement|facility|building|project)\b/i.test(lo)) return true;
  if (/^([\w\s.&]+\s+)?(department|office|division|bureau|program|services?)\s*$/i.test(lo.trim()) && !/\b(construction|design|capital|renovation|project|facility|building)\b/i.test(lo)) return true;
  if (/\b(tourism|visitor|festival|parade)\b/i.test(lo) && !/\b(renovation|construction|building|facility|design|addition|expansion|terminal|center)\b/i.test(lo)) return true;
  if (/^(planning commission|city council|town council|county commission|board of supervisors|park board|parks? (and|&) recreation|police commission|fire commission|zoning board|historic preservation)\s*$/i.test(lo.trim())) return true;
  if (/\b(virtual (campus )?(tour|walkthrough)|get married|wedding|event (rental|venue|booking)|rent (the|a|our) (hall|room|space|facility))\b/.test(lo)) return true;
  if (/\b(project planning guide|planning guide|how to (apply|submit|file|get)|step.by.step|application (process|instructions|checklist)|permit (info|information|requirements|process|fees)|zoning (info|information|requirements|map|districts))\b/.test(lo) && !/\b(architect|design|building|renovation|construction|facility|school|hospital)\b/.test(lo)) return true;
  if (/^(overlay (district|zone)|zoning (map|ordinance|code|district)|land use (map|plan|code))/i.test(lo.trim())) return true;
  if (/\b(storm damage|building permit information|permit information|permit fees)\b/i.test(lo) && !/\b(renovation|construction|design|facility|project|rfq|rfp)\b/i.test(lo)) return true;
  if (/\b(assessment report|housing assessment|needs assessment|condition assessment)\b/i.test(lo)) return true;
  if (/\b(park|recreation|trail|playground|sports field|ball field|skate park|dog park|splash pad)\b/i.test(lo) && !/\b(renovation|construction|building|facility|design|addition|expansion|community center|recreation center|pool|aquatic|pavilion|clubhouse|restroom|shelter)\b/i.test(lo)) return true;
  if (/\b(design (excellence|guidelines|standards|review|overlay)|overlay district|form.based code)\b/i.test(lo) && !/\b(renovation|construction|building|facility|project|rfq|rfp)\b/i.test(lo)) return true;
  if (/\b(stewardship|award|recognition|honor|hall of fame)\b/i.test(lo) && !/\b(renovation|construction|building|facility|design|project|rfq|rfp)\b/i.test(lo)) return true;
  if (/^\d{4}-\d{2}-\d{2}\b/.test(lo.trim())) return true;
  if (/\b(environmental (assessment|impact|review|study))\b/i.test(lo) && !/\b(building|facility|renovation|design|architect|construction)\b/i.test(lo)) return true;
  if (/\b(coalition|alliance|consortium|collaborative|network)\s*$/i.test(lo.trim()) && !/\b(renovation|construction|building|facility|project|design|rfq|rfp)\b/i.test(lo)) return true;
  if (/\b(housing (strategy|program|initiative|action plan)|citywide (strategy|plan|housing)|workforce housing (program|initiative))\b/i.test(lo) && !/\b(school|hospital|library|courthouse|fire station|campus|building|facility|renovation|construction|design|rfq|rfp)\b/i.test(lo)) return true;
  if (/\btourism\s+business\s+improvement\s+district\b/i.test(lo)) return true;
  if (/\b(data (city|project|initiative|platform|hub)|open data|smart city|digital (city|twin|transformation))\b/i.test(lo) && !/\b(building|facility|renovation|construction|design|architect)\b/i.test(lo)) return true;
  if (/\b(rent (the|a|our) (hall|room|space|facility|building|park|center|county)|facility (rental|rentals)|venue (rental|rentals|hire))\b/i.test(lo)) return true;
  // ── v21: Source page / topic page / admin page suppression ──
  if (/^(community development|economic development|planning and development|development services|development center|planning services)\s*$/i.test(lo.trim()) &&
      !/\b(block grant|redevelopment|renovation|construction|rfq|rfp|bond)\b/i.test(lo)) return true;
  if (/^(project and engineering|engineering services|public works|facilities management|building maintenance)\s*$/i.test(lo.trim())) return true;
  if (/\b(school (closur|consolidat|boundar|redistrict|report card)|closures?\s*$)\b/i.test(lo) &&
      !/\b(renovation|construction|building|facility|design|addition|expansion|replacement|rfq|rfp)\b/i.test(lo)) return true;
  if (/\b(fairground|fairgrounds|fair ground)\b/i.test(lo) && /\b(rental|rent|reservation|book|lease|event)\b/i.test(lo)) return true;
  if (/\b(building rental|room rental|space rental|hall rental|rental (rates?|info|information|agreement|application|policy|policies|form))\b/i.test(lo)) return true;
  if (/^(downtown|uptown|midtown|northside|southside|eastside|westside|old town|central)\s+[A-Z][a-z]+\s*$/i.test((title||'').trim()) &&
      !/\b(development|redevelopment|renovation|construction|plan|improvement|expansion|project|program|district)\b/i.test(lo)) return true;
  if (/^\d{4}[\s\-]+\d{4}\b/.test(lo.trim()) && /\b(review|audit|report|analysis|summary|update|assessment)\b/i.test(lo) &&
      !/\b(renovation|construction|design|rfq|rfp|facility|school|hospital)\b/i.test(lo)) return true;
  if (/^\d{4}\s+\b/.test(lo.trim()) && /\b(code (adoption|update|amendment|revision)|ordinance (adoption|update|amendment))\b/i.test(lo) &&
      !/\b(renovation|construction|design|rfq|rfp|facility|building project)\b/i.test(lo)) return true;
  if (/\b(permit statistics|building statistics|code enforcement statistics|inspection statistics)\b/i.test(lo)) return true;
  if (/\b(faqs?|frequently asked|questions and answers)\b/i.test(lo) &&
      !/\b(renovation|construction|design|rfq|rfp|facility|project)\b/i.test(lo)) return true;
  if (/\b(building division|planning division|engineering division|code enforcement|inspection services)\s*$/i.test(lo.trim()) &&
      !/\b(renovation|construction|design|rfq|rfp|project)\b/i.test(lo)) return true;
  if (/^(planning|development|sustainability|growth)[,\s]+(development|planning|sustainability|growth|and|&|\s)+$/i.test(lo.trim()) &&
      !/\b(renovation|construction|design|rfq|rfp|facility|building|project|block grant|redevelopment)\b/i.test(lo)) return true;
  if (/\b(development (applications?|permits?|submittals?|filings?|review))\b/i.test(lo) &&
      !/\b(renovation|construction|design|rfq|rfp|facility|building|school|hospital|block grant)\b/i.test(lo)) return true;
  if (/^(private|public)\s+(development|construction)\s+(projects?|listings?|applications?)\s*$/i.test(lo.trim())) return true;
  if (/\b(storm\s*water|stormwater)\s+(pollution|runoff|management|permit|compliance|prevention)\b/i.test(lo) &&
      !/\b(renovation|construction|building|facility|design|treatment plant)\b/i.test(lo)) return true;
  // Bare proper-name + generic civic word
  if (/^[A-Z][\w\s.'&\u2019]+\s+(housing|planning|zoning|infrastructure|transportation|utilities|services|operations|administration|management|information|safety|compliance|personnel|staffing)\s*$/i.test((title||'').trim()) &&
      !/\b(renovation|construction|building|facility|design|project|rfq|rfp|bond|development|redevelopment|expansion|addition|replacement|improvement|plan)\b/i.test(lo)) return true;
  // Non-physical development
  if (/\b(staff|workforce|professional|economic|income|revenue|resource|software|curriculum|leadership|organizational|career|personal|talent|capacity)\s+development\b/i.test(lo) &&
      !/\b(building|facility|renovation|construction|design|rfq|rfp|redevelopment|site|campus|block|corridor|district)\b/i.test(lo)) return true;
  // Vague area/neighborhood references
  if (/\b(area|neighborhood|vicinity|zone|sector|precinct|ward|annexation area)\s*$/i.test(lo.trim()) &&
      !/\b(renovation|construction|building|facility|design|project|rfq|rfp|development|redevelopment|expansion|improvement|plan|bond)\b/i.test(lo)) return true;
  // Geographic + report/update
  if (/^[A-Z][\w\s.'&\u2019]+\s+(update|report|overview|summary|profile|snapshot|brief|bulletin|newsletter)\s*$/i.test((title||'').trim()) &&
      !/\b(renovation|construction|building|facility|design|project|rfq|rfp|development|bond|capital)\b/i.test(lo)) return true;
  // Filler title prefix
  if (/^(information (about|on|regarding)|overview of|guide to|introduction to|summary of|update on|status of|details (on|about|of))\s+/i.test(lo) &&
      !/\b(renovation|construction|building|facility|design|project|rfq|rfp|development|bond|capital)\b/i.test(lo)) return true;
  // Permits, regulatory, and administrative — not A&E project signals
  if (/\b(building permits?|commercial.+permits?|residential.+permits?|permit (application|fee|process|requirement))\b/i.test(lo) && !/\b(design|architect|renovation|construction of|new (building|facility))\b/.test(lo)) return true;
  if (/\b(weed control|weed district|noxious weed|mosquito control|pest district)\b/i.test(lo)) return true;
  if (/\b(hazard mitigation plan|hazard mitigation update|pre-?disaster mitigation)\b/i.test(lo) && !/\b(design|architect|building|facility|renovation|shelter|safe room|fire station)\b/.test(lo)) return true;
  // Right-of-way research/clearing
  if (/\b(right.of.way|public right of way|property right.of.way|easement (acquisition|research))\b/i.test(lo) && !/\b(design|architect|building|facility|renovation|improvement project)\b/.test(lo)) return true;
  // v27: Heritage/interpretive/cultural plans
  if (/\b(heritage\s+(interpretive|preservation|trail|corridor|tourism)|interpretive\s+(plan|center|trail|sign)|cultural\s+(plan|heritage|trail|corridor))\b/i.test(lo) && !/\b(design|architect|building|facility|renovation|museum|visitor\s+center|rfq|rfp)\b/.test(lo)) return true;
  // Community development partnerships / civic initiative labels
  if (/\b(community\s+development\s+partner(ship)?s?|development\s+partnerships?|civic\s+partnerships?)\b/i.test(lo) && !/\b(design|architect|building|facility|renovation|rfq|rfp|school|hospital|fire station)\b/.test(lo)) return true;
  // v29: Elevator, MEP, walking tours, business dev, CDBG program, brownfields
  // are now Tier 2 (review queue) — removed from isNoiseTitle auto-prune
  // Generic "X District" / "X Triangle" area names without project action
  if (/^[\w\s']+\s+(district|triangle|corridor|neighborhood|quarter|precinct|zone)\s*$/i.test(lo.trim()) &&
      !/\b(renovation|construction|building|facility|design|rfq|rfp|project|improvement|development|redevelopment|expansion|bond)\b/i.test(lo)) return true;
  // v29: Community Development standalone and program-level redevelopment
  // are now Tier 2 (review queue) — removed from isNoiseTitle auto-prune
  return false;
}

// Test cases
const suppress = [
  'Community Development', 'School Closures', 'Fairground Building Rental',
  'Downtown Kalispell', 'Project and Engineering', '2023-2024 Development Review Audit',
  'Building Permit Statistics', '2021 Building Code Adoption', 'Building Division FAQs', 'Development Center',
  // New Watch-quality suppressions
  'Missoula Housing', 'Flathead County Planning', 'Helena Infrastructure',
  'Staff Development', 'Professional Development', 'Workforce Development',
  'North Reserve Area', 'South Hills Neighborhood',
  'Billings Report', 'Helena Update',
  'Information about zoning changes', 'Overview of the permitting process',
  // Out-of-scope: permits, weed control, hazard mitigation, ROW
  'Commercial Building Permits', 'Residential Building Permits',
  'Weed Control District', 'Regional Hazard Mitigation Plan',
  'Research a Property Public Right of Way',
  // v27: Vague civic/planning labels, neighborhood names (still Tier 1)
  'Community Development Partnerships',
  'Downtown Heritage Interpretive Plan',
  'University District',
  'Southgate Triangle',
];

// v29: Tier 2 items — go to review queue, not auto-pruned
const tier2Review = [
  'Mazurek Elevator Modernization',
  'Mazurek Renovation / Elevator Modernization',
  'Elevator Repair / Replacement',
  'Fire Alarm Replacement - Multiple Buildings',
  'Boiler Replacement - MLEA Administration Building',
  'Boiler Replacement - Helena Civic Center',
  'Fire Alarm Upgrade',
  'Central Business Historic District Walking Tour',
  'Railroad Historic District Walking Tour',
  'New Business Development',
  'Community Development Block Grant (CDBG) Program',
  'Brownfields Redevelopment',
  'Community Development Initiative',
];

const keep = [
  'Redevelopment of the Former Library Block', 'Greater Missoula Downtown Master Plan',
  'Riverfront Triangle Development', 'Midtown Commons (aka Southgate Crossing)',
  'West Broadway River Corridor Plan', 'Core & Rail Development',
  'Community Development Block Grant',
  'Lambing Barn Renovation & Safety Upgrades',
  'Kalispell Combination Facility', 'MT State Capitol Renovation of Legislative Spaces',
  'Great Falls Combination Facility',
  // New: must still survive Watch-quality filters
  'Missoula Housing Development Plan', 'Helena Infrastructure Improvement Project',
  'North Reserve Street Redevelopment', 'South Hills Community Center Expansion',
  'Flathead County Facility Planning', 'Billings Capital Improvement Report',
];

const borderline = [
  'Smith Block Building', 'Storm Water Pollution', 'Water Treatment Plant',
  'Wastewater Facility', 'Private Development Projects',
  'Engage Missoula Development Applications', 'Planning, Development and Sustainability',
];

// Tier 2 review candidate function (mirrors frontend isTier2ReviewCandidate)
function isTier2ReviewCandidate(title) {
  const lo = (title || '').toLowerCase();
  if (/\b(elevator|escalator)\b/i.test(lo) && /\b(modernization|maintenance|repair|service|inspection|upgrade|replacement|refurbish)\b/i.test(lo) && !/\b(design\s+services|architect|a\/e|new\s+(building|facility|addition)|building\s+design)\b/i.test(lo)) return { isTier2: true, reason: 'MEP (elevator/escalator)' };
  if (/\b(boiler|fire\s+alarm|fire\s+suppression|sprinkler\s+system|generator|hvac\s+(unit|system|equipment)|chiller|cooling\s+tower|rooftop\s+unit|ahu|air\s+handler)\b/i.test(lo) && /\b(replacement|repair|maintenance|service|inspection|upgrade|install)\b/i.test(lo) && !/\b(design\s+services|architect|a\/e|renovation|addition|new\s+(building|facility)|building\s+design|remodel|expansion)\b/i.test(lo)) return { isTier2: true, reason: 'MEP equipment' };
  if (/\b(walking\s+tour|self[\-\s]guided\s+tour|audio\s+tour|guided\s+tour|heritage\s+tour|historic\s+(district\s+)?tour|architectural\s+tour)\b/i.test(lo)) return { isTier2: true, reason: 'Walking tour' };
  if (/\b(business\s+development|new\s+business|business\s+retention|business\s+attraction|business\s+recruitment|business\s+incubat)\b/i.test(lo) && !/\b(renovation|construction|building|facility|design|rfq|rfp|campus|center|office\s+building|incubator\s+facility)\b/i.test(lo)) return { isTier2: true, reason: 'Business development' };
  if (/^community\s+development\b/i.test(lo.trim()) && !/\b(renovation|construction|building|facility|design|rfq|rfp|block\s+grant|cdbg|school|hospital|fire station|library)\b/i.test(lo)) return { isTier2: true, reason: 'Community development (vague)' };
  if (/\b(block\s+grant|cdbg)\b/i.test(lo) && /\bprogram\b/i.test(lo) && !/\b(renovation|construction|design|rfq|rfp|facility|project|school|hospital|fire station)\b/i.test(lo)) return { isTier2: true, reason: 'CDBG program' };
  if (/\b(brownfield|urban|area|community|downtown|neighborhood|rural|regional)\s+redevelopment\s*$/i.test(lo.trim()) && !/\b(renovation|construction|building|facility|design|rfq|rfp|school|hospital|fire station|library|courthouse|campus|center)\b/i.test(lo)) return { isTier2: true, reason: 'Program-level redevelopment' };
  if (/^(brownfield|brownfields)\s*(redevelopment|cleanup|assessment|remediation|program|grant|site)?\s*$/i.test(lo.trim())) return { isTier2: true, reason: 'Brownfields' };
  return { isTier2: false };
}

let failures = 0;

console.log('=== TIER 1: SHOULD AUTO-SUPPRESS ===');
for (const t of suppress) {
  const blocked = isNoiseTitle(t);
  if (!blocked) failures++;
  console.log(blocked ? '  ✅ BLOCKED' : '  ❌ PASSES', '-', t);
}

console.log('\n=== TIER 2: SHOULD GO TO REVIEW QUEUE (not auto-blocked, but caught by Tier 2) ===');
for (const t of tier2Review) {
  const blockedByTier1 = isNoiseTitle(t);
  const tier2 = isTier2ReviewCandidate(t);
  if (blockedByTier1) { failures++; console.log('  ❌ AUTO-BLOCKED (should be review)', '-', t); }
  else if (!tier2.isTier2) { failures++; console.log('  ❌ NOT CAUGHT by Tier 2', '-', t); }
  else { console.log(`  ✅ → REVIEW (${tier2.reason})`, '-', t); }
}

console.log('\n=== SHOULD KEEP (no Tier 1 or Tier 2 match) ===');
for (const t of keep) {
  const blocked = isNoiseTitle(t);
  if (blocked) failures++;
  console.log(blocked ? '  ❌ BLOCKED' : '  ✅ PASSES', '-', t);
}

console.log('\n=== BORDERLINE ===');
for (const t of borderline) {
  const blocked = isNoiseTitle(t);
  console.log(blocked ? '  BLOCKED' : '  PASSES', '-', t);
}

console.log(`\n${failures === 0 ? '✅' : '❌'} ${failures} failures`);
