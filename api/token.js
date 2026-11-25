// Gives the browser a short-lived AssemblyAI token, so the real key never leaves the server.
import { checkPasscode, json, errorResponse, HttpError } from '../lib/server.js';

export async function POST(request) {
  const denied = checkPasscode(request);
  if (denied) return denied;
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) return json({ error: 'ASSEMBLYAI_API_KEY is not set in Vercel.' }, 500);

  try {
    // Current token endpoint.
    let r = await fetch('https://token.assemblyai.com/v1/token', {
      method: 'POST',
      headers: { authorization: key, 'content-type': 'application/json' },
      body: JSON.stringify({ product: 'streaming', expires_in_seconds: 60, max_session_duration_seconds: 10800 }),
    });
    // Older endpoint, used only if the first one isn't available.
    if (r.status === 404 || r.status === 405) {
      r = await fetch('https://streaming.assemblyai.com/v3/token?expires_in_seconds=60', {
        headers: { authorization: key },
      });
    }
    const text = await r.text();
    if (!r.ok) {
      const msg = r.status === 401 ? 'AssemblyAI rejected the key. Check ASSEMBLYAI_API_KEY in Vercel.' : 'AssemblyAI token error: ' + text.slice(0, 200);
      throw new HttpError(r.status === 401 ? 401 : 502, msg);
    }
    const data = JSON.parse(text);
    if (!data.token) throw new HttpError(502, 'AssemblyAI did not return a token.');
    return json({ token: data.token });
  } catch (e) {
    return errorResponse(e);
  }
}
