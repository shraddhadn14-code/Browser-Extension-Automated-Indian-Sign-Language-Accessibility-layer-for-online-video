// Audio capture (tab audio -> 16 kHz PCM) and WebSocket link to the local ASR server.
const WS_URL = "ws://127.0.0.1:8765";
let ws, ctx, stream, active = false, tabId = null;

chrome.runtime.onMessage.addListener((m) => {
  if (m.target !== "offscreen") return;
  if (m.type === "start") start(m.streamId, m.tabId);
  if (m.type === "stop") stop();
  if (m.type === "flush" && ws?.readyState === 1) ws.send(JSON.stringify({ cmd: "flush" }));
});

function connect() {
  ws = new WebSocket(WS_URL); ws.binaryType = "arraybuffer";
  ws.onopen = () => chrome.runtime.sendMessage({ type: "asr-status", tabId, connected: true });
  ws.onmessage = (e) => {
    const d = JSON.parse(e.data);
    chrome.runtime.sendMessage({ ...d, type: "asr-" + d.type, tabId });   // asr-final / asr-interim (type must come last)
  };
  ws.onclose = () => {
    chrome.runtime.sendMessage({ type: "asr-status", tabId, connected: false });
    if (active) setTimeout(connect, 2000);                                // server restart tolerance
  };
}

async function start(streamId, tid) {
  stop(); active = true; tabId = tid;
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } } });
  ctx = new AudioContext();                       // native rate so the user still hears clean audio
  if (ctx.state === "suspended") await ctx.resume();
  await ctx.audioWorklet.addModule("pcm-worklet.js");
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "pcm");
  const mute = ctx.createGain(); mute.gain.value = 0;
  src.connect(ctx.destination);                   // tabCapture mutes the tab; play it back
  src.connect(node); node.connect(mute).connect(ctx.destination);
  node.port.onmessage = (e) => { if (ws?.readyState === 1) ws.send(e.data); };
  connect();
}
function stop() {
  active = false;
  try { ws?.close(); } catch (_) {}
  stream?.getTracks().forEach((t) => t.stop());
  ctx?.close(); ws = ctx = stream = null;
}
