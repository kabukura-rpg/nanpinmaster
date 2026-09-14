/**
 * 決定性のテスト（仕様書 §5.2）
 *
 * 固定シード10本の生成結果のハッシュをスナップショットと比較する。
 * このテストは iOS Safari・Android Chrome でも同じ値になることを確認するために使う
 * （ブラウザ側は tests/determinism.snapshot.json を読み込んで同じ比較を行う）。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { GENERATOR_VERSION, generateChart } from '../src/core/generator';
import { mulberry32, cyrb53, Rng } from '../src/core/rng';
import { FIXED_SEEDS, chartHash } from './hash';

const here = dirname(fileURLToPath(import.meta.url));
const snapshot: Record<string, string> = JSON.parse(
  readFileSync(join(here, 'determinism.snapshot.json'), 'utf8'),
);

describe('PRNG', () => {
  it('mulberry32 は同じシードで同じ列を返す', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });

  it('mulberry32 は [0,1) に収まる', () => {
    const r = mulberry32(7);
    for (let i = 0; i < 10000; i++) {
      const x = r();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('cyrb53 は決定的で、入力が違えば値も違う', () => {
    expect(cyrb53('DAILY|2026-09-11|0')).toBe(cyrb53('DAILY|2026-09-11|0'));
    expect(cyrb53('DAILY|2026-09-11|0')).not.toBe(cyrb53('DAILY|2026-09-11|1'));
  });

  it('Irwin–Hall 正規乱数は平均0・分散1に近い', () => {
    const rng = new Rng(1);
    let sum = 0;
    let sq = 0;
    const n = 200000;
    for (let i = 0; i < n; i++) {
      const x = rng.normal();
      sum += x;
      sq += x * x;
    }
    expect(Math.abs(sum / n)).toBeLessThan(0.01);
    expect(Math.abs(sq / n - 1)).toBeLessThan(0.02);
  });
});

describe('generateChart', () => {
  it('同じシードから同じチャートを作る', () => {
    for (const seed of FIXED_SEEDS) {
      expect(chartHash(generateChart(seed))).toBe(chartHash(generateChart(seed)));
    }
  });

  it('固定シードの結果がスナップショットと一致する', () => {
    expect(snapshot.generatorVersion).toBe(GENERATOR_VERSION);
    for (const seed of FIXED_SEEDS) {
      expect(chartHash(generateChart(seed))).toBe(snapshot[String(seed)]);
    }
  });

  it('ティック価格はすべて整数円', () => {
    for (const seed of FIXED_SEEDS) {
      const c = generateChart(seed);
      for (const t of c.ticks) expect(Number.isInteger(t)).toBe(true);
    }
  });
});

describe('生成コードの制約', () => {
  it('src/core は Math.log / exp / sin / cos / pow を使わない', () => {
    // JSエンジン間で最下位ビットの一致が保証されないため（§5.2）
    const dir = join(here, '..', 'src', 'core');
    const banned = /Math\.(log|log2|log10|exp|expm1|sin|cos|tan|pow|cbrt|hypot|atan2?)\b/;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts')) continue;
      const src = readFileSync(join(dir, name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      const offending = src
        .split('\n')
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) => banned.test(line));
      expect(offending, `${name}: ${JSON.stringify(offending)}`).toEqual([]);
    }
  });
});
