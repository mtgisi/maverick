# Maverick Compass — watch face (Amazfit Active 2, Zepp OS)

A **watch face** (not the app) for the Active 2: warm-black + gold, a steps ring, big digital time,
date, and a sensor complication (steps · battery · heart rate). It runs entirely **on-device** — no
phone, no network — so it works as your everyday always-on face. (Live Maverick/AI data can't run on a
watch face; that lives in the Maverick app.)

## Build / preview (Zeus CLI)

```bash
cd watch-face
zeus preview        # builds + QR; scan in the Zepp app (Developer Mode on) to install
zeus build          # distributable .zab
```

It installs into the watch's **watch-face gallery** (long-press the current face to switch), not the app list.

## What it shows

- **Steps ring** — gold arc around the bezel, filled by today's steps vs. goal (`@zos/sensor` Step).
- **Time** — big 12-hour digital, updated each minute.
- **Date** — weekday · month day.
- **Complication row** — steps · battery % · heart rate.

## Notes

- No `package.json`/deps — watch faces don't use the side-service or zml.
- Sensor reads are wrapped defensively; an unavailable sensor shows `—` instead of breaking the face.
- If the time/date formatting looks off (the Zepp `Time` getters vary slightly by firmware), tell me what
  it shows and I'll adjust the getters.
- If `zeus preview` asks for a cover/preview image, add one at `assets/default.r/cover.png` and reference
  it in `app.json` — I can wire that if the build requires it.
