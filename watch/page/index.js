import { createWidget, deleteWidget, widget, align, prop, text_style } from '@zos/ui';
import { BasePage } from '@zeppos/zml/base-page';
import { API_BASE, DEVICE_TOKEN } from '../config';

// Maverick watch companion — 1:1 with Maverick Watch.dc.html.
// Face (steps ring + time + lead complication) -> tap -> 5 swipeable cards:
//   Now · Next · Quick log · Tasks · Talk to Maverick.
// Networking uses zml's this.httpRequest(), relayed by the Side Service (app-side) which has internet.

const W = 480, C = 240;
const GOLD = 0xe6a92c, COPPER = 0xcf9f5a, SAGE = 0x9ca980, BLUE = 0x7e93b0;
const INK = 0xf4eee2, MUTED = 0xa39b8b, FAINT = 0x8f8674, DIM = 0x6f6a5e;
const BG = 0x0f0c07, CARD = 0x211c14, LEAD0 = 0x2c2210, LEAD1 = 0x1d1810;
const TASKS = [
  { id: 1, title: 'Pack tide charts', done: false },
  { id: 2, title: 'Flash drive-base firmware', done: false },
  { id: 3, title: 'Send Reef Co. invoice', done: false },
];
const PAGES = 5;

Page(
  BasePage({
    state: { inApp: false, page: 0, busy: false, transcript: '', reply: '', water: 5, wtasks: TASKS.map((t) => ({ ...t })) },

    build() { this.w = []; this.render(); },

    // --- widget bookkeeping (delete + rebuild on every nav; cheap for a watch) ---
    add(w) { this.w.push(w); return w; },
    clear() { (this.w || []).forEach((x) => { try { deleteWidget(x); } catch (e) {} }); this.w = []; },
    txt(o) { return this.add(createWidget(widget.TEXT, Object.assign({ align_h: align.CENTER_H, align_v: align.CENTER_V, text_style: text_style.NONE, color: INK }, o))); },
    rect(o) { return this.add(createWidget(widget.FILL_RECT, o)); },
    tap(x, y, w, h, fn, extra) { return this.add(createWidget(widget.BUTTON, Object.assign({ x, y, w, h, radius: 0, normal_color: 0x00000000, press_color: 0x18ffffff, text: '', click_func: fn }, extra || {}))); },

    render() {
      this.clear();
      this.rect({ x: 0, y: 0, w: W, h: W, color: BG });
      if (!this.state.inApp) this.face(); else this.app();
    },

    // ===================== WATCH FACE =====================
    face() {
      try { // steps ring (decorative); wrapped so an ARC API mismatch can't blank the screen
        this.add(createWidget(widget.ARC, { x: 16, y: 16, w: W - 32, h: W - 32, start_angle: -220, end_angle: 40, color: 0x2a2620, line_width: 8 }));
        this.add(createWidget(widget.ARC, { x: 16, y: 16, w: W - 32, h: W - 32, start_angle: -220, end_angle: -40, color: GOLD, line_width: 8 }));
      } catch (e) {}
      this.txt({ x: 0, y: 66, w: W, h: 26, color: MUTED, text_size: 22, text: '72° · Sunny' });
      this.txt({ x: 0, y: 120, w: W, h: 86, color: INK, text_size: 80, text: '9:41' });
      this.txt({ x: 0, y: 212, w: W, h: 24, color: FAINT, text_size: 20, text: 'Tuesday · June 17' });
      // lead complication
      this.rect({ x: C - 156, y: 286, w: 312, h: 96, radius: 22, color: LEAD0 });
      this.add(createWidget(widget.STROKE_RECT, { x: C - 156, y: 286, w: 312, h: 96, radius: 22, line_width: 2, color: 0x6b4f1a }));
      this.rect({ x: C - 130, y: 304, w: 8, h: 8, radius: 4, color: GOLD });
      this.txt({ x: C - 116, y: 302, w: 260, h: 16, align_h: align.LEFT, color: GOLD, text_size: 16, text: 'NOW · FIELD SCI' });
      this.txt({ x: C - 130, y: 326, w: 260, h: 44, align_h: align.LEFT, color: INK, text_size: 24, text_style: text_style.WRAP, text: 'Tide survey in 45 min' });
      this.txt({ x: 0, y: 404, w: W, h: 22, color: DIM, text_size: 18, text: 'tap to open Maverick' });
      this.tap(0, 0, W, W, () => this.openApp());
    },

    // ===================== APP SHELL =====================
    app() {
      // home dot
      this.rect({ x: C - 15, y: 22, w: 30, h: 5, radius: 3, color: 0x47433a });
      this.tap(C - 40, 14, 80, 30, () => this.goFace());

      switch (this.state.page) {
        case 0: this.pageNow(); break;
        case 1: this.pageNext(); break;
        case 2: this.pageQuickLog(); break;
        case 3: this.pageTasks(); break;
        case 4: this.pageTalk(); break;
      }

      // prev / next arrows
      if (this.state.page > 0) {
        this.rect({ x: 12, y: C - 18, w: 36, h: 36, radius: 18, color: 0x1a1610 });
        this.txt({ x: 12, y: C - 20, w: 36, h: 36, color: 0xcfc6b4, text_size: 26, text: '‹' });
        this.tap(4, C - 30, 64, 60, () => this.go(-1));
      }
      if (this.state.page < PAGES - 1) {
        this.rect({ x: W - 48, y: C - 18, w: 36, h: 36, radius: 18, color: 0x1a1610 });
        this.txt({ x: W - 48, y: C - 20, w: 36, h: 36, color: 0xcfc6b4, text_size: 26, text: '›' });
        this.tap(W - 68, C - 30, 64, 60, () => this.go(1));
      }

      // page dots
      const gap = 18, startX = C - ((PAGES - 1) * gap) / 2;
      for (let i = 0; i < PAGES; i++) {
        this.rect({ x: startX + i * gap - 4, y: 430, w: 8, h: 8, radius: 4, color: i === this.state.page ? GOLD : 0x39342b });
      }
    },

    eyebrow(text, color) { this.txt({ x: 40, y: 96, w: W - 80, h: 18, color, text_size: 16, text }); },
    primaryBtn(y, label, color, fn) {
      const w = 188, x = C - w / 2;
      this.rect({ x, y, w, h: 54, radius: 27, color });
      this.txt({ x, y, w, h: 54, color: 0x141109, text_size: 24, text: label });
      this.tap(x, y, w, 54, fn);
    },

    // ----- PAGE 0 · NOW -----
    pageNow() {
      this.rect({ x: C - 56, y: 100, w: 8, h: 8, radius: 4, color: GOLD });
      this.txt({ x: C - 42, y: 98, w: 160, h: 16, align_h: align.LEFT, color: GOLD, text_size: 16, text: 'NOW · FIELD SCI' });
      this.txt({ x: 64, y: 140, w: W - 128, h: 110, color: INK, text_size: 34, text_style: text_style.WRAP, text: 'Leave for the tide survey' });
      this.txt({ x: 0, y: 270, w: W, h: 24, color: MUTED, text_size: 20, text: 'in 45 min · 1:10 PM' });
      this.primaryBtn(330, 'Start prep', GOLD, () => this.set(4));
    },

    // ----- PAGE 1 · NEXT -----
    pageNext() {
      this.txt({ x: 0, y: 104, w: W, h: 18, color: COPPER, text_size: 16, text: 'NEXT UP' });
      this.txt({ x: 0, y: 140, w: W, h: 36, color: INK, text_size: 32, text: '2:00 PM' });
      this.txt({ x: 56, y: 188, w: W - 112, h: 40, color: INK, text_size: 28, text_style: text_style.WRAP, text: 'Robotics standup' });
      this.txt({ x: 0, y: 248, w: W, h: 22, color: MUTED, text_size: 18, text: 'Lab 3 · in 3h 10m' });
      const bw = 100;
      this.rect({ x: C - bw - 8, y: 320, w: bw, h: 48, radius: 24, color: COPPER });
      this.txt({ x: C - bw - 8, y: 320, w: bw, h: 48, color: 0x141109, text_size: 22, text: 'Move' });
      this.tap(C - bw - 8, 320, bw, 48, () => this.ask('Move my robotics standup to 2:30 and notify the team.'));
      this.rect({ x: C + 8, y: 320, w: bw, h: 48, radius: 24, color: 0x1a1610 });
      this.txt({ x: C + 8, y: 320, w: bw, h: 48, color: 0xcfc6b4, text_size: 22, text: 'Notify' });
      this.tap(C + 8, 320, bw, 48, () => this.ask('Notify my robotics team about standup.'));
    },

    // ----- PAGE 2 · QUICK LOG (2x2) -----
    pageQuickLog() {
      this.txt({ x: 0, y: 96, w: W, h: 18, color: SAGE, text_size: 16, text: 'QUICK LOG' });
      const cw = 150, ch = 120, gx = 16, x0 = C - cw - gx / 2, x1 = C + gx / 2, y0 = 140, y1 = 140 + ch + gx;
      const tile = (x, y, label, val, color, fn) => {
        this.rect({ x, y, w: cw, h: ch, radius: 22, color: CARD });
        this.txt({ x, y: y + 30, w: cw, h: 26, color: INK, text_size: 24, text: label });
        this.txt({ x, y: y + 64, w: cw, h: 22, color, text_size: 20, text: val });
        this.tap(x, y, cw, ch, fn);
      };
      tile(x0, y0, 'Water', this.state.water + '/8', SAGE, () => this.addWater());
      tile(x1, y0, 'Meal', '1,240', MUTED, () => this.ask('Log a meal.'));
      tile(x0, y1, 'Workout', 'Start', BLUE, () => this.ask('Start a workout.'));
      tile(x1, y1, 'Note', 'Dictate', COPPER, () => this.set(4));
    },

    // ----- PAGE 3 · TASKS -----
    pageTasks() {
      const due = this.state.wtasks.filter((t) => !t.done).length;
      this.txt({ x: 0, y: 96, w: W, h: 18, color: GOLD, text_size: 16, text: (due + ' DUE TODAY').toUpperCase() });
      let y = 140;
      this.state.wtasks.forEach((t) => {
        this.rect({ x: 70, y, w: W - 140, h: 56, radius: 16, color: CARD });
        this.rect({ x: 86, y: y + 16, w: 24, h: 24, radius: 8, color: t.done ? SAGE : 0x3a352c });
        if (t.done) this.txt({ x: 86, y: y + 14, w: 24, h: 24, color: 0x141109, text_size: 18, text: '✓' });
        this.txt({ x: 122, y, w: W - 210, h: 56, align_h: align.LEFT, color: t.done ? DIM : INK, text_size: 22, text: t.title });
        this.tap(70, y, W - 140, 56, () => this.toggleTask(t.id));
        y += 66;
      });
    },

    // ----- PAGE 4 · TALK -----
    pageTalk() {
      const s = this.state;
      if (s.busy) {
        this.txt({ x: 40, y: 200, w: W - 80, h: 60, color: INK, text_size: 28, text_style: text_style.WRAP, text: 'Thinking…' });
        return;
      }
      if (s.reply) {
        this.txt({ x: 50, y: 96, w: W - 100, h: 16, color: SAGE, text_size: 15, text: 'YOU SAID' });
        this.txt({ x: 56, y: 120, w: W - 112, h: 70, color: INK, text_size: 22, text_style: text_style.WRAP, text: s.transcript });
        this.rect({ x: 48, y: 210, w: W - 96, h: 180, radius: 18, color: 0x1a1610 });
        this.txt({ x: 64, y: 224, w: W - 128, h: 152, align_h: align.LEFT, color: 0xcfc6b4, text_size: 21, text_style: text_style.WRAP, text: 'Maverick: ' + s.reply });
        this.tap(48, 210, W - 96, 180, () => this.ask('Summarize my day.'));
        return;
      }
      // idle: big mic (drawn from primitives — avoids font/emoji gaps)
      this.rect({ x: C - 64, y: 150, w: 128, h: 128, radius: 64, color: 0x2a2210 });
      this.rect({ x: C - 14, y: 184, w: 28, h: 46, radius: 14, color: GOLD });   // mic body
      this.rect({ x: C - 3, y: 230, w: 6, h: 14, color: GOLD });                  // stem
      this.rect({ x: C - 18, y: 244, w: 36, h: 6, radius: 3, color: GOLD });      // base
      this.txt({ x: 0, y: 302, w: W, h: 24, color: MUTED, text_size: 22, text: 'Tap to talk' });
      this.tap(C - 80, 140, 160, 150, () => this.ask('Summarize my day.'));
    },

    // ===================== ACTIONS =====================
    set(i) { this.state.page = Math.max(0, Math.min(i, PAGES - 1)); this.render(); },
    go(d) { this.set(this.state.page + d); },
    openApp() { this.state.inApp = true; this.state.page = 0; this.render(); },
    goFace() { this.state.inApp = false; this.state.reply = ''; this.render(); },
    addWater() { this.state.water = Math.min(this.state.water + 1, 8); this.render(); },
    toggleTask(id) { const t = this.state.wtasks.find((x) => x.id === id); if (t) t.done = !t.done; this.render(); },

    ask(message) {
      if (this.state.busy) return;
      this.state.busy = true; this.state.transcript = message; this.state.reply = ''; this.state.page = 4; this.render();
      let settled = false;
      const done = (reply) => { if (settled) return; settled = true; this.state.busy = false; this.state.reply = reply; this.render(); };
      // UI guard: never leave it stuck on "Thinking…"
      this._guard = setTimeout(() => done('Took too long — tap to retry.'), 55000);
      this.httpRequest({
        method: 'POST',
        url: `${API_BASE}/api/device/chat`,
        headers: { 'Content-Type': 'application/json', 'X-Device-Token': DEVICE_TOKEN },
        body: JSON.stringify({ message, conversation_id: 'watch' }),
        timeout: 50000,
      })
        .then((res) => {
          // zml/Zepp fetch response shape varies — probe several fields, parse strings, and
          // fall back to showing the raw structure so any mismatch is visible (not a blank box).
          let reply = '';
          try {
            let b = res;
            if (res && typeof res === 'object') {
              b = res.body !== undefined ? res.body : (res.data !== undefined ? res.data : (res.result !== undefined ? res.result : res));
            }
            if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) {} }
            if (b && typeof b === 'object' && b.reply) reply = b.reply;
            else if (typeof b === 'string') reply = b;
          } catch (e) {}
          if (!reply) reply = 'raw: ' + JSON.stringify(res).slice(0, 200);
          done(reply);
        })
        .catch(() => done('Could not reach Maverick.'));
    },

    onInit() {},
    onDestroy() { if (this._guard) clearTimeout(this._guard); },
  })
);
