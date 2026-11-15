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
        Workflow: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, enabled: { type: 'boolean' }, catchUp: { type: 'string', enum: ['once', 'skip'], description: 'A scheduled time missed while SILO was off, asleep or paused: run once when it is back, or skip it.' }, catchUpHours: { type: 'integer', minimum: 0, maximum: 168, description: 'With once: only if it is at most this many hours late. 0: however late.' }, steps: { type: 'array', items: { type: 'object' } } } },
        Run: { type: 'object', properties: { id: { type: 'string' }, workflowId: { type: 'string' }, status: { type: 'string', examples: ['running', 'done', 'failed', 'stopped'] }, waiting: { type: 'boolean' }, input: { type: 'string' }, output: { type: 'string' }, steps: { type: 'array', items: { type: 'object' } }, started: { type: 'integer' }, ended: { type: 'integer' } } },
        Reply: { type: 'object', properties: { text: { type: 'string' }, tokens: { type: 'integer' }, tools: { type: 'array', items: { type: 'object' } }, truncated: { type: 'boolean' }, traceId: { type: 'string' } } },
        Check: { type: 'object', properties: { op: { type: 'string', enum: ['contains', 'missing', 'regex', 'field', 'judge', 'maxcost', 'maxms', 'maxtokens'] }, text: { type: 'string' }, weight: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['op', 'text'] },
        TestCase: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string', maxLength: 80 }, input: { type: 'string', maxLength: 15000 }, reference: { type: 'string', maxLength: 8000 }, checks: { type: 'array', maxItems: 10, items: { $ref: '#/components/schemas/Check' } } }, required: ['input', 'checks'] },
        Suite: { type: 'object', properties: { tests: { type: 'array', maxItems: 20, items: { $ref: '#/components/schemas/TestCase' } }, judgeId: { type: ['string', 'null'] }, repeat: { type: 'integer', minimum: 1, maximum: 5 }, gate: { type: 'string', enum: ['off', 'test', 'hold'] }, learn: { type: 'boolean', description: 'Workflows only: a run rejected with a note becomes a case.' } }, required: ['tests'] },
        EvaluateBody: { type: 'object', properties: { repeat: { type: 'integer', minimum: 1, maximum: 5 }, trigger: { type: 'string', enum: ['manual', 'ci'] }, models: { type: 'array', maxItems: 4, items: { type: 'object', properties: { provider: { type: 'string' }, model: { type: 'string' } } } } } },
        Report: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['waiting', 'running', 'done', 'interrupted'] }, total: { type: 'integer' }, passed: { type: 'integer' }, score: { type: 'number', description: '0 to 100' }, interval: { type: 'array', items: { type: 'number' }, description: 'Pass rate over every attempt, 95% interval, in %.' }, repeat: { type: 'integer' }, worse: { type: 'object' }, compare: { type: 'object', properties: { baseline: { type: ['string', 'null'] }, cases: { type: 'object', additionalProperties: { type: 'string', enum: ['broke', 'worse', 'flaky', 'new', 'better', 'fixed', 'same'] } }, count: { type: 'object' }, scoreDelta: { type: ['number', 'null'] }, worse: { type: 'boolean' } } }, results: { type: 'array', items: { type: 'object' } } } },
        Column: { type: 'object', properties: { name: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,39}$' }, type: { type: 'string', enum: ['text', 'number', 'boolean', 'date', 'json'] }, required: { type: 'boolean' }, unique: { type: 'boolean' }, was: { type: 'string', description: 'When changing columns: the name it had.' } }, required: ['name'] },
        Table: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, columns: { type: 'array', items: { $ref: '#/components/schemas/Column' } }, rows: { type: 'integer' }, created: { type: 'integer' }, updated: { type: 'integer' } } },
        TalkConversation: { type: 'object', properties: { id: { type: 'string' }, kind: { type: 'string', enum: ['widget', 'slack', 'whatsapp', 'teams'] }, who: { type: 'string' }, mode: { type: 'string', enum: ['resident', 'person'], description: 'person: taken over by your team; the resident does not answer.' }, unread: { type: 'integer' }, count: { type: 'integer' }, started: { type: 'integer' }, updated: { type: 'integer' }, heard: { type: 'integer' }, last: { type: 'string' }, lastRole: { type: 'string' } } },
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
      '/api/workflows/draft': { post: op('run', 'Draft a workflow from a description. A resident with a model writes it; it is checked like a saved workflow and not saved', {
        requestBody: json({ type: 'object', properties: { text: { type: 'string', maxLength: 4000 }, agentId: { type: 'string', description: 'The resident who drafts it. The first one with a model when left out.' }, current: { $ref: '#/components/schemas/Workflow', description: 'A draft to change as asked, instead of starting over.' } }, required: ['text'] }),
        responses: { 200: ok('The draft, to save with POST /api/workflows.', { type: 'object', properties: { draft: { $ref: '#/components/schemas/Workflow' }, notes: { type: 'string' }, agent: { type: 'string' }, tries: { type: 'integer' }, tokens: { type: 'integer' } } }), 422: { $ref: '#/components/responses/Error' }, 502: { $ref: '#/components/responses/Error' }, 504: { $ref: '#/components/responses/Error' } } }) },
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
      '/api/talk/inbox': { get: op('read', 'Conversations of the talk channels, newest first. Owners and operators only', {
        parameters: [{ name: 'q', in: 'query', schema: { type: 'string', maxLength: 200 }, description: 'Words in the name or in any message.' }, { name: 'mode', in: 'query', schema: { type: 'string', enum: ['', 'waiting', 'unread', 'person', 'resident'] }, description: 'waiting: taken over, and the last message is from the person.' },
          { name: 'kind', in: 'query', schema: { type: 'string', enum: ['widget', 'slack', 'whatsapp', 'teams'] } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } }, { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } }],
        responses: { 200: ok('The conversations, how many match, the counts and the channels.', { type: 'object', properties: { conversations: { type: 'array', items: { $ref: '#/components/schemas/TalkConversation' } }, total: { type: 'integer' }, counts: { type: 'object' }, settings: { type: 'object' }, channels: { type: 'object' } } }), 403: { $ref: '#/components/responses/Error' } } }) },
      '/api/talk/inbox/settings': { post: op('run', 'How long conversations are kept. Owner only', { requestBody: json({ type: 'object', properties: { keepDays: { type: 'integer', minimum: 1, maximum: 365 } }, required: ['keepDays'] }), responses: { 200: ok('The settings.') } }) },
      '/api/talk/inbox/{id}': {
        get: op('read', 'One conversation with its messages', { parameters: [id, { name: 'after', in: 'query', schema: { type: 'integer', minimum: 0 }, description: 'Only messages after this number.' }],
          responses: { 200: ok('The conversation and its messages.', { type: 'object', properties: { conversation: { $ref: '#/components/schemas/TalkConversation' }, messages: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, role: { type: 'string', enum: ['person', 'resident', 'human', 'notice', 'note'] }, text: { type: 'string' }, at: { type: 'integer' }, by: { type: 'string' } } } } } }) } }),
        delete: op('run', 'Delete a conversation and its messages', { parameters: [id], responses: { 200: ok('Deleted.') } }),
      },
      '/api/talk/inbox/{id}/mode': { post: op('run', 'Take a conversation over (person) or give it back to the resident', { parameters: [id], requestBody: json({ type: 'object', properties: { mode: { type: 'string', enum: ['person', 'resident'] } }, required: ['mode'] }), responses: { 200: ok('The conversation.', { $ref: '#/components/schemas/TalkConversation' }) } }) },
      '/api/talk/inbox/{id}/reply': { post: op('run', 'Answer as your team, the way the person wrote. Takes the conversation over', { parameters: [id], requestBody: json({ type: 'object', properties: { text: { type: 'string', maxLength: 4000 } }, required: ['text'] }),
        responses: { 200: ok('Sent.', { type: 'object', properties: { conversation: { $ref: '#/components/schemas/TalkConversation' }, n: { type: 'integer' } } }), 409: { $ref: '#/components/responses/Error' }, 502: { $ref: '#/components/responses/Error' } } }) },
      '/api/talk/inbox/{id}/read': { post: op('run', 'Mark a conversation as read', { parameters: [id], responses: { 200: ok('The conversation.', { $ref: '#/components/schemas/TalkConversation' }) } }) },
      '/api/tables': {
        get: op('read', 'The tables, with their columns and how many rows they have', { responses: { 200: ok('The tables.', { type: 'object', properties: { tables: { type: 'array', items: { $ref: '#/components/schemas/Table' } } } }) } }),
        post: op('run', 'Make a table', { requestBody: json({ type: 'object', properties: { name: { type: 'string', maxLength: 60 }, columns: { type: 'array', maxItems: 30, items: { $ref: '#/components/schemas/Column' } } }, required: ['name', 'columns'] }), responses: { 201: ok('The table.', { $ref: '#/components/schemas/Table' }) } }),
      },
      '/api/tables/{id}': {
        get: op('read', 'One table, by its id or its name', { parameters: [id], responses: { 200: ok('The table.', { $ref: '#/components/schemas/Table' }) } }),
        put: op('run', 'Rename a table or change its columns. "was" renames a column and keeps its values; table steps follow the new name', { parameters: [id], requestBody: json({ type: 'object', properties: { name: { type: 'string', maxLength: 60 }, columns: { type: 'array', maxItems: 30, items: { $ref: '#/components/schemas/Column' } } } }), responses: { 200: ok('The table, and how many workflows were changed.') } }),
        delete: op('run', 'Delete a table and its rows. Refused (409) while a workflow uses it', { parameters: [id], responses: { 200: ok('Deleted.'), 409: { $ref: '#/components/responses/Error' } } }),
      },
      '/api/tables/{id}/rows': {
        get: op('read', 'Rows of a table', {
          parameters: [id, { name: 'filters', in: 'query', schema: { type: 'string' }, description: 'JSON: [{"column":"email","op":"eq","value":"ana@example.com"}]. op: eq, ne, contains, starts, gt, gte, lt, lte, empty, filled. Text is compared without case.' },
            { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Words found in any value.' }, { name: 'sort', in: 'query', schema: { type: 'string' }, description: 'A column, or id, created, updated.' },
            { name: 'desc', in: 'query', schema: { type: 'string', enum: ['1', ''] } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 } }, { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } }],
          responses: { 200: ok('The rows and how many match.', { type: 'object', properties: { table: { $ref: '#/components/schemas/Table' }, rows: { type: 'array', items: { type: 'object' } }, total: { type: 'integer' } } }) } }),
        post: op('run', 'Add a row, or with matchOn change the row with that value and add it when there is none', { parameters: [id], requestBody: json({ type: 'object', properties: { values: { type: 'object', description: 'Column names and values.' }, matchOn: { type: 'string', description: 'A column, like email.' } }, required: ['values'] }), responses: { 200: ok('Changed: {row, added: false}.'), 201: ok('Added: the row, or {row, added: true} with matchOn.'), 409: { $ref: '#/components/responses/Error' } } }),
      },
      '/api/tables/{id}/rows/{row}': {
        get: op('read', 'One row', { parameters: [id, { name: 'row', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: ok('The row.') } }),
        put: op('run', 'Change values of a row. null or "" clears one', { parameters: [id, { name: 'row', in: 'path', required: true, schema: { type: 'integer' } }], requestBody: json({ type: 'object', properties: { values: { type: 'object' } }, required: ['values'] }), responses: { 200: ok('The row.') } }),
        delete: op('run', 'Delete a row', { parameters: [id, { name: 'row', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: ok('Deleted.') } }),
      },
      '/api/tables/{id}/delete': { post: op('run', 'Delete up to 1000 rows', { parameters: [id], requestBody: json({ type: 'object', properties: { ids: { type: 'array', maxItems: 1000, items: { type: 'integer' } } }, required: ['ids'] }), responses: { 200: ok('How many were deleted.') } }) },
      '/api/tables/{id}/import': { post: op('run', 'Add rows from CSV, all or none. The first line names the columns', { parameters: [id], requestBody: { required: true, content: { 'text/csv': { schema: { type: 'string', maxLength: 5000000 } } } }, responses: { 200: ok('How many rows were added, and the headers left out.') } }) },
      '/api/tables/import': { post: op('run', 'Make a table from CSV: columns from the first line, kinds of value from the rows', { parameters: [{ name: 'name', in: 'query', schema: { type: 'string', maxLength: 60 } }], requestBody: { required: true, content: { 'text/csv': { schema: { type: 'string', maxLength: 5000000 } } } }, responses: { 201: ok('The table and how many rows were added.') } }) },
      '/api/tables/{id}/csv': { get: op('read', 'A table as a CSV file', { parameters: [id], responses: { 200: { description: 'text/csv' } } }) },
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
