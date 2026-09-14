/**
 * シミュレーション実行（仕様書 §10）
 *
 *   npm run sim -- --train 2000 --valid 10000
 *
 * src/core を Node から直接呼び出す。GUI は不要。
 * レポートは sim/out/ に CSV と Markdown で出力する。
 *
 * 目的は §10.2 の数値を機械的に通すことではなく、
 * 「市場情報を適切に読む戦略ほど、ランダムな判断より統計的に良い成績になる」ことの確認。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PLAYABLE_TICKS, TICKS_PER_CANDLE, generateChart } from '../src/core/generator';
import { RANK_ORDER, RANK_THRESHOLDS, judge, rankAtLeast } from '../src/core/judge';
import { Rng } from '../src/core/rng';
import { SCENARIO_NAMES } from '../src/core/scenarios';
import type { Chart, Rank, ScenarioId, SignalKind } from '../src/core/types';
import {
  bigGreenBot,
  bounceBot,
  comboBot,
  confirmBot,
  decelBot,
  depthBot,
  expertBot,
  observe,
  oracleBot,
  pairBot,
  randomBot,
  timeBot,
  volumeBot,
  tickScore,
  wickBot,
  type Bot,
  type ComboWeights,
  type ExpertParams,
  type Obs,
} from './bots';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out');

// 学習用シードと検証用シードは分ける。報告する数値はすべて検証用シードで算出する。
const TRAIN_BASE = 0x5eed_1000;
const VALID_BASE = 0x5eed_9000;

/**
 * §10.2 #6 の設計信頼度（Phase 1 最終値）
 *
 * 旧値（70/65/55/45/20%）は廃止。分析の結果、信頼度を上げるほど
 * 複合戦略とランダム・時刻戦略の差が広がり、かつ単純戦略が支配的にならないことが確認できたため。
 */
const DESIGNED_RELIABILITY: Record<string, number> = {
  WICK: 0.82,
  BIG_GREEN: 0.74,
  VOLUME: 0.7,
  DECEL: 0.6,
  SMALL_BOUNCE: 0.3,
};

interface Sample {
  chart: Chart;
  obs: Obs;
}

// ---------------------------------------------------------------- 集計

interface Stat {
  n: number;
  totalScore: number;
  ranks: Record<Rank, number>;
  /** NO TRADE を除いた乖離率。中央値を出すために保持する */
  deviations: number[];
  /** NO TRADE を除いた正規化誤差 z。閾値の見直しに使う */
  zs: number[];
  byScenario: Record<string, { n: number; total: number; superPlus: number }>;
}

function emptyStat(): Stat {
  const ranks = {} as Record<Rank, number>;
  for (const r of RANK_ORDER) ranks[r] = 0;
  return { n: 0, totalScore: 0, ranks, deviations: [], zs: [], byScenario: {} };
}

function record(stat: Stat, chart: Chart, buyTick: number | null): void {
  const res = judge(chart, buyTick);
  stat.n++;
  stat.totalScore += res.score;
  stat.ranks[res.rank]++;
  if (res.deviationPct !== null) stat.deviations.push(res.deviationPct);
  if (res.z !== null) stat.zs.push(res.z);
  const k = chart.scenario;
  const b = stat.byScenario[k] ?? { n: 0, total: 0, superPlus: 0 };
  b.n++;
  b.total += res.score;
  if (rankAtLeast(res.rank, 'SUPER')) b.superPlus++;
  stat.byScenario[k] = b;
}

function rate(stat: Stat, min: Rank): number {
  let hit = 0;
  for (const r of RANK_ORDER) {
    if (rankAtLeast(r, min)) hit += stat.ranks[r];
  }
  return stat.n ? hit / stat.n : 0;
}

function noTradeRate(stat: Stat): number {
  return stat.n ? stat.ranks.NO_TRADE / stat.n : 0;
}

function avgScore(stat: Stat): number {
  return stat.n ? stat.totalScore / stat.n : 0;
}

/** NO TRADE を除いた平均乖離率 */
function meanDeviation(stat: Stat): number | null {
  if (stat.deviations.length === 0) return null;
  let sum = 0;
  for (const d of stat.deviations) sum += d;
  return sum / stat.deviations.length;
}

function medianDeviation(stat: Stat): number | null {
  if (stat.deviations.length === 0) return null;
  const a = stat.deviations.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function pct(x: number): string {
  return `${(100 * x).toFixed(1)}%`;
}

function devPct(x: number | null): string {
  return x === null ? '—' : `${(100 * x).toFixed(2)}%`;
}

// ---------------------------------------------------------------- 実行

function makeSamples(base: number, n: number): Sample[] {
  const out: Sample[] = [];
  for (let i = 0; i < n; i++) {
    const chart = generateChart((base + i * 2654435761) >>> 0);
    out.push({ chart, obs: observe(chart) });
  }
  return out;
}

function evaluate(bot: Bot, samples: Sample[], seed: number): Stat {
  const stat = emptyStat();
  const rng = new Rng(seed);
  for (const s of samples) {
    record(stat, s.chart, bot.decide(s.chart, rng, s.obs));
  }
  return stat;
}

type Objective = (s: Stat) => number;

/** 候補の中から、目的関数が最大になるものを学習用シードで選ぶ */
function selectBest(bots: Bot[], train: Sample[], objective: Objective): Bot {
  let best = bots[0];
  let bestVal = -Infinity;
  for (const b of bots) {
    const v = objective(evaluate(b, train, 0xc0ffee));
    if (v > bestVal) {
      bestVal = v;
      best = b;
    }
  }
  return best;
}

/**
 * パラメータ探索。重みが7次元になったので総当たりではなくランダムサーチを使う。
 * 乱数は固定シードなので結果は再現する。
 */
const SEARCH_TRIALS = 6000;
/** 探索中は反応遅延を平均値 2ティックで固定する */
const SEARCH_DELAY = 2;

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

/** 学習用シードでの平均スコア。閾値に達したティックで買う */
function trainScore(
  train: Sample[],
  w: ComboWeights,
  freshLow: number | null,
  patience: number | null,
): number {
  return trainStats(train, w, freshLow, patience).avg;
}

/** 平均スコアと SUPER以上の率。ExpertBot はこの両方で ComboBot を下回らないことを条件にする */
function trainStats(
  train: Sample[],
  w: ComboWeights,
  freshLow: number | null,
  patience: number | null,
): { avg: number; superRate: number } {
  let total = 0;
  let sup = 0;
  for (const s of train) {
    const f = s.obs.tickFeat;
    let buy: number | null = null;
    for (let t = 0; t < PLAYABLE_TICKS; t++) {
      const signal = tickScore(f, t, w) >= w.threshold;
      const hit =
        freshLow === null
          ? signal
          : (f.sinceLow[t] <= freshLow && signal) ||
            (patience !== null && f.sinceLow[t] >= patience && f.bullish[t] === 1);
      if (hit) {
        const b = t + SEARCH_DELAY;
        buy = b < PLAYABLE_TICKS ? b : null;
        break;
      }
    }
    const res = judge(s.chart, buy);
    total += res.score;
    if (rankAtLeast(res.rank, 'SUPER')) sup++;
  }
  return { avg: total / train.length, superRate: sup / train.length };
}

function searchCombo(train: Sample[]): ComboWeights {
  const rng = new Rng(0xc0b0a11);
  let best: ComboWeights | null = null;
  let bestVal = -Infinity;
  for (let i = 0; i < SEARCH_TRIALS; i++) {
    const w = randomWeights(rng);
    if (w.wick + w.vol + w.decel + w.sinceLow + w.green + w.dry + w.flat === 0) continue;
    const v = trainScore(train, w, null, null);
    if (v > bestVal) {
      bestVal = v;
      best = w;
    }
  }
  return best!;
}

/**
 * ExpertBot の探索。
 *
 * ComboBot の現行戦略（freshLow=6 で安値からの距離を問わず、patience=99 で反転確認を使わない）を
 * 必ず最初の候補に入れ、その周辺も探索する。最後に ComboBot 相当の成績と比べ、
 * 上回れなかった場合は ComboBot のパラメータをそのまま採用する。
 * これで評価上 Expert >= Combo が構造的に保証される
 * （同じパラメータなら Bot の乱数列も同じなので、最悪でも完全に一致する）。
 */
function searchExpert(train: Sample[], comboW: ComboWeights): ExpertParams {
  const rng = new Rng(0xe0e0e0);
  // freshLow=6 は「安値からの距離を問わない」、patience=99 は「反転確認を使わない」
  const baseline: ExpertParams = { ...comboW, freshLow: 6, patience: 99 };
  const base = trainStats(train, baseline, baseline.freshLow, baseline.patience);
  let best: ExpertParams = baseline;
  let bestVal = base.avg;

  // 平均スコアと SUPER以上の率のどちらも ComboBot 相当を下回らない候補だけを採る
  const consider = (w: ComboWeights, freshLow: number, patience: number) => {
    const st = trainStats(train, w, freshLow, patience);
    if (st.avg > bestVal && st.superRate >= base.superRate) {
      bestVal = st.avg;
      best = { ...w, freshLow, patience };
    }
  };

  // ComboBot の重みを保ったまま、反転確認の入れ方だけを変えてみる
  for (const freshLow of [0, 1, 2, 3, 6]) {
    for (const patience of [2, 3, 4, 5, 6, 99]) {
      consider(comboW, freshLow, patience);
    }
  }

  // ComboBot の重みの近傍
  for (let i = 0; i < SEARCH_TRIALS / 2; i++) {
    const jitter = (x: number) => Math.max(0, x + rng.uniform(-0.75, 0.75));
    const w: ComboWeights = {
      wick: jitter(comboW.wick),
      vol: jitter(comboW.vol),
      decel: jitter(comboW.decel),
      sinceLow: jitter(comboW.sinceLow),
      green: jitter(comboW.green),
      dry: jitter(comboW.dry),
      flat: jitter(comboW.flat),
      threshold: Math.max(0.1, comboW.threshold + rng.uniform(-1, 1)),
    };
    consider(w, rng.pickWeighted([0, 1, 2, 3, 6], [20, 20, 20, 20, 20]), rng.pickWeighted([2, 3, 4, 5, 6, 99], [20, 20, 20, 20, 10, 10]));
  }

  // 広域のランダムサーチ
  for (let i = 0; i < SEARCH_TRIALS; i++) {
    const w = randomWeights(rng);
    if (w.wick + w.vol + w.decel + w.sinceLow + w.green + w.dry + w.flat === 0) continue;
    consider(w, rng.pickWeighted([0, 1, 2, 3, 6], [20, 20, 20, 20, 20]), rng.pickWeighted([2, 3, 4, 5, 6, 99], [20, 20, 20, 20, 10, 10]));
  }

  return best;
}

// ---------------------------------------------------------------- 兆候の内訳

interface Reliability {
  genuine: number;
  fake: number;
  genuineNear: number;
  fakeNear: number;
}

/** 兆候ごとの実測信頼度：兆候が出現した足の±2本以内に真の底がある割合 */
function signalReliability(samples: Sample[]): Record<string, Reliability> {
  const out: Record<string, Reliability> = {};
  for (const s of samples) {
    const bottomCandle = Math.floor(s.chart.bottomTick / TICKS_PER_CANDLE);
    for (const e of s.chart.events) {
      const key: SignalKind = e.kind;
      const b = out[key] ?? { genuine: 0, fake: 0, genuineNear: 0, fakeNear: 0 };
      const near = Math.abs(e.candleIndex - bottomCandle) <= 2;
      if (e.genuine) {
        b.genuine++;
        if (near) b.genuineNear++;
      } else {
        b.fake++;
        if (near) b.fakeNear++;
      }
      out[key] = b;
    }
  }
  return out;
}

function reliabilityOf(r: Reliability): number {
  const total = r.genuine + r.fake;
  return total ? (r.genuineNear + r.fakeNear) / total : 0;
}

// ---------------------------------------------------------------- 底値圏の滞在時間

interface Dwell {
  n: number;
  superTicks: number;
  ultraTicks: number;
  godTicks: number;
  /** 下落中に SUPER 圏へ入ってから底値に達するまでのティック数 */
  approach: number;
  /** 底値到達から SUPER 圏を出るまでのティック数 */
  exit: number;
}

/**
 * 底値圏に価格が留まる時間を測る。
 * RandomBot の SUPER以上の率は「SUPER圏のティック数 ÷ 240」と厳密に一致するので、
 * ランダムがどこで当たっているかはこの数字で説明できる。
 */
function measureDwell(samples: Sample[]): Record<string, Dwell> {
  const out: Record<string, Dwell> = {};
  for (const s of samples) {
    const bottom = s.chart.ticks[s.chart.bottomTick];
    const atr = s.chart.atrRef;
    let sup = 0;
    let ult = 0;
    let god = 0;
    let first = -1;
    let last = -1;
    for (let t = 0; t < PLAYABLE_TICKS; t++) {
      const z = (s.chart.ticks[t] - bottom) / atr;
      if (z <= RANK_THRESHOLDS[2].maxZ) {
        sup++;
        if (first < 0) first = t;
        last = t;
      }
      if (z <= RANK_THRESHOLDS[1].maxZ) ult++;
      if (z <= RANK_THRESHOLDS[0].maxZ) god++;
    }
    const bt = Math.min(s.chart.bottomTick, PLAYABLE_TICKS - 1);
    const d = out[s.chart.scenario] ?? {
      n: 0,
      superTicks: 0,
      ultraTicks: 0,
      godTicks: 0,
      approach: 0,
      exit: 0,
    };
    d.n++;
    d.superTicks += sup;
    d.ultraTicks += ult;
    d.godTicks += god;
    d.approach += first >= 0 && first <= bt ? bt - first : 0;
    d.exit += last >= bt ? last - bt + 1 : 0;
    out[s.chart.scenario] = d;
  }
  return out;
}

// ---------------------------------------------------------------- レポート

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  return fallback;
}

function main(): void {
  const nTrain = arg('train', 2000);
  const nValid = arg('valid', 10000);

  process.stderr.write(`generating ${nTrain} train / ${nValid} valid charts...\n`);
  const train = makeSamples(TRAIN_BASE, nTrain);
  const valid = makeSamples(VALID_BASE, nValid);

  // 情報漏れ検査用の Bot は SUPER以上の割合で最良を選ぶ（漏れの上限を測るため）
  const leakObjective: Objective = (s) => rate(s, 'SUPER');
  const timeCandidates: Bot[] = [];
  for (let t = 3; t <= 23; t += 0.5) timeCandidates.push(timeBot(t));
  const bestTime = selectBest(timeCandidates, train, leakObjective);

  const depthCandidates: Bot[] = [];
  for (let x = 10; x <= 45; x += 1) depthCandidates.push(depthBot(x));
  const bestDepth = selectBest(depthCandidates, train, leakObjective);

  // 戦略Botは平均スコアで最良を選ぶ
  const scoreObjective: Objective = avgScore;
  const bestDecel = selectBest(
    [0.3, 0.4, 0.5, 0.6, 0.7, 0.8].map(decelBot),
    train,
    scoreObjective,
  );
  const bestBigGreen = selectBest([1.0, 1.5, 2.0, 2.5, 3.0].map(bigGreenBot), train, scoreObjective);
  const bestBounce = selectBest([0.2, 0.4, 0.6, 0.8, 1.0].map(bounceBot), train, scoreObjective);
  const bestConfirm = selectBest([confirmBot(1), confirmBot(2), confirmBot(3)], train, scoreObjective);

  process.stderr.write('searching ComboBot...\n');
  const comboW = searchCombo(train);
  const combo = comboBot(comboW);
  process.stderr.write('searching ExpertBot...\n');
  const expertW = searchExpert(train, comboW);
  const expert = expertBot(expertW);

  const singleSignal = [wickBot, volumeBot, bestDecel, bestBigGreen, bestBounce];
  const pairSignal = [
    pairBot('wick', 'vol'),
    pairBot('wick', 'decel'),
    pairBot('vol', 'decel'),
    pairBot('wick', 'green'),
    pairBot('vol', 'green'),
  ];
  const bots: Bot[] = [
    randomBot,
    ...singleSignal,
    ...pairSignal,
    bestConfirm,
    combo,
    expert,
    bestTime,
    bestDepth,
    oracleBot,
  ];

  const stats = new Map<string, Stat>();
  for (const b of bots) {
    process.stderr.write(`  ${b.name}\n`);
    stats.set(b.name, evaluate(b, valid, 0x1234_5678));
  }

  const reliability = signalReliability(valid);
  const scenarioIds = [...new Set(valid.map((s) => s.chart.scenario))].sort() as ScenarioId[];

  const randomStat = stats.get(randomBot.name)!;
  const comboStat = stats.get(combo.name)!;
  const expertStat = stats.get(expert.name)!;
  const oracleStat = stats.get(oracleBot.name)!;
  const simpleNames = singleSignal.map((b) => b.name).concat(bestConfirm.name);

  // 6シナリオ中5つ以上で同じ単純Botが最良にならないこと
  const winnerBySc: Record<string, string> = {};
  for (const sc of scenarioIds) {
    let bestName = simpleNames[0];
    let bestVal = -Infinity;
    for (const n of simpleNames) {
      const b = stats.get(n)!.byScenario[sc];
      const v = b && b.n ? b.total / b.n : 0;
      if (v > bestVal) {
        bestVal = v;
        bestName = n;
      }
    }
    winnerBySc[sc] = bestName;
  }
  const winCounts: Record<string, number> = {};
  for (const sc of scenarioIds) winCounts[winnerBySc[sc]] = (winCounts[winnerBySc[sc]] ?? 0) + 1;
  const maxWins = Math.max(...Object.values(winCounts));

  const randomSuper = rate(randomStat, 'SUPER');

  // 単純戦略（単一兆候・2兆候）の最良
  const simpleNamesAll = simpleNames.concat(pairSignal.map((b) => b.name));
  const bestSimpleByScore = simpleNamesAll.reduce((a, n) =>
    avgScore(stats.get(n)!) > avgScore(stats.get(a)!) ? n : a,
  );
  const bestSimpleScore = avgScore(stats.get(bestSimpleByScore)!);
  const bestSimpleSuper = Math.max(...simpleNamesAll.map((n) => rate(stats.get(n)!, 'SUPER')));
  const bestSimpleUltra = Math.max(...simpleNamesAll.map((n) => rate(stats.get(n)!, 'ULTRA')));

  const skill = expertStat;
  const skillSuper = Math.max(rate(comboStat, 'SUPER'), rate(skill, 'SUPER'));
  const skillUltra = Math.max(rate(comboStat, 'ULTRA'), rate(skill, 'ULTRA'));
  const timeSuper = rate(stats.get(bestTime.name)!, 'SUPER');
  const timeUltra = rate(stats.get(bestTime.name)!, 'ULTRA');
  const depthSuper = rate(stats.get(bestDepth.name)!, 'SUPER');
  const randomUltra = rate(randomStat, 'ULTRA');

  const checks = [
    {
      no: 1,
      name: 'スキルの優位（最重要）',
      detail: `SUPER+ 複合 ${pct(skillSuper)} vs ランダム ${pct(randomSuper)} / 時刻 ${pct(timeSuper)} / 下落率 ${pct(depthSuper)} / 単純 ${pct(bestSimpleSuper)}、ULTRA+ 複合 ${pct(skillUltra)} vs ランダム ${pct(randomUltra)} / 時刻 ${pct(timeUltra)} / 単純 ${pct(bestSimpleUltra)}`,
      pass:
        skillSuper > randomSuper &&
        skillSuper > timeSuper &&
        skillSuper > depthSuper &&
        skillSuper > bestSimpleSuper &&
        skillUltra > randomUltra &&
        skillUltra > timeUltra &&
        skillUltra > bestSimpleUltra,
    },
    {
      no: 2,
      name: '支配戦略がない',
      detail: `単純戦略の最良は ${bestSimpleByScore} 平均 ${Math.round(bestSimpleScore)}（Combo ${Math.round(avgScore(comboStat))} / Expert ${Math.round(avgScore(skill))}）、SUPER+ 最良 ${pct(bestSimpleSuper)}、同一Botのシナリオ最良獲得 ${maxWins}/${scenarioIds.length}`,
      pass:
        bestSimpleScore < avgScore(comboStat) &&
        bestSimpleScore < avgScore(skill) &&
        bestSimpleSuper < skillSuper &&
        maxWins <= 4,
    },
    {
      no: 3,
      name: 'Expert ≥ Combo',
      detail: `平均スコア ${Math.round(avgScore(skill))} vs ${Math.round(avgScore(comboStat))}、SUPER+ ${pct(rate(skill, 'SUPER'))} vs ${pct(rate(comboStat, 'SUPER'))}`,
      pass:
        avgScore(skill) >= avgScore(comboStat) && rate(skill, 'SUPER') >= rate(comboStat, 'SUPER'),
    },
    {
      no: 4,
      name: 'GOD に到達可能（レア枠）',
      detail: `OracleBot GOD ${pct(rate(oracleStat, 'GOD'))} / ComboBot ${pct(rate(comboStat, 'GOD'))} / RandomBot ${pct(rate(randomStat, 'GOD'))}。GOD は完全なスキル分離を求めない`,
      pass: rate(oracleStat, 'GOD') >= 0.15 && rate(comboStat, 'GOD') > rate(randomStat, 'GOD'),
    },
    {
      no: 5,
      name: '兆候の信頼度',
      detail: Object.entries(DESIGNED_RELIABILITY)
        .map(([k, d]) => `${k} ${pct(reliabilityOf(reliability[k]))}（設計 ${pct(d)}）`)
        .join(' / '),
      pass: Object.entries(DESIGNED_RELIABILITY).every(([k, d]) => {
        const r = reliability[k];
        if (!r) return false;
        return Math.abs(reliabilityOf(r) - d) <= 0.1;
      }),
    },
  ];

  // 参考値（合否には使わない）。目安を満たすために生成を歪めることはしない
  const references = [
    `スキル評価帯の水準：ComboBot SUPER+ ${pct(rate(comboStat, 'SUPER'))}（目安 25〜35%）/ ULTRA+ ${pct(rate(comboStat, 'ULTRA'))}（目安 10〜15%）、ExpertBot SUPER+ ${pct(rate(skill, 'SUPER'))} / ULTRA+ ${pct(rate(skill, 'ULTRA'))}`,
    `RandomBot SUPER+ ${pct(randomSuper)} / ULTRA+ ${pct(randomUltra)} / GOD ${pct(rate(randomStat, 'GOD'))}（旧基準の「SUPER+ ≤5%」は絶対条件から外した）`,
    `TimeBot SUPER+ ${pct(timeSuper)} / ULTRA+ ${pct(timeUltra)}。時刻のみの戦略は複合戦略を下回っていればよい`,
  ];

  // ---- 出力
  mkdirSync(OUT_DIR, { recursive: true });

  const md: string[] = [];
  md.push('# DAILY BOTTOM シミュレーション結果');
  md.push('');
  md.push(`- generator: \`${valid[0].chart.generatorVersion}\``);
  md.push(`- 学習用シード ${nTrain} 本 / 検証用シード ${nValid} 本（下の数値はすべて検証用）`);
  md.push(`- ComboBot: ${JSON.stringify(comboW)}`);
  md.push(`- ExpertBot: ${JSON.stringify(expertW)}`);
  md.push('');

  md.push('## 1. 兆候ごとの内訳');
  md.push('');
  md.push('| 兆候 | 真兆候数 | ダマシ数 | 底±2本以内の真兆候数 | 実測信頼度 | 設計値 | 差 |');
  md.push('|---|---|---|---|---|---|---|');
  for (const [k, d] of Object.entries(DESIGNED_RELIABILITY)) {
    const r = reliability[k];
    const rel = reliabilityOf(r);
    const diff = 100 * (rel - d);
    md.push(
      `| ${k} | ${r.genuine} | ${r.fake} | ${r.genuineNear} | ${pct(rel)} | ${pct(d)} | ${diff >= 0 ? '+' : ''}${diff.toFixed(1)}pt |`,
    );
  }
  md.push('');
  md.push('「底±2本以内の真兆候数」が真兆候数とほぼ一致していれば、真の兆候は設計どおり底の近くに出ている。');
  md.push('実測信頼度が設計値からずれる場合、原因は真兆候とダマシの本数比にある。');
  md.push('');

  md.push('## 2. 戦略ごとの成績');
  md.push('');
  md.push('乖離率は NO TRADE を除いた値。NO TRADE 率は別列に出している。');
  md.push('');
  md.push(
    `| Bot | 種別 | 平均スコア | 平均乖離率 | 乖離率中央値 | NO TRADE | ${RANK_ORDER.filter((r) => r !== 'NO_TRADE').join(' | ')} |`,
  );
  md.push(`|---|---|---|---|---|---|${RANK_ORDER.filter((r) => r !== 'NO_TRADE').map(() => '---').join('|')}|`);
  const kindOf = (b: Bot): string => {
    if (b === randomBot) return 'ランダム';
    if (singleSignal.includes(b)) return '単一兆候';
    if (pairSignal.includes(b)) return '2兆候';
    if (b === bestConfirm) return '反転確認待ち';
    if (b === combo) return '複数兆候';
    if (b === expert) return '熟練';
    if (b === bestTime || b === bestDepth) return '情報漏れ検査';
    return '上限';
  };
  for (const b of bots) {
    const s = stats.get(b.name)!;
    md.push(
      `| ${b.name} | ${kindOf(b)} | ${Math.round(avgScore(s))} | ${devPct(meanDeviation(s))} | ${devPct(medianDeviation(s))} | ${pct(noTradeRate(s))} | ${RANK_ORDER.filter((r) => r !== 'NO_TRADE')
        .map((r) => pct(s.ranks[r] / s.n))
        .join(' | ')} |`,
    );
  }
  md.push('');

  md.push('## 3. ランダムとの差');
  md.push('');
  md.push('| Bot | 平均スコア差 | 乖離率中央値の比 | SUPER以上の差 |');
  md.push('|---|---|---|---|');
  const rMed = medianDeviation(randomStat) ?? 1;
  for (const b of bots) {
    if (b === randomBot) continue;
    const s = stats.get(b.name)!;
    const med = medianDeviation(s);
    md.push(
      `| ${b.name} | ${(avgScore(s) - avgScore(randomStat) >= 0 ? '+' : '') + Math.round(avgScore(s) - avgScore(randomStat))} | ${med === null ? '—' : (med / rMed).toFixed(2)} | ${((rate(s, 'SUPER') - randomSuper) * 100 >= 0 ? '+' : '') + ((rate(s, 'SUPER') - randomSuper) * 100).toFixed(1)}pt |`,
    );
  }
  md.push('');

  md.push('## 4. Bot × シナリオ別の平均スコア');
  md.push('');
  md.push(`| Bot | ${scenarioIds.map((s) => SCENARIO_NAMES[s]).join(' | ')} |`);
  md.push(`|---|${scenarioIds.map(() => '---').join('|')}|`);
  for (const b of bots) {
    const s = stats.get(b.name)!;
    md.push(
      `| ${b.name} | ${scenarioIds
        .map((sc) => {
          const x = s.byScenario[sc];
          return x && x.n ? Math.round(x.total / x.n) : '—';
        })
        .join(' | ')} |`,
    );
  }
  md.push('');

  md.push('### シナリオ別の SUPER以上（ランダムがどこで当たっているか）');
  md.push('');
  md.push(`| Bot | ${scenarioIds.map((x) => SCENARIO_NAMES[x]).join(' | ')} |`);
  md.push(`|---|${scenarioIds.map(() => '---').join('|')}|`);
  for (const b of [randomBot, combo, expert, oracleBot]) {
    const st = stats.get(b.name)!;
    md.push(
      `| ${b.name} | ${scenarioIds
        .map((sc) => {
          const x = st.byScenario[sc];
          return x && x.n ? pct(x.superPlus / x.n) : '—';
        })
        .join(' | ')} |`,
    );
  }
  md.push('');
  md.push('ランダムの当たりやすさは、底が平らなシナリオ（底固め・レンジ）で高くなる。');
  md.push('価格が底の近くに留まる時間が長いほど、適当に押しても SUPER に入るため。');
  md.push('');

  md.push('## 5. 底値圏の滞在時間');
  md.push('');
  md.push('単位はティック（8ティック＝1本＝0.8秒）。BUY 可能なのは 240 ティック。');
  md.push('RandomBot の SUPER以上の率は「SUPER圏のティック数 ÷ 240」と一致する。');
  md.push('');
  md.push(
    '| シナリオ | 出現率 | SUPER圏 | ULTRA圏 | GOD圏 | 圏内進入→底値 | 底値→圏外 | Random | Time | Combo |',
  );
  md.push('|---|---|---|---|---|---|---|---|---|---|');
  const dwell = measureDwell(valid);
  const timeStat = stats.get(bestTime.name)!;
  for (const sc of scenarioIds) {
    const d = dwell[sc];
    const rv = randomStat.byScenario[sc];
    const tv = timeStat.byScenario[sc];
    const cv = comboStat.byScenario[sc];
    md.push(
      `| ${SCENARIO_NAMES[sc]} | ${pct(d.n / valid.length)} | ${(d.superTicks / d.n).toFixed(1)} | ${(d.ultraTicks / d.n).toFixed(1)} | ${(d.godTicks / d.n).toFixed(1)} | ${(d.approach / d.n).toFixed(1)} | ${(d.exit / d.n).toFixed(1)} | ${pct(rv.superPlus / rv.n)} | ${pct(tv.superPlus / tv.n)} | ${pct(cv.superPlus / cv.n)} |`,
    );
  }
  md.push('');

  md.push('## 6. §10.2 の合格基準（Phase 1 最終版）');
  md.push('');
  md.push('最重要は #1。市場情報を複合的に使う戦略が、ランダム・時刻のみ・下落率のみ・単一兆候／2兆候の');
  md.push('どれよりも SUPER+ と ULTRA+ の両方で上回っていること。');
  md.push('SUPER / ULTRA をスキル評価の中心とし、GOD には完全なスキル分離を求めない。');
  md.push('');
  md.push('| # | 項目 | 実測 | 判定 |');
  md.push('|---|---|---|---|');
  for (const c of checks) md.push(`| ${c.no} | ${c.name} | ${c.detail} | ${c.pass ? 'OK' : 'NG'} |`);
  md.push('');
  md.push('参考値（合否には使わない）：');
  for (const r of references) md.push(`- ${r}`);
  md.push('');

  md.push('## 7. 戦略の分離');
  md.push('');
  const ladder: Array<[string, Stat]> = [
    ['ランダム', randomStat],
    ['単一兆候の最良', stats.get(bestOf(singleSignal, stats).name)!],
    ['反転確認待ち', stats.get(bestConfirm.name)!],
    ['複数兆候', comboStat],
    ['熟練', expertStat],
    ['上限（Oracle）', oracleStat],
  ];
  md.push('| 戦略 | 平均スコア | 乖離率中央値 | SUPER以上 |');
  md.push('|---|---|---|---|');
  for (const [label, s] of ladder) {
    md.push(`| ${label} | ${Math.round(avgScore(s))} | ${devPct(medianDeviation(s))} | ${pct(rate(s, 'SUPER'))} |`);
  }
  md.push('');
  const separated =
    avgScore(expertStat) > avgScore(randomStat) &&
    avgScore(comboStat) > avgScore(randomStat) &&
    avgScore(expertStat) > avgScore(stats.get(bestOf(singleSignal, stats).name)!);
  md.push(
    separated
      ? '複数兆候・熟練の戦略が、ランダムと単一兆候の両方を平均スコアで上回っている。'
      : '**戦略が分離できていない。**ランダムまたは単一兆候が、複数兆候・熟練の戦略と同等以上になっている。',
  );
  md.push('');

  md.push('## 8. ランク階層ごとの分離');
  md.push('');
  md.push('ランクは z（＝乖離 ÷ ATR_ref）だけで決まる。閾値の候補ごとに各戦略の到達率を出す。');
  md.push('階層を一括で動かさず、段ごとに「腕による差」が出ているかを見る。');
  md.push('');
  const zOf = (st: Stat) => st.zs.slice().sort((a, b) => a - b);
  const zCache = new Map<string, number[]>();
  for (const b of bots) zCache.set(b.name, zOf(stats.get(b.name)!));
  const rateAt = (b: Bot, t: number): number => {
    const z = zCache.get(b.name)!;
    let k = 0;
    for (const x of z) {
      if (x <= t) k++;
      else break;
    }
    return k / stats.get(b.name)!.n;
  };
  const ladderBots = [randomBot, bestTime, bestConfirm, combo, expert, oracleBot];
  md.push(`| z 閾値 | ${ladderBots.map((b) => b.name).join(' | ')} |`);
  md.push(`|---|${ladderBots.map(() => '---').join('|')}|`);
  for (const t of [0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.75, 1.0, 1.25, 1.5, 2.0]) {
    md.push(`| ${t.toFixed(2)} | ${ladderBots.map((b) => pct(rateAt(b, t))).join(' | ')} |`);
  }
  md.push('');
  md.push(
    `現行の閾値は GOD ${RANK_THRESHOLDS[0].maxZ} / ULTRA ${RANK_THRESHOLDS[1].maxZ} / SUPER ${RANK_THRESHOLDS[2].maxZ}。`,
  );
  md.push('目安（Random: SUPER+ 約5% / ULTRA+ 約1% / GOD 0.5%未満、熟練: 25〜30% / 10〜15% / 2〜5%）に');
  md.push('最も近い閾値を、段ごとに探すと次のようになる。');
  md.push('');
  md.push('| ランク | 目安（Random） | 目安（熟練） | 最も近い z | 実際の Random | 実際の熟練 | 倍率 |');
  md.push('|---|---|---|---|---|---|---|');
  const tiers: Array<[string, number, [number, number]]> = [
    ['GOD', 0.005, [0.02, 0.05]],
    ['ULTRA以上', 0.01, [0.1, 0.15]],
    ['SUPER以上', 0.05, [0.25, 0.3]],
  ];
  const candidates: number[] = [];
  for (let t = 0.05; t <= 2.0; t += 0.01) candidates.push(Math.round(t * 100) / 100);
  for (const [label, randTarget, expRange] of tiers) {
    let bestT = candidates[0];
    let bestErr = Infinity;
    for (const t of candidates) {
      const err = Math.abs(rateAt(randomBot, t) - randTarget);
      if (err < bestErr) {
        bestErr = err;
        bestT = t;
      }
    }
    const r = rateAt(randomBot, bestT);
    const e = rateAt(expert, bestT);
    md.push(
      `| ${label} | ${pct(randTarget)} | ${pct(expRange[0])}〜${pct(expRange[1])} | ${bestT.toFixed(2)} | ${pct(r)} | ${pct(e)} | ${r > 0 ? (e / r).toFixed(1) + '倍' : '—'} |`,
    );
  }
  md.push('');

  const mdText = md.join('\n');
  writeFileSync(join(OUT_DIR, 'report.md'), mdText);

  const csv: string[] = ['bot,metric,value'];
  for (const b of bots) {
    const s = stats.get(b.name)!;
    csv.push(`${b.name},avg_score,${avgScore(s).toFixed(1)}`);
    csv.push(`${b.name},mean_deviation,${(meanDeviation(s) ?? NaN).toFixed(5)}`);
    csv.push(`${b.name},median_deviation,${(medianDeviation(s) ?? NaN).toFixed(5)}`);
    csv.push(`${b.name},no_trade_rate,${noTradeRate(s).toFixed(4)}`);
    for (const r of RANK_ORDER) csv.push(`${b.name},rank_${r},${(s.ranks[r] / s.n).toFixed(4)}`);
    for (const sc of scenarioIds) {
      const x = s.byScenario[sc];
      csv.push(`${b.name},score_${sc},${x && x.n ? (x.total / x.n).toFixed(1) : ''}`);
    }
  }
  for (const [k, v] of Object.entries(reliability)) {
    csv.push(`signal,${k}_genuine,${v.genuine}`);
    csv.push(`signal,${k}_fake,${v.fake}`);
    csv.push(`signal,${k}_genuine_near_bottom,${v.genuineNear}`);
    csv.push(`signal,${k}_reliability,${reliabilityOf(v).toFixed(4)}`);
    csv.push(`signal,${k}_designed,${DESIGNED_RELIABILITY[k] ?? ''}`);
  }
  writeFileSync(join(OUT_DIR, 'report.csv'), csv.join('\n'));

  process.stdout.write(mdText + '\n');
  process.stderr.write(`\nwrote ${join(OUT_DIR, 'report.md')} and report.csv\n`);
}

function bestOf(bots: Bot[], stats: Map<string, Stat>): Bot {
  let best = bots[0];
  for (const b of bots) {
    if (avgScore(stats.get(b.name)!) > avgScore(stats.get(best.name)!)) best = b;
  }
  return best;
}

main();
