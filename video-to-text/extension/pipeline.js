// Caption text -> sentences. Pure logic (no DOM), so it is unit-testable in Node.
// Input: the caption text currently on screen (rolling YouTube auto-captions or whole cues).
// Output: complete sentences via emit({text,startTime,endTime,source}).
class CaptionPipeline {
  constructor(emit) { this.emit = emit; this.reset(); }
  reset() { this.prev = []; this.pending = []; this.t0 = null; }

  static key(w) { return w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""); }

  // Called on every caption change. Only the words that were not on screen before are added.
  onText(text, t) {
    const cur = text.split(/\s+/).filter(Boolean);
    if (!cur.length) { this.prev = []; return; }            // caption disappeared
    const k = CaptionPipeline.key;
    let ov = 0;
    for (let n = Math.min(this.prev.length, cur.length); n > 0; n--) {
      // overlap = tail of previous screen text equals head of the current one (rolling captions).
      // A 1-word overlap is only trusted if the whole previous text is a prefix (pure growth).
      if ((n >= 2 || n === this.prev.length) &&
          this.prev.slice(-n).every((w, i) => k(w) === k(cur[i]))) { ov = n; break; }
    }
    this.prev = cur;
    const fresh = cur.slice(ov);
    if (!fresh.length) return;                               // same caption still on screen
    if (!this.pending.length) this.t0 = t;
    this.pending.push(...fresh);
    this.drain(t);
  }

  drain(t) {
    const parts = this.pending.join(" ").split(/(?<=[.!?]["')\]]?)\s+/);
    const tail = /[.!?]["')\]]?$/.test(parts[parts.length - 1]) ? "" : parts.pop();
    parts.forEach((p) => this.out(p, t));
    this.pending = tail ? tail.split(" ") : [];
    if (this.pending.length >= 30) this.flush(t);            // unpunctuated run-on: force a break
  }

  // Idle / pause / seek / end: turn whatever is pending into a sentence.
  flush(t) {
    if (!this.pending.length) return;
    let text = this.pending.join(" ");
    if (!/[.!?]["')\]]?$/.test(text)) text += ".";
    this.pending = [];
    this.out(text, t);
  }

  out(text, t) {
    if (/[\p{L}\p{N}]/u.test(text)) {
      this.emit({ text: text.trim(), startTime: this.t0 ?? t, endTime: t, source: "captions" });
    }
    this.t0 = t;
  }
}
if (typeof module !== "undefined") module.exports = { CaptionPipeline };
