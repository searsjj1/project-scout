# Missoula Source Universe — Comprehensive Inventory & Priority Map

**Scope:** Missoula County, MT — A&E Business Development Intelligence
**Last Updated:** 2026-03-27 (sourcefix pass)
**Canonical data file:** `src/data/sourceInventory.js`

---

## Overview

| Tier | Count | Description |
|------|-------|-------------|
| Active Now | 35 | In `seedData.js`, operational |
| Profile Next | 18 | Known URL, clear profile; ready to add |
| Backlog | 21 | Catalogued; needs validation or lower priority |
| **Total** | **74** | **Full Missoula universe** |

---

## Active Sources (35) — Current Operational Set

### City of Missoula (9 sources)

| ID | Source Name | Profile | Family | Tier |
|----|-------------|---------|--------|------|
| MT-MIS-001 | Bids, RFPs & RFQs (landing) | procurement | SF-01 | Tier 1 |
| MT-MIS-002 | Bid Postings (CivicEngage) | procurement | SF-01 | Tier 1 |
| MT-MIS-003 | City Council Agendas | agenda | SF-02 | Tier 1 |
| MT-MIS-004 | Community Planning, Development & Innovation | agenda | SF-05 | Tier 1 |
| MT-MIS-005 | Community Investment Program (CIP) | budget | SF-08 | Tier 1 |
| MT-MIS-006 | Major Projects | institutional | SF-07 | Tier 1 |
| MT-MIS-007 | FY2026 Adopted Budget | budget | SF-08 | Tier 1 |
| MT-MIS-010 | City of Missoula Budget Portal | budget | SF-08 | Tier 1 |

**Coverage gaps:** Public Works department, Parks & Recreation department → see P11, P12

### Missoula Redevelopment Agency — MRA (2 sources)

| ID | Source Name | Profile | Family | Tier |
|----|-------------|---------|--------|------|
| MT-MRA-001 | MRA Board Agendas & Minutes | redevelopment | SF-02 | Tier 2 |
| MT-MRA-002 | MRA Urban Renewal Districts | redevelopment | SF-09 | Tier 1 |

**Watch targets:** Riverfront Triangle, Scott Street, Midtown Commons, North Reserve, Hellgate URD, Ravara.

### Missoula County (7 sources)

| ID | Source Name | Profile | Family | Tier |
|----|-------------|---------|--------|------|
| MT-MCO-001 | Commissioner Public Meetings | agenda | SF-02 | Tier 1 |
| MT-MCO-002 | Planning, Development and Sustainability | agenda | SF-05 | Tier 1 |
| MT-MCO-003 | County Budget | budget | SF-08 | Tier 1 |
| MT-MCO-004 | Facilities Management | institutional | SF-07 | Tier 2 |
| MT-MCO-005 | Parks, Trails & Recreation | institutional | SF-07 | Tier 2 |
| MT-MCO-006 | FY26 OpenGov Budget Book — Capital & Districts | budget | SF-08 | Tier 1 |
| MT-MCO-007 | FY26 OpenGov Budget Book — TOC | budget | SF-08 | Tier 2 |

**Watch districts:** Bonner Millsite TID, Bonner West Log Yard TEDD, Wye TEDD, Missoula Development Park.

### MT Architecture & Engineering Division (5 sources)

| ID | Source Name | Profile | Family | Tier |
|----|-------------|---------|--------|------|
| MT-AED-001 | Current Bid Opportunities | procurement | SF-01 | Tier 1 |
| MT-AED-002 | RFQ/RFP Submissions (eMACS) | procurement | SF-01 | Tier 1 |
| MT-AED-003 | Long Range Building Program (LRBP) | budget | SF-08 | Tier 1 |
| MT-AED-004 | Consultants | institutional | SF-07 | Tier 2 |
| MT-AED-005 | Completed Bids | institutional | SF-07 | Tier 2 |

**Note:** LRBP is the single highest-value Watch source in the system — covers all state agency, UM, and school capital projects 1-5 years pre-RFQ.

### Missoula Economic Partnership / MEP (4 sources)

| ID | Source Name | Profile | Family | Tier |
|----|-------------|---------|--------|------|
| MT-MEP-001 | MEP About / Overview | redevelopment | SF-09 | Tier 2 |
| MT-MEP-002 | Invest in Transformation | redevelopment | SF-09 | Tier 1 |
| MT-MEP-003 | Annual Report (current) | redevelopment | SF-06 | Tier 2 |
| MT-MEP-004 | CEDS — Comprehensive Economic Development Strategy | redevelopment | SF-06 | Tier 1 |

### Missoula County Public Schools — MCPS (2 sources)

| ID | Source Name | Profile | Family | Tier |
|----|-------------|---------|--------|------|
| MT-MCPS-001 | MCPS Bond Projects | budget | SF-08 | Tier 2 |
| MT-MCPS-002 | MCPS Smart Schools 2020 | budget | SF-08 | Tier 2 |

**Coverage gaps:** MCPS procurement bids (P10), MCPS board agendas (P13). $158M bond is actively generating A&E work.

### University of Montana (1 source)

| ID | Source Name | Profile | Family | Tier |
|----|-------------|---------|--------|------|
| MT-UM-001 | UM Facilities Services | institutional | SF-08 | Tier 2 |

**Coverage gap:** UM Procurement/Purchasing (P09) — self-funded projects below LRBP threshold.

### Mountain Line / MUTD (1 source — placeholder)

| ID | Source Name | Status |
|----|-------------|--------|
| MT-ML-001 | Mountain Line Board & Procurement | ⚠️ PLACEHOLDER — no URL set |

**Action needed:** Update URL to `mountainline.com` procurement section (P01).

### Media (2 sources)

| ID | Source Name | Profile | Lane |
|----|-------------|---------|------|
| MT-NEWS-001 | Missoulian — Development News | media | news |
| MT-NEWS-002 | Missoula Current — Development | media | news |

### Contractors (2 sources)

| ID | Source Name | Profile | Lane |
|----|-------------|---------|------|
| MT-CON-001 | Jackson Contractor Group — Projects | contractor | development_potentials |
| MT-CON-002 | Langlas & Associates — Projects | contractor | development_potentials |

### Employers / Healthcare (1 source)

| ID | Source Name | Profile | Lane |
|----|-------------|---------|------|
| MT-EMP-001 | Providence St. Patrick Hospital | employer | development_potentials |

**Coverage gap:** Community Medical Center / Intermountain Health (P02) — second major hospital, not monitored.

---

## Coverage Gaps — Critical (add first)

| Gap | Priority | Action |
|-----|----------|--------|
| Mountain Line URL | Immediate | Update MT-ML-001 URL → `mountainline.com` |
| UM Procurement | P09 — High | Active university bids below LRBP threshold |
| MCPS Procurement bids | P10 — High | $158M bond generates ongoing A&E solicitations |
| Missoula Airport | P07 — High | Active terminal expansion — no source monitoring this |
| Community Medical Center | P02 — High | Second major hospital, facility expansion potential |
| City Public Works | P11 — Medium | Infrastructure + utility capital projects |
| City Parks & Rec | P12 — Medium | Bond-funded park/trail facility work |
| MCPS Board Agendas | P13 — Medium | Board approves construction contracts |

---

## Profile Next Sources (18) — Activation Order

Ready to add to `seedData.js`. Activate in this order:

| Order | ID | Source | Reason |
|-------|----|--------|--------|
| 1 | MT-UM-002 | UM Procurement — Bids | Tier 1. Self-funded university bids not covered by AED |
| 2 | MT-MCPS-003 | MCPS Procurement — Bids | Tier 1. $158M bond generating active A&E work |
| 3 | MT-MSO-001 | Missoula Airport Capital Projects | Active terminal expansion. No current coverage |
| 4 | MT-ML-002 | Mountain Line Procurement | Fix existing placeholder MT-ML-001 |
| 5 | MT-EMP-002 | Community Medical Center | Major employer, facility expansion potential |
| 6 | MT-MIS-011 | City Public Works | Gap in City of Missoula coverage |
| 7 | MT-MIS-012 | City Parks & Recreation | Bond-funded park facility work |
| 8 | MT-MCPS-004 | MCPS Board Agendas | Supports MCPS-001/002 |
| 9 | MT-NEWS-003 | KPAX — Local Development News | Supplemental TV news coverage |
| 10 | MT-CON-003 | DAC Inc — Projects | Major Missoula GC, competitive intelligence |
| 11 | MT-CON-004 | Martel Construction — Projects | Montana GC, competitive intelligence |
| 12 | MT-MHA-001 | Missoula Housing Authority | HUD-funded capital projects |
| 13 | MT-MDT-001 | MDT — Missoula District | State transportation projects with A&E scope |
| 14 | MT-MCPLD-001 | Missoula Public Library | New main branch in planning/construction |
| 15 | MT-CON-005 | Quality Construction — Projects | Verify URL first |
| 16 | MT-UM-003 | Missoula College — Campus | Periodic capital projects |
| 17 | MT-WMCF-001 | Western Montana Community Foundation | Low signal density |
| 18 | MT-CON-006 | Swank Enterprises — Projects | Verify URL first |

---

## Backlog Sources (21)

Catalogued but not ready to activate. Review quarterly.

| Category | Sources | Activation Trigger |
|----------|---------|-------------------|
| Small municipalities (K-12) | Frenchtown, Lolo school districts | Facility bond or referendum announcement |
| Seeley Lake area | County coverage via MT-MCO-002 | Specific capital project emerges |
| Major employers | Rocky Mountain Elk Foundation, Washington Companies, Missoula Aging Services | Facility expansion announcement |
| Nonprofits | HRDC, Habitat for Humanity | Multi-unit housing or community facility project |
| Special districts | Rural fire districts, County jail, Fairgrounds | Capital project announced |
| Competitors | CTA Architects, WGM Group, Morrison-Maierle | Manual review; not for scan pipeline |
| Federal | USFS Lolo NF, BLM Missoula | Use SAM.gov for federal procurement |
| Additional media | Montana Free Press, NBC Montana (KECI) | After KPAX (P03) is validated |
| BID / Downtown | Missoula Downtown Association | Overlap with MRA sources |

---

## Named Strategic Watch Targets

Active development areas to watch in MRA/MEP/media sources:

| Target | Owner/Entity | Intelligence Source |
|--------|-------------|---------------------|
| Riverfront Triangle | MRA / Private | MT-MRA-001, MT-MRA-002 |
| Scott Street Project | MRA / Private | MT-MRA-002, MT-NEWS-001/002 |
| Midtown Commons / Southgate Crossing | MRA | MT-MRA-002 |
| Bonner Millsite TIF District | Missoula County | MT-MCO-006 |
| Bonner West Log Yard TEDD | Missoula County | MT-MCO-006 |
| Wye TEDD District | Missoula County | MT-MCO-006 |
| Missoula Development Park | Missoula County | MT-MCO-006 |
| Grant Creek Crossing | City of Missoula | MT-MIS-007, MT-MIS-010 |
| UM Science Complex | University of Montana | MT-UM-001, MT-AED-003 |
| MSO Airport Terminal | Missoula Airport Authority | MT-MSO-001 (profile_next) |
| Fire Station #6 | City of Missoula | MT-MIS-007 |
| Animal Control Facility | City of Missoula | MT-MIS-007 |
| MCPS Smart Schools (active schools) | MCPS | MT-MCPS-001, MT-MCPS-003 (profile_next) |
| Missoula Public Library New Branch | MCPLD | MT-MCPLD-001 (profile_next) |

---

## Profile Distribution (Active)

| Profile Type | Source Count | Primary Entities |
|-------------|-------------|-----------------|
| budget | 9 | City CIP/Budget, County OpenGov, AED LRBP, MCPS bond |
| procurement | 7 | City bids, AED, MCPS/UM (profile_next) |
| agenda | 4 | City Council, County Commissioner, MRA board, MCPS (profile_next) |
| redevelopment | 6 | MRA, MEP |
| institutional | 6 | City Major Projects, County Facilities/Parks, UM, AED validation |
| media | 2 | Missoulian, Missoula Current |
| contractor | 2 | Jackson, Langlas |
| employer | 1 | Providence |

---

## Notes on Source Families

| Family | Missoula Sources | Notes |
|--------|-----------------|-------|
| SF-01 Procurement | 7 active | Primary detection layer |
| SF-02 Agendas | 3 active | Early signal layer |
| SF-05 Planning | 2 active | Private-side development review |
| SF-06 Document Centers | 2 active | MEP annual reports, CEDS |
| SF-07 Capital Projects | 5 active | AED validation + City/County facilities |
| SF-08 Budget/CIP | 9 active | Most critical Watch layer |
| SF-09 Redevelopment/EDO | 4 active | MRA + MEP |
| SF-10 Airport | 0 active (1 profile_next) | MSO terminal expansion uncovered |
| SF-11 Housing | 0 active (1 profile_next) | MHA |
| SF-12 Public Safety | 0 active | Rural fire districts in backlog |
| SF-13 Transportation | 1 active (placeholder) | Mountain Line |
| SF-16 Market Pulse | 5 active | Media + contractors + employer |

---

*Canonical source: `src/data/sourceInventory.js`*
