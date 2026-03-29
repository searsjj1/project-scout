/**
 * Test: Lead quality suppression — strategy documents, already-claimed, title quality
 * Tests classifyDocumentType, isAlreadyClaimed (with wide context), and frontend patterns.
 */

let failures = 0;
function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ PASS - ${label}`);
  } else {
    console.log(`  ❌ FAIL - ${label}`);
    failures++;
  }
}

// ═══════════════════════════════════════════════════════
// Inline: classifyDocumentType (mirrors backend/api/scan.js)
// ═══════════════════════════════════════════════════════
function classifyDocumentType(content) {
  if (!content || content.length < 200) return { isStrategy: false, documentType: 'unknown', signals: [] };
  const lo = content.toLowerCase();
  const signals = [];
  if (/\bcomprehensive\s+economic\s+development\s+strategy\b/.test(lo) || /\bceds\b/.test(lo) && /\beconomic\s+development\b/.test(lo)) signals.push('ceds');
  if (/\bannual\s+report\b/.test(lo) && (/\bfiscal\s+year\b/.test(lo) || /\byear\s+in\s+review\b/.test(lo) || /\baccomplishments?\b/.test(lo))) signals.push('annual_report');
  if (/\bstrategic\s+plan\b/.test(lo) && (/\bgoals?\s+(?:and\s+)?(?:objectives?|strategies|priorities|actions?)\b/.test(lo) || /\bvision\b/.test(lo) && /\bmission\b/.test(lo))) signals.push('strategic_plan');
  if (/\bimplementation\s+(?:plan|strategy|framework)\b/.test(lo) && /\b(?:goals?|objectives?|strategies|priorities|action\s+items?)\b/.test(lo) && /\b(?:community|economic|workforce|regional)\b/.test(lo)) signals.push('implementation_plan');
  if (/\beconomic\s+development\b/.test(lo) && (/\b(?:strategic|comprehensive|annual|five.year|ten.year|long.term)\s+(?:plan|report|strategy)\b/.test(lo) || /\bswot\b/.test(lo) || /\bstakeholder\b/.test(lo) && /\binput\b/.test(lo))) signals.push('economic_development_plan');
  if (/\b(?:comprehensive|community|growth)\s+(?:master\s+)?plan\b/.test(lo) && (/\bland\s+use\b/.test(lo) || /\bzoning\b/.test(lo) || /\bfuture\s+development\b/.test(lo) || /\bgoals?\s+(?:and\s+)?(?:policies|objectives)\b/.test(lo))) signals.push('community_master_plan');
  if (/\b(?:district|corridor|downtown|neighborhood)\s+plan\b/.test(lo) && (/\bvision\b/.test(lo) || /\bgoals?\s+(?:and\s+)?(?:objectives?|strategies|policies)\b/.test(lo)) && content.length > 3000) signals.push('district_plan');
  if (/\b(?:accomplishments?|achievements?|milestones?|progress\s+report|year\s+in\s+review|highlights?)\b/.test(lo) && /\b(?:fiscal\s+year|fy\s*\d|calendar\s+year|\d{4}\s+(?:annual|report|review))\b/.test(lo)) signals.push('retrospective');
  if (/\b(?:priority|priorities)\s+(?:list|projects?|initiatives?|areas?)\b/.test(lo) && /\b(?:community|economic|regional|strategic)\b/.test(lo) && !/\b(?:rfq|rfp|solicitation|invitation\s+to\s+bid)\b/.test(lo)) signals.push('priority_list');
  const hasProcurement = /\b(?:rfq|rfp|invitation\s+to\s+bid|request\s+for\s+(?:qualifications?|proposals?)|solicitation\s+#|bid\s+#|submit\s+(?:qualifications?|proposals?)\s+by|due\s+date|closing\s+date|selection\s+committee)\b/.test(lo);
  return { isStrategy: signals.length >= 1 && !hasProcurement, documentType: signals.length > 0 ? signals[0] : 'standard', signals };
}

// ═══════════════════════════════════════════════════════
// Inline: isAlreadyClaimed (mirrors backend/api/scan.js — UPDATED with wide context + broad patterns)
// ═══════════════════════════════════════════════════════
function isAlreadyClaimed(title, ...contexts) {
  const lo = contexts.map(c => (c || '')).join(' ').toLowerCase();
  const tlo = (title || '').toLowerCase();

  const hasOpenSolicitation = /\b(?:rfq|rfp|invitation\s+to\s+bid|request\s+for\s+(?:qualifications?|proposals?))\s*(?:#\s*\w+[-\d]*\s*)?(?:for|:|–|—)\s/.test(lo) ||
    /\b(?:submit\s+(?:qualifications?|proposals?|statements?)\s+(?:by|before|no\s+later))\b/.test(lo) ||
    /\b(?:solicitation\s+(?:is\s+)?(?:now\s+)?open|currently\s+(?:seeking|soliciting|accepting))\b/.test(lo);

  // Awarded
  if (/\b(?:awarded\s+to|contract\s+awarded\s+to|contract\s+(?:has\s+been\s+)?awarded|award(?:ed)?\s+(?:the\s+)?contract)\b/.test(lo) ||
      /\b(?:selected\s+(?:firm|team|consultant|contractor|vendor|architect|designer|engineer))\b/.test(lo) ||
      /\b(?:firm\s+(?:has\s+been\s+)?selected|team\s+(?:has\s+been\s+)?selected)\b/.test(lo)) {
    if (!/\b(?:to\s+be\s+awarded|will\s+be\s+awarded|pending\s+award|award\s+pending)\b/.test(lo)) {
      if (hasOpenSolicitation) return { isClaimed: false };
      return { isClaimed: true, reason: 'awarded_to_entity' };
    }
  }

  // Designer/architect
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
      return { isClaimed: true, reason: 'has_designer' };
    }
  }

  // Engineer of record
  const engineerMatch =
    /\bengineer\s+of\s+record\b/i.test(lo) ||
    /\b(?:engineer|engineering\s+firm|engineering\s+team|engineering\s+consultant)\s*[:\u2013\u2014\-]\s*[A-Z]/i.test(lo) ||
    /\bengineering\s+(?:firm|team|consultant)\s+(?:is|was|selected)\b/i.test(lo) ||
    /\bengineer\s+(?:is|was|selected)\b/i.test(lo);
  if (engineerMatch) {
    if (!/\b(?:seeking|needed|required|wanted|looking\s+for)\b/i.test(lo)) {
      if (hasOpenSolicitation) return { isClaimed: false };
      return { isClaimed: true, reason: 'has_engineer' };
    }
  }

  // Contractor / CM / GC
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
      return { isClaimed: true, reason: 'has_contractor' };
    }
  }

  // Under construction
  if (/\b(?:under\s+construction|construction\s+(?:is\s+)?underway|construction\s+(?:has\s+)?(?:begun|began|started|commenced)|broke\s+ground|groundbreaking\s+(?:was|held|ceremony|event)|currently\s+(?:under\s+construction|being\s+(?:built|constructed|renovated))|construction\s+(?:is\s+)?in\s+progress|(?:is|are)\s+(?:currently\s+)?under\s+construction)\b/.test(lo)) {
    if (!/\b(?:new\s+phase|phase\s+[2-9]|next\s+phase|additional\s+scope|expansion\s+of|future\s+phase)\b/.test(lo)) {
      if (hasOpenSolicitation) return { isClaimed: false };
      return { isClaimed: true, reason: 'under_construction' };
    }
  }

  // Completed
  if (/\b(?:project\s+complet(?:ed|ion)|construction\s+complet(?:ed|ion)|(?:was|has\s+been)\s+completed|completed\s+in\s+\d{4}|opened\s+in\s+\d{4}|ribbon[\s\-]cutting|grand\s+opening|(?:was|has\s+been)\s+(?:finished|built|constructed|renovated|remodeled)|now\s+(?:open|complete|operational)|substantially\s+complete)\b/.test(lo)) {
    if (!/\b(?:new\s+phase|phase\s+[2-9]|next\s+phase|additional|upcoming|future\s+phase)\b/.test(lo)) {
      if (hasOpenSolicitation) return { isClaimed: false };
      return { isClaimed: true, reason: 'completed' };
    }
  }

  // Project team section (2+ roles named)
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
      return { isClaimed: true, reason: 'project_team_assembled' };
    }
  }

  // Title prefix
  if (/^(?:completed|awarded|closed|expired|archived|past|existing)[:\s]/i.test(tlo)) return { isClaimed: true, reason: 'completed_prefix' };
  return { isClaimed: false };
}

// ═══════════════════════════════════════════════════════
// TEST 1: Strategy document classification
// ═══════════════════════════════════════════════════════
console.log('\n=== STRATEGY DOCUMENT CLASSIFICATION ===');
assert(classifyDocumentType(`Comprehensive Economic Development Strategy (CEDS) outlines goals and objectives for economic development in the region with workforce development priorities. This document establishes a framework for coordinated regional growth and identifies key investment areas for the coming five years.`).isStrategy === true, 'CEDS → strategy');
assert(classifyDocumentType(`Annual Report - Fiscal Year 2025. This year in review highlights our accomplishments across all departments. Parks received new equipment, the fire department responded to calls, and Public Works completed paving projects throughout the county service area.`).isStrategy === true, 'Annual report → strategy');
assert(classifyDocumentType(`RFQ #2025-045 for Architectural Design Services for the New Fire Station. Selection committee will review qualifications. Submit by March 15, 2026. Contact the purchasing department for more details on this procurement opportunity.`).isStrategy === false, 'RFQ page → NOT strategy');
assert(classifyDocumentType(`Short text here`).isStrategy === false, 'Short text → NOT strategy');

// ═══════════════════════════════════════════════════════
// TEST 2: Already-claimed — basic patterns
// ═══════════════════════════════════════════════════════
console.log('\n=== ALREADY-CLAIMED: BASIC PATTERNS ===');
assert(isAlreadyClaimed('Library', 'The contract was awarded to Smith Construction').isClaimed === true, 'Awarded to contractor → claimed');
assert(isAlreadyClaimed('Center', 'Designed by ABC Architects of Missoula').isClaimed === true, 'Designed by → claimed');
assert(isAlreadyClaimed('Station', 'Construction is currently under construction').isClaimed === true, 'Under construction → claimed');
assert(isAlreadyClaimed('School', 'The project was completed in 2024').isClaimed === true, 'Completed → claimed');
assert(isAlreadyClaimed('Arena', 'The grand opening was held last month').isClaimed === true, 'Grand opening → claimed');
assert(isAlreadyClaimed('Hospital', 'Construction began in January 2025').isClaimed === true, 'Construction began → claimed');
assert(isAlreadyClaimed('Completed: Library', 'context').isClaimed === true, 'Title prefix → claimed');

// ═══════════════════════════════════════════════════════
// TEST 3: Already-claimed — REAL-WORLD patterns (the gap from the last pass)
// ═══════════════════════════════════════════════════════
console.log('\n=== ALREADY-CLAIMED: REAL-WORLD PATTERNS ===');

// Architect: FirmName format (colon-delimited, common on project pages)
assert(isAlreadyClaimed('Fire Station Renovation', 'Project Details. Architect: CTA Architects Engineers. Budget: $4.2M.').isClaimed === true,
  '"Architect: CTA Architects" → claimed');

// Designer: FirmName format
assert(isAlreadyClaimed('Community Center', 'Design Team: MMW Architects. Schedule: 18 months.').isClaimed === true,
  '"Design Team: MMW" → claimed');

// Project Architect: format
assert(isAlreadyClaimed('Library Addition', 'Project Architect: A&E Design Group. Contractor: Swank Enterprises.').isClaimed === true,
  '"Project Architect: A&E Design" → claimed');

// GC: or Contractor: format
assert(isAlreadyClaimed('School Renovation', 'GC: Jackson Contractor Group. Architect: SMA Architects.').isClaimed === true,
  '"GC: Jackson" → claimed');

// CM/GC: format
assert(isAlreadyClaimed('Courthouse', 'CM/GC: Sletten Construction. Budget: $12M.').isClaimed === true,
  '"CM/GC: Sletten" → claimed');

// CMAR: format
assert(isAlreadyClaimed('Hospital Wing', 'CMAR: Langlas & Associates. Architect: Cushing Terrell.').isClaimed === true,
  '"CMAR: Langlas" → claimed');

// Design-Build: format
assert(isAlreadyClaimed('Treatment Plant', 'Design-Build: Morrison-Maierle. Owner: City of Missoula.').isClaimed === true,
  '"Design-Build: Morrison" → claimed');

// Engineer of record
assert(isAlreadyClaimed('Water Plant', 'Engineer of record is HDR Engineering. Construction timeline: 2026.').isClaimed === true,
  '"Engineer of record is HDR" → claimed');

// Engineering firm: format
assert(isAlreadyClaimed('Bridge', 'Engineering Firm: Robert Peccia & Associates. County project.').isClaimed === true,
  '"Engineering Firm: Robert Peccia" → claimed');

// Construction Manager: format
assert(isAlreadyClaimed('Arena', 'Construction Manager: Dick Anderson Construction.').isClaimed === true,
  '"Construction Manager: Dick Anderson" → claimed');

// A/E Firm: format
assert(isAlreadyClaimed('School', 'A/E Firm: LPW Architecture. Project schedule starts Fall 2025.').isClaimed === true,
  '"A/E Firm: LPW" → claimed');

// Selected architect
assert(isAlreadyClaimed('Clinic', 'The selected architect for the project is Cushing Terrell.').isClaimed === true,
  '"selected architect" → claimed');

// Selected firm
assert(isAlreadyClaimed('Center', 'The firm has been selected for the design work.').isClaimed === true,
  '"firm has been selected" → claimed');

// Contract awarded
assert(isAlreadyClaimed('Building', 'The contract has been awarded for construction.').isClaimed === true,
  '"contract has been awarded" → claimed');

// Construction in progress
assert(isAlreadyClaimed('Facility', 'Construction is in progress on the new facility.').isClaimed === true,
  '"construction is in progress" → claimed');

// Now open/operational
assert(isAlreadyClaimed('Library', 'The renovated library is now open to the public.').isClaimed === true,
  '"now open" → claimed');

// Multiple team roles (project team assembled)
assert(isAlreadyClaimed('School', 'Architect: SMA. Contractor: Swank. Engineer: Morrison-Maierle.').isClaimed === true,
  '3 team roles named → project_team_assembled');

assert(isAlreadyClaimed('Building', 'Architect: CTA. GC: Jackson.').isClaimed === true,
  '2 team roles named → project_team_assembled');

// ═══════════════════════════════════════════════════════
// TEST 4: Wide context — info in adjacent paragraph
// ═══════════════════════════════════════════════════════
console.log('\n=== WIDE CONTEXT: ADJACENT PARAGRAPH ===');

// Architect info is in a different sentence/paragraph than the project name
const projectSentence = 'The new Kalispell Fire Station will feature a 3-bay apparatus room with living quarters.';
const adjacentParagraph = 'The architect is CTA Architects Engineers of Billings. Construction budget is estimated at $4.2 million.';
assert(isAlreadyClaimed('Kalispell Fire Station', projectSentence, adjacentParagraph).isClaimed === true,
  'Architect in adjacent paragraph → claimed via wide context');

// Contractor info on same page but different section
const projectSection = 'Whitefish Library Expansion: Adding 5,000 sq ft for meeting rooms and children area.';
const teamSection = 'Project Team. Architect: A&E Design Group. Contractor: Swank Enterprises. Engineer: Morrison-Maierle.';
assert(isAlreadyClaimed('Whitefish Library Expansion', projectSection, teamSection).isClaimed === true,
  'Team section elsewhere on page → claimed via wide context');

// ═══════════════════════════════════════════════════════
// TEST 5: Escape clauses — should NOT be claimed
// ═══════════════════════════════════════════════════════
console.log('\n=== ESCAPE CLAUSES: NOT CLAIMED ===');

assert(isAlreadyClaimed('Library', 'The contract will be awarded to the most qualified firm').isClaimed === false,
  '"will be awarded" → NOT claimed');
assert(isAlreadyClaimed('Center', 'Seeking designer for the new community center').isClaimed === false,
  '"Seeking designer" → NOT claimed');
assert(isAlreadyClaimed('School', 'Phase 1 completed. New phase 2 expansion requires new design team').isClaimed === false,
  'New phase → NOT claimed');
assert(isAlreadyClaimed('Fire Station', 'RFQ for design services for new fire station').isClaimed === false,
  'Normal RFQ → NOT claimed');

// Open solicitation escape: page has both past award AND current RFQ
assert(isAlreadyClaimed('Courthouse', 'Phase 1 was awarded to XYZ. RFQ for Phase 2 design services. Submit qualifications by March 30.').isClaimed === false,
  'Past award + current RFQ → NOT claimed (open solicitation escape)');

assert(isAlreadyClaimed('Hospital', 'Architect: CTA. Currently seeking contractor for phase 2. RFP for construction management.').isClaimed === false,
  'Has architect but currently seeking CM → NOT claimed (seeking escape)');

// ═══════════════════════════════════════════════════════
// TEST 6: MEP CEDS proof case
// ═══════════════════════════════════════════════════════
console.log('\n=== PROOF CASE: MEP CEDS ===');
const mepContent = `Missoula Economic Partnership CEDS Comprehensive Economic Development Strategy.
  Goals and objectives for economic development. Priority areas: Mullan Road Technology District,
  Old Sawmill District redevelopment, Southgate Mall area development.`;
assert(classifyDocumentType(mepContent).isStrategy === true, 'MEP CEDS → strategy');

// ═══════════════════════════════════════════════════════
// TEST 7: True procurement survives
// ═══════════════════════════════════════════════════════
console.log('\n=== PROOF CASE: TRUE PROCUREMENT SURVIVES ===');
assert(classifyDocumentType(`RFQ #2026-001 for Architectural Design Services. Submit qualifications by March 30. Selection committee review.`).isStrategy === false,
  'True RFQ → NOT strategy');
assert(isAlreadyClaimed('Fire Station Design', 'RFQ for design services for new fire station. Submit by March 30, 2026.').isClaimed === false,
  'Active RFQ → NOT claimed');

// ═══════════════════════════════════════════════════════
// TEST 8: Suppression reason is inspectable
// ═══════════════════════════════════════════════════════
console.log('\n=== SUPPRESSION REASONS ===');
const r1 = isAlreadyClaimed('X', 'Architect: CTA Architects.');
assert(r1.isClaimed === true && r1.reason === 'has_designer', 'Reason: has_designer');

const r2 = isAlreadyClaimed('X', 'GC: Jackson Contractor Group.');
assert(r2.isClaimed === true && (r2.reason === 'has_contractor' || r2.reason === 'project_team_assembled'), 'Reason: has_contractor');

const r3 = isAlreadyClaimed('X', 'Construction is underway at the site.');
assert(r3.isClaimed === true && r3.reason === 'under_construction', 'Reason: under_construction');

const r4 = isAlreadyClaimed('X', 'The ribbon-cutting ceremony was held.');
assert(r4.isClaimed === true && r4.reason === 'completed', 'Reason: completed');

const r5 = isAlreadyClaimed('X', 'The selected architect is ABC Design.');
assert(r5.isClaimed === true && (r5.reason === 'awarded_to_entity' || r5.reason === 'has_designer'), 'Reason: awarded or has_designer for selected architect');

const r6 = isAlreadyClaimed('X', 'Architect: SMA. Contractor: Swank.');
assert(r6.isClaimed === true && (r6.reason === 'project_team_assembled' || r6.reason === 'has_designer'), 'Reason: project_team_assembled or has_designer (2+ roles)');

// ═══════════════════════════════════════════════════════
console.log('\n' + (failures === 0 ? '✅ ALL TESTS PASS' : `❌ ${failures} FAILURE(S)`) + ` (${failures} failures)`);
process.exit(failures > 0 ? 1 : 0);
