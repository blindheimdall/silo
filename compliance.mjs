// The compliance report: what the audit log proves happened in a period (where data went, what was hidden, who
// decided, what the guardrails caught, who changed what) next to how SILO is set up now. It gathers evidence for a
// GDPR record or an EU AI Act review; it is not legal advice and it does not certify anything.

// Where a model call went, from the host it was sent to.
export function placeOf(host) {
  const raw = String(host || '').toLowerCase(), h = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.replace(/:\d+$/, '');
  if (/^(localhost|127\.|::1$|0\.0\.0\.0$)/.test(h)) return 'this computer';
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fd|fe80:)|\.local$|\.lan$|\.internal$/.test(h)) return 'your network';
  return 'internet';
}

// One model call as an audit detail, and back. Only counts and names: never what was said.
export function modelDetail({host, input = 0, output = 0, hidden = null, from = '', test = false}) {
  const hid = hidden && Object.keys(hidden).length ? Object.entries(hidden).map(([k, n]) => `${k}:${n}`).join(',') : '';
  return [`host=${host}`, `in=${input | 0}`, `out=${output | 0}`, hid && `hidden=${hid}`, from && `from=${String(from).replace(/\s+/g, '_').slice(0, 30)}`, test && 'test'].filter(Boolean).join(' ');
}
export function readModelDetail(detail) {
  const o = {host: '', input: 0, output: 0, hidden: {}, from: '', test: false};
  for (const part of String(detail || '').split(' ')) {
    const [k, v = ''] = part.split('=');
    if (k === 'host') o.host = v; else if (k === 'in') o.input = +v || 0; else if (k === 'out') o.output = +v || 0; else if (k === 'from') o.from = v; else if (k === 'test') o.test = true;
    else if (k === 'hidden') for (const kv of v.split(',')) { const [kind, n] = kv.split(':'); if (kind) o.hidden[kind] = (o.hidden[kind] || 0) + (+n || 0); }
  }
  return o;
}

const CHANGE = /^(POST|PUT|PATCH|DELETE) \/api\/(settings|connections|users|tokens|vault|channels|mcp|grants|radio|sso|otel|audit|talk|sync|system|services|phone|remote|expose|a2a|python-tools)\b/;
const add = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

// records: audit records of the period, oldest first. chain: the result of checking the whole log. now: SILO as it is
// set up at the time of the report (see snapshot in server.mjs).
export function buildReport({records, chain, now, from, to, generated = Date.now()}) {
  const dest = new Map(), people = new Map(), tools = new Map(), guard = {counts: {}, events: []}, oversight = {allowed: 0, denied: 0, approved: 0, rejected: 0, pending: now.pending || 0};
  const access = {signIns: 0, failedSignIns: 0, changes: {}, given: 0, refused: 0};
  const hidden = {}, totals = {calls: 0, failed: 0, external: 0, externalUnhidden: 0, input: 0, output: 0, withHidden: 0};
  const resident = name => { let r = people.get(name); if (!r) people.set(name, r = {name, calls: 0, internet: 0, tools: 0, failedTools: 0}); return r; };
  for (const r of records) {
    const a = r.action || '';
    if (a === 'model.call') {
      const d = readModelDetail(r.detail), [provider, ...m] = String(r.target || '').split(':'), model = m.join(':'), key = `${provider}|${model}|${d.host}`;
      let x = dest.get(key);
      if (!x) dest.set(key, x = {provider, model, host: d.host, place: placeOf(d.host), calls: 0, failed: 0, input: 0, output: 0, withHidden: 0, hidden: {}, residents: new Set()});
      const hid = Object.values(d.hidden).reduce((s, n) => s + n, 0);
      x.calls++; x.input += d.input; x.output += d.output; x.residents.add(r.actor);
      if (r.outcome === 'failed') { x.failed++; totals.failed++; }
      if (hid) { x.withHidden++; totals.withHidden++; for (const [k, n] of Object.entries(d.hidden)) { add(x.hidden, k, n); add(hidden, k, n); } }
      totals.calls++; totals.input += d.input; totals.output += d.output;
      const p = resident(r.actor); p.calls++;
      if (x.place === 'internet') { totals.external++; p.internet++; if (!hid) totals.externalUnhidden++; }
    } else if (a === 'resident.tool' || a === 'resident.delegate') {
      const t = tools.get(r.target) || {tool: r.target, uses: 0, failed: 0, residents: new Set()};
      t.uses++; t.residents.add(r.actor); if (r.outcome === 'failed') t.failed++; tools.set(r.target, t);
      const p = resident(r.actor); p.tools++; if (r.outcome === 'failed') p.failedTools++;
    } else if (a.startsWith('guardrail.')) {
      add(guard.counts, a.slice(10));
      guard.events.push({time: r.time, kind: a.slice(10), who: r.actor, detail: r.detail || ''});
    } else if (a === 'request.allow') oversight.allowed++;
    else if (a === 'request.deny') oversight.denied++;
    else if (a === 'run.approve') oversight.approved++;
    else if (a === 'run.reject') oversight.rejected++;
    else if (a === 'sign-in' || a === 'sign-in.sso') { if (r.outcome === 'ok') access.signIns++; else access.failedSignIns++; }
    else if (a === 'capability.give') access.given++;
    else if (CHANGE.test(a)) { if (r.outcome === 'ok' && !(r.status >= 400)) add(access.changes, a); else access.refused++; }
  }
  const destinations = [...dest.values()].map(x => ({...x, residents: [...x.residents].sort()})).sort((a, b) => b.calls - a.calls);
  const toolList = [...tools.values()].map(t => ({...t, residents: [...t.residents].sort()})).sort((a, b) => b.uses - a.uses);
  const report = {
    title: 'SILO compliance report', silo: now.silo, generated: new Date(generated).toISOString(), from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    chain: {ok: !!chain?.ok, records: chain?.records || 0, broken: chain?.broken || null}, period: {records: records.length},
    totals: {...totals, hidden}, destinations, residents: [...people.values()].sort((a, b) => b.calls - a.calls), tools: toolList,
    oversight, guardrails: {counts: guard.counts, events: guard.events.slice(-30).reverse()}, access: {...access, changes: Object.entries(access.changes).map(([action, count]) => ({action, count})).sort((a, b) => b.count - a.count)},
    setup: now,
  };
  report.findings = findings(report);
  return report;
}

// What deserves a look, worst first. Each finding says what was seen, never what the law requires of you.
export function findings(r) {
  const out = [], s = r.setup, g = s.guardrails || {}, f = (level, text) => out.push({level, text});
  if (!r.chain.ok) f('high', `The audit log chain breaks${r.chain.broken ? ` in ${r.chain.broken.file}, line ${r.chain.broken.line}: ${r.chain.broken.reason}` : ''}. Records from there on cannot be shown to be untouched.`);
  if (r.totals.externalUnhidden && g.pii?.mode !== 'mask') f('high', `${r.totals.externalUnhidden} model call${r.totals.externalUnhidden === 1 ? '' : 's'} went to models on the internet while hiding personal data was off. What they carried was sent as it was.`);
  else if (r.totals.externalUnhidden) f('info', `${r.totals.externalUnhidden} model call${r.totals.externalUnhidden === 1 ? '' : 's'} to the internet carried nothing that needed hiding${g.pii?.mode === 'mask' ? '' : ', or went before hiding was on'}.`);
  if (!s.accounts.total) f('high', 'SILO has no accounts: anyone who can open it on this computer can use everything.');
  else if (s.network && !s.accounts.owner) f('high', 'Network access is on and there is no owner account.');
  if (g.injection?.mode === 'off') f('medium', 'Checking tool results for orders aimed at residents is off.');
  const trusting = s.residents.filter(x => x.trusted.length);
  if (trusting.length) f('medium', `${trusting.length} resident${trusting.length === 1 ? ' acts' : 's act'} without asking first with some tools: ${trusting.map(x => `${x.name} (${x.trusted.join(', ')})`).join('; ')}.`);
  if (!s.audit.keyed) f('medium', 'The audit chain uses the built-in key, not one of its own in the vault, so someone with the files could rebuild the chain after a change.');
  if (s.audit.months && s.audit.months < 6) f('medium', `The audit log is kept for ${s.audit.months} month${s.audit.months === 1 ? '' : 's'}.`);
  if (r.access.failedSignIns >= 10) f('medium', `${r.access.failedSignIns} sign-ins failed in this period.`);
  if (r.oversight.pending) f('medium', `${r.oversight.pending} request${r.oversight.pending === 1 ? ' waits' : 's wait'} for a decision now.`);
  const pub = s.channels.filter(c => c.public);
  if (pub.length) f('info', `People outside talk to residents on ${pub.map(c => `${c.kind} (${c.resident})`).join(', ')}. Make sure they are told they are talking to an AI.`);
  const live = s.grants.filter(c => c.active);
  if (live.length) f('info', `${live.length} capabilit${live.length === 1 ? 'y gives' : 'ies give'} other silos access to this one now.`);
  if (g.pii?.mode === 'mask') f('ok', 'Personal data is hidden from models as placeholders' + (g.pii.local ? ', except for models on this computer.' : ', also from models on this computer.'));
  if (r.chain.ok && r.chain.records) f('ok', `The audit log chain is whole: ${r.chain.records} records.`);
  const order = {high: 0, medium: 1, info: 2, ok: 3};
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

const cell = v => String(v ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim() || '-';
const table = (head, rows) => rows.length ? [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map(r => `| ${r.map(cell).join(' | ')} |`)].join('\n') : '';
const num = n => Number(n || 0).toLocaleString('en-US');
const plural = (n, word) => `${num(n)} ${word}${n === 1 ? '' : 's'}`;
const day = iso => iso.slice(0, 10);
const kinds = h => Object.entries(h || {}).map(([k, n]) => `${k} ${n}`).join(', ');

// The report as Markdown, for reading, for the PDF and for pasting into a record of processing.
export function reportMarkdown(r) {
  const s = r.setup, g = s.guardrails || {}, L = [];
  L.push(`# ${r.title}`, '', `**${s.silo.name}** · SILO ${s.silo.version} · ${day(r.from)} to ${day(r.to)} · made ${r.generated.replace('T', ' ').slice(0, 16)} UTC`, '');
  L.push('This report gathers what the audit log of this SILO shows for the period, and how SILO is set up at the time it was made. It is evidence for your own records, such as a GDPR record of processing or an EU AI Act review. It is not legal advice and does not certify anything.', '');
  L.push('## Findings', '', ...(r.findings.length ? r.findings.map(x => `- **${x.level.toUpperCase()}** ${x.text}`) : ['- Nothing to point out.']), '');
  L.push('## Where data went', '');
  L.push(`${plural(r.totals.calls, 'model call')} in the period, ${num(r.totals.external)} of them to the internet. ${plural(r.totals.input, 'token')} went in and ${num(r.totals.output)} came out. ${plural(r.totals.withHidden, 'call')} carried placeholders instead of personal data${Object.keys(r.totals.hidden).length ? ` (${kinds(r.totals.hidden)})` : ''}.`, '');
  L.push(table(['Provider', 'Model', 'Sent to', 'Where', 'Calls', 'Failed', 'With placeholders', 'Hidden', 'Residents'], r.destinations.map(d => [d.provider, d.model || 'default', d.host, d.place, num(d.calls), num(d.failed), num(d.withHidden), kinds(d.hidden), d.residents.join(', ')])) || 'No model calls in this period.', '');
  L.push('## Residents', '');
  L.push(table(['Resident', 'Role', 'Model', 'Model calls', 'To the internet', 'Tool uses', 'Failed tools'], (() => {
    const seen = new Map(r.residents.map(x => [x.name, x]));
    return [...s.residents.map(x => { const a = seen.get(x.name) || {}; seen.delete(x.name); return [x.name, x.role, `${x.provider}${x.model ? ':' + x.model : ''}`, num(a.calls), num(a.internet), num(a.tools), num(a.failedTools)]; }),
      ...[...seen.values()].map(a => [a.name, '(no longer here)', '', num(a.calls), num(a.internet), num(a.tools), num(a.failedTools)])];
  })()) || 'No residents.', '');
  L.push('### Tools used', '', table(['Tool', 'Uses', 'Failed', 'By'], r.tools.slice(0, 40).map(t => [t.tool, num(t.uses), num(t.failed), t.residents.join(', ')])) || 'No tools were used in this period.', '');
  L.push('### What residents may do without asking', '', table(['Resident', 'Tools', 'Without asking first'], s.residents.map(x => [x.name, x.tools.join(', ') || 'none', x.trusted.join(', ') || 'nothing'])) || 'No residents.', '');
  L.push('## Human oversight', '');
  L.push(`- Tool requests allowed: ${num(r.oversight.allowed)}, denied: ${num(r.oversight.denied)}.`, `- Workflow approvals given: ${num(r.oversight.approved)}, rejected: ${num(r.oversight.rejected)}.`, `- Waiting for a decision now: ${num(r.oversight.pending)}.`, '');
  L.push('## Guardrails', '');
  L.push(`- Personal data sent to models: ${g.pii?.mode === 'mask' ? `hidden as placeholders (${(g.pii.kinds || []).join(', ') || 'no kinds'}${g.pii.terms?.length ? `, ${plural(g.pii.terms.length, 'listed word')}` : ''})${g.pii.local ? ', not for models on this computer' : ''}` : 'sent as it is'}.`);
  L.push(`- Orders inside tool results: ${g.injection?.mode || 'off'}.`, `- Owner rules: ${(g.rules || []).length}.`);
  L.push(`- Caught in the period: ${Object.keys(r.guardrails.counts).length ? kinds(r.guardrails.counts) : 'nothing'}.`, '');
  if (r.guardrails.events.length) L.push(table(['When', 'Kind', 'Resident', 'What'], r.guardrails.events.map(e => [e.time.replace('T', ' ').slice(0, 16), e.kind, e.who, e.detail])), '');
  L.push('## Access and changes', '');
  L.push(`- Sign-ins: ${num(r.access.signIns)}, failed: ${num(r.access.failedSignIns)}.`, `- Changes refused: ${num(r.access.refused)}.`, `- Capabilities given to other silos: ${num(r.access.given)}.`, '');
  if (r.access.changes.length) L.push(table(['Change', 'Times'], r.access.changes.map(c => [c.action, num(c.count)])), '');
  L.push('## Set up now', '');
  L.push(`- Accounts: ${s.accounts.total ? Object.entries(s.accounts.roles).map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`).join(', ') : 'none'}. Single sign-on: ${s.sso ? 'on' : 'off'}. API tokens: ${s.tokens}.`);
  L.push(`- Network access: ${s.network ? 'on' : 'off, this computer only'}. Code runs: ${s.sandbox}. The Pact: ${s.pact ? 'on' : 'off'}.`);
  L.push(`- Audit log: kept ${s.audit.months ? `${s.audit.months} months` : 'always'}, chain key ${s.audit.keyed ? 'in the vault' : 'built in'}. ${r.chain.ok ? `Whole, ${num(r.chain.records)} records.` : 'Broken.'}`);
  L.push(`- Data is kept on this machine: ${s.dataDir}.`, '');
  if (s.channels.length) L.push('### Talk channels', '', table(['Channel', 'Resident', 'Open to people outside'], s.channels.map(c => [c.kind, c.resident, c.public ? 'yes' : 'no'])), '');
  if (s.grants.length) L.push('### Capabilities given to other silos', '', table(['To', 'Residents', 'Tools', 'Folders', 'Ends', 'Now'], s.grants.map(c => [c.to, c.residents.join(', '), c.tools.join(', ') || 'none', c.folders.join(', ') || 'all', c.ends.slice(0, 16).replace('T', ' '), c.active ? 'active' : c.revoked ? 'revoked' : 'ended'])), '');
  L.push('## About this report', '', `Built from ${num(r.period.records)} audit records of the period. Model calls are in the audit log from the version of SILO that added this report on; earlier periods show none. The audit log never holds what was said, only who, what, when and how much.`);
  return L.join('\n');
}
