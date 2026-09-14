/**
 * 決定性のための乱数まわり（仕様書 §5.2）
 *
 * ここでは Math.log / exp / sin / cos / pow を使わない。
 * JSエンジン間で最下位ビットの一致が保証されないため。
 * 使ってよいのは四則演算・Math.sqrt・Math.round・Math.imul。
 */

export type Rand = () => number;

/** mulberry32。Math.imul による整数演算のみで構成する */
export function mulberry32(seed: number): Rand {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** cyrb53。文字列から53bitのハッシュを作る */
export function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** cyrb53 の結果を generateChart に渡せる 32bit シードに落とす */
export function seedFromString(str: string): number {
  return cyrb53(str) >>> 0;
}

export class Rng {
  private r: Rand;

  constructor(seed: number) {
    this.r = mulberry32(seed >>> 0);
  }

  /** [0, 1) */
  next(): number {
    return this.r();
  }

  /** [a, b) */
  uniform(a: number, b: number): number {
    return a + (b - a) * this.r();
  }

  /** [a, b] の整数 */
  int(a: number, b: number): number {
    return a + Math.floor(this.r() * (b - a + 1));
  }

  /** 標準正規（Irwin–Hall法：一様乱数12個の和 − 6） */
  normal(): number {
    let s = 0;
    for (let i = 0; i < 12; i++) s += this.r();
    return s - 6;
  }

  chance(p: number): boolean {
    return this.r() < p;
  }

  pickWeighted<T>(items: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (const w of weights) total += w;
    let x = this.r() * total;
    for (let i = 0; i < items.length; i++) {
      x -= weights[i];
      if (x < 0) return items[i];
    }
    return items[items.length - 1];
  }

  /** Fisher–Yates。配列を破壊的に並べ替えて返す */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
