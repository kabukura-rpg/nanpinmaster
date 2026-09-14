import { cyrb53 } from '../src/core/rng';
import type { Chart } from '../src/core/types';

/** チャートの生成結果を一意に表す文字列。浮動小数は toString で厳密に出す */
export function serializeChart(c: Chart): string {
  const parts: string[] = [
    c.scenario,
    c.branch ?? '-',
    c.generatorVersion,
    c.bottomTick.toString(),
    c.atrRef.toString(),
    c.v.toString(),
  ];
  for (const h of c.history) parts.push(`${h.o},${h.h},${h.l},${h.c},${h.v}`);
  for (const k of c.candles) parts.push(`${k.o},${k.h},${k.l},${k.c},${k.v}`);
  parts.push(c.ticks.join(','));
  for (const e of c.events) parts.push(`${e.candleIndex}:${e.kind}:${e.genuine ? 1 : 0}`);
  return parts.join('|');
}

export function chartHash(c: Chart): string {
  return cyrb53(serializeChart(c)).toString(16);
}

/** スナップショットに使う固定シード */
export const FIXED_SEEDS = [
  1, 2, 3, 12345, 99999, 0x5eed, 0xdeadbeef, 2654435761, 4294967295, 987654321,
];
