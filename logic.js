// Pure helpers shared by the app, the tests and the eval runner. No DOM, no network.
// Loaded in the browser as window.SignalLogic; tests and evals load it the same way in a sandbox.
(function (root) {
  'use strict';

  // ---------- Text ----------
  function tokens(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[’']/g, "'")
      .replace(/[^a-z0-9'%$.\s-]+/g, ' ')
      .replace(/(\w)[.-]+(\s|$)/g, '$1$2')
      .split(/\s+/)
      .map((w) => w.replace(/^[-'.]+|[-'.]+$/g, ''))
      .filter(Boolean);
  }

  // Tokens with character offsets, used to map a quote back onto transcript text.
  function tokensWithOffsets(text) {
    const out = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(text))) {
      const t = tokens(m[0])[0];
      if (t) out.push({ t, start: m.index, end: m.index + m[0].length });
    }
    return out;
  }

  // Word error rate: (substitutions + deletions + insertions) / reference words.
  function wer(reference, hypothesis) {
    const r = Array.isArray(reference) ? reference : tokens(reference);
    const h = Array.isArray(hypothesis) ? hypothesis : tokens(hypothesis);
    if (!r.length) return { wer: h.length ? 1 : 0, errors: h.length, refWords: 0 };
    let prev = new Array(h.length + 1);
    for (let j = 0; j <= h.length; j++) prev[j] = j;
    for (let i = 1; i <= r.length; i++) {
      const cur = new Array(h.length + 1);
      cur[0] = i;
      for (let j = 1; j <= h.length; j++) {
        const cost = r[i - 1] === h[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      prev = cur;
    }
    const errors = prev[h.length];
    return { wer: errors / r.length, errors, refWords: r.length };
  }

  function similarity(a, b) {
    const A = new Set(tokens(a));
    const B = new Set(tokens(b));
    if (!A.size || !B.size) return 0;
    let both = 0;
    A.forEach((x) => { if (B.has(x)) both++; });
    return both / Math.min(A.size, B.size);
  }

  // ---------- Speaker blocks ----------
  // Builds display blocks from final words. Rules:
  // - a pause longer than pauseMs starts a new block
  // - a speaker change only splits at a sentence end or a short pause, so one sentence is never split
  // - fragments under 3 words with an unclear speaker merge into the next block
  const SENTENCE_END = /[.?!]["')\]]*$/;
  function buildBlocks(words, opts) {
    const o = Object.assign({ pauseMs: 1500, switchPauseMs: 400, fallbackSpeaker: null }, opts || {});
    const ws = (words || []).filter((w) => w && w.text);
    const blocks = [];
    let cur = null;
    let prev = null;
    for (const w of ws) {
      const known = w.speaker && w.speaker !== 'PENDING' ? w.speaker : null;
      const gap = prev && w.start != null && prev.end != null ? w.start - prev.end : 0;
      let start = !cur;
      let speaker = cur ? cur.speaker : known || o.fallbackSpeaker;
      if (cur && gap >= o.pauseMs) {
        start = true;
        speaker = known || cur.speaker;
      } else if (cur && known && known !== cur.speaker) {
        const sentenceDone = prev && SENTENCE_END.test(prev.text);
        if (sentenceDone || gap >= o.switchPauseMs || !cur.speaker) {
          start = true;
          speaker = known;
        }
      }
      if (start) {
        cur = { speaker, words: [], start: w.start != null ? w.start : null, end: null, unsure: !known };
        blocks.push(cur);
      } else if (!cur.speaker && known) {
        cur.speaker = known;
      }
      if (known) cur.unsure = false;
      cur.words.push(w.text);
      cur.end = w.end != null ? w.end : cur.end;
      prev = w;
    }
    // Merge unclear fragments forward, and same-speaker neighbours together.
    const merged = [];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const next = blocks[i + 1];
      if (next && b.words.length < 3 && b.unsure) {
        next.words = b.words.concat(next.words);
        next.start = b.start;
        continue;
      }
      const last = merged[merged.length - 1];
      if (last && last.speaker === b.speaker && b.start != null && last.end != null && b.start - last.end < o.pauseMs) {
        last.words = last.words.concat(b.words);
        last.end = b.end;
        continue;
      }
      merged.push(b);
    }
    return merged.map((b) => ({
      speaker: b.speaker || o.fallbackSpeaker,
      text: b.words.join(' '),
      start: b.start,
      end: b.end,
    }));
  }

  // Reuses punctuation and casing from the formatted transcript when it lines up word for word.
  function punctuateWords(words, transcript) {
    const t = String(transcript || '').trim().split(/\s+/).filter(Boolean);
    if (!words || !words.length || t.length !== words.length) return words || [];
    return words.map((w, i) => Object.assign({}, w, { text: t[i] }));
  }

  // ---------- Quotes back to transcript ----------
  // lines: [{ id, text }] newest last. Returns { id, start, end } or null.
  function findQuote(lines, quote) {
    const q = tokens(quote);
    if (!q.length) return null;
    let best = null;
    for (let li = lines.length - 1; li >= 0; li--) {
      const line = lines[li];
      const toks = tokensWithOffsets(line.text || '');
      if (!toks.length) continue;
      const n = Math.min(q.length, toks.length);
      for (let i = 0; i + n <= toks.length; i++) {
        let hit = 0;
        for (let k = 0; k < n; k++) if (toks[i + k].t === q[k] || q.includes(toks[i + k].t)) hit++;
        const score = hit / q.length;
        if (!best || score > best.score + 0.001) {
          best = { id: line.id, start: toks[i].start, end: toks[i + n - 1].end, score };
        }
      }
      if (best && best.score >= 0.95) break;
    }
    return best && best.score >= 0.6 ? { id: best.id, start: best.start, end: best.end } : null;
  }

  // ---------- Model output parsing ----------
  // Line format: 1. [guide] question :: why :: "quote" :: score
  function parseQuestions(text) {
    const out = [];
    String(text || '').split('\n').forEach((line) => {
      const m = line.match(/^\s*(\d)[.)]\s*(.+)$/);
      if (!m) return;
      let body = m[2].trim();
      const guide = /^\[guide\]\s*/i.test(body);
      body = body.replace(/^\[guide\]\s*/i, '');
      const parts = body.split('::').map((p) => p.trim());
      const scoreRaw = parts.length >= 4 ? parts[3] : '';
      const score = Number((scoreRaw.match(/[1-5]/) || [])[0]) || 3;
      out.push({
        q: parts[0] || '',
        why: parts[1] || '',
        quote: (parts[2] || '').replace(/^["“]|["”]$/g, ''),
        score,
        guide,
      });
    });
    return out.filter((x) => x.q).slice(0, 3);
  }

  // Keeps the top question stable: replace it only when a candidate clearly beats it.
  function chooseQuestions(current, candidates, nowMs, opts) {
    const o = Object.assign({ margin: 1, maxAgeMs: 45000 }, opts || {});
    const top = current && current[0];
    const ranked = candidates.slice().sort((a, b) => b.score - a.score);
    let keepTop = false;
    if (top && !top.asked && !top.dismissed) {
      if (top.pinned) keepTop = true;
      else if (!ranked.length) keepTop = true;
      else if (ranked[0].score < top.score + o.margin && nowMs - (top.shownAt || 0) < o.maxAgeMs) keepTop = true;
    }
    const next = [];
    if (keepTop) next.push(top);
    const pinned = (current || []).filter((x) => x.pinned && x !== top && !x.asked && !x.dismissed);
    pinned.forEach((x) => next.push(x));
    for (const c of ranked) {
      if (next.length >= 3) break;
      if (next.some((x) => similarity(x.q, c.q) > 0.7)) continue;
      next.push(c);
    }
    return { list: next.slice(0, 3), topChanged: !top || next[0] !== top };
  }

  // ---------- Stats ----------
  function percentile(values, p) {
    const v = (values || []).filter((x) => typeof x === 'number' && isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const idx = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
    return v[idx];
  }

  function backoffDelays(base, steps, jitter) {
    const out = [];
    for (let i = 0; i < steps; i++) {
      const d = base * Math.pow(2, i);
      out.push(Math.round(d * (1 - jitter + Math.random() * 2 * jitter)));
    }
    return out;
  }

  function formatClock(ms) {
    if (ms == null || ms < 0) return '0:00';
    const s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  root.SignalLogic = { tokens, tokensWithOffsets, wer, similarity, buildBlocks, punctuateWords, findQuote, parseQuestions, chooseQuestions, percentile, backoffDelays, formatClock };
})(typeof window !== 'undefined' ? window : globalThis);
