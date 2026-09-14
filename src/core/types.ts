/** 仕様書 §11 データ構造 */

export type ScenarioId = 'V' | 'SAUCER' | 'FAKE' | 'DOUBLE' | 'CLIMAX' | 'RANGE';

export type Rank =
  | 'GOD'
  | 'ULTRA'
  | 'SUPER'
  | 'GREAT'
  | 'GOOD'
  | 'BAD'
  | 'NO_TRADE';

export type SignalKind =
  | 'WICK'
  | 'VOLUME'
  | 'DECEL'
  | 'BIG_GREEN'
  | 'SMALL_BOUNCE';

export interface Candle {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface SignalEvent {
  /** LIVE基準の足番号（0始まり） */
  candleIndex: number;
  kind: SignalKind;
  /** 真の兆候なら true、ダマシなら false */
  genuine: boolean;
}

export interface Chart {
  seed: number;
  generatorVersion: string;
  scenario: ScenarioId;
  /** シナリオ内の分岐（DOUBLE の D1 / D2 など）。表示には使わない */
  branch?: string;
  /** 事前表示の12本 */
  history: Candle[];
  /** LIVE全ティックの価格（整数円）。36本 × 8ティック = 288 */
  ticks: number[];
  /** LIVE全36本 */
  candles: Candle[];
  /** 底値をつけたティックの番号（最初の最安値ティック） */
  bottomTick: number;
  /** 底の足の前後5本（計11本）の True Range 平均 */
  atrRef: number;
  events: SignalEvent[];
  /** 1足あたり基準ボラ。表示には使わない（Bot・デバッグ用） */
  v: number;
}

export interface Result {
  buyTick: number | null;
  buyPrice: number | null;
  bottomPrice: number;
  /** 乖離率（小数。表示時に ×100 して%にする） */
  deviationPct: number | null;
  z: number | null;
  rank: Rank;
  score: number;
}
