import test from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "./nodus-gateway.mjs";
import { assertPrivatePreview, speak } from "./nodus-worker.mjs";
import http from "node:http";
import { WebSocketServer } from "ws";
const origin = "http://127.0.0.1:5175",
  token = "w".repeat(40);
async function fixture(t, options = {}) {
  let clock = 1000000;
  const server = createGateway({
    secret: "s".repeat(40),
    workerToken: token,
    now: () => clock,
    cooldownMs: 0,
    ...options,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = "http://127.0.0.1:" + server.address().port;
  const call = async (
    path,
    { method = "GET", body, headers = {}, user } = {},
  ) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(method !== "GET"
          ? { Origin: origin, "Content-Type": "application/json" }
          : {}),
        ...(user ? { Cookie: user.cookie, "X-Nodus-CSRF": user.csrf } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: res.status,
      data: await res.json(),
      cookie: res.headers.get("set-cookie")?.split(";")[0],
    };
  };
  const visitor = async () => {
    const r = await call("/session", { method: "POST", body: {} });
    assert.equal(r.status, 200);
    return { cookie: r.cookie, csrf: r.data.csrf, name: r.data.name };
  };
  const worker = (path, body = {}) =>
    call("/worker/" + path, {
      method: "POST",
      body,
      headers: { Authorization: "Bearer " + token },
    });
  return { base, call, visitor, worker, tick: (ms) => (clock += ms) };
}
test("sessions, origin and CSRF protect visitor mutations", async (t) => {
  const { call, visitor, worker } = await fixture(t);
  assert.equal((await call("/state")).status, 401);
  assert.equal(
    (
      await call("/session", {
        method: "POST",
        body: {},
        headers: { Origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  const user = await visitor();
  await worker("heartbeat", { ready: true });
  assert.equal(
    (
      await call("/turns", {
        method: "POST",
        body: { text: "hello", public: true },
        headers: { Cookie: user.cookie },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call("/turns", {
        method: "POST",
        user,
        body: { text: "hello", public: false },
      })
    ).status,
    400,
  );
  assert.equal((await call("/worker/config")).status, 401);
});
test("two visitors are queued in order, with ownership and one pending turn each", async (t) => {
  const { call, visitor, worker } = await fixture(t);
  const a = await visitor(),
    b = await visitor();
  await worker("heartbeat", { ready: true });
  const first = await call("/turns", {
      method: "POST",
      user: a,
      body: { text: "a", public: true },
    }),
    second = await call("/turns", {
      method: "POST",
      user: b,
      body: { text: "b", public: true },
    });
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(
    (
      await call("/turns", {
        method: "POST",
        user: a,
        body: { text: "extra", public: true },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call("/turns/" + first.data.id, {
        method: "DELETE",
        user: b,
        body: {},
      })
    ).status,
    409,
  );
  let claimed = await worker("claim");
  assert.equal(claimed.data.job.text, "a");
  assert.equal((await worker("claim")).data.job, null);
  const job = claimed.data.job;
  assert.equal(
    (
      await worker("complete", {
        id: job.id,
        lease: "wrong",
        ok: true,
        speech: "secret",
      })
    ).status,
    409,
  );
  assert.equal(
    (await worker("complete", { ...job, ok: true, speech: "Public reply." }))
      .status,
    200,
  );
  assert.equal(
    (await worker("complete", { ...job, ok: true, speech: "Duplicate." }))
      .status,
    409,
  );
  claimed = await worker("claim");
  assert.equal(claimed.data.job.text, "b");
  const s = (await call("/state", { user: a })).data;
  assert.deepEqual(
    s.transcript.map((x) => x.text),
    ["a", "Public reply.", "b"],
  );
  assert.equal(JSON.stringify(s).includes(job.lease), false);
});
test("expired jobs are not retried, and conversation spending is capped", async (t) => {
  const { call, visitor, worker, tick } = await fixture(t, { maxTurns: 1 });
  const user = await visitor();
  await worker("heartbeat", { ready: true });
  await call("/turns", {
    method: "POST",
    user,
    body: { text: "one", public: true },
  });
  await worker("claim");
  tick(120001);
  await worker("heartbeat", { ready: true });
  assert.equal((await worker("claim")).data.job, null);
  assert.equal((await call("/state", { user })).data.mine[0].status, "failed");
  assert.equal(
    (
      await call("/turns", {
        method: "POST",
        user,
        body: { text: "two", public: true },
      })
    ).status,
    429,
  );
});

test("long speech renews only its own queue lease and still has a hard deadline", async (t) => {
  const { call, visitor, worker, tick } = await fixture(t);
  const user = await visitor();
  await worker("heartbeat", { ready: true });
  await call("/turns", { method: "POST", user, body: { text: "A long answer", public: true } });
  const { job } = (await worker("claim")).data;
  for (let i = 0; i < 5; i++) {
    tick(90000);
    await worker("heartbeat", { ready: true, busy: true, id: job.id, lease: job.lease });
    assert.equal((await call("/state", { user })).data.mine[0].status, "processing");
    assert.equal((await worker("claim")).data.job, null);
  }
  tick(60001);
  await worker("heartbeat", { ready: true, busy: true, id: job.id, lease: job.lease });
  assert.equal((await call("/state", { user })).data.mine[0].status, "failed");
  assert.equal((await worker("complete", { ...job, ok: true, speech: "Late" })).status, 409);
});

test("an incorrect heartbeat lease cannot extend an abandoned voice job", async t => {
  const { call, visitor, worker, tick } = await fixture(t);
  const user = await visitor();
  await worker("heartbeat", { ready: true });
  await call("/turns", { method: "POST", user, body: { text: "A turn", public: true } });
  const { job } = (await worker("claim")).data;
  tick(90000);
  await worker("heartbeat", { ready: true, busy: true, id: job.id, lease: "wrong" });
  tick(30001);
  assert.equal((await call("/state", { user })).data.mine[0].status, "failed");
});
test("waiting turns can be cancelled; worker offline closes the room", async (t) => {
  const { call, visitor, worker, tick } = await fixture(t);
  const user = await visitor();
  assert.equal(
    (
      await call("/turns", {
        method: "POST",
        user,
        body: { text: "one", public: true },
      })
    ).status,
    503,
  );
  await worker("heartbeat", { ready: true });
  const j = await call("/turns", {
    method: "POST",
    user,
    body: { text: "one", public: true },
  });
  assert.equal(
    (await call("/turns/" + j.data.id, { method: "DELETE", user, body: {} }))
      .status,
    200,
  );
  assert.equal((await worker("claim")).data.job, null);
  tick(8001);
  assert.equal((await call("/state", { user })).data.roomOpen, false);
});
test("publisher signalling is authenticated, isolated per visitor and validates payloads", async (t) => {
  const { base, call, visitor } = await fixture(t);
  const a = await visitor(),
    b = await visitor();
  assert.equal((await call("/operator/signals")).status, 401);
  const op = await call("/operator/session", {
    method: "POST",
    body: {},
    headers: { Origin: base },
  });
  assert.equal(op.status, 200);
  const headers = {
    Cookie: op.cookie,
    "X-Nodus-CSRF": op.data.csrf,
    Origin: base,
  };
  assert.equal(
    (await call("/operator/heartbeat", { method: "POST", body: {}, headers }))
      .status,
    200,
  );
  assert.equal(
    (
      await call("/signal", {
        method: "POST",
        user: a,
        body: { type: "offer", payload: { type: "offer", sdp: "test" } },
      })
    ).status,
    200,
  );
  const incoming = await call("/operator/signals", { headers });
  const visitorId = incoming.data.messages[0].visitor;
  assert.equal(
    (
      await call("/operator/signal", {
        method: "POST",
        headers,
        body: {
          visitor: visitorId,
          type: "answer",
          payload: { type: "answer", sdp: "answer" },
        },
      })
    ).status,
    200,
  );
  assert.equal((await call("/signals", { user: a })).data.messages.length, 1);
  assert.equal((await call("/signals", { user: b })).data.messages.length, 0);
  assert.equal(
    (
      await call("/signal", {
        method: "POST",
        user: b,
        body: { type: "offer", payload: "broken" },
      })
    ).status,
    400,
  );
});
test("separate tabs keep independent video channels within one visitor session", async (t) => {
  const { base, call, visitor, tick } = await fixture(t);
  const a = await visitor();
  const op = await call("/operator/session", {
    method: "POST",
    body: {},
    headers: { Origin: base },
  });
  const operatorHeaders = {
    Cookie: op.cookie,
    "X-Nodus-CSRF": op.data.csrf,
    Origin: base,
  };
  for (const digit of ["1", "2"])
    await call("/signal", {
      method: "POST",
      user: a,
      headers: { "X-Nodus-View": digit.repeat(32) },
      body: {
        type: "offer",
        payload: { type: "offer", sdp: "offer " + digit },
      },
    });
  const incoming = (
    await call("/operator/signals", { headers: operatorHeaders })
  ).data.messages;
  assert.equal(incoming.length, 2);
  assert.notEqual(incoming[0].visitor, incoming[1].visitor);
  await call("/operator/signal", {
    method: "POST",
    headers: operatorHeaders,
    body: {
      visitor: incoming[0].visitor,
      type: "answer",
      payload: { type: "answer", sdp: "first tab only" },
    },
  });
  assert.equal(
    (
      await call("/signals", {
        user: a,
        headers: { "X-Nodus-View": "1".repeat(32) },
      })
    ).data.messages.length,
    1,
  );
  assert.equal(
    (
      await call("/signals", {
        user: a,
        headers: { "X-Nodus-View": "2".repeat(32) },
      })
    ).data.messages.length,
    0,
  );
  tick(60001);
  assert.equal(
    (await call("/operator/signals", { headers: operatorHeaders })).data
      .messages.length,
    0,
  );
});
test("idle sessions expire after 30 minutes unless the visitor has a turn waiting", async (t) => {
  const { call, visitor, worker, tick } = await fixture(t);
  const idle = await visitor(),
    waiting = await visitor();
  await worker("heartbeat", { ready: true });
  assert.equal(
    (
      await call("/turns", {
        method: "POST",
        user: waiting,
        body: { text: "still here", public: true },
      })
    ).status,
    202,
  );
  tick(29 * 60 * 1000);
  assert.equal((await call("/state", { user: idle })).status, 200);
  tick(31 * 60 * 1000);
  assert.equal((await call("/state", { user: idle })).status, 401);
  assert.equal((await call("/state", { user: waiting })).status, 200);
});
test("a leaving tab reaches the publisher and frees its video slot", async (t) => {
  const { base, call, visitor, tick } = await fixture(t);
  const a = await visitor();
  const op = await call("/operator/session", {
    method: "POST",
    body: {},
    headers: { Origin: base },
  });
  const operatorHeaders = {
    Cookie: op.cookie,
    "X-Nodus-CSRF": op.data.csrf,
    Origin: base,
  };
  const offer = (digit) =>
    call("/signal", {
      method: "POST",
      user: a,
      headers: { "X-Nodus-View": digit.repeat(32) },
      body: { type: "offer", payload: { type: "offer", sdp: "tab " + digit } },
    });
  for (const digit of ["1", "2", "3"]) assert.equal((await offer(digit)).status, 200);
  assert.equal((await offer("4")).status, 429);
  assert.equal(
    (
      await call("/signal", {
        method: "POST",
        user: a,
        headers: { "X-Nodus-View": "1".repeat(32) },
        body: { type: "leave" },
      })
    ).status,
    200,
  );
  const messages = (await call("/operator/signals", { headers: operatorHeaders }))
    .data.messages;
  assert.ok(messages.some((m) => m.type === "leave"));
  assert.equal((await offer("4")).status, 200);
  tick(10001);
  assert.equal(
    (
      await call("/signals", {
        user: a,
        headers: { "X-Nodus-View": "1".repeat(32) },
      })
    ).data.messages.length,
    0,
  );
});
test("the local preview accepts both loopback spellings of the site origin only", async (t) => {
  const { call } = await fixture(t);
  for (const [site, status] of [
    ["http://localhost:5175", 200],
    ["http://127.0.0.1:5175", 200],
    ["http://localhost:5176", 403],
  ])
    assert.equal(
      (
        await call("/session", {
          method: "POST",
          body: {},
          headers: { Origin: site },
        })
      ).status,
      status,
    );
});
test("public mode requires proxy authentication and refuses the private Nodus adapter", async (t) => {
  const { call } = await fixture(t, {
    mode: "public",
    siteOrigin: "https://example.com",
    proxyToken: "p".repeat(40),
  });
  assert.equal(
    (
      await call("/session", {
        method: "POST",
        body: {},
        headers: { Origin: "https://example.com" },
      })
    ).status,
    403,
  );
  const r = await call("/session", {
    method: "POST",
    body: {},
    headers: {
      Origin: "https://example.com",
      "X-Nodus-Proxy-Token": "p".repeat(40),
    },
  });
  assert.equal(r.status, 200);
  assert.match(r.cookie, /nodus_stage=/);
  await assert.rejects(
    assertPrivatePreview({
      gateway: "http://127.0.0.1:8794",
      app: "http://127.0.0.1:8788",
      config: { mode: "public", siteOrigin: "https://example.com" },
      enabled: true,
    }),
    /public profile/,
  );
  await assert.rejects(
    assertPrivatePreview({
      gateway: "https://remote.example",
      app: "http://127.0.0.1:8788",
      config: { mode: "local-preview", siteOrigin: origin },
      enabled: true,
    }),
  );
});
test("voice adapter acknowledges playback and waits for audio completion", async (t) => {
  const server = http.createServer(),
    wss = new WebSocketServer({ server });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    wss.close();
    server.close();
  });
  let acknowledged = false;
  wss.on("connection", (ws, req) => {
    assert.equal(
      req.headers.origin,
      "http://127.0.0.1:" + server.address().port,
    );
    ws.on("message", (raw) => {
      const e = JSON.parse(raw);
      if (e.type === "turn")
        ws.send(JSON.stringify({ type: "reply", text: "A fixture reply." }));
      if (e.type === "playback-ready") {
        acknowledged = true;
        ws.send(JSON.stringify({ type: "speech-segment", index: 0, total: 2 }));
        ws.send(JSON.stringify({ type: "performance-complete" }));
        setTimeout(() => {
          assert.equal(ws.readyState, 1);
          ws.send(JSON.stringify({ type: "speech-segment", index: 1, total: 2 }));
          ws.send(JSON.stringify({ type: "audio-end" }));
        }, 20);
      }
    });
  });
  assert.equal(
    await speak("http://127.0.0.1:" + server.address().port, "A test"),
    "A fixture reply.",
  );
  assert.equal(acknowledged, true);
});
