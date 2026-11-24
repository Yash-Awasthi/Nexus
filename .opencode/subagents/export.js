// Exports subagent (or any) session transcripts from opencode's sqlite db into plain text.
// Usage: node export.js <sessionID> [...]            -> write transcript-<id>.txt for each
//        node export.js --parent <sessionID>         -> every child of that session
//        node export.js --list                       -> child sessions grouped by parent
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const OUT = __dirname;
const dbFile = path.join(process.env.USERPROFILE, '.local', 'share', 'opencode', 'opencode.db');
const db = new DatabaseSync(dbFile, { readOnly: true });

const args = process.argv.slice(2);

function children(parent) {
  return db.prepare('select id, title, agent, model, time_created, time_updated from session_v2 where parent_id = ? order by time_created').all(parent);
}

function session(id) {
  return db.prepare('select id, parent_id, title, agent, model, directory, cost, tokens_input, tokens_output, time_created, time_updated from session_v2 where id = ?').get(id);
}

function fmtTime(ms) {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}

function partsOf(messageID) {
  const row = db.prepare('select data from session_message where id = ?').get(messageID);
  if (!row) return { text: '', tools: [], reasoning: '' };
  const data = JSON.parse(row.data || '{}');
  let text = '';
  let reasoning = '';
  const tools = [];
  for (const c of data.content || []) {
    if (c.type === 'text') text += c.text || '';
    else if (c.type === 'reasoning') reasoning += c.text || '';
    else if (c.type === 'tool') tools.push(c);
  }
  return { text, reasoning, tools };
}

function render(id) {
  const s = session(id);
  if (!s) return null;
  const msgs = db.prepare('select id, type, time_created, data from session_message where session_id = ? order by time_created, seq').all(id);
  const out = [];
  out.push('SESSION ' + s.id);
  out.push('title    ' + (s.title || ''));
  out.push('parent   ' + (s.parent_id || '-'));
  out.push('agent    ' + (s.agent || '-'));
  out.push('model    ' + (s.model || '-'));
  out.push('dir      ' + (s.directory || '-'));
  out.push('created  ' + fmtTime(s.time_created));
  out.push('updated  ' + fmtTime(s.time_updated));
  out.push('tokens   in=' + s.tokens_input + ' out=' + s.tokens_output + ' cost=' + s.cost);
  out.push('');
  for (const m of msgs) {
    const meta = JSON.parse(m.data || '{}');
    const p = partsOf(m.id);
    const who = m.type === 'assistant' ? 'assistant' : m.type === 'user' ? 'user' : m.type;
    const model = meta.model ? ' [' + meta.model.id + ']' : '';
    if (who === 'user' && !p.text && !p.tools.length) continue;
    out.push('---- ' + who + model + '  ' + fmtTime(m.time_created) + ' ----');
    if (p.reasoning) out.push('[reasoning] ' + p.reasoning.replace(/\s+/g, ' ').trim());
    if (p.text.trim()) out.push(p.text.trim());
    for (const t of p.tools) {
      const st = t.state || {};
      out.push('[tool ' + t.name + '] ' + st.status + (st.input ? ' ' + JSON.stringify(st.input).slice(0, 400) : ''));
      if (st.output) out.push('[tool result] ' + String(st.output).slice(0, 2000));
      if (st.error) out.push('[tool error] ' + JSON.stringify(st.error).slice(0, 800));
    }
    out.push('');
  }
  return out.join('\n');
}

function exportOne(id) {
  const text = render(id);
  if (!text) {
    console.log('missing session ' + id);
    return null;
  }
  const file = path.join(OUT, 'transcript-' + id + '.txt');
  fs.writeFileSync(file, text, 'utf8');
  console.log('wrote ' + file);
  return file;
}

if (args[0] === '--list') {
  const parents = db.prepare('select distinct parent_id from session_v2 where parent_id is not null').all();
  for (const p of parents) {
    console.log('PARENT ' + p.parent_id + (session(p.parent_id) ? '  (' + session(p.parent_id).title + ')' : ''));
    for (const c of children(p.parent_id)) {
      console.log('  ' + c.id + '  ' + (c.agent || '-') + '  ' + fmtTime(c.time_created) + '  ' + (c.title || ''));
    }
  }
} else if (args[0] === '--parent') {
  for (const c of children(args[1])) exportOne(c.id);
} else {
  for (const id of args) exportOne(id);
}
