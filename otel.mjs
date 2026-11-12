// OpenTelemetry export: finished traces go out as spans, audit records as logs, over OTLP/HTTP with JSON, to any
// collector (the OpenTelemetry Collector, Grafana, Honeycomb, Datadog, Jaeger, Langfuse...). Model and tool spans
// follow the GenAI conventions. Prompts and answers never leave; tool arguments only when you turn that on.
import crypto from 'node:crypto';
import net from 'node:net';

const nano = ms => (BigInt(Math.round(ms || 0)) * 1000000n).toString();
const hex16 = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
const spanIdOf = id => /^[0-9a-f-]{36}$/i.test(id || '') ? id.replace(/-/g, '').slice(0, 16) : hex16(id);
const traceIdOf = id => /^[0-9a-f-]{36}$/i.test(id || '') ? id.replace(/-/g, '').toLowerCase() : crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 32);
function attr(key, v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'boolean') return { key, value: { boolValue: v } };
  if (typeof v === 'number') return Number.isInteger(v) ? { key, value: { intValue: String(v) } } : { key, value: { doubleValue: v } };
  return { key, value: { stringValue: String(v).slice(0, 2000) } };
}
const attrs = o => Object.entries(o).map(([k, v]) => attr(k, v)).filter(Boolean);

// The address of one signal. A base address gets /v1/traces or /v1/logs; a full address is kept for its own signal.
export function otlpUrl(endpoint, signal) {
  const u = new URL(String(endpoint).trim());
  if (/\/v1\/(traces|logs|metrics)\/?$/.test(u.pathname)) u.pathname = u.pathname.replace(/\/v1\/(traces|logs|metrics)\/?$/, '/v1/' + signal);
  else u.pathname = u.pathname.replace(/\/?$/, '/v1/' + signal);
  return u.href;
}
// https anywhere. Plain http only to this computer, the local network or a collector named without dots (Docker).
export function checkEndpoint(endpoint) {
  let u; try { u = new URL(String(endpoint || '').trim()); } catch { throw Object.assign(new Error('Write the collector address, like http://localhost:4318 or https://otlp.example.com.'), { status: 400 }); }
  if (u.username || u.password) throw Object.assign(new Error('Put credentials in the headers, not in the address.'), { status: 400 });
  if (u.protocol === 'https:') return u.href.replace(/\/$/, '');
  if (u.protocol !== 'http:') throw Object.assign(new Error('The collector address starts with http:// or https://.'), { status: 400 });
  const h = u.hostname.replace(/^\[|\]$/g, '');
  const local = h === 'localhost' || !h.includes('.') && !net.isIP(h) || net.isIPv4(h) && /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h === '::1' || /^f[cd]/i.test(h);
  if (!local) throw Object.assign(new Error('Use https for a collector outside this computer and network.'), { status: 400 });
  return u.href.replace(/\/$/, '');
}
// "key=value, key2=value2", as in OTEL_EXPORTER_OTLP_HEADERS.
export function parseHeaders(text) {
  const out = {};
  for (const part of String(text || '').split(/[,\n]/)) {
    const s = part.trim(); if (!s) continue; const i = s.indexOf('=');
    if (i < 1) throw Object.assign(new Error('Write headers as name=value, separated by commas.'), { status: 400 });
    const k = s.slice(0, i).trim(), v = decodeURIComponent(s.slice(i + 1).trim());
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(k) || /[\r\n]/.test(v)) throw Object.assign(new Error('A header name or value is not allowed: ' + k.slice(0, 40)), { status: 400 });
    out[k] = v;
  }
  return out;
}

const OP = { model: 'chat', tool: 'execute_tool', delegate: 'invoke_agent' };
// One trace as OTLP spans: a root for the conversation, run or goal, and every span under it.
export function traceSpans(t, { content = false } = {}) {
  const traceId = traceIdOf(t.id), rootId = hex16(t.id + ':root'), end = t.ended || Date.now();
  const status = s => ['error', 'failed'].includes(s.status) ? { code: 2, message: String(s.error || s.status).slice(0, 300) } : { code: 0 };
  const root = {
    traceId, spanId: rootId, name: `${t.kind || 'trace'} ${t.name || ''}`.trim(), kind: 1, startTimeUnixNano: nano(t.started), endTimeUnixNano: nano(end),
    attributes: attrs({ 'silo.trace.kind': t.kind, 'silo.trace.id': t.id, 'silo.ref.id': t.refId, 'silo.status': t.status, 'gen_ai.usage.input_tokens': t.totals?.input || undefined, 'gen_ai.usage.output_tokens': t.totals?.output || undefined, 'silo.cost_usd': t.totals?.cost || undefined, 'silo.spans_dropped': t.dropped || undefined }),
    status: ['error', 'failed'].includes(t.status) ? { code: 2, message: String(t.error || t.status).slice(0, 300) } : { code: 0 },
  };
  const ids = new Set((t.spans || []).map(s => s.id));
  const spans = (t.spans || []).map(s => {
    const op = OP[s.kind], name = s.kind === 'model' ? `chat ${s.model || s.provider || s.name}` : s.kind === 'tool' ? `execute_tool ${s.name}` : s.kind === 'delegate' ? `invoke_agent ${s.target || s.name}` : `${s.kind} ${s.name}`;
    return {
      traceId, spanId: spanIdOf(s.id), parentSpanId: s.parent && ids.has(s.parent) ? spanIdOf(s.parent) : rootId, name: name.slice(0, 200), kind: s.kind === 'model' ? 3 : 1,
      startTimeUnixNano: nano(s.start), endTimeUnixNano: nano(s.end || end),
      attributes: attrs({
        'gen_ai.operation.name': op, 'gen_ai.provider.name': s.kind === 'model' ? s.provider : undefined, 'gen_ai.request.model': s.kind === 'model' ? s.model : undefined,
        'gen_ai.usage.input_tokens': s.kind === 'model' ? s.input || 0 : undefined, 'gen_ai.usage.output_tokens': s.kind === 'model' ? s.output || 0 : undefined,
        'gen_ai.tool.name': s.kind === 'tool' ? s.name : undefined, 'gen_ai.agent.name': s.agent, 'silo.agent.id': s.agentId, 'silo.span.kind': s.kind, 'silo.status': s.status,
        'silo.cost_usd': s.cost || undefined, 'silo.step': s.step, 'silo.decision': s.decision, 'silo.tool_calls': s.toolCalls, 'silo.fallback': s.fallback, 'silo.target': s.target,
        'gen_ai.tool.call.arguments': content && s.args ? s.args : undefined,
      }),
      status: status(s),
    };
  });
  return [root, ...spans];
}
export function auditLogRecord(r) {
  const bad = r.outcome !== 'ok';
  return {
    timeUnixNano: nano(Date.parse(r.time)), observedTimeUnixNano: nano(Date.now()), severityNumber: bad ? 13 : 9, severityText: bad ? 'WARN' : 'INFO',
    body: { stringValue: `${r.action} by ${r.actor}${r.target ? ' on ' + r.target : ''}: ${r.outcome}` },
    attributes: attrs({ 'event.name': 'silo.audit', 'silo.audit.seq': r.seq, 'silo.audit.action': r.action, 'silo.audit.outcome': r.outcome, 'enduser.id': r.actor, 'enduser.role': r.role, 'client.address': r.ip, 'silo.audit.via': r.via, 'silo.audit.target': r.target, 'silo.audit.detail': r.detail, 'http.response.status_code': r.status, 'silo.audit.hash': r.hash }),
  };
}

export class OtelExporter {
  // config(): {enabled,endpoint,service,traces,logs,content}. headers(): extra headers, from the vault.
  constructor({ config, headers = () => ({}), version = '0.0.0', instance = '' }) {
    this.config = config; this.headers = headers; this.version = version; this.instance = instance;
    this.spans = []; this.logs = []; this.sent = { spans: 0, logs: 0 }; this.dropped = 0; this.lastError = ''; this.lastOk = 0; this.wait = 0; this.retryAt = 0; this.flushing = null;
    this.timer = setInterval(() => this.flush().catch(() => {}), 5000); this.timer.unref?.();
  }
  resource() { const c = this.config(); return { attributes: attrs({ 'service.name': c.service || 'silo', 'service.version': this.version, 'service.instance.id': this.instance, 'telemetry.sdk.name': 'silo', 'telemetry.sdk.language': 'nodejs' }) }; }
  on(kind) { const c = this.config(); return !!(c.enabled && c.endpoint && c[kind] !== false); }
  push(list, items) { list.push(...items); const over = list.length - 5000; if (over > 0) { list.splice(0, over); this.dropped += over; } }
  addTrace(t) { if (this.on('traces')) this.push(this.spans, traceSpans(t, { content: !!this.config().content })); }
  addLog(r) { if (this.on('logs')) this.push(this.logs, [auditLogRecord(r)]); }
  async post(signal, body) {
    const c = this.config();
    const r = await fetch(otlpUrl(c.endpoint, signal), { method: 'POST', headers: { 'Content-Type': 'application/json', ...this.headers() }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!r.ok) { const text = (await r.text().catch(() => '')).slice(0, 200); throw Object.assign(new Error(`The collector answered ${r.status}${text ? ': ' + text : ''}.`), { retry: r.status === 429 || r.status >= 500, status: r.status }); }
  }
  // Sends what waits, in batches. A collector that is down or busy is tried again later, waiting up to five minutes.
  flush(force = false) {
    if (this.flushing) return this.flushing;
    if (!force && Date.now() < this.retryAt) return Promise.resolve();
    this.flushing = (async () => {
      try {
        while (this.spans.length || this.logs.length) {
          const c = this.config(); if (!c.enabled || !c.endpoint) { this.spans = []; this.logs = []; return; }
          if (this.spans.length) { const batch = this.spans.slice(0, 500); await this.post('traces', { resourceSpans: [{ resource: this.resource(), scopeSpans: [{ scope: { name: 'silo', version: this.version }, spans: batch }] }] }).catch(e => this.failed(e, this.spans, batch.length)); this.spans.splice(0, batch.length); this.sent.spans += batch.length; }
          if (this.logs.length) { const batch = this.logs.slice(0, 500); await this.post('logs', { resourceLogs: [{ resource: this.resource(), scopeLogs: [{ scope: { name: 'silo.audit', version: this.version }, logRecords: batch }] }] }).catch(e => this.failed(e, this.logs, batch.length)); this.logs.splice(0, batch.length); this.sent.logs += batch.length; }
          this.lastOk = Date.now(); this.lastError = ''; this.wait = 0; this.retryAt = 0;
        }
      } catch (e) { if (!e.handled) this.lastError = e.message; }
      finally { this.flushing = null; }
    })();
    return this.flushing;
  }
  failed(e, list, n) {
    this.lastError = e.name === 'TimeoutError' ? 'The collector did not answer in 15 seconds.' : e.cause?.code ? `The collector cannot be reached (${e.cause.code}).` : e.message;
    if (e.retry !== false && (e.retry || !e.status)) { this.wait = Math.min(300000, (this.wait || 2500) * 2); this.retryAt = Date.now() + this.wait; }
    else { list.splice(0, n); this.dropped += n; }
    throw Object.assign(new Error(this.lastError), { handled: true });
  }
  // One span right now, to see that the collector takes it.
  async test() {
    const now = Date.now(), traceId = crypto.randomBytes(16).toString('hex');
    await this.post('traces', { resourceSpans: [{ resource: this.resource(), scopeSpans: [{ scope: { name: 'silo', version: this.version }, spans: [{ traceId, spanId: crypto.randomBytes(8).toString('hex'), name: 'silo test', kind: 1, startTimeUnixNano: nano(now - 5), endTimeUnixNano: nano(now), attributes: attrs({ 'silo.test': true }), status: { code: 0 } }] }] }] });
    return { traceId };
  }
  status() { return { queued: this.spans.length + this.logs.length, sent: this.sent, dropped: this.dropped, lastError: this.lastError, lastOk: this.lastOk, retryAt: this.retryAt > Date.now() ? this.retryAt : 0 }; }
  stop() { clearInterval(this.timer); }
}
