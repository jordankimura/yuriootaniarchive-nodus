# Nodus shared room prototype

The `/nodus/` page adds a Warudo viewport and a public conversation to the existing archive. Everyone watches the same character. Visitors get an anonymous browser session and take turns through a queue. This branch does **not** deploy or enable public access to Jordan's personal agent.

## Run locally

Requires Node 22+ (tested on Node 24) and the existing Nodus voice app with its ElevenLabs voice loaded. No provider keys belong in this repository or in browser code. After installing dependencies once, Windows users can double-click `scripts/Start Nodus Website.cmd`. It starts missing preview services and opens the publisher; it does not start Warudo or Connectome. Selecting the shared window remains a browser action each time a new share starts.

```sh
npm ci
npm run build
npm run nodus:local -- --connect-private-nodus
```

One local program on port 8794 serves the built site, the room API (under `/api/nodus/`, as on Vercel) and the camera publisher. Rebuild after editing the site, or run `npm run dev` for Vite's editing server on port 5175, which forwards the room API to 8794.

- Website: `http://127.0.0.1:8794/nodus/`
- Local camera publisher: `http://127.0.0.1:8794/operator`
- Existing personal voice app, used only by the local worker: `http://127.0.0.1:8788`

Use **Join the room** and send a short message. The gateway queues it, the local worker asks Nodus, and the existing voice controller performs the reply in Warudo. The worker sends the visitor's anonymous label (for example `Guest 412`) separately from their message, so the voice controller frames the turn as that visitor rather than as Jordan. An older voice controller without this support receives a text label saying the visitor is not Jordan instead. A turn finishes after audio playback finishes. The public transcript contains the visitor's message and Nodus's final spoken text. Tool output, reasoning, provider keys and local controller endpoints are not returned to the page.

The local adapter still uses Jordan's existing private voice channel and memory. It is suitable for Jordan's own test, **not for untrusted visitors**. Its explicit flag, loopback checks and mode check are deliberate. The provided worker refuses public mode; changing the hostname is not a supported deployment method.

## Video and sound

On the local publisher page, choose **Share Warudo window**, then select the dedicated Warudo output window in the browser's sharing picker. Check the publisher preview before connecting viewers. The page never starts desktop capture automatically. Closing the share or the publisher stops new frames; the visitor page falls back to a clearly labelled saved preview.

The prototype uses WebRTC with HTTP signalling. Viewers do not grant microphone or camera access. It sends a separate peer connection per viewer, suitable for a small pilot. The STUN server sees network connection metadata. TURN is not configured, so some networks will fail to connect. For public use, replace this publisher with an authenticated media relay/SFU such as LiveKit, with TURN, viewer tokens, bandwidth limits and access control. The public-mode operator flow is intentionally not implemented.

Warudo's window is not the source of Nodus's synthesized audio: the existing controller plays it separately. Sharing the window therefore starts with **video only**. The publisher offers an optional audio input for a dedicated virtual cable carrying only Nodus's speech. Listing devices asks for input permission briefly, then closes the probe. Audio capture starts only when sharing starts with a selected source. Selecting the physical microphone would broadcast the room; leave the selector on Video only unless the routing is known. There is no visitor voice input in this version.

## Capture, camera controls and restart update

The publisher now defaults to Warudo's virtual camera, enabled and saved in the local cp87 scene. Four registered WarudoCam devices were found; the first selected device produced Nodus's clean image in Chrome. Camera permission may briefly open the browser's default camera solely to reveal device names; that probe stops before publishing. The publisher refuses to send a device whose label is not Warudo. If permission is already granted, no probe is needed. Leave the publisher tab open for the stream's lifetime.

Source and sender are capped at 1280×720 / 24 FPS, with a 1.6 Mbps video limit and preference for maintaining frame rate. WebRTC can lower resolution under load. Operator diagnostics show actual output; the live clean-camera check reported about 23–24 FPS, adapting between 360p and 720p. The existing procedural idle remained enabled and changing. No full-machine/GPU benchmark or end-to-end latency measurement was performed. Window capture is a fallback: Chrome ignored `cursor: never` in the tested path, so the clean virtual camera is needed to exclude the mouse reliably. The viewer trims the top 6% of window captures for the title bar. No OS cursor settings are changed.

The viewer now uses the close conversation framing by default, with no camera selector. The website API rejects the old wide preset. The existing close shot was already saved in cp87 and was confirmed live as Conversation view. Enter submits a nonempty message through the normal form; Shift+Enter inserts a line break. Repeated Enter, disabled send controls and IME composition do not cause accidental extra sends. The wide shot is disabled everywhere Nodus or the website can reach it: the voice controller no longer maps a `wide` reply to the hand reframe (it is treated as `keep`), and the local camera helper only accepts the close view.

The Windows website launcher now serves the built site through a small loopback HTTP server instead of keeping Vite's watcher running. `npm run dev` remains available for editing. A local **Nodus Studio** desktop shortcut and orchestration script live in the vault under `Tools/Nodus Studio`, outside this public repository. They start the voice service before the saved Connectome recipe, use its headless mode with a Windows named pipe, open Warudo at 1280×720 if absent, and start the website. Existing services are reused. Typed chat starts neither Deepgram nor the microphone lip-sync helper. Scripts, Windows daemon transport and reuse of live services were checked; a complete cold start after reboot has not yet been observed. ElevenLabs keys remain memory-only and must be reloaded after restart.

Fifteen website integration tests pass, including renewal of long replies, a hard deadline and rejection of unrelated lease renewals. The production build, archive checks, focused lint and startup-script parsing passed for the UI/startup changes. Native camera and existing-service startup reuse were checked live. The separate local voice controller passed 49 tests; a real 1,652-character, eight-part reply completed through native audio and lip sync in 98.72 seconds, with exact text preserved and phrase facial cues returning to neutral. That live test used the private voice controller directly; long website lease renewal has a mocked-clock integration test. The original ten-test result below describes the first prototype.

## Review fixes

- Visitor sessions now expire after 30 idle minutes instead of 24 hours, unless the visitor has a turn waiting or in progress. An open tab keeps its session alive by polling. Previously, 100 visitors in one day would have filled the session cap until the next day.
- A viewer tab now sends `leave` when its video stops or the page is closed. The publisher closes that peer connection immediately, and the gateway frees the tab's video slot ten seconds later, so reconnects no longer hit the three-connection limit.
- The local preview accepts both `http://127.0.0.1` and `http://localhost` spellings of the site origin. Other origins and ports are still rejected.
- Only visitor routes are reachable under `/api/nodus/` on the bundled local site; worker, publisher and health routes are not.

Eighteen website integration tests cover these, the bundled local site and the earlier cases.

## Queue and identity

- Signed, HttpOnly anonymous cookie; no IP address is treated as a person's identity.
- Public transcript and shared replies, explicitly disclosed before submitting a message.
- One pending turn per visitor; at most 12 waiting turns; 600 characters per message.
- 20-second per-visitor cooldown and 60 accepted turns per gateway run by default (cancellations still consume the cap).
- One worker lease at a time. A timed-out or failed generation is never automatically retried.
- Long spoken answers stay in one queue turn. The private voice controller accepts up to 4,000 spoken characters, divides speech into requests of at most 420 characters, and emits one completion only after every part finishes. A correlated worker heartbeat renews its own two-minute job lease, with an absolute 8.5-minute deadline. The adapter waits up to 490 seconds; provider failure or cancellation does not replay an already spoken part.
- Worker authentication is separate from visitor sessions and publisher authentication.
- Origin/CSRF checks, bounded requests, expiring sessions and a mutation rate limit.

Cookies are easy to reset; these are pilot protections, not sufficient anti-abuse controls for a public service. Rate limits currently use the gateway socket address, so requests through one reverse proxy share a bucket. State is in memory, in one process, and clears on restart. There is no durable queue or cross-instance coordination. The public transcript must never be presented as a private conversation.

## Public deployment still needed

1. Create a separate public Nodus profile with isolated memory, no Jordan identity assumptions, and an explicit allowlist of safe tools. Decide how public conversations are retained and moderated. Do not expose the private Connectome, Warudo bridge or voice app.
2. Implement an outbound worker for that public profile. The included personal adapter must continue to refuse public mode. Add authentication or an invitation gate, real per-visitor quotas, moderation and an operator stop control before enabling public turns.
3. Host one dedicated gateway process behind HTTPS. It needs persistent hosting; this in-memory queue is not a Vercel Function. For multiple instances, move sessions, jobs, leases and rate limits into shared storage.
4. Publish Warudo and its dedicated voice bus through a media relay. Add audio/video synchronization, disconnect recovery, TURN and a viewer cap; test from another network.
5. Configure the Vercel visitor proxy only after those pieces are ready. Unconfigured deployments show a closed room with a saved preview. There is no public agent connection in this branch.

Server environment names (values must be generated and kept out of Git):

| Variable                   | Where            | Purpose                                                                         |
| -------------------------- | ---------------- | ------------------------------------------------------------------------------- |
| `NODUS_SESSION_SECRET`     | Gateway          | Random session signing secret, at least 32 characters                           |
| `NODUS_WORKER_TOKEN`       | Gateway + worker | Separate random worker credential, at least 32 characters                       |
| `NODUS_PROXY_TOKEN`        | Gateway + Vercel | Separate random visitor-proxy credential, at least 32 characters                |
| `NODUS_MODE`               | Gateway          | `public` for the future isolated deployment; local preview defaults to loopback |
| `NODUS_SITE_ORIGIN`        | Gateway          | Exact public website origin                                                     |
| `NODUS_MAX_TURNS`          | Gateway          | Conversation cap per run, defaults to 60                                        |
| `NODUS_GATEWAY_URL`        | Vercel           | HTTPS origin of the dedicated gateway                                           |
| `NODUS_PUBLIC_SITE_ORIGIN` | Vercel           | Exact allowed website origin                                                    |

The standalone gateway CLI binds loopback only. Public hosting should use a controlled HTTPS reverse proxy to it, not remove that boundary or tunnel the personal app. The Vercel function forwards an exact allowlist of visitor routes and never forwards worker or publisher routes. Provider keys remain on the agent/voice host. A Vercel preview URL must be deliberately configured as an allowed origin; do not use wildcard origins.

## Validation

Local checks on October 16, 2026: 10 integration tests passed; the production build, archive HTML/link checks and focused lint passed. One real website turn reached the existing Nodus agent, completed native ElevenLabs playback and returned the spoken text to the shared transcript. A browser-selected Warudo window reached a viewer at 2880×1728 with advancing playback. Remote speech capture was not tested; video was shared without an audio input. Desktop and narrow layouts were inspected. Multiple-tab camera isolation has an integration test; the public relay and isolated public agent are not installed.

The repository-wide `npm run lint` still reports 174 errors in pre-existing archive components and vendored scripts. Those files are outside this change; the focused check below passes. The Windows launchers passed a syntax check. `Stop Nodus Website.cmd` stops only launcher-recorded Node processes whose process ID and start time still match; it leaves the personal services running.

```sh
npm run test:nodus
npm run build
node tools/check-static-html.mjs
npx eslint public/nodus/nodus.js server/operator.js 'api/nodus/[...path].js' vite.config.js src/data/projects.js
```

Tests cover two independent visitor sessions, FIFO ordering, ownership and CSRF, worker credentials, stale leases, no automatic retries, spending cap, signalling isolation, the voice playback acknowledgement, and the proxy's route and credential boundaries. The saved image is a flattened preview of the room; avatar model and scene source files are not included.
