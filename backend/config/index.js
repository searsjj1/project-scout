/**
 * Backend Configuration
 * Environment variables and defaults for serverless deployment
 */

export const config = {
  // AI Provider
  AI_PROVIDER: process.env.AI_PROVIDER || 'anthropic',
  AI_MODEL: process.env.AI_MODEL || '',
  AI_API_KEY: process.env.AI_API_KEY || '',

  // Asana
  ASANA_ACCESS_TOKEN: process.env.ASANA_ACCESS_TOKEN || '',
  ASANA_PROJECT_ID: process.env.ASANA_PROJECT_ID || '1203575716271060',
  ASANA_WORKSPACE_ID: process.env.ASANA_WORKSPACE_ID || '869158886664904',

  // PIF Form
  PIF_FORM_URL: 'https://form.asana.com/?k=IUr_D0wx9ZOZGXfSY9okag&d=869158886664904',
  BUSINESS_PURSUITS_FORM_URL: 'https://form.asana.com/?k=8KcAztND7v5EofPYzzmbiQ&d=869158886664904',

  // Scheduling
  DAILY_UPDATE_TIME: process.env.DAILY_UPDATE_TIME || '06:00',
  BACKFILL_MONTHS: parseInt(process.env.BACKFILL_MONTHS || '6'),
  NEW_LEAD_FRESHNESS_DAYS: parseInt(process.env.NEW_LEAD_FRESHNESS_DAYS || '60'),
  ACTIVE_LEAD_RECHECK_DAYS: parseInt(process.env.ACTIVE_LEAD_RECHECK_DAYS || '7'),

  // Cache
  CACHE_TTL_MINUTES: parseInt(process.env.CACHE_TTL_MINUTES || '60'),
};
