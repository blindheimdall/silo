// Screenshots reach models that can see, in each provider's own shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openaiInput, anthropicMessages, chatMessages, CallCollector, chatText, errorDetail } from '../provider-format.mjs';

const convo=[
  {role:'user',content:'Look at the page.'},
  {role:'assistant',content:'',calls:[{id:'c1',name:'browser',args:{action:'look'}}]},
  {role:'tool',results:[{id:'c1',name:'browser',content:'<page>Map</page>',images:[{mime:'image/jpeg',data:'QUJD'}]}]},
];

test('OpenAI gets the image inside the tool output',()=>{
  const out=openaiInput(convo).find(x=>x.type==='function_call_output');
  assert.deepEqual(out.output,[{type:'input_text',text:'<page>Map</page>'},{type:'input_image',image_url:'data:image/jpeg;base64,QUJD'}]);
});
test('Anthropic gets an image block inside the tool result',()=>{
  const res=anthropicMessages(convo).at(-1).content[0];
  assert.equal(res.type,'tool_result');assert.equal(res.content[1].type,'image');
  assert.deepEqual(res.content[1].source,{type:'base64',media_type:'image/jpeg',data:'QUJD'});
});
test('chat completions and Ollama get the image in a user message after the tool message',()=>{
  const chat=chatMessages(convo,'sys','compatible');
  assert.equal(chat.at(-2).role,'tool');assert.equal(chat.at(-2).content,'<page>Map</page>');
  assert.equal(chat.at(-1).role,'user');assert.equal(chat.at(-1).content[1].image_url.url,'data:image/jpeg;base64,QUJD');
  const ollama=chatMessages(convo,'sys','ollama');
  assert.deepEqual(ollama.at(-1).images,['QUJD']);
});
test('tool results without images stay plain text',()=>{
  const plain=[convo[0],convo[1],{role:'tool',results:[{id:'c1',name:'browser',content:'text'}]}];
  assert.equal(openaiInput(plain).at(-1).output,'text');
  assert.equal(anthropicMessages(plain).at(-1).content[0].content,'text');
  assert.equal(chatMessages(plain,'','compatible').at(-1).role,'tool');
});

// Tool calls streamed by chat completion servers, in the shapes they really send.
test('streamed tool calls are put together whatever shape the server sends them in',()=>{
  const calls=pieces=>{const c=new CallCollector('compatible');for(const d of pieces)c.event({choices:[{delta:{tool_calls:[d]}}]});return c.calls().map(x=>[x.name,x.args]);};
  const want=[['files',{path:'x'}]];
  assert.deepEqual(calls([{index:0,id:'a',function:{name:'files',arguments:''}},{index:0,function:{arguments:'{"pa'}},{index:0,function:{arguments:'th":"x"}'}}]),want,'the name once');
  assert.deepEqual(calls([{index:0,id:'a',function:{name:'files',arguments:'{"pa'}},{index:0,function:{name:'files',arguments:'th":"x"}'}}]),want,'the name in every piece');
  assert.deepEqual(calls([{index:0,id:'a',function:{name:'files',arguments:{path:'x'}}}]),want,'arguments as an object');
  assert.deepEqual(calls([{id:'a',function:{name:'files',arguments:'{"pa'}},{function:{arguments:'th":"x"}'}}]),want,'no index');
  assert.deepEqual(calls([{function:{name:'files',arguments:'{"path":"x"}'}},{function:{name:'files',arguments:'{"path":"y"}'}}]),[['files',{path:'x'}],['files',{path:'y'}]],'two whole calls, no index or id');
});
test('Anthropic never gets a message with no text',()=>{
  assert.deepEqual(anthropicMessages([{role:'user',content:'hi'},{role:'assistant',content:''},{role:'user',content:'again'}]),[{role:'user',content:[{type:'text',text:'hi'},{type:'text',text:'again'}]}]);
});

test('chat answers given as a list of parts keep only the text parts',()=>{
  assert.equal(chatText('plain'),'plain');
  assert.equal(chatText([{type:'thinking',thinking:'no'},{type:'text',text:'a'},'b',{text:'c'},{type:'image_url',image_url:{}}]),'abc');
  assert.equal(chatText(null),'');assert.equal(chatText({text:'x'}),'');
});

test('the reason of an error is found in every shape servers send it',()=>{
  assert.equal(errorDetail({error:'plain'}),'plain');
  assert.equal(errorDetail({error:{message:'inside'}}),'inside');
  assert.equal(errorDetail({object:'error',message:'top'}),'top');
  assert.equal(errorDetail({detail:'fastapi'}),'fastapi');
  assert.match(errorDetail({error:{code:'model_not_ready'}}),/model_not_ready/);
  assert.match(errorDetail({detail:[{loc:['body'],msg:'field required'}]}),/field required/);
  assert.equal(errorDetail(null),'');assert.equal(errorDetail(5),'');
});
