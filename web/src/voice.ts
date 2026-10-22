import { useCallback, useEffect, useRef, useState } from 'react';

/** The parts of the Web Speech API we use (not in every TypeScript DOM lib). */
interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => Recognition;

const speechWindow = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
const Ctor: RecognitionCtor | null = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;

export const recognitionSupported = Ctor !== null;

interface RecognitionHandlers {
  onInterim(text: string): void;
  onFinal(text: string): void;
  /** Ended without hearing anything. */
  onNothing(): void;
  onError(message: string): void;
}

/** One utterance per start(); stop() ends it early (push-to-talk release). */
export function useRecognition(handlers: RecognitionHandlers) {
  const ref = useRef<Recognition | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const [listening, setListening] = useState(false);

  const start = useCallback(() => {
    if (!Ctor || ref.current) return;
    const rec = new Ctor();
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    let finalText = '';
    let failed = false;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      handlersRef.current.onInterim((finalText + interim).trim());
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      failed = true;
      handlersRef.current.onError(
        e.error === 'not-allowed' || e.error === 'service-not-allowed'
          ? 'I need microphone access. Allow it in the address bar, or type instead.'
          : `I couldn't hear that. (${e.error})`,
      );
    };
    rec.onend = () => {
      ref.current = null;
      setListening(false);
      if (failed) return;
      const text = finalText.trim();
      if (text) handlersRef.current.onFinal(text);
      else handlersRef.current.onNothing();
    };
    ref.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      ref.current = null;
      setListening(false);
    }
  }, []);

  const stop = useCallback(() => ref.current?.stop(), []);

  useEffect(() => () => ref.current?.abort(), []);
  return { supported: recognitionSupported, listening, start, stop };
}

// ---------------------------------------------------------------------------
// Speaking

const PREFERRED_VOICES = ['Google US English', 'Microsoft Aria Online', 'Microsoft Jenny Online', 'Samantha', 'Microsoft Zira', 'Microsoft Aria'];

function pickVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  for (const name of PREFERRED_VOICES) {
    const v = voices.find((x) => x.name.startsWith(name));
    if (v) return v;
  }
  return voices.find((v) => v.lang === 'en-US') ?? voices.find((v) => v.lang.startsWith('en')) ?? null;
}

// Chrome loads voices asynchronously; ask early so the first reply has one.
window.speechSynthesis?.getVoices();

let current: { cancel(): void } | null = null;

/** Speaks `text`, calling onEnd exactly once when it finishes, fails, or is cancelled. */
export function speak(text: string, onEnd: () => void): void {
  stopSpeaking();
  const synth = window.speechSynthesis;
  let done = false;
  // Some browsers never fire onend; give up after a generous estimate.
  const safety = window.setTimeout(() => finish(), 2500 + text.split(/\s+/).length * 450);
  function finish() {
    if (done) return;
    done = true;
    window.clearTimeout(safety);
    current = null;
    onEnd();
  }
  current = {
    cancel: () => {
      synth?.cancel();
      finish();
    },
  };
  if (!synth) return;
  const u = new SpeechSynthesisUtterance(text);
  const voice = pickVoice();
  if (voice) u.voice = voice;
  u.lang = 'en-US';
  u.rate = 1.03;
  u.onend = finish;
  u.onerror = finish;
  synth.speak(u);
}

export function stopSpeaking(): void {
  current?.cancel();
}

// ---------------------------------------------------------------------------
// Earcon: the soft rising chime when the device starts listening.

let audio: AudioContext | null = null;

export function earcon(): void {
  try {
    audio ??= new AudioContext();
    const ctx = audio;
    [660, 990].forEach((freq, i) => {
      const t = ctx.currentTime + i * 0.09;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.07, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.25);
    });
  } catch {
    // No audio output: the light bar still shows it.
  }
}
