// Eval runner: plays each fixture through the real app (Test with audio file) in headless Chrome,
// exports the session, scores it, and compares with the previous run.
//
//   npm run eval                                   all fixtures, default models
//   npm run eval -- --model=gemini-x-flash         compare a specific Gemini model
//   npm run eval -- --only=sales-01-inference-startup --judge=gemini --headed
//
// Needs: SIGNAL_PASSCODE (and SIGNAL_URL to test something other than the live site).
// Audio plays at 1x: AssemblyAI's live API throttles audio sent faster than about real time.
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { computeMetrics, aggregate } from './metrics.mjs';
import { judgeGemini, exportJudgeInput } from './judge.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v === undefined ? true : v]; }));
const URL_BASE = args.url || process.env.SIGNAL_URL || 'https://signal-three-smoky.vercel.app';
const PASSCODE = process.env.SIGNAL_PASSCODE;
const MODEL = typeof args.model === 'string' ? args.model : '';
const JUDGE = args.judge || 'none';
const fixturesDir = path.join(here, 'fixtures');
const resultsDir = path.join(here, 'results');

if (!PASSCODE) { console.error('Set SIGNAL_PASSCODE to the team passcode.'); process.exit(2); }

const readJson = (f, fb) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : fb);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runFixture(browser, id) {
  const dir = path.join(fixturesDir, id);
  const meta = readJson(path.join(dir, 'meta.json'), { type: 'sales', you: 'first', docs: [] });
  const audio = ['audio.wav', 'audio.mp3', 'audio.m4a'].map((f) => path.join(dir, f)).find(existsSync);
  if (!audio) return { id, skipped: 'no audio file (run npm run make-audio on a Mac, or add audio.mp3)' };

  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const q = new URLSearchParams({ eval: '1' });
  if (MODEL) q.set('model', MODEL);
  if (typeof args.asr === 'string') q.set('asr', args.asr); // testing only: point at a fake transcription server
  await page.goto(`${URL_BASE.replace(/\/$/, '')}/?${q}`);
  await page.evaluate(() => { try { localStorage.clear(); } catch {} });
  await page.reload();
  await page.fill('#passcode', PASSCODE);
  await page.click('#lockForm button');
  await page.waitForSelector('#app:not([hidden])', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll('#meetingType option').length > 0);
  await page.selectOption('#meetingType', meta.type || 'sales');
  await sleep(500);

  if ((meta.docs || []).length) {
    await page.click('#docsBtn');
    for (const d of meta.docs) {
      await page.selectOption('#docTag', d.tag);
      await page.setInputFiles('#docFiles', path.join(dir, d.file));
      await sleep(300);
    }
    await page.click('#prepareBtn');
    await page.waitForFunction(() => /Ready|failed/.test(document.getElementById('prepareMsg').textContent), null, { timeout: 120000 });
    await page.click('#closeDrawer');
  }

  await page.setInputFiles('#testFile', audio);
  await page.waitForFunction(() => window.__signal.S.running, null, { timeout: 20000 });

  // Mark the rep as You: the rep speaks first in every scripted call.
  if (meta.you) {
    try {
      await page.waitForSelector('.turn button.who', { timeout: 30000 });
      await page.click('.turn button.who >> nth=0');
    } catch { /* single-speaker audio or labels not available */ }
  }

  const duration = await page.evaluate(() => document.getElementById('testAudio').duration || 0);
  await page.waitForFunction(() => !window.__signal.S.running, null, { timeout: (duration + 90) * 1000 });
  await page.waitForFunction(() => {
    const r = document.getElementById('recap');
    return document.getElementById('recapWrap').hidden || !/Writing/.test(r.textContent);
  }, null, { timeout: 60000 }).catch(() => {});
  const session = await page.evaluate(() => window.__signal.exportSession());
  await page.close();

  const gold = readJson(path.join(dir, 'transcript.gold.json'), null);
  const moments = readJson(path.join(dir, 'moments.gold.json'), null);
  const metrics = computeMetrics(session, gold, moments);
  if (JUDGE === 'gemini') {
    try { Object.assign(metrics, await judgeGemini(session)); } catch (e) { metrics.judge_error = e.message; }
  }
  metrics.page_errors = errors.length;
  return { id, session, metrics };
}

function previousResult(excludeFile) {
  if (!existsSync(resultsDir)) return null;
  const files = readdirSync(resultsDir).filter((f) => f.endsWith('.json') && !f.includes('judge-input') && path.join(resultsDir, f) !== excludeFile).sort();
  return files.length ? readJson(path.join(resultsDir, files[files.length - 1]), null) : null;
}

function compare(current, previous, thresholds) {
  const rows = [];
  const regressions = [];
  Object.entries(thresholds).forEach(([key, rule]) => {
    const now = current[key];
    const before = previous ? previous[key] : null;
    let status = 'ok';
    if (now != null && before != null) {
      const delta = now - before;
      const worse = rule.higherIsWorse ? delta : -delta;
      if (worse > rule.maxDelta) { status = 'regressed'; regressions.push(key); } else if (worse < -rule.maxDelta) status = 'improved';
    } else status = before == null ? 'new' : 'n/a';
    rows.push({ key, before, now, status });
  });
  return { rows, regressions };
}

async function main() {
  const { chromium } = createRequire(import.meta.url)('playwright');
  const browser = await chromium.launch({ headless: !args.headed, args: ['--autoplay-policy=no-user-gesture-required'] });
  const ids = readdirSync(fixturesDir).filter((d) => !d.startsWith('_') && existsSync(path.join(fixturesDir, d, 'meta.json')) && (!args.only || String(args.only).split(',').includes(d)));
  const results = [];
  for (const id of ids) {
    process.stdout.write(`Running ${id}… `);
    try {
      const r = await runFixture(browser, id);
      results.push(r);
      console.log(r.skipped ? 'skipped: ' + r.skipped : 'done');
    } catch (e) {
      results.push({ id, error: e.message });
      console.log('error: ' + e.message);
    }
  }
  await browser.close();

  const scored = results.filter((r) => r.metrics);
  const agg = aggregate(scored.map((r) => r.metrics));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  mkdirSync(resultsDir, { recursive: true });
  const base = `${stamp}-${MODEL || 'default'}`;
  const file = path.join(resultsDir, base + '.json');
  const sessionsDir = path.join(resultsDir, base);
  mkdirSync(sessionsDir, { recursive: true });
  scored.forEach((r) => writeFileSync(path.join(sessionsDir, r.id + '.session.json'), JSON.stringify(r.session, null, 2)));
  if (JUDGE === 'export') exportJudgeInput(path.join(sessionsDir, 'judge-input.json'), scored);

  const previous = previousResult(file);
  const thresholds = readJson(path.join(here, 'thresholds.json'), {});
  const cmp = compare(agg, previous && previous.aggregate, thresholds);
  const output = {
    timestamp: new Date().toISOString(),
    url: URL_BASE,
    model: MODEL || 'default',
    judge: JUDGE,
    aggregate: agg,
    fixtures: results.map((r) => ({ id: r.id, skipped: r.skipped, error: r.error, metrics: r.metrics })),
    regressions: cmp.regressions,
  };
  writeFileSync(file, JSON.stringify(output, null, 2));

  const fmt = (v) => (v == null ? '–' : typeof v === 'number' ? String(v) : v);
  const md = [
    `# Signal eval ${output.timestamp}`,
    '',
    `Site: ${URL_BASE}. Model: ${output.model}. Judge: ${JUDGE}. Fixtures scored: ${scored.length} of ${results.length}.`,
    previous ? `Compared with: ${previous.timestamp} (model ${previous.model}).` : 'No previous run to compare with.',
    '',
    '| Metric | Before | Now | Status |',
    '|---|---|---|---|',
    ...cmp.rows.map((r) => `| ${r.key} | ${fmt(r.before)} | ${fmt(r.now)} | ${r.status} |`),
    '',
    '## Per fixture',
    '',
    ...results.map((r) => r.metrics
      ? `- **${r.id}**: WER ${fmt(r.metrics.final_wer)}, speakers ${fmt(r.metrics.speaker_accuracy)}, moments ${fmt(r.metrics.moment_coverage)}, questions start p50 ${fmt(r.metrics.q_first_p50_ms)} ms, rate limited ${fmt(r.metrics.rate_limited)}`
      : `- **${r.id}**: ${r.skipped ? 'skipped (' + r.skipped + ')' : 'error: ' + r.error}`),
    '',
    cmp.regressions.length ? `**Regressions:** ${cmp.regressions.join(', ')}` : '**No regressions past thresholds.**',
  ].join('\n');
  writeFileSync(path.join(resultsDir, base + '.md'), md);
  console.log('\n' + md + `\n\nSaved ${path.relative(process.cwd(), file)}`);
  process.exit(cmp.regressions.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
