/**
 * 表示から時間情報が漏れないことのテスト（§4）
 *
 * プレイヤーに与える判断材料を価格・ローソク足・出来高に限るため、
 * 「描画される足の本数」がゲーム中いつでも一定であることを機械的に保証する。
 */

import { describe, expect, it } from 'vitest';

import {
  DISPLAY_WINDOW,
  HISTORY_CANDLES,
  PLAYABLE_TICKS,
  TICKS_PER_CANDLE,
  candlesUpTo,
  generateChart,
} from '../src/core/generator';
import { FIXED_SEEDS } from './hash';

/** 描画側と同じ切り出し（ChartRenderer.draw の visible 相当） */
function visibleCount(total: number): number {
  return total <= DISPLAY_WINDOW ? total : DISPLAY_WINDOW;
}

describe('表示ウィンドウ', () => {
  it('事前表示はウィンドウを埋められる本数がある', () => {
    // 足りないと LIVE 序盤に空き幅ができ、その幅が経過時間を示してしまう
    expect(HISTORY_CANDLES).toBeGreaterThanOrEqual(DISPLAY_WINDOW);
  });

  it('READY から BUY 締め切りまで、描画される足の本数は常に一定', () => {
    for (const seed of FIXED_SEEDS) {
      const chart = generateChart(seed);
      // lastTick = -1 は READY（LIVE の足がまだ無い状態）
      for (let tick = -1; tick < PLAYABLE_TICKS; tick++) {
        const total = chart.history.length + candlesUpTo(chart, tick).length;
        expect(visibleCount(total)).toBe(DISPLAY_WINDOW);
      }
    }
  });

  it('1本進むごとにちょうど1本ぶん左へスクロールする', () => {
    const chart = generateChart(FIXED_SEEDS[0]);
    const firstVisible = (tick: number) => {
      const total = chart.history.length + candlesUpTo(chart, tick).length;
      return total - DISPLAY_WINDOW;
    };
    // 足の確定タイミングでのみ、かつ必ず1本だけ進む
    for (let c = 0; c + 1 < PLAYABLE_TICKS / TICKS_PER_CANDLE; c++) {
      const before = firstVisible(c * TICKS_PER_CANDLE);
      const after = firstVisible((c + 1) * TICKS_PER_CANDLE);
      expect(after - before).toBe(1);
    }
  });

  it('形成中の足は常にウィンドウの右端にある', () => {
    // 現在位置が画面上の同じ x に固定されるので、足の位置から進行度は読めない
    const chart = generateChart(FIXED_SEEDS[1]);
    for (let tick = 0; tick < PLAYABLE_TICKS; tick++) {
      const live = candlesUpTo(chart, tick);
      const total = chart.history.length + live.length;
      const lastVisibleIndex = total - 1;
      expect(lastVisibleIndex - (total - DISPLAY_WINDOW)).toBe(DISPLAY_WINDOW - 1);
      // 右端の足は、そのティックが属する形成中の足
      expect(live.length - 1).toBe(Math.floor(tick / TICKS_PER_CANDLE));
    }
  });
});
