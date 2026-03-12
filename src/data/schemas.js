/**
 * Project Scout — Phase 1 Schemas (canonical ps_ keys)
 */
export const SCHEMA_VERSION = 2;

export const KEYS = {
  SOURCE_FAMILIES:   'ps_source_families',
  COVERAGE_REGIONS:  'ps_coverage_regions',
  COUNTY_MAPPING:    'ps_county_mapping',
  ENTITIES:          'ps_entities',
  SOURCES:           'ps_sources',
  PROPOSED_SOURCES:  'ps_proposed_sources',
  PROPOSED_ENTITIES: 'ps_proposed_entities',
  LEADS:             'ps_leads',
  OWNER_PROJECTS:    'ps_owner_projects',
  INTAKE:            'ps_intake',
  SETTINGS:          'ps_settings',
  MIGRATION:         'ps_migration',
};

export const LEAD_STATES = ['preliminary','active','go_no_go_submitted','not_pursued'];
export const LEAD_CLASSES = ['standard','upcoming_budgeted_project'];
export const TIERS = ['Tier 1','Tier 2','Tier 3'];
export const CHECK_FREQUENCIES = ['Daily','3x/week','Weekly','Biweekly','Monthly','Quarterly'];
export const MONITORING_CADENCES = ['high_frequency','standard','monthly','quarterly'];
export const NOT_PURSUED_CATEGORIES = ['scope_too_small','wrong_market','wrong_geography','poor_fit','timeline_conflict','resource_conflict','low_fee','low_probability','not_our_services','other'];
export const SERVICE_LINES = ['architecture','interior_design','landscape_architecture','planning','pm_cpm'];
export const DISCIPLINES = ['architecture','civil','structural','mechanical','electrical','landscape','interior_design','programming','construction_management','environmental','geotechnical','survey'];

export function createEntity(o={}) {
  return { entity_id:`ENT-${Date.now()}`, entity_name:'', entity_type:'other', state:'', primary_area:'', coverage_regions:[], official_site:null, procurement_url:null, notes:'', active:true, date_added:new Date().toISOString().split('T')[0], added_by:'Manual', ...o };
}

export function createSource(o={}) {
  return { source_id:`SRC-${Date.now()}`, entity_id:'', source_family:'SF-01', active:true, priority_tier:'Tier 1', source_name:'', source_url:'', base_url:'', state:'', county:'', city:'', coverage_regions:[], source_type:'', owner_type:'', keywords_to_watch:[], board_or_department:'', check_frequency:'Daily', notes:'', date_added:new Date().toISOString().split('T')[0], added_by:'Manual', discovered_by_ai:false, approved_from_proposal:null, is_aggregator:false, aggregator_scope:null, aggregator_entity_ids:[], requires_javascript:false, requires_auth:false, content_format:'unknown', extraction_notes:null, last_checked:null, last_successful_fetch:null, last_content_hash:null, fetch_health:'untested', fetch_error_count:0, last_error:null, ...o };
}

export function createProposedSource(o={}) {
  return { proposed_id:`PROP-SRC-${Date.now()}`, entity_id:null, entity_name:'', proposed_url:'', detected_family:'SF-01', why_proposed:'', confidence:0.5, discovered_from:'human_suggestion', status:'pending', reviewer_notes:'', date_proposed:new Date().toISOString().split('T')[0], date_reviewed:null, approved_to_source_id:null, ...o };
}

export function createProposedEntity(o={}) {
  return { proposed_id:`PROP-ENT-${Date.now()}`, entity_name:'', entity_type:'other', state:'', primary_area:'', why_proposed:'', confidence:0.5, discovered_from:'human_suggestion', status:'pending', reviewer_notes:'', date_proposed:new Date().toISOString().split('T')[0], date_reviewed:null, approved_to_entity_id:null, ...o };
}

export function createLead(o={}) {
  return {
    lead_id:`LEAD-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    title:'', status:'preliminary', lead_class:'standard',
    owner_entity_name:'', owner_entity_id:null, project_name:'',
    location:'', county:'', state:'', coverage_regions:[], coverage_regions_override:null, office_assignment:null,
    market_sector:'', project_type:'', procurement_type:'', description:'', why_it_matters:'',
    ai_reason:'', recommended_next_action:'',
    relevance_score:0, pursuit_score:0, source_confidence:0, confidence_notes:'',
    service_alignment:[], disciplines_required:[],
    source_id:null, source_name:'', source_url:'', source_family:'', source_tier:'',
    dates:[], evidence:[], documents:[], matched_keywords:[],
    internal_contact:'', notes:'', origin:'manual',
    monitoring_cadence:'standard', date_discovered:null, original_signal_date:null, last_checked:null,
    // Asana
    asana_task_id:null, asana_url:null, asana_section:null, asana_submission_date:null,
    asana_submission_method:null, asana_presence_type:null,
    submitted_by:null, submission_channel:null,
    // Not Pursued
    reason_not_pursued:null, not_pursued_category:null, date_not_pursued:null, not_pursued_monitoring:true,
    // PIP
    pip_project_name:'', pip_owner:'', pip_location:'', pip_market_sector:'', pip_project_type:'',
    pip_delivery_method:'', pip_estimated_fee:'', pip_estimated_cost:'', pip_probability:'',
    pip_pic:'', pip_pm:'', pip_start_date:'', pip_description:'', pip_key_dates:'',
    // Competitor
    competitor_winner:'', competitor_source:'', competitor_confidence:'', competitor_notes:'',
    // Change log
    change_log:[],
    ...o,
  };
}

export function createOwnerProject(o={}) {
  return {
    project_id:`OPRJ-${Date.now()}`, owner_entity_id:null, owner_entity_name:'',
    project_title:'', location:'', county:'', state:'', market_sector:'', project_type:'', project_status:'',
    architect:null, engineers:null, landscape_architect:null, interior_designer:null, contractor:null,
    contract_value:null, construction_value:null, procurement_source:null, award_source:null,
    major_dates:null, construction_start:null, monitoring_until:null, last_updated:null,
    linked_lead_id:null, notes:'', ...o,
  };
}

export function createIntakeItem(o={}) {
  return {
    intake_id:`INT-${Date.now()}`, intake_type:'url', source_url:'', status:'pending',
    raw_content:'', extracted_entity_name:'', extracted_entity_id:null,
    proposed_lead_title:'', extracted_scope:'', extracted_owner:'',
    extracted_deadlines:[], extracted_project_type:'', extracted_market_sector:'',
    extraction_confidence:0, ai_reasoning:'',
    matched_source_id:null, proposed_source_needed:false,
    promoted_to_lead_id:null, proposed_source_id:null,
    notes:'', date_received:new Date().toISOString().split('T')[0], ...o,
  };
}
