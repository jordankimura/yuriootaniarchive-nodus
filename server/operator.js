const $ = (id) => document.getElementById(id);
let csrf = "",
  stream = null,
  cursor = 0,
  polling = false;
let sourceKind = "window",
  voice = null;
// Nodus's generated speech arrives as 24 kHz 16-bit mono PCM from the local voice
// app. Each chunk is scheduled right after the last, so it plays in real time.
function openVoiceFeed() {
  const context = new AudioContext();
  void context.resume();
  const destination = context.createMediaStreamDestination();
  const socket = new WebSocket("ws://127.0.0.1:8788/voice-feed");
  socket.binaryType = "arraybuffer";
  let playhead = 0,
    carry = null;
  socket.onmessage = (event) => {
    if (typeof event.data === "string") return;
    let bytes = new Uint8Array(event.data);
    if (carry) {
      const joined = new Uint8Array(carry.length + bytes.length);
      joined.set(carry);
      joined.set(bytes, carry.length);
      bytes = joined;
      carry = null;
    }
    if (bytes.length % 2) {
      carry = bytes.slice(-1);
      bytes = bytes.slice(0, -1);
    }
    if (!bytes.length) return;
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
    const buffer = context.createBuffer(1, samples.length, 24000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);
    const start = Math.max(playhead, context.currentTime + 0.12);
    source.start(start);
    playhead = start + buffer.duration;
  };
  return {
    track: destination.stream.getAudioTracks()[0],
    socket,
    close() {
      socket.close();
      void context.close();
    },
  };
}
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
  voice?.close();
  voice = null;
  previous?.getTracks().forEach((t) => t.stop());
  for (const peer of peers.values()) peer.close();
  peers.clear();
  pending.clear();
  $("preview").srcObject = null;
  $("share").disabled = false;
  $("stop").disabled = true;
  $("audio").disabled = false;
  $("devices").disabled = false;
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
    $("audio").replaceChildren(
      new Option("Nodus’s voice (direct from the voice app)", "nodus-voice"),
      new Option("Video only", ""),
    );
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
  // Start audio inside the click itself; Chrome may keep a later AudioContext silent.
  if ($("audio").value === "nodus-voice") voice = openVoiceFeed();
  try {
    const session = await api("session", {});
    csrf = session.csrf;
    sourceKind = $("source").value;
    if (sourceKind === "camera") {
      let cameras = await navigator.mediaDevices.enumerateDevices();
      if (
        !cameras.some((d) => d.kind === "videoinput" && /warudo/i.test(d.label))
      ) {
        const probe = await navigator.mediaDevices.getUserMedia({
          video: { width: 320, height: 180 },
          audio: false,
        });
        probe.getTracks().forEach((t) => t.stop());
        cameras = await navigator.mediaDevices.enumerateDevices();
      }
      const camera = cameras.find(
        (d) => d.kind === "videoinput" && /warudo/i.test(d.label),
      );
      if (!camera)
        throw Error(
          "Warudo virtual camera was not found. Enable it in Warudo, or use window sharing. No camera is being published.",
        );
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: camera.deviceId },
          width: { ideal: 1280, max: 1280 },
          height: { ideal: 720, max: 720 },
          frameRate: { ideal: 24, max: 24 },
        },
        audio: false,
      });
      if (!/warudo/i.test(stream.getVideoTracks()[0].label))
        throw Error(
          "The selected camera was not Warudo. Nothing was published.",
        );
    } else {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 24, max: 24 },
          cursor: "never",
        },
        audio: false,
      });
      // Some browsers ignore individual screen-capture constraints; read back the actual result below.
      await stream
        .getVideoTracks()[0]
        .applyConstraints({
          width: { max: 1280 },
          height: { max: 720 },
          frameRate: { max: 24 },
          cursor: "never",
        })
        .catch(() =>
          stream
            .getVideoTracks()[0]
            .applyConstraints({
              width: { max: 1280 },
              height: { max: 720 },
              frameRate: { max: 24 },
            })
            .catch(() => {}),
        );
    }
    stream.getVideoTracks()[0].contentHint = "motion";
    $("preview").style.clipPath =
      sourceKind === "window" ? "inset(6% 0 0 0)" : "none";
    if (voice) {
      voice.socket.onerror = () => {
        $("status").textContent =
          "Nodus’s voice feed is unavailable. Restart the voice app, then reopen the camera.";
      };
      stream.addTrack(voice.track);
    } else if ($("audio").value) {
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
    $("audio").disabled = true;
    $("devices").disabled = true;
    $("status").textContent =
      "Camera open. Check that this is the Warudo output. " +
      (stream.getAudioTracks().length
        ? $("audio").value === "nodus-voice"
          ? "Nodus’s voice is included."
          : "Selected audio input is also shared."
        : "Video only.");
    await api("heartbeat", { source: sourceKind });
  } catch (e) {
    await closeCamera();
    $("status").textContent =
      e.name === "NotAllowedError"
        ? "Sharing was cancelled. Camera stays closed."
        : e.message;
  }
});
$("stop").addEventListener("click", () => void closeCamera());
$("source").addEventListener("change", async () => {
  if (stream) await closeCamera();
  $("share").textContent =
    $("source").value === "camera"
      ? "Open clean Warudo camera"
      : "Share Warudo window";
});
async function handle(m) {
  if (m.type === "leave") {
    peers.get(m.visitor)?.close();
    peers.delete(m.visitor);
    pending.delete(m.visitor);
    return;
  }
  if (m.type === "offer") {
    peers.get(m.visitor)?.close();
    const iceServers = await api("ice")
      .then((r) => r.iceServers)
      .catch(() => [{ urls: "stun:stun.l.google.com:19302" }]);
    const peer = new RTCPeerConnection({ iceServers });
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
    for (const track of stream.getTracks()) {
      const sender = peer.addTrack(track, stream);
      if (track.kind === "video") {
        const parameters = sender.getParameters();
        if (!parameters.encodings?.length) parameters.encodings = [{}];
        parameters.encodings[0].maxBitrate = 1600000;
        parameters.encodings[0].maxFramerate = 24;
        parameters.degradationPreference = "maintain-framerate";
        await sender.setParameters(parameters).catch(() => {});
      }
    }
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
    await api("heartbeat", { source: sourceKind });
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
setInterval(async () => {
  if (!stream) {
    $("stats").textContent = "";
    return;
  }
  const settings = stream.getVideoTracks()[0].getSettings();
  let text = `Source ${settings.width || "?"} × ${settings.height || "?"} · ${Math.round(settings.frameRate || 0)} FPS · ${peers.size} viewer${peers.size === 1 ? "" : "s"}`;
  const peer = peers.values().next().value;
  if (peer)
    try {
      const stats = await peer.getStats();
      for (const report of stats.values())
        if (
          report.type === "outbound-rtp" &&
          report.kind === "video" &&
          !report.isRemote
        ) {
          text = `Sending ${report.frameWidth || settings.width} × ${report.frameHeight || settings.height} · ${Math.round(report.framesPerSecond || 0)} FPS · ${peers.size} viewer${peers.size === 1 ? "" : "s"}`;
          if (report.qualityLimitationReason === "cpu")
            text += " · encoder is busy";
        }
    } catch {
      /* Capture settings still describe the source. */
    }
  if (sourceKind === "window" && settings.cursor && settings.cursor !== "never")
    text += " · this browser did not hide the mouse; use the clean camera";
  $("stats").textContent = text;
}, 4000);
