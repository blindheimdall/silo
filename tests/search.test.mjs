import {test} from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {parseDuckDuckGo} from '../web-search.mjs';
import {ArchiveIndex,chunk,words} from '../archive-index.mjs';

test('reads DuckDuckGo results with their real addresses',()=>{
  const r=parseDuckDuckGo('<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fa%3Fx%3D1&amp;rut=z">Title <b>bold</b></a><a class="result__snippet">Snip &amp; more</a></div><div class="result"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>');
  assert.deepEqual(r,[{title:'Title bold',url:'https://example.org/a?x=1',snippet:'Snip & more'}]);
});
test('cuts files into pieces with line numbers and folds accents',()=>{
  const pieces=chunk(Array.from({length:200},(_,i)=>'line '+i+' '+'x'.repeat(20)).join('\n'),600);
  assert.ok(pieces.length>5);assert.equal(pieces[0].start,1);assert.ok(pieces[1].start<=pieces[0].end,'pieces overlap');
  assert.deepEqual(words('Ședința de consiliu, nivelul 40!'),['sedinta','de','consiliu','nivelul','40']);
});
test('finds passages by keywords, and by meaning when vectors are there',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'silo-index-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const files={'farm.md':'The hydroponic farm grows tomatoes and beans on level 90.','engine.md':'Pour fresh oil into the generator every Tuesday.','constructor.md':'constructor toString valueOf'};
  const make=embed=>new ArchiveIndex(path.join(dir,'index.json'),{list:async()=>Object.keys(files).map(name=>({name,size:files[name].length,mtime:1})),read:async n=>files[n],embed,model:embed?'toy':''});
  const plain=make(null);
  assert.equal((await plain.search('tomatoes'))[0].name,'farm.md');
  assert.deepEqual(await plain.search('lubricant'),[],'no shared word, no keyword hit');
  assert.equal((await plain.search('constructor'))[0]?.name,'constructor.md','words like constructor are plain words');
  const SAME={lubricant:'oil'},vec=s=>{const v=[0,0,0];for(const w of s.toLowerCase().match(/[a-z]+/g)){const x=SAME[w]||w;if(x==='oil')v[0]++;if(x==='farm'||x==='tomatoes')v[1]++;v[2]+=.01;}return v;};
  const smart=make(async texts=>texts.map(vec));
  const hits=await smart.search('lubricant');assert.equal(hits[0].name,'engine.md');assert.equal(hits[0].meaning,true);
  assert.equal(smart.stats().withMeaning,3);
  files['farm.md']='Now the farm grows potatoes.';
  const again=make(null);assert.equal((await again.search('potatoes'))[0].name,'farm.md','changed files are read again');
});
