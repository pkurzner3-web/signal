// Shared server helpers for the /api functions.
// Keys live only in Vercel environment variables, never in this code.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export function errorResponse(err) {
  const status = err && err.status ? err.status : 500;
  return json({ error: (err && err.message) || 'Something went wrong.' }, status);
}

// Every API call must send the team passcode in the x-passcode header.
// Removes invisible characters that sneak in when keys are copied from apps like Notes.
export function cleanKey(value) {
  return String(value || '').replace(/[^\x21-\x7E]/g, '');
}

export function checkPasscode(request) {
  const expected = cleanKey(process.env.APP_PASSCODE);
  if (!expected) return json({ error: 'APP_PASSCODE is not set in Vercel.' }, 500);
  const got = cleanKey(request.headers.get('x-passcode'));
  if (got !== expected) return json({ error: 'Wrong passcode.' }, 401);
  return null;
}

export async function readBody(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'Request body must be JSON.');
  }
}

// Prompts are plain text files in /prompts so the team can edit them without touching code.
const promptCache = new Map();
export async function loadPrompt(name) {
  if (promptCache.has(name)) return promptCache.get(name);
  const file = path.join(process.cwd(), 'prompts', name + '.txt');
  const text = await readFile(file, 'utf8');
  promptCache.set(name, text);
  return text;
}

export function fill(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
}

export function clip(text, max) {
  const s = String(text || '');
  return s.length > max ? s.slice(0, max) + '\n[...cut for length]' : s;
}

// ---------- Gemini ----------

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
let modelCache = null;
const cooldown = new Map(); // model -> time until which it is skipped
const variantCache = new Map(); // model -> index of the thinking setting that works

function geminiKey() {
  const key = cleanKey(process.env.GEMINI_API_KEY);
  if (!key) throw new HttpError(500, 'GEMINI_API_KEY is not set in Vercel.');
  return key;
}

function versionOf(name) {
  const m = name.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

// Picks the newest "flash-lite" (fast) and "flash" (smart) models this key can use,
// unless GEMINI_FAST_MODEL / GEMINI_SMART_MODEL are set in Vercel.
export async function pickModels() {
  if (modelCache) return modelCache;
  const key = geminiKey();
  const r = await fetch(`${GEMINI}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key } });
  if (!r.ok) {
    const t = await r.text();
    throw new HttpError(r.status === 400 || r.status === 403 ? 401 : r.status, 'Gemini rejected the key: ' + shortError(t));
  }
  const data = await r.json();
  const names = (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''));
  const skip = /(image|tts|audio|live|embed|vision|learnlm|robotics|computer|native|nano|thinking)/i;
  const usable = names.filter((n) => /gemini/i.test(n) && !skip.test(n));
  const order = (a, b) =>
    versionOf(b) - versionOf(a) ||
    Number(a.includes('preview')) - Number(b.includes('preview')) ||
    a.length - b.length;
  const lite = usable.filter((n) => /flash-lite/i.test(n)).sort(order);
  const flash = usable.filter((n) => /flash/i.test(n) && !/lite/i.test(n)).sort(order);
  const uniq = (list) => [...new Set(list.filter(Boolean))];
  modelCache = {
    fast: uniq([process.env.GEMINI_FAST_MODEL, ...lite, ...flash]),
    smart: uniq([process.env.GEMINI_SMART_MODEL, ...flash, ...lite]),
  };
  if (!modelCache.fast.length) throw new HttpError(500, 'No usable Gemini flash models found for this key.');
  return modelCache;
}

function promote(tier, model) {
  if (!modelCache) return;
  const list = modelCache[tier];
  const i = list.indexOf(model);
  if (i > 0) {
    list.splice(i, 1);
    list.unshift(model);
  }
}

function shortError(text) {
  try {
    const j = JSON.parse(text);
    const e = Array.isArray(j) ? j[0].error : j.error;
    return (e && e.message ? e.message : text).slice(0, 300);
  } catch {
    return String(text).slice(0, 300);
  }
}

// Calls Gemini. tier: 'fast' or 'smart'. Tries the next model if one isn't available on the free tier.
export async function gemini({ tier, prompt, json: wantJson = false, maxTokens = 800, temperature = 0.4, stream = false, signal }) {
  const key = geminiKey();
  const models = await pickModels();
  let lastErr = null;
  const nowMs = Date.now();
  const ready = models[tier].filter((m) => !(cooldown.get(m) > nowMs));
  const order = (ready.length ? ready : models[tier]).slice(0, 4);
  for (const model of order) {
    // Thinking settings differ by Gemini version; try them in order and remember what works per model.
    const variants = [
      { thinking: { thinkingBudget: 0 }, json: wantJson },
      { thinking: { thinkingLevel: 'minimal' }, json: wantJson },
      { thinking: { thinkingLevel: 'low' }, json: wantJson },
      { thinking: null, json: wantJson },
      { thinking: null, json: false },
    ];
    let v = variantCache.has(model) ? variantCache.get(model) : 0;
    let moveOn = false;
    for (; v < variants.length; v++) {
      const { thinking, json: asJson } = variants[v];
      const body = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature, maxOutputTokens: maxTokens },
      };
      if (asJson) body.generationConfig.responseMimeType = 'application/json';
      if (thinking) body.generationConfig.thinkingConfig = thinking;
      const url = `${GEMINI}/models/${model}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal,
      });
      if (r.ok) {
        variantCache.set(model, v);
        promote(tier, model);
        return { model, response: r };
      }
      const text = await r.text();
      lastErr = new HttpError(r.status === 429 ? 429 : 502, `Gemini (${model}): ${shortError(text)}`);
      if (r.status === 400 && !/not (found|supported)/i.test(text) && v < variants.length - 1) continue; // try the next setting
      const busy = r.status >= 500 || r.status === 429 || /high demand|overloaded|unavailable|try again later/i.test(text);
      if (busy) cooldown.set(model, Date.now() + 60000); // skip a busy model for a minute
      moveOn =
        busy ||
        r.status === 400 ||
        r.status === 404 ||
        (r.status === 403 && /model|permission/i.test(text));
      break;
    }
    if (!moveOn && lastErr) throw lastErr;
  }
  throw lastErr || new HttpError(500, 'No Gemini model was available.');
}

export function textFromCandidate(data) {
  const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  return parts.filter((p) => !p.thought).map((p) => p.text || '').join('');
}

export async function geminiText(opts) {
  const { model, response } = await gemini({ ...opts, stream: false });
  const data = await response.json();
  return { model, text: textFromCandidate(data) };
}

export async function geminiJson(opts) {
  const { model, text } = await geminiText({ ...opts, json: true });
  try {
    return { model, data: JSON.parse(text) };
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return { model, data: JSON.parse(m[0]) };
      } catch {}
    }
    throw new HttpError(502, 'Gemini returned something that was not valid JSON.');
  }
}

// Streams Gemini text back to the browser as plain text chunks.
export async function geminiStream(opts) {
  const { model, response } = await gemini({ ...opts, stream: true });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  const out = new ReadableStream({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const piece = textFromCandidate(JSON.parse(payload));
          if (piece) controller.enqueue(encoder.encode(piece));
        } catch {}
      }
    },
    cancel() {
      reader.cancel();
    },
  });
  return new Response(out, {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-model': model },
  });
}
