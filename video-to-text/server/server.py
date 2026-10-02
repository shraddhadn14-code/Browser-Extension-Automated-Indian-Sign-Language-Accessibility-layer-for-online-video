"""Local ASR server: ws://127.0.0.1:8765
In : binary frames = 16 kHz mono int16 PCM; text frame {"cmd":"flush"}
Out: {"type":"interim","text":...} and {"type":"final","text","start","end","confidence","lag"}

Whisper is NOT a streaming model. This is chunk-based "growing window + local agreement":
re-decode the recent audio, and only commit words that two consecutive decodes agree on.
Receiving audio and decoding run separately, so a slow decode never blocks the connection.
Usage: python server.py [model]   (default base.en; try tiny.en if your PC is slow)
"""
import asyncio, json, re, sys, threading, time
import numpy as np
import websockets
from faster_whisper import WhisperModel

MODEL_NAME = sys.argv[1] if len(sys.argv) > 1 else "base.en"
LANG = "en" if MODEL_NAME.endswith(".en") else None
SR, STEP, MAX_BUF, SILENCE, VOICE_RMS = 16000, 1.0, 15.0, 1.0, 0.004
model = WhisperModel(MODEL_NAME, compute_type="int8")
norm = lambda w: re.sub(r"\W+", "", w.lower())
END = re.compile(r"[.!?][\"')\]]?$")


def transcribe(audio, t0, committed_end):
    t = time.time()
    segs, _ = model.transcribe(audio, language=LANG, word_timestamps=True, vad_filter=True,
                               condition_on_previous_text=False, beam_size=1)
    ws = [(t0 + w.start, t0 + w.end, w.word.strip(), w.probability)
          for s in segs for w in (s.words or []) if w.word.strip()]
    dt = time.time() - t
    if dt > STEP: print(f"[slow] decode of {len(audio)/SR:.1f}s audio took {dt:.1f}s - try a smaller model (tiny.en)")
    return [w for w in ws if w[0] >= committed_end - 0.05]      # words: (start, end, text, prob)


class Stream:
    def __init__(self):
        self.lock, self.epoch, self.voiced = threading.RLock(), 0, False
        self.buf = np.zeros(0, np.float32)
        self.t0 = self.total = self.last_decode = self.last_voice = self.committed_end = 0.0
        self.pending, self.prev, self.last_interim = [], [], ""

    def add(self, pcm):
        with self.lock:
            self.buf = np.concatenate([self.buf, pcm]); self.total += len(pcm) / SR
            if float(np.sqrt(np.mean(pcm ** 2))) > VOICE_RMS: self.last_voice, self.voiced = self.total, True

    def quiet(self): return self.total - self.last_voice >= SILENCE

    def sentence(self, ws):
        text = " ".join(w[2] for w in ws).strip()
        if not END.search(text): text += "."
        return {"text": text, "start": ws[0][0], "end": ws[-1][1],
                "confidence": round(float(np.mean([w[3] for w in ws])), 3),
                "lag": round(max(0.0, self.total - ws[-1][1]), 2)}

    def trim_to(self, t):
        self.buf = self.buf[max(0, int((t - self.t0) * SR)):]; self.t0 = max(self.t0, t)

    def take_sentences(self):
        out = []
        while True:
            i = next((i for i, w in enumerate(self.pending) if END.search(w[2])), None)
            if i is None: break
            out.append(self.sentence(self.pending[:i + 1])); self.trim_to(self.pending[i][1])
            self.pending = self.pending[i + 1:]
        return out

    def flush(self):
        """Finalize everything (silence, pause, seek, end) and drop the audio buffer."""
        with self.lock:
            self.epoch += 1
            self.pending += self.prev; self.prev = []
            out = self.take_sentences()
            if self.pending: out.append(self.sentence(self.pending))
            self.pending, self.voiced = [], False
            self.buf = np.zeros(0, np.float32); self.t0 = self.committed_end = self.total
            return out

    def snapshot(self):
        return self.buf.copy(), self.t0, self.committed_end, self.epoch

    def step(self):
        with self.lock:
            if self.quiet() or len(self.buf) < SR // 2: return [], None
            audio, t0, ce, ep = self.snapshot()
        hyp = transcribe(audio, t0, ce)                          # slow part, runs without the lock
        with self.lock:
            if ep != self.epoch: return [], None                 # a flush happened meanwhile: stale
            n = 0
            while n < min(len(self.prev), len(hyp)) and norm(self.prev[n][2]) == norm(hyp[n][2]): n += 1
            if n: self.pending += hyp[:n]; self.committed_end = hyp[n - 1][1]   # agreed by 2 decodes
            self.prev = hyp[n:]
            out = self.take_sentences()
            if len(self.buf) / SR > MAX_BUF: out += self.flush()               # no sentence end for 15 s
            return out, " ".join(w[2] for w in self.pending + self.prev)

    def final_flush(self):
        """Speaker went quiet: decode the tail once more, then finalize."""
        with self.lock:
            if not self.voiced or len(self.buf) < SR // 4: return self.flush()
            audio, t0, ce, ep = self.snapshot()
        hyp = transcribe(audio, t0, ce)
        with self.lock:
            if ep == self.epoch: self.prev = []; self.pending += hyp
            return self.flush()


async def handler(ws):
    st, loop = Stream(), asyncio.get_running_loop()
    print("client connected")

    async def send(finals, interim):
        for f in finals:
            print("FINAL:", f["text"], flush=True)
            await ws.send(json.dumps({"type": "final", **f}))
        if interim is not None and interim != st.last_interim:
            st.last_interim = interim; await ws.send(json.dumps({"type": "interim", "text": interim}))

    async def decoder():                                         # runs independently of receiving
        try:
            while True:
                await asyncio.sleep(0.05)
                if st.total - st.last_decode >= STEP and not st.quiet():
                    st.last_decode = st.total
                    finals, interim = await loop.run_in_executor(None, st.step)
                    await send(finals, interim)
        except websockets.ConnectionClosed:
            pass

    task = asyncio.create_task(decoder())
    try:
        async for msg in ws:
            if isinstance(msg, str):
                if json.loads(msg).get("cmd") == "flush": await send(st.flush(), "")
            else:
                st.add(np.frombuffer(msg, np.int16).astype(np.float32) / 32768)
                if st.quiet():
                    await send(await loop.run_in_executor(None, st.final_flush), "")
    finally:
        task.cancel()


async def main():
    async with websockets.serve(handler, "127.0.0.1", 8765, max_size=None, max_queue=None,
                                ping_interval=None):
        print(f"ASR server ready ({MODEL_NAME}) on ws://127.0.0.1:8765"); await asyncio.Future()

asyncio.run(main())
