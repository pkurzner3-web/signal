# Signal

Live meeting copilot for the LTV final project. Signal transcribes a call with speaker labels, explains technical terms as they come up, suggests follow-up questions grounded in what was said, and keeps call notes, using the conversation, your documents and the meeting's skills.

## How to use it

1. Open the Signal link in **Chrome** and enter the team passcode.
2. **Pick the call type** next to the Signal name: **Sales discovery** or **Recruiting interview**. Each type has its own skills, documents, labels and note categories.
3. **Call setup** (recommended): switch skills on or off, add documents and tag them, then click **Prepare for the call**. This builds two short briefs, a term map (so explanations show instantly and transcription gets technical words right) and a list of **guide questions** pulled from any interview guide or discovery checklist you upload.
   - Sales: tag documents **Account** (the company you're meeting) or **Team** (your side).
   - Recruiting: tag documents **Candidate** (resume) or **Role** (job description, interview guide).
4. Start one of these:
   - **Start live call**: Chrome asks what to share. Pick the browser tab with your Zoom, Google Meet or Teams call and turn on **Share tab audio**. Then allow the microphone. Your mic is labeled **You**. Wear headphones so your mic doesn't pick up the other side.
   - **Test with audio file**: plays a recording through Signal. Speakers show as **Speaker 1, Speaker 2**. Click a speaker's name to mark them as **You**; everyone else becomes the other side.
5. During the call:
   - **Transcript**: live text appears in a lighter tone until it's final. A new block starts when the speaker changes or after a pause. If you scroll up, **Jump to live** brings you back.
   - **Ask next**: three questions, each with a short reason tied to what was said. Click a question to see the words it builds on. Hover for **Pin** (keep it) or **Dismiss**. The top question only changes when a clearly better one comes along. When you ask a suggested question, it moves to **Earlier questions** marked Asked.
   - **Guide questions**: ticks off recommended questions as you ask them.
   - **Call notes**: pain points, people, tools and competitors, timeline and next steps (or strengths and concerns for interviews), updated as the call goes. Objections and competitor mentions get a small badge in the transcript.
   - **Concepts to know**: up to 3 cards, each saying what the term is and what it means in this call. Tags show where the information came from: **From call**, **From docs** or **General**. Click a term to see where it came up. Hover for **I know this** to stop seeing it.
   - The header shows **talk time** (You vs the other side) and a small status message if the AI is retrying or using a backup model.
6. Click **Stop** when done. Signal writes a **recap**; **Copy as CRM notes** copies it.

Documents, briefs, the term map, guide questions and "I know this" terms are saved in your own browser only, separately for each call type.

## Debug info and session export

**Settings → Show debug info** (off by default) shows, for the current run only:

| Readout | What it measures |
|---|---|
| Words on screen | Time from speech to live text appearing |
| Final text | Time from speech to final text (includes waiting for a pause) |
| Card from docs / Card from AI | Time to show an explanation |
| Questions start / done | Time from the trigger to the first words and to all 3 questions |

Each shows p50 / p95 (typical and worst-case), plus request, retry, rate-limit, backup-model and error counts. **Copy latency log** copies every measurement across runs as CSV. **Export session** downloads everything from the run as JSON (transcript, questions with timing, cards, notes, recap, feedback, latency) for benchmarking.

**Settings → Context sent to the AI** switches between **Hybrid** (default: term map, last 60 seconds and call notes) and **Full transcript** (for comparison).

## Reliability

- AI requests retry automatically with backoff (about 0.5, 1, 2 and 4 seconds) on busy or rate-limit errors, then pause for 15 seconds.
- If a Gemini model is busy, the server switches to the next one for 30 seconds, then returns to the main model. The header shows "Using backup model" meanwhile.
- A request budget (about 14 a minute) keeps cards, questions and notes under Gemini's free-tier limits; questions get priority.

## Tests and evals

- `npm test`: fast checks of the shared logic (speaker blocks, quotes, question parsing and stability, stats). No setup needed beyond Node.js.
- `npm run test:ui`: runs the app in a headless browser against a fake backend.
- `npm run eval`: plays scripted calls through the live app and scores transcription, speakers, question quality, coverage of key moments, churn and latency. See `evals/README.md`.
- GitHub runs the tests on every push (the **Actions** tab). Evals run on demand there too.

## How to change things (no coding needed)

- **Prompts**: edit the text files in `prompts/`. Words in `{{double braces}}` are filled in by the app; keep them.
  - `prepare.txt`: briefs, term map and guide questions from documents
  - `concepts.txt`: concept cards
  - `questions.txt`: follow-up questions
  - `summary.txt`: call notes, objection and competitor signals
  - `recap.txt`: the post-call recap
  - `coverage.txt`: decides which guide or suggested questions you've asked
- **Call types and skills**: `skills/index.json` lists each call type (label, what the other side is called, document tags, note categories and skills). To add a skill, add a file to `skills/` and list it under a call type with `"on": true` or `false`. Skill format:

```
---
name: MEDDICC
meeting_types: [sales]
documents: []
---
Goal: ...
Listen for: ...
Question style: ...
Flag: ...
```

- **Speed settings**: the `CONFIG` block at the top of `app.js`.

To edit on GitHub: open the file, click the pencil icon, make the change, click **Commit changes**. Vercel redeploys in a minute or two. Or ask Claude to make the change and upload the files it gives you.

## Setup (already done once)

Vercel → Project → Settings → Environment Variables:

| Name | Value |
|---|---|
| `ASSEMBLYAI_API_KEY` | AssemblyAI key |
| `GEMINI_API_KEY` | Gemini key from Google AI Studio |
| `APP_PASSCODE` | team passcode |

Optional: `GEMINI_FAST_MODEL` and `GEMINI_SMART_MODEL` to force specific Gemini models. Otherwise Signal picks the newest Flash-Lite (fast) and Flash (smart) models your key can use.

After changing a variable, go to **Deployments**, click **⋯** on the latest one, then **Redeploy**.

## Files

| Path | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app screen and its logic |
| `logic.js` | Pure helpers shared by the app, tests and evals |
| `audio-worklet.js` | Converts audio into the format AssemblyAI expects |
| `api/token.js` | Short-lived AssemblyAI token for the browser |
| `api/prepare.js` | Documents into briefs, term map and guide questions |
| `api/analyze.js` | Cards, questions, coverage, call notes and recap |
| `api/auth.js` | Passcode check and setup status |
| `lib/server.js` | Shared server code: Gemini model choice and fallback |
| `prompts/`, `skills/` | Editable text |
| `tests/` | Unit and browser tests |
| `evals/` | Eval runner, fixtures and results |

## Known limits

- Chrome only. Capturing a tab's audio needs Chrome; use Zoom, Meet or Teams in the browser, not the desktop app.
- Speaker detection on a single audio feed is beta at AssemblyAI. The first one or two turns can be wrong.
- If AssemblyAI rejects the term-map words, Signal reconnects without them automatically.
- Google may review free-tier Gemini inputs, so upload only public material.
- Scanned PDFs (images of text) can't be read.
