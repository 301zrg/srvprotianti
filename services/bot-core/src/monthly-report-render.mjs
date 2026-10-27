import sharp from 'sharp';
import {fileURLToPath} from 'node:url';
import {CARD_METRICS, displayMonth, languageKey, localizedName, metricNames, reportPercent} from './monthly-report-text.mjs';
import {imageNames, RequestQueue} from './monthly-report.mjs';

const fontfile = fileURLToPath(new URL('./assets/fonts/NotoSansCJKjp-Regular.otf', import.meta.url));
const escape = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ink = '#eef3fc', muted = '#acbbd1', accent = '#78d9df';
class Figure {
  constructor(width, height) { this.width = width; this.height = height; this.shapes = []; this.texts = []; }
  rect(x, y, width, height, color, radius = 0) {
    this.shapes.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${color}"/>`);
  }
  text(text, x, y, width, size = 24, color = ink, maxHeight = 100) {
    this.texts.push({text: String(text), x, y, width, size, color, maxHeight});
  }
  async png() {
    const queue = new RequestQueue(4);
    const overlays = await Promise.all(this.texts.map(t => queue.run(async () => {
      const {data, info} = await sharp({text: {text: `<span foreground="${t.color}">${escape(t.text)}</span>`,
        font: `Noto Sans CJK JP ${t.size}`, fontfile, width: Math.floor(t.width), wrap: 'word', rgba: true}}).png().toBuffer({resolveWithObject: true});
      const input = info.height > t.maxHeight ? await sharp(data).resize({width: Math.floor(t.width), height: t.maxHeight, fit: 'inside'}).png().toBuffer() : data;
      return {input, left: Math.round(t.x), top: Math.round(t.y)};
    })));
    const background = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}"><rect width="100%" height="100%" fill="#111b2c"/>${this.shapes.join('')}</svg>`);
    return sharp(background).composite(overlays).png({compressionLevel: 9}).toBuffer();
  }
}
function heading(f, model, title, japanese) {
  f.text('OCG 1103 NEXUS', 60, 35, f.width - 120, 26, accent);
  f.text(`${displayMonth(model.month)} · ${title}`, 60, 85, f.width - 120, 48, ink, 80);
  f.text(japanese + (model.partial ? ' · IN PROGRESS / 集計中' : ''), 60, 164, f.width - 120, 25, muted, 70);
}
function footer(f, model, extra = '') {
  const y = f.height - 180;
  f.text(`Card-data coverage: ${model.coverage.validCardDecks.toLocaleString('en-US')} / ${model.coverage.allDecks.toLocaleString('en-US')} player-view deck samples (${reportPercent(model.coverage.allDecks ? model.coverage.validCardDecks / model.coverage.allDecks : null)})`,
    60, y, f.width - 120, 22, muted, 50);
  if (extra) f.text(extra, 60, y + 50, f.width - 120, 21, muted, 55);
  f.text(`Generated ${model.generatedAt} · Full data: usage-stats.html (${displayMonth(model.month)})`, 60, f.height - 55, f.width - 120, 19, muted, 35);
}
function cellColor(cell) {
  if (!cell.matches || cell.matches < 20) return '#263348';
  const good = cell.rate >= 0.5, strength = Math.abs(cell.rate - 0.5) * 2;
  const start = [43, 56, 76], end = good ? [25, 113, 100] : [141, 53, 73];
  return `rgb(${start.map((n, i) => Math.round(n + (end[i] - n) * strength)).join(',')})`;
}
async function decksFigure(model) {
  const f = new Figure(2880, 1920), startY = 370, rowH = 87, matrixX = 930, cellW = 121;
  heading(f, model, `Top ${model.decks.length} Decks · Usage & Matchups`, 'デッキ使用率・総合勝率・対戦別マッチ勝率');
  f.text('Rows = deck played; columns = opponent. Match wins / player-view Match samples. * n < 20; — no samples. Open original image to zoom.', 60, 230, 2760, 25, muted);
  f.text(`Top ${model.decks.length} share ${reportPercent(model.topRate)} · Other ${reportPercent(model.otherRate)} · Remaining identified ${reportPercent(Math.max(0, 1 - model.otherRate - model.topRate))}`, 60, 275, 2760, 25, accent);
  f.text('DECK / デッキ', 60, 330, 425, 23);
  f.text('USAGE', 500, 330, 110, 23);
  f.text('USES', 620, 330, 100, 23);
  f.text('OVERALL', 735, 330, 175, 23);
  model.decks.forEach((deck, i) => {
    const y = startY + i * rowH;
    f.rect(50, y, 850, rowH - 4, i % 2 ? '#1a273b' : '#172337', 4);
    f.text(`${String(i + 1).padStart(2, '0')}`, 62, y + 20, 45, 27, accent);
    f.text(localizedName(deck.names, 'en'), 120, y + 7, 365, 26, ink, 42);
    f.text(localizedName(deck.names, 'ja'), 120, y + 52, 365, 19, muted, 28);
    f.text(reportPercent(deck.usageRate), 500, y + 24, 115, 25);
    f.text(deck.count.toLocaleString('en-US'), 620, y + 25, 100, 23);
    f.text(reportPercent(deck.overall.rate), 735, y + 9, 175, 28);
    f.text(`n=${deck.overall.matches}`, 735, y + 52, 175, 20, muted);
    f.text(String(i + 1).padStart(2, '0'), matrixX + i * cellW + 38, 327, 80, 25, accent);
    deck.matchups.forEach((cell, j) => {
      const x = matrixX + j * cellW;
      f.rect(x, y, cellW - 4, rowH - 4, cellColor(cell), 4);
      f.text(reportPercent(cell.rate), x + 9, y + 11, cellW - 14, 25, ink, 36);
      f.text(`n=${cell.matches}${cell.matches > 0 && cell.matches < 20 ? '*' : ''}`, x + 9, y + 52, cellW - 14, 19, muted, 28);
    });
  });
  if (!model.decks.length) f.text('No identified decks / 分類済みデッキなし', 60, startY + 80, 2200, 40);
  footer(f, model, 'Usage includes Other in its denominator. Overall includes every opponent, including decks outside this matrix. Samples are not unique players or physical Matches.');
  return f.png();
}
async function cardsFigure(model, metrics, language = null) {
  const f = new Figure(1600, 1800), columnW = metrics.length === 1 ? 1480 : 710;
  const labels = metrics.map(m => metricNames[language || 'en'][CARD_METRICS.indexOf(m)]);
  heading(f, model, `${labels.join(' & ')} · Top 10`, language ?
    ({en: 'Card inclusion rate', ja: 'カード採用率', zh: '卡片使用率', ko: '카드 채용률'}[language]) :
    metrics.map(m => metricNames.ja[CARD_METRICS.indexOf(m)]).join(' / ') + ' 採用率');
  metrics.forEach((metric, column) => {
    const x = 60 + column * 770;
    f.text(labels[column].toUpperCase(), x, 250, columnW, 25, accent);
    const cards = model.cards[metric];
    if (!cards.length) f.text('No data / データなし', x, 360, columnW, 35);
    cards.forEach((card, i) => {
      const y = 310 + i * 127, nameW = columnW - 190;
      f.rect(x, y, columnW, 119, '#1a273b', 8);
      f.text(String(i + 1).padStart(2, '0'), x + 15, y + 16, 45, 27, accent);
      f.text(localizedName(card.names, language || 'en'), x + 75, y + 10, nameW - 65, 26, ink, 55);
      f.text(language ? `ID ${card.cardId}` : localizedName(card.names, 'ja'), x + 75, y + 69, nameW - 65, 19, muted, 34);
      f.text(reportPercent(card.usageRate), x + columnW - 168, y + 15, 155, 31, ink, 45);
      f.text(`n=${card.deckCount}`, x + columnW - 168, y + 68, 155, 20, muted, 34);
      f.rect(x + 75, y + 109, columnW - 95, 4, '#34445c', 2);
      f.rect(x + 75, y + 109, (columnW - 95) * card.usageRate, 4, accent, 2);
    });
  });
  footer(f, model, 'Rate = decks containing this card / valid card-data deck samples. Side Deck = Game 1 initial Side Deck; not siding frequency.');
  return f.png();
}
export async function renderCardQuery(model, metric, language) {
  return {name: `cards-${metric}-${model.month}-${languageKey(language)}.png`, data: await cardsFigure(model, [metric], languageKey(language)),
    description: `${displayMonth(model.month)}: ${metricNames[languageKey(language)][CARD_METRICS.indexOf(metric)]} Top 10 card inclusion rates and deck samples.`};
}
export async function renderMonthlyReport(model) {
  const names = imageNames(model.month), files = [];
  const descriptions = [
    `${displayMonth(model.month)}: Top ${model.decks.length} decks by usage, overall Match win rates against all opponents, and directional matchup matrix within the Top ${model.decks.length}. Each cell shows win percentage and player-view Match sample count; cells with fewer than 20 samples are marked with an asterisk. Names in English and Japanese. Full numerical results accompany the export.`,
    `${displayMonth(model.month)}: Top 10 Main Deck monsters by deck inclusion rate, English and Japanese names, percentages and deck sample counts.`,
    `${displayMonth(model.month)}: Top 10 Main Deck spells and Top 10 Main Deck traps by deck inclusion rate, with English and Japanese names, percentages and deck sample counts.`,
    `${displayMonth(model.month)}: Top 10 Extra Deck cards and Top 10 initial Side Deck cards by inclusion rate. English and Japanese names, percentages and deck sample counts. Side Deck data describes the initial Game 1 deck, not siding frequency.`
  ];
  for (let i = 0; i < 4; i++) files.push({name: names[i], description: descriptions[i], data: await (i === 0 ? decksFigure(model) : cardsFigure(model, [ ['monster'], ['spell', 'trap'], ['extra', 'side'] ][i - 1]))});
  return files;
}
