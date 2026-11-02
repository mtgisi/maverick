// Deterministic parsing of plain health statements: "I lifted for 45 minutes", "drank 24 oz
// of water", "slept 7 and a half hours", "log 650 calories and 40g protein", "undo that".
//
// Why this exists. Measured 2026-11-02 against qwen2.5:7b with log_health in front of it:
// of nine plain statements it called the tool for ONE. For the rest it replied "Logged a
// workout" / "Cleared the last entry" with no call at all. These numbers go to friends via
// the accountability bot, so the model cannot be the thing that decides whether a number
// was recorded. Same principle as brain/time.js: resolve it in code, let the model phrase.
//
// The parser is deliberately conservative. Anything it is not sure about returns null and
// goes to the model as before (where the false-claim guard in brain/index.js still applies):
//   - questions                         ("how many calories have I had?")
//   - negation or future intent         ("I didn't work out", "going to lift later")
//   - messages that also ask for something else ("... and what's on my calendar")
//   - statements with no number where one is needed ("had a burrito")

const WORDNUM = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45,
  fifty: 50, sixty: 60, ninety: 90,
};

const QUESTION = /\?\s*$|^(how|what|when|where|which|who|why|did i|have i|am i|do i|was i|is|are|can|could|should|tell me|show me)\b/;
const NEGATION = /\b(didn'?t|did not|haven'?t|have not|hasn'?t|not|never|no|skip(ped)?|missed|won'?t|can'?t|couldn'?t)\b/;
const FUTURE = /\b(going to|gonna|will|plan(ning)? to|later|tomorrow|tonight i'?ll|remind me|should i|want to|need to)\b/;
// A second request riding along. The shortcut would answer the health half and drop it.
const OTHER_ASK = /\b(and (what|how|when|is|are|can|tell|show|check)|also|calendar|schedule|task|email|mail|remind|meeting|timesheet)\b/;

const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)`;
const num = s => Number(String(s).replace(/,/g, ''));

function normalise(text) {
  let t = ' ' + String(text || '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim() + ' ';
  // "seven and a half hours" -> "7.5 hours"; "an hour" -> "60 minutes"
  for (const [w, n] of Object.entries(WORDNUM)) t = t.replace(new RegExp(`\\b${w}\\b`, 'g'), String(n));
  t = t.replace(/(\d+) and a half/g, (_, n) => String(Number(n) + 0.5));
  t = t.replace(/\b(an|one) hour and a half\b/g, '90 minutes');
  t = t.replace(/\bhalf an hour\b|\ba half hour\b/g, '30 minutes');
  t = t.replace(/\b(an|one|a full) hour\b/g, '60 minutes');
  return t;
}

const WORKOUT_VERBS = [
  [/\b(lifted|lifting|lift(ed)? weights|weightlifting|weights)\b/, 'lifting'],
  [/\b(ran|jogged|went (for a|on a) (run|jog))\b/, 'run'],
  [/\b(biked|cycled|rode my bike|went (for a|on a) (bike ride|ride))\b/, 'bike'],
  [/\b(swam|went swimming)\b/, 'swim'],
  [/\b(hiked|went (for a|on a) hike)\b/, 'hike'],
  [/\b(did|went to|had) (a )?yoga\b|\byoga\b/, 'yoga'],
  [/\b(did|went to|had) (some )?cardio\b|\bcardio\b/, 'cardio'],
  [/\bplayed (basketball|soccer|tennis|volleyball|pickleball|hockey|football|racquetball)\b/, null],
  [/\b(worked out|did my workout|did a workout|finished my workout|hit the gym|went to the gym|gym session|workout)\b/, 'workout'],
];

// Parse a health statement into log_health arguments, or null.
function parseLog(message) {
  const raw = String(message || '');
  const t = normalise(raw);
  const plain = t.trim();
  if (!plain || QUESTION.test(plain) || NEGATION.test(t) || FUTURE.test(t) || OTHER_ASK.test(t)) return null;

  const args = {};
  let m;

  if ((m = t.match(new RegExp(`${NUM}\\s*(?:k?cals?|calories?|kcal)\\b`)))) args.calories = num(m[1]);
  if ((m = t.match(new RegExp(`${NUM}\\s*(?:g|grams?|gs)\\s*(?:of\\s+)?protein\\b`)))
      || (m = t.match(new RegExp(`\\bprotein\\s*(?:of\\s*)?${NUM}\\s*(?:g|grams?)?\\b`)))) args.protein_g = num(m[1]);
  if ((m = t.match(new RegExp(`${NUM}\\s*(?:oz|ounces?|fl oz)\\s*(?:of\\s+)?water\\b`)))
      || (m = t.match(new RegExp(`\\b(?:drank|drink|had)\\s+${NUM}\\s*(?:oz|ounces?)\\b`)))) args.water_oz = num(m[1]);
  if ((m = t.match(new RegExp(`${NUM}\\s*steps\\b`)))) args.steps = num(m[1]);
  if ((m = t.match(new RegExp(`\\bslept\\s+(?:for\\s+)?(?:about\\s+|around\\s+)?${NUM}\\s*(?:hours?|hrs?|h)\\b`)))
      || (m = t.match(new RegExp(`${NUM}\\s*(?:hours?|hrs?)\\s+of\\s+sleep\\b`)))) args.sleep_hours = num(m[1]);
  if ((m = t.match(new RegExp(`\\bweigh(?:ed)?(?:\\s+in)?\\s+(?:at\\s+)?${NUM}\\s*(?:lbs?|pounds)?\\b`)))
      || (m = t.match(new RegExp(`\\b(?:my\\s+)?weight\\s+(?:is|was|today is)\\s+${NUM}\\b`)))
      || (m = t.match(new RegExp(`\\bweigh-?in(?:\\s+(?:at|of|is|was))?\\s+${NUM}\\b`)))) args.weight_lb = num(m[1]);

  // Workout: needs a workout verb. Minutes and distance are optional.
  for (const [re, label] of WORKOUT_VERBS) {
    const w = t.match(re);
    if (!w) continue;
    let name = label || w[1];
    const dist = t.match(new RegExp(`${NUM}\\s*(miles?|mi|k|km)\\b`));
    if (dist && (name === 'run' || name === 'bike' || name === 'hike' || name === 'swim')) {
      name = `${num(dist[1])} ${dist[2].startsWith('mi') ? 'mile' : 'km'} ${name}`;
    }
    args.workout = name;
    const mins = t.match(new RegExp(`${NUM}\\s*(?:min(?:ute)?s?)\\b`));
    const hrs = !args.sleep_hours && t.match(new RegExp(`(?:for\\s+)?${NUM}\\s*(?:hours?|hrs?)\\b`));
    if (mins) args.workout_minutes = num(mins[1]);
    else if (hrs) args.workout_minutes = Math.round(num(hrs[1]) * 60);
    break;
  }

  // Habit: "did my <thing>" (not a workout), "meditated".
  if (!args.workout) {
    if ((m = t.match(/\bdid my ([a-z][a-z -]{1,30}?)(?: (?:today|this morning|this evening|tonight|already|just now))?\s*$/))) {
      args.habit = m[1].trim();
    } else if (/\bmeditated\b/.test(t)) {
      args.habit = 'meditation';
    }
  }

  if (!Object.keys(args).length) return null;
  if (/\byesterday\b/.test(t)) args.day = 'yesterday';
  return args;
}

// "undo that", "scratch that", "take that back", "delete the last entry".
// Only when health is plausibly what "that" refers to; the caller passes that in.
const UNDO = /^(please |ok |okay )?(undo|scratch|take (that|it) back|delete|remove|cancel)\b/;
function isUndo(message, healthInScope) {
  const t = normalise(message).trim();
  if (!UNDO.test(t) || QUESTION.test(t)) return false;
  if (/\b(task|reminder|memory|event|meeting|email|draft)\b/.test(t)) return false;
  return healthInScope || /\b(health|calorie|calories|protein|water|workout|entry|log|steps|sleep|weight|habit)\b/.test(t);
}

module.exports = { parseLog, isUndo, normalise, QUESTION };
