/** 判定（仕様書 §6） */

import { PLAYABLE_TICKS } from './generator';
import type { Chart, Rank, Result } from './types';

/** ランク閾値（初期値。§10のシミュレーションで調整する） */
export const RANK_THRESHOLDS: ReadonlyArray<{ rank: Rank; maxZ: number }> = [
  { rank: 'GOD', maxZ: 0.2 },
  { rank: 'ULTRA', maxZ: 0.5 },
  { rank: 'SUPER', maxZ: 1.0 },
  { rank: 'GREAT', maxZ: 2.0 },
  { rank: 'GOOD', maxZ: 4.0 },
];

export const RANK_LABELS: Record<Rank, string> = {
  GOD: 'GOD BOTTOM',
  ULTRA: 'ULTRA BOTTOM',
  SUPER: 'SUPER BOTTOM',
  GREAT: 'GREAT',
  GOOD: 'GOOD',
  BAD: 'BAD',
  NO_TRADE: 'NO TRADE',
};

export const RANK_EMOJI: Record<Rank, string> = {
  GOD: '👑',
  ULTRA: '🟪',
  SUPER: '🟦',
  GREAT: '🟩',
  GOOD: '🟨',
  BAD: '🟥',
  NO_TRADE: '⬛',
};

/** 強い順。比較や統計の並び順に使う */
export const RANK_ORDER: readonly Rank[] = [
  'GOD',
  'ULTRA',
  'SUPER',
  'GREAT',
  'GOOD',
  'BAD',
  'NO_TRADE',
];

export function rankOf(z: number): Rank {
  for (const t of RANK_THRESHOLDS) {
    if (z <= t.maxZ) return t.rank;
  }
  return 'BAD';
}

export function rankAtLeast(rank: Rank, min: Rank): boolean {
  return RANK_ORDER.indexOf(rank) <= RANK_ORDER.indexOf(min);
}

/**
 * buyTick が null ならタイムアウト（NO TRADE）。
 * 底値は LIVE 全36本の最安値ティック価格。BUY 後に形成された場合も含む。
 */
export function judge(chart: Chart, buyTick: number | null): Result {
  const bottomPrice = chart.ticks[chart.bottomTick];

  if (buyTick === null) {
    return {
      buyTick: null,
      buyPrice: null,
      bottomPrice,
      deviationPct: null,
      z: null,
      rank: 'NO_TRADE',
      score: 0,
    };
  }
  if (buyTick < 0 || buyTick >= PLAYABLE_TICKS) {
    throw new RangeError(`judge: buyTick out of playable range: ${buyTick}`);
  }

  const buyPrice = chart.ticks[buyTick];
  const deviationPct = (buyPrice - bottomPrice) / bottomPrice;
  const z = (buyPrice - bottomPrice) / chart.atrRef;
  const rank = rankOf(z);
  return {
    buyTick,
    buyPrice,
    bottomPrice,
    deviationPct,
    z,
    rank,
    score: Math.round(1000 / (1 + z)),
  };
}
