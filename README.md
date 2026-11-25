# Signal

Live meeting copilot for the LTV final project. Signal transcribes a call with speaker labels, explains technical terms as they come up, and suggests follow-up questions using the conversation, your documents and the meeting's skill.

## How to use it

1. Open the Signal link in **Chrome** and enter the team passcode.
2. **Documents** (optional but recommended): add PDFs or text files, tag each as **Account** (the other side) or **Team** (our side), then click **Prepare**. This builds two short briefs and a term map so explanations show instantly.
3. Start one of these:
   - **Start live call**: Chrome asks what to share. Pick the browser tab with your Zoom, Google Meet or Teams call and turn on **Share tab audio**. Then allow the microphone. Your mic is labeled **You**; the tab is the **Other side**. Wear headphones so your mic doesn't pick up the other side.
   - **Test with audio file**: pick any audio file (for example a podcast clip). It plays through Signal like a live call, with speakers labeled A, B.
4. Watch the transcript on the left, **Ask next** questions and **Concepts to know** on the right. Click **Ask now** to get new questions at any time.
5. Click **Stop** when done.

Documents, briefs and the term map are saved in your own browser only. Teammates add their own.

## Latency readout

The bar at the bottom shows the median of the last 10 measurements for each step:

| Readout | What it measures |
|---|---|
| Transcript | Time from when words were spoken to when the final text arrived |
| Card (term map) | Time to show an explanation for a term already in the term map |
| Card (AI) | Time to show an explanation the AI had to write |
| Questions: first words | Time from the speaker stopping to the first words of new questions |
| Questions: done | Time until all 3 questions finished |

**Copy latency log** copies every measurement as CSV to paste into a spreadsheet.

**Settings → Context sent to the AI** switches between:
- **Hybrid** (default): term map + last 90 seconds + running summary.
- **Full transcript**: sends everything, for the Phase 2 comparison.

Settings also shows whether both keys are working and which Gemini models are in use.

## How to change things (no coding needed)

- **Prompts**: edit the text files in `prompts/`. Words in `{{double braces}}` are filled in by the app; keep them.
  - `prepare.txt`: builds briefs and the term map from documents
  - `concepts.txt`: concept cards
  - `questions.txt`: follow-up questions
  - `summary.txt`: running summary
- **Skills**: add a file to `skills/` and list it in `skills/index.json`. Format:

```
---
name: MEDDICC
meeting_types: [sales]
documents: []
---
Listen for: ...
Question style: ...
Flag: ...
```

- **Speed settings**: the `CONFIG` block at the top of `app.js` (window length, summary interval, question delay).

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
| `audio-worklet.js` | Converts audio into the format AssemblyAI expects |
| `api/token.js` | Gives the browser a short-lived AssemblyAI token |
| `api/prepare.js` | Documents → briefs + term map |
| `api/analyze.js` | Concept cards, questions, running summary |
| `api/auth.js` | Passcode check and setup status |
| `lib/server.js` | Shared server code, including Gemini model selection |
| `prompts/`, `skills/` | Editable text |

## Known limits

- Chrome only. Capturing a tab's audio needs Chrome; use Zoom, Meet or Teams in the browser, not the desktop app.
- Gemini's free tier limits requests per minute. If you see a limit message, wait a few seconds. Google may review free-tier inputs, so upload only public material.
- Speaker labels on a single audio feed (test mode) can be wrong for the first one or two turns.
- Scanned PDFs (images of text) can't be read.
