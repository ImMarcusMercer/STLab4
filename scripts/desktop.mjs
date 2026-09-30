import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const env = { ...process.env };
// IDEs hosted in Electron may export this. A desktop launch must not inherit it.
delete env.ELECTRON_RUN_AS_NODE;
const cli = fileURLToPath(new URL('../node_modules/electron-vite/bin/electron-vite.js', import.meta.url));
const child = spawn(process.execPath, [cli, process.argv[2] ?? 'dev'], { env, stdio: 'inherit', windowsHide: true });
child.on('error', () => { console.error('Unable to launch Electron. Run npm ci first.'); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
