// The workflow canvas: columns of steps, moves that keep the references between steps right, and the same rules as
// the server, said before saving.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {stagesOf,remapRefs,refsOf,lint,layout,rearrange,dropAt,canJoin,COL,NODE_W} from '../public/flow-canvas.js';

const agent=(prompt='Do it.',extra={})=>({type:'agent',agentId:'a',prompt,...extra});

test('steps that run at the same time share a column, only after a resident step',()=>{
  assert.deepEqual(stagesOf([agent(),agent('b',{parallel:true}),agent()]),[[0,1],[2]]);
  assert.deepEqual(stagesOf([{type:'approval'},agent('b',{parallel:true})]),[[0],[1]],'after an approval it is its own column');
  assert.deepEqual(stagesOf([agent(),agent('b',{parallel:true}),agent('c',{parallel:true}),{type:'review',agentId:'a',prompt:'x',target:1}]),[[0,1,2],[3]]);
});

test('references follow a move, all at once, in text and in code',()=>{
  const map=new Map([[1,2],[2,1]]);
  assert.equal(remapRefs('A {{step 1}} and {{ step 2.items[0].id }} and {{step 12}}',map),'A {{step 2}} and {{ step 1.items[0].id }} and {{step 12}}');
  assert.equal(remapRefs('return steps[1] + steps[2] + {{step 1}}',map,true),'return steps[2] + steps[1] + {{step 2}}');
  assert.equal(remapRefs('steps[1]',map),'steps[1]','outside code, steps[1] is just text');
  assert.deepEqual([...refsOf({prompt:'{{step 1}} {{step 3}}',code:'steps[2]',when:{step:4},fields:{to:'{{step 5.email}}'}})].sort(),[1,2,3,4,5]);
});

test('a drop rearranges the columns, and a drop that changes nothing is nothing',()=>{
  const steps=[agent('1'),agent('2',{parallel:true}),agent('3'),{type:'review',agentId:'a',prompt:'r',target:3}];
  // Out of the column, into the gap after it.
  assert.deepEqual(rearrange(steps,1,{kind:'gap',gap:1}),{order:[0,1,2,3],parallel:[false,false,false,false]});
  // Onto the column of step 3: runs at the same time as it.
  assert.deepEqual(rearrange(steps,0,{kind:'stage',stage:1}),{order:[1,2,0,3],parallel:[false,false,true,false]});
  // Its own place.
  assert.equal(rearrange(steps,2,{kind:'gap',gap:1}),null);assert.equal(rearrange(steps,2,{kind:'gap',gap:2}),null);
  // The head of a column moves away: the next one leads it.
  assert.deepEqual(rearrange(steps,0,{kind:'gap',gap:2}),{order:[1,2,0,3],parallel:[false,false,false,false]});
  assert.deepEqual(rearrange(steps,0,{kind:'gap',gap:3}).order,[1,2,3,0],'the last gap is the end');
  // A review cannot join a column, nor a step that repeats.
  assert.equal(canJoin(steps,[0,1],3),false);assert.equal(canJoin([agent(),agent('x',{each:'{{step 1}}'})],[0],1),false);
});

test('the point under the pointer: a column it may join, else the nearest gap',()=>{
  const steps=[agent('1'),agent('2'),{type:'approval'},agent('4')],lay=layout(steps),col=c=>lay.x0+c*COL;
  assert.deepEqual(dropAt(steps,lay,3,col(1)+NODE_W/2),{kind:'stage',stage:1});
  assert.deepEqual(dropAt(steps,lay,3,col(2)+10),{kind:'gap',gap:2},'not onto an approval');
  assert.deepEqual(dropAt(steps,lay,0,col(1)+NODE_W+20),{kind:'gap',gap:2});
  assert.deepEqual(dropAt(steps,lay,0,-500),{kind:'gap',gap:0});
  assert.deepEqual(dropAt(steps,lay,0,99999),{kind:'gap',gap:4});
});

test('the canvas says what the server would refuse',()=>{
  const said=lint([
    {type:'review',agentId:'a',prompt:'r',target:1},
    agent('',{parallel:true}),
    {type:'approval',when:{op:'contains',step:5,text:''}},
    agent('uses {{item}} and {{step 6}}'),
    {type:'action',app:'svc:slack',op:'post',fields:{}},
    {type:'review',agentId:'a',prompt:'r',target:4},
    agent('x',{each:'{{step 9}}'}),
    {type:'code',code:''},
    {type:'review',agentId:'a',prompt:'r',target:3}
  ],s=>s.app==='svc:slack');
  assert.match(said[0].join(' '),/earlier step/);
  assert.match(said[1].join(' '),/instructions/);
  assert.match(said[2].join(' '),/word or phrase/);assert.match(said[2].join(' '),/comes later/);
  assert.match(said[3].join(' '),/\{\{item\}\}/);assert.match(said[3].join(' '),/step 06, which comes after/);
  assert.match(said[5].join(' '),/Step 05 would change something again/);
  assert.match(said[6].join(' '),/earlier step/);
  assert.match(said[7].join(' '),/its code/);
  assert.match(said[8].join(' '),/not a resident step/);
  assert.deepEqual(lint([agent('ok'),agent('also {{step 1}}',{parallel:true}),{type:'review',agentId:'a',prompt:'r',target:1}]),[[],['It runs at the same time as step 01, so it cannot read its answer yet.'],[]]);
  assert.deepEqual(lint([agent('ok'),agent('also'),{type:'review',agentId:'a',prompt:'r',target:1}]),[[],[],[]],'a right workflow has nothing to say');
});

test('the layout leaves room above for each review, and columns in order',()=>{
  const a=layout([agent(),agent()]),b=layout([agent(),{type:'review',agentId:'a',prompt:'r',target:1},{type:'review',agentId:'a',prompt:'r',target:1}]);
  assert.ok(b.top>a.top,'reviews get lanes above');
  assert.ok(a.nodes[1].x-a.nodes[0].x===COL);
  const s=layout([agent(),agent('',{parallel:true}),agent('',{parallel:true})]);
  assert.equal(new Set(s.nodes.map(n=>n.x)).size,1,'one column');assert.ok(s.height>a.height);
});
