import {Figure} from './figure.mjs';
import {imageCopy, languageKeys} from './languages.mjs';
import {CARD_METRICS, displayMonth, localizedName, metricNames, reportPercent} from './monthly-report-text.mjs';
import {imageNames} from './monthly-report.mjs';

const muted = '#acbbd1', accent = '#78d9df';
const lines = (keys, key) => keys.map(lang => imageCopy[lang][key]).join('\n');
function heading(f, model, keys, title) {
  f.text(`OCG 1103 NEXUS · ${displayMonth(model.month)}`, 60, 30, f.width - 120, 32, accent);
  keys.forEach((lang, i) => f.text(title(lang) + (model.partial ? ` · ${imageCopy[lang].current}` : ''), 60, 85 + i * 46, f.width - 120, 30, undefined, 42));
}
function footer(f, model, keys, note, y) {
  keys.forEach((lang, i) => {
    const s = imageCopy[lang], start = y + i * 145;
    f.text(`${s.coverage}: ${model.coverage.validCardDecks} / ${model.coverage.allDecks}`, 60, start, f.width - 120, 23, muted, 35);
    f.text(s[note], 60, start + 38, f.width - 120, 21, muted, 58);
    f.text(`${s.generated}: ${model.generatedAt} · ${s.full}: usage-stats.html (${displayMonth(model.month)})`, 60, start + 100, f.width - 120, 20, muted, 38);
  });
}
export function localizedDeckFigure(model, languages) {
  const keys = languageKeys(languages), count = keys.length;
  const rowH = Math.max(88, count * 46 + 20), startY = 230 + count * 115, footerY = startY + Math.max(1, model.decks.length) * rowH + 25;
  const f = new Figure(3080, footerY + count * 145 + 30), matrixX = 1140, cellW = 121;
  heading(f, model, keys, lang => `${imageCopy[lang].decks} · ${model.decks.length}`);
  keys.forEach((lang, i) => {
    const s = imageCopy[lang], y = 100 + count * 46 + i * 66;
    f.text(s.matrix, 60, y, f.width - 120, 22, muted, 40);
    f.text(`${s.shares}: ${reportPercent(model.topRate)} / ${reportPercent(model.otherRate)} / ${reportPercent(Math.max(0, 1 - model.otherRate - model.topRate))}`, 60, y + 36, f.width - 120, 22, accent, 28);
  });
  for (const [key, x, w] of [['deck', 60, 625], ['usage', 710, 110], ['uses', 830, 100], ['overall', 945, 175]]) {
    f.text(lines(keys, key), x, startY - count * 26 - 12, w, 20, undefined, count * 25);
  }
  model.decks.forEach((deck, i) => {
    const y = startY + i * rowH;
    f.rect(50, y, 1060, rowH - 4, i % 2 ? '#1a273b' : '#172337', 4);
    f.text(String(i + 1).padStart(2, '0'), 62, y + 15, 45, 25, accent);
    keys.forEach((lang, n) => f.text(localizedName(deck.names, lang), 120, y + 8 + n * 46, 565, 23, undefined, 44));
    f.text(reportPercent(deck.usageRate), 710, y + 20, 115, 24);
    f.text(String(deck.count), 830, y + 20, 100, 23);
    f.text(reportPercent(deck.overall.rate), 945, y + 9, 175, 27);
    f.text(`n=${deck.overall.matches}`, 945, y + 50, 175, 20, muted, 28);
    f.text(String(i + 1).padStart(2, '0'), matrixX + i * cellW + 38, startY - 38, 80, 25, accent, 32);
    deck.matchups.forEach((cell, j) => {
      const x = matrixX + j * cellW;
      f.rect(x, y, cellW - 4, rowH - 4, !cell.matches || cell.matches < 20 ? '#263348' : cell.rate >= .5 ? '#196454' : '#753443', 4);
      f.text(reportPercent(cell.rate), x + 9, y + 11, cellW - 14, 25, undefined, 36);
      f.text(`n=${cell.matches}${cell.matches > 0 && cell.matches < 20 ? '*' : ''}`, x + 9, y + 52, cellW - 14, 19, muted, 28);
    });
  });
  if (!model.decks.length) f.text(lines(keys, 'empty'), 60, startY, 2200, 30, undefined, count * 42);
  footer(f, model, keys, 'deckNote', footerY);
  return f;
}
export function localizedCardsFigure(model, metrics, languages) {
  const keys = languageKeys(languages), count = keys.length, columnW = metrics.length === 1 ? 1480 : 710;
  const rowH = Math.max(127, count * 36 + 28), startY = 185 + count * 82, footerY = startY + 10 * rowH + 25;
  const f = new Figure(1600, footerY + count * 145 + 30);
  heading(f, model, keys, lang => `${imageCopy[lang].cards} · 10`);
  metrics.forEach((metric, column) => {
    const x = 60 + column * 770;
    f.text(keys.map(lang => metricNames[lang][CARD_METRICS.indexOf(metric)]).join('\n'), x, 105 + count * 46, columnW, 23, accent, count * 32);
    const cards = model.cards[metric];
    if (!cards.length) f.text(lines(keys, 'empty'), x, startY, columnW, 30, undefined, count * 42);
    cards.forEach((card, i) => {
      const y = startY + i * rowH, nameW = columnW - 190;
      f.rect(x, y, columnW, rowH - 8, '#1a273b', 8);
      f.text(String(i + 1).padStart(2, '0'), x + 15, y + 16, 45, 25, accent);
      keys.forEach((lang, n) => f.text(localizedName(card.names, lang), x + 75, y + 10 + n * 36, nameW - 65, 24, undefined, 34));
      f.text(reportPercent(card.usageRate), x + columnW - 168, y + 15, 155, 29, undefined, 42);
      f.text(`n=${card.deckCount}`, x + columnW - 168, y + 65, 155, 20, muted, 30);
      f.rect(x + 75, y + rowH - 18, columnW - 95, 4, '#34445c', 2);
      f.rect(x + 75, y + rowH - 18, (columnW - 95) * card.usageRate, 4, accent, 2);
    });
  });
  footer(f, model, keys, 'cardNote', footerY);
  return f;
}
export async function renderLocalizedReport(model, languages) {
  const names = imageNames(model.month), files = [];
  for (let i = 0; i < 4; i++) {
    const f = i === 0 ? localizedDeckFigure(model, languages) : localizedCardsFigure(model, [['monster'], ['spell', 'trap'], ['extra', 'side']][i - 1], languages);
    files.push({name: names[i], data: await f.png(), description: `${displayMonth(model.month)} · ${languageKeys(languages).join('/')}`});
  }
  return files;
}
