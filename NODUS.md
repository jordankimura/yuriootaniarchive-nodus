# Nodus shared room prototype

The `/nodus/` page adds a Warudo viewport and a public conversation to the existing archive. Everyone watches the same character. Visitors get an anonymous browser session and take turns through a queue. This branch does **not** deploy or enable public access to Jordan's personal agent.

## Run locally

Requires Node 22+ (tested on Node 24) and the existing Nodus voice app with its ElevenLabs voice loaded. No provider keys belong in this repository or in browser code. After installing dependencies once, Windows users can double-click `scripts/Start Nodus Website.cmd`. It starts missing preview services and opens the publisher; it does not start Warudo or Connectome. Selecting the shared window remains a browser action each time a new share starts.

```sh
npm ci
npm run nodus:local -- --connect-private-nodus
# In a second terminal:
npm run dev
```

- Website: `http://127.0.0.1:5175/nodus/`
- Local camera publisher: `http://127.0.0.1:8794/operator`
- Existing personal voice app, used only by the local worker: `http://127.0.0.1:8788`

Use **Join the room** and send a short message. The gateway queues it, the local worker asks Nodus, and the existing voice controller performs the reply in Warudo. A turn finishes after audio playback finishes. The public transcript contains the visitor's message and Nodus's final spoken text. Tool output, reasoning, provider keys and local controller endpoints are not returned to the page.

The local adapter still uses Jordan's existing private voice channel and memory. It is suitable for Jordan's own test, **not for untrusted visitors**. Its explicit flag, loopback checks and mode check are deliberate. The provided worker refuses public mode; changing the hostname is not a supported deployment method.

## Video and sound

On the local publisher page, choose **Share Warudo window**, then select the dedicated Warudo output window in the browser's sharing picker. Check the publisher preview before connecting viewers. The page never starts desktop capture automatically. Closing the share or the publisher stops new frames; the visitor page falls back to a clearly labelled saved preview.

The prototype uses WebRTC with HTTP signalling. Viewers do not grant microphone or camera access. It sends a separate peer connection per viewer, suitable for a small pilot. The STUN server sees network connection metadata. TURN is not configured, so some networks will fail to connect. For public use, replace this publisher with an authenticated media relay/SFU such as LiveKit, with TURN, viewer tokens, bandwidth limits and access control. The public-mode operator flow is intentionally not implemented.

Warudo's window is not the source of Nodus's synthesized audio: the existing controller plays it separately. Sharing the window therefore starts with **video only**. The publisher offers an optional audio input for a dedicated virtual cable carrying only Nodus's speech. Listing devices asks for input permission briefly, then closes the probe. Audio capture starts only when sharing starts with a selected source. Selecting the physical microphone would broadcast the room; leave the selector on Video only unless the routing is known. There is no visitor voice input in this version.

## Queue and identity

- Signed, HttpOnly anonymous cookie; no IP address is treated as a person's identity.
- Public transcript and shared replies, explicitly disclosed before submitting a message.
- One pending turn per visitor; at most 12 waiting turns; 600 characters per message.
- 20-second per-visitor cooldown and 60 accepted turns per gateway run by default (cancellations still consume the cap).
- One worker lease at a time. A timed-out or failed generation is never automatically retried.
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
