/**
 * Step 16: Verify all 5 survivors are now caught by the fixed gates.
 */

const survivors = [
  { title: "Financial Management System Replacement The City of Missoul...", status: 'active', relevanceScore: 42, marketSector: 'Civic', projectType: 'Other', description: 'Financial management system replacement procurement' },
  { title: "City of Coeur d\u2019Alene \u2013 Capital Improvement", status: 'watch', relevanceScore: 38, marketSector: 'Civic', projectType: 'Other', description: 'Capital improvement program' },
  { title: "RFQ \u2013 Request for Quotes, RFQu \u2013 Request for Qualifications, \u2013 PW...", status: 'active', relevanceScore: 40, marketSector: 'Other', projectType: 'Other', description: '' },
  { title: "construction of Kings Bridge Deck Replacement (OFFICE FILE 1863)", status: 'active', relevanceScore: 45, marketSector: 'Infrastructure', projectType: 'Construction', description: 'Construction of bridge deck replacement' },
  { title: "income development is under construction on a portion of the...", status: 'watch', relevanceScore: 35, marketSector: 'Other', projectType: 'Other', description: '' },
];

// ── Replicate the FIXED boardQualityPrune gates ──

function isPortalTitle(title) {
  const lo = (title || '').toLowerCase().trim();
  if (/^(current|open|active|closed|awarded|pending)\s+(solicitations?|bids?|rfps?|rfqs?|opportunities|projects?|listings?)$/i.test(lo)) return 'portal_status';
  if (/^(solicitations?|bids?|rfps?|rfqs?|opportunities|procurement)\s+(list|index|page|board|calendar|schedule|archive)$/i.test(lo)) return 'portal_list';
  if (/^(public (works?|notices?|bids?)|bid (board|opportunities)|procurement (portal|page))$/i.test(lo)) return 'portal_public';
  if (/^(rfqs?|rfps?|solicitations?|bids?|proposals?|qualifications?)(\.{2,})?$/i.test(lo)) return 'portal_standalone';
  if (/^requests?\s+for\s+(proposals?|qualifications?|quotes?|bids?)(\s*\/\s*(proposals?|qualifications?|quotes?|bids?))*(\s*\.{2,})?$/i.test(lo)) return 'portal_request';
  // FIXED: en-dash + em-dash + hyphen + slash
  if (/^(rfq|rfp|bid|solicitation)\s*[\/\u2013\u2014\-]/.test(lo) && !/\b(architect|design|building|school|hospital|facility|fire station|library|renovation|remodel)\b/.test(lo)) return 'portal_hub_slash_or_dash';
  if (/^(rfqs?|rfps?|solicitations?|bids?|proposals?)\s*[&+]\s*(rfqs?|rfps?|solicitations?|bids?|proposals?)$/i.test(lo)) return 'portal_compound';
  return null;
}

function isAlwaysGenericTitle(title) {
  const lo = (title || '').toLowerCase().trim();
  // FIXED: smart apostrophe \u2019
  if (/^[\w\s&'\u2019.,()]+\s*[\u2013\u2014\-]\s*solicitations?$/i.test(lo)) return true;
  if (/^[\w\s&'\u2019.,()]+\s*[\u2013\u2014\-]\s*(bids?|rfps?|rfqs?|procurement|opportunities)$/i.test(lo)) return true;
  return false;
}

function isGenericFallbackTitle(title) {
  const lo = (title || '').toLowerCase().trim();
  // FIXED: smart apostrophe \u2019
  if (/^[\w\s&'\u2019.,()]+\s*[\u2013\u2014\-]\s*(project signal|capital improvement|bond\/levy program|master plan|renovation project|expansion project)$/i.test(lo)) return true;
  return false;
}

function isNoiseTitle(title) {
  const lo = (title || '').toLowerCase();
  if (/\b(printable map|bid map|interactive map|gis viewer)\b/.test(lo)) return 'map_noise';
  if (/\b(bid results|bid tabulation|plan holders?|vendor list|bidder list)\b/.test(lo)) return 'bid_noise';
  if (/^(home|about|news|events|contact|board|staff|resources|documents|calendar|agenda|minutes)$/i.test(lo.trim())) return 'nav_noise';
  if (/\b(information for the overall|public works construction schedule|construction management office)\b/.test(lo)) return 'generic_noise';
  // FIXED: IT/management system noise
  if (/\b(management system|financial (system|management)|accounting system|hr system|payroll system|erp|enterprise resource|software (system|platform|solution|implementation|migration)|it (system|infrastructure|services))\b/.test(lo) &&
      /\b(replacement|implementation|upgrade|migration|procurement|rfp|solicitation|modernization)\b/.test(lo) &&
      !/\b(architect|design|building|facility|renovation|construction)\b/.test(lo)) return 'it_system_noise';
  // FIXED: bridge-only noise
  if (/\bbridge\b/.test(lo) && /\b(repair|maintenance|replacement|rehabilitation|deck|overlay|painting|scour|rail|abutment|pier)\b/.test(lo) &&
      !/\b(architect|building|renovation|addition|facility|school|hospital|clinic|terminal|fire station|police|library|courthouse|campus)\b/.test(lo)) return 'bridge_noise';
  return null;
}

function isCivilOnly(lead) {
  const txt = `${lead.title || ''} ${lead.description || ''}`.toLowerCase();
  // FIXED: expanded bridge pattern
  if (/\b(water main|sewer (main|line|construction)|paving|chip seal|crack seal|striping|guardrail|culvert|asphalt|road (maintenance|repair|construction)|bridge\b.*?\b(repair|maintenance|replacement|rehabilitation|deck|overlay|painting)|bridge (deck|scour|rail|abutment|pier)|storm drain|curb and gutter|pipe (replacement|lining|bursting)|manhole|hydrant|meter (replacement|installation)|sedimentation|lagoon)\b/.test(txt)) {
    return !/\b(architect|building|renovation|addition|remodel|interior|facility design|treatment (plant|facility)|school|hospital|clinic|airport|terminal|fire station|police|library|courthouse|campus)\b/.test(txt);
  }
  return false;
}

function isInfraNoBuilding(lead) {
  const m = (lead.marketSector || '').trim();
  if (m !== 'Infrastructure') return false;
  const txt = `${lead.title || ''} ${lead.description || ''}`.toLowerCase();
  return !/\b(treatment (plant|facility)|building|architect|facility (design|renovation|addition)|pump (house|building)|control (building|room))\b/.test(txt);
}

console.log('=== Step 16: Verify all 5 survivors are now CAUGHT ===\n');
let allCaught = true;

for (const s of survivors) {
  const lo = (s.title || '').toLowerCase().trim();
  const isWatch = s.status === 'watch' || s.status === 'new' || s.status === 'monitoring';
  let reason = null;

  // Gate 1: portal
  const portalResult = isPortalTitle(s.title);
  if (portalResult) reason = `portal_fragment_title (${portalResult})`;
  // Gate 2a
  if (!reason && isAlwaysGenericTitle(s.title)) reason = 'generic_solicitation_portal';
  // Gate 2b
  if (!reason && isGenericFallbackTitle(s.title) && (s.relevanceScore || 0) < 50) reason = 'generic_fallback_title';
  // Gate 2e: truncated
  if (!reason && /\b(the|a|an|of|for|and|or|is|are|was|in|on|at|to|with|from|by)\s*\.{0,3}$/.test(lo)) reason = 'truncated_fragment';
  // Gate 2f: mid-sentence
  if (!reason && /^(is |are |was |were |has |have |had |being |or |and |but |for |of |with |to |in |on |at |by |from |that |this |which |where |when |it |its |their |our |your |if |as |so |than )/.test(lo)) reason = 'mid_sentence_fragment';
  // Gate 3: noise
  const noiseResult = isNoiseTitle(s.title);
  if (!reason && noiseResult) reason = `noise_title (${noiseResult})`;
  // Gate 5 (Other/Other)
  if (!reason && s.marketSector === 'Other' && (s.projectType === 'Other' || !s.projectType) && (s.relevanceScore || 0) < 50) reason = 'generic_weak_fit';
  // Gate 5b: Watch plan heading
  if (!reason && isWatch) {
    if (/^(capital improvement|capital project|capital budget|annual (report|budget)|operating budget|fiscal year|fy\s*\d)\b/i.test(lo) ||
        /^[\w\s&'\u2019.,()]+\s*[\u2013\u2014\u2012\-]\s*(capital improvement|capital project|master plan|capital budget|annual (report|budget))\s*$/i.test(lo)) {
      reason = 'watch_generic_plan_heading';
    }
  }
  // Gate 6: infra no building
  if (!reason && isInfraNoBuilding(s)) reason = 'infrastructure_no_building';
  // Gate 7: civil only
  if (!reason && isCivilOnly(s)) reason = 'civil_commodity_no_building';

  const caught = reason ? '✅ CAUGHT' : '❌ SURVIVES';
  if (!reason) allCaught = false;
  console.log(`${caught}: "${s.title.slice(0, 60)}..."`);
  console.log(`  Reason: ${reason || 'NONE'}`);
  console.log();
}

console.log(allCaught ? '✅ ALL 5 SURVIVORS NOW CAUGHT' : '❌ SOME SURVIVORS STILL PASS');
