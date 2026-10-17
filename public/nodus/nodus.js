const $ = (id) => document.getElementById(id);
let videoView = "";
let connectionTimer = null;
let playbackBlocked = false;
let signalPolling = false;
let signalFailures = 0;
let roomReadFailed = false;
const CHAT_IDLE_MS = 30 * 60 * 1000;
function transcriptForDisplay(s, time = Date.now()) {
  const messages = s.transcript;
  if (!messages.length) return [];
  if (!s.current && !s.queue.length && time - messages.at(-1).at >= CHAT_IDLE_MS) return [];
  let start = 0;
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].at - messages[i - 1].at >= CHAT_IDLE_MS) start = i;
  }
  return messages.slice(start);
}
let csrf = "",
  name = "",
  state = null,
  polling = false,
  submitting = false,
  lastTranscript = "",
  lastOwnStatus = "",
  pc = null,
  cursor = 0,
  connecting = false,
  retryAt = 0,
  candidates = [];
const notice = (text, error = false) => {
  $("notice").textContent = text;
  $("notice").classList.toggle("error", error);
};
async function api(path, method = "GET", data) {
  const res = await fetch("/api/nodus" + path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...(csrf ? { "X-Nodus-CSRF": csrf } : {}),
      ...(videoView ? { "X-Nodus-View": videoView } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  let result;
  try {
    result = await res.json();
  } catch {
    throw Error("The room is not open yet. Please come back later.");
  }
  if (!res.ok)
    throw Object.assign(
      Error(result.error || "The room is unavailable. Please try again later."),
      { status: res.status },
    );
  return result;
}
function render(s) {
  state = s;
  $("video").classList.toggle("window-feed", s.videoSource !== "camera");
  $("presence").textContent = s.roomOpen ? "OPEN" : "CLOSED";
  $("presence").classList.toggle("open", s.roomOpen);
  const mine = s.queue.find((j) => j.mine),
    active = s.current?.mine,
    busy = !!mine || active;
  $("message").disabled = !s.roomOpen || busy;
  $("send").disabled = !s.roomOpen || busy || submitting;
  $("send").textContent = active
    ? "Nodus is replying…"
    : mine
      ? "In the queue"
      : "Take a turn";
  $("cancel").hidden = !mine;
  $("cancel").dataset.job = mine?.id || "";
  $("queue").textContent =
    s.phase === "camera"
      ? "Adjusting the shared camera…"
      : mine
        ? `Your turn is ${s.queue.findIndex((j) => j.mine) + 1} in the queue.`
        : active
          ? "Nodus is answering you."
          : s.current
            ? `Nodus is answering ${s.current.name}. ${s.queue.length ? `${s.queue.length} waiting.` : ""}`
            : s.roomOpen
              ? "The floor is open. Say hello."
              : "The room is quiet. Come back when Nodus is here.";
  const messages = transcriptForDisplay(s);
  const signature = JSON.stringify(messages);
  if (signature !== lastTranscript) {
    lastTranscript = signature;
    if (messages.length) {
      const frag = document.createDocumentFragment();
      for (const m of messages) {
        const div = document.createElement("div");
        div.className = "message " + (m.role === "nodus" ? "nodus" : "visitor");
        const label = document.createElement("div");
        label.className = "message-name";
        label.textContent = m.name;
        const header = document.createElement("div");
        header.className = "message-header";
        header.append(label);
        if (Number.isFinite(m.at)) {
          const timestamp = document.createElement("time");
          const date = new Date(m.at);
          timestamp.className = "message-time";
          timestamp.dateTime = date.toISOString();
          timestamp.textContent = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
          timestamp.title = date.toLocaleString([], { timeZoneName: "short" });
          header.append(timestamp);
        }
        const text = document.createElement("p");
        text.textContent = m.text;
        div.append(header, text);
        frag.append(div);
      }
      $("transcript").replaceChildren(frag);
      $("transcript").scrollTop = $("transcript").scrollHeight;
    } else {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "A fresh conversation. Messages clear after 30 quiet minutes.";
      $("transcript").replaceChildren(empty);
    }
  }
  const latest = s.mine.at(-1),
    ownStatus = latest ? latest.id + ":" + latest.status : "";
  if (ownStatus !== lastOwnStatus) {
    lastOwnStatus = ownStatus;
    if (latest?.status === "failed") notice(latest.error, true);
    else if (latest?.status === "complete")
      notice(
        "Your turn is complete. Stay a while, or let someone else take the floor.",
      );
  }
  if (s.videoAvailable && !pc && !connecting && Date.now() > retryAt)
    void connectVideo();
  if (!s.videoAvailable && pc) stopVideo();
  if (!pc && !connecting)
    $("stage-caption").textContent = s.roomOpen
      ? "Nodus is here. The camera is resting."
      : "The room is quiet for now.";
}
async function join() {
  $("join").disabled = true;
  notice("Opening the door…");
  try {
    const s = await api("/session", "POST", {});
    csrf = s.csrf;
    name = s.name;
    $("identity").textContent = name;
    $("join").hidden = true;
    $("message-form").hidden = false;
    notice(
      "Your messages and Nodus’s replies are public to everyone in this room.",
    );
    render(s);
    if (matchMedia('(max-width: 760px)').matches) $("stage").scrollIntoView({ block: "start" });
  } catch (e) {
    notice(e.message, true);
  } finally {
    $("join").disabled = false;
  }
}
$("join").addEventListener("click", join);
$("message").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  if (event.repeat || $("send").disabled || !$("message").value.trim()) return;
  $("message-form").requestSubmit();
});
$("message-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (submitting || !state?.roomOpen) return;
  submitting = true;
  $("send").disabled = true;
  notice("Joining the queue…");
  try {
    const s = await api("/turns", "POST", {
      text: $("message").value,
      public: true,
    });
    $("message").value = "";
    notice(
      "You’re in the queue. Your message will appear when Nodus takes your turn.",
    );
    render(s);
  } catch (e) {
    notice(e.message, true);
  } finally {
    submitting = false;
    if (state) render(state);
  }
});
$("cancel").addEventListener("click", async () => {
  try {
    render(await api("/turns/" + $("cancel").dataset.job, "DELETE", {}));
    notice("You’ve left the queue.");
  } catch (e) {
    notice(e.message, true);
  }
});
// Tell the publisher to stop sending to this tab. keepalive lets it finish during page unload.
function sendLeave() {
  if (!csrf || !videoView) return;
  void fetch("/api/nodus/signal", {
    method: "POST",
    keepalive: true,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-Nodus-CSRF": csrf,
      "X-Nodus-View": videoView,
    },
    body: JSON.stringify({ type: "leave" }),
  }).catch(() => {});
}
addEventListener("pagehide", () => {
  stopVideo();
});
function stopVideo() {
  $("video-loading").hidden = true;
  clearTimeout(connectionTimer);
  playbackBlocked = false;
  const old = pc;
  pc = null;
  if (old) sendLeave();
  old?.close();
  $("video").srcObject = null;
  $("video").hidden = true;
  $("poster").hidden = false;
  $("video-badge").textContent = "SAVED PREVIEW";
  $("video-badge").classList.remove("live");
  $("sound").hidden = true;
  $("sound").textContent = "Enable sound";
  $("video").muted = true;
  $("play-video").hidden = true;
  $("retry-video").hidden = !state?.videoAvailable;
  retryAt = Date.now() + 10000;
}
// Wait briefly for the browser to collect its network addresses, so they travel
// inside the offer: one request instead of dozens (a phone can have 30+).
function gathered(peer, ms) {
  return new Promise((resolve) => {
    if (peer.iceGatheringState === "complete") return resolve();
    const done = () => {
      if (peer.iceGatheringState !== "complete") return;
      peer.removeEventListener("icegatheringstatechange", done);
      resolve();
    };
    peer.addEventListener("icegatheringstatechange", done);
    setTimeout(resolve, ms);
  });
}
async function connectVideo() {
  if (!globalThis.RTCPeerConnection) return;
  const startedAt = Date.now();
  connecting = true;
  $("video-loading").hidden = false;
  videoView = crypto.randomUUID().replaceAll("-", "");
  cursor = 0;
  candidates = [];
  $("video-badge").textContent = "CONNECTING";
  $("stage-caption").textContent = "Connecting to the live camera…";
  $("retry-video").hidden = false;
  try {
    // Relay (TURN) servers let viewers on strict networks, such as mobile carriers, connect.
    const iceServers = await api("/ice")
      .then((r) => r.iceServers)
      .catch(() => [{ urls: "stun:stun.l.google.com:19302" }]);
    const peer = new RTCPeerConnection({ iceServers });
    pc = peer;
    // Track arrival only confirms negotiation, not that any frames are playing.
    connectionTimer = setTimeout(() => {
      if (pc !== peer || playbackBlocked) return;
      stopVideo();
      $("stage-caption").textContent = "The camera did not start. Retrying shortly…";
    }, 30000);
    peer.addTransceiver("video", { direction: "recvonly" });
    peer.addTransceiver("audio", { direction: "recvonly" });
    const outgoing = [];
    let offered = false,
      sealed = false;
    peer.onicecandidate = (e) => {
      // Addresses found before the offer is sealed are already inside it.
      if (!e.candidate || pc !== peer || !sealed) return;
      const payload = e.candidate.toJSON();
      if (offered)
        void api("/signal", "POST", { type: "candidate", payload }).catch(
          () => {},
        );
      else outgoing.push(payload);
    };
    peer.ontrack = (e) => {
      if (pc !== peer) return;
      const video = $("video");
      if (!video.srcObject) video.srcObject = new MediaStream();
      video.srcObject.addTrack(e.track);
      if (e.track.kind === "video") {
        video.hidden = false;
        video.onplaying = () => {
          if (pc !== peer || !video.videoWidth) return;
          clearTimeout(connectionTimer);
          $("stage").dataset.connectionMs = String(Date.now() - startedAt);
          playbackBlocked = false;
          $("video-loading").hidden = true;
          $("poster").hidden = true;
          $("play-video").hidden = true;
          $("retry-video").hidden = true;
          $("video-badge").textContent = "LIVE";
          $("video-badge").classList.add("live");
          $("stage-caption").textContent = "One room. Everyone is watching the same Nodus.";
        };
      }
      if (e.track.kind === "audio") $("sound").hidden = false;
      void video.play().catch((error) => {
        if (pc !== peer || error.name !== "NotAllowedError") return;
        playbackBlocked = true;
        $("video-loading").hidden = true;
        $("play-video").hidden = false;
        $("video-badge").textContent = "TAP TO PLAY";
        $("stage-caption").textContent = "Tap Play live video to start playback.";
      });
    };
    peer.onconnectionstatechange = () => {
      if (
        ["failed", "disconnected", "closed"].includes(peer.connectionState) &&
        pc === peer
      )
        stopVideo();
    };
    await peer.setLocalDescription(await peer.createOffer());
    await gathered(peer, 3000);
    if (pc !== peer) return;
    sealed = true;
    await api("/signal", "POST", {
      type: "offer",
      payload: peer.localDescription.toJSON(),
    });
    offered = true;
    for (const payload of outgoing)
      await api("/signal", "POST", { type: "candidate", payload });
  } catch {
    stopVideo();
  } finally {
    connecting = false;
  }
}
$("sound").addEventListener("click", () => {
  const video = $("video");
  video.muted = !video.muted;
  $("sound").textContent = video.muted ? "Enable sound" : "Mute sound";
  void video.play().catch(() => {
    playbackBlocked = true;
    $("video-loading").hidden = true;
    video.muted = true;
    $("sound").textContent = "Enable sound";
    $("play-video").hidden = false;
    $("stage-caption").textContent = "Playback was paused. Tap Play live video, then Enable sound.";
  });
});
$("video").addEventListener("waiting", () => {
  if (pc && !playbackBlocked) $("video-loading").hidden = false;
});
$("play-video").addEventListener("click", () => {
  void $("video").play().catch(() => {
    $("stage-caption").textContent = "Playback could not start. Try Reconnect video.";
  });
});
$("retry-video").addEventListener("click", () => {
  if (connecting) return;
  stopVideo();
  retryAt = 0;
  if (csrf && state?.videoAvailable) void connectVideo();
});
// Camera negotiation must not wait for the transcript request or its timeout.
async function pollSignals() {
  if (!csrf || !pc || connecting || signalPolling) return;
  signalPolling = true;
  const peer = pc;
  try {
    const r = await api("/signals?after=" + cursor);
    if (pc !== peer) return;
    for (const m of r.messages) {
      if (pc !== peer) break;
      if (m.type === "answer" && peer.signalingState === "have-local-offer") {
        $("stage-caption").textContent = "Camera found. Starting video…";
        await peer.setRemoteDescription(m.payload);
        for (const candidate of candidates) await peer.addIceCandidate(candidate);
        candidates = [];
      }
      if (m.type === "candidate" && m.payload) {
        if (peer.remoteDescription) await peer.addIceCandidate(m.payload);
        else candidates.push(m.payload);
      }
      if (m.type === "reset") stopVideo();
    }
    if (pc === peer) { cursor = r.cursor; signalFailures = 0; }
  } catch {
    // A single slow proxy response should not tear down a healthy video stream.
    if (pc === peer && ++signalFailures >= 3) {
      stopVideo();
      $("stage-caption").textContent = "Connection interrupted. Retrying shortly…";
    }
  } finally { signalPolling = false; }
}
setInterval(() => void pollSignals(), 750);
async function pollRoom() {
  if (!csrf || polling) return;
  polling = true;
  try {
    render(await api("/state"));
    if (roomReadFailed) {
      roomReadFailed = false;
      notice("Connection restored. Your messages and Nodus’s replies are public to everyone in this room.");
    }

  } catch (e) {
    if (e.status === 401) {
      csrf = "";
      state = null;
      lastTranscript = "";
      lastOwnStatus = "";
      stopVideo();
      $("join").hidden = false;
      $("message-form").hidden = true;
      $("cancel").hidden = true;
      $("presence").textContent = "REJOIN";
      $("presence").classList.remove("open");
      $("queue").textContent =
        "Your visit timed out or the room restarted. Join again to reconnect.";
      $("transcript").replaceChildren();
      notice(
        "Your visit timed out or the room restarted. Your unsent message is still here; join again when you’re ready.",
      );
      return;
    }
    roomReadFailed = true;
    notice("The connection was interrupted. Reconnecting…", true);
    $("presence").textContent = "RECONNECTING";
    $("presence").classList.remove("open");
    $("send").disabled = true;
  } finally {
    polling = false;
  }
}
setInterval(() => void pollRoom(), 1500);
// Check availability without opening a visitor session or requesting device access.
notice("A shared, public conversation. Please keep personal details private.");
