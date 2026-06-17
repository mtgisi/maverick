import { createWidget, widget, align, prop, text_style } from '@zos/ui';
import { Time, Step, Battery, HeartRate } from '@zos/sensor';

// Maverick compass watch face — runs on-device, no phone needed. Warm black + gold, steps ring,
// big time, date, and a sensor complication (steps / battery / heart rate). All sensor reads are
// wrapped so a missing/again-unavailable sensor never blanks the face.

const W = 480, C = 240;
const GOLD = 0xe6a92c, SAGE = 0x9ca980, INK = 0xf4eee2, MUTED = 0xa39b8b, FAINT = 0x8f8674, BG = 0x0f0c07;
const RING_BG = 0x2a2620;

const safe = (fn, d) => { try { const v = fn(); return v == null ? d : v; } catch (e) { return d; } };
const WDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

WatchFace({
  build() {
    this.time = new Time();
    this.step = safe(() => new Step(), null);
    this.batt = safe(() => new Battery(), null);
    this.hr = safe(() => new HeartRate(), null);

    // background
    createWidget(widget.FILL_RECT, { x: 0, y: 0, w: W, h: W, color: BG });

    // steps ring (track + progress) — wrapped in case ARC differs on firmware
    try {
      createWidget(widget.ARC, { x: 16, y: 16, w: W - 32, h: W - 32, start_angle: 0, end_angle: 360, color: RING_BG, line_width: 10 });
      this.ring = createWidget(widget.ARC, { x: 16, y: 16, w: W - 32, h: W - 32, start_angle: -90, end_angle: -90, color: GOLD, line_width: 10 });
    } catch (e) { this.ring = null; }

    this.weather = createWidget(widget.TEXT, { x: 0, y: 72, w: W, h: 24, align_h: align.CENTER_H, align_v: align.CENTER_V, color: FAINT, text_size: 22, text: '' });
    this.clock = createWidget(widget.TEXT, { x: 0, y: 150, w: W, h: 96, align_h: align.CENTER_H, align_v: align.CENTER_V, color: INK, text_size: 92, text: '' });
    this.date = createWidget(widget.TEXT, { x: 0, y: 252, w: W, h: 26, align_h: align.CENTER_H, align_v: align.CENTER_V, color: MUTED, text_size: 22, text: '' });

    // complication row: steps · battery · heart rate
    const y = 330, third = W / 3;
    this.cSteps = createWidget(widget.TEXT, { x: 0, y, w: third, h: 30, align_h: align.CENTER_H, color: GOLD, text_size: 26, text: '—' });
    this.cBatt = createWidget(widget.TEXT, { x: third, y, w: third, h: 30, align_h: align.CENTER_H, color: INK, text_size: 26, text: '—' });
    this.cHr = createWidget(widget.TEXT, { x: 2 * third, y, w: third, h: 30, align_h: align.CENTER_H, color: SAGE, text_size: 26, text: '—' });
    const yl = y + 30;
    createWidget(widget.TEXT, { x: 0, y: yl, w: third, h: 18, align_h: align.CENTER_H, color: FAINT, text_size: 15, text: 'STEPS' });
    createWidget(widget.TEXT, { x: third, y: yl, w: third, h: 18, align_h: align.CENTER_H, color: FAINT, text_size: 15, text: 'BATT' });
    createWidget(widget.TEXT, { x: 2 * third, y: yl, w: third, h: 18, align_h: align.CENTER_H, color: FAINT, text_size: 15, text: 'HR' });

    this.update();
    try { this.time.onPerMinute(() => this.update()); } catch (e) {}
  },

  update() {
    // time (12h)
    const h = safe(() => this.time.getHours(), 9);
    const m = safe(() => this.time.getMinutes(), 41);
    const h12 = ((h + 11) % 12) + 1;
    this.clock.setProperty(prop.MORE, { text: `${h12}:${String(m).padStart(2, '0')}` });

    // date
    const wd = safe(() => this.time.getDay(), -1);      // 0-6 (Sun-Sat) on most firmware
    const mo = safe(() => this.time.getMonth(), 0);     // 1-12 or 0-11 depending on firmware
    const dd = safe(() => this.time.getDate(), 0);
    const moIdx = mo > 0 ? (mo - 1) % 12 : mo;          // tolerate 1-based or 0-based
    const dStr = `${wd >= 0 && wd < 7 ? WDAY[wd] + ' · ' : ''}${MON[moIdx] || ''} ${dd || ''}`.trim();
    this.date.setProperty(prop.MORE, { text: dStr || '' });

    // steps + ring
    if (this.step) {
      const cur = safe(() => this.step.getCurrent(), 0);
      const goal = safe(() => this.step.getTarget(), 8000) || 8000;
      this.cSteps.setProperty(prop.MORE, { text: cur >= 1000 ? (cur / 1000).toFixed(1) + 'k' : String(cur) });
      if (this.ring) {
        const ratio = Math.max(0, Math.min(1, cur / goal));
        try { this.ring.setProperty(prop.MORE, { start_angle: -90, end_angle: -90 + Math.round(360 * ratio) }); } catch (e) {}
      }
    }
    if (this.batt) this.cBatt.setProperty(prop.MORE, { text: safe(() => this.batt.getCurrent(), 0) + '%' });
    if (this.hr) { const b = safe(() => this.hr.getCurrent(), 0); this.cHr.setProperty(prop.MORE, { text: b ? String(b) : '—' }); }
  },

  onInit() {},
  onDestroy() {},
});
