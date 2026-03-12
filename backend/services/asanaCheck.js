/**
 * Project Scout — Asana Board Check Service
 *
 * Checks the A&E + SMA Asana Project Requests board daily
 * to find leads that have been submitted outside of Project Scout.
 * When a match is found, the lead is automatically moved to
 * "Submitted to Asana" with the match recorded.
 *
 * INTEGRATION:
 *   - Called by the daily scan (or manually from Settings)
 *   - Uses Asana API with a personal access token
 *   - Compares active lead titles against Asana task names
 *   - Uses fuzzy matching (word overlap) to account for naming differences
 *
 * CONFIG:
 *   - Asana Project ID: 1203575716271060 (Project Requests board)
 *   - Asana Workspace: 869158886664904
 */

const ASANA_API = 'https://app.asana.com/api/1.0';

/**
 * Fetch tasks from the Asana Project Requests board.
 */
export async function fetchAsanaTasks(settings) {
  const { asanaToken, asanaProjectId = '1203575716271060' } = settings;
  if (!asanaToken) throw new Error('Asana access token not configured');

  const tasks = [];
  let offset = null;

  do {
    const url = `${ASANA_API}/projects/${asanaProjectId}/tasks?opt_fields=name,created_at,completed,completed_at,permalink_url,custom_fields,assignee.name,notes,memberships.section.name&limit=100${offset ? `&offset=${offset}` : ''}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${asanaToken}` },
    });
    const data = await resp.json();
    if (data.errors) throw new Error(data.errors[0]?.message || 'Asana API error');
    tasks.push(...(data.data || []));
    offset = data.next_page?.offset || null;
  } while (offset);

  return tasks;
}

/**
 * Normalize text for comparison.
 */
function normalize(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Word-overlap similarity (0-1).
 */
function similarity(a, b) {
  const wa = new Set(normalize(a).split(' ').filter(w => w.length > 2));
  const wb = new Set(normalize(b).split(' ').filter(w => w.length > 2));
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / new Set([...wa, ...wb]).size;
}

/**
 * Check active leads against Asana board tasks.
 * Returns array of { lead, asanaTask, confidence } matches.
 */
export async function checkLeadsAgainstAsana(activeLeads, settings) {
  const tasks = await fetchAsanaTasks(settings);
  const matches = [];

  for (const lead of activeLeads) {
    const leadNorm = normalize(lead.title);
    const ownerNorm = normalize(lead.owner);

    for (const task of tasks) {
      const taskNorm = normalize(task.name);

      // Exact title match
      if (leadNorm === taskNorm || taskNorm.includes(leadNorm) || leadNorm.includes(taskNorm)) {
        matches.push({ lead, asanaTask: task, confidence: 0.95, matchType: 'title' });
        break;
      }

      // Fuzzy title match
      const sim = similarity(lead.title, task.name);
      if (sim > 0.5) {
        matches.push({ lead, asanaTask: task, confidence: sim, matchType: 'fuzzy' });
        break;
      }

      // Owner + partial title match
      if (ownerNorm && taskNorm.includes(ownerNorm)) {
        const titleSim = similarity(lead.title, task.name);
        if (titleSim > 0.3) {
          matches.push({ lead, asanaTask: task, confidence: 0.6 + titleSim * 0.3, matchType: 'owner+partial' });
          break;
        }
      }
    }
  }

  return matches;
}

/**
 * Run the daily Asana check and return leads to move.
 */
export async function runDailyAsanaCheck(activeLeads, settings, onLog = console.log) {
  onLog('═══ ASANA CHECK STARTED ═══');

  try {
    const matches = await checkLeadsAgainstAsana(activeLeads, settings);
    onLog(`Found ${matches.length} lead(s) matching Asana board tasks`);

    for (const m of matches) {
      onLog(`  Match: "${m.lead.title}" → "${m.asanaTask.name}" (${(m.confidence * 100).toFixed(0)}% confidence, ${m.matchType})`);
    }

    onLog('═══ ASANA CHECK COMPLETE ═══');
    const taskSection = (task) => {
      const mb = (task.memberships || []).find(m => m.section?.name);
      return mb ? mb.section.name : null;
    };
    return matches.map(m => ({
      leadId: m.lead.id,
      taskName: m.asanaTask.name,
      taskGid: m.asanaTask.gid || null,
      taskUrl: m.asanaTask.permalink_url || `https://app.asana.com/0/1203575716271060/${m.asanaTask.gid}`,
      confidence: m.confidence,
      matchType: m.matchType,
      dateFoundInAsana: new Date().toISOString(),
      asana_created_at: m.asanaTask.created_at || null,
      asana_completed: !!m.asanaTask.completed,
      asana_completed_at: m.asanaTask.completed_at || null,
      asana_assignee: m.asanaTask.assignee?.name || null,
      asana_section: taskSection(m.asanaTask),
      asana_notes_excerpt: m.asanaTask.notes ? m.asanaTask.notes.slice(0, 300) : null,
    }));
  } catch (err) {
    onLog(`ERROR: ${err.message}`);
    return [];
  }
}
