// Saying money out loud — smoother (25 Oct 2026). What made it sound robotic, and what this does instead:
// - Hinglish was written in English letters and read by a Hindi voice → now Hindi and Hinglish are SPOKEN from Hindi
//   script (the words on screen don't change).
// - Digits like "125000" were read out as a number → now Indian words: "एक लाख पच्चीस हज़ार" / "one lakh twenty-five thousand".
// - The first voice on the phone was used → now the best one (iPhone Enhanced / Premium, Android Google, Windows Natural),
//   or the one the person picked in More, at a calm speed.
// - Short names in shop names are said in full ("Engg" → "Engineering").
// Pure functions are exported for tests; nothing here throws.

const HI = ('शून्य एक दो तीन चार पाँच छह सात आठ नौ दस ग्यारह बारह तेरह चौदह पंद्रह सोलह सत्रह अठारह उन्नीस '
  + 'बीस इक्कीस बाईस तेईस चौबीस पच्चीस छब्बीस सत्ताईस अट्ठाईस उनतीस तीस इकतीस बत्तीस तैंतीस चौंतीस पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस '
  + 'चालीस इकतालीस बयालीस तैंतालीस चवालीस पैंतालीस छियालीस सैंतालीस अड़तालीस उनचास पचास इक्यावन बावन तिरपन चौवन पचपन छप्पन सत्तावन अट्ठावन उनसठ '
  + 'साठ इकसठ बासठ तिरसठ चौंसठ पैंसठ छियासठ सड़सठ अड़सठ उनहत्तर सत्तर इकहत्तर बहत्तर तिहत्तर चौहत्तर पचहत्तर छिहत्तर सतहत्तर अठहत्तर उन्यासी '
  + 'अस्सी इक्यासी बयासी तिरासी चौरासी पचासी छियासी सत्तासी अट्ठासी नवासी नब्बे इक्यानवे बानवे तिरानवे चौरानवे पचानवे छियानवे सत्तानवे अट्ठानवे निन्यानवे').split(' ');
export const HINDI_0_99 = HI;

/** 125000 → "एक लाख पच्चीस हज़ार" (Indian grouping: करोड़, लाख, हज़ार, सौ). */
export function hindiNumber(n) {
  n = Math.floor(Math.abs(Number(n) || 0));
  if (n < 100) return HI[n];
  const parts = [];
  const crore = Math.floor(n / 1e7);
  const lakh = Math.floor((n % 1e7) / 1e5);
  const th = Math.floor((n % 1e5) / 1000);
  const sau = Math.floor((n % 1000) / 100);
  const rest = n % 100;
  if (crore) parts.push(`${hindiNumber(crore)} करोड़`);
  if (lakh) parts.push(`${HI[lakh]} लाख`);
  if (th) parts.push(`${HI[th]} हज़ार`);
  if (sau) parts.push(`${HI[sau]} सौ`);
  if (rest) parts.push(HI[rest]);
  return parts.join(' ');
}

const ONES = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ');
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const en99 = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ''}`);
/** 125000 → "one lakh twenty-five thousand" (how money is said in India). */
export function englishNumber(n) {
  n = Math.floor(Math.abs(Number(n) || 0));
  if (n < 100) return en99(n);
  const parts = [];
  const crore = Math.floor(n / 1e7);
  const lakh = Math.floor((n % 1e7) / 1e5);
  const th = Math.floor((n % 1e5) / 1000);
  const hu = Math.floor((n % 1000) / 100);
  const rest = n % 100;
  if (crore) parts.push(`${englishNumber(crore)} crore`);
  if (lakh) parts.push(`${en99(lakh)} lakh`);
  if (th) parts.push(`${en99(th)} thousand`);
  if (hu) parts.push(`${ONES[hu]} hundred`);
  if (rest) parts.push(en99(rest));
  return parts.join(' ');
}

/** Short forms in shop names, said in full. */
const SAY_FULL = [[/\bEngg\.?(?=\s|$)/gi, 'Engineering'], [/\bPvt\.?(?=\s|$)/gi, 'Private'], [/\bLtd\.?(?=\s|$)/gi, 'Limited'],
  [/\bCo\.(?=\s|$)/gi, 'Company'], [/\bBros\.?(?=\s|$)/gi, 'Brothers'], [/\bInds?\.?(?=\s|$)/gi, 'Industries'], [/\s&\s/g, ' and ']];
export const sayName = (name) => SAY_FULL.reduce((s, [re, w]) => s.replace(re, w), String(name || '').trim()).replace(/\s+/g, ' ');

/**
 * The sentence to SAY for money received. how: 'hi' | 'hn' | 'en'. Hindi and Hinglish are both spoken in Hindi script
 * (a Hindi voice reads it naturally). Returns { text, voiceLang: 'hi' | 'en' }.
 */
export function moneySpeech(how, amount, customer) {
  const rs = Math.round(Number(amount) || 0);
  const who = sayName(customer);
  if (how === 'en') return { voiceLang: 'en', text: `Received ${englishNumber(rs)} ${rs === 1 ? 'rupee' : 'rupees'}${who ? ` from ${who}` : ''}.` };
  return { voiceLang: 'hi', text: who ? `${who} से, ${hindiNumber(rs)} रुपये मिल गए।` : `${hindiNumber(rs)} रुपये मिल गए।` };
}

// ---------------------------------------------------------------- the voice
/** How good a voice sounds for this language (higher is better; < 0 = wrong language). */
export function voiceScore(v, code) {
  const l = String(v?.lang || '').replace('_', '-').toLowerCase();
  const want = code.toLowerCase();
  if (!l) return -1;
  let s = l === want ? 100 : l.slice(0, 2) === want.slice(0, 2) ? 60 : -1;
  if (s < 0) return s;
  const n = `${v.name || ''} ${v.voiceURI || ''}`.toLowerCase();
  if (/premium/.test(n)) s += 40;
  if (/enhanced/.test(n)) s += 35;
  if (/natural|neural/.test(n)) s += 35;          // Windows / Edge: "Microsoft Swara Online (Natural)"
  if (/google/.test(n)) s += 20;                  // Android / Chrome
  if (/online|network/.test(n)) s += 8;
  if (/compact|espeak|eloquence|speech\.synthesis\.voice/.test(n)) s -= 30;   // flat robot voices, iPhone joke voices
  if (v.default) s += 2;
  return s;
}
/** Is this one of the clearer voices (worth saying "better" next to it)? */
export const isClearVoice = (v) => /premium|enhanced|natural|neural/i.test(`${v?.name || ''} ${v?.voiceURI || ''}`);
/** The voices for a language, best first. */
export const rankVoices = (voices, code) => (voices || []).map((v) => [voiceScore(v, code), v]).filter(([s]) => s >= 0).sort((a, b) => b[0] - a[0]).map(([, v]) => v);
/** The voice to use: the one picked (if it is still on the phone and speaks this language), else the best. */
export function pickVoice(voices, code, chosen) {
  const ranked = rankVoices(voices, code);
  return (chosen && ranked.find((v) => v.voiceURI === chosen)) || ranked[0] || null;
}
export const RATES = { normal: 0.92, slow: 0.78 };

export const canSpeak = () => typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
let voices = [];
const loadVoices = () => { try { voices = window.speechSynthesis.getVoices() || []; } catch { voices = []; } return voices; };
if (canSpeak()) { try { window.speechSynthesis.addEventListener('voiceschanged', loadVoices); loadVoices(); } catch { /* old browser */ } }
/** The voices on this phone for 'hi' / 'en', best first (for the chooser in More). */
export const phoneVoices = (voiceLang) => (canSpeak() ? rankVoices(loadVoices(), voiceLang === 'en' ? 'en-IN' : 'hi-IN') : []);
/** Voices arrive a moment after the app opens on some phones: wait for them (a little), then go on. */
export function voicesReady(ms = 1200) {
  if (!canSpeak() || loadVoices().length) return Promise.resolve();
  return new Promise((done) => {
    const t = setTimeout(done, ms);
    try { window.speechSynthesis.addEventListener('voiceschanged', () => { clearTimeout(t); loadVoices(); done(); }, { once: true }); } catch { /* */ }
  });
}

/**
 * Say a sentence. voiceLang 'hi' | 'en'; opts { voice: voiceURI picked in More, rate: 'normal' | 'slow' }.
 * Speaks at once when the voices are there (an iPhone wants it straight after the tap), otherwise as soon as they are.
 */
export function say(text, voiceLang = 'hi', opts = {}) {
  if (!canSpeak() || !text) return false;
  const go = () => {
    try {
      const ss = window.speechSynthesis;
      const code = voiceLang === 'en' ? 'en-IN' : 'hi-IN';
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice(voices, code, opts.voice);
      u.lang = v?.lang || code;
      if (v) u.voice = v;
      u.rate = RATES[opts.rate] || RATES.normal; u.pitch = 1; u.volume = 1;
      const speak = () => { try { ss.resume?.(); ss.speak(u); } catch { /* */ } };
      if (ss.speaking || ss.pending) { ss.cancel(); setTimeout(speak, 90); } else speak();   // Chrome drops a sentence spoken right after cancel
    } catch { /* never break the screen for the voice */ }
  };
  if (loadVoices().length) go(); else voicesReady().then(go);
  return true;
}

/** iPhone: the first sentence must come from a tap. A silent one on the first tap lets later ones (after saving) speak. */
let primed = false;
export function primeSpeech() {
  if (primed || !canSpeak()) return;
  primed = true;
  try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; window.speechSynthesis.speak(u); } catch { /* */ }
}
