import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createGateway } from "./nodus-gateway.mjs";
import { runWorker } from "./nodus-worker.mjs";
import { moveCamera } from "./local-camera.mjs";
const token = crypto.randomBytes(32).toString("base64url");
const server = createGateway({
  secret: crypto.randomBytes(32).toString("base64url"),
  workerToken: token,
  // One local program: the built site, the room API and the camera publisher on one port.
  siteRoot: fileURLToPath(new URL("../dist/", import.meta.url)),
});
server.listen(8794, "127.0.0.1", () => {
  console.log(
    "Nodus room (local only): http://127.0.0.1:8794/nodus/ · publisher: http://127.0.0.1:8794/operator",
  );
  if (process.argv.includes("--connect-private-nodus"))
    void runWorker({
      token,
      allowPrivatePreview: true,
      setCamera: moveCamera,
    }).catch((e) => console.error(e.message));
  else
    console.log(
      "Nodus is disconnected. Add --connect-private-nodus only for your own local test.",
    );
});
