import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readPage,htmlToText,privateAddress} from '../web-reader.mjs';

test('turns a web page into readable text',()=>{
  const {title,text}=htmlToText('<html><head><title>Silo &amp; Co</title><style>p{}</style></head><body><nav>Menu</nav><h1>Rules</h1><p>Do not go <b>outside</b>.</p><ul><li>One</li><li>Two &#8212; three</li></ul><script>alert(1)</script></body></html>');
  assert.equal(title,'Silo & Co');assert.match(text,/## Rules\nDo not go outside\./);assert.match(text,/- One\n- Two \u2014 three/);
  assert.ok(!text.includes('alert')&&!text.includes('Menu'));
});
test('knows which addresses are local',()=>{
  for(const ip of ['127.0.0.1','10.1.2.3','192.168.0.5','172.20.1.1','169.254.1.1','::1','fd00::1','::ffff:127.0.0.1','::ffff:7f00:1','[::ffff:7f00:1]','::ffff:a9fe:a9fe','64:ff9b::7f00:1','0.0.0.0'])assert.ok(privateAddress(ip),ip);
  for(const ip of ['8.8.8.8','1.1.1.1','2606:4700::1111','::ffff:808:808'])assert.ok(!privateAddress(ip),ip);
});
test('reads a page, follows redirects and refuses local addresses',async t=>{
  const server=http.createServer((req,res)=>{
    if(req.url==='/move'){res.writeHead(302,{Location:'/page'});return res.end();}
    if(req.url==='/image'){res.writeHead(200,{'Content-Type':'image/png'});return res.end('x');}
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<title>Level 1</title><main><p>'+'The cafeteria screen shows the outside. '.repeat(20)+'</p></main>');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`;
  const page=await readPage(base+'/move',{allowLocal:true});
  assert.equal(page.url,base+'/page');assert.equal(page.title,'Level 1');assert.match(page.text,/cafeteria screen/);
  const short=await readPage(base+'/page',{allowLocal:true,maxChars:50});assert.match(short.text,/The page was cut here/);
  await assert.rejects(readPage(base+'/image',{allowLocal:true}),/not a text page/);
  await assert.rejects(readPage(base+'/page'),/cannot be read/);
  await assert.rejects(readPage(`http://localhost:${server.address().port}/page`),/cannot be read/);
  await assert.rejects(readPage('file:///etc/passwd'),/Only http and https/);
  await assert.rejects(readPage('not a url'),/not a valid web address/);
});
