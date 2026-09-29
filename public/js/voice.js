// 🎙️ Voice bot – speech-to-text for describing the emergency and
// text-to-speech for first aid and turn-by-turn guidance.
// Uses the browser's Web Speech API (works on Android Chrome, which is what
// most people in rural MP use); degrades to typing where unsupported.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export const voiceInputSupported = Boolean(Recognition);
export const voiceOutputSupported = 'speechSynthesis' in window;

const LOCALE = { en: 'en-IN', hi: 'hi-IN' };

/**
 * Start listening. Calls onText(transcript, isFinal) as the user speaks.
 * Returns a stop() function.
 */
export function listen(lang, { onText, onEnd, onError }) {
  if (!Recognition) { onError?.('unsupported'); return () => {}; }
  const rec = new Recognition();
  rec.lang = LOCALE[lang] || 'hi-IN';
  rec.interimResults = true;
  rec.continuous = true;
  rec.maxAlternatives = 1;
  let finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += `${r[0].transcript} `;
      else interim += r[0].transcript;
    }
    onText?.((finalText + interim).trim(), !interim);
  };
  rec.onerror = (e) => onError?.(e.error);
  rec.onend = () => onEnd?.(finalText.trim());
  rec.start();
  return () => rec.stop();
}

let speaking = false;
function pickVoice(locale) {
  const voices = speechSynthesis.getVoices();
  return voices.find((v) => v.lang === locale) || voices.find((v) => v.lang.startsWith(locale.slice(0, 2)));
}

/** Speak one or more lines. Resolves when finished or stopped. */
export function speak(lines, lang = 'en') {
  if (!voiceOutputSupported) return Promise.resolve();
  stopSpeaking();
  const list = Array.isArray(lines) ? lines : [lines];
  const locale = LOCALE[lang] || 'en-IN';
  speaking = true;
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (!speaking || i >= list.length) { speaking = false; resolve(); return; }
      const u = new SpeechSynthesisUtterance(list[i++]);
      u.lang = locale;
      const v = pickVoice(locale);
      if (v) u.voice = v;
      u.rate = 0.95;
      u.onend = next;
      u.onerror = next;
      speechSynthesis.speak(u);
    };
    next();
  });
}

export function stopSpeaking() {
  speaking = false;
  if (voiceOutputSupported) speechSynthesis.cancel();
}

export const isSpeaking = () => speaking;
