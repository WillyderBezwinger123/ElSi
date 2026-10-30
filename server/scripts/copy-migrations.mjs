// tsc does not copy non-TS files: put the SQL migrations next to the compiled migrate.js.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../src/db/migrations/', import.meta.url));
const dest = fileURLToPath(new URL('../dist/db/migrations/', import.meta.url));
mkdirSync(dest, { recursive: true });
const files = readdirSync(src).filter((f) => f.endsWith('.sql'));
for (const f of files) cpSync(src + f, dest + f);
console.log(`copied ${files.length} migration(s) to dist/db/migrations`);
