import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {GameApi} from '../../bot-core/src/api.mjs';
import {MonthlyReports} from '../../bot-core/src/monthly-report.mjs';

// Offline preparation: only public URLs supplied on the command line; never loads private config.
const {values} = parseArgs({options: {month: {type: 'string'}, 'api-url': {type: 'string'}, 'web-url': {type: 'string'}}});
if (!values['api-url'] || !values['web-url']) throw new Error('Usage: npm run report:prepare -- --month YYYY-MM --api-url https://GAME_API/ --web-url https://PUBLIC_WEB/');
for (const key of ['api-url', 'web-url']) {
  const url = new URL(values[key]);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Use public HTTP(S) URLs without credentials');
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reports = new MonthlyReports({root, api: new GameApi({baseUrl: values['api-url'], timeoutMs: 15000}),
  config: {webBaseUrl: values['web-url']}, guide: {introUrl: new URL('intro.html', values['web-url']).toString()}});
const report = await reports.export(values.month);
if (!report.archive) console.log(`No data: ${report.model.month}`);
else {
  const directory = await reports.safeDirectory(path.join(reports.artifactDir, report.model.month));
  const archive = path.join(directory, report.archive.name);
  await fs.writeFile(archive, report.archive.data);
  console.log(`Images: ${path.join(directory, report.batch)}`);
  console.log(`X assets: ${archive} (${report.archive.data.length} bytes)`);
}
