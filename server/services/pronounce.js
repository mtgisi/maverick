// Teaching the voice how to say local words.
//
// Kokoro's grapheme-to-phoneme pass guesses, and it guesses badly on proper nouns. Verified
// against the running service: "Wilke" phonemizes to /wˈɪlk/, so the gym comes out as "wilk"
// with the final vowel dropped entirely. It is pronounced "will-key".
//
// Two ways to fix a word, because they suit different people and different words:
//
//   say_as    a respelling, e.g. "will key". Easy to write, easy to tweak by ear, and it
//             goes through the normal G2P pass so it inherits sensible stress.
//   phonemes  exact IPA, e.g. wˈɪlki, emitted as Kokoro's [word](/phonemes/) syntax.
//             Precise, and worth it when a respelling cannot get there.
//
// say_as is the default because you can fix a word by ear without knowing IPA. Both are
// stored; phonemes win when present.

const db = require('../db');

// Applied to assistant replies before they reach TTS. Never to text shown on screen: the
// written word stays spelled correctly.
function all() {
  try { return db.prepare('SELECT * FROM pronunciations ORDER BY word').all(); }
  catch (_) { return []; }
}

// A respelling is ONE way to say the word. It is spoken literally, so anything that is
// commentary rather than sound ends up being read aloud.
//
// This is not hypothetical: an entry saved as "Crayonts or  kr (start of kracken)-ants"
// phonemized to /kɹˈAɑnts ɔɹ kˌAˈɑɹ (stˈɑɹt ʌv kɹˈækən)ˈænts/, so the voice would have
// said the word "or" and the whole parenthetical out loud. Descriptions belong in
// `description`; `say_as` must be a single sound.
const ALTERNATIVE = /\s+(or|aka|either|maybe|like|rhymes with|sort of|kind of)\s+/i;

function sanitizeSayAs(raw) {
  let v = String(raw || '').trim();
  if (!v) return { ok: false, error: 'say_as is empty' };
  if (/[()\[\]{}"]/.test(v)) return { ok: false, problem: 'contains an aside in brackets or quotes', value: v };
  if (ALTERNATIVE.test(v)) return { ok: false, problem: 'offers more than one alternative', value: v };
  if (/[,;/]/.test(v)) return { ok: false, problem: 'lists alternatives', value: v };
  v = v.replace(/\s+/g, ' ');
  if (!/^[a-z' -]+$/i.test(v)) return { ok: false, problem: 'contains characters that are not speakable letters', value: v };
  if (v.length > 40) return { ok: false, problem: 'is too long to be one word', value: v };
  return { ok: true, value: v };
}

// Kokoro's G2P is case- and hyphen-sensitive in ways that ruin a respelling.
// Measured against the running service:
//
//   "KRAHNTS"     -> /kˌAˌɑɹˌAˌAʧˌɛntˌiˈɛs/    it spells the letters out
//   "krahnts"     -> /kɹˈɑnts/                  correct
//   "juh-LAH-mus" -> /ʤˈʌˌɛlˌAˈAʧmˈʌs/          hyphen plus caps, garbage
//   "juh lah mus" -> /ʤˈʌ lˈɑ mjˈuz/            usable
//
// So a respelling is lowercased and hyphens become spaces before it is phonemized. This is
// applied to what gets SENT to the phonemizer; the stored respelling keeps what was typed.
const normalizeForG2P = raw => String(raw || '')
  .toLowerCase()
  .replace(/[-_]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// IPA, as a phonetic transcription rather than a respelling. Accepted because it is often
// the most direct thing a person has: ChatGPT will hand you /krænts/, and being unable to
// paste that in is a silly reason to be stuck.
//
// Detected by the presence of characters that only appear in phonetic transcription, so
// ordinary respellings are never mistaken for IPA.
const IPA_CHARS = /[ɹɑæɛɪʊʌəɔʃʒʧʤŋθðːɜɐᵻɚɝɡʔˈˌ]/;

function parseSayAs(raw) {
  let v = String(raw || '').trim();
  if (!v) return { kind: 'empty' };
  // /krænts/ and [krænts] are how transcriptions are usually written down.
  const unwrapped = v.replace(/^[/[]|[/\]]$/g, '').trim();
  if (IPA_CHARS.test(unwrapped)) return { kind: 'ipa', value: unwrapped };
  return { kind: 'respelling', value: v };
}

function set({ word, say_as, phonemes, note, description }) {
  const w = String(word || '').trim();
  if (!w) throw new Error('word is required');
  if (!String(say_as || '').trim() && !String(phonemes || '').trim()) {
    throw new Error('give either a respelling ("will key") or IPA ("/krænts/")');
  }
  // IPA typed into the respelling field is phonemes, not a respelling. Route it rather than
  // rejecting it for containing "characters that are not speakable letters", which is true
  // and useless.
  if (say_as) {
    const parsed = parseSayAs(say_as);
    if (parsed.kind === 'ipa') { phonemes = parsed.value; say_as = null; }
  }
  if (say_as) {
    const clean = sanitizeSayAs(say_as);
    if (!clean.ok) {
      throw new Error(`"${clean.value || say_as}" ${clean.problem || clean.error}. `
        + `say_as must be a single respelling that can be read aloud, e.g. "will key". `
        + `Put the explanation in description instead.`);
    }
    say_as = clean.value;
  }
  db.prepare(`
    INSERT INTO pronunciations (word, say_as, phonemes, note, description, updated_at)
    VALUES (@word, @say_as, @phonemes, @note, @description, datetime('now'))
    ON CONFLICT(word) DO UPDATE SET
      say_as=excluded.say_as, phonemes=excluded.phonemes,
      note=COALESCE(excluded.note, pronunciations.note),
      description=COALESCE(excluded.description, pronunciations.description),
      updated_at=datetime('now')
  `).run({ word: w, say_as: say_as || null, phonemes: phonemes || null,
           note: note || null, description: description || null });
  return get(w);
}

const get = word => db.prepare('SELECT * FROM pronunciations WHERE word=? COLLATE NOCASE').get(String(word || '').trim()) || null;
const remove = word => db.prepare('DELETE FROM pronunciations WHERE word=? COLLATE NOCASE').run(String(word || '').trim()).changes > 0;

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Rewrite text for speech. Whole words only and case-insensitive, so "Wilke" and "wilke"
// both match while "Wilkes" does not become "will keys".
//
// Substitutions never nest: each match is taken from the ORIGINAL text and the replacements
// are assembled in one pass, so a respelling containing another dictionary word cannot be
// rewritten again.
function apply(text, entries = all()) {
  let out = String(text == null ? '' : text);
  if (!entries.length || !out) return out;

  const spans = [];
  for (const e of entries) {
    const re = new RegExp(`\\b${escapeRe(e.word)}\\b`, 'gi');
    let m;
    while ((m = re.exec(out)) !== null) {
      spans.push({ start: m.index, end: m.index + m[0].length, entry: e });
      if (m.index === re.lastIndex) re.lastIndex++;   // zero-width guard
    }
  }
  if (!spans.length) return out;

  // Longest match wins where two entries overlap, then earliest.
  spans.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const chosen = [];
  let cursor = -1;
  for (const s of spans) {
    if (s.start < cursor) continue;
    chosen.push(s);
    cursor = s.end;
  }

  let result = '';
  let at = 0;
  for (const s of chosen) {
    result += out.slice(at, s.start);
    result += s.entry.phonemes
      ? `[${out.slice(s.start, s.end)}](/${s.entry.phonemes}/)`
      : s.entry.say_as;
    at = s.end;
  }
  result += out.slice(at);
  return result;
}

// Seeded once, so the voice says the gym correctly out of the box and there is a worked
// example to copy when adding more.
function seed() {
  try {
    const n = db.prepare('SELECT COUNT(*) n FROM pronunciations').get().n;
    if (n > 0) return;
    set({ word: 'Wilke', say_as: 'will key', phonemes: 'wˈɪlki', note: 'the gym; rhymes with milky' });
    console.log('[pronounce] seeded default pronunciations');
  } catch (e) {
    console.warn('[pronounce] seed failed:', e.message);
  }
}

module.exports = { all, get, set, remove, apply, seed, sanitizeSayAs, normalizeForG2P, parseSayAs };
