import crypto from "node:crypto";
import { createGateway } from "./nodus-gateway.mjs";
import { runWorker } from "./nodus-worker.mjs";
import { moveCamera } from "./local-camera.mjs";
const token = crypto.randomBytes(32).toString("base64url");
const server = createGateway({
  secret: crypto.randomBytes(32).toString("base64url"),
  workerToken: token,
});
server.listen(8794, "127.0.0.1", () => {
  console.log(
    "Website room gateway: http://127.0.0.1:8794/operator (local only).",
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
