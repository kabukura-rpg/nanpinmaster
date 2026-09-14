/** 判定のテスト（仕様書 §6） */

import { describe, expect, it } from 'vitest';

import { PLAYABLE_TICKS, TICKS_PER_CANDLE, generateChart, LIVE_CANDLES } from '../src/core/generator';
import { judge, rankOf } from '../src/core/judge';
import type { Chart } from '../src/core/types';
import { FIXED_SEEDS } from './hash';

function chartFor(seed: number): Chart {
  return generateChart(seed);
}

describe('rankOf', () => {
  it('z の閾値どおりに分かれる', () => {
    expect(rankOf(0)).toBe('GOD');
    expect(rankOf(0.2)).toBe('GOD');
    expect(rankOf(0.2001)).toBe('ULTRA');
    expect(rankOf(0.5)).toBe('ULTRA');
    expect(rankOf(0.5001)).toBe('SUPER');
    expect(rankOf(1.0)).toBe('SUPER');
    expect(rankOf(1.0001)).toBe('GREAT');
    expect(rankOf(2.0)).toBe('GREAT');
    expect(rankOf(2.0001)).toBe('GOOD');
    expect(rankOf(4.0)).toBe('GOOD');
    expect(rankOf(4.0001)).toBe('BAD');
  });
});

describe('judge', () => {
  it('BUYなしは NO TRADE でスコア0', () => {
    const c = chartFor(1);
    const r = judge(c, null);
    expect(r.rank).toBe('NO_TRADE');
    expect(r.score).toBe(0);
    expect(r.buyPrice).toBeNull();
    expect(r.deviationPct).toBeNull();
  });

  it('BUY可能範囲の外はエラー', () => {
    const c = chartFor(1);
    expect(() => judge(c, -1)).toThrow();
    expect(() => judge(c, PLAYABLE_TICKS)).toThrow();
  });

  it('乖離率は常に0以上（底値は全36本の最安値）', () => {
    for (const seed of FIXED_SEEDS) {
      const c = chartFor(seed);
      for (let t = 0; t < PLAYABLE_TICKS; t += 7) {
        expect(judge(c, t).deviationPct!).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('同一相場内では、ランクは乖離率に対して単調', () => {
    const order = ['GOD', 'ULTRA', 'SUPER', 'GREAT', 'GOOD', 'BAD'];
    for (const seed of FIXED_SEEDS) {
      const c = chartFor(seed);
      const rows = [];
      for (let t = 0; t < PLAYABLE_TICKS; t++) {
        const r = judge(c, t);
        rows.push({ d: r.deviationPct!, i: order.indexOf(r.rank) });
      }
      rows.sort((a, b) => a.d - b.d);
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i].i).toBeGreaterThanOrEqual(rows[i - 1].i);
      }
    }
  });

  it('精度スコアは round(1000 / (1 + z))', () => {
    for (const seed of FIXED_SEEDS) {
      const c = chartFor(seed);
      for (let t = 0; t < PLAYABLE_TICKS; t += 13) {
        const r = judge(c, t);
        expect(r.score).toBe(Math.round(1000 / (1 + r.z!)));
      }
    }
  });

  it('底値ティックで買えば GOD、スコア1000', () => {
    for (const seed of FIXED_SEEDS) {
      const c = chartFor(seed);
      if (c.bottomTick >= PLAYABLE_TICKS) continue;
      const r = judge(c, c.bottomTick);
      expect(r.z).toBe(0);
      expect(r.rank).toBe('GOD');
      expect(r.score).toBe(1000);
    }
  });
});

describe('生成されたチャートの受理条件（§5.8）', () => {
  it('底の足は LIVE 9〜26本目にあり、明確な反発がある', () => {
    for (let seed = 0; seed < 300; seed++) {
      const c = chartFor(seed);
      const bottomCandle = Math.floor(c.bottomTick / TICKS_PER_CANDLE);
      expect(bottomCandle + 1).toBeGreaterThanOrEqual(9);
      expect(bottomCandle + 1).toBeLessThanOrEqual(26);

      const bottom = c.ticks[c.bottomTick];
      expect(c.candles[LIVE_CANDLES - 1].c).toBeGreaterThanOrEqual(bottom + 3 * c.atrRef);

      const start = c.candles[0].o;
      const drop = (start - bottom) / start;
      expect(drop).toBeGreaterThanOrEqual(0.12);
      expect(drop).toBeLessThanOrEqual(0.45);
    }
  });

  it('底値は全ティックの最小値で、最初の出現を採る', () => {
    for (let seed = 0; seed < 200; seed++) {
      const c = chartFor(seed);
      const min = Math.min(...c.ticks);
      expect(c.ticks[c.bottomTick]).toBe(min);
      expect(c.ticks.indexOf(min)).toBe(c.bottomTick);
    }
  });

  it('ダマシは真の底の足の3本以上前に置かれる（アンカー基準）', () => {
    for (let seed = 0; seed < 300; seed++) {
      const c = chartFor(seed);
      const bottomCandle = Math.floor(c.bottomTick / TICKS_PER_CANDLE);
      for (const e of c.events) {
        if (e.genuine) continue;
        // 実際の底はアンカー±2本ずれうるので、その分を見込む
        expect(e.candleIndex).toBeLessThanOrEqual(bottomCandle + 2 - 3);
      }
    }
  });
});
