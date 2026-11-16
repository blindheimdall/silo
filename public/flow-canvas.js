// The workflow canvas: the steps of the editor drawn as a graph. Steps that run at the same time stand in one column,
// a review draws its way back to the step it sends work to, a condition marks the line into its step, and the steps a
// step reads from are wired to it when it is picked. Dragging a step moves it; dropping it on a column of resident steps
// makes it run at the same time as them. The canvas only reads the step editors and asks the editor to change them,
// so a workflow is saved the same way from both views.

export const NODE_W = 224, NODE_H = 96, COL = 272, ROW = 120, PAD = 32, PILL = 72, LEAD = 44;
const ITEM_USE = /\{\{\s*item\b/i, STEP_REF = /\{\{\s*step\s+(\d{1,2})(?!\d)/gi, CODE_REF = /\bsteps\[(\d{1,2})\]/g;
const EACH_SOURCE = /^\{\{\s*(brief|previous|step\s+(\d{1,2}))((?:\.[\w$@-]+|\[\d+\])*)\s*\}\}$/i;
const KIND = { agent: 'RESIDENT', review: 'REVIEW', approval: 'APPROVAL', action: 'APP', code: 'CODE', wait: 'WAIT', workflow: 'WORKFLOW' };
const pad2 = n => String(n).padStart(2, '0');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Steps run in columns: a resident step and the resident steps right after it that run at the same time.
export function stagesOf(steps) {
  const out = []; let i = 0;
  while (i < steps.length) {
    let h = i;
    while (steps[i].type === 'agent' && h + 1 < steps.length && steps[h + 1].parallel) h++;
    out.push(Array.from({ length: h - i + 1 }, (_, k) => i + k)); i = h + 1;
  }
  return out;
}

// Changes {{step N}} (and steps[N] in code) by a map of old to new step numbers, all at once.
export function remapRefs(text, map, code = false) {
  const swap = (m, lead, n) => lead + (map.has(Number(n)) ? map.get(Number(n)) : n);
  let s = String(text ?? '').replace(/(\{\{\s*step\s+)(\d{1,2})(?!\d)/gi, swap);
  if (code) s = s.replace(/(\bsteps\[)(\d{1,2})(?=\])/g, swap);
  return s;
}

// The earlier steps a step reads from, by number.
export function refsOf(s) {
  const out = new Set(), text = [s.prompt, s.each, ...Object.values(s.fields || {})].join('\n');
  for (const m of text.matchAll(STEP_REF)) out.add(Number(m[1]));
  for (const m of String(s.code || '').matchAll(CODE_REF)) out.add(Number(m[1]));
  if (s.when?.step) out.add(s.when.step);
  return out;
}

// What the server would refuse, or what would not work, said before saving. Same rules as validateWorkflow.
export function lint(steps, writes = () => false) {
  const out = steps.map(() => []), column = new Map(stagesOf(steps).flatMap((st, c) => st.map(i => [i, c])));
  steps.forEach((s, i) => {
    const say = m => out[i].push(m), w = s.when;
    if (w) {
      if (!String(w.text || '').trim()) say('The condition needs a word or phrase to look for.');
      if (i === 0 && !w.step) say('The first step has no step before it to check.');
      else if (w.step > i) say(`The condition looks at step ${pad2(w.step)}, which comes later.`);
    }
    if (s.parallel) {
      if (i === 0 || steps[i - 1].type !== 'agent') say('It runs at the same time as the step above, which is not a resident step.');
      else if (s.each || steps[i - 1].each) say('A step that repeats for each item, or follows one, cannot run at the same time.');
    }
    if (s.each) {
      const m = String(s.each).match(EACH_SOURCE);
      if (!m) say('"For each item in" takes one value from before, like {{step 1}}.');
      else if (m[2] && (Number(m[2]) < 1 || Number(m[2]) > i)) say('It can only repeat over the answer of an earlier step.');
      else if (i === 0 && m[1].toLowerCase() === 'previous') say('The first step has no step before it to repeat over.');
    }
    if ((s.type === 'agent' || s.type === 'review') && !String(s.prompt || '').trim()) say('It needs instructions.');
    if ((s.type === 'agent' || s.type === 'review') && !s.agentId) say('Pick a resident.');
    if (s.type === 'code' && !String(s.code || '').trim()) say('It needs its code.');
    if (s.type === 'action' && (!s.app || !s.op)) say('Pick the app and what it does.');
    if (s.type === 'workflow' && !s.workflowId) say('Pick the workflow it runs.');
    if (s.type === 'review') {
      const t = s.target;
      if (!t || t < 1 || t > i) say('A review has to send work back to an earlier step.');
      else if (steps[t - 1].type !== 'agent') say(`It sends work back to step ${pad2(t)}, which is not a resident step.`);
      else for (let k = t; k < i; k++) if (steps[k].type === 'action' && writes(steps[k])) { say(`Step ${pad2(k + 1)} would change something again on every round. Send the work back to a step after it.`); break; }
    }
    if (!s.each && ITEM_USE.test([s.prompt, ...Object.values(s.fields || {})].join('\n'))) say('It uses {{item}}, but it does not repeat for each item.');
    const later = [...refsOf({ ...s, when: null })].filter(n => n > i).sort((a, b) => a - b);
    if (later.length) say(`It reads step ${later.map(pad2).join(', ')}, which ${later.length === 1 ? 'comes' : 'come'} after it.`);
    const beside = [...refsOf({ ...s, when: null })].filter(n => n <= i && n !== i + 1 && column.get(n - 1) === column.get(i)).sort((a, b) => a - b);
    if (beside.length) say(`It runs at the same time as step ${beside.map(pad2).join(', ')}, so it cannot read ${beside.length === 1 ? 'its' : 'their'} answer yet.`);
  });
  return out;
}

// Where every step stands. Room is left above for the lines of reviews, and below for the wires of the picked step.
export function layout(steps) {
  const stages = stagesOf(steps), rows = Math.max(1, ...stages.map(s => s.length)), reviews = steps.filter(s => s.type === 'review').length;
  const top = PAD + (reviews ? 26 + 14 * reviews : 0), x0 = PAD + PILL + LEAD, body = rows * ROW - (ROW - NODE_H);
  const nodes = [];
  stages.forEach((st, c) => st.forEach((i, r) => nodes[i] = { i, stage: c, row: r, x: x0 + c * COL, y: top + (body - (st.length * ROW - (ROW - NODE_H))) / 2 + r * ROW }));
  const mid = top + body / 2, end = x0 + stages.length * COL - (COL - NODE_W) + LEAD;
  return { stages, nodes, top, mid, x0, end, width: end + PILL + PAD, height: top + body + PAD + 34 };
}

// A step may join a column when all of them, and it, are resident steps that do not repeat for each item.
export function canJoin(steps, stage, from) {
  const all = [...stage.filter(i => i !== from), from];
  return all.length > 1 && all.every(i => steps[i].type === 'agent' && !steps[i].each);
}

// The new order and same-time marks after a step is dropped in a gap between columns or on a column. Null: nothing moves.
export function rearrange(steps, from, drop) {
  const stages = stagesOf(steps).map(s => [...s]), si = stages.findIndex(s => s.includes(from));
  stages[si] = stages[si].filter(i => i !== from);
  const gone = !stages[si].length; if (gone) stages.splice(si, 1);
  const shift = n => (gone && si < n ? n - 1 : n);
  if (drop.kind === 'gap') stages.splice(shift(drop.gap), 0, [from]);
  else stages[shift(drop.stage)].push(from);
  const order = stages.flat(), parallel = stages.flatMap(s => s.map((_, k) => k > 0));
  const same = order.every((v, k) => v === k) && parallel.every((p, k) => p === !!steps[k].parallel && (k > 0 || !p));
  return same ? null : { order, parallel };
}

// The drop place under a point of the canvas, for the step being dragged.
export function dropAt(steps, lay, from, x) {
  const n = lay.stages.length;
  for (let c = 0; c < n; c++) {
    const left = lay.x0 + c * COL;
    if (x >= left - 6 && x <= left + NODE_W + 6) {
      if (canJoin(steps, lay.stages[c], from) && !lay.stages[c].includes(from)) return { kind: 'stage', stage: c };
      return { kind: 'gap', gap: x < left + NODE_W / 2 ? c : c + 1 };
    }
  }
  const g = Math.max(0, Math.min(n, Math.round((x - lay.x0 + (COL - NODE_W) / 2) / COL)));
  return { kind: 'gap', gap: g };
}

const curve = (x1, y1, x2, y2) => { const m = (x1 + x2) / 2; return `M${x1} ${y1}C${m} ${y1} ${m} ${y2} ${x2} ${y2}`; };

export class FlowCanvas {
  // read(): the steps as the editors say now, each with el, title, sub and text for showing.
  // arrange(order, parallel), select(el), add(type, afterEl): changes made through the editors.
  constructor(root, { read, arrange, select, add, writes, kinds }) {
    Object.assign(this, { root, read, arrange, select: select, add, writes, view: { x: 0, y: 0, k: 1 }, sel: null, drag: null, size: '', frame: 0 });
    root.innerHTML = `<div class="fc-tools"><div class="fc-add" role="group" aria-label="Add a step"><span>ADD</span>${kinds.map(([t, l]) => `<button type="button" class="chip" data-fc-add="${t}">${esc(l)}</button>`).join('')}</div><div class="fc-zoom" role="group" aria-label="Zoom"><button type="button" class="chip" data-fc-zoom="-1" aria-label="Zoom out">−</button><button type="button" class="chip fc-k" data-fc-zoom="0" title="Fit the workflow">FIT</button><button type="button" class="chip" data-fc-zoom="1" aria-label="Zoom in">+</button></div></div>`
      + `<div class="fc-viewport" tabindex="0" role="application" aria-roledescription="workflow canvas" aria-label="Workflow canvas. Left and right arrows pick a step. Alt with an arrow moves it."><div class="fc-world"></div><div class="fc-hint">DRAG A STEP TO MOVE IT / DROP IT ON A COLUMN OF RESIDENT STEPS TO RUN AT THE SAME TIME / DRAG THE BACKGROUND TO PAN / CTRL + WHEEL ZOOMS</div></div><ul class="fc-problems" aria-live="polite"></ul>`;
    this.vp = root.querySelector('.fc-viewport'); this.world = root.querySelector('.fc-world');
    root.addEventListener('click', e => this.onClick(e));
    this.vp.addEventListener('pointerdown', e => this.onDown(e));
    this.vp.addEventListener('pointermove', e => this.onMove(e));
    this.vp.addEventListener('pointerup', e => this.onUp(e));
    this.vp.addEventListener('pointercancel', () => this.cancel());
    this.vp.addEventListener('lostpointercapture', () => this.cancel());
    this.vp.addEventListener('wheel', e => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); this.zoomAt(this.view.k * Math.exp(-e.deltaY / 400), e); }, { passive: false });
    this.vp.addEventListener('dblclick', e => { if (!e.target.closest('.fc-node')) this.fit(true); });
    this.vp.addEventListener('keydown', e => this.onKey(e));
    this.resize = new ResizeObserver(() => { if (this.root.offsetParent) this.fit(); });
    this.resize.observe(this.vp);
  }
  destroy() { this.resize.disconnect(); cancelAnimationFrame(this.frame); }
  // Many changes in one frame draw once.
  later() { cancelAnimationFrame(this.frame); this.frame = requestAnimationFrame(() => this.render()); }
  render() {
    if (this.drag?.moved) return;
    const steps = this.read(), lay = layout(steps), bad = lint(steps, this.writes);
    if (!steps.length) { this.world.innerHTML = ''; this.root.querySelector('.fc-problems').innerHTML = ''; return; }
    if (!steps.some(s => s.el === this.sel)) { this.sel = steps[0].el; this.select(this.sel); }
    this.steps = steps; this.lay = lay;
    const si = steps.findIndex(s => s.el === this.sel), feeds = si >= 0 ? [...refsOf(steps[si])].filter(n => n >= 1 && n <= si).map(n => n - 1) : [];
    const N = lay.nodes, cx = n => n.x + NODE_W / 2, right = n => n.x + NODE_W, midY = n => n.y + NODE_H / 2;
    const paths = [], labels = [];
    // The lines between columns, through one point when a column has more than one step.
    const cols = [[{ x: PAD, y: lay.mid - 15, w: PILL, h: 30, pill: true }], ...lay.stages.map(st => st.map(i => N[i])), [{ x: lay.end, y: lay.mid - 15, w: PILL, h: 30, pill: true }]];
    const outOf = n => [n.pill ? n.x + n.w : right(n), n.pill ? lay.mid : midY(n)], into = n => [n.x, n.pill ? lay.mid : midY(n)];
    for (let c = 0; c + 1 < cols.length; c++) {
      const a = cols[c], b = cols[c + 1], bus = a.length > 1 || b.length > 1;
      const jx = (outOf(a[0])[0] + into(b[0])[0]) / 2, jy = lay.mid;
      const line = (d, cls = '') => paths.push(`<path class="fc-edge ${cls}" d="${d}"/>`);
      const cond = n => !n.pill && steps[n.i].when ? 'cond' : '';
      if (!bus) { line(curve(...outOf(a[0]), ...into(b[0])), cond(b[0]) + ' arrow'); }
      else {
        for (const n of a) line(curve(...outOf(n), jx, jy));
        for (const n of b) line(curve(jx, jy, ...into(n)), cond(n) + ' arrow');
        paths.push(`<circle class="fc-joint" cx="${jx}" cy="${jy}" r="3.5"/>`);
      }
      for (const n of b) if (!n.pill && steps[n.i].when) { const w = steps[n.i].when; labels.push(`<div class="fc-label cond" style="left:${n.x}px;top:${n.y - 19}px">${w.op === 'missing' ? 'UNLESS' : 'IF'} ${w.step ? pad2(w.step) : 'PREVIOUS'} SAYS “${esc(String(w.text).slice(0, 24))}”</div>`); }
    }
    // A review's way back, above everything, one lane each.
    let lane = 0;
    steps.forEach((s, i) => {
      if (s.type !== 'review' || !(s.target >= 1 && s.target <= i)) return;
      const r = N[i], t = N[s.target - 1], yT = lay.top - 22 - 14 * lane++, x1 = cx(r) + 18, x2 = cx(t) - 18;
      paths.push(`<path class="fc-edge back arrow" d="M${x1} ${r.y}C${x1} ${yT} ${x2} ${yT} ${x2} ${t.y}"/>`);
      labels.push(`<div class="fc-label back" style="left:${(x1 + x2) / 2}px;top:${0.25 * (r.y + t.y) / 2 + 0.75 * yT - 9}px">BACK TO ${pad2(s.target)} / ${s.rounds}×</div>`);
    });
    // The picked step's wires to the steps it reads from, below everything.
    if (si >= 0) {
      const low = Math.max(...N.map(n => n.y + NODE_H)) + 22;
      for (const f of feeds) { const a = N[f], b = N[si]; paths.push(`<path class="fc-edge wire" d="M${cx(a)} ${a.y + NODE_H}C${cx(a)} ${low} ${cx(b)} ${low} ${cx(b)} ${b.y + NODE_H}"/>`); }
    }
    const nodes = steps.map((s, i) => {
      const n = N[i], cls = ['fc-node', s.type, s.el === this.sel && 'sel', bad[i].length && 'bad', s.each && 'each', s.when && 'cond', feeds.includes(i) && 'feeds'].filter(Boolean).join(' ');
      return `<div class="${cls}" id="fc-n-${i}" data-i="${i}" role="option" aria-selected="${s.el === this.sel}" aria-label="Step ${i + 1}, ${KIND[s.type].toLowerCase()}: ${esc(s.title)}${bad[i].length ? '. ' + esc(bad[i].join(' ')) : ''}" style="left:${n.x}px;top:${n.y}px"><span class="fc-idx">STEP ${pad2(i + 1)} / ${KIND[s.type]}${s.each ? ' / EACH' : ''}</span><strong>${esc(s.title)}</strong>${s.sub ? `<small>${esc(s.sub)}</small>` : ''}<p>${esc(String(s.text || '').replace(/\s+/g, ' ').slice(0, 96))}</p>${bad[i].length ? `<b class="fc-bad" aria-hidden="true">!</b>` : ''}</div>`;
    }).join('');
    const pills = `<div class="fc-pill" style="left:${PAD}px;top:${lay.mid - 15}px">BRIEF</div><div class="fc-pill end" style="left:${lay.end}px;top:${lay.mid - 15}px">ANSWER</div>`;
    const cols2 = lay.stages.map((st, c) => st.length > 1 ? `<div class="fc-same" style="left:${lay.x0 + c * COL - 10}px;top:${N[st[0]].y - 24}px;width:${NODE_W + 20}px;height:${st.length * ROW - (ROW - NODE_H) + 34}px"><span>SAME TIME</span></div>` : '').join('');
    this.world.style.width = lay.width + 'px'; this.world.style.height = lay.height + 'px';
    this.world.innerHTML = `${cols2}<svg class="fc-edges" width="${lay.width}" height="${lay.height}" aria-hidden="true"><defs><marker id="fc-head" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L8 4L0 8z"/></marker></defs>${paths.join('')}</svg>${pills}${labels.join('')}${nodes}<div class="fc-drop" hidden></div>`;
    this.vp.setAttribute('aria-activedescendant', si >= 0 ? 'fc-n-' + si : '');
    const list = bad.flatMap((m, i) => m.map(t => `<li><button type="button" data-fc-pick="${i}">STEP ${pad2(i + 1)}</button> ${esc(t)}</li>`));
    if (steps.every(s => s.type === 'approval' || s.type === 'wait')) list.unshift('<li><b>WORKFLOW</b> It needs at least one resident step or app step.</li>');
    this.root.querySelector('.fc-problems').innerHTML = list.join('');
    const size = lay.width + 'x' + lay.height;
    if (size !== this.size) { this.size = size; this.fit(); } else this.apply();
  }
  apply() { const { x, y, k } = this.view; this.world.style.transform = `translate(${x}px,${y}px) scale(${k})`; this.root.querySelector('.fc-k').textContent = Math.round(k * 100) + '%'; }
  // On its own the canvas keeps the steps readable (80% at least) and starts at the brief; FIT shows all of it.
  fit(all = false) {
    if (!this.lay) return;
    const r = this.vp.getBoundingClientRect(); if (!r.width) { this.size = ''; return; }
    const whole = Math.min(1, (r.width - 24) / this.lay.width, (r.height - 30) / this.lay.height), k = Math.max(all ? 0.3 : 0.8, whole);
    const w = this.lay.width * k, h = this.lay.height * k;
    this.view = { k, x: w <= r.width ? (r.width - w) / 2 : 0, y: h <= r.height - 24 ? (r.height - 24 - h) / 2 : 0 };
    this.apply();
  }
  zoomAt(k, e) {
    k = Math.max(0.3, Math.min(1.8, k));
    const r = this.vp.getBoundingClientRect(), px = e ? e.clientX - r.left : r.width / 2, py = e ? e.clientY - r.top : r.height / 2, v = this.view;
    this.view = { k, x: px - (px - v.x) * k / v.k, y: py - (py - v.y) * k / v.k }; this.apply();
  }
  toWorld(e) { const r = this.vp.getBoundingClientRect(); return { x: (e.clientX - r.left - this.view.x) / this.view.k, y: (e.clientY - r.top - this.view.y) / this.view.k }; }
  pick(el, focusEditor = false) { this.sel = el; this.select(el, focusEditor); this.render(); this.reveal(); }
  // The picked step is moved into view when it is outside, by as little as it takes.
  reveal() {
    const i = this.steps?.findIndex(s => s.el === this.sel), n = i >= 0 && this.lay?.nodes[i]; if (!n) return;
    const r = this.vp.getBoundingClientRect(), { k } = this.view, m = 24, x = n.x * k + this.view.x, y = n.y * k + this.view.y, w = NODE_W * k, h = NODE_H * k;
    if (x < m) this.view.x += m - x; else if (x + w > r.width - m) this.view.x -= x + w - (r.width - m);
    if (y < m) this.view.y += m - y; else if (y + h > r.height - 30) this.view.y -= y + h - (r.height - 30);
    this.apply();
  }
  onClick(e) {
    const add = e.target.closest('[data-fc-add]'), z = e.target.closest('[data-fc-zoom]'), p = e.target.closest('[data-fc-pick]');
    if (add) {
      const steps = this.read(), si = steps.findIndex(s => s.el === this.sel), stage = this.lay?.stages.find(st => st.includes(si));
      const el = this.add(add.dataset.fcAdd, stage ? steps[stage[stage.length - 1]].el : null);
      if (el) this.pick(el, true);
    }
    if (z) { const d = Number(z.dataset.fcZoom); if (d) this.zoomAt(this.view.k * (d > 0 ? 1.2 : 1 / 1.2)); else this.fit(true); }
    if (p) { const s = this.read()[Number(p.dataset.fcPick)]; if (s) this.pick(s.el, true); }
  }
  onDown(e) {
    if (e.button !== 0) return;
    const node = e.target.closest('.fc-node');
    this.drag = { node, i: node ? Number(node.dataset.i) : -1, sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y, moved: false, id: e.pointerId };
    this.vp.setPointerCapture(e.pointerId);
    if (!node) this.vp.classList.add('panning');
  }
  onMove(e) {
    const d = this.drag; if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    if (!d.node) { this.view.x = d.vx + dx; this.view.y = d.vy + dy; this.apply(); d.moved = true; return; }
    if (!d.moved) { d.moved = true; d.node.classList.add('dragging'); this.vp.classList.add('moving'); }
    const n = this.lay.nodes[d.i];
    d.node.style.transform = `translate(${dx / this.view.k}px,${dy / this.view.k}px) rotate(-1deg)`;
    d.drop = dropAt(this.steps, this.lay, d.i, n.x + NODE_W / 2 + dx / this.view.k);
    const box = this.world.querySelector('.fc-drop'), lay = this.lay;
    d.change = rearrange(this.steps, d.i, d.drop);
    box.hidden = !d.change;
    if (!d.change) return;
    if (d.drop.kind === 'gap') {
      box.className = 'fc-drop gap';
      Object.assign(box.style, { left: (lay.x0 + d.drop.gap * COL - (COL - NODE_W) / 2 - 2) + 'px', top: (lay.top - 8) + 'px', width: '4px', height: (lay.height - lay.top - PAD - 18) + 'px' });
    } else {
      const st = lay.stages[d.drop.stage], top = lay.nodes[st[0]].y, bottom = lay.nodes[st[st.length - 1]].y + NODE_H;
      box.className = 'fc-drop join';
      Object.assign(box.style, { left: (lay.x0 + d.drop.stage * COL - 12) + 'px', top: (top - 12) + 'px', width: (NODE_W + 24) + 'px', height: (bottom - top + 24) + 'px' });
    }
  }
  onUp(e) {
    const d = this.drag; if (!d || e.pointerId !== d.id) return;
    this.drag = null; this.vp.classList.remove('panning', 'moving');
    if (d.node && !d.moved) { this.pick(this.steps[d.i].el); this.vp.focus({ preventScroll: true }); return; }
    if (d.node && d.change) { this.arrange(d.change.order, d.change.parallel); this.sel = this.steps[d.i].el; }
    this.render();
  }
  cancel() { if (!this.drag) return; const moved = this.drag.moved && this.drag.node; this.drag = null; this.vp.classList.remove('panning', 'moving'); if (moved) this.render(); }
  onKey(e) {
    if (e.target !== this.vp || !this.steps?.length) return;
    const i = this.steps.findIndex(s => s.el === this.sel), n = this.steps.length;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault(); e.stopPropagation();
      const to = Math.max(0, Math.min(n - 1, i + (e.key === 'ArrowRight' ? 1 : -1)));
      if (!e.altKey) { this.pick(this.steps[to].el); return; }
      // Alt and an arrow: the step goes into the gap before or after its column, on its own.
      const c = this.lay.stages.findIndex(st => st.includes(i)), alone = this.lay.stages[c].length === 1;
      const gap = e.key === 'ArrowRight' ? (alone ? c + 2 : c + 1) : (alone ? c - 1 : c);
      if (gap < 0 || gap > this.lay.stages.length) return;
      const change = rearrange(this.steps, i, { kind: 'gap', gap });
      if (change) { this.arrange(change.order, change.parallel); this.render(); this.reveal(); }
    } else if (e.key === 'Enter') { e.preventDefault(); this.pick(this.sel, true); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); this.zoomAt(this.view.k * 1.2); }
    else if (e.key === '-') { e.preventDefault(); this.zoomAt(this.view.k / 1.2); }
    else if (e.key === '0') { e.preventDefault(); this.fit(true); }
  }
}
