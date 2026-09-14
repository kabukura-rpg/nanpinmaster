/** 決定性スナップショットを作り直す： npm run snap */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GENERATOR_VERSION, generateChart } from '../src/core/generator';
import { FIXED_SEEDS, chartHash } from './hash';

const out: Record<string, string> = { generatorVersion: GENERATOR_VERSION };
for (const seed of FIXED_SEEDS) out[String(seed)] = chartHash(generateChart(seed));

const path = join(dirname(fileURLToPath(import.meta.url)), 'determinism.snapshot.json');
writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
process.stdout.write(`wrote ${path}\n`);
