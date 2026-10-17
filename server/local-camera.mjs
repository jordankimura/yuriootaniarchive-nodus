import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
const movementId = "5f546590-2b16-4b82-9509-2fdaf5a213dd";
export async function moveCamera(preset, { request: injected } = {}) {
  const triggers = {
    conversation: "ConversationCamera",
    wide: "WiderSeatedCamera",
  };
  if (!Object.hasOwn(triggers, preset))
    throw Error("Unsupported camera preset.");
  const request =
    injected ||
    (
      await import(
        pathToFileURL(
          path.join(os.homedir(), ".warudo-agent-bridge/app/src/transport.mjs"),
        ).href
      )
    ).request;
  const opts = { owner: "nodus-web-stage", timeoutMs: 12000 };
  const status = await request("status", {}, opts);
  if (!status.ok) throw Error("Warudo is offline.");
  const before = await request(
    "asset.fields",
    { assetId: movementId, fields: ["ReframeActive"] },
    opts,
  );
  if (
    !before.ok ||
    before.data.fields.find((f) => f.name === "ReframeActive")?.value !== false
  )
    throw Error("Nodus is already moving the camera.");
  const lease = await request("lease.acquire", { seconds: 30 }, opts);
  if (!lease.ok) throw Error("The studio camera is in use.");
  try {
    const result = await request(
      "entity.trigger",
      { assetId: movementId, trigger: triggers[preset] },
      opts,
    );
    if (!result.ok) throw Error("Warudo could not move the camera.");
    await pause(1600);
  } finally {
    await request("lease.release", {}, opts);
  }
}
