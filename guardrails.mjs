// Guardrails: personal data hidden from models, tool results that try to give orders, and rules the owner sets for
// what a resident may answer or do. Everything here is plain text work, without a model, so it costs nothing per call.
import {createHmac, randomBytes} from 'node:crypto';

export const PII_KINDS = {email: 'Email addresses', phone: 'Phone numbers', iban: 'IBANs', card: 'Card numbers', cnp: 'Romanian CNPs', secret: 'API keys and tokens'};
export const INJECTION_MODES = ['off', 'warn', 'ask', 'block'];
export const RULE_ACTIONS = {answer: ['block', 'redact'], tool: ['block', 'ask']};
export const RULES_MAX = 40, TERMS_MAX = 100;

const fail = message => { throw Object.assign(new Error(message), {status: 400}); };

// ---- Personal data -------------------------------------------------------------------------------------------------

const digits = s => s.replace(/\D/g, '');
function luhn(n) {
  let sum = 0;
  for (let i = 0; i < n.length; i++) { let d = +n[n.length - 1 - i]; if (i % 2) { d *= 2; if (d > 9) d -= 9; } sum += d; }
  return sum % 10 === 0;
}
function ibanOk(raw) {
  const s = raw.replace(/\s/g, '').toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const moved = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
  let r = 0; for (const ch of moved) r = (r * 10 + +ch) % 97;
  return r === 1;
}
function cnpOk(n) {
  const key = '279146358279';
  let sum = 0; for (let i = 0; i < 12; i++) sum += +n[i] * +key[i];
  const c = sum % 11 === 10 ? 1 : sum % 11, month = +n.slice(3, 5), day = +n.slice(5, 7);
  return c === +n[12] && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}
// In order: an earlier kind wins where two overlap, so a key that holds digits is a key, not a card.
const FINDERS = [
  ['secret', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----|\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g],
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g],
  ['iban', /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g, ibanOk],
  ['cnp', /\b[1-8]\d{12}\b/g, cnpOk],
  ['card', /\b\d(?:[ -]?\d){12,18}\b/g, s => { const n = digits(s); return n.length >= 13 && n.length <= 19 && !/^(\d)\1+$/.test(n) && luhn(n); }],
  // Phone numbers only with a country prefix (+, or 0040 for Romania), or in the Romanian national shape (07xx xxx
  // xxx), so dates, amounts, order numbers and pieces of account numbers stay as they are.
  ['phone', /(?<![\w+])(?:(?:\+[1-9]\d{0,2}|0040)[ .-]?(?:\(?\d{1,4}\)?[ .-]?){1,4}\d{2,4}|0[237]\d{2}[ .-]?\d{3}[ .-]?\d{3})(?![\w])/g, s => { const n = digits(s); return n.length >= 9 && n.length <= 15; }],
];
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every piece of personal data in a text: {kind, value, index}, in order, without overlaps. terms are words the owner
// wants hidden as they are (client names, project names), found whole and without case.
export function findPii(text, kinds = Object.keys(PII_KINDS), terms = []) {
  // found stays sorted and never overlaps, so a new match only has to be checked against its two neighbours.
  const t = String(text ?? ''), found = [];
  const take = (kind, value, index) => {
    let lo = 0, hi = found.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (found[mid].index < index) lo = mid + 1; else hi = mid; }
    const before = found[lo - 1], after = found[lo];
    if (before && before.index + before.value.length > index) return;
    if (after && after.index < index + value.length) return;
    found.splice(lo, 0, {kind, value, index});
  };
  for (const [kind, re, ok] of FINDERS) {
    if (!kinds.includes(kind)) continue;
    for (const m of t.matchAll(re)) if (!ok || ok(m[0])) take(kind, m[0], m.index);
  }
  const words = terms.filter(w => w && w.length >= 3);
  if (words.length) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map(escapeRe).sort((a, b) => b.length - a.length).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
    for (const m of t.matchAll(re)) take('term', m[0], m.index);
  }
  return found;
}

const SALT = randomBytes(16);
const TOKEN = /\[(EMAIL|PHONE|IBAN|CARD|CNP|SECRET|TERM)_[0-9a-f]{6}\]/g;
// The start of a placeholder that a stream may have cut in two.
const PARTIAL = /\[(?:[A-Z]{0,6}(?:_[0-9a-f]{0,6})?)?$/;

// One call to a model: personal data goes out as placeholders like [EMAIL_3fa9c1] and the answer comes back with the
// real values. The same value always gets the same placeholder (for as long as SILO runs), so a conversation that is
// sent again, round after round, keeps its placeholders, and the model can say "write to [EMAIL_3fa9c1]".
export class Masker {
  constructor(kinds, {terms = [], secrets = []} = {}) {
    this.kinds = kinds; this.terms = terms;
    this.secrets = secrets.filter(s => typeof s === 'string' && s.length >= 8);
    this.values = new Map(); this.kindOf = new Map();
  }
  token(kind, value) {
    const key = kind === 'term' ? value.toLowerCase() : value;
    const t = `[${kind.toUpperCase()}_${createHmac('sha256', SALT).update(kind + '\0' + key).digest('hex').slice(0, 6)}]`;
    if (!this.values.has(t)) { this.values.set(t, value); this.kindOf.set(t, kind); }
    return t;
  }
  mask(text) {
    if (typeof text !== 'string' || !text) return text;
    let t = text;
    // Keys SILO itself holds are hidden first, whatever shape they have.
    for (const s of this.secrets) if (t.includes(s)) t = t.split(s).join(this.token('secret', s));
    const found = findPii(t, this.kinds, this.terms);
    if (!found.length) return t;
    // Placeholders already in the text (a key hidden above, or one the model wrote back) are left whole: a word to
    // hide like "Secret" must not cut into [SECRET_3fa9c1].
    const held = [...t.matchAll(TOKEN)].map(m => [m.index, m.index + m[0].length]);
    let out = '', at = 0;
    for (const f of found) {
      if (held.some(([a, b]) => f.index < b && a < f.index + f.value.length)) continue;
      out += t.slice(at, f.index) + this.token(f.kind, f.value); at = f.index + f.value.length;
    }
    return out + t.slice(at);
  }
  maskDeep(v, d = 0) {
    if (typeof v === 'string') return this.mask(v);
    if (Array.isArray(v)) return d > 8 ? v : v.map(x => this.maskDeep(x, d + 1));
    if (v && typeof v === 'object') return d > 8 ? v : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.maskDeep(x, d + 1)]));
    return v;
  }
  // The conversation in SILO's own shape: text, content parts, tool calls and tool results. Images pass as they are.
  messages(list) {
    return list.map(m => {
      const o = {...m};
      if (typeof m.content === 'string') o.content = this.mask(m.content);
      else if (Array.isArray(m.content)) o.content = m.content.map(c => typeof c?.text === 'string' ? {...c, text: this.mask(c.text)} : c);
      if (Array.isArray(m.calls)) o.calls = m.calls.map(c => ({...c, args: this.maskDeep(c.args)}));
      if (Array.isArray(m.results)) o.results = m.results.map(r => ({...r, content: this.mask(String(r.content ?? ''))}));
      return o;
    });
  }
  // The system instructions, with a note on placeholders when anything was hidden.
  instructions(text) {
    const t = this.mask(text);
    return this.values.size ? t + '\n\nSome personal data in this conversation was replaced with placeholders such as [EMAIL_3fa9c1]. Write a placeholder exactly as it is wherever its value is needed, also in tool calls: SILO puts the real value back. Do not guess what a placeholder stands for.' : t;
  }
  unmask(text) { return typeof text === 'string' ? text.replace(TOKEN, t => this.values.get(t) ?? t) : text; }
  unmaskDeep(v, d = 0) {
    if (typeof v === 'string') return this.unmask(v);
    if (Array.isArray(v)) return d > 8 ? v : v.map(x => this.unmaskDeep(x, d + 1));
    if (v && typeof v === 'object') return d > 8 ? v : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.unmaskDeep(x, d + 1)]));
    return v;
  }
  // A streamed answer: a placeholder cut between two pieces is held back until it is whole.
  stream(onText) {
    let held = '';
    const push = d => {
      const t = held + d, m = t.match(PARTIAL), cut = m && t.length - m.index <= 14 ? m.index : t.length;
      held = t.slice(cut);
      const out = this.unmask(t.slice(0, cut));
      if (out) onText(out);
    };
    push.flush = () => { if (held) { const out = this.unmask(held); held = ''; onText(out); } };
    return push;
  }
  get size() { return this.values.size; }
  counts() { const c = {}; for (const k of this.kindOf.values()) c[k] = (c[k] || 0) + 1; return c; }
}

// ---- Tool results that give orders ---------------------------------------------------------------------------------

// Phrases that speak to the model rather than to a reader: in a web page, an email or an issue they are an attack. Each
// pattern is narrow on purpose; a page about prompt injection may trip one, and that only adds a warning.
const INJECTION = [
  ['ignore', 'tells the model to ignore its instructions', /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any|your|the system)\b[^.\n]{0,25}\b(?:instructions?|prompts?|rules|directions|guidelines|guardrails)\b/i],
  ['ignore', 'tells the model to ignore its instructions', /(?<!\p{L})(?:ignor[ăa]|uit[ăa]|nu\s+(?:mai\s+)?(?:ține|ţine|tine)\s+cont\s+de)(?!\p{L})[^.\n]{0,40}instruc[țţt]iuni/iu],
  ['role', 'tries to give the model a new role', /\b(?:you are now|from now on,? you (?:are|will|must)|act as an? (?:unrestricted|unfiltered|jailbroken)\b|developer mode (?:enabled|on)|\bDAN mode\b)/i],
  ['prompt', 'asks for the hidden instructions', /\b(?:reveal|print|show|repeat|output|leak)\b[^.\n]{0,30}\b(?:system prompt|your (?:system )?instructions|hidden instructions|initial prompt)\b/i],
  ['turn', 'fakes a message from the system or the assistant', /<\|(?:im_start|im_end|system|assistant)\|>|\[\/?INST\]|<<\/?SYS>>|<\/?(?:system|tool_result|function_results)>/i],
  ['hide', 'asks to keep something from the person', /\b(?:do not|don'?t|never)\b[^.\n]{0,20}\b(?:tell|inform|mention|reveal|show)\b[^.\n]{0,25}\b(?:the )?(?:user|operator|human|owner)\b/i],
  ['exfil', 'asks to send keys or data somewhere', /\b(?:send|post|forward|upload|e-?mail|exfiltrate|paste)\b[^.\n]{0,60}\b(?:api[ -]?keys?|passwords?|secrets?|credentials|access tokens?|tokens|the (?:conversation|chat history|system prompt))\b[^.\n]{0,60}(?:https?:\/\/|\b[\w.-]+@[\w.-]+\b|\bto\b)/i],
  ['tool', 'orders a tool call', /\b(?:call|use|invoke|run|execute)\b[^.\n]{0,20}\b(?:the )?(?:tool|function)\b[^.\n]{0,40}\b(?:now|immediately|without asking|silently)\b/i],
  ['hidden', 'hides text in invisible characters', /[​-‏⁠-⁤‪-‮]{4,}|[\u{E0000}-\u{E007F}]{2,}/u],
];
export const INJECTION_LABELS = Object.fromEntries(INJECTION.map(([k, label]) => [k, label]));

// The kinds of order found in a text, each once.
export function scanInjection(text) {
  const t = String(text ?? '').slice(0, 300000);
  return [...new Set(INJECTION.filter(([, , re]) => re.test(t)).map(([k]) => k))];
}
export const describeInjection = hits => hits.map(h => INJECTION_LABELS[h] || h).join('; ');

// ---- Rules ---------------------------------------------------------------------------------------------------------

// One rule per line: where, what to do, and a pattern. "answer redact Project Falcon" hides those words in answers,
// "tool ask /github.*close/" asks you before a resident closes an issue. A pattern between slashes is a regular
// expression; anything else is found as written, without case. Lines starting with # are notes.
export function parseRules(text) {
  const rules = [];
  for (const [i, raw] of String(text ?? '').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+)\s+(\S+)\s+(.+)$/);
    if (!m) fail(`Line ${i + 1}: write where (answer or tool), what to do, and the words or /pattern/.`);
    const where = m[1].toLowerCase(), action = m[2].toLowerCase(), pat = m[3].trim();
    if (!Object.hasOwn(RULE_ACTIONS, where)) fail(`Line ${i + 1}: "${m[1]}" is not answer or tool.`);
    if (!RULE_ACTIONS[where].includes(action)) fail(`Line ${i + 1}: for ${where} choose ${RULE_ACTIONS[where].join(' or ')}.`);
    if (pat.length > 300) fail(`Line ${i + 1}: keep the pattern under 300 characters.`);
    const re = pat.match(/^\/(.+)\/([imsu]*)$/);
    const source = re ? re[1] : escapeRe(pat), flags = re ? [...new Set(re[2] + 'i')].join('') : 'i';
    try { new RegExp(source, flags); } catch (e) { fail(`Line ${i + 1}: the pattern does not work (${e.message}).`); }
    rules.push({where, action, source, flags, line});
    if (rules.length > RULES_MAX) fail(`Keep it to ${RULES_MAX} rules.`);
  }
  return rules;
}
const compiled = new Map();
const regex = (r, g = '') => { const k = r.source + '/' + r.flags + g; let re = compiled.get(k); if (!re) { re = new RegExp(r.source, r.flags + g); compiled.set(k, re); } re.lastIndex = 0; return re; };

// An answer after the rules: block replaces it whole, redact hides what matched. hits names the rules that matched.
export function applyAnswerRules(rules, text) {
  let out = String(text ?? '');
  const hits = [];
  for (const r of rules || []) {
    if (r.where !== 'answer' || !regex(r).test(out)) continue;
    hits.push(r);
    if (r.action === 'block') return {text: '[Withheld by a guardrail: this answer matched a rule the owner set.]', hits, blocked: true};
    out = out.replace(regex(r, 'g'), '[REDACTED]');
  }
  return {text: out, hits, blocked: false};
}
// The first rule a tool call matches, a block before an ask. The call is read as its name and its arguments in JSON.
export function toolRule(rules, name, args) {
  const t = `${name} ${JSON.stringify(args ?? {})}`;
  const hit = (rules || []).filter(r => r.where === 'tool' && regex(r).test(t));
  return hit.find(r => r.action === 'block') || hit[0] || null;
}

// ---- Settings ------------------------------------------------------------------------------------------------------

export const DEFAULT_GUARDRAILS = {pii: {mode: 'off', kinds: Object.keys(PII_KINDS), terms: [], local: true}, injection: {mode: 'warn'}, rules: []};

// Settings as saved: what is given replaces what was there, part by part, and anything not given stays.
export function cleanGuardrails(raw = {}, was = DEFAULT_GUARDRAILS) {
  const prev = {...DEFAULT_GUARDRAILS, ...(was || {})}, p = raw?.pii || {}, pp = {...DEFAULT_GUARDRAILS.pii, ...(prev.pii || {})};
  const mode = p.mode ?? pp.mode;
  if (!['off', 'mask'].includes(mode)) fail('Personal data: choose off or mask.');
  const kinds = Array.isArray(p.kinds) ? [...new Set(p.kinds)] : pp.kinds;
  if (kinds.some(k => !Object.hasOwn(PII_KINDS, k))) fail('Unknown kind of personal data.');
  let terms = pp.terms;
  if (p.terms !== undefined) {
    const list = Array.isArray(p.terms) ? p.terms : String(p.terms).split(/\r?\n/);
    terms = [...new Set(list.map(w => String(w).trim().replace(/\s+/g, ' ')).filter(Boolean))];
    if (terms.length > TERMS_MAX) fail(`Hide at most ${TERMS_MAX} words.`);
    if (terms.some(w => w.length < 3 || w.length > 100)) fail('Each word to hide needs 3 to 100 characters.');
  }
  const local = p.local === undefined ? pp.local !== false : p.local === true;
  const inj = raw?.injection?.mode ?? prev.injection?.mode ?? 'warn';
  if (!INJECTION_MODES.includes(inj)) fail('Orders in tool results: choose off, warn, ask or block.');
  const rules = raw?.rules !== undefined ? parseRules(Array.isArray(raw.rules) ? raw.rules.join('\n') : raw.rules) : Array.isArray(prev.rules) ? prev.rules : [];
  return {pii: {mode, kinds, terms, local}, injection: {mode: inj}, rules};
}
