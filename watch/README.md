# Maverick — Amazfit Active 2 watch app (Zepp OS Mini Program)

A glance + dictation companion for the wrist. Five swipeable cards on the 466×466 circular display:

1. **Now** — the reactive lead (what matters right now)
2. **Next** — your next event, with a quick "Move / Notify" action
3. **Quick log** — log water / a meal / start a workout
4. **Tasks** — what's due today
5. **Talk** — send a request to Maverick and read the reply

Touch-first: tap the left/right edges (‹ ›) to move between cards, tap the gold button to act, tap the
top dot to jump home. The two physical side buttons are left to Zepp OS system navigation (back / app
list) — by design we don't bind core actions to them.

## Connect it to your server

Edit `config.js`:

```js
export const API_BASE = 'https://maverick.matthewgisi.com';
export const DEVICE_TOKEN = '<the DEVICE_TOKEN from the server .env>';
```

The card actions POST to `${API_BASE}/api/device/chat` with header `X-Device-Token`, which the server
checks against `DEVICE_TOKEN`. The reply is shown on the Talk card.

## Build & preview (Zeus CLI)

```bash
npm i -g @zeppos/zeus-cli      # Zepp OS dev tool
cd watch
zeus dev                       # live preview in the Zepp OS simulator
# bind your real device the first time:
zeus target add               # pick "Amazfit Active 2"
zeus preview                   # QR → open in the Zepp app on your phone → installs to the watch
zeus build                     # produce a distributable .zab
```

Pair the watch in the Zepp phone app first; `zeus preview` generates a QR you scan there to side-load.

## Networking note

`page/index.js` uses the device-side `fetch` from `@zos/network` (declared permission
`device:os.network`). Some firmware routes internet through the phone via an **app-side service**
instead. If direct device fetch fails, add an `app-side/index.js` relay that performs the HTTPS call
and forwards the result over `@zos/communication` — the page already isolates the call in `ask()`,
so only that function needs to change.

## Voice / dictation

The Active 2 has on-device voice. Wiring its STT result into `ask(transcript)` is the natural next
step — right now each card sends a useful canned prompt (e.g. "Summarize my day"). Replace the
`quick` strings or feed a live transcript into `ask()` once you hook up the system voice API.

## Brand

Colors and type follow the Aureo design language (gold #e6a92c on warm black #0f0c07).
