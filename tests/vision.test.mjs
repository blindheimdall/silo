// Screenshots reach models that can see, in each provider's own shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openaiInput, anthropicMessages, chatMessages } from '../provider-format.mjs';

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
