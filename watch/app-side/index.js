// Side Service — runs inside the Zepp phone app (which has internet) and performs the HTTPS call to
// Maverick on the watch's behalf. The watch page talks to this over BLE via zml's request/onRequest.
// Zepp OS apps cannot reach the internet directly from the device; this is the supported pattern.
import { BaseSideService } from '@zeppos/zml/base-side';
import { API_BASE, DEVICE_TOKEN } from '../config';

BaseSideService({
  onInit() {},
  onRun() {},
  onDestroy() {},

  // Device calls this.request({ method:'CHAT', message }) → we fetch and return { reply }.
  onRequest(req, res) {
    if (req.method === 'CHAT') {
      fetch({
        url: `${API_BASE}/api/device/chat`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Device-Token': DEVICE_TOKEN },
        body: JSON.stringify({ message: req.message, conversation_id: 'watch' }),
      })
        .then((resp) => {
          let reply = 'Done.';
          try {
            const data = typeof resp.body === 'string' ? JSON.parse(resp.body) : resp.body;
            if (data && data.reply) reply = data.reply;
          } catch (e) {}
          res(null, { reply });
        })
        .catch(() => res(null, { reply: 'Could not reach Maverick.' }));
    } else {
      res(null, {});
    }
  },
});
