(async () => {
  const $ = (id) => document.getElementById(id);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const id = tab.id, TK = "transcript:" + id, SK = "state:" + id;
  let list = (await chrome.storage.local.get(TK))[TK] || [];
  let st = (await chrome.storage.session.get(SK))[SK] || {};
  let autoTried = false;

  async function startAsr() {                     // one click/open per tab: Chrome requires it for tabCapture
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: id });
    chrome.runtime.sendMessage({ type: "start-asr", tabId: id, streamId });
  }
  function render() {
    const last = list[list.length - 1];
    const src = last ? (last.source === "captions" ? "Captions" : "Speech Recognition")
      : st.asr ? "Speech Recognition" : st.captionsAvailable ? "Captions" : "—";
    $("src").textContent = "Source: " + src + (st.asr && st.asrConnected === false ? "  (ASR server not reachable — run server/server.py)" : "")
      + (st.captionsAvailable === false && !st.asr ? "  (no captions detected)" : "")
      + (st.asr ? `  | ASR sentences received: ${st.asrFinals || 0}` : "")
      + `  | v${chrome.runtime.getManifest().version}`;
    $("status").textContent = st.playing ? "[Listening...]" : "[Paused / idle]";
    $("list").replaceChildren(...list.map((s) => {
      const d = document.createElement("div"); d.textContent = s.text;
      d.title = `${s.startTime.toFixed(1)}s – ${s.endTime.toFixed(1)}s`; return d; }));
    $("list").scrollTop = 1e9;
    if (st.captionsAvailable === false && !st.asr && !autoTried) { autoTried = true; startAsr(); }   // auto fallback
  }
  chrome.storage.onChanged.addListener((c) => {
    if (c[TK]) list = c[TK].newValue || [];
    if (c[SK]) st = c[SK].newValue || {};
    render();
  });
  chrome.runtime.onMessage.addListener((m) => {
    if (m.type === "asr-interim" && m.tabId === id) $("interim").textContent = m.text || "";
  });
  $("asr").onclick = () => { autoTried = true; startAsr(); };
  $("stop").onclick = () => chrome.runtime.sendMessage({ type: "stop-asr", tabId: id });
  $("copy").onclick = () => navigator.clipboard.writeText(JSON.stringify(list, null, 2));
  $("clear").onclick = () => chrome.storage.local.set({ [TK]: [] });
  render();
})();
