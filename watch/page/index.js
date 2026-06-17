import { createWidget, deleteWidget, widget, align, text_style } from '@zos/ui';
import { BasePage } from '@zeppos/zml/base-page';
import { API_BASE, DEVICE_TOKEN } from '../config';

// Voice: record Opus with @zos/media -> read bytes with @zos/fs -> base64 -> zml httpRequest to
// /api/device/transcribe (server runs Whisper + the assistant). Errors surface on-screen for fast debugging.

const W = 480, C = 240;
const GOLD = 0xe6a92c, COPPER = 0xcf9f5a, SAGE = 0x9ca980, BLUE = 0x7e93b0, RED = 0xcf8a6a;
const INK = 0xf4eee2, MUTED = 0xa39b8b, DIM = 0x6f6a5e;
const BG = 0x0f0c07, CARD = 0x2b2620, CARD_PRESS = 0x3a352c, LEAD = 0x3a2c14, DARKBTN = 0x1f1a12;
const PAGES = 5;
const REC_PATH = 'data://maverick_rec.opus';   // recorder target
const FS_PATH = 'maverick_rec.opus';            // same file, read via @zos/fs

// lazy-loaded native modules (wrapped so a missing API doesn't blank the page)
let media = null, fs = null;
try { media = require('@zos/media'); } catch (e) {}
try { fs = require('@zos/fs'); } catch (e) {}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function toB64(bytes) {
  let o = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = i + 1 < bytes.length ? bytes[i + 1] : 0, c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    o += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)] +
      (i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '=') +
      (i + 2 < bytes.length ? B64[c & 63] : '=');
  }
  return o;
}

Page(
  BasePage({
    state: { inApp: false, page: 0, recording: false, busy: false, transcript: '', reply: '', err: '', water: 5,
      wtasks: [{ id: 1, t: 'Pack tide charts', d: false }, { id: 2, t: 'Flash firmware', d: false }, { id: 3, t: 'Send invoice', d: false }] },

    build() { this.w = []; this.render(); },

    add(x) { this.w.push(x); return x; },
    clear() { (this.w || []).forEach((x) => { try { deleteWidget(x); } catch (e) {} }); this.w = []; },
    txt(o) { return this.add(createWidget(widget.TEXT, Object.assign({ align_h: align.CENTER_H, align_v: align.CENTER_V, text_style: text_style.NONE, color: INK }, o))); },
    fill(o) { return this.add(createWidget(widget.FILL_RECT, o)); },
    btn(o, fn) { return this.add(createWidget(widget.BUTTON, Object.assign({ radius: 18, normal_color: CARD, press_color: CARD_PRESS, color: INK, text_size: 22 }, o, { click_func: fn }))); },

    render() {
      this.clear();
      this.fill({ x: 0, y: 0, w: W, h: W, color: BG });
      this.fill({ x: 0, y: 0, w: W, h: 6, color: GOLD });
      if (!this.state.inApp) this.face(); else this.app();
    },

    face() {
      this.txt({ x: 0, y: 70, w: W, h: 24, color: MUTED, text_size: 22, text: '72° · Sunny' });
      this.txt({ x: 0, y: 116, w: W, h: 84, color: INK, text_size: 78, text: '9:41' });
      this.txt({ x: 0, y: 206, w: W, h: 22, color: DIM, text_size: 20, text: 'Tuesday · June 17' });
      this.btn({ x: C - 160, y: 270, w: 320, h: 110, radius: 22, normal_color: LEAD, press_color: 0x4a3a1c, text: '' }, () => this.openApp());
      this.txt({ x: C - 140, y: 290, w: 280, h: 18, align_h: align.LEFT, color: GOLD, text_size: 16, text: 'NOW · FIELD SCI' });
      this.txt({ x: C - 140, y: 314, w: 280, h: 50, align_h: align.LEFT, color: INK, text_size: 26, text_style: text_style.WRAP, text: 'Tide survey in 45 min' });
      this.txt({ x: 0, y: 404, w: W, h: 22, color: DIM, text_size: 18, text: 'tap the card to open' });
    },

    app() {
      this.btn({ x: C - 44, y: 18, w: 88, h: 30, radius: 15, normal_color: DARKBTN, press_color: 0x2e2820, color: MUTED, text_size: 16, text: 'Face' }, () => this.goFace());
      switch (this.state.page) {
        case 0: this.pNow(); break; case 1: this.pNext(); break; case 2: this.pQuick(); break;
        case 3: this.pTasks(); break; case 4: this.pTalk(); break;
      }
      if (this.state.page > 0) this.btn({ x: 10, y: C - 22, w: 44, h: 44, radius: 22, normal_color: DARKBTN, press_color: 0x2e2820, color: INK, text_size: 26, text: '‹' }, () => this.go(-1));
      if (this.state.page < PAGES - 1) this.btn({ x: W - 54, y: C - 22, w: 44, h: 44, radius: 22, normal_color: DARKBTN, press_color: 0x2e2820, color: INK, text_size: 26, text: '›' }, () => this.go(1));
      const gap = 18, sx = C - ((PAGES - 1) * gap) / 2;
      for (let i = 0; i < PAGES; i++) this.fill({ x: sx + i * gap - 4, y: 432, w: 8, h: 8, radius: 4, color: i === this.state.page ? GOLD : 0x3a352c });
    },

    pNow() {
      this.txt({ x: 0, y: 92, w: W, h: 18, color: GOLD, text_size: 16, text: 'NOW · FIELD SCI' });
      this.txt({ x: 60, y: 132, w: W - 120, h: 100, color: INK, text_size: 34, text_style: text_style.WRAP, text: 'Leave for the tide survey' });
      this.txt({ x: 0, y: 256, w: W, h: 24, color: MUTED, text_size: 20, text: 'in 45 min · 1:10 PM' });
      this.btn({ x: C - 92, y: 318, w: 184, h: 54, radius: 27, normal_color: GOLD, press_color: 0xc4912a, color: 0x141109, text_size: 24, text: 'Start prep' }, () => this.set(4));
    },

    pNext() {
      this.txt({ x: 0, y: 96, w: W, h: 18, color: COPPER, text_size: 16, text: 'NEXT UP' });
      this.txt({ x: 0, y: 132, w: W, h: 36, color: INK, text_size: 32, text: '2:00 PM' });
      this.txt({ x: 50, y: 182, w: W - 100, h: 40, color: INK, text_size: 28, text_style: text_style.WRAP, text: 'Robotics standup' });
      this.txt({ x: 0, y: 240, w: W, h: 22, color: MUTED, text_size: 18, text: 'Lab 3 · in 3h 10m' });
      this.btn({ x: C - 108, y: 312, w: 100, h: 50, radius: 25, normal_color: COPPER, press_color: 0xa87f3f, color: 0x141109, text_size: 22, text: 'Move' }, () => this.send('Move my robotics standup to 2:30 and notify the team.'));
      this.btn({ x: C + 8, y: 312, w: 100, h: 50, radius: 25, normal_color: DARKBTN, press_color: 0x2e2820, color: INK, text_size: 22, text: 'Notify' }, () => this.send('Notify my robotics team about standup.'));
    },

    pQuick() {
      this.txt({ x: 0, y: 90, w: W, h: 18, color: SAGE, text_size: 16, text: 'QUICK LOG' });
      const cw = 152, ch = 92, g = 14, x0 = C - cw - g / 2, x1 = C + g / 2, y0 = 130, y1 = 130 + ch + g;
      this.btn({ x: x0, y: y0, w: cw, h: ch, radius: 20, text_size: 22, text: 'Water ' + this.state.water + '/8', color: SAGE }, () => this.addWater());
      this.btn({ x: x1, y: y0, w: cw, h: ch, radius: 20, text_size: 22, text: 'Meal', color: INK }, () => this.send('Log a meal.'));
      this.btn({ x: x0, y: y1, w: cw, h: ch, radius: 20, text_size: 22, text: 'Workout', color: BLUE }, () => this.send('Start a workout.'));
      this.btn({ x: x1, y: y1, w: cw, h: ch, radius: 20, text_size: 22, text: 'Note', color: COPPER }, () => this.set(4));
    },

    pTasks() {
      const due = this.state.wtasks.filter((t) => !t.d).length;
      this.txt({ x: 0, y: 86, w: W, h: 18, color: GOLD, text_size: 16, text: due + ' DUE TODAY' });
      let y = 124;
      this.state.wtasks.forEach((t) => {
        this.btn({ x: 64, y, w: W - 128, h: 60, radius: 16, color: t.d ? DIM : INK, text_size: 22, text: (t.d ? '✓  ' : '○  ') + t.t, normal_color: t.d ? 0x232a1c : CARD }, () => this.toggleTask(t.id));
        y += 70;
      });
    },

    pTalk() {
      const s = this.state;
      if (s.err) {
        this.txt({ x: 0, y: 86, w: W, h: 16, color: RED, text_size: 15, text: 'ERROR' });
        this.btn({ x: 48, y: 120, w: W - 96, h: 220, radius: 18, normal_color: 0x2a1810, press_color: 0x3a2418, color: 0xe6c6b4, text_size: 19, text: s.err }, () => this.resetTalk());
        this.txt({ x: 0, y: 360, w: W, h: 22, color: DIM, text_size: 18, text: 'tap to dismiss' });
        return;
      }
      if (s.recording) {
        this.btn({ x: C - 70, y: 150, w: 140, h: 140, radius: 70, normal_color: 0xe6a92c, press_color: 0xc4912a, color: 0x141109, text_size: 24, text: 'Stop' }, () => this.stopRec());
        this.txt({ x: 0, y: 308, w: W, h: 24, color: GOLD, text_size: 22, text: 'Recording… tap to stop' });
        return;
      }
      if (s.busy) { this.txt({ x: 40, y: 200, w: W - 80, h: 60, color: GOLD, text_size: 28, text: s.transcript ? 'Thinking…' : 'Transcribing…' }); return; }
      if (s.reply) {
        this.txt({ x: 40, y: 86, w: W - 80, h: 16, color: SAGE, text_size: 15, text: 'YOU SAID' });
        this.txt({ x: 56, y: 108, w: W - 112, h: 60, color: INK, text_size: 21, text_style: text_style.WRAP, text: s.transcript });
        this.btn({ x: 48, y: 196, w: W - 96, h: 196, radius: 18, normal_color: 0x1a1610, press_color: 0x2a2418, color: 0xcfc6b4, text_size: 21, text: s.reply }, () => this.resetTalk());
        return;
      }
      this.btn({ x: C - 70, y: 150, w: 140, h: 140, radius: 70, normal_color: 0x2a2210, press_color: 0x3a2e16, color: GOLD, text_size: 24, text: 'Talk' }, () => this.startRec());
      this.txt({ x: 0, y: 308, w: W, h: 24, color: MUTED, text_size: 22, text: 'tap, speak, tap again' });
    },

    // ===================== ACTIONS =====================
    set(i) { this.state.page = Math.max(0, Math.min(i, PAGES - 1)); this.render(); },
    go(d) { this.set(this.state.page + d); },
    openApp() { this.state.inApp = true; this.state.page = 0; this.render(); },
    goFace() { this.state.inApp = false; this.resetTalkState(); this.render(); },
    addWater() { this.state.water = Math.min(this.state.water + 1, 8); this.render(); },
    toggleTask(id) { const t = this.state.wtasks.find((x) => x.id === id); if (t) t.d = !t.d; this.render(); },
    resetTalkState() { this.state.recording = false; this.state.busy = false; this.state.transcript = ''; this.state.reply = ''; this.state.err = ''; },
    resetTalk() { this.resetTalkState(); this.render(); },
    showErr(msg) { this.state.recording = false; this.state.busy = false; this.state.err = String(msg); this.render(); },

    // ---- recording ----
    startRec() {
      if (!media) return this.showErr('@zos/media unavailable on this firmware');
      try {
        this._rec = media.create(media.id.RECORDER);
        this._rec.setFormat(media.codec.OPUS, { target_file: REC_PATH });
        this._rec.start();
        this.state.recording = true; this.state.err = ''; this.render();
        // auto-stop after 12s so the clip (and upload) stays small
        this._autostop = setTimeout(() => { if (this.state.recording) this.stopRec(); }, 12000);
      } catch (e) { this.showErr('record start: ' + (e && e.message || e)); }
    },

    stopRec() {
      if (this._autostop) { clearTimeout(this._autostop); this._autostop = null; }
      try { this._rec && this._rec.stop(); } catch (e) {}
      try { this._rec && this._rec.release && this._rec.release(); } catch (e) {}
      this.state.recording = false; this.state.busy = true; this.state.transcript = ''; this.state.reply = ''; this.render();
      // small delay to let the file flush, then read + upload
      setTimeout(() => this.uploadRec(), 500);
    },

    uploadRec() {
      let b64;
      try {
        if (!fs) return this.showErr('@zos/fs unavailable');
        const st = fs.statSync ? fs.statSync({ path: FS_PATH }) : null;
        const size = st && (st.size || (st.stat && st.stat.size)) || 0;
        if (!size) return this.showErr('no audio recorded (file empty)');
        const fd = fs.openSync({ path: FS_PATH, flag: fs.O_RDONLY });
        const ab = new ArrayBuffer(size);
        fs.readSync({ fd, buffer: ab, options: { offset: 0, length: size } });
        fs.closeSync({ fd });
        b64 = toB64(new Uint8Array(ab));
      } catch (e) { return this.showErr('read audio: ' + (e && e.message || e)); }

      let settled = false;
      const done = (r) => { if (settled) return; settled = true; this.state.busy = false; this.state.reply = r.reply || ''; this.state.transcript = r.transcript || this.state.transcript; if (!this.state.reply && r.err) return this.showErr(r.err); this.render(); };
      this._guard = setTimeout(() => done({ reply: 'Took too long — tap to retry.' }), 55000);
      this.httpRequest({
        method: 'POST', url: `${API_BASE}/api/device/transcribe`,
        headers: { 'Content-Type': 'application/json', 'X-Device-Token': DEVICE_TOKEN },
        body: JSON.stringify({ audio_b64: b64, ext: 'opus', conversation_id: 'watch' }), timeout: 50000,
      })
        .then((res) => {
          let b = res && typeof res === 'object' ? (res.body !== undefined ? res.body : res) : res;
          if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) {} }
          if (b && typeof b === 'object') done({ transcript: b.transcript, reply: b.reply || (b.error ? 'Server: ' + b.error : '') });
          else done({ err: 'bad response: ' + JSON.stringify(res).slice(0, 120) });
        })
        .catch((e) => done({ err: 'upload: ' + (e && e.message || e) }));
    },

    // text-only path (Move/Notify/Quick-log tiles) — no recording
    send(message) {
      this.state.page = 4; this.state.busy = true; this.state.transcript = message; this.state.reply = ''; this.state.err = ''; this.render();
      let settled = false;
      const done = (r) => { if (settled) return; settled = true; this.state.busy = false; this.state.reply = r; this.render(); };
      this._guard = setTimeout(() => done('Took too long — tap to retry.'), 55000);
      this.httpRequest({ method: 'POST', url: `${API_BASE}/api/device/chat`,
        headers: { 'Content-Type': 'application/json', 'X-Device-Token': DEVICE_TOKEN },
        body: JSON.stringify({ message, conversation_id: 'watch' }), timeout: 50000 })
        .then((res) => { let b = res && res.body !== undefined ? res.body : res; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) {} } done((b && b.reply) || 'Done.'); })
        .catch(() => done('Could not reach Maverick.'));
    },

    onInit() {},
    onDestroy() { if (this._guard) clearTimeout(this._guard); try { this._rec && this._rec.release && this._rec.release(); } catch (e) {} },
  })
);
