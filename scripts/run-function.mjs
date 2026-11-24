// 本地 Function 启动器：把 deno 跑起来，并把 .env 里的代理配置带上。
// 为什么不用 `deno run ...` 直接写：deno 常常只装在 npx 缓存里（没有全局安装），
// 直接写会报「'deno' is not recognized」。这个脚本自己找。
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const args = ['run', '--watch', '--allow-net', '--allow-env', '--env-file=.env', 'dev/function-local.ts'];

/** 依次找：DENO_PATH 环境变量 → PATH 上的 deno → npx 缓存里的 deno。 */
function findDeno() {
  if (process.env.DENO_PATH && existsSync(process.env.DENO_PATH)) return process.env.DENO_PATH;
  const cache = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'npm-cache', '_npx');
  const roots = existsSync(cache) ? readdirSync(cache).map(name => join(cache, name)) : [];
  const candidates = [
    ...roots.map(root => join(root, 'node_modules', 'deno', 'deno.exe')),
    ...roots.map(root => join(root, 'node_modules', '@deno', 'win32-x64', 'deno.exe')),
    ...roots.map(root => join(root, 'node_modules', '.bin', 'deno.cmd')),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return null;
}

const deno = findDeno();
if (!deno) {
  console.error('找不到 deno。请先安装（npm i -g deno），或用 DENO_PATH 环境变量指到 deno.exe。');
  process.exit(1);
}
console.log(`[dev:function] 使用 ${deno}`);
const child = spawn(deno, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
child.on('exit', code => process.exit(code ?? 0));
