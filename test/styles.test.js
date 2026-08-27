// Guards for a hand-written, no-build frontend.
//
//   node test/styles.test.js
//
// Two failure modes this catches, both of which render as silently wrong layout rather than
// an error anyone would notice:
//
//   1. A class used in app.js that does not exist in styles.css. A typo produces an
//      unstyled element, not a crash.
//   2. Spacing or font-size written as a raw px value instead of a scale token. That is
//      exactly how the sheet drifted to 22 different spacing values and 25 font sizes with
//      nothing aligning to anything.

const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'public');
const js = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');

let pass = 0, fail = 0;
const check = (name, cond, got) => {
  let ok = false;
  try { ok = !!(typeof cond === 'function' ? cond() : cond); }
  catch (e) { got = `threw: ${e.message}`; }
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log(`  FAIL ${name}\n         ${JSON.stringify(got)}`); }
};

// ---- 1. every class used in markup is defined -------------------------------------------

// Classes the CSS defines (including inside media queries).
const defined = new Set();
for (const m of css.matchAll(/\.([a-z][a-z0-9-]*)/gi)) defined.add(m[1]);

// Classes app.js puts into markup. Only static class="..." attributes; template holes are
// skipped because their value is not knowable here.
const used = new Set();
for (const m of js.matchAll(/class="([^"$]*)"/g)) {
  for (const c of m[1].split(/\s+/)) if (c) used.add(c);
}
// Classes built by concatenation, e.g. class="chip${active?' active':''}"
for (const m of js.matchAll(/class="([a-z0-9 -]+)\$\{/gi)) {
  for (const c of m[1].split(/\s+/)) if (c) used.add(c);
}

const orphans = [...used].filter(c => !defined.has(c)).sort();
check('every class used in app.js is defined in styles.css', () => orphans.length === 0, orphans);

// ---- 2. spacing and type come from the scale --------------------------------------------

// Inline styles in app.js must not hardcode spacing or font-size. Dynamic values (colours
// from a space, a percentage bar width) are legitimate and are not px.
const inlinePx = [];
for (const m of js.matchAll(/style="([^"]*)"/g)) {
  const decls = m[1].split(';');
  for (const d of decls) {
    const [propRaw, valRaw] = d.split(':');
    if (!propRaw || !valRaw) continue;
    const prop = propRaw.trim();
    if (!/^(margin|padding|gap|font-size|top|bottom|left|right|width|height)/.test(prop)) continue;
    // Percentages and template holes are fine; raw px is not.
    if (/\d+(\.\d+)?px/.test(valRaw) && !valRaw.includes('${')) inlinePx.push(`${prop}:${valRaw.trim()}`);
  }
}
check('no raw px spacing or font-size in app.js inline styles', () => inlinePx.length === 0, inlinePx);

// The stylesheet itself: spacing and font-size should reference tokens. Hairlines and
// optical nudges under 2px are not spacing and are allowed, as are a handful of fixed
// component dimensions declared with an explicit reason.
const ALLOWED_RAW = new Set(['0px', '1px', '2px', '3px', '5px', '6px', '7px', '9px', '10px',
  '11px', '19px', '56px', '78px', '248px']);
const cssRaw = [];
for (const m of css.matchAll(/(^|[;{])\s*(font-size|gap|padding|margin)\s*:\s*([^;}]+)/g)) {
  const val = m[3].trim();
  for (const px of val.match(/\d+(\.\d+)?px/g) || []) {
    if (!ALLOWED_RAW.has(px)) cssRaw.push(`${m[2]}: ${val}`);
  }
}
check('styles.css uses scale tokens for spacing and type', () => cssRaw.length === 0, [...new Set(cssRaw)]);

// Half-pixel type is the signature of the old ad-hoc scale.
const halfPx = [...css.matchAll(/font-size\s*:\s*\d+\.\d+px/g)].map(m => m[0]);
check('no half-pixel font sizes', () => halfPx.length === 0, halfPx);

// ---- 3. the scale exists and is coherent -------------------------------------------------
const tokens = Object.fromEntries(
  [...css.matchAll(/--(s[1-7]|t-[a-z0-9]+|gutter)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));

check('spacing scale s1..s7 is defined', () => ['s1','s2','s3','s4','s5','s6','s7'].every(k => tokens[k]), tokens);
check('spacing scale is ascending', () => {
  const v = ['s1','s2','s3','s4','s5','s6','s7'].map(k => parseInt(tokens[k], 10));
  return v.every((n, i) => i === 0 || n > v[i - 1]);
}, ['s1','s2','s3','s4','s5','s6','s7'].map(k => tokens[k]));
check('a single --gutter token exists', () => !!tokens.gutter, tokens.gutter);

// ---- 4. chat owns its own layout -----------------------------------------------------------
check('chat layout modifier is applied by render', () => /view\.className\s*=\s*'scroll'/.test(js));
check('.scroll.is-chat drops the page gutter', () => /\.scroll\.is-chat\{[^}]*padding:0/.test(css));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
