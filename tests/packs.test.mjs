// Every operation of every built-in app, called against a fake server: the right method and path, the key in the
// place that app wants it, query values, JSON and form bodies, fixed headers, GraphQL reads that refuse mutations,
// and the harmless call that shows a key works. Nothing leaves this computer.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { APP_PACKS, packSpec, PACK_GROUP_ORDER } from '../public/app-packs.js';
import { OpenApiClient, compileSpec, formBody } from '../openapi-tools.mjs';

async function fakeServer(answer = () => [200, { ok: true }]) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const u = new URL(req.url, 'http://x'); seen.push({ method: req.method, path: decodeURIComponent(u.pathname), query: u.searchParams, headers: req.headers, body });
    const [status, data] = answer(req, u);
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise(r => server.close(r)) };
}
const keyFor = auth => auth.kind === 'basic' || String(auth.name || '').includes(',') ? 'firstpart1234:secondpart5678' : 'single-key-1234567890';

test('the list: names, groups, keys and plain text', () => {
  const ids = Object.keys(APP_PACKS);
  assert.ok(ids.length >= 85, 'apps: ' + ids.length);
  for (const id of ids) {
    const p = APP_PACKS[id];
    assert.ok(PACK_GROUP_ORDER.includes(p.group), id + ' group ' + p.group);
    assert.match(p.base, /^https:\/\//, id);
    assert.ok(['none', 'bearer', 'basic', 'header', 'query', 'path'].includes(p.auth.kind), id);
    assert.ok(p.key.length > 10 && !/[–—]/.test(p.key + JSON.stringify(p.ops)), id + ' plain text');
    for (const op of p.ops) assert.ok(op.length >= 4 && /^[a-z_]+$/.test(op[2]), id + ' ' + op[2]);
  }
});

test('every operation of every app sends the right request, with the key where the app wants it', async () => {
  const fake = await fakeServer();
  let calls = 0;
  try {
    for (const [id, p] of Object.entries(APP_PACKS)) {
      const value = p.auth.kind === 'none' ? '' : keyFor(p.auth);
      const client = new OpenApiClient({ spec: 'builtin:' + id, base: `${fake.base}/${id}`, auth: { ...p.auth, value } });
      const tools = await client.listTools();
      assert.equal(tools.length, p.ops.length, id);
      for (const [method, route, name, , o = {}] of p.ops) {
        const tool = tools.find(t => t.name === name), props = tool.inputSchema.properties, args = {};
        for (const m of route.matchAll(/\{([^}]+)\}/g)) args[m[1].replace(/[^a-zA-Z0-9_.-]/g, '_')] = 'p-' + m[1];
        const firstQ = Object.keys(o.q || {})[0];
        if (firstQ) args[firstQ.replace(/[^a-zA-Z0-9_.-]/g, '_')] = 'qv';
        const bodyKey = Object.keys(props).find(k => k === 'body' || k === '_body');
        if (o.body) { assert.ok(bodyKey, `${id}.${name} has a body`); args[bodyKey] = o.body.startsWith('[') ? [{ a: 1 }] : { a: 1, nested: { b: 'x' } }; }
        if (o.gql === 'read') args[bodyKey] = { query: '{ viewer { id } }' };
        const r = await client.callTool(name, args);
        assert.equal(r.isError, false, `${id}.${name}: ${r.content[0].text.slice(0, 200)}`);
        const got = fake.seen.at(-1); calls++;
        assert.equal(got.method, method, `${id}.${name} method`);
        const prefix = p.auth.kind === 'path' ? `/${id}/${p.auth.prefix || ''}${value}` : `/${id}`;
        assert.equal(got.path, prefix + route.replace(/\{([^}]+)\}/g, (_, x) => 'p-' + x), `${id}.${name} path`);
        if (firstQ) assert.equal(got.query.get(firstQ), 'qv', `${id}.${name} query ${firstQ}`);
        // The key.
        const h = got.headers, a = p.auth;
        if (a.kind === 'bearer') assert.equal(h.authorization, 'Bearer ' + value, id);
        else if (a.kind === 'basic') assert.equal(h.authorization, 'Basic ' + Buffer.from(value).toString('base64'), id);
        else if (a.kind === 'header') { const names = a.name.split(','), vals = names.length > 1 ? value.split(':') : [value]; names.forEach((n, i) => assert.equal(h[n.toLowerCase()], (i === 0 ? a.prefix || '' : '') + vals[i], `${id} header ${n}`)); }
        else if (a.kind === 'query') { const names = a.name.split(','), vals = names.length > 1 ? value.split(':') : [value]; names.forEach((n, i) => assert.equal(got.query.get(n), vals[i], `${id} query key ${n}`)); }
        else if (a.kind === 'none') assert.equal(h.authorization, undefined, id);
        for (const [k, v] of Object.entries(p.headers || {})) assert.equal(h[k.toLowerCase()], v, `${id} fixed header ${k}`);
        assert.equal(h['user-agent'], 'SILO-agent-world');
        // The body.
        if (o.body && o.gql !== 'read') {
          if (o.form) { assert.equal(h['content-type'], 'application/x-www-form-urlencoded', id); assert.equal(got.body, 'a=1&nested%5Bb%5D=x', `${id}.${name} form`); }
          else { assert.equal(h['content-type'], 'application/json', id); assert.deepEqual(JSON.parse(got.body), args[bodyKey], `${id}.${name} body`); }
        }
        // Reading runs freely; changing asks first.
        assert.equal(tool.annotations.readOnlyHint, method === 'GET' || !!o.read || o.gql === 'read', `${id}.${name} read only`);
      }
    }
  } finally { await fake.close(); }
  assert.ok(calls >= 340, 'calls: ' + calls);
});

test('form bodies, GraphQL reads, keys that cannot go in an address', async () => {
  assert.equal(formBody({ line_items: [{ price: 'price_1', quantity: 2 }], metadata: { order: 'A7' }, to: ['a@x.ro', 'b@x.ro'], amount: 500 }),
    'line_items%5B0%5D%5Bprice%5D=price_1&line_items%5B0%5D%5Bquantity%5D=2&metadata%5Border%5D=A7&to=a%40x.ro&to=b%40x.ro&amount=500');
  const fake = await fakeServer();
  try {
    const linear = new OpenApiClient({ spec: 'builtin:linear', base: fake.base, auth: { kind: 'header', name: 'Authorization', value: 'lin_api_123456789' } });
    const before = fake.seen.length;
    const r = await linear.callTool('graphql_read', { body: { query: 'mutation { issueDelete(id: "1") { success } }' } });
    assert.equal(r.isError, true); assert.match(r.content[0].text, /only reads/);
    assert.equal(fake.seen.length, before, 'nothing was sent');
    assert.equal((await linear.callTool('graphql_change', { body: { query: 'mutation { x }' } })).isError, false);
    assert.equal(fake.seen.at(-1).path, '/graphql', 'both go to the same address');
    const tg = new OpenApiClient({ spec: 'builtin:telegram', base: fake.base, auth: { kind: 'path', prefix: 'bot', value: '123:abc/../x' } });
    assert.match((await tg.callTool('me', {})).content[0].text, /cannot go in an address/);
  } finally { await fake.close(); }
});

test('the check call says whether the key works with your account', async () => {
  const fake = await fakeServer((req, u) => req.headers.authorization === 'Bearer good-key-123456' ? [200, { id: 'acct_1' }] : [401, { error: 'Invalid API key good-key-12' }]);
  try {
    const ok = await new OpenApiClient({ spec: 'builtin:stripe', base: fake.base, auth: { kind: 'bearer', value: 'good-key-123456' } }).checkKey();
    assert.equal(ok.ok, true); assert.equal(ok.status, 200);
    assert.equal(fake.seen.at(-1).path, '/balance', 'Stripe checks the balance');
    const bad = await new OpenApiClient({ spec: 'builtin:stripe', base: fake.base, auth: { kind: 'bearer', value: 'wrong-key-654321' } }).checkKey();
    assert.equal(bad.ok, false); assert.equal(bad.status, 401); assert.match(bad.detail, /Invalid API key/);
    const none = await new OpenApiClient({ spec: 'builtin:stripe', base: fake.base, auth: { kind: 'bearer', value: '' } }).checkKey();
    assert.equal(none.ok, false); assert.match(none.detail, /No key/);
    await new OpenApiClient({ spec: 'builtin:linear', base: fake.base, auth: { kind: 'header', name: 'Authorization', value: 'k' } }).checkKey();
    assert.deepEqual(JSON.parse(fake.seen.at(-1).body), { query: '{ viewer { id name } }' }, 'Linear checks with a GraphQL read');
    assert.equal(compileSpec(packSpec('baserow'), {}).check, null, 'an app without a harmless call has no check');
  } finally { await fake.close(); }
});
