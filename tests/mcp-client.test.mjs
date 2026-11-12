import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {McpClient,resultText,safeToolName} from '../mcp-client.mjs';
import {handle} from './mcp-fixture.mjs';
const fixture=path.join(path.dirname(fileURLToPath(import.meta.url)),'mcp-fixture.mjs');

test('talks to a local MCP program over stdio, with paged tool lists and errors',async t=>{
  const c=new McpClient({transport:'stdio',command:process.execPath,args:[fixture]},{timeout:10000});t.after(()=>c.close());
  const tools=await c.listTools();
  assert.deepEqual(tools.map(x=>x.name),['echo','add_note','fail']);assert.equal(c.server.name,'silo-fixture');
  assert.equal(resultText(await c.callTool('echo',{text:'level 40'})),'echo: level 40');
  const bad=await c.callTool('fail',{});assert.equal(bad.isError,true);
  await assert.rejects(c.callTool('nope',{}),/Unknown tool nope/);
});
test('talks to an MCP server over Streamable HTTP, as JSON and as an event stream',async t=>{
  let sessions=0,lastHeaders;
  const server=http.createServer(async (req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;lastHeaders=req.headers;
    if(req.method==='DELETE'){res.writeHead(204);return res.end();}
    if(req.headers.authorization!=='Bearer fixture-token'){res.writeHead(401);return res.end('no');}
    const msg=JSON.parse(body),reply=handle(msg);
    const extra=msg.method==='initialize'?{'Mcp-Session-Id':'s'+(++sessions)}:{};
    if(!reply){res.writeHead(202,extra);return res.end();}
    if(msg.method==='tools/call'){res.writeHead(200,{'Content-Type':'text/event-stream',...extra});res.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n');res.end('data: '+JSON.stringify(reply)+'\n\n');return;}
    res.writeHead(200,{'Content-Type':'application/json',...extra});res.end(JSON.stringify(reply));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const url=`http://127.0.0.1:${server.address().port}/mcp`;
  const c=new McpClient({transport:'http',url,headers:{Authorization:'Bearer fixture-token'}},{timeout:5000});t.after(()=>c.close());
  assert.equal((await c.listTools()).length,3);
  assert.equal(lastHeaders['mcp-session-id'],'s1');assert.equal(lastHeaders['mcp-protocol-version'],'2025-06-18');
  assert.equal(resultText(await c.callTool('echo',{text:'hi'})),'echo: hi');
  const denied=new McpClient({transport:'http',url,headers:{}},{timeout:5000});
  await assert.rejects(denied.listTools(),/answered 401/);
  await assert.rejects(new McpClient({transport:'http',url:'http://example.com/mcp'}).listTools(),/https/);
});
test('makes tool names every provider accepts',()=>{
  assert.equal(safeToolName('My GitHub!','search.issues'),'my_github__search_issues');
  assert.ok(safeToolName('x'.repeat(80),'y'.repeat(80)).length<=64);
});
