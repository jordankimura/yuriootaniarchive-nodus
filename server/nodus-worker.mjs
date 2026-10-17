import WebSocket from "ws";
import { setTimeout as pause } from "node:timers/promises";
const loopback = (url) =>
  ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
export async function assertPrivatePreview({ gateway, app, config, enabled }) {
  if (
    enabled !== true ||
    config.mode !== "local-preview" ||
    !loopback(gateway) ||
    !loopback(app) ||
    !loopback(config.siteOrigin)
  )
    throw Error(
      "The personal Nodus adapter is only available in an explicitly enabled loopback preview. A public profile with isolated memory and restricted tools is required before deployment.",
    );
}
export function speak(app, text, { timeoutMs = 110000 } = {}) {
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
      ws.close();
      if (error) reject(error);
      else resolve(speech);
    };
    const timer = setTimeout(
      () => finish(Error("Voice reply timed out.")),
      timeoutMs,
    );
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          type: "turn",
          text,
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
  });
  let busy = false,
    stopped = false;
  const heartbeat = async () => {
    try {
      const r = await fetch(app + "/api/status", {
        signal: AbortSignal.timeout(3000),
        redirect: "error",
      });
      const s = await r.json();
      const ready =
        r.ok &&
        s.hasVoiceKey &&
        s.brainConnected &&
        (busy || (!s.busy && !s.brainBusy));
      await call("heartbeat", { ready, busy });
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
      try {
        // This local pilot still uses Jordan's private voice channel. Never enable this adapter for public visitors.
        const text = `Private website prototype: a visitor labelled ${job.name} asks the following. Answer in your usual voice; keep this reply brief.\n\n${job.text}`;
        const speech = await speak(app, text);
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
        await heartbeat();
      }
    }
  } finally {
    stopped = true;
    clearInterval(interval);
    await call("heartbeat", { ready: false, busy: false }).catch(() => {});
  }
}
