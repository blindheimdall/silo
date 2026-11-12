// Evaluation maths: checks with weights, repeated attempts, scores, case-by-case comparison with an earlier report,
// line differences and how far a judge can be trusted. No I/O here: server.mjs runs the cases and keeps the reports.
export const REPEAT_DEFAULT = 3, REPEAT_MAX = 5;
// A judged check passes at this score out of 10 or above.
export const PASS_SCORE = 7;
export const CHECK_OPS = ['contains', 'missing', 'regex', 'field', 'judge', 'maxcost', 'maxms', 'maxtokens'];
export const LIMIT_OPS = ['maxcost', 'maxms', 'maxtokens'];
export const GATES = ['off', 'test', 'hold'];
// What a case did compared with the same case in the report before: it broke or got fixed (the share of passing
// attempts moved by half or more), it passes a little more or less often (flaky), its score moved by a fifth or more
// while it passed as often, or nothing changed.
export const CASE_CHANGES = ['broke', 'worse', 'flaky', 'new', 'better', 'fixed', 'same'];

export const weightOf = c => { const w = Number(c?.weight); return Number.isInteger(w) && w >= 1 && w <= 5 ? w : 1; };
export const repeatOf = n => { const r = Number(n); return Number.isInteger(r) && r >= 1 && r <= REPEAT_MAX ? r : REPEAT_DEFAULT; };

// "PASS 8", "FAIL 3", "8/10", "PASS" or "FAIL" on the first line, then why. A PASS with a score below the bar is a FAIL.
export function parseJudge(text) {
  const t = String(text || '').trim(), [first = '', ...rest] = t.split('\n');
  const verdict = first.match(/\b(PASS|FAIL)\b/i)?.[1]?.toUpperCase();
  const m = first.match(/(?:^|[^\w.])(10|[0-9])(?:\.\d+)?\s*(?:\/\s*10|out of 10)?(?![\w.])/i);
  const num = m ? Number(m[1]) : null;
  const pass = verdict ? verdict === 'PASS' && (num === null || num >= PASS_SCORE) : num !== null && num >= PASS_SCORE;
  const score = num !== null ? num / 10 : pass ? 1 : 0;
  const reason = (rest.join(' ').trim() || first.replace(/\b(PASS|FAIL)\b\W*/i, '').trim() || t).slice(0, 240);
  return { pass, score: verdict === 'FAIL' && num === null ? 0 : score, reason, understood: !!verdict || num !== null };
}

// One attempt. checks: [{weight, pass, score?}]; a judged check counts with its score, the others with 1 or 0.
export function scoreAttempt(checks) {
  let total = 0, got = 0;
  for (const c of checks) { const w = weightOf(c); total += w; got += w * (typeof c.score === 'number' ? c.score : c.pass ? 1 : 0); }
  return total ? got / total : 1;
}
// Every attempt of one case. A case passes when every attempt passed, and is flaky when only some did.
export function summarizeCase(attempts) {
  const n = attempts.length, passes = attempts.filter(a => a.ok).length;
  return { attempts: n, passes, rate: n ? passes / n : 0, score: n ? attempts.reduce((s, a) => s + a.score, 0) / n : 0, ok: n > 0 && passes === n, flaky: passes > 0 && passes < n };
}
// Wilson interval for k passes out of n attempts: where the true pass rate most likely is (95%).
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}
const round1 = x => Math.round(x * 10) / 10;
// The suite's score from 0 to 100: the mean of its case scores. Older reports without scores count passes.
export function suiteScore(results) {
  if (!results.length) return 0;
  return round1(results.reduce((s, r) => s + (typeof r.score === 'number' ? r.score : r.ok ? 1 : 0), 0) / results.length * 100);
}

const rateOf = r => typeof r.rate === 'number' ? r.rate : r.ok ? 1 : 0;
const caseScore = r => typeof r.score === 'number' ? r.score : rateOf(r);
export function compareCase(prev, cur) {
  if (!prev) return 'new';
  const pr = rateOf(prev), cr = rateOf(cur);
  if (pr - cr >= 0.5) return 'broke';
  if (cr - pr >= 0.5) return 'fixed';
  if (pr !== cr) return 'flaky';
  const d = caseScore(cur) - caseScore(prev);
  if (d <= -0.2) return 'worse';
  if (d >= 0.2) return 'better';
  return cr > 0 && cr < 1 ? 'flaky' : 'same';
}
// Is the pass rate p2 = k2/n2 clearly below p1 = k1/n1? One-sided two-proportion z-test at 95%.
export function significantDrop(k1, n1, k2, n2) {
  if (!n1 || !n2 || k2 / n2 >= k1 / n1) return false;
  const p = (k1 + k2) / (n1 + n2), se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se > 0 && (k1 / n1 - k2 / n2) / se >= 1.645;
}
const tally = rep => rep.results.reduce((t, r) => ({ k: t.k + (r.passes ?? (r.ok ? 1 : 0)), n: t.n + (r.attempts ?? 1) }), { k: 0, n: 0 });
// The whole report against the one before it. It got worse when a case broke, a case scored clearly lower while passing
// as often, or the pass rate over every attempt fell more than chance explains. One unlucky attempt does not count.
export function compareReports(prev, cur) {
  const before = new Map((prev?.results || []).map(r => [r.testId, r]));
  const cases = {}, count = Object.fromEntries(CASE_CHANGES.map(k => [k, 0]));
  for (const r of cur.results) { const c = compareCase(before.get(r.testId), r); cases[r.testId] = c; count[c]++; }
  const prevScore = typeof prev?.score === 'number' ? prev.score : prev ? suiteScore(prev.results || []) : null;
  const scoreDelta = prevScore === null ? null : round1(cur.score - prevScore);
  const a = prev && tally(prev), b = tally(cur), drop = !!prev && significantDrop(a.k, a.n, b.k, b.n);
  const worse = !!prev && (count.broke > 0 || count.worse > 0 || drop);
  return { baseline: prev?.id || null, cases, count, scoreDelta, ...(drop && { drop: true }), worse };
}

// A line diff (longest common subsequence). Long texts are cut so the work stays small.
export function lineDiff(a, b, max = 400) {
  const A = String(a ?? '').split('\n').slice(0, max), B = String(b ?? '').split('\n').slice(0, max);
  const n = A.length, m = B.length, L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push([' ', A[i]]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push(['-', A[i++]]);
    else out.push(['+', B[j++]]);
  }
  while (i < n) out.push(['-', A[i++]]);
  while (j < m) out.push(['+', B[j++]]);
  return out;
}

// How often a judge agreed with the person who checked its verdicts. Reliable from 5 votes at 80% or more.
export function judgeTrust(cal) {
  const agree = cal?.agree || 0, disagree = cal?.disagree || 0, total = agree + disagree;
  return { agree, total, rate: total ? agree / total : null, reliable: total < 5 ? null : agree / total >= 0.8 };
}

// Checks as people write them, one per line: "op: text" or "op x3: text" for a weight of 3.
export function checkLine(c) { return c.op + (weightOf(c) > 1 ? ' x' + weightOf(c) : '') + ': ' + c.text; }
