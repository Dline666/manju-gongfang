import { handler } from "../functions/handler.ts";

/**
 * 代理不可用时回退直连。
 *
 * Deno 的 fetch 会自动读取 HTTP_PROXY / HTTPS_PROXY。如果 .env 里配了代理、
 * 而代理软件没开，**每一个**上游请求都会连接被拒（fetch failed），
 * 用户看到的却是「未收到服务商明确结果」——完全指不到真正的原因。
 *
 * 代理是锦上添花，不该让整个服务不可用：启动时先探一下，连不上就摘掉这些变量。
 */
const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"];

/** 能不能连上代理端口：只探 TCP，不握手，1.5 秒足够判死。 */
async function reachable(hostname: string, port: number): Promise<boolean> {
  const deadline = new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1500));
  const attempt = (async () => {
    try {
      const connection = await Deno.connect({ hostname, port });
      connection.close();
      return true;
    } catch { return false; }
  })();
  return await Promise.race([attempt, deadline]);
}

async function dropDeadProxies(): Promise<void> {
  const configured = PROXY_KEYS.map(key => [key, Deno.env.get(key)] as const).filter(([, value]) => value);
  if (!configured.length) return;
  for (const [key, value] of configured) {
    let url: URL;
    try { url = new URL(value); } catch { Deno.env.delete(key); console.warn(`[dev:function] ${key} 不是合法地址，已忽略。`); continue; }
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    if (await reachable(url.hostname, port)) continue;
    // 端口上没人监听：留着它只会让所有请求失败，不如直连。
    for (const fallback of PROXY_KEYS) Deno.env.delete(fallback);
    console.warn(`[dev:function] ${key} 指向 ${url.hostname}:${port}，但连不上（代理软件没开？）——已回退直连。`);
    return;
  }
}

await dropDeadProxies();
Deno.serve({ hostname: "127.0.0.1", port: 8000 }, handler);