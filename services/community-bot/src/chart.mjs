import sharp from 'sharp';

export function chartValues(rows) {
  const matches = (Array.isArray(rows) ? rows : []).filter(row =>
    Number.isFinite(Number(row?.pointsBefore)) && Number.isFinite(Number(row?.pointsAfter)));
  if (!matches.length) return [];
  return [Number(matches[0].pointsBefore), ...matches.map(row => Number(row.pointsAfter))];
}

export function chartSvg(rows) {
  const values = chartValues(rows);
  if (!values.length) return null;
  const width = 840, height = 360, left = 86, right = 34, top = 32, bottom = 64;
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
    <text x="${x(index)}" y="${height - 32}" text-anchor="middle" font-size="15" fill="#405066">${index}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#ffffff"/>
    <text x="${left}" y="23" font-size="18" font-family="sans-serif" fill="#202d43">Rating over recent matches</text>
    ${grid}<line x1="${left}" y1="${height - bottom}" x2="${width - right}" y2="${height - bottom}" stroke="#718198"/>
    <polyline points="${points}" fill="none" stroke="#2777d5" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}<text x="${width / 2}" y="${height - 7}" text-anchor="middle" font-size="15" fill="#405066">Match (0 = before first)</text>
  </svg>`;
}

export async function chartPng(rows) {
  const svg = chartSvg(rows);
  return svg ? sharp(Buffer.from(svg)).png().toBuffer() : null;
}
