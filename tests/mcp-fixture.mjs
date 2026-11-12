// A tiny MCP server for tests and for trying connectors without an account anywhere.
// Run it as a program for stdio, or import handle() to answer HTTP requests.
// Tools: echo (read only), add_note (changes something), fail (always an error). tools/list comes in two pages.
import { pathToFileURL } from 'node:url';

const notes=[];
export function handle(msg){
  if(msg.id===undefined)return null;
  const ok=result=>({jsonrpc:'2.0',id:msg.id,result});
  switch(msg.method){
    case 'initialize':return ok({protocolVersion:msg.params?.protocolVersion||'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'silo-fixture',version:'1.0.0'}});
    case 'tools/list':
      if(!msg.params?.cursor)return ok({tools:[{name:'echo',description:'Repeats the text it gets.',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']},annotations:{readOnlyHint:true}}],nextCursor:'page2'});
      return ok({tools:[{name:'add_note',description:'Adds a note to the fixture notebook.',inputSchema:{type:'object',properties:{note:{type:'string'}},required:['note']}},{name:'fail',description:'Always fails.',inputSchema:{type:'object',properties:{}}}]});
    case 'tools/call':{
      const {name,arguments:a={}}=msg.params||{};
      if(name==='echo')return ok({content:[{type:'text',text:'echo: '+a.text}]});
      if(name==='add_note'){notes.push(a.note);return ok({content:[{type:'text',text:`Saved. The notebook has ${notes.length} notes.`}]});}
      if(name==='fail')return ok({content:[{type:'text',text:'The fixture failed on purpose.'}],isError:true});
      return {jsonrpc:'2.0',id:msg.id,error:{code:-32602,message:'Unknown tool '+name}};
    }
    case 'ping':return ok({});
    default:return {jsonrpc:'2.0',id:msg.id,error:{code:-32601,message:'Method not found'}};
  }
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
  let buffer='';process.stdin.setEncoding('utf8');
  process.stdin.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);if(!line)continue;const r=handle(JSON.parse(line));if(r)process.stdout.write(JSON.stringify(r)+'\n');}});
  process.stdin.on('end',()=>process.exit(0));
  process.stderr.write('silo-fixture ready\n');
}
