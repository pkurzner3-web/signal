// Loads logic.js the same way the browser does, inside a sandbox.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
export function loadLogic() {
  const ctx = { window: {} };
  vm.runInNewContext(readFileSync(path.join(here, '..', 'logic.js'), 'utf8'), ctx);
  return ctx.window.SignalLogic;
}
