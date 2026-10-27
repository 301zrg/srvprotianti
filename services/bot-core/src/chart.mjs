import sharp from 'sharp';
import {Figure} from './figure.mjs';
import {imageCopy, languageKeys} from './languages.mjs';

export function chartValues(rows) {
  const matches = (Array.isArray(rows) ? rows : []).filter(row =>
    Number.isFinite(Number(row?.pointsBefore)) && Number.isFinite(Number(row?.pointsAfter)));
  if (!matches.length) return [];
  return [Number(matches[0].pointsBefore), ...matches.map(row => Number(row.pointsAfter))];
}

export function chartSvg(rows, languages = ['en-us']) {
  const values = chartValues(rows);
  if (!values.length) return null;
  const keys = languageKeys(languages);
  const width = 840, height = 360 + (keys.length - 1) * 56, left = 86, right = 34, top = 32 + (keys.length - 1) * 28, bottom = 64 + (keys.length - 1) * 28;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const low = Math.min(...values), high = Math.max(...values), padding = Math.max(8, Math.ceil((high - low) * 0.15));
  const min = low - padding, max = high + padding;
  const x = index => left + (values.length === 1 ? plotWidth / 2 : index * plotWidth / (values.length - 1));
  const y = value => top + (max - value) * plotHeight / (max - min);
  const points = values.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(' ');
  const grid = Array.from({length: 5}, (_, index) => {
    const value = max - index * (max - min) / 4, yy = y(value);
    return `<line x1="${left}" y1="${yy}" x2="${width - right}" y2="${yy}" stroke="#dce6f2"/>
      <text x="${left - 12}" y="${yy + 5}" text-anchor="end" font-size="16" fill="#405066">${Math.round(value)}</text>`;
  }).join('');
  const dots = values.map((value, index) => `<circle cx="${x(index)}" cy="${y(value)}" r="5" fill="#2777d5"/>
    <text x="${x(index)}" y="${height - bottom + 32}" text-anchor="middle" font-size="15" fill="#405066">${index}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#ffffff"/>
    ${keys.map((key, i) => `<text data-label="title" x="${left}" y="${23 + i * 28}" font-size="18" fill="#202d43">${imageCopy[key].rating}</text>`).join('')}
    ${grid}<line x1="${left}" y1="${height - bottom}" x2="${width - right}" y2="${height - bottom}" stroke="#718198"/>
    <polyline points="${points}" fill="none" stroke="#2777d5" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}${keys.map((key, i) => `<text data-label="axis" x="${width / 2}" y="${height - 7 - (keys.length - 1 - i) * 28}" text-anchor="middle" font-size="15" fill="#405066">${imageCopy[key].match}</text>`).join('')}
  </svg>`;
}

export async function chartPng(rows, languages = ['en-us']) {
  const svg = chartSvg(rows, languages);
  if (!svg) return null;
  const keys = languageKeys(languages), height = 360 + (keys.length - 1) * 56;
  const f = new Figure(840, height, '#ffffff');
  // Rasterize axes separately; use the packaged CJK font for every label.
  const drawing = await sharp(Buffer.from(svg.replace(/<text data-label="[^"]+"[^>]*>[^<]*<\/text>/g, ''))).png().toBuffer();
  keys.forEach((key, i) => {
    f.text(imageCopy[key].rating, 86, 3 + i * 28, 720, 18, '#202d43', 25);
    f.text(imageCopy[key].match, 240, height - 27 - (keys.length - 1 - i) * 28, 590, 15, '#405066', 25);
  });
  return sharp(drawing).composite([{input: await f.png(), blend: 'multiply'}]).png().toBuffer();
}
