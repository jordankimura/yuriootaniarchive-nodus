import test from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "./nodus-gateway.mjs";
import { moveCamera } from "./local-camera.mjs";
import { fileURLToPath } from "node:url";
const origin = "http://127.0.0.1:5175",
  token = "w".repeat(40);
test("shared camera presets use a worker lease without speech generation or spending a turn", async (t) => {
  let clock = 1000000;
  const server = createGateway({
    secret: "s".repeat(40),
    workerToken: token,
    now: () => clock,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = "http://127.0.0.1:" + server.address().port;
  let user = {};
  const call = async (path, body, headers = {}) => {
    const r = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...(user.cookie
          ? { Cookie: user.cookie, "X-Nodus-CSRF": user.csrf }
          : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: r.status,
      data: await r.json(),
      cookie: r.headers.get("set-cookie")?.split(";")[0],
    };
  };
  const worker = (route, body) =>
    call("/worker/" + route, body, { Authorization: "Bearer " + token });
  const session = await call("/session", {});
  user = { cookie: session.cookie, csrf: session.data.csrf };
  await worker("heartbeat", { ready: false, camera: true });
  assert.equal((await call("/state")).data.cameraAvailable, true);
  assert.equal((await call("/camera", { preset: "anything" })).status, 400);
  assert.equal((await call("/camera", { preset: "wide" })).status, 400);
  const accepted = await call("/camera", { preset: "conversation" });
  assert.equal(accepted.status, 202);
  assert.equal((await call("/camera", { preset: "conversation" })).status, 409);
  const job = (await worker("claim", {})).data.job;
  assert.equal(job.type, "camera");
  assert.equal(job.preset, "conversation");
  assert.equal(job.text, undefined);
  assert.equal(
    (await worker("complete", { id: job.id, lease: "wrong", ok: true })).status,
    409,
  );
  assert.equal(
    (await worker("complete", { id: job.id, lease: job.lease, ok: true }))
      .status,
    200,
  );
  let state = (await call("/state")).data;
  assert.equal(state.mine.at(-1).status, "complete");
  assert.equal(
    (await worker("complete", { id: job.id, lease: job.lease, ok: true }))
      .status,
    409,
  );
  assert.equal(state.cameraPreset, "conversation");
  assert.equal(state.transcript.length, 0);
  assert.equal(state.remainingTurns, 60);
  assert.equal((await call("/camera", { preset: "conversation" })).status, 429);
  clock += 8001;
  await worker("heartbeat", { ready: true, camera: true });
  await call("/turns", { text: "a real turn", public: true });
  assert.equal((await call("/camera", { preset: "conversation" })).status, 409);
});
test("native camera adapter accepts only the two known triggers and respects an existing reframe", async () => {
  let calls = [];
  const request = async (op, params) => {
    calls.push({ op, params });
    if (op === "asset.fields")
      return {
        ok: true,
        data: { fields: [{ name: "ReframeActive", value: true }] },
      };
    return { ok: true };
  };
  await assert.rejects(moveCamera("arbitrary", { request }), /Unsupported/);
  assert.equal(calls.length, 0);
  await assert.rejects(moveCamera("wide", { request }), /Unsupported/);
  await assert.rejects(
    moveCamera("conversation", { request }),
    /already moving/,
  );
  assert.equal(
    calls.some((c) => c.op === "lease.acquire"),
    false,
  );
  calls = [];
  const permitted = async (op, params) => {
    calls.push({ op, params });
    if (op === "asset.fields")
      return {
        ok: true,
        data: { fields: [{ name: "ReframeActive", value: false }] },
      };
    return { ok: true };
  };
  await moveCamera("conversation", { request: permitted });
  assert.equal(
    calls.find((c) => c.op === "entity.trigger").params.trigger,
    "ConversationCamera",
  );
  assert.equal(calls.at(-1).op, "lease.release");
});
test("the one local program serves the built room and keeps studio controls off the site path", async (t) => {
  const server = createGateway({
    secret: "s".repeat(40),
    workerToken: token,
    siteRoot: fileURLToPath(new URL("../dist/", import.meta.url)),
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = "http://127.0.0.1:" + server.address().port;
  let r = await fetch(base + "/nodus/");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /A room with/);
  r = await fetch(base + "/api/nodus/worker/claim", {
    method: "POST",
    body: "{}",
  });
  assert.equal(r.status, 404);
  r = await fetch(base + "/api/nodus/operator/session", {
    method: "POST",
    body: "{}",
  });
  assert.equal(r.status, 404);
  r = await fetch(base + "/nodus/room.jpg", {
    headers: { Range: "bytes=0-99" },
  });
  assert.equal(r.status, 206);
  assert.equal((await r.arrayBuffer()).byteLength, 100);
  r = await fetch(base + "/api/nodus/state");
  assert.equal(r.status, 401);
  r = await fetch(base + "/api/nodus/session", {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(r.status, 200);
  r = await fetch(base + "/api/nodus/health");
  assert.equal(r.status, 404);
  r = await fetch(base + "/%2e%2e/package.json");
  assert.ok([403, 404].includes(r.status));
  assert.throws(() =>
    createGateway({
      secret: "s".repeat(40),
      workerToken: token,
      proxyToken: "p".repeat(40),
      mode: "public",
      siteRoot: "dist",
    }),
  );
});
