// Browser test against the mock backend. Run: npm run test:ui (needs Playwright's Chromium).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
process.env.MOCK_FAIL_FIRST = '2';
const { start, calls } = await import('./mock-server.mjs');
const { chromium } = createRequire(import.meta.url)('playwright');

test('live session flow: interim text, speakers, retries, questions, tracing, guide, notes, recap', async () => {
  const server = await start(4399);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto('http://localhost:4399/');
    await page.fill('#passcode', 'test123');
    await page.click('#lockForm button');
    await page.waitForSelector('#app:not([hidden])');
    await page.waitForTimeout(300);
    assert.equal(await page.$eval('#debugBar', (e) => e.hidden), true, 'debug info is hidden by default');

    // Prepare docs so the docs path and guide questions are exercised
    await page.click('#docsBtn');
    await page.setInputFiles('#docFiles', { name: 'one-pager.txt', mimeType: 'text/plain', buffer: Buffer.from('Fictional product one-pager about HBM.') });
    await page.click('#prepareBtn');
    await page.waitForFunction(() => /Ready/.test(document.getElementById('prepareMsg').textContent));
    await page.click('#closeDrawer');

    await page.evaluate(() => {
      const s = window.__signal;
      s.S.running = true; s.S.mode = 'test';
      s.S.sources.file = { startWall: Date.now() - 20000 }; s.S.callStart = Date.now() - 20000;
      const words = (text, sp, t0) => text.split(' ').map((x, i) => ({ text: x, speaker: sp, start: t0 + i * 300, end: t0 + i * 300 + 250, word_is_final: true }));
      // Interim with unstable word list: displayed text must come from the transcript string
      s.onTurn('file', { turn_order: 1, transcript: 'We run about 12,000 H100s', end_of_turn: false, words: [{ text: 'We', start: 0, end: 200 }, { text: "n't", start: 300, end: 500 }] });
    });
    assert.equal(await page.$eval('.turn-group.interim .text', (e) => e.textContent), 'We run about 12,000 H100s');

    await page.evaluate(() => {
      const s = window.__signal;
      const words = (text, sp, t0) => text.split(' ').map((x, i) => ({ text: x, speaker: sp, start: t0 + i * 300, end: t0 + i * 300 + 250 }));
      const a = 'Can you tell me how your fleet is set up today?';
      const b = 'Sure. We run about 12,000 H100s and memory bandwidth is the bottleneck. We are evaluating CXL memory pooling next year.';
      s.onTurn('file', { turn_order: 1, transcript: a + ' ' + b, end_of_turn: true, words: [...words(a, 'A', 0), ...words(b, 'B', 3600)] });
    });
    const labels = await page.$$eval('.turn .who', (els) => els.map((e) => e.textContent));
    assert.deepEqual(labels.slice(0, 2), ['Speaker 1', 'Speaker 2']);
    await page.click('.turn .who >> nth=0');
    assert.equal(await page.$eval('.turn .who', (e) => e.textContent), 'You');

    // Questions arrive despite two forced 429s
    await page.waitForFunction(() => document.querySelectorAll('#questions .q').length === 3 && !document.getElementById('questions').classList.contains('streaming') && !document.getElementById('qState').textContent, null, { timeout: 15000 });
    const retried = await page.evaluate(() => window.__signal.S.stats.retries);
    assert.ok(retried >= 2, 'retried after 429');
    assert.equal(await page.$eval('#status', (e) => e.textContent), 'Using backup model');

    // Trace a question back to the transcript
    await page.click('#questions .q .qtext >> nth=0');
    assert.match(await page.$eval('mark', (e) => e.textContent), /evaluating CXL memory pooling/i);

    // Concept card from the call, tagged by source
    await page.waitForSelector('.card .src');
    const tags = await page.$$eval('.card .src', (els) => els.map((e) => e.textContent));
    assert.ok(tags.includes('From call') || tags.includes('From docs'));

    // You ask a guide question and the first suggested question
    await page.evaluate(() => {
      const s = window.__signal;
      s.onTurn('file', { turn_order: 2, transcript: 'How do you measure success today? And what would a pilot need to prove?', end_of_turn: true, words: 'How do you measure success today? And what would a pilot need to prove?'.split(' ').map((x, i) => ({ text: x, speaker: 'A', start: 20000 + i * 300, end: 20000 + i * 300 + 250 })) });
    });
    await page.waitForFunction(() => /1 of 2/.test(document.getElementById('guideCount').textContent), null, { timeout: 8000 });

    // Stop: notes and recap
    await page.evaluate(() => { window.__signal.S.notesAt = 0; });
    await page.evaluate(() => document.getElementById('stopBtn').hidden = false);
    await page.click('#stopBtn');
    await page.waitForFunction(() => !document.getElementById('recapWrap').hidden && /Summary/.test(document.getElementById('recap').textContent), null, { timeout: 10000 });
    assert.ok(await page.$('.badge'), 'competitor badge shown in transcript');

    // Export contains the essentials
    const exp = await page.evaluate(() => window.__signal.exportSession());
    assert.ok(exp.transcript.length >= 3 && exp.questionsShown.length >= 3 && exp.recap);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});
