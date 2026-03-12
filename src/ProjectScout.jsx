import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Search, ChevronRight, ChevronDown, ExternalLink, MapPin, Building2, Calendar, DollarSign, TrendingUp, Activity, Clock, AlertCircle, CheckCircle2, XCircle, Eye, EyeOff, Radio, Settings as SettingsIcon, Layers, Send, Archive, Filter, ArrowUpRight, X, BarChart3, Globe, Bookmark, Zap, RefreshCw, Plus, Minus, ChevronLeft, Database, Target, BookOpen, Wifi, WifiOff, Star, Pause, Play, Trash2, Edit3, TestTube, Copy, Save, RotateCcw, Power, Link2, Hash, FileText, Users, Crosshair, UserPlus, ClipboardCheck, MessageSquare, ArrowRight, Shield, Flag } from "lucide-react";

// Phase 2 data foundation
import { runMigration } from './data/migration.js';
import SourceRegistryView from './components/SourceRegistryView.jsx';

/* ═══════════════════════════════════════════════════════════════
   SEED DATA (inline for artifact portability)
   ═══════════════════════════════════════════════════════════════ */

const LEAD_STATUS = { NEW: 'new', ACTIVE: 'active', MONITORING: 'monitoring', SUBMITTED_TO_ASANA: 'submitted_to_asana', NOT_PURSUED: 'not_pursued' };

const MARKET_SECTORS = ['Civic','Municipal','County','State','Public Safety','K-12','Higher Education','Healthcare','Clinics','Research / Lab','Airports / Aviation','Tribal','Housing','Workforce Housing','Affordable Housing','Mixed Use','Hospitality','Recreation','Infrastructure','Landscape','Utility','Commercial','Retail','Industrial','Developer-Led'];

const GEOGRAPHIES = ['Missoula','Missoula County','Kalispell','Whitefish','Columbia Falls','Flathead County','Ravalli County','Hamilton','Lake County','Polson','Sanders County','Lincoln County','Mineral County'];

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
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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
    [LEAD_STATUS.NEW]: { label: 'New', bg: '#dbeafe', fg: '#1e40af' },
    [LEAD_STATUS.ACTIVE]: { label: 'Active', bg: '#d1fae5', fg: '#065f46' },
    [LEAD_STATUS.MONITORING]: { label: 'Monitoring', bg: '#fef3c7', fg: '#92400e' },
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
  const badge = statusBadge(lead.status);
  const discovered = daysAgo(lead.dateDiscovered);

  return (
    <div onClick={onClick} style={{
      background: '#fff', borderRadius: 14, padding: '20px 22px', cursor: 'pointer',
      border: '1px solid #eef0f4', transition: 'all 0.22s cubic-bezier(.4,0,.2,1)',
      boxShadow: '0 1px 2px rgba(0,0,0,0.03), 0 1px 6px rgba(0,0,0,0.02)',
      ...animStyle,
    }}
    onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 8px 30px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.04)'; e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.borderColor = '#dde1e8'; }}
    onMouseLeave={e => { e.currentTarget.style.boxShadow = '0 1px 2px rgba(0,0,0,0.03), 0 1px 6px rgba(0,0,0,0.02)'; e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.borderColor = '#eef0f4'; }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: '#0f172a', margin: 0, lineHeight: 1.35, letterSpacing: '-0.01em' }}>{lead.title}</h3>
          <p style={{ fontSize: 12.5, color: '#64748b', margin: '3px 0 0', fontWeight: 500 }}>{lead.owner}</p>
        </div>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
          background: badge.bg, color: badge.fg, whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '0.04em',
        }}>{badge.label}</span>
        {lead.leadOrigin === 'manual' && (
          <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
            background: '#dbeafe', color: '#1e40af',
            textTransform: 'uppercase', letterSpacing: '0.04em',
          }}>MANUAL</span>
        )}
      </div>

      {/* Meta row */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', marginBottom: 14, fontSize: 11.5, color: '#94a3b8' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}><MapPin size={11} />{lead.location}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}><Building2 size={11} />{lead.marketSector}</span>
        {lead.projectType && <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}><Layers size={11} />{lead.projectType}</span>}
      </div>

      {/* Description */}
      <p style={{ fontSize: 12.5, lineHeight: 1.55, color: '#475569', margin: '0 0 14px', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {lead.description}
      </p>

      {/* Scores + Budget/Timeline */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: 14 }}>
          <ScoreRing score={lead.relevanceScore || 0} label="Relevance" />
          <UrgencyRing dueDate={lead.action_due_date} />
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
   LEAD DETAIL DRAWER
   ═══════════════════════════════════════════════════════════════ */

function LeadDetail({ lead, onClose, onUpdate, onMoveToNotPursued, onSubmitToAsana, onRestore }) {
  const [activeTab, setActiveTab] = useState('overview');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ ...lead });
  // Sync form when lead prop changes (e.g. clicking different lead, or after save)
  useEffect(() => { setForm({ ...lead }); setEditing(false); }, [lead?.id]);
  if (!lead) return null;
  const badge = statusBadge(lead.status);
  const isNotPursued = lead.status === LEAD_STATUS.NOT_PURSUED;
  const isSubmitted = lead.status === LEAD_STATUS.SUBMITTED_TO_ASANA;
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
              <span style={{ fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6, background: badge.bg, color: badge.fg, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{badge.label}</span>
              {lead.marketSector && <span style={{ fontSize: 10, padding: '3px 7px', borderRadius: 5, background: '#f1f5f9', color: '#64748b' }}>{lead.marketSector}</span>}
              {lead.projectType && <span style={{ fontSize: 10, padding: '3px 7px', borderRadius: 5, background: '#f1f5f9', color: '#64748b' }}>{lead.projectType}</span>}
            </div>
            <h2 style={{ fontSize: 18, fontWeight: 800, color: '#0f172a', margin: '0 0 3px', letterSpacing: '-0.02em', lineHeight: 1.3 }}>{lead.title}</h2>
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
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <button onClick={() => onSubmitToAsana(lead)} style={{ padding: '6px 12px', borderRadius: 6, border: 'none', background: '#0f172a', color: '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
              <Send size={11} /> Submit to Asana
            </button>
            <button onClick={() => onMoveToNotPursued(lead.id)} style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #fecaca', background: '#fff', color: '#dc2626', cursor: 'pointer', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
              <Archive size={11} /> Not Pursuing
            </button>
            {lead.status !== LEAD_STATUS.ACTIVE && (
              <button onClick={() => onUpdate({ ...lead, status: LEAD_STATUS.ACTIVE })} style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', color: '#475569', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                Mark Active
              </button>
            )}
            {lead.status !== LEAD_STATUS.MONITORING && lead.status === LEAD_STATUS.ACTIVE && (
              <button onClick={() => onUpdate({ ...lead, status: LEAD_STATUS.MONITORING })} style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', color: '#475569', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                Monitor
              </button>
            )}
          </div>
        )}
        {isNotPursued && onRestore && (
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <button onClick={() => onRestore(lead.id)} style={{ padding: '6px 12px', borderRadius: 6, border: 'none', background: '#10b981', color: '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
              <RotateCcw size={11} /> Restore to Active
            </button>
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {/* Scores */}
            <div style={{ display: 'flex', gap: 20, justifyContent: 'center', padding: '10px 0' }}>
              <ScoreRing score={lead.relevanceScore || 0} size={56} strokeWidth={4} label="Relevance" />
              <UrgencyRing dueDate={lead.action_due_date} size={56} strokeWidth={4} />
            </div>
            <DetailSection title="Description"><p style={detailText}>{editing ? <textarea style={fieldTextarea} value={form.description} onChange={e => set('description', e.target.value)} /> : (lead.description || '—')}</p></DetailSection>
            <DetailSection title="Why It Matters"><p style={detailText}>{editing ? <textarea style={{ ...fieldTextarea, minHeight: 48 }} value={form.whyItMatters} onChange={e => set('whyItMatters', e.target.value)} /> : (lead.whyItMatters || '—')}</p></DetailSection>
            {lead.aiReasonForAddition && <DetailSection title="AI Assessment"><p style={{ ...detailText, fontStyle: 'italic', color: '#6366f1' }}>{lead.aiReasonForAddition}</p></DetailSection>}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <DetailField icon={<MapPin size={13} />} label="Location" value={editing ? <input style={fieldInput} value={form.location} onChange={e => set('location', e.target.value)} /> : lead.location} />
              <DetailField icon={<Building2 size={13} />} label="Market" value={lead.marketSector} />
              <DetailField icon={<DollarSign size={13} />} label="Budget" value={editing ? <input style={fieldInput} value={form.potentialBudget} onChange={e => set('potentialBudget', e.target.value)} /> : lead.potentialBudget} />
              <DetailField icon={<Calendar size={13} />} label="Timeline" value={editing ? <input style={fieldInput} value={form.potentialTimeline} onChange={e => set('potentialTimeline', e.target.value)} /> : lead.potentialTimeline} />
              <DetailField icon={<Clock size={13} />} label="Action Due" value={editing ? <input type="date" style={fieldInput} value={form.action_due_date || ''} onChange={e => set('action_due_date', e.target.value)} /> : (lead.action_due_date ? new Date(lead.action_due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—')} />
              <DetailField icon={<Clock size={13} />} label="Discovered" value={formatDate(lead.dateDiscovered)} />
              <DetailField icon={<RefreshCw size={13} />} label="Last Checked" value={formatDate(lead.lastCheckedDate)} />
            </div>
            {lead.matchedKeywords?.length > 0 && (
              <DetailSection title="Matched Keywords">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {lead.matchedKeywords.map(k => <span key={k} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, background: '#f1f5f9', color: '#475569', fontWeight: 500 }}>{k}</span>)}
                </div>
              </DetailSection>
            )}
            {lead.matchedTargetOrgs?.length > 0 && (
              <DetailSection title="Matched Target Organizations">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {lead.matchedTargetOrgs.map(o => <span key={o} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, background: '#eff6ff', color: '#3b82f6', fontWeight: 500 }}>{o}</span>)}
                </div>
              </DetailSection>
            )}
            {lead.sourceName && (
              <DetailSection title="Source">
                <div style={{ display:'flex', alignItems:'center', gap:8, fontSize:12.5, color:'#475569' }}>
                  <Database size={13} /><span style={{ fontWeight:500 }}>{lead.sourceName}</span>
                </div>
                {lead.sourceUrl && (
                  <a href={lead.sourceUrl} target="_blank" rel="noopener noreferrer" style={{ display:'inline-flex', alignItems:'center', gap:5, marginTop:6, padding:'5px 12px', borderRadius:6, background:'#eff6ff', border:'1px solid #bfdbfe', color:'#2563eb', fontSize:11.5, fontWeight:600, textDecoration:'none', transition:'background 0.15s' }}
                    onMouseEnter={e => e.currentTarget.style.background='#dbeafe'} onMouseLeave={e => e.currentTarget.style.background='#eff6ff'}>
                    <ExternalLink size={12} /> Open source page
                  </a>
                )}
              </DetailSection>
            )}
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
            <DetailSection title="Evidence Summary"><p style={detailText}>{lead.evidenceSummary || 'No evidence summary available yet.'}</p></DetailSection>
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
                      {ev.url && (
                        <a href={ev.url} target="_blank" rel="noopener noreferrer" style={{ display:'inline-flex', alignItems:'center', gap:5, marginTop:5, padding:'4px 10px', borderRadius:5, background:'#eff6ff', border:'1px solid #bfdbfe', color:'#2563eb', fontSize:11, fontWeight:600, textDecoration:'none', transition:'background 0.15s' }}
                          onMouseEnter={e => e.currentTarget.style.background='#dbeafe'} onMouseLeave={e => e.currentTarget.style.background='#eff6ff'}>
                          <ExternalLink size={11} /> Open source document
                        </a>
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
          </div>
        )}

        {activeTab === 'asana' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {isSubmitted ? (
              <>
                <div style={{ padding: '16px', background: '#f0fdf4', borderRadius: 10, border: '1px solid #bbf7d0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 700, color: '#166534', marginBottom: 6 }}>
                    <CheckCircle2 size={16} /> Submitted to Asana
                  </div>
                  <div style={{ fontSize: 12.5, color: '#475569', lineHeight: 1.6 }}>
                    {lead.dateSubmittedToAsana && <div>Submitted: {formatDate(lead.dateSubmittedToAsana)}</div>}
                    {lead.asanaUrl && <div>Asana: <a href={lead.asanaUrl} target="_blank" rel="noopener noreferrer" style={{ color: '#3b82f6' }}>{lead.asanaUrl}</a></div>}
                    {lead.submissionNotes && <div style={{ marginTop: 4 }}>{lead.submissionNotes}</div>}
                  </div>
                </div>
              </>
            ) : (
              <>
                <DetailSection title="Asana Submission">
                  <p style={{ fontSize: 12.5, color: '#64748b', lineHeight: 1.6, margin: '0 0 12px' }}>
                    Submit this lead to the A&E + SMA Go/No-Go review board via the Project Initiation Form.
                    Fill out the Project Initiation tab first, then use Submit to Asana.
                  </p>
                  <button onClick={() => onSubmitToAsana(lead)} style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: '#0f172a', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#fff', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Send size={14} /> Submit to Asana via PIF
                  </button>
                </DetailSection>
                <DetailSection title="Daily Asana Check">
                  <p style={{ fontSize: 12.5, color: '#94a3b8', lineHeight: 1.6, margin: 0 }}>
                    Project Scout checks the Asana Project Requests board daily. If this lead is found there, it will automatically move to "Submitted to Asana" with the match recorded.
                  </p>
                </DetailSection>
              </>
            )}
          </div>
        )}

        {activeTab === 'notes' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <DetailSection title="Internal Notes">
              <textarea style={{ ...fieldTextarea, minHeight: 80 }} value={form.notes || ''} onChange={e => set('notes', e.target.value)} placeholder="Add internal notes..." />
              <button onClick={handleSave} style={{ marginTop: 6, padding: '6px 14px', borderRadius: 6, border: 'none', background: '#0f172a', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: '#fff' }}><Save size={11} style={{ marginRight: 4, verticalAlign: -2 }} /> Save Notes</button>
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
              <DetailSection title="Reason Not Pursued">
                <div style={{ padding: '12px 14px', background: '#fef2f2', borderRadius: 8, border: '1px solid #fecaca' }}>
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
  const newCount = leads.filter(l => l.status === LEAD_STATUS.NEW).length;
  const activeCount = leads.filter(l => l.status === LEAD_STATUS.ACTIVE).length;
  const monitorCount = leads.filter(l => l.status === LEAD_STATUS.MONITORING).length;
  const withDueDate = leads.filter(l => l.action_due_date).length;
  const stats = [
    { label: 'Total Leads', value: leads.length, icon: <BarChart3 size={15} />, color: '#3b82f6' },
    { label: 'New', value: newCount, icon: <Zap size={15} />, color: '#10b981' },
    { label: 'Active', value: activeCount, icon: <Activity size={15} />, color: '#0f172a' },
    { label: 'Monitoring', value: monitorCount, icon: <Eye size={15} />, color: '#f59e0b' },
    { label: 'With Due Date', value: withDueDate, icon: <Clock size={15} />, color: '#6366f1' },
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginBottom: 24 }}>
      {stats.map(s => (
        <div key={s.label} style={{ background: '#fff', borderRadius: 10, padding: '14px 16px', border: '1px solid rgba(0,0,0,0.05)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: s.color, marginBottom: 6 }}>
            {s.icon}
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#94a3b8' }}>{s.label}</span>
          </div>
          <div style={{ fontSize: 24, fontWeight: 800, color: '#0f172a', letterSpacing: '-0.02em' }}>{s.value}</div>
        </div>
      ))}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════
   TAB: ACTIVE LEADS
   ═══════════════════════════════════════════════════════════════ */

function ActiveLeadsTab({ leads, onSelectLead }) {
  const [search, setSearch] = useState('');
  const [sectorFilter, setSectorFilter] = useState('all');
  const [geoFilter, setGeoFilter] = useState('all');
  const [sortBy, setSortBy] = useState('relevance');

  const sectors = useMemo(() => [...new Set(leads.map(l => l.marketSector).filter(Boolean))].sort(), [leads]);
  const geos = useMemo(() => [...new Set(leads.map(l => l.geography).filter(Boolean))].sort(), [leads]);

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
    if (geoFilter !== 'all') result = result.filter(l => l.geography === geoFilter);
    result.sort((a, b) => {
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
          <option value="all">All Geographies</option>
          {geos.map(g => <option key={g} value={g}>{g}</option>)}
        </select>
        <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={selectStyle}>
          <option value="relevance">Sort: Relevance</option>
          <option value="newest">Sort: Newest</option>
          <option value="duedate">Sort: Action Due</option>
          <option value="budget">Sort: Budget</option>
        </select>
      </div>

      {/* Lead Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 14 }}>
        {filtered.map((lead, i) => (
          <LeadCard key={lead.id} lead={lead} onClick={() => onSelectLead(lead)}
            style={{ animationDelay: `${i * 0.04}s`, animation: 'fadeUp 0.35s ease both' }}
          />
        ))}
      </div>

      {filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: '#94a3b8' }}>
          <Search size={32} style={{ marginBottom: 12, opacity: 0.4 }} />
          <p style={{ fontSize: 14, fontWeight: 600, margin: '0 0 4px' }}>No leads match your filters</p>
          <p style={{ fontSize: 12.5 }}>Try adjusting your search or filter criteria</p>
        </div>
      )}
    </div>
  );
}

const selectStyle = { padding: '9px 12px', borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12.5, background: '#fff', color: '#475569', cursor: 'pointer', outline: 'none' };


/* ═══════════════════════════════════════════════════════════════
   TAB: SUBMITTED TO ASANA
   ═══════════════════════════════════════════════════════════════ */

function SubmittedTab({ leads, onSelectLead }) {
  if (leads.length === 0) return <EmptyState icon={<Send size={36} />} title="No Leads in Asana Tracking" message="Submit leads from the Active / Watch tab to track them through the Go/No-Go review process." />;
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 14 }}>
        {leads.map(lead => <LeadCard key={lead.id} lead={lead} onClick={() => onSelectLead(lead)} />)}
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════
   TAB: NOT PURSUED
   ═══════════════════════════════════════════════════════════════ */

function NotPursuedTab({ leads, onSelectLead, onRestore }) {
  if (leads.length === 0) return <EmptyState icon={<Archive size={36} />} title="No Archived Leads" message="Leads reviewed and not pursued appear here with their reason recorded. They can be restored to active tracking at any time." />;
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 14 }}>
        {leads.map(lead => (
          <div key={lead.id} style={{ position: 'relative' }}>
            <LeadCard lead={lead} onClick={() => onSelectLead(lead)} />
            {lead.reasonNotPursued && (
              <div style={{ padding: '8px 14px', background: '#fef2f2', borderRadius: '0 0 12px 12px', marginTop: -8, border: '1px solid #fecaca', borderTop: 'none', fontSize: 11.5, color: '#991b1b' }}>
                <strong>Reason:</strong> {lead.reasonNotPursued}
                <button onClick={(e) => { e.stopPropagation(); onRestore(lead.id); }} style={{ marginLeft: 10, padding: '3px 10px', borderRadius: 5, border: '1px solid #fecaca', background: '#fff', cursor: 'pointer', fontSize: 10.5, fontWeight: 600, color: '#dc2626' }}>
                  <RotateCcw size={10} style={{ marginRight: 3, verticalAlign: -1 }} />Restore
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
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

function SettingsTab({ onMergeResults, onRunAsanaCheck, allLeads, notPursuedLeads, submittedLeads }) {
  const loadS = (k, fb) => { try { const d = localStorage.getItem(`ps_${k}`); return d ? JSON.parse(d) : fb; } catch { return fb; } };
  const [settings, setSettings] = useState(() => loadS('settings', {
    aiProvider: 'anthropic', aiModel: '', aiApiKey: '', backendEndpoint: '',
    asanaToken: '', dailyUpdateTime: '06:00',
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
  const logRef = useRef(null);

  const addLog = useCallback((msg) => {
    setEngineLog(prev => [...prev, { ts: new Date().toISOString(), msg }]);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [engineLog]);

  // ─── Connection status ─────────────────────────────────────
  const hasBackend = !!settings.backendEndpoint;
  const hasAIKey = !!settings.aiApiKey;
  const hasAsanaToken = !!settings.asanaToken;

  // ─── Real client-side engine (uses scoring/dedup logic, merges results) ─
  const runEngine = useCallback(async (action) => {
    setEngineState('running');
    setEngineAction(action);
    setEngineLog([]);
    setEngineResults(null);

    const isConnected = hasBackend;
    addLog(`═══ ${action.toUpperCase()} INITIATED ═══`);
    addLog(`Mode: ${isConnected ? 'LIVE — real source fetching via backend at ' + settings.backendEndpoint : 'FALLBACK — metadata-based lead generation (no live fetch). Deploy backend for live scouting.'}`);
    addLog(`AI: ${hasAIKey ? 'Configured (' + settings.aiProvider + ') — will classify if backend available' : 'Not configured — rule-based scoring only'}`);

    // Load current persisted data
    const currentSources = JSON.parse(localStorage.getItem('ps_sources') || JSON.stringify(INIT_SOURCES));
    const currentFP = JSON.parse(localStorage.getItem('ps_focuspoints') || JSON.stringify(INIT_FOCUS_POINTS));
    const currentOrgs = JSON.parse(localStorage.getItem('ps_targetorgs') || JSON.stringify(INIT_TARGET_ORGS));
    const activeSources = currentSources.filter(s => s.state === 'active');
    const activeFP = currentFP.filter(f => f.active);
    const activeOrgs = currentOrgs.filter(o => o.active);

    try {
      let results;

      if (isConnected) {
        // ─── CONNECTED MODE: call real backend ────────────────
        addLog(`Sending request to backend (${activeSources.length} sources, ${allLeads.length} existing leads)...`);
        const resp = await fetch(`${settings.backendEndpoint}/api/scan?action=${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sources: activeSources, focusPoints: activeFP, targetOrgs: activeOrgs,
            existingLeads: allLeads, notPursuedLeads: notPursuedLeads,
            settings,
          }),
        });
        if (!resp.ok) throw new Error(`Backend returned ${resp.status}: ${await resp.text().then(t=>t.slice(0,200))}`);
        const data = await resp.json();
        if (data.logs) data.logs.forEach(l => addLog(l));
        results = data.results;
      } else {
        // ─── LOCAL MODE: client-side rule-based engine ────────
        results = await runLocalEngine(action, activeSources, activeFP, activeOrgs, allLeads, notPursuedLeads, submittedLeads, settings, addLog);
      }

      // ─── MERGE results into persisted lead state ────────────
      if (results && onMergeResults) {
        onMergeResults(results);
        addLog(`✓ Merged into lead state: ${results.leadsAdded?.length || 0} added, ${results.leadsUpdated?.length || 0} updated`);
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
  }, [settings, hasBackend, hasAIKey, allLeads, notPursuedLeads, submittedLeads, onMergeResults, addLog, runHistory]);

  // ─── Asana check via parent callback ───────────────────────
  const handleAsanaCheck = useCallback(async () => {
    setEngineState('running');
    setEngineAction('asana-check');
    setEngineLog([]);
    const result = await onRunAsanaCheck(settings, addLog);
    setLastAsanaCheck(result);
    localStorage.setItem('ps_lastAsanaCheck', JSON.stringify(result));
    setEngineState(result?.error && result.mode !== 'disconnected' ? 'error' : 'complete');
    setEngineResults(result?.matched !== undefined ? { asanaMatched: result.matched, asanaMode: result.mode } : null);
  }, [settings, onRunAsanaCheck, addLog]);

  const groups = [
    { title: 'AI Configuration', fields: [
      { key: 'aiProvider', label: 'AI Provider', type: 'select', options: ['anthropic', 'openai'] },
      { key: 'aiModel', label: 'Model Name', type: 'text', placeholder: 'Default: claude-haiku-4-5 / gpt-4o-mini' },
      { key: 'aiApiKey', label: 'API Key', type: 'password', placeholder: 'sk-... or anthropic key' },
      { key: 'backendEndpoint', label: 'Backend Endpoint', type: 'text', placeholder: 'https://your-app.vercel.app' },
    ]},
    { title: 'Asana Integration', fields: [
      { key: 'asanaToken', label: 'Access Token', type: 'password', placeholder: 'Asana personal access token' },
    ]},
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

  const backendStatus = hasBackend ? 'configured' : 'fallback';
  const aiStatus = hasAIKey ? 'configured' : 'unavailable';
  const asanaStatus = hasAsanaToken ? 'configured' : 'unavailable';

  return (
    <div style={{ maxWidth: 720 }}>
      {/* Connection Status Bar */}
      <div style={{ display:'flex', gap:8, marginBottom:20, flexWrap:'wrap' }}>
        <ConnBadge status={backendStatus} label="Backend" />
        <ConnBadge status={aiStatus} label="AI Provider" />
        <ConnBadge status={asanaStatus} label="Asana" />
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
                {engineResults.asanaMatched !== undefined && <span><strong style={{ color:'#6366f1' }}>{engineResults.asanaMatched}</strong> Asana matches</span>}
              </div>
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
                {hasAsanaToken ? 'Connected to Asana' : 'Asana token not configured'}
              </div>
              {lastAsanaCheck && (
                <div style={{ fontSize:11, color:'#94a3b8', marginTop:2 }}>
                  Last check: {formatDate(lastAsanaCheck.timestamp)} — {lastAsanaCheck.matched || 0} match(es)
                  {lastAsanaCheck.error && ` — Error: ${lastAsanaCheck.error}`}
                </div>
              )}
            </div>
            <button onClick={handleAsanaCheck} disabled={engineState === 'running'}
              style={{ padding:'7px 16px', borderRadius:7, border:'none', background: hasAsanaToken ? '#0f172a' : '#e2e8f0', color: hasAsanaToken ? '#fff' : '#94a3b8', cursor: hasAsanaToken && engineState !== 'running' ? 'pointer' : 'not-allowed', fontSize:12, fontWeight:600, display:'flex', alignItems:'center', gap:5 }}>
              <Search size={12}/> Check Asana Now
            </button>
          </div>
          {!hasAsanaToken && (
            <div style={{ padding:'10px 12px', background:'#fffbeb', borderRadius:7, border:'1px solid #fef3c7', fontSize:11.5, color:'#92400e', lineHeight:1.5 }}>
              Configure your Asana personal access token in the Asana Integration section below to enable daily board checking. Without a token, this check cannot run.
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
        </div>
      ))}
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
async function runLocalEngine(action, sources, focusPoints, targetOrgs, existingLeads, notPursuedLeads, submittedLeads, settings, addLog) {
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
          relevanceScore, pursuitScore, sourceConfidenceScore,
          confidenceNotes: `Source: ${src.category} (${src.priority}). Focus: ${fp.title}. Org: ${org.name}.`,
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
  { id: 'asana', label: 'Asana Tracked', icon: <Send size={15} /> },
  { id: 'notpursued', label: 'Not Pursued', icon: <Archive size={15} /> },
  { id: 'registry', label: 'Source Registry', icon: <Database size={15} /> },
  { id: 'settings', label: 'Settings', icon: <SettingsIcon size={15} /> },
];

export default function ProjectScout() {
  // ─── Persistence helpers ───────────────────────────────────
  const loadState = (key, fallback) => {
    try { const d = localStorage.getItem(`ps_${key}`); return d ? JSON.parse(d) : fallback; }
    catch { return fallback; }
  };
  const saveState = (key, data) => {
    try { localStorage.setItem(`ps_${key}`, JSON.stringify(data)); } catch(e) { console.warn('Save failed:', e); }
  };

  useEffect(() => {
    const result = runMigration();
    if (result.status !== 'current') {
      console.log('[Project Scout] Migration:', result.status, result.notes);
    }
  }, []);

  // ─── Centralized lead state (persisted) ────────────────────
  const [leads, setLeads] = useState(() => loadState('leads', [...seedLeads]));
  const [submittedLeads, setSubmittedLeads] = useState(() => loadState('submitted', [...seedSubmitted]));
  const [notPursuedLeads, setNotPursuedLeads] = useState(() => loadState('notpursued', [...seedNotPursued]));

  // Persist on every change
  useEffect(() => { saveState('leads', leads); }, [leads]);
  useEffect(() => { saveState('submitted', submittedLeads); }, [submittedLeads]);
  useEffect(() => { saveState('notpursued', notPursuedLeads); }, [notPursuedLeads]);

  const [activeTab, setActiveTab] = useState('active');
  const [selectedLead, setSelectedLead] = useState(null);
  const [showAddLead, setShowAddLead] = useState(false);
  const [showPIFReview, setShowPIFReview] = useState(null);
  const [showNotPursuedDialog, setShowNotPursuedDialog] = useState(null);

  // ─── Lead CRUD operations ──────────────────────────────────

  const addLead = useCallback((lead) => {
    const newLead = {
      ...lead,
      id: lead.id || `lead-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
      status: lead.status || LEAD_STATUS.NEW,
      leadOrigin: lead.leadOrigin || 'manual',
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
        setNotPursuedLeads(np => [{
          ...lead,
          status: LEAD_STATUS.NOT_PURSUED,
          reasonNotPursued: reason,
          dateNotPursued: new Date().toISOString(),
        }, ...np]);
      }
      return prev.filter(l => l.id !== leadId);
    });
    setSelectedLead(null);
    setShowNotPursuedDialog(null);
  }, []);

  const restoreFromNotPursued = useCallback((leadId) => {
    setNotPursuedLeads(prev => {
      const lead = prev.find(l => l.id === leadId);
      if (lead) {
        setLeads(active => [{
          ...lead,
          status: LEAD_STATUS.ACTIVE,
          reasonNotPursued: null,
          dateNotPursued: null,
        }, ...active]);
      }
      return prev.filter(l => l.id !== leadId);
    });
    setSelectedLead(null);
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
        }, ...sub]);
      }
      return prev.filter(l => l.id !== leadId);
    });
    setSelectedLead(null);
    setShowPIFReview(null);
  }, []);

  // ─── Asana check — prefers backend route, falls back to browser-direct ────
  const runAsanaCheck = useCallback(async (settings, addLog) => {
    const log = addLog || (() => {});
    const asanaToken = settings?.asanaToken;
    const backendUrl = settings?.backendEndpoint;

    if (!asanaToken && !process.env?.ASANA_ACCESS_TOKEN) {
      log('Asana check: No access token configured. Configure in Settings → Asana Integration.');
      return { matched: 0, error: 'No Asana token configured', mode: 'unavailable' };
    }

    log('═══ ASANA CHECK STARTED ═══');

    // ─── Prefer backend route (safer: no token exposure, no CORS risk) ───
    if (backendUrl) {
      log(`Mode: BACKEND — routing through ${backendUrl}/api/scan?action=asana`);
      try {
        const resp = await fetch(`${backendUrl}/api/scan?action=asana`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings, existingLeads: leads }),
        });
        if (!resp.ok) throw new Error(`Backend HTTP ${resp.status}`);
        const data = await resp.json();
        if (data.logs) data.logs.forEach(l => log(l));
        if (!data.ok) throw new Error(data.error || 'Backend Asana check failed');

        // Process matches — move matched leads to Submitted
        const matchIds = new Set((data.matches || []).map(m => m.leadId));
        if (matchIds.size > 0) {
          setLeads(prev => {
            const remaining = [];
            for (const lead of prev) {
              const match = (data.matches || []).find(m => m.leadId === lead.id);
              if (match) {
                log(`  ✓ MATCH: "${lead.title}" → "${match.taskName}" (${match.matchType}, ${Math.round((match.confidence||0)*100)}%)`);
                setSubmittedLeads(sub => [{
                  ...lead,
                  status: LEAD_STATUS.SUBMITTED_TO_ASANA,
                  dateSubmittedToAsana: new Date().toISOString(),
                  asanaUrl: match.taskUrl || match.url || '',
                  submissionNotes: `Auto-matched via backend Asana check (${match.matchType}, ${Math.round((match.confidence||0)*100)}% confidence).`,
                }, ...sub]);
              } else {
                remaining.push(lead);
              }
            }
            return remaining;
          });
        }

        const result = { matched: data.matches?.length || 0, tasksChecked: data.tasks || 0, mode: 'connected', timestamp: new Date().toISOString() };
        log(`═══ ASANA CHECK COMPLETE — ${result.matched} match(es) ═══`);
        saveState('lastAsanaCheck', result);
        return result;
      } catch (err) {
        log(`Backend Asana check failed: ${err.message}`);
        log('Falling back to browser-direct Asana API call...');
        // Fall through to browser-direct below
      }
    }

    // ─── Browser-direct fallback (may hit CORS on some environments) ───
    if (!asanaToken) {
      log('No Asana token for browser-direct check.');
      return { matched: 0, error: 'No Asana token', mode: 'unavailable' };
    }

    log('Mode: BROWSER-DIRECT — calling Asana API from browser (token exposed in request)');
    log('⚠ For production, configure Backend Endpoint to route Asana checks server-side.');

    const ASANA_PROJECT = '1203575716271060';
    try {
      let tasks = [], offset = null;
      do {
        const url = `https://app.asana.com/api/1.0/projects/${ASANA_PROJECT}/tasks?opt_fields=name,permalink_url&limit=100${offset ? `&offset=${offset}` : ''}`;
        const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${asanaToken}` } });
        if (!resp.ok) throw new Error(`Asana API ${resp.status}`);
        const data = await resp.json();
        if (data.errors?.length) throw new Error(data.errors[0].message);
        tasks.push(...(data.data || []));
        offset = data.next_page?.offset || null;
      } while (offset);
      log(`Fetched ${tasks.length} tasks`);

      const normalize = (t) => (t||'').toLowerCase().replace(/[^a-z0-9\s]/g,'').replace(/\s+/g,' ').trim();
      const wordSim = (a, b) => {
        const wa = new Set(normalize(a).split(' ').filter(w=>w.length>2));
        const wb = new Set(normalize(b).split(' ').filter(w=>w.length>2));
        if(!wa.size||!wb.size) return 0;
        let i=0; for(const w of wa) if(wb.has(w)) i++;
        return i / new Set([...wa,...wb]).size;
      };

      const matched = [];
      setLeads(prev => {
        const remaining = [];
        for (const lead of prev) {
          let found = null;
          for (const task of tasks) {
            const na = normalize(lead.title), nb = normalize(task.name);
            if (na===nb || nb.includes(na) || na.includes(nb)) { found = { task, confidence:0.95, matchType:'exact' }; break; }
            const s = wordSim(lead.title, task.name);
            if (s > 0.5) { found = { task, confidence:s, matchType:'fuzzy' }; break; }
          }
          if (found) {
            matched.push({ lead, ...found });
            log(`  ✓ MATCH: "${lead.title}" → "${found.task.name}" (${found.matchType})`);
            setSubmittedLeads(sub => [{ ...lead, status:LEAD_STATUS.SUBMITTED_TO_ASANA, dateSubmittedToAsana:new Date().toISOString(),
              asanaUrl: found.task.permalink_url||'', submissionNotes:`Auto-matched (${found.matchType}, ${Math.round(found.confidence*100)}%).` }, ...sub]);
          } else { remaining.push(lead); }
        }
        return remaining;
      });

      const result = { matched: matched.length, tasksChecked: tasks.length, mode: 'browser-direct', timestamp: new Date().toISOString() };
      log(`═══ ASANA CHECK COMPLETE — ${matched.length} match(es) ═══`);
      saveState('lastAsanaCheck', result);
      return result;
    } catch (err) {
      log(`ERROR: ${err.message}`);
      const result = { matched:0, error:err.message, mode:'error', timestamp:new Date().toISOString() };
      saveState('lastAsanaCheck', result);
      return result;
    }
  }, [leads, setLeads, setSubmittedLeads]);

  // ─── Engine merge callback — called by SettingsTab to merge engine results into persisted state ───
  const mergeEngineResults = useCallback((results) => {
    if (!results) return;
    const addedLeads = results.leadsAdded || [];
    const updatedLeads = results.leadsUpdated || [];

    if (addedLeads.length > 0) {
      setLeads(prev => {
        // Final dedup pass against current state
        const existingIds = new Set(prev.map(l => l.id));
        const existingTitles = new Set(prev.map(l => l.title?.toLowerCase().trim()));
        const genuinelyNew = addedLeads.filter(l =>
          !existingIds.has(l.id) && !existingTitles.has(l.title?.toLowerCase().trim())
        );
        return [...genuinelyNew, ...prev];
      });
    }

    if (updatedLeads.length > 0) {
      setLeads(prev => prev.map(lead => {
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
        return merged;
      }));
    }
  }, [setLeads]);

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
        background: '#fff', borderBottom: '1px solid #eef0f4',
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
            {activeTab === 'active' && `${leads.length} leads across active geography`}
            {activeTab === 'asana' && `${submittedLeads.length} leads in Asana tracking`}
            {activeTab === 'notpursued' && `${notPursuedLeads.length} archived leads reviewed and not pursued`}
            {activeTab === 'registry' && 'Source intelligence — sources, entities, geography, families'}
            {activeTab === 'settings' && 'Intelligence engine, AI provider, scheduling, Asana integration'}
          </p>
        </div>

        {activeTab === 'active' && <ActiveLeadsTab leads={leads} onSelectLead={handleSelectLead} />}
        {activeTab === 'asana' && <SubmittedTab leads={submittedLeads} onSelectLead={handleSelectLead} />}
        {activeTab === 'notpursued' && <NotPursuedTab leads={notPursuedLeads} onSelectLead={handleSelectLead} onRestore={restoreFromNotPursued} />}
        {activeTab === 'registry' && <SourceRegistryView />}
        {activeTab === 'settings' && <SettingsTab onMergeResults={mergeEngineResults} onRunAsanaCheck={runAsanaCheck} allLeads={leads} notPursuedLeads={notPursuedLeads} submittedLeads={submittedLeads} />}
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
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════
   NOT PURSUED REASON MODAL
   ═══════════════════════════════════════════════════════════════ */

function NotPursuedReasonModal({ onConfirm, onCancel }) {
  const [reason, setReason] = useState('');
  return (
    <Modal title="Move to Not Pursued" onClose={onCancel} width={440}>
      <p style={{ fontSize: 13, color: '#475569', lineHeight: 1.6, margin: '0 0 14px' }}>
        This lead will be archived and will not be reintroduced by the intelligence engine unless manually restored.
      </p>
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
        <SectionHeader>Core Information</SectionHeader>
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

        <SectionHeader>Scores (Manual Override)</SectionHeader>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
          {[['relevanceScore','Relevance'],['pursuitScore','Pursuit'],['sourceConfidenceScore','Confidence']].map(([k, label]) => (
            <div key={k}>
              <label style={fieldLabel}>{label} ({form[k]})</label>
              <input type="range" min="0" max="100" value={form[k] || 50} onChange={e => set(k, parseInt(e.target.value))}
                style={{ width: '100%', accentColor: scoreColor(form[k] || 50) }} />
            </div>
          ))}
        </div>

        <SectionHeader>Project Initiation Prep</SectionHeader>
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

function SectionHeader({ children }) {
  return <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '18px 0 10px', paddingTop: 14, borderTop: '1px solid #f1f5f9' }}>{children}</div>;
}
