'use strict';

const byId = id => document.getElementById(id);
const viewButtons = document.querySelectorAll('[data-view]');
const productImage = byId('product-image');
const tour = byId('tour');
const views = {
  world: ['silo-world.webp', 'The SILO galleries and spiral stair', 'Navigate 144 levels, find residents and open a terminal from the dock.'],
  flows: ['silo-flows.webp', 'The workflow terminal with resident and review steps', 'Build a workflow and see the order in which residents, reviews and app actions run.'],
  cameras: ['silo-cameras.webp', 'The security terminal and its camera feeds', 'Switch feeds, follow a resident, or let the active workflow choose the camera.'],
  tour: ['silo-tour.gif', 'Animated tour around the stair and between floors', 'Recorded in the demo instance as the camera moves through the upper galleries.']
};
let currentView = 'world';

function showView(key) {
  const [file, alt, caption] = views[key];
  productImage.src = '../media/' + file;
  productImage.alt = alt;
  byId('product-caption').textContent = caption;
  for (const button of viewButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.view === key));
  }
  tour.setAttribute('aria-pressed', String(key === 'tour'));
  tour.textContent = key === 'tour' ? 'Stop GIF tour' : 'Play GIF tour ▷';
}

for (const button of viewButtons) {
  button.addEventListener('click', () => {
    currentView = button.dataset.view;
    showView(currentView);
  });
}

tour.addEventListener('click', () => {
  showView(tour.getAttribute('aria-pressed') === 'true' ? currentView : 'tour');
});

const directory = globalThis.siloProductCatalog;
const search = byId('integration-search');
const category = byId('group');
const more = byId('more');
const modeButtons = document.querySelectorAll('[data-mode]');
const pageSize = 12;
let mode = 'accounts';
let visible = pageSize;

const introductions = {
  accounts: 'Google and Microsoft use OAuth with your own app registration. Slack, GitHub and Notion use tokens.',
  apps: 'Choose from preconfigured app operations. Most connectors need a service credential. Some also need your instance URL.',
  hooks: 'Start a workflow when a service sends an event. Each adapter uses the verification method configured for that service.'
};

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
  title.append(element('strong', item.name), element('span', item.group, 'kind'));
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
  byId('directory-intro').textContent = introductions[key];
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

const copy = byId('copy');
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
