// During the call: concept cards, follow-up questions and the running summary.
import { checkPasscode, json, errorResponse, readBody, loadPrompt, fill, clip, geminiJson, geminiText, geminiStream } from '../lib/server.js';

export async function POST(request) {
  const denied = checkPasscode(request);
  if (denied) return denied;
  try {
    const b = await readBody(request);
    const common = {
      meeting_type: clip(b.meetingType || 'Sales discovery', 80),
      skill: clip(b.skill, 3000),
    };

    if (b.mode === 'concepts') {
      const prompt = fill(await loadPrompt('concepts'), {
        ...common,
        context: clip(b.context, b.contextMode === 'full' ? 60000 : 4000),
        latest: clip(b.latest, 2000),
        known: clip((Array.isArray(b.known) ? b.known : []).join(', '), 4000),
      });
      const { model, data } = await geminiJson({ tier: 'fast', prompt, maxTokens: 400, temperature: 0.2 });
      const cards = (Array.isArray(data.cards) ? data.cards : [])
        .filter((c) => c && c.term && c.explanation)
        .slice(0, 2)
        .map((c) => ({ term: String(c.term).slice(0, 60), explanation: String(c.explanation).slice(0, 300), why: String(c.why || '').slice(0, 200) }));
      return json({ model, cards });
    }

    if (b.mode === 'questions') {
      const prompt = fill(await loadPrompt('questions'), {
        ...common,
        account_brief: clip(b.accountBrief, 4000),
        team_brief: clip(b.teamBrief, 4000),
        summary: clip(b.summary, 2000),
        recent: clip(b.recent, b.contextMode === 'full' ? 60000 : 6000),
        asked: clip((Array.isArray(b.asked) ? b.asked : []).join('\n'), 2000),
      });
      return await geminiStream({ tier: b.quality === 'smart' ? 'smart' : 'fast', prompt, maxTokens: 400, temperature: 0.5, signal: request.signal });
    }

    if (b.mode === 'summary') {
      const prompt = fill(await loadPrompt('summary'), {
        ...common,
        previous: clip(b.previous, 2000),
        transcript: clip(b.transcript, 12000),
      });
      const { model, text } = await geminiText({ tier: 'fast', prompt, maxTokens: 300, temperature: 0.2 });
      return json({ model, summary: text.trim() });
    }

    return json({ error: 'Unknown mode.' }, 400);
  } catch (e) {
    return errorResponse(e);
  }
}
