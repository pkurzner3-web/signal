// AI judge for question quality and concept-card precision.
// --judge=gemini  calls Gemini directly (needs GEMINI_API_KEY). Note: Gemini grading Gemini can be generous.
// --judge=export  writes judge-input.json so an independent model (for example Claude) can grade it.
import { writeFileSync } from 'node:fs';

const API = 'https://generativelanguage.googleapis.com/v1beta';

async function pickJudgeModel(key) {
  if (process.env.JUDGE_MODEL) return process.env.JUDGE_MODEL;
  const r = await fetch(`${API}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key } });
  if (!r.ok) throw new Error('Judge could not list Gemini models: ' + r.status);
  const names = ((await r.json()).models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((n) => /gemini/i.test(n) && /flash/i.test(n) && !/lite|image|tts|audio|live|embed|thinking/i.test(n));
  const v = (n) => parseFloat((n.match(/(\d+(?:\.\d+)?)/) || [])[1] || 0);
  names.sort((a, b) => v(b) - v(a) || Number(a.includes('preview')) - Number(b.includes('preview')));
  if (!names.length) throw new Error('No Gemini flash model available for judging.');
  return names[0];
}

function transcriptUpTo(session, atMs) {
  return session.transcript.filter((x) => x.t == null || x.t <= atMs).slice(-14).map((x) => `${x.speaker}: ${x.text}`).join('\n');
}

export function buildJudgeItems(session) {
  return {
    questions: (session.questionsShown || []).map((q, i) => ({ id: 'q' + i, at: q.at, question: q.q, why: q.why, context: transcriptUpTo(session, q.at) })),
    cards: (session.cards || []).map((c, i) => ({ id: 'c' + i, at: c.at, term: c.term, what: c.what, here: c.here, context: transcriptUpTo(session, c.at) })),
  };
}

const QUESTION_RUBRIC = `You are grading follow-up questions suggested to a salesperson during a live discovery call.
The salesperson is Stanford-educated but not a technical specialist.
Score each question 1 to 5 on each criterion:
- grounded: builds on something specific the prospect actually said in the context
- non_presumptive: does not assume pain, budget, timeline or decisions that weren't stated
- not_redundant: doesn't repeat what was already asked or answered
- advances: moves discovery forward (needs, metrics, decision process, competition, next steps)
Return JSON only: {"scores": [{"id": "...", "grounded": n, "non_presumptive": n, "not_redundant": n, "advances": n}]}`;

const CARD_RUBRIC = `You are grading concept cards shown to a salesperson during a live call.
The salesperson is Stanford-educated: knows business and tech basics, not in-depth technical terms, acronyms or industry news.
For each card, answer worth_showing: true if a rep in this call would benefit from it right then, false if it's trivia, too basic, or wrong.
Return JSON only: {"scores": [{"id": "...", "worth_showing": true}]}`;

async function ask(key, model, rubric, items) {
  const r = await fetch(`${API}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: rubric + '\n\nItems:\n' + JSON.stringify(items, null, 1) }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 4000 },
    }),
  });
  if (!r.ok) throw new Error('Judge request failed: ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const data = await r.json();
  const text = ((data.candidates || [])[0] || {}).content?.parts?.map((p) => p.text || '').join('') || '{}';
  return JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}').scores || [];
}

export async function judgeGemini(session) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('Set GEMINI_API_KEY to use --judge=gemini.');
  const model = await pickJudgeModel(key);
  const items = buildJudgeItems(session);
  const out = { judge: model, question_quality_mean: null, question_quality_pct4: null, card_precision: null };
  if (items.questions.length) {
    const scores = await ask(key, model, QUESTION_RUBRIC, items.questions);
    const per = scores.map((s) => (Number(s.grounded) + Number(s.non_presumptive) + Number(s.not_redundant) + Number(s.advances)) / 4).filter((x) => isFinite(x));
    if (per.length) {
      out.question_quality_mean = Number((per.reduce((a, b) => a + b, 0) / per.length).toFixed(2));
      out.question_quality_pct4 = Number((per.filter((x) => x >= 4).length / per.length).toFixed(3));
    }
  }
  if (items.cards.length) {
    const scores = await ask(key, model, CARD_RUBRIC, items.cards);
    if (scores.length) out.card_precision = Number((scores.filter((s) => s.worth_showing === true).length / scores.length).toFixed(3));
  }
  return out;
}

export function exportJudgeInput(file, sessions) {
  const payload = {
    instructions: { questions: QUESTION_RUBRIC, cards: CARD_RUBRIC },
    fixtures: sessions.map(({ id, session }) => ({ id, ...buildJudgeItems(session) })),
  };
  writeFileSync(file, JSON.stringify(payload, null, 2));
}
