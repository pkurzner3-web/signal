// Builds fixture audio from script.json using the Mac's built-in `say` voices (free, offline).
// Writes audio.wav, transcript.gold.json and moments.gold.json in each fixture folder.
// Usage (on a Mac): npm run make-audio            (all fixtures with a script.json)
//                   npm run make-audio -- sales-01-inference-startup
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');
const RATE = 16000;
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));

if (process.platform !== 'darwin') {
  console.error('make-audio uses the macOS `say` command. Run it on a Mac, then commit the generated audio.wav files.');
  process.exit(1);
}

function pcmFromWav(file) {
  const buf = readFileSync(file);
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return buf.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  throw new Error('No audio data in ' + file);
}

function wavFile(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const silence = (ms) => Buffer.alloc(Math.round((RATE * ms) / 1000) * 2);
const msOf = (bytes) => Math.round((bytes / 2 / RATE) * 1000);

const dirs = readdirSync(fixturesDir).filter((d) => !d.startsWith('_') && existsSync(path.join(fixturesDir, d, 'script.json')) && (!only.length || only.includes(d)));
for (const id of dirs) {
  const dir = path.join(fixturesDir, id);
  const script = JSON.parse(readFileSync(path.join(dir, 'script.json'), 'utf8'));
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'signal-'));
  const parts = [silence(800)];
  let cursor = 800;
  const gold = [];
  const moments = [];
  script.turns.forEach((turn, i) => {
    const voice = (script.voices || {})[turn.speaker] || 'Samantha';
    const out = path.join(tmp, `t${i}.wav`);
    execFileSync('say', ['-v', voice, '-o', out, '--file-format=WAVE', `--data-format=LEI16@${RATE}`, turn.text]);
    const pcm = pcmFromWav(out);
    const start = cursor;
    const end = start + msOf(pcm.length);
    gold.push({ speaker: turn.speaker, text: turn.text, start, end });
    (turn.moments || []).forEach((m, k) => moments.push({ id: `${id}-m${i}-${k}`, type: m.type, keywords: m.keywords, time: start, turn: i }));
    parts.push(pcm);
    const gap = i % 3 === 2 ? 250 : 700; // every third handoff is quick, to test fast back-and-forth
    parts.push(silence(gap));
    cursor = end + gap;
  });
  parts.push(silence(1500));
  writeFileSync(path.join(dir, 'audio.wav'), wavFile(Buffer.concat(parts)));
  writeFileSync(path.join(dir, 'transcript.gold.json'), JSON.stringify(gold, null, 2));
  writeFileSync(path.join(dir, 'moments.gold.json'), JSON.stringify(moments, null, 2));
  rmSync(tmp, { recursive: true, force: true });
  console.log(`${id}: ${(cursor / 1000).toFixed(0)} s, ${gold.length} turns, ${moments.length} moments`);
}
if (!dirs.length) console.log('No fixtures with script.json found.');
