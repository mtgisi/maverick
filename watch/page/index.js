import { createWidget, widget, align, prop, text_style } from '@zos/ui';
import { push } from '@zos/router';
import { API_BASE, DEVICE_TOKEN } from '../config';

// Network: Zepp OS 3.x exposes a fetch-like on @zos/network with the device:os.network permission.
// If your firmware lacks device-side fetch, route through an app-side relay (see watch/README.md).
let netFetch = null;
try { netFetch = require('@zos/network').fetch; } catch (e) { netFetch = null; }

const W = 466, CX = 233;
const GOLD = 0xe6a92c, INK = 0xf4eee2, MUTED = 0xa39b8b, FAINT = 0x8f8674, DIM = 0x6f6a5e, SAGE = 0x9ca980, CARD = 0x1d1810;

// The five glance pages (mirrors the Aureo Watch design).
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

Page({
  state: { page: 0, busy: false },
  build() {
    // background
    createWidget(widget.FILL_RECT, { x: 0, y: 0, w: W, h: W, color: 0x0f0c07 });

    // home dot (top) — returns to first card
    this.homeDot = createWidget(widget.FILL_RECT, { x: CX - 15, y: 20, w: 30, h: 5, radius: 3, color: 0x47433a });

    // tag (mono label)
    this.tag = createWidget(widget.TEXT, {
      x: 70, y: 120, w: W - 140, h: 26, color: GOLD, text_size: 22, align_h: align.CENTER_H, text: '',
    });
    // title (serif-ish display)
    this.title = createWidget(widget.TEXT, {
      x: 56, y: 168, w: W - 112, h: 120, color: INK, text_size: 34, align_h: align.CENTER_H, align_v: align.CENTER_V,
      text_style: text_style.WRAP, text: '',
    });
    // sub (mono)
    this.sub = createWidget(widget.TEXT, {
      x: 70, y: 296, w: W - 140, h: 28, color: MUTED, text_size: 22, align_h: align.CENTER_H, text: '',
    });

    // primary button
    this.btnBg = createWidget(widget.FILL_RECT, { x: CX - 86, y: 336, w: 172, h: 52, radius: 26, color: GOLD });
    this.btn = createWidget(widget.TEXT, {
      x: CX - 86, y: 336, w: 172, h: 52, color: 0x141109, text_size: 24, align_h: align.CENTER_H, align_v: align.CENTER_V, text: '',
    });
    this.btnZone = createWidget(widget.BUTTON, {
      x: CX - 86, y: 336, w: 172, h: 52, radius: 26, normal_color: 0x00000000, press_color: 0x22000000, text: '',
      click_func: () => this.onAction(),
    });

    // prev / next tap arrows
    this.prevZone = createWidget(widget.BUTTON, { x: 8, y: 180, w: 70, h: 110, radius: 0, normal_color: 0x00000000, press_color: 0x11ffffff, text: '‹', text_size: 30, color: 0xcfc6b4, click_func: () => this.go(-1) });
    this.nextZone = createWidget(widget.BUTTON, { x: W - 78, y: 180, w: 70, h: 110, radius: 0, normal_color: 0x00000000, press_color: 0x11ffffff, text: '›', text_size: 30, color: 0xcfc6b4, click_func: () => this.go(1) });

    // page dots
    this.dots = [];
    const total = PAGES.length, gap = 16, startX = CX - ((total - 1) * gap) / 2;
    for (let i = 0; i < total; i++) {
      this.dots.push(createWidget(widget.FILL_RECT, { x: startX + i * gap - 4, y: 414, w: 8, h: 8, radius: 4, color: 0x39342b }));
    }

    // home dot tap → first page
    createWidget(widget.BUTTON, { x: CX - 30, y: 12, w: 60, h: 26, radius: 0, normal_color: 0x00000000, press_color: 0x11ffffff, text: '', click_func: () => this.set(0) });

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
    const p = PAGES[this.state.page];
    if (this.state.busy) return;
    this.ask(p.quick);
  },

  ask(message) {
    if (!netFetch) { this.show('Maverick', 'Network unavailable — see README (app-side relay).'); return; }
    this.state.busy = true;
    this.show('Maverick', 'Thinking…');
    netFetch({
      url: `${API_BASE}/api/device/chat`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Token': DEVICE_TOKEN },
      body: JSON.stringify({ message, conversation_id: 'watch' }),
    }).then((res) => {
      let reply = 'Done.';
      try { reply = JSON.parse(res.body).reply || reply; } catch (e) {}
      this.show('Maverick', reply);
    }).catch(() => this.show('Maverick', 'Could not reach Maverick.'))
      .then(() => { this.state.busy = false; });
  },

  show(tag, text) {
    this.tag.setProperty(prop.MORE, { color: GOLD, text: tag });
    this.title.setProperty(prop.MORE, { text: text });
    this.sub.setProperty(prop.MORE, { text: '' });
    this.btn.setProperty(prop.MORE, { text: 'Ask again' });
  },

  onInit() {},
  onDestroy() {},
});
