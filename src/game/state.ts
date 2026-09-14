/** 状態遷移（仕様書 §8.1） */

import {
  PLAYABLE_TICKS,
  READY_MS,
  TICKS_PER_CANDLE,
  TICK_MS,
  LIVE_CANDLES,
  candlesUpTo,
} from '../core/generator';
import { judge } from '../core/judge';
import type { Candle, Chart, Rank, Result } from '../core/types';

export type Phase = 'READY' | 'LIVE' | 'FREEZE' | 'PLAYBACK' | 'REVEAL' | 'RESULT';

const FREEZE_MS = 400;
const PLAYBACK_NORMAL_MS = 200;
const PLAYBACK_SLOW_MS = 500;
const PLAYBACK_CAP_MS = 4000;
const REVEAL_SKIPPABLE_AFTER_MS = 500;

export const REVEAL_MS: Record<Rank, number> = {
  BAD: 2000,
  GOOD: 3000,
  GREAT: 4000,
  SUPER: 5000,
  ULTRA: 7000,
  GOD: 10000,
  NO_TRADE: 2000,
};

export interface Frame {
  phase: Phase;
  /** 履歴＋LIVE の連結。描画にそのまま渡す */
  candles: Candle[];
  currentPrice: number | null;
  /** 最後に描画したティック（0始まり）。LIVE 前は -1 */
  lastTick: number;
  buyTick: number | null;
}

export interface RunnerHooks {
  onPhase?(phase: Phase, runner: GameRunner): void;
  onFrame?(frame: Frame): void;
  onDone?(result: Result): void;
}

interface Step {
  tick: number;
  at: number;
}

/**
 * 1相場の進行。時間基準で進めるので、フレーム落ちしても進行はずれない。
 */
export class GameRunner {
  readonly chart: Chart;
  private hooks: RunnerHooks;
  private phase: Phase = 'READY';
  private phaseStart = 0;
  private liveStart = 0;
  private lastTick = -1;
  private buyTick: number | null = null;
  private result: Result | null = null;
  private steps: Step[] = [];
  private raf = 0;
  private running = false;
  /** PRACTICE の一時停止用 */
  private pausedAt: number | null = null;

  constructor(chart: Chart, hooks: RunnerHooks = {}) {
    this.chart = chart;
    this.hooks = hooks;
  }

  get currentPhase(): Phase {
    return this.phase;
  }

  get currentResult(): Result | null {
    return this.result;
  }

  start(): void {
    this.running = true;
    this.setPhase('READY', now());
    this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** READY からやり直す（PRACTICE のバックグラウンド復帰） */
  restartReady(): void {
    this.lastTick = -1;
    this.buyTick = null;
    this.result = null;
    this.pausedAt = null;
    this.setPhase('READY', now());
  }

  pause(): void {
    if (this.pausedAt === null) this.pausedAt = now();
  }

  isPaused(): boolean {
    return this.pausedAt !== null;
  }

  /** LIVE 中のみ有効。押下時点で「最後に描画したティック」の価格で約定する */
  buy(): boolean {
    if (this.phase !== 'LIVE' || this.buyTick !== null) return false;
    const t = Math.max(0, Math.min(this.lastTick, PLAYABLE_TICKS - 1));
    this.buyTick = t;
    this.result = judge(this.chart, t);
    vibrate();
    this.setPhase('FREEZE', now());
    return true;
  }

  /** タイムアウト、または DAILY のバックグラウンド遷移 */
  forceNoTrade(): void {
    if (this.phase === 'RESULT' || this.result) return;
    this.buyTick = null;
    this.result = judge(this.chart, null);
    this.setPhase('PLAYBACK', now());
  }

  /** REVEAL のスキップ */
  skipReveal(): boolean {
    if (this.phase !== 'REVEAL') return false;
    if (now() - this.phaseStart < REVEAL_SKIPPABLE_AFTER_MS) return false;
    this.setPhase('RESULT', now());
    return true;
  }

  private setPhase(phase: Phase, t: number): void {
    this.phase = phase;
    this.phaseStart = t;
    if (phase === 'LIVE') this.liveStart = t;
    if (phase === 'PLAYBACK') this.steps = buildPlayback(this.chart, this.buyTick);
    if (phase === 'RESULT' && this.result) this.hooks.onDone?.(this.result);
    this.hooks.onPhase?.(phase, this);
  }

  private loop = (): void => {
    if (!this.running) return;
    this.tickOnce(now());
    this.raf = requestAnimationFrame(this.loop);
  };

  private tickOnce(t: number): void {
    if (this.pausedAt !== null) {
      this.emit();
      return;
    }
    const since = t - this.phaseStart;

    switch (this.phase) {
      case 'READY':
        if (since >= READY_MS) this.setPhase('LIVE', t);
        break;
      case 'LIVE': {
        // ゲーム内のティック番号は経過時間から求める
        const tick = Math.floor((t - this.liveStart) / TICK_MS);
        if (tick >= PLAYABLE_TICKS) {
          this.lastTick = PLAYABLE_TICKS - 1;
          this.forceNoTrade();
        } else {
          this.lastTick = tick;
        }
        break;
      }
      case 'FREEZE':
        if (since >= FREEZE_MS) this.setPhase('PLAYBACK', t);
        break;
      case 'PLAYBACK': {
        let last = this.lastTick;
        let done = true;
        for (const s of this.steps) {
          if (s.at <= since) last = s.tick;
          else {
            done = false;
            break;
          }
        }
        this.lastTick = Math.max(this.lastTick, last);
        if (done) this.setPhase('REVEAL', t);
        break;
      }
      case 'REVEAL': {
        const rank = this.result?.rank ?? 'BAD';
        if (since >= REVEAL_MS[rank]) this.setPhase('RESULT', t);
        break;
      }
      case 'RESULT':
        break;
    }
    this.emit();
  }

  private emit(): void {
    this.hooks.onFrame?.(this.frame());
  }

  frame(): Frame {
    const live = candlesUpTo(this.chart, this.lastTick);
    const candles = this.chart.history.concat(live);
    const currentPrice = this.lastTick >= 0 ? this.chart.ticks[this.lastTick] : null;
    return {
      phase: this.phase,
      candles,
      currentPrice: this.phase === 'READY' ? this.chart.history[this.chart.history.length - 1].c : currentPrice,
      lastTick: this.lastTick,
      buyTick: this.buyTick,
    };
  }
}

/**
 * PLAYBACK の再生スケジュール。
 * 表示するのは生成済みの実データそのもの。演出のために値は変えない。
 */
export function buildPlayback(chart: Chart, buyTick: number | null): Step[] {
  const bottomCandle = Math.floor(chart.bottomTick / TICKS_PER_CANDLE);
  const from = buyTick === null ? PLAYABLE_TICKS / TICKS_PER_CANDLE : Math.floor(buyTick / TICKS_PER_CANDLE);

  const durations: number[] = [];
  for (let c = from; c < LIVE_CANDLES; c++) {
    const slow = Math.abs(c - bottomCandle) <= 1;
    durations.push(slow ? PLAYBACK_SLOW_MS : PLAYBACK_NORMAL_MS);
  }

  // 合計の上限は4秒。超える場合は通常速度の部分を圧縮する
  let total = 0;
  let slowTotal = 0;
  for (let i = 0; i < durations.length; i++) {
    total += durations[i];
    if (durations[i] === PLAYBACK_SLOW_MS) slowTotal += durations[i];
  }
  if (total > PLAYBACK_CAP_MS) {
    const normalTotal = total - slowTotal;
    if (slowTotal >= PLAYBACK_CAP_MS || normalTotal <= 0) {
      const k = PLAYBACK_CAP_MS / total;
      for (let i = 0; i < durations.length; i++) durations[i] *= k;
    } else {
      const k = (PLAYBACK_CAP_MS - slowTotal) / normalTotal;
      for (let i = 0; i < durations.length; i++) {
        if (durations[i] !== PLAYBACK_SLOW_MS) durations[i] *= k;
      }
    }
  }

  const steps: Step[] = [];
  let at = 0;
  for (let i = 0; i < durations.length; i++) {
    const c = from + i;
    const d = durations[i];
    for (let t = 0; t < TICKS_PER_CANDLE; t++) {
      steps.push({ tick: c * TICKS_PER_CANDLE + t, at: at + (d * (t + 1)) / TICKS_PER_CANDLE });
    }
    at += d;
  }
  return steps;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function vibrate(): void {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    navigator.vibrate(30);
  }
}
