import sharp from 'sharp';
import {fileURLToPath} from 'node:url';
import {RequestQueue} from './monthly-report.mjs';

const fontfile = fileURLToPath(new URL('./assets/fonts/NotoSansCJKjp-Regular.otf', import.meta.url));
const escape = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export class Figure {
  constructor(width, height, background = '#111b2c') { this.width = width; this.height = height; this.background = background; this.shapes = []; this.texts = []; }
  rect(x, y, width, height, color, radius = 0) {
    this.shapes.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${color}"/>`);
  }
  text(text, x, y, width, size = 24, color = '#eef3fc', maxHeight = 100) {
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
    const background = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}"><rect width="100%" height="100%" fill="${this.background}"/>${this.shapes.join('')}</svg>`);
    return sharp(background).composite(overlays).png({compressionLevel: 9}).toBuffer();
  }
}
