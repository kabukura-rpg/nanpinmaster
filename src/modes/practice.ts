/** PRACTICE（仕様書 §7.2） */

import { generateChart } from '../core/generator';
import type { Chart, Rank, Result, ScenarioId } from '../core/types';
import { readJson, writeJson } from './storage';

export interface PracticeStats {
  plays: number;
  totalScore: number;
  ranks: Partial<Record<Rank, number>>;
  byScenario: Partial<Record<ScenarioId, { plays: number; totalScore: number }>>;
}

const KEY = 'db.practice.stats';

export function randomSeed(): number {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0];
  }
  return Math.floor(Math.random() * 4294967296);
}

export function practiceChart(seed: number = randomSeed()): Chart {
  return generateChart(seed);
}

export function loadStats(): PracticeStats {
  return readJson<PracticeStats>(KEY, { plays: 0, totalScore: 0, ranks: {}, byScenario: {} });
}

export function recordPractice(chart: Chart, result: Result): PracticeStats {
  const s = loadStats();
  s.plays += 1;
  s.totalScore += result.score;
  s.ranks[result.rank] = (s.ranks[result.rank] ?? 0) + 1;
  const b = s.byScenario[chart.scenario] ?? { plays: 0, totalScore: 0 };
  b.plays += 1;
  b.totalScore += result.score;
  s.byScenario[chart.scenario] = b;
  writeJson(KEY, s);
  return s;
}

export function resetStats(): void {
  writeJson(KEY, { plays: 0, totalScore: 0, ranks: {}, byScenario: {} });
}
