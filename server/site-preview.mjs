import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../dist/", import.meta.url));
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".woff2": "font/woff2",
  ".json": "application/json",
};
export function startSitePreview({
  port = 5175,
  gateway = "http://127.0.0.1:8794",
} = {}) {
  const server = http.createServer(async (req, res) => {
    const json = (status, data) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(data));
    };
    try {
      const listeningPort = server.address()?.port || port;
      if (
        ![`127.0.0.1:${listeningPort}`, `localhost:${listeningPort}`].includes(
          req.headers.host,
        )
      )
        return json(403, { error: "Open the local preview." });
      const url = new URL(req.url, "http://preview.local");
      if (url.pathname === "/preview-health")
        return json(200, { app: "nodus-static-preview" });
      if (url.pathname.startsWith("/api/nodus/")) {
        const route = url.pathname.slice("/api/nodus".length);
        const allowed =
          (req.method === "GET" && ["/state", "/signals"].includes(route)) ||
          (req.method === "POST" &&
            ["/session", "/turns", "/signal", "/camera"].includes(route)) ||
          (req.method === "DELETE" &&
            /^\/turns\/[A-Za-z0-9_-]{32}$/.test(route));
        if (!allowed) return json(404, { error: "Not found." });
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 20000)
            return json(413, { error: "Request too large." });
        }
        const headers = {};
        for (const name of [
          "origin",
          "cookie",
          "content-type",
          "x-nodus-csrf",
          "x-nodus-view",
        ])
          if (req.headers[name]) headers[name] = req.headers[name];
        const r = await fetch(gateway + route + url.search, {
          method: req.method,
          headers,
          body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
          redirect: "error",
          signal: AbortSignal.timeout(8000),
        });
        if (r.headers.get("set-cookie"))
          res.setHeader("Set-Cookie", r.headers.get("set-cookie"));
        return json(r.status, await r.json());
      }
      if (!["GET", "HEAD"].includes(req.method))
        return json(405, { error: "Method not allowed." });
      let file = path.resolve(root, "." + decodeURIComponent(url.pathname));
      if (
        file !== path.resolve(root) &&
        !file.startsWith(path.resolve(root) + path.sep)
      )
        return json(403, { error: "Invalid path." });
      let stat = await fs.promises.stat(file).catch(() => null);
      if (stat?.isDirectory()) {
        file = path.join(file, "index.html");
        stat = await fs.promises.stat(file).catch(() => null);
      }
      if (!stat?.isFile()) return json(404, { error: "Not found." });
      const headers = {
        "Content-Type": types[path.extname(file)] || "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Accept-Ranges": "bytes",
      };
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
      const start = match ? Number(match[1]) : 0,
        end = match
          ? Math.min(match[2] ? Number(match[2]) : stat.size - 1, stat.size - 1)
          : stat.size - 1;
      if (start > end || start >= stat.size) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        return res.end();
      }
      headers["Content-Length"] = end - start + 1;
      if (match)
        headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
      res.writeHead(match ? 206 : 200, headers);
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file, { start, end })
        .on("error", () => res.destroy())
        .pipe(res);
    } catch {
      if (!res.headersSent)
        json(503, { error: "The local room is temporarily unavailable." });
      else res.destroy();
    }
  });
  server.listen(port, "127.0.0.1");
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) startSitePreview();
