// Transcript store, route arbitration, ASR session management. State lives in chrome.storage
// because MV3 service workers are killed when idle. All mutations are serialized through one queue.
const sget = async (k) => (await chrome.storage.session.get(k))[k];
async function patch(tabId, p) {
  const k = "state:" + tabId;
  await chrome.storage.session.set({ [k]: { ...((await sget(k)) || {}), ...p } });
}
let q = Promise.resolve();
const enqueue = (f) => (q = q.then(f).catch((e) => console.error(e)));

const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

// Duplicate removal + corrections. Sentences arrive already segmented; here we drop repeats.
async function addSentence(tabId, s) {
  const key = "transcript:" + tabId;
  const list = (await chrome.storage.local.get(key))[key] || [];
  const n = norm(s.text); if (!n) return;
  const nowMs = Date.now(), last = list[list.length - 1];
  const dup = list.slice(-8).some((r) => norm(r.text) === n &&
    (nowMs - r.at < 15000 || (s.startTime < r.endTime + 2 && s.endTime > r.startTime - 2)));
  if (dup) return;
  if (last && nowMs - last.at < 8000 && last.source === s.source) {
    const ln = norm(last.text);
    if (n.startsWith(ln)) { list[list.length - 1] = { ...s, id: last.id, startTime: last.startTime, at: nowMs }; }  // extended/corrected
    else if (ln.includes(n)) return;                                                                            // already covered
    else list.push({ id: last.id + 1, ...s, at: nowMs });
  } else list.push({ id: last ? last.id + 1 : 1, ...s, at: nowMs });
  await chrome.storage.local.set({ [key]: list.slice(-5000) });
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();   // always fresh code/stream
  await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["USER_MEDIA"],
    justification: "Capture tab audio for speech recognition" });
}
const toOffscreen = (m) => chrome.runtime.sendMessage({ target: "offscreen", ...m }).catch(() => {});

async function handle(m, tabId) {
  const s = (await sget("state:" + tabId)) || {};
  switch (m.type) {
    case "video-time":
      if (s.key !== m.key) {                                   // new video (incl. YouTube SPA navigation)
        await chrome.storage.local.set({ ["transcript:" + tabId]: [] });
        await patch(tabId, { key: m.key, captionsAvailable: null, captionsAt: 0, videoTime: m.t, playing: m.playing, title: m.title });
      } else await patch(tabId, { videoTime: m.t, playing: m.playing });
      break;
    case "captions-status": await patch(tabId, { captionsAvailable: m.available }); break;
    case "sentence":                                            // route 1
      await patch(tabId, { captionsAt: Date.now() });
      await addSentence(tabId, { text: m.text, startTime: m.startTime, endTime: m.endTime, source: "captions" });
      break;
    case "asr-final": {                                         // route 2 (ignored while captions are flowing)
      await patch(tabId, { asrFinals: (s.asrFinals || 0) + 1 });
      if (Date.now() - (s.captionsAt || 0) < 6000) break;
      const endTime = Math.max(0, (s.videoTime || 0) - (m.lag || 0));
      await addSentence(tabId, { text: m.text, startTime: Math.max(0, endTime - (m.end - m.start)), endTime,
                                 source: "asr", confidence: m.confidence });
      break; }
    case "asr-status": await patch(tabId, { asrConnected: m.connected }); break;
    case "start-asr":
      await ensureOffscreen();
      await toOffscreen({ type: "start", streamId: m.streamId, tabId });
      await patch(tabId, { asr: true, asrFinals: 0 }); break;
    case "stop-asr": await toOffscreen({ type: "stop" }); await patch(tabId, { asr: false }); break;
    case "video-event": if (s.asr) await toOffscreen({ type: "flush" }); break;
  }
}

chrome.runtime.onMessage.addListener((m, sender) => {
  if (m.target) return;                                         // addressed to offscreen doc
  const tabId = sender.tab?.id ?? m.tabId;
  if (tabId != null) enqueue(() => handle(m, tabId));
});
chrome.tabs.onRemoved.addListener((id) => enqueue(async () => {
  const s = await sget("state:" + id);
  if (s?.asr) await toOffscreen({ type: "stop" });
  await chrome.storage.session.remove("state:" + id);
  await chrome.storage.local.remove("transcript:" + id);
}));
