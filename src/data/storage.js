/**
 * Project Scout — Storage Layer (canonical ps_ keys)
 */
import { KEYS } from './schemas.js';

export function storageGet(key) {
  try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : null; }
  catch (e) { console.warn('[PS] Read error:', key, e); return null; }
}
export function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch (e) { console.warn('[PS] Write error:', key, e); return false; }
}
export function storageDelete(key) {
  try { localStorage.removeItem(key); return true; } catch { return false; }
}

export function getTable(key) { return storageGet(key) || []; }
export function setTable(key, data) { return storageSet(key, data); }

export function getSourceFamilies()  { return getTable(KEYS.SOURCE_FAMILIES); }
export function getCoverageRegions() { return getTable(KEYS.COVERAGE_REGIONS); }
export function getCountyMapping()   { return getTable(KEYS.COUNTY_MAPPING); }
export function getEntities()        { return getTable(KEYS.ENTITIES); }
export function setEntities(data)    { return setTable(KEYS.ENTITIES, data); }
export function getSources()         { return getTable(KEYS.SOURCES); }
export function setSources(data)     { return setTable(KEYS.SOURCES, data); }
export function getProposedSources() { return getTable(KEYS.PROPOSED_SOURCES); }
export function setProposedSources(data) { return setTable(KEYS.PROPOSED_SOURCES, data); }
export function getProposedEntities(){ return getTable(KEYS.PROPOSED_ENTITIES); }
export function setProposedEntities(data){ return setTable(KEYS.PROPOSED_ENTITIES, data); }
export function getLeads()           { return getTable(KEYS.LEADS); }
export function getOwnerProjects()   { return getTable(KEYS.OWNER_PROJECTS); }
export function getIntake()          { return getTable(KEYS.INTAKE); }
export function getSettings()        { return storageGet(KEYS.SETTINGS) || {}; }
export function setSettings(s)       { return storageSet(KEYS.SETTINGS, s); }
export function getMigration()       { return storageGet(KEYS.MIGRATION); }
