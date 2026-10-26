// Saying money out loud (lib/speech.js, 25 Oct 2026): Indian number words, the spoken sentence, the voice picked.
// Run: node --test apps/web/test/speech.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { HINDI_0_99, hindiNumber, englishNumber, sayName, moneySpeech, voiceScore, rankVoices, pickVoice, isClearVoice, RATES } from '../src/lib/speech.js';

test('Hindi words for 0–99 are all there, in order', () => {
  assert.equal(HINDI_0_99.length, 100);
  assert.equal(HINDI_0_99[0], 'शून्य');
  assert.equal(HINDI_0_99[45], 'पैंतालीस');
  assert.equal(HINDI_0_99[99], 'निन्यानवे');
  assert.equal(new Set(HINDI_0_99).size, 100, 'no word twice');
});

test('amounts in Hindi the Indian way (लाख, हज़ार, सौ)', () => {
  assert.equal(hindiNumber(0), 'शून्य');
  assert.equal(hindiNumber(7), 'सात');
  assert.equal(hindiNumber(100), 'एक सौ');
  assert.equal(hindiNumber(1500), 'एक हज़ार पाँच सौ');
  assert.equal(hindiNumber(45000), 'पैंतालीस हज़ार');
  assert.equal(hindiNumber(125000), 'एक लाख पच्चीस हज़ार');
  assert.equal(hindiNumber(1430), 'एक हज़ार चार सौ तीस');
  assert.equal(hindiNumber(9999999), 'निन्यानवे लाख निन्यानवे हज़ार नौ सौ निन्यानवे');
  assert.equal(hindiNumber(25000000), 'दो करोड़ पचास लाख');
});

test('amounts in English the Indian way (lakh, crore)', () => {
  assert.equal(englishNumber(0), 'zero');
  assert.equal(englishNumber(21), 'twenty-one');
  assert.equal(englishNumber(45000), 'forty-five thousand');
  assert.equal(englishNumber(125000), 'one lakh twenty-five thousand');
  assert.equal(englishNumber(1430), 'one thousand four hundred thirty');
  assert.equal(englishNumber(10000000), 'one crore');
});

test('shop names said in full', () => {
  assert.equal(sayName('Gupta Engg'), 'Gupta Engineering');
  assert.equal(sayName('Rana Tools Pvt. Ltd.'), 'Rana Tools Private Limited');
  assert.equal(sayName('Sharma & Sons'), 'Sharma and Sons');
  assert.equal(sayName('Engineers Point'), 'Engineers Point', 'a real word is left alone');
});

test('the sentence: Hindi and Hinglish are SPOKEN in Hindi script, English in English', () => {
  assert.deepEqual(moneySpeech('hi', 125000, 'Sharma ji'), { voiceLang: 'hi', text: 'Sharma ji से, एक लाख पच्चीस हज़ार रुपये मिल गए।' });
  assert.deepEqual(moneySpeech('hn', 45000.4, 'Gupta Engg'), { voiceLang: 'hi', text: 'Gupta Engineering से, पैंतालीस हज़ार रुपये मिल गए।' });
  assert.deepEqual(moneySpeech('hi', 500, ''), { voiceLang: 'hi', text: 'पाँच सौ रुपये मिल गए।' });
  assert.deepEqual(moneySpeech('en', 125000, 'Sharma ji'), { voiceLang: 'en', text: 'Received one lakh twenty-five thousand rupees from Sharma ji.' });
  assert.equal(moneySpeech('en', 1, null).text, 'Received one rupee.');
  assert.ok(!/\d/.test(moneySpeech('hn', 98765, 'X').text), 'no digits are read out');
});

const V = (name, lang, voiceURI = name, extra = {}) => ({ name, lang, voiceURI, ...extra });
test('the best voice: clearer ones first, the right language only', () => {
  const iphone = [V('Samantha', 'en-US'), V('Lekha', 'hi-IN', 'com.apple.voice.compact.hi-IN.Lekha'), V('Lekha (Enhanced)', 'hi-IN', 'com.apple.voice.enhanced.hi-IN.Lekha'),
    V('Bells', 'en-US', 'com.apple.speech.synthesis.voice.Bells'), V('Rishi', 'en-IN')];
  assert.equal(pickVoice(iphone, 'hi-IN').name, 'Lekha (Enhanced)');
  assert.equal(pickVoice(iphone, 'en-IN').name, 'Rishi', 'Indian English before American');
  assert.equal(rankVoices(iphone, 'hi-IN').length, 2, 'only Hindi voices for Hindi');
  const android = [V('Google हिन्दी', 'hi-IN'), V('hi-in-x-hia-local', 'hi-IN'), V('English United States', 'en-US')];
  assert.equal(pickVoice(android, 'hi-IN').name, 'Google हिन्दी');
  const windows = [V('Microsoft Kalpana - Hindi (India)', 'hi-IN'), V('Microsoft Swara Online (Natural) - Hindi (India)', 'hi-IN')];
  assert.equal(pickVoice(windows, 'hi-IN').name, 'Microsoft Swara Online (Natural) - Hindi (India)');
  assert.ok(isClearVoice(windows[1]) && !isClearVoice(windows[0]));
  assert.equal(voiceScore(V('x', 'hi_IN'), 'hi-IN') >= 100, true, 'Android writes hi_IN');
  assert.equal(pickVoice([], 'hi-IN'), null);
});

test('the voice the person picked wins — if it is still on the phone and speaks the language', () => {
  const vs = [V('Lekha', 'hi-IN', 'a'), V('Lekha (Enhanced)', 'hi-IN', 'b'), V('Rishi', 'en-IN', 'c')];
  assert.equal(pickVoice(vs, 'hi-IN', 'a').voiceURI, 'a');
  assert.equal(pickVoice(vs, 'hi-IN', 'gone').voiceURI, 'b', 'removed voice → the best');
  assert.equal(pickVoice(vs, 'hi-IN', 'c').voiceURI, 'b', 'an English voice is not used for Hindi');
});

test('speeds', () => { assert.ok(RATES.slow < RATES.normal && RATES.normal < 1); });
