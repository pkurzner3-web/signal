import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLogic } from './load-logic.mjs';
const L = loadLogic();
const w = (text, sp, t0, step = 300) => text.split(' ').map((x, i) => ({ text: x, speaker: sp, start: t0 + i * step, end: t0 + i * step + 250 }));

test('WER counts substitutions, deletions and insertions', () => {
  assert.equal(L.wer('that has not changed', 'that has not changed').wer, 0);
  assert.equal(L.wer('that has not changed', "that n't changed").errors, 2);
});

test('speaker change mid-sentence does not split the sentence', () => {
  const words = [...w('What does that mean', 'A', 0), ...w('just expand on that.', 'B', 1200), ...w('Sure, so the model found it.', 'B', 3200)];
  const blocks = L.buildBlocks(words);
  assert.equal(blocks[0].text, 'What does that mean just expand on that.');
  assert.equal(blocks[1].speaker, 'B');
});

test('speaker change after a sentence end starts a new block', () => {
  const words = [...w('Can you expand on that?', 'A', 0), ...w('Yes. The incident was in March.', 'B', 1700)];
  const blocks = L.buildBlocks(words);
  assert.equal(blocks.map((b) => b.speaker).join(','), 'A,B');
});

test('a pause over 1.5 s starts a new block for the same speaker', () => {
  const words = [...w('First point here.', 'A', 0), ...w('Second point after a pause.', 'A', 3000)];
  assert.equal(L.buildBlocks(words).length, 2);
});

test('unclear short fragments merge into the next block', () => {
  const words = [{ text: 'So', speaker: 'PENDING', start: 0, end: 200 }, ...w('we moved to Kubernetes last year.', 'B', 2000)];
  const blocks = L.buildBlocks(words);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text.startsWith('So we moved'), true);
});

test('findQuote maps a quote back to the right line and range', () => {
  const lines = [{ id: 'a', text: 'We run 12,000 H100s across three regions.' }, { id: 'b', text: 'Memory bandwidth is the bottleneck for long context.' }];
  const hit = L.findQuote(lines, 'memory bandwidth is the bottleneck');
  assert.equal(hit.id, 'b');
  assert.equal(lines[1].text.slice(hit.start, hit.end), 'Memory bandwidth is the bottleneck');
  assert.equal(L.findQuote(lines, 'completely unrelated words here'), null);
});

test('parseQuestions reads question, why, quote, score and guide marker', () => {
  const out = L.parseQuestions('1. [guide] How do you handle on-call? :: on your guide :: "on-call rotation" :: 5\n2. What broke first? :: they named scale issues :: "it broke at scale" :: 4');
  assert.equal(out[0].guide, true);
  assert.equal(out[0].quote, 'on-call rotation');
  assert.equal(out[1].score, 4);
});

test('top question stays unless a candidate clearly beats it', () => {
  const now = 100000;
  const current = [{ q: 'How do you measure ROI today?', score: 4, shownAt: now - 5000 }];
  const keep = L.chooseQuestions(current, [{ q: 'What tools do you use?', score: 4 }], now);
  assert.equal(keep.topChanged, false);
  const swap = L.chooseQuestions(current, [{ q: 'Who signs off on budget?', score: 5 }], now);
  assert.equal(swap.topChanged, true);
  const pinned = L.chooseQuestions([{ ...current[0], pinned: true }], [{ q: 'Who signs off on budget?', score: 5 }], now);
  assert.equal(pinned.topChanged, false);
});

test('percentile and clock helpers', () => {
  assert.equal(L.percentile([100, 200, 300, 400], 50), 200);
  assert.equal(L.percentile([100, 200, 300, 400], 95), 400);
  assert.equal(L.formatClock(75000), '1:15');
});
