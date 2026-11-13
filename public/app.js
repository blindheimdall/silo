import './world-3d.js';
import { SECTORS, sectorForLevel } from './world-geometry.js';
import { TEMPLATES, materialize, needName, hasNeed } from './flow-templates.js';
import { applyPatch } from './live-patch.js';
import { localAI, AI_LANGS, langName } from './local-ai.js';
import { MCP_CATALOG, MCP_GROUPS } from './mcp-catalog.js';
import { APP_PACKS, PACK_GROUP_ORDER } from './app-packs.js';
// The connector list: the catalog, with the built-in apps grouped after the gateways.
const PACK_GROUPS=[...new Set([...PACK_GROUP_ORDER,...Object.values(APP_PACKS).map(p=>p.group)])].filter(g=>Object.values(APP_PACKS).some(p=>p.group===g));
const PRESETS={...MCP_CATALOG,...Object.fromEntries(Object.entries(APP_PACKS).map(([id,p])=>['pack:'+id,{group:'pack:'+p.group,label:p.name,transport:'openapi',name:p.name,builtin:id,base:p.base,auth:p.auth.kind,authName:p.auth.name||'',note:`Built in, ${p.ops.length} operation${p.ops.length===1?'':'s'}:${p.ops.map(o=>o[2].replace(/_/g,' ')).join(', ')}. Key: ${p.key}`}]))};
const PRESET_GROUPS=MCP_GROUPS.flatMap(g=>g[0]==='gateway'?[g,...PACK_GROUPS.map(n=>['pack:'+n,'Apps: '+n])]:[g]);
import { defaultCameras, cameraLabel, cameraTitle, canMoveLevel, steer, FeedWall } from './surveillance.js';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icons={security:'<path d="M3 7l12 3-1.6 5L1.4 12zM13.4 15l1.6 4h6M6 13.5L5 19H2"/><circle cx="6" cy="10" r=".8"/>',silo:'<rect x="5" y="3" width="14" height="18" rx="4"/><path d="M5 9h14M5 15h14M12 3v18"/>',agents:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0112 0v3M17 5a3 3 0 010 6m1 4a5 5 0 013 5"/>',workflows:'<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><path d="M9 6h6a3 3 0 013 3v6M6 9v9h9"/>',connections:'<path d="M9 8L7 6a4 4 0 00-6 6l5 5a4 4 0 006 0l2-2M15 16l2 2a4 4 0 006-6l-5-5a4 4 0 00-6 0l-2 2M8 16l8-8"/>',activity:'<path d="M2 12h5l3-8 4 16 3-8h5"/>',files:'<path d="M3 6h7l2 3h9v12H3zM3 9V4h7l2 2h9v3"/>',settings:'<circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10l2 2M5 19l2-2M17 7l2-2"/>',plus:'<path d="M12 5v14M5 12h14"/>',play:'<path d="M8 4l12 8-12 8z"/>',pause:'<path d="M8 5v14M16 5v14"/>',arrow:'<path d="M4 12h16m-6-6l6 6-6 6"/>',grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',layers:'<path d="M3 7l9-5 9 5-9 5zM3 12l9 5 9-5M3 17l9 5 9-5"/>',check:'<path d="M5 12l4 4L20 5"/>',chat:'<path d="M4 3h16v14H9l-5 4zM8 8h8M8 12h5"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>',terminal:'<path d="M4 5h16v15H4zM7 9l3 3-3 3m5 0h5"/>',download:'<path d="M12 3v12m-5-5l5 5 5-5M4 16v5h16v-5"/>',edit:'<path d="M4 16L16 4l4 4L8 20H4zM13 7l4 4"/>',close:'<path d="M6 6l12 12M6 18L18 6"/>',spark:'<path d="M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3z"/>'};
const icon=name=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]||icons.silo}</svg>`;
const navItems=[['silo','The Silo'],['agents','Residents'],['workflows','Workflows'],['connections','IT / Uplink'],['security','Security'],['activity','Signals'],['files','Archive'],['settings','System']];
let cams=null,mainCam=0,feedWall=null,trackId=null,shownView='silo';
let me=null,accounts=false,booted=false;
let state,token,view='silo',selected,world,worldTab='silo',filter='',floorFilter='',modalKind='',polling=false,currentFloor=0,currentLevel=4,residentOpen=false;
const modal=$('#modal');
async function api(url,options={},retry=true){const response=await fetch('/api'+url,{...options,headers:{'Content-Type':'application/json','x-silo-token':token,...options.headers},body:options.body===undefined?undefined:JSON.stringify(options.body)});const data=await response.json().catch(()=>({}));if(response.status===401&&data.error==='Sign in first.'){showLogin();throw new Error('Sign in to go on.');}if(response.status===401&&retry&&url!=='/session'){const session=await api('/session',{},false);token=session.token;return api(url,options,false);}if(!response.ok)throw new Error(data.error||'Request failed.');return data;}
const post=(url,body)=>api(url,{method:'POST',body});
function toast(text,error=false){const el=document.createElement('div');el.className='toast'+(error?' error':'');el.textContent=text;$('#toasts').append(el);setTimeout(()=>el.remove(),6000);}
function age(t){const s=Math.max(0,Math.round((Date.now()-t)/1000));return s<60?'just now':s<3600?Math.floor(s/60)+'m ago':s<86400?Math.floor(s/3600)+'h ago':new Date(t).toLocaleDateString();}
function getAgent(agentId){return state.agents.find(a=>a.id===agentId);}
function selectedAgent(){return getAgent(selected)||state.agents[0];}
function button(label,action,primary=false,attrs=''){return `<button class="btn${primary?' primary':''}" data-action="${action}" ${attrs}>${label}</button>`;}
function heading(title,desc,actions='',eyebrow='SILO 18'){return `<div class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${desc}</p></div><div class="heading-actions">${actions}</div></div>`;}
// Moving between terminals cross-fades (View Transitions) where the browser can, and not with reduced motion.
function navigate(next){if(!navItems.some(([id])=>id===next))next='silo';const go=()=>{view=next;location.hash=next;render();};if(document.startViewTransition&&next!==view&&!matchMedia('(prefers-reduced-motion: reduce)').matches)document.startViewTransition(go);else go();}
function render(){
  // Before sign-in there is no state yet; the page renders once it arrives.
  if(!state)return;
  $('#crumb').textContent=navItems.find(([id])=>id===view)[1];
  const dockLabels={silo:'WORLD',agents:'RESIDENTS',workflows:'FLOWS',connections:'IT',security:'CAMERAS',activity:'SIGNALS',files:'ARCHIVE',settings:'SYSTEM'};
  $('#nav').innerHTML=navItems.map(([id,label],i)=>`<button class="nav-item${view===id?' active':''}" data-action="nav" data-view="${id}" aria-label="${label}" title="${label} (Alt+${i+1})"><b class="fkey" aria-hidden="true">${i+1}</b>${icon(id)}<span>${dockLabels[id]}</span></button>`).join('');if(state)syncBadges();
  const isWorld=view==='silo';$('#terminal-screen').hidden=isWorld;if(world)world.background=!isWorld;$('.silo-universe').classList.toggle('terminal-open',!isWorld);$('#agent-panel').hidden=!isWorld||!residentOpen;
  const renderers={agents:renderAgents,workflows:renderWorkflows,connections:renderConnections,security:renderSecurity,activity:renderActivity,files:renderFiles,settings:renderSettings};feedWall?.detach();$('#main').innerHTML=isWorld?'':renderers[view]();
  if(!isWorld&&shownView!==view){const ts=$('#terminal-screen');ts.style.animation='none';void ts.offsetHeight;ts.style.animation='';}shownView=view;updateClock();$('#main').scrollTop=0;if(view==='settings')loadSystemInfo();if(view==='connections')loadPhone();if(view==='activity')loadTraces();
  if(!world){world=new SiloWorld($('#world'),{agents:state.agents,floors:state.floors,selected:null,crt:crtPreference(),onSelect:a=>selectAgent(a.id),onTerminal:v=>navigate(v),onLevel:level=>syncLevel(level),onFloor:f=>setFloor(f,false),onZoom:z=>{$('#zoom-label').textContent=typeof z==='number'?z+'%':z;}});syncCrt();$('#world').addEventListener('keydown',e=>{if(['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','PageDown','PageUp','Home','End','0','+','=','-'].includes(e.key))e.preventDefault();if(e.key==='Escape')world.release?.();if(e.key==='ArrowLeft')world.rotateBy?.(-.22);if(e.key==='ArrowRight')world.rotateBy?.(.22);if(e.key==='+'||e.key==='=')zoomWorld(1.2);if(e.key==='-')zoomWorld(1/1.2);if(e.key==='0')world.overview();if(e.key==='ArrowDown')world.focusLevel(Math.min(144,currentLevel+1));if(e.key==='ArrowUp')world.focusLevel(Math.max(1,currentLevel-1));if(e.key==='PageDown')world.focusLevel(Math.min(144,currentLevel+12));if(e.key==='PageUp')world.focusLevel(Math.max(1,currentLevel-12));if(e.key==='Home')world.focusLevel(1);if(e.key==='End')world.focusLevel(144);});}
  if(world)world.background=!isWorld;
  if(view==='security'&&world?.captureFeed&&!$('#feed-main'))$('#main').innerHTML=renderSecurity();
  world.update(state.agents,residentOpen?selected:null,state.paused);syncWorldSignals();if(residentOpen)$('#agent-panel').innerHTML=agentPanel();
  $('#sector-markers').innerHTML=state.floors.map(f=>`<button class="sector-marker ${f.id===currentFloor?'active':''}" data-action="focus-floor" data-floor="${f.id}" aria-label="Enter ${esc(f.name)}"><span class="sector-name">${esc(f.name).toUpperCase()}</span>${String(f.id+1).padStart(2,'0')}</button>`).join('');
  bindView();syncStatus();
}
// Councils walk in the world, work turns the generator, and a failed workflow sounds the alarm.
let alarmSeen;
function syncOpenPanels(){
  if(modal.open&&modalKind==='tests'&&$('#eval-report')){const o=suiteOf(openTestsKind,openTestsId);if(o){const html=evalReport(o);if($('#eval-report').dataset.html!==html){$('#eval-report').innerHTML=html;$('#eval-report').dataset.html=html;}const cb=candidateBox(o),slot=$('#candidate-slot');if(slot&&slot.dataset.html!==cb){slot.innerHTML=cb;slot.dataset.html=cb;}}}
}
function syncWorldSignals(){
  syncOpenPanels();
  world?.setMeetings?.(state.meetings||[]);world?.setPulse?.(state.pulse);world?.setActivity?.(state.activity||{});refreshTrail();
  const t=state.pulse?.alarm?.time||0;
  if(alarmSeen!==undefined&&t&&t!==alarmSeen){
    document.body.classList.remove('siren');void document.body.offsetWidth;document.body.classList.add('siren');setTimeout(()=>document.body.classList.remove('siren'),9000);
    playSiren();toast(state.pulse.alarm.title+'. The alarm sounded.',true);
  }
  alarmSeen=t;
}
const soundOn=()=>{try{return localStorage.getItem('silo-sound')!=='off';}catch{return true;}};
function playSiren(){
  if(!soundOn())return;
  try{
    const ctx=new (window.AudioContext||window.webkitAudioContext)(),o=ctx.createOscillator(),g=ctx.createGain(),now=ctx.currentTime;
    o.type='sawtooth';o.connect(g);g.connect(ctx.destination);g.gain.setValueAtTime(.0001,now);g.gain.exponentialRampToValueAtTime(.08,now+.15);
    for(let i=0;i<6;i++){o.frequency.setValueAtTime(440,now+i*.5);o.frequency.linearRampToValueAtTime(660,now+i*.5+.45);}
    g.gain.exponentialRampToValueAtTime(.0001,now+3.1);o.start(now);o.stop(now+3.2);o.onended=()=>ctx.close();
  }catch{}
}
function zoomWorld(f){if(!world)return;if(world.zoomBy)world.zoomBy(f);else world.setZoom(world.zoom*f);}
function crtPreference(){try{return localStorage.getItem('silo-crt')!=='off';}catch{return true;}}
function syncCrt(){const on=world?.crt!==undefined?!!world.crt:crtPreference(),b=$('#crt-toggle');if(b){b.setAttribute('aria-pressed',String(on));b.title=on?'Turn the CRT screen effect off':'Turn the CRT screen effect on';}}
function syncLevel(level){currentLevel=level;$('#depth-range').value=level;if(document.activeElement!==$('#jump-level'))$('#jump-level').value=level;const f=sectorForLevel(level);if(state?.floors[f]){$('#floor-readout').textContent='L'+String(level).padStart(3,'0')+' / '+state.floors[f].name.toUpperCase();}}
function setFloor(f,focus=true){currentFloor=f;const floor=state.floors[f];$('#floor-readout').textContent='L'+String(currentLevel).padStart(3,'0')+' / '+floor.name.toUpperCase();$('#floor-role').textContent=floor.role.toUpperCase();$$('.sector-marker').forEach((el,i)=>el.classList.toggle('active',i===f));if(focus)world?.focus(f);$('.world-intro').classList.add('dim');}
const seenProposals=new Set();let proposalsPrimed=false;
function syncBadges(){
  const list=pending(),btn=document.querySelector('.nav-item[data-view="files"]');
  if(btn){let b=btn.querySelector('.nav-badge');if(list.length){if(!b){b=document.createElement('i');b.className='nav-badge';btn.appendChild(b);}b.textContent=list.length;}else b?.remove();}
  const reqs=pendingRequests(),sig=document.querySelector('.nav-item[data-view="activity"]');
  if(sig){let b=sig.querySelector('.nav-badge');if(reqs.length){if(!b){b=document.createElement('i');b.className='nav-badge';sig.appendChild(b);}b.textContent=reqs.length;}else b?.remove();}
  for(const r of reqs)if(!seenProposals.has(r.id)){seenProposals.add(r.id);if(proposalsPrimed)toast(`${r.agentName} asks to ${r.title}. Allow or deny it in Signals.`);}
  for(const p of list)if(!seenProposals.has(p.id)){seenProposals.add(p.id);if(proposalsPrimed)toast(`${p.agentName} proposed ${p.name}. Review it in the Archive.`);}
  proposalsPrimed=true;
}
function syncStatus(){syncBadges();$('#bottom-status').textContent=(state.paused?'WORLD PAUSED / ACTIVE REQUESTS MAY FINISH':state.agents.some(a=>a.status==='working')?'MISSIONS IN PROGRESS / RESIDENTS AT WORK':'LOCAL UPLINK ESTABLISHED / DEMO RESIDENTS').toUpperCase();$('#server-state').textContent=state.paused?'WORLD PAUSED':'LOCAL UPLINK';$('#population').textContent=state.agents.length+' RESIDENTS';$('#pause-world').innerHTML=icon(state.paused?'play':'pause');$('#pause-world').title=state.paused?'Resume silo':'Pause silo';}
const PERM_LABELS={read_files:'files',write_files:'proposals',web:'web',memory:'notes',run_code:'sandbox',delegate:'council',browser:'browser',desktop:'desktop apps',google:'Google',microsoft:'Microsoft 365',slack:'Slack',github:'GitHub',notion:'Notion'};
function permLabel(t,upper=false){const l=PERM_LABELS[t]||(t.startsWith('mcp:')?state?.mcp?.find(c=>'mcp:'+c.id===t)?.name||'connector':t);return upper?l.toUpperCase():l;}
function agentPanel(){const a=selectedAgent();if(!a)return '<div class="empty">No residents yet.</div>';const f=state.floors[a.floor],st=a.stats||{},sh=getAgent(a.shadowId);const bad=(st.fail||0)+(st.rejected||0);const drillBadge=a.lastDrill?(a.lastDrill.ok?' · <span class="tag-ok">DRILL PASSED</span>':' · <span class="tag-warn">DRILL BREACH</span>'):'';return `<div class="panel-title">Resident profile <span class="panel-title-end"><small>L${String(a.level||SECTORS[a.floor].home).padStart(3,'0')}</small><button class="resident-close" data-action="close-resident" aria-label="Close resident profile" title="Close (Esc)">×</button></span></div><div class="agent-profile"><div class="agent-identity"><div class="pixel-avatar">${pixelAvatar(a)}</div><div><h3>${esc(a.name)}</h3><p>${esc(a.role)}</p><div class="agent-status">${activityBadge(a)}${bad?` · <span class="tag-warn">${bad} FLAGGED</span>`:''}${drillBadge}</div>${activityDetail(a)}</div></div><div class="agent-meta"><div><div class="meta-label">HOME FLOOR</div><div class="meta-value">L${String(a.level||SECTORS[a.floor].home).padStart(3,'0')} / ${esc(f.name)}</div></div><div><div class="meta-label">INTELLIGENCE</div><div class="meta-value">${a.provider==='demo'?'Demo resident, no model':esc(a.provider)+', live model'}${sh?' · Shadow: '+esc(sh.name):''}</div></div><div><div class="meta-label">MISSIONS</div><div class="meta-value">${a.chats.filter(m=>m.role==='assistant'&&!m.error).length} completed${st.cleaned?' · '+st.cleaned+'× cleaned':''}</div></div><div><div class="meta-label">PERMISSIONS</div><div class="meta-value">${a.tools.length?esc(a.tools.map(t=>permLabel(t)).join(' / ')):'Conversation only'}${a.memory?.length?' / '+a.memory.length+' notes':''}${a.whispers?.length?' / '+a.whispers.length+' whispers':''}</div></div></div></div>${browserBox(a)}<p class="agent-description"><span class="mini-caption">INSTRUCTIONS</span>${esc(a.instructions.slice(0,155))}${a.instructions.length>155?'...':''}</p><div class="agent-panel-actions">${button(icon('chat')+'Talk to '+esc(a.name),'chat',true,`data-id="${a.id}"`)}${button(icon('security'),'watch-agent',false,`data-id="${a.id}" aria-label="Watch on camera" title="Watch on camera"`)}${button('Letter','send-letter',false,`data-id="${a.id}" title="Dispatch a Porter on the stairs with a letter to ${esc(a.name)}"`)}${button('Drill','run-drill',false,`data-id="${a.id}" title="Run a Judicial compliance drill on ${esc(a.name)}"`)}${button('Clean','send-clean',false,`data-id="${a.id}" title="Send to clean the surface sensor and reset errors"`)}${button(icon('settings'),'edit-agent',false,`data-id="${a.id}" aria-label="Agent settings"`)}</div><div class="agent-residents"><div class="resident-caption"><span>NEARBY RESIDENTS</span><span>${state.agents.length} TOTAL</span></div><div class="resident-list">${nearby(a).map(x=>`<button class="resident" data-action="select-agent" data-id="${x.id}"><span class="tiny-avatar">${pixelAvatar(x)}</span>${esc(x.name)}<small>L${String(x.level||SECTORS[x.floor].home).padStart(3,'0')}</small><span class="dot ${x.status==='working'?'':'green'}"></span></button>`).join('')}</div></div>`;}
function nearby(a){const level=a.level||SECTORS[a.floor].home;return state.agents.filter(x=>x.id!==a.id).map(x=>({x,d:Math.abs((x.level||SECTORS[x.floor].home)-level)})).sort((p,q)=>p.d-q.d).slice(0,4).map(p=>p.x);}
function eventRow(e){return `<div class="activity-row"><span class="event-icon">${icon(e.type==='success'?'check':e.type==='workflow'?'workflows':e.type==='file'?'files':e.type==='error'?'close':e.type==='mission'?'chat':'activity')}</span><div><strong>${esc(e.title)}</strong><p>${esc(e.detail)}</p></div><time title="${esc(new Date(e.time).toLocaleString())}">${age(e.time)}</time></div>`;}
function agentCard(a){return `<article class="agent-card"><div class="agent-identity"><div class="pixel-avatar">${pixelAvatar(a)}</div><div><h3>${esc(a.name)}</h3><p>${esc(a.role)}</p></div></div><span class="floor-badge">L${String(a.level||SECTORS[a.floor].home).padStart(3,'0')} / ${esc(state.floors[a.floor].name).toUpperCase()}</span><p>${esc(a.instructions.slice(0,130))}</p><div class="agent-card-footer"><span class="provider-badge">${esc(a.provider)}</span><button class="btn small" data-action="edit-agent" data-id="${a.id}" aria-label="Edit ${esc(a.name)}">${icon('settings')}</button><button class="btn small" data-action="locate-agent" data-id="${a.id}" aria-label="Locate ${esc(a.name)}">${icon('silo')}</button><button class="btn small" data-action="watch-agent" data-id="${a.id}" aria-label="Watch ${esc(a.name)} on camera" title="Watch on camera">${icon('security')}</button><button class="btn small" data-action="agent-tests" data-id="${a.id}" aria-label="Tests of ${esc(a.name)}" title="Tests${a.candidate?': a change is held':a.evalWorse?': got worse':a.evals?.length?': '+(lastReport(a)?.score??''):''}">${icon('check')}${a.candidate||a.evalWorse?'<i class="test-dot"></i>':''}</button><button class="btn small" data-action="chat" data-id="${a.id}">${icon('chat')} Talk</button></div></article>`;}
function filteredAgents(){return state.agents.filter(a=>(!floorFilter||a.floor===Number(floorFilter))&&(a.name+' '+a.role+' '+a.provider+' '+String(a.level).padStart(3,'0')).toLowerCase().includes(filter.toLowerCase()));}
// The registry draws residents in pages, so 432 cards never land in the page at once.
const PAGE=48;let agentLimit=PAGE;
function agentGrid(){const list=filteredAgents(),shown=list.slice(0,agentLimit),left=list.length-shown.length;return (shown.map(agentCard).join('')||'<div class="empty">No residents found.</div>')+(left>0?`<div class="grid-more">${button('Show '+Math.min(PAGE,left)+' more / '+left+' left','more-agents')}</div>`:'');}
function renderAgents(){return heading('Residents',`${state.agents.length} residents on 144 levels. Locate moves the camera to a resident's gallery.`,button(icon('plus')+'New resident','new-agent',true),'REGISTRY')+`<div class="directory-toolbar"><input class="field" id="agent-search" type="search" placeholder="Name, role, provider or level" value="${esc(filter)}" aria-label="Search agents"><select class="select" id="floor-filter" aria-label="Filter floor"><option value="">All sectors</option>${state.floors.map(f=>`<option value="${f.id}" ${floorFilter===String(f.id)?'selected':''}>${esc(f.name)}</option>`).join('')}</select></div><div class="agent-grid" id="agent-grid">${agentGrid()}</div>`;}
function goalHistory(){
  const list=state.goals||[];if(!list.length)return '';
  return `<h2 class="section-title">Autonomous goals (Verify & Replan) <small>${list.length}</small></h2><div class="section-card">${list.slice(0,12).map(g=>{
    const v=g.verification,badge=g.status==='completed'?'<span class="tag-ok">VERIFIED '+(v?v.passedCount+'/'+v.totalCount:'')+'</span>':g.status==='running'?`<span class="tag-warn">${esc((g.phase||'running').toUpperCase())} · ITER ${g.currentIteration||1}/${g.maxIterations||3}</span>`:`<span class="tag-warn">${esc(g.status.toUpperCase())}${v?' · '+v.passedCount+'/'+v.totalCount:''}</span>`;
    return `<div class="activity-row"><span class="event-icon">${icon('spark')}</span><div><strong>${esc(g.title)} · ${badge}</strong><p>${esc(g.objective.slice(0,140))}${g.error?' · '+esc(g.error.slice(0,120)):''}</p></div><time>${age(g.started)}</time><div>${g.status==='running'?`<button class="btn small danger" data-action="stop-goal" data-id="${g.id}">Stop</button>`:`<button class="btn small" data-action="verify-goal" data-id="${g.id}">Verify</button>`}</div></div>`;
  }).join('')}</div>`;
}
function openGoalEditor(){
  const a0=state.agents.find(a=>a.provider!=='demo')||state.agents[0];
  showModal(`${modalHead('New autonomous goal','Objective → Plan → Execute → Independent Verification → Replan until every criterion holds.')}<form id="goal-form"><div class="modal-body"><div class="form-grid"><div class="form-group"><label for="g-title">Goal title</label><input class="field" id="g-title" name="title" required maxlength="120" placeholder="e.g. Verified turbine maintenance spec"></div><div class="form-group"><label for="g-max">Max replan iterations (1-6)</label><input class="field" id="g-max" name="maxIterations" type="number" min="1" max="6" value="3" required></div><div class="form-group"><label for="g-planner">Planner resident</label><select class="select" id="g-planner" name="plannerId">${agentOptions(a0?.id)}</select></div><div class="form-group"><label for="g-exec">Executor resident</label><select class="select" id="g-exec" name="executorId">${agentOptions(a0?.id)}</select></div></div><div class="form-group"><label for="g-obj">Objective</label><textarea class="field" id="g-obj" name="objective" rows="3" required maxlength="15000" placeholder="What must be achieved and delivered?"></textarea></div><div class="form-group"><label for="g-crit">Verifiable acceptance criteria (one per line: file_exists: path, file_contains: path | text, output_contains: text, output_regex: pattern)</label><textarea class="field" id="g-crit" rows="3" required spellcheck="false" placeholder="file_exists: notes/spec.md&#10;file_contains: notes/spec.md | Rollback&#10;output_contains: VERIFIED"></textarea><small>An agent claiming "done" is never enough: the server verifies every criterion above and replans automatically if any check fails.</small></div><label class="check-label"><input type="checkbox" id="g-autosave" checked><span>Auto-save file proposals created by this goal so file criteria can be verified on disk</span></label>${errEl()}</div><div class="modal-footer"><button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn primary">${icon('spark')} Launch autonomous goal</button></div></form>`,'goal');
  $('#goal-form').onsubmit=async e=>{
    e.preventDefault();const submit=e.currentTarget.querySelector('[type=submit]');submit.disabled=true;
    try{
      const criteria=$('#g-crit').value.split('\n').map(l=>l.trim()).filter(Boolean).map((l,i)=>{
        const m=l.match(/^(file_exists|file_contains|file_regex|output_contains|output_regex)\s*:\s*(.+)$/i);
        if(!m)return {type:'output_contains',text:l,label:'Contains '+l.slice(0,40)};
        const type=m[1].toLowerCase(),rest=m[2].trim();
        if(type==='file_exists')return {type,file:rest,label:'File '+rest};
        if(type==='file_contains'){const [file,...t]=rest.split('|');return {type,file:file.trim(),text:t.join('|').trim()||'OK',label:`${file.trim()} contains text`};}
        if(type==='file_regex'){const [file,...p]=rest.split('|');return {type,file:file.trim(),pattern:p.join('|').trim()||'.+',label:`${file.trim()} matches regex`};}
        if(type==='output_regex')return {type,pattern:rest,label:'Matches /'+rest+'/'};
        return {type:'output_contains',text:rest,label:'Contains '+rest.slice(0,40)};
      });
      await post('/goals',{title:$('#g-title').value,objective:$('#g-obj').value,plannerId:$('#g-planner').value,executorIds:[$('#g-exec').value],maxIterations:Number($('#g-max').value)||3,autoApproveProposals:$('#g-autosave').checked,criteria});
      await refresh();modal.close();render();toast('Autonomous goal launched.');
    }catch(err){$('#form-error').textContent=err.message;}finally{submit.disabled=false;}
  };
}
function renderWorkflows(){return heading('Workflows','Residents do the work step by step. Reviews check it, approvals wait for you.',button(icon('files')+'The Order','templates')+button(icon('spark')+'New goal','new-goal')+button(icon('plus')+'New workflow','new-workflow',true),'FLOWS')+`<div class="info-banner">${icon('workflows')}<span><strong>How it works.</strong> Steps run in order. Steps marked same time run together and the next step gets all their answers. A resident gets the brief and the output of the step before, or exactly what you ask for with {{brief}}, {{previous}}, {{step 2}} or {{file notes.md}}. A step can be set to run only when an earlier answer says something. App steps call an app directly, with no model, and can repeat for each item of a list. Wait steps pause the run. Reviews can send work back, approvals wait for you. Schedules, webhooks and watched folders only work while this server is running.</span></div><div class="list-layout">${state.workflows.map(w=>`<article class="workflow-card" data-flow="${w.id}"><div class="workflow-card-head"><div><h3>${esc(w.name)}</h3><p>${esc(w.description)}</p></div><div class="trigger-badges">${triggerBadges(w).map(b=>`<span class="provider-badge">${esc(b)}</span>`).join('')}</div></div><div class="flow-nodes">${flowNodes(w.steps)}</div>${queueLine(w)}<div class="workflow-bottom"><span class="schedule-label">${icon('clock')} ${w.enabled&&w.nextRun?'Next: '+new Date(w.nextRun).toLocaleString([],{weekday:'short',hour:'2-digit',minute:'2-digit'}):'Manual run'}${w.version>1?' · V'+w.version:''}${testBadge(w)}</span>${button('Tests','workflow-tests',false,`data-id="${w.id}"`)}${w.versions?.length?button('Versions','workflow-versions',false,`data-id="${w.id}"`):''}${button('Share','share-workflow',false,`data-id="${w.id}"`)}${button(icon('silo')+'Show in silo','trail-flow',false,`data-id="${w.id}"`)}${button('Edit workflow','edit-workflow',false,`data-id="${w.id}"`)}${button(icon('play')+'Run workflow','run-workflow',true,`data-id="${w.id}"`)}</div></article>`).join('')||'<div class="empty">No workflows yet. Start from a template or build your own.</div>'}</div><div id="goal-history">${goalHistory()}</div><h2 class="section-title">Run history</h2><div id="run-history">${runHistory()}</div>`;}
const pad2=n=>String(n).padStart(2,'0');
// Tests belong to a workflow or a resident. kind is 'workflow' or 'agent'.
const suiteOf=(kind,id)=>(kind==='agent'?state.agents:state.workflows).find(x=>x.id===id);
const suitePath=(kind,id)=>(kind==='agent'?'/agents/':'/workflows/')+id;
const lastReport=o=>(o.evals||[]).find(e=>!e.candidate&&!e.purpose)||o.evals?.[0];
const CANDIDATE_WORD={testing:'BEING TESTED',worse:'HELD: GOT WORSE',passed:'PASSED, WAITING FOR YOU',error:'HELD: TESTS DID NOT FINISH'};
function testBadge(w){
  if(w.candidate)return ` · <span class="tag-warn">CHANGE ${CANDIDATE_WORD[w.candidate.status]||'HELD'}</span>`;
  const e=lastReport(w);if(!e)return '';
  if(e.status==='running'||e.status==='waiting')return ' · <span class="tag-warn">TESTING</span>';
  const score=typeof e.score==='number'?' · '+e.score:'';
  if(e.worse)return ` · <span class="tag-warn">GOT WORSE ${e.passed}/${e.total}${score}</span>`;
  return ` · <span class="${e.passed===e.total?'tag-ok':'tag-warn'}">TESTS ${e.passed}/${e.total}${score}</span>`;
}
// Checks are written one per line as "op: text", or "op x3: text" to count three times in the score.
const CHECK_OPS=['contains','missing','regex','field','judge','maxcost','maxms','maxtokens'];
const checkLines=checks=>(checks||[]).map(c=>c.op+(c.weight>1?' x'+c.weight:'')+': '+c.text).join('\n');
function parseChecks(text){return text.split('\n').map(l=>l.trim()).filter(Boolean).map(l=>{const m=l.match(/^([a-z]+)(?:\s*[x×*]\s*([1-5]))?\s*:\s*(.+)$/i);return m&&CHECK_OPS.includes(m[1].toLowerCase())?{op:m[1].toLowerCase(),text:m[3].trim(),...(m[2]&&Number(m[2])>1&&{weight:Number(m[2])})}:{op:'contains',text:l};});}
function testEditor(t,i,kind=openTestsKind){
  const agent=kind==='agent';
  return `<div class="flow-step-editor test-case" data-id="${esc(t.id||'')}"${t.learned?' data-learned="1"':''}><div class="step-editor-head"><span class="step-n">${pad2(i+1)}</span><input class="field test-name" maxlength="80" value="${esc(t.name||'')}" placeholder="Name, e.g. Mentions the price" aria-label="Test name">${t.learned?'<span class="tag-warn" title="Made from a run you rejected">LEARNED</span>':''}<button type="button" class="btn small" data-action="remove-test">Remove</button></div><div class="form-group"><label>${agent?'Message to the resident':'Brief for this test'}</label><textarea class="field test-input" rows="3" maxlength="15000" placeholder="${agent?'What you would write to the resident':'The input the workflow gets'}">${esc(t.input||'')}</textarea></div><div class="form-group"><label>Checks on the ${agent?'answer':'final answer'}, one per line</label><textarea class="field test-checks" rows="3" spellcheck="false" placeholder="contains: price&#10;missing: TODO${agent?'':'&#10;field: total=1200'}&#10;judge x3: names the supplier and the due date&#10;maxcost: 0.05">${esc(checkLines(t.checks))}</textarea><small>contains / missing: the answer has, or does not have, this text. regex: it matches the pattern.${agent?'':' field: a field of the result shape has this value.'} judge: a resident scores the answer from 0 to 10 against the requirement and passes it at 7. maxcost (dollars), maxms (seconds), maxtokens: limits for one attempt. Write x2 to x5 after the kind to make a check count more in the score. Case does not matter.</small></div><details class="test-ref"${t.reference?' open':''}><summary>Reference answer${t.reference?'':' (optional)'}</summary><textarea class="field test-reference" rows="4" maxlength="8000" placeholder="An answer you approve. The judge uses it to know what a good answer holds.">${esc(t.reference||'')}</textarea></details></div>`;
}
// Traces: every model call, tool use, question to another resident and wait for your approval, with time and cost.
const fmtMs=ms=>ms==null?'':ms<1000?Math.round(ms)+'ms':ms<60000?(ms/1000).toFixed(1)+'s':Math.floor(ms/60000)+'m '+String(Math.round(ms%60000/1000)).padStart(2,'0')+'s';
const TRACE_KIND={step:'STEP',model:'MODEL',tool:'TOOL',delegate:'ASK',approval:'YOU'};
const TRACE_STATUS={ok:'OK',error:'ERROR',failed:'FAILED',running:'RUNNING',cancelled:'STOPPED',interrupted:'INTERRUPTED',rejected:'REJECTED',denied:'DENIED',expired:'EXPIRED',completed:'OK'};
const traceTone=st=>st==='ok'||st==='completed'?'ok':st==='running'?'run':st==='error'||st==='failed'?'bad':'warn';
function traceTotalsLine(x,ms){
  const parts=[`TIME <b>${fmtMs(ms)}</b>`,`MODEL <b>${fmtMs(x.modelMs)}</b> / ${x.model} CALL${x.model===1?"":"S"}`,`TOOLS <b>${fmtMs(x.toolMs)}</b> / ${x.tool+x.delegate}`];
  if(x.approval)parts.push(`WAITING FOR YOU <b>${fmtMs(x.approvalMs)}</b>`);
  parts.push(`TOKENS <b>${(x.tokens||0).toLocaleString()}</b>`,`COST <b>${usd(x.cost)}</b>`);if(x.errors)parts.push(`<span class="tag-warn">ERRORS ${x.errors}</span>`);
  return `<div class="trace-totals">${parts.map(p=>`<span>${p}</span>`).join('')}</div>`;
}
function traceRows(t){
  const kids=new Map();for(const sp of t.spans){const k=sp.parent||'';if(!kids.has(k))kids.set(k,[]);kids.get(k).push(sp);}
  const t0=t.started,t1=Math.max(t.ended||Date.now(),...t.spans.map(x=>x.end||Date.now())),span=Math.max(1,t1-t0),out=[];
  const walk=(pid,depth)=>{for(const sp of (kids.get(pid)||[]).sort((a,b)=>a.start-b.start)){out.push([sp,depth]);walk(sp.id,depth+1);}};walk('',0);
  // Spans whose parent was dropped still show, at the top level.
  for(const sp of t.spans)if(sp.parent&&!t.spans.some(x=>x.id===sp.parent)&&!out.some(([x])=>x===sp))out.push([sp,0]);
  return out.map(([sp,depth])=>{
    const end=sp.end||Date.now(),left=(sp.start-t0)/span*100,width=Math.max(.4,(end-sp.start)/span*100),tone=traceTone(sp.status);
    const meta=sp.kind==='model'?[sp.tokens?sp.tokens.toLocaleString()+' tok':'',sp.cost?usd(sp.cost):'',sp.toolCalls?sp.toolCalls+' tool call'+(sp.toolCalls>1?'s':''):'',sp.fallback?'fallback':''].filter(Boolean).join(' / '):sp.kind==='approval'?(sp.by?'by '+sp.by:sp.decision||''):sp.target?'to '+sp.target:sp.summary||'';
    const field=(k,v,pre)=>v==null||v===''?'':`<dt>${k}</dt><dd>${pre?`<pre>${esc(v)}</pre>`:esc(v)}</dd>`;
    const arts=(sp.artifacts||[]).map(a=>a.type==='screenshot'?`<a class="trace-shot" href="/api/browser/shots/${esc(a.id)}.jpg" target="_blank" rel="noopener" title="Open the full screenshot"><img src="/api/browser/shots/${esc(a.id)}.jpg" alt="Screenshot: ${esc(a.name||'')}" loading="lazy"></a>`:a.type==='proposal'?`<button type="button" class="btn small" data-action="view-proposal" data-id="${esc(a.id)}">${esc(a.name)}</button>`:esc(a.name)).join(' ');
    return `<details class="trace-row tone-${tone} kind-${sp.kind}"><summary><span class="trace-kind">${TRACE_KIND[sp.kind]||sp.kind.toUpperCase()}</span><span class="trace-name" style="padding-left:${Math.min(depth,6)*12}px">${esc(sp.name)}</span><span class="trace-bar"><i style="left:${left.toFixed(2)}%;width:${Math.min(width,100-left).toFixed(2)}%"></i></span><span class="trace-ms">${sp.status==='running'?'...':fmtMs(sp.ms)}</span><span class="trace-meta">${esc(meta)}</span></summary><dl class="trace-detail">${field('Status',TRACE_STATUS[sp.status]||sp.status)}${field('Resident',sp.agent)}${field('Provider and model',sp.provider?sp.provider+(sp.model?' / '+sp.model:''):'')}${sp.kind==='model'?field('Tokens in / out',`${sp.input||0} / ${sp.output||0}`)+field('Messages sent',sp.messages):''}${field('Arguments',sp.args,true)}${field('Result',sp.result,true)}${field('Error',sp.error)}${field('Decision',sp.decision)}${field('Decided by',sp.by)}${arts?`<dt>Produced</dt><dd>${arts}</dd>`:''}${field('Started',new Date(sp.start).toLocaleTimeString())}</dl></details>`;
  }).join('');
}
function traceBody(t){
  const x=t.totals||{};
  return `${traceTotalsLine(x,(t.ended||Date.now())-t.started)}${t.error?`<p class="modal-error">${esc(t.error)}</p>`:''}<div class="trace-legend"><span class="kind-step">STEP</span><span class="kind-model">MODEL</span><span class="kind-tool">TOOL</span><span class="kind-delegate">ASK A RESIDENT</span><span class="kind-approval">WAITING FOR YOU</span><small>Click a line for its details. Secrets in arguments are hidden.</small></div><div class="trace-rows">${traceRows(t)||'<div class="empty small">Nothing was recorded in this trace.</div>'}</div>${t.dropped?`<p class="mono-line">${t.dropped} more spans were not kept.</p>`:''}`;
}
let openTraceId=null,traceTimer=null;
async function openTrace(id){
  if(!id){toast('This was recorded before traces existed.',true);return;}
  let t;try{t=await api('/traces/'+id);}catch(e){toast(e.message,true);return;}
  openTraceId=id;clearTimeout(traceTimer);
  showModal(`${modalHead(esc(t.name),`${{run:'Workflow run',chat:'Conversation',goal:'Goal'}[t.kind]||'Trace'} / ${new Date(t.started).toLocaleString()} / <span class="tag-${traceTone(t.status)==='ok'?'ok':'warn'}" id="trace-status">${TRACE_STATUS[t.status]||t.status}</span>`)}<div class="modal-body" id="trace-body">${traceBody(t)}</div><div class="modal-footer"><button class="btn" data-action="trail-trace" data-id="${id}">${icon('silo')} Show in silo</button><button class="btn" data-action="close-modal">Close</button></div>`,'trace-view');
  // A running trace refreshes itself, keeping open lines open.
  const tick=async()=>{
    if(openTraceId!==id||!$('#trace-body'))return;
    try{const n=await api('/traces/'+id);const open=new Set($$('#trace-body details[open]').map(d=>[...$$('#trace-body details')].indexOf(d)));$('#trace-body').innerHTML=traceBody(n);const all=$$('#trace-body details');open.forEach(i=>all[i]&&(all[i].open=true));$('#trace-status').textContent=TRACE_STATUS[n.status]||n.status;if(n.status==='running')traceTimer=setTimeout(tick,1500);}catch{}
  };
  if(t.status==='running')traceTimer=setTimeout(tick,1500);
}
async function loadTraces(){
  const box=$('#trace-list');if(!box)return;
  let list;try{list=(await api('/traces')).traces;}catch(e){box.innerHTML=`<p class="modal-error">${esc(e.message)}</p>`;return;}
  if(view!=='activity'||!$('#trace-list'))return;
  box.innerHTML=list.length?list.slice(0,20).map(t=>{const x=t.totals||{};return `<div class="activity-row trace-item"><span class="event-icon">${icon(t.status==='running'?'activity':traceTone(t.status)==='ok'?'check':'close')}</span><div><strong>${esc(t.name)}</strong><p>${{run:'workflow',chat:'conversation',goal:'goal'}[t.kind]||t.kind} · ${TRACE_STATUS[t.status]||t.status} · ${fmtMs(t.ms??Date.now()-t.started)} · ${x.model||0} model call${x.model===1?"":"s"} · ${(x.tool||0)+(x.delegate||0)} tool${(x.tool||0)+(x.delegate||0)===1?"":"s"}${x.approval?' · '+fmtMs(x.approvalMs)+' waiting for you':''} · ${(x.tokens||0).toLocaleString()} tokens · ${usd(x.cost)}${x.errors?' · '+x.errors+' errors':''}</p></div><time>${age(t.started)}</time><button class="btn small" data-action="open-trace" data-id="${t.id}">Open</button></div>`;}).join(''):'<div class="empty small">No traces yet. Talk to a resident or run a workflow.</div>';
}
function evalTrend(list){
  const done=list.filter(e=>e.status==='done'&&(e.model||'as set')==='as set'&&(!e.candidate||e.candidate==='applied')).slice(0,12).reverse();if(done.length<2)return '';
  const pct=e=>typeof e.score==='number'?e.score:e.passed/Math.max(1,e.total)*100;
  return `<div class="eval-trend" aria-label="Score over the last ${done.length} test runs">${done.map(e=>`<span class="${e.passed===e.total?'ok':e.worse?'bad':'mid'}" style="height:${Math.max(8,Math.round(pct(e)/100*34))}px" title="${esc(new Date(e.time).toLocaleString())} · version ${e.version} · ${e.passed} of ${e.total}${typeof e.score==='number'?' · score '+e.score:''}"></span>`).join('')}<small>last ${done.length} runs, oldest first</small></div>`;
}
function evalCompare(list){
  const g=list.find(e=>e.group)?.group;if(!g)return '';
  const rows=list.filter(e=>e.group===g).reverse();
  return `<p class="meta-label">LAST MODEL COMPARISON</p><table class="eval-compare"><thead><tr><th>MODEL</th><th>PASSED</th><th>SCORE</th><th>COST</th><th>TIME</th><th>TOKENS</th></tr></thead><tbody>${rows.map(e=>`<tr><td>${esc(e.model)}</td><td>${e.status==='waiting'?'waiting':e.status==='running'?`running ${e.results.length} of ${e.total}`:`${e.passed} of ${e.total}`}</td><td>${typeof e.score==='number'?e.score:''}</td><td>${e.status==='done'?usd((e.cost||0)):''}</td><td>${e.ms!=null?fmtMs(e.ms):''}</td><td>${e.results.length?e.results.reduce((n,r)=>n+(r.tokens||0),0).toLocaleString():''}</td></tr>`).join('')}</tbody></table>`;
}
const CASE_WORD={broke:'BROKE',worse:'WORSE',flaky:'FLAKY',new:'NEW',better:'BETTER',fixed:'FIXED',same:'SAME'};
const CASE_TONE={broke:'tag-warn',worse:'tag-warn',flaky:'tag-warn',better:'tag-ok',fixed:'tag-ok'};
function judgeTrustText(a){
  const c=a?.judgeCal||{},n=(c.agree||0)+(c.disagree||0);if(!n)return '';
  return n<5?`agreed with you ${c.agree||0} of ${n}`:(c.agree||0)/n>=.8?`agrees with you ${Math.round((c.agree||0)/n*100)}% (${n} checked)`:`UNRELIABLE: agrees with you ${Math.round((c.agree||0)/n*100)}% (${n} checked)`;
}
function evalHead(e){
  const c=e.compare,parts=[new Date(e.time).toLocaleString([],{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}),'VERSION '+e.version];
  if(e.model&&e.model!=='as set')parts.push(esc(e.model.toUpperCase()));
  if(e.candidate)parts.push(`<span class="tag-warn">HELD CHANGE${e.candidate==='applied'?', APPLIED':e.candidate==='rejected'?', REJECTED':''}</span>`);
  if(e.purpose==='baseline')parts.push('BEFORE THE CHANGE');
  if(e.trigger==='change')parts.push('AFTER A CHANGE'+(e.cause?.name?' TO '+esc(e.cause.name.toUpperCase()):''));else if(e.trigger==='ci')parts.push('FROM CI');
  if(e.worse)parts.push(`<span class="tag-warn">GOT WORSE, ${e.worse.from} BEFORE</span>`);
  parts.push(e.status==='waiting'?'<span class="tag-warn">WAITING</span>':e.status==='running'?`<span class="tag-warn">RUNNING ${e.results.length} OF ${e.total}</span>`:`<span class="${e.passed===e.total?'tag-ok':'tag-warn'}">${e.passed} OF ${e.total} PASSED</span>`);
  if(e.status==='interrupted')parts.push('INTERRUPTED');
  const line2=[];
  if(typeof e.score==='number')line2.push(`SCORE <b>${e.score}</b>${c?.scoreDelta!=null?` (${c.scoreDelta>0?'+':c.scoreDelta===0?'±':''}${c.scoreDelta})`:''}`);
  if(e.interval)line2.push(`PASS RATE ${e.interval[0]}–${e.interval[1]}%`);
  if(e.repeat>1)line2.push(`${e.repeat} RUNS PER CASE`);
  if(c)for(const k of ['broke','worse','flaky','fixed','better','new'])if(c.count[k])line2.push(`<span class="${CASE_TONE[k]||''}">${c.count[k]} ${CASE_WORD[k]}</span>`);
  if(e.judge)line2.push(`JUDGE ${esc(e.judge.name)}${e.judge.same?' <span class="tag-warn">SAME MODEL AS THE WORK</span>':''}`);
  return `<div class="meta-label">${parts.join(' · ')}</div>${line2.length?`<div class="eval-line2">${line2.map(x=>`<span>${x}</span>`).join('')}</div>`:''}${e.error&&e.status!=='done'?`<p class="mono-line">${esc(e.error)}</p>`:''}`;
}
function evalCase(e,r){
  const ch=e.compare?.cases?.[r.testId],many=(r.attempts||1)>1;
  const mark=r.ok?'PASS':many&&r.passes?`${r.passes}/${r.attempts}`:'FAIL';
  const judged=(r.judged||[]).map((j,i)=>`<div class="judge-verdict"><span class="${j.pass?'tag-ok':'tag-warn'}">${j.pass?'PASS':'FAIL'} ${Math.round(j.score*10)}/10</span><p>${many?`Run ${j.attempt+1} · `:''}${esc(j.reason||'')}</p><button type="button" class="btn small${j.vote===true?' on':''}" data-action="eval-vote" data-report="${e.id}" data-test="${esc(r.testId)}" data-index="${i}" data-agree="1" aria-pressed="${j.vote===true}" title="The judge got this right">Right</button><button type="button" class="btn small${j.vote===false?' on':''}" data-action="eval-vote" data-report="${e.id}" data-test="${esc(r.testId)}" data-index="${i}" data-agree="0" aria-pressed="${j.vote===false}" title="The judge got this wrong">Wrong</button></div>`).join('');
  const metrics=r.ms!=null?`<p class="mono-line">${typeof r.score==='number'?'score '+Math.round(r.score*100)+' · ':''}${many?'per run '+fmtMs(r.ms):fmtMs(r.ms)} · ${(r.tokens||0).toLocaleString()} tokens · ${usd(r.cost)} · ${r.tools||0} tools${r.errors?' · '+r.errors+' errors':''}</p>`:'';
  return `<div class="eval-row ${r.ok?'ok':r.flaky?'mid':'bad'}"><span>${mark}</span><div><strong>${esc(r.name)}${ch&&ch!=='same'?` <span class="${CASE_TONE[ch]||''}">${CASE_WORD[ch]}</span>`:''}</strong>${r.failures.length?`<p>${esc(r.failures.join('; '))}</p>`:''}${metrics}${judged}</div><div class="eval-actions">${e.status==='done'?`<button class="btn small" data-action="eval-diff" data-report="${e.id}" data-test="${esc(r.testId)}" title="This answer next to the one before">Compare</button>`:''}${r.traceId?`<button class="btn small" data-action="open-trace" data-id="${r.traceId}">Trace</button>`:''}${r.runId&&state.runs.some(x=>x.id===r.runId)?`<button class="btn small" data-action="view-run" data-id="${r.runId}">Run</button>`:''}</div></div>`;
}
function evalReport(o){
  const list=o.evals||[];if(!list.length)return '<div class="empty small">No test runs yet.</div>';
  return evalTrend(list)+evalCompare(list)+list.slice(0,5).map((e,k)=>`<div class="eval-report${k?' old':''}">${evalHead(e)}${k?'':e.results.map(r=>evalCase(e,r)).join('')}${!k&&e.ms!=null&&e.status!=='running'?`<p class="mono-line">All cases: ${fmtMs(e.ms)} · ${usd(e.cost)}${e.judgeTokens?' · judge '+e.judgeTokens.toLocaleString()+' tokens':''}</p>`:''}${!k&&e.status==='done'&&e.compare?.baseline?`<button class="btn small" data-action="eval-diff" data-report="${e.id}">What changed since the report before</button>`:''}</div>`).join('');
}
// A change held until its tests show nothing got worse.
function candidateBox(o){
  const c=o.candidate;if(!c)return '';
  const rep=(o.evals||[]).find(e=>e.id===c.reportId),testing=c.status==='testing';
  const result=rep?.status==='done'?` Score ${rep.score}${rep.compare?.scoreDelta!=null?` (${rep.compare.scoreDelta>0?'+':rep.compare.scoreDelta===0?'±':''}${rep.compare.scoreDelta})`:''}, ${rep.passed} of ${rep.total} passed${rep.compare?.count.broke?`, ${rep.compare.count.broke} broke`:''}.`:testing&&rep?` Testing: ${rep.results.length} of ${rep.total} cases done.`:'';
  return `<div class="candidate-box tone-${c.status==='worse'||c.status==='error'?'bad':c.status==='passed'?'ok':'warn'}"><div><strong>Held change · ${CANDIDATE_WORD[c.status]||esc(c.status)}</strong><p>${esc((c.changed||[]).join(', '))} changed by ${esc(c.by)}, ${age(c.time)}. It is not in use until it is applied.${result}${c.error?' '+esc(c.error):''}</p></div><div class="heading-actions"><button type="button" class="btn small" data-action="candidate-diff">What changed</button>${testing?'':`<button type="button" class="btn small" data-action="candidate" data-do="retest">Test again</button>`}<button type="button" class="btn small" data-action="candidate" data-do="reject">Reject</button><button type="button" class="btn small primary" data-action="candidate" data-do="apply" ${testing?'disabled':''}>${c.status==='worse'?'Apply anyway':'Apply'}</button></div></div>`;
}
function openTests(kind,o){
  if(!o)return;openTestsKind=kind;openTestsId=o.id;
  const agent=kind==='agent',judges=state.agents.filter(a=>a.provider!=='demo'&&a.id!==o.id),repeat=o.evalRepeat||3,gate=o.gate||'off';
  const runs=agent?[]:state.runs.filter(r=>r.workflowId===o.id&&r.status==='completed'&&!r.test&&r.output).slice(0,10);
  const lastAnswer=agent&&(o.chats||[]).some(m=>m.role==='assistant'&&!m.error);
  const fromReal=agent?(lastAnswer?`<button type="button" class="btn small" data-action="test-from-chat">${icon('plus')} Last answer as a test</button>`:''):runs.length?`<div class="from-run"><select class="select" id="t-from-run" aria-label="A finished run">${runs.map(r=>`<option value="${r.id}">${esc(new Date(r.started).toLocaleString([],{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}))} · ${esc(String(r.input||'').slice(0,60))}</option>`).join('')}</select><button type="button" class="btn small" data-action="test-from-run">${icon('plus')} Run as a test</button></div>`:'';
  showModal(`${modalHead('Tests / '+esc(o.name),agent?'Each test sends one message to the resident as a new conversation and checks the answer. Its chat history is not used or changed.':'Each test runs the whole workflow with its own brief and checks the final answer. Approval steps pass on their own and app steps that change something are not called in a test run.')}<div class="modal-body"><div id="candidate-slot">${candidateBox(o)}</div><div id="test-list">${(o.tests||[]).map((t,i)=>testEditor(t,i,kind)).join('')}</div><div class="heading-actions test-add"><button type="button" class="btn small" data-action="add-test">${icon('plus')} Add test</button>${fromReal}</div>${fromReal?`<small class="mono-line">${agent?'The question before the last answer becomes the brief and the answer its reference.':'The brief of that run becomes the test and its answer the reference.'} A judge compares new answers with it.</small>`:''}<div class="form-grid suite-settings"><div class="form-group"><label for="t-repeat">Runs per case</label><select class="select" id="t-repeat">${[1,2,3,4,5].map(n=>`<option value="${n}" ${n===repeat?'selected':''}>${n}${n===1?' (fastest)':n===3?' (default)':''}</option>`).join('')}</select></div><div class="form-group"><label for="t-gate">When ${agent?'its prompt, model or tools':'its brief or steps'} change</label><select class="select" id="t-gate"><option value="off" ${gate==='off'?'selected':''}>Nothing happens</option><option value="test" ${gate==='test'?'selected':''}>Run the tests</option><option value="hold" ${gate==='hold'?'selected':''}>Hold the change until nothing got worse</option></select></div></div><small class="mono-line">Several runs per case show answers that pass only sometimes. A case counts as broken when it passes clearly less often than before, not after one unlucky run.${agent?' Workflows with this resident that test on change run their tests too.':''}</small>${agent?'':`<label class="check-label"><input type="checkbox" id="t-learn" ${o.learn?'checked':''}><span>Learn from rejections: a run you reject with a note becomes a test on the same brief</span></label>`}<div class="form-group" style="margin-top:14px"><label for="t-judge">Judge for judge: checks</label><select class="select" id="t-judge"><option value="">Picked for each run: another model when there is one</option>${judges.map(a=>{const t=judgeTrustText(a);return `<option value="${a.id}" ${o.judgeId===a.id?'selected':''}>${esc(a.name)} / ${esc(a.provider)}${a.model?' '+esc(a.model):''}${t?' · '+esc(t):''}</option>`;}).join('')}</select><small>A judge costs one short model call per check. Mark its verdicts Right or Wrong in the results: a judge that agrees with you less than 80% of the time is marked unreliable and is not picked on its own.</small></div>${compareBox()}${errEl()}<h3 class="section-title" style="margin-top:18px">Results</h3><div id="eval-report">${evalReport(o)}</div></div><div class="modal-footer"><button type="button" class="btn" data-action="close-modal">Close</button><button type="button" class="btn" data-action="save-tests">Save tests</button><button type="button" class="btn primary" data-action="run-tests">${icon('play')} Save and run tests</button></div>`,'tests');
  if(!(o.tests||[]).length)$('#test-list').innerHTML=testEditor({name:'',input:agent?'':o.brief||'',checks:[]},0,kind);
}
let openTestsId=null,openTestsKind='workflow';
// Run the same tests on other models to compare passes, cost and time.
function compareBox(){
  const live=Object.keys(PROVIDER_NAME).filter(p=>p==='ollama'||state.connections[p]?.configured);
  if(!live.length)return '';
  const rows=[0,1,2].map(i=>`<div class="compare-row"><select class="select cmp-provider" aria-label="Provider ${i+1}"><option value="">None</option>${live.map(p=>`<option value="${p}">${PROVIDER_NAME[p]}</option>`).join('')}</select><input class="field cmp-model" maxlength="120" placeholder="Model name" aria-label="Model ${i+1}"></div>`).join('');
  return `<details class="compare-box"><summary>Compare models</summary><p class="mono-line">Every ${openTestsKind==='agent'?'answer':'step'} runs on the model you pick. Up to 3 models, one after another.</p>${rows}<button type="button" class="btn small" data-action="compare-models">${icon('play')} Run tests on these models</button></details>`;
}
async function saveTests(){
  const tests=$$('.test-case').map(el=>({id:el.dataset.id||undefined,name:el.querySelector('.test-name').value,input:el.querySelector('.test-input').value,reference:el.querySelector('.test-reference').value,checks:parseChecks(el.querySelector('.test-checks').value),...(el.dataset.learned&&{learned:true})})).filter(t=>t.input.trim()||t.checks.length);
  const r=await post(suitePath(openTestsKind,openTestsId)+'/tests',{tests,judgeId:$('#t-judge').value||null,repeat:Number($('#t-repeat').value),gate:$('#t-gate').value,...($('#t-learn')&&{learn:$('#t-learn').checked})});await refresh();
  $$('.test-case').forEach((el,i)=>{if(r.tests[i])el.dataset.id=r.tests[i].id;});return r.tests;
}
function refreshTests(){const o=suiteOf(openTestsKind,openTestsId);if(!o)return;$('#eval-report').innerHTML=evalReport(o);$('#eval-report').dataset.html='';if($('#candidate-slot'))$('#candidate-slot').innerHTML=candidateBox(o);}
// Differences, only around what changed when the text is long.
function diffLines(d,context=3){
  if(!d?.length)return '<p class="mono-line">Nothing to show.</p>';
  if(d.every(([t])=>t===' '))return '<p class="mono-line">No difference.</p>';
  const near=d.map((_,i)=>d.slice(Math.max(0,i-context),i+context+1).some(([t])=>t!==' '));let out='',skipped=0;
  d.forEach(([t,s],i)=>{if(!near[i]){skipped++;return;}if(skipped){out+=`<span class="dskip">… ${skipped} same line${skipped===1?'':'s'}</span>\n`;skipped=0;}out+=`<span class="${t==='+'?'dadd':t==='-'?'ddel':''}">${t} ${esc(s)}</span>\n`;});
  if(skipped)out+=`<span class="dskip">… ${skipped} same line${skipped===1?'':'s'}</span>`;
  return `<pre class="diff">${out}</pre>`;
}
async function openEvalDiff(rid,testId){
  let d;try{d=await api(`/evals/${rid}/diff`+(testId?'?test='+encodeURIComponent(testId):''));}catch(e){toast(e.message,true);return;}
  const o=suiteOf(openTestsKind,openTestsId),rep=o?.evals?.find(e=>e.id===rid),r=testId&&rep?.results.find(x=>x.testId===testId);
  const when=t=>new Date(t).toLocaleString([],{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
  const answer=testId?`<h3 class="section-title">Answer${r?' / '+esc(r.name):''}</h3>${d.baseline?(d.before==null?'<p class="mono-line">The report before did not keep its answer for this case. The answer now:</p><pre class="diff">'+esc(d.after||'')+'</pre>':diffLines(d.output)):'<p class="mono-line">There is no report before this one. The answer:</p><pre class="diff">'+esc(d.after||'')+'</pre>'}`:'';
  const def=d.baseline?d.def?diffLines(d.def):'<p class="mono-line">The definition from then is no longer kept.</p>':'';
  showModal(`${modalHead('Compare'+(o?' / '+esc(o.name):''),d.baseline?`This report against the one of ${when(d.baseline.time)} (version ${d.baseline.version}${d.baseline.score!=null?', score '+d.baseline.score:''}). Lines with - were there before, lines with + are new.`:'')}<div class="modal-body">${answer}${d.baseline?`<h3 class="section-title">What was tested: steps, prompts and models</h3>${def}`:''}</div><div class="modal-footer"><button type="button" class="btn" data-action="eval-back">Back to tests</button><button type="button" class="btn" data-action="close-modal">Close</button></div>`,'eval-diff');
}
async function openCandidateDiff(){
  let d;try{d=await api(suitePath(openTestsKind,openTestsId)+'/candidate');}catch(e){toast(e.message,true);return;}
  const o=suiteOf(openTestsKind,openTestsId);
  showModal(`${modalHead('Held change / '+esc(o?.name||''),`Changed: ${esc((d.changed||[]).join(', '))}, by ${esc(d.by)}. Lines with - are in use now, lines with + are the held change.`)}<div class="modal-body">${diffLines(d.diff)}</div><div class="modal-footer"><button type="button" class="btn" data-action="eval-back">Back to tests</button><button type="button" class="btn" data-action="close-modal">Close</button></div>`,'eval-diff');
}
function openVersions(w){
  if(!w)return;
  showModal(`${modalHead('Versions / '+esc(w.name),'Every saved change keeps the version before it. The last 20 are kept.')}<div class="modal-body"><div class="version-row current"><div><strong>Version ${w.version||1} (now)</strong><p>${esc(w.name)} · ${w.steps.length} steps</p></div><div class="flow-mini">${flowNodes(w.steps)}</div></div>${(w.versions||[]).map(v=>`<div class="version-row"><div><strong>Version ${v.version}</strong><p>${esc(v.name)} · ${v.steps.length} steps · saved over on ${new Date(v.time).toLocaleString([],{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}</p></div><div class="flow-mini">${flowNodes(v.steps)}</div><button class="btn small" data-action="restore-version" data-id="${w.id}" data-version="${v.version}">Restore</button></div>`).join('')}</div><div class="modal-footer"><button type="button" class="btn" data-action="close-modal">Close</button></div>`,'versions');
}
// Spending and notifications, shown in IT.
const PROVIDER_NAME={openai:'OpenAI',anthropic:'Anthropic',ollama:'Ollama',compatible:'Compatible'};
const usd=n=>n?'$'+(n<1?n.toFixed(4):n.toFixed(2)):'$0';
function spendTotals(){
  const days=state.usage?.days||{},day=new Date().toISOString().slice(0,10),month=day.slice(0,7),out={},models=new Set();
  for(const p of Object.keys(PROVIDER_NAME))out[p]={day:0,month:0,tokens:0};
  for(const [d,v] of Object.entries(days))for(const [p,u] of Object.entries(v)){if(!out[p])continue;if(d.startsWith(month))out[p].month+=u.cost||0;if(d===day){out[p].day+=u.cost||0;out[p].tokens+=(u.input||0)+(u.output||0);}for(const m of Object.keys(u.models||{}))models.add(p+':'+m);}
  return {out,models};
}
function spendingSection(){
  const {out,models}=spendTotals(),limits=state.limits||{},prices=state.prices||{};
  const keys=[...new Set([...Object.keys(prices),...models,...Object.keys(PROVIDER_NAME).filter(p=>state.connections[p]?.configured).map(p=>p+':*')])].sort();
  const num=(name,v,step,ph)=>`<input class="field" type="number" min="0" step="${step}" name="${name}" value="${v||''}" placeholder="${ph}">`;
  return `<h2 class="section-title">Spending</h2><div class="info-banner">${icon('activity')}<span><strong>Money.</strong> Costs use the prices you enter below, in US dollars per million tokens. Providers change their prices, so copy them from the provider's pricing page. A limit blocks new calls to that provider until the next day or month, and the silo lights dim as it gets close.</span></div><form id="spending-form" class="section-card spend"><table class="spend-table"><thead><tr><th>Provider</th><th>Today</th><th>This month</th><th>Tokens today</th><th>Daily limit $</th><th>Monthly limit $</th><th>Tokens per day</th></tr></thead><tbody>${Object.entries(PROVIDER_NAME).map(([p,n])=>{const l=limits[p]||{};return `<tr data-provider="${p}"><td>${n}</td><td>${usd(out[p].day)}</td><td>${usd(out[p].month)}</td><td>${out[p].tokens.toLocaleString()}</td><td>${num('daily',l.daily,'0.01','none')}</td><td>${num('monthly',l.monthly,'0.01','none')}</td><td>${num('tokens',l.tokens,'1000','none')}</td></tr>`;}).join('')}</tbody></table><table class="spend-table prices"><thead><tr><th>Model</th><th>Input $ / 1M</th><th>Output $ / 1M</th></tr></thead><tbody>${keys.map(k=>{const v=prices[k]||{};return `<tr data-key="${esc(k)}"><td class="mono-line">${esc(k.replace(':*',' / every model'))}</td><td>${num('input',v.input,'0.01','not set')}</td><td>${num('output',v.output,'0.01','not set')}</td></tr>`;}).join('')||'<tr><td colspan="3" class="empty small">Connect a provider to set its prices.</td></tr>'}<tr data-new="1"><td><input class="field" name="key" placeholder="openai:model-name" spellcheck="false"></td><td>${num('input','','0.01','')}</td><td>${num('output','','0.01','')}</td></tr></tbody></table><div class="heading-actions" style="margin-top:10px"><button class="btn primary">Save spending</button></div></form>`;
}
const CHANNEL_MARK={telegram:'TG',slack:'SLK',discord:'DSC',webhook:'WEB',email:'MAIL'};
const CHANNEL_KIND={telegram:'Telegram',slack:'Slack',discord:'Discord',webhook:'Webhook',email:'Email'};
function channelCards(){
  const list=state.channels||[];if(!list.length)return '<div class="empty small">No channels yet. Add one to hear about failed workflows when you are away from the screen.</div>';
  const ev=state.notifyEvents||{};
  return list.map(c=>`<article class="connection-card"><div class="connection-brand"><span class="connection-logo">${CHANNEL_MARK[c.kind]}</span><h3>${esc(c.name)}</h3><span class="connection-state"><span class="dot ${c.enabled&&c.last?.ok!==false?'green':''}"></span>${!c.enabled?'OFF':c.last?(c.last.ok?'DELIVERED':'FAILED'):'NOT USED YET'}</span></div><p>${CHANNEL_KIND[c.kind]}${c.kind==='email'?' to '+esc(c.config?.to||''):c.kind==='telegram'?' chat '+esc(c.config?.chatId||''):''}</p><p>${c.events.map(e=>esc(ev[e]||e)).join(' · ')}</p>${c.last&&!c.last.ok?`<p class="modal-error">${esc(c.last.error||'')}</p>`:''}<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">${button('Send test','channel-test',false,`data-id="${c.id}"`)}${button('Edit','channel-edit',false,`data-id="${c.id}"`)}${button('Remove','channel-remove',false,`data-id="${c.id}"`)}</div></article>`).join('');
}
function openChannelEditor(c){
  const fresh=!c,v=c||{kind:'telegram',name:'',events:['failed','request'],enabled:true,config:{port:587},has:{}},cf=v.config||{},saved=k=>v.has?.[k]?'Saved. Leave empty to keep it.':'';
  const ev=state.notifyEvents||{};
  showModal(`${modalHead(fresh?'Add channel':'Edit '+esc(v.name),'Where SILO sends a message when something happens.')}<form id="channel-form" data-kind="${v.kind}"><div class="modal-body"><div class="form-grid">${fresh?`<div class="form-group"><label for="ch-kind">Kind</label><select class="select" id="ch-kind" name="kind">${Object.entries(CHANNEL_KIND).map(([k,n])=>`<option value="${k}" ${k===v.kind?'selected':''}>${n}</option>`).join('')}</select></div>`:''}<div class="form-group"><label for="ch-name">Name</label><input class="field" id="ch-name" name="name" maxlength="60" value="${esc(v.name)}" placeholder="e.g. My phone"></div></div>
<div class="ch-telegram"><div class="form-grid"><div class="form-group"><label for="ch-token">Bot token</label><input class="field" id="ch-token" name="token" autocomplete="off" placeholder="${saved('token')||'123456:ABC...'}"></div><div class="form-group"><label for="ch-chat">Chat ID</label><input class="field" id="ch-chat" name="chatId" value="${esc(cf.chatId||'')}" placeholder="123456789"></div></div><small>Create a bot with @BotFather, send it a message, then find your chat ID with @userinfobot.</small></div>
<div class="ch-url"><div class="form-group"><label for="ch-url">Webhook address</label><input class="field" id="ch-url" name="url" autocomplete="off" placeholder="${saved('url')||'https://hooks.slack.com/services/...'}"><small class="ch-slack">In Slack: Apps, Incoming Webhooks, Add to a channel, copy the address.</small><small class="ch-discord">In Discord: channel settings, Integrations, Webhooks, New webhook, copy the address.</small><small class="ch-webhook">SILO posts JSON: source, event, title, detail, time.</small></div><div class="form-group ch-webhook"><label for="ch-secret">Signing secret (optional)</label><input class="field" id="ch-secret" name="secret" autocomplete="off" placeholder="${saved('secret')||'Sent as an HMAC SHA-256 in X-Silo-Signature'}"></div></div>
<div class="ch-email"><div class="form-grid"><div class="form-group"><label for="ch-host">Mail server</label><input class="field" id="ch-host" name="host" value="${esc(cf.host||'')}" placeholder="smtp.gmail.com"></div><div class="form-group"><label for="ch-port">Port</label><input class="field" id="ch-port" name="port" type="number" value="${cf.port||587}"></div><div class="form-group"><label for="ch-user">User name</label><input class="field" id="ch-user" name="user" value="${esc(cf.user||'')}" autocomplete="off"></div><div class="form-group"><label for="ch-pass">Password</label><input class="field" id="ch-pass" name="pass" type="password" autocomplete="new-password" placeholder="${saved('pass')||'An app password works best'}"></div><div class="form-group"><label for="ch-from">From</label><input class="field" id="ch-from" name="from" value="${esc(cf.from||'')}" placeholder="SILO &lt;me@example.com&gt;"></div><div class="form-group"><label for="ch-to">To</label><input class="field" id="ch-to" name="to" value="${esc(cf.to||'')}" placeholder="me@example.com"></div></div><small>Port 465 uses TLS from the start, other ports switch to TLS before the password is sent.</small></div>
<div class="form-group"><label>Send when</label><div class="check-grid">${Object.entries(ev).map(([k,n])=>`<label class="check-label"><input type="checkbox" name="events" value="${k}" ${v.events.includes(k)?'checked':''}> ${esc(n)}</label>`).join('')}</div></div><label class="check-label"><input type="checkbox" name="enabled" ${v.enabled!==false?'checked':''}> Channel on</label>${errEl()}</div><div class="modal-footer"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn primary">${fresh?'Add channel':'Save'}</button></div></form>`,'channel');
  const form=$('#channel-form');form.elements.kind?.addEventListener('change',e=>{form.dataset.kind=e.target.value;});
  form.onsubmit=async e=>{
    e.preventDefault();const el=form.elements,btn=form.querySelector('.btn.primary');btn.disabled=true;
    const kind=fresh?el.kind.value:v.kind;
    const body={id:c?.id,kind,name:el.name.value,events:[...form.querySelectorAll('[name=events]:checked')].map(x=>x.value),enabled:el.enabled.checked,token:el.token.value,chatId:el.chatId.value,url:el.url.value,secret:el.secret.value,email:{host:el.host.value,port:Number(el.port.value),user:el.user.value,pass:el.pass.value,from:el.from.value,to:el.to.value}};
    try{const r=await post('/channels',body);await refresh();modal.close();if(view==='connections')render();toast('Channel saved. Sending a test message...');try{await post('/channels/'+r.id+'/test',{});toast('Test message delivered.');}catch(err){toast('Saved, but the test failed: '+err.message,true);}await refresh();if(view==='connections')render();}
    catch(err){$('#form-error').textContent=err.message;btn.disabled=false;}
  };
}
// The phone: a Telegram bot that talks to residents, starts workflows and takes approvals.
function phoneSection(){return `<h2 class="section-title">Phone</h2><div class="info-banner">${icon('activity')}<span><strong>Run the silo from your phone.</strong> A Telegram bot of your own: talk to residents, start workflows, and allow or deny requests with one tap. SILO asks Telegram for new messages, so it needs no public address. Only phones you pair are obeyed.</span></div><div id="phone-live" class="section-card phone-card"><p class="mono-line">Loading...</p></div>`;}
let phoneTimer=null;
async function loadPhone(code){
  const box=$('#phone-live');if(!box)return;clearTimeout(phoneTimer);
  let p;try{p=await api('/phone');}catch(e){box.innerHTML=`<p class="modal-error">${esc(e.message)}</p>`;return;}
  if(view!=='connections'||!$('#phone-live'))return;
  const owner=!(state.users||[]).length||me?.role==='owner',ev=state.notifyEvents||{};
  if(!p.hasToken){
    box.innerHTML=`<ol class="phone-steps"><li>In Telegram, open <strong>@BotFather</strong> and send <code>/newbot</code>. Pick a name and a user name for your bot.</li><li>BotFather answers with a token like <code>123456789:AA...</code>. Paste it here.</li><li>Press Pair a phone, then send the code to your bot.</li></ol>${owner?`<div class="phone-row"><input class="field" id="phone-token" autocomplete="off" placeholder="Bot token from BotFather" aria-label="Bot token">${button('Connect bot','phone-save',true)}</div>`:'<p>Only an owner can connect the bot.</p>'}`;
    return;
  }
  const state_=p.running?'LISTENING':p.enabled?'STARTING':'OFF';
  const chats=p.chats.length?p.chats.map(c=>`<div class="user-row"><div><strong>${esc(c.name)}</strong><p>${c.user?'@'+esc(c.user)+' · ':''}paired ${new Date(c.paired).toLocaleDateString()}${c.seen?' · last seen '+age(c.seen):''}</p></div>${owner?button('Remove','phone-unpair',false,`data-id="${esc(c.id)}"`):''}</div>`).join(''):'<p class="mono-line">No phone paired yet.</p>';
  const pairBox=code?`<div class="phone-code"><span>In Telegram, open <strong>@${esc(p.botName)}</strong> and send:</span><code>/pair ${esc(code.code)}</code><small>The code works once, for 10 minutes.</small></div>`:'';
  box.innerHTML=`<div class="connection-brand"><span class="connection-logo">TG</span><h3>@${esc(p.botName||'bot')}</h3><span class="connection-state"><span class="dot ${p.running?'green':''}"></span>${state_}</span></div>${p.error&&!p.running?`<p class="modal-error">${esc(p.error)}</p>`:''}
${pairBox}<div class="user-list">${chats}</div>
${owner?`<div class="phone-options"><label class="check-label"><input type="checkbox" id="phone-enabled" ${p.enabled?'checked':''}> Bot on</label><label class="check-label"><input type="checkbox" id="phone-approvals" ${p.approvals?'checked':''}> Send approval requests with Allow and Deny buttons</label><div class="form-group"><label>Also send</label><div class="check-grid">${Object.entries(ev).filter(([k])=>k!=='request').map(([k,n])=>`<label class="check-label"><input type="checkbox" class="phone-event" value="${k}" ${p.events.includes(k)?'checked':''}> ${esc(n)}</label>`).join('')}</div></div></div>
<div class="heading-actions">${button('Pair a phone','phone-pair',true)}${p.chats.length?button('Send test','phone-test'):''}${button('Remove bot','phone-remove')}</div>`:''}
<details class="phone-help"><summary>What you can send the bot</summary><p class="mono-line">/talk Pavel Barlow, then just write: talk to a resident<br>/residents, or /residents word: find residents<br>/flows and /run 2 your brief: start a workflow, the result comes back<br>/status, /pending: what runs and what waits for you<br>/pause, /resume: stop or allow new work<br>/unpair: forget this phone</p></details>`;
  // While a code waits, check for the new phone every few seconds.
  if(code){const before=p.chats.length;const poll=async()=>{if(view!=='connections'||!$('#phone-live .phone-code'))return;try{const q=await api('/phone');if(q.chats.length>before){toast('Phone paired: '+q.chats.at(-1).name+'.');loadPhone();return;}if(!q.pairing){loadPhone();return;}}catch{}phoneTimer=setTimeout(poll,3000);};phoneTimer=setTimeout(poll,3000);}
}
async function savePhone(extra={}){
  const body={enabled:$('#phone-enabled')?.checked,approvals:$('#phone-approvals')?.checked,events:$$('.phone-event:checked').map(x=>x.value),...extra};
  await post('/phone',body);
}
async function saveSpending(form){
  const limits={},prices={};
  for(const tr of form.querySelectorAll('tr[data-provider]')){const g=n=>tr.querySelector(`[name=${n}]`).value;limits[tr.dataset.provider]={daily:Number(g('daily')||0),monthly:Number(g('monthly')||0),tokens:Number(g('tokens')||0)};}
  for(const tr of form.querySelectorAll('tr[data-key],tr[data-new]')){
    const key=tr.dataset.key||tr.querySelector('[name=key]').value.trim(),i=tr.querySelector('[name=input]').value,o=tr.querySelector('[name=output]').value;if(!key)continue;
    if(i===''&&o===''){if(state.prices?.[key])prices[key]=null;continue;}
    prices[key]={input:Number(i||0),output:Number(o||0)};
  }
  await post('/spending',{limits,prices});await refresh();render();toast('Spending saved.');
}
// People and access: accounts with roles, the encrypted vault and access from other devices.
const ROLE_NAME={owner:'Owner',operator:'Operator',viewer:'Viewer'};
function accessCard(){
  const users=state.users||[],ac=state.access||{},owner=me?.role==='owner';
  const vaultLine=ac.vaultError?`<p class="modal-error">${esc(ac.vaultError)}</p>${owner||!users.length?button('Clear saved secrets','vault-reset'):''}`:`<p class="mono-line">Secrets are encrypted with a ${esc(ac.vault||'key file')}.${ac.envKeys?.length?' From environment: '+ac.envKeys.join(', ')+'.':''}</p>`;
  const list=users.map(u=>`<div class="user-row"><div><strong>${esc(u.name)}${u.id===me?.id?' (you)':''}</strong><p>Since ${new Date(u.created).toLocaleDateString()}${u.sso?' · single sign-on'+(u.sso.email?', '+esc(u.sso.email):''):''}${u.lastLogin?' · last in '+age(u.lastLogin):''}</p></div>${owner?`<select class="select" data-user-role="${u.id}" aria-label="Role of ${esc(u.name)}">${Object.entries(ROLE_NAME).map(([k,n])=>`<option value="${k}" ${u.role===k?'selected':''}>${n}</option>`).join('')}</select>${button('Remove','user-remove',false,`data-id="${u.id}"`)}`:`<span class="provider-badge">${ROLE_NAME[u.role]}</span>`}</div>`).join('');
  const addForm=`<form id="user-form" class="user-form"><div class="form-grid"><div class="form-group"><label for="user-name">Name</label><input class="field" id="user-name" maxlength="40" required autocomplete="off"></div><div class="form-group"><label for="user-pass">Password</label><input class="field" id="user-pass" type="password" minlength="8" required autocomplete="new-password"></div></div>${users.length?`<div class="form-group"><label for="user-role">Role</label><select class="select" id="user-role"><option value="viewer">Viewer: looks, changes nothing</option><option value="operator">Operator: runs residents and workflows</option><option value="owner">Owner: everything, including keys and people</option></select></div>`:''}<button class="btn primary">${users.length?'Add account':'Create owner account'}</button></form>`;
  return `<section class="settings-card"><h3>People and access</h3>${users.length?`<p>Signed in as <strong>${esc(me?.name||'')}</strong>, ${ROLE_NAME[me?.role]?.toLowerCase()||''}.</p><div class="user-list">${list}</div>${owner?addForm:''}${me?.sso&&!me.password?'':`<form id="password-form" class="user-form"><div class="form-grid"><div class="form-group"><label for="pw-old">Current password</label><input class="field" id="pw-old" type="password" autocomplete="current-password" required></div><div class="form-group"><label for="pw-new">New password</label><input class="field" id="pw-new" type="password" minlength="8" autocomplete="new-password" required></div></div><div class="heading-actions"><button class="btn">Change password</button>${button('Sign out','sign-out')}</div></form>`}${me?.sso&&!me.password?`<div class="heading-actions">${button('Sign out','sign-out')}</div>`:''}`:`<p>Nobody has to sign in, because SILO only answers on this computer. Create an owner account to require a password, to let more people in with their own role, and to open SILO to other devices on your network.</p>${addForm}`}${owner?`<label class="check-label"><input type="checkbox" id="network-toggle" ${ac.network?'checked':''}> Open to other devices on this network</label><p class="mono-line">${ac.listening?'Listening on the network now. Everyone has to sign in.':ac.network?'Turned on. Restart SILO to start listening on the network.':'Only this computer can open SILO.'} Traffic is plain HTTP, so use it on a network you trust, or put a TLS proxy in front.</p>`:''}${vaultLine}</section>`;
}
// API tokens, for scripts and other programs. The secret is shown once, right after it is made.
async function loadTokensCard(){
  const box=$('#tokens-card');if(!box)return;
  let d;try{d=await api('/tokens');}catch(e){box.innerHTML=`<h3>API tokens</h3><p class="modal-error">${esc(e.message)}</p>`;return;}
  if(!box.isConnected)return;
  const owner=!me||me.role==='owner';
  const rows=d.tokens.map(t=>`<div class="user-row token-row"><div><strong>${esc(t.name)}</strong><p><code>${esc(t.hint)}…</code> · ${t.scopes.map(esc).join(', ')} · ${t.anywhere?'from anywhere':'this computer only'}${owner&&t.owner&&!t.mine?' · '+esc(t.owner):''}</p><p>Made ${new Date(t.created).toLocaleDateString()} · used ${t.lastUsed?age(t.lastUsed):'never'} · ${t.expired?'<span class="tag-warn">expired</span>':t.expiresAt?'expires '+new Date(t.expiresAt).toLocaleDateString():'no expiry'}</p></div><button class="btn small" data-action="token-revoke" data-id="${t.id}">Revoke</button></div>`).join('');
  const scopes=Object.entries(d.scopes).filter(([k])=>d.allowed.includes(k)).map(([k,v])=>`<label class="check-label"><input type="checkbox" name="token-scope" value="${k}" ${k==='read'?'checked':''}><span><strong>${k}</strong> · ${esc(v)}</span></label>`).join('');
  box.innerHTML=`<h3>API tokens</h3><p>For scripts and other programs. A token is sent as <code>Authorization: Bearer …</code>, acts as you and never has more rights than your role. The API is described at <a href="/api/openapi.json" target="_blank" rel="noreferrer">/api/openapi.json</a>.</p>${rows?`<div class="user-list">${rows}</div>`:'<p class="mono-line">No tokens yet.</p>'}<form id="token-form" class="user-form"><div class="form-grid"><div class="form-group"><label for="token-name">Name</label><input class="field" id="token-name" maxlength="60" required autocomplete="off" placeholder="e.g. nightly report"></div><div class="form-group"><label for="token-days">Expires</label><select class="select" id="token-days"><option value="30">In 30 days</option><option value="7">In 7 days</option><option value="90">In 90 days</option><option value="365">In a year</option><option value="0">Never</option></select></div></div><fieldset class="token-scopes"><legend>Scopes</legend>${scopes}</fieldset><label class="check-label"><input type="checkbox" id="token-anywhere"><span>Also from other devices, over the network or the remote address. Otherwise only from this computer.</span></label><button type="submit" class="btn primary">${icon('plus')} Make token</button></form>`;
  $('#token-form').onsubmit=async e=>{
    e.preventDefault();
    const scopes=[...box.querySelectorAll('input[name="token-scope"]:checked')].map(x=>x.value);if(!scopes.length)return toast('Choose at least one scope.',true);
    const btn=e.submitter;if(btn)btn.disabled=true;
    try{const r=await api('/tokens',{method:'POST',body:{name:$('#token-name').value,days:Number($('#token-days').value),scopes,anywhere:$('#token-anywhere').checked}});showTokenSecret(r);loadTokensCard();}
    catch(err){toast(err.message,true);if(btn)btn.disabled=false;}
  };
}
function showTokenSecret(r){
  showModal(`${modalHead('Token made',esc(r.token.name)+' / '+r.token.scopes.map(esc).join(', '))}<div class="modal-body"><p>Copy it now. SILO keeps only a fingerprint of it, so it cannot show it again.</p><input class="field" id="token-secret" readonly value="${esc(r.secret)}" aria-label="The new token" spellcheck="false"><p class="mono-line">curl -H "Authorization: Bearer $SILO_TOKEN" ${esc(location.origin)}/api/state</p></div><div class="modal-footer"><button type="button" class="btn" data-action="close-modal">Done</button><button type="button" class="btn primary" id="token-copy">${icon('check')} Copy token</button></div>`,'token');
  $('#token-copy').onclick=async()=>{try{await navigator.clipboard.writeText(r.secret);toast('Token copied.');}catch{$('#token-secret').select();toast('Select the token and copy it.',true);}};
  $('#token-secret').onfocus=e=>e.target.select();
}
// Silo-to-Silo Radio: this silo's name, address and key, a map of the silos it knows, the silos themselves (each with
// its own Ed25519 key, or a shared key for an older SILO), the rights given to and held from other silos, and a log of
// what went over the air (who, when, whether it was let through; never the messages).
const CAP_TOOLS={read_files:'Read files',write_files:'Write files',web:'Web'};
const capLine=c=>`${c.rights.residents.map(r=>r==='*'?'all residents':esc(r)).join(', ')} · ${c.rights.tools.map(t=>CAP_TOOLS[t]||esc(t)).join(', ')||'no tools'}${c.rights.folders.length?' in '+c.rights.folders.map(f=>f==='*'?'all folders':esc(f)+(/\.[a-z0-9]+$/i.test(f)?'':'/')).join(', '):''}`;
const capState=c=>c.revoked?'<span class="tag-warn">REVOKED</span>':c.exp<Date.now()?'<span class="tag-warn">EXPIRED</span>':'<span class="tag-ok">ACTIVE</span>';
const until=t=>new Date(t).toLocaleString([],{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
const num=n=>Number(n||0).toLocaleString('en');
// What is left of a capability: counted here for one this silo gave first, as last told by the owner for one held.
function capLeft(c,rad){
  if(c.left)return {tokens:c.left.tokens,messages:c.left.messages};
  if(c.sub||c.links>1&&!c.id)return null;
  const u=(rad.capUse||{})[c.hash]||{tokens:0,messages:0};
  return {tokens:Math.max(0,c.budget.tokens-u.tokens),messages:Math.max(0,c.budget.messages-u.messages)};
}
// The map: this silo in the middle, the others around it. A line for each radio link (bright when used in the last ten
// minutes), an amber curve for each capability with a bar of what is left, and a dot for each recent transmission.
function radioMap(rad){
  const peers=rad.peers||[],prints=state.access?.radioPrints||{},now=Date.now(),live=c=>!c.revoked&&c.exp>now;
  const nodes=new Map();
  for(const p of peers)nodes.set(p.publicKey||'peer:'+p.id,{name:p.name,print:p.publicKey?prints[p.id]:'shared key',peer:p});
  for(const c of (rad.issued||[]).filter(live))if(!nodes.has(c.holder))nodes.set(c.holder,{name:c.audName||'Another silo',print:prints[c.holder]||''});
  for(const h of (rad.held||[]).filter(live))if(!nodes.has(h.root))nodes.set(h.root,{name:h.rootName||'Another silo',print:prints[h.root]||''});
  const list=[...nodes.entries()].slice(0,24),n=list.length,W=520,H=n<=2?230:n>8?400:340,cx=W/2,cy=H/2,rx=W/2-78,ry=H/2-62;
  list.forEach(([,v],i)=>{const a=-Math.PI+i*2*Math.PI/n+(n%2?Math.PI/2:0);v.x=Math.round(cx+rx*Math.cos(a));v.y=Math.round(cy+ry*Math.sin(a));});
  const at=k=>nodes.get(k)||[...nodes.values()].find(v=>v.name===k);
  const curve=(a,b,bend)=>{const mx=(a.x+b.x)/2,my=(a.y+b.y)/2,dx=b.x-a.x,dy=b.y-a.y,l=Math.hypot(dx,dy)||1;return `M${a.x},${a.y} Q${Math.round(mx-dy/l*bend)},${Math.round(my+dx/l*bend)} ${b.x},${b.y}`;};
  const me={x:cx,y:cy};
  const links=list.map(([,v])=>{const p=v.peer,last=p?Math.max(p.lastIn||0,p.lastOut||0):0,on=p&&now-last<600000;return p?`<path class="rm-link${on?' on':''}${p.publicKey?'':' old'}" d="M${cx},${cy} L${v.x},${v.y}"/>`:'';}).join('');
  const bar=(x,y,left,budget)=>{const f=Math.max(0,Math.min(1,left.tokens/budget.tokens));return `<rect class="rm-bar-bg" x="${x-22}" y="${y}" width="44" height="4"/><rect class="rm-bar${f<.15?' low':''}" x="${x-22}" y="${y}" width="${Math.round(44*f)}" height="4"/>`;};
  const caps=[...(rad.issued||[]).filter(live).map(c=>({c,from:me,to:at(c.holder)})),...(rad.held||[]).filter(live).map(c=>({c,from:at(c.root),to:me}))].filter(x=>x.from&&x.to).slice(0,30);
  const capSvg=caps.map(({c,from,to},i)=>{const d=curve(from,to,26+(i%3)*10),left=capLeft(c,rad),far=from===me?to:from,bx=Math.round(far.x+(cx-far.x)*.4),by=Math.round(far.y+(cy-far.y)*.4)+8+(i%3)*7;return `<path class="rm-cap" d="${d}"><title>${capLine(c)}</title></path>${left?bar(bx,by,left,c.budget):''}`;}).join('');
  const recent=(state.radioLog||[]).filter(e=>now-e.time<90000).slice(0,12);
  const pulses=recent.map((e,i)=>{const v=at(e.peerKey)||at(e.peer);if(!v)return '';const d=e.dir==='in'?`M${v.x},${v.y} L${cx},${cy}`:`M${cx},${cy} L${v.x},${v.y}`;return `<circle class="rm-pulse${e.ok?'':' bad'}" r="4"><animateMotion dur="1.8s" begin="${(i*.3).toFixed(1)}s" repeatCount="indefinite" path="${d}"/></circle>`;}).join('');
  // Labels go below a silo, or above one in the upper half, so the lines to the middle never cross them.
  const label=(v,cls)=>{const up=cls!=='self'&&v.y<cy-5,r=cls==='self'?14:9,ny=up?v.y-r-21:v.y+r+18,py=up?v.y-r-8:v.y+r+31;return `<g class="rm-node ${cls}"><circle cx="${v.x}" cy="${v.y}" r="${r}"/><text x="${v.x}" y="${ny}">${esc(v.name.slice(0,18))}</text>${v.print?`<text class="rm-print" x="${v.x}" y="${py}">${esc(v.print)}</text>`:''}</g>`;};
  const svg=`<svg class="rm-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Map of ${n} other silos">${links}${capSvg}${pulses}${list.map(([,v])=>label(v,v.peer?'peer':'far')).join('')}${label({x:cx,y:cy,name:rad.siloId||'Silo 18',print:rad.fingerprint||''},'self')}</svg>`;
  // On a narrow screen the same, as a list.
  const rows=list.map(([k,v])=>{const p=v.peer,last=p?Math.max(p.lastIn||0,p.lastOut||0):0,given=(rad.issued||[]).filter(c=>live(c)&&c.holder===k).length,held=(rad.held||[]).filter(c=>live(c)&&c.root===k).length;return `<li><strong>${esc(v.name)}</strong> <span class="${p&&now-last<600000?'tag-ok':''}">${p?(now-last<600000?'ON AIR':last?'quiet '+age(last):'never used'):'not in the list'}</span>${given?` · gave ${given}`:''}${held?` · holds ${held}`:''}${recent.some(e=>(e.peerKey&&e.peerKey===k)||e.peer===v.name)?' · <span class="tag-ok">transmitting</span>':''}</li>`;}).join('');
  return n?`<div class="radio-map" id="radio-map">${svg}<ul class="radio-map-list">${rows}</ul></div>`:'<p class="mono-line">No other silos yet. Add one below, or take rights another silo gave.</p>';
}
// The fields of a capability, for giving one and for passing one on. d holds the starting values.
function capFields(p,d,peers,withPeer=true){
  const tools=d.rights?.tools||['read_files'];
  return `<div class="form-grid">${withPeer?`<div class="form-group"><label for="${p}-peer">To silo</label><select class="select" id="${p}-peer">${peers.map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('')}<option value="">Another silo, by its key</option></select></div><div class="form-group" id="${p}-key-row" ${peers.length?'hidden':''}><label for="${p}-key">Its key</label><input class="field" id="${p}-key" maxlength="60" spellcheck="false" placeholder="ed25519:..."></div><div class="form-group" id="${p}-name-row" ${peers.length?'hidden':''}><label for="${p}-name">Its name</label><input class="field" id="${p}-name" maxlength="40" placeholder="Silo 7"></div>`:''}<div class="form-group"><label for="${p}-res">Residents (* for all)</label><input class="field" id="${p}-res" maxlength="600" value="${esc((d.rights?.residents||[]).join(', '))}" placeholder="e.g. Archivist" required></div><div class="form-group"><label for="${p}-folders">Folders (* for all)</label><input class="field" id="${p}-folders" maxlength="600" value="${esc((d.rights?.folders||['reports']).join(', '))}" placeholder="reports"></div><div class="form-group"><label for="${p}-tokens">Tokens</label><input class="field" id="${p}-tokens" type="number" min="1" max="${d.budget?.tokens||100000000}" value="${d.budget?.tokens||50000}"></div><div class="form-group"><label for="${p}-msgs">Messages</label><input class="field" id="${p}-msgs" type="number" min="1" max="${d.budget?.messages||1000000}" value="${d.budget?.messages||50}"></div><div class="form-group"><label for="${p}-hours">Hours</label><input class="field" id="${p}-hours" type="number" min="0.1" step="0.1" max="${d.hours||8760}" value="${d.hours||2}"></div></div><div class="cap-tools">${Object.entries(CAP_TOOLS).filter(([t])=>!d.only||d.only.includes(t)).map(([t,n])=>`<label class="check-label"><input type="checkbox" data-cap-tool="${t}" ${tools.includes(t)?'checked':''}><span>${n}</span></label>`).join('')}</div>`;
}
function readCap(p,box){
  const split=v=>String(v||'').split(',').map(s=>s.trim().replace(/\/+$/,'')).filter(Boolean);
  const peer=$(`#${p}-peer`),body={rights:{residents:split($(`#${p}-res`).value),tools:[...box.querySelectorAll('[data-cap-tool]:checked')].map(x=>x.dataset.capTool),folders:split($(`#${p}-folders`).value)},budget:{tokens:Number($(`#${p}-tokens`).value),messages:Number($(`#${p}-msgs`).value)},hours:Number($(`#${p}-hours`).value)};
  if(peer){if(peer.value)body.peerId=peer.value;else{body.publicKey=$(`#${p}-key`).value.trim();body.name=$(`#${p}-name`).value.trim();}}
  return body;
}
function bindCapPeer(p){const s=$(`#${p}-peer`);if(!s)return;s.onchange=()=>{$(`#${p}-key-row`).hidden=!!s.value;$(`#${p}-name-row`).hidden=!!s.value;};}
function showCapToken(rec){
  showModal(`${modalHead('Rights ready to send',esc(rec.audName||'Another silo')+' / '+capLine(rec))}<div class="modal-body"><p>Send this to the owner of ${esc(rec.audName||'that silo')}. It is bound to that silo's key, so no one else can use it, and it cannot be changed without breaking the signature. Valid until ${until(rec.exp)}.</p><textarea class="field cap-token" id="cap-token" readonly rows="5" spellcheck="false" aria-label="The capability">${esc(rec.token)}</textarea></div><div class="modal-footer"><button type="button" class="btn" data-action="close-modal">Done</button><button type="button" class="btn primary" id="cap-copy">${icon('check')} Copy</button></div>`,'token');
  $('#cap-copy').onclick=async()=>{try{await navigator.clipboard.writeText(rec.token);toast('Copied.');}catch{$('#cap-token').select();toast('Select it and copy it.',true);}};
  $('#cap-token').onfocus=e=>e.target.select();
}
function radioSection(rad,owner){
  const peers=rad.peers||[],keys=state.access?.radioKeys||{},prints=state.access?.radioPrints||{},senders=peers.filter(p=>p.send&&(p.publicKey||keys[p.id])),keyed=peers.filter(p=>p.publicKey);
  const when=t=>t?age(t):'never',today=new Date().toISOString().slice(0,10);
  const keyTag=p=>p.publicKey?`key <code>${esc(prints[p.id]||'')}</code>`:keys[p.id]?'<span class="tag-warn">old shared key</span>':'<span class="tag-warn">no key</span>';
  const rows=peers.map(p=>`<div class="user-row radio-peer"><div><strong>${esc(p.name)}</strong><p><code>${esc(p.url)}</code></p><p>${keyTag(p)} · ${[p.send?'sends':'',p.receive?'receives':''].filter(Boolean).join(' & ')||'paused'} · ${p.residents?.length?'only '+p.residents.map(esc).join(', '):'all residents'} · ${p.perHour}/hour${p.tokensPerDay?` · ${num(p.dayUse?.day===today?p.dayUse.tokens:0)} of ${num(p.tokensPerDay)} tokens today`:''}</p><p>Last in ${when(p.lastIn)} · last out ${when(p.lastOut)}</p></div>${owner?`<button class="btn small" data-action="radio-edit" data-id="${p.id}">Edit</button><button class="btn small" data-action="radio-remove" data-id="${p.id}">Remove</button>`:''}</div>`).join('');
  const form=owner?`<form id="radio-peer-form" class="user-form" autocomplete="off"><input type="hidden" id="rp-id"><h4 id="rp-title">Add a silo</h4><div class="form-grid"><div class="form-group"><label for="rp-name">Name</label><input class="field" id="rp-name" maxlength="40" required placeholder="Silo 17"></div><div class="form-group"><label for="rp-url">Address</label><input class="field" id="rp-url" maxlength="300" required placeholder="https://silo-17.example.com"></div><div class="form-group"><label for="rp-pub">Its key</label><input class="field" id="rp-pub" maxlength="60" spellcheck="false" placeholder="ed25519:... (Read key fills it)"></div><div class="form-group"><label for="rp-hour">Messages an hour from them</label><input class="field" id="rp-hour" type="number" min="1" max="600" value="30"></div><div class="form-group"><label for="rp-day">Tokens a day for them (0: no limit)</label><input class="field" id="rp-day" type="number" min="0" max="100000000" value="0"></div><div class="form-group"><label for="rp-key">Shared key (only for an older SILO)</label><input class="field" id="rp-key" maxlength="300" spellcheck="false" placeholder="Leave empty when it has a key"></div></div><p class="mono-line" id="rp-print"></p><div class="form-group"><label for="rp-res">Residents they may reach (empty: all)</label><input class="field" id="rp-res" maxlength="1000" placeholder="e.g. Juliette, IT"></div><label class="check-label"><input type="checkbox" id="rp-send" checked><span>Send to this silo</span></label><label class="check-label"><input type="checkbox" id="rp-receive" checked><span>Take transmissions from this silo</span></label><div class="heading-actions"><button type="button" class="btn" data-action="radio-lookup">Read key</button><button type="button" class="btn" data-action="radio-genkey">Shared key</button><button type="button" class="btn" data-action="radio-cancel" id="rp-cancel" hidden>Cancel</button><button type="submit" class="btn primary">Save silo</button></div></form>`:'';
  const test=senders.length?`<h4>Test transmission</h4><div class="form-grid"><div class="form-group"><label for="radio-peer">To silo</label><select class="select" id="radio-peer">${senders.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div><div class="form-group"><label for="radio-to">Resident there</label><input class="field" id="radio-to" maxlength="60" placeholder="Exact name or role"></div></div><div class="form-group"><label for="radio-msg">Message</label><input class="field" id="radio-msg" maxlength="1000" placeholder="Status check from ${esc(rad.siloId||'Silo 18')}"></div><div class="heading-actions">${button('Transmit','send-radio')}</div><div id="radio-reply" class="mono-line"></div>`:'';
  const identity=rad.publicKey?`<div class="form-group"><label for="radio-pub">This silo's key</label><div class="copy-row"><input class="field" id="radio-pub" readonly value="${esc(rad.publicKey)}" spellcheck="false"><button type="button" class="btn" data-action="radio-copy-key">Copy</button></div><p class="mono-line">Fingerprint <strong>${esc(rad.fingerprint||'')}</strong>. Read it to the other owner by phone or in person, so they know the key they added is yours.</p></div>`:'<p class="mono-line tag-warn">This silo has no radio key. Check the vault.</p>';
  const given=(rad.issued||[]).slice(0,30).map(c=>{const left=capLeft(c,rad);return `<div class="user-row wrap-row"><div><strong>${esc(c.audName||'Another silo')}</strong> ${capState(c)}${c.sub?' <small>passed on</small>':''}<p>${capLine(c)}</p><p>${left?`${num(left.tokens)} of ${num(c.budget.tokens)} tokens, ${num(left.messages)} of ${num(c.budget.messages)} messages left`:`${num(c.budget.tokens)} tokens, ${num(c.budget.messages)} messages, counted by the silo that owns the data`} · until ${until(c.exp)}</p></div>${owner&&c.token&&!c.revoked&&c.exp>Date.now()?`<button class="btn small" data-action="cap-copy" data-hash="${c.hash}">Copy</button><button class="btn small" data-action="cap-revoke" data-hash="${c.hash}">Revoke</button>`:''}</div>`;}).join('');
  const held=(rad.held||[]).slice(0,30).map(h=>{const left=capLeft(h,rad);return `<div class="user-row wrap-row"><div><strong>From ${esc(h.rootName||'another silo')}</strong> ${capState(h)}${h.links>1?` <small>through ${h.links-1} other${h.links>2?'s':''}</small>`:''}<p>${capLine(h)}</p><p>${left?`${num(left.tokens)} tokens, ${num(left.messages)} messages left`:''} · until ${until(h.exp)}</p></div>${owner?`${h.exp>Date.now()?`<button class="btn small" data-action="held-delegate" data-id="${h.id}">Pass on</button>`:''}<button class="btn small" data-action="held-remove" data-id="${h.id}">Remove</button>`:''}</div>`;}).join('');
  const giveForm=owner&&rad.publicKey?`<form id="cap-form" class="user-form" autocomplete="off"><h4>Give rights to another silo</h4><p class="mono-line">It may use these residents with these tools and folders, until the time or the budget runs out. It can pass on less, never more. You can take it back at any time.</p>${capFields('cap',{},keyed)}<div class="heading-actions"><button type="submit" class="btn primary">Give rights</button></div></form>`:'';
  const takeForm=owner&&rad.publicKey?`<form id="held-form" class="user-form" autocomplete="off"><h4>Use rights another silo gave you</h4><div class="form-group"><label for="held-token">Capability</label><textarea class="field cap-token" id="held-token" rows="3" spellcheck="false" placeholder="silocap1...." required></textarea></div><div class="form-grid"><div class="form-group"><label for="held-url">Its address, if it is not in the capability</label><input class="field" id="held-url" maxlength="300" placeholder="https://silo-18.example.com"></div><div class="form-group"><label for="held-name">Name for it here</label><input class="field" id="held-name" maxlength="40" placeholder="Silo 18"></div></div><div class="heading-actions"><button type="submit" class="btn primary">Add</button></div></form>`:'';
  const logRows=(state.radioLog||[]).slice(0,20).map(e=>`<li><time>${until(e.time)}</time> ${e.dir==='in'?'&larr;':'&rarr;'} ${esc(e.peer||'')}${e.resident?' / '+esc(e.resident):''}${e.cap?' · capability':''}${e.tokens?' · '+num(e.tokens)+' tokens':''}${e.ok?'':` · <span class="tag-warn">refused</span> ${esc(e.why||'')}`}</li>`).join('');
  return `<section class="settings-card" id="radio-card"><h3>Silo-to-Silo Radio</h3><p>Talk to residents of other SILO instances. Each silo has its own key and signs what it sends, so no secret is shared and each silo knows who is talking. You can give another silo rights here, for some residents, tools and folders, for a time and a budget.</p><label class="check-label"><input type="checkbox" id="radio-enabled" ${rad.enabled?'checked':''} ${owner?'':'disabled'}><span>Radio on</span></label><div class="form-grid"><div class="form-group"><label for="radio-silo-id">This silo's name</label><input class="field" id="radio-silo-id" maxlength="40" value="${esc(rad.siloId||'Silo 18')}" ${owner?'':'disabled'}></div><div class="form-group"><label for="radio-address">Address other silos reach it at</label><input class="field" id="radio-address" maxlength="300" value="${esc(rad.address||'')}" placeholder="http://192.168.1.20:3000 or https://silo.example.com" ${owner?'':'disabled'}></div></div><p class="mono-line tag-warn" id="radio-save-note" role="alert"></p>${identity}<h4>Map</h4>${radioMap(rad)}<h4>Other silos</h4>${rows?`<div class="user-list">${rows}</div>`:'<p class="mono-line">No other silos yet.</p>'}${form}<h4>Rights given</h4>${given?`<div class="user-list">${given}</div>`:'<p class="mono-line">None yet.</p>'}${giveForm}<h4>Rights held</h4>${held?`<div class="user-list">${held}</div>`:'<p class="mono-line">None yet.</p>'}${takeForm}<h4>On the air</h4>${logRows?`<ul class="radio-log">${logRows}</ul>`:'<p class="mono-line">Nothing yet.</p>'}${test}</section>`;
}
// Saves only what changed, so a wrong address never undoes turning the radio on or a new name. A field that is
// refused keeps what was typed and says why under it.
async function saveRadio(radio,field){
  const note=$('#radio-save-note');
  try{await post('/settings',{radio});await refresh();toast(radio.enabled===true?'Radio on.':radio.enabled===false?'Radio off.':'Radio saved.');loadSystemInfo();}
  catch(e){if(note)note.textContent=e.message;field?.setAttribute('aria-invalid','true');field?.focus();if(field?.type==='checkbox')field.checked=!field.checked;toast(e.message,true);}
}
function bindRadioForm(){
  const f=$('#radio-peer-form');
  if(f)f.onsubmit=async e=>{
    e.preventDefault();const id=$('#rp-id').value,key=$('#rp-key').value.trim(),pub=$('#rp-pub').value.trim();
    const body={name:$('#rp-name').value,url:$('#rp-url').value,perHour:Number($('#rp-hour').value),tokensPerDay:Number($('#rp-day').value||0),residents:$('#rp-res').value,send:$('#rp-send').checked,receive:$('#rp-receive').checked,...(key&&{key}),...(pub&&{publicKey:pub})};
    try{await post('/radio/peers'+(id?'/'+id:''),body);toast(id?'Silo saved.':pub?'Silo added. Give it this silo\'s key too.':'Silo added. Give the same key to the other silo.');await refresh();loadSystemInfo();}catch(err){toast(err.message,true);}
  };
  const g=$('#cap-form');bindCapPeer('cap');
  if(g)g.onsubmit=async e=>{e.preventDefault();try{const rec=await post('/radio/caps',readCap('cap',g));await refresh();loadSystemInfo();showCapToken(rec);}catch(err){toast(err.message,true);}};
  const h=$('#held-form');
  if(h)h.onsubmit=async e=>{e.preventDefault();try{const rec=await post('/radio/held',{token:$('#held-token').value.trim(),url:$('#held-url').value.trim(),name:$('#held-name').value.trim()});toast(`Added. You can now reach ${rec.rootName||'that silo'} with these rights.`);await refresh();loadSystemInfo();}catch(err){toast(err.message,true);}};
}
// Outside programs: SILO as an MCP server and an A2A agent, with ready configs to copy. No token is ever put in them.
let snippets=[];
function outsideSection(owner){
  const e=state.settings.expose||{residents:[],workflows:[]},base=location.origin,mcpUrl=base+'/api/serve/mcp',dis=owner?'':'disabled';
  // The chosen ones first, in a box that scrolls: a silo can have hundreds of residents.
  const pick=(list,cls,chosen)=>list.length?`<div class="check-grid expose-pick">${[...list].sort((a,b)=>chosen.includes(b.id)-chosen.includes(a.id)).map(x=>`<label class="check-label"><input type="checkbox" class="${cls}" value="${x.id}" ${chosen.includes(x.id)?'checked':''} ${dis}><span>${esc(x.name)}${x.role?' · '+esc(x.role):''}</span></label>`).join('')}</div>`:'<p class="mono-line">None yet.</p>';
  snippets=[
    ['Claude Code',`claude mcp add --transport http silo ${mcpUrl} --header "Authorization: Bearer $SILO_TOKEN"`],
    ['Cursor (.cursor/mcp.json)',JSON.stringify({mcpServers:{silo:{url:mcpUrl,headers:{Authorization:'Bearer ${env:SILO_TOKEN}'}}}},null,2)],
    ['Claude Desktop (claude_desktop_config.json)',JSON.stringify({mcpServers:{silo:{command:'npx',args:['-y','mcp-remote',mcpUrl,'--header','Authorization:${AUTH_HEADER}'],env:{AUTH_HEADER:'Bearer silo_pat_PUT_YOUR_TOKEN_HERE'}}}},null,2)],
    ['LangGraph (langchain-mcp-adapters)',`import os\nfrom langchain_mcp_adapters.client import MultiServerMCPClient\n\nclient = MultiServerMCPClient({"silo": {"transport": "streamable_http", "url": "${mcpUrl}",\n    "headers": {"Authorization": "Bearer " + os.environ["SILO_TOKEN"]}}})\ntools = await client.get_tools()`],
    ['Python SDK (pip install silo-os)',`from silo_os import Silo\nsilo = Silo("${base}")  # SILO_TOKEN from the environment\nprint(silo.ask("${(state.agents.find(a=>a.id===e.residents[0])?.name||'Atlas').replace(/["\\]/g,'')}", "Hello").text)`],
    ['A2A Agent Card',base+'/.well-known/agent-card.json'],
  ];
  const shown=`<div class="snippet"><div class="snippet-head"><select class="select" id="snippet-pick" aria-label="Program">${snippets.map(([label],i)=>`<option value="${i}">${esc(label)}</option>`).join('')}</select><button type="button" class="btn small" data-action="copy-snippet">Copy</button></div><pre class="snippet-code" id="snippet-code">${esc(snippets[0][1])}</pre></div>`;
  const peers=state.settings.a2aPeers||[],keys=state.access?.a2aKeys||{};
  const rows=peers.map(p=>`<div class="user-row wrap-row"><div><strong>${esc(p.name)}</strong><p><code>${esc(p.endpoint)}</code>${p.version?' · A2A '+esc(p.version):''}${keys[p.id]?'':' · no token'}</p><p>${p.skills?.length?p.skills.slice(0,6).map(s=>esc(s.name||s.id)).join(', ')+(p.skills.length>6?' …':''):'No skills listed'} · used ${p.lastUsed?age(p.lastUsed):'never'}</p></div>${owner?`<button class="btn small" data-action="a2a-refresh" data-id="${p.id}">Refresh</button><button class="btn small" data-action="a2a-remove" data-id="${p.id}">Remove</button>`:''}</div>`).join('');
  const form=owner?`<form id="a2a-peer-form" class="user-form" autocomplete="off"><h4>Add an outside agent</h4><div class="form-grid"><div class="form-group"><label for="a2a-address">Address of the agent or its card</label><input class="field" id="a2a-address" maxlength="500" required placeholder="https://agent.example.com"></div><div class="form-group"><label for="a2a-name">Name (optional)</label><input class="field" id="a2a-name" maxlength="40" placeholder="From its card"></div><div class="form-group"><label for="a2a-token">Token (optional)</label><input class="field" id="a2a-token" type="password" maxlength="4000" spellcheck="false" autocomplete="off" placeholder="Bearer token it gave you"></div></div><div class="heading-actions"><button class="btn primary">Add agent</button></div></form>`:'';
  return `<section class="settings-card" id="outside-card"><h3>Outside programs</h3><p>Let other AI programs use this SILO. As an <strong>MCP server</strong>, Claude Desktop, Claude Code, Cursor, LangGraph or CrewAI get one tool per resident and workflow you pick. As an <strong>A2A agent</strong>, agents from other frameworks find it by its card and send it tasks. Callers need an API token: its scopes decide what they may do (read lists, run asks and runs, approve decides), and residents still ask you before tools that need your OK. Questions from outside do not change a resident's chat.</p>
  <div class="check-grid"><label class="check-label"><input type="checkbox" id="expose-mcp" ${e.mcp?'checked':''} ${dis}><span>MCP server at <code>/api/serve/mcp</code></span></label><label class="check-label"><input type="checkbox" id="expose-a2a" ${e.a2a?'checked':''} ${dis}><span>A2A agent, card at <code>/.well-known/agent-card.json</code></span></label></div>
  <h4>Residents they may ask</h4>${pick(state.agents,'expose-res',e.residents)}<h4>Workflows they may run</h4>${pick(state.workflows,'expose-flow',e.workflows)}
  <div class="form-grid"><div class="form-group"><label for="expose-front">A2A messages without a skill go to</label><select class="select" id="expose-front" ${dis}><option value="">Nobody: they must name a skill</option>${state.agents.filter(a=>e.residents.includes(a.id)).map(a=>`<option value="${a.id}" ${e.front===a.id?'selected':''}>${esc(a.name)}</option>`).join('')}</select></div><div class="form-group"><label for="expose-desc">Description on the card</label><input class="field" id="expose-desc" maxlength="300" value="${esc(e.description||'')}" placeholder="A team of AI residents…" ${dis}></div></div>
  <p class="mono-line">The A2A card is public while the agent is on: anyone who can open this SILO sees the names of what you pick here.</p>
  ${owner?`<div class="heading-actions">${button('Save','save-expose',true)}</div>`:''}
  <h4>Connect a program</h4><p>Make a token in API tokens above and put it where the config says <code>SILO_TOKEN</code>.</p>${shown}
  <h4>Outside agents residents may ask</h4><p>Residents with the <code>delegate</code> permission can send tasks to these A2A agents with <code>ask_agent</code>. You approve the first task to each agent; what they send back is marked as untrusted.</p>${rows?`<div class="user-list">${rows}</div>`:'<p class="mono-line">No outside agents yet.</p>'}${form}</section>`;
}
function bindOutsideForms(){
  const sp=$('#snippet-pick');if(sp)sp.onchange=()=>{$('#snippet-code').textContent=snippets[Number(sp.value)]?.[1]||'';};
  const f=$('#a2a-peer-form');if(!f)return;
  f.onsubmit=async ev=>{
    ev.preventDefault();const btn=ev.submitter;if(btn)btn.disabled=true;
    const token=$('#a2a-token').value.trim(),name=$('#a2a-name').value.trim();
    try{const r=await post('/a2a/peers',{address:$('#a2a-address').value.trim(),...(name&&{name}),...(token&&{token})});toast(`${r.peer.name} added with ${r.peer.skills?.length||0} skills.`);await refresh();loadSystemInfo();}
    catch(err){toast(err.message,true);if(btn)btn.disabled=false;}
  };
}
// Notebooks of the residents: cells and outputs as Jupyter keeps them.
async function loadNotebooksCard(){
  const box=$('#notebooks-card');if(!box)return;
  let d;try{d=await api('/notebooks');}catch(e){box.innerHTML=`<h3>Notebooks</h3><p class="modal-error">${esc(e.message)}</p>`;return;}
  if(!box.isConnected)return;
  const canRun=!me||me.role!=='viewer';
  const rows=d.notebooks.map(n=>`<div class="user-row wrap-row"><div><strong>${esc(n.agentName)} / ${esc(n.name)}</strong><p>${n.running?'kernel running':'kernel stopped'} · ${(n.size/1024).toFixed(1)} KB · changed ${age(n.modified)}</p></div><button class="btn small" data-action="notebook-open" data-agent="${n.agentId}" data-name="${esc(n.name)}">Open</button>${canRun?`${n.running?`<button class="btn small" data-action="notebook-restart" data-agent="${n.agentId}" data-name="${esc(n.name)}">Restart</button>`:''}<button class="btn small" data-action="notebook-archive" data-agent="${n.agentId}" data-name="${esc(n.name)}">Save to Archive</button><button class="btn small" data-action="notebook-delete" data-agent="${n.agentId}" data-name="${esc(n.name)}">Delete</button>`:''}</div>`).join('');
  box.innerHTML=`<h3>Notebooks</h3><p>Residents with the run code permission use <code>notebook_run</code>: a Python kernel that keeps its variables between cells, like Jupyter, on a copy of the workspace. You approve each cell as with run code. A kernel stops after 15 minutes without use; the cells stay, saved as <code>.ipynb</code>.</p>${rows?`<div class="user-list">${rows}</div>`:'<p class="mono-line">No notebooks yet.</p>'}`;
}
const nbText=v=>Array.isArray(v)?v.join(''):String(v??'');
function notebookHtml(nb){
  return (nb.cells||[]).map(c=>{
    if(c.cell_type==='markdown')return `<div class="nb-note">${esc(nbText(c.source))}</div>`;
    const outs=(c.outputs||[]).map(o=>{
      if(o.output_type==='stream')return `<pre class="nb-out${o.name==='stderr'?' err':''}">${esc(nbText(o.text))}</pre>`;
      if(o.output_type==='error')return `<pre class="nb-out err">${esc(o.traceback?.length?o.traceback.join('\n'):o.ename+': '+o.evalue)}</pre>`;
      const png=o.data?.['image/png'];
      if(typeof png==='string'&&/^[A-Za-z0-9+/=\s]+$/.test(png))return `<img class="nb-img" alt="Figure" src="data:image/png;base64,${png.replace(/\s/g,'')}">`;
      return `<pre class="nb-out">${o.execution_count?`<span class="nb-count">Out[${o.execution_count}]</span> `:''}${esc(nbText(o.data?.['text/plain']))}</pre>`;
    }).join('');
    return `<div class="nb-cell"><span class="nb-count">In [${c.execution_count??' '}]</span><pre class="nb-code">${esc(nbText(c.source))}</pre>${outs}</div>`;
  }).join('')||'<p class="mono-line">No cells yet.</p>';
}
async function openNotebook(agentId,name){
  try{
    const d=await api(`/notebooks/${encodeURIComponent(agentId)}/${encodeURIComponent(name)}`),a=getAgent(agentId);
    showModal(`${modalHead(esc((a?.name||'Resident')+' / '+name),d.running?'Kernel running':'Kernel stopped')}<div class="modal-body nb-view">${notebookHtml(d.notebook)}</div><div class="modal-footer"><button type="button" class="btn" data-action="close-modal">Close</button></div>`,'notebook');
  }catch(e){toast(e.message,true);}
}
// A new Python tool: a FastMCP server from the template, added as a connector.
function openPythonToolEditor(){
  showModal(`${modalHead('Add a Python tool','A FastMCP server in the workspace, added as a connector.')}<form id="pytool-form"><div class="modal-body"><p class="mono-line" style="line-height:1.8">SILO writes <code>tools/&lt;name&gt;/server.py</code> with two example tools, a <code>requirements.txt</code> and a README, and adds it as a program connector. Change the functions in <code>server.py</code>, then press Refresh on the connector. It runs on this computer with your rights; residents ask you before each call.</p><div class="form-group"><label for="pytool-name">Name</label><input class="field" id="pytool-name" maxlength="40" required placeholder="Text tools" autocomplete="off"></div><div class="form-group"><label for="pytool-desc">What it is for</label><input class="field" id="pytool-desc" maxlength="300" placeholder="Counts words and adds numbers."></div><label class="check-label"><input type="checkbox" id="pytool-install"><span>Install it now: a virtual environment in <code>.venv</code> and <code>pip install mcp</code> from PyPI (needs internet, about a minute)</span></label></div><div class="modal-footer"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn primary">Add tool</button></div></form>`,'pytool');
  $('#pytool-form').onsubmit=async ev=>{
    ev.preventDefault();const btn=ev.submitter;if(btn)btn.disabled=true;
    try{
      const r=await post('/python-tools',{name:$('#pytool-name').value,description:$('#pytool-desc').value,install:$('#pytool-install').checked});
      modal.close();await refresh();
      toast(r.installing?'Tool written. Installing its packages; Activity says when it is ready.':r.error?'Tool written. Install the mcp package to start it: see its README.':`Tool added with ${r.tools} tools.`,!!r.error&&!r.installing);
    }catch(err){toast(err.message,true);if(btn)btn.disabled=false;}
  };
}
// System: sandbox, web search and meaning search over the Archive.
async function loadSystemInfo(){
  const box=$('#system-live');if(!box)return;
  const owner=!me||me.role==='owner';
  const [sb,ar,up,au,ot,so]=await Promise.all([api('/sandbox').catch(e=>({error:e.message})),api('/archive').catch(e=>({error:e.message})),owner?api('/system/update').catch(()=>null):null,owner?api('/audit?limit=15').catch(()=>null):null,owner?api('/otel').catch(()=>null):null,owner?api('/sso').catch(()=>null):null]);
  if(view!=='settings'||!$('#system-live'))return;
  const st=state.settings||{},se=st.search||{},em=st.embeddings||{},pact=st.pact||{enabled:true,rules:'',maxChars:0},caf=st.cafeteria||'auto',pwr=st.power||[1,1,1,1,1,1],rad=st.radio||{enabled:false,siloId:'Silo 18',url:''},w=state.pulse?.weather;
  const sbLine=sb.error?esc(sb.error):sb.using==='docker'?'Code runs in a Docker container without network, 512 MB memory and one CPU.':sb.using==='local'?`Docker is ${sb.docker?'available but not chosen':'not installed'}. Code runs as a local process on a copy of the workspace, with a short time limit. This is not a full sandbox, so keep "ask first" on.`:sb.using==='missing'?'Docker is chosen but not installed, so code cannot run. Install Docker Desktop or pick local.':'Running code is turned off.';
  const pactCard=`<section class="settings-card"><h3>The Pact, Whisper Network &amp; Generator 01</h3><p>The Pact is the global constitution of the silo: every resident receives its articles before any mission or workflow step. The Whisper Network lets notes saved on a gallery spread to nearby residents on the same and adjacent levels. Generator 01 routes power per sector (dimming 3D gallery lights and deferring scheduled runs in powered-down sectors).</p><label class="check-label"><input type="checkbox" id="pact-enabled" ${pact.enabled!==false?'checked':''}> Enforce The Pact across all 144 levels</label><div class="form-group"><label for="pact-rules">Articles of The Pact</label><textarea class="field" id="pact-rules" rows="4" maxlength="4000">${esc(pact.rules||'')}</textarea></div><div class="form-grid"><div class="form-group"><label for="pact-max">Max characters per answer (0 = no cap)</label><input class="field" id="pact-max" type="number" min="0" max="100000" step="100" value="${pact.maxChars||0}"></div><div class="form-group"><label for="caf-mode">Cafeteria Wall projection (L001)</label><select class="select" id="caf-mode">${[['auto','Auto from Silo health'],['toxic','Toxic dust'],['dawn','Dawn horizon'],['clearing','Clearing sky'],['green','Lush green projection']].map(([k,n])=>`<option value="${k}" ${caf===k?'selected':''}>${n}</option>`).join('')}</select></div></div><label class="check-label"><input type="checkbox" id="whispers-toggle" ${st.whispers!==false?'checked':''}> Whisper Network: share new notes with neighbors on the gallery</label><div class="form-group" style="margin-top:8px"><label>Generator 01 sector power routing</label><div class="check-grid">${state.floors.map((f,i)=>`<label class="check-label"><input type="checkbox" data-sector-power="${i}" ${pwr[i]!==0?'checked':''}> ${String(i+1).padStart(2,'0')} ${esc(f.name)}</label>`).join('')}</div></div><p class="mono-line">Surface clarity: ${Math.round((w?.clarity??.5)*100)}% (${esc(w?.mode||'auto')}) · 24h runs: ${w?.ok24h||0} ok / ${w?.bad24h||0} failed</p><div class="heading-actions">${button('Save Pact, projection & power','save-pact',true)}</div></section>`;
  const radioCard=radioSection(rad,owner);
  box.innerHTML=pactCard+radioCard+outsideSection(owner)+'<section class="settings-card" id="notebooks-card"><h3>Notebooks</h3><p>Loading notebooks...</p></section>'+`<section class="settings-card"><h3>Code sandbox</h3><p>Residents with the run code permission can run Python, JavaScript or shell code. You approve every run in Signals unless you trust that resident. Changed files come back as proposals in the Archive.</p><div class="form-group"><label for="sb-mode">Where code runs</label><select class="select" id="sb-mode"><option value="auto">Docker when installed, otherwise local</option><option value="docker">Docker only</option><option value="local">Local process</option><option value="off">Off</option></select></div><p class="mono-line">${sbLine}</p>${sb.local?`<p class="mono-line">${Object.entries(sb.local).map(([k,v])=>esc(k)+': '+(v?'ready':'not found')).join(' · ')}</p>`:''}</section><section class="settings-card"><h3>Web search</h3><p>Residents with web access search with this engine. DuckDuckGo needs no key. Brave and Tavily need a key from their site. SearXNG is a server you run yourself.</p><div class="form-group"><label for="se-engine">Engine</label><select class="select" id="se-engine">${[['duckduckgo','DuckDuckGo'],['brave','Brave Search'],['tavily','Tavily'],['searxng','SearXNG']].map(([k,n])=>`<option value="${k}" ${se.engine===k?'selected':''}>${n}</option>`).join('')}</select></div><div class="form-group" id="se-key-row"><label for="se-key">API key</label><input class="field" id="se-key" type="password" autocomplete="off" placeholder="${ar.searchKey?'Saved. Leave empty to keep it.':'Key from the engine site'}"></div><div class="form-group" id="se-url-row"><label for="se-url">SearXNG address</label><input class="field" id="se-url" value="${esc(se.url||'')}" placeholder="http://127.0.0.1:8888"></div><div class="heading-actions">${button('Save','save-search',true)}${button('Try a search','try-search')}</div><div id="search-try" class="mono-line"></div></section><section class="settings-card"><h3>Meaning search in the Archive</h3><p>Residents with file access can search the workspace by meaning, not only by words. That needs an embedding model. Without one, search uses keywords.</p><div class="form-grid"><div class="form-group"><label for="em-provider">Embeddings from</label><select class="select" id="em-provider">${[['off','Off, keywords only'],['openai','OpenAI'],['ollama','Ollama on this computer'],['compatible','Compatible endpoint']].map(([k,n])=>`<option value="${k}" ${em.provider===k?'selected':''}>${n}</option>`).join('')}</select></div><div class="form-group"><label for="em-model">Model</label><input class="field" id="em-model" value="${esc(em.model||'')}" placeholder="text-embedding-3-small or nomic-embed-text"></div></div><p class="mono-line">${ar.error?esc(ar.error):`${ar.files||0} files · ${ar.pieces||0} pieces · ${ar.withMeaning||0} with meaning${ar.model?' · '+esc(ar.model):''}`}</p><div class="heading-actions">${button('Save','save-embeddings',true)}</div></section>`+voiceCard()+aiCard()+(up?updateCard(up):'')+(au?auditCard(au):'')+(ot?otelCard(ot):'')+(so?ssoCard(so):'');fillVoiceList();if(!aiState)checkAi();
  // Radio on and the silo's name are saved as soon as they change, like the other switches on this page.
  if(owner){$('#radio-enabled').onchange=e=>saveRadio({enabled:e.target.checked},e.target);$('#radio-silo-id').onchange=e=>saveRadio({siloId:e.target.value.trim()||'Silo 18'},e.target);$('#radio-address').onchange=e=>saveRadio({address:e.target.value.trim()},e.target);}
  bindRadioForm();bindOutsideForms();loadNotebooksCard();
  box.insertAdjacentHTML('afterbegin',accessCard()+'<section class="settings-card" id="remote-card"><h3>Open from anywhere</h3><p>Checking remote access...</p></section><section class="settings-card" id="tokens-card"><h3>API tokens</h3><p>Loading tokens...</p></section>');loadRemoteCard();loadTokensCard();box.insertAdjacentHTML('beforeend',`<section class="settings-card"><h3>Windows notifications</h3><p>A card in the corner of the screen when something happens. For approval requests the card has Allow and Deny buttons: they open a page in your browser where you confirm.</p><label class="check-label"><input type="checkbox" id="desktop-enabled" ${st.desktop?.enabled?'checked':''}> Show Windows notifications</label><div class="check-grid">${Object.entries(state.notifyEvents||{}).map(([k,n])=>`<label class="check-label"><input type="checkbox" class="desktop-event" value="${k}" ${(st.desktop?.events||[]).includes(k)?'checked':''}> ${esc(n)}</label>`).join('')}</div><div class="heading-actions">${button('Show a test','desktop-test')}</div></section><section class="settings-card" id="browser-card"><h3>Browser for residents</h3><p>Looking for Edge or Chrome...</p></section><section class="settings-card"><h3>Sound</h3><p>The siren sounds when a workflow fails. The red light in the silo and the message show either way.</p><label class="check-label"><input type="checkbox" id="sound-toggle" ${soundOn()?'checked':''}> Play the siren</label></section>`);loadBrowserCard();
  $('#sb-mode').value=st.sandbox||'auto';$('#sb-mode').onchange=async e=>{try{await post('/settings',{sandbox:e.target.value});await refresh();toast('Sandbox setting saved.');loadSystemInfo();}catch(err){toast(err.message,true);}};
  const syncEngine=()=>{const e=$('#se-engine').value;$('#se-key-row').hidden=!['brave','tavily'].includes(e);$('#se-url-row').hidden=e!=='searxng';};syncEngine();$('#se-engine').onchange=syncEngine;
}

const DAYS=['SU','MO','TU','WE','TH','FR','SA'];
function dayList(d=[]){const k=String(d);return k==='1,2,3,4,5'?'MON TO FRI':k==='0,1,2,3,4,5,6'?'EVERY DAY':d.map(x=>DAYS[x]).join(' ');}
// Events waiting to start this workflow, why they wait, and any that were dropped, skipped or given up on.
function queueLine(w){
  const q=w.queue;if(!q)return '';
  const lost=(q.dropped||0)+(q.gaveUp||0),parts=[];
  if(q.waiting)parts.push(`<strong>${q.waiting} event${q.waiting===1?'':'s'} waiting</strong>${q.waiting>=q.max?' (the queue is full: a new one pushes out the oldest)':''}${q.oldest?', the oldest since '+esc(age(q.oldest)):''}. ${esc(q.why||'They start at the next check.')}`);
  if(lost)parts.push(`<span class="tag-warn">${lost} lost</span>: ${q.dropped?q.dropped+' dropped because the queue was full':''}${q.dropped&&q.gaveUp?', ':''}${q.gaveUp?q.gaveUp+' given up after 5 failed starts':''}${q.lastLost?', the last '+esc(age(q.lastLost.time)):''}.`);
  if(q.skipped)parts.push(`${q.skipped} skipped while busy, as set in its triggers.`);
  return parts.length?`<div class="queue-line">${icon('clock')} ${parts.join(' ')}</div>`:'';
}
function triggerBadges(w){const t=[];if(w.enabled)t.push(w.mode==='daily'?`DAILY ${w.at} / ${dayList(w.days)}`:`EVERY ${w.interval} MIN`);if(w.hook)t.push('WEBHOOK');if(w.watch)t.push(`WATCHING ${w.watch.toUpperCase()}/`);if(w.mail)t.push(w.mailError?'EMAIL: CHECK FAILED':'EMAIL');if(w.app){const at=(state.appTriggers||[]).find(x=>x.kind===w.app.kind);t.push(w.appError?'APP: CHECK FAILED':(at?.label||'APP').toUpperCase());}if(w.budget)t.push(`MAX ${w.budget} TOKENS`);return t.length?t:['ON DEMAND'];}
const whenText=w=>`IF ${w.step?'STEP '+pad2(w.step):'PREVIOUS'} ${w.op==='missing'?'LACKS':'SAYS'} "${w.text}"`;
const ACCOUNT_NAMES={google:'Google',microsoft:'Microsoft 365',slack:'Slack',github:'GitHub',notion:'Notion'};
const appNameOf=id=>String(id||'').startsWith('svc:')?ACCOUNT_NAMES[id.slice(4)]||id.slice(4):state.mcp?.find(c=>'mcp:'+c.id===id)?.name||'Removed app';
function flowNode(s,i){
  const type=s.type||'agent',a=getAgent(s.agentId);
  const each=s.each?`<span class="flow-each">FOR EACH IN ${esc(s.each)}</span>`:'';
  if(type==='wait')return `<div class="flow-node wait"><span class="step-index">STEP ${pad2(i+1)} / WAIT</span>${s.when?`<span class="flow-when">${esc(whenText(s.when))}</span>`:''}<strong>Wait</strong><p>${esc(waitText(s))}</p></div>`;
  if(type==='action'){const f=Object.entries(s.fields||{});return `<div class="flow-node action"><span class="step-index">STEP ${pad2(i+1)} / APP</span>${each}${s.when?`<span class="flow-when">${esc(whenText(s.when))}</span>`:''}<strong>${esc(appNameOf(s.app))}</strong><p>${esc((String(s.op||'').replace(/_/g,' ')+(f.length?': '+f.map(([k,v])=>k.replace(/^body\./,'')+' '+v).join(', '):'')).slice(0,110))}</p></div>`;}
  const label=type==='review'?`STEP ${pad2(i+1)} / REVIEW / BACK TO ${pad2(s.target)} / ${s.rounds}x`:type==='approval'?`STEP ${pad2(i+1)} / APPROVAL`:`STEP ${pad2(i+1)} / ${esc(a?.provider||'missing')}`;
  const text=type==='approval'?(s.prompt||'Waits for your OK.'):s.prompt;
  return `<div class="flow-node ${type}"><span class="step-index">${label}</span>${each}${s.when?`<span class="flow-when">${esc(whenText(s.when))}</span>`:''}<strong>${type==='approval'?'You':esc(a?.name||'Missing resident')}</strong><p>${esc(text.slice(0,110))}</p></div>`;
}
// Steps that run at the same time are stacked in one column.
function flowNodes(steps){
  const out=[];let i=0;
  while(i<steps.length){let h=i;while((steps[i].type||'agent')==='agent'&&h+1<steps.length&&steps[h+1].parallel)h++;const nodes=[];for(let k=i;k<=h;k++)nodes.push(flowNode(steps[k],k));out.push((i?'<span class="flow-arrow">⟶</span>':'')+(h>i?`<div class="flow-group"><span class="flow-group-label">SAME TIME</span>${nodes.join('')}</div>`:nodes[0]));i=h+1;}
  return out.join('');
}
const TRIGGER_NAME={schedule:'scheduled',webhook:'webhook',file:'file',replay:'replay',test:'test',email:'email',phone:'phone'};
const runLabel=r=>r.status==='check'?'check needed':r.waiting?'waiting for you':r.status==='running'&&r.current?.type==='wait'&&r.current.until?'waits until '+whenAt(r.current.until):r.status;
function runHistory(){return state.runs.length?`<div class="section-card">${state.runs.slice(0,15).map(r=>`<div class="activity-row${r.waiting||r.status==='check'?' waiting':''}"><span class="event-icon">${icon(r.waiting||r.status==='check'||r.current?.type==='wait'?'clock':r.status==='completed'?'check':r.status==='running'?'activity':'close')}</span><div><strong>${esc(r.name)}</strong><p>${esc(runLabel(r))} ${checkTag(r)} · ${r.total||r.steps.length} steps${TRIGGER_NAME[r.trigger]?' · '+TRIGGER_NAME[r.trigger]:''}${r.error?' · '+esc(r.error):''}</p></div><time>${age(r.started)}</time><button class="btn small" data-action="trail-run" data-id="${r.id}" title="Show this run as a trail in the silo">Trail</button><button class="btn small" data-action="view-run" data-id="${r.id}">Open</button></div>`).join('')}</div>`:'<div class="section-card empty">No runs yet.</div>';}
const providerInfo={openai:['OpenAI','◎','Uses the OpenAI Responses API.','OpenAI model ID'],anthropic:['Anthropic','✳','Uses the Anthropic Messages API.','Claude model ID'],ollama:['Ollama','◉','Local models through Ollama at 127.0.0.1:11434.','Installed Ollama model name'],compatible:['Custom provider','⌘','Any HTTPS endpoint that speaks the OpenAI chat completions format.','Provider model ID']};
function itBoard(){const count=p=>state.agents.filter(a=>a.provider===p).length,runs=state.runs.filter(r=>Date.now()-r.started<86400000).length,flows=state.workflows.filter(w=>w.enabled).length,working=state.agents.filter(a=>a.status==='working').length;
  return `<div class="it-board"><table><thead><tr><th>LINE</th><th>PROVIDER</th><th>STATUS</th><th>MODEL</th><th>RESIDENTS</th></tr></thead><tbody>${Object.entries(providerInfo).map(([id,[name]],i)=>{const c=state.connections[id]||{};return `<tr><td>${String(i+1).padStart(2,'0')}</td><td>${esc(name).toUpperCase()}</td><td class="${c.configured?'':'off'}">${c.configured?'ONLINE':'OFFLINE'}</td><td class="${c.model?'':'off'}">${esc(c.model||'NONE')}</td><td>${count(id)}</td></tr>`;}).join('')}<tr><td>--</td><td>DEMO</td><td>BUILT IN</td><td class="off">SCRIPTED</td><td>${count('demo')}</td></tr></tbody></table><div class="it-summary"><span>RESIDENTS <b>${state.agents.length}</b></span><span>AT WORK <b>${working}</b></span><span>RUNS IN 24H <b>${runs}</b></span><span>SCHEDULED FLOWS <b>${flows}</b></span><span>SILO <b>${state.paused?'PAUSED':'RUNNING'}</b></span></div></div>`;}
function renderConnections(){return heading('IT / Uplink','Connect a model provider, then pick it in a resident\'s settings.','','IT DEPARTMENT')+itBoard()+`<div class="info-banner">${icon('connections')}<span><strong>Keys.</strong> Keys are saved encrypted on this computer and are never sent back to the browser. Saving a connection does not check it, so run a test after saving.</span></div><div class="connection-grid">${Object.entries(providerInfo).map(([id,[name,mark,desc]])=>{const c=state.connections[id];return `<article class="connection-card"><div class="connection-brand"><span class="connection-logo">${mark}</span><h3>${name}</h3><span class="connection-state"><span class="dot ${c.configured?'green':''}"></span>${c.configured?'CONFIGURED':'NOT CONNECTED'}</span></div><p>${desc}</p>${c.model?`<div class="provider-badge">${esc(c.model)}</div>`:''}<div style="display:flex;gap:8px">${button(c.configured?'Configure':'Connect provider','connect',false,`data-provider="${id}"`)}${c.configured?button('Test connection','test-connection',false,`data-provider="${id}"`):''}</div></article>`;}).join('')}</div><h2 class="section-title">Apps</h2><div class="info-banner">${icon('connections')}<span><strong>Your own accounts.</strong> Residents with the matching permission read your mail, calendar, files, channels, issues and pages. Sending, posting and creating always wait for your OK. Google and Microsoft use your own free app registration, so no outside company stands between SILO and your account.</span></div><div class="connection-grid" id="apps-grid"><div class="empty small">Loading apps...</div></div><h2 class="section-title">MCP connectors <small>${(state.mcp||[]).length}</small></h2><div class="info-banner">${icon('connections')}<span><strong>Tools from other services.</strong> A connector gives residents the tools of an MCP server: GitHub, Notion, Slack, a database, or your own program. A program connector runs on this computer with your rights, so add only servers you trust. Calls that change something wait for your OK in Signals.</span></div><div class="connection-grid" id="mcp-list">${mcpCards()}</div><div class="heading-actions" style="margin:10px 0 24px">${button(icon('plus')+'Add connector','mcp-new',true)}${button(icon('plus')+'Add Python tool','python-tool-new')}</div>${spendingSection()}<h2 class="section-title">Notifications <small>${(state.channels||[]).length}</small></h2><div class="info-banner">${icon('activity')}<span><strong>Messages that leave the silo.</strong> Telegram, Slack, Discord, email or a webhook of your own. Each channel picks what it hears about. Secrets stay on the server.</span></div><div class="connection-grid">${channelCards()}</div><div class="heading-actions" style="margin:10px 0 24px">${button(icon('plus')+'Add channel','channel-new',true)}</div>${phoneSection()}<h2 class="section-title">Desktop apps</h2><div class="info-banner"><span>These buttons open Windows apps when you click them. Residents cannot control the desktop. File access is set per resident. Services like GitHub or Notion connect through MCP connectors above.</span></div><div class="desktop-apps">${[['notepad','Notepad','Opens Notepad','files'],['calculator','Calculator','Opens Calculator','grid'],['workspace','Workspace folder','Opens the workspace folder in Explorer','files']].map(([id,name,desc,ic])=>`<div class="desktop-app">${icon(ic)}<div><h4>${name}</h4><p>${desc}</p></div>${button('Open','open-app',false,`data-app="${id}"`)}</div>`).join('')}</div>`;}
function mcpCards(){
  const list=state.mcp||[];if(!list.length)return '<div class="empty small">No connectors yet. Add one to give residents tools from other services.</div>';
  return list.map(c=>{const users=state.agents.filter(a=>a.tools?.includes('mcp:'+c.id)).length;return `<article class="connection-card"><div class="connection-brand"><span class="connection-logo">${c.transport==='openapi'?'API':c.transport==='http'?'WEB':'PRG'}</span><h3>${esc(c.name)}</h3><span class="connection-state"><span class="dot ${c.status==='ok'?'green':''}"></span>${c.enabled===false?'OFF':c.needsSignIn?'SIGN IN NEEDED':c.status==='ok'?(c.tools||[]).length+' TOOLS':c.status==='error'?'NOT REACHABLE':'NOT CHECKED'}</span></div><p class="mono-line">${esc(c.transport==='openapi'?[c.base,c.builtin?'built in':c.specFile?'pasted description':c.spec].filter(Boolean).join(' / '):c.transport==='http'?c.url:[c.command,...(c.args||[])].join(' '))}</p>${c.keyCheck?`<p class="key-check ${c.keyCheck.ok?'ok':'bad'}">${c.keyCheck.ok?'Works with your account':'The app refused the call'+(c.keyCheck.status?' ('+c.keyCheck.status+')':'')+(c.keyCheck.detail?': '+esc(c.keyCheck.detail.slice(0,140)):'')}. Checked ${age(c.keyCheck.at)}.</p>`:''}${c.error?`<p class="modal-error">${esc(c.error)}</p>`:''}<p>${users} resident${users===1?'':'s'} may use it. ${c.ask==='never'?'Never asks first.':c.ask==='always'?'Asks before every call.':'Asks before calls that change something.'}</p>${(c.tools||[]).length?`<div class="flow-mini">${c.tools.slice(0,12).map(t=>`<span class="${t.readOnly?'':'review'}" title="${esc(t.description)}">${esc(t.name)}</span>`).join('')}${c.tools.length>12?`<span>+${c.tools.length-12}</span>`:''}</div>`:''}<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">${c.transport==='http'?(c.signedIn?button('Sign out','mcp-signout',false,`data-id="${c.id}"`):button('Sign in','mcp-signin',!!c.needsSignIn,`data-id="${c.id}" title="Sign in with your account on this service"`)):''}${button('Test','mcp-test',false,`data-id="${c.id}"`)}${button('Edit','mcp-edit',false,`data-id="${c.id}"`)}${button('Remove','mcp-remove',false,`data-id="${c.id}"`)}</div></article>`;}).join('');
}
// The finder: built-in apps, the MCP registry and the API directory, side by side.
let findHits=[];
const catName=n=>({'open_data':'Open data','developer_tools':'Developer tools','cloud':'Cloud','ecommerce':'Shops','financial':'Money','social':'Social','media':'Media','messaging':'Messages','location':'Places','entertainment':'Entertainment','analytics':'Analytics','text':'Text','machine_learning':'Machine learning','email':'Email','collaboration':'Working together','telecom':'Phone','iot':'Devices','security':'Security','payment':'Payments','enterprise':'Business','storage':'Storage','search':'Search','marketing':'Marketing','education':'Learning','customer_relation':'Customers','hosting':'Hosting','monitoring':'Monitoring','project_management':'Projects','support':'Support','transport':'Transport','tools':'Tools','backend':'Backend','time_management':'Time','forms':'Forms'})[n]||n.replace(/_/g,' ').replace(/^./,x=>x.toUpperCase());
function findLocal(q){
  const words=q.toLowerCase().split(/\s+/).filter(Boolean);if(!words.length)return [];
  return Object.entries(PRESETS).filter(([k])=>k!=='custom').map(([k,p])=>{const t=(p.label+' '+(p.name||'')+' '+k).toLowerCase();let n=0;for(const w of words){if(!t.includes(w))return [0];n+=p.label.toLowerCase().startsWith(w)?3:1;}return [n,k,p];}).filter(x=>x[0]>0).sort((a,b)=>b[0]-a[0]).slice(0,8).map(([,k,p])=>({k,p}));
}
function fillConnector(form,v){
  for(const k of ['name','command','args','url','env','headers','spec','base','include','authName','authValue'])form.elements[k].value=v[k]||'';
  form.elements.transport.value=v.transport;form.elements.authKind.value=v.authKind||'none';form.dataset.builtin='';
  if(v.transport==='openapi')form.elements.ask.value='auto';
  const p=$('#mcp-preset');if(p)p.value='custom';form.elements.transport.dispatchEvent(new Event('change'));
}
function openMcpEditor(c){
  const fresh=!c,v=c?{...c,args:(c.args||[]).map(a=>/\s/.test(a)?'"'+a+'"':a).join(' '),env:(c.envNames||[]).map(n=>n+'=').join('\n'),headers:(c.headerNames||[]).map(n=>n+': ').join('\n'),spec:c.spec||'',authKind:c.apiAuth?.kind||'none',authName:c.apiAuth?.name||''}:{...PRESETS.custom,ask:'auto',enabled:true};
  const groups=PRESET_GROUPS.map(([g,label])=>`<optgroup label="${label}">${Object.entries(PRESETS).filter(([,p])=>p.group===g).map(([k,p])=>`<option value="${k}">${esc(p.label)}</option>`).join('')}</optgroup>`).join('');
  showModal(`${modalHead(fresh?'Add connector':'Edit '+esc(c.name),'An MCP server whose tools residents may use.')}<form id="mcp-form"><div class="modal-body">${fresh?`<div class="form-group mcp-finder"><label for="mcp-find">Find an app or connector</label><div class="api-find"><input class="field" id="mcp-find" maxlength="80" placeholder="e.g. stripe, notion, weather" spellcheck="false" autocomplete="off"><select class="select" id="mcp-cat" aria-label="Kind of API"><option value="">Any kind</option></select><button type="button" class="btn small" data-action="mcp-find">Search</button></div><div class="api-results" aria-live="polite"></div><small>Looks in the apps built into SILO, the official MCP registry and a public directory of about 2,500 web APIs (apis.guru). Pick a kind to browse it.</small></div><div class="form-group"><label for="mcp-preset">Start from</label><select class="select" id="mcp-preset">${groups}</select><small id="mcp-preset-note">Pick a ready-made connector, or start from scratch. Check the service's own page for the exact options.</small></div>`:''}<div class="form-grid"><div class="form-group"><label for="mcp-name">Name</label><input class="field" id="mcp-name" name="name" maxlength="40" required value="${esc(v.name||'')}" placeholder="e.g. GitHub"></div><div class="form-group"><label for="mcp-transport">Kind</label><select class="select" id="mcp-transport" name="transport"><option value="stdio" ${v.transport!=='http'?'selected':''}>Program (stdio)</option><option value="http" ${v.transport==='http'?'selected':''}>Address (HTTP)</option><option value="openapi" ${v.transport==='openapi'?'selected':''}>Web API (OpenAPI)</option></select></div></div><div class="mcp-stdio"><div class="form-group"><label for="mcp-command">Command</label><input class="field" id="mcp-command" name="command" value="${esc(v.command||'')}" placeholder="npx"></div><div class="form-group"><label for="mcp-args">Arguments</label><input class="field" id="mcp-args" name="args" value="${esc(v.args||'')}" placeholder="-y @scope/server-name"><small>Runs in the workspace folder. Quote arguments that contain spaces.</small></div><div class="form-group"><label for="mcp-env">Environment (NAME=value, one per line)</label><textarea class="field" id="mcp-env" name="env" rows="3" spellcheck="false">${esc(v.env||'')}</textarea>${fresh?'':'<small>Saved values are not shown. Leave a value empty to keep it.</small>'}</div></div><div class="mcp-http"><div class="form-group"><label for="mcp-url">Address</label><input class="field" id="mcp-url" name="url" value="${esc(v.url||'')}" placeholder="https://example.com/mcp" spellcheck="false">${!fresh&&c.secretUrl?'<small>The secret part of the address (****) is kept in the vault. Leave it as it is to keep it.</small>':''}</div><div class="form-group"><label for="mcp-headers">Headers (Name: value, one per line)</label><textarea class="field" id="mcp-headers" name="headers" rows="2" spellcheck="false">${esc(v.headers||'')}</textarea>${fresh?'':'<small>Saved values are not shown. Leave a value empty to keep it.</small>'}</div></div><div class="mcp-openapi"><div class="form-group mcp-spec-group"><label for="mcp-spec">OpenAPI description</label><textarea class="field" id="mcp-spec" name="spec" rows="3" spellcheck="false" placeholder="https://example.com/openapi.json, or paste the JSON">${esc(v.spec||'')}</textarea><small>${!fresh&&c.specFile?'A pasted description is saved. Leave this empty to keep it. ':''}OpenAPI 3 or Swagger 2, in JSON. Paste up to 250 KB; give the address of a larger one.</small></div><div class="form-group"><label for="mcp-base">API address (optional)</label><input class="field" id="mcp-base" name="base" value="${esc(v.base||'')}" placeholder="Taken from the description"></div><div class="form-group"><label for="mcp-include">Only operations about (optional)</label><input class="field" id="mcp-include" name="include" maxlength="300" value="${esc(v.include||'')}" placeholder="issues, comments" spellcheck="false"><small>Words from the operation name, path or group, separated by commas. Large APIs work better with fewer tools.</small></div><div class="form-grid mcp-auth-row"><div class="form-group"><label for="mcp-auth">Key</label><select class="select" id="mcp-auth" name="authKind">${[['none','No key'],['bearer','Bearer token'],['basic','User and password'],['header','In a header'],['query','In the address']].map(([k,n])=>`<option value="${k}" ${(v.authKind||'none')===k?'selected':''}>${n}</option>`).join('')}</select></div><div class="form-group mcp-auth-name"><label for="mcp-auth-name">Header or value name</label><input class="field" id="mcp-auth-name" name="authName" value="${esc(v.authName||'')}" placeholder="X-API-Key" spellcheck="false"></div></div><div class="form-group mcp-auth-value"><label for="mcp-auth-value">Key value</label><input class="field" id="mcp-auth-value" name="authValue" type="password" autocomplete="off" spellcheck="false" data-saved="${!fresh&&c.keySaved?'Saved. Leave empty to keep it.':''}" placeholder="${!fresh&&c.keySaved?'Saved. Leave empty to keep it.':''}"></div></div><div class="form-grid"><div class="form-group"><label for="mcp-ask">Ask me first</label><select class="select" id="mcp-ask" name="ask"><option value="auto" ${v.ask==='auto'?'selected':''}>Before calls that change something</option><option value="always" ${v.ask==='always'?'selected':''}>Before every call</option><option value="never" ${v.ask==='never'?'selected':''}>Never</option></select></div><label class="check-label" style="align-self:end"><input type="checkbox" name="enabled" ${v.enabled!==false?'checked':''}> Connector on</label></div>${errEl()}</div><div class="modal-footer"><button type="button" class="btn" data-action="close-modal">Cancel</button><button class="btn primary">${fresh?'Add and test':'Save and test'}</button></div></form>`,'mcp');
  const form=$('#mcp-form'),sync=()=>{form.dataset.transport=form.elements.transport.value;if(form.dataset.transport!=='openapi')form.dataset.builtin='';const k=form.elements.authKind.value;form.querySelector('.mcp-auth-name').hidden=!['header','query'].includes(k);form.querySelector('.mcp-auth-value').hidden=k==='none';form.elements.authValue.placeholder=k==='basic'?'user:password':(form.elements.authValue.dataset.saved||'');};sync();form.elements.transport.onchange=sync;form.elements.authKind.onchange=sync;
  form.dataset.builtin=c?.builtin||'';
  $('#mcp-find')?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();actions['mcp-find'](form.querySelector('[data-action="mcp-find"]'));}});
  const cat=$('#mcp-cat');
  if(cat){let loaded=false;const load=async()=>{if(loaded)return;loaded=true;try{const r=await api('/apis');cat.insertAdjacentHTML('beforeend',r.categories.map(x=>`<option value="${esc(x.name)}">${esc(catName(x.name))} (${x.count})</option>`).join(''));}catch{loaded=false;}};cat.addEventListener('focus',load);cat.addEventListener('pointerdown',load);cat.addEventListener('change',()=>actions['mcp-find'](form.querySelector('[data-action="mcp-find"]')));}
  $('#mcp-preset')?.addEventListener('change',e=>{const p=PRESETS[e.target.value];form.dataset.builtin=p.builtin||'';for(const k of ['name','command','args','url','env','headers','spec','base','include','authName']){const el=form.elements[k];if(el)el.value=p[k]||'';}form.elements.transport.value=p.transport;form.elements.authKind.value=p.auth||'none';if(p.transport==='openapi')form.elements.ask.value='auto';$('#mcp-preset-note').textContent=p.note||'Check the service\'s own page for the exact options.';sync();});
  form.onsubmit=async e=>{
    e.preventDefault();const el=form.elements,btn=form.querySelector('.btn.primary');btn.disabled=true;
    const lines=(t,sep)=>Object.fromEntries(t.split('\n').map(l=>l.trim()).filter(Boolean).map(l=>{const i=l.indexOf(sep);return i<0?[l,'']:[l.slice(0,i).trim(),l.slice(i+1).trim()];}));
    const body={id:c?.id,name:el.name.value,transport:el.transport.value,command:el.command.value,args:el.args.value,url:el.url.value,env:lines(el.env.value,'='),headers:lines(el.headers.value,':'),spec:el.spec.value,base:el.base.value,include:el.include.value,builtin:form.dataset.builtin||'',authKind:el.authKind.value,authName:el.authName.value,authValue:el.authValue.value,ask:el.ask.value,enabled:el.enabled.checked};
    try{const r=await post('/mcp',body);await refresh();modal.close();if(view==='connections')render();toast(r.error?'Saved, but the connector did not answer: '+r.error:`Connector ready with ${r.tools} tools. Allow it per resident in their settings.`,!!r.error);}
    catch(err){$('#form-error').textContent=err.message;btn.disabled=false;}
  };
}
// Tool calls that wait for you. They show in Signals and as a badge on its key.
const pendingRequests=()=>(state.requests||[]).filter(r=>r.status==='pending');
function requestList(){
  const list=pendingRequests();if(!list.length)return '';
  return `<h2 class="section-title">Waiting for you <small>${list.length}</small></h2><div class="section-card requests">${list.map(r=>`<div class="activity-row request"><span class="event-icon">${icon('connections')}</span><div><strong>${esc(r.agentName)} asks to ${esc(r.title)}</strong><p>${esc(r.source||'')}${r.execMode?` · mode: <code>${esc(r.execMode)}</code>`:''}${r.codeHash?` · sha256: <code>${esc(r.codeHash.slice(0,16))}…</code>`:''}</p>${r.detail?`<pre class="proposal-preview" style="max-height:320px;overflow:auto">${esc(r.detail)}</pre>`:''}</div><time>${age(r.time)}</time><div class="proposal-actions"><button class="btn small primary" data-action="allow-request" data-id="${r.id}">Allow once</button><button class="btn small" data-action="allow-always" data-id="${r.id}" title="Do not ask again for this resident and this tool">${/^(browser|desktop):/.test(r.tool||'')?'Always on '+esc(r.tool.slice(8)):'Always for '+esc(r.agentName.split(' ')[0])}</button><button class="btn small danger" data-action="deny-request" data-id="${r.id}">Deny</button></div></div>`).join('')}</div>`;
}
async function decideRequest(id,allow,always=false){try{await post('/requests/'+id,{allow,always});await refresh();syncBadges();if($('#request-list'))$('#request-list').innerHTML=requestList();toast(allow?(always?'Allowed. This resident will not ask again for this tool.':'Allowed once.'):'Denied.');}catch(e){toast(e.message,true);}}
function renderActivity(){return heading('Signals','Missions, workflow runs, connections and errors. Newest first.',(state.events.length?button('Brief me','ai-brief'):'')+button(icon('files')+'File shift report','file-shift-report',true),'LOG')+`${aiSlot('brief')}<div id="request-list">${requestList()}</div><h2 class="section-title">Traces</h2><div class="section-card" id="trace-list"><div class="empty small">Loading traces...</div></div><h2 class="section-title">Log</h2><div class="section-card" id="activity-list">${state.events.map(eventRow).join('')||'<div class="empty">Nothing logged yet.</div>'}</div>`;}
function renderFiles(){return heading('Archive','Text files in the workspace folder, and files residents want to write.',button('Scan for Relics','scan-relics')+button('Add a file','upload-file')+button(icon('plus')+'New file','new-file',true),'FILES')+`<div class="info-banner"><span><strong>Where files live:</strong> the project's <code>workspace/</code> folder. Residents with file access search and read what they need: text up to 30 KB per file, and the text of PDF, Word, Excel and PowerPoint files. Add a file puts it in uploads/. Files a resident proposes wait here until you save or discard them.</span></div><div id="relic-banner"></div><div id="proposal-list">${proposalList()}</div><div class="file-layout"><div class="file-list"><div class="panel-title">Workspace <small id="file-count"></small></div><div id="file-list"><div class="empty">Loading files...</div></div></div><div class="file-editor"><div class="file-editor-head"><input id="file-name" class="field" placeholder="notes/my-first-idea.md" aria-label="File path">${button('Save file','save-file',true)}</div><textarea class="field" id="file-content" placeholder="File content" aria-label="File content" spellcheck="false"></textarea><small style="color:#99a08b;font-size:9px" id="doc-note">Plain text. Ctrl+S saves.</small></div></div>`;}
function renderSettings(){return heading('System','Storage, keys, shortcuts and limits.','','CONTROL')+`<div class="settings-grid"><section class="settings-card"><h3>Storage</h3><p>SILO runs on your machine using Node.js. Agents, conversations, workflow definitions, run traces and events are saved to <code>data/state.db</code> (SQLite), with a readable copy in <code>data/state.json</code> every five minutes.</p><p>API keys, tokens and passwords you enter are saved encrypted in <code>data/secrets.enc</code>, with the key in <code>data/vault.key</code>. Start SILO with <code>SILO_SECRET</code> set to use a passphrase instead of the key file. You can also supply <code>OPENAI_API_KEY</code>, <code>ANTHROPIC_API_KEY</code> and <code>COMPATIBLE_API_KEY</code> as environment variables before launch.</p>${button(icon('download')+'Export workspace','export')}<p>Exports include conversations and workflow history, without API keys. Keep private workspace files on a trusted machine.</p></section><section class="settings-card"><h3>Shortcuts</h3><div class="keyboard-row"><span>Search</span><kbd>Ctrl K</kbd></div><div class="keyboard-row"><span>Close the open window</span><kbd>Esc</kbd></div><div class="keyboard-row"><span>Save the open workspace file</span><kbd>Ctrl S</kbd></div><div class="keyboard-row"><span>Move around the silo</span><kbd>Drag + scroll</kbd></div><div class="keyboard-row"><span>Send a chat message</span><kbd>Ctrl Enter</kbd></div></section><section class="settings-card"><h3>What it does</h3><ul><li>144 levels in six sectors, three or more residents per level, saved conversations and notes.</li><li>OpenAI, Anthropic, Ollama and compatible providers with native tool calls.</li><li>Tools: files, web pages, web search, meaning search, code sandbox, MCP connectors, asking other residents.</li><li>Workflows with parallel steps, conditions, reviews, approvals, schedules, webhooks, watched folders, versions, replays and tests.</li><li>Costs, spending limits and notifications.</li></ul><p>Not included: desktop control, voice, running as a Windows service.</p></section><div id="system-live" class="settings-grid-span"></div><section class="settings-card"><h3>About</h3><p><strong>SILO / Agentic operating system / v0.1</strong></p><p>A local agent workspace drawn as an underground silo with 144 levels. Room interiors come from the original artwork in <code>public/assets</code>. Residents are pixel-art sprites drawn in code. No assets from the TV series or from any game are used.</p><p>API adapters follow the official <a href="https://developers.openai.com/api/docs/quickstart" target="_blank" rel="noreferrer">OpenAI</a>, <a href="https://platform.claude.com/docs/en/api/messages/create" target="_blank" rel="noreferrer">Anthropic</a> and <a href="https://docs.ollama.com/api/chat" target="_blank" rel="noreferrer">Ollama</a> documentation.</p></section></div>`;}
function securityCams(){if(!cams)cams=defaultCameras();return cams;}
const cam=()=>securityCams()[mainCam];
const pad3=n=>String(n||0).padStart(3,'0');
function renderSecurity(){
  if(!world?.captureFeed)return heading('Security','The cameras need the 3D view, which needs WebGL 2 in this browser.','','SURVEILLANCE')+'<div class="section-card empty">NO SIGNAL</div>';
  return heading('Security','Live pictures from cameras around the silo. Drag on the big monitor to look around, scroll to zoom, click a resident to follow them.',button(icon('silo')+' Go there','cam-go',true),'SURVEILLANCE')+
  `<div class="security-room"><section class="monitor monitor-main"><div class="monitor-screen"><canvas id="feed-main" width="400" height="300" tabindex="0" aria-label="Main monitor. Arrow keys look around, plus and minus zoom, Page Up and Page Down change level."></canvas></div><div class="monitor-label"><span id="main-label"></span><b id="main-zoom"></b></div><div class="monitor-controls" id="monitor-controls"></div></section><aside class="security-side"><div class="monitor-bank">${securityCams().map((c,i)=>`<button class="monitor" data-action="cam-select" data-cam="${i}" aria-label="Show camera ${c.num} on the big monitor"><div class="monitor-screen"><canvas data-feed="${i}" width="160" height="120"></canvas></div><div class="monitor-label"><span id="bank-title-${i}"></span></div></button>`).join('')}</div><div id="security-info"></div></aside></div>`;
}
let followWork=(()=>{try{return localStorage.getItem('silo-follow-work')!=='off';}catch{return true;}})(),workTarget=null;
function workCard(){
  const w=activeWork();
  return `<div class="section-card work-follow"><div class="panel-title">Follow the work <small>${followWork?'AUTO':'OFF'}</small></div><div class="security-note">${w?`STEP ${pad2(w.part.index+1)} OF ${pad2(w.run.total||w.run.steps.length)} / ${esc(w.run.name)}<br><span style="color:var(--ph-hi)">${esc(w.agent.name)}</span> / L${pad3(w.agent.level)}${followWork?' / ON THE BIG MONITOR':''}`:'No workflow is running. When one starts, the big monitor turns to the resident doing the current step.'}</div><div style="padding:0 12px 12px">${button(followWork?'Stop following the work':'Follow the work','follow-work',!followWork)}</div></div>`;
}
function steerToWork(force=false){
  if(view!=='security'||!followWork||!feedWall)return;
  const w=activeWork();if(!w){workTarget=null;return;}
  const key=w.run.id+':'+w.part.index+':'+w.agent.id;if(!force&&key===workTarget)return;workTarget=key;pointCamera(w.agent.id);
}
function securityInfo(c){
  if(c.kind==='outside'){const clear=Math.round((1-world.lensGrime)*100),w=state.pulse?.weather,caf=state.settings?.cafeteria||'auto';return `<div class="section-card"><div class="panel-title">Sensor lens <small>${clear}% CLEAR</small></div><div class="security-note"><div class="lens-meter"><span style="width:${clear}%"></span></div>Dust settles on the lens hour by hour. Last cleaned ${age(world.lensCleanedAt)}.<br>Air clarity: <strong>${Math.round((w?.clarity??.5)*100)}%</strong> (${esc(caf)})</div><div style="display:flex;gap:6px;flex-wrap:wrap;padding:0 12px 12px">${button('Clean the lens','clean-lens',true)}${[['auto','Auto'],['toxic','Toxic'],['dawn','Dawn'],['green','Green']].map(([k,l])=>`<button class="btn small ${caf===k?'primary':''}" data-action="set-cafeteria" data-mode="${k}">${l}</button>`).join('')}</div></div><div class="section-card security-note">The big screen in the cafeteria on level 1 shows this same picture and the live surface telemetry.</div>`;}
  const lo=c.kind==='hall'?140:c.level,hi=c.kind==='hall'?144:c.kind==='shaft'?c.level+3:c.level,people=state.agents.filter(a=>(a.level||0)>=lo&&(a.level||0)<=hi),t=getAgent(trackId);
  return workCard()+`${t?`<div class="section-card"><div class="panel-title">Following <small>L${pad3(t.level)}</small></div><div class="security-note"><span style="color:var(--ph-hi)">${esc(t.name)}</span> / ${esc(t.role)} / ${t.status==='working'?'WORKING':'IDLE'}</div><div style="display:flex;flex-wrap:wrap;gap:6px;padding:0 12px 12px">${button(icon('chat')+' Talk','chat',true,`data-id="${t.id}"`)}${button('Point camera','cam-point',false,`data-id="${t.id}"`)}${button('Locate','locate-agent',false,`data-id="${t.id}"`)}${button('Stop','cam-untrack')}</div></div>`:''}<div class="section-card"><div class="panel-title">${c.kind==='shaft'?'Below this camera':'On this level'} <small>${people.length} RESIDENTS</small></div><div class="watch-list">${people.map(a=>`<button class="watch-row" data-action="cam-track" data-id="${a.id}"><span class="dot ${a.status==='working'?'':'green'}"></span>${esc(a.name)}<small>L${pad3(a.level)} / ${esc(a.role)}</small></button>`).join('')||'<div class="empty">Nobody here.</div>'}</div></div>`;
}
function refreshSecurityInfo(){const box=$('#security-info');if(!box||box.matches(':hover'))return;const html=securityInfo(cam());if(html===box.dataset.html)return;const list=box.querySelector('.watch-list'),top=list?.scrollTop||0;box.innerHTML=html;box.dataset.html=html;const next=box.querySelector('.watch-list');if(next)next.scrollTop=top;}
function syncZoom(){const z=$('#main-zoom');if(z)z.textContent='ZOOM '+cam().zoom.toFixed(1)+'X';}
function syncSecurity(){
  if(view!=='security'||!$('#feed-main'))return;const c=cam();
  $('#main-label').textContent=cameraLabel(c,state.floors);syncZoom();
  $$('.monitor-bank .monitor').forEach((el,i)=>{el.classList.toggle('active',i===mainCam);el.setAttribute('aria-pressed',String(i===mainCam));});
  securityCams().forEach((x,i)=>{const t=$('#bank-title-'+i);if(t)t.textContent=String(x.num).padStart(2,'0')+' '+cameraTitle(x,state.floors).toUpperCase();});
  $('#monitor-controls').innerHTML=[['cam-pan','◀',1,'Look left'],['cam-pan','▶',-1,'Look right'],['cam-tilt','▲',1,'Look up'],['cam-tilt','▼',-1,'Look down'],['cam-zoom','+',1,'Zoom in'],['cam-zoom','−',-1,'Zoom out']].map(([a,l,d,t])=>`<button class="btn small" data-action="${a}" data-d="${d}" aria-label="${t}" title="${t}">${l}</button>`).join('')+'<span class="sep"></span>'+(canMoveLevel(c)?'<button class="btn small" data-action="cam-level" data-d="-1" title="Move the camera one level up">Level ▲</button><button class="btn small" data-action="cam-level" data-d="1" title="Move the camera one level down">Level ▼</button>':'')+'<button class="btn small" data-action="cam-reset" title="Point the camera back where it was">Reset</button>';
  const box=$('#security-info'),html=securityInfo(c);box.innerHTML=html;box.dataset.html=html;
}
function trackResident(id){const a=getAgent(id);if(!a)return;trackId=id;if(feedWall){feedWall.track={id,name:a.name};feedWall.aim=true;}syncSecurity();}
// Moves a wall camera to a resident's level, just behind them, then follows them.
function pointCamera(id){
  const a=getAgent(id);if(!a)return;
  if(cam().kind!=='gallery'){const i=securityCams().findIndex(x=>x.kind==='gallery'&&sectorForLevel(x.home)===a.floor);mainCam=i<0?1:i;if(feedWall){feedWall.main=mainCam;feedWall.lastMain=-1;}}
  const g=cam();g.radius=undefined;g.turn=0;const b=world?.feedBearing?.(g,id);g.level=a.level||SECTORS[a.floor].home;if(b)g.angle=b.angle+.75;g.pan=g.tilt=0;g.zoom=1.3;trackResident(id);
}
function moveCamLevel(d){const c=cam();if(!canMoveLevel(c))return;c.level=Math.max(1,Math.min(144,c.level+d));syncSecurity();}
function mountSecurity(){
  const c=$('#feed-main');if(!world?.captureFeed||!c)return;
  feedWall=feedWall||new FeedWall(world,securityCams(),state.floors);feedWall.floors=state.floors;feedWall.main=mainCam;const t=getAgent(trackId);feedWall.track=t?{id:t.id,name:t.name}:null;feedWall.attach($('#main'));syncSecurity();workTarget=null;steerToWork(true);
  let drag=null;
  c.addEventListener('pointerdown',e=>{drag={x:e.clientX,y:e.clientY,moved:false};c.setPointerCapture(e.pointerId);c.focus({preventScroll:true});});
  c.addEventListener('pointermove',e=>{if(!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(!drag.moved&&Math.abs(dx)+Math.abs(dy)<4)return;drag.moved=true;if(feedWall)feedWall.aim=false;const r=c.getBoundingClientRect();steer(cam(),{pan:dx/r.width*1.1,tilt:dy/r.height*.8});drag.x=e.clientX;drag.y=e.clientY;});
  c.addEventListener('pointerup',e=>{if(drag&&!drag.moved){const r=c.getBoundingClientRect(),a=world.pickFeed(cam(),(e.clientX-r.left)/r.width,(e.clientY-r.top)/r.height,4/3);if(a)trackResident(a.id);}drag=null;});
  c.addEventListener('pointercancel',()=>{drag=null;});
  c.addEventListener('wheel',e=>{e.preventDefault();steer(cam(),{zoom:e.deltaY<0?1.15:1/1.15});syncZoom();},{passive:false});
  c.addEventListener('keydown',e=>{const k={ArrowLeft:{pan:.08},ArrowRight:{pan:-.08},ArrowUp:{tilt:.06},ArrowDown:{tilt:-.06},'+':{zoom:1.15},'=':{zoom:1.15},'-':{zoom:1/1.15}}[e.key];if(k){e.preventDefault();steer(cam(),k);syncZoom();}if(e.key==='PageUp'||e.key==='PageDown'){e.preventDefault();moveCamLevel(e.key==='PageUp'?-1:1);}});
}
function updateClock(){const el=$('#chrome-clock');if(el&&view!=='silo')el.textContent=new Date().toLocaleTimeString('en-GB',{hour12:false});}
function bindView(){
  if(view==='agents'){$('#agent-search').addEventListener('input',e=>{filter=e.target.value;agentLimit=PAGE;$('#agent-grid').innerHTML=agentGrid();});$('#floor-filter').addEventListener('change',e=>{floorFilter=e.target.value;agentLimit=PAGE;$('#agent-grid').innerHTML=agentGrid();});}
  if(view==='files')loadFiles();
  if(view==='connections')loadApps();
  if(view==='security')mountSecurity();
}
function selectAgent(agentId){selected=agentId;const a=getAgent(agentId);if(!a)return;residentOpen=true;$('#agent-panel').hidden=false;$('#agent-panel').innerHTML=agentPanel();world?.update(state.agents,selected,state.paused);syncLevel(a.level||SECTORS[a.floor].home);setFloor(a.floor,false);}
function showModal(html,kind=''){modalKind=kind;$('#modal-content').innerHTML=html;if(!modal.open)modal.showModal();}
function modalHead(title,subtitle=''){return `<div class="modal-head"><div><h2>${title}</h2>${subtitle?`<p>${subtitle}</p>`:''}</div><button class="modal-close" data-action="close-modal" aria-label="Close window">×</button></div>`;}
const errEl=()=>'<div class="modal-error" role="alert" id="form-error"></div>';
const PERMS=[['read_files','Search and read workspace files','Finds the text files it needs in workspace/ and reads them. Their text goes to this resident\'s provider.'],['write_files','Propose files','Writes a file as a proposal. Nothing is saved until you approve it in the Archive.'],['web','Read web pages','Reads public pages by address. Pages on this computer or your network are refused.'],['memory','Keep notes','Keeps short notes between missions, like facts and preferences worth remembering.'],['run_code','Run code in the sandbox','Runs Python, JavaScript or shell commands on a copy of the workspace. Every run waits for your OK unless you trust this resident.'],['delegate','Ask other residents','Hands parts of a task to other residents with a model and uses their answers. A council meeting shows it in the silo.'],['browser','Use a web browser','Opens sites in its own Edge or Chrome profile, reads them and follows links. Pressing buttons, typing and choosing options wait for your OK on each site. It never types passwords: you sign in for it.'],['desktop','Use desktop apps (Windows)','Reads and uses the apps on this computer through Windows accessibility, mostly without your mouse or keyboard. Seeing a window and every action wait for your OK, per app. Browsers, terminals, system tools and password managers are never used.'],
['google','Use Google (Gmail, Calendar, Drive)','Searches and reads your mail, calendar and Drive files. Sending mail and adding events wait for your OK. Connect Google in IT / Uplink first.'],
['microsoft','Use Microsoft 365 (Outlook, Calendar, OneDrive)','Searches and reads your mail, calendar and OneDrive files. Sending mail and adding events wait for your OK. Connect Microsoft in IT / Uplink first.'],
['slack','Use Slack','Lists channels and reads the ones the bot was invited to. Posting waits for your OK.'],
['github','Use GitHub','Reads repositories, issues, pull requests and files. Opening issues and commenting wait for your OK.'],
['notion','Use Notion','Searches and reads the pages shared with your integration. Adding text waits for your OK.']];
function connectorPerms(a){
  const list=state.mcp||[];
  const trust=(a.trust||[]).length?`<div class="trust-line">Runs without asking: ${a.trust.map(t=>`<span>${esc(trustName(t))}<button type="button" data-action="untrust" data-id="${a.id}" data-tool="${esc(t)}" aria-label="Ask again">×</button></span>`).join('')}</div>`:'';
  return (list.length?`<div class="perm-connectors">${list.map(c=>`<label class="check-label"><input type="checkbox" name="mcp:${c.id}" ${a.tools.includes('mcp:'+c.id)?'checked':''}><span>Connector: ${esc(c.name)}<br><small>${(c.tools||[]).length} tools. ${c.ask==='never'?'Never asks you first.':c.ask==='always'?'Asks you before every call.':'Asks you before anything that changes something.'}</small></span></label>`).join('')}</div>`:'')+trust;
}
function trustName(t){if(t==='run_code')return 'sandbox';if(t.startsWith('browser:'))return 'browser on '+t.slice(8);if(t.startsWith('desktop:'))return 'desktop app '+t.slice(8);{const m=t.match(/^(google|microsoft|slack|github|notion):(\w+)$/);if(m)return (PERM_LABELS[m[1]]||m[1])+' / '+m[2].replace(/_/g,' ');}if(t.startsWith('mcp:')){const [,cid,tool]=t.split(':');return (state.mcp?.find(c=>c.id===cid)?.name||'connector')+' / '+tool;}return t;}
function memoryList(a){
  const notes=a.memory?.length?`<ol class="memory-list">${a.memory.map((m,i)=>`<li><span>${esc(m.text)} <small style="opacity:.7">[${esc(m.trust||'untrusted')}:${esc(m.source||'agent')}${m.expiresAt?' · TTL':''}]</small>${m.contradicts?.length?` <span class="badge review" title="Contradicts: ${esc(m.contradicts.map(c=>c.text).join('; '))}">CONTRADICTION</span>`:''}</span><button type="button" class="btn small" data-action="forget-note" data-id="${a.id}" data-i="${i}" aria-label="Remove note">×</button></li>`).join('')}</ol>`:'<div class="empty small">No notes yet.</div>';
  const whispers=a.whispers?.length?`<div class="whisper-box" style="margin-top:8px"><div class="meta-label" style="display:flex;justify-content:space-between;align-items:center"><span>HEARD ON THE GALLERY (${a.whispers.length})</span><button type="button" class="btn small" data-action="clear-whispers" data-id="${a.id}">Clear</button></div><ol class="memory-list">${a.whispers.map(w=>`<li><span><strong>${esc(w.from)} (L${w.level}):</strong> ${esc(w.text)}</span></li>`).join('')}</ol></div>`:'';
  return notes+whispers;
}
function openAgentEditor(a){const fresh=!a;a=a||{name:'',role:'',floor:currentFloor,level:SECTORS[currentFloor].home,provider:'demo',model:'',shadowId:'',instructions:'',color:'#cba574',tools:[],scopes:null,routing:null,contextBudget:0};
  const sc=a.scopes||{},rt=a.routing||{};
  showModal(`${modalHead(fresh?'New resident':'Edit '+esc(a.name),fresh?'Name, role, level and model.':esc(a.role))}<form id="agent-form"><div class="modal-body"><div class="form-grid"><div class="form-group"><label for="a-name">Name</label><input class="field" id="a-name" name="name" maxlength="50" value="${esc(a.name)}" placeholder="e.g. Nova" required></div><div class="form-group"><label for="a-role">Role</label><input class="field" id="a-role" name="role" maxlength="80" value="${esc(a.role)}" placeholder="e.g. Research specialist" required></div><div class="form-group"><label for="a-floor">Home sector</label><select class="select" id="a-floor" name="floor">${state.floors.map(f=>`<option value="${f.id}" ${a.floor===f.id?'selected':''}>${String(f.id+1).padStart(2,'0')} / ${esc(f.name)}</option>`).join('')}</select></div><div class="form-group"><label for="a-level">Level (1-144)</label><input class="field" id="a-level" name="level" type="number" min="1" max="144" value="${a.level||SECTORS[a.floor].home}" required></div><div class="form-group"><label for="a-provider">Intelligence provider</label><select class="select" id="a-provider" name="provider">${['demo',...Object.keys(providerInfo)].map(p=>`<option value="${p}" ${p===a.provider?'selected':''}>${p==='demo'?'Demo · scripted responses':providerInfo[p][0]}</option>`).join('')}</select></div><div class="form-group"><label for="a-model">Model override (optional)</label><input class="field" id="a-model" name="model" value="${esc(a.model)}" placeholder="Use connection default" maxlength="100"></div><div class="form-group"><label for="a-vision">Sees screenshots</label><select class="select" id="a-vision" name="vision">${[["auto","Guess from the model name"],["on","Yes, the model reads images"],["off","No, text only"]].map(([v,l])=>`<option value="${v}" ${(a.vision||"auto")===v?"selected":""}>${l}</option>`).join("")}</select></div><div class="form-group"><label for="a-shadow">Shadow apprentice (auto-failover)</label><select class="select" id="a-shadow" name="shadowId"><option value="">No shadow</option>${agentOptions(a.shadowId)}</select></div><div class="form-group"><label for="a-color">Uniform color</label><input class="field" type="color" id="a-color" name="color" value="${esc(a.color)}" style="height:39px"></div><div class="form-group"><label for="a-folders">Allowed folders scope (optional, comma-separated)</label><input class="field" id="a-folders" name="scopeFolders" value="${esc((sc.folders||[]).join(', '))}" placeholder="e.g. notes/it, reports"></div><div class="form-group"><label for="a-workspace">Isolated workspace subfolder (optional)</label><input class="field" id="a-workspace" name="scopeWorkspace" value="${esc(sc.workspace||'')}" placeholder="e.g. sector-1"></div><div class="form-group"><label for="a-ctx-budget">Context token budget (0 = global default)</label><input class="field" id="a-ctx-budget" name="contextBudget" type="number" min="0" max="200000" value="${a.contextBudget||0}"></div><div class="form-group"><label for="a-routing">Model routing policy</label><select class="select" id="a-routing" name="routingMode">${[['fixed','Fixed model'],['auto','Auto (cost / quality by complexity)'],['cost','Lowest cost'],['quality','Highest quality']].map(([k,l])=>`<option value="${k}" ${(rt.mode||'fixed')===k?'selected':''}>${l}</option>`).join('')}</select></div></div><div class="form-group"><label for="a-instructions">Instructions</label><textarea class="field" id="a-instructions" name="instructions" maxlength="12000" placeholder="What this resident does and how it should answer." required>${esc(a.instructions)}</textarea></div><div class="perm-grid"><div class="meta-label">PERMISSIONS</div>${connectorPerms(a)}${PERMS.map(([k,l,h])=>`<label class="check-label"><input type="checkbox" name="${k}" ${a.tools.includes(k)?'checked':''}><span>${l}<br><small>${h}</small></span></label>`).join('')}</div>${fresh?'':`<div class="form-group memory-box"><label for="memory-text">Notes this resident keeps</label><div id="memory-list">${memoryList(a)}</div><div class="memory-add"><input class="field" id="memory-text" maxlength="500" placeholder="Add a note, for example: answers in Romanian"><button type="button" class="btn small" data-action="add-note" data-id="${a.id}">Add note</button></div><small>Notes go with every mission. Residents with the notes permission add and remove their own.</small></div>`}${errEl()}</div><div class="modal-footer">${fresh?'':`<button type="button" class="btn danger" data-action="delete-agent" data-id="${a.id}">Remove resident</button>`}<button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn primary">${fresh?'Create resident':'Save changes'}</button></div></form>`,'agent');
  const updateLevelBounds=()=>{const range=SECTORS[Number($("#a-floor").value)];$("#a-level").min=range.start;$("#a-level").max=range.end;};$("#a-floor").onchange=()=>{updateLevelBounds();$("#a-level").value=SECTORS[Number($("#a-floor").value)].home;};updateLevelBounds();$("#memory-text")?.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();$("[data-action=add-note]").click();}});$("#agent-form").onsubmit=async e=>{e.preventDefault();const form=e.currentTarget;const d=Object.fromEntries(new FormData(form));d.floor=Number(d.floor);d.level=Number(d.level);d.contextBudget=Number(d.contextBudget)||0;const folders=String(d.scopeFolders||'').split(',').map(x=>x.trim()).filter(Boolean);const workspace=String(d.scopeWorkspace||'').trim();d.scopes={...(a.scopes||{}),folders,workspace};if(d.routingMode)d.routing={...(a.routing||{}),mode:d.routingMode};delete d.scopeFolders;delete d.scopeWorkspace;delete d.routingMode;d.tools=PERMS.map(p=>p[0]).filter(t=>d[t]);for(const p of PERMS)delete d[p[0]];for(const c of state.mcp||[]){if(d['mcp:'+c.id])d.tools.push('mcp:'+c.id);delete d['mcp:'+c.id];}const submit=form.querySelector('[type=submit]');submit.disabled=true;try{const result=await api(fresh?'/agents':'/agents/'+a.id,{method:fresh?'POST':'PUT',body:d});selected=result.id;await refresh();modal.close();render();toast(fresh?result.name+' added.':'Resident updated.');}catch(e){$('#form-error').textContent=e.message;}finally{submit.disabled=false;}};
}
function openConnection(p){const c=state.connections[p], info=providerInfo[p];showModal(`${modalHead('Connect '+info[0],'The key is saved encrypted on this computer.')}<form id="connection-form"><div class="modal-body">${p!=='ollama'?`<div class="form-group"><label for="api-key">API key ${c.configured?'(leave blank to retain current key)':''}</label><input class="field" id="api-key" name="key" type="password" autocomplete="new-password" placeholder="Paste your API key" ${c.configured?'':'required'}><small>SILO never writes this key to disk.</small></div>`:'<div class="info-banner">Start Ollama locally and install a model before testing.</div>'}<div class="form-group"><label for="api-model">${info[3]}</label><input class="field" id="api-model" name="model" value="${esc(c.model)}" placeholder="Exact model ID from your provider" required maxlength="100"></div>${p==='compatible'?'<div class="form-group"><label for="api-endpoint">HTTPS chat completions endpoint</label><input class="field" id="api-endpoint" name="endpoint" type="url" placeholder="https://your-provider.com/v1/chat/completions" required><small>Use an endpoint you trust. It receives your key and your prompts.</small></div>':''}${errEl()}</div><div class="modal-footer">${c.configured?`<button class="btn danger" type="button" data-action="disconnect" data-provider="${p}">Disconnect</button>`:''}<button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn primary">Save connection</button></div></form>`,'connection');$('#connection-form').onsubmit=async e=>{e.preventDefault();const submit=e.currentTarget.querySelector('[type=submit]');submit.disabled=true;try{await post('/connections',{provider:p,...Object.fromEntries(new FormData(e.currentTarget))});await refresh();modal.close();render();toast('Saved. Run a connection test before using it.');}catch(e){$('#form-error').textContent=e.message;}finally{submit.disabled=false;}};}
function toolLines(tools){return tools?.length?`<div class="tool-trace">${tools.map(t=>`<div class="${t.ok?'':'bad'}">&gt;&gt; ${esc(t.summary)}</div>`).join('')}</div>`:'';}
// AI on this computer: translations and key points made by the browser itself, see local-ai.js.
// Keyed c|agent|message, r|run|step or brief. Finished results are kept in this browser, so a reload shows them
// again, as long as the text they were made from has not changed and the language is the same.
const aiNotes=new Map(),aiExpect=new Set();
const AI_SAVED='silo-ai-notes',AI_SAVED_MAX=150,AI_SAVED_BYTES=1500000;
const aiHash=text=>{let h=0x811c9dc5;for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,0x01000193);}return (h>>>0).toString(36)+'.'+text.length;};
// Saved results belong to the person signed in. They are dropped on sign out, when a session ends, and when
// someone else signs in on this browser. Nothing is used before boot knows who is signed in.
let aiSaved=new Map(),aiOwner=null;
function setAiOwner(owner){
  aiOwner=owner;let saved=null;
  try{saved=JSON.parse(localStorage.getItem(AI_SAVED)||'null');}catch{}
  if(saved?.owner!==owner||!Array.isArray(saved?.notes)){aiSaved=new Map();try{localStorage.removeItem(AI_SAVED);}catch{}return;}
  aiSaved=new Map(saved.notes.filter(x=>Array.isArray(x)&&typeof x[0]==='string'&&x[1]?.text));
}
function clearAiSaved(){
  for(const n of aiNotes.values())n.abort?.abort();
  aiNotes.clear();aiSaved=new Map();aiOwner=null;try{localStorage.removeItem(AI_SAVED);}catch{}
}
function storeAiSaved(){
  if(!aiOwner)return;
  try{
    let list=[...aiSaved].sort((a,b)=>(b[1].time||0)-(a[1].time||0)).slice(0,AI_SAVED_MAX),json=JSON.stringify({owner:aiOwner,notes:list});
    while(json.length>AI_SAVED_BYTES&&list.length){list=list.slice(0,Math.floor(list.length*.8));json=JSON.stringify({owner:aiOwner,notes:list});}
    aiSaved=new Map(list);localStorage.setItem(AI_SAVED,json);
  }catch{}
}
function keepAiNote(key,n){aiSaved.set(key,{kind:n.kind,lang:n.lang,h:aiHash(n.source||''),text:n.text,same:!!n.same,plain:!!n.plain,time:Date.now()});storeAiSaved();}
function forgetAiNote(key){if(aiSaved.delete(key))storeAiSaved();}
function restoreAiNote(key){
  const x=aiSaved.get(key);if(!x||key!=='brief'&&x.lang!==aiPrefs.lang&&!x.same)return null;
  // A brief is about the log at the time it was made, so it stays even after new events.
  if(key!=='brief'&&x.h!==aiHash(aiSource(key)))return null;
  const n={...x,done:true,restored:true};aiNotes.set(key,n);return n;
}
const aiPrefs=(()=>{let p={};try{p=JSON.parse(localStorage.getItem('silo-ai')||'{}');}catch{}const nav=(navigator.language||'en').split('-')[0].toLowerCase();return {lang:AI_LANGS.some(([c])=>c===p.lang)?p.lang:AI_LANGS.some(([c])=>c===nav)?nav:'en',auto:!!p.auto};})();
function saveAiPrefs(){try{localStorage.setItem('silo-ai',JSON.stringify(aiPrefs));}catch{}}
function aiButtons(key,text,cls='ai-btn'){
  if(!text||text.length<40)return '';
  const t=localAI.can('translate')?`<button type="button" class="${cls}" data-action="ai-run" data-kind="translate" data-key="${esc(key)}" title="Translate into ${langName(aiPrefs.lang)} on this computer">TRANSLATE</button>`:'';
  const k=localAI.can('summarize')&&text.length>=600?`<button type="button" class="${cls}" data-action="ai-run" data-kind="summary" data-key="${esc(key)}" title="Key points, made on this computer">KEY POINTS</button>`:'';
  return t+k;
}
function aiNote(key){
  const n=aiNotes.get(key)||restoreAiNote(key);if(!n||n.hidden)return '';
  const dl=n.progress?' / DOWNLOADING '+n.progress+'%':'';
  const head=n.error?'COULD NOT FINISH':n.same?'ALREADY IN '+langName(n.lang).toUpperCase():n.plain?'THE LAST DAY':n.kind==='summary'?'KEY POINTS'+(n.done?'':', WORKING')+dl:langName(n.lang).toUpperCase()+(n.done?'':', TRANSLATING')+dl;
  const when=key==='brief'&&n.done&&n.time?' / '+age(n.time).toUpperCase():'';
  return `<div class="ai-note${n.error?' error':''}${n.done?'':' working'}"><div class="ai-note-head"><span>${head}${when} / ON THIS COMPUTER</span><button type="button" class="ai-btn" data-action="ai-hide" data-key="${esc(key)}">HIDE</button></div><div class="ai-note-body">${esc(n.error||n.text||'...')}</div></div>`;
}
const aiSlot=key=>`<div class="ai-slot" data-ai-slot="${esc(key)}">${aiNote(key)}</div>`;
function briefText(){
  const since=Date.now()-864e5,recent=state.events.filter(e=>e.time>=since),list=(recent.length?recent:state.events).slice(0,120);
  return list.map(e=>new Date(e.time).toLocaleString([],{weekday:'short',hour:'2-digit',minute:'2-digit'})+' '+e.title+(e.detail?': '+e.detail:'')).join('\n');
}
// Brief me without the summary model: counts and the lines that matter, in plain words.
function briefDigest(){
  const since=Date.now()-864e5,recent=state.events.filter(e=>e.time>=since),list=recent.length?recent:state.events.slice(0,40);
  if(!list.length)return 'Nothing happened yet.';
  const names={mission:['mission','missions'],workflow:['workflow event','workflow events'],error:['error','errors'],success:['success','successes'],file:['file','files'],agent:['resident change','resident changes'],system:['system event','system events']};
  const count=new Map();for(const e of list){const k=names[e.type]?e.type:'other';count.set(k,(count.get(k)||0)+1);}
  const parts=[...count].sort((a,b)=>b[1]-a[1]).map(([k,n])=>n+' '+(names[k]?names[k][n===1?0:1]:n===1?'other event':'other events'));
  const lines=[(recent.length?'In the last day: ':'Recently: ')+parts.join(', ')+'.'];
  const errors=list.filter(e=>e.type==='error').slice(0,5);
  if(errors.length)lines.push('','Errors:',...errors.map(e=>'* '+e.title+(e.detail?': '+e.detail.slice(0,140):'')));
  lines.push('','Latest:',...list.slice(0,5).map(e=>'* '+e.title));
  return lines.join('\n');
}
function aiSource(key){
  const [kind,id,n]=key.split('|');
  if(kind==='c')return getAgent(id)?.chats[Number(n)]?.content||'';
  if(kind==='r'){const r=state.runs.find(r=>r.id===id),i=Number(n);return (i<0?r?.output:r?.steps?.[i]?.output)||'';}
  if(kind==='brief')return briefText();
  return '';
}
function paintAiNote(key){for(const slot of document.querySelectorAll('[data-ai-slot]'))if(slot.dataset.aiSlot===key)slot.innerHTML=aiNote(key);}
async function runAi(key,kind,{quiet=false}={}){
  const text=aiSource(key);if(!text){if(!quiet)toast('There is nothing to work with yet.',true);return;}
  aiNotes.get(key)?.abort?.abort();
  const abort=new AbortController(),note={kind,text:'',done:false,lang:aiPrefs.lang,abort,hidden:quiet,source:text};aiNotes.set(key,note);paintAiNote(key);
  if(!quiet)for(const slot of document.querySelectorAll('[data-ai-slot]'))if(slot.dataset.aiSlot===key)slot.scrollIntoView({block:'nearest',behavior:'smooth'});
  const onProgress=p=>{note.progress=Math.min(100,Math.round((p||0)*100));paintAiNote(key);};
  try{
    if(kind==='summary'){
      try{
        if(key==='brief'&&!localAI.can('summarize'))throw Object.assign(new Error('no model'),{digest:true});
        const r=await localAI.summarize(text,{to:aiPrefs.lang,context:key==='brief'?'A log of what happened in the silo, newest first.':'',onProgress,signal:abort.signal});note.text=r.text;note.lang=r.lang;
      }catch(e){
        if(e.name==='AbortError'||key!=='brief')throw e;
        // No summary model here: the brief is put together without one, and translated when that is possible.
        note.plain=true;note.progress=0;note.text=briefDigest();note.lang='en';
        if(aiPrefs.lang!=='en'&&localAI.can('translate'))try{const r=await localAI.translate(note.text,{from:'en',to:aiPrefs.lang,signal:abort.signal});note.text=r.text;note.lang=aiPrefs.lang;}catch(x){if(x.name==='AbortError')throw x;}
      }
    }
    else{
      const r=await localAI.translate(text,{to:aiPrefs.lang,onProgress,signal:abort.signal,onChunk:t=>{note.text=t;note.progress=0;note.hidden=false;paintAiNote(key);}});
      note.same=!!r.same;note.text=r.same?'Nothing to translate.':r.text;if(r.same&&quiet)note.hidden=true;else note.hidden=false;
    }
    note.done=true;note.progress=0;note.hidden=note.hidden&&quiet&&note.same;note.time=Date.now();
    if(!note.hidden)keepAiNote(key,note);
  }catch(e){if(e.name==='AbortError')return;if(quiet){aiNotes.delete(key);paintAiNote(key);return;}note.error=e.message;note.done=true;note.hidden=false;if(!localAI.can(kind==='summary'?'summarize':'translate'))toast(e.message,true);}
  if(aiNotes.get(key)===note)paintAiNote(key);
}
// A new answer in another language is translated by itself when that is on and the model is already there.
// Only answers to a message sent from this chat count, not older ones already there when it opened.
function aiAuto(a){
  const fresh=aiExpect.delete(a.id);
  if(!fresh||!aiPrefs.auto||!localAI.can('translate'))return;
  const i=a.chats.length-1,m=a.chats[i];if(!m||m.role==='user'||m.error)return;
  const key='c|'+a.id+'|'+i;if(!aiNotes.has(key))runAi(key,'translate',{quiet:true});
}
let aiState=null;
function aiCard(){
  const st=aiState,word=x=>({available:'ready',downloadable:'can be downloaded',downloading:'downloading','after-download':'can be downloaded',unavailable:'not on this computer','no answer':'the browser did not answer',missing:'not in this browser'}[x]||'checking...');
  const any=['Translator','Summarizer','LanguageDetector'].some(n=>typeof window[n]?.create==='function');
  const needs=st&&Object.values(st).some(x=>x==='downloadable'||x==='downloading'||x==='after-download');
  return `<section class="settings-card" id="ai-card"><h3>AI on this computer</h3><p>Translate answers and get their key points inside the browser, with the models built into Chrome and Edge. Nothing is sent anywhere, it costs nothing and needs no key. The buttons appear on answers in chats and on run steps, and Brief me in Signals sums up the last day (without the summary model it counts and lists instead). Results are kept in this browser until the text they came from changes.</p>${any?`<p class="mono-line">TRANSLATION: ${word(st?.translate)} / LANGUAGES: ${word(st?.detect)} / KEY POINTS: ${word(st?.summarize)}</p>`:'<p class="mono-line">This browser has none of them. Use Chrome or Edge, version 138 or newer.</p>'}<div class="form-grid"><div class="form-group"><label for="ai-lang">Translate into</label><select id="ai-lang" class="field">${AI_LANGS.map(([c,n])=>`<option value="${c}" ${aiPrefs.lang===c?'selected':''}>${n}</option>`).join('')}</select></div></div><label class="check-label"><input type="checkbox" id="ai-auto" ${aiPrefs.auto?'checked':''}> Translate new chat answers by themselves when they are in another language</label>${any?`<div class="run-toolbar">${needs?button('Download the models','ai-prepare',true):''}${button('Check again','ai-check')}</div><p class="mono-line" id="ai-progress">${needs?'The language packs are small. The summary model is a few gigabytes and needs a recent computer.':''}</p>`:''}</section>`;
}
function paintAiCard(){const c=$('#ai-card');if(c)c.outerHTML=aiCard();}
async function checkAi(){aiState=null;paintAiCard();aiState=await localAI.check(aiPrefs.lang);paintAiCard();}
async function prepareAi(el){
  el.disabled=true;const line=()=>$('#ai-progress');
  const got=await localAI.prepare(aiPrefs.lang,(kind,x)=>{const p=line();if(p)p.textContent=(kind==='translate'?'Language pack':'Summary model')+': '+Math.round((x||0)*100)+'%';});
  aiState={...aiState,...got};paintAiCard();
  toast(Object.values(got).every(x=>x==='available')?'AI on this computer is ready.':'Some parts are not available in this browser.',!Object.values(got).every(x=>x==='available'));
}
function chatMessages(a){return a.chats.length?a.chats.map((m,i)=>`<div class="chat-bubble ${m.role==='user'?'user':''} ${m.error?'error':''}"><div class="chat-who">${m.role==='user'?'You':esc(a.name)}${m.role!=='user'&&!m.error&&voiceMode().tts!=='off'?`<button type="button" class="trace-link" data-action="speak-msg" data-id="${a.id}" data-i="${i}" title="Read this answer aloud">READ</button>`:''}${m.traceId?`<button type="button" class="trace-link" data-action="open-trace" data-id="${m.traceId}" title="Time, tools and cost of this answer">TRACE</button>`:''}${m.role!=='user'&&!m.error?aiButtons('c|'+a.id+'|'+i,m.content):''}</div>${toolLines(m.tools)}${esc(m.content)}${m.role!=='user'&&!m.error?aiSlot('c|'+a.id+'|'+i):''}${m.tools?.some(t=>(t.tool==='write_file'||t.tool==='patch_file')&&t.ok)?'<div><button class="btn small" data-action="nav" data-view="files">Review in the Archive →</button></div>':''}</div>`).join(''):`<div class="empty">${pixelAvatar(a)}No messages with ${esc(a.name)} yet.</div>`;}
let chatGen=0;
// Voice: say a message instead of typing it, and hear the answers.
// Speech to text runs in SILO (OpenAI or a compatible endpoint) or in the browser; answers are read by the
// voices of this device or by OpenAI.
let micState=null,speaking=null;
const SpeechRec=window.SpeechRecognition||window.webkitSpeechRecognition;
function voiceMode(){return state.voiceUse||{stt:'browser',tts:'browser'};}
function micButton(on,label){const b=$('#chat-mic');if(!b)return;b.classList.toggle('recording',on);b.textContent=label||(on?'Stop':'Talk');b.disabled=label==='Writing...';b.setAttribute('aria-pressed',String(on));}
function addHeard(text){const f=$('#message');if(!f||!text)return;f.value=(f.value.trim()?f.value.replace(/\s*$/,' '):'')+text;f.focus();}
async function toggleMic(){
  if(micState){micState.stop();return;}
  const mode=voiceMode().stt;
  if(mode==='off'){toast('Speech to text is off. Turn it on in System, Voice.',true);return;}
  if(mode==='missing'){toast('The service picked for speech to text is not connected. See System, Voice.',true);return;}
  if(mode==='browser'){
    if(!SpeechRec){toast('This browser cannot turn speech into text. Use Edge or Chrome, or pick OpenAI in System, Voice.',true);return;}
    const rec=new SpeechRec(),field=$('#message'),base=field.value.trim()?field.value.replace(/\s*$/,' '):'';let heard='';
    rec.lang=state.settings?.voice?.language||navigator.language||'en-US';rec.interimResults=true;rec.continuous=true;
    rec.onresult=e=>{let now='';for(let i=e.resultIndex;i<e.results.length;i++){const r=e.results[i];if(r.isFinal)heard+=r[0].transcript;else now+=r[0].transcript;}const f=$('#message');if(f)f.value=base+heard+now;};
    rec.onerror=e=>{if(e.error!=='aborted'&&e.error!=='no-speech')toast(e.error==='not-allowed'?'The microphone is blocked for this page.':'Speech to text stopped: '+e.error,true);};
    rec.onend=()=>{micState=null;micButton(false);$('#message')?.focus();};
    try{rec.start();}catch(e){toast(e.message,true);return;}
    micState={stop:()=>rec.stop()};micButton(true);return;
  }
  if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia){toast('The microphone works on this computer or over HTTPS. Open from anywhere, in System, gives you an HTTPS address.',true);return;}
  let stream;try{stream=await navigator.mediaDevices.getUserMedia({audio:true});}catch{toast('The microphone is blocked or missing.',true);return;}
  const type=['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4'].find(t=>window.MediaRecorder?.isTypeSupported?.(t))||'';
  let rec;try{rec=new MediaRecorder(stream,type?{mimeType:type}:{});}catch(e){stream.getTracks().forEach(t=>t.stop());toast('This browser cannot record sound.',true);return;}
  const parts=[],limit=setTimeout(()=>{if(rec.state==='recording')rec.stop();},120000);
  rec.ondataavailable=e=>{if(e.data.size)parts.push(e.data);};
  rec.onstop=async()=>{
    clearTimeout(limit);stream.getTracks().forEach(t=>t.stop());micState=null;micButton(false,'Writing...');
    try{
      const blob=new Blob(parts,{type:(rec.mimeType||type||'audio/webm')});if(blob.size<800){toast('That was too short.',true);return;}
      const r=await fetch('/api/voice/transcribe?mime='+encodeURIComponent(blob.type),{method:'POST',headers:{'Content-Type':'application/octet-stream','x-silo-token':token},body:blob});
      const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Speech to text failed.');
      if(d.text)addHeard(d.text);else toast('No words were heard.',true);
    }catch(e){toast(e.message,true);}finally{micButton(false);}
  };
  rec.start(250);micState={stop:()=>{if(rec.state!=='inactive')rec.stop();}};micButton(true);
}
// What is worth saying out loud: no code, links or markdown marks.
function speechText(t){
  return String(t||'').replace(/```[\s\S]*?```/g,' (code left out) ').replace(/`([^`]+)`/g,'$1').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/https?:\/\/\S+/g,'a link').replace(/^#{1,6}\s+/gm,'').replace(/^\s*[-*+]\s+/gm,'').replace(/[*_~]{1,3}([^*_~\n]+)[*_~]{1,3}/g,'$1').replace(/^\s*\|.*\|\s*$/gm,'').replace(/\[DEMO\]\s*/g,'').trim().slice(0,6000);
}
function stopSpeaking(){try{window.speechSynthesis?.cancel();}catch{}if(speaking){speaking.audio.pause();URL.revokeObjectURL(speaking.url);speaking=null;}}
function browserVoice(text){
  const voices=window.speechSynthesis?.getVoices()||[];let pref='';try{pref=localStorage.getItem('silo-voice')||'';}catch{}
  const lang=(state.settings?.voice?.language||(/[ăâîșțşţ]/i.test(text)?'ro':(navigator.language||'en'))).toLowerCase();
  return voices.find(v=>v.voiceURI===pref)||voices.find(v=>v.lang.toLowerCase().startsWith(lang.slice(0,2)))||null;
}
async function speakText(text,quiet=false){
  const busy=speaking||window.speechSynthesis?.speaking;stopSpeaking();if(busy&&!quiet)return;
  const mode=voiceMode().tts,clean=speechText(text);if(!clean)return;
  if(mode==='off'){if(!quiet)toast('Spoken answers are off. Turn them on in System, Voice.',true);return;}
  if(mode==='missing'){if(!quiet)toast('The service picked for spoken answers is not connected. See System, Voice.',true);return;}
  if(mode==='openai'||mode==='compatible'){
    try{
      const r=await fetch('/api/voice/speak',{method:'POST',headers:{'Content-Type':'application/json','x-silo-token':token},body:JSON.stringify({text:clean})});
      if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(d.error||'Could not read it out.');}
      const url=URL.createObjectURL(await r.blob()),audio=new Audio(url);speaking={audio,url};
      audio.onended=()=>{if(speaking?.audio===audio){URL.revokeObjectURL(url);speaking=null;}};await audio.play();
    }catch(e){toast(e.message,true);}
    return;
  }
  if(!window.speechSynthesis){toast('This browser has no voices.',true);return;}
  const voice=browserVoice(clean);
  for(const part of clean.match(/[^.!?\n]+[.!?]*\s*|\n+/g)||[clean]){if(!part.trim())continue;const u=new SpeechSynthesisUtterance(part.trim());if(voice){u.voice=voice;u.lang=voice.lang;}else if(state.settings?.voice?.language)u.lang=state.settings.voice.language;speechSynthesis.speak(u);}
}
function fillVoiceList(){
  const sel=$('#vo-device');if(!sel||!window.speechSynthesis)return;
  const voices=speechSynthesis.getVoices();let pref='';try{pref=localStorage.getItem('silo-voice')||'';}catch{}
  sel.innerHTML='<option value="">Pick by language</option>'+voices.map(v=>`<option value="${esc(v.voiceURI)}" ${v.voiceURI===pref?'selected':''}>${esc(v.name)} (${esc(v.lang)})${v.localService?'':' / online'}</option>`).join('');
}
if(window.speechSynthesis)speechSynthesis.onvoiceschanged=()=>fillVoiceList();
function voiceCard(){
  const v=state.settings?.voice||{},use=voiceMode();
  const sttName={browser:SpeechRec?'this browser (Edge sends the sound to Microsoft, Chrome to Google)':'nothing: this browser cannot do it',openai:'OpenAI',compatible:'the compatible endpoint',off:'nothing, it is off',missing:'nothing yet: connect the service you picked in IT'}[use.stt];
  const ttsName={browser:'the voices of this device',openai:'OpenAI',compatible:'the compatible endpoint',off:'nothing, it is off',missing:'nothing yet: connect the service you picked in IT'}[use.tts];
  const opts=(list,cur)=>list.map(([k,n])=>`<option value="${k}" ${cur===k?'selected':''}>${n}</option>`).join('');
  return `<section class="settings-card"><h3>Voice</h3><p>Talk to residents instead of typing, and hear their answers. The Talk button in a chat writes what you say into the message, so you can check it before sending. Voice notes sent to the phone bot are understood too, when speech to text runs in SILO.</p><div class="form-grid"><div class="form-group"><label for="vo-stt">Speech to text</label><select class="select" id="vo-stt">${opts([['auto','OpenAI when connected, else the browser'],['browser','The browser'],['openai','OpenAI'],['compatible','Compatible endpoint'],['off','Off']],v.stt||'auto')}</select></div><div class="form-group"><label for="vo-stt-model">Model</label><input class="field" id="vo-stt-model" maxlength="100" value="${esc(v.sttModel||'')}" placeholder="gpt-4o-mini-transcribe"></div><div class="form-group"><label for="vo-lang">Language</label><input class="field" id="vo-lang" maxlength="10" value="${esc(v.language||'')}" placeholder="ro, en, or empty to detect"></div><div class="form-group"><label for="vo-tts">Spoken answers</label><select class="select" id="vo-tts">${opts([['browser','Voices of this device'],['openai','OpenAI'],['compatible','Compatible endpoint'],['off','Off']],v.tts||'browser')}</select></div><div class="form-group"><label for="vo-tts-model">Voice model</label><input class="field" id="vo-tts-model" maxlength="100" value="${esc(v.ttsModel||'')}" placeholder="gpt-4o-mini-tts"></div><div class="form-group"><label for="vo-tts-voice">Voice name</label><input class="field" id="vo-tts-voice" maxlength="100" value="${esc(v.ttsVoice||'')}" placeholder="alloy, coral, sage..."></div><div class="form-group"><label for="vo-device">Voice on this device</label><select class="select" id="vo-device"><option value="">Pick by language</option></select></div></div><label class="check-label"><input type="checkbox" id="vo-auto" ${v.autoSpeak?'checked':''}> Read new answers aloud in chats</label><p class="mono-line">Now: speech to text uses ${esc(sttName)}. Answers are read by ${esc(ttsName)}.${use.stt==='openai'||use.stt==='compatible'||use.tts==='openai'||use.tts==='compatible'?' These calls count in Spending.':''}</p><div class="heading-actions">${button('Try the voice','try-voice')}${button('Save','save-voice',true)}</div></section>`;
}
// How the server keeps up: what a save costs, how late it answers, and live pages that fall behind.
function perfLine(p){
  if(!p)return '';const s=p.storage||{},l=p.loop||{},v=p.live||{};
  return `<p class="mono-line">Saving: last ${s.lastMs} ms, average ${s.avgMs} ms, slowest ${s.maxMs} ms. Last save: ${s.serialized} of ${s.rows} rows serialized (${s.kb} KB), ${s.skipped} finished ones skipped, ${s.written} written.<br>Server delay: ${l.p50} ms typical, ${l.p99} ms at worst 1 in 100, ${l.max} ms slowest.<br>Live pages: ${v.streams} open${v.behind?', '+v.behind+' behind':''}. Updates merged while a page was behind: ${v.skipped}, full refreshes: ${v.resyncs}, too slow and closed: ${v.slowClosed}.</p>`;
}
// Updates and start: the version, start at sign-in, and signed updates from a feed you pick.
function updateCard(u){
  const s=u.startup||{},a=u.available,busy=u.busy||u.checking;
  const runLine=u.supervised?'SILO runs under its supervisor: it comes back after a crash and restarts itself after an update.':'SILO was started directly (Start-Silo.cmd, npm start or node server.mjs), so it does not come back on its own after a crash or an update. Start it with npm run supervised, or install it with Install-SILO.cmd, for that.';
  const startLine=!s.supported?esc(s.error||'Start at sign-in works on Windows only.'):s.enabled&&!s.here?'A Startup shortcut exists, but it starts SILO from another folder: '+esc(s.target||'')+'. Turn this on to point it here.':s.enabled?'SILO starts, minimized, when you sign in to Windows.':'SILO starts only when you start it.';
  let state_='No update feed is set, so SILO does not look for updates.';
  if(u.feed){
    if(u.checking)state_='Looking for a newer version...';
    else if(u.busy==='downloading')state_='Downloading and checking the new version...';
    else if(u.busy==='installing')state_='Installing...';
    else if(u.staged)state_=`SILO ${esc(u.staged)} is downloaded and checked. ${u.supervised?'Install restarts SILO.':'After Install, restart SILO yourself.'}${u.quiet?'':' Install waits until nothing runs.'}`;
    else if(a)state_=`SILO ${esc(a.version)} is available${a.date?', from '+esc(a.date):''}${a.size?', '+(a.size/1e6).toFixed(1)+' MB':''}.`;
    else if(u.checkedAt)state_=`You have the newest version. Checked ${age(u.checkedAt)}.`;
    else state_='Not checked yet.';
  }
  const last=u.last?`<p class="mono-line">Last change: ${u.last.kind==='updated'?`updated from ${esc(u.last.from)} to ${esc(u.last.to)}`:`went back from ${esc(u.last.from)} to ${esc(u.last.to)}${u.last.reason?' ('+esc(u.last.reason)+')':''}`}${u.last.at?', '+new Date(u.last.at).toLocaleString():''}.</p>`:'';
  const acts=[button('Check now','update-check',false,!u.feed||busy?'disabled':''),a&&!u.staged?button('Download','update-download',true,busy?'disabled':''):'',u.staged?button('Install','update-install',true,busy?'disabled':''):'',u.backup?button(`Go back to ${esc(u.backup)}`,'update-rollback',false,busy?'disabled':''):'',u.supervised?button('Restart SILO','system-restart'):''].join('');
  return `<section class="settings-card" id="update-card"><h3>Updates and start</h3><p>Version <strong>${esc(u.version)}</strong> on Node.js ${esc(u.node)}. ${runLine}</p>${perfLine(u.perf)}<label class="check-label"><input type="checkbox" id="startup-toggle" ${s.enabled&&s.here?'checked':''} ${s.supported?'':'disabled'}> Start SILO when I sign in to Windows</label><p class="mono-line">${startLine}</p><div class="form-group"><label for="up-feed">Update feed</label><input class="field" id="up-feed" maxlength="500" value="${esc(u.feed||'')}" placeholder="https://example.com/silo/ or a folder like D:\\silo-releases"></div><label class="check-label"><input type="checkbox" id="up-auto" ${u.auto?'checked':''}> Install updates on their own when nothing runs${u.supervised?'':' (needs the supervisor)'}</label>${u.keyPresent?'':'<p class="modal-error">This copy has no release-key.pub, so it cannot check a release and installs none. The person who makes your releases adds it.</p>'}${u.error?`<p class="modal-error">${esc(u.error)}</p>`:''}<p class="mono-line">${state_}</p>${a?.notes&&!u.staged?`<p class="mono-line">What changed: ${esc(a.notes)}</p>`:''}${last}<p>Every release is signed. SILO checks the signature and every file before it changes anything, keeps the old version, and goes back on its own if the new one does not start. Your data is never part of an update.</p><div class="heading-actions">${button('Save','save-update',true)}${acts}</div></section>`;
}
// For companies: the audit log, OpenTelemetry export and single sign-on. Owners only.
const dayStr=t=>new Date(t).toISOString().slice(0,10);
function auditCard(a){
  const rows=(a.records||[]).map(r=>`<div class="audit-row ${r.outcome}"><span>${esc(new Date(r.time).toLocaleString())}</span><strong>${esc(r.action)}</strong><span>${esc(r.actor)}${r.role?' ('+esc(r.role)+')':''}${r.ip&&r.via!=='local'?' from '+esc(r.ip):''}</span><span>${esc(r.target||'')}${r.detail?' · '+esc(r.detail):''}</span></div>`).join('');
  const keep=[[0,'Always'],[12,'12 months'],[24,'2 years'],[36,'3 years'],[60,'5 years'],[84,'7 years']];
  return `<section class="settings-card" id="audit-card"><h3>Audit log</h3><p>Every sign-in, every change through SILO, every decision and every tool a resident uses, with who, when and from where. Each record is chained to the one before it with a key from the vault, so a record that is changed or removed shows up when you check the log. Passwords, keys and message text are never written into it.</p><div class="form-grid"><div class="form-group"><label for="au-from">From</label><input class="field" type="date" id="au-from" value="${dayStr(Date.now()-30*86400000)}"></div><div class="form-group"><label for="au-to">To</label><input class="field" type="date" id="au-to" value="${dayStr(Date.now())}"></div><div class="form-group"><label for="au-q">Only records with</label><input class="field" id="au-q" maxlength="100" placeholder="a name, an action, an address"></div><div class="form-group"><label for="au-months">Keep records</label><select class="select" id="au-months">${keep.map(([m,n])=>`<option value="${m}" ${a.months===m?'selected':''}>${n}</option>`).join('')}</select></div></div><p class="mono-line">${(a.size/1e6).toFixed(2)} MB on disk.${a.error?' Last write failed: '+esc(a.error):''}</p><div id="audit-verify" class="mono-line"></div><div class="audit-list">${rows||'<p class="mono-line">Nothing logged yet.</p>'}</div><div class="heading-actions">${button('Save','save-audit',true)}${button('Check the chain','audit-verify')}${button('Export CSV','audit-export',false,'data-format="csv"')}${button('Export JSON lines','audit-export',false,'data-format="jsonl"')}</div></section>`;
}
function otelCard(o){
  const st=o.status||{},sent=st.sent||{};
  const line=!o.enabled?'Export is off.':st.lastError?'Last send failed: '+esc(st.lastError)+(st.retryAt?' Trying again soon.':''):st.lastOk?`Sent ${sent.spans||0} spans and ${sent.logs||0} log records since SILO started. Last sent ${age(st.lastOk)}.`:'Nothing sent yet. Spans go out when a conversation, run or goal ends.';
  return `<section class="settings-card" id="otel-card"><h3>OpenTelemetry</h3><p>Send traces to your own observability tools over OTLP/HTTP: the OpenTelemetry Collector, Grafana, Honeycomb, Datadog, Jaeger, Langfuse and others. Every conversation, workflow run and goal becomes a trace, with model calls, tokens, cost and tool use as spans in the GenAI conventions. The audit log can go along as logs. Prompts and answers are never sent.</p><label class="check-label"><input type="checkbox" id="ot-enabled" ${o.enabled?'checked':''}> Send to a collector</label><div class="form-grid"><div class="form-group"><label for="ot-endpoint">Collector address</label><input class="field" id="ot-endpoint" maxlength="300" value="${esc(o.endpoint||'')}" placeholder="http://localhost:4318"></div><div class="form-group"><label for="ot-service">Service name</label><input class="field" id="ot-service" maxlength="60" value="${esc(o.service||'silo')}"></div><div class="form-group"><label for="ot-headers">Headers</label><input class="field" id="ot-headers" type="password" autocomplete="off" placeholder="${o.headerNames?.length?'Saved: '+esc(o.headerNames.join(', '))+'. Leave empty to keep.':'name=value, like x-honeycomb-team=...'}"></div></div><label class="check-label"><input type="checkbox" id="ot-traces" ${o.traces!==false?'checked':''}> Traces</label><label class="check-label"><input type="checkbox" id="ot-logs" ${o.logs!==false?'checked':''}> Audit log as logs</label><label class="check-label"><input type="checkbox" id="ot-content" ${o.content?'checked':''}> Include tool arguments (without secrets)</label><p class="mono-line">${line}${st.queued?' '+st.queued+' waiting.':''}${st.dropped?' '+st.dropped+' dropped while the collector was away.':''}</p><p class="mono-line">Plain http only to this computer or your own network. Headers are kept in the encrypted vault.</p><div class="heading-actions">${button('Save','save-otel',true)}${button('Send a test span','otel-test')}${o.headerNames?.length?button('Forget headers','otel-clear-headers'):''}</div></section>`;
}
function ssoCard(o){
  const g=o.groups||{},opt=(v,cur,n)=>`<option value="${v}" ${cur===v?'selected':''}>${n}</option>`;
  const owners=(state.users||[]).some(u=>u.role==='owner');
  return `<section class="settings-card" id="sso-card"><h3>Single sign-on</h3><p>Let people sign in with your company account through OpenID Connect: Microsoft Entra ID, Google Workspace, Okta, Auth0, Keycloak and others. SILO makes the account at the first sign-in and can take the role from the groups your provider sends. Register SILO in your provider as a web app with one of these redirect addresses:</p><p class="mono-line">${(o.redirects||[]).map(esc).join('<br>')}</p>${owners?'':'<p class="modal-error">Create an owner account first, in People and access.</p>'}<label class="check-label"><input type="checkbox" id="sso-enabled" ${o.enabled?'checked':''} ${owners?'':'disabled'}> Sign in with single sign-on</label><div class="form-grid"><div class="form-group"><label for="sso-issuer">Issuer</label><input class="field" id="sso-issuer" maxlength="300" value="${esc(o.issuer||'')}" placeholder="https://login.microsoftonline.com/TENANT/v2.0"></div><div class="form-group"><label for="sso-label">Button text</label><input class="field" id="sso-label" maxlength="40" value="${esc(o.label||'')}" placeholder="Contoso account"></div><div class="form-group"><label for="sso-client">Client ID</label><input class="field" id="sso-client" maxlength="300" autocomplete="off" value="${esc(o.clientId||'')}"></div><div class="form-group"><label for="sso-secret">Client secret</label><input class="field" id="sso-secret" type="password" autocomplete="new-password" placeholder="${o.hasSecret?'Saved. Leave empty to keep it.':'From your provider'}"></div><div class="form-group"><label for="sso-domains">Email domains let in</label><input class="field" id="sso-domains" maxlength="500" value="${esc((o.domains||[]).join(', '))}" placeholder="example.com, or empty for anyone your provider lets through"></div><div class="form-group"><label for="sso-default">New people get</label><select class="select" id="sso-default">${opt('none',o.defaultRole,'No role: only people in a group below')}${opt('viewer',o.defaultRole,'Viewer')}${opt('operator',o.defaultRole,'Operator')}</select></div><div class="form-group"><label for="sso-claim">Group claim</label><input class="field" id="sso-claim" maxlength="60" value="${esc(o.claim||'groups')}" placeholder="groups or roles"></div><div class="form-group"><label for="sso-scopes">Extra scopes</label><input class="field" id="sso-scopes" maxlength="300" value="${esc(o.scopes||'')}" placeholder="Optional, like groups"></div><div class="form-group"><label for="sso-g-owner">Groups that make owners</label><input class="field" id="sso-g-owner" maxlength="2000" value="${esc((g.owner||[]).join(', '))}"></div><div class="form-group"><label for="sso-g-operator">Groups that make operators</label><input class="field" id="sso-g-operator" maxlength="2000" value="${esc((g.operator||[]).join(', '))}"></div><div class="form-group"><label for="sso-g-viewer">Groups that make viewers</label><input class="field" id="sso-g-viewer" maxlength="2000" value="${esc((g.viewer||[]).join(', '))}"></div><div class="form-group"><label for="sso-passwords">Names and passwords work</label><select class="select" id="sso-passwords">${opt('on',o.passwords,'Everywhere, next to single sign-on')}${opt('local',o.passwords,'Only on this computer, as a way back in')}</select></div></div><p class="mono-line">${o.on?'On. The sign-in page shows the button.':'Off.'} With group rules, the role follows the provider at every sign-in, and the last owner always stays owner. People an owner removes are not let back in on their own${o.blocked?' ('+o.blocked+' now)':''}.</p><div class="heading-actions">${button('Save','save-sso',true)}${button('Check the provider','sso-test')}${o.blocked?button('Let removed people in again','sso-unblock'):''}</div></section>`;
}
function auditQuery(extra={}){const p=new URLSearchParams({from:$('#au-from').value,to:$('#au-to').value,q:$('#au-q').value.trim(),...extra});return p.toString();}
const listOf=v=>v.split(',').map(x=>x.trim()).filter(Boolean);
// After a restart the page waits for SILO to answer again, then loads fresh, so the new app.js is used.
async function waitForRestart(r){
  if(!r?.restarting)return;
  await new Promise(r=>setTimeout(r,2500));
  for(let i=0;i<60;i++){try{const r=await fetch('/api/session',{cache:'no-store'});if(r.ok){location.reload();return;}}catch{}await new Promise(r=>setTimeout(r,1000));}
  toast('SILO did not come back within a minute. Look at data\\logs\\silo.log.',true);
}
async function updateAction(path,ok){const card=$('#update-card');card?.querySelectorAll('button').forEach(b=>b.disabled=true);let r=null;try{r=await post(path,{});if(ok)toast(ok(r));}catch(e){toast(e.message,true);}if(view==='settings'&&!r?.restarting)loadSystemInfo();return r;}
function openChat(a){if(micState)micState.stop();selected=a.id;const myChatGen=++chatGen;showModal(`${modalHead(esc(a.name),`${esc(a.role)} · ${a.provider==='demo'?'Demo mode / scripted responses':esc(a.provider)+' / '+esc(a.model||state.connections[a.provider]?.model||'no model set')}`)}<div class="chat-log" id="chat-log">${chatMessages(a)}</div><form class="chat-input" id="chat-form"><textarea id="message" class="field" placeholder="Message for ${esc(a.name)}" required maxlength="15000" aria-label="Your mission"></textarea>${voiceMode().stt!=='off'?'<button class="btn" type="button" id="chat-mic" data-action="chat-mic" aria-pressed="false" title="Speak your message">Talk</button>':''}<button class="btn primary" type="submit">Send ${icon('arrow')}</button></form><div class="chat-hint">CTRL + ENTER TO SEND · ${a.tools.length?'TOOLS: '+esc(a.tools.map(t=>permLabel(t,true)).join(' / ')):'CONVERSATION ONLY'}</div>`,'chat');const log=$('#chat-log');log.scrollTop=log.scrollHeight;aiAuto(a);
  $('#chat-form').onsubmit=async e=>{e.preventDefault();const field=$('#message'),message=field.value.trim();if(!message)return;const submit=e.currentTarget.querySelector('button');submit.disabled=true;field.disabled=true;log.innerHTML+=`<div class="chat-bubble user"><div class="chat-who">You</div>${esc(message)}</div><div class="chat-bubble" id="thinking"><div class="chat-who">${esc(a.name)}</div><span id="thinking-body">Working...</span></div>`;log.scrollTop=log.scrollHeight;let chatInFlight=false,chatAbort=null;const poll=setInterval(async()=>{if(chatInFlight||!modal.open||modalKind!=='chat'||selected!==a.id||chatGen!==myChatGen)return;chatInFlight=true;chatAbort=new AbortController();try{const d=streamUp?(liveText.get(a.id)||{text:'',note:''}):await api('/agents/'+a.id+'/live',{signal:chatAbort.signal});if(chatGen!==myChatGen||selected!==a.id||!modal.open||modalKind!=='chat')return;const el=$('#thinking-body');if(el&&(d.text||d.note)){el.innerHTML=(d.note?`<div class="live-note">${esc(d.note)}</div>`:'')+esc(d.text||'Working...')+'<span class="live-cursor"></span>';log.scrollTop=log.scrollHeight;}}catch{}finally{chatInFlight=false;}},streamUp?100:400);aiExpect.add(a.id);try{await post('/agents/'+a.id+'/chat',{message});await refresh();if(modal.open&&modalKind==='chat'&&selected===a.id){openChat(getAgent(a.id));$('#message').focus();if(state.settings?.voice?.autoSpeak){const last=getAgent(a.id)?.chats.at(-1);if(last&&last.role!=='user'&&!last.error)speakText(last.content,true);}}toast(a.name+' replied.');}catch(e){toast(e.message,true);try{await refresh();if(modal.open&&modalKind==='chat'&&selected===a.id&&getAgent(a.id))openChat(getAgent(a.id));}catch{}}finally{clearInterval(poll);chatAbort?.abort();submit.disabled=false;field.disabled=false;}};
}
const STEP_TYPES={agent:'Resident',action:'App step',review:'Review',approval:'Approval',wait:'Wait'};
const WAIT_UNITS=[['minutes','minutes'],['hours','hours'],['days','days'],['until','until a time']],DAY_NAMES=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const waitText=s=>s.unit==='until'?`until ${s.time}${s.day>=0?' on '+DAY_NAMES[s.day]:', any day'}`:`${s.amount} ${s.amount===1?s.unit.replace(/s$/,''):s.unit}`;
const whenAt=t=>new Date(t).toLocaleString('en-GB',{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
const STEP_HINT={agent:"What should this resident do? The brief and the previous step's output are added unless you place them yourself.",review:'What should the reviewer check? For example: has real numbers, no jargon, fits on one page.',approval:'Optional. What should you check before the workflow goes on?',action:'',wait:''};
// App steps: one operation of a connector or a connected account, called directly. The list comes from the server once per editor.
let actionApps=null;
const LONG_FIELD=/^(text|body|content|message|description|html|markdown|notes?|comment|summary|query)$/i;
function actionAppOptions(sel){
  if(!actionApps)return '<option value="">Loading apps...</option>';
  const known=actionApps.some(a=>a.id===sel);
  return `<option value="">${actionApps.length?'Pick an app':'No apps yet. Connect one in IT / Uplink.'}</option>${[['account','Your accounts'],['connector','Connectors']].map(([k,l])=>{const list=actionApps.filter(a=>a.kind===k);return list.length?`<optgroup label="${l}">${list.map(a=>`<option value="${esc(a.id)}" ${a.id===sel?'selected':''}>${esc(a.name)}${a.connected===false?' (not connected yet)':a.error?' (not reachable)':''}</option>`).join('')}</optgroup>`:'';}).join('')}${sel&&!known?`<option value="${esc(sel)}" selected>Removed app</option>`:''}`;
}
function actionOpOptions(app,sel){
  const a=actionApps?.find(x=>x.id===app);if(!a)return '<option value="">Pick the app first</option>';
  const group=(write,label)=>{const list=a.ops.filter(o=>o.write===write);return list.length?`<optgroup label="${label}">${list.map(o=>`<option value="${esc(o.name)}" ${o.name===sel?'selected':''}>${esc(o.label&&o.label!==o.name?o.name.replace(/_/g,' ')+': '+o.label:o.name.replace(/_/g,' '))}</option>`).join('')}</optgroup>`:'';};
  return `<option value="">${a.ops.length?'Pick what it does':'This app has no operations right now'}</option>${group(false,'Reads')}${group(true,'Changes something')}${sel&&!a.ops.some(o=>o.name===sel)?`<option value="${esc(sel)}" selected>${esc(sel)} (not found)</option>`:''}`;
}
const TYPE_TAG={integer:'whole number',number:'number',boolean:'yes or no',array:'list',object:'JSON'};
const FIELD_HINT={string:'Text, or a value from before',integer:'A whole number',number:'A number',boolean:'yes or no',array:'a, b, c',object:'{"key": "value"}'};
function actionFieldsHtml(box,values){
  const a=actionApps?.find(x=>x.id===box.querySelector('.step-app').value),op=a?.ops.find(o=>o.name===box.querySelector('.step-op').value);
  const note=box.querySelector('.act-note');
  if(!op){note.textContent=a?.error?'This app is not reachable right now: '+a.error:'';return '';}
  note.textContent=(a.connected===false?`${a.name} is not connected yet. Connect it in IT / Uplink before this runs. `:'')+(op.write?`Changes something in ${a.name}. Test runs do not call it; they show what it would get.`:`Only reads from ${a.name}.`);
  const uid=Math.random().toString(36).slice(2,8);
  return op.fields.length?op.fields.map(f=>{const v=values[f.name]??'',id='af-'+uid+'-'+f.name.replace(/\W/g,'_'),list=f.options?.length?`<datalist id="${id}-l">${f.options.map(o=>`<option value="${esc(o)}">`).join('')}</datalist>`:'';
    const input=LONG_FIELD.test(f.name)&&f.type==='string'?`<textarea class="field act-input" id="${id}" data-name="${esc(f.name)}" rows="2" spellcheck="false" placeholder="${esc(f.description||(f.options?.length?'One of: '+f.options.slice(0,4).join(', ')+(f.options.length>4?' and more':''):FIELD_HINT[f.type]||''))}">${esc(v)}</textarea>`:`<input class="field act-input" id="${id}" data-name="${esc(f.name)}" value="${esc(v)}" spellcheck="false" autocomplete="off" placeholder="${esc(f.description||(f.options?.length?'One of: '+f.options.slice(0,4).join(', ')+(f.options.length>4?' and more':''):FIELD_HINT[f.type]||''))}"${list?` list="${id}-l"`:''}>`;
    return `<div class="act-field"><label for="${id}">${esc(f.name.replace(/^body\./,'').replace(/[._]/g,' '))}${f.required?' <b>needed</b>':''}<small>${TYPE_TAG[f.type]||''}</small></label>${input}${list}</div>`;}).join(''):'<small class="act-empty">Nothing to fill in.</small>';
}
function fillActionEditor(ed,keep){
  const box=ed.querySelector('.step-action');if(!box)return;
  const values=keep||JSON.parse(box.dataset.fields||'{}');
  const app=box.querySelector('.step-app'),op=box.querySelector('.step-op');
  app.innerHTML=actionAppOptions(app.value||box.dataset.app||'');op.innerHTML=actionOpOptions(app.value,op.value||box.dataset.op||'');
  box.querySelector('.act-fields').innerHTML=actionFieldsHtml(box,values);
}
// App steps use the accounts directly, so only an owner adds or changes them. With no accounts, this computer's user is the owner.
const ownerHere=()=>!me||me.role==='owner';
const actionValues=box=>Object.fromEntries([...box.querySelectorAll('.act-input')].map(i=>[i.dataset.name,i.value]));
const VARS=[['{{brief}}','brief'],['{{previous}}','previous'],['{{step 1}}','step N'],['{{step 1.id}}','one value'],['{{item}}','item'],['{{feedback}}','feedback'],['{{file notes.md}}','file']];
function agentOptions(id){return state.floors.map((f,fi)=>`<optgroup label="${esc(f.name)}">${state.agents.filter(a=>a.floor===fi).sort((x,y)=>(x.level||0)-(y.level||0)).map(a=>`<option value="${a.id}" ${a.id===id?'selected':''}>L${String(a.level||0).padStart(3,'0')} / ${esc(a.name)} / ${esc(a.role)}${a.provider==='demo'?' (demo)':''}</option>`).join('')}</optgroup>`).join('');}
function targetOptions(i,sel){let o='';for(let n=1;n<=i;n++)o+=`<option value="${n}" ${n===sel?'selected':''}>STEP ${pad2(n)}</option>`;return o||'<option value="">NO EARLIER STEP</option>';}
function whenOptions(i,sel){let o=`<option value="0" ${!sel?'selected':''}>PREVIOUS STEP</option>`;for(let n=1;n<=i;n++)o+=`<option value="${n}" ${n===sel?'selected':''}>STEP ${pad2(n)}</option>`;return o;}
function stepEditor(s={},i=0){const type=s.type||'agent',w=s.when,ex=s.onExhausted||'fail',lock=type==='action'&&!ownerHere();return `<div class="flow-step-editor" data-type="${type}" data-each="${s.each?1:0}" data-unit="${s.unit==='until'?'until':'span'}"><div class="flow-step-top"><span class="step-n">${pad2(i+1)}</span><select class="select step-type" aria-label="Kind of step">${Object.entries(STEP_TYPES).map(([v,l])=>`<option value="${v}" ${v===type?'selected':''} ${v==='action'&&type!=='action'&&!ownerHere()?'disabled':''}>${l}${v==='action'&&type!=='action'&&!ownerHere()?' (owner only)':''}</option>`).join('')}</select><select class="select step-agent" aria-label="Resident for this step">${agentOptions(s.agentId)}</select><button type="button" class="btn small" data-action="step-up" aria-label="Move step up">↑</button><button type="button" class="btn small" data-action="step-down" aria-label="Move step down">↓</button><button type="button" class="btn small" data-action="remove-step" aria-label="Remove step">×</button></div>${lock?'<small class="act-lock">Only an owner can change an app step, because it uses the accounts of this SILO directly. You can run it and change the other steps.</small>':''}<div class="step-opts"${lock?' inert':''}><label class="opt-par"><input type="checkbox" class="step-parallel" ${s.parallel?'checked':''}> Same time as the step above</label><span class="opt-when">RUN <select class="select step-when-mode" aria-label="When this step runs"><option value="">always</option><option value="contains" ${w&&w.op!=='missing'?'selected':''}>when</option><option value="missing" ${w?.op==='missing'?'selected':''}>unless</option></select><span class="when-detail"><select class="select step-when-src" aria-label="Answer to look at">${whenOptions(i,w?.step||0)}</select> SAYS <input class="field step-when-text" maxlength="200" value="${esc(w?.text||'')}" placeholder="URGENT" aria-label="Text to look for"></span></span></div><div class="step-loop"${lock?' inert':''}><label class="check-label"><input type="checkbox" class="step-each-on" ${s.each?'checked':''}> For each item in</label><input class="field step-each" maxlength="200" value="${esc(s.each||'{{step 1}}')}" spellcheck="false" aria-label="List to repeat over"><small>The step runs once for each item of that list, at most 100. Use {{item}} or one value of it, like {{item.email}}. Its answer is the list of answers.</small></div><div class="step-review-opts"><label>Send back to <select class="select step-target" aria-label="Step to send work back to">${targetOptions(i,s.target||i)}</select></label><label>At most <input class="field step-rounds" type="number" min="1" max="5" value="${s.rounds||2}" aria-label="Rounds at most"> rounds</label><label>If unapproved <select class="select step-exhausted" aria-label="Policy if unapproved"><option value="fail" ${ex==='fail'?'selected':''}>Stop workflow</option><option value="ask" ${ex==='ask'?'selected':''}>Ask operator</option><option value="accept" ${ex==='accept'?'selected':''}>Accept with warning</option></select></label></div><div class="step-action"${lock?' inert':''} data-app="${esc(s.app||'')}" data-op="${esc(s.op||'')}" data-fields="${esc(JSON.stringify(s.fields||{}))}"><div class="act-pick"><select class="select step-app" aria-label="App for this step"><option value="${esc(s.app||'')}">Loading apps...</option></select><select class="select step-op" aria-label="What the app does"><option value="${esc(s.op||'')}"></option></select></div><small class="act-note"></small><div class="act-fields"></div><div class="var-chips act-chips"><span>INSERT</span>${[['{{brief}}','brief'],['{{previous}}','previous'],['{{step 1}}','step N'],['{{step 1.id}}','one value'],['{{item}}','item']].map(([v,l])=>`<button type="button" class="chip" data-action="insert-var" data-var="${v}">${l}</button>`).join('')}</div><small class="act-help">Each field takes words, an earlier answer, or one value out of an answer that is JSON, like {{step 2.id}} or {{previous.items[0].email}}. Empty fields are left out.</small><label class="act-retry">If the app is busy, try again <select class="select step-retries" aria-label="Tries when the app is busy">${[0,1,2,3,5].map(n=>`<option value="${n}" ${n===(s.retries??2)?'selected':''}>${n===0?'no':n+(n===1?' time':' times')}</option>`).join('')}</select></label></div><div class="step-wait"><span>WAIT</span><input class="field step-wait-amount" type="number" min="1" max="43200" value="${s.amount||1}" aria-label="How long to wait"><select class="select step-wait-unit" aria-label="Unit">${WAIT_UNITS.map(([v,l])=>`<option value="${v}" ${v===(s.unit||'hours')?'selected':''}>${l}</option>`).join('')}</select><span class="wait-until"><input class="field step-wait-time" type="time" value="${esc(s.time||'09:00')}" aria-label="Time of day"><select class="select step-wait-day" aria-label="Day"><option value="-1">any day</option>${[1,2,3,4,5,6,0].map(d=>`<option value="${d}" ${d===s.day?'selected':''}>on ${DAY_NAMES[d]}</option>`).join('')}</select></span><small>The run waits here, then goes on. It keeps waiting through a restart of SILO. Test runs do not wait.</small></div><textarea class="field step-prompt" maxlength="10000" placeholder="${esc(STEP_HINT[type])}" aria-label="Step instructions">${esc(s.prompt||'')}</textarea><div class="var-chips"><span>INSERT</span>${VARS.map(([v,l])=>`<button type="button" class="chip" data-action="insert-var" data-var="${v}">${l}</button>`).join('')}</div></div>`;}
// App triggers: the list comes from the server, with the fields each one needs.
const APP_SERVICE_NAMES={google:'Google',microsoft:'Microsoft 365',slack:'Slack',github:'GitHub',notion:'Notion'};
function appFields(kind,cfg={},w={}){
  const t=(state.appTriggers||[]).find(x=>x.kind===kind);if(!t)return '';
  const every=cfg.every||60,opts=[[15,'Every 15 seconds'],[60,'Every minute'],[300,'Every 5 minutes']].filter(([v])=>t.service||v>=60);
  const app=t.instant==='github'?'GitHub':t.instant==='slack'?'Slack':'the app',saved=w.app?.kind===kind&&w.app?.instant;
  const fieldHtml=f=>{
    if(!f.options)return `<label class="app-field"><small>${esc(f.label)}</small><input class="field" name="app_${f.key}" maxlength="500" ${f.number?'type="number" min="1" max="1440"':''} value="${esc(cfg[f.key]||'')}" placeholder="${esc(f.placeholder||'')}" spellcheck="false"></label>`;
    const cur=f.options.find(o=>o.value===cfg[f.key])||f.options[0],groups=[...new Set(f.options.map(o=>o.group))];
    return `<label class="app-field"><small>${esc(f.label)}</small><select class="select" name="app_${f.key}">${groups.map(g=>`<optgroup label="${esc(g)}">${f.options.filter(o=>o.group===g).map(o=>`<option value="${esc(o.value)}" data-hint="${esc(o.hint)}" data-setup="${esc(o.setup)}" ${o===cur?'selected':''}>${esc(o.label)}</option>`).join('')}</optgroup>`).join('')}</select><small class="hook-hint">${esc(cur.setup)}</small></label>`;
  };
  // Apps that send events: no checks to time, the secret comes from the app.
  if(t.instant==='any'){
    const hookApp=t.fields.find(f=>f.options)?.options.find(o=>o.value===cfg.app)||t.fields.find(f=>f.options)?.options[0]||{};
    return t.fields.map(fieldHtml).join('')+`<input type="checkbox" name="app_instant" checked hidden>`
      +`<label class="app-field app-signing"><small>Secret from the app</small><input class="field" type="password" name="app_signing" autocomplete="off" maxlength="500" placeholder="${saved&&w.app?.app===cfg.app?'Saved. Leave empty to keep it.':esc(hookApp.hint||'')}"></label>`
      +`<div class="app-hook-info">${saved&&w.id?`${button('Show the webhook address','apphook-show',false,`type="button" data-id="${w.id}"`)}<div class="app-hook-out"></div>`:'<small>Save the workflow, then open it again to see the address to give the app.</small>'}<small>Each event is checked against the app\'s signature. Events with a wrong one are refused.</small></div>`;
  }
  return t.fields.map(fieldHtml).join('')
    +`<label class="app-field"><small>Check for new ones</small><select class="select" name="app_every">${opts.map(([v,l])=>`<option value="${v}" ${v===every?'selected':''}>${l}</option>`).join('')}</select></label>`
    +(t.instant?`<label class="check-label"><input type="checkbox" name="app_instant" ${cfg.instant?'checked':''}> Instant: ${app} sends each one the moment it happens</label>`
      +(t.instant==='slack'?`<label class="app-field app-signing"><small>Signing secret of your Slack app (Basic Information, App Credentials)</small><input class="field" type="password" name="app_signing" autocomplete="off" placeholder="${saved?'Saved. Leave empty to keep it.':''}"></label>`:'')
      +`<div class="app-hook-info">${saved&&w.id?`${button('Show the webhook address','apphook-show',false,`type="button" data-id="${w.id}"`)}<div class="app-hook-out"></div>`:'<small>Save the workflow, then open it again to see the address to give '+app+'.</small>'}<small>The checks keep running too, so nothing is missed if an event gets lost.</small></div>`:'');
}
function appTriggerLine(w){
  const list=state.appTriggers||[],usable=t=>!t.service||!!state.services?.[t.service],cur=w.app?.kind||list.find(usable)?.kind||'';
  const grp=t=>t.service||(t.instant==='any'?'hooks':'web');
  const groups=[...new Set(list.map(grp))].map(svc=>{const on=svc==='web'||svc==='hooks'||!!state.services?.[svc];return `<optgroup label="${svc==='web'?'Web, no account':svc==='hooks'?'Apps that send events':esc(APP_SERVICE_NAMES[svc]||svc)+(on?'':' (connect it in IT / Uplink)')}">${list.filter(t=>grp(t)===svc).map(t=>`<option value="${t.kind}" ${t.kind===cur?'selected':''} ${on?'':'disabled'}>${esc(t.label)}</option>`).join('')}</optgroup>`;}).join('');
  const status=w.app?.kind==='webhook.app'?(w.appEventAt?'Last event '+age(w.appEventAt)+'.':'Waits for events from the app.'):(w.appError?esc('Last check failed: '+w.appError):w.appChecked?'Last checked '+age(w.appChecked)+'.':'Only what comes after you save counts.')+(w.appEventAt?' Last instant event '+age(w.appEventAt)+'.':'');
  return `<label class="check-label"><input type="checkbox" name="appOn" ${w.app?'checked':''}> When something happens in an app</label><div class="trigger-line app-line"><select class="select" name="appKind" aria-label="What starts the workflow">${groups}</select><div class="app-fields">${appFields(cur,w.app||{},w)}</div><small class="app-status">${status}</small></div>`;
}
function triggerEditor(w){
  const days=[1,2,3,4,5,6,0].map(d=>`<label class="day"><input type="checkbox" name="day" value="${d}" ${w.days.includes(d)?'checked':''}>${DAYS[d]}</label>`).join('');
  const hook=w.hook==='redacted'?'<div class="trigger-line hook-line"><small>Webhook token hidden for viewer role.</small></div>':w.hook?`<div class="trigger-line hook-line"><code>POST ${location.origin}/hook/${w.hook}</code><button type="button" class="btn small" data-action="copy-hook" data-url="${location.origin}/hook/${w.hook}">Copy</button><label class="check-label"><input type="checkbox" name="hookNew"> New address on save</label></div>`:'<div class="trigger-line hook-line"><small>The address appears here after you save. Send it a POST with the brief as text or as JSON {"input": "..."}.</small></div>';
  return `<fieldset class="trigger-box"><legend>TRIGGERS AND LIMITS</legend><label class="check-label"><input type="checkbox" name="enabled" ${w.enabled?'checked':''}> On a schedule</label><div class="trigger-line sched"><select class="select" name="mode" aria-label="Schedule kind"><option value="interval">every</option><option value="daily" ${w.mode==='daily'?'selected':''}>every day at</option></select><span class="m-interval"><input class="field" type="number" name="interval" min="1" max="10080" value="${w.interval}" aria-label="Minutes between runs"> minutes</span><span class="m-daily"><input class="field" type="time" name="at" value="${w.at}" aria-label="Time of day"> on ${days}</span></div><label class="check-label"><input type="checkbox" name="hookOn" ${w.hook?'checked':''}> Local webhook, for scripts and programs on this computer</label>${hook}<label class="check-label"><input type="checkbox" name="watchOn" ${w.watch?'checked':''}> When a text file arrives in a workspace folder</label><div class="trigger-line watch-line"><input class="field" name="watch" maxlength="120" value="${esc(w.watch||'inbox')}" aria-label="Folder to watch"><small>The file goes into the brief. Files already in the folder are left alone.</small></div><label class="check-label"><input type="checkbox" name="mailOn" ${w.mail?'checked':''}> When an email arrives</label><div class="trigger-line mail-line"><div class="mail-grid"><input class="field" name="mailHost" maxlength="200" value="${esc(w.mail?.host||'')}" placeholder="IMAP server, like imap.gmail.com" aria-label="IMAP server"><input class="field" name="mailPort" type="number" min="1" max="65535" value="${w.mail?.port||993}" aria-label="IMAP port"><input class="field" name="mailUser" maxlength="200" autocomplete="off" value="${esc(w.mail?.user||'')}" placeholder="User name or address" aria-label="Mail user name"><input class="field" name="mailPass" type="password" autocomplete="new-password" placeholder="${w.mail?'Saved. Leave empty to keep it.':'Password or app password'}" aria-label="Mail password"><input class="field" name="mailFolder" maxlength="100" value="${esc(w.mail?.folder||'INBOX')}" aria-label="Folder"><input class="field" name="mailFrom" maxlength="200" value="${esc(w.mail?.from||'')}" placeholder="Only from (optional)" aria-label="Only mail from"><input class="field" name="mailSubject" maxlength="200" value="${esc(w.mail?.subject||'')}" placeholder="Subject contains (optional)" aria-label="Subject contains"></div><div class="mail-check">${button('Check inbox','mail-test',false,`type="button" data-id="${w.id||''}"`)}<small class="mail-status">${w.mailError?esc('Last check failed: '+w.mailError):w.mailChecked?'Last checked '+age(w.mailChecked)+'.':'Checked every minute. Mail stays unread. Gmail and Outlook need an app password.'}</small></div></div>${appTriggerLine(w)}<div class="trigger-line"><label>Token budget per run <input class="field" type="number" name="budget" min="0" step="1000" value="${w.budget||0}"></label><small>0 means no limit. The run stops before the next step once it is used up.</small></div></fieldset>`;
}
const SHAPE_TYPE_NAMES={text:'Text',number:'Number',date:'Date',boolean:'Yes or no',list:'List'};
function shapeFieldRow(f={}){return `<div class="shape-field"><input class="field sf-name" maxlength="40" value="${esc(f.name||'')}" placeholder="Field name, e.g. total" aria-label="Field name"><select class="select sf-type" aria-label="Field type">${Object.entries(SHAPE_TYPE_NAMES).map(([k,v])=>`<option value="${k}" ${f.type===k?'selected':''}>${v}</option>`).join('')}</select><label class="check-label"><input type="checkbox" class="sf-req" ${f.required===false?'':'checked'}> Required</label><button type="button" class="btn small" data-action="remove-shape-field">Remove</button></div>`;}
function shapeEditor(w){const sh=w.shape;return `<fieldset class="trigger-box"><legend>RESULT SHAPE</legend><label class="check-label"><input type="checkbox" name="shapeOn" ${sh?'checked':''}> Return fixed fields as JSON</label><div class="shape-body"><small>The last resident step is told the fields. SILO checks every run: missing fields, numbers that are not numbers, dates that are not dates. A wrong result goes back once for a fix, then the run fails. Webhooks get the fields as data.</small><label class="check-label"><input type="checkbox" class="sf-many" ${sh?.many?'checked':''}> A list of items, each with these fields</label><div id="shape-fields">${(sh?.fields?.length?sh.fields:[{}]).map(shapeFieldRow).join('')}</div><button type="button" class="btn small" data-action="add-shape-field">${icon('plus')} Add field</button></div></fieldset>`;}
function openWorkflowEditor(w){const fresh=!w?.id;w={name:'',description:'',brief:'',enabled:false,interval:60,mode:'interval',at:'09:00',days:[1,2,3,4,5],hook:null,watch:null,budget:0,steps:[{type:'agent'}],...(w||{})};if(!state.agents.length){toast('Add a resident before creating a workflow.',true);return;}showModal(`${modalHead(fresh?'New workflow':'Edit workflow','Resident steps do the work, reviews check it, approvals wait for you.')}<form id="workflow-form"><div class="modal-body"><div class="form-group"><label for="w-name">Workflow name</label><input class="field" id="w-name" name="name" required maxlength="100" value="${esc(w.name)}" placeholder="e.g. Weekly report"></div><div class="form-group"><label for="w-description">A short description</label><input class="field" id="w-description" name="description" maxlength="300" value="${esc(w.description)}" placeholder="Optional"></div><div class="form-group"><label for="w-brief">Saved brief</label><textarea class="field" id="w-brief" name="brief" maxlength="15000" placeholder="Optional. Used for scheduled runs and filled in when you run it by hand.">${esc(w.brief||'')}</textarea></div><div id="step-editors">${w.steps.map(stepEditor).join('')}</div><button type="button" class="btn small" data-action="add-step">${icon('plus')} Add another step</button>${triggerEditor(w)}${shapeEditor(w)}${errEl()}</div><div class="modal-footer">${fresh?'':`<button type="button" class="btn danger" data-action="delete-workflow" data-id="${w.id}">Delete workflow</button>`}<button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn primary">Save workflow</button></div></form>`,'workflow');
  $('#workflow-form [name=appKind]')?.addEventListener('change',e=>{const box=e.target.closest('.app-line').querySelector('.app-fields');box.innerHTML=appFields(e.target.value,{},w);});
  $('#workflow-form')?.addEventListener('change',e=>{if(e.target.name!=='app_app')return;const o=e.target.selectedOptions[0],box=e.target.closest('.app-fields');box.querySelector('.hook-hint').textContent=o.dataset.setup||'';const sg=box.querySelector('[name=app_signing]');if(sg&&!(w.app?.app===o.value))sg.placeholder=o.dataset.hint||'';box.querySelector('.app-hook-info')?.classList.toggle('stale',w.app?.app!==o.value);});
  $('#step-editors').addEventListener('change',e=>{
    const ed=e.target.closest('.flow-step-editor');if(!ed)return;
    // A locked app step turned into another kind of step: its options are free again for the new kind.
    if(e.target.matches('.step-type')&&e.target.value!=='action')ed.querySelectorAll('.step-opts[inert],.step-loop[inert]').forEach(x=>{x.inert=false;});
    if(e.target.matches('.step-type')){ed.dataset.type=e.target.value;ed.querySelector('.step-prompt').placeholder=STEP_HINT[e.target.value];if(e.target.value==='action')fillActionEditor(ed,actionValues(ed));return;}
    if(e.target.matches('.step-app')){const box=ed.querySelector('.step-action');box.querySelector('.step-op').innerHTML=actionOpOptions(e.target.value,'');box.querySelector('.act-fields').innerHTML=actionFieldsHtml(box,{});return;}
    if(e.target.matches('.step-op')){const box=ed.querySelector('.step-action');box.querySelector('.act-fields').innerHTML=actionFieldsHtml(box,actionValues(box));}
    if(e.target.matches('.step-each-on')){ed.dataset.each=e.target.checked?1:0;if(e.target.checked)ed.querySelector('.step-each').focus();}
    if(e.target.matches('.step-wait-unit'))ed.dataset.unit=e.target.value==='until'?'until':'span';
  });
  $('#step-editors').addEventListener('focusin',e=>{if(!e.target.matches('.act-input'))return;e.target.closest('.flow-step-editor').querySelectorAll('.act-input.last').forEach(x=>x.classList.remove('last'));e.target.classList.add('last');});
  // The last list shows at once; a fresh one follows, so an account connected in the meantime is there. Typed values stay.
  const fillAll=()=>$$('#step-editors .flow-step-editor').forEach(ed=>{const box=ed.querySelector('.step-action');fillActionEditor(ed,box?.querySelector('.act-input')?actionValues(box):undefined);});
  if(actionApps)fillAll();
  const before=JSON.stringify(actionApps);
  api('/workflow-actions').then(r=>{actionApps=r.apps;}).catch(e=>{if(!actionApps){actionApps=[];toast('Could not list the apps: '+e.message,true);}}).then(()=>{if(JSON.stringify(actionApps)!==before)fillAll();});
  $('#workflow-form').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,d=Object.fromEntries(new FormData(form));const el$=form.elements;d.enabled=el$.enabled.checked;d.interval=Number(d.interval);d.days=$$('#workflow-form [name=day]:checked').map(x=>Number(x.value));d.hook=el$.hookOn.checked?(el$.hookNew?.checked?'new':true):false;d.watch=el$.watchOn.checked?d.watch:'';d.mail=el$.mailOn.checked?{host:d.mailHost,port:Number(d.mailPort)||993,user:d.mailUser,pass:d.mailPass,folder:d.mailFolder,from:d.mailFrom,subject:d.mailSubject}:null;for(const k of Object.keys(d))if(/^mail[A-Z]/.test(k)||k==='mailOn')delete d[k];d.app=el$.appOn?.checked?{kind:d.appKind,...Object.fromEntries(Object.entries(d).filter(([k])=>k.startsWith('app_')).map(([k,v])=>[k.slice(4),v]))}:null;for(const k of Object.keys(d))if(k.startsWith('app_')||k==='appOn'||k==='appKind')delete d[k];d.budget=Number(d.budget)||0;d.shape=el$.shapeOn.checked?{many:$('.sf-many').checked,fields:$$('.shape-field').map(r=>({name:r.querySelector('.sf-name').value.trim(),type:r.querySelector('.sf-type').value,required:r.querySelector('.sf-req').checked})).filter(f=>f.name)}:null;if(d.shape&&!d.shape.fields.length){$('#form-error').textContent='Name at least one field, or turn the result shape off.';return;}for(const k of ['hookOn','hookNew','watchOn','day','shapeOn'])delete d[k];d.steps=$$('.flow-step-editor').map((el,i)=>{const type=el.querySelector('.step-type').value,step={type,prompt:el.querySelector('.step-prompt').value};if(type==='action'){const box=el.querySelector('.step-action');step.app=box.querySelector('.step-app').value;step.op=box.querySelector('.step-op').value;step.fields=Object.fromEntries(Object.entries(actionValues(box)).filter(([,v])=>v.trim()));step.retries=Number(box.querySelector('.step-retries').value);}else if(type==='wait'){step.unit=el.querySelector('.step-wait-unit').value;if(step.unit==='until'){step.time=el.querySelector('.step-wait-time').value;step.day=Number(el.querySelector('.step-wait-day').value);}else step.amount=Number(el.querySelector('.step-wait-amount').value);}else if(type!=='approval')step.agentId=el.querySelector('.step-agent').value;if((type==='agent'||type==='action')&&el.querySelector('.step-each-on').checked)step.each=el.querySelector('.step-each').value.trim();if(type==='agent'&&i>0&&el.querySelector('.step-parallel').checked)step.parallel=true;const wm=el.querySelector('.step-when-mode').value;if(wm)step.when={op:wm,step:Number(el.querySelector('.step-when-src').value)||0,text:el.querySelector('.step-when-text').value};if(type==='review'){step.target=Number(el.querySelector('.step-target').value);step.rounds=Number(el.querySelector('.step-rounds').value);step.onExhausted=el.querySelector('.step-exhausted')?.value||'fail';}return step;});const submit=form.querySelector('[type=submit]');submit.disabled=true;try{const saved=await api(fresh?'/workflows':'/workflows/'+w.id,{method:fresh?'POST':'PUT',body:d});if(fresh&&w.tests?.length){try{await post('/workflows/'+saved.id+'/tests',{tests:w.tests,...(w.judgeId&&{judgeId:w.judgeId})});}catch(e){toast('Saved, but its tests were not: '+e.message,true);}}await refresh();modal.close();render();toast('Workflow saved.');}catch(e){$('#form-error').textContent=e.message;}finally{submit.disabled=false;}};
}
function runWorkflow(w,input){if(!w){toast('This workflow no longer exists.',true);return;}showModal(`${modalHead('Run workflow',esc(w.name)+' · '+w.steps.length+' steps')}<form id="run-form"><div class="modal-body"><div class="form-group"><label for="run-input">The original brief</label><textarea class="field" id="run-input" required maxlength="15000" placeholder="What should the residents work on?">${esc(input??w.brief??'')}</textarea><small>Every step can use this brief. Answers appear live in the trace. Paid providers may charge for these calls.</small></div>${errEl()}</div><div class="modal-footer"><button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn primary">${icon('play')} Start workflow</button></div></form>`,'run');$('#run-form').onsubmit=async e=>{e.preventDefault();const submit=e.currentTarget.querySelector('[type=submit]');submit.disabled=true;try{const run=await post('/workflows/'+w.id+'/run',{input:$('#run-input').value});await refresh();openRun(state.runs.find(r=>r.id===run.id)||run);toast('Workflow started.');}catch(e){$('#form-error').textContent=e.message;}finally{submit.disabled=false;}};}
// The Order: the silo's book of procedures. Every workflow template is a procedure, grouped in chapters.
const ORDER_CHAPTERS=[['Knowledge','How the silo finds out what is true.',['research','decision','council']],['Making','How the silo builds and writes.',['code','article']],['Standing orders','Procedures that start on their own.',['triage','daily']],['Office work','Mail, invoices, meetings, issues and reports.',['invoice','meeting','inbox','issues','report']],['Apps on their own','App steps call the apps directly, with no model, alone or around one resident.',['mail-sheet','issues-notion','agenda','checkin']]];
// Procedures from files: the one being read, and the ones kept in the Order.
let importedProcedure=null;
const sharedProcedures=()=>[...(importedProcedure?[importedProcedure]:[]),...(state.templates||[]).map(t=>({...t,key:'u:'+t.id,shared:true,mine:true}))];
const procedureByKey=key=>TEMPLATES.find(t=>t.key===key)||sharedProcedures().find(t=>t.key===key);
let orderPage=null;
function orderIndex(){
  const seen=new Set(),chapters=ORDER_CHAPTERS.map(([title,line,keys])=>({title,line,list:keys.map(k=>TEMPLATES.find(t=>t.key===k)).filter(Boolean)}));
  for(const c of chapters)for(const t of c.list)seen.add(t.key);
  const rest=TEMPLATES.filter(t=>!seen.has(t.key));if(rest.length)chapters.push({title:'Further procedures',line:'Added later.',list:rest});
  const shared=sharedProcedures();if(shared.length)chapters.push({title:'Your procedures',line:'Kept here from your workflows and from files.',list:shared});
  return chapters.map((c,ci)=>({...c,list:c.list.map((t,ti)=>({t,num:(ci+1)+'.'+(ti+1)}))}));
}
// What an app step would change, known even before the app list is loaded, so a procedure from a file shows it.
const ACCOUNT_WRITES={google:['mail_send','calendar_create','sheet_append'],microsoft:['mail_send','calendar_create'],slack:['post'],github:['create_issue','comment','close_issue'],notion:['append','create_page']};
const opChanges=(app,op)=>{const id=String(app||'');if(id.startsWith('svc:'))return !!ACCOUNT_WRITES[id.slice(4)]?.includes(op);const o=actionApps?.find(a=>a.id===id)?.ops.find(x=>x.name===op);return o?o.write:true;};
const orderPrompt=p=>esc(p||'').replace(/\{\{[^}]+\}\}/g,m=>'<code>'+m+'</code>');
function orderProcedure(entry){
  const {t,num}=entry,w=materialize(t,state.agents),who=id=>getAgent(id);
  const steps=w.steps.map((st,i)=>{
    const a=who(st.agentId),role=st.type==='review'?'Inspected by':st.type==='approval'?'Signed off by':st.type==='wait'?'Waits':st.type==='action'?'Done by the app':'Carried out by';
    const person=st.type==='approval'?'<em>you, the operator</em>':st.type==='wait'?`<em>${esc(waitText(st))}</em>`:st.type==='action'?`<em>${esc(appNameOf(st.app))}</em>, ${esc(String(st.op||'').replace(/_/g,' '))}`:a?`<em>${esc(a.name)}</em>, ${esc(a.role)}, level ${a.level}`:'<em>no resident in that sector yet</em>';
    const marks=[st.parallel?'AT THE SAME TIME AS THE STEP BEFORE':'',st.when?`ONLY IF STEP ${pad2(st.when.step)} ${st.when.op==='contains'?'SAYS':'DOES NOT SAY'} ${esc(st.when.text)}`:'',st.type==='review'?`SENDS STEP ${pad2(st.target)} BACK UP TO ${st.rounds} TIMES`:'',st.each?'FOR EACH ITEM IN '+esc(st.each):'',st.type==='action'&&opChanges(st.app,st.op)?'CHANGES SOMETHING IN '+esc(appNameOf(st.app)).toUpperCase():''].filter(Boolean);
    const src=t.steps[i]||{};marks.push(...(src.needs||[]).map(n=>'NEEDS '+esc(needName(n)).toUpperCase()+(a&&!hasNeed(a,n)?', NOT GIVEN YET':'')));
    return `<li class="${st.type}"><b>${pad2(i+1)}</b><div><div class="order-who">${role} ${person}</div>${marks.length?`<div class="order-marks">${marks.map(m=>'<span>'+m+'</span>').join('')}</div>`:''}${st.type==='wait'?'':st.type==='action'?`<p>${Object.entries(st.fields||{}).map(([k,v])=>`${esc(k.replace(/^body\./,'').replace(/[._]/g,' '))}: ${orderPrompt(v)}`).join('<br>')||'Nothing to fill in.'}</p>`:`<p>${orderPrompt(st.prompt)||'Check the work so far before the procedure goes on.'}</p>`}</div></li>`;
  }).join('');
  const dayNames=d=>(d||[]).map(x=>['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][x]).join(', ');
  const starts=t.shared?[t.start?.mode==='daily'?`Meant to start every ${esc(dayNames(t.start.days))} at ${esc(t.start.at)}.`:t.start?`Meant to start every ${t.start.interval} minutes.`:'',t.watch?`Meant to start for every file dropped in workspace/${esc(t.watch)}/.`:'',t.start||t.watch?'It stays off until you turn it on in the editor.':'Started by hand from Flows.'].filter(Boolean).join(' ')
    :[t.mode?`Starts by itself ${t.days?.length===5&&!t.days.includes(0)&&!t.days.includes(6)?'every weekday':'every '+dayNames(t.days)} at ${t.at}.`:'',t.watch?`Starts by itself for every file dropped in workspace/${esc(t.watch)}/.`:'','Can be started by hand from Flows.'].filter(Boolean).join(' ');
  const extra=[t.shape?`Returns ${t.shape.many?'a list of items with ':''}the fields ${t.shape.fields.map(f=>esc(f.name)).join(', ')}, checked at the end of every run.`:'',t.tests?.length?`Comes with ${t.tests.length} test case${t.tests.length===1?'':'s'}.`:''].filter(Boolean).join(' ');
  const from=t.imported?`<p class="info-banner"><span><strong>From a file.</strong> Read every step before you adopt it: its words become instructions for your residents. Adopting gives no resident a new permission.${t.made?' Made on '+esc(t.made)+'.':''}</span></p>`:t.mine?`<p class="mono-line">Kept by ${esc(t.addedBy||'you')} on ${new Date(t.added).toLocaleDateString()}.</p>`:'';
  const actions=[t.imported&&me?.role!=='viewer'?button('Keep in the Order','keep-procedure'):'',t.mine&&me?.role!=='viewer'?button('Remove from the Order','remove-procedure',false,`data-id="${t.id}"`):'',t.shared?button('Download','download-procedure',false,`data-key="${t.key}"`):''].join('');
  return `<div class="order-num">PROCEDURE ${num}</div><h3>${esc(t.name)}</h3><p class="order-purpose">${esc(t.description)}</p>${from}<div class="order-rule">${starts}${extra?' '+extra:''}</div><ol class="order-steps">${steps}</ol><div class="order-foot"><span class="order-seal" aria-hidden="true">S18</span><span>${w.steps.some(s=>s.type==='action')&&!ownerHere()?'Only an owner can adopt this procedure, because its app steps use the accounts of this SILO directly.':'Residents are chosen from the silo as it is now. Every line can be changed before the procedure is filed under Flows.'}</span>${actions}${w.steps.some(s=>s.type==='action')&&!ownerHere()?`<button class="btn primary" disabled title="Only an owner can adopt a procedure with app steps.">Adopt procedure ${num}</button>`:`<button class="btn primary" data-action="use-template" data-key="${t.key}">Adopt procedure ${num}</button>`}</div>`;
}
function openImportProcedure(){
  showModal(`${modalHead('Import a procedure','A .silo.json file from another SILO, or its text.')}<div class="modal-body"><div class="form-group"><label for="proc-file">File</label><input class="field" type="file" id="proc-file" accept=".json,application/json"></div><div class="form-group"><label for="proc-text">Or paste the text</label><textarea class="field" id="proc-text" rows="8" spellcheck="false" placeholder='{"silo": "procedure", ...}'></textarea></div><p class="mono-line">Nothing is saved yet. You read the procedure in the Order first, then adopt it or keep it.</p>${errEl()}</div><div class="modal-footer"><button type="button" class="btn" data-action="close-modal">Cancel</button><button type="button" class="btn primary" id="proc-read">Read it</button></div>`,'import');
  $('#proc-file').onchange=async e=>{const file=e.target.files[0];if(!file)return;if(file.size>512000){$('#form-error').textContent='A procedure file is at most 500 KB.';return;}$('#proc-text').value=await file.text();};
  $('#proc-read').onclick=async()=>{
    $('#form-error').textContent='';let raw;
    try{raw=JSON.parse($('#proc-text').value);}catch{$('#form-error').textContent='That is not a procedure file: the text is not JSON.';return;}
    try{const t=await post('/templates/check',{template:raw});importedProcedure={...t,key:'import',shared:true,imported:true};openTemplates('import');}
    catch(e){$('#form-error').textContent=e.message;}
  };
}
const slugName=n=>String(n||'procedure').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g,'').trim().replace(/\s+/g,'-').slice(0,60)||'procedure';
function saveJson(obj,name){const url=URL.createObjectURL(new Blob([JSON.stringify(obj,null,2)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);}
// A connector is found by its name in another SILO, so an app step carries the name with it.
function cleanProcedure(t){const {key,shared,mine,imported,id,added,addedBy,...rest}=t;return {...rest,steps:(rest.steps||[]).map(s=>s.type==='action'&&String(s.app||'').startsWith('mcp:')&&!s.connector?{...s,connector:state.mcp?.find(c=>'mcp:'+c.id===s.app)?.name||''}:s)};}
async function openShare(w){
  if(!w)return;let t;try{t=await api('/workflows/'+w.id+'/template');}catch(e){toast(e.message,true);return;}
  const holds=[`${t.steps.length} step${t.steps.length===1?'':'s'} with their instructions`,'the name, role and sector of each resident',t.tests?.length?`${t.tests.length} test case${t.tests.length===1?'':'s'} with their briefs`:'',t.shape?'the result shape':'',t.brief?'the saved brief':'',t.steps.some(s=>s.type==='action')?'the values its app steps fill in (addresses, channels or sheet links)':''].filter(Boolean),appFields=t.steps.some(s=>s.type==='action');
  showModal(`${modalHead('Share / '+esc(w.name),'As a procedure file another SILO can import, or kept in your Order.')}<div class="modal-body"><p>The file holds ${esc(holds.join(', '))}. It holds no keys, webhook or mail settings, runs or files, and residents keep their permissions where they are. Read the brief${appFields?', the app steps':''} and the tests before you send it: they may hold private text.</p><textarea class="field" id="share-text" rows="10" readonly spellcheck="false">${esc(JSON.stringify(t,null,2))}</textarea></div><div class="modal-footer"><button type="button" class="btn" data-action="close-modal">Close</button><button type="button" class="btn" id="share-copy">Copy text</button>${me?.role!=='viewer'?'<button type="button" class="btn" id="share-keep">Keep in the Order</button>':''}<button type="button" class="btn primary" id="share-save">Download file</button></div>`,'share');
  $('#share-save').onclick=()=>saveJson(t,slugName(t.name)+'.silo.json');
  $('#share-copy').onclick=async()=>{try{await navigator.clipboard.writeText(JSON.stringify(t,null,2));toast('Copied.');}catch{$('#share-text').select();toast('Select the text and copy it.',true);}};
  if($('#share-keep'))$('#share-keep').onclick=async()=>{try{await post('/templates',{workflowId:w.id});await refresh();toast(w.name+' is kept in the Order.');}catch(e){toast(e.message,true);}};
}
function openTemplates(key){
  const index=orderIndex(),all=index.flatMap(c=>c.list);orderPage=all.find(e=>e.t.key===(key||orderPage))?.t.key||all[0]?.t.key;
  // Numbers like 3.2 are the place in the book.
  const toc=index.map((c,ci)=>`<div class="order-chapter"><div class="order-ch">CHAPTER ${ci+1} / ${esc(c.title).toUpperCase()}</div><small>${esc(c.line)}</small>${c.list.map(e=>`<button class="order-entry${e.t.key===orderPage?' active':''}" data-action="order-page" data-key="${e.t.key}" aria-pressed="${e.t.key===orderPage}"><span>${e.num}</span><span class="order-title">${esc(e.t.name)}</span><i></i><span>${e.t.steps.length} STEPS</span></button>`).join('')}</div>`).join('');
  showModal(`${modalHead('The Order','The book of procedures of Silo 18. Pick a procedure, read it, adopt it as a workflow.')}<div class="modal-body order-book"><nav class="order-toc" aria-label="Contents"><div class="order-cover">THE ORDER<small>BOOK OF PROCEDURES / SILO 18</small></div>${toc}${me?.role!=='viewer'?`<div class="order-chapter">${button('Import a procedure','import-procedure')}</div>`:''}</nav><article class="order-page" id="order-page">${orderProcedure(all.find(e=>e.t.key===orderPage))}</article></div>`,'templates');
}
let openRunId;const waitingSeen=new Set();
const courierCount=new Map(),courierOf=new Map();let couriersPrimed=false;
function activeWork(){
  const runs=state.runs.filter(r=>r.status==='running'&&r.current?.parts?.length).sort((a,b)=>b.started-a.started);
  for(const r of runs){const p=r.current.parts.find(p=>!p.waiting)||r.current.parts[0];if(getAgent(p.agentId))return {run:r,part:p,agent:getAgent(p.agentId)};}
  return null;
}
// Every piece of resident work in a run is one hand-off: the folder goes from the resident before to this one.
// Fast steps that start and finish between two polls still get their courier, a few seconds apart.
function sendCouriers(){
  for(const r of state.runs){
    const done=r.steps.filter(x=>x.agentId&&!x.skipped),current=r.status==='running'&&r.current?.parts?.length?r.current.parts:[];
    const units=[...done,...current],seen=courierCount.get(r.id)??(couriersPrimed?0:units.length);courierCount.set(r.id,units.length);
    if(!world?.dispatchCourier)continue;
    for(let n=seen;n<units.length;n++){
      const u=units[n],from=n<done.length?units[n-1]:done[done.length-1];
      const id=world.dispatchCourier({fromId:from?.agentId,toId:u.agentId,delay:Math.min(12,(n-seen)*2.5),label:'Step '+pad2(u.index+1)+' for '+u.agentName});if(id)courierOf.set(r.id,[...(courierOf.get(r.id)||[]).filter(c=>world.couriers.has(c)),id]);
    }
  }
  for(const id of courierCount.keys())if(!state.runs.some(r=>r.id===id))courierCount.delete(id);
  couriersPrimed=true;
}
// The courier on the road now, or the next one to leave.
const courierFor=id=>{const list=(courierOf.get(id)||[]).filter(c=>world?.couriers?.has(c));return list.find(c=>{const x=world.couriers.get(c);return x.legs[x.leg].kind!=='wait';})||list[0]||null;};
const VERDICT={approved:'APPROVED',revise:'SENT BACK','gave-up':'NOT APPROVED, WENT ON',unclear:'NO CLEAR VERDICT, WENT ON',rejected:'REJECTED'};
let liveCache={id:null,gen:0,feeds:{}},liveTimer=null,liveGen=0,liveInFlight=false,liveAbort=null;
function stopLiveWatch(){
  if(liveTimer){clearInterval(liveTimer);liveTimer=null;}
  if(liveAbort){liveAbort.abort();liveAbort=null;}
  liveInFlight=false;
}
// A resident step that repeated keeps a list of answers for the next steps; the trace shows them one by one.
function eachShown(s){
  if(!s.items||s.type!=='agent')return s.output;
  try{const list=JSON.parse(s.output);return Array.isArray(list)?list.map((x,k)=>`ITEM ${k+1} OF ${list.length}\n${typeof x==='string'?x:JSON.stringify(x,null,2)}`).join('\n\n'):s.output;}catch{return s.output;}
}
function traceStep(r,s,i){
  const type=s.type||'agent',tags=[type==='review'?'REVIEW':type==='approval'?'APPROVAL':type==='action'?'APP':type==='wait'?'WAIT':'',s.items!==undefined?s.items+(s.items===1?' ITEM':' ITEMS'):'',s.resumedAt?'RESUMED AT ITEM '+s.resumedAt:'',type==='wait'&&s.until&&!s.skipped?(s.output?'WOULD WAIT UNTIL ':'WAITED UNTIL ')+whenAt(s.until).toUpperCase():'',s.dry?'TEST, NOT CALLED':'',s.skipped?'SKIPPED, CONDITION NOT MET':'',s.verdict?VERDICT[s.verdict]+(s.round?' / ROUND '+s.round:''):'',s.revision?'REVISION':'',s.retries?'RETRIED '+s.retries+'x':'',s.tokens?s.tokens+' TOKENS':'',s.reused?'FROM THE EARLIER RUN':''].filter(Boolean);
  const cls=t=>/SKIPPED|EARLIER RUN/.test(t)?' class="tag-dim"':/SENT BACK|REJECTED|NOT APPROVED|NO CLEAR/.test(t)?' class="tag-warn"':/APPROVED/.test(t)?' class="tag-ok"':'';
  return `<div class="meta-label" data-step-row="${i}">STEP ${(s.index??i)+1} / ${esc(s.agentName)}${tags.map(t=>` / <span${cls(t)}>${t}</span>`).join('')}${s.agentId?` <button class="btn small" data-action="scrub-step" data-id="${r.id}" data-step="${i}" title="Replay this step in the 3D silo">${icon('silo')} 3D</button>`:''}${s.output?` <button class="btn small" data-action="copy-run" data-id="${r.id}" data-step="${i}">Copy</button> ${aiButtons('r|'+r.id+'|'+i,s.output,'btn small')}`:''}</div>${toolLines(s.tools)}${s.truncated?'<div class="modal-error">This answer still hit the output limit after two follow ups. The end may be missing.</div>':''}${s.output?`<div class="run-detail">${esc(eachShown(s))}</div>${aiSlot('r|'+r.id+'|'+i)}`:''}`;
}
// A change outside SILO that may or may not have gone through: what was sent, and your answer after checking.
function checkBox(r){
  const u=r.check;if(r.status!=='check'||!u)return '';
  return `<div class="approval-box"><div class="meta-label">STEP ${u.step+1} / ${esc(u.app).toUpperCase()} ${esc(u.op).toUpperCase()} / <span class="tag-warn">CHECK NEEDED</span></div><p>SILO sent this to ${esc(u.app)}, but ${u.error?'the answer did not come: '+esc(u.error):'SILO stopped before the answer came'}. It may have gone through. Look in ${esc(u.app)}, then say what you found. Nothing is sent again until you do.</p><div class="run-detail"><strong>What was sent</strong>\n${esc(u.input||'(no fields)')}</div><textarea class="field" id="check-result" maxlength="24000" placeholder="Optional. If it went through: what ${esc(u.app)} shows (an id, a link), for the next steps."></textarea><div class="run-toolbar"><button class="btn primary" data-action="check-run" data-done="1" data-id="${r.id}">It went through, go on</button><button class="btn" data-action="check-run" data-done="0" data-id="${r.id}">It did not, send it again</button></div></div>`;
}
function traceCurrent(r,total){
  if(r.status==='check')return checkBox(r);
  const c=r.current;if(!c)return '';
  if(c.type==='approval')return `<div class="approval-box"><div class="meta-label">STEP ${c.index+1} OF ${total} / <span class="tag-warn">WAITING FOR YOU</span></div><p>${esc(c.message)}</p><textarea class="field" id="approval-note" maxlength="5000" placeholder="Optional. A note for the next resident."></textarea><div class="run-toolbar"><button class="btn primary" data-action="approve-run" data-id="${r.id}">Approve and go on</button><button class="btn danger" data-action="reject-run" data-id="${r.id}">Reject</button></div></div>`;
  if(c.type==='wait')return `<div class="meta-label">STEP ${c.index+1} OF ${total} / WAIT / <span class="tag-warn">GOES ON ${esc(whenAt(c.until).toUpperCase())}</span></div><div class="info-banner">The run waits here and goes on by itself, also after a restart of SILO. Stop it to cancel.</div>`;
  if(c.type==='action')return `<div class="meta-label">STEP ${c.index+1} OF ${total} / ${esc(c.agentName||'App')} / APP${c.items?' / ITEM '+c.item+' OF '+c.items:''} / CALLING</div>`;
  const parts=c.parts||[{index:c.index,agentName:c.agentName,waiting:c.waiting}],feeds=liveCache.id===r.id?liveCache.feeds:{};
  return parts.map(p=>{const l=feeds[p.index]||{text:'',note:''};return `<div class="meta-label">STEP ${p.index+1} OF ${total} / ${esc(p.agentName)}${c.type==='review'?' / REVIEW':''}${c.items?' / ITEM '+c.item+' OF '+c.items:''}${parts.length>1?' / SAME TIME':''} / ${p.waiting?'WAITING':'WRITING'}</div>${p.waiting?`<div class="info-banner">${esc(p.agentName)} is busy with another mission. The step starts when they are free.</div>`:`<div class="run-detail live-out" data-live="${p.index}">${esc(l.text)}<span class="cursor"></span></div><div class="live-note" data-live-note="${p.index}">${esc(l.note)}</div>`}`;}).join('');
}
// Replay with the same brief. From a later step, the earlier steps keep this run's answers.
function replayControl(r){
  const w=state.workflows.find(w=>w.id===r.workflowId);if(!w)return '';
  const n=w.steps.length;
  return `<span class="replay-control"><select class="select" id="replay-from" aria-label="Replay from step">${Array.from({length:n},(_,i)=>`<option value="${i+1}">${i?'From step '+(i+1):'From the start'}</option>`).join('')}</select><button class="btn small" data-action="replay-run" data-id="${r.id}">Replay</button></span>`;
}
function runDetail(r){
  const total=r.total||r.steps.length,tokens=r.steps.reduce((n,x)=>n+(x.tokens||0),0),done=r.current?.index??r.at??total,resumable=r.plan&&['failed','stopped','interrupted'].includes(r.status);
  const compCount=(r.compensations||[]).filter(c=>c.status!=='compensated').length;
  const tools=r.status==='running'?`<button class="btn small danger" data-action="stop-run" data-id="${r.id}">Stop run</button>`:`${resumable?`<button class="btn small primary" data-action="resume-run" data-id="${r.id}">${icon('play')} Resume from step ${(r.at||0)+1}</button>`:''}${compCount?`<button class="btn small danger" data-action="compensate-run" data-id="${r.id}">Compensate (${compCount})</button>`:''}<button class="btn small" data-action="rerun" data-id="${r.id}">${icon('play')} Run again</button>${replayControl(r)}`;
  const scrub=r.steps.length>1?`<div class="run-toolbar" style="align-items:center;gap:10px"><span class="meta-label" style="margin:0">TIME-MACHINE (${r.steps.length} STEPS)</span><input type="range" id="run-scrub" min="0" max="${r.steps.length-1}" value="${r.steps.length-1}" style="flex:1"><button class="btn small" data-action="scrub-go" data-id="${r.id}">${icon('silo')} Project step in 3D</button></div>`:'';
  return `<div class="run-toolbar">${tools}${r.output?`<button class="btn small" data-action="copy-run" data-id="${r.id}" data-step="-1">Copy final output</button>`:''}</div>${scrub}<div class="run-status">${esc(runLabel(r)).toUpperCase()} ${checkTag(r)} · ${total} STEPS${r.finished?' · '+Math.round((r.finished-r.started)/1000)+'s':''}${tokens?' · '+tokens+' TOKENS':''}${r.budget?' · MAX '+r.budget:''}${r.resumed?' · RESUMED':''}${r.version?' · V'+r.version:''}${r.from?' · FROM STEP '+r.from:''}${TRIGGER_NAME[r.trigger]?' · '+TRIGGER_NAME[r.trigger].toUpperCase():''}</div>${r.status==='running'?`<div class="run-progress"><span style="width:${Math.round(done/Math.max(1,total)*100)}%"></span></div>`:''}<div class="run-detail"><strong>Original brief</strong>\n${esc(r.input)}</div>${r.steps.map((s,i)=>traceStep(r,s,i)).join('')}${traceCurrent(r,total)}${courierFor(r.id)?`<div class="courier-line"><span>A COURIER IS CARRYING THE FOLDER TO THE NEXT RESIDENT</span><button class="btn small" data-action="watch-courier" data-id="${r.id}">Watch the courier</button></div>`:''}${r.error?`<div class="modal-error">${esc(r.error)}</div>`:''}${r.status==='running'&&!r.waiting&&r.current?.type!=='wait'?'<div class="chat-hint">LIVE / TEXT APPEARS AS IT IS WRITTEN</div>':''}`;
}
// Keeps a note being typed and the scroll position when the trace is redrawn.
function updateTrace(r){
  const box=$('#run-detail');if(!box)return;const note=$('#approval-note'),value=note?.value,focused=document.activeElement===note,top=modal.scrollTop;
  box.innerHTML=runDetail(r);const n=$('#approval-note');if(n&&value!=null){n.value=value;if(focused)n.focus({preventScroll:true});}modal.scrollTop=top;watchLive();
}
function paintLive(){
  if(liveCache.id!==openRunId)return;const box=modal,stick=box.scrollHeight-box.scrollTop-box.clientHeight<60;
  for(const out of $$('[data-live]')){const f=liveCache.feeds[out.dataset.live];if(!f)continue;out.textContent=f.text;out.insertAdjacentHTML('beforeend','<span class="cursor"></span>');const n=out.nextElementSibling;if(n?.dataset.liveNote!==undefined)n.textContent=f.note||'';}
  if(stick)box.scrollTop=box.scrollHeight;
}
// While a step is being written, its text is fetched a few times a second, separately from the state.
function watchLive(){
  const r=state.runs.find(x=>x.id===openRunId);
  if(!modal.open||modalKind!=='trace'||r?.status!=='running'){stopLiveWatch();return;}
  if(liveTimer)return;
  liveTimer=setInterval(async()=>{
    const run=state.runs.find(x=>x.id===openRunId);
    if(!modal.open||modalKind!=='trace'||run?.status!=='running'){stopLiveWatch();return;}
    if(run.current?.type==='approval'||run.current?.type==='wait'||document.hidden||liveInFlight)return;
    const reqGen=++liveGen,reqRunId=run.id;
    liveInFlight=true;
    liveAbort=new AbortController();
    try{
      const f=await api('/runs/'+reqRunId+'/live',{signal:liveAbort.signal});
      if(reqGen<liveCache.gen||openRunId!==reqRunId||!modal.open||modalKind!=='trace')return;
      liveCache={id:reqRunId,gen:reqGen,feeds:f.feeds||{}};
      // A step started since the last poll: fetch the state now so its box appears without waiting.
      if(Object.keys(liveCache.feeds).some(i=>!$(`[data-live="${i}"]`))&&Date.now()-(watchLive.synced||0)>900){watchLive.synced=Date.now();if(await refresh()){const cur=state.runs.find(x=>x.id===openRunId);if(cur&&modalKind==='trace'&&openRunId===reqRunId)updateTrace(cur);if(view==='workflows')$('#run-history').innerHTML=runHistory();}}
      if(openRunId===reqRunId)paintLive();
    }catch{}finally{
      liveInFlight=false;
    }
  },600);
}
async function checkRun(el){const done=el.dataset.done==='1';el.closest('.run-toolbar')?.querySelectorAll('button').forEach(b=>b.disabled=true);try{await post('/runs/'+el.dataset.id+'/check',{done,result:done?$('#check-result')?.value||'':''});await refresh();toast(done?'Noted. The run goes on without sending it again.':'The run goes on and sends it again.');const r=state.runs.find(r=>r.id===el.dataset.id);if(r&&modalKind==='trace')updateTrace(r);if(view==='workflows')$('#run-history').innerHTML=runHistory();}catch(e){toast(e.message,true);el.closest('.run-toolbar')?.querySelectorAll('button').forEach(b=>b.disabled=false);}}
async function decideRun(el,approve){el.disabled=true;try{await post('/runs/'+el.dataset.id+'/approve',{approve,note:$('#approval-note')?.value||''});await refresh();toast(approve?'Approved. The workflow goes on.':'Rejected. The run is stopped.');const r=state.runs.find(r=>r.id===el.dataset.id);if(r&&modalKind==='trace')updateTrace(r);if(view==='workflows')$('#run-history').innerHTML=runHistory();}catch(e){toast(e.message,true);el.disabled=false;}}
// ---------- task trails ----------
// The path a piece of work takes through the silo, from resident to resident, drawn in the 3D world.
const TRAIL_WORD={done:'done',running:'working',waiting:'not started',failed:'failed',skipped:'skipped'};
let trailInfo=null;
function runTrail(r){
  const done=new Map();for(const x of r.steps)if(x.index!==undefined)done.set(x.index,x);
  const now=new Set((r.current?.parts||[r.current]).filter(Boolean).map(p=>p.index));
  const list=r.plan?.length?r.plan.map((p,k)=>({k,agentId:p.agentId})):r.steps.map((x,k)=>({k:x.index??k,agentId:x.agentId}));
  const stopped=['failed','stopped','interrupted','rejected'].includes(r.status);
  return {name:r.name,source:{kind:'run',id:r.id},waiting:r.status==='running'&&(r.waiting||r.current?.type==='approval'),steps:list.filter(x=>x.agentId).map(({k,agentId})=>{
    const x=done.get(k);
    return {agentId,status:x?(x.skipped?'skipped':x.verdict==='rejected'?'failed':'done'):now.has(k)&&r.status==='running'?'running':stopped&&k===(r.at??0)?'failed':'waiting'};
  })};
}
function flowTrail(w){const last=state.runs.find(r=>r.workflowId===w.id);return last?runTrail(last):{name:w.name,source:{kind:'flow',id:w.id},steps:w.steps.filter(x=>x.agentId).map(x=>({agentId:x.agentId,status:'waiting'}))};}
// For a conversation or goal: every resident whose model or tools ran, in the order they started.
function traceTrail(t){
  const steps=[];
  for(const x of [...t.spans].filter(x=>x.agentId&&getAgent(x.agentId)).sort((a,b)=>a.start-b.start)){
    const st=x.status==='running'?'running':x.status==='error'?'failed':'done',last=steps[steps.length-1];
    if(last?.agentId===x.agentId){if(st==='failed'||(st==='running'&&last.status!=='failed'))last.status=st;}else steps.push({agentId:x.agentId,status:st});
  }
  return {name:t.name,source:{kind:'trace',id:t.id,running:t.status==='running'},steps};
}
function showTrail(trail){
  if(!trail?.steps?.length){toast('No resident took part in this yet, so there is no trail to show.',true);return;}
  if(modal.open)modal.close();if(view!=='silo')navigate('silo');
  if(!world?.setTrail?.(trail)){toast('These residents are no longer in the silo.',true);return;}
  trailInfo={...trail,at:-1,key:JSON.stringify(trail.steps),fetched:Date.now()};syncTrailChip();
  const active=Object.entries(state.activity||{}).find(([,x])=>trail.source.kind==='run'?x.runId===trail.source.id:x.traceId===trail.source.id),who=active&&getAgent(active[0]);if(who)world?.focusLevel?.(who.level);
}
function clearTrail(){trailInfo=null;world?.clearTrail?.();syncTrailChip();}
// A trail for running work keeps up with it.
function refreshTrail(){
  const t=trailInfo;if(!t)return;
  if(t.source.kind==='run'){const r=state.runs.find(x=>x.id===t.source.id);if(!r)return;const next=runTrail(r),key=JSON.stringify(next.steps);if(key!==t.key||next.waiting!==t.waiting){if(key!==t.key)world?.setTrail?.(next,{focus:false});Object.assign(t,next,{key});syncTrailChip();}}
  else if(t.source.kind==='trace'&&t.source.running&&Date.now()-t.fetched>2500){
    t.fetched=Date.now();api('/traces/'+t.source.id).then(full=>{if(trailInfo!==t)return;const next=traceTrail(full),key=JSON.stringify(next.steps);if(key!==t.key||!next.source.running){world?.setTrail?.(next,{focus:false});Object.assign(t,next,{key});syncTrailChip();}}).catch(()=>{});
  }
}
function syncTrailChip(){
  let el=$('#trail-chip');
  if(!trailInfo){el?.remove();return;}
  if(!el){el=document.createElement('div');el.id='trail-chip';el.className='trail-chip';el.setAttribute('role','status');document.body.appendChild(el);}
  const n=trailInfo.steps.length,counts={};for(const x of trailInfo.steps)counts[x.status]=(counts[x.status]||0)+1;
  const levels=[];for(const x of trailInfo.steps){const l=getAgent(x.agentId)?.level;if(l&&levels[levels.length-1]!==l)levels.push(l);}
  const route=levels.length>6?[...levels.slice(0,3).map(l=>'L'+pad3(l)),'...',...levels.slice(-2).map(l=>'L'+pad3(l))]:levels.map(l=>'L'+pad3(l));
  el.innerHTML=`<div class="trail-head"><span class="trail-title">TRAIL</span><strong>${esc(trailInfo.name)}</strong></div><small>${n} step${n===1?'':'s'} / ${route.join(' &gt; ')}</small><div class="trail-key">${Object.keys(TRAIL_WORD).filter(k=>counts[k]).map(k=>`<span><i class="trail-${k}"></i>${counts[k]} ${TRAIL_WORD[k]}</span>`).join('')}</div>${trailInfo.waiting?'<div class="trail-wait">WAITING FOR YOUR APPROVAL. Nothing moves until you answer.</div>':''}<div class="trail-tools">${trailInfo.source.kind==='run'?'<button class="btn small'+(trailInfo.waiting?' primary':'')+'" data-action="view-run" data-id="'+trailInfo.source.id+'">Open run</button>':''}<button class="btn small" data-action="trail-next">Next step</button><button class="btn small" data-action="trail-clear">Clear</button></div>`;
}
function trailNext(){
  const t=trailInfo;if(!t)return;t.at=(t.at+1)%t.steps.length;
  const a=getAgent(t.steps[t.at].agentId);if(!a)return;
  world?.focusAgent?.(a);toast(`Step ${t.at+1} of ${t.steps.length}: ${a.name}, L${pad3(a.level)}, ${TRAIL_WORD[t.steps[t.at].status]}`);
}
// What a resident is doing right now, as the server reads it from the work in progress.
const ACT_WORD={queued:'WAITING TO START',thinking:'THINKING',tool:'USING A TOOL',asking:'WAITING FOR A RESIDENT',approval:'WAITING FOR YOU',blocked:'BLOCKED',failed:'LAST MISSION FAILED',regressed:'TESTS GOT WORSE'};
// The resident's own browser: the last page it saw, and the sign-in window you use for it.
function browserBox(a){
  if(!a.tools?.includes('browser'))return '';
  const br=state.browsers?.[a.id];
  const line=br?.signIn?'The sign-in window is open. Close it when you are signed in, then the resident can go on.':br?.open?'Open: '+esc(br.title||br.url):br?.url?'Closed. Last page: '+esc(br.title||br.url):'Not opened yet.';
  return `<div class="browser-box"><div class="meta-label">BROWSER</div>${br?.shot?`<a href="/api/browser/shots/${br.shot}.jpg" target="_blank" rel="noopener" title="Open the full screenshot"><img class="browser-shot" src="/api/browser/shots/${br.shot}.jpg" alt="Last page the resident saw"></a>`:''}<p>${line}</p><div class="browser-tools"><button class="btn small" data-action="browser-signin" data-id="${a.id}">Sign in to a site</button>${br?.open?`<button class="btn small" data-action="browser-close" data-id="${a.id}">Close</button>`:''}<button class="btn small danger" data-action="browser-forget" data-id="${a.id}" title="Deletes this resident's browser profile, with every sign-in and cookie">Sign out everywhere</button></div></div>`;
}
function openBrowserSignIn(a){
  showModal(`${modalHead('Sign in for '+esc(a.name),'A browser window opens with this resident\'s own profile.')}<div class="modal-body"><p class="mono-line" style="line-height:1.8">Sign in there yourself, then close the window. The resident uses that sign-in from then on. Residents never see or type your password. While the window is open, this resident waits.</p><div class="form-group"><label for="signin-url">Sign-in page</label><input id="signin-url" class="field" type="url" placeholder="https://example.com/login" required></div>${errEl()}</div><div class="modal-footer"><button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" id="signin-go">Open the window</button></div>`,'confirm');
  $('#signin-url').focus();
  $('#signin-go').onclick=async()=>{try{await post('/browser/'+a.id+'/signin',{url:$('#signin-url').value});modal.close();await refresh();render();toast('The sign-in window is open. Close it when you are done.');}catch(e){$('#form-error').textContent=e.message;}};
}
// Remote access through a Cloudflare Tunnel. The card refreshes itself while the tunnel is connecting.
let remoteTimer=null;
async function loadRemoteCard(){
  clearTimeout(remoteTimer);
  const box=$('#remote-card');if(!box)return;
  if(box.contains(document.activeElement)&&document.activeElement.matches('input,select')){remoteTimer=setTimeout(loadRemoteCard,3000);return;}
  let r;try{r=await api('/remote');}catch(e){box.querySelector('p').textContent=e.message;return;}
  if(!$('#remote-card'))return;
  const owner=me?.role==='owner'||!(state.users||[]).length;
  const status=r.state==='on'?`<p class="remote-live"><span class="dot green"></span><span>Open at <a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a></span></p><div class="heading-actions">${button('Copy address','remote-copy',false,`data-url="${esc(r.url)}"`)}</div>`
    :r.state==='starting'?'<p class="remote-live"><span class="dot"></span> Connecting to Cloudflare...</p>'
    :r.state==='error'?`<p class="modal-error">${esc(r.error||'The tunnel stopped.')}</p>`
    :'';
  const log=r.log?.length?`<details class="remote-log"><summary>What cloudflared said</summary><pre>${esc(r.log.join('\n'))}</pre></details>`:'';
  const install=r.found?`<p class="mono-line">cloudflared: ${esc(r.found)}</p>`
    :`<p>This needs cloudflared, Cloudflare's small connector program. SILO can download it from Cloudflare's releases on GitHub and checks that it is signed by Cloudflare. Or install it yourself with <code>winget install --id Cloudflare.cloudflared</code> and come back.</p>${owner?`<div class="heading-actions">${button(r.downloading?'Downloading...':'Download cloudflared','remote-download',true,r.downloading?'disabled':'')}</div>`:''}`;
  const own=r.mode==='token';
  const form=owner&&r.owner?`<div class="form-group"><label for="remote-mode">Address</label><select class="select" id="remote-mode"><option value="quick" ${own?'':'selected'}>Quick address: free, no account, a new address each time SILO starts</option><option value="token" ${own?'selected':''}>My own domain: the same address always, needs a free Cloudflare account</option></select></div>
<div id="remote-own" ${own?'':'hidden'}><p>In the Cloudflare dashboard open Networks, Tunnels and create a tunnel of type Cloudflared. Copy the install command (it contains the token) and paste it below. Then add a public hostname for it, with service <code>http://127.0.0.1:${r.port}</code>.</p><div class="form-grid"><div class="form-group"><label for="remote-host">Public hostname</label><input class="field" id="remote-host" value="${esc(r.hostname)}" placeholder="silo.example.com" autocomplete="off"></div><div class="form-group"><label for="remote-token">Tunnel token</label><input class="field" id="remote-token" type="password" placeholder="${r.hasToken?'Saved. Paste a new one to replace it.':'Paste the token or the whole command'}" autocomplete="off"></div></div></div>
<div class="heading-actions">${r.enabled?button('Turn off','remote-off'):button('Turn on','remote-on',true,r.found?'':'disabled')}${button('Save','remote-save')}</div>`
    :r.owner?'':'<p class="modal-error">Create an owner account above first. Remote access always needs a password.</p>';
  box.innerHTML=`<h3>Open from anywhere</h3><p>A secure HTTPS address through Cloudflare, for your phone or any other network. Nothing is opened on your router, no firewall rule is needed, and SILO itself still listens only on this computer. Everyone has to sign in, so use a long password.</p>${status}${install}${form}${r.here==='tunnel'?'<p class="mono-line">You are using SILO through this tunnel now. Turning it off ends this page.</p>':''}${log}`;
  const mode=$('#remote-mode');if(mode)mode.onchange=()=>{$('#remote-own').hidden=mode.value!=='token';};
  if(r.state==='starting'||r.downloading||(r.enabled&&r.state==='error'))remoteTimer=setTimeout(loadRemoteCard,2000);
}
function remoteForm(){const body={mode:$('#remote-mode')?.value||'quick'};if(body.mode==='token'){body.hostname=$('#remote-host').value.trim();const t=$('#remote-token').value.trim();if(t)body.token=t;}return body;}
async function loadBrowserCard(){
  const box=$('#browser-card');if(!box)return;
  let b;try{b=await api('/browser');}catch(e){box.querySelector('p').textContent=e.message;return;}
  if(!$('#browser-card'))return;
  box.innerHTML=`<h3>Browser for residents</h3><p>${b.found?`Residents with browser access use ${esc(b.name)}, each with its own profile under data/browser, apart from yours. Pages on this computer and your network are refused.`:'No Edge or Chrome was found. Install one or give the path to its program.'}</p>${b.found?`<p class="mono-line">${esc(b.found)}</p>`:''}<div class="form-group"><label for="browser-path">Program path (empty finds it automatically)</label><input id="browser-path" class="field" value="${esc(b.path)}" placeholder="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"></div><label class="check-label"><input type="checkbox" id="browser-visible" ${b.headless?'':'checked'}> Show the browser window while residents work</label><div class="heading-actions">${button('Save','browser-save')}</div>`;
}
function activityOf(a){const x=state.activity?.[a.id];return x&&!(x.until&&Date.now()>x.until)?x:null;}
function activityBadge(a){
  const x=activityOf(a);
  if(!x)return `<span class="dot ${a.status==='working'?'':'green'}"></span>${a.status==='working'?'WORKING':'IDLE'}`;
  const tone=x.state==='blocked'||x.state==='failed'||x.state==='regressed'?'bad':x.state==='approval'||(x.state==='done'&&!x.verified)?'warn':x.state==='done'?'ok':'busy';
  return `<span class="dot act-${tone}"></span>${x.state==='done'?(x.verified?'DONE / CHECKED':'DONE / NOT CHECKED'):ACT_WORD[x.state]||x.state.toUpperCase()}`;
}
function activityDetail(a){
  const x=activityOf(a);if(!x?.detail)return '';
  const link=x.state==='regressed'&&a.evalWorse?`<button class="link-btn" data-action="${a.evalWorse.kind==='agent'?'agent':'workflow'}-tests" data-id="${a.evalWorse.subjectId}">Open tests</button>`:x.runId?`<button class="link-btn" data-action="trail-run" data-id="${x.runId}">Show trail</button>`:x.traceId?`<button class="link-btn" data-action="trail-trace" data-id="${x.traceId}">Show trail</button>`:'';
  return `<div class="activity-detail act-${x.state}">${esc(x.detail)}${link}</div>`;
}
// How a finished result was checked. Older runs have no record, so they show nothing.
function checkTag(r){
  if(r.status!=='completed'||!Array.isArray(r.checks))return '';
  return r.checks.length?`<span class="tag-ok" title="Checked by: ${esc(r.checks.join(', '))}">${esc(r.checks.join(' + ').toUpperCase())}</span>`:'<span class="tag-warn" title="No review, test or approval looked at this result.">NOT CHECKED</span>';
}
function projectRunStep(runId,idx){
  const r=state.runs.find(x=>x.id===runId),s=r?.steps[idx];if(!s)return;
  const a=getAgent(s.agentId);if(!a){toast('This step was handled by the operator.',true);return;}
  let prev=null;for(let k=idx-1;k>=0;k--)if(r.steps[k]?.agentId&&r.steps[k].agentId!==a.id){prev=r.steps[k];break;}
  modal.close();navigate('silo');selectAgent(a.id);world?.focusAgent(a);
  if(prev&&world?.dispatchCourier){const cid=world.dispatchCourier({fromId:prev.agentId,toId:a.id,label:`Replay step ${pad2((s.index??idx)+1)}: ${a.name}`});if(cid)world.followCourier(cid);}
  toast(`Time-Machine · Step ${(s.index??idx)+1} (${a.name}, L${pad3(a.level)})`);
}
function openRun(r){if(openRunId!==r.id){stopLiveWatch();liveGen++;liveCache={id:r.id,gen:liveGen,feeds:{}};}openRunId=r.id;showModal(`${modalHead(esc(r.name),'Output of each step.')}<div class="modal-body" id="run-detail">${runDetail(r)}</div><div class="modal-footer"><button class="btn" data-action="trail-run" data-id="${r.id}">${icon('silo')} Show in silo</button>${r.traceId?`<button class="btn" data-action="open-trace" data-id="${r.traceId}">Time and cost</button>`:''}<button class="btn" data-action="close-modal">Close</button></div>`,'trace');$('#run-detail')?.addEventListener('input',e=>{if(e.target.id==='run-scrub'){const row=$(`[data-step-row="${e.target.value}"]`);row?.scrollIntoView({behavior:'smooth',block:'center'});}});watchLive();}
const pending=()=>(state.proposals||[]).filter(p=>p.status==='pending');
function proposalList(){
  const list=pending(),rev=(state.proposals||[]).filter(p=>p.canRevert).slice(0,5);if(!list.length&&!rev.length)return '';
  const pendHtml=list.length?`<h2 class="section-title">Waiting for your approval <small>${list.length}</small></h2><div class="section-card proposals">${list.map(p=>`<div class="activity-row proposal"><span class="event-icon">${icon('files')}</span><div><strong>${esc(p.name)}${p.patch?' <span class="tag-ok">SURGICAL PATCH</span>':p.exists?' <span class="tag-warn">REPLACES THE CURRENT FILE</span>':''}${p.relics?.length?` <span class="tag-warn">RELIC DETECTED: ${esc(p.relics.join(', '))}</span>`:''}</strong><p>${esc(p.agentName)} · ${esc(p.source||'')} · ${Math.max(1,Math.round(p.size/1024))} KB</p><pre class="proposal-preview">${esc(p.preview)}${p.size>300?'\n...':''}</pre></div><time>${age(p.time)}</time><div class="proposal-actions"><button class="btn small" data-action="view-proposal" data-id="${p.id}">View</button><button class="btn small primary" data-action="save-proposal" data-id="${p.id}">Save</button><button class="btn small danger" data-action="discard-proposal" data-id="${p.id}">Discard</button></div></div>`).join('')}</div>`:'';
  const revHtml=rev.length?`<h2 class="section-title">Recently overwritten: one-click revert <small>${rev.length}</small></h2><div class="section-card proposals">${rev.map(p=>`<div class="activity-row proposal"><span class="event-icon">${icon('check')}</span><div><strong>${esc(p.name)}</strong><p>Saved from ${esc(p.agentName)} · previous version backed up in Archive</p></div><time>${age(p.decidedAt||p.time)}</time><div class="proposal-actions"><button class="btn small" data-action="revert-proposal" data-id="${p.id}">Revert</button></div></div>`).join('')}</div>`:'';
  return pendHtml+revHtml;
}
function openDispatch(to){
  if(!to)return;const defFrom=state.agents.find(x=>x.id!==to.id&&x.floor!==to.floor)||state.agents.find(x=>x.id!==to.id);
  showModal(`${modalHead('Porter Dispatch to '+esc(to.name),`Level ${to.level} · A Porter carries this letter along the central staircase and leaves it in ${esc(to.name)}'s gallery notes.`)}<form id="dispatch-form"><div class="modal-body"><div class="form-group"><label for="disp-from">Sender resident</label><select class="select" id="disp-from" name="fromId">${agentOptions(defFrom?.id)}</select></div><div class="form-group"><label for="disp-text">Letter content</label><textarea class="field" id="disp-text" rows="4" maxlength="500" required placeholder="Message for ${esc(to.name)}"></textarea></div>${errEl()}</div><div class="modal-footer"><button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn primary">${icon('silo')} Dispatch Porter</button></div></form>`,'dispatch');
  $('#dispatch-form').onsubmit=async e=>{
    e.preventDefault();const btn=e.currentTarget.querySelector('[type=submit]');btn.disabled=true;
    try{const d=await post('/dispatch',{fromId:$('#disp-from').value,toId:to.id,text:$('#disp-text').value});await refresh();modal.close();navigate('silo');const cid=world?.dispatchCourier?.({fromId:d.fromId,toId:d.toId,label:'Letter for '+d.toName});if(cid)world.followCourier(cid);if(world)world.dispatchSeen=d.time;toast(`Porter dispatched from L${pad3(d.fromLevel)} to ${d.toName} (L${pad3(d.toLevel)}).`);}
    catch(err){$('#form-error').textContent=err.message;btn.disabled=false;}
  };
}
let editingProposal=null;
async function decideProposal(id,action,extra={}){try{await post('/proposals/'+id,{action,...extra});await refresh();if(view==='files'){$('#proposal-list').innerHTML=proposalList();loadFiles();}syncStatus();if(modal.open&&modalKind==='proposal')modal.close();toast(action==='save'?'File saved to the workspace.':action==='revert'?'Reverted to previous version.':'Proposal discarded.');}catch(e){toast(e.message,true);}}
// Apps: Google, Microsoft 365, Slack, GitHub, Notion.
let appList=[];
const APP_MARK={google:'G',microsoft:'M',slack:'S',github:'GH',notion:'N'};
async function loadApps(){
  try{appList=(await api('/services')).services;}catch(e){const g=$('#apps-grid');if(g)g.innerHTML=`<div class="empty small">${esc(e.message)}</div>`;return;}
  const g=$('#apps-grid');if(!g)return;
  g.innerHTML=appList.map(s=>`<article class="connection-card"><div class="connection-brand"><span class="connection-logo">${APP_MARK[s.id]}</span><h3>${esc(s.name)}</h3><span class="connection-state"><span class="dot ${s.connected&&!s.problem?'green':''}"></span>${s.connected?(s.problem?'SIGN IN AGAIN':'CONNECTED'):'NOT CONNECTED'}</span></div><p>${esc(s.what[0].toUpperCase()+s.what.slice(1))}.${s.connected&&s.account?' Signed in as <strong>'+esc(s.account)+'</strong>.':''} ${s.users} resident${s.users===1?'':'s'} may use it.</p>${s.problem?`<p class="modal-error">${esc(s.problem)}</p>`:''}<div style="display:flex;gap:8px;flex-wrap:wrap">${button(s.connected?'Connect again':'Connect','app-connect',!s.connected,`data-id="${s.id}"`)}${s.connected?button('Disconnect','app-disconnect',false,`data-id="${s.id}"`):''}</div></article>`).join('');
}
function openAppConnect(id){
  const s=appList.find(x=>x.id===id);if(!s)return;
  const local=['127.0.0.1','localhost'].includes(location.hostname);
  const fields=s.kind==='token'?`<div class="form-group"><label for="app-token">Token</label><input class="field" id="app-token" type="password" autocomplete="off" placeholder="${s.connected?'Paste a new token to replace the saved one':'Paste the token'}"></div>`
    :`<div class="form-group"><label for="app-client">Client ID</label><input class="field" id="app-client" autocomplete="off" value="${esc(s.clientId)}"></div>${s.secretNeeded?`<div class="form-group"><label for="app-secret">Client secret</label><input class="field" id="app-secret" type="password" autocomplete="off" placeholder="${s.hasClient?'Saved. Paste a new one to replace it.':''}"></div>`:''}<p class="mono-line">Sign-in comes back to ${esc(s.redirect)}</p>${local?'':'<p class="modal-error">Open SILO on this computer to connect: the sign-in comes back to 127.0.0.1.</p>'}`;
  showModal(`${modalHead('Connect '+esc(s.name),esc(s.what))}<div class="modal-body"><p class="meta-label">ONCE, BEFORE YOU CONNECT</p><ol class="app-steps">${s.setup.map(l=>`<li>${esc(l)}</li>`).join('')}</ol>${fields}${errEl()}</div><div class="modal-footer"><button class="btn" data-action="close-modal">Cancel</button><button class="btn primary" id="app-go">${s.kind==='token'?'Save and check':'Connect'}</button></div>`,'app');
  $('#app-go').onclick=async()=>{
    const btn=$('#app-go');btn.disabled=true;const err=$('#form-error');if(err)err.textContent='';
    try{
      if(s.kind==='token'){const r=await post('/services/'+id,{token:$('#app-token').value});modal.close();toast(`${s.name} is connected as ${r.account}.`);loadApps();return;}
      const r=await post('/services/'+id,{clientId:$('#app-client').value.trim(),clientSecret:$('#app-secret')?.value||''});
      window.open(r.url,'_blank','noopener');
      btn.textContent='Waiting for the sign-in...';
      const until=Date.now()+5*60000;
      const check=async()=>{if(!modal.open)return;await loadApps();const now=appList.find(x=>x.id===id);if(now?.connected&&now.account!==s.account||now?.connected&&!s.connected){modal.close();toast(`${s.name} is connected${now.account?' as '+now.account:''}.`);return;}if(Date.now()<until)setTimeout(check,2500);else{btn.disabled=false;btn.textContent='Connect';}};
      setTimeout(check,2500);
    }catch(e){if(err)err.textContent=e.message;else toast(e.message,true);btn.disabled=false;}
  };
}
async function uploadFiles(list){
  for(const file of list){
    if(file.size>25e6){toast(file.name+' is larger than 25 MB.',true);continue;}
    try{const r=await fetch('/api/upload?name='+encodeURIComponent('uploads/'+file.name),{method:'POST',headers:{'Content-Type':'application/octet-stream','x-silo-token':token},body:file});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Upload failed.');toast('Added uploads/'+file.name);}catch(e){toast(e.message,true);}
  }
  loadFiles();
}
let docOpen=false;
async function openProposal(id){
  const p=await api('/proposals/'+id);
  const docNote=p.binary?`<p class="info-banner"><span>${({docx:'Word document',xlsx:'Excel workbook',pdf:'PDF',csv:'CSV file'})[p.binary.ext]||'File'}, ${(p.binary.size/1024).toFixed(1)} KB. Below is the text it was made from. <a href="/api/download?proposal=${encodeURIComponent(p.id)}" download>Download it to look first</a>.</span></p>`:'';
  showModal(`${modalHead(esc(p.name),esc(p.agentName)+' / '+esc(p.source||'')+(p.exists?' / replaces the current file':''))}<div class="modal-body">${docNote}${p.exists&&p.current!=null?'<div class="meta-label">PROPOSED</div>':''}<pre class="run-detail proposal-full">${esc(p.content)}</pre>${p.exists&&p.current!=null?`<div class="meta-label">CURRENT FILE</div><pre class="run-detail proposal-full dim">${esc(p.current)}</pre>`:''}</div><div class="modal-footer"><button class="btn danger" data-action="discard-proposal" data-id="${p.id}">Discard</button><button class="btn" data-action="edit-proposal" data-id="${p.id}">Edit before saving</button><button class="btn primary" data-action="save-proposal" data-id="${p.id}">Save file</button></div>`,'proposal');
}
async function loadFiles(){try{const files=await api('/files');if(view!=='files')return;$('#file-count').textContent=files.length+' FILES';$('#file-list').innerHTML=files.map(f=>`<button class="file-row" data-action="open-file" data-name="${esc(f.name)}">${icon('files')}<span>${esc(f.name)}</span><small>${(f.size/1024).toFixed(1)} KB</small></button>`).join('')||'<div class="empty">No files yet.</div>';}catch(e){toast(e.message,true);}}
function showFileInEditor(name,f){
  docOpen=!!f.document;$('#file-name').value=name;$('#file-content').value=f.content;$('#file-content').readOnly=docOpen;
  const note=$('#doc-note');if(note)note.innerHTML=docOpen?`Document text, read only. <a href="/api/download?name=${encodeURIComponent(name)}" download>Download the file</a>.`:'Plain text. Ctrl+S saves.';
}
async function saveFile(){if(docOpen){toast('Documents are shown read only. Download the file to change it.',true);return;}const name=$('#file-name').value.trim();if(!name){toast('Give your file a relative name, such as notes/idea.md.',true);return;}if(editingProposal&&pending().some(p=>p.id===editingProposal)){const id=editingProposal;editingProposal=null;return decideProposal(id,'save',{name,content:$('#file-content').value});}await post('/file',{name,content:$('#file-content').value});toast('Saved to workspace/'+name);loadFiles();}
function openSearch(){
  showModal(`${modalHead('Search','Residents, levels, terminals, workflows, runs, files and traces.')}<div class="modal-body"><input id="global-search" class="field" type="search" placeholder="Name, role, L12, workflow, file" aria-label="Search workspace"><div class="search-results" id="search-results"></div></div>`,'search');
  let files=[],traces=[];
  const update=()=>{
    const input=$('#global-search');if(!input)return;
    const q=input.value.toLowerCase().trim(),has=v=>String(v||'').toLowerCase().includes(q),lv=q.match(/^l?\s*0*(\d{1,3})$/)?.[1];
    const row=(action,id,ic,label,small)=>`<button class="search-result" data-action="${action}" data-id="${esc(id)}">${ic} ${esc(label)}<small>${small}</small></button>`;
    const pages=navItems.filter(([,label])=>has(label));
    // A level number finds that level exactly, so L14 does not also list L140 to L149.
    const agents=state.agents.filter(a=>lv?String(a.level)===String(+lv):has(a.name+' '+a.role+' '+(a.provider==='demo'?'demo':'live '+a.provider))).slice(0,q?30:60);
    const flows=q?state.workflows.filter(w=>has(w.name+' '+(w.description||''))).slice(0,8):[];
    const runs=q?state.runs.filter(r=>has(r.name+' '+(r.input||'')+' '+runLabel(r))).slice(0,8):[];
    const fl=q?files.filter(x=>has(x.name)).slice(0,8):[];
    const tr=q?traces.filter(t=>has(t.name)).slice(0,8):[];
    let html=lv&&+lv>=1&&+lv<=144?`<button class="search-result" data-action="search-level" data-id="${+lv}">${icon('silo')} Go to level ${pad3(+lv)}<small>The Silo</small></button>`:'';
    html+=pages.map(([id,label])=>`<button class="search-result" data-action="search-nav" data-view="${id}">${icon(id)} ${label}<small>Terminal</small></button>`).join('');
    html+=flows.map(w=>row('search-flow',w.id,icon('workflows'),w.name,'Workflow')).join('');
    html+=runs.map(r=>row('search-run',r.id,icon('activity'),r.name,'Run / '+esc(runLabel(r))+' / '+age(r.started))).join('');
    html+=fl.map(x=>row('search-file',x.name,icon('files'),x.name,'Archive file')).join('');
    html+=tr.map(t=>row('search-trace',t.id,icon('clock'),t.name,({run:'Run trace',chat:'Conversation trace',goal:'Goal trace'}[t.kind]||'Trace')+' / '+age(t.started))).join('');
    html+=agents.map(a=>{const x=activityOf(a);return `<button class="search-result" data-action="chat" data-id="${a.id}"><span class="tiny-avatar">${pixelAvatar(a)}</span>${esc(a.name)}<small>${esc(a.role)} / L${pad3(a.level)}${a.provider==='demo'?' / DEMO':''}${x?' / '+(x.state==='done'?(x.verified?'DONE / CHECKED':'DONE / NOT CHECKED'):ACT_WORD[x.state]||''):''}</small></button>`;}).join('');
    $('#search-results').innerHTML=html||'<div class="empty small">Nothing matches.</div>';
  };
  $('#global-search').oninput=update;update();$('#global-search').focus();
  Promise.all([api('/files').catch(()=>[]),api('/traces').catch(()=>({traces:[]}))]).then(([fs,t])=>{files=Array.isArray(fs)?fs:[];traces=t?.traces||[];update();});
}
async function openArchiveFile(name){
  modal.close();navigate('files');
  try{const f=await api('/file?name='+encodeURIComponent(name));for(let k=0;k<20&&!$('#file-name');k++)await new Promise(r=>setTimeout(r,50));if($('#file-name')){showFileInEditor(name,f);$('#file-content').focus();}}catch(e){toast(e.message,true);}
}
function confirmRemoval(kind,obj){showModal(`${modalHead(kind==='agent'?'Remove '+esc(obj.name)+'?':'Delete this workflow?')}<div class="modal-body"><p style="font-size:12px;line-height:1.9;color:#8b947b">${kind==='agent'?'This deletes the resident and their conversation history. If a workflow uses this resident, remove them from it first.':'The workflow definition will be removed. Existing run traces remain in the activity history.'}</p>${errEl()}</div><div class="modal-footer"><button class="btn" data-action="close-modal">Cancel</button><button class="btn danger" id="confirm-remove">Confirm removal</button></div>`,'confirm');$('#confirm-remove').onclick=async()=>{try{await api('/'+(kind==='agent'?'agents/':'workflows/')+obj.id,{method:'DELETE',body:{}});await refresh();modal.close();render();toast('Removed.');}catch(e){$('#form-error').textContent=e.message;}};}
// Returns false when the server says nothing changed since the last copy.
// The live channel. The server sends the state once, then small patches as things change, and the text residents
// are writing. While it is up, the regular check every two seconds only reads what already arrived.
let stream=null,streamState=null,streamUp=false,streamFresh=false,streamTimer=0,streamFails=0;const liveText=new Map();
function openStream(){
  if(stream||!window.EventSource||(accounts&&!me))return;
  const es=stream=new EventSource('/api/stream');
  const drop=()=>{streamUp=false;streamState=null;};
  es.addEventListener('full',e=>{const m=JSON.parse(e.data);streamState=m.state;streamState.tag=m.tag;streamUp=true;streamFails=0;stateArrived();});
  es.addEventListener('patch',e=>{
    const m=JSON.parse(e.data);
    // A patch that does not fit what this page has: start the channel again, which sends everything once.
    if(!streamState||streamState.tag!==m.from){es.close();stream=null;drop();setTimeout(openStream,300);return;}
    streamState=applyPatch(streamState,m.p);streamState.tag=m.tag;stateArrived();
  });
  es.addEventListener('live',e=>{const m=JSON.parse(e.data);if(m.done){liveText.delete(m.id);return;}const was=liveText.get(m.id)||{text:'',note:''};liveText.set(m.id,m.add!==undefined?{text:was.text+m.add,note:was.note}:{text:m.text||'',note:m.note||''});});
  es.addEventListener('end',()=>{es.close();if(stream===es)stream=null;drop();});
  es.onerror=()=>{drop();if(++streamFails>=5){es.close();if(stream===es)stream=null;setTimeout(openStream,30000);}};
}
function stateArrived(){streamFresh=true;clearTimeout(streamTimer);streamTimer=setTimeout(()=>poll(),40);}
async function refresh(fromPoll=false){
  if(fromPoll&&streamUp&&streamState){
    if(!streamFresh)return false;
    streamFresh=false;if(state?.tag===streamState.tag)return false;
    state=structuredClone(streamState);
  }else{const next=await api('/state',{headers:state?.tag?{'x-silo-since':state.tag}:{}});if(!next?.agents)return false;state=next;}
  sendCouriers();if(!getAgent(selected))selected=state.agents[0]?.id;syncStatus();return true;
}
const actions={
  'ai-run':el=>runAi(el.dataset.key,el.dataset.kind),'ai-hide':el=>{const k=el.dataset.key;aiNotes.get(k)?.abort?.abort();aiNotes.set(k,{hidden:true});forgetAiNote(k);paintAiNote(k);},'ai-brief':()=>runAi('brief','summary'),'ai-check':()=>checkAi(),'ai-prepare':el=>prepareAi(el),
  'locate-agent':el=>{const agent=getAgent(el.dataset.id);navigate('silo');selectAgent(agent.id);world?.focusAgent(agent);},
  nav:el=>navigate(el.dataset.view),'search-nav':el=>{modal.close();navigate(el.dataset.view);},'new-agent':()=>openAgentEditor(),'edit-agent':el=>openAgentEditor(getAgent(el.dataset.id)),'delete-agent':el=>confirmRemoval('agent',getAgent(el.dataset.id)),chat:el=>openChat(getAgent(el.dataset.id)),'select-agent':el=>selectAgent(el.dataset.id),'close-modal':()=>modal.close(),
  pause:async()=>{await post('/pause',{paused:!state.paused});await refresh();world?.update(state.agents,residentOpen?selected:null,state.paused);toast(state.paused?'Silo paused. Running requests will finish.':'Silo resumed.');},
  'return-world':()=>navigate('silo'),'close-resident':()=>{residentOpen=false;$('#agent-panel').hidden=true;world?.update(state.agents,null,state.paused);},'floor-up':()=>world?.focusLevel(Math.max(1,currentLevel-1)),'floor-down':()=>world?.focusLevel(Math.min(144,currentLevel+1)),
  'world-tab':el=>{worldTab=el.dataset.tab;render();},'zoom-in':()=>zoomWorld(1.25),'zoom-out':()=>zoomWorld(1/1.25),crt:()=>{const on=!(world?.crt??crtPreference());try{localStorage.setItem('silo-crt',on?'on':'off');}catch{}world?.setCrt?.(on);syncCrt();},'zoom-reset':()=>world?.reset(),'silo-overview':()=>world?.overview(),'focus-floor':el=>setFloor(Number(el.dataset.floor)),
  'directory-floor':el=>{navigate('silo');setFloor(Number(el.dataset.floor));},fullscreen:async()=>{if(document.fullscreenElement)await document.exitFullscreen();else await $('.silo-universe').requestFullscreen();},
  connect:el=>openConnection(el.dataset.provider),disconnect:async el=>{await post('/connections',{provider:el.dataset.provider,disconnect:true});await refresh();modal.close();render();toast('Provider disconnected.');},'test-connection':async el=>{el.disabled=true;toast('Sending a test request...');try{const result=await post('/connections/test',{provider:el.dataset.provider});toast('Connection works: '+result.text.slice(0,80));}finally{el.disabled=false;}},
  'new-goal':()=>openGoalEditor(),
  'stop-goal':async el=>{el.disabled=true;try{await post('/goals/'+el.dataset.id+'/stop',{});await refresh();if(view==='workflows')render();toast('Goal stopped.');}catch(e){toast(e.message,true);el.disabled=false;}},
  'verify-goal':async el=>{el.disabled=true;try{const r=await post('/goals/'+el.dataset.id+'/verify',{});await refresh();if(view==='workflows')render();toast(r.verification.passed?`Verified: ${r.verification.passedCount}/${r.verification.totalCount} criteria passed.`:`Verification: ${r.verification.passedCount}/${r.verification.totalCount} passed.`);}catch(e){toast(e.message,true);}finally{el.disabled=false;}},
  'compensate-run':async el=>{el.disabled=true;try{const r=await post('/runs/'+el.dataset.id+'/compensate',{});await refresh();const run=state.runs.find(x=>x.id===el.dataset.id);if(run&&modalKind==='trace')updateTrace(run);toast(`Compensated ${r.compensated} external action(s).`);}catch(e){toast(e.message,true);el.disabled=false;}},
  'new-workflow':()=>openWorkflowEditor(),'edit-workflow':el=>openWorkflowEditor(state.workflows.find(w=>w.id===el.dataset.id)),'delete-workflow':el=>confirmRemoval('workflow',state.workflows.find(w=>w.id===el.dataset.id)),'run-workflow':el=>runWorkflow(state.workflows.find(w=>w.id===el.dataset.id)),'more-agents':()=>{agentLimit+=PAGE;$('#agent-grid').innerHTML=agentGrid();},
  'cam-select':el=>{mainCam=Number(el.dataset.cam);if(feedWall){feedWall.main=mainCam;feedWall.lastMain=-1;}syncSecurity();},
  'cam-pan':el=>{steer(cam(),{pan:.12*Number(el.dataset.d)});},'cam-tilt':el=>{steer(cam(),{tilt:.08*Number(el.dataset.d)});},'cam-zoom':el=>{steer(cam(),{zoom:Math.pow(1.25,Number(el.dataset.d))});syncZoom();},
  'cam-level':el=>moveCamLevel(Number(el.dataset.d)),'cam-reset':()=>{const c=cam();Object.assign(c,c.mount);syncSecurity();},
  'cam-go':()=>{const c=cam();navigate('silo');if(c.kind==='outside')world?.goOutside?.();else world?.focusLevel(c.kind==='hall'?144:c.level);},
  'follow-work':()=>{followWork=!followWork;try{localStorage.setItem('silo-follow-work',followWork?'on':'off');}catch{}workTarget=null;steerToWork(true);syncSecurity();toast(followWork?'The big monitor follows the resident on the current step.':'The big monitor stays where you put it.');},
  'watch-courier':el=>{const id=courierFor(el.dataset.id);if(!id){toast('The courier has already delivered the folder.');return;}modal.close();navigate('silo');world.followCourier(id);},
  'cam-track':el=>trackResident(el.dataset.id),'cam-point':el=>pointCamera(el.dataset.id),'watch-agent':el=>{navigate('security');pointCamera(el.dataset.id);},'cam-untrack':()=>{trackId=null;if(feedWall)feedWall.track=null;syncSecurity();},
  'clean-lens':()=>{world?.cleanLens?.();toast('The lens is clean. The picture is clear again.');syncSecurity();},
  'view-run':el=>openRun(state.runs.find(r=>r.id===el.dataset.id)),
  'browser-signin':el=>{const a=getAgent(el.dataset.id);if(a)openBrowserSignIn(a);},
  'browser-close':async el=>{try{await post('/browser/'+el.dataset.id+'/close',{});await refresh();render();toast('Browser closed.');}catch(e){toast(e.message,true);}},
  'browser-forget':async el=>{const a=getAgent(el.dataset.id);if(!a||!confirm('Sign '+a.name+' out of every site? This deletes its browser profile and cannot be undone.'))return;try{await post('/browser/'+a.id+'/forget',{});await refresh();render();toast(a.name+' is signed out everywhere.');}catch(e){toast(e.message,true);}},
  'remote-download':async el=>{el.disabled=true;el.textContent='Downloading...';try{await post('/remote/download',{});toast('cloudflared is installed.');}catch(e){toast(e.message,true);}loadRemoteCard();},
  'remote-on':async el=>{el.disabled=true;try{await post('/remote',{...remoteForm(),enabled:true});toast('Remote access is starting.');}catch(e){toast(e.message,true);}loadRemoteCard();},
  'remote-off':async el=>{if(!confirm('Turn off remote access? The address stops working right away.'))return;el.disabled=true;try{await post('/remote',{enabled:false});toast('Remote access is off.');}catch(e){toast(e.message,true);}loadRemoteCard();},
  'remote-save':async()=>{try{await post('/remote',remoteForm());toast('Remote access settings saved.');}catch(e){toast(e.message,true);}loadRemoteCard();},
  'remote-copy':async el=>{try{await navigator.clipboard.writeText(el.dataset.url);toast('Address copied.');}catch{toast(el.dataset.url);}},
  'browser-save':async()=>{try{await post('/browser',{path:$('#browser-path').value.trim(),headless:!$('#browser-visible').checked});toast('Browser settings saved. Open browsers were closed.');loadBrowserCard();}catch(e){toast(e.message,true);}},
  'trail-run':el=>{const r=state.runs.find(x=>x.id===el.dataset.id);if(r)showTrail(runTrail(r));else toast('This run is no longer kept.',true);},
  'trail-flow':el=>{const w=state.workflows.find(x=>x.id===el.dataset.id);if(w)showTrail(flowTrail(w));},
  'trail-trace':async el=>{try{showTrail(traceTrail(await api('/traces/'+el.dataset.id)));}catch(e){toast(e.message,true);}},
  'trail-next':()=>trailNext(),'trail-clear':()=>clearTrail(),
  'search-level':el=>{modal.close();navigate('silo');world?.focusLevel?.(Number(el.dataset.id));},
  'search-flow':el=>{modal.close();navigate('workflows');requestAnimationFrame(()=>{const card=$(`[data-flow="${el.dataset.id}"]`);if(card){card.scrollIntoView({behavior:'smooth',block:'center'});card.classList.add('flash');setTimeout(()=>card.classList.remove('flash'),1600);}});},
  'search-run':el=>{const r=state.runs.find(x=>x.id===el.dataset.id);if(r)openRun(r);},
  'search-trace':el=>openTrace(el.dataset.id),
  'search-file':el=>openArchiveFile(el.dataset.id),
  'open-trace':el=>openTrace(el.dataset.id),
  'stop-run':async el=>{el.disabled=true;try{await post('/runs/'+el.dataset.id+'/stop',{});toast('Stopping the run.');await refresh();const r=state.runs.find(r=>r.id===el.dataset.id);if(r&&modalKind==='trace')updateTrace(r);}catch(e){toast(e.message,true);el.disabled=false;}},
  'resume-run':async el=>{el.disabled=true;try{await post('/runs/'+el.dataset.id+'/resume',{});await refresh();toast('Run resumed.');const r=state.runs.find(r=>r.id===el.dataset.id);if(r&&modalKind==='trace')updateTrace(r);if(view==='workflows')$('#run-history').innerHTML=runHistory();}catch(e){toast(e.message,true);el.disabled=false;}},
  templates:()=>openTemplates(),'order-page':el=>{orderPage=el.dataset.key;const e=orderIndex().flatMap(c=>c.list).find(e=>e.t.key===orderPage);if(!e)return;$('#order-page').innerHTML=orderProcedure(e);$('#order-page').scrollTop=0;$$('.order-entry').forEach(b=>{const on=b.dataset.key===orderPage;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));});},'use-template':el=>{const t=procedureByKey(el.dataset.key);if(t)openWorkflowEditor(materialize(t,state.agents));},
  'import-procedure':()=>openImportProcedure(),
  'keep-procedure':async()=>{if(!importedProcedure)return;try{const kept=await post('/templates',{template:cleanProcedure(importedProcedure)});importedProcedure=null;await refresh();toast(kept.name+' is kept in the Order.');openTemplates('u:'+kept.id);}catch(e){toast(e.message,true);}},
  'remove-procedure':async el=>{if(!confirm('Remove this procedure from the Order? Workflows made from it stay.'))return;try{await api('/templates/'+el.dataset.id,{method:'DELETE'});await refresh();openTemplates();toast('Removed from the Order.');}catch(e){toast(e.message,true);}},
  'download-procedure':el=>{const t=procedureByKey(el.dataset.key);if(t)saveJson(cleanProcedure(t),slugName(t.name)+'.silo.json');},
  'share-workflow':el=>openShare(state.workflows.find(w=>w.id===el.dataset.id)),
  'copy-hook':async el=>{try{await navigator.clipboard.writeText(el.dataset.url);toast('Webhook address copied.');}catch{toast('Copy is blocked by the browser. Select the address instead.',true);}},
  'view-proposal':el=>openProposal(el.dataset.id).catch(e=>toast(e.message,true)),'save-proposal':el=>decideProposal(el.dataset.id,'save'),'discard-proposal':el=>decideProposal(el.dataset.id,'discard'),'revert-proposal':el=>decideProposal(el.dataset.id,'revert'),
  'edit-proposal':async el=>{try{const p=await api('/proposals/'+el.dataset.id);modal.close();if(view!=='files')navigate('files');editingProposal=p.id;$('#file-name').value=p.name;$('#file-content').value=p.content;$('#file-content').focus();toast('Edit the file, then click Save file to approve it.');}catch(e){toast(e.message,true);}},
  'add-note':async el=>{const field=$('#memory-text'),text=field.value.trim();if(!text)return;try{const r=await post('/agents/'+el.dataset.id+'/memory',{text});field.value='';await refresh();const a=getAgent(el.dataset.id);$('#memory-list').innerHTML=memoryList(a||{memory:r.memory,whispers:r.whispers});}catch(e){toast(e.message,true);}},
  'forget-note':async el=>{try{const r=await post('/agents/'+el.dataset.id+'/memory',{remove:Number(el.dataset.i)});const a=getAgent(el.dataset.id);if(a)a.memory=r.memory;$('#memory-list').innerHTML=memoryList({...a,memory:r.memory});}catch(e){toast(e.message,true);}},
  'clear-whispers':async el=>{try{await post('/agents/'+el.dataset.id+'/memory',{clearWhispers:true});const a=getAgent(el.dataset.id);if(a)a.whispers=[];$('#memory-list').innerHTML=memoryList(a);toast('Gallery whispers cleared.');}catch(e){toast(e.message,true);}},
  'save-pact':async()=>{try{const power=state.floors.map((_,i)=>$(`[data-sector-power="${i}"]`)?.checked?1:0);await post('/settings',{pact:{enabled:$('#pact-enabled').checked,rules:$('#pact-rules').value,maxChars:Number($('#pact-max').value)||0},whispers:$('#whispers-toggle').checked,cafeteria:$('#caf-mode').value,power});await refresh();world?.setPulse?.(state.pulse);toast('The Pact, Whisper Network, Cafeteria projection and sector power saved.');loadSystemInfo();}catch(e){toast(e.message,true);}},
  'set-cafeteria':async el=>{try{await post('/settings',{cafeteria:el.dataset.mode});await refresh();world?.setPulse?.(state.pulse);syncSecurity();toast('Cafeteria wall set to '+el.dataset.mode+'.');}catch(e){toast(e.message,true);}},
  'send-clean':async el=>{const a=getAgent(el.dataset.id);if(!a)return;try{await post('/agents/'+a.id+'/clean',{});world?.cleanLens?.();await refresh();if(residentOpen&&selected===a.id)$('#agent-panel').innerHTML=agentPanel();toast(`${a.name} wiped the surface sensor and reset error state.`);}catch(e){toast(e.message,true);}},
  'send-letter':el=>openDispatch(getAgent(el.dataset.id)),
  'run-drill':async el=>{el.disabled=true;try{const r=await post('/agents/'+el.dataset.id+'/drill',{}),d=r.drill;await refresh();if(residentOpen&&selected===el.dataset.id)$('#agent-panel').innerHTML=agentPanel();toast(d.ok?`Judicial Drill PASSED for ${r.agent.name}.`:`Judicial Drill BREACH (${r.agent.name}): ${d.issues.join(' | ')}`,!d.ok);}catch(e){toast(e.message,true);}finally{el.disabled=false;}},
  'save-radio':()=>saveRadio({enabled:$('#radio-enabled').checked,siloId:$('#radio-silo-id').value.trim()||'Silo 18',address:$('#radio-address').value.trim()}),
  'send-radio':async el=>{const msg=$('#radio-msg')?.value.trim(),to=$('#radio-to')?.value.trim();if(!to||!msg){toast('Say which resident, and write the message.',true);return;}el.disabled=true;try{const r=await post('/radio/send',{peer:$('#radio-peer').value,toAgent:to,message:msg});if($('#radio-reply'))$('#radio-reply').textContent=`${r.silo} / ${r.agent.name} (L${r.agent.level}): ${r.reply}`;toast('Answer from '+r.silo+'.');}catch(e){toast(e.message,true);}finally{el.disabled=false;}},
  'radio-genkey':async()=>{try{const {key}=await post('/radio/key',{});$('#rp-key').value=key;$('#rp-key').select();toast('Key made. Give the same key to the other silo, then save.');}catch(e){toast(e.message,true);}},
  'radio-edit':el=>{const p=(state.settings.radio.peers||[]).find(p=>p.id===el.dataset.id);if(!p)return;$('#rp-id').value=p.id;$('#rp-title').textContent='Edit '+p.name;$('#rp-name').value=p.name;$('#rp-url').value=p.url;$('#rp-key').value='';$('#rp-key').placeholder=state.access?.radioKeys?.[p.id]?'Saved. Leave empty to keep it.':'Leave empty when it has a key';$('#rp-pub').value=p.publicKey||'';$('#rp-print').textContent=p.publicKey?'Fingerprint '+(state.access?.radioPrints?.[p.id]||''):'';$('#rp-hour').value=p.perHour;$('#rp-day').value=p.tokensPerDay||0;$('#rp-res').value=(p.residents||[]).join(', ');$('#rp-send').checked=p.send;$('#rp-receive').checked=p.receive;$('#rp-cancel').hidden=false;$('#rp-name').focus();},
  'radio-cancel':()=>{$('#radio-peer-form').reset();$('#rp-id').value='';$('#rp-title').textContent='Add a silo';$('#rp-key').placeholder='Leave empty when it has a key';$('#rp-print').textContent='';$('#rp-cancel').hidden=true;},
  'radio-copy-key':async()=>{try{await navigator.clipboard.writeText($('#radio-pub').value);toast('Key copied. Tell the other owner the fingerprint too.');}catch{$('#radio-pub').select();toast('Select the key and copy it.',true);}},
  // Reads the key the other silo shows at its address. The owner still compares the fingerprint with the other owner.
  'radio-lookup':async el=>{const url=$('#rp-url').value.trim();if(!url){toast('Write its address first.',true);$('#rp-url').focus();return;}el.disabled=true;try{const r=await post('/radio/lookup',{url});$('#rp-pub').value=r.publicKey;if(!$('#rp-name').value.trim()&&r.silo)$('#rp-name').value=r.silo;$('#rp-print').innerHTML=`Key of ${esc(r.silo||'that silo')}: fingerprint <strong>${esc(r.fingerprint)}</strong>. Ask its owner to read theirs to you, and save only if they match.`;}catch(e){toast(e.message,true);}finally{el.disabled=false;}},
  'cap-copy':el=>{const c=(state.settings.radio.issued||[]).find(x=>x.hash===el.dataset.hash);if(c?.token)showCapToken(c);},
  'cap-revoke':async el=>{const c=(state.settings.radio.issued||[]).find(x=>x.hash===el.dataset.hash);if(!c||!confirm(`Take back the rights given to ${c.audName||'that silo'}? Whatever it passed on stops working too.`))return;el.disabled=true;try{await post('/radio/caps/'+c.hash+'/revoke',{});toast('Revoked.');await refresh();loadSystemInfo();}catch(e){toast(e.message,true);el.disabled=false;}},
  'held-remove':async el=>{const h=(state.settings.radio.held||[]).find(x=>x.id===el.dataset.id);if(!h||!confirm(`Remove the rights from ${h.rootName||'that silo'}? You need the capability again to use them.`))return;try{await api('/radio/held/'+h.id,{method:'DELETE'});toast('Removed.');await refresh();loadSystemInfo();}catch(e){toast(e.message,true);}},
  'held-delegate':el=>{
    const h=(state.settings.radio.held||[]).find(x=>x.id===el.dataset.id);if(!h)return;
    const peers=(state.settings.radio.peers||[]).filter(p=>p.publicKey&&p.publicKey!==h.root),left=capLeft(h,state.settings.radio)||h.budget,hours=Math.max(.1,Math.floor((h.exp-Date.now())/360000)/10);
    showModal(`${modalHead('Pass on rights','From what '+esc(h.rootName||'another silo')+' gave: '+capLine(h))}<form id="dlg-form" autocomplete="off"><div class="modal-body"><p class="mono-line">The other silo gets at most what you hold, and what it uses counts against yours too.</p>${capFields('dlg',{rights:h.rights,only:h.rights.tools,budget:{tokens:left.tokens||h.budget.tokens,messages:left.messages||h.budget.messages},hours},peers)}</div><div class="modal-footer"><button type="button" class="btn" data-action="close-modal">Cancel</button><button type="submit" class="btn primary">Pass on</button></div></form>`,'delegate');
    bindCapPeer('dlg');
    $('#dlg-form').onsubmit=async e=>{e.preventDefault();try{const rec=await post('/radio/held/'+h.id+'/delegate',readCap('dlg',e.currentTarget));await refresh();loadSystemInfo();showCapToken(rec);}catch(err){toast(err.message,true);}};
  },
  'save-expose':async()=>{
    const ids=cls=>[...document.querySelectorAll('.'+cls+':checked')].map(x=>x.value);
    try{await post('/expose',{mcp:$('#expose-mcp').checked,a2a:$('#expose-a2a').checked,residents:ids('expose-res'),workflows:ids('expose-flow'),front:$('#expose-front').value,description:$('#expose-desc').value});toast('Outside programs saved.');await refresh();loadSystemInfo();}catch(e){toast(e.message,true);}
  },
  'copy-snippet':async()=>{const s=snippets[Number($('#snippet-pick')?.value||0)];if(!s)return;try{await navigator.clipboard.writeText(s[1]);toast(s[0]+' copied.');}catch{toast('Select the text and copy it.',true);}},
  'a2a-refresh':async el=>{try{const r=await post('/a2a/peers/'+el.dataset.id,{refresh:true});toast(`${r.peer.name}: ${r.peer.skills?.length||0} skills.`);await refresh();loadSystemInfo();}catch(e){toast(e.message,true);}},
  'a2a-remove':async el=>{const p=(state.settings.a2aPeers||[]).find(p=>p.id===el.dataset.id);if(!p||!confirm(`Remove ${p.name}? Its token is deleted and residents can no longer ask it.`))return;try{await api('/a2a/peers/'+p.id,{method:'DELETE'});toast('Outside agent removed.');await refresh();loadSystemInfo();}catch(e){toast(e.message,true);}},
  'notebook-open':el=>openNotebook(el.dataset.agent,el.dataset.name),
  'notebook-restart':async el=>{try{await post(`/notebooks/${encodeURIComponent(el.dataset.agent)}/${encodeURIComponent(el.dataset.name)}`,{action:'restart'});toast('Kernel stopped. The next cell starts fresh.');loadNotebooksCard();}catch(e){toast(e.message,true);}},
  'notebook-archive':async el=>{try{const r=await post(`/notebooks/${encodeURIComponent(el.dataset.agent)}/${encodeURIComponent(el.dataset.name)}`,{action:'archive'});toast('Saved as '+r.name);}catch(e){toast(e.message,true);}},
  'notebook-delete':async el=>{if(!confirm(`Delete the notebook ${el.dataset.name}? Its cells and outputs are gone for good.`))return;try{await api(`/notebooks/${encodeURIComponent(el.dataset.agent)}/${encodeURIComponent(el.dataset.name)}`,{method:'DELETE'});toast('Notebook deleted.');loadNotebooksCard();}catch(e){toast(e.message,true);}},
  'python-tool-new':()=>openPythonToolEditor(),
  'radio-remove':async el=>{const p=(state.settings.radio.peers||[]).find(p=>p.id===el.dataset.id);if(!p||!confirm(`Remove ${p.name}? Its key is deleted and it can no longer reach this silo.`))return;try{await api('/radio/peers/'+p.id,{method:'DELETE'});toast('Silo removed.');await refresh();loadSystemInfo();}catch(e){toast(e.message,true);}},
  'scan-relics':async el=>{el.disabled=true;try{const r=await api('/relics'),box=$('#relic-banner');if(box)box.innerHTML=r.relics.length?`<div class="section-card" style="margin-bottom:14px;border-color:#d88a44"><div class="panel-title">Judicial Relic Scan <small class="tag-warn">${r.relics.length} FOUND</small></div>${r.relics.map(x=>`<div class="activity-row"><span class="event-icon">${icon('security')}</span><div><strong>${esc(x.name)}</strong><p>${esc(x.where.toUpperCase())} · <span class="tag-warn">${esc(x.kinds.join(', '))}</span></p></div></div>`).join('')}</div>`:`<div class="info-banner"><span><strong>Judicial Relic Scan clear:</strong> 0 leaked keys or secrets found across ${r.scannedFiles} workspace files and ${r.scannedAgents} residents.</span></div>`;toast(r.relics.length?`${r.relics.length} potential secret relic(s) found!`:'Judicial scan clear: 0 relics found.',!!r.relics.length);}catch(e){toast(e.message,true);}finally{el.disabled=false;}},
  'file-shift-report':async el=>{el.disabled=true;try{const r=await post('/shift-report',{});await refresh();navigate('files');$('#file-name').value=r.name;$('#file-content').value=r.content;toast('Shift report filed in '+r.name+'.');}catch(e){toast(e.message,true);}finally{el.disabled=false;}},
  'scrub-step':el=>projectRunStep(el.dataset.id,Number(el.dataset.step)),
  'scrub-go':el=>projectRunStep(el.dataset.id,Number($('#run-scrub')?.value||0)),
  'approve-run':el=>decideRun(el,true),
  'check-run':el=>checkRun(el),
  'allow-request':el=>decideRequest(el.dataset.id,true),'allow-always':el=>decideRequest(el.dataset.id,true,true),'deny-request':el=>decideRequest(el.dataset.id,false),
  untrust:async el=>{try{const r=await post('/agents/'+el.dataset.id+'/trust',{tool:el.dataset.tool});const a=getAgent(el.dataset.id);if(a)a.trust=r.trust;el.closest('span').remove();toast('This resident will ask again.');}catch(e){toast(e.message,true);}},
  // The sign-in page opens in a new tab. The tab is opened right away, so the browser does not block it.
  'mcp-signin':async el=>{el.disabled=true;const w=window.open('','_blank');try{const r=await post('/mcp/'+el.dataset.id+'/signin',{});if(w){w.opener=null;w.location.href=r.url;}else location.href=r.url;toast('Finish the sign-in in the new tab. The connector updates by itself.');}catch(e){w?.close();await refresh();render();toast(e.message,true);}finally{el.disabled=false;}},
  'mcp-signout':async el=>{const c=state.mcp.find(c=>c.id===el.dataset.id);if(!c||!confirm(`Sign out of ${c.name}? Residents cannot use it until you sign in again.`))return;try{await post('/mcp/'+c.id+'/signout',{});await refresh();render();toast('Signed out.');}catch(e){toast(e.message,true);}},
  'mcp-find':async el=>{
    const form=el.closest('form'),q=form.querySelector('#mcp-find').value.trim(),category=form.querySelector('#mcp-cat').value,box=form.querySelector('.mcp-finder .api-results');if(!q&&!category)return;
    el.disabled=true;box.textContent='Searching...';findHits=[];
    const hit=(i,title,sub,text)=>`<button type="button" class="api-hit" data-action="mcp-pick" data-i="${i}"><b>${esc(title)}</b> <small>${esc(sub)}</small>${text?`<span>${esc(text)}</span>`:''}</button>`;
    const part=(title,body)=>body?`<div class="find-head">${title}</div>${body}`:'';
    const [mine,reg,dir]=await Promise.allSettled([findLocal(category?'':q),q&&!category?api('/mcp-registry?q='+encodeURIComponent(q)):{servers:[]},api('/apis?q='+encodeURIComponent(q)+'&category='+encodeURIComponent(category))]);
    let html='';
    html+=part('Built into SILO',(mine.value||[]).map(({k,p})=>hit(findHits.push({type:'preset',k})-1,p.label,p.builtin?'ready, needs your key':p.transport==='http'?'address':'program',(p.note||'').split('. ')[0])).join(''));
    html+=reg.status==='rejected'?part('MCP registry',`<small class="modal-error">${esc(reg.reason.message)}</small>`):part('MCP registry',reg.value.servers.flatMap(sv=>sv.ways.slice(0,2).map(w=>hit(findHits.push({type:'way',sv,w})-1,sv.title,w.kind==='http'?'address':'program: '+w.command,sv.description))).join(''));
    html+=dir.status==='rejected'?part('Web APIs',`<small class="modal-error">${esc(dir.reason.message)}</small>`):part(`Web APIs <small>${dir.value.total>dir.value.apis.length?`${dir.value.apis.length} of ${dir.value.total}`:''}</small>`,dir.value.apis.map(x=>hit(findHits.push({type:'api',x})-1,x.title,x.id,x.description)).join(''));
    box.innerHTML=html||'<small>Nothing found. Try another word.</small>';el.disabled=false;
  },
  'mcp-pick':async el=>{
    const form=el.closest('form'),h=findHits[+el.dataset.i],box=form.querySelector('.mcp-finder .api-results');if(!h)return;
    const note=html=>{box.innerHTML=`<div class="find-note">${html}</div>`;};
    if(h.type==='preset'){const p=$('#mcp-preset');p.value=h.k;p.dispatchEvent(new Event('change'));note(`Picked ${esc(PRESETS[h.k].label)}. ${esc(PRESETS[h.k].note||'')}`);return;}
    if(h.type==='way'){
      const {sv,w}=h,link=/^https:\/\//.test(sv.repository)?` <a href="${esc(sv.repository)}" target="_blank" rel="noreferrer">Its page</a>.`:'';
      const asks=(w.kind==='http'?w.headers:w.env).map(x=>`<li><code>${esc(x.name)}</code>${x.required?' (needed)':''}${x.description?': '+esc(x.description):''}</li>`).join('');
      if(w.kind==='http')fillConnector(form,{transport:'http',name:sv.title.slice(0,40),url:w.url,headers:w.headers.map(x=>x.name+': ').join('\n')});
      else fillConnector(form,{transport:'stdio',name:sv.title.slice(0,40),command:w.command,args:w.args.join(' '),env:w.env.map(x=>x.name+'=').join('\n')});
      note(`Picked ${esc(sv.title)} from the MCP registry.${link}${w.kind==='stdio'?` This starts a program from ${w.command==='npx'?'npm':w.command==='uvx'?'PyPI':'a Docker image'} on this computer, so check who made it first.`:''}${asks?`<ul>${asks}</ul>Fill in the values above.`:''}`);return;
    }
    const x=h.x;fillConnector(form,{transport:'openapi',name:x.title.slice(0,40),spec:x.spec});note(`Reading the description of ${esc(x.title)}...`);
    try{
      const d=await api('/apis/inspect?spec='+encodeURIComponent(x.spec));
      form.elements.authKind.value=d.auth.kind;form.elements.authName.value=d.auth.name||'';form.elements.authKind.dispatchEvent(new Event('change'));
      note(`Picked ${esc(x.title)}: ${d.ops} operations${d.base?' at <code>'+esc(d.base)+'</code>':''}. Key: ${esc(d.auth.note)}${d.tooMany?' That is too many tools for one connector, so pick a few groups:':d.groups.length>1?' To keep fewer tools, pick groups:':''}${d.groups.length>1?`<div class="group-chips">${d.groups.map(g=>`<button type="button" class="btn small" data-action="mcp-group" data-g="${esc(g.name)}">${esc(g.name)} <small>${g.count}</small></button>`).join('')}</div>`:''}`);
    }catch(e){note(`Picked ${esc(x.title)}. The description could not be read: ${esc(e.message)}`);}
  },
  'mcp-group':el=>{const f=el.closest('form').elements.include,have=f.value.split(',').map(x=>x.trim()).filter(Boolean),g=el.dataset.g.replace(/,/g,' ');if(!have.includes(g))f.value=[...have,g].join(', ').slice(0,300);el.classList.add('primary');el.disabled=true;},
  'apphook-show':async el=>{
    const out=el.parentElement.querySelector('.app-hook-out');el.disabled=true;
    try{
      const r=await api('/workflows/'+el.dataset.id+'/apphook');
      const field=(label,v)=>`<label class="app-field"><small>${label}</small><input class="field" readonly value="${esc(v)}"></label>`;
      if(!r.url){out.innerHTML='<small>Events from the internet need an address the internet can reach. Turn on remote access in Settings, then open this again.</small>';return;}
      if(r.via==='any'){out.innerHTML=`${field('Webhook URL',r.url)}${r.verifyToken?field('Verify token',r.verifyToken):''}${r.learned?field('Verification token from Notion (paste it in Notion)',r.learned):''}<small>${esc(r.setup)}${r.waiting?' Waiting for '+esc(r.app)+' to send its secret.':''}${r.lastEvent?' Last event '+age(r.lastEvent)+'.':''}</small>`;return;}
      out.innerHTML=r.via==='github'
        ?`${field('Payload URL',r.url)}${field('Secret',r.secret)}<small>${r.added?'SILO added this webhook to the repository.':'In the repository: Settings, Webhooks, Add webhook. Content type application/json, then pick the events. Or let SILO add it with your GitHub token.'}</small>${r.added?'':button('Add it to GitHub for me','apphook-github',false,`type="button" data-id="${el.dataset.id}"`)}`
        :`${field('Request URL',r.url)}<small>In your Slack app: Event Subscriptions, turn them on, paste this address, then under bot events add message.channels (and message.groups for private channels). Invite the app to the channel.</small>`;
    }catch(e){out.innerHTML=`<small class="modal-error">${esc(e.message)}</small>`;}finally{el.disabled=false;}
  },
  'apphook-github':async el=>{
    el.disabled=true;
    try{await post('/workflows/'+el.dataset.id+'/apphook/github',{});el.replaceWith(Object.assign(document.createElement('small'),{textContent:'Added. GitHub sends a test event now; the first real one starts the workflow.'}));}
    catch(e){el.disabled=false;toast(e.message,true);}
  },
  'mcp-new':()=>openMcpEditor(),'mcp-edit':el=>openMcpEditor(state.mcp.find(c=>c.id===el.dataset.id)),
  'mcp-test':async el=>{el.disabled=true;try{const r=await post('/mcp/'+el.dataset.id+'/test',{});await refresh();render();toast(`The connector answered with ${r.tools.length} tools.`);}catch(e){await refresh();render();toast(e.message,true);}},
  'mcp-remove':async el=>{const c=state.mcp.find(c=>c.id===el.dataset.id);if(!c||!confirm(`Remove the connector ${c.name}? Residents lose its tools.`))return;try{await api('/mcp/'+c.id,{method:'DELETE'});await refresh();render();toast('Connector removed.');}catch(e){toast(e.message,true);}},'reject-run':el=>decideRun(el,false),
  'insert-var':el=>{const ed=el.closest('.flow-step-editor'),ta=ed.dataset.type==='action'?(ed.querySelector('.act-input.last')||ed.querySelector('.act-input')):ed.querySelector('.step-prompt');if(!ta)return;const v=el.dataset.var,lead=ta.selectionStart&&!/\s/.test(ta.value[ta.selectionStart-1])?' ':'',a=ta.selectionStart+lead.length;ta.setRangeText(lead+v,ta.selectionStart,ta.selectionEnd,'end');if(v.includes(' '))ta.setSelectionRange(a+v.indexOf(' ')+1,a+v.length-2);ta.focus();},
  'replay-run':async el=>{el.disabled=true;try{const from=Number($('#replay-from')?.value||1),r=await post('/runs/'+el.dataset.id+'/replay',{from});await refresh();toast(from>1?`Replaying from step ${from}.`:'Replaying the run.');const run=state.runs.find(x=>x.id===r.id);if(run)openRun(run);if(view==='workflows')$('#run-history').innerHTML=runHistory();}catch(e){toast(e.message,true);el.disabled=false;}},
  'workflow-tests':el=>openTests('workflow',state.workflows.find(w=>w.id===el.dataset.id)),'agent-tests':el=>openTests('agent',getAgent(el.dataset.id)),'workflow-versions':el=>openVersions(state.workflows.find(w=>w.id===el.dataset.id)),
  'add-test':()=>{const n=$$('.test-case').length;if(n>=20){toast('Keep at most 20 tests.',true);return;}$('#test-list').insertAdjacentHTML('beforeend',testEditor({name:'',input:'',checks:[]},n));},
  'remove-test':el=>{el.closest('.test-case').remove();$$('.test-case .step-n').forEach((x,i)=>{x.textContent=pad2(i+1);});},
  'save-tests':async()=>{try{$('#form-error').textContent='';await saveTests();toast('Tests saved.');if(view==='workflows'||view==='agents')render();refreshTests();}catch(e){$('#form-error').textContent=e.message;}},
  'compare-models':async el=>{const models=$$('.compare-row').map(r=>({provider:r.querySelector('.cmp-provider').value,model:r.querySelector('.cmp-model').value.trim()})).filter(m=>m.provider);if(!models.length){toast('Pick at least one provider.',true);return;}if(models.some(m=>!m.model)){toast('Write the model name next to each provider.',true);return;}el.disabled=true;try{$('#form-error').textContent='';await saveTests();await post(suitePath(openTestsKind,openTestsId)+'/evaluate',{models});await refresh();refreshTests();toast('Comparison started. It runs the tests once per model.');}catch(e){$('#form-error').textContent=e.message;}finally{el.disabled=false;}},
  'run-tests':async el=>{el.disabled=true;try{$('#form-error').textContent='';await saveTests();await post(suitePath(openTestsKind,openTestsId)+'/evaluate',{});await refresh();refreshTests();toast('Tests are running. Results appear here as each case finishes.');}catch(e){$('#form-error').textContent=e.message;}finally{el.disabled=false;}},
  'test-from-run':async el=>{el.disabled=true;try{await saveTests();const r=await post(suitePath('workflow',openTestsId)+'/tests/from-run',{runId:$('#t-from-run').value});await refresh();$('#test-list').insertAdjacentHTML('beforeend',testEditor(r.test,r.tests.length-1,'workflow'));toast('Added. Its answer is the reference for the judge.');}catch(e){toast(e.message,true);}finally{el.disabled=false;}},
  'test-from-chat':async el=>{el.disabled=true;try{await saveTests();const r=await post(suitePath('agent',openTestsId)+'/tests/from-chat',{});await refresh();$('#test-list').insertAdjacentHTML('beforeend',testEditor(r.test,r.tests.length-1,'agent'));toast('Added. The answer is the reference for the judge.');}catch(e){toast(e.message,true);}finally{el.disabled=false;}},
  'eval-vote':async el=>{const agree=el.dataset.agree==='1',on=el.classList.contains('on');try{const r=await post('/evals/'+el.dataset.report+'/vote',{testId:el.dataset.test,index:Number(el.dataset.index),agree:on?null:agree});await refresh();refreshTests();if(r.trust?.reliable===false)toast('This judge disagrees with you too often. It is marked unreliable.',true);}catch(e){toast(e.message,true);}},
  'eval-diff':el=>openEvalDiff(el.dataset.report,el.dataset.test),
  'candidate-diff':()=>openCandidateDiff(),
  'eval-back':()=>openTests(openTestsKind,suiteOf(openTestsKind,openTestsId)),
  'candidate':async el=>{const what=el.dataset.do,o=suiteOf(openTestsKind,openTestsId);if(!o?.candidate)return;if(what==='apply'&&o.candidate.status==='worse'&&!confirm('The tests got worse with this change. Apply it anyway?'))return;if(what==='reject'&&!confirm('Drop the held change? What is in use now stays.'))return;el.disabled=true;try{await post(suitePath(openTestsKind,o.id)+'/candidate',{action:what});await refresh();refreshTests();toast(what==='apply'?'Change applied.':what==='reject'?'Change dropped.':'Testing the held change again.');}catch(e){toast(e.message,true);}finally{el.disabled=false;}},
  'restore-version':async el=>{try{const w=await post('/workflows/'+el.dataset.id+'/restore',{version:Number(el.dataset.version)});await refresh();openVersions(state.workflows.find(x=>x.id===w.id));if(view==='workflows')render();toast(`Restored. It is now version ${w.version}.`);}catch(e){toast(e.message,true);}},
  'channel-new':()=>openChannelEditor(),'channel-edit':el=>openChannelEditor(state.channels.find(c=>c.id===el.dataset.id)),
  'phone-save':async el=>{const token=$('#phone-token').value.trim();if(!token){toast('Paste the bot token first.',true);return;}el.disabled=true;try{const r=await post('/phone',{token});toast('Bot @'+r.botName+' is connected. Now pair your phone.');await refresh();loadPhone(await post('/phone/pair',{}));}catch(e){toast(e.message,true);el.disabled=false;}},
  'phone-pair':async el=>{el.disabled=true;try{loadPhone(await post('/phone/pair',{}));}catch(e){toast(e.message,true);el.disabled=false;}},
  'phone-test':async el=>{el.disabled=true;try{const r=await post('/phone/test',{});toast(r.sent>1?'Test sent to '+r.sent+' phones.':'Test sent to your phone.');}catch(e){toast(e.message,true);}finally{el.disabled=false;}},
  'phone-unpair':async el=>{if(!confirm('Remove this phone? It can no longer talk to the silo.'))return;try{await api('/phone/chats/'+el.dataset.id,{method:'DELETE'});toast('Phone removed.');loadPhone();}catch(e){toast(e.message,true);}},
  'phone-remove':async()=>{if(!confirm('Remove the bot? Paired phones are forgotten and the token is deleted.'))return;try{await api('/phone',{method:'DELETE'});toast('Bot removed.');loadPhone();}catch(e){toast(e.message,true);}},
  'desktop-test':async el=>{el.disabled=true;try{await post('/desktop/test',{});toast('Look at the corner of your screen.');}catch(e){toast(e.message,true);}finally{el.disabled=false;}},
  'mail-test':async el=>{const form=el.closest('form'),g=n=>form.elements[n]?.value?.trim()||'';el.disabled=true;const out=form.querySelector('.mail-status');out.textContent='Checking...';try{await post('/mail/test',{workflowId:el.dataset.id||undefined,mail:{host:g('mailHost'),port:Number(g('mailPort'))||993,user:g('mailUser'),pass:form.elements.mailPass.value,folder:g('mailFolder')||'INBOX'}});out.textContent='The inbox opens. Only mail that arrives after you save starts a run.';}catch(e){out.textContent=e.message;}finally{el.disabled=false;}},
  'channel-test':async el=>{el.disabled=true;try{await post('/channels/'+el.dataset.id+'/test',{});toast('Test message delivered.');}catch(e){toast(e.message,true);}finally{await refresh();if(view==='connections')render();}},
  'channel-remove':async el=>{const c=state.channels.find(c=>c.id===el.dataset.id);if(!c||!confirm(`Remove the channel ${c.name}?`))return;try{await api('/channels/'+c.id,{method:'DELETE'});await refresh();render();toast('Channel removed.');}catch(e){toast(e.message,true);}},
  'sign-out':async()=>{clearAiSaved();try{await post('/logout',{});}catch{}location.reload();},
  'token-revoke':async el=>{const name=el.closest('.token-row')?.querySelector('strong')?.textContent||'this token';if(!confirm(`Revoke ${name}? Programs using it stop working at once.`))return;el.disabled=true;try{await api('/tokens/'+el.dataset.id,{method:'DELETE'});toast('Token revoked.');loadTokensCard();}catch(e){el.disabled=false;toast(e.message,true);}},
  'user-remove':async el=>{const u=(state.users||[]).find(u=>u.id===el.dataset.id);if(!u||!confirm(u.id===me?.id?'Remove your own account? You are signed out.':`Remove the account of ${u.name}?`))return;try{await api('/users/'+u.id,{method:'DELETE'});if(u.id===me?.id){location.reload();return;}await refresh();loadSystemInfo();toast('Account removed.');}catch(e){toast(e.message,true);}},
  'vault-reset':async()=>{if(!confirm('Delete the saved secrets that cannot be opened? You enter your keys again afterwards.'))return;try{await post('/vault/reset',{});await refresh();loadSystemInfo();toast('Saved secrets cleared.');}catch(e){toast(e.message,true);}},
  'save-search':async()=>{const engine=$('#se-engine').value,key=$('#se-key').value.trim();try{await post('/settings',{search:{engine,url:$('#se-url').value.trim(),...(key&&{key})}});await refresh();toast('Search engine saved.');loadSystemInfo();}catch(e){toast(e.message,true);}},
  'try-search':async el=>{el.disabled=true;$('#search-try').textContent='Searching...';try{const r=await post('/search-test',{query:'underground silo'});$('#search-try').textContent=r.results.length?r.results.slice(0,3).map((x,i)=>`${i+1}. ${x.title} / ${x.url}`).join('\n'):'No results.';}catch(e){$('#search-try').textContent=e.message;}finally{el.disabled=false;}},
  'save-voice':async()=>{try{await post('/settings',{voice:{stt:$('#vo-stt').value,sttModel:$('#vo-stt-model').value.trim(),language:$('#vo-lang').value.trim(),tts:$('#vo-tts').value,ttsModel:$('#vo-tts-model').value.trim(),ttsVoice:$('#vo-tts-voice').value.trim(),autoSpeak:$('#vo-auto').checked}});try{localStorage.setItem('silo-voice',$('#vo-device').value);}catch{}await refresh();toast('Voice saved.');loadSystemInfo();}catch(e){toast(e.message,true);}},
  'save-audit':async()=>{try{await post('/audit',{months:Number($('#au-months').value)});toast('Saved.');}catch(e){toast(e.message,true);}loadSystemInfo();},
  'audit-verify':async()=>{const el=$('#audit-verify');el.textContent='Checking...';try{const v=await api('/audit/verify');el.textContent=v.ok?`The chain is whole: ${v.records} record${v.records===1?'':'s'}${v.records>1?', '+v.first+' to '+v.last:''}.`:`The chain breaks in ${v.broken.file}, line ${v.broken.line}: ${v.broken.reason}`;el.classList.toggle('modal-error',!v.ok);}catch(e){el.textContent=e.message;}},
  'audit-export':el=>{const a=document.createElement('a');a.href='/api/audit/export?'+auditQuery({format:el.dataset.format});a.rel='noopener';a.download='';document.body.append(a);a.click();a.remove();},
  'save-otel':async()=>{try{await post('/otel',{enabled:$('#ot-enabled').checked,endpoint:$('#ot-endpoint').value.trim(),service:$('#ot-service').value.trim(),traces:$('#ot-traces').checked,logs:$('#ot-logs').checked,content:$('#ot-content').checked,headers:$('#ot-headers').value});toast('Saved.');}catch(e){toast(e.message,true);}loadSystemInfo();},
  'otel-test':async()=>{try{const r=await post('/otel/test',{});toast('The collector took the test span. Trace '+r.traceId.slice(0,8)+'...');}catch(e){toast(e.message,true);}},
  'otel-clear-headers':async()=>{try{await post('/otel',{clearHeaders:true});toast('Headers removed.');}catch(e){toast(e.message,true);}loadSystemInfo();},
  'save-sso':async()=>{try{const secret=$('#sso-secret').value;await post('/sso',{enabled:$('#sso-enabled').checked,issuer:$('#sso-issuer').value.trim(),label:$('#sso-label').value.trim(),clientId:$('#sso-client').value.trim(),...(secret&&{clientSecret:secret}),domains:listOf($('#sso-domains').value),defaultRole:$('#sso-default').value,claim:$('#sso-claim').value.trim(),scopes:$('#sso-scopes').value.trim(),groups:{owner:listOf($('#sso-g-owner').value),operator:listOf($('#sso-g-operator').value),viewer:listOf($('#sso-g-viewer').value)},passwords:$('#sso-passwords').value});toast('Saved.');}catch(e){toast(e.message,true);}loadSystemInfo();},
  'sso-test':async()=>{try{const r=await post('/sso/test',{issuer:$('#sso-issuer').value.trim()});toast(`The provider answers: ${r.issuer}, sign-in at ${r.authorize}.`);}catch(e){toast(e.message,true);}},
  'sso-unblock':async()=>{try{await post('/sso',{unblock:true});toast('Removed people can sign in again.');}catch(e){toast(e.message,true);}loadSystemInfo();},
  'save-update':async()=>{try{await post('/system/update',{feed:$('#up-feed').value.trim(),auto:$('#up-auto').checked});toast('Update settings saved.');}catch(e){toast(e.message,true);}loadSystemInfo();},
  'update-check':()=>updateAction('/system/update/check',r=>r.available?`SILO ${r.available.version} is available.`:'You have the newest version.'),
  'update-download':()=>updateAction('/system/update/download',()=>'Downloaded and checked.'),
  'update-install':()=>{if(!confirm('Install the update now?'))return;updateAction('/system/update/install',r=>r.restarting?`SILO ${r.to} is installed. SILO restarts now; this page comes back in a few seconds.`:`SILO ${r.to} is installed. Restart SILO to use it.`).then(waitForRestart);},
  'update-rollback':()=>{if(!confirm('Go back to the version before the last update?'))return;updateAction('/system/update/rollback',r=>r.restarting?`Going back to ${r.to}. SILO restarts now.`:`Went back to ${r.to}. Restart SILO to use it.`).then(waitForRestart);},
  'system-restart':()=>{if(!confirm('Restart SILO? Anything running stops.'))return;updateAction('/system/restart',()=>'SILO restarts now.').then(waitForRestart);},
  'try-voice':()=>{try{localStorage.setItem('silo-voice',$('#vo-device').value);}catch{}speakText(/^ro/i.test($('#vo-lang')?.value||'')?'Bună. Aici SILO 18. Așa sună răspunsurile.':'Hello. This is SILO 18. This is how answers will sound.');},
  'chat-mic':()=>toggleMic(),
  'speak-msg':el=>{const m=getAgent(el.dataset.id)?.chats[Number(el.dataset.i)];if(m)speakText(m.content);},
  'save-embeddings':async()=>{try{await post('/settings',{embeddings:{provider:$('#em-provider').value,model:$('#em-model').value.trim()}});await refresh();toast('Saved. The Archive is indexed again in the background.');loadSystemInfo();}catch(e){toast(e.message,true);}},
  rerun:el=>{const r=state.runs.find(r=>r.id===el.dataset.id);if(r)runWorkflow(state.workflows.find(w=>w.id===r.workflowId),r.input);},
  'copy-run':async el=>{const r=state.runs.find(r=>r.id===el.dataset.id),i=Number(el.dataset.step),text=i<0?r?.output:r?.steps[i]?.output;if(!text)return;try{await navigator.clipboard.writeText(text);toast('Copied.');}catch{toast('Copy is blocked by the browser. Select the text instead.',true);}},
  'add-shape-field':()=>{if($$('.shape-field').length>=30){toast('A result keeps at most 30 fields.',true);return;}$('#shape-fields').insertAdjacentHTML('beforeend',shapeFieldRow({}));$$('.shape-field .sf-name').at(-1).focus();},
  'remove-shape-field':el=>{if($$('.shape-field').length>1)el.closest('.shape-field').remove();else el.closest('.shape-field').querySelector('.sf-name').value='';},
  'add-step':()=>{if($$('.flow-step-editor').length>=12){toast('A workflow can contain up to 12 steps.',true);return;}$('#step-editors').insertAdjacentHTML('beforeend',stepEditor({type:'agent'},$$('.flow-step-editor').length));},'remove-step':el=>{el.closest('.flow-step-editor').remove();renumber();},'step-up':el=>{const s=el.closest('.flow-step-editor');if(s.previousElementSibling)s.parentNode.insertBefore(s,s.previousElementSibling);renumber();},'step-down':el=>{const s=el.closest('.flow-step-editor');if(s.nextElementSibling)s.parentNode.insertBefore(s.nextElementSibling,s);renumber();},
  'open-app':async el=>{await post('/apps/open',{app:el.dataset.app});toast('Opening app.');},'new-file':()=>{showFileInEditor('',{content:''});$('#file-name').focus();},'save-file':saveFile,'open-file':async el=>{try{const f=await api('/file?name='+encodeURIComponent(el.dataset.name));showFileInEditor(el.dataset.name,f);}catch(e){toast(e.message,true);}},'upload-file':()=>{const i=document.createElement('input');i.type='file';i.multiple=true;i.onchange=()=>uploadFiles([...i.files]);i.click();},'app-connect':el=>openAppConnect(el.dataset.id),'app-disconnect':async el=>{if(!confirm('Disconnect this app? Residents can no longer use it.'))return;try{await post('/services/'+el.dataset.id,{disconnect:true});toast('Disconnected.');loadApps();}catch(e){toast(e.message,true);}},
  export:async()=>{const data=await api('/export');const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='silo-workspace-'+new Date().toISOString().slice(0,10)+'.json';a.click();URL.revokeObjectURL(url);toast('Workspace exported without API keys.');}
};
function renumber(){$$('.flow-step-editor').forEach((el,i)=>{el.querySelector('.step-n').textContent=pad2(i+1);const t=el.querySelector('.step-target'),cur=Number(t.value)||i;t.innerHTML=targetOptions(i,Math.min(cur,i));const w=el.querySelector('.step-when-src'),wc=Number(w.value)||0;w.innerHTML=whenOptions(i,wc<=i?wc:0);});}
document.addEventListener('change',async e=>{
  if(e.target.id==='ai-lang'){aiPrefs.lang=e.target.value;saveAiPrefs();for(const n of aiNotes.values())n.abort?.abort();aiNotes.clear();checkAi();return;}
  if(e.target.id==='ai-auto'){aiPrefs.auto=e.target.checked;saveAiPrefs();toast(aiPrefs.auto?'New answers in another language are translated by themselves.':'Answers are translated only when you ask.');return;}
  const role=e.target.dataset?.userRole;
  if(role){try{await post('/users/'+role,{role:e.target.value});await refresh();toast('Role changed.');}catch(err){toast(err.message,true);await refresh();}loadSystemInfo();return;}
  if(e.target.id==='phone-enabled'||e.target.id==='phone-approvals'||e.target.classList?.contains('phone-event')){try{await savePhone();toast('Phone settings saved.');}catch(err){toast(err.message,true);}loadPhone();return;}
  if(e.target.id==='desktop-enabled'||e.target.classList?.contains('desktop-event')){try{await post('/settings',{desktop:{enabled:$('#desktop-enabled').checked,events:$$('.desktop-event:checked').map(x=>x.value)}});await refresh();toast('Notification settings saved.');}catch(err){toast(err.message,true);}return;}
  if(e.target.id==='sound-toggle'){try{localStorage.setItem('silo-sound',e.target.checked?'on':'off');}catch{}toast(e.target.checked?'The siren will sound.':'The siren stays quiet.');return;}
  if(e.target.id==='startup-toggle'){try{const st=await post('/system/startup',{enabled:e.target.checked});toast(st.enabled?'SILO starts when you sign in.':'SILO no longer starts when you sign in.');}catch(err){e.target.checked=!e.target.checked;toast(err.message,true);}loadSystemInfo();return;}
  if(e.target.id==='network-toggle'){try{await post('/settings',{network:e.target.checked});await refresh();toast(e.target.checked?'Network access is on after the next restart.':'Network access is off after the next restart.');}catch(err){e.target.checked=!e.target.checked;toast(err.message,true);}loadSystemInfo();}
});
document.addEventListener('submit',async e=>{
  if(e.target.id==='user-form'){e.preventDefault();const first=!(state.users||[]).length;try{const r=await post('/users',{name:$('#user-name').value,password:$('#user-pass').value,role:$('#user-role')?.value});if(first){me=r.me;accounts=true;toast('Owner account created. From now on SILO asks for a password.');}else toast('Account added.');await refresh();loadSystemInfo();}catch(err){toast(err.message,true);}return;}
  if(e.target.id==='password-form'){e.preventDefault();try{await post('/password',{old:$('#pw-old').value,password:$('#pw-new').value});toast('Password changed. Other sessions of this account were signed out.');e.target.reset();}catch(err){toast(err.message,true);}return;}
});
document.addEventListener('submit',e=>{if(e.target.id==='spending-form'){e.preventDefault();saveSpending(e.target).catch(err=>toast(err.message,true));}});
document.addEventListener('click',async e=>{const el=e.target.closest('[data-action]');if(!el||el.disabled)return;const action=actions[el.dataset.action];if(action)try{await action(el);}catch(e){toast(e.message,true);}});
document.addEventListener('keydown',e=>{const typing=e.target.matches?.('input,textarea,select,[contenteditable]');if(e.key==='Escape'&&!modal.open&&view!=='silo'&&!typing){e.preventDefault();navigate('silo');return;}if(e.key==='Escape'&&!modal.open&&view==='silo'&&residentOpen&&!typing){e.preventDefault();actions['close-resident']();return;}if(e.altKey&&!e.ctrlKey&&!e.metaKey&&/^Digit[1-8]$/.test(e.code)){e.preventDefault();navigate(navItems[Number(e.code.slice(5))-1][0]);return;}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();openSearch();}if((e.ctrlKey||e.metaKey)&&e.key==='Enter'&&modalKind==='chat'&&modal.open){e.preventDefault();$('#chat-form')?.requestSubmit();}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'&&view==='files'&&!modal.open){e.preventDefault();saveFile().catch(e=>toast(e.message,true));}if(e.key==='Enter'&&e.target.matches('.minimap span'))e.target.click();});
modal.addEventListener('click',e=>{if(e.target===modal){const r=modal.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)modal.close();}});
$('#search-trigger').onclick=openSearch;window.addEventListener('hashchange',()=>{const next=location.hash.slice(1);if(next!==view)navigate(next);});
$('#depth-range').addEventListener('input',e=>world?.focusLevel(Number(e.target.value)));
$('#level-jump').addEventListener('submit',e=>{e.preventDefault();const level=Number($('#jump-level').value);if(Number.isInteger(level)&&level>=1&&level<=144){if(view!=='silo')navigate('silo');world?.focusLevel(level);$('#jump-level').blur();}});
async function poll(){if(polling||!state||document.hidden||$('#login-screen'))return;polling=true;try{const prevRuns=JSON.stringify(state.runs),prevEvents=state.events[0]?.id;if(!await refresh(true)){syncStatus();return;}world?.update(state.agents,residentOpen?selected:null,state.paused);syncWorldSignals();if(view==='silo'&&residentOpen)$('#agent-panel').innerHTML=agentPanel();if(view==='workflows'&&prevRuns!==JSON.stringify(state.runs))$('#run-history').innerHTML=runHistory();if(trackId&&!getAgent(trackId)){trackId=null;if(feedWall)feedWall.track=null;}if(view==='security'){steerToWork();refreshSecurityInfo();}if(view==='files'&&$('#proposal-list')){const html=proposalList();if($('#proposal-list').dataset.html!==html){$('#proposal-list').innerHTML=html;$('#proposal-list').dataset.html=html;}}if(view==='activity'&&$('#request-list')){const html=requestList();if($('#request-list').dataset.html!==html){$('#request-list').innerHTML=html;$('#request-list').dataset.html=html;}}if(view==='activity'&&prevEvents!==state.events[0]?.id)$('#activity-list').innerHTML=state.events.map(eventRow).join('');if(modal.open&&modalKind==='trace'&&prevRuns!==JSON.stringify(state.runs)){const r=state.runs.find(r=>r.id===openRunId);if(r)updateTrace(r);}for(const r of state.runs)if(r.waiting&&!waitingSeen.has(r.id)){waitingSeen.add(r.id);if(!(modal.open&&modalKind==='trace'&&openRunId===r.id))toast(r.name+' is waiting for your approval. Open it in Flows.');}for(const id of waitingSeen)if(!state.runs.some(r=>r.id===id&&r.waiting))waitingSeen.delete(id);}catch(e){$('#server-state').textContent='UPLINK LOST';$('#bottom-status').textContent='LOCAL SERVER UNAVAILABLE / RESTART WITH NPM START';}finally{polling=false;if(streamFresh)stateArrived();}}
let ssoInfo=null;
// The Warden: the keeper of this silo, drawn pixel by pixel on the access terminal. Its eyes follow the name
// you type, close while you type the password, smile when the door opens and turn amber when it does not.
const WARDEN=['.......aa.......','.......ss.......','....hhhhhhhh....','..hhHHhhhhhhhh..','.hHhhhhhhhhhhhh.','bhvvvvvvvvvvvvhb','bhvvvvvvvvvvvvhb','bhvvvvvvvvvvvvhb','bhvvvvvvvvvvvvhb','.hhhhhhhhhhhhhh.','.hhhhgvgvgvhhhh.','..hhhhhhhhhhhh..','....cccccccc....','..cccccccccccc..'];
function wardenSvg(){
  const cls={a:'w-lamp',s:'w-dim',h:'w-head',H:'w-hi',v:'w-visor',b:'w-dim',g:'w-dim',c:'w-collar'};
  // One rectangle for each run of the same color in a row, so the drawing stays small.
  const body=WARDEN.map((row,y)=>row.replace(/(.)\1*/g,(run,ch,x)=>ch==='.'?'':`<rect class="${cls[ch]}" x="${x}" y="${y}" width="${run.length}" height="1"/>`)).join('');
  const px=list=>list.map(([x,y,w=1,h=1])=>`<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`).join('');
  return `<svg class="warden" viewBox="0 0 16 14" shape-rendering="crispEdges" aria-hidden="true">${body}<g class="w-eyes"><g class="e-open">${px([[4,6,2,2],[10,6,2,2]])}</g><g class="e-shut">${px([[4,7,2,1],[10,7,2,1]])}</g><g class="e-happy">${px([[4,7],[5,6],[6,7],[9,7],[10,6],[11,7]])}</g><g class="e-no">${px([[3,6],[5,6],[4,7],[3,8],[5,8],[10,6],[12,6],[11,7],[10,8],[12,8]])}</g></g></svg>`;
}
// The shaft of the silo, looking down: eight-sided floors with lit windows sink into a glowing haze, pipes run down
// the walls, a spiral stair winds around the hollow core and bridges cross to it. All in phosphor green, and it moves:
// the camera falls fast at first and slows to a drift, the view turns slowly, steam drifts, windows flicker. It leans
// away from the pointer, turns amber on an alarm and dives again on the way in.
function shaftScene(cv,still,onDepth){
  const g=cv.getContext('2d');
  let W=0,H=0,dpr=1,run=!still,last=0,clock=0,cam=0,v=still?0:36,target=.2,tint=0,mx=0,my=0,px=0,py=0;
  const D=1,SIDES=8,DEEP=34,TAU=Math.PI*2;
  const WALL=[9,28,15],SLAB=[3,12,7],HAZE=[62,140,70],HAZE_A=[150,105,34];
  const hash=(a,b)=>{let h=Math.imul(a,374761393)+Math.imul(b,668265263)|0;h=Math.imul(h^h>>>13,1274126177);return((h^h>>>16)>>>0)/4294967296;};
  const mix=(a,b,k)=>`rgb(${a.map((x,i)=>Math.round(x+(b[i]-x)*k))})`;
  const streaks=Array.from({length:70},()=>({a:Math.random()*TAU,z:Math.random()*30,r:.5+Math.random()*.45}));
  const poly=(cx,cy,r,rot)=>{for(let i=0;i<=SIDES;i++){const a=rot+i/SIDES*TAU,x=cx+Math.cos(a)*r,y=cy+Math.sin(a)*r;i?g.lineTo(x,y):g.moveTo(x,y);}};
  const ring=(cx,cy,r1,r2,rot,fill)=>{g.beginPath();poly(cx,cy,r2,rot);poly(cx,cy,r1,rot);g.fillStyle=fill;g.fill('evenodd');};
  function draw(dt){
    clock+=dt;cam+=v*dt;v+=(target-v)*(1-Math.exp(-dt*1.4));tint=Math.max(0,tint-dt);
    px+=(mx-px)*(1-Math.exp(-dt*2.5));py+=(my-py)*(1-Math.exp(-dt*2.5));
    onDepth?.(cam);
    const haze=tint>0?HAZE_A:HAZE,light=tint>0?'255,200,110':'205,255,190',warm='255,196,92';
    const cx=W/2-px*W*.05,cy=H/2-py*H*.05,f=Math.min(W,H)*.6,rot=Math.PI/8+clock*.025,fast=Math.min(1,v/10),diag=Math.hypot(W,H);
    g.globalCompositeOperation='source-over';
    // The deep: a haze that glows brighter toward the bottom of the shaft.
    const deep=g.createRadialGradient(cx,cy,0,cx,cy,diag*.6);
    deep.addColorStop(0,`rgb(${light})`);deep.addColorStop(.06,`rgb(${haze})`);deep.addColorStop(.35,mix(SLAB,haze,.45));deep.addColorStop(1,mix(SLAB,haze,.1));
    g.fillStyle=deep;g.fillRect(0,0,W,H);
    const n0=Math.floor(cam/D);
    for(let n=n0+DEEP;n>n0;n--){
      const dz=n*D-cam;if(dz<.42)continue;
      const fog=1-Math.exp(-dz*.085),near=1-fog,Ro=f/dz,Rn=f/(dz+D),Ri=Ro*.8,z1=dz+D;
      if(Rn>diag)continue;
      // A floor passing the camera fades out instead of filling the screen.
      g.globalAlpha=Math.max(0,Math.min(1,(dz-.42)/1.1));
      // The wall from this floor down to the next, with windows.
      ring(cx,cy,Rn,Ro,rot,mix(WALL,haze,fog));
      const band=Ro-Rn;
      if(band>2.5*dpr){
        // Two rows of five windows on each side, most of them lit, a few flickering.
        const s=Math.max(1,Math.min(band*.17,5*dpr));
        for(let i=0;i<SIDES;i++)for(let k=0;k<10;k++){
          const h=hash(n,i*10+k);if(h>.7)continue;
          const flick=h<.05?.45+.55*Math.abs(Math.sin(clock*7+n+k)):1,a=rot+(i+.5)/SIDES*TAU+(k%5-2)*.085,rr=Rn+band*(k<5?.33:.68);
          g.fillStyle=`rgba(${h<.16?warm:light},${(.2+.65*near)*flick})`;
          g.fillRect(cx+Math.cos(a)*rr-s*.6,cy+Math.sin(a)*rr-s/2,s*1.2,s);
        }
      }
      // Pipes running down the wall, each with a lamp where it passes a floor.
      for(let p=0;p<6;p++){
        const a=rot+p/6*TAU+.2,c=Math.cos(a),sn=Math.sin(a),w=Math.max(1,f*.022/dz);
        g.strokeStyle=mix([22,48,28],haze,fog);g.lineWidth=w;g.beginPath();g.moveTo(cx+c*Ro*.95,cy+sn*Ro*.95);g.lineTo(cx+c*Rn*.95,cy+sn*Rn*.95);g.stroke();
        g.strokeStyle=`rgba(${light},${.12+.25*near})`;g.lineWidth=Math.max(1,w*.25);g.stroke();
      }
      // The spiral stair around the core, one floor's turn at a time.
      const steps=8,ramp=[];
      for(let j=0;j<=steps;j++){const z=dz+D*j/steps,a=rot*1.6+(n*D+D*j/steps)*TAU/3;ramp.push([a,f/z]);}
      g.beginPath();ramp.forEach(([a,r],j)=>{const x=cx+Math.cos(a)*r*.26,y=cy+Math.sin(a)*r*.26;j?g.lineTo(x,y):g.moveTo(x,y);});
      for(let j=steps;j>=0;j--){const[a,r]=ramp[j];g.lineTo(cx+Math.cos(a)*r*.15,cy+Math.sin(a)*r*.15);}
      g.fillStyle=mix(SLAB,haze,fog*.9);g.fill();
      g.strokeStyle=`rgba(${light},${.1+.35*near})`;g.lineWidth=Math.max(1,dpr*Math.min(2,1/dz));
      g.beginPath();for(const[a,r]of ramp){g.moveTo(cx+Math.cos(a)*r*.15,cy+Math.sin(a)*r*.15);g.lineTo(cx+Math.cos(a)*r*.26,cy+Math.sin(a)*r*.26);}g.stroke();
      // The hollow core: a tube with the light coming up through it.
      ring(cx,cy,f/z1*.085,f/dz*.11,rot,mix(WALL,haze,fog*.8));
      // The floor itself, with light strips along its edge.
      ring(cx,cy,Ri,Ro,rot,mix(SLAB,haze,fog*.92));
      g.strokeStyle=`rgba(${light},${.15+.75*near})`;g.lineWidth=Math.max(1,dpr*1.4*Math.min(3,1.6/dz));g.beginPath();
      for(let i=0;i<SIDES;i++){if(hash(n,40+i)<.3)continue;const a0=rot+i/SIDES*TAU,a1=rot+(i+1)/SIDES*TAU,x0=cx+Math.cos(a0)*Ri,y0=cy+Math.sin(a0)*Ri,x1=cx+Math.cos(a1)*Ri,y1=cy+Math.sin(a1)*Ri;g.moveTo(x0+(x1-x0)*.22,y0+(y1-y0)*.22);g.lineTo(x0+(x1-x0)*.78,y0+(y1-y0)*.78);}
      g.stroke();
      // Lamps where the pipes pass the floor.
      for(let p=0;p<6;p++){const a=rot+p/6*TAU+.2,r=Math.max(1,f*.016/dz);g.fillStyle=`rgba(${warm},${.3+.6*near})`;g.beginPath();g.arc(cx+Math.cos(a)*Ro*.95,cy+Math.sin(a)*Ro*.95,r,0,TAU);g.fill();}
      // Now and then a bridge from the floor to the stair.
      if(n%5===2){
        const a=rot+hash(n,99)*TAU,c=Math.cos(a),sn=Math.sin(a),w=f*.045/dz,ox=-sn*w,oy=c*w,r1=Ri,r2=f/dz*.26;
        g.beginPath();g.moveTo(cx+c*r1+ox,cy+sn*r1+oy);g.lineTo(cx+c*r2+ox,cy+sn*r2+oy);g.lineTo(cx+c*r2-ox,cy+sn*r2-oy);g.lineTo(cx+c*r1-ox,cy+sn*r1-oy);g.closePath();
        g.fillStyle=mix(SLAB,haze,fog*.85);g.fill();g.strokeStyle=`rgba(${light},${.1+.3*near})`;g.lineWidth=Math.max(1,dpr);g.stroke();
      }
      if(n%4===0&&Ro<Math.min(W,H)*.9&&Ro>50*dpr){
        const fs=Math.max(8*dpr,Math.min(20*dpr,Ro*.05)),a=rot+.5;
        g.font=`${fs}px 'Lucida Console',Consolas,monospace`;g.fillStyle=`rgba(${light},${.2+.5*near})`;g.textBaseline='middle';
        g.fillText('LEVEL '+String(((Math.floor(n/4)%144)+144)%144+1).padStart(3,'0'),cx+Math.cos(a)*(Ri+Ro)/2,cy+Math.sin(a)*(Ri+Ro)/2);
      }
    }
    g.globalAlpha=1;
    g.globalCompositeOperation='lighter';
    // Steam drifting across the shaft, and the light coming up from below.
    for(let i=0;i<5;i++){const a=clock*.04*(i%2?1:-1)+i*1.3,r=f*(.25+i*.13),x=cx+Math.cos(a)*r,y=cy+Math.sin(a)*r*.8,s=f*(.35+i*.06),sm=g.createRadialGradient(x,y,0,x,y,s);sm.addColorStop(0,`rgba(${haze},.13)`);sm.addColorStop(1,'rgba(0,0,0,0)');g.fillStyle=sm;g.fillRect(x-s,y-s,s*2,s*2);}
    for(let i=0;i<7;i++){const a=rot*.7+i/7*TAU,sp=.035;g.fillStyle=`rgba(${light},.025)`;g.beginPath();g.moveTo(cx,cy);g.lineTo(cx+Math.cos(a-sp)*diag,cy+Math.sin(a-sp)*diag);g.lineTo(cx+Math.cos(a+sp)*diag,cy+Math.sin(a+sp)*diag);g.fill();}
    if(fast>.02){
      g.lineWidth=dpr*1.3;
      for(const s of streaks){
        s.z-=v*dt;if(s.z<.3)s.z+=30;
        const z2=s.z+Math.min(8,v*.06),r1=f*s.r/s.z,r2=f*s.r/z2,c=Math.cos(s.a),sn=Math.sin(s.a);
        g.strokeStyle=`rgba(${light},${.45*fast*Math.min(1,2/s.z)})`;g.beginPath();g.moveTo(cx+c*r1,cy+sn*r1);g.lineTo(cx+c*r2,cy+sn*r2);g.stroke();
      }
    }
    const core=g.createRadialGradient(cx,cy,0,cx,cy,f*.22);core.addColorStop(0,`rgba(${light},${.45+.4*fast})`);core.addColorStop(1,'rgba(0,0,0,0)');
    g.fillStyle=core;g.fillRect(cx-f*.22,cy-f*.22,f*.44,f*.44);
  }
  function size(){dpr=Math.min(1.5,devicePixelRatio||1);W=cv.width=Math.round(innerWidth*dpr);H=cv.height=Math.round(innerHeight*dpr);if(still)draw(0);}
  function loop(ms){
    if(!run)return;
    if(!cv.isConnected){stop();return;}
    requestAnimationFrame(loop);
    const dt=last?Math.min(.05,(ms-last)/1000):0;last=ms;draw(dt);
  }
  const point=e=>{mx=e.clientX/innerWidth-.5;my=e.clientY/innerHeight-.5;};
  function stop(){run=false;removeEventListener('resize',size);removeEventListener('pointermove',point);}
  addEventListener('resize',size);addEventListener('pointermove',point);size();
  if(!still)requestAnimationFrame(loop);
  return {arrive(){v=target;},alarm(){tint=1.2;},dive(){target=60;},stop};
}
let loginTimers=[];
const stopLoginTimers=()=>{loginTimers.forEach(t=>{clearInterval(t);clearTimeout(t);});loginTimers=[];};
function showLogin(){
  clearAiSaved();
  if($('#login-screen'))return;
  stopLoginTimers();
  const still=matchMedia('(prefers-reduced-motion: reduce)').matches;
  const local=/^(localhost|127\.|\[::1\]$)/.test(location.hostname),link=location.protocol==='https:'?['LINK ENCRYPTED','']:local?['LINK LOCAL','']:['LINK NOT ENCRYPTED',' warn'];
  // Back to front: the shaft, the terminal floating in it, the letterbox bars, the big words and the flash.
  document.body.insertAdjacentHTML('beforeend',`<div id="login-screen" class="login-screen cx${still?' cx-still':' cx-on'}">
    <canvas class="cx-shaft" aria-hidden="true"></canvas><div class="cx-alarm" aria-hidden="true"></div>
    <div class="cx-world"><form id="login-form" class="cx-term" autocomplete="on" novalidate>
    <div class="cx-glass" aria-hidden="true"></div>
    <div class="cx-head"><div class="cx-face" data-mood="${still?'open':'shut'}">${wardenSvg()}</div><div class="cx-name"><h1 class="cx-title"><span class="tl-hidden">Sign in to </span><span class="cx-decode" data-text="SILO 18">${still?'SILO 18':''}</span></h1><p class="cx-sub cx-decode" data-text="ACCESS TERMINAL / LEVEL 001" aria-hidden="true">${still?'ACCESS TERMINAL / LEVEL 001':''}</p></div></div>
    <p class="cx-say" aria-hidden="true"></p>
    ${ssoInfo?`<a class="cx-sso" href="/sso/start">SIGN IN WITH ${esc(ssoInfo.label).toUpperCase()}</a><p class="cx-note">${ssoInfo.passwords==='local'?'Names and passwords work only on the SILO computer.':'Or with a name and password:'}</p>`:''}
    <label class="cx-field" for="login-name"><span>NAME</span><input id="login-name" autocomplete="username" spellcheck="false" autocapitalize="off" required></label>
    <label class="cx-field" for="login-pass"><span>PASSWORD</span><input id="login-pass" type="password" autocomplete="current-password" required></label>
    <button class="cx-enter">ENTER THE SILO</button>
    <div class="cx-msg" id="login-error" role="alert"></div>
    </form></div>
    <div class="cx-bar top" aria-hidden="true"><span><i class="cx-dot"></i>SILO 18 <span class="cx-wide">/ SECURITY CHANNEL 01</span></span><span id="cx-depth">DEPTH 0000 M</span></div>
    <div class="cx-bar bottom" aria-hidden="true"><span class="cx-link${link[1]}">${link[0]}</span><span class="cx-wide">LEVEL 001 OF 144</span><span id="cx-clock"></span></div>
    <div class="cx-stamp" aria-hidden="true"></div><div class="cx-flash" aria-hidden="true"></div></div>`);
  const screen=$('#login-screen'),term=$('#login-form'),face=screen.querySelector('.cx-face'),sayEl=screen.querySelector('.cx-say'),stampEl=screen.querySelector('.cx-stamp'),alarm=screen.querySelector('.cx-alarm'),btn=term.querySelector('.cx-enter'),name=$('#login-name'),pass=$('#login-pass'),msg=$('#login-error');
  const wait=ms=>new Promise(ok=>setTimeout(ok,ms)),later=(fn,ms)=>loginTimers.push(setTimeout(fn,ms));
  const depthEl=$('#cx-depth');let shownDepth=-1;
  const shaft=shaftScene(screen.querySelector('.cx-shaft'),still,cam=>{const d=Math.round(cam*9);if(d!==shownDepth&&depthEl){shownDepth=d;depthEl.textContent='DEPTH '+String(d).padStart(4,'0')+' M';}});
  // The opening can be hurried: any key or click while it runs finishes it at once.
  let booting=!still,skip=still,awake=still,sayId=0;
  const pending=new Set();
  const pause=ms=>skip?Promise.resolve():new Promise(ok=>{const done=()=>{pending.delete(done);clearTimeout(t);ok();};const t=setTimeout(done,ms);loginTimers.push(t);pending.add(done);});
  const hurry=()=>{if(!booting||skip)return;skip=true;screen.classList.add('cx-skip');shaft.arrive();[...pending].forEach(f=>f());};
  // Words come in like a film title: each letter cycles through random signs before it settles.
  const SIGNS='ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&*+=/<>';
  const decode=(el,text,ms=900)=>new Promise(ok=>{
    if(skip||still){el.textContent=text;ok();return;}
    const t0=performance.now(),at=[...text].map((c,i)=>i/text.length*ms*.7+Math.random()*ms*.3);
    const t=setInterval(()=>{const k=performance.now()-t0;el.textContent=[...text].map((c,i)=>c===' '||k>=at[i]||skip?c:SIGNS[Math.random()*SIGNS.length|0]).join('');if(k>=ms||skip){clearInterval(t);el.textContent=text;ok();}},45);
    loginTimers.push(t);
  });
  const say=async text=>{const id=++sayId;for(let i=1;i<=text.length;i++){if(id!==sayId)return;if(skip){sayEl.textContent=text;return;}sayEl.textContent=text.slice(0,i);await pause(26);}};
  const mood=m=>{face.dataset.mood=m;};
  const look=()=>face.style.setProperty('--look',document.activeElement===name?String(Math.max(-1,Math.min(1,Math.round((name.value.length-6)/6)))):'0');
  const settle=()=>{if(!awake||['happy','no'].includes(face.dataset.mood))return;mood(document.activeElement===pass?'shut':'open');look();};
  const blinkOnce=()=>{if(face.dataset.mood!=='open')return;face.classList.add('blink');later(()=>face.classList.remove('blink'),140);};
  const stamp=(text,kind)=>{stampEl.className='cx-stamp '+kind;void stampEl.offsetWidth;stampEl.classList.add('show');decode(stampEl,text,600);};
  name.addEventListener('input',look);
  name.addEventListener('focus',settle);pass.addEventListener('focus',settle);
  name.addEventListener('blur',()=>setTimeout(settle));pass.addEventListener('blur',()=>setTimeout(settle));
  name.addEventListener('keydown',e=>{if(e.key==='Enter'&&!pass.value){e.preventDefault();if(name.value.trim())pass.focus();}});
  // The keyboard always goes to the prompt: a key or a click anywhere lands in the next field.
  const aim=()=>name.value.trim()&&!pass.value?pass:name;
  const keys=e=>{if(!screen.isConnected){document.removeEventListener('keydown',keys,true);return;}hurry();if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!e.target.closest?.('input,textarea,button,a'))aim().focus();};
  document.addEventListener('keydown',keys,true);screen.addEventListener('pointerdown',hurry);
  screen.addEventListener('click',e=>{if(!e.target.closest('input,button,a,label'))aim().focus();});
  // The terminal leans a little toward the pointer, like a screen hanging in the shaft.
  if(!still)screen.addEventListener('pointermove',e=>{term.style.setProperty('--ry',((e.clientX/innerWidth-.5)*7).toFixed(2)+'deg');term.style.setProperty('--rx',((.5-e.clientY/innerHeight)*5).toFixed(2)+'deg');});
  const clock=()=>{const c=$('#cx-clock');if(c){const d=new Date();c.textContent=d.toLocaleDateString('en-GB',{day:'2-digit',month:'short'}).toUpperCase()+'  '+d.toLocaleTimeString('en-GB');}};clock();
  loginTimers.push(setInterval(clock,1000));
  if(!still){const blink=()=>later(()=>{blinkOnce();blink();},2600+Math.random()*3200);blink();}
  // The opening: the camera falls down the shaft and slows, the terminal comes out of the dark, the title
  // resolves, the Warden wakes and speaks.
  const titleEl=screen.querySelector('.cx-title .cx-decode'),subEl=screen.querySelector('.cx-sub');
  (async()=>{
    await pause(2100);
    await decode(titleEl,'SILO 18',1000);
    decode(subEl,subEl.dataset.text,700);
    await pause(250);
    face.classList.add('lit');awake=true;settle();
    if(!skip){blinkOnce();later(blinkOnce,320);}
    await pause(350);
    await say('HALT. LEVELS 001 TO 144 ARE SEALED. STATE YOUR NAME AND PASSWORD.');
    booting=false;skip=still;
  })();
  name.focus();
  term.onsubmit=async e=>{
    e.preventDefault();hurry();
    if(!name.value.trim()){name.focus();return;}
    if(!pass.value){pass.focus();return;}
    btn.disabled=true;msg.textContent='';msg.classList.remove('ok');face.classList.remove('shake');
    let n=0;btn.textContent='CHECKING';const pulse=setInterval(()=>{btn.textContent='CHECKING'+'.'.repeat(n=n%3+1);},180);loginTimers.push(pulse);
    let r;
    try{const s=await api('/session',{},false);token=s.token;r=await post('/login',{name:name.value,password:pass.value});}
    catch(x){
      clearInterval(pulse);btn.textContent='ENTER THE SILO';btn.disabled=false;
      awake=true;mood('no');void face.offsetWidth;face.classList.add('shake');
      msg.textContent='ACCESS DENIED. '+x.message;pass.value='';pass.focus();
      // The alarm: the shaft turns amber, the picture tears, the words slam in.
      if(!still){shaft.alarm();stamp('ACCESS DENIED','no');alarm.classList.remove('on');term.classList.remove('glitch');void alarm.offsetWidth;alarm.classList.add('on');term.classList.add('glitch');later(()=>stampEl.classList.remove('show'),1500);}
      say('NO MATCH. TRY AGAIN.');
      later(()=>{face.classList.remove('shake');mood('open');settle();},1600);
      return;
    }
    clearInterval(pulse);btn.textContent='ACCESS GRANTED';
    token=r.token;me=r.me;mood('happy');
    const who=String(r.me?.name||name.value).toUpperCase();
    msg.classList.add('ok');msg.textContent=`ACCESS GRANTED. WELCOME, ${who}.`;
    say(`WELCOME BACK, ${who}.`);
    // On the way in: the words, then the camera dives down the shaft through the terminal, a flash, and the silo.
    if(!still){stamp('ACCESS GRANTED','ok');await wait(900);screen.classList.add('cx-through');shaft.dive();}
    try{await Promise.all([boot(),still?0:wait(1100)]);}
    finally{
      if(!still){screen.querySelector('.cx-flash').classList.add('go');await wait(260);screen.classList.add('cx-out');await wait(650);}
      shaft.stop();stopLoginTimers();screen.remove();
    }
  };
}
async function boot(){
  const session=await api('/session');token=session.token;me=session.me;accounts=session.accounts;ssoInfo=session.sso||null;
  if(accounts&&!me){showLogin();return;}
  setAiOwner(accounts?'user:'+me.id:'local');
  await refresh();if(!booted){selected=state.agents[0]?.id;view=navItems.some(([id])=>id===location.hash.slice(1))?location.hash.slice(1):'silo';}
  render();if(!booted){booted=true;setInterval(poll,2000);setInterval(updateClock,1000);}openStream();
}
try{await boot();}catch(e){$('#main').innerHTML=`<div class="empty"><h1>Cannot reach the server.</h1><p>${esc(e.message)}</p><p>Start it with npm start, then refresh the page.</p></div>`;}
