import test from "node:test";
import assert from "node:assert/strict";
import handler from "../api/nodus/[...path].js";
function response() {
  return {
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(n) {
      this.code = n;
      return this;
    },
    json(data) {
      this.data = data;
      return this;
    },
  };
}
test("website proxy never exposes worker or operator routes and fails closed without configuration", async () => {
  for (const path of [
    ["worker", "claim"],
    ["operator", "session"],
    ["..", "worker", "config"],
  ]) {
    const res = response();
    await handler(
      { url: "/api/nodus/" + path.join("/"), query: {}, method: "POST", headers: {} },
      res,
    );
    assert.equal(res.code, 404);
  }
  const saved = process.env.NODUS_GATEWAY_URL;
  delete process.env.NODUS_GATEWAY_URL;
  try {
    const res = response();
    await handler(
      { url: "/api/nodus/session", query: {}, method: "POST", headers: {} },
      res,
    );
    assert.equal(res.code, 503);
    // The route comes from the URL; a ?path= query cannot select or unlock one.
    const forged = response();
    await handler(
      { url: "/api/nodus/missing?path=state", query: { path: "state" }, method: "GET", headers: {} },
      forged,
    );
    assert.equal(forged.code, 404);
    const state = response();
    await handler(
      { url: "/api/nodus/state?path=worker/claim", query: { path: "worker/claim" }, method: "GET", headers: {} },
      state,
    );
    assert.equal(state.code, 503);
  } finally {
    if (saved) process.env.NODUS_GATEWAY_URL = saved;
  }
});
test("website proxy forwards only the intended visitor request and server-held credential", async () => {
  const saved = { ...process.env };
  const nativeFetch = globalThis.fetch;
  Object.assign(process.env, {
    NODUS_GATEWAY_URL: "https://gateway.example",
    NODUS_PUBLIC_SITE_ORIGIN: "https://site.example",
    NODUS_PROXY_TOKEN: "proxy-secret",
  });
  let called = false;
  globalThis.fetch = async (url, options) => {
    called = true;
    assert.equal(url.href, "https://gateway.example/session");
    assert.equal(options.headers["X-Nodus-Proxy-Token"], "proxy-secret");
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers.Cookie, "nodus_stage=test");
    assert.equal(options.redirect, "error");
    return new Response(JSON.stringify({ name: "Guest 123" }), {
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": "nodus_stage=test; HttpOnly; Secure",
      },
    });
  };
  try {
    const res = response();
    await handler(
      {
        url: "/api/nodus/session", query: {},
        method: "POST",
        body: {},
        headers: {
          origin: "https://site.example",
          cookie: "nodus_stage=test",
          authorization: "Bearer untrusted",
        },
      },
      res,
    );
    assert.equal(res.code, 200);
    assert.equal(called, true);
    assert.match(res.headers["Set-Cookie"], /HttpOnly/);
    called = false;
    const wrong = response();
    await handler(
      {
        url: "/api/nodus/session", query: {},
        method: "POST",
        body: {},
        headers: { origin: "https://elsewhere.example" },
      },
      wrong,
    );
    assert.equal(wrong.code, 403);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = nativeFetch;
    for (const key of [
      "NODUS_GATEWAY_URL",
      "NODUS_PUBLIC_SITE_ORIGIN",
      "NODUS_PROXY_TOKEN",
    ]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
