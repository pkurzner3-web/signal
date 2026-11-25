// Before the call: turns uploaded documents into an Account brief, a Team brief and a glossary (the term map).
import { checkPasscode, json, errorResponse, readBody, loadPrompt, fill, clip, geminiJson } from '../lib/server.js';

export async function POST(request) {
  const denied = checkPasscode(request);
  if (denied) return denied;
  try {
    const body = await readBody(request);
    const docs = Array.isArray(body.docs) ? body.docs : [];
    if (!docs.length) return json({ error: 'Add at least one document first.' }, 400);

    const documents = docs
      .map((d) => `### [${d.tag === 'team' ? 'Team' : 'Account'}] ${String(d.name || 'Untitled').slice(0, 120)}\n${clip(d.text, 60000)}`)
      .join('\n\n');

    const prompt = fill(await loadPrompt('prepare'), {
      meeting_type: clip(body.meetingType || 'Sales discovery', 80),
      skill: clip(body.skill, 4000),
      documents: clip(documents, 200000),
    });

    const { model, data } = await geminiJson({ tier: 'smart', prompt, maxTokens: 8000, temperature: 0.2 });

    const glossary = (Array.isArray(data.glossary) ? data.glossary : [])
      .filter((g) => g && g.term && g.explanation)
      .slice(0, 80)
      .map((g) => ({
        term: String(g.term).slice(0, 60),
        aliases: (Array.isArray(g.aliases) ? g.aliases : []).map(String).slice(0, 6),
        explanation: String(g.explanation).slice(0, 300),
        why: String(g.why_it_matters || g.why || '').slice(0, 200),
      }));

    return json({
      model,
      accountBrief: String(data.account_brief || '').slice(0, 4000),
      teamBrief: String(data.team_brief || '').slice(0, 4000),
      glossary,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
