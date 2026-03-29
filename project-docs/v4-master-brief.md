# Project Scout Version 4 — Master Brief
## Missoula Gold Standard

### Mission
Make Missoula County the gold standard for A&E + SMA project intelligence.
Get Missoula nailed first. Then expand county by county.

### Core Problem with Version 3
- Too much broad keyword hunting across 68+ sources statewide
- Too many generic programs, themes, and departments surviving as "leads"
- Not enough source-by-source intelligence
- Not enough intentional reading of budgets, agendas, packets, minutes, development sites, media, employers, contractors, and local entities
- Circular tuning: pruning rules fought extraction rules, leading to noise→suppress→recall→noise cycles

### Version 4 Direction
- **Source-by-source intelligence** replaces broad keyword scraping
- **Missoula County only** as active scope (reversible for future expansion)
- **Source profiles** define what each source is, what it produces, what to follow, what to ignore
- **Dashboard lanes** replace the single Active/Watch board:
  1. Development / Project Potentials
  2. News
  3. Active Project Leads
  4. Go / No Go Submitted
  5. Not Pursued
- **Lead object typing** enforced: only valid solicitations, projects, sites, districts, and news items survive

### Active Scope — Missoula County Only

**Public / Institutional:**
- Missoula County government
- City of Missoula
- Frenchtown, Lolo, Seeley Lake
- Libraries, school districts
- Sheriff, police, fire departments and districts
- Transportation (air and road)
- Missoula College, University of Montana
- Other Missoula County governmental entities

**Community / Development / Nonprofit:**
- Missoula Chamber of Commerce
- Missoula Economic Partnership (MEP)
- Missoula Development Authority (MDA)
- Missoula Redevelopment Agency (MRA)
- Local nonprofit/public development groups

**Private / Market Pulse:**
- Top 20 employers in Missoula County
- Hospitals (Providence St. Patrick, Community Medical Center)
- Banks and major institutions
- Key private developers

**Contractors:**
- DAC, Quality, Jackson, Martel, Langlas
- Other important Missoula-area commercial contractors

**Competitors / Consultants:**
- Monitor websites, social media, media blasts, news
- Track projects they are working on

**Media:**
- Local print, internet, TV news relevant to development, building, planning, land use, infrastructure, construction

### Infrastructure Preserved from Version 3
- Shared persistence (Upstash Redis)
- Backend/frontend connectivity (Vercel + GitHub Pages)
- Asana integration
- Prune review workflow
- Source registry framework
- Lead object typing
- Taxonomy system
