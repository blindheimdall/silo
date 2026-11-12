// SILO as an MCP server (Streamable HTTP, JSON answers). Claude Desktop, Cursor, LangGraph, CrewAI and any other MCP
// client can ask the residents and run the workflows an owner exposed, with the rights of the token they use.
// This module speaks the protocol; server.mjs gives it the tools and runs them.
export const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const ERR = { parse: -32700, request: -32600, method: -32601, params: -32602, internal: -32603 };

// A tool name an MCP client accepts: letters, digits, _ and -, at most 64.
export const toolSlug = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'x';
// Names for a list of things, made unique by a number when two would be the same.
export function uniqueNames(items, prefix) {
  const seen = new Map();
  return items.map(it => { let n = prefix + toolSlug(it.name), k = n, i = 2; while (seen.has(k)) k = `${n}_${i++}`; seen.set(k, true); return k; });
}

const typeOk = (v, t) => t === 'string' ? typeof v === 'string' : t === 'integer' ? Number.isInteger(v) : t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'boolean' ? typeof v === 'boolean' : t === 'array' ? Array.isArray(v) : t === 'object' ? v && typeof v === 'object' && !Array.isArray(v) : true;
// The arguments against the tool's input schema: an object, required keys, simple types, string lengths and enums.
export function checkArgs(schema, args) {
  if (args === undefined || args === null) args = {};
  if (!typeOk(args, 'object')) return 'The arguments must be an object.';
  for (const k of schema.required || []) if (args[k] === undefined || args[k] === null || args[k] === '') return `"${k}" is required.`;
  for (const [k, v] of Object.entries(args)) {
    const p = schema.properties?.[k];
    if (!p) { if (schema.additionalProperties === false) return `"${k}" is not an argument of this tool.`; continue; }
    if (p.type && !typeOk(v, p.type)) return `"${k}" must be ${p.type === 'integer' ? 'a whole number' : 'a ' + p.type}.`;
    if (p.enum && !p.enum.includes(v)) return `"${k}" must be one of ${p.enum.join(', ')}.`;
    if (typeof v === 'string' && p.maxLength && v.length > p.maxLength) return `"${k}" is longer than ${p.maxLength} characters.`;
    if (typeof v === 'number' && ((p.minimum !== undefined && v < p.minimum) || (p.maximum !== undefined && v > p.maximum))) return `"${k}" must be between ${p.minimum} and ${p.maximum}.`;
  }
  return null;
}

// One JSON-RPC message or a batch. ctx: {info: {name, version, instructions}, tools(): [{name, title, description,
// inputSchema, annotations, scope}], can(scope), call(tool, args)}. call returns {text, data?, isError?}.
// The answer is {status, body}: 202 with no body when only notifications came.
export async function handleMcp(msg, ctx) {
  if (Array.isArray(msg)) {
    if (!msg.length) return { status: 400, body: rpcError(null, ERR.request, 'Empty batch.') };
    const out = (await Promise.all(msg.slice(0, 20).map(m => one(m, ctx)))).filter(Boolean);
    return out.length ? { status: 200, body: out } : { status: 202, body: null };
  }
  const r = await one(msg, ctx);
  return r ? { status: 200, body: r } : { status: 202, body: null };
}
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });

async function one(m, ctx) {
  if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
    // A response from the client (to a request we never send) or nonsense.
    return m && typeof m === 'object' && ('result' in m || 'error' in m) ? null : rpcError(m?.id, ERR.request, 'Not a JSON-RPC 2.0 request.');
  }
  const notify = !('id' in m);
  if (notify) return null; // notifications/initialized, notifications/cancelled: nothing to answer
  const { id, method, params = {} } = m;
  if (typeof id !== 'string' && typeof id !== 'number') return rpcError(null, ERR.request, 'The id must be a string or a number.');
  try {
    if (method === 'initialize') {
      const asked = params?.protocolVersion, version = MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0];
      return ok(id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'silo', title: ctx.info.name, version: ctx.info.version }, instructions: ctx.info.instructions });
    }
    if (method === 'ping') return ok(id, {});
    if (method === 'tools/list') {
      const tools = ctx.tools().filter(t => ctx.can(t.scope)).map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, ...(annotations && { annotations }) }));
      return ok(id, { tools });
    }
    if (method === 'tools/call') {
      const name = params?.name, tool = typeof name === 'string' && ctx.tools().find(t => t.name === name);
      if (!tool) return rpcError(id, ERR.params, `Unknown tool: ${String(name).slice(0, 80)}`);
      if (!ctx.can(tool.scope)) return ok(id, { content: [{ type: 'text', text: `This needs a token with the ${tool.scope} scope.` }], isError: true });
      const bad = checkArgs(tool.inputSchema, params.arguments);
      if (bad) return ok(id, { content: [{ type: 'text', text: bad }], isError: true });
      try {
        const r = await ctx.call(tool, params.arguments || {});
        return ok(id, { content: [{ type: 'text', text: String(r.text ?? '') }], ...(r.data !== undefined && { structuredContent: r.data }), ...(r.isError && { isError: true }) });
      } catch (e) { return ok(id, { content: [{ type: 'text', text: String(e?.message || e).slice(0, 2000) }], isError: true }); }
    }
    if (method === 'resources/list') return ok(id, { resources: [] });
    if (method === 'prompts/list') return ok(id, { prompts: [] });
    return rpcError(id, ERR.method, `Unknown method: ${method.slice(0, 80)}`);
  } catch (e) { return rpcError(id, ERR.internal, String(e?.message || e).slice(0, 500)); }
}
