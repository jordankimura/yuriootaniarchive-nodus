import fs from 'node:fs/promises';

// Installed only in Vite's local development server, never in the public gateway.
export function copyEditor() {
  const file = new URL('../public/nodus/copy.json', import.meta.url);
  return {
    name: 'local-nodus-copy-editor',
    configureServer(server) {
      server.middlewares.use('/__nodus-copy', async (req, res) => {
        const origin = `http://${req.headers.host}`;
        if (!/^http:\/\/(127\.0\.0\.1|localhost):5175$/.test(origin) ||
            req.headers.origin !== origin || req.method !== 'PUT' ||
            req.headers['content-type'] !== 'application/json') {
          res.writeHead(403).end('Local editor only'); return;
        }
        try {
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (Buffer.byteLength(body) > 32000) { res.writeHead(413).end(); return; }
          }
          const copy = JSON.parse(body);
          const current = JSON.parse(await fs.readFile(file, 'utf8'));
          if (!copy || Array.isArray(copy) || Object.keys(copy).length !== Object.keys(current).length ||
              Object.keys(current).some(key => typeof copy[key] !== 'string' || copy[key].length > 4000)) {
            res.writeHead(400).end('Invalid text fields'); return;
          }
          await fs.writeFile(file, JSON.stringify(copy, null, 2) + '\n');
          res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"saved":true}');
        } catch {
          res.writeHead(400).end('Could not save text');
        }
      });
    },
  };
}
