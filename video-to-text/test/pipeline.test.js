const assert = require("assert");
const { CaptionPipeline } = require("../extension/pipeline.js");
function run(steps) {
  const out = []; const p = new CaptionPipeline((s) => out.push(s.text)); let t = 0;
  for (const s of steps) {
    if (s === "FLUSH") p.flush(t); else if (s === "RESET") { p.flush(t); p.reset(); } else p.onText(s, (t += 0.5));
  }
  return out;
}
// 1. rolling / growing captions (interim-like) -> exactly 3 sentences, no partial duplicates
assert.deepStrictEqual(run([
  "Hello", "Hello everyone.", "Hello everyone. Today we are",
  "Hello everyone. Today we are going to learn about data science.",
  "Today we are going to learn about data science. Data science is used",
  "data science is used in many industries.", "FLUSH"]),
  ["Hello everyone.", "Today we are going to learn about data science.", "Data science is used in many industries."]);
// 2. same caption stays on screen / re-fires -> stored once
assert.deepStrictEqual(run(["Hello everyone.", "Hello everyone.", "Hello everyone.", "FLUSH", "Hello everyone."]), ["Hello everyone."]);
// 3. caption disappears (pause in speech), unpunctuated cues get a period
assert.deepStrictEqual(run(["welcome back", "", "FLUSH", "to the show", "FLUSH"]), ["welcome back.", "to the show."]);
// 4. seek: screen state reset, so replayed text is emitted again (store-level dedup handles repeats)
assert.strictEqual(run(["Hello there.", "RESET", "Hello there."]).length, 2);
// 5. single-word overlap must not eat a new cue's first word
assert.ok(run(["That is it", "It was great.", "FLUSH"])[0].includes("It was great"));
console.log("pipeline tests passed");
