# Source Profile Specification

## Purpose
Each source in Scout V4 has a **source profile** that tells the engine:
- What kind of source this is
- How to read it (container vs direct, child-following rules)
- What objects may survive from it
- What to ignore
- Which dashboard lane it feeds

## Source Profile Schema

```javascript
{
  // Identity
  source_id: 'MT-MIS-007',
  source_name: 'FY2026 Adopted Budget',

  // Profile classification
  source_profile: {
    // What kind of source is this?
    profile_type: 'budget',  // budget | agenda | procurement | redevelopment | media | employer | contractor | institutional

    // Is this a container (listing page) or a direct lead source?
    container_behavior: 'container',  // 'container' | 'direct' | 'hybrid'

    // What child artifacts should be followed?
    child_follow_rules: {
      follow_pdf: true,
      follow_html_children: true,
      follow_opengov_sections: false,
      max_child_fetches: 4,
      prefer_child_types: ['capital_document', 'solicitation_detail', 'project_detail'],
      ignore_child_types: ['meeting_document'],  // budget source doesn't need meeting docs
    },

    // What lead object types may survive from this source?
    allowed_object_types: ['project', 'district', 'site'],
    blocked_object_types: ['department', 'program', 'topic', 'organization'],

    // Which dashboard lane does this feed?
    dashboard_lane: 'active_leads',  // 'development_potentials' | 'news' | 'active_leads'

    // What to ignore from this source
    ignore_patterns: [
      'general fund',
      'operating budget',
      'personnel',
      'staffing',
    ],

    // Confidence signals that matter for this source type
    confidence_signals: {
      strong: ['rfq', 'rfp', 'capital improvement', 'design services'],
      moderate: ['budget', 'funded', 'appropriated', 'capital'],
      weak: ['planning', 'study', 'assessment'],
    },
  },
}
```

## Profile Types

### budget
- Container behavior: usually a container (links to CIP, department budgets, PDFs)
- Follow: CIP documents, capital project sections, budget PDFs
- Produces: projects, districts, capital items
- Ignore: general fund, operating, personnel, staffing lines
- Dashboard lane: active_leads or development_potentials

### agenda
- Container behavior: container (links to individual agenda items, packets, minutes)
- Follow: agenda detail pages, packet PDFs, minutes, staff reports
- Produces: projects, districts, consultant selections, board actions
- Ignore: routine admin, consent agenda boilerplate, proclamations
- Dashboard lane: active_leads (for actions) or news (for updates)

### procurement
- Container behavior: container (listing of solicitations)
- Follow: individual RFQ/RFP/BID/SOQ links, PDF documents
- Produces: solicitations
- Ignore: commodity bids, fuel, chip seal, equipment-only purchases
- Dashboard lane: active_leads

### redevelopment
- Container behavior: hybrid (some direct district info, some child project links)
- Follow: district detail pages, project pages, staff reports
- Produces: districts, sites, district subprojects
- Ignore: generic policy, boilerplate
- Dashboard lane: development_potentials

### media
- Container behavior: direct (each article is a potential lead/news item)
- Follow: article links matching development/construction/planning keywords
- Produces: news items
- Ignore: sports, entertainment, opinion, obituaries
- Dashboard lane: news

### employer / contractor
- Container behavior: direct (project pages, news pages)
- Follow: project portfolio, news/media pages
- Produces: news items, project intelligence
- Ignore: job postings, HR pages, generic about pages
- Dashboard lane: news or development_potentials

### institutional
- Container behavior: hybrid
- Follow: facilities pages, capital planning, campus plans
- Produces: projects, capital items
- Ignore: academic programs, student services, admin
- Dashboard lane: active_leads or development_potentials
