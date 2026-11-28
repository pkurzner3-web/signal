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

You don't need to code for most of this. Two ways:

1. **Small text edits** (prompts in `prompts/`, skills in `skills/`): open the file on GitHub, click the pencil icon, edit, click **Commit changes**.
2. **Code changes with Claude:** on GitHub click **Code**, then **Download ZIP**. Give Claude the ZIP and one of the prompts below. Claude gives you back changed files. Upload them on GitHub with **Add file**, then **Upload files**, then **Commit changes**.

Vercel redeploys within a minute or two. If a change doesn't show up after 5 minutes, ask Patrick to click **Redeploy** in Vercel. (Vercel's free plan only lets Patrick manage deployments.)

Tip: tell Claude "Follow `CLAUDE.md` and the anti-slop-ui-design skill in `.claude/skills`" for any visual change.

## Tools already in the app

- **Test with audio file**: plays a recording through Signal. Click a speaker's name to mark them as You.
- **Settings → Show debug info**: latency p50 / p95 for this run, plus retry, rate-limit and backup-model counts. **Copy latency log** and **Export session** live there.
- **Settings**: switch between **Hybrid** and **Full transcript** context, and between the **Fast** and **Smart** model for questions.
- **Evals** (`evals/`): scripted calls played through the real app and scored automatically. See `evals/README.md`.

## Already built (from the improvement spec)

Patrick's build already covers: key terms sent to AssemblyAI, grounded and stable questions with quotes and "why now", relevance-scored concept cards with "I know this", retries and backup models, call notes and recap, question Pin and Dismiss, click-to-source, and session export. See `CHANGELOG.md`. Your job is to measure these, tune them, and report what you find.

## Step 1: Set up and run the evals (about 30 minutes, on a Mac)

1. Install Node.js 22 from nodejs.org. Clone the repo (GitHub **Code** button, then **Open with GitHub Desktop**, or download the ZIP).
2. In the repo folder, in Terminal: `npm install`, then `npx playwright install chromium`.
3. `npm run make-audio` generates the 5 scripted calls with the Mac's built-in voices. Commit the new files.
4. `SIGNAL_PASSCODE=<passcode> npm run eval -- --judge=gemini`
5. Read the summary in `evals/results/`. This is the baseline.

Optional: add the podcast clip to `evals/fixtures/offdomain-podcast/` (see its README).

## Step 2: Human check and benchmark against Claude out of the box

The automated judge is Gemini grading Gemini, so add a human check and an independent baseline.

1. Run 3 live sessions yourself (a role-played sales call over Google Meet, a role-played interview with a 4-question guide tagged **Role**, and the podcast clip). After each, click **Export session**.
2. In a scorecard (Google Sheet), rate each question **would ask / so-so / wouldn't ask** and each card **useful / obvious / wrong**. For news or company cards, check the facts; the AI can be out of date.
3. Benchmark: give Claude an exported session (or the eval's `--judge=export` file) with this prompt:
   > Here is a transcript from a [sales discovery call / recruiting interview] and the questions and concept cards a live assistant showed, with timestamps. I'm Stanford-educated but not a technical specialist. At 5 moments, write the 3 follow-up questions and explanations you would have suggested from the transcript up to that point. Then, blind to which is which, compare yours with the assistant's and say which set is better and why.
4. Record which side won at each moment and why. Claude out of the box can't run live, so speed is Signal's built-in edge; the question is whether quality matches or beats it.

## Step 3: Tune (one change at a time, rerun evals after each)

1. **Prompts** in `prompts/` (no code): tighten wording where the scorecard shows weak questions or obvious cards.
2. **Skill examples**: in each file in `skills/`, add 2 or 3 pairs of a weak follow-up and a strong one.
3. **Speed and stability** in the `CONFIG` block at the top of `app.js`: `windowSeconds`, `midTurnQuestionGapMs`, `topMaxAgeMs`, `maxAiPerMinute`.
4. **Transcription**: try `speechModel` set to `universal-3-6-pro` vs `assemblyai-stt-3-7-realtime`, and `turnMode` set to `balanced` vs `min_latency`. Compare WER and latency in the eval.
5. **Models**: `npm run eval -- --model=<id>` compares Gemini models. The model names appear in Settings.
6. **Thresholds**: once results settle, tighten `evals/thresholds.json` so future changes can't quietly make things worse.
7. Ideas not built yet, if you have time: two-step questions (fast first, smart replaces), and dropping duplicate mic text when someone isn't wearing headphones.

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
- [ ] Eval results committed in `evals/results/` (baseline and after tuning)
- [ ] Exported session files saved in a shared folder
- [ ] Findings list sent to Teammate C
- [ ] Any open issues listed at the bottom of `README.md`
