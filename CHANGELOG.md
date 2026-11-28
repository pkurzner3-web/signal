# Changelog

## Nov 28, 2026: review fixes
- **Security:** the eval-only transcription override now only accepts a test server on the same machine, so a crafted link can't redirect call audio.
- **Live calls:** the transcription token is requested after you pick the tab, so a slow pick no longer breaks the call.
- **Backup model:** Signal returns to the main Gemini model after 30 seconds instead of staying on the backup.
- **Rate limits:** while every model is cooling down, each retry makes one upstream call instead of up to four.
- **Click to source:** cards and questions created from live text can still jump to their source after the sentence is finalized.

## Nov 28, 2026: improvement spec (P0, P1, P2)

### P0: correctness and reliability
1. **Live text no longer garbles.** Interim and final text are kept separate. Interim text is replaced whole on each update and shown in a lighter tone; final text is never changed by a late interim message. Speaker splitting only runs on final words. (`app.js`, `logic.js`)
2. **Speakers in file and tab mode.** Speakers show as Speaker 1 / 2 until you click one to mark them as You. One sentence is never split across speakers, unclear fragments under 3 words merge forward, and a pause over 1.5 s starts a new block. (`logic.js` `buildBlocks`, `app.js`)
3. **Rate limits recover on their own.** Automatic retries with backoff and jitter, server-side fallback to the next model, a request budget, and a header status chip ("Retrying…", "Using backup model") that clears itself. (`app.js` `ai()`, `lib/server.js`)
4. **Latency resets per run** and shows p50 / p95. The long-running log stays in Copy latency log and the export. Added a "Words on screen" measurement.

### P1: output quality
5. **Questions**: grounded in the last 60 seconds plus call notes, each with a quote from the transcript and a "why now" under 10 words. No assumed pain, budget or decisions; no repeats; targets the uncovered part of the active skill's framework (MEDDICC on sales when switched on, STAR in recruiting). The top question only changes when a candidate scores clearly higher, after 45 s, or if it was asked or dismissed. (`prompts/questions.txt`, `logic.js` `chooseQuestions`)
6. **Concept cards**: relevance-scored against the call (trivia dropped), each with "what it is" and "what it means here". Tags: From call, From docs, General. 3 visible, older ones fold away. "I know this" hides a term for good. (`prompts/concepts.txt`, `api/analyze.js`)
7. **Sample docs pack**: fictional product one-pager and battlecard in `evals/fixtures/_docs/`, loaded by every sales fixture.
8. **Eval harness**: `npm run eval` plays fixtures through the real app and scores WER, interim WER, speaker accuracy, moment coverage and time to card, question churn, judged question quality and card precision, latency p50 / p95 and reliability. Results and a markdown comparison go to `evals/results/`; regressions past `evals/thresholds.json` fail the run. 5 scripted sales calls plus a slot for the podcast clip. Runs at 1x speed (AssemblyAI throttles faster audio).
- **Accuracy**: the term map is sent to AssemblyAI as key terms (falls back automatically if rejected).

### P2: features and polish
9. **Call notes** update during the call (categories per call type in `skills/index.json`). After Stop, a recap with **Copy as CRM notes**.
10. **Question lifecycle**: suggested questions you ask move to Earlier questions marked Asked. Pin and Dismiss on hover, logged as feedback in the export.
11. **Traceability**: click a question or concept to highlight its source text in the transcript.
12. **Call signals**: talk-time bar in the header; objection and competitor badges in the transcript (folded into the notes request to save AI calls).
13. **Transcript**: a block per speaker change or pause, with a timestamp; Jump to live when scrolled up.
14. **Debug info** hidden behind Settings → Show debug info. **Export session** added there.
15. **Status** messages moved to the header chip.
16. Kept navy and glacier blue; the red recording dot is the only accent (Stop is now neutral).

### Tooling
- `npm test` (logic) and `npm run test:ui` (browser, fake backend); GitHub Actions runs both on every push and evals on demand.
- Vercel skips `npm install` (the app has no runtime dependencies), so the test tools don't slow deploys.
