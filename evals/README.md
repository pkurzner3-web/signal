# Signal evals

Repeatable tests that play scripted calls through the real app and score the result, so every change can be compared with the last run.

## What it measures

| Metric | Meaning | Better |
|---|---|---|
| `final_wer` | Word error rate of the final transcript vs the script | Lower |
| `interim_wer` | How wrong live (in-progress) text was vs the final text of the same turn | Lower |
| `speaker_accuracy` | Share of turns attributed to the right speaker | Higher |
| `moment_coverage` | Share of key moments (pain, budget, timeline, decision maker, objection, competitor) followed by a relevant question or card within 15 s | Higher |
| `time_to_card_median_s` | Seconds from a key moment to that question or card | Lower |
| `churn_per_min` | How often the top question changed | Lower |
| `question_quality_mean`, `question_quality_pct4` | Judge score 1 to 5 (grounded, non-presumptive, not redundant, advances discovery) and share scoring 4 or more | Higher |
| `card_precision` | Share of concept cards the judge says were worth showing | Higher |
| `*_p50_ms`, `*_p95_ms` | Latency per stage: words on screen, final text, cards, questions start and done | Lower |
| `error_rate`, `rate_limited`, `backup_model` | Reliability counters | Lower |

## One-time setup (on a Mac)

1. Install Node.js 22 from nodejs.org.
2. In the repo folder: `npm install`, then `npx playwright install chromium`.
3. Generate the fixture audio with the Mac's built-in voices: `npm run make-audio`. This writes `audio.wav`, `transcript.gold.json` and `moments.gold.json` into each fixture. Commit them so CI can use them.

## Run

```
SIGNAL_PASSCODE=yourpasscode npm run eval
```

Options:

- `-- --only=sales-01-inference-startup` runs one fixture
- `-- --model=<gemini model id>` compares a specific Gemini model
- `-- --judge=gemini` scores question and card quality with Gemini (needs `GEMINI_API_KEY`). Gemini grading Gemini can be generous, so treat it as a trend line.
- `-- --judge=export` saves `judge-input.json` with every question and card in context, so Claude or a teammate can grade it independently
- `-- --headed` shows the browser while it runs
- `SIGNAL_URL=...` tests a Vercel preview link instead of the live site

Each run writes `results/<time>-<model>.json`, a markdown summary next to it, and the raw exported sessions in a folder. The runner compares with the previous results file and exits with an error if a metric got worse by more than the limit in `thresholds.json`.

## Run in GitHub (no laptop needed)

1. In the GitHub repo: **Settings**, then **Secrets and variables**, then **Actions**. Add `SIGNAL_PASSCODE` and `GEMINI_API_KEY`.
2. Open the **Actions** tab, pick **Eval**, click **Run workflow**. Results download from the run page under **Artifacts**.

## Notes

- Audio plays at normal speed. AssemblyAI's live API throttles audio sent faster than about real time, so 4x replay isn't possible through the live pipeline.
- Live transcription and AI output vary a little between runs. Compare trends across a few runs before acting on a small change.
- Each full run uses a few cents of AssemblyAI credit and counts against Gemini's free-tier limits.
- `fixtures/_docs/` holds a fictional product one-pager and battlecard. Every sales fixture loads them, so the "from your docs" path is tested on each run.
- To add a fixture: copy a `sales-0x` folder, edit `script.json` (mark key moments on the turns where they happen, with keywords a good question or card would mention), then run `npm run make-audio -- <folder>`.
- `offdomain-podcast/` is for your own podcast clip. See its README.
