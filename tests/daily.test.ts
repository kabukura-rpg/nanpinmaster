/** DAILY の決定性（仕様書 §5.2, §7.1） */

import { describe, expect, it } from 'vitest';

import { ROUNDS, dailyChart, dailyNumber, dailyScenarios, jstDateString } from '../src/modes/daily';
import { chartHash } from './hash';

const DATES = ['2026-09-11', '2026-09-12', '2027-01-01'];

describe('DAILY', () => {
  it('同じ日付なら何度呼んでも同じチャートになる', () => {
    for (const date of DATES) {
      for (let i = 0; i < ROUNDS; i++) {
        expect(chartHash(dailyChart(date, i))).toBe(chartHash(dailyChart(date, i)));
      }
    }
  });

  it('日付が違えばチャートも違う', () => {
    const a = chartHash(dailyChart(DATES[0], 0));
    const b = chartHash(dailyChart(DATES[1], 0));
    expect(a).not.toBe(b);
  });

  it('同じ日の3相場は互いに異なる', () => {
    for (const date of DATES) {
      const hashes = [0, 1, 2].map((i) => chartHash(dailyChart(date, i)));
      expect(new Set(hashes).size).toBe(ROUNDS);
    }
  });

  it('3相場のシナリオは重複しない', () => {
    for (const date of DATES) {
      const ids = dailyScenarios(date);
      expect(ids).toHaveLength(ROUNDS);
      expect(new Set(ids).size).toBe(ROUNDS);
    }
    // 生成されたチャートのシナリオも一致する
    const ids = dailyScenarios(DATES[0]);
    for (let i = 0; i < ROUNDS; i++) {
      expect(dailyChart(DATES[0], i).scenario).toBe(ids[i]);
    }
  });

  it('JSTの日付境界で日付が変わる', () => {
    // 2026-09-11 14:59 UTC = 2026-09-11 23:59 JST
    expect(jstDateString(new Date('2026-09-11T14:59:00Z'))).toBe('2026-09-11');
    // 2026-09-11 15:00 UTC = 2026-09-12 00:00 JST
    expect(jstDateString(new Date('2026-09-11T15:00:00Z'))).toBe('2026-09-12');
  });

  it('番号はリリース日を #001 として1日ずつ増える', () => {
    expect(dailyNumber('2026-09-11')).toBe(1);
    expect(dailyNumber('2026-09-12')).toBe(2);
    expect(dailyNumber('2026-10-11')).toBe(31);
  });
});
