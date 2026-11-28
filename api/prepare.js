// Before the call: turns uploaded documents into an Account brief, a Team brief and a glossary (the term map).
import { checkPasscode, json, errorResponse, readBody, loadPrompt, fill, clip, geminiJson } from '../lib/server.js';

export async function POST(request) {
  const denied = checkPasscode(request);
  if (denied) return denied;
  try {
    const body = await readBody(request);
    const docs = Array.isArray(body.docs) ? body.docs : [];
    if (!docs.length) return json({ error: 'Add at least one document first.' }, 400);

    const tags = Array.isArray(body.docTags) ? body.docTags : [];
    const tagOf = (id) => tags.find((t) => t.id === id) || { label: id || 'Document', side: 'other' };
    const otherTags = tags.filter((t) => t.side === 'other').map((t) => `[${t.label}]`).join(', ') || '[Account]';
    const ourTags = tags.filter((t) => t.side === 'ours').map((t) => `[${t.label}]`).join(', ') || '[Team]';

    const documents = docs
      .map((d) => `### [${tagOf(d.tag).label}] ${String(d.name || 'Untitled').slice(0, 120)}\n${clip(d.text, 60000)}`)
      .join('\n\n');

    const prompt = fill(await loadPrompt('prepare'), {
      meeting_type: clip(body.meetingType || 'Sales discovery', 80),
      other_label: clip(body.otherLabel || 'the other side', 40),
      other_tags: otherTags,
      our_tags: ourTags,
      skill: clip(body.skill, 6000),
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
    const checklist = (Array.isArray(data.checklist) ? data.checklist : [])
      .map((q) => String(q || '').trim())
      .filter(Boolean)
      .slice(0, 25)
      .map((q) => q.slice(0, 240));

    return json({
      model,
      otherBrief: String(data.other_brief || '').slice(0, 4000),
      ourBrief: String(data.our_brief || '').slice(0, 4000),
      checklist,
      glossary,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
