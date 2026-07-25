// Copies the hand-authored marketing page into the Workers Assets directory.
//
// The source file at the repo root is a 3 MB bundled export and is treated as
// read-only -- the Worker injects /site-hook.js into it at request time rather
// than the file being edited. public/index.html is generated and gitignored.
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'Coyote Ridge Airsoft.html');
const dest = resolve(root, 'public/index.html');

try {
  await stat(src);
} catch {
  console.error(`sync-site: missing source page at ${src}`);
  process.exit(1);
}

await mkdir(dirname(dest), { recursive: true });
await copyFile(src, dest);
console.log(`sync-site: ${src} -> ${dest}`);
