// 启动本地开发环境（Vite + Deno Function），两个进程都脱离当前会话独立运行。
// 为什么不用后台任务：后台任务有 1 小时上限，到点连同子进程一起被回收。
// 用法：node scripts/dev-services.mjs start | stop | status
import { spawn, execFileSync } from 'node:child_process';
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

/**
 * 连树一起杀。
 * Function 是 node 包装进程再拉起 deno：只杀 node 会把 deno 留成孤儿，
 * 孤儿还占着 8000 端口，于是新起的 deno 绑不上端口、旧代码继续对外服务。
 */
function killTree(pid) {
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch {}
}

/** 找出还在跑本项目 Function 的 deno（按命令行认，不按 pid 认——pid 早就记不准了）。 */
function functionDenoPids() {
  if (process.platform !== 'win32') return [];
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='deno.exe'\" | Where-Object { $_.CommandLine -like '*function-local.ts*' } | ForEach-Object { $_.ProcessId }"],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\s+/).map(Number).filter(Boolean);
  } catch { return []; }
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
    if (pid && alive(pid)) { killTree(pid); console.log('stopped', pid); }
  }
  // 兜底：node 包装进程被杀后，它拉起的 deno 可能还活着占着 8000 端口。
  for (const pid of functionDenoPids()) {
    if (!alive(pid)) continue;
    killTree(pid);
    console.log('stopped function deno', pid);
  }
  try { unlinkSync(PID_FILE); } catch {}
  process.exit(0);
}

if (action === 'start') {
  // 端口被上一轮遗留的孤儿进程占着的话先收掉，否则新起的 Function 绑不上端口，
  // 外面对的还是旧代码——这个坑很安静，不会报错。
  for (const pid of functionDenoPids()) {
    if (!alive(pid)) continue;
    killTree(pid);
    console.log('cleaned stale function deno', pid);
  }
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
