// Regression test for the composer losing the caret after a reply landed.
//
//   node test/focus.test.js
//
// public/app.js is a no-build browser script, so the function under test is extracted from
// the real file rather than copied here. A copy would drift and quietly stop testing
// anything; extraction fails loudly if the function is renamed or removed.
//
// The fake DOM replaces element OBJECTS on rebuild, exactly as reassigning innerHTML does.
// That is the point: a restore that held a stale element reference would still "work"
// against a naive mock, and would do nothing in a browser.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'public', 'app.js');
const src = fs.readFileSync(SRC, 'utf8');
const m = src.match(/function withFocusPreserved\(rebuild\)\{[\s\S]*?\n\}/);
if (!m) {
  console.error('FAIL: withFocusPreserved() not found in public/app.js — renamed or removed?');
  process.exit(1);
}

let els = {};
let active = null;

const makeEl = (id, tag = 'INPUT') => ({
  id, tagName: tag, selectionStart: 0, selectionEnd: 0,
  focus() { active = this; },
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
});

global.document = {
  get activeElement() { return active; },
  getElementById: id => els[id] || null,
};

// eslint-disable-next-line no-eval
const withFocusPreserved = eval(`(${m[0]})`);

const rebuild = () => {
  els = { chatInput: makeEl('chatInput'), other: makeEl('other', 'BUTTON') };
  active = null;                       // innerHTML reassignment drops focus to <body>
};

let pass = 0, fail = 0;
// Guarded so a failing assertion reports and continues. A test that throws on the first
// failure hides every later one, which is exactly when you most want the full picture.
const check = (name, cond, got) => {
  let ok = false;
  try { ok = !!(typeof cond === 'function' ? cond() : cond); }
  catch (e) { got = `threw: ${e.message}`; }
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log(`  FAIL ${name}  got: ${JSON.stringify(got)}`); }
};

// The actual bug: typing, sending, and being unable to type again.
els = { chatInput: makeEl('chatInput') };
active = els.chatInput;
active.selectionStart = 7; active.selectionEnd = 7;
withFocusPreserved(rebuild);
check('focus restored after rebuild', () => active.id === 'chatInput', active && active.id);
check('caret position restored', () => active.selectionStart === 7 && active.selectionEnd === 7,
      active && [active.selectionStart, active.selectionEnd]);
check('restored to the rebuilt element, not a stale reference', () => active === els.chatInput, 'stale or null');

// Must not grant focus that was not held: forcing it would open a phone keyboard unasked
// when Send was tapped rather than typed.
els = { chatInput: makeEl('chatInput') }; active = null;
withFocusPreserved(rebuild);
check('no focus granted when none was held', active === null, active && active.id);

// Focus on something other than the composer stays where it was.
els = { other: makeEl('other', 'BUTTON'), chatInput: makeEl('chatInput') };
active = els.other;
withFocusPreserved(rebuild);
check('non-input focus restored to the same id', () => active.id === 'other', active && active.id);

// An element that no longer exists must not hand focus to something else.
els = { gone: makeEl('gone') }; active = els.gone;
withFocusPreserved(rebuild);
check('vanished element does not steal focus', active === null, active && active.id);

// After a send the input is cleared, so the old caret offset is past the end.
els = { chatInput: makeEl('chatInput') };
active = els.chatInput;
active.selectionStart = 40; active.selectionEnd = 40;
withFocusPreserved(() => { els = { chatInput: makeEl('chatInput') }; active = null; });
check('survives the input being cleared', () => active.id === 'chatInput', active && active.id);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
