// During the call: concept cards, follow-up questions, guide coverage, call notes and the post-call recap.
import { checkPasscode, json, errorResponse, readBody, loadPrompt, fill, clip, geminiJson, geminiText, geminiStream } from '../lib/server.js';

const str = (v, max) => String(v == null ? '' : v).slice(0, max);
const list = (v) => (Array.isArray(v) ? v : []);

export async function POST(request) {
  const denied = checkPasscode(request);
  if (denied) return denied;
  try {
    const b = await readBody(request);
    const prefer = typeof b.model === 'string' ? b.model.slice(0, 80) : undefined;
    const common = {
      meeting_type: clip(b.meetingType || 'Sales discovery', 80),
      skill: clip(b.skill, 5000),
      other_label: clip(b.otherLabel || 'Other side', 40),
      other_brief: clip(b.otherBrief, 3000),
    };

    if (b.mode === 'concepts') {
      const prompt = fill(await loadPrompt('concepts'), {
        ...common,
        context: clip(b.context, b.contextMode === 'full' ? 60000 : 4000),
        latest: clip(b.latest, 2000),
        known: clip(list(b.known).join(', '), 4000),
      });
      const { model, fallback, data } = await geminiJson({ tier: 'fast', prompt, maxTokens: 500, temperature: 0.2, prefer });
      const cards = list(data.cards)
        .filter((c) => c && c.term && (c.what || c.explanation) && Number(c.relevance || 4) >= 4)
        .slice(0, 2)
        .map((c) => ({
          term: str(c.term, 60),
          what: str(c.what || c.explanation, 240),
          here: str(c.here, 240),
          quote: str(c.quote, 200),
          relevance: Number(c.relevance) || 4,
        }));
      return json({ model, fallback, cards });
    }

    if (b.mode === 'questions') {
      const prompt = fill(await loadPrompt('questions'), {
        ...common,
        our_brief: clip(b.ourBrief, 3000),
        summary: clip(b.summary, 2500),
        recent: clip(b.recent, b.contextMode === 'full' ? 60000 : 5000),
        asked: clip(list(b.asked).join('\n'), 3000) || '(none)',
        guide: list(b.guide).length ? list(b.guide).slice(0, 25).map((q) => '- ' + clip(q, 240)).join('\n') : '(none)',
      });
      return await geminiStream({ tier: b.quality === 'smart' ? 'smart' : 'fast', prompt, maxTokens: 500, temperature: 0.4, signal: request.signal, prefer });
    }

    if (b.mode === 'coverage') {
      const items = list(b.items).slice(0, 30);
      if (!items.length) return json({ covered: [] });
      const prompt = fill(await loadPrompt('coverage'), {
        ...common,
        items: items.map((it) => `${it.id}: ${clip(it.q, 240)}`).join('\n'),
        said: clip(b.said, 3000),
      });
      const { model, fallback, data } = await geminiJson({ tier: 'fast', prompt, maxTokens: 150, temperature: 0, prefer });
      const ids = new Set(items.map((it) => String(it.id)));
      const covered = list(data.covered).map(String).filter((id) => ids.has(id));
      return json({ model, fallback, covered });
    }

    if (b.mode === 'notes' || b.mode === 'summary') {
      const cats = list(b.categories).slice(0, 8).map((c) => str(c, 40));
      const prompt = fill(await loadPrompt('summary'), {
        ...common,
        note_keys: cats.map((c) => JSON.stringify(c) + ': []').join(', '),
        previous: clip(b.previous, 1500),
        previous_notes: clip(JSON.stringify(b.previousNotes || {}), 3000),
        transcript: clip(b.transcript, 12000),
      });
      const { model, fallback, data } = await geminiJson({ tier: 'fast', prompt, maxTokens: 900, temperature: 0.2, prefer });
      const notes = {};
      cats.forEach((c) => { notes[c] = list(data.notes && data.notes[c]).map((x) => str(x, 160)).filter(Boolean).slice(0, 8); });
      const signals = list(data.signals)
        .filter((x) => x && (x.type === 'objection' || x.type === 'competitor') && x.quote)
        .slice(0, 6)
        .map((x) => ({ type: x.type, label: str(x.label, 60), quote: str(x.quote, 200) }));
      return json({ model, fallback, summary: str(data.summary, 1200), notes, signals });
    }

    if (b.mode === 'recap') {
      const cats = list(b.categories).slice(0, 8).map((c) => str(c, 40));
      const prompt = fill(await loadPrompt('recap'), {
        ...common,
        note_headings: cats.join(', '),
        notes: clip(JSON.stringify(b.notes || {}), 4000),
        transcript: clip(b.transcript, 40000),
      });
      const { model, fallback, text } = await geminiText({ tier: 'smart', prompt, maxTokens: 700, temperature: 0.2, prefer });
      return json({ model, fallback, recap: text.trim() });
    }

    return json({ error: 'Unknown mode.' }, 400);
  } catch (e) {
    return errorResponse(e);
  }
}
