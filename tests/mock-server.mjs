// Fake backend for UI tests: serves the app and answers /api/* with canned responses.
// MOCK_FAIL_FIRST=N makes the first N analyze calls return 429 to test retries.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.md': 'text/markdown', '.txt': 'text/plain' };
let failLeft = Number(process.env.MOCK_FAIL_FIRST || 0);
export const calls = [];
export function start(port = 4322) {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/api/')) {
      let body = ''; for await (const c of req) body += c;
      const b = body ? JSON.parse(body) : {};
      calls.push({ path: u.pathname, mode: b.mode });
      const j = (o, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.headers['x-passcode'] !== 'test123') return j({ error: 'Wrong passcode.' }, 401);
      if (u.pathname === '/api/auth') return j({ ok: true, assemblyai: true, gemini: true, models: { fast: 'gemini-x-flash-lite', smart: 'gemini-x-flash' }, problem: null });
      if (u.pathname === '/api/token') return j({ token: 'test-token' });
      if (u.pathname === '/api/prepare') return j({ model: 'm', otherBrief: 'Acme runs AI clusters.', ourBrief: 'We sell memory.', checklist: ['How do you measure success today?', 'Who approves new vendors?'], glossary: [{ term: 'HBM', aliases: ['high bandwidth memory'], explanation: 'Stacked memory next to the GPU.', why: 'Core to our product.' }] });
      if (u.pathname === '/api/analyze') {
        if (failLeft > 0) { failLeft--; return j({ error: 'Gemini is busy' }, 429); }
        if (b.mode === 'concepts') return setTimeout(() => j({ fallback: false, cards: [{ term: 'CXL', what: 'A link that lets servers share memory.', here: 'They are evaluating it to cut inference cost.', quote: 'evaluating CXL memory pooling' }] }), 200);
        if (b.mode === 'questions') {
          res.writeHead(200, { 'content-type': 'text/plain', 'x-fallback': '1' });
          const t = '1. What would CXL pooling need to prove in a pilot? :: They named CXL pooling; probe criteria :: "evaluating CXL memory pooling" :: 5\n2. How is memory bandwidth limiting you today? :: They called bandwidth the bottleneck :: "memory bandwidth is the bottleneck" :: 4\n3. Who else weighs in on hardware choices? :: No decision maker named yet :: "across three regions" :: 3\n';
          let i = 0; const iv = setInterval(() => { res.write(t.slice(i, i + 20)); i += 20; if (i >= t.length) { clearInterval(iv); res.end(); } }, 40); return;
        }
        if (b.mode === 'coverage') return j({ covered: /measure success/i.test(b.said) ? ['g1'] : /pilot/i.test(b.said) ? b.items.filter((x) => String(x.id).startsWith('q')).slice(0, 1).map((x) => x.id) : [] });
        if (b.mode === 'notes') return j({ summary: 'Acme scales inference.', notes: { 'Pain points': ['Memory bandwidth limits long context'], 'Current tools and competitors': ['Evaluating CXL pooling'] }, signals: [{ type: 'competitor', label: 'CXL pooling', quote: 'evaluating CXL memory pooling' }] });
        if (b.mode === 'recap') return j({ recap: 'Summary\nAcme is scaling inference.\nPain points\n- Memory bandwidth\nOpen questions\n- Decision maker' });
      }
      res.writeHead(404); return res.end('{}');
    }
    try { const p = path.join(root, u.pathname === '/' ? 'index.html' : u.pathname); const d = await readFile(p); res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' }); res.end(d); } catch { res.writeHead(404); res.end(); }
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) start(Number(process.env.PORT || 4322)).then(() => console.log('mock up'));
