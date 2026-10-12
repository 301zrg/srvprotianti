import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createWorkerSupervisor} from '../../bot-core/src/worker-supervisor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const supervisor = createWorkerSupervisor({root, platform: 'qq'});
process.once('SIGINT', supervisor.stop);
process.once('SIGTERM', supervisor.stop);
supervisor.start();
