# Live Video Transcript (prototype)
1. `cd server && pip install -r requirements.txt && python server.py base.en` (only needed for the ASR fallback)
2. chrome://extensions -> Developer mode -> Load unpacked -> `extension/`
3. Open a YouTube video. Captions route starts automatically. Open the popup to see the live transcript.
   If no captions exist, opening the popup starts ASR (one click per tab is a Chrome requirement).
Unit test: `node test/pipeline.test.js`
