/**
 * Project Scout — Migration (canonical ps_ keys, direct overwrite)
 * Safe to call on every load. No-ops if already at SCHEMA_VERSION.
 */
import { KEYS, SCHEMA_VERSION } from './schemas.js';
import { storageGet, storageSet, storageDelete, getTable, setTable } from './storage.js';
import {
  SEED_VERSION, SEED_SOURCE_FAMILIES, SEED_COVERAGE_REGIONS,
  SEED_COUNTY_MAPPING, SEED_ENTITIES, SEED_SOURCES,
} from './seedData.js';

export function runMigration() {
  const notes = [];
  try {
    const settings = storageGet(KEYS.SETTINGS);
    if (settings && settings.schema_version === SCHEMA_VERSION) {
      // Schema current — check if seed data has been updated (e.g. new batch of sources)
      if (settings.seed_version !== SEED_VERSION) {
        return runSeedUpdate(settings, notes);
      }
      return { status: 'current', notes: ['Schema v2 active. No migration needed.'] };
    }

    // Determine if V1 data exists (settings without schema_version, or legacy keys present)
    const hasV1 = settings !== null || storageGet('ps_leads') !== null;

    if (hasV1) {
      notes.push('V1 data detected. Backing up and migrating...');
      backupV1Keys(notes);
      migrateSettings(settings, notes);
    } else {
      notes.push('Fresh install. Seeding...');
      storageSet(KEYS.SETTINGS, freshSettings());
    }

    seedTables(notes);
    writeMigrationLog(hasV1, notes);
    return { status: hasV1 ? 'migrated' : 'fresh_seeded', notes };

  } catch (err) {
    console.error('[PS Migration]', err);
    notes.push('ERROR: ' + err.message);
    // Ensure settings exist even on error
    try {
      const s = storageGet(KEYS.SETTINGS) || {};
      if (!s.schema_version) { s.schema_version = SCHEMA_VERSION; storageSet(KEYS.SETTINGS, s); }
    } catch {}
    return { status: 'error', notes };
  }
}

function backupV1Keys(notes) {
  // Backup colliding keys (will be overwritten)
  backup('ps_sources', 'ps_sources_v1', notes);
  backup('ps_leads', 'ps_leads_v1', notes);
  backup('ps_settings', 'ps_settings_v1', notes);
  // Backup and delete deprecated keys
  backupAndDelete('ps_submitted', 'ps_submitted_v1', notes);
  backupAndDelete('ps_notpursued', 'ps_notpursued_v1', notes);
  backupAndDelete('ps_focuspoints', 'ps_focuspoints_v1', notes);
  backupAndDelete('ps_targetorgs', 'ps_targetorgs_v1', notes);
}

function backup(srcKey, dstKey, notes) {
  const data = storageGet(srcKey);
  if (data !== null) {
    storageSet(dstKey, data);
    notes.push(`Backed up ${srcKey} → ${dstKey}`);
  }
}

function backupAndDelete(srcKey, dstKey, notes) {
  const data = storageGet(srcKey);
  if (data !== null) {
    storageSet(dstKey, data);
    storageDelete(srcKey);
    notes.push(`Backed up ${srcKey} → ${dstKey}, deleted original`);
  }
}

function migrateSettings(v1Settings, notes) {
  const merged = freshSettings();
  if (v1Settings) {
    // Preserve user-entered values (secrets excluded — managed server-side)
    ['aiProvider','aiModel','backendEndpoint',
     'dailyUpdateTime','freshnessDays','recheckDays'].forEach(k => {
      if (v1Settings[k] !== undefined && v1Settings[k] !== '') merged[k] = v1Settings[k];
    });
  }
  storageSet(KEYS.SETTINGS, merged);
  notes.push('Settings migrated with schema_version = 2.');
}

function freshSettings() {
  return {
    schema_version: SCHEMA_VERSION,
    seed_version: SEED_VERSION,
    aiProvider: 'anthropic', aiModel: '', backendEndpoint: '',
    asanaWorkspaceId: '869158886664904', asanaProjectId: '1203575716271060',
    dailyUpdateTime: '06:00', backfillMonths: 6, freshnessDays: 60, recheckDays: 7,
    activeSourcesOnly: true, priorityThreshold: 'low',
  };
}

function seedTables(notes) {
  // Reference tables (always overwrite to keep current)
  setTable(KEYS.SOURCE_FAMILIES, SEED_SOURCE_FAMILIES);
  notes.push(`Seeded ${SEED_SOURCE_FAMILIES.length} source families.`);

  setTable(KEYS.COVERAGE_REGIONS, SEED_COVERAGE_REGIONS);
  notes.push(`Seeded ${SEED_COVERAGE_REGIONS.length} coverage regions.`);

  // Data tables (seed only if empty/missing)
  seedIfEmpty(KEYS.COUNTY_MAPPING, SEED_COUNTY_MAPPING, 'county mappings', notes);
  seedIfEmpty(KEYS.ENTITIES, SEED_ENTITIES, 'entities', notes);

  // Sources: overwrite on migration (V1 schema is incompatible)
  setTable(KEYS.SOURCES, SEED_SOURCES);
  notes.push(`Seeded ${SEED_SOURCES.length} sources (V2 schema).`);

  // Leads: start empty (V1 fictional leads not migrated)
  setTable(KEYS.LEADS, []);
  notes.push('Initialized leads (empty).');

  // Empty workflow tables
  seedIfEmpty(KEYS.PROPOSED_SOURCES, [], 'proposed sources', notes);
  seedIfEmpty(KEYS.PROPOSED_ENTITIES, [], 'proposed entities', notes);
  seedIfEmpty(KEYS.OWNER_PROJECTS, [], 'owner projects', notes);
  seedIfEmpty(KEYS.INTAKE, [], 'intake queue', notes);
}

function seedIfEmpty(key, data, label, notes) {
  if (getTable(key).length === 0) {
    setTable(key, data);
    notes.push(`Seeded ${data.length} ${label}.`);
  } else {
    notes.push(`${label} already present — preserved.`);
  }
}

function writeMigrationLog(wasV1, notes) {
  storageSet(KEYS.MIGRATION, {
    migrated_at: new Date().toISOString(),
    from_version: wasV1 ? 1 : null,
    to_version: SCHEMA_VERSION,
    seed_version: SEED_VERSION,
    notes,
  });
}

/* ── Seed Update (same schema, new seed data) ───────────────────── */
function runSeedUpdate(settings, notes) {
  try {
    notes.push(`Seed update: ${settings.seed_version} → ${SEED_VERSION}`);

    // Reference tables — always safe to overwrite (user doesn't edit these)
    setTable(KEYS.SOURCE_FAMILIES, SEED_SOURCE_FAMILIES);
    notes.push(`Refreshed ${SEED_SOURCE_FAMILIES.length} source families.`);
    setTable(KEYS.COVERAGE_REGIONS, SEED_COVERAGE_REGIONS);
    notes.push(`Refreshed ${SEED_COVERAGE_REGIONS.length} coverage regions.`);

    // Data tables — merge new records without overwriting existing edits
    mergeNewRecords(KEYS.ENTITIES, SEED_ENTITIES, 'entity_id', 'entities', notes);
    mergeNewRecords(KEYS.SOURCES, SEED_SOURCES, 'source_id', 'sources', notes);
    mergeCountyMappings(notes);

    // Update seed_version in settings
    settings.seed_version = SEED_VERSION;
    storageSet(KEYS.SETTINGS, settings);

    // Log the update
    storageSet(KEYS.MIGRATION, {
      migrated_at: new Date().toISOString(),
      from_version: SCHEMA_VERSION,
      to_version: SCHEMA_VERSION,
      seed_version: SEED_VERSION,
      notes,
    });

    return { status: 'seed_updated', notes };
  } catch (err) {
    console.error('[PS Seed Update]', err);
    notes.push('ERROR during seed update: ' + err.message);
    return { status: 'error', notes };
  }
}

function mergeNewRecords(key, seedRecords, idField, label, notes) {
  const existing = getTable(key);
  const existingIds = new Set(existing.map(r => r[idField]));
  const newRecords = seedRecords.filter(r => !existingIds.has(r[idField]));
  if (newRecords.length > 0) {
    setTable(key, [...existing, ...newRecords]);
    notes.push(`Added ${newRecords.length} new ${label}.`);
  } else {
    notes.push(`No new ${label} to add.`);
  }
}

function mergeCountyMappings(notes) {
  const existing = getTable(KEYS.COUNTY_MAPPING);
  const existingKeys = new Set(existing.map(c => `${c.county_name}|${c.state}`));
  const newMappings = SEED_COUNTY_MAPPING.filter(c => !existingKeys.has(`${c.county_name}|${c.state}`));
  if (newMappings.length > 0) {
    setTable(KEYS.COUNTY_MAPPING, [...existing, ...newMappings]);
    notes.push(`Added ${newMappings.length} new county mappings.`);
  } else {
    notes.push('No new county mappings to add.');
  }
}
