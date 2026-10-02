// Video detection + caption extraction. Runs in every frame; acts only where a <video> exists.
(() => {
  if (window.__lvtLoaded) return; window.__lvtLoaded = true;
  const send = (m) => { try { chrome.runtime.sendMessage(m); } catch (_) {} };
  const isYT = /(^|\.)youtube\.com$/.test(location.hostname);
  let video = null, curKey = null, sawCaption = false, playedFor = 0, ccClicked = false,
      reported = null, trackHooked = false, idleTimer, mo, moTick;

  const now = () => (video ? video.currentTime : 0);
  const cp = new CaptionPipeline((s) => send({ type: "sentence", ...s }));

  const videoKey = () => isYT
    ? (new URL(location.href).searchParams.get("v") || location.pathname)
    : location.href;

  // ---- caption text intake (shared by all caption sources) ----
  function onCaptionText(text) {
    if (text) sawCaption = true;
    cp.onText(text, now());
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => cp.flush(now()), 1500);     // pause in speech / caption gone
  }

  // ---- source 1: YouTube DOM captions (needs CC "on"; we click it once if it is off) ----
  const inAd = () => !!document.querySelector(".html5-video-player.ad-showing");
  const readYT = () => [...document.querySelectorAll(".ytp-caption-segment")]
    .map((e) => e.textContent).join(" ").replace(/\s+/g, " ").trim();

  function watchYT() {
    const root = document.querySelector("#movie_player");
    if (!root || root.__lvt) return;
    root.__lvt = true;
    mo = new MutationObserver(() => {
      if (moTick) return;
      moTick = setTimeout(() => { moTick = 0; if (!inAd()) onCaptionText(readYT()); }, 120);
    });
    mo.observe(root, { subtree: true, childList: true, characterData: true });
  }
  function ensureYTCC() {
    const b = document.querySelector(".ytp-subtitles-button");
    const usable = !!b && b.offsetParent !== null && b.getAttribute("aria-disabled") !== "true";
    if (usable && b.getAttribute("aria-pressed") === "false" && !ccClicked) { b.click(); ccClicked = true; }
    return usable;
  }

  // ---- source 2: standard HTML5 <track> / TextTrack cues (many non-YouTube players) ----
  const hasTextTrack = (v) => [...v.textTracks].some((t) => t.kind === "subtitles" || t.kind === "captions");
  function watchTracks(v) {
    const hook = (tr) => {
      if (trackHooked || (tr.kind !== "subtitles" && tr.kind !== "captions")) return;
      trackHooked = true;
      if (tr.mode === "disabled") tr.mode = "hidden";        // hidden = cues fire, nothing drawn
      tr.addEventListener("cuechange", () => onCaptionText(
        [...(tr.activeCues || [])].map((c) => c.text.replace(/<[^>]+>/g, "")).join(" ").replace(/\s+/g, " ").trim()));
    };
    [...v.textTracks].forEach(hook);
    v.textTracks.addEventListener("addtrack", (e) => hook(e.track));
  }

  // ---- video detection ----
  const area = (v) => v.clientWidth * v.clientHeight;
  function pickVideo() {
    const vs = [...document.querySelectorAll("video")].filter((v) => v.clientWidth > 200 && (v.readyState > 0 || !v.paused));
    vs.sort((a, b) => (b.paused ? 0 : 1) - (a.paused ? 0 : 1) || area(b) - area(a));
    return vs[0] || null;
  }
  function attach(v) {
    video = v;
    if (v.__lvt) return; v.__lvt = true;
    const ev = (name, resetToo) => v.addEventListener(name, () => {
      cp.flush(now()); if (resetToo) cp.reset();
      send({ type: "video-event", event: name });
    });
    ev("pause"); ev("ended"); ev("seeking", true);
    if (!isYT) watchTracks(v);
  }
  function resetForNewVideo() {
    cp.reset(); sawCaption = false; playedFor = 0; ccClicked = false; reported = null; trackHooked = false;
    if (video && !isYT) watchTracks(video);
  }

  // ---- main tick (also the heartbeat with the video clock) ----
  setInterval(() => {
    const v = pickVideo();
    if (!v) return;
    if (v !== video) attach(v);
    if (isYT) watchYT();
    const key = videoKey();
    if (key !== curKey) { curKey = key; resetForNewVideo(); }
    const playing = !video.paused && !video.ended;
    send({ type: "video-time", t: video.currentTime, playing, key, title: document.title });
    if (playing) playedFor += 0.5;
    const hardNo = isYT ? !ensureYTCC() : !hasTextTrack(video);     // no caption UI/track at all
    let avail = null;
    if (sawCaption) avail = true;
    else if (playedFor >= (hardNo ? 3 : 8)) avail = false;          // played a while, nothing came
    if (avail !== reported && avail !== null) { reported = avail; send({ type: "captions-status", available: avail }); }
  }, 500);
})();
