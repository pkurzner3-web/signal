# Signal: Teammate C guide (features and write-up)

Your job: refine Signal's call types and skills, make sure it's demo-ready, record the Loom, and assemble the written brief for submission.

**Due:** Monday, December 7, 8am (aim to submit by December 6)

## What you receive from Teammate B

- The tuned app at **signal-three-smoky.vercel.app** (passcode sent to you privately)
- The scorecard (before and after latency and quality, benchmark vs Claude)
- A findings list for "What we learned"

## Who Signal is for

Assume users are Stanford-educated. They know business and tech basics, but not in-depth technical concepts, specific acronyms, or industry news and context. Keep every skill, example and demo pitched at that person.

## How to make changes

1. **Text edits** (skills in `skills/`, prompts in `prompts/`): open the file on GitHub, click the pencil icon, edit, click **Commit changes**.
2. **Code changes with Claude:** on GitHub click **Code**, then **Download ZIP**. Give Claude the ZIP and your request. Upload the files Claude gives back with **Add file**, then **Upload files**, then **Commit changes**.

Vercel redeploys within a minute or two. If not, ask Patrick to click **Redeploy** in Vercel. For any visual change, tell Claude: "Follow `CLAUDE.md` and the anti-slop-ui-design skill in `.claude/skills`."

## How call types and skills work

- `skills/index.json` lists each call type: its label, what the other side is called, its document tags, and which skills it uses (`"on": true` means switched on by default).
- Each skill is a plain text file in `skills/` with a name, a goal, what to listen for, question style and flags.
- Users switch skills on or off in **Call setup**. Documents are stored per call type.

## Step 1: Refine call types and skills

1. **Review the 4 current skills** (`sales-discovery.md`, `meddicc.md`, `star-behavioral.md`, `technical-depth.md`) against Teammate B's scorecard. Tighten anything that produced weak or off-target questions.
2. **Check the example follow-ups** Teammate B added to each skill. Each skill should have 2 or 3 pairs of a weak and a strong follow-up.
3. **Add features the team agrees on.** Write each as a short request to Claude, one feature at a time, and test after each.
4. **Regression check:** rerun Teammate B's sessions 3 and 4. Make sure latency and quality didn't slip. Note the numbers in the scorecard.

## Step 2: Demo prep and Loom (2 to 3 minutes)

Suggested script:

1. **(15 s) The problem:** a generalist seller or recruiter facing a technical buyer or candidate.
2. **(30 s) Call setup:** pick the call type, show uploaded documents, click Prepare, show the briefs, term map and guide questions.
3. **(75 s) Live call:** start a live call (role-play or a podcast tab). Show the transcript with speaker labels, a concept card appearing mid-sentence, follow-up questions, and a guide question getting ticked.
4. **(20 s) Switch to Recruiting interview** and show the different labels, skills and guide.
5. **(20 s) Results:** the latency bar and one benchmark result from the scorecard.

Record with Loom in Chrome. Use headphones so the mic doesn't pick up the call audio.

## Step 3: The written brief

Requirements from the assignment memo:

- 500 to 1,000 words
- The file name includes all three last names, for example `Signal_LTV_Final_[Last1]_[Last2]_[Last3].docx`
- Required sections, in order: Introduction, What we built, Why we built it, How it works, What we learned (most important), Appendix
- Disclose precisely which AI tools were used and how
- Grading: 50% artifact, 40% brief quality, 10% format adherence. It's judged on use of the course's tools and frameworks and on judgment, not technical quality.

The draft below is about 900 words, so trim as you add results to stay under 1,000. Replace everything in [brackets], fill "What we learned" from Teammate B's findings, and connect it to LTV frameworks and cases from class.

---

### DRAFT BRIEF

**INTRODUCTION**

[Full name 1], [Full name 2], [Full name 3]. December 7, 2026. Section [ ].

**Signal** is a live copilot for technical conversations. It listens to a sales discovery call or a recruiting interview, transcribes it with speaker labels, explains technical terms and industry references in plain English as they come up, and suggests follow-up questions grounded in the conversation, the user's documents and a chosen framework.

**WHAT WE BUILT**

- Live app: [signal-three-smoky.vercel.app] (passcode available on request)
- Demo: [Loom link]

Signal captures the user's microphone and the browser tab running the call (Zoom, Meet or Teams). The screen shows the transcript on the left. On the right are "Ask next" (three follow-up questions, refreshed when the other side pauses or during long answers), "Guide questions" (recommended questions from an uploaded interview guide or discovery checklist, ticked off automatically when asked) and "Concepts to know" (plain-English explanations). Users pick a call type, Sales discovery or Recruiting interview, which switches the labels, document types and frameworks (MEDDICC, STAR, technical depth).

**WHY WE BUILT IT**

[Startup context: 2 to 3 sentences on the target customer, for example generalist business hires, MBA-trained sellers and recruiters at semiconductor and AI-infrastructure companies.] These users are smart but not specialists. On a call with an engineer or a technical candidate, an unfamiliar acronym or industry reference can derail the conversation: they miss the follow-up that matters, skip key qualification questions, or lose credibility. Existing conversation-intelligence tools mostly summarize after the call or are priced for large sales teams, and real-time coaching tools focus on contact centers. Signal helps during the call, for one person, using that person's own documents.

**HOW IT WORKS**

- **Transcription:** audio streams from the browser to AssemblyAI's real-time API. The mic is labeled "You" and the call tab is the other side. Per-word speaker labels split turns when two people on the other side talk back to back.
- **Preparation:** before the call, uploaded documents are condensed by Google's Gemini into two short briefs (the other side, our side), a term map of likely technical terms with explanations, and a list of guide questions.
- **Live analysis:** known terms are explained instantly from the term map. New terms go to a fast Gemini model. Questions stream from Gemini using the last 90 seconds, a running summary, the briefs and the active skills.
- **Stack:** GitHub (shared code), Vercel (hosting plus small server functions that keep API keys secret), AssemblyAI and the Gemini API on free tiers.

Key design decisions:

1. **Hybrid context instead of the full transcript.** We weighed sending the full transcript (simple but slower as calls grow) against a full knowledge graph (fast but a heavy build). We chose a lightweight term map plus a rolling window. [Insert the measured comparison.]
2. **Zero cost, no credit card.** Our HBS accounts couldn't add a card, so every service runs on a free tier, behind a team passcode.
3. **Swappable parts.** Transcription and AI calls sit behind small server functions. When our first transcription vendor's sign-up failed, switching to AssemblyAI took minutes.
4. **Glanceable design.** A live tool competes with the conversation for attention, so the screen shows one highlighted insight at a time, never animates live text, and uses a restrained two-color palette. We encoded these rules as a design skill the AI follows.
5. **Frameworks as editable text.** Call types and skills are plain text files, so non-engineers can tune them.

**WHAT WE LEARNED**

[Results from Teammate B's scorecard: latency per step before and after, transcription errors before and after key terms, useful-card rate, benchmark wins, ties and losses vs Claude out of the box.]

Non-obvious insights so far (keep, cut or expand with data):

1. **Latency came from AI configuration, not transcription.** One model setting (extended "thinking") made questions take 50 seconds. Turning it off brought the first words to under 1 second.
2. **Waiting for someone to finish talking doesn't work.** Long answers delayed help by a minute, so Signal now updates mid-answer.
3. **Relevance beats coverage.** Explaining every technical word is noise. We defined the user (Stanford-educated, not a specialist) and [if Teammate B's salience change worked] scored each term's relevance before showing it. [Insert before and after useful-card rates.]
4. **Constraints shaped the architecture.** No card and no API keys pushed us to free tiers, fallbacks and swappable vendors, which also made the product cheaper to run.
5. [Benchmark insight: where Signal beat Claude out of the box (live timing, grounding in documents and frameworks) and where it didn't.]

LTV connections: [Tie to course frameworks and cases. For example, the memo's "10x founder or 10x joiner, combining timeless methods with timely tools": Signal applies timeless discovery and interviewing methods (MEDDICC, STAR) through timely AI tools, aimed at helping a new joiner ramp quickly in a technical role. Add the MVP and iteration approach and any relevant cases.]

**AI tool disclosure**

- **Claude (Anthropic):** planned the project, wrote the PRD and most of the code, debugged deployment, and drafted this brief. Every change was tested by a team member in the live app; Claude could not call the live APIs from its own environment.
- **Gemini API (Google):** powers Signal's live analysis (briefs, term map, explanations, questions).
- **AssemblyAI:** real-time transcription and speaker labels.
- [Reflection on tool quality, for example: Claude produced a working first version in one session, but deployment issues such as a hidden character in a pasted key needed human debugging.]

**APPENDIX**

- PRD and team plan [links]
- `README.md`, `README-teammate-B.md`, `README-teammate-C.md`
- Skill files and `skills/index.json`
- Scorecard and benchmark results [link]
- Screenshots of sales and recruiting modes

---

## Handoff checklist

- [ ] Skills refined and regression check done
- [ ] Loom recorded and linked
- [ ] Brief finalized: all brackets replaced, 500 to 1,000 words, file named with all three last names
- [ ] Team review of the brief before submission
- [ ] Submitted by December 7, 8am
