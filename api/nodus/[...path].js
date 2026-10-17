// Vercel only forwards the visitor API. Worker and publisher controls are never proxied.
import process from "node:process";
import { Buffer } from "node:buffer";
export default async function handler(req, res) {
  // Read the route from the request URL. Vercel does not fill req.query.path for
  // this catch-all outside Next.js, and a ?path= query must never pick the route.
  const requested = new URL(req.url || "/", "http://site.local");
  const path = requested.pathname.startsWith("/api/nodus/")
    ? requested.pathname.slice("/api/nodus".length)
    : "/";
  const allowed =
    (path === "/session" && req.method === "POST") ||
    (path === "/state" && req.method === "GET") ||
    (path === "/signals" && req.method === "GET") ||
    (path === "/signal" && req.method === "POST") ||
    (path === "/turns" && req.method === "POST") ||
    (path === "/camera" && req.method === "POST") ||
    (/^\/turns\/[A-Za-z0-9_-]{32}$/.test(path) && req.method === "DELETE");
  res.setHeader("Cache-Control", "no-store");
  if (!allowed) return res.status(404).json({ error: "Not found." });
  const origin = process.env.NODUS_PUBLIC_SITE_ORIGIN,
    gateway = process.env.NODUS_GATEWAY_URL,
    token = process.env.NODUS_PROXY_TOKEN;
  if (!origin || !gateway || !token)
    return res
      .status(503)
      .json({ error: "The room is not open yet. Please come back later." });
  if (req.headers.origin && req.headers.origin !== origin)
    return res.status(403).json({ error: "Enter through the website." });
  if (req.method !== "GET" && req.headers.origin !== origin)
    return res.status(403).json({ error: "Enter through the website." });
  try {
    const base = new URL(gateway);
    if (base.protocol !== "https:" || base.username || base.password)
      throw Error("Gateway configuration.");
    const url = new URL(path, base);
    if (path === "/signals") {
      const after = requested.searchParams.get("after") || "0";
      if (!/^\d{1,12}$/.test(after))
        return res.status(400).json({ error: "Invalid cursor." });
      url.searchParams.set("after", after);
    }
    const body =
      req.method === "GET" ? undefined : JSON.stringify(req.body || {});
    if (body && Buffer.byteLength(body) > 20000)
      return res.status(413).json({ error: "Request too large." });
    const upstream = await fetch(url, {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        "X-Nodus-Proxy-Token": token,
        ...(req.headers.origin ? { Origin: req.headers.origin } : {}),
        ...(req.headers.cookie ? { Cookie: req.headers.cookie } : {}),
        ...(req.headers["x-nodus-csrf"]
          ? { "X-Nodus-CSRF": req.headers["x-nodus-csrf"] }
          : {}),
        ...(req.headers["x-nodus-view"]
          ? { "X-Nodus-View": req.headers["x-nodus-view"] }
          : {}),
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    const cookie = upstream.headers.get("set-cookie");
    if (cookie) res.setHeader("Set-Cookie", cookie);
    return res.status(upstream.status).json(await upstream.json());
  } catch {
    return res.status(503).json({
      error: "The room is temporarily unavailable. Please try again later.",
    });
  }
}
