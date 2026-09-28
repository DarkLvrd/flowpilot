import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const fixture = (rpcid) => readFileSync(join(dir, `${rpcid}.txt`), 'utf8');
