// OpenAPI 3.1 description of the parts of /api/* meant for programs: state, residents, workflows, runs,
// approvals, tests, traces and files. Served at /api/openapi.json. Every call needs "Authorization: Bearer silo_pat_...";
// x-silo-scope is the token scope a call needs.
const id = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const json = schema => ({ required: true, content: { 'application/json': { schema } } });
const ok = (description, schema = { type: 'object' }) => ({ description, content: { 'application/json': { schema } } });
const errors = {
  400: { $ref: '#/components/responses/Error' }, 401: { $ref: '#/components/responses/Error' },
  403: { $ref: '#/components/responses/Error' }, 404: { $ref: '#/components/responses/Error' }, 429: { $ref: '#/components/responses/Error' },
};
const op = (scope, summary, extra) => ({ summary, 'x-silo-scope': scope, ...extra, responses: { ...extra.responses, ...errors } });

export function openApiSpec({ version = '0.0.0', server = 'http://127.0.0.1:3000' } = {}) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'SILO API', version,
      description: 'Make a token in System > API tokens. A token acts as the person who made it and never has more rights than their role. ' +
        'Tokens work from this computer only, unless made to work from anywhere. At most 300 requests a minute per token. ' +
        'Scopes: read (GET), run (talk, run, change), approve (requests, run approvals, proposed files), admin (owner settings).',
    },
    servers: [{ url: server }],
    security: [{ token: [] }],
    components: {
      securitySchemes: { token: { type: 'http', scheme: 'bearer', bearerFormat: 'silo_pat_...' } },
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
        CapabilityRights: { type: 'object', properties: { residents: { type: 'array', items: { type: 'string' }, description: 'Names, or * for all.' }, tools: { type: 'array', items: { type: 'string', enum: ['read_files', 'write_files', 'web'] } }, folders: { type: 'array', items: { type: 'string' }, description: 'Needed with file tools; * for all.' } }, required: ['residents'] },
        CapabilityRequest: { type: 'object', properties: { peerId: { type: 'string' }, publicKey: { type: 'string', description: 'ed25519:..., instead of peerId.' }, name: { type: 'string' }, rights: { $ref: '#/components/schemas/CapabilityRights' }, budget: { type: 'object', properties: { tokens: { type: 'integer', minimum: 1 }, messages: { type: 'integer', minimum: 1 } }, required: ['tokens', 'messages'] }, hours: { type: 'number', exclusiveMinimum: 0 } }, required: ['rights', 'budget', 'hours'] },
        Capability: { type: 'object', properties: { hash: { type: 'string' }, token: { type: 'string' }, root: { type: 'string' }, holder: { type: 'string' }, rights: { $ref: '#/components/schemas/CapabilityRights' }, budget: { type: 'object' }, exp: { type: 'integer' }, links: { type: 'integer' } } },
        Agent: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' }, level: { type: 'integer' }, provider: { type: 'string' }, model: { type: 'string' }, status: { type: 'string' } } },
        Workflow: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, enabled: { type: 'boolean' }, steps: { type: 'array', items: { type: 'object' } } } },
        Run: { type: 'object', properties: { id: { type: 'string' }, workflowId: { type: 'string' }, status: { type: 'string', examples: ['running', 'done', 'failed', 'stopped'] }, waiting: { type: 'boolean' }, input: { type: 'string' }, output: { type: 'string' }, steps: { type: 'array', items: { type: 'object' } }, started: { type: 'integer' }, ended: { type: 'integer' } } },
        Reply: { type: 'object', properties: { text: { type: 'string' }, tokens: { type: 'integer' }, tools: { type: 'array', items: { type: 'object' } }, truncated: { type: 'boolean' }, traceId: { type: 'string' } } },
        Check: { type: 'object', properties: { op: { type: 'string', enum: ['contains', 'missing', 'regex', 'field', 'judge', 'maxcost', 'maxms', 'maxtokens'] }, text: { type: 'string' }, weight: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['op', 'text'] },
        TestCase: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string', maxLength: 80 }, input: { type: 'string', maxLength: 15000 }, reference: { type: 'string', maxLength: 8000 }, checks: { type: 'array', maxItems: 10, items: { $ref: '#/components/schemas/Check' } } }, required: ['input', 'checks'] },
        Suite: { type: 'object', properties: { tests: { type: 'array', maxItems: 20, items: { $ref: '#/components/schemas/TestCase' } }, judgeId: { type: ['string', 'null'] }, repeat: { type: 'integer', minimum: 1, maximum: 5 }, gate: { type: 'string', enum: ['off', 'test', 'hold'] }, learn: { type: 'boolean', description: 'Workflows only: a run rejected with a note becomes a case.' } }, required: ['tests'] },
        EvaluateBody: { type: 'object', properties: { repeat: { type: 'integer', minimum: 1, maximum: 5 }, trigger: { type: 'string', enum: ['manual', 'ci'] }, models: { type: 'array', maxItems: 4, items: { type: 'object', properties: { provider: { type: 'string' }, model: { type: 'string' } } } } } },
        Report: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['waiting', 'running', 'done', 'interrupted'] }, total: { type: 'integer' }, passed: { type: 'integer' }, score: { type: 'number', description: '0 to 100' }, interval: { type: 'array', items: { type: 'number' }, description: 'Pass rate over every attempt, 95% interval, in %.' }, repeat: { type: 'integer' }, worse: { type: 'object' }, compare: { type: 'object', properties: { baseline: { type: ['string', 'null'] }, cases: { type: 'object', additionalProperties: { type: 'string', enum: ['broke', 'worse', 'flaky', 'new', 'better', 'fixed', 'same'] } }, count: { type: 'object' }, scoreDelta: { type: ['number', 'null'] }, worse: { type: 'boolean' } } }, results: { type: 'array', items: { type: 'object' } } } },
        TraceSummary: { type: 'object', properties: { id: { type: 'string' }, kind: { type: 'string' }, name: { type: 'string' }, refId: { type: 'string' }, status: { type: 'string' }, started: { type: 'integer' }, ended: { type: 'integer' }, ms: { type: 'integer' }, totals: { type: 'object' } } },
      },
      responses: { Error: { description: 'What went wrong, in words.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } },
    },
    paths: {
      '/api/state': { get: op('read', 'The whole silo: residents, workflows, runs, requests, events', {
        parameters: [{ name: 'x-silo-since', in: 'header', required: false, schema: { type: 'string' }, description: 'The tag of the last answer. 204 when nothing changed.' }],
        responses: { 200: ok('The state, with a tag.'), 204: { description: 'Nothing changed since that tag.' } } }) },
      '/api/stream': { get: op('read', 'Server-Sent Events: the state once, then its changes', { responses: { 200: { description: 'text/event-stream' } } }) },
      '/api/agents/{id}/chat': { post: op('run', 'Ask a resident something and wait for the answer', {
        parameters: [id], requestBody: json({ type: 'object', properties: { message: { type: 'string', maxLength: 15000 } }, required: ['message'] }),
        responses: { 200: ok('The answer.', { $ref: '#/components/schemas/Reply' }) } }) },
      '/api/agents/{id}/live': { get: op('read', 'The text a resident is writing right now', { parameters: [id], responses: { 200: ok('Text so far.') } }) },
      '/api/agents': { post: op('run', 'Add a resident', { requestBody: json({ $ref: '#/components/schemas/Agent' }), responses: { 201: ok('The resident.', { $ref: '#/components/schemas/Agent' }) } }) },
      '/api/agents/{id}': {
        put: op('run', 'Change a resident', { parameters: [id], requestBody: json({ $ref: '#/components/schemas/Agent' }), responses: { 200: ok('The resident.', { $ref: '#/components/schemas/Agent' }) } }),
        delete: op('run', 'Remove a resident', { parameters: [id], responses: { 200: ok('Removed.') } }),
      },
      '/api/workflows/{id}/run': { post: op('run', 'Start a workflow run', {
        parameters: [id], requestBody: json({ type: 'object', properties: { input: { type: 'string', maxLength: 15000 } } }),
        responses: { 202: ok('The run, started. Follow it in /api/state or /api/traces.', { $ref: '#/components/schemas/Run' }) } }) },
      '/api/runs/{id}/stop': { post: op('run', 'Stop a running run', { parameters: [id], responses: { 200: ok('Stopped.') } }) },
      '/api/runs/{id}/resume': { post: op('run', 'Resume a run that stopped', { parameters: [id], responses: { 202: ok('Resumed.', { $ref: '#/components/schemas/Run' }) } }) },
      '/api/runs/{id}/approve': { post: op('approve', 'Approve or send back a run that waits for you', {
        parameters: [id], requestBody: json({ type: 'object', properties: { approve: { type: 'boolean' }, note: { type: 'string', maxLength: 5000 } }, required: ['approve'] }),
        responses: { 200: ok('Decided.') } }) },
      '/api/runs/{id}/live': { get: op('read', 'The text the residents of a run are writing right now', { parameters: [id], responses: { 200: ok('Text per part.') } }) },
      '/api/requests/{id}': { post: op('approve', 'Allow or deny a tool request', {
        parameters: [id], requestBody: json({ type: 'object', properties: { allow: { type: 'boolean' }, always: { type: 'boolean', description: 'Allow this tool for this resident from now on.' } }, required: ['allow'] }),
        responses: { 200: ok('Decided.'), 409: { $ref: '#/components/responses/Error' } } }) },
      '/api/proposals/{id}': {
        get: op('read', 'A file a resident proposes, with the current file', { parameters: [id], responses: { 200: ok('The proposal.') } }),
        post: op('approve', 'Save or discard a proposed file', { parameters: [id], requestBody: json({ type: 'object', properties: { action: { type: 'string', enum: ['save', 'discard', 'revert'] } } }), responses: { 200: ok('Done.') } }),
      },
      '/api/workflows/{id}/tests': { post: op('run', 'Replace the test cases of a workflow and how they run', {
        parameters: [id], requestBody: json({ $ref: '#/components/schemas/Suite' }), responses: { 200: ok('The saved cases.') } }) },
      '/api/workflows/{id}/evaluate': { post: op('run', 'Run the tests of a workflow', {
        parameters: [id], requestBody: json({ $ref: '#/components/schemas/EvaluateBody' }),
        responses: { 202: ok('The report, started. Follow it at /api/evals/{id}.', { $ref: '#/components/schemas/Report' }), 409: { $ref: '#/components/responses/Error' } } }) },
      '/api/workflows/{id}/candidate': {
        get: op('read', 'The change held until its tests show nothing got worse, as a line diff', { parameters: [id], responses: { 200: ok('The held change.') } }),
        post: op('approve', 'Apply, reject or test again the held change', { parameters: [id], requestBody: json({ type: 'object', properties: { action: { type: 'string', enum: ['apply', 'reject', 'retest'] } }, required: ['action'] }), responses: { 200: ok('Done.'), 202: ok('Testing again.') } }),
      },
      '/api/agents/{id}/tests': { post: op('run', 'Replace the test cases of a resident and how they run', {
        parameters: [id], requestBody: json({ $ref: '#/components/schemas/Suite' }), responses: { 200: ok('The saved cases.') } }) },
      '/api/agents/{id}/evaluate': { post: op('run', 'Run the tests of a resident', {
        parameters: [id], requestBody: json({ $ref: '#/components/schemas/EvaluateBody' }),
        responses: { 202: ok('The report, started. Follow it at /api/evals/{id}.', { $ref: '#/components/schemas/Report' }), 409: { $ref: '#/components/responses/Error' } } }) },
      '/api/agents/{id}/candidate': {
        get: op('read', 'The change held until its tests show nothing got worse, as a line diff', { parameters: [id], responses: { 200: ok('The held change.') } }),
        post: op('approve', 'Apply, reject or test again the held change', { parameters: [id], requestBody: json({ type: 'object', properties: { action: { type: 'string', enum: ['apply', 'reject', 'retest'] } }, required: ['action'] }), responses: { 200: ok('Done.'), 202: ok('Testing again.') } }),
      },
      '/api/workflows/{id}/tests/from-run': { post: op('run', 'Turn a finished run into a test case, its answer the reference', {
        parameters: [id], requestBody: json({ type: 'object', properties: { runId: { type: 'string' }, name: { type: 'string', maxLength: 80 } }, required: ['runId'] }), responses: { 201: ok('The new case.') } }) },
      '/api/agents/{id}/tests/from-chat': { post: op('run', 'Turn an answer of the resident into a test case, the question before it the brief', {
        parameters: [id], requestBody: json({ type: 'object', properties: { index: { type: 'integer', description: 'Index of the answer in its chats. Left out: the last answer.' }, name: { type: 'string', maxLength: 80 } } }), responses: { 201: ok('The new case.') } }) },
      '/api/evals/{id}': { get: op('read', 'One test report, with the answers of its cases', { parameters: [id], responses: { 200: ok('The report.', { type: 'object', properties: { kind: { type: 'string', enum: ['workflow', 'agent'] }, subjectId: { type: 'string' }, subject: { type: 'string' }, report: { $ref: '#/components/schemas/Report' } } }) } }) },
      '/api/evals/{id}/diff': { get: op('read', 'What changed since the report before: the definition, and with ?test= the answer of one case', {
        parameters: [id, { name: 'test', in: 'query', schema: { type: 'string' } }], responses: { 200: ok('Line diffs as [mark, line] pairs, the mark being a space, - or +.') } }) },
      '/api/evals/{id}/vote': { post: op('run', 'Say whether the judge got one verdict right. It decides whether the judge counts as reliable.', {
        parameters: [id], requestBody: json({ type: 'object', properties: { testId: { type: 'string' }, index: { type: 'integer' }, agree: { type: ['boolean', 'null'] } }, required: ['testId', 'index'] }), responses: { 200: ok('The vote and how far the judge is trusted.') } }) },
      '/api/traces': { get: op('read', 'The last traces: conversations, runs and goals with their time, tools and cost', {
        parameters: [{ name: 'ref', in: 'query', schema: { type: 'string' }, description: 'Resident, run or goal id.' }, { name: 'kind', in: 'query', schema: { type: 'string', enum: ['chat', 'run', 'goal'] } }],
        responses: { 200: ok('Up to 40 traces.', { type: 'object', properties: { traces: { type: 'array', items: { $ref: '#/components/schemas/TraceSummary' } } } }) } }) },
      '/api/traces/{id}': { get: op('read', 'One trace with all its spans', { parameters: [id], responses: { 200: ok('The trace.') } }) },
      '/api/files': { get: op('read', 'Files in the workspace', { responses: { 200: ok('The file list.') } }) },
      '/api/file': {
        get: op('read', 'Read a workspace file', { parameters: [{ name: 'name', in: 'query', required: true, schema: { type: 'string' } }], responses: { 200: ok('The file.') } }),
        post: op('run', 'Write a workspace file', { requestBody: json({ type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' } }, required: ['name', 'content'] }), responses: { 200: ok('Saved.') } }),
      },
      '/api/radio/send': { post: op('run', 'Ask a resident of another silo, over Silo-to-Silo Radio', {
        requestBody: json({ type: 'object', properties: { peer: { type: 'string', description: 'Name of the other silo. May be left out when only one is connected.' }, toAgent: { type: 'string', maxLength: 60 }, message: { type: 'string', maxLength: 6000 } }, required: ['toAgent', 'message'] }),
        responses: { 200: ok('The signed answer, checked.', { type: 'object', properties: { silo: { type: 'string' }, remoteName: { type: 'string' }, agent: { type: 'object' }, reply: { type: 'string' } } }), 502: { $ref: '#/components/responses/Error' } } }) },
      '/api/radio/lookup': { post: op('admin', 'Read the Ed25519 key another silo shows at its address, with its fingerprint to compare with its owner', {
        requestBody: json({ type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }),
        responses: { 200: ok('Its key.', { type: 'object', properties: { publicKey: { type: 'string' }, fingerprint: { type: 'string' }, silo: { type: 'string' } } }), 502: { $ref: '#/components/responses/Error' } } }) },
      '/api/radio/caps': { post: op('admin', 'Give another silo a capability: residents, tools (read_files, write_files, web), folders, a budget of tokens and messages, and a time. Signed with this silo\'s key and bound to the key of the other silo.', {
        requestBody: json({ $ref: '#/components/schemas/CapabilityRequest' }),
        responses: { 201: ok('The capability, with the token to send to the other owner.', { $ref: '#/components/schemas/Capability' }) } }) },
      '/api/radio/caps/{hash}/revoke': { post: op('admin', 'Take back a capability. One this silo gave first stops at once; one it passed on is revoked at the silo that owns the data, which checks the signature.', {
        parameters: [{ name: 'hash', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } }], responses: { 200: ok('Revoked.', { $ref: '#/components/schemas/Capability' }), 502: { $ref: '#/components/responses/Error' } } }) },
      '/api/radio/held': { post: op('admin', 'Add a capability another silo gave this one. Its owner becomes a silo this one can send to.', {
        requestBody: json({ type: 'object', properties: { token: { type: 'string', description: 'silocap1....' }, url: { type: 'string', description: 'Address of the silo that owns the data, when the capability does not carry it.' }, name: { type: 'string', maxLength: 40 } }, required: ['token'] }),
        responses: { 201: ok('The capability as held.', { $ref: '#/components/schemas/Capability' }) } }) },
      '/api/radio/held/{id}': { delete: op('admin', 'Remove a held capability', { parameters: [id], responses: { 200: ok('Removed.') } }) },
      '/api/radio/held/{id}/delegate': { post: op('admin', 'Pass on part of a held capability to another silo. It can only be narrower: fewer residents, tools and folders, a smaller budget, a shorter time.', {
        parameters: [id], requestBody: json({ $ref: '#/components/schemas/CapabilityRequest' }),
        responses: { 201: ok('The longer chain, with the token to send.', { $ref: '#/components/schemas/Capability' }) } }) },
      '/api/runs/{id}': { get: op('read', 'One run: status, output, error and its steps', { parameters: [id], responses: { 200: ok('The run.', { $ref: '#/components/schemas/Run' }) } }) },
      '/api/serve/mcp': { post: op('read', 'SILO as an MCP server (Streamable HTTP, JSON answers). One tool per resident and workflow an owner exposed in System, Outside programs, plus silo_get_run, silo_pending, silo_decide, silo_run_tests and silo_test_report. Getting in needs read; each tool needs its own scope (ask and run: run, decide: approve), so a read-only token sees only the read tools.', {
        requestBody: json({ description: 'A JSON-RPC 2.0 request, notification or batch (initialize, ping, tools/list, tools/call).', oneOf: [{ type: 'object' }, { type: 'array', items: { type: 'object' } }] }),
        responses: { 200: ok('The JSON-RPC answer.'), 202: { description: 'Only notifications came.' }, 405: { $ref: '#/components/responses/Error' } } }) },
      '/api/serve/a2a': { post: op('read', 'SILO as an A2A agent (protocol 0.3, JSON-RPC). Its card is at /.well-known/agent-card.json while the agent is on. message/send and message/stream (server-sent events) need run, tasks/get and tasks/resubscribe need read, tasks/cancel needs run. Each token sees only its own tasks, kept in memory for a day.', {
        requestBody: json({ type: 'object', properties: { jsonrpc: { const: '2.0' }, id: { type: ['string', 'integer'] }, method: { type: 'string', enum: ['message/send', 'message/stream', 'tasks/get', 'tasks/cancel', 'tasks/resubscribe'] }, params: { type: 'object' } }, required: ['jsonrpc', 'id', 'method'] }),
        responses: { 200: ok('The JSON-RPC answer, or a stream of task events.') } }) },
      '/api/notebooks': { get: op('read', 'The notebooks of the residents and whether their kernels run', { responses: { 200: ok('The list.') } }) },
      '/api/notebooks/{id}/{name}': {
        get: op('read', 'One notebook as nbformat 4.5 JSON', { parameters: [id, { name: 'name', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: ok('The notebook.') } }),
        post: op('run', 'Restart its kernel, or save a copy to the Archive', { parameters: [id, { name: 'name', in: 'path', required: true, schema: { type: 'string' } }], requestBody: json({ type: 'object', properties: { action: { type: 'string', enum: ['restart', 'archive'] } }, required: ['action'] }), responses: { 200: ok('Done.') } }),
        delete: op('run', 'Delete a notebook', { parameters: [id, { name: 'name', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: ok('Deleted.') } }),
      },
      '/api/pause': { post: op('run', 'Pause or resume the silo', { requestBody: json({ type: 'object', properties: { paused: { type: 'boolean' } } }), responses: { 200: ok('Done.') } }) },
      '/api/export': { get: op('read', 'Everything except keys, as one JSON file', { responses: { 200: ok('The export.') } }) },
    },
  };
}
