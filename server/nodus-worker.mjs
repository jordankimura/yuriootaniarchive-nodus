import WebSocket from "ws";
import { setTimeout as pause } from "node:timers/promises";
const loopback = (url) =>
  ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
// The personal adapter always runs on this PC. Public visitors reach it only when
// Jordan explicitly opens the public room; otherwise a public profile is required.
export async function assertPrivatePreview({
  gateway,
  app,
  config,
  enabled,
  publicRoom = false,
}) {
  const room =
    config.mode === "local-preview"
      ? loopback(config.siteOrigin)
      : publicRoom === true &&
        config.mode === "public" &&
        new URL(config.siteOrigin).protocol === "https:";
  if (enabled !== true || !room || !loopback(gateway) || !loopback(app))
    throw Error(
      "The personal Nodus adapter is only available in an explicitly enabled loopback preview, or when Jordan opens the public room. Otherwise a public profile with isolated memory and restricted tools is required.",
    );
}
export function speak(app, text, { timeoutMs = 490000, signal, visitor } = {}) {
  if (signal?.aborted) return Promise.reject(Error("Voice reply cancelled."));
  return new Promise((resolve, reject) => {
    const url = new URL("/talk", app);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url, {
      origin: new URL(app).origin,
      maxPayload: 2 * 1024 * 1024,
    });
    let speech = "",
      finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      ws.close();
      if (error) reject(error);
      else resolve(speech);
    };
    const timer = setTimeout(
      () => finish(Error("Voice reply timed out.")),
      timeoutMs,
    );
    const cancel = () => finish(Error("Voice reply cancelled."));
    signal?.addEventListener("abort", cancel, { once: true });
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          type: "turn",
          text,
          ...(visitor ? { visitor } : {}),
          model: "eleven_v4_turbo",
          performance: true,
        }),
      ),
    );
    ws.on("message", (raw, binary) => {
      if (binary) return;
      let e;
      try {
        e = JSON.parse(raw);
      } catch {
        return;
      }
      if (e.type === "reply") {
        speech = typeof e.text === "string" ? e.text : "";
        ws.send(JSON.stringify({ type: "playback-ready" }));
      }
      if (e.type === "audio-end")
        finish(speech ? null : Error("No spoken reply."));
      if (e.type === "error")
        finish(Error("Nodus could not finish the voice reply."));
    });
    ws.on("error", () =>
      finish(Error("Could not reach the local Nodus voice app.")),
    );
    ws.on("close", () => {
      if (!finished)
        finish(Error("The voice connection ended before the reply finished."));
    });
  });
}
export async function runWorker({
  gateway = "http://127.0.0.1:8794",
  app = "http://127.0.0.1:8788",
  token,
  allowPrivatePreview = false,
  allowPublicRoom = false,
  setCamera,
  signal,
} = {}) {
  if (!token) throw Error("A worker token is required.");
  const call = async (path, data) => {
    const r = await fetch(gateway + "/worker/" + path, {
      method: data ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + token,
        ...(data ? { "Content-Type": "application/json" } : {}),
      },
      body: data ? JSON.stringify(data) : undefined,
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!r.ok) throw Error("The room worker request failed.");
    return r.json();
  };
  const config = await call("config");
  await assertPrivatePreview({
    gateway,
    app,
    config,
    enabled: allowPrivatePreview,
    publicRoom: allowPublicRoom,
  });
  let activeJob = null,
    visitorTurns = false;
  let busy = false,
    stopped = false;
  const heartbeat = async () => {
    try {
      const r = await fetch(app + "/api/status", {
        signal: AbortSignal.timeout(3000),
        redirect: "error",
      });
      const s = await r.json();
      visitorTurns = s.visitorTurns === true;
      const ready =
        r.ok &&
        s.hasVoiceKey &&
        s.brainConnected &&
        (busy || (!s.busy && !s.brainBusy));
      await call("heartbeat", {
        ready,
        busy: busy || s.busy || s.brainBusy,
        camera: typeof setCamera === "function",
        ...(activeJob ? { id: activeJob.id, lease: activeJob.lease } : {}),
      });
    } catch {
      await call("heartbeat", { ready: false, busy }).catch(() => {});
    }
  };
  await heartbeat();
  const interval = setInterval(() => {
    if (!stopped) void heartbeat();
  }, 2500);
  try {
    while (!signal?.aborted) {
      let job;
      try {
        ({ job } = await call("claim", {}));
      } catch {
        await pause(1500);
        continue;
      }
      if (!job) {
        await pause(1000);
        continue;
      }
      busy = true;
      activeJob = job;
      try {
        if (job.type === "camera") {
          if (typeof setCamera !== "function")
            throw Error("Camera unavailable.");
          await setCamera(job.preset);
          await call("complete", { id: job.id, lease: job.lease, ok: true });
          continue;
        }
        // This local pilot still uses Jordan's private voice channel. Never enable this adapter for public visitors.
        // A current voice app frames the turn as the visitor; an older one still wraps everything as Jordan's speech.
        const text = visitorTurns
          ? job.text
          : `A public website visitor labelled ${job.name}, who is not Jordan, asks the following. Keep this reply brief.\n\n${job.text}`;
        const speech = await speak(app, text, {
          signal,
          visitor: visitorTurns ? job.name : undefined,
        });
        await call("complete", {
          id: job.id,
          lease: job.lease,
          ok: true,
          speech,
        });
      } catch {
        await call("complete", {
          id: job.id,
          lease: job.lease,
          ok: false,
        }).catch(() => {});
        console.error("A website preview turn failed; it was not retried.");
      } finally {
        busy = false;
        activeJob = null;
        await heartbeat();
      }
    }
  } finally {
    stopped = true;
    clearInterval(interval);
    await call("heartbeat", { ready: false, busy: false }).catch(() => {});
  }
}
