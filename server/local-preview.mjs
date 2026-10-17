import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGateway } from "./nodus-gateway.mjs";
import { runWorker } from "./nodus-worker.mjs";
import { moveCamera } from "./local-camera.mjs";

const random = () => crypto.randomBytes(32).toString("base64url");
const siteRoot = fileURLToPath(new URL("../dist/", import.meta.url));
const publicRoom = process.argv.includes("--public");

// Public-room secrets live outside the repository and the vault. The proxy token
// is the one value Jordan copies into Vercel; it is never written to the logs.
const secretsFile = path.join(os.homedir(), ".nodus", "public-room.json");
function publicSecrets() {
  if (!fs.existsSync(secretsFile)) {
    fs.mkdirSync(path.dirname(secretsFile), { recursive: true });
    fs.writeFileSync(
      secretsFile,
      JSON.stringify(
        {
          siteOrigin: "https://yuriootani.vercel.app",
          sessionSecret: random(),
          proxyToken: random(),
          maxTurns: 60,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  }
  return JSON.parse(fs.readFileSync(secretsFile, "utf8"));
}

if (process.argv.includes("--print-proxy-token")) {
  console.log(publicSecrets().proxyToken);
  process.exit(0);
}

const token = random();
const secrets = publicRoom ? publicSecrets() : null;
const server = createGateway(
  publicRoom
    ? {
        mode: "public",
        secret: secrets.sessionSecret,
        workerToken: token,
        proxyToken: secrets.proxyToken,
        siteOrigin: secrets.siteOrigin,
        maxTurns: secrets.maxTurns,
        siteRoot,
        localControls: true,
      }
    : {
        secret: random(),
        workerToken: token,
        // One local program: the built site, the room API and the camera publisher on one port.
        siteRoot,
      },
);
// In the public room, `server` is the visitor door that Tailscale Funnel exposes,
// and the controls listener stays on loopback for the publisher and the worker.
const controls = publicRoom ? server.controls : server;
controls.listen(8794, "127.0.0.1", () => {
  console.log(
    publicRoom
      ? "Nodus room is PUBLIC through " +
          secrets.siteOrigin +
          ". Local view: http://127.0.0.1:8794/nodus/ · publisher: http://127.0.0.1:8794/operator"
      : "Nodus room (local only): http://127.0.0.1:8794/nodus/ · publisher: http://127.0.0.1:8794/operator",
  );
  if (process.argv.includes("--connect-private-nodus"))
    void runWorker({
      token,
      allowPrivatePreview: true,
      allowPublicRoom: publicRoom,
      setCamera: moveCamera,
    }).catch((e) => console.error(e.message));
  else
    console.log(
      "Nodus is disconnected. Add --connect-private-nodus only for your own local test.",
    );
});
if (publicRoom)
  server.listen(8795, "127.0.0.1", () =>
    console.log("Visitor door listening on 127.0.0.1:8795 for Tailscale Funnel."),
  );
