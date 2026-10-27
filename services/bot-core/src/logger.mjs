import fs from 'node:fs/promises';
import path from 'node:path';

export class FileLogger {
  constructor(filename) {
    this.filename = filename;
    this.pending = Promise.resolve();
  }

  write(event, fields = {}) {
    const record = JSON.stringify({time: new Date().toISOString(), event, ...fields}) + '\n';
    this.pending = this.pending.then(async () => {
      await fs.mkdir(path.dirname(this.filename), {recursive: true});
      await fs.appendFile(this.filename, record, 'utf8');
    }).catch(error => {
      process.stderr.write(`Unable to write community bot log: ${error.code || 'unknown'}\n`);
    });
    return this.pending;
  }
}

// Platform errors may contain request headers. Keep only short platform codes and
// a known denial string; never serialize whole SDK errors or HTTP responses.
export function platformErrorCode(error) {
  const code = error?.bizCode ?? error?.code ?? error?.err_code ?? error?.rawError?.code ?? error?.data?.code ?? error?.httpStatus;
  if (typeof code === 'number' || /^[A-Z_0-9-]{1,40}$/.test(String(code || ''))) return String(code);
  if (/40034102|主动消息失败|无权限/.test(String(error?.message || ''))) return '40034102';
  return 'unknown';
}
