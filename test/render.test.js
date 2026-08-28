// Render every view against a stubbed DOM.
//
//   node test/render.test.js
//
// public/app.js is a browser script with no build step and no framework, so a typo in a
// template literal produces a blank screen rather than an error anyone sees. This executes
// the real render path for each tab and checks the markup is well formed.
//
// It does not check that anything LOOKS right. It checks the views run, produce balanced
// markup, and never leak "undefined" or "[object Object]" into the page.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const check = (name, cond, got) => {
  let ok = false;
  try { ok = !!(typeof cond === 'function' ? cond() : cond); }
  catch (e) { got = `threw: ${e.message}`; }
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log(`  FAIL ${name}\n         ${JSON.stringify(got)}`); }
};

// ---- minimal DOM ------------------------------------------------------------------------
const els = {};
const makeEl = id => ({
  id, innerHTML: '', className: '', textContent: '', hidden: false, style: {}, dataset: {},
  scrollTop: 0, scrollHeight: 0,
  addEventListener() {}, removeEventListener() {}, focus() {}, remove() {},
  querySelector: () => null, querySelectorAll: () => [],
  setPointerCapture() {}, scrollIntoView() {},
  appendChild() {}, insertBefore() {}, closest: () => null,
  get parentElement() { return makeEl('parent'); },
});
for (const id of ['app','sidebar','topbar','view','chrome','scrim','drawer','chatInput','voiceBadge','toolHint','convBtn','micBtn','liveBubble']) els[id] = makeEl(id);

const sandbox = {
  console,
  document: {
    getElementById: id => els[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => makeEl('new'),
    get activeElement() { return null; },
    title: '',
  },
  window: { addEventListener() {}, AudioContext: function () {}, matchMedia: () => ({ matches: false }) },
  navigator: { serviceWorker: { register: () => Promise.resolve() }, mediaDevices: {} },
  location: { href: '' },
  fetch: () => new Promise(() => {}),          // never resolves: boot loads must not run
  setTimeout, clearTimeout, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  performance: { now: () => 0 },
  VoiceLoop: function () { return { startDictation() {}, stopDictation() {}, stop() {} }; },
};
sandbox.globalThis = sandbox;

// Top-level `const` in a strict script does not attach to globalThis, so the script is
// evaluated with a shim appended that hands the internals out. The shim is the ONLY thing
// added; the file under test is otherwise run verbatim.
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8')
  + '\n;globalThis.__app = { S, renderAll, render, leadEvent, demoTiles };\n';
const ctx = vm.createContext(sandbox);
try {
  vm.runInContext(src, ctx, { filename: 'app.js' });
  pass++; console.log('  ok   app.js evaluates without throwing');
} catch (e) {
  fail++; console.log(`  FAIL app.js evaluates without throwing\n         ${e.message}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}

// ---- plausible state --------------------------------------------------------------------
const S = sandbox.__app.S;
S.cfg = { brand: 'Maverick', user: { name: 'Matthew Gisi', email: 'm@x.com', initials: 'MG' },
          features: { timeclock: true, tasks: true, bookmarks: false, containers: false },
          googleAccounts: [{ email: 'm@x.com', label: 'personal' }], showDemoTiles: false };
S.spaces = [{ key: 'work', label: 'Work', color: '#e6a92c', memories: 3, notes: 1 },
            { key: 'personal', label: 'Personal', color: '#9ca980', memories: 0, notes: 0 }];
const iso = h => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.toISOString(); };
S.events = [{ time: '7:50 AM', title: 'Help George T Gialamas', sub: '217', start: iso(7), end: iso(8), allDay: false, role: 'work' },
            { time: '', title: "Ben Kasten's Birthday", sub: '', start: '2026-08-27', end: null, allDay: true, role: 'work' }];
S.eventsConnected = true;
S.tasks = [{ id: 'cw:1', title: 'Onboarding Setup', source: 'charliework', role: 'work', due: '2026-06-12', done: false, overdue: true, synced: true, pushError: null },
           { id: 'gw:2', title: 'Cancel Insurance', source: 'goosework', role: 'personal', due: '', done: false, overdue: false, synced: false, pushError: 'nope' }];
S.tasksConnected = true;
S.taskCounts = { open: 67, overdue: 6, due_soon: 0, by_source: { charliework: 62, goosework: 5 } };
S.tasksUnsynced = 1;
S.messages = [{ from: 'user', text: 'what is on my calendar' }, { from: 'ai', text: 'Three things **today**.' }];
S.pending = [{ id: 1, summary: 'Clock-out 5:34 PM -> 6:34 PM' }];
S.pron = [{ word: 'Wilke', say_as: 'will key', phonemes: 'wˈɪlki', note: 'the gym' },
          { word: 'Krantz', say_as: 'krants', phonemes: null }];
S.calendars = { connected: true, modes: ['agenda', 'reference', 'off'], counts: {},
  calendars: [{ id: 'a@x', account: 'work', summary: 'EHS Birthdays', kind: 'owned', mode: 'reference', explicit: true },
              { id: 'b@x', account: 'work', summary: 'Gone', kind: 'unknown', mode: 'off', explicit: true, missing: true }] };

// ---- render every view --------------------------------------------------------------------
const balanced = html => {
  const open = (html.match(/<(?!\/)(?!br\b)(?!input\b)(?!img\b)[a-z][a-z0-9]*/gi) || []).length;
  const close = (html.match(/<\/[a-z][a-z0-9]*/gi) || []).length;
  return { open, close, ok: open === close };
};

const VIEWS = ['home', 'calendar', 'tasks', 'spaces', 'chat'];
for (const tab of VIEWS) {
  S.tab = tab; S.detail = null;
  let html = '';
  check(`renders the ${tab} view`, () => { sandbox.__app.renderAll(); html = els.view.innerHTML; return html.length > 50; },
        html.slice(0, 80));
  const b = balanced(html);
  check(`  ${tab}: tags balanced`, () => b.ok, b);
  check(`  ${tab}: no undefined leaked`, () => !/\bundefined\b/.test(html), (html.match(/.{0,40}undefined.{0,40}/) || [])[0]);
  check(`  ${tab}: no [object Object]`, () => !html.includes('[object Object]'));
}

// Detail screens, including the settings one that is reachable without demo tiles.
for (const detail of ['notifications', 'calendars', 'pronounce']) {
  S.tab = 'home'; S.detail = detail;
  let html = '';
  check(`renders the ${detail} detail`, () => { sandbox.__app.renderAll(); html = els.view.innerHTML; return html.length > 40; });
  check(`  ${detail}: tags balanced`, () => balanced(html).ok, balanced(html));
  check(`  ${detail}: no undefined leaked`, () => !/\bundefined\b/.test(html), (html.match(/.{0,40}undefined.{0,40}/) || [])[0]);
}

// Demo tiles must be absent by default and present when enabled.
S.tab = 'home'; S.detail = null;
sandbox.__app.renderAll();
check('demo tiles hidden by default', () => !/data-detail="sleep"/.test(els.view.innerHTML));
S.cfg.showDemoTiles = true;
sandbox.__app.renderAll();
check('demo tiles appear when enabled', () => /data-detail="sleep"/.test(els.view.innerHTML));
S.cfg.showDemoTiles = false;

// Chat gets its own layout modifier; nothing else does.
S.tab = 'chat'; sandbox.__app.renderAll();
check('chat view sets the is-chat modifier', () => els.view.className === 'scroll is-chat', els.view.className);
S.tab = 'home'; sandbox.__app.renderAll();
check('other views do not', () => els.view.className === 'scroll', els.view.className);

// The drawer and chrome are rendered separately from the view.
S.drawer = true; sandbox.__app.renderAll();
check('drawer renders', () => els.drawer.innerHTML.length > 100);
check('drawer tags balanced', () => balanced(els.drawer.innerHTML).ok, balanced(els.drawer.innerHTML));
check('chrome renders the composer', () => els.chrome.innerHTML.includes('id="chatInput"'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
