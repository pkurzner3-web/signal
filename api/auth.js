// Checks the passcode and reports which keys are set up, so setup problems are easy to spot.
import { checkPasscode, json, pickModels } from '../lib/server.js';

export async function POST(request) {
  const denied = checkPasscode(request);
  if (denied) return denied;

  const status = {
    ok: true,
    assemblyai: Boolean(process.env.ASSEMBLYAI_API_KEY),
    gemini: Boolean(process.env.GEMINI_API_KEY),
    models: null,
    problem: null,
  };
  if (!status.assemblyai) status.problem = 'ASSEMBLYAI_API_KEY is not set in Vercel.';
  if (status.gemini) {
    try {
      const m = await pickModels();
      status.models = { fast: m.fast[0], smart: m.smart[0] };
    } catch (e) {
      status.problem = e.message;
    }
  } else {
    status.problem = 'GEMINI_API_KEY is not set in Vercel.';
  }
  return json(status);
}
