// Turns an exported Signal session plus gold files into metrics.
import { loadLogic } from '../tests/load-logic.mjs';
const L = loadLogic();

const median = (v) => L.percentile(v, 50);
const round = (x, d = 3) => (x == null || !isFinite(x) ? null : Number(x.toFixed(d)));

// Final-text WER against the gold transcript.
export function finalWer(session, gold) {
  if (!gold || !gold.length) return null;
  const hyp = session.transcript.slice().sort((a, b) => (a.audioStartMs ?? a.t ?? 0) - (b.audioStartMs ?? b.t ?? 0)).map((x) => x.text).join(' ');
  return round(L.wer(gold.map((g) => g.text).join(' '), hyp).wer);
}

// Interim WER: how wrong the live text was compared with the final text of the same turn.
export function interimWer(session) {
  const scores = (session.partials || []).map((p) => {
    const interim = L.tokens(p.interim);
    const ref = L.tokens(p.final).slice(0, interim.length);
    return interim.length ? L.wer(ref, interim).wer : null;
  }).filter((x) => x != null);
  return scores.length ? round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
}

// Speaker-turn accuracy: share of gold turns whose majority app speaker maps to the right gold speaker.
export function speakerAccuracy(session, gold) {
  if (!gold || !gold.length) return null;
  const off = (session.meta && session.meta.audioOffsetMs) || 0;
  const rows = session.transcript.filter((x) => x.audioStartMs != null).map((x) => Object.assign({}, x, { audioStartMs: x.audioStartMs + off }));
  if (!rows.length) return null;
  const turnLetter = gold.map((g) => {
    const counts = {};
    rows.filter((r) => r.audioStartMs >= g.start - 600 && r.audioStartMs <= g.end + 300).forEach((r) => {
      const k = r.letter || r.speaker;
      counts[k] = (counts[k] || 0) + L.tokens(r.text).length;
    });
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return best ? best[0] : null;
  });
  const co = {};
  gold.forEach((g, i) => { const l = turnLetter[i]; if (!l) return; co[l] = co[l] || {}; co[l][g.speaker] = (co[l][g.speaker] || 0) + 1; });
  const map = {};
  Object.entries(co).forEach(([l, c]) => { map[l] = Object.entries(c).sort((a, b) => b[1] - a[1])[0][0]; });
  const scored = gold.map((g, i) => turnLetter[i] && map[turnLetter[i]] === g.speaker).filter((x, i) => turnLetter[i]);
  const distinct = new Set(Object.values(map)).size;
  // If every turn got the same app label, the mapping is trivially "right" for one speaker only.
  const acc = scored.filter(Boolean).length / Math.max(1, scored.length);
  return round(distinct < new Set(gold.map((g) => g.speaker)).size ? Math.min(acc, 0.5) : acc);
}

// Moment coverage: was a relevant question or card shown within 15 s of each gold moment?
export function momentCoverage(session, moments, windowMs = 15000, offsetMs = 0) {
  if (!moments || !moments.length) return { coverage: null, medianSeconds: null, detail: [] };
  const shown = []
    .concat((session.questionsShown || []).map((q) => ({ at: q.at, text: [q.q, q.why].join(' ') })))
    .concat((session.cards || []).map((c) => ({ at: c.at, text: [c.term, c.what, c.here].join(' ') })));
  const detail = moments.map((m) => {
    const t0 = m.time - offsetMs; // app times count from when streaming began, offsetMs into the file
    const hit = shown
      .filter((s) => s.at >= t0 && s.at <= t0 + windowMs)
      .filter((s) => m.keywords.some((k) => s.text.toLowerCase().includes(k.toLowerCase())))
      .sort((a, b) => a.at - b.at)[0];
    return { id: m.id, type: m.type, covered: Boolean(hit), seconds: hit ? round((hit.at - t0) / 1000, 1) : null };
  });
  const covered = detail.filter((d) => d.covered);
  return { coverage: round(covered.length / detail.length), medianSeconds: median(covered.map((d) => d.seconds)), detail };
}

export function churnPerMinute(session) {
  const minutes = (session.meta.durationMs || 0) / 60000;
  return minutes > 0 ? round((session.topQuestionChanges || []).length / minutes, 2) : null;
}

export function latency(session) {
  const out = {};
  const rows = (session.latency && session.latency.run) || [];
  ['words', 'transcript', 'card_docs', 'card_ai', 'q_first', 'q_done'].forEach((m) => {
    const v = rows.filter((r) => r.metric === m).map((r) => r.ms);
    out[m + '_p50_ms'] = L.percentile(v, 50);
    out[m + '_p95_ms'] = L.percentile(v, 95);
  });
  return out;
}

export function reliability(session) {
  const s = session.stats || {};
  return {
    requests: s.requests || 0,
    errors: s.errors || 0,
    rate_limited: s.s429 || 0,
    backup_model: s.fallbacks || 0,
    error_rate: s.requests ? round((s.errors || 0) / s.requests) : 0,
  };
}

export function computeMetrics(session, gold, moments, offsetMs) {
  const cov = momentCoverage(session, moments, 15000, offsetMs != null ? offsetMs : (session.meta && session.meta.audioOffsetMs) || 0);
  return Object.assign(
    {
      final_wer: finalWer(session, gold),
      interim_wer: interimWer(session),
      speaker_accuracy: speakerAccuracy(session, gold),
      moment_coverage: cov.coverage,
      time_to_card_median_s: cov.medianSeconds,
      churn_per_min: churnPerMinute(session),
      questions_shown: (session.questionsShown || []).length,
      cards_shown: (session.cards || []).length,
    },
    latency(session),
    reliability(session),
    { _moments: cov.detail },
  );
}

// Averages numeric metrics across fixtures (ignores nulls).
export function aggregate(list) {
  const keys = new Set();
  list.forEach((m) => Object.keys(m).forEach((k) => { if (!k.startsWith('_') && typeof m[k] === 'number') keys.add(k); }));
  const out = {};
  keys.forEach((k) => {
    const v = list.map((m) => m[k]).filter((x) => typeof x === 'number' && isFinite(x));
    out[k] = v.length ? round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  });
  return out;
}

export { L };
