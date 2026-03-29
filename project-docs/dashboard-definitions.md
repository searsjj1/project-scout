# Dashboard and Lead Object Definitions

## Dashboard Lanes

### 1. Development / Project Potentials
Named development areas, districts, sites, and future opportunity areas.
Not yet active procurements, but real places that may generate future A&E work.

**Examples:**
- Bonner Millsite TIF District
- Wye TEDD District
- Scott Street Project (early stage)
- Midtown Commons / Southgate Crossing
- Riverfront Triangle

**Object types:** district, site, development_potential
**Source types:** redevelopment, budget (capital/TIF sections), media, employer

### 2. News
Missoula County news feed about development, building, planning, land use, infrastructure, construction.
Grouped by date/week, then by area/project, then by source.

**Examples:**
- "Providence announces $40M expansion"
- "City Council approves consultant for Fire Station #6"
- "DAC awarded contract for UM Science Complex"

**Object types:** news_item
**Source types:** media, contractor, employer, agenda (actions)

### 3. Active Project Leads
Real A&E + SMA opportunities that are either in procurement or moving toward procurement.

**Examples:**
- RFQ for CM/GC services - 8th Street (Active solicitation)
- FY2026 CIP: Fire Station #6 Design (Funded, pre-procurement)
- MCPS Bond: Elementary School Addition (Approved, design pending)

**Object types:** solicitation, project
**Source types:** procurement, budget (CIP items), agenda (consultant selections)

### 4. Go / No Go Submitted
Projects submitted for formal Go/No-Go review in Asana.
Tracked via Asana integration.

### 5. Not Pursued
Leads reviewed and intentionally passed on, or pruned by system rules.
Includes manual prunes and system-pruned items.
Recoverable via Unprune.

## Lead Object Types

| Type | Description | Dashboard Lane |
|------|-------------|---------------|
| solicitation | Active RFQ/RFP/SOQ/BID | Active Project Leads |
| project | Named facility project with design scope | Active Project Leads |
| site | Named opportunity area or development site | Development / Project Potentials |
| district | URD/TIF/TEDD/redevelopment district | Development / Project Potentials |
| development_potential | Future opportunity without current procurement | Development / Project Potentials |
| news_item | Development/construction/planning news | News |
| program | Generic program (usually filtered out) | Not a lead |
| department | Department name (filtered out) | Not a lead |
| organization | Company/entity name (filtered out) | Not a lead |

## Filtering Dimensions

| Dimension | Values |
|-----------|--------|
| County | Missoula (V4 default), expandable later |
| Office / Region | Western MT (Missoula office) |
| State | MT (default), ID, WA (future) |
| Dashboard Lane | Development Potentials, News, Active Leads, Go/No-Go, Not Pursued |
| Source Type | Budget, Agenda, Procurement, Redevelopment, Media, Employer, Contractor |
