# Signal: Teammate B guide (testing and refinement)

Your job: make Signal measurably better and prove it. You test it, benchmark it against using Claude out of the box, make the improvements below, and hand Teammate C a tuned app plus the results for the "What we learned" section of the brief.

**Handoff to Teammate C:** [date agreed by the team]

## What you receive from Patrick

- Live link: **signal-three-smoky.vercel.app** (passcode sent to you privately)
- Collaborator access to the GitHub repo **signal**
- `README.md` (how the app works) and the latency screenshot from the first test

## Who Signal is for

Assume users are Stanford-educated. They know business and tech basics, but not in-depth technical concepts, specific acronyms, or industry news and context. Every explanation and question should be pitched at that person. The prompts already say this; your tests check whether the output matches.

## How to make changes

You don't need to code. Two ways:

1. **Small text edits** (prompts in `prompts/`, skills in `skills/`): open the file on GitHub, click the pencil icon, edit, click **Commit changes**.
2. **Code changes with Claude:** on GitHub click **Code**, then **Download ZIP**. Give Claude the ZIP and one of the prompts below. Claude gives you back changed files. Upload them on GitHub with **Add file**, then **Upload files**, then **Commit changes**.

Vercel redeploys within a minute or two. If a change doesn't show up after 5 minutes, ask Patrick to click **Redeploy** in Vercel. (Vercel's free plan only lets Patrick manage deployments.)

Tip: tell Claude "Follow `CLAUDE.md` and the anti-slop-ui-design skill in `.claude/skills`" for any visual change.

## Tools already in the app

- **Test with audio file**: plays a recording through Signal like a live call.
- **Latency bar** (bottom): median of the last 10 measurements per step. **Copy latency log** copies every measurement as CSV.
- **Settings**: switch between **Hybrid** and **Full transcript** context, and between the **Fast** and **Smart** model for questions. Also shows whether both keys work.

## Step 1: Baseline test (before changing anything)

Run 5 sessions and log each in a shared Google Sheet (the scorecard):

| # | Session | Call type |
|---|---|---|
| 1 | Semiconductor or AI-infrastructure podcast clip, 3 min | Sales discovery |
| 2 | Same clip, Settings set to **Full transcript** | Sales discovery |
| 3 | Role-played sales call over Google Meet (a teammate plays the buyer, using a short script with jargon) | Sales discovery |
| 4 | Role-played interview using a 4-question interview guide uploaded as **Role** | Recruiting interview |
| 5 | Repeat of #3 with Settings set to **Smart** model | Sales discovery |

Scorecard columns for each session:

- Latency log (paste from **Copy latency log**)
- Transcription errors: count misheard words in a 1-minute stretch, especially technical terms
- Speaker labels: right or wrong per turn
- Each concept card: **useful / obvious / wrong**
- Each set of questions: **would ask / so-so / wouldn't ask**
- Recruiting only: guide questions ticked correctly? Any missed or wrongly ticked?
- For industry news or company cards: is the context accurate? (The AI can be out of date; flag anything wrong.)

## Step 2: Benchmark against Claude out of the box

The goal is to show where Signal beats simply pasting a transcript into Claude, and where it doesn't yet.

**First, add an export button.** Give Claude this prompt with the repo ZIP:

> Add an "Export session" button next to "Copy latency log" in Signal. It saves a JSON file with: call type, active skills, the transcript (speaker, text, time), every concept card (term, explanation, source, time shown), every question set (questions, time shown), guide questions with asked status, and the latency log. Use a plain download link created from a Blob. Follow CLAUDE.md.

**Then, for sessions 3 and 4:**

1. Export the session.
2. Open a new chat with Claude (no project, no files) and paste the transcript up to 5 chosen moments, with this prompt:
   > I'm in a [sales discovery call / recruiting interview]. I'm Stanford-educated but not a technical specialist. Here is the conversation so far. Explain any technical terms or industry references I might not know, and suggest 3 follow-up questions I should ask next.
3. For each moment, put Signal's cards and questions next to Claude's, with the source hidden. Ask a teammate who wasn't on the call to pick the better set and rate each card useful / obvious / wrong.

Record for each moment: which side won, useful-card rate, and Signal's time to first question. Claude out of the box can't run live, so speed is Signal's built-in advantage. The real question is whether Signal's quality is close to Claude's, or better thanks to your documents and skills.

You can also give the exported JSON files to Claude and ask it to run the baseline and a blind comparison for you.

## Step 3: Improvements to make (in priority order)

Make one change at a time, rerun a short test, and note the before and after in the scorecard. Each item has a prompt to give Claude with the repo ZIP.

1. **Send the term map to AssemblyAI (biggest accuracy gain).**
   > In app.js, when opening the AssemblyAI WebSocket, pass up to 100 terms from the term map (terms plus aliases) as `keyterms_prompt`, and a short `prompt` (under 1,750 characters) describing the call type and the other side's brief. Follow CLAUDE.md.
2. **Make concept cards salient.**
   > Change the concepts prompt and api/analyze.js so the model also receives the active skills and both briefs, rates each candidate term 1 to 5 for importance to this call and for how likely a Stanford-educated generalist doesn't know it, and returns only terms scoring 4 or higher on both. Add an "I know this" button on each card that hides it and remembers the term in browser storage so it is never explained again. Follow CLAUDE.md.
3. **Two-step questions (speed and quality).**
   > Show questions from the fast model as soon as they're ready, then when the other side pauses, request the smart model and replace the set if it arrives within 8 seconds. Log the smart model's timing as a separate latency metric. Follow CLAUDE.md.
4. **Add example follow-ups to each skill.** No code: in each file in `skills/`, add 2 or 3 pairs of a weak follow-up and a strong one, written for the kinds of calls you tested.
5. **Reorder prompts for speed.** In `prompts/questions.txt` and `prompts/concepts.txt`, move the fixed parts (instructions, skills, briefs) to the top and the changing parts (guide, summary, conversation) to the bottom. Gemini can then reuse the fixed part, which is faster and reduces free-tier limit hits.
6. **Measure words-on-screen delay.**
   > Add a latency metric "Words on screen" measured from the audio time of the latest word in each partial transcript message to when it is displayed. Follow CLAUDE.md.
7. **Test AssemblyAI settings.** In `app.js`, the `CONFIG` block at the top: try `speechModel` set to `universal-3-6-pro` vs `assemblyai-stt-3-7-realtime`, and `turnMode` set to `balanced` vs `min_latency`. Compare transcription errors and latency.
8. **Remove duplicate text without headphones** (only if testers hit it).
   > If the mic transcript closely repeats what the tab transcript said in the last 5 seconds, drop the mic turn. Follow CLAUDE.md.

## Step 4: Re-test and write up findings

Rerun sessions 3 and 4 and the Claude benchmark. Then write 5 to 8 short findings for Teammate C, for example:

- Latency before and after, per step (median)
- Transcription errors before and after key terms
- Useful-card rate before and after the salience change
- Benchmark results: how often Signal beat, tied or lost to Claude out of the box, and why
- One or two surprises (what didn't work, what you'd do next)

## Handoff checklist

- [ ] All changes committed; the live link works
- [ ] Scorecard shared with the team (before and after columns filled)
- [ ] Exported session files saved in a shared folder
- [ ] Findings list sent to Teammate C
- [ ] Any open issues listed at the bottom of `README.md`
