import fs from "node:fs";
import path from "node:path";
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
  ".glb": "model/gltf-binary",
  ".moc3": "application/octet-stream",
};
// Serves the built website from `root` for the local room. Ranges keep video seeking working.
export async function serveSite(req, res, root) {
  const base = path.resolve(root);
  const notFound = (status, error) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ error }));
  };
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://site.local").pathname);
  } catch {
    return notFound(400, "Invalid path.");
  }
  let file = path.resolve(base, "." + pathname);
  if (file !== base && !file.startsWith(base + path.sep))
    return notFound(403, "Invalid path.");
  let stat = await fs.promises.stat(file).catch(() => null);
  if (stat?.isDirectory()) {
    file = path.join(file, "index.html");
    stat = await fs.promises.stat(file).catch(() => null);
  }
  if (!stat?.isFile()) return notFound(404, "Not found.");
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
  if (match) headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
  res.writeHead(match ? 206 : 200, headers);
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file, { start, end })
    .on("error", () => res.destroy())
    .pipe(res);
}
