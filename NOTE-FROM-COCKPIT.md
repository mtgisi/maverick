# Uncommitted change in server/routes/device.js — please review

2026-08-27, from the "work" Claude session on bastion, at Matthew's request.

Added two endpoints so Work Cockpit (his Electron dashboard on the school
laptop) can reach Maverick from a floating always-on-top overlay:

- `POST /api/device/chat/stream` — SSE, same event vocabulary as /api/chat
  (token | tool_start | tool_end | done | error). A tool-using turn measures
  ~12s from off-LAN, so the desktop client needed streaming where the watch
  did not. Falls back to a single `done` when the brain cannot stream.
- `POST /api/device/stt` — transcribe only, no brain. The overlay shows what
  it heard immediately, then streams the reply separately. The existing
  /api/device/transcribe still does both in one blocking call for the watch.

Both are purely additive; nothing existing was modified. The image has been
rebuilt and redeployed, and both endpoints are verified working through the
public endpoint.

The change is left UNCOMMITTED deliberately — this is your repo and the commit
should be yours. I could not reach you via SendMessage: your tmux session here
does not surface in bastion's agent list.
