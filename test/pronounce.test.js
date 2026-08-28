// Pronunciation dictionary: parsing, IPA normalisation, and substitution.
//
//   docker exec maverick node /app/test/pronounce.test.js
//
// Every rule here exists because something was actually mispronounced. The comments name
// the symptom, because a phoneme table is unreadable otherwise.

process.env.MAVERICK_DB_PATH = '/tmp/pronounce-test.db';
require('fs').rmSync(process.env.MAVERICK_DB_PATH, { force: true });

const p = require('../server/services/pronounce');

let pass = 0, fail = 0;
const check = (name, cond, got) => {
  let ok = false;
  try { ok = !!(typeof cond === 'function' ? cond() : cond); }
  catch (e) { got = `threw: ${e.message}`; }
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log(`  FAIL ${name}\n         ${JSON.stringify(got)}`); }
};

// ---- telling a respelling from a transcription -------------------------------------------
// ChatGPT hands you /krænts/. The field used to refuse it twice over: the æ failed the
// letters-only check, and the slashes tripped the "lists alternatives" check.
for (const [input, kind] of [
  ['/krænts/', 'ipa'], ['[krænts]', 'ipa'], ['krænts', 'ipa'], ['kɹˈænts', 'ipa'],
  ['crants', 'respelling'], ['will key', 'respelling'], ['wilky', 'respelling'],
]) {
  check(`${JSON.stringify(input)} reads as ${kind}`, () => p.parseSayAs(input).kind === kind,
        p.parseSayAs(input));
}

// ---- IPA is mapped into THIS engine's inventory -------------------------------------------
// Measured by synthesis: [Krantz](/krænts/) is 15020 bytes, [Krantz](/kɹˈænts/) is 15788.
// Plain r is an alveolar trill and comes out wrong; ɹ is the English approximant.
check('plain r becomes the approximant ɹ', () => p.parseSayAs('/krænts/').value === 'kɹænts',
      p.parseSayAs('/krænts/').value);
check('the correction is reported, not silent', () => p.parseSayAs('/krænts/').corrected === true);
check('missing stress is reported', () => p.parseSayAs('/krænts/').noStress === true);
check('already-correct IPA is left alone', () => {
  const r = p.parseSayAs('kɹˈænts');
  return r.value === 'kɹˈænts' && !r.corrected && !r.noStress;
}, p.parseSayAs('kɹˈænts'));
check('ASCII g becomes script ɡ', () => p.normalizeIPA('gɪ').value === 'ɡɪ', p.normalizeIPA('gɪ').value);
check('an apostrophe becomes a stress mark', () => p.normalizeIPA("kr'ænts").value === 'kɹˈænts',
      p.normalizeIPA("kr'ænts").value);

// ---- G2P normalisation --------------------------------------------------------------------
// "KRAHNTS" phonemizes to /kˌAˌɑɹˌAˌAʧˌɛntˌiˈɛs/ — Kokoro spells capitals out letter by
// letter. Hyphens do the same to a syllable.
check('respellings are lowercased for G2P', () => p.normalizeForG2P('KRAHNTS') === 'krahnts');
check('hyphens become spaces for G2P', () => p.normalizeForG2P('juh-LAH-mus') === 'juh lah mus');

// ---- a respelling must be ONE sound --------------------------------------------------------
// Saved verbatim, "Crayonts or  kr (start of kracken)-ants" phonemized to a transcription
// that spoke the word "or" and the whole parenthetical aloud.
for (const bad of [
  'Crayonts or  kr (start of kracken)-ants',
  'krants or crants',
  'krants, crants',
  'like milky',
]) {
  check(`rejects an explanation as a respelling: ${JSON.stringify(bad.slice(0, 28))}`,
        () => p.sanitizeSayAs(bad).ok === false, p.sanitizeSayAs(bad));
}
check('accepts a plain respelling', () => p.sanitizeSayAs('will key').ok === true);
check('a rejected respelling cannot be stored', () => {
  try { p.set({ word: 'X', say_as: 'a or b (c)' }); return false; } catch (_) { return true; }
});

// ---- substitution ---------------------------------------------------------------------------
p.set({ word: 'Wilke', say_as: 'wilky', phonemes: 'wˈɪlki' });
p.set({ word: 'Krantz', say_as: 'crants', phonemes: 'kɹˈænts' });

check('substitutes with phonemes when present',
      () => p.apply('the Krantz Center') === 'the [Krantz](/kɹˈænts/) Center', p.apply('the Krantz Center'));
check('matches case-insensitively', () => p.apply('wilke') === '[wilke](/wˈɪlki/)', p.apply('wilke'));
check('whole words only: Wilkes is untouched', () => p.apply('the Wilkes family') === 'the Wilkes family',
      p.apply('the Wilkes family'));
check('handles several words in one sentence', () => {
  const out = p.apply('Krantz and Wilke');
  return out.includes('kɹˈænts') && out.includes('wˈɪlki');
}, p.apply('Krantz and Wilke'));
check('leaves unrelated text alone', () => p.apply('nothing to fix here') === 'nothing to fix here');

// Falls back to the respelling when no phonemes were derived, which still speaks correctly.
p.set({ word: 'Sielaff', say_as: 'see loff' });
check('falls back to the respelling without phonemes',
      () => p.apply('ask Sielaff') === 'ask see loff', p.apply('ask Sielaff'));

// IPA typed into the respelling field is stored as phonemes, not spoken literally.
const ipaEntry = p.set({ word: 'Joe', say_as: '/dʒoʊ/' });
check('IPA in the respelling field is stored as phonemes',
      () => ipaEntry.phonemes === 'ʤoʊ' && !ipaEntry.say_as, ipaEntry);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
