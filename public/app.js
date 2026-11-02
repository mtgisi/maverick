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
  // Real timestamps for today, so the lead card's now/next logic behaves in demo mode too.
  const at = (h,m)=>{ const d=new Date(); d.setHours(h,m,0,0); return d.toISOString(); };
  const hm = [[9,0],[12,30],[14,0],[17,30]];
  return rows.map((r,i)=>({
    time:r[0], title:r[1], sub:(r[2]?r[2]+' · ':'')+sp[i%sp.length].label, role:sp[i%sp.length].key,
    start:at(hm[i][0],hm[i][1]), end:at(hm[i][0]+1,hm[i][1]), allDay:false,
  }));
}

const S = {
  cfg:null, tab:'home', role:'All', detail:null, whyOpen:false,
  thinking:false, chatInput:'',
  messages:[], pending:[], spaces:[],
  events:null, eventsConnected:false, tasks:null, tasksConnected:false,
  drawer:false, conv:'web',
  // tasks (unified charliework + goosework mirror)
  taskSource:'All', taskCounts:null, taskSources:[], tasksUnsynced:0,
  calendars:null, pron:null, pronForm:null,
  health:null, healthForm:null,
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
    S.events = d.connected ? (d.events||[]).filter(e=>!e.error).map(e=>({
      time:e.time||'all day', title:e.title, sub:(e.location||e.account||''),
      start:e.start||null, end:e.end||null, allDay:!!e.allDay,
      role:S.role==='All'?'Personal':S.role,
    })) : null;
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
        } else if(ev.type==='discard'){
          // The server threw away what it had streamed (it answered without checking, and
          // is now fetching the real data). Clear the partial text so the invented version
          // never stays on screen.
          S.streaming=''; S.thinking=true;
          const b=document.getElementById('liveBubble'); if(b) b.parentElement.remove();
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
  log_health:'logging that', health_today:'checking your log', undo_health_log:'taking that back',
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

// Six states, each visually distinct. "Listening" and "Speaking" look nothing alike,
// because when you are deciding whether to keep talking that is the difference that matters.
const VOICE_COPY={
  listening:'Listening', dictating:'Dictating', transcribing:'Heard you',
  thinking:'Thinking', speaking:'Speaking', idle:'',
};

function setToolHint(text){
  const el=document.getElementById('toolHint');
  if(!el) return;
  el.textContent=text||'';
  el.hidden=!text;
}

// Targeted update, not a full render: the mic button must not be rebuilt while it is held,
// or the pointerup never lands on the same element.
function updateVoiceChrome(){
  const badge=document.getElementById('voiceBadge');
  const conv=document.getElementById('convBtn');
  const mic=document.getElementById('micBtn');
  const raw=S.voiceState||'idle';
  const working=raw.startsWith('working:');
  const state=S.voiceError?'error':(working?'thinking':raw);
  const label=S.voiceError || (working?'Working':VOICE_COPY[raw]||'');

  if(badge){
    badge.textContent=label;
    badge.dataset.state=state;
    badge.hidden=!label;
  }
  if(working) setToolHint(toolLabel(raw.slice(8)));
  if(conv) conv.className='conv-btn'+(S.convMode?' on':'');
  if(mic) mic.className='mic'+(S.dictating?' live':'');
}

/* ---------- render ---------- */
function chips(){
  return `<div class="chips">${roleOrder().map(k=>{
    const active=S.role===k;
    return `<button class="chip${active?' active':''}" style="${active?`background:${rc(k)}`:''}" data-role="${esc(k)}">${esc(roleLabel(k))}</button>`;
  }).join('')}</div>`;
}

/* What the lead card should be about, given the time of day.
   Previously this was events[0], the first event of the DAY, so at four in the afternoon it
   still offered to help you prep a 7:50 AM meeting. An event is only worth leading with if
   it is happening now or has not started yet. */
function leadEvent(list){
  const now = Date.now();
  const t = v => { const n = v ? Date.parse(v) : NaN; return Number.isFinite(n) ? n : null; };

  // All-day entries have no clock time, so they are context for the day rather than a
  // "right now". They lead only when there is nothing timed left.
  const timed = list.filter(e => !e.allDay && t(e.start));

  const current = timed.find(e => {
    const s = t(e.start), en = t(e.end);
    return s <= now && (en ? en > now : now - s < 60 * 60 * 1000);   // no end: assume an hour
  });
  if (current) return { ev: current, state: 'now' };

  const upcoming = timed.filter(e => t(e.start) > now).sort((a, b) => t(a.start) - t(b.start))[0];
  if (upcoming) return { ev: upcoming, state: 'next' };

  const allDay = list.find(e => e.allDay);
  if (allDay) return { ev: allDay, state: 'today' };

  return { ev: null, state: timed.length ? 'done' : 'clear' };
}

function homeView(){
  const ev = events().filter(e=>inRole(e.role));
  const { ev: next, state } = leadEvent(ev);
  const due = tasks().filter(t=>!t.done && inRole(t.role)).length;

  const KICKER = { now:'Happening now', next:'Next up', today:'Today', done:'Rest of the day', clear:'Right now' };
  const leadTitle = next ? next.title
    : state==='done' ? "That's your day done"
    : 'Nothing urgent right now';
  const leadSub = next ? [next.time, next.sub].filter(Boolean).join(' · ')
    : state==='done' ? `Nothing else scheduled.${due?` ${due} task${due===1?'':'s'} still open.`:''}`
    : 'Your day is clear. Ask me to plan something.';

  // Only offer to prep something that has not happened yet.
  const action = state==='next' ? ['chat-prep','Start prep']
    : state==='now' ? null
    : due ? ['chat-plan','Plan my tasks']
    : ['chat-plan','Plan my day'];

  return `
  ${headerHTML()}
  <div class="lead">
    <div class="now"><span class="dot"></span><span class="t">${KICKER[state]}${S.role!=='All'?' · '+esc(roleLabel(S.role)):''}</span></div>
    <h2>${esc(leadTitle)}</h2>
    <p>${esc(leadSub)}</p>
    ${S.whyOpen?`<div class="why">
      <div class="row"><b>◆</b><span>Surfaced from your calendar and open tasks for this space.</span></div>
      <div class="row"><b>◆</b><span>${due} task${due===1?'':'s'} due — I can reprioritize on request.</span></div>
    </div>`:''}
    <div class="actions">
      ${action?`<button class="btn" data-act="${action[0]}">${action[1]}</button>`:''}
      <button class="btn ghost" data-act="why">${S.whyOpen?'Hide reasoning':'Why this?'}</button>
    </div>
  </div>
  ${chips()}
  <div class="grid">
    <div class="card span2 row-between" data-go="calendar">
      <div>
        <div class="k">${KICKER[state]}${next&&next.time?' \u00b7 '+esc(next.time):''}</div>
        <div class="v">${esc(next?next.title:(state==='done'?'Nothing else today':'No events'))}</div>
        <div class="m">${esc(next?next.sub:'')}${isDemoEvents()?' \u00b7 demo':''}</div>
      </div>
      <span class="arrow">&rarr;</span>
    </div>
    <div class="card" data-go="tasks">
      <div class="k">Tasks</div>
      <div class="v"><span class="bignum">${due}</span></div>
      <div class="m">due${isDemoTasks()?' \u00b7 demo':''}</div>
    </div>
    <div class="card" data-detail="notifications">
      <div class="k">Needs you</div>
      <div class="v"><span class="bignum">${S.pending.length}</span></div>
      <div class="m">${S.pending.length?'awaiting confirmation':'all clear'}</div>
    </div>
    ${healthTile()}
    ${demoTiles()}
    <div class="card span2 row-between" data-go="spaces" style="background:linear-gradient(120deg,rgba(156,169,128,.12),rgba(255,255,255,.03));border-color:rgba(156,169,128,.22)">
      <div>
        <div class="k" style="color:var(--sage)">Spaces</div>
        <div class="v">${S.spaces.length} context${S.spaces.length===1?'':'s'}</div>
        <div class="m">Scope the day to one of them</div>
      </div>
      <span class="bignum" style="color:var(--sage)">${S.spaces.length}</span>
    </div>
  </div>`;
}

// Sleep, nutrition and finance were hardcoded sample numbers filling half the home grid
// with fiction, which crowded out the three real tiles and made the whole screen less
// trustworthy. Off unless SHOW_DEMO_TILES is set.
function demoTiles(){
  if(!(S.cfg && S.cfg.showDemoTiles)) return '';
  return `
    <div class="card" data-detail="sleep"><div class="k">Sleep \u00b7 demo</div>
      <div class="v mono">7h 12m</div><div class="m" style="color:var(--sage)">+24m vs avg</div></div>
    <div class="card" data-detail="nutrition"><div class="k">Nutrition \u00b7 demo</div>
      <div class="v mono">1,240 <span style="color:var(--faint)">/ 2,100</span></div>
      <div class="bar"><span style="width:59%"></span></div></div>
    <div class="card" data-detail="finance"><div class="k">Finance \u00b7 demo</div>
      <div class="v mono" style="color:var(--sage)">$214</div><div class="m">left this week</div></div>`;
}

function headerHTML(){
  // The temperature and condition were hardcoded "72 / Sunny". Invented data in the first
  // place you look is worse than none, so it is gone until a weather source exists.
  return `<div class="head">
    <div>
      <div class="date">${esc(todayStr())}</div>
      <div class="greet">${greeting()}${S.cfg&&S.cfg.user.name?', '+esc(S.cfg.user.name.split(' ')[0]):''}</div>
    </div>
    <button class="avatar" data-act="settings">${esc(initials())}</button>
  </div>`;
}

function calendarView(){
  const ev = events().filter(e=>inRole(e.role));
  return `<div class="dhead">
      <div class="grow">
        <div class="sub">${S.role==='All'?'All spaces':esc(roleLabel(S.role))+' space'}${isDemoEvents()?' \u00b7 demo':''}</div>
        <div class="ttl">${esc(todayStr())}</div>
      </div>
    </div>
    ${!S.eventsConnected?`<div class="pending"><div class="s">Connect a Google account to see your real calendar.</div><div class="a"><a class="btn" href="/connect/google?account=personal">Connect Google</a></div></div>`:''}
    <div class="agenda">${ev.map(e=>`<div class="ev">
      <div class="time">${esc(e.time)}</div>
      <div class="body" style="border-left-color:${rc(e.role)}">
        <div class="t">${esc(e.title)}</div><div class="s">${esc(e.sub)}</div>
      </div></div>`).join('')||'<div class="empty">Nothing scheduled.</div>'}</div>`;
}

function tasksView(){
  const all = tasks();
  const ts = all.filter(t=>inRole(t.role)).filter(t=>!S.taskSource||S.taskSource==='All'||t.source===S.taskSource);
  const c = S.taskCounts;
  const srcChips = S.tasksConnected ? `<div class="chips">${
    [['All','All'],['charliework','Work'],['goosework','Personal']].map(([k,l])=>{
      const active=(S.taskSource||'All')===k;
      const n = k==='All' ? (c?c.open:all.length) : (c&&c.by_source?c.by_source[k]||0:0);
      return `<button class="chip${active?' active':''}" style="${active?`background:${ACCENT}`:''}" data-tsrc="${k}">${l} \u00b7 ${n}</button>`;
    }).join('')}</div>` : '';

  return `<div class="dhead">
      <div class="grow">
        <div class="sub">${c ? `${c.open} open${c.overdue?` \u00b7 ${c.overdue} overdue`:''}` : (isDemoTasks()?'demo':'')}</div>
        <div class="ttl">Tasks</div>
      </div>
    </div>
    ${srcChips}
    ${!S.tasksConnected?`<div class="pending"><div class="s">Showing sample tasks. No task system is connected.</div></div>`:''}
    ${S.tasksUnsynced?`<div class="pending"><div class="s">${S.tasksUnsynced} change${S.tasksUnsynced===1?'':'s'} not yet pushed to the source system. Retrying.</div></div>`:''}
    <div class="task-list">${ts.map(t=>`
      <div class="task${t.done?' done':''}" data-task="${esc(t.id)}">
        <span class="box${t.done?' done':''}">${t.done?'\u2713':''}</span>
        <div class="body">
          <div class="t">${esc(t.title)}</div>
          <div class="due">${[
            t.due ? (t.overdue?`Overdue \u00b7 ${esc(t.due)}`:esc(t.due)) : '',
            t.synced ? '' : (t.pushError ? 'not synced' : 'syncing\u2026'),
          ].filter(Boolean).join(' \u00b7 ')}</div>
        </div>
        ${t.source?`<span class="src-tag${t.source==='goosework'?' personal':''}">${esc(SOURCE_LABEL[t.source]||t.source)}</span>`:''}
      </div>`).join('') || '<div class="empty">Nothing here.</div>'}</div>`;
}

function spacesView(){
  const list = S.spaces;
  return `<div class="dhead">
      <div class="grow"><div class="sub">Your roles and contexts</div><div class="ttl">Spaces</div></div>
      <button class="btn sm" data-space-add>+ Add</button>
    </div>
    <p class="cal-intro">Spaces are yours to define. Each one pulls its own tasks, events and
      notes into the shared modules. Add, rename or remove them anytime.</p>
    ${list.length?`<div class="grid">${list.map(s=>`
      <div class="space" data-space="${esc(s.key)}" style="border-top-color:${s.color}">
        <div class="space-tools">
          <button data-space-edit="${esc(s.key)}" title="Rename">\u270e</button>
          <button data-space-del="${esc(s.key)}" title="Delete">\u2715</button>
        </div>
        <div class="sw" style="background:${s.color}"></div>
        <div class="l">${esc(s.label)}</div>
        <div class="m">${s.memories||0} memories \u00b7 ${s.notes||0} notes</div>
      </div>`).join('')}</div>`
      :`<div class="empty">No spaces yet. Tap <b>+ Add</b> to create your first context.</div>`}`;
}

function chatView(){
  const suggestions = ['What is on my calendar','What should I work on','Any unread email'];
  const brandName = esc(brand());
  return `<div class="chat">
    <div class="who">
      <span class="a compass-mark"></span>
      <div class="grow">
        <div class="n">${brandName}</div>
        <div class="s">${S.convMode?'Conversation mode':'Online'} \u00b7 ${S.role==='All'?'all spaces':'scoped to '+esc(roleLabel(S.role))}</div>
      </div>
    </div>
    <div class="thread" id="chatScroll">
      ${S.messages.length?'':`<div class="msg ai"><div class="bubble">Hey. Ask me to plan your day, check your calendar, draft an email, or look at your tasks.</div></div>`}
      ${S.messages.map(m=>`<div class="msg ${m.from==='user'?'user':'ai'}"><div class="bubble">${m.from==='user'?esc(m.text):md(m.text)}</div></div>`).join('')}
      ${S.thinking?`<div class="typing"><span></span><span></span><span></span></div>`:''}
      ${S.pending.map(p=>`<div class="pending"><div class="s">${esc(p.summary)}</div><div class="a"><button class="btn" data-confirm="${p.id}">Confirm</button><button class="btn ghost" data-cancel="${p.id}">Cancel</button></div></div>`).join('')}
      ${S.messages.length?'':`<div class="suggest">${suggestions.map(x=>`<span data-suggest="${esc(x)}">${esc(x)}</span>`).join('')}</div>`}
    </div>
  </div>`;
}

/* ---------- calendars: which ones are your day ---------- */
const CAL_MODES = [
  ['agenda','Agenda','Counts as your day'],
  ['reference','Reference','Readable when asked, never an activity'],
  ['off','Off','Never fetched'],
];

async function loadCalendars(){
  try { S.calendars = await api('/calendars'); }
  catch(_){ S.calendars = {error:'Could not load calendars.', calendars:[]}; }
}

async function setCalendarMode(account, id, mode, label){
  const d = S.calendars; if(!d) return;
  const cal = (d.calendars||[]).find(c=>c.account===account && c.id===id);
  if(cal){ cal.mode=mode; cal.explicit=true; }        // optimistic; the list is re-read on failure
  render();
  try {
    await api('/calendars',{method:'PATCH',body:JSON.stringify({account,calendar_id:id,mode,label})});
  } catch(_){ await loadCalendars(); }
  render();
}

function calendarsView(){
  const d = S.calendars;
  const back = `<div class="dhead">
    <button class="back" data-act="back" aria-label="Back">\u2190</button>
    <div class="grow"><div class="sub">Settings</div><div class="ttl">Calendars</div></div>
  </div>`;
  if(!d) return back + `<div class="empty">Loading…</div>`;

  const intro = `<p class="cal-intro">Not everything on a calendar is something you have to do.
    Mark the ones that are your actual commitments as <b>Agenda</b>. Birthdays, menus and
    who-is-in-and-out boards work better as <b>Reference</b>: ${esc(brand())} will read them when you
    ask, but they never show up as your activities.</p>`;

  const warn = d.error ? `<div class="pending"><div class="s">${esc(d.error)}${
      d.connected===false?' Reconnect a Google account in Settings.':''
    } Your settings below are saved and still editable.</div></div>` : '';

  const groups = {};
  for(const c of (d.calendars||[])) (groups[c.account]=groups[c.account]||[]).push(c);

  const body = Object.keys(groups).length ? Object.entries(groups).map(([acct,cals])=>`
    <div class="section-label">${esc(acct)}</div>
    <div class="cal-list">${cals.map(c=>`
      <div class="cal-row${c.missing?' missing':''}">
        <div class="cal-name">
          <div class="n">${esc(c.summary)}${c.primary?' <span class="cal-flag">primary</span>':''}</div>
          <div class="m">${c.missing?'no longer on this account':esc(c.kind||'')}${c.explicit?'':' · default'}</div>
        </div>
        <div class="seg">${CAL_MODES.map(([m,label,tip])=>`
          <button class="seg-btn${c.mode===m?' on':''}" title="${esc(tip)}"
            data-cal-mode="${esc(m)}" data-cal-acct="${esc(c.account)}" data-cal-id="${esc(c.id)}"
            data-cal-label="${esc(c.summary)}">${label}</button>`).join('')}</div>
      </div>`).join('')}</div>`).join('')
    : `<div class="empty">No calendars found${d.connected===false?' — connect a Google account first.':'.'}</div>`;

  return back + intro + warn + body;
}

/* ---------- pronunciation: teaching the voice local words ---------- */

async function loadPronunciations(){
  try { S.pron = await api('/voice/pronunciations'); }
  catch(_){ S.pron = []; }
}

// Form state lives in S because render() rebuilds innerHTML: anything typed into a field
// that is not mirrored here would vanish on the next render.
const blankPronForm = () => ({ word:'', description:'', say_as:'', phonemes:null, busy:false, error:'', note:'', defaultFor:null, defaultPhonemes:null });

// Turn the description into one respelling. The description is where you explain it however
// you like ("Crayonts, or kr like the start of kracken, then -ants"); this reduces that to a
// single sound, because the respelling is read out literally and an explanation would be
// spoken word for word.
// What the voice says with no correction at all. Shown so an override is a decision:
// "Krantz" already renders as /kɹˈænts/, and the entry added for it was replacing a correct
// default with a wrong vowel.
async function loadPronDefault(){
  const f=S.pronForm; const w=(f.word||'').trim();
  if(!w || w===f.defaultFor) return;
  f.defaultFor=w; f.defaultPhonemes=null; render();
  try {
    const r=await api('/voice/pronunciations/default?word='+encodeURIComponent(w));
    if(f.word.trim()===w){ f.defaultPhonemes=(r&&r.phonemes)||null; render(); }
  } catch(_){}
}

async function interpretPronunciation(){
  const f=S.pronForm;
  if(!f.word.trim() || !f.description.trim()){ f.error='Give the word and a description first.'; render(); return; }
  f.busy=true; f.error=''; render();
  try {
    const r=await api('/voice/pronunciations/interpret',{method:'POST',
      body:JSON.stringify({word:f.word.trim(),description:f.description.trim()})});
    if(r.error){ f.error=r.detail||r.error; }
    else { f.say_as=r.say_as||''; f.phonemes=r.phonemes||null; }
  } catch(e){ f.error='Could not work that out. Write the respelling yourself.'; }
  f.busy=false; render();
}

// Re-derive the phonemes from whatever respelling is in the field right now, so an edit by
// ear is picked up without going back through the description.
async function rephonemize(){
  const f=S.pronForm;
  if(!f.say_as.trim()) return;
  f.busy=true; f.note=''; render();
  try {
    const r=await api('/voice/pronunciations/phonemize',{method:'POST',body:JSON.stringify({text:f.say_as.trim()})});
    f.phonemes=(r&&r.phonemes)||null;
    // Pasted IPA usually needs mapping into this engine's inventory. Say so, because the
    // symptom otherwise is just "the R sounds wrong" with nothing to point at.
    if(r&&r.kind==='ipa'){
      f.note = r.corrected
        ? `Adjusted to this engine's symbols${r.noStress?', and it has no stress mark, which can sound flat':''}.`
        : (r.noStress?'No stress mark in that transcription; it may sound flat.':'');
    } else f.note='';
  } catch(_){}
  f.busy=false; render();
}

async function savePronForm(){
  const f=S.pronForm;
  if(!f.word.trim() || !f.say_as.trim()){ f.error='Needs a word and a respelling.'; render(); return; }
  f.busy=true; f.error=''; render();
  try {
    const r=await api('/voice/pronunciations',{method:'POST',body:JSON.stringify({
      word:f.word.trim(), say_as:f.say_as.trim(), phonemes:f.phonemes, description:f.description.trim()||null })});
    if(r&&r.error){ f.error=r.error; f.busy=false; render(); return; }
    S.pronForm=blankPronForm();
  } catch(e){ f.error='Could not save that.'; f.busy=false; render(); return; }
  await loadPronunciations(); render();
}

function editPronunciation(word){
  const e=(S.pron||[]).find(x=>x.word===word); if(!e) return;
  S.pronForm={ ...blankPronForm(), word:e.word, description:e.description||'', say_as:e.say_as||e.phonemes||'', phonemes:e.phonemes||null };
  loadPronDefault();
  render();
  const el=document.getElementById('pronDesc'); if(el) el.focus();
}

async function delPronunciation(word){
  if(!confirm(`Stop correcting "${word}"?`)) return;
  try { await api('/voice/pronunciations/'+encodeURIComponent(word),{method:'DELETE'}); } catch(_){}
  await loadPronunciations(); render();
}

// Say it out loud. The ear is the only test that counts, so this speaks the respelling
// exactly as the dictionary would.
async function previewPronunciation(text){
  try {
    const r=await fetch('/api/voice/speak',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({text})});
    if(!r.ok) return;
    const url=URL.createObjectURL(await r.blob());
    const a=new Audio(url); a.onended=()=>URL.revokeObjectURL(url); a.play().catch(()=>{});
  } catch(_){}
}

function pronounceView(){
  const f=S.pronForm||(S.pronForm=blankPronForm());
  const back = `<div class="dhead">
    <button class="back" data-act="back" aria-label="Back">\u2190</button>
    <div class="grow"><div class="sub">Settings</div><div class="ttl">Pronunciation</div></div>
  </div>`;
  if(!S.pron) return back + `<div class="empty">Loading\u2026</div>`;

  const form = `<div class="lead form">
    <div class="now"><span class="dot"></span><span class="t">${f.word&&(S.pron||[]).some(x=>x.word===f.word)?'Editing':'Add a word'}</span></div>
    <label class="fld">
      <span class="fl">Word, spelled normally</span>
      <input id="pronWord" data-pf="word" value="${esc(f.word)}" placeholder="Krantz" autocapitalize="words">
      ${f.defaultPhonemes?`<span class="fh dim">Without any correction the voice says <b>/${esc(f.defaultPhonemes)}/</b> \u2014 <span data-act="pron-preview-word" class="lnk">hear it</span>. Only override that if it is wrong.</span>`:''}
    </label>
    <label class="fld">
      <span class="fl">How does it sound? Explain it however you like.</span>
      <textarea id="pronDesc" data-pf="description" rows="3"
        placeholder="Crayonts, or kr like the start of kracken, then -ants">${esc(f.description)}</textarea>
    </label>
    <div class="actions">
      <button class="btn" data-act="pron-interpret" ${f.busy?'disabled':''}>${f.busy?'Working\u2026':'Work out the sound'}</button>
      ${(f.say_as||f.phonemes)?`<button class="btn ghost" data-act="pron-preview-form">Hear the fix</button>`:''}
      ${f.word||f.description?`<button class="btn ghost" data-act="pron-cancel">Clear</button>`:''}
    </div>
    <label class="fld">
      <span class="fl">Say it as \u2014 a respelling, or paste IPA like /kr\u00e6nts/</span>
      <input id="pronSay" data-pf="say_as" value="${esc(f.say_as)}" placeholder="krantz">
      <span class="fh">${f.phonemes?'/'+esc(f.phonemes)+'/':'nothing converted yet'}</span>
      ${f.note?`<span class="fh dim">${esc(f.note)}</span>`:''}
    </label>
    <div class="actions">
      <button class="btn" data-act="pron-save" ${f.busy?'disabled':''}>Save</button>
      <button class="btn ghost" data-act="pron-rephon" ${f.busy?'disabled':''}>Convert</button>
    </div>
    ${f.error?`<div class="fe">${esc(f.error)}</div>`:''}
  </div>`;

  const rows = S.pron.length ? `<div class="section-label">Corrected words</div>
    <div class="cal-list">${S.pron.map(e=>`
    <div class="cal-row">
      <div class="cal-name">
        <div class="n">${esc(e.word)}${e.say_as?` <span class="cal-flag">${esc(e.say_as)}</span>`:''}</div>
        <div class="m">${e.phonemes?'/'+esc(e.phonemes)+'/':'not converted'}${e.description?' \u00b7 '+esc(e.description.slice(0,48)):''}</div>
      </div>
      <div class="seg">
        <button class="seg-btn" data-pron-play="${esc(e.word)}" title="Hear it">\u25b6</button>
        <button class="seg-btn" data-pron-edit="${esc(e.word)}" title="Change it">\u270e</button>
        <button class="seg-btn" data-pron-del="${esc(e.word)}" title="Remove">\u2715</button>
      </div>
    </div>`).join('')}</div>`
    : `<div class="empty">Nothing corrected yet. Add the first word above.</div>`;

  return back + form + rows;
}

/* ---------- health log: what the accountability bot reports to friends ---------- */

async function loadHealth(){
  try { S.health = await api('/health/day/today'); }
  catch(_){ S.health = null; }
}

const blankHealthForm = () => ({ calories:'', protein_g:'', water_oz:'', workout:'', workout_minutes:'',
  habit:'', steps:'', sleep_h:'', weight_lb:'', busy:false, error:'' });

const fmtN = v => v==null ? null : Math.round(v).toLocaleString('en-US');

function healthTile(){
  const s = S.health && S.health.summary;
  if(!s) return '';
  const worked = s.workouts.length>0;
  return `<div class="card" data-detail="health">
      <div class="k">Health · today</div>
      <div class="v"><span class="bignum">${s.calories!=null?fmtN(s.calories):'—'}</span></div>
      <div class="m">${s.calories!=null?'kcal · ':''}${worked?'workout done':'no workout yet'}</div>
    </div>`;
}

// One line per entry, worded the same way the assistant reports them.
function healthEntryText(e){
  const v=e.value;
  switch(e.kind){
    case 'calories': return `${fmtN(v)} kcal`;
    case 'protein_g': return `${fmtN(v)} g protein`;
    case 'water_oz': return `${fmtN(v)} oz water`;
    case 'steps': return `${fmtN(v)} steps`;
    case 'sleep_h': return `${+(+v).toFixed(1)} h sleep`;
    case 'weight_lb': return `Weigh-in ${+(+v).toFixed(1)} lb`;
    case 'workout': return `Workout: ${e.label}${v?` · ${fmtN(v)} min`:''}`;
    case 'habit': return `Habit: ${e.label}`;
    default: return e.kind;
  }
}

async function saveHealthForm(){
  const f=S.healthForm||(S.healthForm=blankHealthForm());
  const num = k => String(f[k]).trim()==='' ? null : Number(f[k]);
  const entries=[];
  for(const k of ['calories','protein_g','water_oz','steps','sleep_h','weight_lb']){
    const v=num(k);
    if(v!=null){
      if(!Number.isFinite(v)){ f.error=`${k.replace('_',' ')} needs a number.`; render(); return; }
      entries.push({kind:k, value:v});
    }
  }
  if(f.workout.trim() || num('workout_minutes')!=null) entries.push({kind:'workout', value:num('workout_minutes'), label:f.workout.trim()});
  if(f.habit.trim()) entries.push({kind:'habit', label:f.habit.trim()});
  if(!entries.length){ f.error='Fill in at least one field.'; render(); return; }
  f.busy=true; f.error=''; render();
  try {
    const r=await api('/health/log',{method:'POST',body:JSON.stringify({entries})});
    if(r.error){ f.error=r.error; f.busy=false; render(); return; }
    S.healthForm=blankHealthForm();
  } catch(_){ f.error='Could not save that.'; f.busy=false; render(); return; }
  await loadHealth(); render();
}

async function delHealthEntry(id){
  if(!confirm('Remove this entry? Your friends will see the updated totals at the next check.')) return;
  try { await api('/health/entries/'+id,{method:'DELETE'}); } catch(_){}
  await loadHealth(); render();
}

function healthView(){
  const f=S.healthForm||(S.healthForm=blankHealthForm());
  const back = `<div class="dhead">
    <button class="back" data-act="back" aria-label="Back">←</button>
    <div class="grow"><div class="sub">Today</div><div class="ttl">Health</div></div>
  </div>`;
  if(!S.health) return back + `<div class="empty">Loading…</div>`;
  const s=S.health.summary;

  const stat = (label, value, unit) => `<div class="card hstat">
      <div class="k">${label}</div>
      <div class="v">${value==null?'<span class="dimv">—</span>':`<span class="bignum">${value}</span>`}</div>
      <div class="m">${value==null?'not logged':unit}</div>
    </div>`;
  const stats = `<div class="grid">
    ${stat('Calories', fmtN(s.calories), 'kcal')}
    ${stat('Protein', fmtN(s.protein_g), 'g')}
    ${stat('Water', fmtN(s.water_oz), 'oz')}
    ${stat('Steps', fmtN(s.steps), 'steps')}
    ${stat('Sleep', s.sleep_h==null?null:+s.sleep_h.toFixed(1), 'hours')}
    ${stat('Weigh-in', s.weight_lb==null?null:+s.weight_lb.toFixed(1), 'lb')}
    <div class="card hstat span2">
      <div class="k">Workout${s.habits.length?' · habits':''}</div>
      <div class="v">${s.workouts.length?esc(s.workouts.map(w=>w.label+(w.minutes?` (${fmtN(w.minutes)} min)`:'')).join(', ')):'<span class="dimv">None yet</span>'}</div>
      ${s.habits.length?`<div class="m">${esc(s.habits.join(', '))}</div>`:''}
    </div>
  </div>`;

  const inp = (key, label, ph, mode='decimal') => `<label class="fld">
      <span class="fl">${label}</span>
      <input data-hf="${key}" value="${esc(f[key])}" placeholder="${ph}" ${mode?`inputmode="${mode}"`:''} autocomplete="off">
    </label>`;
  const form = `<div class="section-label">Log something</div>
  <div class="lead form">
    <div class="hform">
      ${inp('calories','Calories','650')}
      ${inp('protein_g','Protein g','40')}
      ${inp('water_oz','Water oz','20')}
    </div>
    <div class="hform two">
      ${inp('workout','Workout','Lifting','')}
      ${inp('workout_minutes','Minutes','45','numeric')}
    </div>
    <div class="hform">
      ${inp('steps','Steps today','8000','numeric')}
      ${inp('sleep_h','Sleep h','7.5')}
      ${inp('weight_lb','Weight lb','')}
    </div>
    ${inp('habit','Habit done','Meditate','')}
    <div class="fh dim">Calories, protein and water add to today. Steps, sleep and weight replace today's value. You can also just tell the assistant: “log 650 calories and 40 grams of protein”.</div>
    <div class="actions">
      <button class="btn" data-act="health-save" ${f.busy?'disabled':''}>${f.busy?'Saving…':'Log it'}</button>
    </div>
    ${f.error?`<div class="fe">${esc(f.error)}</div>`:''}
  </div>`;

  const list = S.health.entries.length ? `<div class="section-label">Today's entries</div>
    <div class="cal-list">${S.health.entries.slice().reverse().map(e=>`
      <div class="cal-row">
        <div class="cal-name">
          <div class="n">${esc(healthEntryText(e))}</div>
          <div class="m">${esc(new Date(e.created_at.replace(' ','T')+'Z').toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}))} · ${esc(e.source||'')}</div>
        </div>
        <div class="seg"><button class="seg-btn" data-health-del="${e.id}" title="Remove">✕</button></div>
      </div>`).join('')}</div>` : '';

  // Exactly what the bot receives, so nothing about the share is a surprise.
  const sh=S.health.shared;
  const shared = `<div class="section-label">What the accountability bot sees</div>
    <div class="cal-row"><div class="cal-name"><div class="m hshare">${esc([
      `workout ${sh.workout.completed?'done':'not done'}`,
      sh.nutrition.calories!=null?`${fmtN(sh.nutrition.calories)} kcal`:'calories: no data',
      sh.nutrition.protein_g!=null?`${fmtN(sh.nutrition.protein_g)} g protein`:'protein: no data',
      sh.nutrition.water_oz!=null?`${fmtN(sh.nutrition.water_oz)} oz water`:'water: no data',
      sh.activity.steps!=null?`${fmtN(sh.activity.steps)} steps`:'steps: no data',
      sh.sleep.hours!=null?`${sh.sleep.hours} h sleep`:'sleep: no data',
      `weigh-in ${sh.weighin.logged?'logged':'not logged'}${sh.weighin.weight_lb!=null?` (${sh.weighin.weight_lb} lb)`:''}`,
      ...Object.keys(sh.habits).map(h=>`habit ${h}`),
    ].join(' · '))}</div></div></div>`;

  return back + stats + form + list + shared;
}

/* demo detail views (Aureo design, placeholder data) */
function detailView(){
  if(S.detail==='calendars') return calendarsView();
  if(S.detail==='pronounce') return pronounceView();
  if(S.detail==='health') return healthView();
  const TITLES={nutrition:'Nutrition',sleep:'Sleep',finance:'Finance',workout:'Training',notes:'Notes',notifications:'Notifications',pronounce:'Pronunciation'};
  const DEMO=['nutrition','sleep','finance','workout'];
  const back = `<div class="dhead">
    <button class="back" data-act="back" aria-label="Back">\u2190</button>
    <div class="grow">
      ${DEMO.includes(S.detail)?'<div class="sub">Sample data</div>':''}
      <div class="ttl">${TITLES[S.detail]||''}</div>
    </div>
  </div>`;
  if(S.detail==='notifications'){
    return back + (S.pending.length
      ? `<div class="section-label" style="color:var(--warn)">Needs you \u00b7 ${S.pending.length}</div>
         <div class="task-list">${S.pending.map(p=>`<div class="pending"><div class="s">${esc(p.summary)}</div><div class="a"><button class="btn" data-confirm="${p.id}">Confirm</button><button class="btn ghost" data-cancel="${p.id}">Cancel</button></div></div>`).join('')}</div>`
      : `<div class="empty">Nothing needs you. Assistant proposals awaiting confirmation show up here.</div>`);
  }
  if(S.detail==='nutrition') return back + `
    <div class="lead row-between">
      <div class="stat"><span class="n gold">1,240</span><span class="u">of 2,100 kcal</span></div>
      <div class="stat" style="text-align:right"><span class="n">860</span><span class="u sage">remaining</span></div>
    </div>
    <div class="bar"><span style="width:59%"></span></div>
    ${macros()}`;

  if(S.detail==='sleep') return back + `
    <div class="stat-row">
      <div class="card"><div class="stat"><span class="n">7h 12m</span><span class="u sage">+24m vs avg</span></div></div>
      <div class="card"><div class="stat"><span class="n sage">84</span><span class="u">sleep score</span></div></div>
    </div>
    <div class="section-label">Last 7 nights</div>${bars7()}`;

  if(S.detail==='finance') return back + `
    <div class="lead">
      <div class="row-between">
        <div class="stat"><span class="n sage">$214</span><span class="u">left of a $600 week</span></div>
        <span class="u mono">$386 spent</span>
      </div>
      <div class="bar"><span style="width:64%;background:var(--sage)"></span></div>
    </div>`;

  if(S.detail==='workout') return back + `
    <div class="card"><div class="k">Up next \u00b7 5:30 PM</div>
      <div class="v">Evening session</div><div class="m">~60 min</div></div>`;

  return back;
}

const macros=()=>`<div class="section-label">Macros</div>` + [
  ['Protein','78 / 120g',65,'var(--gold)'],
  ['Carbs','130 / 210g',62,'var(--sage)'],
  ['Fat','41 / 70g',58,'#cf9f5a'],
].map(([n,v,w,c])=>`<div class="macro">
    <div class="row"><span>${n}</span><span class="mono" style="color:var(--muted)">${v}</span></div>
    <div class="bar"><span style="width:${w}%;background:${c}"></span></div>
  </div>`).join('');

const bars7=()=>`<div class="bars7">${[64,80,55,72,68,60,78].map((h,i)=>
  `<div class="b${i===6?' on':''}"><span style="height:${h}%"></span><em>${'WTFSSMT'[i]}</em></div>`).join('')}</div>`;


/* render() reassigns innerHTML on four containers, so any element that had focus stops
   existing and focus falls back to <body>. That is why the cursor was lost the moment a
   reply finished: send() ends in render(), which rebuilds the composer out from under you.

   Capture focus and caret before the rebuild, restore after. Doing it here rather than in
   send() covers every render() call site, so a future one cannot reintroduce the same bug.

   Only ever RESTORES focus, never grants it. If you tapped Send on a phone rather than
   typing, focus was on the button, and forcing it into the input would pop the keyboard
   open when you did not ask for it. */
function withFocusPreserved(rebuild){
  const el = document.activeElement;
  const id = el && el.id;
  const isField = el && (el.tagName==='INPUT' || el.tagName==='TEXTAREA');
  const start = isField ? el.selectionStart : null;
  const end   = isField ? el.selectionEnd   : null;

  rebuild();

  if(!id) return;
  const next = document.getElementById(id);
  if(!next || next===document.activeElement) return;
  next.focus({preventScroll:true});
  if(start!=null && typeof next.setSelectionRange==='function'){
    try { next.setSelectionRange(start, end); } catch(_){}
  }
}

function render(){ withFocusPreserved(renderAll); }

function renderAll(){
  // sidebar (desktop)
  document.getElementById('sidebar').innerHTML = `
    <div class="brand"><span class="logo"></span><span class="n">${esc(brand())}</span></div>
    ${NAV.map(([k,l])=>`<a class="navitem${S.tab===k?' active':''}" data-go="${k}">${svg(k,S.tab===k?'#e6a92c':'#cfc6b4',19)}<span>${l}</span></a>`).join('')}
    <div class="spaces-h">Spaces</div>
    <div class="splist">${S.spaces.map(s=>`<div class="si" data-space="${esc(s.key)}"><span class="sw" style="background:${s.color}"></span><span>${esc(s.label)}</span><span class="c">${s.memories||0}</span></div>`).join('')}</div>
    <div class="me" data-act="settings">
      <span class="a">${esc(initials())}</span>
      <div class="grow">
        <div class="n">${esc((S.cfg&&S.cfg.user.name)||'Account')}</div>
        <div class="s">${S.spaces.length} space${S.spaces.length===1?'':'s'}</div>
      </div>
    </div>`;

  // topbar
  //
  // On mobile this used to render nothing but padding, which left Settings reachable ONLY
  // from the avatar in the home header. Every other tab had no way in at all. It now carries
  // a settings button on every screen except home, where the header already has one, so
  // there is always exactly one way in and it is always in the same corner.
  const titles={home:'Dashboard',calendar:'Calendar',tasks:'Tasks',spaces:'Spaces',chat:brand(),calendars:'Calendars',pronounce:'Pronunciation',health:'Health'};
  const title = esc(S.detail?titles[S.detail]||'Detail':titles[S.tab]||'');
  document.getElementById('topbar').innerHTML =
    `<div class="desktop-only">
       <div class="ttl">${title}</div>
       <div class="sub">${esc(todayStr())} \u00b7 ${S.role==='All'?'All spaces':esc(roleLabel(S.role))+' space'}</div>
     </div>
     ${(S.tab==='home' && !S.detail) ? '' : `<div class="mobile-only topbar-mobile">
       <div class="ttl">${title}</div>
       <button class="avatar sm" data-act="settings" aria-label="Settings">${esc(initials())}</button>
     </div>`}`;

  // main view
  let html;
  if(S.detail) html=detailView();
  else if(S.tab==='home') html=homeView();
  else if(S.tab==='calendar') html=calendarView();
  else if(S.tab==='tasks') html=tasksView();
  else if(S.tab==='spaces') html=spacesView();
  else if(S.tab==='chat') html=chatView();
  // Chat is its own layout, not a document inside the dashboard scroller. The modifier
  // drops the page gutter and vertical rhythm so the thread and composer belong together.
  const view = document.getElementById('view');
  view.className = 'scroll' + (S.tab==='chat' && !S.detail ? ' is-chat' : '');
  view.innerHTML = html;

  // chrome (bottom nav + omnipresent composer)
  document.getElementById('chrome').innerHTML = `
    <div class="nav">${NAV.map(([k,l])=>`<a class="${S.tab===k&&!S.detail?'active':''}" data-go="${k}">${svg(k,S.tab===k&&!S.detail?'#e6a92c':'#6f6a5e')}<span>${l}</span></a>`).join('')}</div>
    <div class="voice-row"><span class="voice-badge" id="voiceBadge" hidden></span><span class="tool-hint" id="toolHint" hidden></span></div>
    <div class="bar-chat">
      <button class="mic" id="micBtn" title="Hold to dictate" aria-label="Hold to dictate">${svg('mic','#cfc6b4',18)}</button>
      <input id="chatInput" placeholder="Ask or tell ${esc(brand())} anything\u2026" value="${esc(S.chatInput)}">
      <button class="conv-btn" id="convBtn" data-act="conv" title="Hands-free conversation" aria-label="Hands-free conversation">${svg('wave','#cfc6b4',18)}</button>
      <button class="send" data-act="send" aria-label="Send">\u2191</button>
    </div>`;
  updateVoiceChrome();

  // drawer
  const dr=document.getElementById('drawer'), sc=document.getElementById('scrim');
  if(S.drawer){ dr.hidden=false; sc.hidden=false; dr.innerHTML=drawerHTML(); } else { dr.hidden=true; sc.hidden=true; }
}

function drawerHTML(){
  const accts=(S.cfg&&S.cfg.googleAccounts)||[];
  const feat=(S.cfg&&S.cfg.features)||{};
  const dot = on => `<span class="sw" style="background:${on?'var(--sage)':'var(--dim)'}"></span>`;
  const acctRows = accts.length
    ? accts.map(a=>`<div class="drawer-item">${dot(true)}<span class="l">${esc(a.email)}</span><span class="r">${esc(a.label||'')}</span></div>`).join('')
    : `<div class="drawer-item">${dot(false)}<span class="l" style="color:var(--muted)">None connected</span></div>`;

  return `<div class="drawer-head">
    <span class="a">${esc(initials())}</span>
    <div class="grow">
      <div class="n">${esc((S.cfg&&S.cfg.user.name)||'Account')}</div>
      <div class="e">${esc((S.cfg&&S.cfg.user.email)||'')}</div>
    </div>
    <button class="back" data-act="settings" aria-label="Close">\u2715</button>
  </div>
  <div class="drawer-body">
    <div class="g">Connected Google accounts</div>
    ${acctRows}
    <a class="drawer-item" href="/connect/google?account=personal"><span class="sw"></span><span class="l">Connect personal Gmail / Calendar</span><span class="r">&rarr;</span></a>
    <a class="drawer-item" href="/connect/google?account=work"><span class="sw" style="background:#6fa195"></span><span class="l">Connect work Gmail / Calendar</span><span class="r">&rarr;</span></a>

    <div class="g">Assistant</div>
    <div class="drawer-item" data-detail="calendars"><span class="sw" style="background:var(--sage)"></span><span class="l">Calendars</span><span class="r">&rarr;</span></div>
    <div class="drawer-item" data-detail="pronounce"><span class="sw" style="background:var(--sage)"></span><span class="l">Pronunciation</span><span class="r">&rarr;</span></div>
    <div class="drawer-item" data-act="clear-chat"><span class="sw" style="background:var(--warn)"></span><span class="l">Clear chat history</span><span class="r">\u21ba</span></div>

    <div class="g">Integrations</div>
    ${[['Timeclock',feat.timeclock],['Tasks',feat.tasks],['Bookmarks',feat.bookmarks],['Containers',feat.containers]]
      .map(([n,on])=>`<div class="drawer-item">${dot(on)}<span class="l">${n}</span><span class="r">${on?'On':'Off'}</span></div>`).join('')}

    <div class="g">App</div>
    <div class="drawer-item" data-act="install"><span class="sw"></span><span class="l">Add to Home Screen</span><span class="r"></span></div>
    <a class="signout" href="/auth/logout">Sign out</a>
  </div>`;
}

function scrollChat(){ const el=document.getElementById('chatScroll'); if(el) el.scrollIntoView(false); const v=document.getElementById('view'); if(v) v.scrollTop=v.scrollHeight; }

/* ---------- events (delegated) ---------- */
let deferredPrompt=null;
window.addEventListener('beforeinstallprompt', e=>{ e.preventDefault(); deferredPrompt=e; });

document.addEventListener('click', e=>{
  const t=e.target.closest('[data-go],[data-role],[data-act],[data-detail],[data-task],[data-tsrc],[data-cal-mode],[data-pron-play],[data-pron-edit],[data-pron-del],[data-space-add],[data-space-edit],[data-space-del],[data-space],[data-confirm],[data-cancel],[data-suggest],[data-health-del]');
  if(!t) return;
  if('spaceAdd' in t.dataset){ addSpace(); return; }
  if(t.dataset.spaceEdit){ editSpace(t.dataset.spaceEdit); return; }
  if(t.dataset.spaceDel){ delSpace(t.dataset.spaceDel); return; }
  if(t.dataset.go){ S.tab=t.dataset.go; S.detail=null; render(); return; }
  if(t.dataset.role){ S.role=t.dataset.role; render(); return; }
  if(t.dataset.healthDel){ delHealthEntry(Number(t.dataset.healthDel)); return; }
  if(t.dataset.pronPlay){ previewPronunciation(t.dataset.pronPlay); return; }
  if(t.dataset.pronDel){ delPronunciation(t.dataset.pronDel); return; }
  if(t.dataset.pronEdit){ editPronunciation(t.dataset.pronEdit); return; }
  if(t.dataset.calMode){
    setCalendarMode(t.dataset.calAcct, t.dataset.calId, t.dataset.calMode, t.dataset.calLabel);
    return;
  }
  if(t.dataset.detail){
    S.detail=t.dataset.detail; S.drawer=false; render();
    if(S.detail==='calendars') loadCalendars().then(render);
    if(S.detail==='pronounce') loadPronunciations().then(render);
    if(S.detail==='health') loadHealth().then(render);
    return;
  }
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
  else if(a==='pron-interpret'){ interpretPronunciation(); }
  else if(a==='pron-save'){ savePronForm(); }
  else if(a==='pron-rephon'){ rephonemize(); }
  else if(a==='pron-preview-form'){ previewPronunciation(S.pronForm.word||S.pronForm.say_as); }
  else if(a==='pron-preview-word'){ previewPronunciation(S.pronForm.word); }
  else if(a==='pron-cancel'){ S.pronForm=blankPronForm(); render(); }
  else if(a==='health-save'){ saveHealthForm(); }
  else if(a==='send'){ const inp=document.getElementById('chatInput'); S.chatInput=inp?inp.value:''; send(); }
  else if(a==='chat-plan'){ send('Plan my day and tell me what to start with.'); }
  else if(a==='clear-chat'){
    if(confirm('Clear this conversation?\nThe assistant forgets what was said; your memories, tasks and reminders are untouched.')){
      api('/chat/history',{method:'DELETE',body:JSON.stringify({conversation_id:S.conv})})
        .catch(()=>{})
        .then(()=>{ S.messages=[]; S.pending=[]; S.streaming=''; S.drawer=false; render(); });
    }
  }
  else if(a==='chat-prep'){
    // Prep the NEXT event specifically, not "the day", so the reply is about the thing the
    // card is showing.
    const { ev } = leadEvent(events().filter(x=>inRole(x.role)));
    send(ev ? `Help me prepare for "${ev.title}" at ${ev.time}. What should I have ready?`
            : 'Plan my day and tell me what to start with.');
  }
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

document.addEventListener('input', e=>{
  if(e.target.id==='chatInput'){ S.chatInput=e.target.value; return; }
  // Form fields mirror into state, or a render triggered by anything else wipes what was typed.
  const hf=e.target.dataset && e.target.dataset.hf;
  if(hf){ (S.healthForm||(S.healthForm=blankHealthForm()))[hf]=e.target.value; return; }
  const f=e.target.dataset && e.target.dataset.pf;
  if(f && S.pronForm){
    S.pronForm[f]=e.target.value;
    if(f==='word'){ clearTimeout(S._pronT); S._pronT=setTimeout(loadPronDefault,500); }
  }
});
document.addEventListener('keydown', e=>{ if(e.target.id==='chatInput' && e.key==='Enter'){ S.chatInput=e.target.value; send(); } });
document.getElementById('scrim').addEventListener('click', ()=>{ S.drawer=false; render(); });

/* ---------- boot ---------- */
(async ()=>{
  try { await loadConfig(); document.title=brand(); } catch(_){}
  render();
  await Promise.all([loadSpaces(), loadEvents(), loadTasks(), loadHealth()]);
  render();
  if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
})();
