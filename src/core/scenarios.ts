/**
 * シナリオ定義（仕様書 §5.5）。データのみ。解釈は generator.ts が行う。
 *
 * 数値はすべて初期値。§10のシミュレーションで調整する前提。
 */

import type { ScenarioId, SignalKind } from './types';

/** true / false のほか、'anchor'（そのセグメントが真の底を含むときだけ真の兆候） */
export type Genuine = boolean | 'anchor';

export interface EventSpec {
  kind: SignalKind;
  /** 発生確率 */
  p: number;
  genuine: Genuine;
  /** セグメント内の位置（0始まり）。省略時はアンカー足、なければ先頭 */
  at?: number;
  /**
   * アンカーからの相対位置で置く。at より優先。
   * 底の±2本以内に真の兆候を出すために使う。
   */
  anchorOffset?: number;
  /** DECEL / SMALL_BOUNCE: 影響する本数の範囲 */
  candles?: [number, number];
  /** WICK: 下ヒゲの深さ（V単位）の範囲 */
  depth?: [number, number];
  /** VOLUME: 出来高倍率の範囲 */
  mult?: [number, number];
  /** 値をいじらず SignalEvent の記録だけ行う（セグメント定義で既に表現済みの兆候） */
  markOnly?: boolean;
}

export interface SegSpec {
  name: string;
  /** 本数の下限・上限 */
  min: number;
  max: number;
  /** 「下落」セグメント。本数はアンカー位置から逆算する */
  fill?: boolean;
  /** 最終セグメント。LIVE 36本の残りを埋める */
  rest?: boolean;
  /** シナリオ固有セグメント。本数が足りないときは下限−1（最低1本）まで縮められる */
  own?: boolean;
  /** ドリフト（V単位／足）。mEnd があれば線形に変化 */
  m: number;
  mEnd?: number;
  /** ボラ倍率 */
  s: number;
  sEnd?: number;
  /** 出来高倍率 */
  u: number;
  uEnd?: number;
  /** ダマシの配置対象 */
  fakeTarget?: boolean;
  /** 真の底（アンカー）の置き方 */
  anchor?: 'first' | 'center' | 'last' | 'lastThirdCenter';
  events?: EventSpec[];
}

export interface ScenarioSpec {
  id: ScenarioId;
  branch?: string;
  /** 抽選の重み（%） */
  weight: number;
  segments: SegSpec[];
}

/** 全シナリオ共通の先頭部分（履歴12本は生成側が別に扱う） */
function head(): SegSpec[] {
  return [
    { name: '初動', min: 2, max: 4, m: -0.8, s: 1.0, u: 1.3 },
    { name: '下落', min: 1, max: 1, fill: true, m: -1.4, s: 1.2, u: 1.6, fakeTarget: true },
  ];
}

const TRUE_WICK: EventSpec = { kind: 'WICK', p: 0.8, genuine: true, depth: [1.2, 2.0] };

/**
 * 底の直後に出る真の小反発。
 * 小反発は最も信頼度の低い兆候（設計 20%）なので、確率は低く抑え、
 * ダマシ側（§5.7）の方が多く出るようにしている。これ単独では底が確定しない。
 */
const GENUINE_BOUNCE: EventSpec = {
  kind: 'SMALL_BOUNCE',
  p: 0.21,
  genuine: true,
  anchorOffset: 1,
  candles: [1, 2],
};

/** A：急落→V字 */
const V_SHAPE: ScenarioSpec = {
  id: 'V',
  weight: 20,
  segments: [
    ...head(),
    { name: '加速', min: 2, max: 3, own: true, m: -2.6, s: 1.5, u: 2.5, fakeTarget: true },
    {
      name: '底足',
      min: 1,
      max: 1,
      own: true,
      m: -1.0,
      s: 1.2,
      u: 2.0,
      anchor: 'first',
      events: [TRUE_WICK, { kind: 'VOLUME', p: 0.8, genuine: true, mult: [3, 5] }],
    },
    {
      name: '急反発',
      min: 3,
      max: 4,
      own: true,
      m: 2.6,
      s: 1.3,
      u: 2.0,
      events: [{ kind: 'BIG_GREEN', p: 0.7, genuine: true, at: 0 }],
    },
    { name: '戻り', min: 1, max: 1, rest: true, m: 0.6, s: 1.0, u: 1.2 },
  ],
};

/** B：ジリ下げ→底固め。スパイク系の兆候は出ない */
const SAUCER: ScenarioSpec = {
  id: 'SAUCER',
  weight: 20,
  segments: [
    ...head(),
    {
      name: '減速',
      min: 4,
      max: 6,
      own: true,
      m: -1.4,
      mEnd: -0.9,
      s: 1.0,
      sEnd: 0.6,
      u: 1.2,
      uEnd: 0.6,
    },
    {
      name: '底固め',
      min: 3,
      max: 4,
      own: true,
      // 平坦にすると、この区間まるごとが SUPER 圏に収まってしまう。
      // 負→正へ傾きが変わる丸い底にすることで、皿型を保ったまま底値圏を早く抜ける
      m: -1.3,
      mEnd: 2.2,
      s: 0.65,
      u: 0.6,
      anchor: 'center',
      // 減速・実体縮小・出来高枯れはセグメント定義そのものが兆候なので記録だけ行う。
      // 底の足に記録することで「底の±2本以内に出る真のDECEL」になる。
      events: [
        { kind: 'DECEL', p: 1.0, genuine: true, markOnly: true, anchorOffset: 0 },
        GENUINE_BOUNCE,
      ],
    },
    { name: '上放れ', min: 1, max: 1, rest: true, m: 1.7, s: 0.8, u: 1.4 },
  ],
};

/** C：ダマシ反発→二段下げ */
const FAKE: ScenarioSpec = {
  id: 'FAKE',
  weight: 20,
  segments: [
    ...head(),
    {
      name: '第一安値',
      min: 1,
      max: 1,
      own: true,
      m: -1.0,
      s: 1.2,
      u: 1.6,
      events: [
        { kind: 'WICK', p: 0.13, genuine: false, depth: [1.2, 2.0] },
        { kind: 'VOLUME', p: 0.17, genuine: false, mult: [3, 3] },
      ],
    },
    {
      name: 'ダマシ反発',
      min: 3,
      max: 5,
      own: true,
      m: 1.3,
      s: 1.1,
      u: 1.3,
      events: [{ kind: 'BIG_GREEN', p: 0.47, genuine: false, at: 0 }],
    },
    { name: '二段下げ', min: 3, max: 5, own: true, m: -2.0, s: 1.4, u: 2.0 },
    {
      name: '底足',
      min: 1,
      max: 1,
      own: true,
      m: -1.0,
      s: 1.2,
      u: 2.0,
      anchor: 'first',
      events: [
        { kind: 'WICK', p: 0.6, genuine: true, depth: [1.2, 2.0] },
        { kind: 'VOLUME', p: 0.7, genuine: true, mult: [3, 5] },
      ],
    },
    { name: '反発', min: 3, max: 5, own: true, m: 1.9, s: 1.2, u: 1.6 },
    { name: '残り', min: 1, max: 1, rest: true, m: 0.5, s: 1.0, u: 1.1 },
  ],
};

/** D：二番底。第一底のイベントが真の兆候かどうかは分岐で変わるので 'anchor' 指定 */
function doubleBottom(branch: 'D1' | 'D2', weight: number): ScenarioSpec {
  return {
    id: 'DOUBLE',
    branch,
    weight,
    segments: [
      ...head(),
      {
        name: '第一底',
        min: 1,
        max: 1,
        own: true,
        m: -1.0,
        s: 1.2,
        u: 2.0,
        anchor: branch === 'D2' ? 'first' : undefined,
        events: [
          { kind: 'WICK', p: 0.5, genuine: 'anchor', depth: [1.2, 2.0] },
          { kind: 'VOLUME', p: 0.7, genuine: 'anchor', mult: [3, 4] },
        ],
      },
      { name: '反発', min: 3, max: 4, own: true, m: 1.9, s: 1.0, u: 1.2 },
      {
        name: '二番底',
        min: 3,
        max: 3,
        own: true,
        m: -2.4,
        s: 1.0,
        u: 0.9,
        anchor: branch === 'D1' ? 'last' : undefined,
      },
      { name: '上昇', min: 1, max: 1, rest: true, m: 2.0, s: 1.1, u: 1.4 },
    ],
  };
}

/** E：セリクラ→底固め */
const CLIMAX: ScenarioSpec = {
  id: 'CLIMAX',
  weight: 15,
  segments: [
    ...head(),
    { name: '加速', min: 2, max: 3, own: true, m: -2.6, s: 1.5, u: 2.5, fakeTarget: true },
    {
      name: 'クライマックス',
      min: 1,
      max: 1,
      own: true,
      m: -1.0,
      s: 1.3,
      u: 2.5,
      anchor: 'first',
      events: [
        { kind: 'WICK', p: 0.9, genuine: true, depth: [1.5, 2.5] },
        { kind: 'VOLUME', p: 0.9, genuine: true, mult: [4, 6] },
      ],
    },
    {
      name: '底固め',
      min: 3,
      max: 5,
      own: true,
      // セリクラ直後の落ち着きは残しつつ、後半にかけて上向きを強めて安値圏を抜ける
      m: 0.0,
      mEnd: 1.2,
      s: 0.6,
      u: 0.8,
      // クライマックス直後の値動きの落ち着き。底は直前のセグメントなので anchorOffset で寄せる
      events: [
        { kind: 'DECEL', p: 0.7, genuine: true, markOnly: true, anchorOffset: 1 },
        GENUINE_BOUNCE,
      ],
    },
    { name: '上放れ', min: 1, max: 1, rest: true, m: 1.6, s: 0.9, u: 1.3 },
  ],
};

/** F：レンジ→突然反転 */
const RANGE: ScenarioSpec = {
  id: 'RANGE',
  weight: 10,
  segments: [
    ...head(),
    {
      name: '下値レンジ',
      min: 6,
      max: 9,
      own: true,
      // 横ばいのままだとレンジ全体が SUPER 圏に入ってしまう。
      // 低ボラのまま緩やかに切り下がる形にして、底値圏にいる時間を後半に寄せる
      m: -0.7,
      s: 0.7,
      u: 0.8,
      anchor: 'lastThirdCenter',
      events: [
        { kind: 'DECEL', p: 0.7, genuine: true, markOnly: true, anchorOffset: 0 },
        GENUINE_BOUNCE,
      ],
    },
    {
      name: '急反転',
      min: 2,
      max: 2,
      own: true,
      m: 3.0,
      s: 1.2,
      u: 2.5,
      events: [{ kind: 'BIG_GREEN', p: 0.8, genuine: true, at: 0 }],
    },
    { name: '残り', min: 1, max: 1, rest: true, m: 1.1, s: 1.0, u: 1.2 },
  ],
};

export const SCENARIOS: readonly ScenarioSpec[] = [
  V_SHAPE,
  SAUCER,
  FAKE,
  doubleBottom('D1', 15 * 0.7),
  doubleBottom('D2', 15 * 0.3),
  CLIMAX,
  RANGE,
];

export const SCENARIO_NAMES: Record<ScenarioId, string> = {
  V: '急落→V字',
  SAUCER: 'ジリ下げ→底固め',
  FAKE: 'ダマシ反発→二段下げ',
  DOUBLE: '二番底',
  CLIMAX: 'セリクラ→底固め',
  RANGE: 'レンジ→突然反転',
};

export const SIGNAL_NAMES: Record<SignalKind, string> = {
  WICK: '下ヒゲ',
  VOLUME: '出来高急増',
  DECEL: '減速',
  BIG_GREEN: '大陽線',
  SMALL_BOUNCE: '小反発',
};

/**
 * ダマシの実装パラメータ（§5.6, §5.7）
 *
 * 個数と種別の重みは、§10.2 #6 の設計信頼度
 * （下ヒゲ82% / 大陽線74% / 出来高急増70% / 減速60% / 小反発30%）に合わせて較正した値。
 * 真の兆候が底の±2本以内にほぼ100%出るため、信頼度はおおむね
 * 「真の兆候 ÷（真の兆候＋ダマシ）」になる。信頼度の高い兆候ほどダマシを少なくしている。
 */
export const FAKE_PARAMS = {
  /** 個数 k の分布 */
  countWeights: [58, 27, 12, 3] as const,
  /** 種別の重み：下ヒゲ / 出来高スパイク / 一時減速 / 小反発 */
  kinds: ['WICK', 'VOLUME', 'DECEL', 'SMALL_BOUNCE'] as const,
  kindWeights: [4, 14, 44, 38] as const,
  /** 2種を同じ足に重ねる確率 */
  stackP: 0.2,
  wickDepth: [1.2, 2.0] as const,
  volumeMult: [2.5, 4.0] as const,
  /** 一時減速：本数と上書き値 */
  decelCandles: [2, 3] as const,
  decelM: -0.2,
  decelSFactor: 0.7,
  /** 小反発：本数と上書き値 */
  bounceCandles: [1, 2] as const,
  bounceM: 1.0,
} as const;

/** 大陽線の m 上書き値 */
export const BIG_GREEN_M = 3.0;
