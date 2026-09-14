import './style.css';

import { DISPLAY_WINDOW, GENERATOR_VERSION, TICKS_PER_CANDLE } from './core/generator';
import { RANK_EMOJI, RANK_LABELS } from './core/judge';
import { SCENARIO_NAMES, SIGNAL_NAMES } from './core/scenarios';
import type { Chart, Result, SignalKind } from './core/types';
import { GameRunner, REVEAL_MS, type Frame } from './game/state';
import {
  ROUNDS,
  dailyChart,
  dailyFinished,
  dailyNumber,
  dailyTotal,
  jstDateString,
  loadDaily,
  nextRound,
  reconcileDaily,
  saveDaily,
  type DailyState,
} from './modes/daily';
import { loadStats, practiceChart, randomSeed, recordPractice, resetStats } from './modes/practice';
import { ChartRenderer, SIGNAL_MARKS, formatPrice, type Marker } from './render/chart';
import { THEME } from './render/theme';
import { dailyShareText, share } from './ui/share';

const DISCLAIMER = '実在の銘柄・相場とは無関係です。投資助言ではありません。';
const MAX_TOTAL = 3000;

const root = document.getElementById('app')!;

type Mode = 'DAILY' | 'PRACTICE';

let runner: GameRunner | null = null;
let detachVisibility: (() => void) | null = null;

// ---------------------------------------------------------------- 画面遷移

function clear(): void {
  runner?.stop();
  runner = null;
  detachVisibility?.();
  detachVisibility = null;
  root.innerHTML = '';
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function showTitle(): void {
  clear();
  const s = el('div', 'screen title-screen');
  s.append(
    el('h1', undefined, '底値を掴め！'),
    el('p', 'sub', 'DAILY BOTTOM'),
  );

  const date = jstDateString();
  const state = reconcileDaily(loadDaily(date), null);
  saveDaily(state);

  const menu = el('div', 'menu');
  const daily = el('button', 'btn primary', dailyButtonLabel(state, date));
  daily.onclick = () => showDailyHub();
  const practice = el('button', 'btn', 'PRACTICE');
  practice.onclick = () => startPractice();
  const stats = el('button', 'btn ghost', '記録を見る');
  stats.onclick = () => showStats();
  menu.append(daily, practice, stats);

  s.append(menu, el('p', 'disclaimer', DISCLAIMER));
  s.append(el('p', 'disclaimer', `generator ${GENERATOR_VERSION}`));
  root.append(s);
}

function dailyButtonLabel(state: DailyState, date: string): string {
  const n = dailyNumber(date);
  if (dailyFinished(state)) return `DAILY #${pad3(n)}（本日ぶん終了）`;
  const done = state.results.filter((r) => r !== null).length;
  return `DAILY #${pad3(n)}  ${done + 1}/${ROUNDS}`;
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

// ---------------------------------------------------------------- DAILY

function showDailyHub(): void {
  clear();
  const date = jstDateString();
  const state = reconcileDaily(loadDaily(date), null);
  saveDaily(state);

  const s = el('div', 'screen result-screen');
  s.append(el('div', 'header', `DAILY #${pad3(dailyNumber(date))}`));

  const rounds = el('div', 'rounds');
  for (let i = 0; i < ROUNDS; i++) {
    const r = state.results[i];
    rounds.append(el('span', undefined, r ? RANK_EMOJI[r.rank] : '⬜'));
  }
  s.append(rounds);

  const grid = el('div', 'result-grid');
  grid.append(
    cell('合計スコア', `${dailyTotal(state)}`),
    cell('残り', `${state.results.filter((r) => r === null).length} 相場`),
  );
  s.append(grid);

  const actions = el('div', 'actions');
  const next = nextRound(state);
  if (next !== null) {
    const go = el('button', 'btn primary', `${next + 1} 相場目をはじめる`);
    go.onclick = () => startDaily(next);
    actions.append(go);
    actions.append(
      el(
        'p',
        'note',
        'この相場は1回だけです。開始した時点で記録され、途中でアプリを離れると NO TRADE になります。',
      ),
    );
  } else {
    const sh = el('button', 'btn primary', 'シェア');
    sh.onclick = () =>
      share(dailyShareText(dailyNumber(date), state.results, dailyTotal(state), MAX_TOTAL));
    actions.append(sh);
    actions.append(el('p', 'note', '次の相場は JST 0:00 に更新されます。'));
  }
  const back = el('button', 'btn ghost', 'タイトルへ');
  back.onclick = () => showTitle();
  actions.append(back);
  s.append(actions);
  root.append(s);
}

function startDaily(round: number): void {
  const date = jstDateString();
  const state = reconcileDaily(loadDaily(date), round);
  // 相場を開始した時点で started を保存する（リロードでやり直せないように）
  state.started[round] = true;
  saveDaily(state);

  const chart = dailyChart(date, round);
  showGame(chart, 'DAILY', round, (result) => {
    const s2 = loadDaily(date);
    s2.started[round] = true;
    s2.results[round] = result;
    saveDaily(s2);
  });
}

// ---------------------------------------------------------------- PRACTICE

function startPractice(seed = randomSeed()): void {
  const chart = practiceChart(seed);
  showGame(chart, 'PRACTICE', null, (result) => {
    recordPractice(chart, result);
  });
}

// ---------------------------------------------------------------- ゲーム画面

function showGame(
  chart: Chart,
  mode: Mode,
  round: number | null,
  onResult: (r: Result) => void,
): void {
  clear();

  const s = el('div', 'screen game-screen');
  const header = el('div', 'header');
  const left = el('span', undefined, mode === 'DAILY' ? `DAILY #${pad3(dailyNumber(jstDateString()))}` : 'PRACTICE');
  const right = el('span', undefined, round === null ? '' : `${round + 1}/${ROUNDS}`);
  header.append(left, right);

  const price = el('div', 'price', '—');
  const wrap = el('div', 'chart-wrap');
  const canvas = el('canvas');
  canvas.id = 'chart';
  const overlay = el('div', 'overlay');
  wrap.append(canvas, overlay);

  const buyArea = el('div', 'buy-area');
  const buy = el('button');
  buy.id = 'buy';
  buy.textContent = 'BUY';
  buy.disabled = true;
  buyArea.append(buy);

  s.append(header, price, wrap, buyArea);
  root.append(s);

  const renderer = new ChartRenderer(canvas);
  const onResize = () => renderer.resize();
  window.addEventListener('resize', onResize);

  let revealNode: HTMLElement | null = null;

  const r = new GameRunner(chart, {
    onPhase(phase) {
      buy.disabled = phase !== 'LIVE';
      overlay.textContent = phase === 'READY' ? 'READY' : '';
      if (phase === 'REVEAL') {
        revealNode = buildReveal(r.currentResult!, () => r.skipReveal());
        wrap.append(revealNode);
      } else if (revealNode) {
        revealNode.remove();
        revealNode = null;
      }
      if (phase === 'RESULT') {
        window.removeEventListener('resize', onResize);
        showResult(chart, r.currentResult!, mode);
      }
    },
    onFrame(frame: Frame) {
      price.textContent = frame.currentPrice === null ? '—' : `¥${formatPrice(frame.currentPrice)}`;
      renderer.draw(
        {
          candles: frame.candles,
          windowSize: DISPLAY_WINDOW,
          currentPrice: frame.currentPrice,
          markers: markersFor(chart, frame),
        },
        performance.now(),
      );
    },
    onDone: onResult,
  });
  runner = r;

  // 多重タップ無効は GameRunner 側（buyTick が入ったら以後は無視）でも担保している
  buy.addEventListener('click', () => {
    r.buy();
  });

  attachVisibility(r, mode);
  r.start();
}

/** PLAYBACK 以降だけ底のマーカーを出す（LIVE 中は出さない） */
function markersFor(chart: Chart, frame: Frame): Marker[] {
  if (frame.phase !== 'PLAYBACK') return [];
  const bottomCandle = Math.floor(chart.bottomTick / TICKS_PER_CANDLE);
  if (bottomCandle * TICKS_PER_CANDLE > frame.lastTick) return [];
  return [
    {
      candleIndex: chart.history.length + bottomCandle,
      price: chart.ticks[chart.bottomTick],
      label: 'BOTTOM',
      color: THEME.bottom,
    },
  ];
}

/**
 * バックグラウンド遷移（§4）
 * DAILY：その相場は NO TRADE。PRACTICE：一時停止し、復帰時に READY から再開。
 */
function attachVisibility(r: GameRunner, mode: Mode): void {
  const handler = () => {
    if (document.visibilityState === 'hidden') {
      if (r.currentPhase === 'LIVE' || r.currentPhase === 'READY') {
        if (mode === 'DAILY') r.forceNoTrade();
        else r.pause();
      }
    } else if (mode === 'PRACTICE' && r.isPaused()) {
      r.restartReady();
    }
  };
  document.addEventListener('visibilitychange', handler);
  detachVisibility = () => document.removeEventListener('visibilitychange', handler);
}

/** REVEAL の演出。MVPではテキストと図形のプレースホルダー（§8.1） */
function buildReveal(result: Result, skip: () => void): HTMLElement {
  const rank = result.rank;
  const node = el('div', 'reveal');
  node.style.pointerEvents = 'auto';
  if (rank === 'GOD') node.classList.add('blackout');

  if (rank === 'GREAT' || rank === 'SUPER') node.append(el('div', 'flash'));
  if (rank === 'ULTRA') {
    node.append(el('div', 'pierce'));
  }

  const label = el('div', 'rank', RANK_LABELS[rank]);
  if (rank === 'GOD') label.classList.add('god');
  node.append(label);

  if (rank === 'GOD') {
    node.append(el('div', 'cutin-frame', '［カットイン枠 ×4／専用BGM枠］'));
    node.append(el('div', 'hint', '約定しました。'));
  } else if (rank === 'ULTRA' || rank === 'SUPER') {
    node.append(el('div', 'cutin-frame', '［カットイン枠］'));
  }

  node.append(el('div', 'hint', `${(REVEAL_MS[rank] / 1000).toFixed(0)}秒 / タップでスキップ`));
  node.addEventListener('click', () => skip());
  return node;
}

// ---------------------------------------------------------------- 結果画面

function showResult(chart: Chart, result: Result, mode: Mode): void {
  clear();
  const date = jstDateString();
  const state = mode === 'DAILY' ? loadDaily(date) : null;
  const revealSignals = mode === 'PRACTICE' || (state !== null && dailyFinished(state));

  const s = el('div', 'screen result-screen');
  s.append(el('div', 'result-rank', `${RANK_EMOJI[result.rank]} ${RANK_LABELS[result.rank]}`));

  const grid = el('div', 'result-grid');
  grid.append(
    cell('BUY価格', result.buyPrice === null ? '—' : `¥${formatPrice(result.buyPrice)}`),
    cell('底値', `¥${formatPrice(result.bottomPrice)}`),
    cell('乖離率', result.deviationPct === null ? '—' : `${(result.deviationPct * 100).toFixed(2)}%`),
    cell('精度スコア', `${result.score}`),
  );
  s.append(grid);

  const chartBox = el('div', 'result-chart');
  const canvas = el('canvas');
  chartBox.append(canvas);
  s.append(chartBox);
  s.append(
    el('p', 'note', 'ランクはこの相場の値幅（ATR）を基準に判定しています。同じ乖離率でも相場が違えばランクは変わります。'),
  );

  if (revealSignals) {
    s.append(el('p', 'note', `シナリオ：${SCENARIO_NAMES[chart.scenario]}`));
    const legend = el('div', 'legend');
    for (const [kind, mark] of Object.entries(SIGNAL_MARKS)) {
      legend.append(el('span', undefined, `${mark} = ${SIGNAL_NAMES[kind as SignalKind]}`));
    }
    s.append(legend);
    const legend2 = el('div', 'legend');
    legend2.append(el('span', 'genuine', '色つき：本物の兆候'), el('span', 'fake', 'グレー：ダマシ'));
    s.append(legend2);
  }
  if (mode === 'PRACTICE') {
    s.append(el('p', 'note', `シード：${chart.seed}`));
  }

  const actions = el('div', 'actions');
  if (mode === 'DAILY' && state) {
    const next = nextRound(state);
    if (next !== null) {
      const go = el('button', 'btn primary', '次の相場へ');
      go.onclick = () => startDaily(next);
      actions.append(go);
    } else {
      const sh = el('button', 'btn primary', 'シェア');
      sh.onclick = () =>
        share(dailyShareText(dailyNumber(date), state.results, dailyTotal(state), MAX_TOTAL));
      actions.append(sh);
      const rounds = el('div', 'rounds');
      for (const r of state.results) rounds.append(el('span', undefined, r ? RANK_EMOJI[r.rank] : '⬜'));
      s.insertBefore(rounds, s.children[1]);
    }
  } else {
    const again = el('button', 'btn primary', 'もう一度');
    again.onclick = () => startPractice();
    actions.append(again);
  }
  const back = el('button', 'btn ghost', 'タイトルへ');
  back.onclick = () => showTitle();
  actions.append(back);
  s.append(actions);
  s.append(el('p', 'disclaimer', DISCLAIMER));
  root.append(s);

  // チャート全体（YOU と BOTTOM のマーカー付き）
  const renderer = new ChartRenderer(canvas);
  const draw = () => {
    renderer.resize();
    const bottomCandle = Math.floor(chart.bottomTick / TICKS_PER_CANDLE);
    const markers: Marker[] = [
      {
        candleIndex: chart.history.length + bottomCandle,
        price: result.bottomPrice,
        label: 'BOTTOM',
        color: THEME.bottom,
      },
    ];
    if (result.buyTick !== null && result.buyPrice !== null) {
      markers.push({
        candleIndex: chart.history.length + Math.floor(result.buyTick / TICKS_PER_CANDLE),
        price: result.buyPrice,
        label: 'YOU',
        color: THEME.you,
      });
    }
    renderer.draw(
      {
        candles: chart.history.concat(chart.candles),
        windowSize: null,
        currentPrice: null,
        showPriceLine: false,
        markers,
        signals: revealSignals ? { events: chart.events, offset: chart.history.length } : undefined,
      },
      performance.now(),
    );
  };
  requestAnimationFrame(draw);
  const onResize = () => draw();
  window.addEventListener('resize', onResize);
  detachVisibility = () => window.removeEventListener('resize', onResize);
}

function cell(k: string, v: string): HTMLElement {
  const c = el('div', 'cell');
  c.append(el('div', 'k', k), el('div', 'val', v));
  return c;
}

// ---------------------------------------------------------------- 記録

function showStats(): void {
  clear();
  const st = loadStats();
  const s = el('div', 'screen result-screen');
  s.append(el('div', 'header', 'PRACTICE の記録'));

  const grid = el('div', 'result-grid');
  grid.append(
    cell('プレイ回数', `${st.plays}`),
    cell('平均スコア', st.plays ? `${Math.round(st.totalScore / st.plays)}` : '—'),
  );
  s.append(grid);

  const table = el('table', 'stats-table');
  const head = el('tr');
  head.append(el('th', undefined, 'ランク'), el('th', undefined, '回数'));
  table.append(head);
  for (const [rank, n] of Object.entries(st.ranks)) {
    const tr = el('tr');
    tr.append(el('td', undefined, RANK_LABELS[rank as keyof typeof RANK_LABELS]), el('td', undefined, `${n}`));
    table.append(tr);
  }
  s.append(table);

  const t2 = el('table', 'stats-table');
  const h2 = el('tr');
  h2.append(el('th', undefined, 'シナリオ'), el('th', undefined, '平均スコア'));
  t2.append(h2);
  for (const [id, v] of Object.entries(st.byScenario)) {
    if (!v) continue;
    const tr = el('tr');
    tr.append(
      el('td', undefined, SCENARIO_NAMES[id as keyof typeof SCENARIO_NAMES]),
      el('td', undefined, `${Math.round(v.totalScore / v.plays)}`),
    );
    t2.append(tr);
  }
  s.append(t2);

  const actions = el('div', 'actions');
  const reset = el('button', 'btn ghost', '記録を消す');
  reset.onclick = () => {
    resetStats();
    showStats();
  };
  const back = el('button', 'btn', 'タイトルへ');
  back.onclick = () => showTitle();
  actions.append(reset, back);
  s.append(actions);
  root.append(s);
}

showTitle();
