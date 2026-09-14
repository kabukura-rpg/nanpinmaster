/**
 * チャート生成（仕様書 §5）
 *
 * generateChart は純粋関数。DOM に依存しない。
 * ブラウザ・Nodeシミュレーション・Phase 2 のサーバー検証で同じコードを使う。
 */

import { Rng, clamp } from './rng';
import {
  BIG_GREEN_M,
  FAKE_PARAMS,
  SCENARIOS,
  type EventSpec,
  type ScenarioSpec,
  type SegSpec,
} from './scenarios';
import type { Candle, Chart, ScenarioId, SignalEvent, SignalKind } from './types';

export const GENERATOR_VERSION = '0.3.0';

export const TICK_MS = 100;
export const TICKS_PER_CANDLE = 8;
/**
 * 事前表示の本数。表示ウィンドウ（DISPLAY_WINDOW）と同数にしてある。
 * これより少ないと、LIVE 序盤にウィンドウが埋まらず、空き幅が経過時間を示してしまう。
 */
export const HISTORY_CANDLES = 18;
/**
 * チャートの表示本数。常にこの本数ちょうどを描き、
 * 新しい足が増えるぶんだけ左へスクロールする。
 * ウィンドウが埋まらない時間帯を作らないことで、残り時間・現在位置が読めないようにする。
 */
export const DISPLAY_WINDOW = 18;
/** 生成全長。31〜36本目は BUY 後の答え合わせ専用 */
export const LIVE_CANDLES = 36;
/** BUY 可能な本数 */
export const PLAYABLE_CANDLES = 30;
export const LIVE_TICKS = LIVE_CANDLES * TICKS_PER_CANDLE; // 288
export const PLAYABLE_TICKS = PLAYABLE_CANDLES * TICKS_PER_CANDLE; // 240
export const READY_MS = 1500;

/** アンカー（真の底の足）の抽選範囲。1始まり */
export const ANCHOR_MIN = 9;
export const ANCHOR_MAX = 26;

const MAX_ATTEMPTS = 200;
const SQRT8 = Math.sqrt(8);

/** 確定したセグメント配置。start は LIVE 基準の 0 始まり足番号 */
interface Placed {
  spec: SegSpec;
  count: number;
  start: number;
}

export interface GenerateOptions {
  scenario?: ScenarioId;
}

export function generateChart(seed: number, opts: GenerateOptions = {}): Chart {
  const rng = new Rng(seed);
  const pool = opts.scenario ? SCENARIOS.filter((s) => s.id === opts.scenario) : SCENARIOS;

  // シナリオはリトライ前に一度だけ引く。再抽選すると、受理条件のゆるいシナリオが
  // 実際の出現率で有利になり、§5.5 の重みからずれてしまう。
  const spec = pickScenario(rng, pool);

  let last: Chart | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const chart = tryBuild(rng, seed, spec);
    if (chart) {
      if (chart.accepted) return chart.chart;
      last = chart.chart;
    }
  }

  // 200回を超えて不合格が続いた場合は SAUCER に差し替えて再試行する
  const saucer = SCENARIOS.filter((s) => s.id === 'SAUCER');
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const chart = tryBuild(rng, seed, saucer[0]);
    if (chart) {
      if (chart.accepted) return chart.chart;
      last = chart.chart;
    }
  }

  if (!last) throw new Error(`generateChart: failed to build any chart for seed ${seed}`);
  return last;
}

function pickScenario(rng: Rng, pool: readonly ScenarioSpec[]): ScenarioSpec {
  if (pool.length === 1) return pool[0];
  return rng.pickWeighted(
    pool,
    pool.map((s) => s.weight),
  );
}

// ---------------------------------------------------------------- 生成本体

function tryBuild(
  rng: Rng,
  seed: number,
  spec: ScenarioSpec,
): { chart: Chart; accepted: boolean } | null {
  // チャート単位パラメータ（§5.3）
  const startPrice = rng.uniform(3000, 9000);
  const v = rng.uniform(0.007, 0.013);
  // アンカーはシナリオと独立に抽選する
  const b1 = rng.int(ANCHOR_MIN, ANCHOR_MAX);

  const plan = resolvePlan(rng, spec, b1);
  if (!plan) return null;
  const { placed, anchorIndex } = plan;

  const params = buildParams(placed);
  const events: SignalEvent[] = [];
  applyScenarioEvents(rng, placed, anchorIndex, params, events);
  applyFakes(rng, placed, anchorIndex, params, events);

  const built = renderTicks(rng, startPrice, v, params);
  const chart = finishChart(seed, spec, v, built, events);
  const accepted = accept(chart, placed, anchorIndex, v, built.liveStartPrice, spec);
  return { chart, accepted };
}

/**
 * セグメントの本数を決める。
 * 「下落」の本数は、アンカー b に底が来るように逆算する（§5.5）。
 */
function resolvePlan(
  rng: Rng,
  spec: ScenarioSpec,
  b1: number,
): { placed: Placed[]; anchorIndex: number } | null {
  const segs = spec.segments;
  const counts = segs.map((s) => (s.fill || s.rest ? 0 : rng.int(s.min, s.max)));

  const ai = segs.findIndex((s) => !!s.anchor);
  const fi = segs.findIndex((s) => !!s.fill);
  const ri = segs.findIndex((s) => !!s.rest);
  if (ai < 0 || fi < 0 || ri < 0) return null;

  // 本数が足りないときに縮められるシナリオ固有セグメント
  const shrinkable: number[] = [];
  for (let i = 0; i <= ai; i++) {
    if (segs[i].own && !segs[i].fill) shrinkable.push(i);
  }

  let anchorLocal = 0;
  for (let guard = 0; ; guard++) {
    if (guard > 200) return null;
    let pre = 0;
    for (let i = 0; i < ai; i++) if (i !== fi) pre += counts[i];
    anchorLocal = localAnchor(segs[ai].anchor!, counts[ai]);
    const fill = b1 - pre - anchorLocal;
    if (fill >= 1) {
      counts[fi] = fill;
      break;
    }
    // シナリオ固有セグメントを各下限−1（最低1本）まで縮める
    let shrunk = false;
    for (let k = shrinkable.length - 1; k >= 0; k--) {
      const i = shrinkable[k];
      const floor = Math.max(1, segs[i].min - 1);
      if (counts[i] > floor) {
        counts[i]--;
        shrunk = true;
        break;
      }
    }
    if (!shrunk) return null;
  }

  let used = 0;
  for (let i = 0; i < segs.length; i++) if (i !== ri) used += counts[i];
  counts[ri] = LIVE_CANDLES - used;
  if (counts[ri] < 1) return null;

  const placed: Placed[] = [];
  let cursor = 0;
  for (let i = 0; i < segs.length; i++) {
    placed.push({ spec: segs[i], count: counts[i], start: cursor });
    cursor += counts[i];
  }
  if (cursor !== LIVE_CANDLES) return null;

  const anchorIndex = placed[ai].start + anchorLocal - 1;
  if (anchorIndex !== b1 - 1) return null;

  return { placed, anchorIndex };
}

/** セグメント内でのアンカー位置（1始まり） */
function localAnchor(rule: NonNullable<SegSpec['anchor']>, count: number): number {
  switch (rule) {
    case 'first':
      return 1;
    case 'last':
      return count;
    case 'center':
      return Math.ceil(count / 2);
    case 'lastThirdCenter': {
      // レンジ後半1/3の中央
      const third = Math.max(1, Math.floor(count / 3));
      return count - third + Math.ceil(third / 2);
    }
  }
}

/** 足ごとの m / s / u。ramp 指定があれば線形補間する */
interface Params {
  m: number[];
  s: number[];
  u: number[];
  /** 下ヒゲの深さ（V単位）。0 なら無し */
  wick: number[];
  /** 下ヒゲの戻し係数 k */
  wickK: number[];
  volMult: number[];
}

function buildParams(placed: Placed[]): Params {
  const p: Params = {
    m: new Array(LIVE_CANDLES).fill(0),
    s: new Array(LIVE_CANDLES).fill(1),
    u: new Array(LIVE_CANDLES).fill(1),
    wick: new Array(LIVE_CANDLES).fill(0),
    wickK: new Array(LIVE_CANDLES).fill(1),
    volMult: new Array(LIVE_CANDLES).fill(1),
  };
  for (const seg of placed) {
    for (let j = 0; j < seg.count; j++) {
      const i = seg.start + j;
      const t = seg.count > 1 ? j / (seg.count - 1) : 0;
      p.m[i] = ramp(seg.spec.m, seg.spec.mEnd, t);
      p.s[i] = ramp(seg.spec.s, seg.spec.sEnd, t);
      p.u[i] = ramp(seg.spec.u, seg.spec.uEnd, t);
    }
  }
  return p;
}

function ramp(from: number, to: number | undefined, t: number): number {
  return to === undefined ? from : from + (to - from) * t;
}

function applyScenarioEvents(
  rng: Rng,
  placed: Placed[],
  anchorIndex: number,
  p: Params,
  events: SignalEvent[],
): void {
  for (const seg of placed) {
    const specs = seg.spec.events;
    if (!specs) continue;
    const isAnchorSeg = seg.spec.anchor !== undefined;
    for (const ev of specs) {
      if (!rng.chance(ev.p)) continue;
      // anchorOffset は真の底からの相対位置。at やセグメント先頭より優先する
      const local =
        ev.anchorOffset !== undefined
          ? anchorIndex - seg.start + ev.anchorOffset
          : ev.at !== undefined
            ? ev.at
            : isAnchorSeg
              ? anchorIndex - seg.start
              : 0;
      const ci = seg.start + local;
      if (local < 0 || local >= seg.count) continue;
      if (ci < 0 || ci >= LIVE_CANDLES) continue;
      const genuine = ev.genuine === 'anchor' ? isAnchorSeg : ev.genuine;
      applyEvent(rng, p, ci, ev, genuine, events);
    }
  }
}

function applyEvent(
  rng: Rng,
  p: Params,
  ci: number,
  ev: EventSpec,
  genuine: boolean,
  events: SignalEvent[],
): void {
  if (!ev.markOnly) {
    switch (ev.kind) {
      case 'WICK': {
        const [lo, hi] = ev.depth ?? [1.2, 2.0];
        p.wick[ci] = rng.uniform(lo, hi);
        p.wickK[ci] = rng.uniform(0.7, 1.0);
        break;
      }
      case 'VOLUME': {
        const [lo, hi] = ev.mult ?? [3, 5];
        p.volMult[ci] *= lo === hi ? lo : rng.uniform(lo, hi);
        break;
      }
      case 'BIG_GREEN':
        p.m[ci] = BIG_GREEN_M;
        break;
      case 'SMALL_BOUNCE': {
        const [lo, hi] = ev.candles ?? FAKE_PARAMS.bounceCandles;
        const n = rng.int(lo, hi);
        for (let j = 0; j < n; j++) {
          const t = ci + j;
          if (t >= LIVE_CANDLES) break;
          p.m[t] = FAKE_PARAMS.bounceM;
        }
        break;
      }
      case 'DECEL':
        // セグメント定義（ドリフト・ボラ・出来高の低下）が既に減速を表しているので記録だけ
        break;
    }
  }
  events.push({ candleIndex: ci, kind: ev.kind, genuine });
}

/**
 * ダマシの配置（§5.7）
 * 配置先は「下落」「加速」セグメント内で、真の底の足の3本以上前。
 */
function applyFakes(
  rng: Rng,
  placed: Placed[],
  anchorIndex: number,
  p: Params,
  events: SignalEvent[],
): void {
  const k = rng.pickWeighted([0, 1, 2, 3], FAKE_PARAMS.countWeights as unknown as number[]);
  if (k === 0) return;

  const candidates: number[] = [];
  for (const seg of placed) {
    if (!seg.spec.fakeTarget) continue;
    for (let j = 0; j < seg.count; j++) {
      const ci = seg.start + j;
      if (ci <= anchorIndex - 3) candidates.push(ci);
    }
  }
  if (candidates.length === 0) return;

  rng.shuffle(candidates);
  const chosen = candidates.slice(0, Math.min(k, candidates.length));
  for (const ci of chosen) {
    const first = placeFake(rng, p, ci, anchorIndex, events, null);
    // 20%の確率で2種を同じ足に重ねる
    if (rng.chance(FAKE_PARAMS.stackP)) {
      placeFake(rng, p, ci, anchorIndex, events, first);
    }
  }
}

function placeFake(
  rng: Rng,
  p: Params,
  ci: number,
  anchorIndex: number,
  events: SignalEvent[],
  exclude: SignalKind | null,
): SignalKind {
  const kinds = FAKE_PARAMS.kinds.filter((x) => x !== exclude);
  const weights = FAKE_PARAMS.kinds
    .map((x, i) => [x, FAKE_PARAMS.kindWeights[i]] as const)
    .filter(([x]) => x !== exclude)
    .map(([, w]) => w);
  const kind = rng.pickWeighted(kinds, weights);

  switch (kind) {
    case 'WICK': {
      const [lo, hi] = FAKE_PARAMS.wickDepth;
      p.wick[ci] = rng.uniform(lo, hi);
      p.wickK[ci] = rng.uniform(0.7, 1.0);
      break;
    }
    case 'VOLUME': {
      const [lo, hi] = FAKE_PARAMS.volumeMult;
      p.volMult[ci] *= rng.uniform(lo, hi);
      break;
    }
    case 'DECEL': {
      const n = rng.int(FAKE_PARAMS.decelCandles[0], FAKE_PARAMS.decelCandles[1]);
      for (let j = 0; j < n; j++) {
        const t = ci + j;
        if (t >= anchorIndex) break;
        p.m[t] = FAKE_PARAMS.decelM;
        p.s[t] *= FAKE_PARAMS.decelSFactor;
      }
      break;
    }
    case 'SMALL_BOUNCE': {
      const n = rng.int(FAKE_PARAMS.bounceCandles[0], FAKE_PARAMS.bounceCandles[1]);
      for (let j = 0; j < n; j++) {
        const t = ci + j;
        if (t >= anchorIndex) break;
        p.m[t] = FAKE_PARAMS.bounceM;
      }
      break;
    }
  }
  events.push({ candleIndex: ci, kind, genuine: false });
  return kind;
}

// ---------------------------------------------------------------- ティック生成

interface Built {
  history: Candle[];
  candles: Candle[];
  ticks: number[];
  liveStartPrice: number;
}

function renderTicks(rng: Rng, startPrice: number, v: number, p: Params): Built {
  let price = startPrice;

  const history: Candle[] = [];
  for (let i = 0; i < HISTORY_CANDLES; i++) {
    const o = Math.round(price);
    let hi = o;
    let lo = o;
    let last = o;
    for (let t = 0; t < TICKS_PER_CANDLE; t++) {
      const r = (0.05 * v) / TICKS_PER_CANDLE + 0.8 * (v / SQRT8) * rng.normal();
      price = price * (1 + r);
      last = Math.round(price);
      if (last > hi) hi = last;
      if (last < lo) lo = last;
    }
    history.push({ o, h: hi, l: lo, c: last, v: volumeOf(rng, o, last, v, 1.0, 1) });
  }

  const liveStartPrice = Math.round(price);
  const ticks: number[] = [];
  const candles: Candle[] = [];
  for (let i = 0; i < LIVE_CANDLES; i++) {
    const o = Math.round(price);
    let hi = o;
    let lo = o;
    let last = o;
    const m = p.m[i];
    const s = p.s[i];
    const w = p.wick[i];
    const k = p.wickK[i];
    for (let t = 0; t < TICKS_PER_CANDLE; t++) {
      // 下ヒゲ：t=1〜3 で下げ、t=4〜6 で戻す（§5.6）
      let e = 0;
      if (w > 0) {
        if (t >= 1 && t <= 3) e = (-w * v) / 3;
        else if (t >= 4 && t <= 6) e = ((w * v) / 3) * k;
      }
      const r = (m * v) / TICKS_PER_CANDLE + s * (v / SQRT8) * rng.normal() + e;
      price = price * (1 + r);
      last = Math.round(price);
      ticks.push(last);
      if (last > hi) hi = last;
      if (last < lo) lo = last;
    }
    candles.push({ o, h: hi, l: lo, c: last, v: volumeOf(rng, o, last, v, p.u[i], p.volMult[i]) });
  }

  return { history, candles, ticks, liveStartPrice };
}

function volumeOf(rng: Rng, o: number, c: number, v: number, u: number, mult: number): number {
  const ret = o === 0 ? 0 : (c - o) / o;
  const abs = ret < 0 ? -ret : ret;
  const q = clamp(1 + 0.25 * rng.normal(), 0.5, 1.8);
  return Math.round(1000 * u * (1 + (0.8 * abs) / v) * q * mult);
}

function finishChart(
  seed: number,
  spec: ScenarioSpec,
  v: number,
  built: Built,
  events: SignalEvent[],
): Chart {
  // 最安値と同値のティックが複数ある場合は、最初のティックを底とする
  let bottomTick = 0;
  for (let i = 1; i < built.ticks.length; i++) {
    if (built.ticks[i] < built.ticks[bottomTick]) bottomTick = i;
  }
  const bottomCandle = Math.floor(bottomTick / TICKS_PER_CANDLE);
  const atrRef = computeAtrRef(built.history, built.candles, bottomCandle);

  return {
    seed,
    generatorVersion: GENERATOR_VERSION,
    scenario: spec.id,
    branch: spec.branch,
    history: built.history,
    ticks: built.ticks,
    candles: built.candles,
    bottomTick,
    atrRef,
    events: events.slice().sort((a, b) => a.candleIndex - b.candleIndex),
    v,
  };
}

/** 底の足の前後5本（計11本）の True Range の平均 */
export function computeAtrRef(history: Candle[], candles: Candle[], bottomCandle: number): number {
  const all = history.concat(candles);
  const center = history.length + bottomCandle;
  const from = Math.max(1, center - 5);
  const to = Math.min(all.length - 1, center + 5);
  let sum = 0;
  let n = 0;
  for (let i = from; i <= to; i++) {
    const cur = all[i];
    const prevC = all[i - 1].c;
    const a = cur.h - cur.l;
    const b = Math.abs(cur.h - prevC);
    const c = Math.abs(cur.l - prevC);
    sum += Math.max(a, b, c);
    n++;
  }
  const atr = n > 0 ? sum / n : 0;
  return atr > 0 ? atr : 1;
}

// ---------------------------------------------------------------- 受理判定（§5.8）

function accept(
  chart: Chart,
  placed: Placed[],
  anchorIndex: number,
  v: number,
  liveStartPrice: number,
  spec: ScenarioSpec,
): boolean {
  const bottomCandle = Math.floor(chart.bottomTick / TICKS_PER_CANDLE);
  const bottomPrice = chart.ticks[chart.bottomTick];

  // 1. 全体最安値の足が、アンカー±2本以内かつ LIVE 9〜26本目にある
  const diff = Math.abs(bottomCandle - anchorIndex);
  if (diff > 2) return false;
  const oneBased = bottomCandle + 1;
  if (oneBased < ANCHOR_MIN || oneBased > ANCHOR_MAX) return false;

  // 2. LIVE最終足の終値 ≥ 最安値 + 3 × ATR_ref
  if (chart.candles[LIVE_CANDLES - 1].c < bottomPrice + 3 * chart.atrRef) return false;

  // 3. LIVE開始価格から最安値までの下落率が 12〜45%
  const drop = (liveStartPrice - bottomPrice) / liveStartPrice;
  if (drop < 0.12 || drop > 0.45) return false;

  // 4. シナリオ固有の条件
  return acceptScenario(chart, placed, spec, v, bottomPrice);
}

function segLow(chart: Chart, seg: Placed): number {
  let lo = Infinity;
  for (let j = 0; j < seg.count; j++) {
    const l = chart.candles[seg.start + j].l;
    if (l < lo) lo = l;
  }
  return lo;
}

function findSeg(placed: Placed[], name: string): Placed | undefined {
  return placed.find((p) => p.spec.name === name);
}

function acceptScenario(
  chart: Chart,
  placed: Placed[],
  spec: ScenarioSpec,
  v: number,
  bottomPrice: number,
): boolean {
  switch (spec.id) {
    case 'FAKE': {
      // 真の底 ≤ 第一安値 − 2V×価格
      const first = findSeg(placed, '第一安値');
      if (!first) return false;
      const firstLow = segLow(chart, first);
      return bottomPrice <= firstLow - 2 * v * firstLow;
    }
    case 'DOUBLE': {
      const first = findSeg(placed, '第一底');
      const second = findSeg(placed, '二番底');
      if (!first || !second) return false;
      const a = segLow(chart, first);
      const b = segLow(chart, second);
      if (spec.branch === 'D1') {
        // 二番底が第一底を下回る。
        // 差が 1ATR 未満だと二つの安値がどちらも SUPER 圏に入ってしまうので、
        // 「わずかに下回る」より広めの窓にしてある
        return b >= a - 2.5 * v * a && b <= a - 0.8 * v * a;
      }
      // D2：安値切り上げ。こちらも同じ理由で窓を広げている
      return b >= a + 1.2 * v * a && b <= a + 3.0 * v * a;
    }
    case 'CLIMAX': {
      // 底固めがクライマックス安値を割らない
      const climax = findSeg(placed, 'クライマックス');
      const base = findSeg(placed, '底固め');
      if (!climax || !base) return false;
      return segLow(chart, base) >= segLow(chart, climax);
    }
    default:
      return true;
  }
}

// ---------------------------------------------------------------- 表示用ヘルパ

/**
 * 形成中の足を含めた表示用の足列を返す。
 * lastTick は「最後に描画したティック」（0始まり）。-1 なら LIVE の足はまだ無い。
 */
export function candlesUpTo(chart: Chart, lastTick: number): Candle[] {
  if (lastTick < 0) return [];
  const done = Math.floor((lastTick + 1) / TICKS_PER_CANDLE);
  const out = chart.candles.slice(0, done);
  const into = (lastTick + 1) % TICKS_PER_CANDLE;
  if (into > 0) {
    const i = done;
    const o = i === 0 ? chart.history[chart.history.length - 1].c : chart.candles[i - 1].c;
    let hi = o;
    let lo = o;
    let last = o;
    for (let t = 0; t < into; t++) {
      const q = chart.ticks[i * TICKS_PER_CANDLE + t];
      if (q > hi) hi = q;
      if (q < lo) lo = q;
      last = q;
    }
    // 形成中の足の出来高は、ティック進行に比例して積み上げる
    out.push({ o, h: hi, l: lo, c: last, v: Math.round((chart.candles[i].v * into) / TICKS_PER_CANDLE) });
  }
  return out;
}
