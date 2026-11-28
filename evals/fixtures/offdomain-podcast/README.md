# Off-domain podcast clip

Put the podcast clip you tested with here as `audio.mp3` (or `audio.wav`). It checks that Signal behaves sensibly on a conversation that isn't a sales call.

`meta.json` is already set up. If you also add `transcript.gold.json` (a list of `{ "speaker", "text", "start", "end" }` turns, times in milliseconds), the runner reports word error rate and speaker accuracy for it too. Without it, only latency, churn and judged quality are reported.

Only use audio you have the rights to use, and keep it out of the public repo if you don't (add it locally and don't commit it).
