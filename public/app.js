/* Maverick — Aureo SPA. Vanilla JS, no build step. Mobile-first, responsive desktop.
   Renders the design faithfully; pulls real data where connected, demo data otherwise. */
'use strict';

const ACCENT = '#e6a92c';   // brand gold — default when a space has no color / for the "All" filter

const ICONS = {
  home:'<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" stroke-linejoin="round"/>',
  calendar:'<rect x="3.5" y="5" width="17" height="16" rx="2.5"/><line x1="3.5" y1="9.5" x2="20.5" y2="9.5"/><line x1="8" y1="3" x2="8" y2="6"/><line x1="16" y1="3" x2="16" y2="6"/>',
  tasks:'<polyline points="4,12 7,15 12,8" stroke-linecap="round" stroke-linejoin="round"/><line x1="14" y1="7" x2="20" y2="7"/><line x1="14" y1="13" x2="20" y2="13"/><line x1="4" y1="19" x2="20" y2="19"/>',
  spaces:'<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  mic:'<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0" stroke-linecap="round"/><line x1="12" y1="17" x2="12" y2="21"/>',
  // conversation mode: a waveform, distinct from the push-to-talk mic at a glance
  wave:'<line x1="3" y1="12" x2="3" y2="12" stroke-linecap="round"/><line x1="7" y1="8" x2="7" y2="16" stroke-linecap="round"/><line x1="11" y1="4" x2="11" y2="20" stroke-linecap="round"/><line x1="15" y1="8" x2="15" y2="16" stroke-linecap="round"/><line x1="19" y1="10" x2="19" y2="14" stroke-linecap="round"/>',
};
const svg = (name, color, w=22) => `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.8">${ICONS[name]}</svg>`;
const esc = s => String(s==null?'':s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// Minimal, safe Markdown -> HTML (escape first, then a small subset). Used for assistant messages.
function md(s){
  let h = esc(s);
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  h = h.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  h = h.replace(/^\s*#{1,6}\s*(.+)$/gm, '<div class="mdh">$1</div>');
  const lines = h.split('\n'); let out = '', ul = false, ol = false;
  const close = () => { if(ul){out+='</ul>';ul=false;} if(ol){out+='</ol>';ol=false;} };
  for (const ln of lines) {
    let m;
    if ((m = ln.match(/^\s*[-*]\s+(.+)$/))) { if(!ul){close();out+='<ul>';ul=true;} out+='<li>'+m[1]+'</li>'; }
    else if ((m = ln.match(/^\s*\d+\.\s+(.+)$/))) { if(!ol){close();out+='<ol>';ol=true;} out+='<li>'+m[1]+'</li>'; }
    else if (/^<div class="mdh">/.test(ln)) { close(); out += ln; }
    else { close(); out += ln.trim() === '' ? '<br>' : ln + '<br>'; }
  }
  close();
  return out;
}

const NAV = [['home','Home'],['calendar','Calendar'],['tasks','Tasks'],['spaces','Spaces']];

// Demo fallbacks — shown until a real data source is connected; tagged "demo" in the UI.
// Generated against the user's own spaces so the sample content matches their contexts.
function demoSpaces(){ return S.spaces.length ? S.spaces : [{key:'personal',label:'Personal'}]; }
function demoTasks(){
  const sp = demoSpaces();
  const rows = [
    ['Review this week’s priorities','Due today'],
    ['Reply to two pending messages','Due by 3:00 PM'],
    ['Plan tomorrow’s schedule','Tomorrow'],
    ['Tidy up notes & follow-ups','This week'],
  ];
  return rows.map((r,i)=>({id:'demo'+i,title:r[0],role:sp[i%sp.length].key,due:r[1],done:false,
                           source:null,synced:true,overdue:false}));
}
function demoEvents(){
  const sp = demoSpaces();
  const rows = [
    ['9:00','Focus block','Deep work'],
    ['12:30','Lunch & reset',''],
    ['2:00','Afternoon check-in','Quick sync'],
    ['5:30','Wrap up the day',''],
  ];
  return rows.map((r,i)=>({time:r[0],title:r[1],sub:(r[2]?r[2]+' · ':'')+sp[i%sp.length].label,role:sp[i%sp.length].key}));
}

const S = {
  cfg:null, tab:'home', role:'All', detail:null, whyOpen:false,
  thinking:false, chatInput:'',
  messages:[], pending:[], spaces:[],
  events:null, eventsConnected:false, tasks:null, tasksConnected:false,
  drawer:false, conv:'web',
  // tasks (unified charliework + goosework mirror)
  taskSource:'All', taskCounts:null, taskSources:[], tasksUnsynced:0,
  // voice
  convMode:false, dictating:false, voiceState:'idle', voiceError:'', streaming:'', tool:null,
};

const api = async (path, opts) => {
  const r = await fetch('/api'+path, Object.assign({headers:{'Content-Type':'application/json'}}, opts));
  if (r.status === 401) { location.href='/login'; throw new Error('unauth'); }
  return r.json();
};

/* ---------- helpers (spaces are user-defined, loaded from /api/spaces) ---------- */
const spaceMap = () => S.spaces.reduce((m,s)=>(m[s.key]=s,m),{});
const rc = r => r==='All' ? ACCENT : ((spaceMap()[r]||{}).color || ACCENT);
const roleOrder = () => ['All', ...S.spaces.map(s=>s.key)];
const roleLabel = k => k==='All' ? 'All' : ((spaceMap()[k]||{}).label || k);
const inRole = r => S.role==='All' || r===S.role;
const greeting = () => { const h=new Date().getHours(); return h<12?'Good morning':h<18?'Good afternoon':'Good evening'; };
const todayStr = () => new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
const initials = () => (S.cfg && S.cfg.user.initials) || 'M';
const brand = () => (S.cfg && S.cfg.brand) || 'Maverick';

/* ---------- data loads ---------- */
async function loadConfig(){ S.cfg = await api('/config'); }
async function loadSpaces(){ try { S.spaces = await api('/spaces'); } catch(_){ S.spaces=[]; } }
async function loadEvents(){
  try {
    const d = await api('/calendar');
    S.eventsConnected = !!d.connected;
    S.events = d.connected ? (d.events||[]).filter(e=>!e.error).map(e=>({time:e.time||'all day',title:e.title,sub:(e.location||e.account||''),role:S.role==='All'?'Personal':S.role})) : null;
  } catch(_){ S.eventsConnected=false; S.events=null; }
}
// Tasks come from the unified mirror (charliework + goosework), already merged and sorted
// by urgency server-side. Each row carries its source and its sync state; neither is hidden.
async function loadTasks(){
  try {
    const d = await api('/tasks?limit=200');
    S.tasksConnected = !!d.connected;
    S.taskCounts = d.counts||null;
    S.taskSources = d.sources||[];
    S.tasksUnsynced = d.unsynced||0;
    const fallbackRole = () => (S.spaces[0] && S.spaces[0].key) || 'personal';
    S.tasks = d.connected ? (d.tasks||[]).map(t=>({
      id:t.id, title:t.title, source:t.source,
      role:t.space || fallbackRole(),
      due:t.due_date||'', done:t.status==='done',
      overdue:!!t.is_overdue, dueSoon:!!t.is_due_soon,
      notes:t.notes||'', synced:t.synced!==false, pushError:t.push_error||null,
    })) : null;
  } catch(_){ S.tasksConnected=false; S.tasks=null; }
}

const SOURCE_LABEL = { charliework:'Work', goosework:'Personal' };
const events = () => S.events || demoEvents();
const tasks = () => S.tasks || demoTasks();
const isDemoTasks = () => !S.tasksConnected;
const isDemoEvents = () => !S.eventsConnected;

/* ---------- chat ----------
   Streams over SSE and appends tokens straight into the live bubble. Deliberately does NOT
   call render() per token: render() reassigns innerHTML on four containers, which would
   destroy the composer, reset the scroll and replay the fade animation on every message,
   sixty times a second. Targeted DOM mutation is the only way streaming is usable. */

function liveBubble(){
  let el = document.getElementById('liveBubble');
  if (el) return el;
  const scroll = document.getElementById('chatScroll');
  if (!scroll) return null;
  const wrap = document.createElement('div');
  wrap.className = 'msg ai';
  wrap.innerHTML = '<div class="bubble" id="liveBubble"></div>';
  const typing = scroll.querySelector('.typing');
  scroll.insertBefore(wrap, typing || null);
  return document.getElementById('liveBubble');
}

function appendUserBubble(text){
  const scroll = document.getElementById('chatScroll');
  if (!scroll) return;
  const wrap = document.createElement('div');
  wrap.className = 'msg user';
  wrap.innerHTML = `<div class="bubble">${esc(text)}</div>`;
  scroll.appendChild(wrap);
  scrollChat();
}

async function send(text){
  text = (text||S.chatInput||'').trim(); if(!text) return;
  S.messages.push({from:'user',text}); S.chatInput='';
  const wasChat = S.tab==='chat' && !S.detail;
  S.tab='chat'; S.detail=null; S.thinking=true; S.streaming='';
  if (wasChat) { appendUserBubble(text); const i=document.getElementById('chatInput'); if(i) i.value=''; }
  else render();

  try {
    const r = await fetch('/api/chat',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({conversation_id:S.conv,message:text}),
    });
    if (r.status===401) { location.href='/login'; return; }
    if (!r.ok || !r.body) throw new Error('http '+r.status);

    const reader=r.body.getReader(), dec=new TextDecoder();
    let buf='', done=null;
    for(;;){
      const {done:fin, value}=await reader.read();
      if(fin) break;
      buf+=dec.decode(value,{stream:true});
      let i;
      while((i=buf.indexOf('\n\n'))>=0){
        const frame=buf.slice(0,i).trim(); buf=buf.slice(i+2);
        if(!frame.startsWith('data:')) continue;
        let ev; try{ ev=JSON.parse(frame.slice(5).trim()); }catch(_){ continue; }

        if(ev.type==='token'){
          S.thinking=false; S.streaming+=ev.text;
          const b=liveBubble(); if(b){ b.innerHTML=md(S.streaming); scrollChat(); }
          const t=document.querySelector('#chatScroll .typing'); if(t) t.remove();
        } else if(ev.type==='tool_start'){
          S.tool=ev.tool; setToolHint(toolLabel(ev.tool));
        } else if(ev.type==='tool_end'){
          S.tool=null; setToolHint('');
        } else if(ev.type==='done'){
          done=ev;
        } else if(ev.type==='error'){
          throw new Error(ev.message||ev.error);
        }
      }
    }
    const reply=(done&&done.reply)||S.streaming||'(no reply)';
    S.messages.push({from:'ai',text:reply});
    S.pending=(done&&done.pending)||[];
  } catch(e){
    S.messages.push({from:'ai',text:'Could not reach the assistant. '+(e.message||'')});
  }
  S.thinking=false; S.streaming=''; S.tool=null;
  render(); scrollChat();
}

const TOOL_LABELS={
  list_calendar_events:'checking your calendar', list_calendars:'checking your calendars',
  list_tasks:'reading your tasks', add_task:'adding the task', complete_task:'marking it done',
  reschedule_task:'moving the due date', ask_supervisor:'filing the question',
  get_timesheet:'reading your timesheet', propose_timesheet_change:'preparing the change',
  draft_email:'drafting the email', save_memory:'saving that', list_memories:'looking through your notes',
  schedule_reminder:'setting the reminder', list_reminders:'checking your reminders',
  list_drive_files:'searching Drive', read_doc:'reading the doc', read_sheet:'reading the sheet',
  read_slides:'reading the deck', list_bookmarks:'checking bookmarks',
  container_status:'checking the server', search_youtube:'searching YouTube',
};
const toolLabel = n => TOOL_LABELS[n] || ('running '+String(n||'').replace(/_/g,' '));

function setToolHint(text){
  const el=document.getElementById('toolHint');
  if(el){ el.textContent=text; el.style.display=text?'':'none'; }
}
/* ---------- spaces management ---------- */
async function addSpace(){
  const label = (prompt('Name this space (e.g. Work, Family, Side project):')||'').trim();
  if(!label) return;
  try { await api('/spaces',{method:'POST',body:JSON.stringify({label})}); } catch(_){}
  await loadSpaces(); render();
}
async function editSpace(key){
  const cur = S.spaces.find(s=>s.key===key); if(!cur) return;
  const label = prompt('Rename space:', cur.label);
  if(label===null) return;
  try { await api('/spaces/'+encodeURIComponent(key),{method:'PATCH',body:JSON.stringify({label:(label||'').trim()||cur.label})}); } catch(_){}
  await loadSpaces(); render();
}
async function delSpace(key){
  const cur = S.spaces.find(s=>s.key===key);
  if(!confirm('Delete the "'+(cur?cur.label:key)+'" space?\nItems tagged to it keep their tag but stop being counted.')) return;
  try { await api('/spaces/'+encodeURIComponent(key),{method:'DELETE'}); } catch(_){}
  if(S.role===key) S.role='All';
  await loadSpaces(); render();
}

async function confirmPending(id){ await api('/timesheet/confirm',{method:'POST',body:JSON.stringify({id})}); S.pending=S.pending.filter(p=>p.id!==id); S.messages.push({from:'ai',text:'Done — applied and logged.'}); render(); }
async function cancelPending(id){ await api('/timesheet/cancel',{method:'POST',body:JSON.stringify({id})}); S.pending=S.pending.filter(p=>p.id!==id); render(); }

/* ---------- voice ----------
   Replaces the Web Speech API, which was Chrome/Safari only, single-shot, had no VAD, and
   shipped your audio to Google. Both modes now go through self-hosted Whisper.

   Dictation    hold-to-talk. Transcript lands in the composer. Never answers.
   Conversation continuous hands-free, with TTS and barge-in. See public/voice.js. */

let voice=null;

function ensureVoice(){
  if(voice) return voice;
  voice = new VoiceLoop({
    onState: s => {
      S.voiceState = s;
      if(s.startsWith('working:')) setToolHint(toolLabel(s.slice(8)));
      updateVoiceChrome();
    },
    onTranscript: t => {
      if(voice.mode==='conversation'){
        S.messages.push({from:'user',text:t});
        appendUserBubble(t);
        S.streaming=''; S.thinking=true;
      } else {
        S.chatInput=t;
        const i=document.getElementById('chatInput'); if(i){ i.value=t; i.focus(); }
      }
    },
    onToken: tok => {
      S.thinking=false; S.streaming+=tok;
      const b=liveBubble(); if(b){ b.innerHTML=md(S.streaming); scrollChat(); }
      const t=document.querySelector('#chatScroll .typing'); if(t) t.remove();
    },
    onReply: (reply, ev) => {
      S.messages.push({from:'ai',text:reply});
      S.pending=(ev&&ev.pending)||S.pending;
      S.streaming=''; S.thinking=false; S.tool=null; setToolHint('');
      render(); scrollChat();
    },
    onError: msg => { S.voiceError=msg; updateVoiceChrome(); setTimeout(()=>{ S.voiceError=''; updateVoiceChrome(); },4000); },
  });
  return voice;
}

// Hold to dictate. Pointer events so it works with touch and mouse alike.
async function dictateStart(){
  if(S.convMode) return;                       // conversation mode owns the mic
  const v=ensureVoice();
  S.dictating=true; updateVoiceChrome();
  await v.startDictation();
}
async function dictateStop(){
  if(!S.dictating) return;
  S.dictating=false;
  const v=ensureVoice();
  await v.stopDictation();
  updateVoiceChrome();
}

async function toggleConversation(){
  const v=ensureVoice();
  if(S.convMode){ v.stop(); S.convMode=false; S.voiceState='idle'; updateVoiceChrome(); return; }
  S.tab='chat'; S.detail=null; render();
  const ok=await v.startConversation(S.conv);
  S.convMode=!!ok; updateVoiceChrome();
}

const VOICE_COPY={
  listening:'Listening', transcribing:'Got it…', thinking:'Thinking',
  speaking:'Speaking', dictating:'Dictating', idle:'',
};

// Targeted update, not a full render: the mic button must not be rebuilt while it is being
// held down, or the pointerup never lands on the same element.
function updateVoiceChrome(){
  const badge=document.getElementById('voiceBadge');
  const btn=document.getElementById('convBtn');
  const mic=document.getElementById('micBtn');
  const st=S.voiceState||'idle';
  const label=S.voiceError || (st.startsWith('working:') ? toolLabel(st.slice(8)) : VOICE_COPY[st]||'');
  if(badge){
    badge.textContent=label;
    badge.className='voice-badge'+(S.voiceError?' err':'')+(st==='listening'?' live':'');
    badge.style.display=(S.convMode||label)?'':'none';
  }
  if(btn) btn.className='conv-btn'+(S.convMode?' on':'');
  if(mic) mic.className='mic'+(S.dictating?' live':'');
}

/* ---------- render ---------- */
function chips(){
  return `<div class="chips">${roleOrder().map(k=>{
    const active=S.role===k;
    return `<button class="chip${active?' active':''}" style="${active?`background:${rc(k)}`:''}" data-role="${esc(k)}">${esc(roleLabel(k))}</button>`;
  }).join('')}</div>`;
}

function homeView(){
  const ev = events().filter(e=>inRole(e.role));
  const next = ev[0];
  const due = tasks().filter(t=>!t.done && inRole(t.role)).length;
  const leadTitle = next ? `${next.title}` : 'Nothing urgent right now';
  const leadSub = next ? `${next.time} · ${next.sub}` : 'Your day is clear. Ask me to plan something.';
  return `
  ${headerHTML()}
  <div class="lead">
    <div class="now"><span class="dot"></span><span class="t">Right now${S.role!=='All'?' · '+esc(roleLabel(S.role)):''}</span></div>
    <h2>${esc(leadTitle)}</h2>
    <p>${esc(leadSub)}</p>
    ${S.whyOpen?`<div class="why">
      <div class="row"><b>◆</b><span>Surfaced from your calendar and open tasks for this space.</span></div>
      <div class="row"><b>◆</b><span>${due} task${due===1?'':'s'} due — I can reprioritize on request.</span></div>
    </div>`:''}
    <div class="actions">
      <button class="btn" data-act="chat-plan">Start prep</button>
      <button class="btn ghost" data-act="why">${S.whyOpen?'Hide reasoning':'Why this?'}</button>
    </div>
  </div>
  ${chips()}
  <div class="grid">
    <div class="card span2" data-go="calendar" style="display:flex;justify-content:space-between;align-items:center">
      <div><div class="k">Next up${next?' · '+esc(next.time):''}</div>
        <div style="font-size:15.5px;color:var(--ink);font-weight:600">${esc(next?next.title:'No events')}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:2px">${esc(next?next.sub:'')}${isDemoEvents()?'<span class="demo-tag">demo</span>':''}</div></div>
      <span style="width:30px;height:30px;border-radius:50%;border:1px solid rgba(207,159,90,.4);color:#cf9f5a;display:flex;align-items:center;justify-content:center">→</span>
    </div>
    <div class="card" data-go="tasks"><div class="k">Tasks</div>
      <div style="display:flex;align-items:baseline;gap:6px"><span class="bignum">${due}</span><span style="font-size:12px;color:var(--muted)">due${isDemoTasks()?' · demo':''}</span></div></div>
    <div class="card" data-detail="notifications"><div class="k">Notifications</div>
      <div style="display:flex;align-items:baseline;gap:6px"><span class="bignum" style="color:var(--ink)">${S.pending.length}</span><span style="font-size:12px;color:#cf9f5a">${S.pending.length?'need you':'all clear'}</span></div></div>
    <div class="card" data-detail="sleep"><div class="k">Sleep <span class="demo-tag">demo</span></div>
      <div class="mono" style="font-size:18px;color:var(--ink)">7h 12m</div><div style="font-size:11.5px;color:var(--sage);margin-top:3px">+24m vs avg</div></div>
    <div class="card" data-detail="nutrition"><div class="k">Nutrition <span class="demo-tag">demo</span></div>
      <div class="mono" style="font-size:14px;color:var(--ink)">1,240<span style="color:var(--faint);font-size:11px"> / 2,100</span></div>
      <div class="bar"><span style="width:59%"></span></div></div>
    <div class="card" data-detail="finance"><div class="k">Finance · week <span class="demo-tag">demo</span></div>
      <div class="mono" style="font-size:18px;color:var(--sage)">$214</div><div style="font-size:11.5px;color:var(--muted);margin-top:3px">left to spend</div></div>
    <div class="card span2" data-go="spaces" style="background:linear-gradient(120deg,rgba(156,169,128,.12),rgba(255,255,255,.03));border-color:rgba(156,169,128,.22);display:flex;justify-content:space-between;align-items:center">
      <div><div class="k" style="color:var(--sage)">Spaces</div><div style="font-size:15.5px;color:var(--ink);font-weight:600">${S.spaces.length} context${S.spaces.length===1?'':'s'} · scope your day</div></div>
      <span class="mono" style="font-size:24px;color:var(--sage)">${S.spaces.length}</span></div>
  </div>`;
}

function headerHTML(){
  return `<div class="head">
    <div><div class="date">${esc(todayStr())}</div><div class="greet">${greeting()}${S.cfg&&S.cfg.user.name?', '+esc(S.cfg.user.name.split(' ')[0]):''}</div></div>
    <div class="right"><div><div class="temp">72°</div><div class="cond">Sunny</div></div>
      <button class="avatar" data-act="settings">${esc(initials())}</button></div>
  </div>`;
}

function calendarView(){
  const ev = events().filter(e=>inRole(e.role));
  return `<div class="dhead" style="justify-content:space-between"><div><div class="sub">Today</div><div class="ttl">${esc(todayStr())}</div></div>
    <div style="font-size:12px;color:var(--muted)">${S.role==='All'?'All spaces':esc(roleLabel(S.role))+' space'}${isDemoEvents()?' · demo':''}</div></div>
    ${!S.eventsConnected?`<div class="pending" style="margin-bottom:14px"><div class="s">Connect a Google account to see your real calendar.</div><div class="a"><a class="btn" href="/connect/google?account=personal">Connect Google</a></div></div>`:''}
    <div class="agenda">${ev.map(e=>`<div class="ev"><div class="time">${esc(e.time)}</div>
      <div class="body" style="border-left-color:${rc(e.role)}"><div class="t">${esc(e.title)}</div><div class="s">${esc(e.sub)}</div></div></div>`).join('')||'<div style="color:var(--muted);padding:20px">No events.</div>'}</div>`;
}

function tasksView(){
  const all = tasks();
  const ts = all.filter(t=>inRole(t.role)).filter(t=>S.taskSource==='All'||!S.taskSource||t.source===S.taskSource);
  const c = S.taskCounts;
  const srcChips = S.tasksConnected ? `<div class="chips">${
    [['All','All'],['charliework','Work'],['goosework','Personal']].map(([k,l])=>{
      const active=(S.taskSource||'All')===k;
      const n = k==='All' ? (c?c.open:all.length) : (c&&c.by_source?c.by_source[k]||0:0);
      return `<button class="chip${active?' active':''}" style="${active?`background:${ACCENT}`:''}" data-tsrc="${k}">${l}${S.tasksConnected?` · ${n}`:''}</button>`;
    }).join('')}</div>` : '';

  return `<div class="dhead"><div><div class="sub">${
      c ? `${c.open} open${c.overdue?` · ${c.overdue} overdue`:''}` : (isDemoTasks()?'demo':'')
    }</div><div class="ttl">Tasks</div></div></div>
    ${srcChips}
    ${!S.tasksConnected?`<div class="pending" style="margin:8px 0 14px"><div class="s">Showing sample tasks. No task system is connected.</div></div>`:''}
    ${S.tasksUnsynced?`<div class="pending" style="margin:8px 0 14px"><div class="s">${S.tasksUnsynced} change${S.tasksUnsynced===1?'':'s'} not yet pushed to the source system. Retrying.</div></div>`:''}
    <div class="task-list">${ts.map(t=>`
      <div class="task${t.done?' done':''}" data-task="${esc(t.id)}">
        <span class="box${t.done?' done':''}">${t.done?'✓':''}</span>
        <div style="flex:1;min-width:0">
          <div class="t">${esc(t.title)}</div>
          <div class="due">${[
            t.due ? (t.overdue?`Overdue · ${esc(t.due)}`:esc(t.due)) : '',
            t.synced ? '' : (t.pushError ? 'not synced' : 'syncing…'),
          ].filter(Boolean).join(' · ')}</div>
        </div>
        <span class="src-tag${t.source==='goosework'?' personal':''}">${esc(SOURCE_LABEL[t.source]||t.source||'')}</span>
      </div>`).join('') || '<div class="empty">Nothing here.</div>'}</div>`;
}

function spacesView(){
  const list = S.spaces;
  return `<div class="dhead" style="justify-content:space-between;align-items:flex-start">
      <div><div class="sub">Your roles & contexts</div><div class="ttl">Spaces</div></div>
      <button class="btn" data-space-add style="padding:7px 12px;font-size:13px">+ Add space</button></div>
    <p style="font-size:13px;color:var(--muted);margin:-8px 2px 14px;line-height:1.5">Spaces are yours to define — each one pulls its own tasks, events, notes and notifications into the shared modules. Add, rename or remove them anytime.</p>
    ${list.length?`<div class="grid" style="grid-template-columns:1fr 1fr">${list.map(s=>`
      <div class="space" data-space="${esc(s.key)}" style="border-top-color:${s.color};position:relative">
        <div class="space-tools">
          <button data-space-edit="${esc(s.key)}" title="Rename">✎</button>
          <button data-space-del="${esc(s.key)}" title="Delete">✕</button>
        </div>
        <div class="sw" style="background:${s.color}"></div>
        <div class="l">${esc(s.label)}</div>
        <div class="m">${s.memories||0} memories · ${s.notes||0} notes</div></div>`).join('')}</div>`
      :`<div style="color:var(--muted);padding:22px 4px">No spaces yet. Tap <b>+ Add space</b> to create your first context.</div>`}`;
}

function chatView(){
  const suggestions = ['Summarize my day','Draft an email','What needs me?'];
  return `<div class="chat">
    <div class="who"><span class="a compass-mark"></span><div><div style="font-size:15px;color:var(--ink);font-weight:700;font-family:var(--serif)">${esc(brand())}</div>
      <div style="font-size:11px;color:var(--sage)">Online · ${S.role==='All'?'all spaces':'scoped to '+esc(roleLabel(S.role))}</div></div></div>
    <div style="flex:1;display:flex;flex-direction:column;gap:12px" id="chatScroll">
      ${S.messages.length?'':`<div class="msg ai"><div class="bubble">Hey — I'm ${esc(brand())}. Ask me to plan your day, draft an email, check your calendar, or adjust your timeclock.</div></div>`}
      ${S.messages.map(m=>`<div class="msg ${m.from==='user'?'user':'ai'}"><div class="bubble">${m.from==='user'?esc(m.text):md(m.text)}</div></div>`).join('')}
      ${S.thinking?`<div class="typing"><span></span><span></span><span></span></div>`:''}
      ${S.pending.map(p=>`<div class="pending"><div class="s">${esc(p.summary)}</div><div class="a"><button class="btn" data-confirm="${p.id}">Confirm</button><button class="btn ghost" data-cancel="${p.id}">Cancel</button></div></div>`).join('')}
    </div>
    <div class="suggest">${suggestions.map(s=>`<span data-suggest="${esc(s)}">${esc(s)}</span>`).join('')}</div>
  </div>`;
}

/* demo detail views (Aureo design, placeholder data) */
function detailView(){
  const back = `<div class="dhead"><button class="back" data-act="back">←</button><div><div class="sub">Demo data</div><div class="ttl">${({nutrition:'Nutrition',sleep:'Sleep',finance:'Finance',workout:'Training',notes:'Notes',notifications:'Notifications'})[S.detail]||''}</div></div></div>`;
  if(S.detail==='notifications'){
    return back + (S.pending.length?`<div class="section-label" style="color:#cf9f5a">Needs you · ${S.pending.length}</div>
      <div style="display:flex;flex-direction:column;gap:9px">${S.pending.map(p=>`<div class="pending"><div class="s">${esc(p.summary)}</div><div class="a"><button class="btn" data-confirm="${p.id}">Confirm</button><button class="btn ghost" data-cancel="${p.id}">Cancel</button></div></div>`).join('')}</div>`
      :`<div style="color:var(--muted);padding:24px 4px">No notifications need you. Pending assistant proposals show up here.</div>`);
  }
  if(S.detail==='nutrition') return back + `<div class="lead" style="display:flex;justify-content:space-between;align-items:center;border-color:rgba(230,169,44,.22)"><div><div class="mono" style="font-size:34px;color:var(--gold)">1,240</div><div style="font-size:12px;color:var(--muted)">of 2,100 kcal</div></div><div style="text-align:right"><div class="mono" style="font-size:22px;color:var(--ink)">860</div><div style="font-size:12px;color:var(--sage)">remaining</div></div></div><div class="bar" style="height:8px;margin-top:14px"><span style="width:59%"></span></div>${macros()}`;
  if(S.detail==='sleep') return back + `<div style="display:flex;gap:11px"><div class="card" style="flex:1;cursor:default"><div class="mono" style="font-size:26px;color:var(--ink)">7h 12m</div><div style="font-size:12px;color:var(--sage);margin-top:5px">+24m vs avg</div></div><div class="card" style="flex:1;cursor:default;background:linear-gradient(155deg,#222a18,#1a1810);border-color:rgba(156,169,128,.25)"><div class="mono" style="font-size:26px;color:var(--sage)">84</div><div style="font-size:12px;color:var(--muted);margin-top:5px">sleep score</div></div></div><div class="section-label">Last 7 nights</div>${bars7()}`;
  if(S.detail==='finance') return back + `<div class="lead" style="background:linear-gradient(155deg,#222a18,#1a1810);border-color:rgba(156,169,128,.25)"><div style="display:flex;justify-content:space-between;align-items:baseline"><div><div class="mono" style="font-size:30px;color:var(--sage)">$214</div><div style="font-size:12px;color:var(--muted);margin-top:4px">left of $600 weekly budget</div></div><div class="mono" style="font-size:14px;color:var(--faint)">$386 spent</div></div><div class="bar" style="height:8px;margin-top:14px"><span style="width:64%;background:var(--sage)"></span></div></div>`;
  if(S.detail==='workout') return back + `<div class="card" style="cursor:default"><div class="k">Up next · 5:30 PM</div><div style="font-size:17px;color:var(--ink);font-weight:700">Evening session</div><div style="font-size:12px;color:var(--muted);margin-top:2px">~60 min</div></div>`;
  return back;
}
const macros=()=>`<div class="section-label">Macros</div>${[['Protein','78 / 120g',65,'var(--gold)'],['Carbs','130 / 210g',62,'var(--sage)'],['Fat','41 / 70g',58,'#cf9f5a']].map(([n,v,w,c])=>`<div style="margin-bottom:14px"><div style="display:flex;justify-content:space-between;font-size:13px;color:var(--ink-2);margin-bottom:6px"><span>${n}</span><span class="mono" style="color:var(--muted)">${v}</span></div><div class="bar" style="height:6px;margin:0"><span style="width:${w}%;background:${c}"></span></div></div>`).join('')}`;
const bars7=()=>`<div style="display:flex;align-items:flex-end;gap:9px;height:110px">${[64,80,55,72,68,60,78].map((h,i)=>`<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px"><span style="width:100%;height:${h}%;background:${i===6?'var(--gold)':'rgba(156,169,128,.5)'};border-radius:5px"></span><span style="font-size:10px;color:${i===6?'var(--gold)':'var(--faint)'}">${'WTFSSMT'[i]}</span></div>`).join('')}</div>`;

function render(){
  // sidebar (desktop)
  document.getElementById('sidebar').innerHTML = `
    <div class="brand"><span class="logo"></span><span class="n">${esc(brand())}</span></div>
    ${NAV.map(([k,l])=>`<a class="navitem${S.tab===k?' active':''}" data-go="${k}">${svg(k,S.tab===k?'#e6a92c':'#cfc6b4',19)}<span>${l}</span></a>`).join('')}
    <div class="spaces-h">Spaces</div>
    <div class="splist">${S.spaces.map(s=>`<div class="si" data-space="${esc(s.key)}"><span class="sw" style="background:${s.color}"></span><span>${esc(s.label)}</span><span class="c">${s.memories||0}</span></div>`).join('')}</div>
    <div class="me" data-act="settings"><span class="a">${esc(initials())}</span><div style="flex:1"><div style="font-size:13.5px;color:var(--ink);font-weight:600">${esc((S.cfg&&S.cfg.user.name)||'Account')}</div><div style="font-size:11px;color:var(--faint)">${S.spaces.length} space${S.spaces.length===1?'':'s'}</div></div></div>`;

  // topbar (desktop shows title; mobile shows nothing here — header is in home view)
  const titles={home:'Dashboard',calendar:'Calendar',tasks:'Tasks',spaces:'Spaces',chat:brand()};
  document.getElementById('topbar').innerHTML = `<div class="desktop-only"><div class="ttl">${esc(S.detail?titles[S.detail]||'Detail':titles[S.tab]||'')}</div><div class="sub">${esc(todayStr())} · ${S.role==='All'?'All spaces':esc(roleLabel(S.role))+' space'}</div></div>
    <div class="desktop-only" style="display:flex;align-items:center;gap:16px"><div style="text-align:right"><div class="temp mono" style="font-size:16px;color:var(--gold)">72°</div><div class="cond">Sunny</div></div></div>`;

  // main view
  let html;
  if(S.detail) html=detailView();
  else if(S.tab==='home') html=homeView();
  else if(S.tab==='calendar') html=calendarView();
  else if(S.tab==='tasks') html=tasksView();
  else if(S.tab==='spaces') html=spacesView();
  else if(S.tab==='chat') html=chatView();
  document.getElementById('view').innerHTML=html;

  // chrome (bottom nav + omnipresent chat bar)
  document.getElementById('chrome').innerHTML = `
    <div class="nav">${NAV.map(([k,l])=>`<a class="${S.tab===k&&!S.detail?'active':''}" data-go="${k}">${svg(k,S.tab===k&&!S.detail?'#e6a92c':'#6f6a5e')}<span>${l}</span></a>`).join('')}</div>
    <div class="voice-row"><span class="voice-badge" id="voiceBadge" style="display:none"></span><span class="tool-hint" id="toolHint" style="display:none"></span></div>
    <div class="bar-chat">
      <button class="mic" id="micBtn" title="Hold to dictate">${svg('mic','#cfc6b4',18)}</button>
      <input id="chatInput" placeholder="Ask or tell ${esc(brand())} anything…" value="${esc(S.chatInput)}">
      <button class="conv-btn" id="convBtn" data-act="conv" title="Hands-free conversation">${svg('wave','#cfc6b4',18)}</button>
      <button class="send" data-act="send">↑</button>
    </div>`;
  updateVoiceChrome();

  // drawer
  const dr=document.getElementById('drawer'), sc=document.getElementById('scrim');
  if(S.drawer){ dr.hidden=false; sc.hidden=false; dr.innerHTML=drawerHTML(); } else { dr.hidden=true; sc.hidden=true; }
}

function drawerHTML(){
  const accts=(S.cfg&&S.cfg.googleAccounts)||[];
  const feat=(S.cfg&&S.cfg.features)||{};
  const acctRows = accts.length?accts.map(a=>`<div class="drawer-item"><span class="sw" style="background:var(--sage)"></span><span class="l">${esc(a.email)}</span><span class="r">${esc(a.label||'')}</span></div>`).join(''):`<div class="drawer-item" style="cursor:default"><span class="sw" style="background:var(--dim)"></span><span class="l" style="color:var(--muted)">None connected</span></div>`;
  return `<div class="drawer-head"><span class="a">${esc(initials())}</span><div style="flex:1"><div class="n">${esc((S.cfg&&S.cfg.user.name)||'Account')}</div><div class="e">${esc((S.cfg&&S.cfg.user.email)||'')}</div></div><span data-act="settings" style="color:var(--muted);font-size:20px;cursor:pointer">✕</span></div>
  <div class="drawer-body">
    <div class="g">Connected Google accounts</div>
    ${acctRows}
    <a class="drawer-item" href="/connect/google?account=personal"><span class="sw" style="background:var(--gold)"></span><span class="l">Connect personal Gmail / Calendar</span><span class="r">→</span></a>
    <a class="drawer-item" href="/connect/google?account=work"><span class="sw" style="background:#6fa195"></span><span class="l">Connect work Gmail / Calendar</span><span class="r">→</span></a>
    <div class="g">Integrations</div>
    ${[['Timeclock',feat.timeclock],['Tasks (charliework)',feat.tasks],['Bookmarks',feat.bookmarks],['Containers',feat.containers]].map(([n,on])=>`<div class="drawer-item" style="cursor:default"><span class="sw" style="background:${on?'var(--sage)':'var(--dim)'}"></span><span class="l">${n}</span><span class="r">${on?'On':'Off'}</span></div>`).join('')}
    <div class="g">App</div>
    <div class="drawer-item" data-act="install"><span class="sw" style="background:var(--gold)"></span><span class="l">Add to Home Screen</span><span class="r"></span></div>
    <div class="drawer-item" style="cursor:default"><span class="sw" style="background:var(--dim)"></span><span class="l">About ${esc(brand())}</span><span class="r">v0.1</span></div>
    <a class="signout" href="/auth/logout">Sign out</a>
  </div>`;
}

function scrollChat(){ const el=document.getElementById('chatScroll'); if(el) el.scrollIntoView(false); const v=document.getElementById('view'); if(v) v.scrollTop=v.scrollHeight; }

/* ---------- events (delegated) ---------- */
let deferredPrompt=null;
window.addEventListener('beforeinstallprompt', e=>{ e.preventDefault(); deferredPrompt=e; });

document.addEventListener('click', e=>{
  const t=e.target.closest('[data-go],[data-role],[data-act],[data-detail],[data-task],[data-space-add],[data-space-edit],[data-space-del],[data-space],[data-confirm],[data-cancel],[data-suggest]');
  if(!t) return;
  if('spaceAdd' in t.dataset){ addSpace(); return; }
  if(t.dataset.spaceEdit){ editSpace(t.dataset.spaceEdit); return; }
  if(t.dataset.spaceDel){ delSpace(t.dataset.spaceDel); return; }
  if(t.dataset.go){ S.tab=t.dataset.go; S.detail=null; render(); return; }
  if(t.dataset.role){ S.role=t.dataset.role; render(); return; }
  if(t.dataset.detail){ S.detail=t.dataset.detail; render(); return; }
  if(t.dataset.space){ S.role=t.dataset.space; S.tab='home'; S.detail=null; S.drawer=false; render(); return; }
  if(t.dataset.tsrc){ S.taskSource=t.dataset.tsrc; render(); return; }
  if(t.dataset.task){
    const id=t.dataset.task, tk=tasks().find(x=>String(x.id)===id);
    if(tk){
      tk.done=!tk.done;
      if(S.tasksConnected){
        tk.synced=false;
        api('/tasks/'+encodeURIComponent(id),{method:'PATCH',body:JSON.stringify({status:tk.done?'done':'open'})})
          .then(r=>{ tk.synced=r&&r.synced!==false; tk.pushError=(r&&r.push_error)||null; loadTasks().then(render); })
          .catch(()=>{ tk.pushError='could not reach the task system'; render(); });
      }
    }
    render(); return;
  }
  if(t.dataset.confirm){ confirmPending(Number(t.dataset.confirm)); return; }
  if(t.dataset.cancel){ cancelPending(Number(t.dataset.cancel)); return; }
  if(t.dataset.suggest){ send(t.dataset.suggest); return; }
  const a=t.dataset.act;
  if(a==='settings'){ S.drawer=!S.drawer; render(); }
  else if(a==='back'){ S.detail=null; render(); }
  else if(a==='why'){ S.whyOpen=!S.whyOpen; render(); }
  else if(a==='conv'){ toggleConversation(); }
  else if(a==='send'){ const inp=document.getElementById('chatInput'); S.chatInput=inp?inp.value:''; send(); }
  else if(a==='chat-plan'){ send('Plan my day and tell me what to start with.'); }
  else if(a==='install'){ if(deferredPrompt){ deferredPrompt.prompt(); deferredPrompt=null; } else alert('Use your browser menu → Add to Home Screen.'); }
});
// Hold-to-dictate. Delegated pointer events on document, so the handler survives the
// chrome being re-rendered underneath it.
document.addEventListener('pointerdown', e=>{
  const m=e.target.closest('#micBtn'); if(!m) return;
  e.preventDefault(); m.setPointerCapture && m.setPointerCapture(e.pointerId);
  dictateStart();
});
document.addEventListener('pointerup', e=>{ if(S.dictating) dictateStop(); });
document.addEventListener('pointercancel', ()=>{ if(S.dictating) dictateStop(); });

document.addEventListener('input', e=>{ if(e.target.id==='chatInput') S.chatInput=e.target.value; });
document.addEventListener('keydown', e=>{ if(e.target.id==='chatInput' && e.key==='Enter'){ S.chatInput=e.target.value; send(); } });
document.getElementById('scrim').addEventListener('click', ()=>{ S.drawer=false; render(); });

/* ---------- boot ---------- */
(async ()=>{
  try { await loadConfig(); document.title=brand(); } catch(_){}
  render();
  await Promise.all([loadSpaces(), loadEvents(), loadTasks()]);
  render();
  if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
})();
