const $ = (id) => document.getElementById(id);
let csrf = "",
  stream = null,
  cursor = 0,
  polling = false;
const peers = new Map(),
  pending = new Map();
async function api(path, data) {
  const r = await fetch("/operator/" + path, {
    method: data ? "POST" : "GET",
    headers: data
      ? { "Content-Type": "application/json", "X-Nodus-CSRF": csrf }
      : {},
    body: data ? JSON.stringify(data) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const result = await r.json();
  if (!r.ok) throw Error(result.error || "Publisher request failed.");
  return result;
}
async function closeCamera() {
  const previous = stream;
  stream = null;
  previous?.getTracks().forEach((t) => t.stop());
  for (const peer of peers.values()) peer.close();
  peers.clear();
  pending.clear();
  $("preview").srcObject = null;
  $("share").disabled = false;
  $("stop").disabled = true;
  $("status").textContent = "Camera closed.";
  try {
    await api("offline", {});
  } catch {
    /* A stopped stream is already disconnected. */
  }
}
$("devices").addEventListener("click", async () => {
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((t) => t.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    $("audio").replaceChildren(new Option("Video only", ""));
    for (const d of devices.filter((d) => d.kind === "audioinput"))
      $("audio").add(new Option(d.label || "Audio input", d.deviceId));
    $("status").textContent =
      "Choose the virtual cable for Nodus, or keep Video only. Your normal microphone would broadcast your room.";
  } catch {
    $("status").textContent =
      "Audio permission was not granted. Video sharing still works.";
  }
});
$("share").addEventListener("click", async () => {
  $("share").disabled = true;
  try {
    const session = await api("session", {});
    csrf = session.csrf;
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 24, max: 30 } },
      audio: false,
    });
    if ($("audio").value) {
      const audio = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: $("audio").value },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
      for (const track of audio.getAudioTracks()) stream.addTrack(track);
    }
    $("preview").srcObject = stream;
    cursor = 0;
    stream
      .getVideoTracks()[0]
      .addEventListener("ended", () => void closeCamera(), { once: true });
    $("stop").disabled = false;
    $("status").textContent =
      "Camera open. Check that this is the Warudo output. " +
      (stream.getAudioTracks().length
        ? "Selected audio input is also shared."
        : "Video only; Nodus’s remote audio is not routed yet.");
    await api("heartbeat", {});
  } catch (e) {
    await closeCamera();
    $("status").textContent =
      e.name === "NotAllowedError"
        ? "Sharing was cancelled. Camera stays closed."
        : e.message;
  }
});
$("stop").addEventListener("click", () => void closeCamera());
async function handle(m) {
  if (m.type === "leave") {
    peers.get(m.visitor)?.close();
    peers.delete(m.visitor);
    pending.delete(m.visitor);
    return;
  }
  if (m.type === "offer") {
    peers.get(m.visitor)?.close();
    const peer = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    peers.set(m.visitor, peer);
    peer.onconnectionstatechange = () => {
      if (
        ["closed", "failed", "disconnected"].includes(peer.connectionState) &&
        peers.get(m.visitor) === peer
      ) {
        peer.close();
        peers.delete(m.visitor);
        pending.delete(m.visitor);
      }
    };
    const outgoing = [];
    let answered = false;
    peer.onicecandidate = (e) => {
      if (!e.candidate) return;
      const payload = e.candidate.toJSON();
      if (answered)
        void api("signal", {
          visitor: m.visitor,
          type: "candidate",
          payload,
        }).catch(() => {});
      else outgoing.push(payload);
    };
    for (const track of stream.getTracks()) peer.addTrack(track, stream);
    await peer.setRemoteDescription(m.payload);
    for (const candidate of pending.get(m.visitor) || [])
      await peer.addIceCandidate(candidate);
    pending.delete(m.visitor);
    await peer.setLocalDescription(await peer.createAnswer());
    await api("signal", {
      visitor: m.visitor,
      type: "answer",
      payload: peer.localDescription.toJSON(),
    });
    answered = true;
    for (const payload of outgoing)
      await api("signal", { visitor: m.visitor, type: "candidate", payload });
  } else if (m.type === "candidate" && m.payload) {
    const peer = peers.get(m.visitor);
    if (peer?.remoteDescription) await peer.addIceCandidate(m.payload);
    else {
      const list = pending.get(m.visitor) || [];
      list.push(m.payload);
      pending.set(m.visitor, list);
    }
  }
}
setInterval(async () => {
  if (!stream || polling) return;
  polling = true;
  try {
    await api("heartbeat", {});
    const result = await api("signals?after=" + cursor);
    for (const m of result.messages) {
      try {
        await handle(m);
      } catch {
        peers.get(m.visitor)?.close();
        peers.delete(m.visitor);
        await api("signal", {
          visitor: m.visitor,
          type: "reset",
          payload: null,
        }).catch(() => {});
      }
    }
    cursor = result.cursor;
  } catch {
    $("status").textContent =
      "Publisher connection interrupted. Reopen the camera if it does not recover.";
  } finally {
    polling = false;
  }
}, 1000);
