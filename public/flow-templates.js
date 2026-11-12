// Ready-made workflows. Each step names a sector and a role it prefers; the residents are picked from the silo when the template is used.
// Sectors: 0 upper levels, 1 IT, 2 the mids, 3 engineering, 4 supply and farms, 5 mechanical.
export const TEMPLATES=[
  {
    key:'research',name:'Research brief',description:'Two researchers dig in at the same time, an analyst checks the facts, a writer turns it into one page.',
    brief:'',
    steps:[
      {pick:[1,/research/i],prompt:'Research {{brief}}. List what is known, with sources where you have them, and what is still unclear.'},
      {pick:[1,/analyst|data/i],parallel:true,prompt:'Look at {{brief}} from the numbers side. What can be measured, what are the key figures, what would change the picture?'},
      {pick:[1,/audit|analyst/i],type:'review',target:1,rounds:2,prompt:'Every claim needs a source or has to be marked as an assumption. Nothing important from the brief may be missing.'},
      {pick:[2,/writer|editor/i],prompt:'Write a one page brief from the research below. Plain language, short sections, the open questions at the end.'}
    ]
  },
  {
    key:'code',name:'Code change with review',description:'Plan, build, review until it passes, then you approve before it is written up.',
    brief:'',
    steps:[
      {pick:[3,/lead|backend/i],prompt:'Plan the change for {{brief}}. Name the files, the steps and the risks. Keep it short.'},
      {pick:[3,/frontend|backend|build/i],prompt:'Write the code for this plan. Show complete files or clear diffs. {{previous}}'},
      {pick:[3,/review/i],type:'review',target:2,rounds:3,prompt:'Check the code for bugs, missing edge cases and anything that does not match the plan. Be strict.'},
      {type:'approval',prompt:'Read the code before it is written up as a change note.'},
      {pick:[3,/test|qa/i],prompt:'Write a short change note and a test checklist for this code: {{step 2}}'}
    ]
  },
  {
    key:'article',name:'Article',description:'Research and a story angle in parallel, an editor merges them, a review, then your OK.',
    brief:'',
    steps:[
      {pick:[1,/research/i],prompt:'Collect facts, numbers and quotes for an article about {{brief}}.'},
      {pick:[2,/story|creative|copy/i],parallel:true,prompt:'Find the story in {{brief}}: who it is about, what is at stake, a strong opening.'},
      {pick:[2,/editor|writer/i],prompt:'Write the article from the research and the story angle below. About 800 words.'},
      {pick:[2,/editor|translator|teacher/i],type:'review',target:3,rounds:2,prompt:'Is it clear, accurate and readable for someone outside the field? No filler.'},
      {type:'approval',prompt:'Read the article before it is marked as final.'}
    ]
  },
  {
    key:'triage',name:'Inbox triage',description:'Every text file dropped in the inbox folder is sorted. Urgent ones go to the council, the rest to the archive.',
    brief:'Sort this message.',watch:'inbox',
    steps:[
      {pick:[0,/clerk|coordinator|dispatch/i],prompt:'Read the file below. Start your answer with URGENT or ROUTINE on its own line, then one line on why.'},
      {pick:[0,/supervisor|orchestrator|security/i],when:{step:1,op:'contains',text:'URGENT'},prompt:'This needs action now. Write what has to happen, who should do it and by when.'},
      {pick:[5,/archive|records|memory/i],when:{step:1,op:'missing',text:'URGENT'},prompt:'File this away. Write a two line summary and three keywords for the archive.'}
    ]
  },
  {
    key:'daily',name:'Morning report',description:'Every weekday at 08:00 the notes file is read and turned into a short report.',
    brief:'Daily report.',mode:'daily',at:'08:00',days:[1,2,3,4,5],
    steps:[
      {pick:[4,/logistics|planner|operations/i],prompt:'Read {{file notes.md}} and list what changed, what is blocked and what is due today.'},
      {pick:[0,/scheduler|planner|clerk/i],prompt:'Turn this into a morning report of at most ten lines, most important first.'}
    ]
  },
  {
    key:'council',name:'Council session',description:'The chair asks the residents whose roles fit, several at once, and writes one answer from what they said. Give the chair the permission Ask other residents.',
    brief:'',
    steps:[
      {pick:[0,/orchestrator|coordinator|supervisor/i],prompt:'Hold a council on {{brief}}. Ask the residents whose roles fit best, several at the same time, then write one answer that weighs what each of them said and names who said what.'}
    ]
  },
  {
    key:'decision',name:'Decision memo',description:'Three sectors argue their side at the same time, the council weighs them, you decide.',
    brief:'',
    steps:[
      {pick:[3,/lead|engineer/i],prompt:'Argue the engineering view on {{brief}}: cost, risk, what it takes to build.'},
      {pick:[4,/planner|quartermaster|operations/i],parallel:true,prompt:'Argue the supply view on {{brief}}: stock, people, time.'},
      {pick:[2,/director|creative|teacher/i],parallel:true,prompt:'Argue the view of the people who live with it on {{brief}}: what changes for them.'},
      {pick:[0,/orchestrator|supervisor|liaison/i],prompt:'Weigh the three views below. Give the options, the trade offs and one recommendation.'},
      {type:'approval',prompt:'Make the call. Your note goes into the final memo.'},
      {pick:[0,/clerk|records/i],prompt:'Write the final decision memo from the recommendation and the operator note.'}
    ]
  },
  // Office work. "needs" names the permissions the resident has to have; "a|b" means either one.
  {
    key:'invoice',name:'Invoice to fields',description:'A clerk reads an invoice from the Archive and returns the supplier, the dates and the total as checked fields.',
    brief:'uploads/invoice.pdf',
    shape:{fields:[{name:'supplier',type:'text'},{name:'invoice number',type:'text'},{name:'date',type:'date'},{name:'due',type:'date',required:false},{name:'total',type:'number'},{name:'currency',type:'text'},{name:'paid',type:'boolean',required:false}]},
    steps:[
      {pick:[0,/clerk|records|account/i],needs:['read_files'],prompt:'Read the invoice file {{brief}} from the Archive. Take the supplier, the invoice number, the invoice date, the due date, the total with its currency, and whether it says it is paid. Do not guess: leave a field empty when the invoice does not say.'}
    ]
  },
  {
    key:'meeting',name:'Meeting notes to tasks',description:'Notes from a meeting become a list of tasks, each with an owner and a date when one was said.',
    brief:'',
    shape:{many:true,fields:[{name:'task',type:'text'},{name:'owner',type:'text'},{name:'due',type:'date',required:false}]},
    tests:[{name:'Every task keeps its owner',input:'Meeting on 3 May 2026. Ana orders the pump seals by 2026-05-10. Radu checks the generator logs.',checks:[{op:'contains',text:'Ana'},{op:'contains',text:'Radu'},{op:'judge',text:'Both tasks from the notes are there once, each with the person named in the notes as owner.'}]}],
    steps:[
      {pick:[2,/secretary|clerk|editor|writer/i],prompt:'Read these meeting notes and list every task that was agreed, who does it, and by when if a date was said.\n\n{{brief}}'}
    ]
  },
  {
    key:'inbox',name:'Mail digest',description:'Every weekday at 07:30 a clerk reads the mail of the last day in Gmail or Outlook and tells you what needs you today. Nothing is sent.',
    brief:'Mail of the last day.',mode:'daily',at:'07:30',days:[1,2,3,4,5],
    steps:[
      {pick:[0,/clerk|liaison|secretary|coordinator/i],needs:['google|microsoft'],prompt:'Search my mail from the last day. List what needs an answer from me today, what can wait, and anything with a deadline. One line each, most urgent first, with the sender. Do not send, answer or change anything.'}
    ]
  },
  {
    key:'issues',name:'GitHub issue triage',description:'The open issues of a repository from the last week, sorted by kind and urgency. Nothing is changed on GitHub.',
    brief:'owner/repository',
    shape:{many:true,fields:[{name:'issue',type:'number'},{name:'title',type:'text'},{name:'kind',type:'text'},{name:'urgency',type:'text'}]},
    steps:[
      {pick:[1,/developer|engineer|admin|analyst/i],needs:['github'],prompt:'List the open issues of the GitHub repository {{brief}} that were opened in the last 7 days. For each one give its number, its title, its kind (bug, question or idea) and its urgency (now, this week or later). Do not comment or change anything.'}
    ]
  },
  {
    key:'report',name:'Weekly report in Word',description:'Every Friday at 15:00 the notes of the week become a Word report with a table of the numbers. It waits in the Archive for your OK.',
    brief:'Weekly report.',mode:'daily',at:'15:00',days:[5],
    steps:[
      {pick:[4,/logistics|planner|operations|analyst/i],needs:['read_files'],prompt:'Read {{file notes.md}} and collect what was done this week, what is late, and every number worth reporting.'},
      {pick:[2,/writer|editor|clerk/i],needs:['write_files'],prompt:'Write the weekly report as a Word document named reports/weekly.docx with make_document: a heading per topic, short paragraphs, and a table of the numbers. Then say in two lines what is in it.'}
    ]
  },
  // App steps: the apps do the work, with no model, alone or around one resident.
  {
    key:'mail-sheet',name:'Mail into a sheet',description:'Every evening the mail of the day that matches a search goes into a Google Sheet, one row per email. No model, no tokens.',
    brief:'newer_than:1d',mode:'daily',at:'18:00',days:[1,2,3,4,5],
    steps:[
      {type:'action',app:'svc:google',op:'mail_search',fields:{query:'{{brief}}',limit:'25'}},
      {type:'action',app:'svc:google',op:'sheet_append',each:'{{step 1}}',fields:{sheet:'Paste the link of your Google Sheet here',range:'Sheet1',values:'{{item.date}}, {{item.from}}, {{item.subject}}'}}
    ]
  },
  {
    key:'issues-notion',name:'Issues into Notion',description:'The open issues of a repository become pages in a Notion database, one page per issue, with the link. No model, no tokens.',
    brief:'owner/repository',
    steps:[
      {type:'action',app:'svc:github',op:'issues',fields:{repo:'{{brief}}',state:'open'}},
      {type:'action',app:'svc:notion',op:'create_page',each:'{{step 1}}',fields:{database:'Paste the link of your Notion database here',title:'#{{item.number}} {{item.title}}',text:'{{item.url}}'}}
    ]
  },
  {
    key:'agenda',name:'Today in Slack',description:'Every weekday at 08:00 a clerk reads your calendar for the day and posts a short agenda to a Slack channel, after your OK.',
    brief:'My day.',mode:'daily',at:'08:00',days:[1,2,3,4,5],
    steps:[
      {type:'action',app:'svc:google',op:'calendar_list',fields:{days:'1'}},
      {pick:[0,/clerk|secretary|coordinator|liaison/i],prompt:'Write a short agenda for today from these events: {{step 1}}. One line per event with the time and the title, then one line on what to prepare. No greeting.'},
      {type:'approval',prompt:'Read the agenda before it goes to Slack.'},
      {type:'action',app:'svc:slack',op:'post',fields:{channel:'Paste the channel id here',text:'{{step 2}}'}}
    ]
  },
  {
    key:'checkin',name:'Ask, wait, sum up',description:'Posts a question to a Slack channel, waits two days for answers, then a resident sums them up in the same channel.',
    brief:'What slowed you down this week?',
    steps:[
      {type:'action',app:'svc:slack',op:'post',fields:{channel:'Paste the channel id here',text:'{{brief}} Answer in this channel, I will sum it up in two days.'}},
      {type:'wait',unit:'days',amount:2},
      {type:'action',app:'svc:slack',op:'read',fields:{channel:'Paste the channel id here',limit:'100'}},
      {pick:[2,/analyst|editor|writer/i],prompt:'These are the answers to "{{brief}}" in a Slack channel: {{step 3}}. Sum them up in five lines at most: what came up most, what only one person said, and one thing to do next.'},
      {type:'action',app:'svc:slack',op:'post',fields:{channel:'Paste the channel id here',text:'{{step 4}}'}}
    ]
  }
];

// Names for permissions, for "needs".
export const NEED_NAMES={read_files:'read files',write_files:'propose files',web:'web',browser:'a browser',run_code:'run code',delegate:'ask other residents',memory:'notes',desktop:'desktop apps',google:'Google',microsoft:'Microsoft 365',slack:'Slack',github:'GitHub',notion:'Notion'};
export const needName=n=>String(n).split('|').map(k=>NEED_NAMES[k]||k).join(' or ');
export const hasNeed=(agent,n)=>String(n).split('|').some(k=>(agent?.tools||[]).includes(k));
// A resident described by name, role and sector, in a procedure from a file: the same name first, then the role.
export function matchResident(r,agents,used=new Set()){
  const free=a=>!used.has(a.id),name=String(r?.name||'').toLowerCase(),words=String(r?.role||'').toLowerCase().split(/[^\p{L}]+/u).filter(w=>w.length>2);
  const byRole=list=>words.map(w=>list.find(a=>free(a)&&a.role.toLowerCase().includes(w))).find(Boolean);
  const floor=agents.filter(a=>a.floor===r?.floor);
  return agents.find(a=>free(a)&&a.name.toLowerCase()===name)||byRole(floor)||byRole(agents)||floor.find(free)||agents.find(free)||agents[0]||null;
}
// Fills a template with real residents: the first one in the sector whose role matches, else anyone in the sector.
// Procedures from a file name a resident instead, matched by matchResident.
export function materialize(t,agents){
  const used=new Set();
  const pick=([sector,role])=>{
    const pool=agents.filter(a=>a.floor===sector).sort((a,b)=>(a.level||0)-(b.level||0));
    // Earlier words in the pattern win: /lead|engineer/ takes a lead engineer before any other engineer.
    const a=role.source.split('|').map(w=>new RegExp(w,'i')).reduce((found,re)=>found||pool.find(a=>re.test(a.role)&&!used.has(a.id)),null)||pool.find(a=>!used.has(a.id))||pool[0]||agents[0];
    if(a)used.add(a.id);return a?.id;
  };
  return {
    name:t.name,description:t.description,brief:t.brief||'',enabled:!!t.mode,interval:60,mode:t.mode||'interval',at:t.at||'09:00',days:t.days||[1,2,3,4,5],
    watch:t.watch||null,hook:null,budget:t.budget||0,
    ...(t.shared&&{enabled:false,watch:null,mode:t.start?.mode||'interval',interval:t.start?.interval||60,at:t.start?.at||'09:00',days:t.start?.days||[1,2,3,4,5]}),
    ...(t.shape&&{shape:t.shape}),
    ...(t.tests?.length&&{tests:t.tests}),
    ...(t.judge&&{judgeId:matchResident(t.judge,agents)?.id}),
    steps:t.steps.map(s=>{const {pick:p,resident:r,needs,...rest}=s;const a=r&&s.type!=='approval'?matchResident(r,agents,used):null;if(a)used.add(a.id);return {type:'agent',...rest,...(p&&{agentId:pick(p)}),...(a&&{agentId:a.id})};})
  };
}
