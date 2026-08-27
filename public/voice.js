/* Maverick voice — two modes, deliberately separate.
 *
 *   Dictation    push to talk. Audio in, text into the composer, no assistant turn.
 *                This is the WhisperFlow-style typing replacement. It must never answer.
 *
 *   Conversation continuous hands-free. Stays on until you turn it off:
 *
 *      mic -> VAD -> Whisper -> /api/chat (SSE) -> sentence split -> TTS -> speaker
 *       ^                                                                     |
 *       +------------------- barge-in aborts everything --------------------- +
 *
 * Turn-end is detected in the browser, so silence never crosses the network and the loop
 * reacts in milliseconds rather than after a round trip.
 *
 * VAD is energy-based (Web Audio RMS with a hangover timer), not Silero. That is a
 * deliberate v1 trade: zero dependencies, nothing to vendor, and it is reliable in a quiet
 * room. It is worse than Silero in background noise. `detectSpeech` is the only place that
 * knows how speech is detected, so swapping in an ONNX VAD later is one function.
 *
 * Echo: the assistant's own audio reaches the mic and would look like barge-in. Handled by
 * asking for echoCancellation on the capture stream and by requiring a higher, sustained
 * energy to barge in than to start a normal turn. Headphones make it a non-issue.
 */
'use strict';

const VoiceCfg = {
  // RMS thresholds, 0..1. Tuned by ear on a laptop mic; exposed so they can be adjusted.
  speechThreshold: 0.018,
  bargeThreshold: 0.055,      // higher: must beat the assistant's own playback
  // Timings, ms.
  minSpeechMs: 250,           // ignore coughs, clicks, a chair creak
  hangoverMs: 900,            // silence this long ends the turn
  bargeSustainMs: 220,        // speech must persist this long to count as barge-in
  maxUtteranceMs: 30000,      // hard stop so a stuck mic cannot record forever
  analyserFft: 1024,
};

const SENTENCE_END = /([.!?]["')\]]?)(\s+|$)/;

// Hard ceiling on how much text goes to TTS in one request. Kokoro on CPU costs roughly
// 1.6s of fixed overhead plus 0.045s per character, so 460 characters is 25 seconds of
// silence before a single word is spoken.
//
// A sentence boundary is the preferred cut, but it cannot be the only one: the model
// sometimes answers with a markdown bullet list that contains no full stop at all, and then
// the whole reply becomes one chunk. This cap makes first-audio latency bounded by the cap
// rather than by the model's formatting.
const SPEAK_CHUNK_MAX = 140;
const SPEAK_CHUNK_MIN = 12;
// The first chunk alone decides how long you wait before hearing anything, so it is held
// shorter. Later chunks only have to keep pace with playback, and 140 characters of speech
// takes far longer to say than to synthesise, so the queue stays ahead.
const SPEAK_FIRST_MAX = 70;

/* How much of `text` is ready to speak. Returns 0 when nothing is.
 *
 *   final=false  streaming: only cut at a boundary we are sure of, because more text is coming
 *   final=true   flushing:  take what is left, still capped
 *
 * Preference order: sentence end, then clause end (comma / semicolon / colon / newline),
 * then a word boundary at the cap. Never returns a cut that splits a word. */
function chunkEnd(text, final, first) {
  if (!text) return 0;
  const cap = first ? SPEAK_FIRST_MAX : SPEAK_CHUNK_MAX;
  const trimmed = final ? text.trimEnd() : text;
  if (!trimmed.trim()) return final ? text.length : 0;

  const m = trimmed.match(SENTENCE_END);
  if (m && m.index + m[1].length >= SPEAK_CHUNK_MIN && m.index + m[1].length <= cap) {
    return m.index + m[1].length;
  }
  if (trimmed.length <= cap) {
    return final ? text.length : 0;   // wait for more unless this is the flush
  }

  // Over the cap. Cut at the last clause break inside it, else the last space.
  const head = trimmed.slice(0, cap);
  const clause = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '),
                          head.lastIndexOf(': '), head.lastIndexOf('\n'));
  if (clause >= SPEAK_CHUNK_MIN) return clause + 1;
  const space = head.lastIndexOf(' ');
  return space >= SPEAK_CHUNK_MIN ? space + 1 : cap;
}

class VoiceLoop {
  constructor({ onState, onTranscript, onToken, onReply, onError } = {}) {
    this.onState = onState || (() => {});
    this.onTranscript = onTranscript || (() => {});
    this.onToken = onToken || (() => {});
    this.onReply = onReply || (() => {});
    this.onError = onError || (() => {});

    this.mode = null;           // null | 'dictation' | 'conversation'
    this.state = 'idle';
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
    this.recorder = null;
    this.chunks = [];
    this.rafId = null;

    this.speechStartedAt = 0;
    this.lastVoiceAt = 0;
    this.utteranceStartedAt = 0;

    this.audioEl = null;
    this.audioQueue = [];
    this.playing = false;
    this.abortCtl = null;
    this.stopping = false;
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.onState(s);
  }

  // ---- capture ------------------------------------------------------------------------

  async openMic() {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,   // keeps the assistant's own voice out of the barge-in path
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = VoiceCfg.analyserFft;
    src.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
  }

  closeMic() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.recorder && this.recorder.state !== 'inactive') {
      try { this.recorder.stop(); } catch (_) {}
    }
    this.recorder = null;
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null;
    if (this.ctx) { try { this.ctx.close(); } catch (_) {} }
    this.ctx = null;
    this.analyser = null;
  }

  rms() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    return Math.sqrt(sum / this.buf.length);
  }

  pickMime() {
    const want = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    for (const m of want) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    return '';
  }

  startRecorder() {
    this.chunks = [];
    const mimeType = this.pickMime();
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.recorder.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.recorder.start();
    this.utteranceStartedAt = performance.now();
  }

  // Stop the recorder and hand back the complete blob. The recorder runs across the whole
  // listening window, so the blob holds leading silence, the utterance, and the trailing
  // silence. Whisper is unbothered by the silence and nothing gets clipped off the front,
  // which is what happens if you only start recording once speech is detected.
  stopRecorder() {
    return new Promise(resolve => {
      if (!this.recorder || this.recorder.state === 'inactive') return resolve(null);
      const type = this.recorder.mimeType || 'audio/webm';
      this.recorder.onstop = () => resolve(this.chunks.length ? new Blob(this.chunks, { type }) : null);
      try { this.recorder.stop(); } catch (_) { resolve(null); }
    });
  }

  // ---- the VAD tick -------------------------------------------------------------------

  detectSpeech(level, threshold) { return level > threshold; }

  tick() {
    if (this.stopping) return;
    this.rafId = requestAnimationFrame(() => this.tick());
    const level = this.rms();
    const now = performance.now();

    // Barge-in: the assistant is talking and you started talking over it.
    if (this.playing) {
      if (this.detectSpeech(level, VoiceCfg.bargeThreshold)) {
        if (!this.bargeFrom) this.bargeFrom = now;
        else if (now - this.bargeFrom > VoiceCfg.bargeSustainMs) {
          this.bargeFrom = 0;
          this.bargeIn();
        }
      } else {
        this.bargeFrom = 0;
      }
      return;
    }

    if (this.state !== 'listening') return;

    if (this.detectSpeech(level, VoiceCfg.speechThreshold)) {
      if (!this.speechStartedAt) this.speechStartedAt = now;
      this.lastVoiceAt = now;
      return;
    }

    // Silence. End the turn if we heard enough and it has been quiet long enough.
    if (this.speechStartedAt
        && now - this.lastVoiceAt > VoiceCfg.hangoverMs
        && this.lastVoiceAt - this.speechStartedAt > VoiceCfg.minSpeechMs) {
      this.endUtterance();
      return;
    }
    // Runaway guard.
    if (this.speechStartedAt && now - this.utteranceStartedAt > VoiceCfg.maxUtteranceMs) {
      this.endUtterance();
    }
  }

  // ---- conversation mode --------------------------------------------------------------

  async startConversation(conversationId) {
    this.mode = 'conversation';
    this.conversationId = conversationId || 'web';
    this.stopping = false;
    try {
      await this.openMic();
    } catch (e) {
      this.onError('Microphone permission is needed for conversation mode.');
      this.setState('idle');
      return false;
    }
    this.listen();
    this.tick();
    return true;
  }

  listen() {
    this.speechStartedAt = 0;
    this.lastVoiceAt = 0;
    this.bargeFrom = 0;
    if (this.stream) this.startRecorder();
    this.setState('listening');
  }

  async endUtterance() {
    this.setState('transcribing');
    const blob = await this.stopRecorder();
    if (!blob || blob.size < 1200) { this.listen(); return; }

    let transcript = '';
    try {
      const r = await fetch('/api/voice/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'audio/webm' },
        body: blob,
      });
      if (!r.ok) throw new Error('stt ' + r.status);
      ({ transcript } = await r.json());
    } catch (e) {
      this.onError('Could not transcribe that.');
      if (this.mode === 'conversation' && !this.stopping) this.listen();
      return;
    }

    transcript = (transcript || '').trim();
    // Whisper emits "you", "Thank you." and similar for pure silence or a breath. Dropping
    // sub-two-character noise stops the loop talking to itself.
    if (transcript.length < 2) { if (!this.stopping) this.listen(); return; }

    this.onTranscript(transcript);
    if (this.mode !== 'conversation' || this.stopping) return;
    await this.askAndSpeak(transcript);
  }

  async askAndSpeak(text) {
    this.setState('thinking');
    this.abortCtl = new AbortController();
    this.audioQueue = [];
    let spoken = 0;         // chars already handed to TTS
    let reply = '';

    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: this.conversationId, message: text, voice: true }),
        signal: this.abortCtl.signal,
      });
      if (!r.ok) throw new Error('chat ' + r.status);

      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 2);
          if (!frame.startsWith('data:')) continue;
          let ev;
          try { ev = JSON.parse(frame.slice(5).trim()); } catch (_) { continue; }

          if (ev.type === 'token') {
            reply += ev.text;
            this.onToken(ev.text);
            // Speak each chunk as soon as it is complete, so the first one plays while the
            // rest is still being generated.
            for (;;) {
              const cut = chunkEnd(reply.slice(spoken), false, spoken === 0);
              if (cut <= 0) break;
              this.enqueueSpeech(reply.slice(spoken, spoken + cut));
              spoken += cut;
            }
          } else if (ev.type === 'discard') {
            // Server discarded the invented answer. Drop anything queued for speech that
            // came from it, so it is never spoken.
            reply = ''; spoken = 0;
            this.audioQueue = [];
          } else if (ev.type === 'tool_start') {
            this.onState('working:' + ev.tool);
          } else if (ev.type === 'done') {
            if (ev.reply && ev.reply.length > reply.length) reply = ev.reply;   // non-streamed round
            this.onReply(ev.reply || reply, ev);
          } else if (ev.type === 'error') {
            throw new Error(ev.message || ev.error);
          }
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') return;              // barge-in, already handled
      this.onError(e.message || 'The assistant did not answer.');
      if (!this.stopping) this.listen();
      return;
    }

    // Flush the tail, still respecting the cap so a bullet-list ending cannot produce one
    // enormous final request.
    let rest = reply.slice(spoken);
    for (;;) {
      const cut = chunkEnd(rest, true, spoken === 0 && rest.length === reply.length - spoken);
      if (cut <= 0) break;
      this.enqueueSpeech(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (!this.audioQueue.length && !this.playing && !this.stopping) this.listen();
  }

  // ---- speech out ---------------------------------------------------------------------

  enqueueSpeech(text) {
    const clean = String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      // Bullets read as a run-on without this: turn "- item" into "item." so the voice
      // pauses between entries. The model is asked not to emit lists in voice mode, but it
      // does anyway often enough that the client has to cope.
      .replace(/^[ \t]*[-*•]\s+/gm, '')
      .replace(/^[ \t]*\d+[.)]\s+/gm, '')
      .replace(/\n{2,}/g, '. ')
      .replace(/\n/g, '. ')
      .replace(/https?:\/\/\S+/g, 'a link')
      .replace(/[*_#`>|]/g, '')
      .replace(/\.\s*\./g, '.')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) return;
    // Kick off synthesis immediately; play in order.
    const job = fetch('/api/voice/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clean }),
    }).then(r => r.ok ? r.blob() : null).catch(() => null);
    this.audioQueue.push(job);
    if (!this.playing) this.drainAudio();
  }

  async drainAudio() {
    this.playing = true;
    this.setState('speaking');
    while (this.audioQueue.length && !this.stopping) {
      const blob = await this.audioQueue.shift();
      if (!blob) continue;
      await this.playBlob(blob);
    }
    this.playing = false;
    if (this.mode === 'conversation' && !this.stopping) this.listen();
  }

  playBlob(blob) {
    return new Promise(resolve => {
      const url = URL.createObjectURL(blob);
      this.audioEl = new Audio(url);
      this.audioEl.onended = this.audioEl.onerror = () => { URL.revokeObjectURL(url); resolve(); };
      this.audioEl.play().catch(() => { URL.revokeObjectURL(url); resolve(); });
    });
  }

  bargeIn() {
    // Kill the audio and the in-flight generation, then go straight back to listening.
    // Without this, hands-free is unusable the first time it says something wrong.
    if (this.audioEl) { try { this.audioEl.pause(); } catch (_) {} this.audioEl = null; }
    this.audioQueue = [];
    this.playing = false;
    if (this.abortCtl) { try { this.abortCtl.abort(); } catch (_) {} this.abortCtl = null; }
    this.listen();
  }

  stop() {
    this.stopping = true;
    this.mode = null;
    if (this.abortCtl) { try { this.abortCtl.abort(); } catch (_) {} this.abortCtl = null; }
    if (this.audioEl) { try { this.audioEl.pause(); } catch (_) {} this.audioEl = null; }
    this.audioQueue = [];
    this.playing = false;
    this.closeMic();
    this.setState('idle');
  }

  // ---- dictation mode -----------------------------------------------------------------
  // Push to talk. Never fires an assistant turn: the transcript goes to the caller and the
  // caller puts it in the composer.

  async startDictation() {
    this.mode = 'dictation';
    this.stopping = false;
    try { await this.openMic(); }
    catch (e) { this.onError('Microphone permission is needed for dictation.'); return false; }
    this.startRecorder();
    this.setState('dictating');
    return true;
  }

  async stopDictation() {
    if (this.mode !== 'dictation') return '';
    this.setState('transcribing');
    const blob = await this.stopRecorder();
    this.closeMic();
    this.mode = null;
    if (!blob || blob.size < 1200) { this.setState('idle'); return ''; }
    try {
      const r = await fetch('/api/voice/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'audio/webm' },
        body: blob,
      });
      const { transcript } = await r.json();
      this.setState('idle');
      const t = (transcript || '').trim();
      if (t) this.onTranscript(t);
      return t;
    } catch (e) {
      this.onError('Could not transcribe that.');
      this.setState('idle');
      return '';
    }
  }
}

window.VoiceLoop = VoiceLoop;
window.VoiceCfg = VoiceCfg;
