/**
 * ローソク足・出来高の描画（仕様書 §4）
 *
 * 表示するもの：ローソク足（常に直近18本）、現在値ライン、右軸の価格目盛り、出来高バー（数値なし）
 * 表示しないもの：時刻軸、経過時間、相場タイプ、開始からの下落率
 *
 * ウィンドウは常に埋まっている（事前表示18本 ≥ ウィンドウ18本）ので、
 * 空き幅・足の総数・スクロールの挙動から経過時間を読み取ることはできない。
 */

import type { Candle, SignalEvent, SignalKind } from '../core/types';
import { THEME } from './theme';

/** Y軸スケールの補間時間 */
const SCALE_TWEEN_MS = 200;
/** 表示範囲の余白 */
const PADDING = 0.1;

export interface Marker {
  /** candles 配列内の位置 */
  candleIndex: number;
  price: number;
  label: string;
  color: string;
}

export interface DrawInput {
  /** 履歴＋LIVE の連結。形成中の足を最後に含めてよい */
  candles: Candle[];
  /** 表示する足数。null なら全部 */
  windowSize: number | null;
  currentPrice: number | null;
  markers?: Marker[];
  /** PRACTICE / 結果画面でのみ渡す。history の本数だけずらして描画する */
  signals?: { events: SignalEvent[]; offset: number };
  /** 現在値ラインを引くか */
  showPriceLine?: boolean;
}

interface Range {
  min: number;
  max: number;
}

export class ChartRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private shown: Range | null = null;
  private lastNow = 0;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
    this.resize();
  }

  /** スケール補間の状態を捨てる。相場の切り替え時に呼ぶ */
  reset(): void {
    this.shown = null;
    this.lastNow = 0;
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dpr = dpr;
  }

  draw(input: DrawInput, now: number): void {
    const { ctx } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const s = this.dpr;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = THEME.bg;
    ctx.fillRect(0, 0, W, H);

    const visible =
      input.windowSize === null || input.candles.length <= input.windowSize
        ? input.candles
        : input.candles.slice(input.candles.length - input.windowSize);
    if (visible.length === 0) return;

    const axisW = 52 * s;
    const left = 8 * s;
    const right = W - axisW;
    const plotW = right - left;

    // 上：ローソク足、下：出来高
    const gap = 10 * s;
    const volH = Math.round(H * 0.18);
    const priceTop = 6 * s;
    const priceBottom = H - volH - gap;
    const priceH = priceBottom - priceTop;
    const volTop = priceBottom + gap;

    const range = this.rangeFor(visible, input.currentPrice, now);
    const y = (p: number) => priceTop + ((range.max - p) / (range.max - range.min)) * priceH;

    const slots = input.windowSize === null ? visible.length : input.windowSize;
    const slotW = plotW / slots;
    const bodyW = Math.max(1 * s, Math.min(slotW * 0.68, 26 * s));
    // 右詰め。最新の足の位置を固定し、足幅も変えない
    const slotOffset = slots - visible.length;
    const xOf = (i: number) => left + slotW * (i + slotOffset + 0.5);

    this.drawGrid(range, y, left, right);

    let maxVol = 1;
    for (const c of visible) if (c.v > maxVol) maxVol = c.v;

    for (let i = 0; i < visible.length; i++) {
      const c = visible[i];
      const x = xOf(i);
      const up = c.c >= c.o;
      ctx.strokeStyle = up ? THEME.up : THEME.down;
      ctx.fillStyle = up ? THEME.upFill : THEME.downFill;

      // ヒゲ
      ctx.lineWidth = Math.max(1, s);
      ctx.beginPath();
      ctx.moveTo(x, y(c.h));
      ctx.lineTo(x, y(c.l));
      ctx.stroke();

      // 実体（同値なら1px線）
      const yo = y(c.o);
      const yc = y(c.c);
      const top = Math.min(yo, yc);
      const hgt = Math.max(Math.abs(yc - yo), Math.max(1, s));
      ctx.fillRect(x - bodyW / 2, top, bodyW, hgt);

      // 出来高（数値は出さない）
      const vh = Math.max(1, (c.v / maxVol) * (volH - 2 * s));
      ctx.fillStyle = up ? THEME.volUp : THEME.volDown;
      ctx.fillRect(x - bodyW / 2, volTop + (volH - vh), bodyW, vh);
    }

    if (input.signals) this.drawSignals(input, visible, xOf, y, s);
    if (input.showPriceLine !== false && input.currentPrice !== null) {
      this.drawPriceLine(input.currentPrice, y, left, right, axisW, s);
    }
    if (input.markers) this.drawMarkers(input, visible, xOf, y, s);
    this.drawAxis(range, y, right, axisW, s);
  }

  private rangeFor(visible: Candle[], current: number | null, now: number): Range {
    let min = Infinity;
    let max = -Infinity;
    for (const c of visible) {
      if (c.l < min) min = c.l;
      if (c.h > max) max = c.h;
    }
    if (current !== null) {
      if (current < min) min = current;
      if (current > max) max = current;
    }
    const span = Math.max(max - min, 1);
    const pad = span * PADDING;
    const target: Range = { min: min - pad, max: max + pad };

    if (!this.shown) {
      this.shown = target;
      this.lastNow = now;
      return target;
    }

    // 目標は毎フレーム動くので、時間ベースの指数平滑で追従する。
    // SCALE_TWEEN_MS でおよそ収束する時定数を使う。
    const dt = Math.max(0, Math.min(now - this.lastNow, 250));
    this.lastNow = now;
    const k = 1 - Math.exp((-dt * 3) / SCALE_TWEEN_MS);
    const next: Range = {
      min: this.shown.min + (target.min - this.shown.min) * k,
      max: this.shown.max + (target.max - this.shown.max) * k,
    };

    // 補間が遅れても、実際の高値・安値・現在値はプロット内に必ず収める
    if (next.min > min) next.min = min;
    if (next.max < max) next.max = max;

    this.shown = next;
    return this.shown;
  }

  private drawGrid(range: Range, y: (p: number) => number, left: number, right: number): void {
    const { ctx } = this;
    ctx.strokeStyle = THEME.grid;
    ctx.lineWidth = 1;
    for (const p of tickValues(range)) {
      const py = Math.round(y(p)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(left, py);
      ctx.lineTo(right, py);
      ctx.stroke();
    }
  }

  private drawAxis(
    range: Range,
    y: (p: number) => number,
    right: number,
    axisW: number,
    s: number,
  ): void {
    const { ctx } = this;
    ctx.fillStyle = THEME.axisText;
    ctx.font = `${Math.round(10 * s)}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const p of tickValues(range)) {
      ctx.fillText(formatPrice(p), right + 6 * s, y(p), axisW - 8 * s);
    }
  }

  private drawPriceLine(
    price: number,
    y: (p: number) => number,
    left: number,
    right: number,
    axisW: number,
    s: number,
  ): void {
    const { ctx } = this;
    const py = Math.round(y(price)) + 0.5;
    ctx.save();
    ctx.strokeStyle = THEME.priceLine;
    ctx.lineWidth = Math.max(1, s);
    ctx.setLineDash([4 * s, 4 * s]);
    ctx.beginPath();
    ctx.moveTo(left, py);
    ctx.lineTo(right, py);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = THEME.text;
    ctx.fillRect(right, py - 8 * s, axisW, 16 * s);
    ctx.fillStyle = THEME.bg;
    ctx.font = `bold ${Math.round(10 * s)}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(formatPrice(price), right + 5 * s, py, axisW - 6 * s);
  }

  private drawMarkers(
    input: DrawInput,
    visible: Candle[],
    xOf: (i: number) => number,
    y: (p: number) => number,
    s: number,
  ): void {
    const { ctx } = this;
    const offset = input.candles.length - visible.length;
    for (const m of input.markers ?? []) {
      const i = m.candleIndex - offset;
      if (i < 0 || i >= visible.length) continue;
      const x = xOf(i);
      const py = y(m.price);
      ctx.fillStyle = m.color;
      ctx.beginPath();
      ctx.arc(x, py, 4 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `bold ${Math.round(10 * s)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(m.label, x, py - 7 * s);
    }
  }

  private drawSignals(
    input: DrawInput,
    visible: Candle[],
    xOf: (i: number) => number,
    y: (p: number) => number,
    s: number,
  ): void {
    const { ctx } = this;
    const offset = input.candles.length - visible.length;
    const sig = input.signals!;
    ctx.font = `${Math.round(9 * s)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const usedRows = new Map<number, number>();
    for (const e of sig.events) {
      const abs = e.candleIndex + sig.offset;
      const i = abs - offset;
      if (i < 0 || i >= visible.length) continue;
      const row = usedRows.get(i) ?? 0;
      usedRows.set(i, row + 1);
      const x = xOf(i);
      const py = y(visible[i].l) + (6 + row * 11) * s;
      ctx.fillStyle = e.genuine ? THEME.genuine : THEME.fake;
      ctx.fillText(signalMark(e), x, py);
    }
  }
}

/**
 * 兆候のマーク。足の幅が狭いので1文字にする。
 * 文字と兆候の対応は結果画面の凡例（SIGNAL_MARKS）で示す。
 */
export const SIGNAL_MARKS: Record<SignalKind, string> = {
  WICK: 'ヒ',
  VOLUME: '出',
  DECEL: '減',
  BIG_GREEN: '陽',
  SMALL_BOUNCE: '反',
};

function signalMark(e: SignalEvent): string {
  return SIGNAL_MARKS[e.kind];
}

/** 3〜4本の目盛りを「切りのよい」値で返す */
export function tickValues(range: Range): number[] {
  const span = range.max - range.min;
  if (span <= 0) return [range.min];
  const rough = span / 3;
  const step = niceStep(rough);
  const first = Math.ceil(range.min / step) * step;
  const out: number[] = [];
  for (let p = first; p <= range.max && out.length < 6; p += step) out.push(p);
  return out;
}

function niceStep(x: number): number {
  // 10のべき乗は Math.pow を使わずにループで作る（生成側と同じ方針を描画にも適用）
  let scale = 1;
  while (scale * 10 <= x) scale *= 10;
  while (scale > x && scale > 1) scale /= 10;
  for (const mult of [1, 2, 2.5, 5, 10]) {
    if (scale * mult >= x) return scale * mult;
  }
  return scale * 10;
}

export function formatPrice(p: number): string {
  return Math.round(p).toLocaleString('ja-JP');
}
