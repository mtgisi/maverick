import { createWidget, widget, align, prop, text_style } from '@zos/ui';
import { BasePage } from '@zeppos/zml/base-page';

// Networking goes through the Side Service (app-side/index.js) over BLE — Zepp OS apps can't reach
// the internet from the device directly. We send { method:'CHAT', message } via zml's this.request().

const W = 480, CX = 240;
const GOLD = 0xe6a92c, INK = 0xf4eee2, MUTED = 0xa39b8b, SAGE = 0x9ca980;

// The five glance pages (mirrors the Maverick Watch design).
const PAGES = [
  { tag: 'Now · Field Sci', tagColor: GOLD,
    title: 'Leave for the tide survey', sub: 'in 45 min · 1:10 PM', btn: 'Start prep', quick: 'What should I start with right now?' },
  { tag: 'Next up', tagColor: 0xcf9f5a,
    title: 'Robotics standup', sub: '2:00 PM · Lab 3', btn: 'Notify', quick: 'Move my robotics standup to 2:30 and notify the team.' },
  { tag: 'Quick log', tagColor: SAGE,
    title: 'Log water', sub: 'tap to add a glass', btn: 'Log water', quick: 'Log a glass of water.' },
  { tag: 'Tasks', tagColor: GOLD,
    title: '3 due today', sub: 'tap to hear them', btn: 'Read tasks', quick: 'List my tasks due today.' },
  { tag: 'Talk to Maverick', tagColor: GOLD,
    title: 'Tap to talk', sub: 'dictate a request', btn: 'Send', quick: 'Summarize my day.' },
];

BasePage({
  state: { page: 0, busy: false },

  build() {
    createWidget(widget.FILL_RECT, { x: 0, y: 0, w: W, h: W, color: 0x0f0c07 });
    createWidget(widget.FILL_RECT, { x: CX - 15, y: 20, w: 30, h: 5, radius: 3, color: 0x47433a });

    this.tag = createWidget(widget.TEXT, { x: 70, y: 120, w: W - 140, h: 26, color: GOLD, text_size: 22, align_h: align.CENTER_H, text: '' });
    this.title = createWidget(widget.TEXT, { x: 56, y: 168, w: W - 112, h: 120, color: INK, text_size: 34, align_h: align.CENTER_H, align_v: align.CENTER_V, text_style: text_style.WRAP, text: '' });
    this.sub = createWidget(widget.TEXT, { x: 70, y: 296, w: W - 140, h: 28, color: MUTED, text_size: 22, align_h: align.CENTER_H, text: '' });

    createWidget(widget.FILL_RECT, { x: CX - 86, y: 336, w: 172, h: 52, radius: 26, color: GOLD });
    this.btn = createWidget(widget.TEXT, { x: CX - 86, y: 336, w: 172, h: 52, color: 0x141109, text_size: 24, align_h: align.CENTER_H, align_v: align.CENTER_V, text: '' });
    createWidget(widget.BUTTON, { x: CX - 86, y: 336, w: 172, h: 52, radius: 26, normal_color: 0x00000000, press_color: 0x22000000, text: '', click_func: () => this.onAction() });

    createWidget(widget.BUTTON, { x: 8, y: 180, w: 70, h: 110, normal_color: 0x00000000, press_color: 0x11ffffff, text: '‹', text_size: 30, color: 0xcfc6b4, click_func: () => this.go(-1) });
    createWidget(widget.BUTTON, { x: W - 78, y: 180, w: 70, h: 110, normal_color: 0x00000000, press_color: 0x11ffffff, text: '›', text_size: 30, color: 0xcfc6b4, click_func: () => this.go(1) });

    this.dots = [];
    const total = PAGES.length, gap = 16, startX = CX - ((total - 1) * gap) / 2;
    for (let i = 0; i < total; i++) {
      this.dots.push(createWidget(widget.FILL_RECT, { x: startX + i * gap - 4, y: 414, w: 8, h: 8, radius: 4, color: 0x39342b }));
    }
    createWidget(widget.BUTTON, { x: CX - 30, y: 12, w: 60, h: 26, normal_color: 0x00000000, press_color: 0x11ffffff, text: '', click_func: () => this.set(0) });

    this.set(0);
  },

  set(i) {
    this.state.page = Math.max(0, Math.min(i, PAGES.length - 1));
    const p = PAGES[this.state.page];
    this.tag.setProperty(prop.MORE, { color: p.tagColor, text: p.tag });
    this.title.setProperty(prop.MORE, { text: p.title });
    this.sub.setProperty(prop.MORE, { text: p.sub });
    this.btn.setProperty(prop.MORE, { text: p.btn });
    this.dots.forEach((d, idx) => d.setProperty(prop.MORE, { color: idx === this.state.page ? GOLD : 0x39342b }));
  },

  go(d) { this.set(this.state.page + d); },

  onAction() {
    if (this.state.busy) return;
    this.ask(PAGES[this.state.page].quick);
  },

  ask(message) {
    this.state.busy = true;
    this.show('Maverick', 'Thinking…');
    // Round-trip to the Side Service, which has internet.
    this.request({ method: 'CHAT', message })
      .then((data) => this.show('Maverick', (data && data.reply) || 'Done.'))
      .catch(() => this.show('Maverick', 'Could not reach Maverick.'))
      .then(() => { this.state.busy = false; });
  },

  show(tag, text) {
    this.tag.setProperty(prop.MORE, { color: GOLD, text: tag });
    this.title.setProperty(prop.MORE, { text });
    this.sub.setProperty(prop.MORE, { text: '' });
    this.btn.setProperty(prop.MORE, { text: 'Ask again' });
  },

  onInit() {},
  onDestroy() {},
});
