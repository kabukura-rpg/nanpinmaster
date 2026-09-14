/** DAILY（仕様書 §7.1） */

import { generateChart } from '../core/generator';
import { seedFromString } from '../core/rng';
import { Rng } from '../core/rng';
import { SCENARIOS } from '../core/scenarios';
import type { Chart, Result, ScenarioId } from '../core/types';
import { readJson, writeJson } from './storage';

/** リリース日を #001 とする */
export const RELEASE_DATE = '2026-09-11';
export const ROUNDS = 3;

/** JST 固定の YYYY-MM-DD */
export function jstDateString(d: Date = new Date()): string {
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const day = String(jst.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function dailyNumber(date: string): number {
  const a = Date.parse(`${RELEASE_DATE}T00:00:00Z`);
  const b = Date.parse(`${date}T00:00:00Z`);
  return Math.floor((b - a) / 86400000) + 1;
}

/** 3相場のシナリオを、重み付き抽選で重複しないように選ぶ */
export function dailyScenarios(date: string): ScenarioId[] {
  const rng = new Rng(seedFromString(`DAILY|${date}|scenarios`));
  const ids: ScenarioId[] = [];
  const weights: number[] = [];
  for (const s of SCENARIOS) {
    const at = ids.indexOf(s.id);
    if (at < 0) {
      ids.push(s.id);
      weights.push(s.weight);
    } else {
      weights[at] += s.weight;
    }
  }
  const out: ScenarioId[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    const picked = rng.pickWeighted(ids, weights);
    const at = ids.indexOf(picked);
    ids.splice(at, 1);
    weights.splice(at, 1);
    out.push(picked);
  }
  return out;
}

export function dailyChart(date: string, round: number): Chart {
  const scenario = dailyScenarios(date)[round];
  return generateChart(seedFromString(`DAILY|${date}|${round}`), { scenario });
}

export interface DailyState {
  date: string;
  /** 相場を開始した時点で立てる。リロードしてもやり直せないようにするため */
  started: boolean[];
  results: (Result | null)[];
}

const KEY = (date: string) => `db.daily.${date}`;

export function loadDaily(date: string): DailyState {
  const fresh: DailyState = {
    date,
    started: [false, false, false],
    results: [null, null, null],
  };
  const s = readJson<DailyState>(KEY(date), fresh);
  if (s.date !== date || !Array.isArray(s.started) || s.started.length !== ROUNDS) return fresh;
  return s;
}

export function saveDaily(s: DailyState): void {
  writeJson(KEY(s.date), s);
}

/**
 * 未完了のまま再訪した相場は NO TRADE として確定させる。
 * 現在プレイ中の相場（current）は対象外。
 */
export function reconcileDaily(s: DailyState, current: number | null): DailyState {
  for (let i = 0; i < ROUNDS; i++) {
    if (i === current) continue;
    if (s.started[i] && s.results[i] === null) {
      s.results[i] = {
        buyTick: null,
        buyPrice: null,
        bottomPrice: 0,
        deviationPct: null,
        z: null,
        rank: 'NO_TRADE',
        score: 0,
      };
    }
  }
  return s;
}

export function nextRound(s: DailyState): number | null {
  for (let i = 0; i < ROUNDS; i++) {
    if (s.results[i] === null && !s.started[i]) return i;
  }
  return null;
}

export function dailyFinished(s: DailyState): boolean {
  return s.results.every((r) => r !== null);
}

export function dailyTotal(s: DailyState): number {
  return s.results.reduce((a, r) => a + (r?.score ?? 0), 0);
}
