/**
 * Bot 群（仕様書 §10.1）
 *
 * Bot は観測可能な情報（そのティックまでに描画された内容）のみを使う。
 * chart.v / chart.bottomTick / chart.events は OracleBot 以外では参照しない。
 * RandomBot 以外の全 Bot には反応遅延 N(250ms, 50ms) を加え、ティック単位に丸める。
 */

import { PLAYABLE_CANDLES, PLAYABLE_TICKS, TICKS_PER_CANDLE } from '../src/core/generator';
import { Rng, clamp } from '../src/core/rng';
import type { Candle, Chart } from '../src/core/types';

export interface Bot {
  name: string;
  decide(chart: Chart, rng: Rng, obs: Obs): number | null;
}

/** 観測可能な情報だけをまとめたもの */
export interface Obs {
  /** 履歴＋LIVE の連結 */
  all: Candle[];
  histLen: number;
  liveStart: number;
  /** 履歴の値動きから推定した1足あたりボラ（真の V は見ない） */
  vEst: number;
  /** LIVE 各足の特徴量（足の確定時点）。§10.1 の単純ルール Bot が使う */
  feat: Features[];
  /**
   * LIVE 各ティックの特徴量。形成中の足を含む。
   *
   * §4 のとおり人間は足の途中で BUY できるので、人間の代理である
   * ComboBot / ExpertBot はこちらを使う。足の確定を待つ実装にすると、
   * 底のティックを捉える精度が構造的に頭打ちになる。
   */
  tickFeat: TickFeatures;
}

/** ティック単位の特徴量。本数が多いので型付き配列で持つ */
export interface TickFeatures {
  wick: Float32Array;
  volRatio: Float32Array;
  decel: Float32Array;
  sinceLow: Float32Array;
  green: Float32Array;
  dry: Float32Array;
  flat: Float32Array;
  bullish: Uint8Array;
}

export function tickFeatureAt(t: TickFeatures, i: number): Features {
  return {
    wick: t.wick[i],
    volRatio: t.volRatio[i],
    decel: t.decel[i],
    sinceLow: t.sinceLow[i],
    green: t.green[i],
    dry: t.dry[i],
    flat: t.flat[i],
    newLow: false,
    bullish: t.bullish[i] === 1,
  };
}

export interface Features {
  /** 下ヒゲの深さ（推定V単位） */
  wick: number;
  /** 出来高の直近10本平均に対する倍率 */
  volRatio: number;
  /** 実体の縮小度合い（0〜1） */
  decel: number;
  /** 安値を更新していない経過本数 */
  sinceLow: number;
  /** 陽線の大きさ（推定V単位） */
  green: number;
  /** 出来高枯れ：直近3本の出来高が、その前の平均に対してどれだけ減ったか（0〜1） */
  dry: number;
  /** 値幅の収縮：直近3本の高安レンジが、その前に対してどれだけ縮んだか（0〜1） */
  flat: number;
  /** その足までに安値を更新したか */
  newLow: boolean;
  /** 陽線か */
  bullish: boolean;
}

const E_ABS_NORMAL = 0.7978845608;
/** 履歴セグメントのボラ倍率 s。推定の逆算に使う */
const HISTORY_S = 0.8;

export function observe(chart: Chart): Obs {
  const all = chart.history.concat(chart.candles);
  const histLen = chart.history.length;
  const liveStart = chart.candles[0].o;

  let sum = 0;
  for (const c of chart.history) sum += Math.abs((c.c - c.o) / c.o);
  const meanAbs = sum / chart.history.length;
  const vEst = Math.max(meanAbs / (HISTORY_S * E_ABS_NORMAL), 1e-6);

  const feat: Features[] = [];
  let lowSoFar = Infinity;
  let sinceLow = 0;
  for (let i = 0; i < chart.candles.length; i++) {
    const c = chart.candles[i];
    const scale = vEst * c.o;

    let volSum = 0;
    let volN = 0;
    for (let j = 1; j <= 10; j++) {
      const k = histLen + i - j;
      if (k < 0) break;
      volSum += all[k].v;
      volN++;
    }
    const volAvg = volN > 0 ? volSum / volN : c.v;

    let bodySum = 0;
    let bodyN = 0;
    for (let j = 1; j <= 5; j++) {
      const k = histLen + i - j;
      if (k < 0) break;
      bodySum += Math.abs(all[k].c - all[k].o);
      bodyN++;
    }
    const bodyAvg = bodyN > 0 ? bodySum / bodyN : Math.abs(c.c - c.o);

    const newLow = c.l < lowSoFar;
    if (newLow) {
      lowSoFar = c.l;
      sinceLow = 0;
    } else {
      sinceLow++;
    }

    feat.push({
      wick: (Math.min(c.o, c.c) - c.l) / scale,
      volRatio: volAvg > 0 ? c.v / volAvg : 1,
      decel: bodyAvg > 0 ? clamp(1 - Math.abs(c.c - c.o) / bodyAvg, 0, 1) : 0,
      sinceLow,
      green: (c.c - c.o) / scale,
      dry: dryness(all, histLen + i),
      flat: flatness(all, histLen + i),
      newLow,
      bullish: c.c > c.o,
    });
  }

  return { all, histLen, liveStart, vEst, feat, tickFeat: buildTickFeatures(chart, all, histLen, vEst) };
}

/**
 * 形成中の足を含むティック単位の特徴量。
 * 各ティックで「そこまでに描画された内容」だけから作る。
 */
function buildTickFeatures(
  chart: Chart,
  all: Candle[],
  histLen: number,
  vEst: number,
): TickFeatures {
  const n = PLAYABLE_TICKS;
  const out: TickFeatures = {
    wick: new Float32Array(n),
    volRatio: new Float32Array(n),
    decel: new Float32Array(n),
    sinceLow: new Float32Array(n),
    green: new Float32Array(n),
    dry: new Float32Array(n),
    flat: new Float32Array(n),
    bullish: new Uint8Array(n),
  };

  let lowSoFar = Infinity;
  let lastNewLowCandle = -1;

  for (let i = 0; i < n / TICKS_PER_CANDLE; i++) {
    const candle = chart.candles[i];
    const o = candle.o;
    const scale = vEst * o;

    // 直前の足までの平均は足の中では変わらないので、足ごとに1回だけ求める
    let volSum = 0;
    let volN = 0;
    for (let j = 1; j <= 10; j++) {
      const k = histLen + i - j;
      if (k < 0) break;
      volSum += all[k].v;
      volN++;
    }
    const volAvg = volN > 0 ? volSum / volN : candle.v;

    let bodySum = 0;
    let bodyN = 0;
    for (let j = 1; j <= 5; j++) {
      const k = histLen + i - j;
      if (k < 0) break;
      bodySum += Math.abs(all[k].c - all[k].o);
      bodyN++;
    }
    const bodyAvg = bodyN > 0 ? bodySum / bodyN : Math.abs(candle.c - candle.o);
    // 確定した足だけから作る指標なので、足の中では一定
    const dry = dryness(all, histLen + i);
    const flat = flatness(all, histLen + i);

    let hi = o;
    let lo = o;
    for (let t = 0; t < TICKS_PER_CANDLE; t++) {
      const idx = i * TICKS_PER_CANDLE + t;
      const price = chart.ticks[idx];
      if (price > hi) hi = price;
      if (price < lo) lo = price;

      if (lo < lowSoFar) {
        lowSoFar = lo;
        lastNewLowCandle = i;
      }

      // 出来高バーはティック進行に比例して伸びる。見えているぶんだけで比べる
      const volSoFar = (candle.v * (t + 1)) / TICKS_PER_CANDLE;
      const body = Math.abs(price - o);

      out.wick[idx] = (Math.min(o, price) - lo) / scale;
      out.volRatio[idx] = volAvg > 0 ? volSoFar / volAvg : 1;
      out.decel[idx] = bodyAvg > 0 ? clamp(1 - body / bodyAvg, 0, 1) : 0;
      out.sinceLow[idx] = lastNewLowCandle < 0 ? 0 : i - lastNewLowCandle;
      out.green[idx] = (price - o) / scale;
      out.dry[idx] = dry;
      out.flat[idx] = flat;
      out.bullish[idx] = price > o ? 1 : 0;
    }
  }
  return out;
}

/**
 * 出来高枯れ。直近3本と、その前7本の出来高を比べる。
 * 確定した足だけから作るので、形成中の足の途中でも値は変わらない。
 */
function dryness(all: Candle[], upTo: number): number {
  const recent = avgVolume(all, upTo - 3, upTo);
  const before = avgVolume(all, upTo - 10, upTo - 3);
  if (before <= 0) return 0;
  return clamp(1 - recent / before, 0, 1);
}

function avgVolume(all: Candle[], from: number, to: number): number {
  let sum = 0;
  let n = 0;
  for (let i = Math.max(0, from); i < to; i++) {
    sum += all[i].v;
    n++;
  }
  return n > 0 ? sum / n : 0;
}

/** 値幅の収縮。直近3本の高安レンジと、その前7本のレンジを比べる */
function flatness(all: Candle[], upTo: number): number {
  const recent = rangeOf(all, upTo - 3, upTo);
  const before = rangeOf(all, upTo - 10, upTo - 3);
  if (before <= 0) return 0;
  return clamp(1 - recent / before, 0, 1);
}

function rangeOf(all: Candle[], from: number, to: number): number {
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = Math.max(0, from); i < to; i++) {
    if (all[i].h > hi) hi = all[i].h;
    if (all[i].l < lo) lo = all[i].l;
  }
  return hi === -Infinity ? 0 : hi - lo;
}

/** 反応遅延 N(250ms, 50ms) をティックに丸めたもの */
function delayTicks(rng: Rng): number {
  const ms = 250 + 50 * rng.normal();
  return Math.max(0, Math.round(ms / 100));
}

/** 足 i が確定した瞬間のティック */
function candleCloseTick(i: number): number {
  return i * TICKS_PER_CANDLE + (TICKS_PER_CANDLE - 1);
}

function finish(tick: number): number | null {
  return tick >= 0 && tick < PLAYABLE_TICKS ? tick : null;
}

// ---------------------------------------------------------------- 基準線

export const randomBot: Bot = {
  name: 'RandomBot',
  decide(_chart, rng) {
    return rng.int(0, PLAYABLE_TICKS - 1);
  },
};

export function timeBot(seconds: number): Bot {
  return {
    name: `TimeBot(${seconds.toFixed(1)}s)`,
    decide(_chart, rng) {
      return finish(Math.round(seconds * 10) + delayTicks(rng));
    },
  };
}

export function depthBot(pct: number): Bot {
  return {
    name: `DepthBot(${pct}%)`,
    decide(chart, rng, obs) {
      const target = obs.liveStart * (1 - pct / 100);
      const d = delayTicks(rng);
      for (let t = 0; t < PLAYABLE_TICKS; t++) {
        if (chart.ticks[t] <= target) return finish(t + d);
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------- 単純ルール

export const wickBot: Bot = {
  name: 'WickBot',
  decide(_chart, rng, obs) {
    const d = delayTicks(rng);
    for (let i = 0; i < PLAYABLE_CANDLES; i++) {
      if (obs.feat[i].wick >= 1.0) return finish(candleCloseTick(i) + d);
    }
    return null;
  },
};

export const volumeBot: Bot = {
  name: 'VolumeBot',
  decide(_chart, rng, obs) {
    const d = delayTicks(rng);
    for (let i = 0; i < PLAYABLE_CANDLES; i++) {
      if (obs.feat[i].volRatio >= 2.2) return finish(candleCloseTick(i) + d);
    }
    return null;
  },
};

/** 単一兆候：減速（実体の縮小）だけを見る */
export function decelBot(threshold: number): Bot {
  return {
    name: `DecelBot(${threshold.toFixed(2)})`,
    decide(_chart, rng, obs) {
      const d = delayTicks(rng);
      for (let i = 0; i < PLAYABLE_CANDLES; i++) {
        if (obs.feat[i].decel >= threshold) return finish(candleCloseTick(i) + d);
      }
      return null;
    },
  };
}

/** 単一兆候：大陽線だけを見る */
export function bigGreenBot(threshold: number): Bot {
  return {
    name: `BigGreenBot(${threshold.toFixed(1)})`,
    decide(_chart, rng, obs) {
      const d = delayTicks(rng);
      for (let i = 0; i < PLAYABLE_CANDLES; i++) {
        if (obs.feat[i].green >= threshold) return finish(candleCloseTick(i) + d);
      }
      return null;
    },
  };
}

/** 単一兆候：小反発だけを見る（安値更新の直後の、小さな陽線） */
export function bounceBot(threshold: number): Bot {
  return {
    name: `BounceBot(${threshold.toFixed(1)})`,
    decide(_chart, rng, obs) {
      const d = delayTicks(rng);
      for (let i = 0; i < PLAYABLE_CANDLES; i++) {
        const f = obs.feat[i];
        if (f.sinceLow >= 1 && f.sinceLow <= 2 && f.green >= threshold && f.green < 2.0) {
          return finish(candleCloseTick(i) + d);
        }
      }
      return null;
    },
  };
}

export function confirmBot(n: number): Bot {
  return {
    name: `ConfirmBot(${n})`,
    decide(_chart, rng, obs) {
      const d = delayTicks(rng);
      let seenLow = false;
      let streak = 0;
      for (let i = 0; i < PLAYABLE_CANDLES; i++) {
        const f = obs.feat[i];
        if (f.newLow) {
          seenLow = true;
          streak = 0;
          continue;
        }
        if (!seenLow) continue;
        streak = f.bullish ? streak + 1 : 0;
        if (streak >= n) return finish(candleCloseTick(i) + d);
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------- 複合

export interface ComboWeights {
  wick: number;
  vol: number;
  decel: number;
  sinceLow: number;
  green: number;
  /** 出来高枯れ。SAUCER のような、スパイクの出ない底を読むのに要る */
  dry: number;
  /** 値幅の収縮。底固め・レンジを読むのに要る */
  flat: number;
  threshold: number;
}

/** 兆候スコア。重みと閾値は学習用シードでグリッドサーチする */
export function comboScore(f: Features, w: ComboWeights): number {
  return (
    w.wick * clamp(f.wick, 0, 3) +
    w.vol * clamp(f.volRatio - 1, 0, 3) +
    w.decel * f.decel +
    w.sinceLow * (clamp(f.sinceLow, 0, 6) / 6) +
    w.green * clamp(f.green, 0, 3) +
    w.dry * f.dry +
    w.flat * f.flat
  );
}

export function comboBot(w: ComboWeights): Bot {
  return {
    name: 'ComboBot',
    decide(_chart, rng, obs) {
      const d = delayTicks(rng);
      const f = obs.tickFeat;
      for (let t = 0; t < PLAYABLE_TICKS; t++) {
        if (tickScore(f, t, w) >= w.threshold) return finish(t + d);
      }
      return null;
    },
  };
}

/** comboScore のティック版。型付き配列から直接読む */
export function tickScore(f: TickFeatures, t: number, w: ComboWeights): number {
  return (
    w.wick * clamp(f.wick[t], 0, 3) +
    w.vol * clamp(f.volRatio[t] - 1, 0, 3) +
    w.decel * f.decel[t] +
    w.sinceLow * (clamp(f.sinceLow[t], 0, 6) / 6) +
    w.green * clamp(f.green[t], 0, 3) +
    w.dry * f.dry[t] +
    w.flat * f.flat[t]
  );
}

export interface ExpertParams extends ComboWeights {
  /** 兆候で入るときに、直近安値からどれだけ離れていないことを求めるか（足数） */
  freshLow: number;
  /** 兆候が出ないまま安値を更新しない足がこの本数続き、陽線が出たら入る */
  patience: number;
}

/**
 * 熟練プレイヤーの代理。時計を持たず、市場情報だけで判断する。
 *
 * ComboBot との違いは、兆候が出ないまま相場が進んだときの逃げ道を持っていること。
 * 経過時間は観測できないので、代わりに「安値を更新しなくなった＋陽線」という
 * 市場情報だけで反転確認に切り替える。
 */
export function expertBot(w: ExpertParams): Bot {
  return {
    name: 'ExpertBot',
    decide(_chart, rng, obs) {
      const d = delayTicks(rng);
      const f = obs.tickFeat;
      for (let t = 0; t < PLAYABLE_TICKS; t++) {
        // 兆候が重なっていて、かつ安値をつけたばかりのところを狙う
        if (f.sinceLow[t] <= w.freshLow && tickScore(f, t, w) >= w.threshold) {
          return finish(t + d);
        }
        // 兆候が出ないまま下げ止まったら、反転確認に切り替える
        if (f.sinceLow[t] >= w.patience && f.bullish[t] === 1) {
          return finish(t + d);
        }
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------- 2兆候の組み合わせ

/** 単一兆候Botの発火しきい値。2兆候Botもこれを使う */
export const SINGLE_THRESHOLDS = {
  wick: 1.0,
  vol: 2.2,
  decel: 0.8,
  green: 1.5,
} as const;

export type SignalKey = keyof typeof SINGLE_THRESHOLDS;

export const SIGNAL_KEY_LABEL: Record<SignalKey, string> = {
  wick: '下ヒゲ',
  vol: '出来高',
  decel: '減速',
  green: '大陽線',
};

function firesAt(f: TickFeatures, t: number, key: SignalKey): boolean {
  switch (key) {
    case 'wick':
      return f.wick[t] >= SINGLE_THRESHOLDS.wick;
    case 'vol':
      return f.volRatio[t] >= SINGLE_THRESHOLDS.vol;
    case 'decel':
      return f.decel[t] >= SINGLE_THRESHOLDS.decel;
    case 'green':
      return f.green[t] >= SINGLE_THRESHOLDS.green;
  }
}

/**
 * 2つの兆候がどちらも直近2本以内に出ていたら買う。
 * ComboBot と同じくティック単位で見るので、単純さ以外のハンデは無い。
 * 「この2つだけ覚えれば勝てる」が成立しないことの確認に使う。
 */
export function pairBot(a: SignalKey, b: SignalKey): Bot {
  return {
    name: `Pair(${SIGNAL_KEY_LABEL[a]}+${SIGNAL_KEY_LABEL[b]})`,
    decide(_chart, rng, obs) {
      const d = delayTicks(rng);
      const f = obs.tickFeat;
      const window = 2 * TICKS_PER_CANDLE;
      let lastA = -1;
      let lastB = -1;
      for (let t = 0; t < PLAYABLE_TICKS; t++) {
        if (firesAt(f, t, a)) lastA = t;
        if (firesAt(f, t, b)) lastB = t;
        if (lastA >= 0 && lastB >= 0 && t - lastA <= window && t - lastB <= window) {
          return finish(t + d);
        }
      }
      return null;
    },
  };
}

/** GOD に到達可能かの上限確認 */
export const oracleBot: Bot = {
  name: 'OracleBot',
  decide(chart, rng) {
    return finish(chart.bottomTick + delayTicks(rng));
  },
};
