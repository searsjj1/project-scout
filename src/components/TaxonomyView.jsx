/**
 * Project Scout — Taxonomy Registry View
 * Editable registry for service fit, pursuit signals, market classification,
 * noise suppression, and client intelligence taxonomy.
 *
 * Subtabs: Service | Pursuit | Market | Noise | Client Intelligence
 * Each item supports: add, edit, deactivate, archive, parent/child, fit modes, keywords.
 */
import { useState, useEffect, useMemo } from 'react';
import { getTaxonomy, setTaxonomy, getClients, setClients } from '../data/storage.js';
import { createTaxonomyItem, createClient, TAXONOMY_GROUPS, FIT_MODES, TAXONOMY_STATUSES, CLIENT_STATUSES } from '../data/schemas.js';

const GROUP_TABS = [
  { id: 'service',             label: 'Service' },
  { id: 'pursuit',             label: 'Pursuit' },
  { id: 'market',              label: 'Market' },
  { id: 'noise',               label: 'Noise / Exclusion' },
  { id: 'client_intelligence', label: 'Client Intelligence' },
];

const FIT_MODE_LABELS = {
  strong_fit: 'Strong Fit',
  moderate_fit: 'Moderate Fit',
  monitor_only: 'Monitor Only',
  downrank: 'Downrank',
  exclude: 'Exclude',
};

const FIT_MODE_COLORS = {
  strong_fit:   { bg: '#dcfce7', fg: '#166534' },
  moderate_fit:  { bg: '#dbeafe', fg: '#1e40af' },
  monitor_only:  { bg: '#fef9c3', fg: '#854d0e' },
  downrank:      { bg: '#fed7aa', fg: '#9a3412' },
  exclude:       { bg: '#fecaca', fg: '#991b1b' },
};

const STATUS_COLORS = {
  active:   { bg: '#dcfce7', fg: '#166534' },
  inactive: { bg: '#f1f5f9', fg: '#64748b' },
  archived: { bg: '#e2e8f0', fg: '#94a3b8' },
};

export default function TaxonomyView() {
  const [group, setGroup] = useState('service');
  const [taxonomy, setTaxonomyState] = useState([]);
  const [clients, setClientsState] = useState([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [editingId, setEditingId] = useState(null);
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => {
    setTaxonomyState(getTaxonomy());
    setClientsState(getClients());
  }, [refreshKey]);

  const persist = (updated) => {
    setTaxonomy(updated);
    setTaxonomyState(updated);
  };
  const persistClients = (updated) => {
    setClients(updated);
    setClientsState(updated);
  };
  const refresh = () => { setRefreshKey(k => k + 1); setEditingId(null); setShowAdd(false); };

  const groupItems = useMemo(() =>
    taxonomy.filter(t => t.taxonomy_group === group).sort((a, b) => a.sort_order - b.sort_order),
    [taxonomy, group]
  );

  const topLevel = useMemo(() => groupItems.filter(t => !t.parent_id), [groupItems]);
  const childrenOf = (parentId) => groupItems.filter(t => t.parent_id === parentId);

  const groupCounts = useMemo(() => {
    const counts = {};
    for (const g of TAXONOMY_GROUPS) {
      counts[g] = taxonomy.filter(t => t.taxonomy_group === g && t.status === 'active').length;
    }
    return counts;
  }, [taxonomy]);

  return (
    <div>
      {/* Group tab nav */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 22, flexWrap: 'wrap' }}>
        {GROUP_TABS.map(t => {
          const active = group === t.id;
          return (
            <button key={t.id} onClick={() => { setGroup(t.id); setEditingId(null); setShowAdd(false); }} style={{
              padding: '9px 18px', borderRadius: 8, border: '1px solid',
              borderColor: active ? '#0f172a' : '#e2e8f0',
              background: active ? '#0f172a' : '#fff',
              color: active ? '#fff' : '#64748b',
              fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 7, transition: 'all 0.15s',
            }}>
              {t.label}
              <span style={{
                fontSize: 10, padding: '1px 7px', borderRadius: 10, fontWeight: 700,
                background: active ? 'rgba(255,255,255,0.18)' : '#f1f5f9',
                color: active ? '#fff' : '#94a3b8',
              }}>{groupCounts[t.id] || 0}</span>
            </button>
          );
        })}
      </div>

      {/* Group description */}
      <div style={{ fontSize: 12, color: '#64748b', marginBottom: 16 }}>
        {group === 'service' && 'Service lines and disciplines. Controls service-fit scoring for leads.'}
        {group === 'pursuit' && 'Pursuit signal types. Controls how keyword tiers drive pursuit scoring.'}
        {group === 'market' && 'Market sectors. Controls market classification and sector-based scoring.'}
        {group === 'noise' && 'Noise and exclusion patterns. Suppresses or downranks false leads.'}
        {group === 'client_intelligence' && 'Client intelligence categories. Foundation for future Client Registry.'}
      </div>

      {/* Add button */}
      <div style={{ marginBottom: 16 }}>
        <button onClick={() => { setShowAdd(true); setEditingId(null); }} style={{
          padding: '7px 16px', borderRadius: 6, border: '1px solid #e2e8f0',
          background: '#f8fafc', color: '#334155', fontSize: 12, fontWeight: 600,
          cursor: 'pointer',
        }}>+ Add Item</button>
      </div>

      {/* Add form */}
      {showAdd && (
        <TaxonomyItemForm
          group={group}
          parentOptions={topLevel}
          onSave={(item) => {
            persist([...taxonomy, item]);
            setShowAdd(false);
          }}
          onCancel={() => setShowAdd(false)}
        />
      )}

      {/* Items list with hierarchy */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {topLevel.map(item => (
          <div key={item.taxonomy_id}>
            <TaxonomyItemRow
              item={item}
              isChild={false}
              isEditing={editingId === item.taxonomy_id}
              parentOptions={[]}
              onEdit={() => setEditingId(editingId === item.taxonomy_id ? null : item.taxonomy_id)}
              onSave={(updated) => {
                persist(taxonomy.map(t => t.taxonomy_id === updated.taxonomy_id ? updated : t));
                setEditingId(null);
              }}
              onStatusChange={(newStatus) => {
                persist(taxonomy.map(t => t.taxonomy_id === item.taxonomy_id ? { ...t, status: newStatus, date_modified: new Date().toISOString().split('T')[0] } : t));
              }}
              onDelete={() => {
                if (confirm(`Remove "${item.label}"? This will also remove its children.`)) {
                  persist(taxonomy.filter(t => t.taxonomy_id !== item.taxonomy_id && t.parent_id !== item.taxonomy_id));
                }
              }}
            />
            {/* Children */}
            {childrenOf(item.taxonomy_id).map(child => (
              <TaxonomyItemRow
                key={child.taxonomy_id}
                item={child}
                isChild={true}
                isEditing={editingId === child.taxonomy_id}
                parentOptions={topLevel}
                onEdit={() => setEditingId(editingId === child.taxonomy_id ? null : child.taxonomy_id)}
                onSave={(updated) => {
                  persist(taxonomy.map(t => t.taxonomy_id === updated.taxonomy_id ? updated : t));
                  setEditingId(null);
                }}
                onStatusChange={(newStatus) => {
                  persist(taxonomy.map(t => t.taxonomy_id === child.taxonomy_id ? { ...t, status: newStatus, date_modified: new Date().toISOString().split('T')[0] } : t));
                }}
                onDelete={() => {
                  if (confirm(`Remove "${child.label}"?`)) {
                    persist(taxonomy.filter(t => t.taxonomy_id !== child.taxonomy_id));
                  }
                }}
              />
            ))}
          </div>
        ))}
      </div>

      {topLevel.length === 0 && !showAdd && (
        <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
          No taxonomy items in this group yet. Click "+ Add Item" to create one.
        </div>
      )}

      {/* Client Registry preview (only on client_intelligence tab) */}
      {group === 'client_intelligence' && (
        <ClientRegistryPreview clients={clients} onChanged={() => refresh()} persistClients={persistClients} />
      )}
    </div>
  );
}


/* ── Taxonomy Item Row ─────────────────────────────────────────── */

function TaxonomyItemRow({ item, isChild, isEditing, parentOptions, onEdit, onSave, onStatusChange, onDelete }) {
  const fitColor = FIT_MODE_COLORS[item.fit_mode] || FIT_MODE_COLORS.moderate_fit;
  const statusColor = STATUS_COLORS[item.status] || STATUS_COLORS.active;

  if (isEditing) {
    return (
      <TaxonomyItemForm
        group={item.taxonomy_group}
        existing={item}
        parentOptions={parentOptions}
        onSave={onSave}
        onCancel={onEdit}
      />
    );
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
      borderRadius: 8, border: '1px solid #f1f5f9', background: '#fff',
      marginLeft: isChild ? 28 : 0, opacity: item.status === 'archived' ? 0.5 : 1,
    }}>
      {/* Label */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>
          {isChild && <span style={{ color: '#cbd5e1', marginRight: 6 }}>└</span>}
          {item.label}
        </div>
        {item.notes && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{item.notes}</div>}
        {item.include_keywords.length > 0 && (
          <div style={{ fontSize: 10, color: '#64748b', marginTop: 3 }}>
            Keywords: {item.include_keywords.slice(0, 5).join(', ')}{item.include_keywords.length > 5 ? ` +${item.include_keywords.length - 5} more` : ''}
          </div>
        )}
      </div>

      {/* Fit mode badge */}
      <span style={{
        fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6,
        background: fitColor.bg, color: fitColor.fg,
      }}>{FIT_MODE_LABELS[item.fit_mode]}</span>

      {/* Status badge */}
      <span style={{
        fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 6,
        background: statusColor.bg, color: statusColor.fg,
      }}>{item.status}</span>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 4 }}>
        <SmallBtn label="Edit" onClick={onEdit} />
        {item.status === 'active' && <SmallBtn label="Deactivate" onClick={() => onStatusChange('inactive')} />}
        {item.status === 'inactive' && <SmallBtn label="Activate" onClick={() => onStatusChange('active')} />}
        {item.status !== 'archived' && <SmallBtn label="Archive" onClick={() => onStatusChange('archived')} />}
        {item.status === 'archived' && <SmallBtn label="Restore" onClick={() => onStatusChange('inactive')} />}
      </div>
    </div>
  );
}


/* ── Taxonomy Item Form (add / edit) ───────────────────────────── */

function TaxonomyItemForm({ group, existing, parentOptions = [], onSave, onCancel }) {
  const isNew = !existing;
  const [form, setForm] = useState(() => existing ? { ...existing } : createTaxonomyItem({ taxonomy_group: group }));
  const [kwInput, setKwInput] = useState('');
  const [exKwInput, setExKwInput] = useState('');

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSave = () => {
    if (!form.label.trim()) return alert('Label is required.');
    if (!form.item_key.trim()) {
      form.item_key = form.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    }
    form.date_modified = new Date().toISOString().split('T')[0];
    if (isNew) form.added_by = 'manual';
    onSave(form);
  };

  const addKeyword = (type) => {
    const input = type === 'include' ? kwInput : exKwInput;
    const field = type === 'include' ? 'include_keywords' : 'exclude_keywords';
    const words = input.split(',').map(w => w.trim().toLowerCase()).filter(w => w && !form[field].includes(w));
    if (words.length) set(field, [...form[field], ...words]);
    type === 'include' ? setKwInput('') : setExKwInput('');
  };

  const removeKeyword = (type, kw) => {
    const field = type === 'include' ? 'include_keywords' : 'exclude_keywords';
    set(field, form[field].filter(k => k !== kw));
  };

  const fieldStyle = { padding: '6px 10px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 12, width: '100%', boxSizing: 'border-box' };
  const labelStyle = { fontSize: 11, fontWeight: 600, color: '#475569', marginBottom: 3 };

  return (
    <div style={{
      padding: 16, borderRadius: 10, border: '1px solid #e2e8f0', background: '#f8fafc',
      marginBottom: 8, marginLeft: existing?.parent_id ? 28 : 0,
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', marginBottom: 12 }}>
        {isNew ? 'Add Taxonomy Item' : `Edit: ${existing.label}`}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div>
          <div style={labelStyle}>Label *</div>
          <input style={fieldStyle} value={form.label} onChange={e => set('label', e.target.value)} placeholder="e.g. Architecture" />
        </div>
        <div>
          <div style={labelStyle}>Item Key</div>
          <input style={fieldStyle} value={form.item_key} onChange={e => set('item_key', e.target.value)} placeholder="auto-generated from label" />
        </div>
        <div>
          <div style={labelStyle}>Fit Mode</div>
          <select style={fieldStyle} value={form.fit_mode} onChange={e => set('fit_mode', e.target.value)}>
            {FIT_MODES.map(m => <option key={m} value={m}>{FIT_MODE_LABELS[m]}</option>)}
          </select>
        </div>
        <div>
          <div style={labelStyle}>Status</div>
          <select style={fieldStyle} value={form.status} onChange={e => set('status', e.target.value)}>
            {TAXONOMY_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        {parentOptions.length > 0 && (
          <div>
            <div style={labelStyle}>Parent</div>
            <select style={fieldStyle} value={form.parent_id || ''} onChange={e => set('parent_id', e.target.value || null)}>
              <option value="">None (top-level)</option>
              {parentOptions.map(p => <option key={p.taxonomy_id} value={p.taxonomy_id}>{p.label}</option>)}
            </select>
          </div>
        )}
        <div>
          <div style={labelStyle}>Sort Order</div>
          <input style={fieldStyle} type="number" value={form.sort_order} onChange={e => set('sort_order', parseInt(e.target.value) || 0)} />
        </div>
      </div>

      {/* Include keywords */}
      <div style={{ marginBottom: 10 }}>
        <div style={labelStyle}>Include Keywords</div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
          <input style={{ ...fieldStyle, flex: 1 }} value={kwInput} onChange={e => setKwInput(e.target.value)}
            placeholder="Comma-separated keywords" onKeyDown={e => e.key === 'Enter' && addKeyword('include')} />
          <button onClick={() => addKeyword('include')} style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', fontSize: 11, cursor: 'pointer' }}>Add</button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {form.include_keywords.map(kw => (
            <span key={kw} style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: '#dbeafe', color: '#1e40af', cursor: 'pointer' }}
              onClick={() => removeKeyword('include', kw)}>
              {kw} ×
            </span>
          ))}
        </div>
      </div>

      {/* Exclude keywords */}
      <div style={{ marginBottom: 10 }}>
        <div style={labelStyle}>Exclude Keywords</div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
          <input style={{ ...fieldStyle, flex: 1 }} value={exKwInput} onChange={e => setExKwInput(e.target.value)}
            placeholder="Keywords that suppress this match" onKeyDown={e => e.key === 'Enter' && addKeyword('exclude')} />
          <button onClick={() => addKeyword('exclude')} style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid #e2e8f0', background: '#fff', fontSize: 11, cursor: 'pointer' }}>Add</button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {form.exclude_keywords.map(kw => (
            <span key={kw} style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: '#fecaca', color: '#991b1b', cursor: 'pointer' }}
              onClick={() => removeKeyword('exclude', kw)}>
              {kw} ×
            </span>
          ))}
        </div>
      </div>

      {/* Notes */}
      <div style={{ marginBottom: 12 }}>
        <div style={labelStyle}>Notes</div>
        <textarea style={{ ...fieldStyle, minHeight: 48, resize: 'vertical' }} value={form.notes} onChange={e => set('notes', e.target.value)} />
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={handleSave} style={{
          padding: '7px 20px', borderRadius: 6, border: 'none', background: '#0f172a',
          color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer',
        }}>{isNew ? 'Add' : 'Save'}</button>
        <button onClick={onCancel} style={{
          padding: '7px 16px', borderRadius: 6, border: '1px solid #e2e8f0',
          background: '#fff', color: '#64748b', fontSize: 12, cursor: 'pointer',
        }}>Cancel</button>
      </div>
    </div>
  );
}


/* ── Client Registry Preview ───────────────────────────────────── */

function ClientRegistryPreview({ clients, onChanged, persistClients }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);

  return (
    <div style={{ marginTop: 32 }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', marginBottom: 4 }}>
        Client Registry (Foundation)
      </div>
      <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 14 }}>
        Track client relationships for future Client News and intelligence features. Manual entries now; AI-suggested entries in a future version.
      </div>

      <button onClick={() => { setShowAdd(true); setEditId(null); }} style={{
        padding: '7px 16px', borderRadius: 6, border: '1px solid #e2e8f0',
        background: '#f8fafc', color: '#334155', fontSize: 12, fontWeight: 600,
        cursor: 'pointer', marginBottom: 12,
      }}>+ Add Client</button>

      {showAdd && (
        <ClientForm
          onSave={(client) => {
            persistClients([...clients, client]);
            setShowAdd(false);
          }}
          onCancel={() => setShowAdd(false)}
        />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {clients.map(c => (
          <div key={c.client_id}>
            {editId === c.client_id ? (
              <ClientForm
                existing={c}
                onSave={(updated) => {
                  persistClients(clients.map(cl => cl.client_id === updated.client_id ? updated : cl));
                  setEditId(null);
                }}
                onCancel={() => setEditId(null)}
              />
            ) : (
              <ClientRow
                client={c}
                onEdit={() => setEditId(c.client_id)}
                onStatusChange={(status) => {
                  persistClients(clients.map(cl => cl.client_id === c.client_id ? { ...cl, status, date_modified: new Date().toISOString().split('T')[0] } : cl));
                }}
              />
            )}
          </div>
        ))}
      </div>

      {clients.length === 0 && !showAdd && (
        <div style={{ padding: 30, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
          No clients registered yet. Add your first client to start building the registry.
        </div>
      )}
    </div>
  );
}

function ClientRow({ client, onEdit, onStatusChange }) {
  const typeColors = {
    current: { bg: '#dcfce7', fg: '#166534' },
    past: { bg: '#e0e7ff', fg: '#3730a3' },
    target: { bg: '#fef9c3', fg: '#854d0e' },
    prospect: { bg: '#f1f5f9', fg: '#64748b' },
  };
  const tc = typeColors[client.client_type] || typeColors.prospect;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
      borderRadius: 8, border: '1px solid #f1f5f9', background: '#fff',
      opacity: client.status === 'archived' ? 0.5 : 1,
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>{client.client_name}</div>
        {client.relationship_owner && <div style={{ fontSize: 11, color: '#64748b' }}>Owner: {client.relationship_owner}</div>}
        {client.notes && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{client.notes}</div>}
      </div>
      <span style={{ fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6, background: tc.bg, color: tc.fg }}>
        {client.client_type}
      </span>
      <div style={{ display: 'flex', gap: 4 }}>
        <SmallBtn label="Edit" onClick={onEdit} />
        {client.status === 'active' && <SmallBtn label="Deactivate" onClick={() => onStatusChange('inactive')} />}
        {client.status === 'inactive' && <SmallBtn label="Activate" onClick={() => onStatusChange('active')} />}
        {client.status !== 'archived' && <SmallBtn label="Archive" onClick={() => onStatusChange('archived')} />}
      </div>
    </div>
  );
}

function ClientForm({ existing, onSave, onCancel }) {
  const isNew = !existing;
  const [form, setForm] = useState(() => existing ? { ...existing } : createClient());
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const fieldStyle = { padding: '6px 10px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 12, width: '100%', boxSizing: 'border-box' };
  const labelStyle = { fontSize: 11, fontWeight: 600, color: '#475569', marginBottom: 3 };

  const handleSave = () => {
    if (!form.client_name.trim()) return alert('Client name is required.');
    form.date_modified = new Date().toISOString().split('T')[0];
    onSave(form);
  };

  return (
    <div style={{ padding: 16, borderRadius: 10, border: '1px solid #e2e8f0', background: '#f8fafc', marginBottom: 8 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', marginBottom: 12 }}>
        {isNew ? 'Add Client' : `Edit: ${existing.client_name}`}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div>
          <div style={labelStyle}>Client Name *</div>
          <input style={fieldStyle} value={form.client_name} onChange={e => set('client_name', e.target.value)} />
        </div>
        <div>
          <div style={labelStyle}>Client Type</div>
          <select style={fieldStyle} value={form.client_type} onChange={e => set('client_type', e.target.value)}>
            {CLIENT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <div style={labelStyle}>Relationship Owner</div>
          <input style={fieldStyle} value={form.relationship_owner} onChange={e => set('relationship_owner', e.target.value)} placeholder="Internal staff" />
        </div>
        <div>
          <div style={labelStyle}>Primary Contact</div>
          <input style={fieldStyle} value={form.primary_contact} onChange={e => set('primary_contact', e.target.value)} placeholder="Client contact" />
        </div>
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={labelStyle}>Notes</div>
        <textarea style={{ ...fieldStyle, minHeight: 48, resize: 'vertical' }} value={form.notes} onChange={e => set('notes', e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={handleSave} style={{
          padding: '7px 20px', borderRadius: 6, border: 'none', background: '#0f172a',
          color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer',
        }}>{isNew ? 'Add' : 'Save'}</button>
        <button onClick={onCancel} style={{
          padding: '7px 16px', borderRadius: 6, border: '1px solid #e2e8f0',
          background: '#fff', color: '#64748b', fontSize: 12, cursor: 'pointer',
        }}>Cancel</button>
      </div>
    </div>
  );
}


/* ── Shared Small Button ───────────────────────────────────────── */

function SmallBtn({ label, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: '3px 8px', borderRadius: 4, border: '1px solid #e2e8f0',
      background: '#fff', color: '#64748b', fontSize: 10, fontWeight: 600,
      cursor: 'pointer', whiteSpace: 'nowrap',
    }}>{label}</button>
  );
}
