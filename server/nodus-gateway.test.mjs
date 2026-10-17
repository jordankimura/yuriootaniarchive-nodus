import test from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "./nodus-gateway.mjs";
import { assertPrivatePreview, speak } from "./nodus-worker.mjs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
const origin = "http://127.0.0.1:5175",
  token = "w".repeat(40);

test('reply states require evidence and are shared with other visitors', async t => {
  const { call, visitor, worker, tick } = await fixture(t);
  const user = await visitor(), observer = await visitor();
  for (const [completion, expected] of [
    [{ok:true, outcome:'quiet'}, 'quiet'],
    [{ok:true, speech:''}, 'unknown'],
    [{ok:false}, 'unknown'],
    [{ok:false, outcome:'unknown'}, 'unknown'],
    [{ok:false, outcome:'failed'}, 'failed'],
    [{ok:true, speech:'A reply'}, 'idle'],
  ]) {
    await worker('heartbeat', {ready:true});
    await call('/turns', {method:'POST', user, body:{text:'Hello', public:true}});
    const {job} = (await worker('claim')).data;
    assert.equal((await call('/state',{user:observer})).data.activity.state,'working');
    tick(8001);
    assert.equal((await call('/state',{user:observer})).data.activity.state,'unknown');
    await worker('heartbeat',{ready:true,id:job.id,lease:job.lease});
    assert.equal((await call('/state',{user:observer})).data.activity.state,'working');
    await worker('complete',{...job,...completion});
    const state=(await call('/state',{user:observer})).data;
    assert.equal(state.activity.state,expected);
    assert.equal(state.transcript.filter(m=>m.role==='nodus').length,expected==='idle'?1:0);
  }
});

test('voice adapter distinguishes explicit quiet, empty output, errors, and timeout', async t => {
  const server=http.createServer(), wss=new WebSocketServer({server});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{for(const ws of wss.clients)ws.terminate();wss.close();server.close();});
  const app='http://127.0.0.1:'+server.address().port;
  wss.on('connection',ws=>ws.on('message',raw=>{
    const event=JSON.parse(raw);
    if(event.type!=='turn')return;
    const response={quiet:{type:'quiet'},empty:{type:'audio-end'},failed:{type:'error',outcome:'failed'},legacy:{type:'error'}}[event.text];
    if(response)ws.send(JSON.stringify(response));
  }));
  assert.deepEqual(await speak(app,'quiet'),{speech:'',outcome:'quiet'});
  for(const [text,outcome] of [['empty','unknown'],['failed','failed'],['legacy','unknown'],['timeout','unknown']]){
    await assert.rejects(speak(app,text,{timeoutMs:100}),error=>error.outcome===outcome);
  }
});
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
  assert.equal((await call("/state", { user })).data.mine[0].status, "unknown");
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
  assert.equal((await call("/state", { user })).data.mine[0].status, "unknown");
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
  assert.equal((await call("/state", { user })).data.mine[0].status, "unknown");
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
  const turns = [];
  wss.on("connection", (ws, req) => {
    assert.equal(
      req.headers.origin,
      "http://127.0.0.1:" + server.address().port,
    );
    ws.on("message", (raw) => {
      const e = JSON.parse(raw);
      if (e.type === "turn") turns.push(e);
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
  assert.deepEqual(
    await speak("http://127.0.0.1:" + server.address().port, "A test"),
    {speech: "A fixture reply.", outcome: "complete"},
  );
  assert.equal(acknowledged, true);
  assert.equal(turns[0].visitor, undefined);
  await speak("http://127.0.0.1:" + server.address().port, "Hi", {
    visitor: "Guest 412",
  });
  assert.equal(turns[1].visitor, "Guest 412");
  assert.equal(turns[1].text, "Hi");
});
test("the public room splits a token-guarded visitor door from loopback-only controls that share one room", async (t) => {
  const proxyToken = "p".repeat(40),
    site = "https://site.example";
  const door = createGateway({
    secret: "s".repeat(40),
    workerToken: token,
    proxyToken,
    mode: "public",
    siteOrigin: site,
    localControls: true,
    cooldownMs: 0,
    siteRoot: fileURLToPath(new URL("../dist/", import.meta.url)),
  });
  const controls = door.controls;
  await new Promise((r) => door.listen(0, "127.0.0.1", r));
  await new Promise((r) => controls.listen(0, "127.0.0.1", r));
  t.after(() => {
    door.close();
    controls.close();
  });
  const doorBase = "http://127.0.0.1:" + door.address().port,
    controlsBase = "http://127.0.0.1:" + controls.address().port;
  const fromSite = (ip, extra = {}) => ({
    Origin: site,
    "Content-Type": "application/json",
    "X-Nodus-Proxy-Token": proxyToken,
    "X-Nodus-Client-Ip": ip,
    ...extra,
  });
  // Studio controls are not reachable through the public door, even with the proxy token.
  for (const path of ["/worker/config", "/operator", "/operator/session"])
    assert.equal(
      (await fetch(doorBase + path, { headers: fromSite("1.2.3.4") })).status,
      404,
    );
  assert.equal(
    (await fetch(doorBase + "/session", { method: "POST", headers: { Origin: site }, body: "{}" })).status,
    403,
  );
  const join = await fetch(doorBase + "/session", {
    method: "POST",
    headers: fromSite("1.2.3.4"),
    body: "{}",
  });
  assert.equal(join.status, 200);
  assert.match(join.headers.get("set-cookie"), /Secure/);
  const visitor = await join.json(),
    cookie = join.headers.get("set-cookie").split(";")[0];
  // The worker uses the loopback controls and sees the visitor's turn.
  const worker = (path, body) =>
    fetch(controlsBase + "/worker/" + path, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  await worker("heartbeat", { ready: true });
  assert.equal(
    (
      await fetch(doorBase + "/turns", {
        method: "POST",
        headers: fromSite("1.2.3.4", { Cookie: cookie, "X-Nodus-CSRF": visitor.csrf }),
        body: JSON.stringify({ text: "hello", public: true }),
      })
    ).status,
    202,
  );
  assert.equal((await worker("claim", {})).job.text, "hello");
  assert.equal((await fetch(controlsBase + "/operator")).status, 200);
  // Jordan's own local view on the controls listener can join and take part.
  const localJoin = await fetch(controlsBase + "/api/nodus/session", {
    method: "POST",
    headers: { Origin: controlsBase, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(localJoin.status, 200);
  assert.doesNotMatch(localJoin.headers.get("set-cookie"), /Secure/);
  // Rate limits apply per forwarded visitor address, not to the shared proxy connection.
  let last;
  for (let i = 0; i < 41; i++)
    last = await fetch(doorBase + "/session", { method: "POST", headers: fromSite("9.9.9.9"), body: "{}" });
  assert.equal(last.status, 429);
  assert.equal(
    (await fetch(doorBase + "/session", { method: "POST", headers: fromSite("8.8.8.8"), body: "{}" })).status,
    200,
  );
  // The personal adapter accepts the public room only when Jordan opens it explicitly.
  const config = { mode: "public", siteOrigin: site };
  await assertPrivatePreview({ gateway: controlsBase, app: "http://127.0.0.1:8788", config, enabled: true, publicRoom: true });
  await assert.rejects(
    assertPrivatePreview({ gateway: controlsBase, app: "http://127.0.0.1:8788", config: { mode: "public", siteOrigin: "http://site.example" }, enabled: true, publicRoom: true }),
  );
  assert.throws(() =>
    createGateway({ secret: "s".repeat(40), workerToken: token, localControls: true }),
  );
});

test("relay credentials come from the TURN key on this PC, are cached, filtered and fall back to STUN", async (t) => {
  let clock = 1000000,
    calls = 0,
    fail = false;
  const fetchImpl = async (url, init) => {
    calls++;
    assert.match(url, /\/v1\/turn\/keys\/key-id-123\/credentials\/generate-ice-servers$/);
    assert.equal(init.headers.Authorization, "Bearer turn-token-abcdefghij");
    if (fail) return { ok: false };
    return {
      ok: true,
      json: async () => ({
        iceServers: [
          { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
          {
            urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:53?transport=udp"],
            username: "u",
            credential: "c",
          },
        ],
      }),
    };
  };
  const server = createGateway({
    secret: "s".repeat(40),
    workerToken: token,
    now: () => clock,
    turn: { keyId: "key-id-123", apiToken: "turn-token-abcdefghij" },
    fetchImpl,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = "http://127.0.0.1:" + server.address().port;
  assert.equal((await fetch(base + "/ice")).status, 401);
  const join = await fetch(base + "/session", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  let cookie = join.headers.get("set-cookie").split(";")[0];
  const ice = async () => (await (await fetch(base + "/ice", { headers: { Cookie: cookie } })).json()).iceServers;
  const first = await ice();
  assert.deepEqual(first[1], {
    urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
    username: "u",
    credential: "c",
  });
  assert.deepEqual(first[0].urls, ["stun:stun.cloudflare.com:3478"]);
  await ice();
  assert.equal(calls, 1);
  clock += 2 * 3600000 + 1;
  fail = true;
  // The idle visitor session expired during the jump; join again.
  cookie = (
    await fetch(base + "/session", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: "{}",
    })
  ).headers.get("set-cookie").split(";")[0];
  assert.deepEqual(await ice(), [{ urls: "stun:stun.l.google.com:19302" }]);
  assert.throws(() =>
    createGateway({ secret: "s".repeat(40), workerToken: token, turn: { keyId: "x", apiToken: "y" } }),
  );
});
test("offers carrying their network addresses fit, while other requests keep the small limit", async (t) => {
  const { call, visitor } = await fixture(t);
  const user = await visitor();
  const sdp = "v=0\r\n" + "a=candidate:1 1 udp 1 203.0.113.7 5000 typ relay\r\n".repeat(600);
  assert.ok(sdp.length > 16000 && sdp.length < 48000);
  assert.equal(
    (await call("/signal", { method: "POST", user, headers: { "X-Nodus-View": "a".repeat(32) }, body: { type: "offer", payload: { type: "offer", sdp } } })).status,
    200,
  );
  assert.equal(
    (await call("/turns", { method: "POST", user, body: { text: "x".repeat(25000), public: true } })).status,
    413,
  );
});
