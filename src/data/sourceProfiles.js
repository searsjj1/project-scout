/**
 * Source Profile Framework — Project Scout V4
 *
 * Each source has a profile that tells the engine how to read it,
 * what objects to extract, what to ignore, and which dashboard lane it feeds.
 *
 * Profile types: budget, agenda, procurement, redevelopment, media, employer, contractor, institutional
 */

// Default profile templates by type
export const PROFILE_TEMPLATES = {
  budget: {
    profile_type: 'budget',
    container_behavior: 'container',
    child_follow_rules: {
      follow_pdf: true,
      follow_html_children: true,
      follow_opengov_sections: true,
      max_child_fetches: 4,
      prefer_child_types: ['capital_document', 'document_pdf', 'project_detail'],
    },
    allowed_object_types: ['project', 'district', 'site', 'development_potential'],
    blocked_object_types: ['department', 'program', 'topic', 'organization'],
    dashboard_lane: 'active_leads',
    ignore_patterns: ['general fund', 'operating budget', 'personnel', 'staffing', 'payroll', 'insurance', 'benefits'],
    confidence_signals: {
      strong: ['rfq', 'rfp', 'capital improvement', 'design services', 'construction'],
      moderate: ['budget', 'funded', 'appropriated', 'capital', 'replacement', 'renovation'],
      weak: ['planning', 'study', 'assessment', 'feasibility'],
    },
  },
  agenda: {
    profile_type: 'agenda',
    container_behavior: 'container',
    child_follow_rules: {
      follow_pdf: true,
      follow_html_children: true,
      follow_opengov_sections: false,
      max_child_fetches: 4,
      prefer_child_types: ['meeting_document', 'document_pdf', 'board_packet'],
    },
    allowed_object_types: ['project', 'district', 'site', 'solicitation', 'news_item'],
    blocked_object_types: ['department', 'program', 'topic', 'organization'],
    dashboard_lane: 'active_leads',
    ignore_patterns: ['consent agenda', 'roll call', 'pledge of allegiance', 'approval of minutes', 'public comment period', 'adjournment'],
    confidence_signals: {
      strong: ['consultant selection', 'design contract', 'construction contract', 'rfq', 'rfp'],
      moderate: ['approval', 'resolution', 'authorization', 'appropriation'],
      weak: ['discussion', 'update', 'presentation', 'report'],
    },
  },
  procurement: {
    profile_type: 'procurement',
    container_behavior: 'container',
    child_follow_rules: {
      follow_pdf: true,
      follow_html_children: true,
      follow_opengov_sections: false,
      max_child_fetches: 6,
      prefer_child_types: ['solicitation_detail', 'document_pdf', 'project_detail'],
    },
    allowed_object_types: ['solicitation', 'project'],
    blocked_object_types: ['department', 'program', 'topic', 'organization'],
    dashboard_lane: 'active_leads',
    ignore_patterns: ['fuel bid', 'chip seal', 'mowing', 'snow removal', 'janitorial', 'custodial', 'uniform', 'vehicle purchase'],
    confidence_signals: {
      strong: ['rfq', 'rfp', 'soq', 'invitation to bid', 'design services', 'architectural', 'engineering services'],
      moderate: ['bid', 'solicitation', 'construction'],
      weak: ['maintenance', 'repair', 'service contract'],
    },
  },
  redevelopment: {
    profile_type: 'redevelopment',
    container_behavior: 'hybrid',
    child_follow_rules: {
      follow_pdf: true,
      follow_html_children: true,
      follow_opengov_sections: false,
      max_child_fetches: 4,
      prefer_child_types: ['project_detail', 'document_pdf', 'meeting_document'],
    },
    allowed_object_types: ['district', 'site', 'development_potential', 'project'],
    blocked_object_types: ['department', 'topic', 'organization'],
    dashboard_lane: 'development_potentials',
    ignore_patterns: ['general policy', 'mission statement', 'about us', 'contact us'],
    confidence_signals: {
      strong: ['tif', 'tedd', 'urd', 'urban renewal', 'redevelopment', 'developer selected'],
      moderate: ['development agreement', 'site plan', 'master plan', 'rezoning'],
      weak: ['study', 'assessment', 'planning'],
    },
  },
  media: {
    profile_type: 'media',
    container_behavior: 'direct',
    child_follow_rules: {
      follow_pdf: false,
      follow_html_children: false,
      follow_opengov_sections: false,
      max_child_fetches: 0,
    },
    allowed_object_types: ['news_item'],
    blocked_object_types: ['department', 'program', 'topic'],
    dashboard_lane: 'news',
    ignore_patterns: ['sports', 'entertainment', 'obituary', 'opinion', 'letter to the editor', 'classified'],
    confidence_signals: {
      strong: ['construction', 'design', 'architect', 'engineering', 'building permit', 'groundbreaking'],
      moderate: ['development', 'planning', 'rezoning', 'expansion', 'renovation'],
      weak: ['proposed', 'considering', 'studying'],
    },
  },
  employer: {
    profile_type: 'employer',
    container_behavior: 'direct',
    child_follow_rules: {
      follow_pdf: false,
      follow_html_children: true,
      follow_opengov_sections: false,
      max_child_fetches: 2,
      prefer_child_types: ['project_detail'],
    },
    allowed_object_types: ['news_item', 'project', 'development_potential'],
    blocked_object_types: ['department', 'program', 'topic'],
    dashboard_lane: 'news',
    ignore_patterns: ['job posting', 'career', 'hiring', 'employment', 'benefits', 'hr'],
    confidence_signals: {
      strong: ['expansion', 'new facility', 'campus', 'construction', 'renovation'],
      moderate: ['growth', 'investment', 'headquarters', 'relocation'],
      weak: ['planning', 'considering', 'exploring'],
    },
  },
  contractor: {
    profile_type: 'contractor',
    container_behavior: 'direct',
    child_follow_rules: {
      follow_pdf: false,
      follow_html_children: true,
      follow_opengov_sections: false,
      max_child_fetches: 2,
      prefer_child_types: ['project_detail'],
    },
    allowed_object_types: ['news_item', 'project'],
    blocked_object_types: ['department', 'program', 'topic', 'organization'],
    dashboard_lane: 'news',
    ignore_patterns: ['job posting', 'career', 'hiring', 'about us', 'mission', 'values'],
    confidence_signals: {
      strong: ['awarded', 'under construction', 'completed', 'project'],
      moderate: ['construction', 'building', 'renovation'],
      weak: ['announcement', 'update'],
    },
  },
  institutional: {
    profile_type: 'institutional',
    container_behavior: 'hybrid',
    child_follow_rules: {
      follow_pdf: true,
      follow_html_children: true,
      follow_opengov_sections: false,
      max_child_fetches: 3,
      prefer_child_types: ['capital_document', 'project_detail', 'document_pdf'],
    },
    allowed_object_types: ['project', 'development_potential'],
    blocked_object_types: ['department', 'program', 'topic', 'organization'],
    dashboard_lane: 'active_leads',
    ignore_patterns: ['academic program', 'student services', 'admissions', 'tuition', 'course catalog'],
    confidence_signals: {
      strong: ['capital project', 'facility plan', 'campus plan', 'renovation', 'construction'],
      moderate: ['deferred maintenance', 'facility assessment', 'bond'],
      weak: ['planning', 'study', 'master plan'],
    },
  },
};

/**
 * Get the source profile for a given source.
 * Uses the source_profile field if set, otherwise infers from source_family/type.
 */
export function getSourceProfile(source) {
  // If source already has a profile, use it
  if (source.source_profile?.profile_type) {
    return { ...PROFILE_TEMPLATES[source.source_profile.profile_type], ...source.source_profile };
  }

  // Infer from source_family
  const family = source.source_family || '';
  const name = (source.source_name || '').toLowerCase();
  const url = (source.source_url || '').toLowerCase();

  if (/SF-01/.test(family) || /procurement|bid|rfq|rfp/i.test(name)) return PROFILE_TEMPLATES.procurement;
  if (/SF-02/.test(family) || /agenda|meeting|minutes|commission/i.test(name)) return PROFILE_TEMPLATES.agenda;
  if (/SF-08/.test(family) || /budget|cip|capital|opengov/i.test(name) || /opengov\.com/.test(url)) return PROFILE_TEMPLATES.budget;
  if (/SF-09/.test(family) || /redevelopment|mra|urban renewal|development (authority|partnership)/i.test(name)) return PROFILE_TEMPLATES.redevelopment;
  if (/SF-07/.test(family) || /facilit|campus|university|college|school/i.test(name)) return PROFILE_TEMPLATES.institutional;
  if (/news|missoulian|current|kpax|media/i.test(name) || /missoulian\.com|missoulacurrent|kpax/i.test(url)) return PROFILE_TEMPLATES.media;
  if (/contractor|construction|dac|quality|jackson|martel|langlas/i.test(name)) return PROFILE_TEMPLATES.contractor;
  if (/employer|hospital|bank|providence|community medical/i.test(name)) return PROFILE_TEMPLATES.employer;

  // Default to institutional
  return PROFILE_TEMPLATES.institutional;
}

/**
 * Check if a lead object type is allowed by a source profile.
 */
export function isObjectTypeAllowed(profile, objectType) {
  if (!profile || !objectType) return true; // permissive fallback
  if (profile.blocked_object_types?.includes(objectType)) return false;
  if (profile.allowed_object_types?.length > 0) return profile.allowed_object_types.includes(objectType);
  return true;
}

/**
 * Check if text matches any ignore pattern for a source profile.
 */
export function matchesIgnorePattern(profile, text) {
  if (!profile?.ignore_patterns?.length || !text) return false;
  const lo = text.toLowerCase();
  return profile.ignore_patterns.some(pat => lo.includes(pat));
}
