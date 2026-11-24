// 启动本地开发环境（Vite + Deno Function），两个进程都脱离当前会话独立运行。
// 为什么不用后台任务：后台任务有 1 小时上限，到点连同子进程一起被回收。
// 用法：node scripts/dev-services.mjs start | stop | status
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Socket } from 'node:net';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const LOG_DIR = join(ROOT, 'dev');
const PID_FILE = join(LOG_DIR, 'dev-services.pid');
mkdirSync(LOG_DIR, { recursive: true });

function findDeno() {
  const cache = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'npm-cache', '_npx');
  if (!existsSync(cache)) return null;
  const roots = readdirSync(cache).map(name => join(cache, name));
  const candidates = [
    ...roots.map(root => join(root, 'node_modules', 'deno', 'deno.exe')),
    ...roots.map(root => join(root, 'node_modules', '@deno', 'win32-x64', 'deno.exe')),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return null;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPids() {
  if (!existsSync(PID_FILE)) return {};
  try { return JSON.parse(readFileSync(PID_FILE, 'utf8')); } catch { return {}; }
}

function portOpen(port) {
  return new Promise(resolve => {
    const socket = new Socket();
    socket.setTimeout(800);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.connect(port, '127.0.0.1');
  });
}

const action = process.argv[2] || 'status';

if (action === 'stop') {
  const pids = readPids();
  for (const pid of Object.values(pids)) {
    if (pid && alive(pid)) { try { process.kill(pid, 'SIGTERM'); console.log('stopped', pid); } catch {} }
  }
  try { unlinkSync(PID_FILE); } catch {}
  process.exit(0);
}

if (action === 'start') {
  // 直接 spawn node + vite 的 bin：npm.cmd 是批处理文件，detached 模式下 spawn 会 EINVAL
  const viteBin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const viteLog = openSync(join(LOG_DIR, 'vite.log'), 'a');
  const vite = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', '5173', '--strictPort'], { cwd: ROOT, detached: true, stdio: ['ignore', viteLog, viteLog], windowsHide: true });
  vite.unref();
  const deno = findDeno();
  let fn = null;
  if (deno) {
    // 复用 run-function.mjs：找 deno、加载 .env 都只维护一份
    fn = spawn(process.execPath, [join(ROOT, 'scripts', 'run-function.mjs')],
      { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
    fn.unref();
  } else console.error('找不到 deno，Function 未启动');
  writeFileSync(PID_FILE, JSON.stringify({ vite: vite.pid, function: fn?.pid ?? null }));
  console.log(`vite pid=${vite.pid} function pid=${fn?.pid ?? 'n/a'}`);
  process.exit(0);
}

const pids = readPids();
console.log(JSON.stringify({
  vite: { pid: pids.vite ?? null, alive: pids.vite ? alive(pids.vite) : false, port5173: await portOpen(5173) },
  function: { pid: pids.function ?? null, alive: pids.function ? alive(pids.function) : false, port8000: await portOpen(8000) },
}, null, 2));
