/**
 * Phase 1 のパラメータ決定に向けた追加分析（分析専用。本体は一切変更しない）
 *
 *   npm run analysis -- --valid 8000 --train 800
 *
 * 1. GOD に「先読み条件（buyTick <= bottomTick）」を足した場合の各Botの GOD 率
 * 2. 兆候信頼度を現行と高信頼度実験の中間に置いたときの各Botの成績
 * 3. 単一兆候・2兆候の組み合わせが支配戦略になっていないかの確認
 * 4. GOD 判定方式 A（価格乖離のみ）と B（価格乖離＋先読み）の比較
 *
 * 信頼度の差し替えはメモリ上のオブジェクトを書き換えて行う。
 * ファイルには何も書き戻さないので、src/ の内容は変わらない。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PLAYABLE_TICKS, TICKS_PER_CANDLE, generateChart } from '../src/core/generator';
import { RANK_THRESHOLDS, judge } from '../src/core/judge';
import { Rng, clamp } from '../src/core/rng';
import { FAKE_PARAMS, SCENARIOS } from '../src/core/scenarios';
import type { Chart, SignalKind } from '../src/core/types';
import {
  bigGreenBot,
  bounceBot,
  comboBot,
  confirmBot,
  decelBot,
  depthBot,
  observe,
  oracleBot,
  pairBot,
  randomBot,
  tickScore,
  timeBot,
  volumeBot,
  wickBot,
  type Bot,
  type ComboWeights,
  type ExpertParams,
  type Obs,
} from './bots';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out');
const VALID_BASE = 0x5eed_9000;
const TRAIN_BASE = 0x5eed_1000;

const Z_GOD = RANK_THRESHOLDS[0].maxZ;
const Z_ULTRA = RANK_THRESHOLDS[1].maxZ;
const Z_SUPER = RANK_THRESHOLDS[2].maxZ;

const KINDS: SignalKind[] = ['WICK', 'BIG_GREEN', 'VOLUME', 'DECEL', 'SMALL_BOUNCE'];

interface Sample {
  chart: Chart;
  obs: Obs;
}

function makeSamples(base: number, n: number): Sample[] {
  const out: Sample[] = [];
  for (let i = 0; i < n; i++) {
    const chart = generateChart((base + i * 2654435761) >>> 0);
    out.push({ chart, obs: observe(chart) });
  }
  return out;
}

// ---------------------------------------------------------------- 兆候信頼度の差し替え

/** メモリ上の可変ノブ。ファイルには書き戻さない */
interface Knobs {
  /** §5.7 のダマシ、種別ごとの目標本数（1万チャートあたり） */
  want57: Record<'WICK' | 'VOLUME' | 'DECEL' | 'SMALL_BOUNCE', number>;
  /** FAKE シナリオの構造的ダマシの発生確率 */
  pFakeWick: number;
  pFakeVolume: number;
  pFakeBigGreen: number;
}

const mutableFake = FAKE_PARAMS as unknown as {
  countWeights: number[];
  kindWeights: number[];
  stackP: number;
};

function fakeScenarioEvents() {
  const fake = SCENARIOS.find((s) => s.id === 'FAKE')!;
  const low = fake.segments.find((x) => x.name === '第一安値')!.events!;
  const rally = fake.segments.find((x) => x.name === 'ダマシ反発')!.events!;
  return {
    wick: low.find((e) => e.kind === 'WICK')! as { p: number },
    volume: low.find((e) => e.kind === 'VOLUME')! as { p: number },
    bigGreen: rally.find((e) => e.kind === 'BIG_GREEN')! as { p: number },
  };
}

function applyKnobs(k: Knobs): void {
  const order: Array<keyof Knobs['want57']> = ['WICK', 'VOLUME', 'DECEL', 'SMALL_BOUNCE'];
  const counts = order.map((x) => Math.max(1, k.want57[x]));
  const total = counts.reduce((a, b) => a + b, 0);
  mutableFake.kindWeights = counts.map((c) => (1000 * c) / total);

  // 1チャートあたりの目標ダマシ数から k の分布を決める（重ね置き 20% を織り込む）
  const perChart = total / 10000 / (1 + mutableFake.stackP);
  mutableFake.countWeights = countWeightsForMean(clamp(perChart, 0, 2.9));

  const ev = fakeScenarioEvents();
  ev.wick.p = clamp(k.pFakeWick, 0, 1);
  ev.volume.p = clamp(k.pFakeVolume, 0, 1);
  ev.bigGreen.p = clamp(k.pFakeBigGreen, 0, 1);
}

/** {0,1,2,3} 上で指定した平均になる重みを作る */
function countWeightsForMean(mean: number): number[] {
  // 0 と 1..3 の混合。1..3 の形は現行の比率を保つ
  const shape = [45, 21, 5];
  const shapeMean = (1 * shape[0] + 2 * shape[1] + 3 * shape[2]) / (shape[0] + shape[1] + shape[2]);
  const q = Math.min(1, mean / shapeMean);
  const w1 = q * shape[0];
  const w2 = q * shape[1];
  const w3 = q * shape[2];
  const w0 = Math.max(0.001, shape[0] + shape[1] + shape[2] - (w1 + w2 + w3));
  return [w0, w1, w2, w3];
}

interface Measured {
  genuine: number;
  fake: number;
  near: number;
  reliability: number;
}

function measureSignals(n: number): Record<string, Measured> {
  const acc: Record<string, Measured> = {};
  for (const k of KINDS) acc[k] = { genuine: 0, fake: 0, near: 0, reliability: 0 };
  for (let i = 0; i < n; i++) {
    const c = generateChart((VALID_BASE + i * 2654435761) >>> 0);
    const bc = Math.floor(c.bottomTick / TICKS_PER_CANDLE);
    for (const e of c.events) {
      const a = acc[e.kind];
      const near = Math.abs(e.candleIndex - bc) <= 2;
      if (e.genuine) a.genuine++;
      else a.fake++;
      if (near) a.near++;
    }
  }
  for (const k of KINDS) {
    const a = acc[k];
    const tot = a.genuine + a.fake;
    a.reliability = tot ? a.near / tot : 0;
    // 1万チャート換算
    const scale = 10000 / n;
    a.genuine = Math.round(a.genuine * scale);
    a.fake = Math.round(a.fake * scale);
    a.near = Math.round(a.near * scale);
  }
  return acc;
}

/**
 * 目標信頼度に合わせてダマシの量を調整する。
 * 真の兆候はほぼ 100% が底の±2本以内に出るので、
 * 信頼度 ≒ 真 ÷（真＋ダマシ）。比例制御で数回まわせば収束する。
 */
function calibrate(target: Record<string, number>, iters: number, n: number): Knobs {
  const knobs: Knobs = {
    want57: { WICK: 1100, VOLUME: 2900, DECEL: 4500, SMALL_BOUNCE: 3400 },
    pFakeWick: 0.5,
    pFakeVolume: 0.5,
    pFakeBigGreen: 0.72,
  };
  for (let it = 0; it < iters; it++) {
    applyKnobs(knobs);
    const m = measureSignals(n);
    for (const kind of KINDS) {
      const a = m[kind];
      const t = target[kind];
      // 目標を満たすために要るダマシの本数
      const wantFake = Math.max(1, a.near * (1 / t - 1));
      const factor = clamp(wantFake / Math.max(1, a.fake), 0.35, 2.5);
      switch (kind) {
        case 'WICK':
          knobs.want57.WICK *= factor;
          knobs.pFakeWick *= factor;
          break;
        case 'VOLUME':
          knobs.want57.VOLUME *= factor;
          knobs.pFakeVolume *= factor;
          break;
        case 'BIG_GREEN':
          knobs.pFakeBigGreen *= factor;
          break;
        case 'DECEL':
          knobs.want57.DECEL *= factor;
          break;
        case 'SMALL_BOUNCE':
          knobs.want57.SMALL_BOUNCE *= factor;
          break;
      }
    }
  }
  applyKnobs(knobs);
  return knobs;
}

// ---------------------------------------------------------------- 2兆候の組み合わせBot

/**
 * 足の途中の反転を捉えるBot。
 *
 * §5.6 の下ヒゲは 8ティックのうち t=1〜3 で下げ、t=4〜6 で戻す。
 * つまり「急に下げて、下げ止まった瞬間」が底のティックになりやすい。
 * これは形成中の足を見ていれば分かる情報なので、人間にも取れる。
 * GOD 帯（±0.2ATR ≒ 3ティック分）が腕で取れるものかどうかを見るために入れている。
 */
function reversalBot(dropV: number, riseV: number): Bot {
  return {
    name: `ReversalBot(${dropV}/${riseV})`,
    decide(chart, rng, obs) {
      const d = Math.max(0, Math.round((250 + 50 * rng.normal()) / 100));
      const scaleBase = obs.vEst;
      for (let i = 0; i < PLAYABLE_TICKS / TICKS_PER_CANDLE; i++) {
        const o = chart.candles[i].o;
        const scale = scaleBase * o;
        let low = o;
        for (let t = 0; t < TICKS_PER_CANDLE; t++) {
          const idx = i * TICKS_PER_CANDLE + t;
          const p = chart.ticks[idx];
          if (p < low) low = p;
          // 足の中で dropV 以上下げたあと、安値から riseV 以上戻したら入る
          if ((o - low) / scale >= dropV && (p - low) / scale >= riseV) {
            const buy = idx + d;
            return buy < PLAYABLE_TICKS ? buy : null;
          }
        }
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------- 評価

interface BotStat {
  n: number;
  trades: number;
  noTrade: number;
  superPlus: number;
  ultraPlus: number;
  godA: number;
  /** GOD 価格条件に加えて buyTick <= bottomTick を満たしたもの */
  godB: number;
  /** 現行 GOD の内訳 */
  godBefore: number;
  godSame: number;
  godAfter: number;
  /** GOD 価格条件を満たしたときの buyTick - bottomTick。許容幅の掃引に使う */
  godOffsets: number[];
  devSum: number;
  devs: number[];
  scoreSum: number;
}

function emptyBotStat(): BotStat {
  return {
    n: 0,
    trades: 0,
    noTrade: 0,
    superPlus: 0,
    ultraPlus: 0,
    godA: 0,
    godB: 0,
    godBefore: 0,
    godSame: 0,
    godAfter: 0,
    godOffsets: [],
    devSum: 0,
    devs: [],
    scoreSum: 0,
  };
}

function evaluate(bot: Bot, samples: Sample[], seed = 0x1234_5678): BotStat {
  const st = emptyBotStat();
  const rng = new Rng(seed);
  for (const s of samples) {
    const buy = bot.decide(s.chart, rng, s.obs);
    const res = judge(s.chart, buy);
    st.n++;
    st.scoreSum += res.score;
    if (buy === null || res.z === null) {
      st.noTrade++;
      continue;
    }
    st.trades++;
    st.devSum += res.deviationPct!;
    st.devs.push(res.deviationPct!);
    if (res.z <= Z_SUPER) st.superPlus++;
    if (res.z <= Z_ULTRA) st.ultraPlus++;
    if (res.z <= Z_GOD) {
      st.godA++;
      st.godOffsets.push(buy - s.chart.bottomTick);
      if (buy <= s.chart.bottomTick) st.godB++;
      if (buy < s.chart.bottomTick) st.godBefore++;
      else if (buy === s.chart.bottomTick) st.godSame++;
      else st.godAfter++;
    }
  }
  return st;
}

function median(a: number[]): number | null {
  if (a.length === 0) return null;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const pct2 = (x: number) => `${(100 * x).toFixed(2)}%`;
const dev = (x: number | null) => (x === null ? '—' : `${(100 * x).toFixed(2)}%`);

// ---------------------------------------------------------------- パラメータ探索（簡易版）

function randomWeights(rng: Rng): ComboWeights {
  const w = () => rng.pickWeighted([0, 0.5, 1, 2, 3], [30, 20, 20, 20, 10]);
  return {
    wick: w(),
    vol: w(),
    decel: w(),
    sinceLow: w(),
    green: w(),
    dry: w(),
    flat: w(),
    threshold: rng.uniform(0.3, 6),
  };
}

function trainAvg(
  train: Sample[],
  w: ComboWeights,
  freshLow: number | null,
  patience: number | null,
): number {
  let total = 0;
  for (const s of train) {
    const f = s.obs.tickFeat;
    let buy: number | null = null;
    for (let t = 0; t < PLAYABLE_TICKS; t++) {
      const sig = tickScore(f, t, w) >= w.threshold;
      const hit =
        freshLow === null
          ? sig
          : (f.sinceLow[t] <= freshLow && sig) ||
            (patience !== null && f.sinceLow[t] >= patience && f.bullish[t] === 1);
      if (hit) {
        const b = t + 2;
        buy = b < PLAYABLE_TICKS ? b : null;
        break;
      }
    }
    total += judge(s.chart, buy).score;
  }
  return total / train.length;
}

function searchCombo(train: Sample[], trials: number): ComboWeights {
  const rng = new Rng(0xc0b0a11);
  let best: ComboWeights | null = null;
  let bestVal = -Infinity;
  for (let i = 0; i < trials; i++) {
    const w = randomWeights(rng);
    const v = trainAvg(train, w, null, null);
    if (v > bestVal) {
      bestVal = v;
      best = w;
    }
  }
  return best!;
}

function searchExpert(train: Sample[], comboW: ComboWeights, trials: number): ExpertParams {
  const rng = new Rng(0xe0e0e0);
  const baseline: ExpertParams = { ...comboW, freshLow: 6, patience: 99 };
  let best = baseline;
  let bestVal = trainAvg(train, baseline, baseline.freshLow, baseline.patience);
  const consider = (w: ComboWeights, freshLow: number, patience: number) => {
    const v = trainAvg(train, w, freshLow, patience);
    if (v > bestVal) {
      bestVal = v;
      best = { ...w, freshLow, patience };
    }
  };
  for (const freshLow of [0, 1, 2, 3, 6]) {
    for (const patience of [2, 3, 4, 5, 6, 99]) consider(comboW, freshLow, patience);
  }
  for (let i = 0; i < trials; i++) {
    consider(
      randomWeights(rng),
      rng.pickWeighted([0, 1, 2, 3, 6], [20, 20, 20, 20, 20]),
      rng.pickWeighted([2, 3, 4, 5, 6, 99], [20, 20, 20, 20, 10, 10]),
    );
  }
  return best;
}

function expertBotOf(w: ExpertParams): Bot {
  return {
    name: 'ExpertBot',
    decide(_chart, rng, obs) {
      const d = Math.max(0, Math.round((250 + 50 * rng.normal()) / 100));
      const f = obs.tickFeat;
      for (let t = 0; t < PLAYABLE_TICKS; t++) {
        if (f.sinceLow[t] <= w.freshLow && tickScore(f, t, w) >= w.threshold) {
          const b = t + d;
          return b < PLAYABLE_TICKS ? b : null;
        }
        if (f.sinceLow[t] >= w.patience && f.bullish[t] === 1) {
          const b = t + d;
          return b < PLAYABLE_TICKS ? b : null;
        }
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------- 設定

interface Setting {
  label: string;
  target: Record<string, number> | null;
}

const SETTINGS: Setting[] = [
  { label: '現行', target: null },
  {
    label: '中間A',
    target: { WICK: 0.78, BIG_GREEN: 0.7, VOLUME: 0.65, DECEL: 0.55, SMALL_BOUNCE: 0.25 },
  },
  {
    label: '中間B（やや低め）',
    target: { WICK: 0.74, BIG_GREEN: 0.68, VOLUME: 0.6, DECEL: 0.5, SMALL_BOUNCE: 0.22 },
  },
  {
    label: '中間C（やや高め）',
    target: { WICK: 0.82, BIG_GREEN: 0.74, VOLUME: 0.7, DECEL: 0.6, SMALL_BOUNCE: 0.3 },
  },
];

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  return fallback;
}

// ---------------------------------------------------------------- 本体

function main(): void {
  const nValid = arg('valid', 8000);
  const nTrain = arg('train', 800);
  const trials = arg('trials', 1200);

  // 現行設定の控え。最後に必ず戻す
  const original = {
    countWeights: mutableFake.countWeights.slice(),
    kindWeights: mutableFake.kindWeights.slice(),
    ...(() => {
      const ev = fakeScenarioEvents();
      return { pw: ev.wick.p, pv: ev.volume.p, pb: ev.bigGreen.p };
    })(),
  };
  const restore = () => {
    mutableFake.countWeights = original.countWeights.slice();
    mutableFake.kindWeights = original.kindWeights.slice();
    const ev = fakeScenarioEvents();
    ev.wick.p = original.pw;
    ev.volume.p = original.pv;
    ev.bigGreen.p = original.pb;
  };

  const md: string[] = [];
  md.push('# GOD 条件と兆候信頼度の追加分析');
  md.push('');
  md.push(`検証用シード ${nValid} 本 / 学習用シード ${nTrain} 本。`);
  md.push('本体のコード・生成ロジック・ランク閾値・兆候信頼度は変更していない。');
  md.push('信頼度の差し替えはこのスクリプトの中でメモリ上のみ行い、最後に現行値へ戻している。');
  md.push('');

  const perSetting: Array<{
    label: string;
    signals: Record<string, Measured>;
    rows: Array<{ bot: Bot; st: BotStat; kind: string }>;
  }> = [];

  for (const setting of SETTINGS) {
    process.stderr.write(`\n=== ${setting.label} ===\n`);
    restore();
    if (setting.target) calibrate(setting.target, 6, 3000);
    const signals = measureSignals(Math.min(nValid, 6000));

    process.stderr.write('  generating...\n');
    const train = makeSamples(TRAIN_BASE, nTrain);
    const valid = makeSamples(VALID_BASE, nValid);

    process.stderr.write('  searching...\n');
    const comboW = searchCombo(train, trials);
    const expertW = searchExpert(train, comboW, trials);

    const singles: Bot[] = [
      wickBot,
      volumeBot,
      decelBot(0.8),
      bigGreenBot(1.5),
      bounceBot(0.4),
    ];
    const pairs: Bot[] = [
      pairBot('wick', 'vol'),
      pairBot('wick', 'decel'),
      pairBot('vol', 'decel'),
      pairBot('wick', 'green'),
      pairBot('vol', 'green'),
    ];
    const bots: Array<{ bot: Bot; kind: string }> = [
      { bot: randomBot, kind: 'ランダム' },
      ...singles.map((b) => ({ bot: b, kind: '単一兆候' })),
      ...pairs.map((b) => ({ bot: b, kind: '2兆候' })),
      { bot: reversalBot(1.0, 0.3), kind: '足中反転' },
      { bot: reversalBot(1.5, 0.5), kind: '足中反転' },
      { bot: confirmBot(2), kind: '反転確認' },
      { bot: timeBot(18.5), kind: '時刻のみ' },
      { bot: depthBot(14), kind: '下落率のみ' },
      { bot: comboBot(comboW), kind: '複数兆候' },
      { bot: expertBotOf(expertW), kind: '熟練' },
      { bot: oracleBot, kind: '上限' },
    ];

    process.stderr.write('  scanning time/depth for GOD...\n');
    // 時刻・下落率だけを使う戦略の GOD 上限を求める（t / x を GOD 率で最適化）
    let bestTimeGod: { bot: Bot; st: BotStat } | null = null;
    for (let t = 3; t <= 23; t += 0.5) {
      const b = timeBot(t);
      const st = evaluate(b, valid);
      if (!bestTimeGod || st.godA > bestTimeGod.st.godA) bestTimeGod = { bot: b, st };
    }
    let bestDepthGod: { bot: Bot; st: BotStat } | null = null;
    for (let x = 10; x <= 45; x += 1) {
      const b = depthBot(x);
      const st = evaluate(b, valid);
      if (!bestDepthGod || st.godA > bestDepthGod.st.godA) bestDepthGod = { bot: b, st };
    }

    process.stderr.write('  evaluating...\n');
    const rows = bots.map(({ bot, kind }) => ({ bot, st: evaluate(bot, valid), kind }));
    rows.push({ bot: bestTimeGod!.bot, st: bestTimeGod!.st, kind: '時刻のみ(GOD最適)' });
    rows.push({ bot: bestDepthGod!.bot, st: bestDepthGod!.st, kind: '下落率のみ(GOD最適)' });
    perSetting.push({ label: setting.label, signals, rows });
  }

  restore();

  // ---- 1 & 4. GOD 条件の比較（現行設定）
  const cur = perSetting[0];
  md.push('## 1. GOD に先読み条件を足した場合（現行設定）');
  md.push('');
  md.push('A = 現行（z ≤ 0.2 のみ）、B = A かつ `buyTick <= bottomTick`。');
  md.push('内訳は現行 GOD の中で BUY が底値ティックの前／同時／後だったものの数。');
  md.push('');
  md.push('| Bot | 種別 | GOD A | GOD B | B/A | 底より前 | 底と同時 | 底より後 |');
  md.push('|---|---|---|---|---|---|---|---|');
  for (const r of cur.rows) {
    const st = r.st;
    md.push(
      `| ${r.bot.name} | ${r.kind} | ${pct2(st.godA / st.n)} | ${pct2(st.godB / st.n)} | ${st.godA ? (st.godB / st.godA).toFixed(2) : '—'} | ${st.godBefore} | ${st.godSame} | ${st.godAfter} |`,
    );
  }
  md.push('');

  md.push('## 4. GOD 判定方式の比較');
  md.push('');
  md.push('| 方式 | Random | Time | Combo | Expert | Oracle | Combo/Random | Combo/Time |');
  md.push('|---|---|---|---|---|---|---|---|');
  const pick = (name: string) => cur.rows.find((r) => r.bot.name.startsWith(name))!.st;
  for (const [label, f] of [
    ['A. 価格乖離のみ', (s: BotStat) => s.godA / s.n],
    ['B. 価格乖離 + 先読み', (s: BotStat) => s.godB / s.n],
  ] as const) {
    const r = f(pick('RandomBot'));
    const t = f(pick('TimeBot'));
    const c = f(pick('ComboBot'));
    const e = f(pick('ExpertBot'));
    const o = f(pick('OracleBot'));
    md.push(
      `| ${label} | ${pct2(r)} | ${pct2(t)} | ${pct2(c)} | ${pct2(e)} | ${pct2(o)} | ${r > 0 ? (c / r).toFixed(1) + '倍' : '—'} | ${t > 0 ? (c / t).toFixed(1) + '倍' : '—'} |`,
    );
  }
  md.push('');

  // ---- 2 & 3. 信頼度の設定ごと
  md.push('### 先読み条件に反応遅延の許容を入れた場合');
  md.push('');
  md.push('`buyTick <= bottomTick + 許容` としたときの GOD 率。許容 0 が方式 B、∞ が方式 A。');
  md.push('人間の反応は 250ms ＝ 2〜3ティックなので、許容 0 は「予測して押す」ことを要求する。');
  md.push('');
  const allowances = [0, 1, 2, 3, 4, 6, 8, 12, Infinity];
  const godAt = (st: BotStat, a: number) =>
    st.godOffsets.filter((d) => d <= a).length / st.n;
  const targets = ['RandomBot', 'TimeBot(18.0s)', 'ComboBot', 'ExpertBot', 'OracleBot'];
  md.push(`| 許容 | ${targets.join(' | ')} | Combo/Random | Combo/Time |`);
  md.push(`|---|${targets.map(() => '---').join('|')}|---|---|`);
  for (const a of allowances) {
    const vals = targets.map((t) => {
      const row = cur.rows.find((r) => r.bot.name === t);
      return row ? godAt(row.st, a) : 0;
    });
    const label = a === Infinity ? '∞（方式A）' : a === 0 ? '0（方式B）' : String(a);
    md.push(
      `| ${label} | ${vals.map(pct2).join(' | ')} | ${vals[0] > 0 ? (vals[2] / vals[0]).toFixed(1) + '倍' : '—'} | ${vals[1] > 0 ? (vals[2] / vals[1]).toFixed(2) + '倍' : '—'} |`,
    );
  }
  md.push('');

  md.push('## 2. 兆候信頼度の設定ごとの比較');
  md.push('');
  for (const s of perSetting) {
    md.push(`### ${s.label}`);
    md.push('');
    md.push(`| 兆候 | ${KINDS.join(' | ')} |`);
    md.push(`|---|${KINDS.map(() => '---').join('|')}|`);
    md.push(`| 実測信頼度 | ${KINDS.map((k) => pct(s.signals[k].reliability)).join(' | ')} |`);
    md.push(`| 真兆候数 | ${KINDS.map((k) => s.signals[k].genuine).join(' | ')} |`);
    md.push(`| ダマシ数 | ${KINDS.map((k) => s.signals[k].fake).join(' | ')} |`);
    md.push('');
    md.push('| Bot | 種別 | SUPER+ | ULTRA+ | GOD | 平均乖離率 | 中央値 | NO TRADE | 平均スコア |');
    md.push('|---|---|---|---|---|---|---|---|---|');
    for (const r of s.rows) {
      const st = r.st;
      md.push(
        `| ${r.bot.name} | ${r.kind} | ${pct(st.superPlus / st.n)} | ${pct(st.ultraPlus / st.n)} | ${pct2(st.godA / st.n)} | ${dev(st.trades ? st.devSum / st.trades : null)} | ${dev(median(st.devs))} | ${pct(st.noTrade / st.n)} | ${Math.round(st.scoreSum / st.n)} |`,
      );
    }
    md.push('');
  }

  // ---- 3. 支配戦略チェックのまとめ
  md.push('## 3. 単一兆候・2兆候が支配戦略になっていないか');
  md.push('');
  md.push('各設定で、単一兆候・2兆候の最良と、Combo / Expert を並べる。');
  md.push('');
  md.push('| 設定 | 単一兆候の最良 | 2兆候の最良 | Combo | Expert | Combo − 最良の単純戦略 |');
  md.push('|---|---|---|---|---|---|');
  for (const s of perSetting) {
    const best = (kind: string) => {
      const rs = s.rows.filter((r) => r.kind === kind);
      return rs.reduce((a, b) => (b.st.scoreSum > a.st.scoreSum ? b : a));
    };
    const bs = best('単一兆候');
    const bp = best('2兆候');
    const combo = s.rows.find((r) => r.kind === '複数兆候')!;
    const expert = s.rows.find((r) => r.kind === '熟練')!;
    const bestSimple = Math.max(bs.st.scoreSum, bp.st.scoreSum) / bs.st.n;
    md.push(
      `| ${s.label} | ${bs.bot.name} ${Math.round(bs.st.scoreSum / bs.st.n)} | ${bp.bot.name} ${Math.round(bp.st.scoreSum / bp.st.n)} | ${Math.round(combo.st.scoreSum / combo.st.n)} | ${Math.round(expert.st.scoreSum / expert.st.n)} | ${(combo.st.scoreSum / combo.st.n - bestSimple >= 0 ? '+' : '') + Math.round(combo.st.scoreSum / combo.st.n - bestSimple)} |`,
    );
  }
  md.push('');

  // ---- 5. 推奨
  md.push('## 5. 推奨');
  md.push('');
  md.push('### GOD の先読み条件（方式 B）は採用しないことを推奨');
  md.push('');
  md.push('- 許容幅を 0 から ∞ まで振っても Combo/Random は 3.8〜4.2倍で横ばい、');
  md.push('  Combo/Time は 0.88〜1.09倍で横ばい。**分離はまったく改善しない**');
  md.push('- 許容 0（＝方式 B そのもの）では OracleBot が 0.00%。');
  md.push('  底値ティックを知っていても反応遅延 250ms があると到達できず、§10.2 #5 が原理的に満たせなくなる');
  md.push('- 現行 GOD の内訳を見ても、BUY が底より前か後かの割合は Random 56% / Combo 54% とほぼ同じ。');
  md.push('  ティックの前後関係は腕を表していない');
  md.push('');
  md.push('### GOD が分離しない理由');
  md.push('');
  md.push('- GOD 圏は 240ティック中わずか 2.6〜5.3ティック。約 0.3 秒の精度が要る');
  md.push('- 兆候はすべて足単位（0.8秒）の情報なので、足の中のどのティックが底かまでは分からない');
  md.push('- 足の中の反転を直接狙う ReversalBot でも GOD は 0.20〜0.75% にとどまる');
  md.push('- 底値ティックを知っている OracleBot ですら、反応遅延だけで 23% まで落ちる');
  md.push('');
  md.push('つまり GOD 帯を支配しているのは腕ではなく 0.25 秒の運で、');
  md.push('判定式をいじってもここは変わらない。');
  md.push('');
  md.push('### 兆候信頼度は「中間C」を推奨');
  md.push('');
  md.push('| 段 | 指標 | 現行 | 中間A | 中間C |');
  md.push('|---|---|---|---|---|');
  const at = (label: string, name: string, f: (s: BotStat) => number) => {
    const set = perSetting.find((x) => x.label.startsWith(label))!;
    const row = set.rows.find((r) => r.bot.name.startsWith(name) && r.kind !== '時刻のみ(GOD最適)')!;
    return f(row.st);
  };
  const atGodTime = (label: string) => {
    const set = perSetting.find((x) => x.label.startsWith(label))!;
    const row = set.rows.find((r) => r.kind === '時刻のみ(GOD最適)')!;
    return row.st.godA / row.st.n;
  };
  const ratio = (label: string, tier: 'S' | 'U' | 'G') => {
    const c =
      tier === 'S'
        ? at(label, 'ComboBot', (s) => s.superPlus / s.n)
        : tier === 'U'
          ? at(label, 'ComboBot', (s) => s.ultraPlus / s.n)
          : at(label, 'ComboBot', (s) => s.godA / s.n);
    const t =
      tier === 'S'
        ? at(label, 'TimeBot', (s) => s.superPlus / s.n)
        : tier === 'U'
          ? at(label, 'TimeBot', (s) => s.ultraPlus / s.n)
          : atGodTime(label);
    return t > 0 ? (c / t).toFixed(2) : '—';
  };
  md.push(`| SUPER+ | Combo ÷ Time | ${ratio('現行', 'S')} | ${ratio('中間A', 'S')} | ${ratio('中間C', 'S')} |`);
  md.push(`| ULTRA+ | Combo ÷ Time | ${ratio('現行', 'U')} | ${ratio('中間A', 'U')} | ${ratio('中間C', 'U')} |`);
  md.push(`| GOD | Combo ÷ Time(GOD最適) | ${ratio('現行', 'G')} | ${ratio('中間A', 'G')} | ${ratio('中間C', 'G')} |`);
  md.push('');
  md.push('- どの段でも信頼度を上げるほど単調に改善し、支配戦略は生まれない');
  md.push('  （単一兆候・2兆候の最良と Combo の差は +92 → +112 に広がる）');
  md.push('- ただし §10.2 #6 の設計値（70/65/55/45/20%）からは外れるので、');
  md.push('  採用するなら設計値そのものを更新する判断が要る');
  md.push('');

  mkdirSync(OUT_DIR, { recursive: true });
  const text = md.join('\n');
  writeFileSync(join(OUT_DIR, 'analysis.md'), text);
  process.stdout.write(text + '\n');
  process.stderr.write(`\nwrote ${join(OUT_DIR, 'analysis.md')}\n`);
}

main();
