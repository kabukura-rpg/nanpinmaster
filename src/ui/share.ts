/** シェア（仕様書 §9.2）。ネタバレ防止のため価格は含めない */

import { RANK_EMOJI, RANK_LABELS, RANK_ORDER } from '../core/judge';
import type { Rank, Result } from '../core/types';

export const SHARE_URL = 'https://example.com/daily-bottom';

export function bestRank(results: (Result | null)[]): Rank {
  let best: Rank = 'NO_TRADE';
  for (const r of results) {
    if (!r) continue;
    if (RANK_ORDER.indexOf(r.rank) < RANK_ORDER.indexOf(best)) best = r.rank;
  }
  return best;
}

export function dailyShareText(
  dayNumber: number,
  results: (Result | null)[],
  total: number,
  maxTotal: number,
): string {
  const emoji = results.map((r) => (r ? RANK_EMOJI[r.rank] : '⬛')).join('');
  const best = RANK_LABELS[bestRank(results)];
  return [
    `底値を掴め！ DAILY BOTTOM #${String(dayNumber).padStart(3, '0')}`,
    `${emoji}  ${total.toLocaleString('ja-JP')} / ${maxTotal.toLocaleString('ja-JP')}`,
    `最高：${best}`,
    '#底値を掴め #株クラRPG',
    SHARE_URL,
  ].join('\n');
}

/**
 * Web Share API に対応した端末ではネイティブの共有シートを使う。
 * 非対応の場合はXの投稿intent URLを開く。
 */
export async function share(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.share) {
    try {
      await navigator.share({ text });
      return;
    } catch {
      // ユーザーがキャンセルした場合も含めて、ここでは何もしない
      return;
    }
  }
  const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
  window.open(url, '_blank', 'noopener');
}
