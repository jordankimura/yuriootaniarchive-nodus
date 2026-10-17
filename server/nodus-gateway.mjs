import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { serveSite } from "./static-site.mjs";

const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const id = () => crypto.randomBytes(24).toString("base64url");
const loopback = (host) =>
  ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
// Idle visitors are dropped so a day of traffic cannot fill the session cap.
const SESSION_IDLE_MS = 30 * 60 * 1000;
export function createGateway({
  secret,
  workerToken,
  proxyToken = "",
  siteOrigin = "http://127.0.0.1:5175",
  mode = "local-preview",
  now = Date.now,
  maxTurns = 60,
  cooldownMs = 20000,
  siteRoot = "",
  localControls = false,
  turn = null,
  fetchImpl = fetch,
} = {}) {
  if (!secret || secret.length < 32 || !workerToken || workerToken.length < 32)
    throw Error(
      "Set separate random session and worker secrets (at least 32 characters).",
    );
  if (!["local-preview", "public"].includes(mode))
    throw Error("Unknown room mode.");
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 1000)
    throw Error("Choose a conversation cap of 1–1000 turns.");
  if (mode === "public" && (!proxyToken || proxyToken.length < 32))
    throw Error("Public mode requires a separate proxy secret.");
  if (localControls && mode !== "public")
    throw Error("Separate local controls are only used by the public room.");
  if (siteRoot && mode !== "local-preview" && !localControls)
    throw Error("Only the local preview serves the website itself.");
  const origin = new URL(siteOrigin).origin;
  if (mode === "local-preview" && !loopback(new URL(origin).hostname))
    throw Error(
      "Private Nodus preview only accepts a loopback website origin.",
    );
  // The local preview answers on both loopback spellings of the same port.
  const origins = new Set([origin]);
  if (mode === "local-preview")
    for (const [from, to] of [
      ["127.0.0.1", "localhost"],
      ["localhost", "127.0.0.1"],
    ])
      if (new URL(origin).hostname === from) {
        const alias = new URL(origin);
        alias.hostname = to;
        origins.add(alias.origin);
      }
  if (
    turn &&
    (!/^[A-Za-z0-9_-]{8,128}$/.test(String(turn.keyId)) ||
      typeof turn.apiToken !== "string" ||
      turn.apiToken.length < 16)
  )
    throw Error("The TURN relay key id or token is invalid.");
  // Short-lived relay credentials from Cloudflare. The TURN key never leaves this PC;
  // browsers get credentials that expire, refreshed well before they do.
  const STUN_ONLY = [{ urls: "stun:stun.l.google.com:19302" }];
  let ice = { servers: STUN_ONLY, refresh: -Infinity };
  async function iceServers() {
    if (!turn || now() < ice.refresh) return ice.servers;
    try {
      const r = await fetchImpl(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${turn.keyId}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + turn.apiToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ttl: 14400 }),
          signal: AbortSignal.timeout(5000),
          redirect: "error",
        },
      );
      if (!r.ok) throw Error("TURN credentials request failed.");
      const servers = (await r.json()).iceServers
        .map((server) => ({
          ...server,
          urls: [server.urls]
            .flat()
            .filter((url) => typeof url === "string" && !/:53(\?|$)/.test(url)),
        }))
        .filter((server) => server.urls.length);
      if (!servers.length) throw Error("No usable relay servers.");
      ice = { servers, refresh: now() + 2 * 3600000 };
    } catch {
      ice = { servers: STUN_ONLY, refresh: now() + 60000 };
    }
    return ice.servers;
  }
  const sessions = new Map(),
    operators = new Map(),
    jobs = [],
    transcript = [],
    signals = new Map(),
    rates = new Map();
  let workerAt = -Infinity,
    workerReady = false,
    workerBusy = false,
    workerCamera = false,
    cameraAt = -Infinity,
    cameraPreset = "conversation",
    videoSource = "window",
    publisherAt = -Infinity,
    active = null,
    turns = 0,
    sequence = 0;
  const sign = (value) =>
    crypto.createHmac("sha256", secret).update(value).digest("base64url");
  const cookie = (req, name) =>
    String(req.headers.cookie || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(name + "="))
      ?.slice(name.length + 1);
  const json = (res, status, data) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(JSON.stringify(data));
  };
  // When it also serves the site, the local room is its own origin.
  const allowed = (req, local = mode === "local-preview") =>
    !req.headers.origin ||
    origins.has(req.headers.origin) ||
    (local &&
      !!siteRoot &&
      req.headers.origin === "http://" + req.headers.host);
  const apiRoute = (route) =>
    route.startsWith("/worker/") ||
    route.startsWith("/operator") ||
    route.startsWith("/turns/") ||
    ["/session", "/state", "/ice", "/signals", "/signal", "/turns", "/camera", "/health"].includes(route);
  const worker = (req) =>
    equal(req.headers.authorization, "Bearer " + workerToken);
  const validSignal = (type, payload) =>
    type === "leave" || type === "reset"
      ? payload == null
      : type === "candidate"
        ? payload == null ||
          (typeof payload === "object" &&
            typeof payload.candidate === "string" &&
            payload.candidate.length < 4000)
        : payload &&
          payload.type === type &&
          typeof payload.sdp === "string" &&
          payload.sdp.length < 48000;
  function session(req) {
    const token = cookie(req, "nodus_stage");
    if (!token) return null;
    const [key, signature] = token.split(".");
    return equal(signature, sign(key)) ? sessions.get(key) : null;
  }
  function operator(req) {
    return operators.get(cookie(req, "nodus_publisher")) || null;
  }
  function videoChannel(req, s) {
    const view = req.headers["x-nodus-view"] || "legacy";
    if (view !== "legacy" && !/^[a-f0-9]{32}$/.test(view))
      throw Object.assign(Error("Invalid video connection."), { status: 400 });
    return s.id + ":" + view;
  }
  function clean() {
    for (const [key, s] of sessions)
      if (
        now() - s.seen > SESSION_IDLE_MS &&
        !jobs.some(
          (j) =>
            j.visitor === key && ["queued", "processing"].includes(j.status),
        )
      ) {
        sessions.delete(key);
        for (const channel of signals.keys())
          if (channel.startsWith(key + ":")) signals.delete(channel);
      }
    for (const [channel, list] of signals)
      if (now() - list.seen > 60000 || (list.left && now() - list.left > 10000))
        signals.delete(channel);
    for (const [key, s] of operators)
      if (now() - s.created > 43200000) operators.delete(key);
    for (const [key, r] of rates)
      if (now() - r.start > 60000) rates.delete(key);
    if (active && now() > active.expires) {
      active.status = "failed";
      active.error = "The reply timed out. It was not retried.";
      active = null;
    }
    while (
      jobs.length > 100 &&
      !["queued", "processing"].includes(jobs[0].status)
    )
      jobs.shift();
  }
  function state(s) {
    clean();
    return {
      mode,
      roomOpen: workerReady && now() - workerAt < 8000,
      phase:
        active?.type === "camera"
          ? "camera"
          : active
            ? "replying"
            : workerBusy
              ? "busy"
              : "idle",
      cameraAvailable:
        workerCamera &&
        now() - workerAt < 8000 &&
        !active &&
        !workerBusy &&
        !jobs.some((j) => j.status === "queued") &&
        now() - cameraAt >= 8000,
      cameraPreset,
      videoSource,
      videoAvailable: now() - publisherAt < 8000,
      queue: jobs
        .filter((j) => j.status === "queued")
        .map((j) => ({ id: j.id, name: j.name, mine: j.visitor === s.id })),
      current: active
        ? {
            id: active.id,
            name: active.name,
            type: active.type || "speech",
            mine: active.visitor === s.id,
          }
        : null,
      mine: jobs
        .filter((j) => j.visitor === s.id)
        .map((j) => ({ id: j.id, status: j.status, error: j.error }))
        .slice(-3),
      transcript: transcript.slice(-40),
      remainingTurns: Math.max(0, maxTurns - turns),
    };
  }
  async function body(req, max = 20000) {
    let text = "";
    for await (const chunk of req) {
      text += chunk;
      if (Buffer.byteLength(text) > max)
        throw Object.assign(Error("Request too large."), { status: 413 });
    }
    try {
      return JSON.parse(text || "{}");
    } catch {
      throw Object.assign(Error("Invalid request."), { status: 400 });
    }
  }
  // Behind the authenticated Vercel proxy, each visitor's address arrives in a header.
  function limit(req, door = false) {
    const forwarded = String(req.headers["x-nodus-client-ip"] || "");
    const key =
      door && /^[0-9a-fA-F:.]{2,45}$/.test(forwarded)
        ? "visitor:" + forwarded
        : req.socket.remoteAddress || "unknown";
    let r = rates.get(key);
    if (!r || now() - r.start > 60000) {
      r = { start: now(), count: 0 };
      rates.set(key, r);
    }
    if (++r.count > 40)
      throw Object.assign(Error("Please slow down."), { status: 429 });
  }
  // "door" is the main listener. In the public room, "controls" is a second,
  // loopback-only listener for the publisher, the worker and Jordan's local view.
  async function handle(req, res, surface) {
    const local = mode === "local-preview" || surface === "controls";
    const door = mode === "public" && surface === "door";
    try {
      const url = new URL(req.url, "http://gateway.local");
      let route = url.pathname;
      // The bundled local site calls the room API under /api/nodus, as it does on Vercel.
      // Only visitor routes are reachable there; worker and publisher controls never are.
      if (siteRoot && local && route.startsWith("/api/nodus/")) {
        route = route.slice("/api/nodus".length);
        if (
          route.startsWith("/worker/") ||
          route.startsWith("/operator") ||
          route === "/health"
        )
          return json(res, 404, { error: "Not found." });
      }
      clean();
      if (
        door &&
        localControls &&
        (route.startsWith("/worker/") || route.startsWith("/operator"))
      )
        return json(res, 404, { error: "Not found." });
      if (local) {
        if (
          !loopback(new URL("http://" + req.headers.host).hostname) ||
          req.headers["x-forwarded-for"] ||
          (!route.startsWith("/operator") && !allowed(req, true))
        )
          return json(res, 403, { error: "This preview is local only." });
      } else if (
        !route.startsWith("/worker/") &&
        !route.startsWith("/operator") &&
        (!proxyToken || !equal(req.headers["x-nodus-proxy-token"], proxyToken))
      )
        return json(res, 403, { error: "Use the website to enter this room." });
      if (
        !route.startsWith("/worker/") &&
        !route.startsWith("/operator") &&
        !allowed(req, local)
      )
        return json(res, 403, { error: "This website origin is not allowed." });
      if (
        siteRoot &&
        local &&
        ["GET", "HEAD"].includes(req.method) &&
        !apiRoute(route) &&
        !url.pathname.startsWith("/api/")
      )
        return serveSite(req, res, siteRoot);
      if (route.startsWith("/worker/")) {
        if (!worker(req))
          return json(res, 401, { error: "Worker authentication required." });
        if (req.method === "GET" && route === "/worker/config")
          return json(res, 200, { mode, siteOrigin: origin });
        if (req.method !== "POST")
          return json(res, 405, { error: "Method not allowed." });
        const data = await body(req);
        if (route === "/worker/heartbeat") {
          workerAt = now();
          workerReady = data.ready === true;
          workerBusy = data.busy === true;
          workerCamera = data.camera === true;
          if (active && data.id === active.id && equal(data.lease, active.lease))
            active.expires = Math.min(now() + 120000, active.deadline);
          return json(res, 200, { ok: true });
        }
        if (route === "/worker/claim") {
          if (now() - workerAt >= 8000 || active || workerBusy)
            return json(res, 200, { job: null });
          const job = jobs.find((j) => j.status === "queued");
          if (!job) return json(res, 200, { job: null });
          if (!workerReady && job.type !== "camera")
            return json(res, 200, { job: null });
          job.status = "processing";
          job.lease = id();
          job.expires = now() + 120000;
          job.deadline = now() + (job.type === "camera" ? 120000 : 510000);
          active = job;
          if (job.type !== "camera")
            transcript.push({
              id: ++sequence,
              role: "visitor",
              name: job.name,
              text: job.text,
              at: now(),
            });
          return json(res, 200, {
            job: {
              id: job.id,
              lease: job.lease,
              name: job.name,
              text: job.text,
              type: job.type || "speech",
              preset: job.preset,
            },
          });
        }
        if (route === "/worker/complete") {
          if (
            !active ||
            data.id !== active.id ||
            !equal(data.lease, active.lease)
          )
            return json(res, 409, { error: "This job is no longer active." });
          if (active.type === "camera") {
            active.status = data.ok === true ? "complete" : "failed";
            if (data.ok === true) cameraPreset = active.preset;
            else
              active.error =
                "The camera could not move. Try again when Nodus is resting.";
          } else if (
            data.ok === true &&
            typeof data.speech === "string" &&
            data.speech.trim() &&
            data.speech.length <= 4000
          ) {
            transcript.push({
              id: ++sequence,
              role: "nodus",
              name: "Nodus",
              text: data.speech,
              at: now(),
            });
            active.status = "complete";
          } else {
            active.status = "failed";
            active.error =
              "Nodus could not finish that reply. No automatic retry was made.";
          }
          active = null;
          return json(res, 200, { ok: true });
        }
        return json(res, 404, { error: "Not found." });
      }
      if (route === "/operator" || route === "/operator.js") {
        if (!local)
          return json(res, 404, {
            error: "Publisher setup is only served locally.",
          });
        const file = route === "/operator" ? "operator.html" : "operator.js";
        res.writeHead(200, {
          "Content-Type": file.endsWith(".js")
            ? "text/javascript"
            : "text/html",
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:8788; media-src 'self' blob:; frame-ancestors 'none'",
        });
        return res.end(await fs.readFile(new URL(file, import.meta.url)));
      }
      if (route === "/operator/session" && req.method === "POST") {
        if (
          !local ||
          !loopback(req.socket.remoteAddress?.replace("::ffff:", "")) ||
          req.headers.origin !== new URL("http://" + req.headers.host).origin
        )
          return json(res, 403, {
            error: "Publisher setup requires the local operator window.",
          });
        const token = id(),
          s = { csrf: id(), created: now() };
        operators.set(token, s);
        res.setHeader(
          "Set-Cookie",
          `nodus_publisher=${token}; HttpOnly; SameSite=Strict; Path=/operator`,
        );
        return json(res, 200, { csrf: s.csrf });
      }
      if (route.startsWith("/operator/")) {
        const op = operator(req);
        if (!op)
          return json(res, 401, { error: "Local publisher session required." });
        if (req.method === "GET" && route === "/operator/ice")
          return json(res, 200, { iceServers: await iceServers() });
        if (req.method === "GET" && route === "/operator/signals") {
          const entries = [];
          for (const [visitor, items] of signals)
            for (const message of items.filter(
              (m) =>
                m.to === "publisher" &&
                m.seq > Number(url.searchParams.get("after") || 0),
            ))
              entries.push({ visitor, ...message });
          return json(res, 200, { messages: entries, cursor: sequence });
        }
        if (
          req.method !== "POST" ||
          !equal(req.headers["x-nodus-csrf"], op.csrf) ||
          req.headers.origin !== new URL("http://" + req.headers.host).origin
        )
          return json(res, 403, { error: "Invalid publisher request." });
        const data = await body(req, 64000);
        if (route === "/operator/heartbeat") {
          publisherAt = now();
          videoSource = data.source === "camera" ? "camera" : "window";
          return json(res, 200, { ok: true });
        }
        if (route === "/operator/offline") {
          publisherAt = -Infinity;
          signals.clear();
          return json(res, 200, { ok: true });
        }
        if (route === "/operator/signal") {
          if (
            !sessions.has(String(data.visitor).split(":")[0]) ||
            !signals.has(data.visitor)
          )
            return json(res, 404, { error: "Visitor disconnected." });
          if (
            !["answer", "candidate", "reset"].includes(data.type) ||
            !validSignal(data.type, data.payload)
          )
            return json(res, 400, { error: "Unsupported signal." });
          const list = signals.get(data.visitor);
          if (list.length >= 100)
            return json(res, 429, { error: "Too many signals." });
          list.push({
            seq: ++sequence,
            to: "visitor",
            type: data.type,
            payload: data.payload,
          });
          return json(res, 200, { ok: true });
        }
        return json(res, 404, { error: "Not found." });
      }
      if (route === "/health" && req.method === "GET")
        return json(res, 200, { app: "nodus-website-gateway", mode });
      if (route === "/session" && req.method === "POST") {
        if (!req.headers.origin || !allowed(req, local))
          return json(res, 403, { error: "Enter through the website." });
        limit(req, door);
        let s = session(req);
        if (!s) {
          if (sessions.size >= 100)
            return json(res, 503, {
              error: "The room is full. Try again later.",
            });
          const key = id();
          s = {
            id: key,
            name: "Guest " + crypto.randomInt(100, 999),
            csrf: id(),
            seen: now(),
            lastTurn: -Infinity,
          };
          sessions.set(key, s);
          res.setHeader(
            "Set-Cookie",
            `nodus_stage=${key}.${sign(key)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${door && new URL(origin).protocol === "https:" ? "; Secure" : ""}`,
          );
        }
        s.seen = now();
        return json(res, 200, { name: s.name, csrf: s.csrf, ...state(s) });
      }
      const s = session(req);
      if (!s) return json(res, 401, { error: "Join the room first." });
      s.seen = now();
      if (req.method === "GET" && route === "/state")
        return json(res, 200, state(s));
      if (req.method === "GET" && route === "/ice")
        return json(res, 200, { iceServers: await iceServers() });
      if (req.method === "GET" && route === "/signals") {
        const list = signals.get(videoChannel(req, s)) || [];
        list.seen = now();
        return json(res, 200, {
          messages: list.filter(
            (m) =>
              m.to === "visitor" &&
              m.seq > Number(url.searchParams.get("after") || 0),
          ),
          cursor: sequence,
        });
      }
      if (
        !["POST", "DELETE"].includes(req.method) ||
        !req.headers.origin ||
        !allowed(req, local) ||
        !equal(req.headers["x-nodus-csrf"], s.csrf)
      )
        return json(res, 403, {
          error: "Refresh the room before trying again.",
        });
      limit(req, door);
      // Offers carry their network addresses, so they can be larger than other requests.
      const data = await body(req, route === "/signal" ? 64000 : 20000);
      if (route === "/signal" && req.method === "POST") {
        if (
          !["offer", "candidate", "leave"].includes(data.type) ||
          !validSignal(data.type, data.payload)
        )
          return json(res, 400, { error: "Unsupported signal." });
        const channel = videoChannel(req, s);
        if (data.type === "offer") {
          if (
            !signals.has(channel) &&
            [...signals].filter(
              ([key, list]) => key.startsWith(s.id + ":") && !list.left,
            ).length >= 3
          )
            return json(res, 429, {
              error:
                "Too many open video connections. Close another tab and try again shortly.",
            });
          signals.set(channel, []);
        }
        const list = signals.get(channel);
        if (!list)
          return json(res, 409, { error: "Start a new video connection." });
        if (list.length >= 100)
          return json(res, 429, { error: "Too many signals." });
        list.seen = now();
        // A closed tab frees its slot once the publisher has had time to read the leave.
        if (data.type === "leave") list.left = now();
        list.push({
          seq: ++sequence,
          to: "publisher",
          type: data.type,
          payload: data.payload,
        });
        return json(res, 200, { ok: true });
      }
      if (route === "/camera" && req.method === "POST") {
        if (data.preset !== "conversation")
          return json(res, 400, { error: "The website uses the close view." });
        if (!workerCamera || now() - workerAt >= 8000)
          return json(res, 503, { error: "The camera controls are offline." });
        if (active || workerBusy || jobs.some((j) => j.status === "queued"))
          return json(res, 409, {
            error:
              "Let Nodus finish this turn before changing the shared camera.",
          });
        if (now() - cameraAt < 8000)
          return json(res, 429, {
            error: "Give the camera a moment before changing it again.",
          });
        cameraAt = now();
        const job = {
          id: id(),
          type: "camera",
          preset: data.preset,
          visitor: s.id,
          name: s.name,
          status: "queued",
          created: now(),
        };
        jobs.push(job);
        return json(res, 202, { id: job.id, ...state(s) });
      }
      if (route === "/turns" && req.method === "POST") {
        if (!workerReady || now() - workerAt >= 8000)
          return json(res, 503, {
            error: "Nodus is resting. Come back when the room opens.",
          });
        if (turns >= maxTurns)
          return json(res, 429, {
            error: "This session has reached its conversation limit.",
          });
        if (
          jobs.some(
            (j) =>
              j.visitor === s.id && ["queued", "processing"].includes(j.status),
          )
        )
          return json(res, 409, {
            error: "Let Nodus finish your current turn first.",
          });
        if (jobs.filter((j) => j.status === "queued").length >= 12)
          return json(res, 429, {
            error: "The queue is full. Please try again shortly.",
          });
        if (now() - s.lastTurn < cooldownMs)
          return json(res, 429, {
            error: "Give someone else a turn; try again in a moment.",
          });
        const text = typeof data.text === "string" ? data.text.trim() : "";
        if (
          !text ||
          text.length > 600 ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)
        )
          return json(res, 400, {
            error: "Write a message of 1–600 characters.",
          });
        if (data.public !== true)
          return json(res, 400, {
            error: "Please acknowledge that this is a shared room.",
          });
        const job = {
          id: id(),
          visitor: s.id,
          name: s.name,
          text,
          status: "queued",
          created: now(),
        };
        jobs.push(job);
        s.lastTurn = now();
        turns++;
        return json(res, 202, { id: job.id, ...state(s) });
      }
      if (route.startsWith("/turns/") && req.method === "DELETE") {
        const job = jobs.find(
          (j) => j.id === route.slice(7) && j.visitor === s.id,
        );
        if (!job || job.status !== "queued")
          return json(res, 409, {
            error: "Only your waiting turn can be cancelled.",
          });
        job.status = "cancelled";
        return json(res, 200, state(s));
      }
      return json(res, 404, { error: "Not found." });
    } catch (error) {
      json(res, error.status || 500, {
        error: error.status
          ? error.message
          : "The room could not handle this request.",
      });
    }
  }
  const server = http.createServer((req, res) => handle(req, res, "door"));
  if (localControls)
    server.controls = http.createServer((req, res) =>
      handle(req, res, "controls"),
    );
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createGateway({
    secret: process.env.NODUS_SESSION_SECRET,
    workerToken: process.env.NODUS_WORKER_TOKEN,
    proxyToken: process.env.NODUS_PROXY_TOKEN,
    siteOrigin: process.env.NODUS_SITE_ORIGIN,
    mode: process.env.NODUS_MODE || "local-preview",
    maxTurns: Number(process.env.NODUS_MAX_TURNS || 60),
  });
  server.listen(
    Number(process.env.NODUS_GATEWAY_PORT || 8794),
    "127.0.0.1",
    () => console.log("Nodus gateway listening on loopback."),
  );
}
