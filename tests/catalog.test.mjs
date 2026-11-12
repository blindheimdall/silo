// Finding apps: how the key goes is read from a description, a description is summed up before it is added, any
// web API gets a key check, and a running SILO searches the API directory by words and by kind, reads a description
// and turns entries of the official MCP registry into connector settings. Everything outside runs on fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAuth, describeSpec, compileSpec } from '../openapi-tools.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = ms => new Promise(r => setTimeout(r, ms));
const op = (tags, extra = {}) => ({ tags, responses: { 200: { description: 'ok' } }, ...extra });

test('the kind of key is read from the security schemes, the one in use first', () => {
  assert.deepEqual(detectAuth({ components: { securitySchemes: { b: { type: 'http', scheme: 'bearer' } } } }).kind, 'bearer');
  assert.deepEqual(detectAuth({ components: { securitySchemes: { b: { type: 'http', scheme: 'basic' } } } }).kind, 'basic');
  assert.deepEqual(detectAuth({ securityDefinitions: { b: { type: 'basic' } } }).kind, 'basic');
  const header = detectAuth({ components: { securitySchemes: { k: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } } } });
  assert.equal(header.kind, 'header'); assert.equal(header.name, 'X-Api-Key'); assert.match(header.note, /X-Api-Key header/);
  const query = detectAuth({ components: { securitySchemes: { k: { type: 'apiKey', in: 'query', name: 'appid' } } } });
  assert.equal(query.kind, 'query'); assert.equal(query.name, 'appid');
  assert.equal(detectAuth({ components: { securitySchemes: { o: { type: 'oauth2', flows: {} } } } }).kind, 'bearer');
  assert.equal(detectAuth({ components: { securitySchemes: { a: { type: 'apiKey', in: 'header', name: 'Authorization' } } } }).name, 'Authorization');
  // The scheme the API uses wins over the first one listed.
  const both = { security: [{ key: [] }], components: { securitySchemes: { oauth: { type: 'oauth2' }, key: { type: 'apiKey', in: 'query', name: 'token' } } } };
  assert.equal(detectAuth(both).kind, 'query');
  const perOp = { paths: { '/a': { get: { security: [{ key: [] }] } } }, components: { securitySchemes: { oauth: { type: 'oauth2' }, key: { type: 'apiKey', in: 'header', name: 'K' } } } };
  assert.equal(detectAuth(perOp).kind, 'header');
  // A plain key wins over OAuth even when OAuth is the one in use, like the Petstore example.
  const petstore = { paths: { '/pet': { post: { security: [{ petstore_auth: ['write:pets'] }] } }, '/store': { get: { security: [{ api_key: [] }] } } }, components: { securitySchemes: { petstore_auth: { type: 'oauth2', flows: {} }, api_key: { type: 'apiKey', name: 'api_key', in: 'header' } } } };
  assert.deepEqual(detectAuth(petstore), { kind: 'header', name: 'api_key', note: 'A key in the api_key header.' });
  assert.equal(detectAuth({ components: { securitySchemes: { o: { type: 'openIdConnect' } } } }).kind, 'bearer', 'OAuth alone still gives a token');
  assert.equal(detectAuth({}).kind, 'none'); assert.match(detectAuth({}).note, /names no key/);
  assert.equal(detectAuth({ components: { securitySchemes: { m: { type: 'mutualTLS' } } } }).kind, 'none');
});

test('a description is summed up: name, address, operations, biggest groups', () => {
  const spec = { openapi: '3.0.3', info: { title: 'Pets', description: '<p>All the **pets**.</p>' }, servers: [{ url: 'https://pets.example.com/v1' }], components: { securitySchemes: { k: { type: 'apiKey', in: 'header', name: 'X-Key' } } },
    paths: { '/pets': { get: op(['pets']), post: op(['pets']) }, '/pets/{id}': { get: op(['pets']) }, '/stores': { get: op(['stores']) } } };
  const d = describeSpec(spec);
  assert.equal(d.title, 'Pets'); assert.equal(d.description, 'All the pets .'); assert.equal(d.base, 'https://pets.example.com/v1');
  assert.equal(d.ops, 4); assert.equal(d.tooMany, false); assert.equal(d.version, 'OpenAPI 3.0.3'); assert.equal(d.auth.name, 'X-Key');
  assert.deepEqual(d.groups, [{ name: 'pets', count: 3 }, { name: 'stores', count: 1 }]);
  const big = { swagger: '2.0', host: 'big.example.com', schemes: ['https'], paths: Object.fromEntries(Array.from({ length: 400 }, (_, i) => ['/r' + i, { get: op(['g' + (i % 30)]) }])) };
  const b = describeSpec(big);
  assert.equal(b.version, 'Swagger 2'); assert.equal(b.ops, 400); assert.equal(b.tooMany, true); assert.equal(b.groups.length, 24); assert.equal(b.base, 'https://big.example.com');
});

test('any description gets a key check: the first plain read, unless it says otherwise', () => {
  const spec = { openapi: '3.0.0', servers: [{ url: 'https://x.example.com' }], paths: {
    '/items/{id}': { get: { operationId: 'getItem', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: {} } },
    '/search': { get: { operationId: 'search', parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' } }], responses: {} } },
    '/items': { post: { operationId: 'addItem', responses: {} } },
    '/me': { get: { operationId: 'getMe', responses: {} } } } };
  assert.deepEqual(compileSpec(spec).check, ['getMe', {}]);
  assert.equal(compileSpec({ ...spec, 'x-silo-check': false }).check, null);
  assert.deepEqual(compileSpec({ ...spec, 'x-silo-check': ['getItem', { id: '1' }] }).check, ['getItem', { id: '1' }]);
  assert.equal(compileSpec({ ...spec, paths: { '/items': spec.paths['/items'] } }).check, null, 'nothing safe to call');
});

test('a running SILO browses the API directory, reads a description, searches the MCP registry and checks any key', async t => {
  const seen = [];
  const pets = { openapi: '3.0.0', info: { title: 'Pet shop' }, servers: [{ url: '/' }], components: { securitySchemes: { k: { type: 'apiKey', in: 'header', name: 'X-Pet-Key' } } },
    paths: { '/me': { get: { operationId: 'whoAmI', tags: ['account'], responses: {} } }, '/pets': { get: { operationId: 'listPets', tags: ['pets'], responses: {} } } } };
  const directory = {
    'stripe.com': { preferred: '1', versions: { 1: { info: { title: 'Stripe API', description: 'Payments <b>online</b>', 'x-apisguru-categories': ['financial', 'payment'] }, swaggerUrl: 'https://api.apis.guru/v2/specs/stripe.com/1/openapi.json' } } },
    'paypal.com:orders': { preferred: '2', versions: { 2: { info: { title: 'Orders', description: 'PayPal orders', 'x-apisguru-categories': ['payment'] }, swaggerUrl: 'https://api.apis.guru/v2/specs/paypal.com/orders/2/openapi.json' } } },
    'weather.gov': { preferred: '1', versions: { 1: { info: { title: 'Weather', description: 'Forecasts', 'x-apisguru-categories': ['open_data'] }, swaggerUrl: 'https://api.apis.guru/v2/specs/weather.gov/1/openapi.json' } } },
    'plain.example': { preferred: '1', versions: { 1: { info: { title: 'Plain' }, swaggerUrl: 'http://not-https.example/spec.json' } } } };
  const registry = { servers: [
    { server: { name: 'io.example/weather', title: 'Weather MCP', description: 'Forecasts  for   anywhere', version: '1.2.0', repository: { url: 'https://github.com/example/weather' },
      remotes: [{ type: 'sse', url: 'https://weather.example.com/sse' }, { type: 'streamable-http', url: 'https://weather.example.com/mcp', headers: [{ name: 'X-Weather-Key', isRequired: true, isSecret: true, description: 'Your key' }, { name: 'bad header!', isRequired: false }] }],
      packages: [{ registryType: 'npm', identifier: '@example/weather-mcp', version: '1.2.0', transport: { type: 'stdio' }, environmentVariables: [{ name: 'WEATHER_KEY', isRequired: true, isSecret: true, description: 'Your key' }, { name: 'bad name', isRequired: false }], packageArguments: [{ type: 'positional', value: '--quiet' }, { type: 'positional', value: 'rm -rf /' }] }] }, _meta: {} },
    { name: 'io.example/py-weather', description: 'Python one', version: '0.3.0', packages: [{ registry_type: 'pypi', identifier: 'weather-mcp', version: '0.3.0', transport: { type: 'stdio' } }] },
    { server: { name: 'io.example/box', version: '2.0.0', packages: [{ registryType: 'oci', identifier: 'ghcr.io/example/box', transport: { type: 'stdio' }, environmentVariables: [{ name: 'BOX_TOKEN', isRequired: true }] }] } },
    { server: { name: 'io.example/old-only', version: '1.0.0', remotes: [{ type: 'sse', url: 'https://old.example.com/sse' }] } },
    { server: { name: 'io.example/evil', version: '1.0.0', packages: [{ registryType: 'npm', identifier: 'x; rm -rf /', transport: { type: 'stdio' } }] } }] };
  const fake = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); seen.push(u.pathname + u.search);
    const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/list.json') return json(200, directory);
    if (u.pathname === '/pets.json') return json(200, pets);
    if (u.pathname === '/v0/servers') return json(200, u.searchParams.get('search') === 'weather' ? registry : { servers: [] });
    if (u.pathname === '/me') return req.headers['x-pet-key'] === 'pk_good_1234' ? json(200, { name: 'me' }) : json(401, { error: 'Bad key' });
    json(404, {});
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r)); t.after(() => fake.close());
  const fakeUrl = 'http://127.0.0.1:' + fake.address().port;

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'silo-catalog-'));
  const port = 14373, api = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', './tests/provider-mock.mjs', 'server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), SILO_DATA_DIR: path.join(temp, 'data'), SILO_WORK_DIR: path.join(temp, 'workspace'), SILO_API_DIRECTORY: fakeUrl + '/list.json', SILO_MCP_REGISTRY: fakeUrl, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', COMPATIBLE_API_KEY: '', SILO_SECRET: '' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let errors = ''; child.stderr.on('data', b => { errors += b; });
  t.after(async () => { child.kill(); await new Promise(r => { if (child.exitCode !== null) return r(); child.once('exit', r); setTimeout(r, 3000); }); await wait(300); const resolved = path.resolve(temp); assert.ok(path.basename(resolved).startsWith('silo-catalog-')); await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Test server did not start: ' + errors)), 15000); child.stdout.on('data', b => { if (b.toString().includes('SILO is ready')) { clearTimeout(timer); resolve(); } }); });
  const ses = await fetch(api + '/api/session'); const { token } = await ses.json(), cookie = ses.headers.get('set-cookie').split(';')[0];
  const request = async (route, body, method = body === undefined ? 'GET' : 'POST') => { const r = await fetch(api + '/api' + route, { method, headers: { cookie, origin: api, 'Content-Type': 'application/json', 'x-silo-token': token }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => null) }; };

  // The kinds, with how many APIs each has. Entries without an https description are left out.
  const kinds = await request('/apis');
  assert.equal(kinds.status, 200, JSON.stringify(kinds.data));
  assert.equal(kinds.data.total, 3);
  assert.deepEqual(kinds.data.categories, [{ name: 'payment', count: 2 }, { name: 'financial', count: 1 }, { name: 'open_data', count: 1 }]);
  const pay = await request('/apis?category=payment');
  assert.deepEqual(pay.data.apis.map(a => a.id), ['paypal.com:orders', 'stripe.com'], 'sorted by title');
  assert.equal(pay.data.total, 2);
  assert.deepEqual(pay.data.apis[1].categories, ['financial', 'payment']);
  assert.equal(pay.data.apis[1].description, 'Payments online');
  const words = await request('/apis?q=paypal%20orders');
  assert.deepEqual(words.data.apis.map(a => a.id), ['paypal.com:orders']);
  assert.deepEqual((await request('/apis?q=stripe&category=open_data')).data.apis, []);
  assert.equal(seen.filter(s => s === '/list.json').length, 1, 'the directory is fetched once and kept');

  // A description read before it is added.
  const look = await request('/apis/inspect?spec=' + encodeURIComponent(fakeUrl + '/pets.json'));
  assert.equal(look.status, 200, JSON.stringify(look.data));
  assert.equal(look.data.title, 'Pet shop'); assert.equal(look.data.ops, 2); assert.equal(look.data.base, fakeUrl);
  assert.deepEqual(look.data.auth, { kind: 'header', name: 'X-Pet-Key', note: 'A key in the X-Pet-Key header.' });
  for (const bad of ['builtin:stripe', 'file:///C:/Windows/win.ini', 'http://example.com/spec.json', 'not a url', '../data/state.json']) {
    const r = await request('/apis/inspect?spec=' + encodeURIComponent(bad));
    assert.equal(r.status, 400, bad + ' ' + JSON.stringify(r.data));
  }
  assert.equal((await request('/apis/inspect?spec=' + encodeURIComponent(fakeUrl + '/missing.json'))).status, 502);

  // The MCP registry: an address over streamable HTTP (old SSE ones left out), npm, PyPI and Docker programs.
  const reg = await request('/mcp-registry?q=Weather');
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  assert.ok(seen.includes('/v0/servers?search=weather&limit=40&version=latest'), seen.join(' '));
  const [weather, py, box, ...rest] = reg.data.servers;
  assert.equal(rest.length, 0, 'SSE only and unsafe package names are left out');
  assert.equal(weather.title, 'Weather MCP'); assert.equal(weather.description, 'Forecasts for anywhere'); assert.equal(weather.repository, 'https://github.com/example/weather');
  assert.deepEqual(weather.ways, [
    { kind: 'http', url: 'https://weather.example.com/mcp', headers: [{ name: 'X-Weather-Key', required: true, secret: true, description: 'Your key' }] },
    { kind: 'stdio', command: 'npx', args: ['-y', '@example/weather-mcp@1.2.0', '--quiet'], env: [{ name: 'WEATHER_KEY', required: true, secret: true, description: 'Your key' }] }]);
  assert.equal(py.title, 'py-weather');
  assert.deepEqual(py.ways, [{ kind: 'stdio', command: 'uvx', args: ['weather-mcp==0.3.0'], env: [] }]);
  assert.deepEqual(box.ways[0].args, ['run', '-i', '--rm', '-e', 'BOX_TOKEN', 'ghcr.io/example/box:2.0.0']);
  assert.deepEqual((await request('/mcp-registry?q=weather')).data, reg.data);
  assert.equal(seen.filter(s => s.startsWith('/v0/servers')).length, 1, 'answers are kept for a while');
  assert.deepEqual((await request('/mcp-registry?q=')).data.servers, []);

  // Any web API, not only the built-in ones, gets a key check on its card.
  const add = await request('/mcp', { name: 'Pet shop', transport: 'openapi', spec: fakeUrl + '/pets.json', authKind: 'header', authName: 'X-Pet-Key', authValue: 'pk_good_1234' });
  assert.equal(add.status, 201, JSON.stringify(add.data));
  let card = (await request('/state')).data.mcp.find(c => c.id === add.data.id);
  assert.equal(card.keyCheck.ok, true);
  await request('/mcp', { id: add.data.id, name: 'Pet shop', transport: 'openapi', spec: fakeUrl + '/pets.json', authKind: 'header', authName: 'X-Pet-Key', authValue: 'pk_bad_9876' });
  card = (await request('/state')).data.mcp.find(c => c.id === add.data.id);
  assert.equal(card.keyCheck.ok, false); assert.equal(card.keyCheck.status, 401);
  assert.equal(JSON.stringify(card).includes('pk_bad_9876'), false, 'the key is not on the card');
});
