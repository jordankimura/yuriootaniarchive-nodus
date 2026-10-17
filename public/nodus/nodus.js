const $ = (id) => document.getElementById(id);
let videoView = "";
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
  $("presence").textContent = s.roomOpen ? "● OPEN" : "● CLOSED";
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
      : "Take a turn ↗";
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
  const signature = JSON.stringify(s.transcript);
  if (signature !== lastTranscript) {
    lastTranscript = signature;
    if (s.transcript.length) {
      const frag = document.createDocumentFragment();
      for (const m of s.transcript) {
        const div = document.createElement("div");
        div.className = "message " + (m.role === "nodus" ? "nodus" : "visitor");
        const label = document.createElement("div");
        label.className = "message-name";
        label.textContent = m.name;
        const text = document.createElement("p");
        text.textContent = m.text;
        div.append(label, text);
        frag.append(div);
      }
      $("transcript").replaceChildren(frag);
      $("transcript").scrollTop = $("transcript").scrollHeight;
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
  if (!pc)
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
  if (pc) sendLeave();
});
function stopVideo() {
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
  connecting = true;
  videoView = crypto.randomUUID().replaceAll("-", "");
  cursor = 0;
  candidates = [];
  try {
    // Relay (TURN) servers let viewers on strict networks, such as mobile carriers, connect.
    const iceServers = await api("/ice")
      .then((r) => r.iceServers)
      .catch(() => [{ urls: "stun:stun.l.google.com:19302" }]);
    const peer = new RTCPeerConnection({ iceServers });
    pc = peer;
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
        $("poster").hidden = true;
        $("video-badge").textContent = "LIVE";
        $("video-badge").classList.add("live");
        $("stage-caption").textContent =
          "One room. Everyone is watching the same Nodus.";
      }
      if (e.track.kind === "audio") $("sound").hidden = false;
      void video.play().catch(() => {});
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
  void video.play().catch(() => {});
});
setInterval(async () => {
  if (!csrf || polling) return;
  polling = true;
  let roomRead = false;
  try {
    render(await api("/state"));
    roomRead = true;
    if (pc && !connecting) {
      const peer = pc,
        r = await api("/signals?after=" + cursor);
      cursor = r.cursor;
      for (const m of r.messages) {
        if (pc !== peer) break;
        if (m.type === "answer" && peer.signalingState === "have-local-offer") {
          await peer.setRemoteDescription(m.payload);
          for (const candidate of candidates)
            await peer.addIceCandidate(candidate);
          candidates = [];
        }
        if (m.type === "candidate" && m.payload) {
          if (peer.remoteDescription) await peer.addIceCandidate(m.payload);
          else candidates.push(m.payload);
        }
        if (m.type === "reset") stopVideo();
      }
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
      $("presence").textContent = "● REJOIN";
      $("presence").classList.remove("open");
      $("queue").textContent =
        "Your visit timed out or the room restarted. Join again to reconnect.";
      $("transcript").replaceChildren();
      notice(
        "Your visit timed out or the room restarted. Your unsent message is still here; join again when you’re ready.",
      );
      return;
    }
    if (roomRead) {
      stopVideo();
      notice("The camera is reconnecting. You can still use the conversation.");
      return;
    }
    notice(e.message, true);
    $("presence").textContent = "● RECONNECTING";
    $("presence").classList.remove("open");
    $("send").disabled = true;
  } finally {
    polling = false;
  }
}, 1500);
// Check availability without opening a visitor session or requesting device access.
notice("A shared, public conversation. Please keep personal details private.");
