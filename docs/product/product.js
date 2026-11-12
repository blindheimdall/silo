'use strict';

const byId = id => document.getElementById(id);
const cases = [
  {
    name: 'Connect three silos', stack: 'SILO RADIO · SCOPED ACCESS',
    start: 'Transmit request', initial: 'Start the simulation or select a floor to inspect the route.',
    steps: [
      ['C', 'Support silo', 'Ask Operations for a report', 'A Support resident requests the weekly uptime summary from an Operations resident. Support signs the request with its own key and attaches the capability chain.', 'OUTBOUND REQUEST', 'From: Support → Operations\nTask: Summarize weekly uptime\nCapability chain: Operations → Analytics → Support'],
      ['A', 'Operations silo', 'Check the capability chain', 'Operations owns the reports. It checks the request signature, the destination and each signed grant. Analytics may delegate only a subset of the rights it received.', 'SIGNED RIGHTS', 'Operations → Analytics: reports/ · read · 2 hours\nAnalytics → Support: reports/uptime/ · read · 30 min'],
      ['A', 'Operations resident', 'Read inside the granted folder', 'The Operations resident can read inside reports/uptime/. Operations checks expiry, revocation and budget where the files live. Try revoking the grant before the read.', 'FILE SCOPE', 'ALLOW  reports/uptime/weekly.md\nDENY   reports/finance/budget.md'],
      ['C', 'Support silo', 'Receive the signed answer', 'Operations signs the answer and binds it to the original request. Support receives the summary. The receiving silo sees the answer that the Operations resident returned.', 'SAMPLE RESPONSE', 'Weekly uptime: 99.92%\nOne interruption in the EU region.\nSigned by Operations · request matched']
    ],
    revoke: 2, complete: 'Simulation complete. Support received the signed reply.'
  },
  {
    name: 'Triage a GitHub issue', stack: 'GITHUB · AGENT · APPROVAL',
    start: 'Simulate new issue', initial: 'Run the sample to see exactly what would be posted.',
    steps: [
      ['001', 'Uplink', 'Receive an issue event', 'A GitHub event starts the workflow. The issue title and body become the brief.', 'TRIGGER DATA', 'repository: demo/client\nissue: #42\ntitle: Export stops at 90%'],
      ['014', 'Triage resident', 'Read the issue and draft a reply', 'A resident uses GitHub issue context and proposes a response for the maintainer to review.', 'DRAFT', 'Thanks for the report. Could you share the app version and export format so we can reproduce this?'],
      ['032', 'Approval terminal', 'Review the exact comment', 'An approval step pauses the workflow. Rejecting ends the run before the GitHub write.', 'PROPOSED ACTION', 'GitHub / comment on issue #42\nThanks for the report. Could you share the app version and export format so we can reproduce this?'],
      ['001', 'GitHub connector', 'Post the approved comment', 'The app step receives the reviewed text and sends it to the issue in a real run.', 'SAMPLE RESULT', 'Comment accepted on demo/client#42.']
    ],
    approval: 2, complete: 'Simulation complete. GitHub comment action reached.'
  },
  {
    name: 'Log an incoming request', stack: 'GMAIL · RESIDENT · SHEETS',
    start: 'Simulate incoming email', initial: 'Follow the sample from an email to a structured spreadsheet row.',
    steps: [
      ['001', 'Google account', 'Read a new Gmail message', 'A configured email trigger starts the workflow. The subject and message are passed to a resident as input.', 'SAMPLE EMAIL', 'Subject: Request for 12 units\nPlease send a quote to Purchasing by Friday.'],
      ['048', 'Intake resident', 'Extract structured fields', 'The resident turns the message into fields the next app step can use.', 'RESIDENT OUTPUT', '{\n  "team": "Purchasing",\n  "quantity": 12,\n  "due": "Friday"\n}'],
      ['032', 'Approval terminal', 'Check the proposed row', 'A person checks the extracted values before the workflow writes to the spreadsheet.', 'PROPOSED ROW', 'Requests / Purchasing | 12 | Friday'],
      ['001', 'Google Sheets', 'Append the approved row', 'The Sheets app step maps the approved fields into cells using the configured Google account.', 'SAMPLE RESULT', 'New row added to Requests.']
    ],
    approval: 2, complete: 'Simulation complete. Google Sheets append action reached.'
  }
];

function node(tag, value, className) {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}

let selectedCase = 0;
let inspected = 0;
let current = -1;
let blocked = false;
const caseButtons = [];
let floorButtons = [];
const compactLayout = window.matchMedia('(max-width: 760px)');
const mobileAction = byId('mobile-sim-action');

function showInspection() {
  const title = byId('step-title');
  title.focus({preventScroll:true});
  title.closest('.inspection').scrollIntoView({block:'start'});
}

mobileAction.addEventListener('click', () => {
  if (current < 0) advance();
  showInspection();
});

for (const [index, example] of cases.entries()) {
  const button = node('button', '', 'case');
  const label = node('span', '');
  label.append(node('b', example.name), node('small', example.stack));
  button.type = 'button';
  button.append(node('i', String(index + 1).padStart(2, '0')), label);
  button.addEventListener('click', () => {
    selectedCase = index;
    reset();
  });
  caseButtons.push(button);
  byId('cases').append(button);
}

function reset() {
  inspected = 0;
  current = -1;
  blocked = false;
  caseButtons.forEach((button, index) => button.setAttribute('aria-pressed', String(index === selectedCase)));
  floorButtons = cases[selectedCase].steps.map(([level, place, title], index) => {
    const button = node('button', '', 'floor');
    const label = node('span', '');
    label.append(node('strong', title), node('small', place));
    button.type = 'button';
    button.append(node('span', level.length === 1 ? 'NODE ' + level : 'L' + level, 'node'), label, node('span', '', 'signal'));
    button.addEventListener('click', () => {
      inspected = index;
      render();
      if (compactLayout.matches) showInspection();
    });
    return button;
  });
  byId('floors').replaceChildren(...floorButtons);
  render();
}

function action(label, handler, primary = false) {
  const button = node('button', label, primary ? 'key primary' : 'key');
  button.type = 'button';
  button.addEventListener('click', () => {
    handler();
    byId('action-controls').querySelector('button')?.focus({preventScroll:true});
  });
  byId('action-controls').append(button);
}

function advance() {
  current += 1;
  inspected = Math.min(current, cases[selectedCase].steps.length - 1);
  render();
}

function block() {
  blocked = true;
  inspected = current;
  render();
}

function render() {
  const example = cases[selectedCase];
  const [, place, title, description, payloadLabel, payload] = example.steps[inspected];
  const done = current === example.steps.length;
  const approval = current === example.approval;
  const revocation = current === example.revoke;
  const denied = blocked && current === inspected;
  byId('step-meta').textContent = 'STEP ' + (inspected + 1) + ' / ' + place.toUpperCase();
  byId('step-title').textContent = denied ? (revocation ? 'Access revoked' : 'Approval rejected') : title;
  byId('step-description').textContent = denied ? (revocation ? 'Operations refuses the request after revocation. The resident cannot perform the read.' : 'The workflow ends at the approval gate. The app action is skipped.') : description;
  byId('payload-label').textContent = denied ? 'SIMULATION RESULT' : inspected > current ? 'PREVIEW / ' + payloadLabel : payloadLabel;
  byId('step-payload').textContent = denied ? (revocation ? 'DENY · capability revoked\nNo file read · no report returned' : 'STOP · rejected by operator\nNo write action performed') : payload;
  byId('radio-route').hidden = selectedCase !== 0;
  for (const peer of byId('radio-route').querySelectorAll('[data-peer]')) {
    peer.dataset.active = String(peer.dataset.peer === example.steps[inspected][0]);
  }
  floorButtons.forEach((button, index) => {
    const state = index < current ? 'done' : index === current ? (blocked ? 'blocked' : 'current') : 'queued';
    button.dataset.state = state;
    button.setAttribute('aria-pressed', String(index === inspected));
    button.lastElementChild.textContent = {done:'DONE',current:'ACTIVE',blocked:'STOP',queued:'·'}[state];
  });
  byId('shaft-status').textContent = blocked ? 'STOPPED' : done ? 'COMPLETE' : current < 0 ? 'STANDBY' : approval ? 'APPROVAL REQUIRED' : 'STEP ' + (current + 1) + ' ACTIVE';
  byId('run-status').textContent = blocked ? 'Simulation stopped.' : done ? example.complete : current < 0 ? example.initial : approval ? 'Review the proposed action and choose what happens next.' : revocation ? 'Run the scoped read or revoke the grant to see the refusal.' : 'Active step ' + (current + 1) + ' of ' + example.steps.length + '. Advance when ready.';
  mobileAction.textContent = current < 0 ? example.start + ' ↓' : 'Open step details ↓';
  byId('action-controls').replaceChildren();
  if (blocked || done) action('Reset simulation', reset, true);
  else if (current < 0) action(example.start + ' →', advance, true);
  else if ((approval || revocation) && inspected !== current) {
    action('Review active step', () => { inspected = current; render(); }, true);
    action('Reset', reset);
  } else {
    if (approval) {
      action('Approve →', advance, true);
      action('Reject', block);
    } else if (revocation) {
      action('Allow scoped read →', advance, true);
      action('Revoke grant', block);
    } else action(current === example.steps.length - 1 ? 'Finish run →' : 'Next step ↓', advance, true);
    action('Reset', reset);
  }
}

reset();
byId('simulation-board').hidden = false;

const footage = {
  world: ['silo-world.webp', 'SILO galleries and spiral stair', 'Move between floors, locate a resident and open a terminal from the dock.'],
  flows: ['silo-flows.webp', 'The workflow terminal with resident and review steps', 'Inspect the order in which residents, review steps and app actions run.'],
  cameras: ['silo-cameras.webp', 'The security terminal and its camera feeds', 'Follow a resident or let the active workflow select the camera feed.'],
  tour: ['silo-tour.gif', 'Animated navigation through the SILO galleries', 'Captured in the running demo as the camera moves through the upper galleries.']
};
let previousFootage = 'world';
let currentFootage = 'world';
const footageButtons = document.querySelectorAll('[data-view]');
document.querySelector('.monitor-nav').hidden = false;
for (const button of footageButtons) {
  button.addEventListener('click', () => {
    const requested = button.dataset.view;
    currentFootage = requested === 'tour' && currentFootage === 'tour' ? previousFootage : requested;
    if (currentFootage !== 'tour') previousFootage = currentFootage;
    const [file, alt, caption] = footage[currentFootage];
    byId('product-image').src = '../media/' + file;
    byId('product-image').alt = alt;
    byId('product-caption').textContent = caption;
    for (const choice of footageButtons) choice.setAttribute('aria-pressed', String(choice.dataset.view === currentFootage));
    document.querySelector('[data-view=tour]').textContent = currentFootage === 'tour' ? 'Stop GIF' : 'Play GIF';
  });
}


const directory = globalThis.siloProductCatalog;
const search = byId('integration-search');
const category = byId('group');
const more = byId('more');
const modeButtons = document.querySelectorAll('[data-mode]');
const pageSize = 12;
let mode = 'accounts';
let visible = pageSize;

function element(tag, content, className) {
  const node = document.createElement(tag);
  node.textContent = content;
  if (className) node.className = className;
  return node;
}

function integrationCard(item) {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  const title = document.createElement('span');
  title.append(element('strong', item.name), element('small', item.group, 'kind'));
  summary.append(title);
  const body = element('div', item.description, 'result-body');
  if (item.operations?.length) {
    const list = document.createElement('ul');
    for (const operation of item.operations) list.append(element('li', operation));
    body.append(list);
  }
  details.append(summary, body);
  return details;
}

function renderDirectory(preserve = false) {
  const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = directory[mode].filter(item => {
    const text = [item.name, item.group, item.description, ...(item.operations ?? [])].join(' ').toLowerCase();
    return (!category.value || item.group === category.value) && terms.every(term => text.includes(term));
  });
  const results = byId('integration-results');
  const alreadyShown = preserve ? results.children.length : 0;
  const shown = matches.slice(0, visible);
  if (!preserve) results.replaceChildren();
  results.append(...shown.slice(alreadyShown).map(integrationCard));
  byId('result-count').textContent = matches.length ? 'Showing ' + shown.length + ' of ' + matches.length : 'No integrations match your search.';
  more.hidden = matches.length <= shown.length;
  if (preserve && more.hidden) results.children[alreadyShown]?.querySelector('summary')?.focus();
}

function selectMode(key) {
  mode = key;
  visible = pageSize;
  for (const button of modeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === key));
  }
  const groups = [...new Set(directory[key].map(item => item.group))].sort();
  category.replaceChildren(new Option('All categories', ''), ...groups.map(group => new Option(group, group)));
  byId('group-field').hidden = groups.length < 2;

  renderDirectory();
}

for (const button of modeButtons) {
  button.addEventListener('click', () => selectMode(button.dataset.mode));
}

for (const [input, event] of [[search, 'input'], [category, 'change']]) {
  input.addEventListener(event, () => {
    visible = pageSize;
    renderDirectory();
  });
}

more.addEventListener('click', () => {
  visible += pageSize;
  renderDirectory(true);
});

selectMode(mode);
byId('connection-directory').hidden = false;

const copy = byId('copy');
copy.hidden = false;
copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText('npm start');
    copy.textContent = 'Copied';
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(copy.previousElementSibling);
    selection.removeAllRanges();
    selection.addRange(range);
    copy.textContent = 'Selected';
  }
});
