/**
 * Project Scout — Source Registry (parent shell)
 * 6 subtabs: Sources (REAL), Entities (REAL), Geography, Families, Proposed Sources, Proposed Entities
 * Phase 1 Step 6 — Sources CRUD added.
 */
import { useState, useEffect, useMemo } from 'react';
import { getSourceFamilies, getSources, setSources, getEntities, setEntities, getCoverageRegions, getCountyMapping, getProposedSources, setProposedSources, getProposedEntities, setProposedEntities } from '../data/storage.js';
import { ENTITY_TYPES, EXPECTED_FAMILIES_BY_TYPE } from '../data/seedData.js';
import { createSource, createEntity, createProposedSource, createProposedEntity, CHECK_FREQUENCIES, TIERS } from '../data/schemas.js';

const SUB_TABS = [
  { id: 'sources',  label: 'Sources' },
  { id: 'entities', label: 'Entities' },
  { id: 'geography',label: 'Geography' },
  { id: 'families', label: 'Families' },
  { id: 'proposed', label: 'Proposed Sources' },
  { id: 'propent',  label: 'Proposed Entities' },
];

export default function SourceRegistryView() {
  const [sub, setSub] = useState('sources');
  const [data, setData] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    setData({
      sources: getSources(),
      entities: getEntities(),
      families: getSourceFamilies(),
      regions: getCoverageRegions(),
      counties: getCountyMapping(),
      proposedSrc: getProposedSources(),
      proposedEnt: getProposedEntities(),
    });
  }, [refreshKey]);
  const handleSourcesChanged = () => setRefreshKey(k => k + 1);
  if (!data) return null;
  return (
    <div>
      {/* Sub-tab nav */}
      <div style={{ display:'flex', gap:6, marginBottom:22, flexWrap:'wrap' }}>
        {SUB_TABS.map(t => {
          const active = sub === t.id;
          const count = t.id === 'sources' ? data.sources.length
            : t.id === 'entities' ? data.entities.length
            : t.id === 'geography' ? data.regions.length
            : t.id === 'families' ? data.families.length
            : t.id === 'proposed' ? data.proposedSrc.length
            : data.proposedEnt.length;
          return (
            <button key={t.id} onClick={() => setSub(t.id)} style={{
              padding:'9px 18px', borderRadius:8, border:'1px solid',
              borderColor: active ? '#0f172a' : '#e2e8f0',
              background: active ? '#0f172a' : '#fff',
              color: active ? '#fff' : '#64748b',
              fontSize:12.5, fontWeight:600, cursor:'pointer',
              display:'flex', alignItems:'center', gap:7, transition:'all 0.15s',
            }}>
              {t.label}
              <span style={{
                fontSize:10, padding:'1px 7px', borderRadius:10, fontWeight:700,
                background: active ? 'rgba(255,255,255,0.18)' : '#f1f5f9',
                color: active ? '#fff' : '#94a3b8',
              }}>{count}</span>
            </button>
          );
        })}
      </div>
      {/* Sub-tab content */}
      {sub === 'sources'  && <SourcesTable sources={data.sources} entities={data.entities} families={data.families} onChanged={handleSourcesChanged} />}
      {sub === 'entities' && <EntitiesTable entities={data.entities} sources={data.sources} families={data.families} regions={data.regions} onChanged={handleSourcesChanged} />}
      {sub === 'geography'&& <GeographyView regions={data.regions} counties={data.counties} />}
      {sub === 'families' && <FamiliesTable families={data.families} sources={data.sources} />}
      {sub === 'proposed' && <ProposedSourcesQueue proposals={data.proposedSrc} entities={data.entities} families={data.families} sources={data.sources} onChanged={handleSourcesChanged} />}
      {sub === 'propent'  && <ProposedEntitiesQueue proposals={data.proposedEnt} entities={data.entities} regions={data.regions} onChanged={handleSourcesChanged} />}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════
   SOURCES TABLE (from Step 2 — unchanged)
   ═══════════════════════════════════════════════════════════════ */

const selectStyle = { padding:'8px 12px', borderRadius:7, border:'1px solid #e2e8f0', fontSize:12, background:'#fff', color:'#475569', cursor:'pointer', outline:'none' };
const inputStyle = { padding:'8px 12px', borderRadius:7, border:'1px solid #e2e8f0', fontSize:12, background:'#fff', color:'#1e293b', outline:'none', width:'100%' };

const TIER_COLORS = { 'Tier 1':'#0f172a', 'Tier 2':'#3b82f6', 'Tier 3':'#94a3b8' };
const HEALTH_COLORS = { healthy:'#10b981', degraded:'#f59e0b', failing:'#ef4444', untested:'#d1d5db' };

function SourcesTable({ sources, entities, families, onChanged }) {
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('all');
  const [familyFilter, setFamilyFilter] = useState('all');
  const [tierFilter, setTierFilter] = useState('all');
  const [sortBy, setSortBy] = useState('entity');
  const [sortDir, setSortDir] = useState('asc');
  const [editing, setEditing] = useState(null); // null or source object
  const entityMap = useMemo(() => {
    const m = {};
    entities.forEach(e => { m[e.entity_id] = e.entity_name; });
    return m;
  }, [entities]);
  const familyMap = useMemo(() => {
    const m = {};
    families.forEach(f => { m[f.family_id] = f.family_name; });
    return m;
  }, [families]);
  const states = useMemo(() => [...new Set(sources.map(s => s.state).filter(Boolean))].sort(), [sources]);
  const familyIds = useMemo(() => [...new Set(sources.map(s => s.source_family).filter(Boolean))].sort(), [sources]);
  const tiers = useMemo(() => [...new Set(sources.map(s => s.priority_tier).filter(Boolean))].sort(), [sources]);
  const filtered = useMemo(() => {
    let r = [...sources];
    if (search) {
      const q = search.toLowerCase();
      r = r.filter(s =>
        s.source_name?.toLowerCase().includes(q) ||
        (entityMap[s.entity_id] || '').toLowerCase().includes(q) ||
        (familyMap[s.source_family] || '').toLowerCase().includes(q) ||
        s.source_url?.toLowerCase().includes(q) ||
        s.city?.toLowerCase().includes(q) ||
        s.state?.toLowerCase().includes(q) ||
        s.notes?.toLowerCase().includes(q) ||
        (s.keywords_to_watch || []).some(k => k.toLowerCase().includes(q))
      );
    }
    if (stateFilter !== 'all') r = r.filter(s => s.state === stateFilter);
    if (familyFilter !== 'all') r = r.filter(s => s.source_family === familyFilter);
    if (tierFilter !== 'all') r = r.filter(s => s.priority_tier === tierFilter);
    r.sort((a, b) => {
      let va, vb;
      if (sortBy === 'name') { va = a.source_name || ''; vb = b.source_name || ''; }
      else if (sortBy === 'entity') { va = entityMap[a.entity_id] || ''; vb = entityMap[b.entity_id] || ''; }
      else if (sortBy === 'family') { va = a.source_family || ''; vb = b.source_family || ''; }
      else if (sortBy === 'state') { va = a.state || ''; vb = b.state || ''; }
      else { va = a.source_name || ''; vb = b.source_name || ''; }
      const cmp = va.localeCompare(vb);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return r;
  }, [sources, search, stateFilter, familyFilter, tierFilter, sortBy, sortDir, entityMap, familyMap]);
  const handleSort = (col) => {
    if (sortBy === col) { setSortDir(d => d === 'asc' ? 'desc' : 'asc'); }
    else { setSortBy(col); setSortDir('asc'); }
  };
  const sortArrow = (col) => sortBy === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
  const handleAdd = () => {
    setEditing(createSource({ added_by: 'Manual', date_added: new Date().toISOString().split('T')[0] }));
  };
  const handleEdit = (src) => {
    setEditing({ ...src });
  };
  const handleToggleActive = (src) => {
    const updated = sources.map(s => s.source_id === src.source_id ? { ...s, active: !s.active } : s);
    setSources(updated);
    onChanged();
  };
  const handleSave = (form) => {
    const isNew = !sources.find(s => s.source_id === form.source_id);
    let updated;
    if (isNew) {
      updated = [...sources, form];
    } else {
      updated = sources.map(s => s.source_id === form.source_id ? form : s);
    }
    setSources(updated);
    setEditing(null);
    onChanged();
  };
  const activeCount = sources.filter(s => s.active).length;
  const byState = {};
  sources.forEach(s => { byState[s.state] = (byState[s.state]||0) + 1; });
  return (
    <div>
      {/* Stats bar */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(110px, 1fr))', gap:8, marginBottom:16 }}>
        {[
          { label:'Total', value:sources.length, color:'#3b82f6' },
          { label:'Active', value:activeCount, color:'#10b981' },
          ...Object.entries(byState).map(([st, n]) => ({ label:st, value:n, color:'#64748b' })),
        ].map(s => (
          <div key={s.label} style={{ background:'#fff', borderRadius:9, padding:'10px 14px', border:'1px solid rgba(0,0,0,0.05)' }}>
            <div style={{ fontSize:9.5, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.06em', color:'#94a3b8', marginBottom:3 }}>{s.label}</div>
            <div style={{ fontSize:20, fontWeight:800, color:s.color, letterSpacing:'-0.02em' }}>{s.value}</div>
          </div>
        ))}
      </div>
      {/* Toolbar */}
      <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:14, alignItems:'center' }}>
        <div style={{ flex:'1 1 200px', position:'relative' }}>
          <span style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#94a3b8', fontSize:13 }}>⌕</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, entity, family, keyword, city, state..." style={{ ...inputStyle, paddingLeft:30 }} />
        </div>
        <select value={stateFilter} onChange={e => setStateFilter(e.target.value)} style={selectStyle}>
          <option value="all">All States</option>
          {states.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={familyFilter} onChange={e => setFamilyFilter(e.target.value)} style={selectStyle}>
          <option value="all">All Families</option>
          {familyIds.map(f => <option key={f} value={f}>{f} — {familyMap[f] ? familyMap[f].split('(')[0].trim().slice(0,30) : f}</option>)}
        </select>
        <select value={tierFilter} onChange={e => setTierFilter(e.target.value)} style={selectStyle}>
          <option value="all">All Tiers</option>
          {tiers.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <button onClick={handleAdd} style={{ padding:'8px 16px', borderRadius:7, border:'none', background:'#0f172a', color:'#fff', cursor:'pointer', fontSize:12, fontWeight:600, display:'flex', alignItems:'center', gap:5, whiteSpace:'nowrap' }}>+ Add Source</button>
      </div>
      {/* Table */}
      <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:10, overflow:'hidden' }}>
        <div style={{ display:'grid', gridTemplateColumns:'2fr 1.3fr 1fr 0.5fr 0.4fr 0.5fr 0.6fr 0.6fr', gap:0, padding:'10px 16px', background:'#f8fafc', borderBottom:'1px solid #e2e8f0', fontSize:10.5, fontWeight:700, color:'#94a3b8', textTransform:'uppercase', letterSpacing:'0.06em' }}>
          <div style={{ cursor:'pointer' }} onClick={() => handleSort('name')}>Source{sortArrow('name')}</div>
          <div style={{ cursor:'pointer' }} onClick={() => handleSort('entity')}>Entity{sortArrow('entity')}</div>
          <div style={{ cursor:'pointer' }} onClick={() => handleSort('family')}>Family{sortArrow('family')}</div>
          <div>Tier</div>
          <div style={{ cursor:'pointer' }} onClick={() => handleSort('state')}>St{sortArrow('state')}</div>
          <div>Freq</div>
          <div>Health</div>
          <div style={{ textAlign:'right' }}>Actions</div>
        </div>
        {filtered.length === 0 && (
          <div style={{ padding:'48px 20px', textAlign:'center', color:'#94a3b8' }}>
            <div style={{ fontSize:14, fontWeight:600, marginBottom:4 }}>No sources match your filters</div>
            <div style={{ fontSize:12.5 }}>Try adjusting your search or filter criteria</div>
          </div>
        )}
        {filtered.map(src => {
          const isBenchmark = src.notes?.includes('BENCHMARK');
          const entityName = entityMap[src.entity_id] || src.entity_id || '—';
          const familyName = familyMap[src.source_family] || src.source_family || '—';
          const familyShort = familyName.split('/')[0].split('(')[0].trim();
          const tierColor = TIER_COLORS[src.priority_tier] || '#94a3b8';
          const healthColor = HEALTH_COLORS[src.fetch_health] || '#d1d5db';
          const isInactive = src.active === false;
          return (
            <div key={src.source_id} style={{
              display:'grid', gridTemplateColumns:'2fr 1.3fr 1fr 0.5fr 0.4fr 0.5fr 0.6fr 0.6fr',
              gap:0, padding:'12px 16px', borderBottom:'1px solid #f1f5f9',
              background: isBenchmark ? '#fffbeb' : isInactive ? '#f8fafc' : '#fff',
              opacity: isInactive ? 0.55 : 1, transition:'background 0.1s',
            }}
              onMouseEnter={e => { if (!isBenchmark && !isInactive) e.currentTarget.style.background = '#f8fafc'; }}
              onMouseLeave={e => { e.currentTarget.style.background = isBenchmark ? '#fffbeb' : isInactive ? '#f8fafc' : '#fff'; }}
            >
              <div style={{ minWidth:0 }}>
                <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                  <span style={{ fontSize:12.5, fontWeight:600, color:'#0f172a', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{src.source_name}</span>
                  {isBenchmark && <span style={{ fontSize:9, fontWeight:700, padding:'1px 5px', borderRadius:4, background:'#fef3c7', color:'#92400e', whiteSpace:'nowrap' }}>BENCHMARK</span>}
                  {isInactive && <span style={{ fontSize:9, fontWeight:700, padding:'1px 5px', borderRadius:4, background:'#f1f5f9', color:'#94a3b8', whiteSpace:'nowrap' }}>INACTIVE</span>}
                </div>
                {src.source_url ? (
                  <a href={src.source_url} target="_blank" rel="noreferrer" style={{ fontSize:10.5, color:'#3b82f6', textDecoration:'none', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', display:'block', maxWidth:'100%' }}
                    onMouseEnter={e => e.target.style.textDecoration='underline'} onMouseLeave={e => e.target.style.textDecoration='none'}>
                    {src.source_url.replace(/^https?:\/\//, '').slice(0,50)}{src.source_url.length > 58 ? '...' : ''}
                  </a>
                ) : <span style={{ fontSize:10.5, color:'#d1d5db', fontStyle:'italic' }}>No URL yet</span>}
                {src.notes && <div style={{ fontSize:10, color:'#94a3b8', marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{src.notes}</div>}
              </div>
              <div style={{ fontSize:12, color:'#475569', display:'flex', alignItems:'center', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{entityName}</div>
              <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                <span style={{ fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:4, background:'#f1f5f9', color:'#64748b', whiteSpace:'nowrap' }}>{src.source_family}</span>
                <span style={{ fontSize:11, color:'#64748b', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{familyShort}</span>
              </div>
              <div style={{ display:'flex', alignItems:'center' }}>
                <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:4, background: tierColor === '#0f172a' ? '#0f172a' : tierColor + '18', color: tierColor === '#0f172a' ? '#fff' : tierColor }}>{src.priority_tier?.replace('Tier ', 'T')}</span>
              </div>
              <div style={{ fontSize:12, color:'#475569', display:'flex', alignItems:'center' }}>{src.state || '—'}</div>
              <div style={{ fontSize:11, color:'#94a3b8', display:'flex', alignItems:'center' }}>{src.check_frequency || '—'}</div>
              <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                <div style={{ width:8, height:8, borderRadius:'50%', background:healthColor, flexShrink:0 }} />
                <span style={{ fontSize:11, color:'#94a3b8', textTransform:'capitalize' }}>{src.fetch_health || 'untested'}</span>
              </div>
              {/* Actions */}
              <div style={{ display:'flex', alignItems:'center', justifyContent:'flex-end', gap:4 }}>
                <button onClick={() => handleEdit(src)} style={{ padding:'3px 8px', borderRadius:5, border:'1px solid #e2e8f0', background:'#fff', cursor:'pointer', fontSize:10, fontWeight:600, color:'#475569' }}>Edit</button>
                <button onClick={() => handleToggleActive(src)} style={{ padding:'3px 8px', borderRadius:5, border:'1px solid', borderColor: src.active ? '#fecaca' : '#d1fae5', background:'#fff', cursor:'pointer', fontSize:10, fontWeight:600, color: src.active ? '#dc2626' : '#166534' }}>
                  {src.active ? 'Deact.' : 'Activ.'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop:10, fontSize:11, color:'#94a3b8', textAlign:'right' }}>Showing {filtered.length} of {sources.length} sources</div>
      {/* Edit/Add Modal */}
      {editing && (
        <SourceEditModal
          source={editing}
          entities={entities}
          families={families}
          isNew={!sources.find(s => s.source_id === editing.source_id)}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════
   SOURCE EDIT MODAL (Phase 1 Step 6)
   ═══════════════════════════════════════════════════════════════ */

function SourceEditModal({ source, entities, families, isNew, onSave, onCancel }) {
  const [form, setForm] = useState({ ...source });
  const [kwText, setKwText] = useState((source.keywords_to_watch || []).join(', '));
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const handleSubmit = () => {
    if (!form.source_name) return;
    const keywords = kwText.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const final = { ...form, keywords_to_watch: keywords };
    if (isNew && (!final.source_id || final.source_id.startsWith('SRC-'))) {
      const prefix = (final.state || 'XX').toUpperCase();
      const city = (final.city || 'GEN').toUpperCase().slice(0, 3);
      final.source_id = `${prefix}-${city}-${Date.now().toString(36).slice(-4).toUpperCase()}`;
    }
    onSave(final);
  };
  const modalField = { marginBottom: 14 };
  const modalLabel = { display: 'block', fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' };
  return (
    <>
      <div onClick={onCancel} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.3)', zIndex:999 }} />
      <div style={{ position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)', width:'100%', maxWidth:560, maxHeight:'90vh', overflow:'auto', background:'#fff', borderRadius:12, boxShadow:'0 20px 60px rgba(0,0,0,0.15)', zIndex:1000, padding:'24px 28px' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
          <h3 style={{ fontSize:16, fontWeight:700, color:'#0f172a', margin:0 }}>{isNew ? 'Add Source' : 'Edit Source'}</h3>
          <button onClick={onCancel} style={{ background:'none', border:'none', cursor:'pointer', fontSize:18, color:'#94a3b8', padding:4 }}>✕</button>
        </div>
        <div style={modalField}>
          <label style={modalLabel}>Source Name *</label>
          <input value={form.source_name || ''} onChange={e => set('source_name', e.target.value)} style={inputStyle} placeholder="e.g. Bids / RFPs / RFQs" />
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, ...modalField }}>
          <div>
            <label style={modalLabel}>Entity</label>
            <select value={form.entity_id || ''} onChange={e => set('entity_id', e.target.value)} style={{ ...inputStyle }}>
              <option value="">— Select entity —</option>
              {entities.map(e => <option key={e.entity_id} value={e.entity_id}>{e.entity_name}</option>)}
            </select>
          </div>
          <div>
            <label style={modalLabel}>Source Family</label>
            <select value={form.source_family || ''} onChange={e => set('source_family', e.target.value)} style={{ ...inputStyle }}>
              {families.map(f => <option key={f.family_id} value={f.family_id}>{f.family_id} — {f.family_name.split('(')[0].trim().slice(0,35)}</option>)}
            </select>
          </div>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, ...modalField }}>
          <div>
            <label style={modalLabel}>Priority Tier</label>
            <select value={form.priority_tier || 'Tier 1'} onChange={e => set('priority_tier', e.target.value)} style={{ ...inputStyle }}>
              {TIERS.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label style={modalLabel}>Check Frequency</label>
            <select value={form.check_frequency || 'Daily'} onChange={e => set('check_frequency', e.target.value)} style={{ ...inputStyle }}>
              {CHECK_FREQUENCIES.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
        </div>
        <div style={modalField}>
          <label style={modalLabel}>Source URL</label>
          <input value={form.source_url || ''} onChange={e => set('source_url', e.target.value)} style={inputStyle} placeholder="https://..." />
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12, ...modalField }}>
          <div>
            <label style={modalLabel}>State</label>
            <input value={form.state || ''} onChange={e => set('state', e.target.value)} style={inputStyle} placeholder="MT" />
          </div>
          <div>
            <label style={modalLabel}>County</label>
            <input value={form.county || ''} onChange={e => set('county', e.target.value)} style={inputStyle} placeholder="Missoula" />
          </div>
          <div>
            <label style={modalLabel}>City</label>
            <input value={form.city || ''} onChange={e => set('city', e.target.value)} style={inputStyle} placeholder="Missoula" />
          </div>
        </div>
        <div style={modalField}>
          <label style={modalLabel}>Keywords (comma-separated)</label>
          <input value={kwText} onChange={e => setKwText(e.target.value)} style={inputStyle} placeholder="rfq, rfp, design services, architectural" />
        </div>
        <div style={modalField}>
          <label style={modalLabel}>Notes</label>
          <textarea value={form.notes || ''} onChange={e => set('notes', e.target.value)} rows={3} style={{ ...inputStyle, resize:'vertical', fontFamily:'inherit' }} placeholder="Internal notes about this source..." />
        </div>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginTop:20 }}>
          <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:12, color:'#475569', cursor:'pointer' }}>
            <button onClick={() => set('active', !form.active)} style={{
              width:36, height:20, borderRadius:10, border:'none', cursor:'pointer',
              background: form.active ? '#10b981' : '#e2e8f0', position:'relative', transition:'background 0.2s',
            }}>
              <div style={{ width:14, height:14, borderRadius:'50%', background:'#fff', position:'absolute', top:3, left: form.active ? 19 : 3, transition:'left 0.2s', boxShadow:'0 1px 3px rgba(0,0,0,0.2)' }} />
            </button>
            {form.active ? 'Active' : 'Inactive'}
          </label>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={onCancel} style={{ padding:'9px 18px', borderRadius:7, border:'1px solid #e2e8f0', background:'#fff', cursor:'pointer', fontSize:12.5, fontWeight:600, color:'#64748b' }}>Cancel</button>
            <button onClick={handleSubmit} style={{ padding:'9px 18px', borderRadius:7, border:'none', background:'#0f172a', cursor:'pointer', fontSize:12.5, fontWeight:600, color:'#fff', opacity: form.source_name ? 1 : 0.4 }}>
              {isNew ? 'Add Source' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}


/* ═══════════════════════════════════════════════════════════════
   ENTITIES TABLE — CRUD (Phase 1 Step 7)
   ═══════════════════════════════════════════════════════════════ */

function EntitiesTable({ entities, sources, families, regions, onChanged }) {
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [sortBy, setSortBy] = useState('name');
  const [sortDir, setSortDir] = useState('asc');
  const [editing, setEditing] = useState(null);
  const sourceCountMap = useMemo(() => {
    const m = {};
    sources.forEach(s => {
      if (s.entity_id && s.active !== false) {
        m[s.entity_id] = (m[s.entity_id] || 0) + 1;
      }
    });
    return m;
  }, [sources]);
  const coveredFamiliesMap = useMemo(() => {
    const m = {};
    sources.forEach(s => {
      if (s.entity_id && s.active !== false && !s.is_aggregator) {
        if (!m[s.entity_id]) m[s.entity_id] = new Set();
        m[s.entity_id].add(s.source_family);
      }
    });
    return m;
  }, [sources]);
  const familyNameMap = useMemo(() => {
    const m = {};
    families.forEach(f => { m[f.family_id] = f.family_name; });
    return m;
  }, [families]);
  const typeLabelMap = useMemo(() => {
    const m = {};
    ENTITY_TYPES.forEach(t => { m[t.value] = t.label; });
    return m;
  }, []);
  const statesInData = useMemo(() => [...new Set(entities.map(e => e.state).filter(Boolean))].sort(), [entities]);
  const typesInData = useMemo(() => [...new Set(entities.map(e => e.entity_type).filter(Boolean))].sort(), [entities]);
  const enriched = useMemo(() => {
    return entities.map(e => {
      const srcCount = sourceCountMap[e.entity_id] || 0;
      const covered = coveredFamiliesMap[e.entity_id] || new Set();
      const expected = EXPECTED_FAMILIES_BY_TYPE[e.entity_type] || [];
      const gaps = expected.filter(fid => !covered.has(fid));
      return { ...e, _srcCount: srcCount, _coveredCount: covered.size, _expectedCount: expected.length, _gapCount: gaps.length, _gaps: gaps };
    });
  }, [entities, sourceCountMap, coveredFamiliesMap]);
  const filtered = useMemo(() => {
    let r = [...enriched];
    if (search) {
      const q = search.toLowerCase();
      r = r.filter(e =>
        e.entity_name?.toLowerCase().includes(q) ||
        (typeLabelMap[e.entity_type] || '').toLowerCase().includes(q) ||
        e.primary_area?.toLowerCase().includes(q) ||
        e.state?.toLowerCase().includes(q) ||
        e.notes?.toLowerCase().includes(q)
      );
    }
    if (stateFilter !== 'all') r = r.filter(e => e.state === stateFilter);
    if (typeFilter !== 'all') r = r.filter(e => e.entity_type === typeFilter);
    r.sort((a, b) => {
      let va, vb;
      if (sortBy === 'name') { va = a.entity_name || ''; vb = b.entity_name || ''; }
      else if (sortBy === 'type') { va = typeLabelMap[a.entity_type] || ''; vb = typeLabelMap[b.entity_type] || ''; }
      else if (sortBy === 'state') { va = a.state || ''; vb = b.state || ''; }
      else if (sortBy === 'sources') { va = a._srcCount; vb = b._srcCount; return sortDir === 'asc' ? va - vb : vb - va; }
      else if (sortBy === 'gaps') { va = a._gapCount; vb = b._gapCount; return sortDir === 'asc' ? va - vb : vb - va; }
      else { va = a.entity_name || ''; vb = b.entity_name || ''; }
      if (typeof va === 'string') { const cmp = va.localeCompare(vb); return sortDir === 'asc' ? cmp : -cmp; }
      return 0;
    });
    return r;
  }, [enriched, search, stateFilter, typeFilter, sortBy, sortDir, typeLabelMap]);
  const handleSort = (col) => {
    if (sortBy === col) { setSortDir(d => d === 'asc' ? 'desc' : 'asc'); }
    else { setSortBy(col); setSortDir('asc'); }
  };
  const sortArrow = (col) => sortBy === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
  const handleAdd = () => {
    setEditing(createEntity({ added_by: 'Manual', date_added: new Date().toISOString().split('T')[0] }));
  };
  const handleEdit = (ent) => {
    setEditing({ ...ent });
  };
  const handleToggleActive = (ent) => {
    const updated = entities.map(e => e.entity_id === ent.entity_id ? { ...e, active: !e.active } : e);
    setEntities(updated);
    onChanged();
  };
  const handleSave = (form) => {
    const isNew = !entities.find(e => e.entity_id === form.entity_id);
    let updated;
    if (isNew) {
      updated = [...entities, form];
    } else {
      updated = entities.map(e => e.entity_id === form.entity_id ? form : e);
    }
    setEntities(updated);
    setEditing(null);
    onChanged();
  };
  const totalGaps = enriched.reduce((s, e) => s + e._gapCount, 0);
  const entitiesWithGaps = enriched.filter(e => e._gapCount > 0).length;
  return (
    <div>
      {/* Stats */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(120px, 1fr))', gap:8, marginBottom:16 }}>
        {[
          { label:'Entities', value:entities.length, color:'#3b82f6' },
          { label:'Sources Linked', value:sources.filter(s => s.active !== false).length, color:'#10b981' },
          { label:'With Gaps', value:entitiesWithGaps, color: entitiesWithGaps > 0 ? '#f59e0b' : '#10b981' },
          { label:'Total Gaps', value:totalGaps, color: totalGaps > 0 ? '#ef4444' : '#10b981' },
        ].map(s => (
          <div key={s.label} style={{ background:'#fff', borderRadius:9, padding:'10px 14px', border:'1px solid rgba(0,0,0,0.05)' }}>
            <div style={{ fontSize:9.5, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.06em', color:'#94a3b8', marginBottom:3 }}>{s.label}</div>
            <div style={{ fontSize:20, fontWeight:800, color:s.color, letterSpacing:'-0.02em' }}>{s.value}</div>
          </div>
        ))}
      </div>
      {/* Toolbar */}
      <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:14, alignItems:'center' }}>
        <div style={{ flex:'1 1 200px', position:'relative' }}>
          <span style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#94a3b8', fontSize:13 }}>⌕</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search entity name, type, area, state..." style={{ ...inputStyle, paddingLeft:30 }} />
        </div>
        <select value={stateFilter} onChange={e => setStateFilter(e.target.value)} style={selectStyle}>
          <option value="all">All States</option>
          {statesInData.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={selectStyle}>
          <option value="all">All Types</option>
          {typesInData.map(t => <option key={t} value={t}>{typeLabelMap[t] || t}</option>)}
        </select>
        <button onClick={handleAdd} style={{ padding:'8px 16px', borderRadius:7, border:'none', background:'#0f172a', color:'#fff', cursor:'pointer', fontSize:12, fontWeight:600, display:'flex', alignItems:'center', gap:5, whiteSpace:'nowrap' }}>+ Add Entity</button>
      </div>
      {/* Table */}
      <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:10, overflow:'hidden' }}>
        <div style={{ display:'grid', gridTemplateColumns:'2fr 1.2fr 0.5fr 0.8fr 0.6fr 0.6fr 0.5fr 0.6fr', gap:0, padding:'10px 16px', background:'#f8fafc', borderBottom:'1px solid #e2e8f0', fontSize:10.5, fontWeight:700, color:'#94a3b8', textTransform:'uppercase', letterSpacing:'0.06em' }}>
          <div style={{ cursor:'pointer' }} onClick={() => handleSort('name')}>Entity{sortArrow('name')}</div>
          <div style={{ cursor:'pointer' }} onClick={() => handleSort('type')}>Type{sortArrow('type')}</div>
          <div style={{ cursor:'pointer' }} onClick={() => handleSort('state')}>State{sortArrow('state')}</div>
          <div>Regions</div>
          <div style={{ cursor:'pointer' }} onClick={() => handleSort('sources')}>Sources{sortArrow('sources')}</div>
          <div>Coverage</div>
          <div style={{ cursor:'pointer' }} onClick={() => handleSort('gaps')}>Gaps{sortArrow('gaps')}</div>
          <div style={{ textAlign:'right' }}>Actions</div>
        </div>
        {filtered.length === 0 && (
          <div style={{ padding:'48px 20px', textAlign:'center', color:'#94a3b8' }}>
            <div style={{ fontSize:14, fontWeight:600, marginBottom:4 }}>No entities match your filters</div>
            <div style={{ fontSize:12.5 }}>Try adjusting your search or filter criteria</div>
          </div>
        )}
        {filtered.map(ent => {
          const hasGaps = ent._gapCount > 0;
          const typeLabel = typeLabelMap[ent.entity_type] || ent.entity_type;
          const isInactive = ent.active === false;
          return (
            <div key={ent.entity_id} style={{
              display:'grid', gridTemplateColumns:'2fr 1.2fr 0.5fr 0.8fr 0.6fr 0.6fr 0.5fr 0.6fr',
              gap:0, padding:'12px 16px', borderBottom:'1px solid #f1f5f9',
              background: hasGaps ? '#fffbeb' : isInactive ? '#f8fafc' : '#fff',
              opacity: isInactive ? 0.55 : 1, transition:'background 0.1s',
            }}
              onMouseEnter={e => { if (!hasGaps && !isInactive) e.currentTarget.style.background = '#f8fafc'; }}
              onMouseLeave={e => { e.currentTarget.style.background = hasGaps ? '#fffbeb' : isInactive ? '#f8fafc' : '#fff'; }}
            >
              <div style={{ minWidth:0 }}>
                <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                  <span style={{ fontSize:12.5, fontWeight:600, color:'#0f172a', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{ent.entity_name}</span>
                  {isInactive && <span style={{ fontSize:9, fontWeight:700, padding:'1px 5px', borderRadius:4, background:'#f1f5f9', color:'#94a3b8', whiteSpace:'nowrap' }}>INACTIVE</span>}
                </div>
                <div style={{ display:'flex', gap:8, marginTop:3 }}>
                  {ent.official_site && (
                    <a href={ent.official_site} target="_blank" rel="noreferrer" style={{ fontSize:10, color:'#3b82f6', textDecoration:'none' }}
                      onMouseEnter={e => e.target.style.textDecoration='underline'} onMouseLeave={e => e.target.style.textDecoration='none'}>Site ↗</a>
                  )}
                  {ent.procurement_url && (
                    <a href={ent.procurement_url} target="_blank" rel="noreferrer" style={{ fontSize:10, color:'#3b82f6', textDecoration:'none' }}
                      onMouseEnter={e => e.target.style.textDecoration='underline'} onMouseLeave={e => e.target.style.textDecoration='none'}>Procurement ↗</a>
                  )}
                </div>
                {ent.notes && <div style={{ fontSize:10, color:'#94a3b8', marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{ent.notes}</div>}
              </div>
              <div style={{ fontSize:11.5, color:'#475569', display:'flex', alignItems:'center' }}>{typeLabel}</div>
              <div style={{ fontSize:12, color:'#475569', display:'flex', alignItems:'center' }}>{ent.state || '—'}</div>
              <div style={{ display:'flex', flexWrap:'wrap', gap:3, alignItems:'center' }}>
                {(ent.coverage_regions || []).map(r => (
                  <span key={r} style={{ fontSize:9, padding:'1px 5px', borderRadius:3, background:'#f1f5f9', color:'#64748b', fontWeight:600 }}>{r.replace('_',' ')}</span>
                ))}
              </div>
              <div style={{ fontSize:13, fontWeight:700, color: ent._srcCount > 0 ? '#0f172a' : '#d1d5db', display:'flex', alignItems:'center' }}>{ent._srcCount}</div>
              <div style={{ display:'flex', alignItems:'center', gap:2 }}>
                <span style={{ fontSize:12, fontWeight:600, color: ent._coveredCount >= ent._expectedCount ? '#10b981' : '#f59e0b' }}>{ent._coveredCount}</span>
                <span style={{ fontSize:10, color:'#94a3b8' }}>/</span>
                <span style={{ fontSize:12, color:'#94a3b8' }}>{ent._expectedCount}</span>
              </div>
              <div style={{ display:'flex', alignItems:'center' }}>
                {ent._gapCount === 0 ? (
                  <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:4, background:'#dcfce7', color:'#166534' }}>✓</span>
                ) : (
                  <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:4, background:'#fef3c7', color:'#92400e' }}>{ent._gapCount} gap{ent._gapCount > 1 ? 's' : ''}</span>
                )}
              </div>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'flex-end', gap:4 }}>
                <button onClick={() => handleEdit(ent)} style={{ padding:'3px 8px', borderRadius:5, border:'1px solid #e2e8f0', background:'#fff', cursor:'pointer', fontSize:10, fontWeight:600, color:'#475569' }}>Edit</button>
                <button onClick={() => handleToggleActive(ent)} style={{ padding:'3px 8px', borderRadius:5, border:'1px solid', borderColor: ent.active ? '#fecaca' : '#d1fae5', background:'#fff', cursor:'pointer', fontSize:10, fontWeight:600, color: ent.active ? '#dc2626' : '#166534' }}>
                  {ent.active ? 'Deact.' : 'Activ.'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop:10, fontSize:11, color:'#94a3b8', textAlign:'right' }}>Showing {filtered.length} of {entities.length} entities</div>
      {totalGaps > 0 && (
        <div style={{ marginTop:12, padding:'12px 16px', background:'#fffbeb', border:'1px solid #fef3c7', borderRadius:8 }}>
          <div style={{ fontSize:11, fontWeight:700, color:'#92400e', marginBottom:6 }}>Source family gaps detected</div>
          <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
            {enriched.filter(e => e._gapCount > 0).map(e => (
              <div key={e.entity_id} style={{ fontSize:11, color:'#78716c' }}>
                <span style={{ fontWeight:600, color:'#0f172a' }}>{e.entity_name}</span>
                {' — missing: '}
                {e._gaps.map((fid, i) => (
                  <span key={fid}>{i > 0 && ', '}<span style={{ fontWeight:500 }}>{familyNameMap[fid] ? familyNameMap[fid].split('/')[0].split('(')[0].trim() : fid}</span></span>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
      {editing && (
        <EntityEditModal
          entity={editing}
          regions={regions}
          isNew={!entities.find(e => e.entity_id === editing.entity_id)}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════════
   ENTITY EDIT MODAL
   ═══════════════════════════════════════════════════════════════ */

function EntityEditModal({ entity, regions, isNew, onSave, onCancel }) {
  const [form, setForm] = useState({ ...entity });
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const toggleRegion = (rid) => {
    const current = form.coverage_regions || [];
    if (current.includes(rid)) {
      set('coverage_regions', current.filter(r => r !== rid));
    } else {
      set('coverage_regions', [...current, rid]);
    }
  };
  const handleSubmit = () => {
    if (!form.entity_name) return;
    const final = { ...form };
    if (isNew && (!final.entity_id || final.entity_id.startsWith('ENT-'))) {
      const prefix = (final.state || 'XX').toUpperCase();
      const name = (final.entity_name || 'NEW').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);
      final.entity_id = `ENT-${prefix}-${name}-${Date.now().toString(36).slice(-3).toUpperCase()}`;
    }
    onSave(final);
  };
  const modalField = { marginBottom: 14 };
  const modalLabel = { display: 'block', fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' };
  return (
    <>
      <div onClick={onCancel} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.3)', zIndex:999 }} />
      <div style={{ position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)', width:'100%', maxWidth:560, maxHeight:'90vh', overflow:'auto', background:'#fff', borderRadius:12, boxShadow:'0 20px 60px rgba(0,0,0,0.15)', zIndex:1000, padding:'24px 28px' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
          <h3 style={{ fontSize:16, fontWeight:700, color:'#0f172a', margin:0 }}>{isNew ? 'Add Entity' : 'Edit Entity'}</h3>
          <button onClick={onCancel} style={{ background:'none', border:'none', cursor:'pointer', fontSize:18, color:'#94a3b8', padding:4 }}>✕</button>
        </div>
        <div style={modalField}>
          <label style={modalLabel}>Entity Name *</label>
          <input value={form.entity_name || ''} onChange={e => set('entity_name', e.target.value)} style={inputStyle} placeholder="e.g. City of Missoula" />
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, ...modalField }}>
          <div>
            <label style={modalLabel}>Entity Type</label>
            <select value={form.entity_type || 'other'} onChange={e => set('entity_type', e.target.value)} style={{ ...inputStyle }}>
              {ENTITY_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <label style={modalLabel}>State</label>
            <input value={form.state || ''} onChange={e => set('state', e.target.value)} style={inputStyle} placeholder="MT" />
          </div>
        </div>
        <div style={modalField}>
          <label style={modalLabel}>Primary Area</label>
          <input value={form.primary_area || ''} onChange={e => set('primary_area', e.target.value)} style={inputStyle} placeholder="e.g. Missoula, Kalispell, Statewide" />
        </div>
        <div style={modalField}>
          <label style={modalLabel}>Coverage Regions</label>
          <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
            {regions.map(r => {
              const selected = (form.coverage_regions || []).includes(r.region_id);
              return (
                <button key={r.region_id} onClick={() => toggleRegion(r.region_id)} style={{
                  padding:'5px 10px', borderRadius:6, fontSize:11, fontWeight:600, cursor:'pointer',
                  border:'1px solid', borderColor: selected ? '#0f172a' : '#e2e8f0',
                  background: selected ? '#0f172a' : '#fff', color: selected ? '#fff' : '#64748b',
                  transition:'all 0.15s', opacity: r.active ? 1 : 0.5,
                }}>{r.region_name}</button>
              );
            })}
          </div>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, ...modalField }}>
          <div>
            <label style={modalLabel}>Official Site URL</label>
            <input value={form.official_site || ''} onChange={e => set('official_site', e.target.value)} style={inputStyle} placeholder="https://..." />
          </div>
          <div>
            <label style={modalLabel}>Procurement URL</label>
            <input value={form.procurement_url || ''} onChange={e => set('procurement_url', e.target.value)} style={inputStyle} placeholder="https://..." />
          </div>
        </div>
        <div style={modalField}>
          <label style={modalLabel}>Notes</label>
          <textarea value={form.notes || ''} onChange={e => set('notes', e.target.value)} rows={3} style={{ ...inputStyle, resize:'vertical', fontFamily:'inherit' }} placeholder="Internal notes about this entity..." />
        </div>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginTop:20 }}>
          <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:12, color:'#475569', cursor:'pointer' }}>
            <button onClick={() => set('active', !form.active)} style={{
              width:36, height:20, borderRadius:10, border:'none', cursor:'pointer',
              background: form.active ? '#10b981' : '#e2e8f0', position:'relative', transition:'background 0.2s',
            }}>
              <div style={{ width:14, height:14, borderRadius:'50%', background:'#fff', position:'absolute', top:3, left: form.active ? 19 : 3, transition:'left 0.2s', boxShadow:'0 1px 3px rgba(0,0,0,0.2)' }} />
            </button>
            {form.active ? 'Active' : 'Inactive'}
          </label>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={onCancel} style={{ padding:'9px 18px', borderRadius:7, border:'1px solid #e2e8f0', background:'#fff', cursor:'pointer', fontSize:12.5, fontWeight:600, color:'#64748b' }}>Cancel</button>
            <button onClick={handleSubmit} style={{ padding:'9px 18px', borderRadius:7, border:'none', background:'#0f172a', cursor:'pointer', fontSize:12.5, fontWeight:600, color:'#fff', opacity: form.entity_name ? 1 : 0.4 }}>
              {isNew ? 'Add Entity' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}


/* ═══════════════════════════════════════════════════════════════
   STUB COMPONENTS (unchanged)
   ═══════════════════════════════════════════════════════════════ */

function Card({ children }) {
  return (
    <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:12, padding:'28px' }}>
      {children}
    </div>
  );
}

function PhaseTag({ text }) {
  return <div style={{ marginTop:16, fontSize:11, color:'#10b981', fontWeight:600 }}>✓ Data loaded — {text}</div>;
}

function GeographyView({ regions, counties }) {
  /* ── Region state ── */
  const [regSearch, setRegSearch] = useState('');
  const [regActive, setRegActive] = useState('all');   // all | active | inactive
  const [regSort, setRegSort]     = useState('region_name');
  const [regDir, setRegDir]       = useState('asc');

  /* ── County state ── */
  const [ctySearch, setCtySearch] = useState('');
  const [ctyState, setCtyState]   = useState('all');
  const [ctySort, setCtySort]     = useState('county_name');
  const [ctyDir, setCtyDir]       = useState('asc');

  /* ── Derived data ── */
  const countyCountByRegion = useMemo(() => {
    const m = {};
    counties.forEach(c => { m[c.coverage_region] = (m[c.coverage_region] || 0) + 1; });
    return m;
  }, [counties]);

  const states = useMemo(() => [...new Set(counties.map(c => c.state))].sort(), [counties]);

  /* ── Filtered / sorted regions ── */
  const filteredRegions = useMemo(() => {
    let r = [...regions];
    if (regSearch) { const q = regSearch.toLowerCase(); r = r.filter(x => x.region_name?.toLowerCase().includes(q) || x.office_assignment?.toLowerCase().includes(q) || x.description?.toLowerCase().includes(q)); }
    if (regActive === 'active')   r = r.filter(x => x.active);
    if (regActive === 'inactive') r = r.filter(x => !x.active);
    r.sort((a, b) => {
      let va, vb;
      if (regSort === 'counties') return regDir === 'asc' ? (countyCountByRegion[a.region_id]||0) - (countyCountByRegion[b.region_id]||0) : (countyCountByRegion[b.region_id]||0) - (countyCountByRegion[a.region_id]||0);
      va = a[regSort] || ''; vb = b[regSort] || '';
      if (typeof va === 'string') { const c = va.localeCompare(vb); return regDir === 'asc' ? c : -c; }
      return 0;
    });
    return r;
  }, [regions, regSearch, regActive, regSort, regDir, countyCountByRegion]);

  /* ── Filtered / sorted counties ── */
  const filteredCounties = useMemo(() => {
    let r = [...counties];
    if (ctySearch) { const q = ctySearch.toLowerCase(); r = r.filter(x => x.county_name?.toLowerCase().includes(q) || x.state?.toLowerCase().includes(q) || x.coverage_region?.toLowerCase().includes(q) || x.office_assignment?.toLowerCase().includes(q)); }
    if (ctyState !== 'all') r = r.filter(x => x.state === ctyState);
    r.sort((a, b) => {
      const va = a[ctySort] || '', vb = b[ctySort] || '';
      if (typeof va === 'string') { const c = va.localeCompare(vb); return ctyDir === 'asc' ? c : -c; }
      return 0;
    });
    return r;
  }, [counties, ctySearch, ctyState, ctySort, ctyDir]);

  const handleRegSort = col => { if (regSort === col) setRegDir(d => d === 'asc' ? 'desc' : 'asc'); else { setRegSort(col); setRegDir('asc'); } };
  const handleCtySort = col => { if (ctySort === col) setCtyDir(d => d === 'asc' ? 'desc' : 'asc'); else { setCtySort(col); setCtyDir('asc'); } };
  const arrow = (active, col, dir) => active === col ? (dir === 'asc' ? ' ↑' : ' ↓') : '';

  const activeRegions   = regions.filter(r => r.active).length;
  const inactiveRegions = regions.length - activeRegions;

  return (
    <div>
      {/* ═══ COVERAGE REGIONS ═══ */}
      <div style={{ fontSize:15, fontWeight:700, color:'#0f172a', marginBottom:12 }}>Coverage Regions</div>

      {/* Stats bar */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(110px, 1fr))', gap:8, marginBottom:14 }}>
        {[
          { label:'Regions', value:regions.length, color:'#3b82f6' },
          { label:'Active', value:activeRegions, color:'#10b981' },
          { label:'Inactive', value:inactiveRegions, color: inactiveRegions > 0 ? '#f59e0b' : '#10b981' },
        ].map(s => (
          <div key={s.label} style={{ background:'#fff', borderRadius:9, padding:'10px 14px', border:'1px solid rgba(0,0,0,0.05)' }}>
            <div style={{ fontSize:9.5, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.06em', color:'#94a3b8', marginBottom:3 }}>{s.label}</div>
            <div style={{ fontSize:20, fontWeight:800, color:s.color, letterSpacing:'-0.02em' }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Region toolbar */}
      <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:12, alignItems:'center' }}>
        <div style={{ flex:'1 1 180px', position:'relative' }}>
          <span style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#94a3b8', fontSize:13 }}>⌕</span>
          <input value={regSearch} onChange={e => setRegSearch(e.target.value)} placeholder="Search regions..." style={{ ...inputStyle, paddingLeft:30 }} />
        </div>
        <select value={regActive} onChange={e => setRegActive(e.target.value)} style={selectStyle}>
          <option value="all">All Status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>

      {/* Region table */}
      <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:10, overflow:'hidden', marginBottom:28 }}>
        <div style={{ display:'grid', gridTemplateColumns:'2fr 1.2fr 1.2fr 0.8fr 0.6fr', gap:0, padding:'10px 16px', background:'#f8fafc', borderBottom:'1px solid #e2e8f0', fontSize:10.5, fontWeight:700, color:'#94a3b8', textTransform:'uppercase', letterSpacing:'0.06em' }}>
          <div style={{ cursor:'pointer' }} onClick={() => handleRegSort('region_name')}>Region{arrow(regSort,'region_name',regDir)}</div>
          <div style={{ cursor:'pointer' }} onClick={() => handleRegSort('office_assignment')}>Office{arrow(regSort,'office_assignment',regDir)}</div>
          <div>Description</div>
          <div style={{ cursor:'pointer' }} onClick={() => handleRegSort('counties')}>Counties{arrow(regSort,'counties',regDir)}</div>
          <div>Status</div>
        </div>
        {filteredRegions.length === 0 && (
          <div style={{ padding:'36px 20px', textAlign:'center', color:'#94a3b8' }}>
            <div style={{ fontSize:13, fontWeight:600 }}>No regions match your filters</div>
          </div>
        )}
        {filteredRegions.map(r => (
          <div key={r.region_id} style={{
            display:'grid', gridTemplateColumns:'2fr 1.2fr 1.2fr 0.8fr 0.6fr',
            gap:0, padding:'11px 16px', borderBottom:'1px solid #f1f5f9',
            opacity: r.active ? 1 : 0.55, transition:'background 0.1s',
          }}
            onMouseEnter={e => { e.currentTarget.style.background = '#f8fafc'; }}
            onMouseLeave={e => { e.currentTarget.style.background = ''; }}
          >
            <div style={{ fontSize:12.5, fontWeight:600, color:'#0f172a' }}>{r.region_name}</div>
            <div style={{ fontSize:12, color:'#475569' }}>{r.office_assignment || '—'}</div>
            <div style={{ fontSize:11, color:'#94a3b8', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.description || '—'}</div>
            <div style={{ fontSize:13, fontWeight:700, color:'#0f172a' }}>{countyCountByRegion[r.region_id] || 0}</div>
            <div><span style={{ fontSize:10, fontWeight:600, padding:'2px 8px', borderRadius:4, background: r.active ? '#dcfce7' : '#f1f5f9', color: r.active ? '#166534' : '#94a3b8' }}>{r.active ? 'Active' : 'Inactive'}</span></div>
          </div>
        ))}
      </div>
      <div style={{ fontSize:11, color:'#94a3b8', textAlign:'right', marginTop:-22, marginBottom:24 }}>Showing {filteredRegions.length} of {regions.length} regions</div>

      {/* ═══ COUNTY MAPPING ═══ */}
      <div style={{ fontSize:15, fontWeight:700, color:'#0f172a', marginBottom:12 }}>County Mapping</div>

      {/* County stats */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(110px, 1fr))', gap:8, marginBottom:14 }}>
        {[
          { label:'Counties', value:counties.length, color:'#3b82f6' },
          { label:'States', value:states.length, color:'#8b5cf6' },
          { label:'Regions Referenced', value:Object.keys(countyCountByRegion).length, color:'#10b981' },
        ].map(s => (
          <div key={s.label} style={{ background:'#fff', borderRadius:9, padding:'10px 14px', border:'1px solid rgba(0,0,0,0.05)' }}>
            <div style={{ fontSize:9.5, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.06em', color:'#94a3b8', marginBottom:3 }}>{s.label}</div>
            <div style={{ fontSize:20, fontWeight:800, color:s.color, letterSpacing:'-0.02em' }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* County toolbar */}
      <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:12, alignItems:'center' }}>
        <div style={{ flex:'1 1 180px', position:'relative' }}>
          <span style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#94a3b8', fontSize:13 }}>⌕</span>
          <input value={ctySearch} onChange={e => setCtySearch(e.target.value)} placeholder="Search county, state, region, office..." style={{ ...inputStyle, paddingLeft:30 }} />
        </div>
        <select value={ctyState} onChange={e => setCtyState(e.target.value)} style={selectStyle}>
          <option value="all">All States</option>
          {states.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* County table */}
      <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:10, overflow:'hidden' }}>
        <div style={{ display:'grid', gridTemplateColumns:'2fr 0.8fr 1.5fr 1.2fr', gap:0, padding:'10px 16px', background:'#f8fafc', borderBottom:'1px solid #e2e8f0', fontSize:10.5, fontWeight:700, color:'#94a3b8', textTransform:'uppercase', letterSpacing:'0.06em' }}>
          <div style={{ cursor:'pointer' }} onClick={() => handleCtySort('county_name')}>County{arrow(ctySort,'county_name',ctyDir)}</div>
          <div style={{ cursor:'pointer' }} onClick={() => handleCtySort('state')}>State{arrow(ctySort,'state',ctyDir)}</div>
          <div style={{ cursor:'pointer' }} onClick={() => handleCtySort('coverage_region')}>Region{arrow(ctySort,'coverage_region',ctyDir)}</div>
          <div style={{ cursor:'pointer' }} onClick={() => handleCtySort('office_assignment')}>Office{arrow(ctySort,'office_assignment',ctyDir)}</div>
        </div>
        {filteredCounties.length === 0 && (
          <div style={{ padding:'36px 20px', textAlign:'center', color:'#94a3b8' }}>
            <div style={{ fontSize:13, fontWeight:600 }}>No counties match your filters</div>
          </div>
        )}
        {filteredCounties.map((c, i) => (
          <div key={`${c.state}-${c.county_name}-${i}`} style={{
            display:'grid', gridTemplateColumns:'2fr 0.8fr 1.5fr 1.2fr',
            gap:0, padding:'11px 16px', borderBottom:'1px solid #f1f5f9', transition:'background 0.1s',
          }}
            onMouseEnter={e => { e.currentTarget.style.background = '#f8fafc'; }}
            onMouseLeave={e => { e.currentTarget.style.background = ''; }}
          >
            <div style={{ fontSize:12.5, fontWeight:600, color:'#0f172a' }}>{c.county_name}</div>
            <div style={{ fontSize:12, color:'#475569', fontWeight:600 }}>{c.state}</div>
            <div style={{ fontSize:12, color:'#64748b' }}>{c.coverage_region || '—'}</div>
            <div style={{ fontSize:12, color:'#64748b' }}>{c.office_assignment || '—'}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize:11, color:'#94a3b8', textAlign:'right', marginTop:8 }}>Showing {filteredCounties.length} of {counties.length} counties</div>
    </div>
  );
}

function FamiliesTable({ families, sources }) {
  const [search, setSearch] = useState('');
  const [tierFilter, setTierFilter] = useState('all');
  const [roleFilter, setRoleFilter] = useState('all');
  const [sortBy, setSortBy] = useState('sort_order');
  const [sortDir, setSortDir] = useState('asc');
  const ROLE_LABELS = { primary_detection:'Primary Detection', early_signal:'Early Signal', supporting_evidence:'Supporting Evidence', source_discovery:'Source Discovery' };
  const ROLE_COLORS = { primary_detection:'#0f172a', early_signal:'#3b82f6', supporting_evidence:'#94a3b8', source_discovery:'#a78bfa' };
  const sourcesByFamily = useMemo(() => {
    const m = {};
    sources.forEach(s => {
      if (s.source_family && s.active !== false) {
        if (!m[s.source_family]) m[s.source_family] = { count:0, entityIds:new Set() };
        m[s.source_family].count++;
        if (s.entity_id) m[s.source_family].entityIds.add(s.entity_id);
      }
    });
    return m;
  }, [sources]);
  const enriched = useMemo(() => {
    return families.map(f => {
      const stats = sourcesByFamily[f.family_id] || { count:0, entityIds:new Set() };
      return { ...f, _srcCount: stats.count, _entCount: stats.entityIds.size };
    });
  }, [families, sourcesByFamily]);
  const tiers = useMemo(() => [...new Set(families.map(f => f.default_tier).filter(Boolean))].sort(), [families]);
  const roles = useMemo(() => [...new Set(families.map(f => f.detection_role).filter(Boolean))], [families]);
  const filtered = useMemo(() => {
    let r = [...enriched];
    if (search) {
      const q = search.toLowerCase();
      r = r.filter(f =>
        f.family_id?.toLowerCase().includes(q) ||
        f.family_name?.toLowerCase().includes(q) ||
        (ROLE_LABELS[f.detection_role] || '').toLowerCase().includes(q) ||
        f.default_cadence?.toLowerCase().includes(q) ||
        f.description?.toLowerCase().includes(q)
      );
    }
    if (tierFilter !== 'all') r = r.filter(f => f.default_tier === tierFilter);
    if (roleFilter !== 'all') r = r.filter(f => f.detection_role === roleFilter);
    r.sort((a, b) => {
      let va, vb;
      if (sortBy === 'id') { va = a.family_id || ''; vb = b.family_id || ''; }
      else if (sortBy === 'name') { va = a.family_name || ''; vb = b.family_name || ''; }
      else if (sortBy === 'tier') { va = a.default_tier || ''; vb = b.default_tier || ''; }
      else if (sortBy === 'priority') { return sortDir === 'asc' ? (a.scan_priority||99) - (b.scan_priority||99) : (b.scan_priority||99) - (a.scan_priority||99); }
      else if (sortBy === 'sources') { return sortDir === 'asc' ? a._srcCount - b._srcCount : b._srcCount - a._srcCount; }
      else if (sortBy === 'entities') { return sortDir === 'asc' ? a._entCount - b._entCount : b._entCount - a._entCount; }
      else if (sortBy === 'sort_order') { return sortDir === 'asc' ? (a.sort_order||99) - (b.sort_order||99) : (b.sort_order||99) - (a.sort_order||99); }
      else { va = a.family_id || ''; vb = b.family_id || ''; }
      if (typeof va === 'string') { const cmp = va.localeCompare(vb); return sortDir === 'asc' ? cmp : -cmp; }
      return 0;
    });
    return r;
  }, [enriched, search, tierFilter, roleFilter, sortBy, sortDir]);
  const handleSort = (col) => {
    if (sortBy === col) { setSortDir(d => d === 'asc' ? 'desc' : 'asc'); }
    else { setSortBy(col); setSortDir('asc'); }
  };
  const sortArrow = (col) => sortBy === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
  const coveredCount = enriched.filter(f => f._srcCount > 0).length;
  const uncoveredCount = enriched.filter(f => f._srcCount === 0).length;
  return (
    <div>
      {/* Stats */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(120px, 1fr))', gap:8, marginBottom:16 }}>
        {[
          { label:'Families', value:families.length, color:'#3b82f6' },
          { label:'With Sources', value:coveredCount, color:'#10b981' },
          { label:'No Sources', value:uncoveredCount, color: uncoveredCount > 0 ? '#f59e0b' : '#10b981' },
          { label:'Total Sources', value:sources.filter(s => s.active !== false).length, color:'#64748b' },
        ].map(s => (
          <div key={s.label} style={{ background:'#fff', borderRadius:9, padding:'10px 14px', border:'1px solid rgba(0,0,0,0.05)' }}>
            <div style={{ fontSize:9.5, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.06em', color:'#94a3b8', marginBottom:3 }}>{s.label}</div>
            <div style={{ fontSize:20, fontWeight:800, color:s.color, letterSpacing:'-0.02em' }}>{s.value}</div>
          </div>
        ))}
      </div>
      {/* Toolbar */}
      <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:14, alignItems:'center' }}>
        <div style={{ flex:'1 1 200px', position:'relative' }}>
          <span style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#94a3b8', fontSize:13 }}>⌕</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search family name, role, cadence, description..." style={{ ...inputStyle, paddingLeft:30 }} />
        </div>
        <select value={tierFilter} onChange={e => setTierFilter(e.target.value)} style={selectStyle}>
          <option value="all">All Tiers</option>
          {tiers.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={roleFilter} onChange={e => setRoleFilter(e.target.value)} style={selectStyle}>
          <option value="all">All Roles</option>
          {roles.map(r => <option key={r} value={r}>{ROLE_LABELS[r] || r}</option>)}
        </select>
      </div>
      {/* Table */}
      <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:10, overflow:'hidden' }}>
        <div style={{ display:'grid', gridTemplateColumns:'0.5fr 2fr 0.6fr 0.5fr 1fr 0.7fr 0.5fr 0.5fr', gap:0, padding:'10px 16px', background:'#f8fafc', borderBottom:'1px solid #e2e8f0', fontSize:10.5, fontWeight:700, color:'#94a3b8', textTransform:'uppercase', letterSpacing:'0.06em' }}>
          <div style={{ cursor:'pointer' }} onClick={() => handleSort('id')}>ID{sortArrow('id')}</div>
          <div style={{ cursor:'pointer' }} onClick={() => handleSort('name')}>Family{sortArrow('name')}</div>
          <div style={{ cursor:'pointer' }} onClick={() => handleSort('tier')}>Tier{sortArrow('tier')}</div>
          <div style={{ cursor:'pointer' }} onClick={() => handleSort('priority')}>Pri{sortArrow('priority')}</div>
          <div>Role</div>
          <div>Cadence</div>
          <div style={{ cursor:'pointer' }} onClick={() => handleSort('sources')}>Src{sortArrow('sources')}</div>
          <div style={{ cursor:'pointer' }} onClick={() => handleSort('entities')}>Ent{sortArrow('entities')}</div>
        </div>
        {filtered.length === 0 && (
          <div style={{ padding:'48px 20px', textAlign:'center', color:'#94a3b8' }}>
            <div style={{ fontSize:14, fontWeight:600, marginBottom:4 }}>No families match your filters</div>
            <div style={{ fontSize:12.5 }}>Try adjusting your search or filter criteria</div>
          </div>
        )}
        {filtered.map(f => {
          const noSources = f._srcCount === 0;
          const tierColor = TIER_COLORS[f.default_tier] || '#94a3b8';
          const roleColor = ROLE_COLORS[f.detection_role] || '#94a3b8';
          const roleLabel = ROLE_LABELS[f.detection_role] || f.detection_role || '—';
          return (
            <div key={f.family_id} style={{
              display:'grid', gridTemplateColumns:'0.5fr 2fr 0.6fr 0.5fr 1fr 0.7fr 0.5fr 0.5fr',
              gap:0, padding:'12px 16px', borderBottom:'1px solid #f1f5f9',
              background: noSources ? '#fef2f2' : '#fff', transition:'background 0.1s',
            }}
              onMouseEnter={e => { if (!noSources) e.currentTarget.style.background = '#f8fafc'; }}
              onMouseLeave={e => { e.currentTarget.style.background = noSources ? '#fef2f2' : '#fff'; }}
            >
              {/* ID */}
              <div style={{ fontSize:10, color:'#94a3b8', fontWeight:600, display:'flex', alignItems:'center' }}>{f.family_id}</div>
              {/* Name + description */}
              <div style={{ minWidth:0 }}>
                <div style={{ fontSize:12.5, fontWeight:600, color:'#0f172a', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{f.family_name}</div>
                {f.description && <div style={{ fontSize:10, color:'#94a3b8', marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{f.description}</div>}
              </div>
              {/* Tier */}
              <div style={{ display:'flex', alignItems:'center' }}>
                <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:4, background: tierColor === '#0f172a' ? '#0f172a' : tierColor + '18', color: tierColor === '#0f172a' ? '#fff' : tierColor }}>{f.default_tier?.replace('Tier ', 'T')}</span>
              </div>
              {/* Priority */}
              <div style={{ fontSize:12, color:'#475569', display:'flex', alignItems:'center', fontWeight:600 }}>{f.scan_priority}</div>
              {/* Role */}
              <div style={{ display:'flex', alignItems:'center' }}>
                <span style={{ fontSize:10, fontWeight:600, padding:'2px 8px', borderRadius:4, background: roleColor + '14', color: roleColor }}>{roleLabel}</span>
              </div>
              {/* Cadence */}
              <div style={{ fontSize:11, color:'#64748b', display:'flex', alignItems:'center' }}>{f.default_cadence || '—'}</div>
              {/* Source count */}
              <div style={{ fontSize:13, fontWeight:700, color: f._srcCount > 0 ? '#0f172a' : '#d1d5db', display:'flex', alignItems:'center' }}>{f._srcCount}</div>
              {/* Entity count */}
              <div style={{ fontSize:13, fontWeight:700, color: f._entCount > 0 ? '#0f172a' : '#d1d5db', display:'flex', alignItems:'center' }}>{f._entCount}</div>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop:10, fontSize:11, color:'#94a3b8', textAlign:'right' }}>Showing {filtered.length} of {families.length} families</div>
      {uncoveredCount > 0 && (
        <div style={{ marginTop:12, padding:'12px 16px', background:'#fef2f2', border:'1px solid #fecaca', borderRadius:8 }}>
          <div style={{ fontSize:11, fontWeight:700, color:'#991b1b', marginBottom:4 }}>Families with no seeded sources</div>
          <div style={{ fontSize:11, color:'#78716c' }}>
            {enriched.filter(f => f._srcCount === 0).map(f => f.family_name).join(' · ')}
          </div>
        </div>
      )}
    </div>
  );
}

function ProposedSourcesQueue({ proposals, entities, families, sources, onChanged }) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sortBy, setSortBy] = useState('date');
  const [sortDir, setSortDir] = useState('desc');
  const [editing, setEditing] = useState(null);
  const entityMap = useMemo(() => {
    const m = {};
    entities.forEach(e => { m[e.entity_id] = e.entity_name; });
    return m;
  }, [entities]);
  const familyMap = useMemo(() => {
    const m = {};
    families.forEach(f => { m[f.family_id] = f.family_name; });
    return m;
  }, [families]);
  const statuses = useMemo(() => [...new Set(proposals.map(p => p.status).filter(Boolean))], [proposals]);
  const filtered = useMemo(() => {
    let r = [...proposals];
    if (search) {
      const q = search.toLowerCase();
      r = r.filter(p =>
        (p.entity_name || entityMap[p.entity_id] || '').toLowerCase().includes(q) ||
        p.proposed_url?.toLowerCase().includes(q) ||
        p.why_proposed?.toLowerCase().includes(q) ||
        p.reviewer_notes?.toLowerCase().includes(q) ||
        (familyMap[p.detected_family] || '').toLowerCase().includes(q) ||
        p.detected_family?.toLowerCase().includes(q)
      );
    }
    if (statusFilter !== 'all') r = r.filter(p => p.status === statusFilter);
    r.sort((a, b) => {
      let va, vb;
      if (sortBy === 'date') { va = a.date_proposed || ''; vb = b.date_proposed || ''; }
      else if (sortBy === 'name') { va = a.entity_name || entityMap[a.entity_id] || ''; vb = b.entity_name || entityMap[b.entity_id] || ''; }
      else { va = a.date_proposed || ''; vb = b.date_proposed || ''; }
      const cmp = va.localeCompare(vb);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return r;
  }, [proposals, search, statusFilter, sortBy, sortDir, entityMap, familyMap]);
  const handleSort = (col) => {
    if (sortBy === col) { setSortDir(d => d === 'asc' ? 'desc' : 'asc'); }
    else { setSortBy(col); setSortDir('desc'); }
  };
  const sortArrow = (col) => sortBy === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
  const handleAdd = () => {
    setEditing(createProposedSource({ discovered_from: 'human_suggestion' }));
  };
  const handleEdit = (p) => {
    setEditing({ ...p });
  };
  const handleSave = (form) => {
    const isNew = !proposals.find(p => p.proposed_id === form.proposed_id);
    let updated;
    if (isNew) {
      updated = [...proposals, form];
    } else {
      updated = proposals.map(p => p.proposed_id === form.proposed_id ? form : p);
    }
    setProposedSources(updated);
    setEditing(null);
    onChanged();
  };
  const handleApprove = (prop) => {
    const entityName = prop.entity_name || entityMap[prop.entity_id] || '';
    const newSource = createSource({
      source_name: entityName ? `${entityName} — proposed` : 'New Source (from proposal)',
      entity_id: prop.entity_id || '',
      source_family: prop.detected_family || 'SF-01',
      source_url: prop.proposed_url || '',
      priority_tier: 'Tier 2',
      check_frequency: 'Weekly',
      notes: `Approved from proposal. ${prop.why_proposed || ''}`.trim(),
      added_by: 'Proposed → Approved',
      date_added: new Date().toISOString().split('T')[0],
      active: true,
      fetch_health: 'untested',
    });
    const updatedSources = [...sources, newSource];
    setSources(updatedSources);
    const updatedProposals = proposals.map(p =>
      p.proposed_id === prop.proposed_id
        ? { ...p, status: 'approved', date_reviewed: new Date().toISOString().split('T')[0], approved_to_source_id: newSource.source_id }
        : p
    );
    setProposedSources(updatedProposals);
    onChanged();
  };
  const handleReject = (prop) => {
    const reason = prompt('Reason for rejection (optional):');
    if (reason === null) return;
    const updatedProposals = proposals.map(p =>
      p.proposed_id === prop.proposed_id
        ? { ...p, status: 'rejected', date_reviewed: new Date().toISOString().split('T')[0], reviewer_notes: reason || p.reviewer_notes }
        : p
    );
    setProposedSources(updatedProposals);
    onChanged();
  };
  const STATUS_STYLES = {
    pending: { bg: '#fef3c7', color: '#92400e', label: 'Pending' },
    approved: { bg: '#dcfce7', color: '#166534', label: 'Approved' },
    rejected: { bg: '#fef2f2', color: '#991b1b', label: 'Rejected' },
  };
  const pendingCount = proposals.filter(p => p.status === 'pending').length;
  const approvedCount = proposals.filter(p => p.status === 'approved').length;
  const rejectedCount = proposals.filter(p => p.status === 'rejected').length;
  return (
    <div>
      {/* Stats */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(110px, 1fr))', gap:8, marginBottom:16 }}>
        {[
          { label:'Total', value:proposals.length, color:'#3b82f6' },
          { label:'Pending', value:pendingCount, color: pendingCount > 0 ? '#f59e0b' : '#94a3b8' },
          { label:'Approved', value:approvedCount, color:'#10b981' },
          { label:'Rejected', value:rejectedCount, color:'#94a3b8' },
        ].map(s => (
          <div key={s.label} style={{ background:'#fff', borderRadius:9, padding:'10px 14px', border:'1px solid rgba(0,0,0,0.05)' }}>
            <div style={{ fontSize:9.5, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.06em', color:'#94a3b8', marginBottom:3 }}>{s.label}</div>
            <div style={{ fontSize:20, fontWeight:800, color:s.color, letterSpacing:'-0.02em' }}>{s.value}</div>
          </div>
        ))}
      </div>
      {/* Toolbar */}
      <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:14, alignItems:'center' }}>
        <div style={{ flex:'1 1 200px', position:'relative' }}>
          <span style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#94a3b8', fontSize:13 }}>⌕</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search proposals..." style={{ ...inputStyle, paddingLeft:30 }} />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="all">All Status</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
        <button onClick={handleAdd} style={{ padding:'8px 16px', borderRadius:7, border:'none', background:'#0f172a', color:'#fff', cursor:'pointer', fontSize:12, fontWeight:600, display:'flex', alignItems:'center', gap:5, whiteSpace:'nowrap' }}>+ Add Proposed Source</button>
      </div>
      {/* Empty state */}
      {proposals.length === 0 && (
        <Card>
          <div style={{ textAlign:'center', padding:'30px 0' }}>
            <div style={{ fontSize:14, fontWeight:600, color:'#64748b', marginBottom:6 }}>No proposed sources yet</div>
            <div style={{ fontSize:12.5, color:'#94a3b8', lineHeight:1.6, maxWidth:400, margin:'0 auto' }}>
              Proposed sources appear here when discovered by the AI intake engine or added manually. Click "Add Proposed Source" to test the review workflow.
            </div>
          </div>
        </Card>
      )}
      {/* Table */}
      {proposals.length > 0 && (
        <>
          <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:10, overflow:'hidden' }}>
            <div style={{ display:'grid', gridTemplateColumns:'1.5fr 1.5fr 1fr 0.7fr 0.6fr 0.7fr', gap:0, padding:'10px 16px', background:'#f8fafc', borderBottom:'1px solid #e2e8f0', fontSize:10.5, fontWeight:700, color:'#94a3b8', textTransform:'uppercase', letterSpacing:'0.06em' }}>
              <div style={{ cursor:'pointer' }} onClick={() => handleSort('name')}>Entity / Name{sortArrow('name')}</div>
              <div>URL</div>
              <div>Family</div>
              <div>Status</div>
              <div style={{ cursor:'pointer' }} onClick={() => handleSort('date')}>Date{sortArrow('date')}</div>
              <div style={{ textAlign:'right' }}>Actions</div>
            </div>
            {filtered.length === 0 && (
              <div style={{ padding:'36px 20px', textAlign:'center', color:'#94a3b8' }}>
                <div style={{ fontSize:14, fontWeight:600, marginBottom:4 }}>No proposals match your filters</div>
              </div>
            )}
            {filtered.map(prop => {
              const entName = prop.entity_name || entityMap[prop.entity_id] || '—';
              const famName = familyMap[prop.detected_family] || prop.detected_family || '—';
              const famShort = famName.split('/')[0].split('(')[0].trim();
              const st = STATUS_STYLES[prop.status] || STATUS_STYLES.pending;
              const isPending = prop.status === 'pending';
              return (
                <div key={prop.proposed_id} style={{
                  display:'grid', gridTemplateColumns:'1.5fr 1.5fr 1fr 0.7fr 0.6fr 0.7fr',
                  gap:0, padding:'12px 16px', borderBottom:'1px solid #f1f5f9',
                  background: prop.status === 'rejected' ? '#fafafa' : '#fff',
                  opacity: prop.status === 'rejected' ? 0.6 : 1,
                  transition:'background 0.1s',
                }}
                  onMouseEnter={e => { if (prop.status !== 'rejected') e.currentTarget.style.background = '#f8fafc'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = prop.status === 'rejected' ? '#fafafa' : '#fff'; }}
                >
                  <div style={{ minWidth:0 }}>
                    <div style={{ fontSize:12.5, fontWeight:600, color:'#0f172a', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{entName}</div>
                    {prop.why_proposed && <div style={{ fontSize:10, color:'#94a3b8', marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{prop.why_proposed}</div>}
                    {prop.reviewer_notes && prop.status === 'rejected' && <div style={{ fontSize:10, color:'#dc2626', marginTop:2 }}>Reason: {prop.reviewer_notes}</div>}
                  </div>
                  <div style={{ minWidth:0, display:'flex', alignItems:'center' }}>
                    {prop.proposed_url ? (
                      <a href={prop.proposed_url} target="_blank" rel="noreferrer" style={{ fontSize:10.5, color:'#3b82f6', textDecoration:'none', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', display:'block' }}
                        onMouseEnter={e => e.target.style.textDecoration='underline'} onMouseLeave={e => e.target.style.textDecoration='none'}>
                        {prop.proposed_url.replace(/^https?:\/\//, '').slice(0,40)}{prop.proposed_url.length > 48 ? '...' : ''}
                      </a>
                    ) : <span style={{ fontSize:10.5, color:'#d1d5db', fontStyle:'italic' }}>No URL</span>}
                  </div>
                  <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                    <span style={{ fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:4, background:'#f1f5f9', color:'#64748b' }}>{prop.detected_family}</span>
                    <span style={{ fontSize:10, color:'#64748b', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{famShort}</span>
                  </div>
                  <div style={{ display:'flex', alignItems:'center' }}>
                    <span style={{ fontSize:10, fontWeight:600, padding:'2px 8px', borderRadius:4, background:st.bg, color:st.color }}>{st.label}</span>
                  </div>
                  <div style={{ fontSize:11, color:'#94a3b8', display:'flex', alignItems:'center' }}>{prop.date_proposed || '—'}</div>
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'flex-end', gap:3 }}>
                    {isPending && (
                      <>
                        <button onClick={() => handleApprove(prop)} style={{ padding:'3px 7px', borderRadius:5, border:'1px solid #d1fae5', background:'#fff', cursor:'pointer', fontSize:10, fontWeight:600, color:'#166534' }}>✓</button>
                        <button onClick={() => handleReject(prop)} style={{ padding:'3px 7px', borderRadius:5, border:'1px solid #fecaca', background:'#fff', cursor:'pointer', fontSize:10, fontWeight:600, color:'#dc2626' }}>✕</button>
                      </>
                    )}
                    <button onClick={() => handleEdit(prop)} style={{ padding:'3px 7px', borderRadius:5, border:'1px solid #e2e8f0', background:'#fff', cursor:'pointer', fontSize:10, fontWeight:600, color:'#475569' }}>Edit</button>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop:8, fontSize:11, color:'#94a3b8', textAlign:'right' }}>Showing {filtered.length} of {proposals.length} proposals</div>
        </>
      )}
      {editing && (
        <ProposedSourceEditModal
          proposal={editing}
          entities={entities}
          families={families}
          isNew={!proposals.find(p => p.proposed_id === editing.proposed_id)}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ProposedSourceEditModal({ proposal, entities, families, isNew, onSave, onCancel }) {
  const [form, setForm] = useState({ ...proposal });
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const handleSubmit = () => {
    if (!form.proposed_url && !form.entity_name) return;
    onSave(form);
  };
  const modalField = { marginBottom: 14 };
  const modalLabel = { display: 'block', fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' };
  return (
    <>
      <div onClick={onCancel} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.3)', zIndex:999 }} />
      <div style={{ position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)', width:'100%', maxWidth:500, maxHeight:'90vh', overflow:'auto', background:'#fff', borderRadius:12, boxShadow:'0 20px 60px rgba(0,0,0,0.15)', zIndex:1000, padding:'24px 28px' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
          <h3 style={{ fontSize:16, fontWeight:700, color:'#0f172a', margin:0 }}>{isNew ? 'Add Proposed Source' : 'Edit Proposal'}</h3>
          <button onClick={onCancel} style={{ background:'none', border:'none', cursor:'pointer', fontSize:18, color:'#94a3b8', padding:4 }}>✕</button>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, ...modalField }}>
          <div>
            <label style={modalLabel}>Entity</label>
            <select value={form.entity_id || ''} onChange={e => { set('entity_id', e.target.value); const ent = entities.find(x => x.entity_id === e.target.value); if (ent) set('entity_name', ent.entity_name); }} style={{ ...inputStyle }}>
              <option value="">— Select or leave blank —</option>
              {entities.map(e => <option key={e.entity_id} value={e.entity_id}>{e.entity_name}</option>)}
            </select>
          </div>
          <div>
            <label style={modalLabel}>Or enter entity name</label>
            <input value={form.entity_name || ''} onChange={e => set('entity_name', e.target.value)} style={inputStyle} placeholder="New entity name..." />
          </div>
        </div>
        <div style={modalField}>
          <label style={modalLabel}>Proposed URL</label>
          <input value={form.proposed_url || ''} onChange={e => set('proposed_url', e.target.value)} style={inputStyle} placeholder="https://..." />
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, ...modalField }}>
          <div>
            <label style={modalLabel}>Detected Family</label>
            <select value={form.detected_family || 'SF-01'} onChange={e => set('detected_family', e.target.value)} style={{ ...inputStyle }}>
              {families.map(f => <option key={f.family_id} value={f.family_id}>{f.family_id} — {f.family_name.split('(')[0].trim().slice(0,30)}</option>)}
            </select>
          </div>
          <div>
            <label style={modalLabel}>Discovered From</label>
            <select value={form.discovered_from || 'human_suggestion'} onChange={e => set('discovered_from', e.target.value)} style={{ ...inputStyle }}>
              <option value="human_suggestion">Human Suggestion</option>
              <option value="ai_intake">AI Intake</option>
              <option value="source_discovery">Source Discovery</option>
              <option value="other">Other</option>
            </select>
          </div>
        </div>
        <div style={modalField}>
          <label style={modalLabel}>Why Proposed / Rationale</label>
          <textarea value={form.why_proposed || ''} onChange={e => set('why_proposed', e.target.value)} rows={2} style={{ ...inputStyle, resize:'vertical', fontFamily:'inherit' }} placeholder="Why should this source be tracked?" />
        </div>
        <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:20 }}>
          <button onClick={onCancel} style={{ padding:'9px 18px', borderRadius:7, border:'1px solid #e2e8f0', background:'#fff', cursor:'pointer', fontSize:12.5, fontWeight:600, color:'#64748b' }}>Cancel</button>
          <button onClick={handleSubmit} style={{ padding:'9px 18px', borderRadius:7, border:'none', background:'#0f172a', cursor:'pointer', fontSize:12.5, fontWeight:600, color:'#fff', opacity: (form.proposed_url || form.entity_name) ? 1 : 0.4 }}>
            {isNew ? 'Add Proposal' : 'Save Changes'}
          </button>
        </div>
      </div>
    </>
  );
}

function ProposedEntitiesQueue({ proposals, entities, regions, onChanged }) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sortBy, setSortBy] = useState('date');
  const [sortDir, setSortDir] = useState('desc');
  const [editing, setEditing] = useState(null);
  const typeLabelMap = useMemo(() => {
    const m = {};
    ENTITY_TYPES.forEach(t => { m[t.value] = t.label; });
    return m;
  }, []);
  const statuses = useMemo(() => [...new Set(proposals.map(p => p.status).filter(Boolean))], [proposals]);
  const filtered = useMemo(() => {
    let r = [...proposals];
    if (search) {
      const q = search.toLowerCase();
      r = r.filter(p =>
        p.entity_name?.toLowerCase().includes(q) ||
        (typeLabelMap[p.entity_type] || '').toLowerCase().includes(q) ||
        p.state?.toLowerCase().includes(q) ||
        p.primary_area?.toLowerCase().includes(q) ||
        p.why_proposed?.toLowerCase().includes(q) ||
        p.reviewer_notes?.toLowerCase().includes(q)
      );
    }
    if (statusFilter !== 'all') r = r.filter(p => p.status === statusFilter);
    r.sort((a, b) => {
      let va, vb;
      if (sortBy === 'date') { va = a.date_proposed || ''; vb = b.date_proposed || ''; }
      else if (sortBy === 'name') { va = a.entity_name || ''; vb = b.entity_name || ''; }
      else if (sortBy === 'state') { va = a.state || ''; vb = b.state || ''; }
      else { va = a.date_proposed || ''; vb = b.date_proposed || ''; }
      const cmp = va.localeCompare(vb);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return r;
  }, [proposals, search, statusFilter, sortBy, sortDir, typeLabelMap]);
  const handleSort = (col) => {
    if (sortBy === col) { setSortDir(d => d === 'asc' ? 'desc' : 'asc'); }
    else { setSortBy(col); setSortDir('desc'); }
  };
  const sortArrow = (col) => sortBy === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
  const handleAdd = () => {
    setEditing(createProposedEntity({ discovered_from: 'human_suggestion' }));
  };
  const handleEdit = (p) => {
    setEditing({ ...p });
  };
  const handleSave = (form) => {
    const isNew = !proposals.find(p => p.proposed_id === form.proposed_id);
    let updated;
    if (isNew) {
      updated = [...proposals, form];
    } else {
      updated = proposals.map(p => p.proposed_id === form.proposed_id ? form : p);
    }
    setProposedEntities(updated);
    setEditing(null);
    onChanged();
  };
  const handleApprove = (prop) => {
    const newEntity = createEntity({
      entity_name: prop.entity_name || 'New Entity (from proposal)',
      entity_type: prop.entity_type || 'other',
      state: prop.state || '',
      primary_area: prop.primary_area || '',
      coverage_regions: [],
      official_site: null,
      procurement_url: null,
      notes: `Approved from proposal. ${prop.why_proposed || ''}`.trim(),
      added_by: 'Proposed → Approved',
      date_added: new Date().toISOString().split('T')[0],
      active: true,
    });
    const updatedEntities = [...entities, newEntity];
    setEntities(updatedEntities);
    const updatedProposals = proposals.map(p =>
      p.proposed_id === prop.proposed_id
        ? { ...p, status: 'approved', date_reviewed: new Date().toISOString().split('T')[0], approved_to_entity_id: newEntity.entity_id }
        : p
    );
    setProposedEntities(updatedProposals);
    onChanged();
  };
  const handleReject = (prop) => {
    const reason = prompt('Reason for rejection (optional):');
    if (reason === null) return;
    const updatedProposals = proposals.map(p =>
      p.proposed_id === prop.proposed_id
        ? { ...p, status: 'rejected', date_reviewed: new Date().toISOString().split('T')[0], reviewer_notes: reason || p.reviewer_notes }
        : p
    );
    setProposedEntities(updatedProposals);
    onChanged();
  };
  const STATUS_STYLES = {
    pending: { bg: '#fef3c7', color: '#92400e', label: 'Pending' },
    approved: { bg: '#dcfce7', color: '#166534', label: 'Approved' },
    rejected: { bg: '#fef2f2', color: '#991b1b', label: 'Rejected' },
  };
  const pendingCount = proposals.filter(p => p.status === 'pending').length;
  const approvedCount = proposals.filter(p => p.status === 'approved').length;
  const rejectedCount = proposals.filter(p => p.status === 'rejected').length;
  return (
    <div>
      {/* Stats */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(110px, 1fr))', gap:8, marginBottom:16 }}>
        {[
          { label:'Total', value:proposals.length, color:'#3b82f6' },
          { label:'Pending', value:pendingCount, color: pendingCount > 0 ? '#f59e0b' : '#94a3b8' },
          { label:'Approved', value:approvedCount, color:'#10b981' },
          { label:'Rejected', value:rejectedCount, color:'#94a3b8' },
        ].map(s => (
          <div key={s.label} style={{ background:'#fff', borderRadius:9, padding:'10px 14px', border:'1px solid rgba(0,0,0,0.05)' }}>
            <div style={{ fontSize:9.5, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.06em', color:'#94a3b8', marginBottom:3 }}>{s.label}</div>
            <div style={{ fontSize:20, fontWeight:800, color:s.color, letterSpacing:'-0.02em' }}>{s.value}</div>
          </div>
        ))}
      </div>
      {/* Toolbar */}
      <div style={{ display:'flex', flexWrap:'wrap', gap:8, marginBottom:14, alignItems:'center' }}>
        <div style={{ flex:'1 1 200px', position:'relative' }}>
          <span style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'#94a3b8', fontSize:13 }}>⌕</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search proposed entities..." style={{ ...inputStyle, paddingLeft:30 }} />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="all">All Status</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
        <button onClick={handleAdd} style={{ padding:'8px 16px', borderRadius:7, border:'none', background:'#0f172a', color:'#fff', cursor:'pointer', fontSize:12, fontWeight:600, display:'flex', alignItems:'center', gap:5, whiteSpace:'nowrap' }}>+ Add Proposed Entity</button>
      </div>
      {/* Empty state */}
      {proposals.length === 0 && (
        <Card>
          <div style={{ textAlign:'center', padding:'30px 0' }}>
            <div style={{ fontSize:14, fontWeight:600, color:'#64748b', marginBottom:6 }}>No proposed entities yet</div>
            <div style={{ fontSize:12.5, color:'#94a3b8', lineHeight:1.6, maxWidth:400, margin:'0 auto' }}>
              Proposed entities appear here when discovered by the AI intake engine or added manually. Click "Add Proposed Entity" to test the review workflow.
            </div>
          </div>
        </Card>
      )}
      {/* Table */}
      {proposals.length > 0 && (
        <>
          <div style={{ background:'#fff', border:'1px solid #e2e8f0', borderRadius:10, overflow:'hidden' }}>
            <div style={{ display:'grid', gridTemplateColumns:'1.5fr 1fr 0.5fr 0.8fr 0.6fr 0.6fr 0.6fr', gap:0, padding:'10px 16px', background:'#f8fafc', borderBottom:'1px solid #e2e8f0', fontSize:10.5, fontWeight:700, color:'#94a3b8', textTransform:'uppercase', letterSpacing:'0.06em' }}>
              <div style={{ cursor:'pointer' }} onClick={() => handleSort('name')}>Entity{sortArrow('name')}</div>
              <div>Type</div>
              <div style={{ cursor:'pointer' }} onClick={() => handleSort('state')}>State{sortArrow('state')}</div>
              <div>Area</div>
              <div>Status</div>
              <div style={{ cursor:'pointer' }} onClick={() => handleSort('date')}>Date{sortArrow('date')}</div>
              <div style={{ textAlign:'right' }}>Actions</div>
            </div>
            {filtered.length === 0 && (
              <div style={{ padding:'36px 20px', textAlign:'center', color:'#94a3b8' }}>
                <div style={{ fontSize:14, fontWeight:600, marginBottom:4 }}>No proposals match your filters</div>
              </div>
            )}
            {filtered.map(prop => {
              const typeLabel = typeLabelMap[prop.entity_type] || prop.entity_type || '—';
              const st = STATUS_STYLES[prop.status] || STATUS_STYLES.pending;
              const isPending = prop.status === 'pending';
              return (
                <div key={prop.proposed_id} style={{
                  display:'grid', gridTemplateColumns:'1.5fr 1fr 0.5fr 0.8fr 0.6fr 0.6fr 0.6fr',
                  gap:0, padding:'12px 16px', borderBottom:'1px solid #f1f5f9',
                  background: prop.status === 'rejected' ? '#fafafa' : '#fff',
                  opacity: prop.status === 'rejected' ? 0.6 : 1,
                  transition:'background 0.1s',
                }}
                  onMouseEnter={e => { if (prop.status !== 'rejected') e.currentTarget.style.background = '#f8fafc'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = prop.status === 'rejected' ? '#fafafa' : '#fff'; }}
                >
                  <div style={{ minWidth:0 }}>
                    <div style={{ fontSize:12.5, fontWeight:600, color:'#0f172a', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{prop.entity_name || '—'}</div>
                    {prop.why_proposed && <div style={{ fontSize:10, color:'#94a3b8', marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{prop.why_proposed}</div>}
                    {prop.reviewer_notes && prop.status === 'rejected' && <div style={{ fontSize:10, color:'#dc2626', marginTop:2 }}>Reason: {prop.reviewer_notes}</div>}
                  </div>
                  <div style={{ fontSize:11.5, color:'#475569', display:'flex', alignItems:'center' }}>{typeLabel}</div>
                  <div style={{ fontSize:12, color:'#475569', display:'flex', alignItems:'center' }}>{prop.state || '—'}</div>
                  <div style={{ fontSize:11.5, color:'#64748b', display:'flex', alignItems:'center', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{prop.primary_area || '—'}</div>
                  <div style={{ display:'flex', alignItems:'center' }}>
                    <span style={{ fontSize:10, fontWeight:600, padding:'2px 8px', borderRadius:4, background:st.bg, color:st.color }}>{st.label}</span>
                  </div>
                  <div style={{ fontSize:11, color:'#94a3b8', display:'flex', alignItems:'center' }}>{prop.date_proposed || '—'}</div>
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'flex-end', gap:3 }}>
                    {isPending && (
                      <>
                        <button onClick={() => handleApprove(prop)} style={{ padding:'3px 7px', borderRadius:5, border:'1px solid #d1fae5', background:'#fff', cursor:'pointer', fontSize:10, fontWeight:600, color:'#166534' }}>✓</button>
                        <button onClick={() => handleReject(prop)} style={{ padding:'3px 7px', borderRadius:5, border:'1px solid #fecaca', background:'#fff', cursor:'pointer', fontSize:10, fontWeight:600, color:'#dc2626' }}>✕</button>
                      </>
                    )}
                    <button onClick={() => handleEdit(prop)} style={{ padding:'3px 7px', borderRadius:5, border:'1px solid #e2e8f0', background:'#fff', cursor:'pointer', fontSize:10, fontWeight:600, color:'#475569' }}>Edit</button>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop:8, fontSize:11, color:'#94a3b8', textAlign:'right' }}>Showing {filtered.length} of {proposals.length} proposals</div>
        </>
      )}
      {editing && (
        <ProposedEntityEditModal
          proposal={editing}
          regions={regions}
          isNew={!proposals.find(p => p.proposed_id === editing.proposed_id)}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ProposedEntityEditModal({ proposal, regions, isNew, onSave, onCancel }) {
  const [form, setForm] = useState({ ...proposal });
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const handleSubmit = () => {
    if (!form.entity_name) return;
    onSave(form);
  };
  const modalField = { marginBottom: 14 };
  const modalLabel = { display: 'block', fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' };
  return (
    <>
      <div onClick={onCancel} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.3)', zIndex:999 }} />
      <div style={{ position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)', width:'100%', maxWidth:500, maxHeight:'90vh', overflow:'auto', background:'#fff', borderRadius:12, boxShadow:'0 20px 60px rgba(0,0,0,0.15)', zIndex:1000, padding:'24px 28px' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
          <h3 style={{ fontSize:16, fontWeight:700, color:'#0f172a', margin:0 }}>{isNew ? 'Add Proposed Entity' : 'Edit Proposal'}</h3>
          <button onClick={onCancel} style={{ background:'none', border:'none', cursor:'pointer', fontSize:18, color:'#94a3b8', padding:4 }}>✕</button>
        </div>
        <div style={modalField}>
          <label style={modalLabel}>Entity Name *</label>
          <input value={form.entity_name || ''} onChange={e => set('entity_name', e.target.value)} style={inputStyle} placeholder="e.g. City of Great Falls" />
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, ...modalField }}>
          <div>
            <label style={modalLabel}>Entity Type</label>
            <select value={form.entity_type || 'other'} onChange={e => set('entity_type', e.target.value)} style={{ ...inputStyle }}>
              {ENTITY_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <label style={modalLabel}>State</label>
            <input value={form.state || ''} onChange={e => set('state', e.target.value)} style={inputStyle} placeholder="MT" />
          </div>
        </div>
        <div style={modalField}>
          <label style={modalLabel}>Primary Area</label>
          <input value={form.primary_area || ''} onChange={e => set('primary_area', e.target.value)} style={inputStyle} placeholder="e.g. Great Falls, Statewide" />
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, ...modalField }}>
          <div>
            <label style={modalLabel}>Discovered From</label>
            <select value={form.discovered_from || 'human_suggestion'} onChange={e => set('discovered_from', e.target.value)} style={{ ...inputStyle }}>
              <option value="human_suggestion">Human Suggestion</option>
              <option value="ai_intake">AI Intake</option>
              <option value="source_discovery">Source Discovery</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label style={modalLabel}>Confidence</label>
            <input type="number" min="0" max="1" step="0.1" value={form.confidence || 0.5} onChange={e => set('confidence', parseFloat(e.target.value) || 0.5)} style={inputStyle} />
          </div>
        </div>
        <div style={modalField}>
          <label style={modalLabel}>Why Proposed / Rationale</label>
          <textarea value={form.why_proposed || ''} onChange={e => set('why_proposed', e.target.value)} rows={2} style={{ ...inputStyle, resize:'vertical', fontFamily:'inherit' }} placeholder="Why should this entity be tracked?" />
        </div>
        <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:20 }}>
          <button onClick={onCancel} style={{ padding:'9px 18px', borderRadius:7, border:'1px solid #e2e8f0', background:'#fff', cursor:'pointer', fontSize:12.5, fontWeight:600, color:'#64748b' }}>Cancel</button>
          <button onClick={handleSubmit} style={{ padding:'9px 18px', borderRadius:7, border:'none', background:'#0f172a', cursor:'pointer', fontSize:12.5, fontWeight:600, color:'#fff', opacity: form.entity_name ? 1 : 0.4 }}>
            {isNew ? 'Add Proposal' : 'Save Changes'}
          </button>
        </div>
      </div>
    </>
  );
}
