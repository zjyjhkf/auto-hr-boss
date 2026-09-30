#!/usr/bin/env node
/**
 * 一键拉起招聘端自动化会话。
 *
 * 把原来需要 6~8 次工具调用、人工反复试的启动流程压成一条命令：
 *   1) 精确结束占用调试端口的旧浏览器（不影响你日常用的 Edge）
 *   2) 启动带 CDP 的浏览器（lean 瘦身档 + 防遮挡参数），等它真正 READY
 *   3) 启动 CDP 代理，等它 connected
 *   4) 定位目标页面 tab，打印 targetId（并可按需写入文件）
 *
 * 每一步都打印耗时，便于日后回归对比。
 *
 * 用法：
 *   node scripts/start-session.mjs
 *   node scripts/start-session.mjs --url https://www.zhipin.com/web/chat/recommend \
 *        --page-match zhipin.com --tid-out ../_tid.txt
 *   node scripts/start-session.mjs --reuse        # 浏览器已在跑就复用，不重启
 *   node scripts/start-session.mjs --no-proxy     # 只起浏览器
 */

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const flag = (n) => args.includes('--' + n);

if (flag('help')) {
  console.log(`用法: node scripts/start-session.mjs [选项]

  --url <url>         起始页面，默认 https://www.zhipin.com/web/chat/recommend
  --page-match <s>    目标 tab 的 URL 关键词，默认 zhipin.com
  --tid-out <file>    把目标 tab 的 targetId 写入该文件
  --browser <id>      edge（默认）| chrome
  --port <n>          调试端口，默认 9222
  --proxy-port <n>    代理端口，默认 3456
  --reuse             调试端口已活就直接复用，不重启浏览器
  --no-proxy          只起浏览器，不碰代理
  --hold              就绪后**保持阻塞不退出**（关键，见下）
  --no-kill           不结束旧进程（可能与 --reuse 冲突时自便）

⚠️ 关于 --hold（实测踩过）：
   在沙箱/任务系统里以后台任务方式运行时，**任务命令一旦返回，它派生的整棵进程树都会被回收**，
   即使子进程做了 detached + unref 也一样。所以起完就退 = 浏览器和代理立刻被杀。
   加 --hold 让本脚本前台阻塞，浏览器与代理就随这个后台任务一起存活：
   任务结束（或 Ctrl-C）→ 整树回收，环境干净。`);
  process.exit(0);
}

const URL_ = opt('url', 'https://www.zhipin.com/web/chat/recommend');
const PAGE_MATCH = opt('page-match', 'zhipin.com');
const TID_OUT = opt('tid-out');
const BROWSER = opt('browser', 'edge');
const PORT = parseInt(opt('port', '9222'), 10);
const PROXY_PORT = parseInt(opt('proxy-port', '3456'), 10);
const REUSE = flag('reuse');
const NO_PROXY = flag('no-proxy');
const NO_KILL = flag('no-kill');
const HOLD = flag('hold');

const SYS = process.env.SystemRoot || 'C:\\Windows';
const NETSTAT = path.join(SYS, 'System32', 'netstat.exe');
const TASKKILL = path.join(SYS, 'System32', 'taskkill.exe');
const PROXY_LOG = path.join(os.tmpdir(), 'cdp-proxy.log');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
const el = () => ((Date.now() - T0) / 1000).toFixed(2) + 's';

function pidsOnPort(port) {
  let out = '';
  try { out = execSync(`"${NETSTAT}" -ano -p TCP`, { encoding: 'latin1', maxBuffer: 64 * 1024 * 1024 }); }
  catch { return []; }
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    if (line.includes(`:${port} `) && line.includes('LISTENING')) {
      const m = line.trim().match(/(\d+)\s*$/);
      if (m) pids.add(m[1]);
    }
  }
  return [...pids];
}

function killPids(pids) {
  for (const pid of pids) {
    try { execSync(`"${TASKKILL}" /F /T /PID ${pid}`, { stdio: 'ignore' }); } catch { /* ignore */ }
  }
}

async function getJson(u, ms) {
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(ms) });
    return await r.json();
  } catch { return null; }
}

async function main() {
  console.log(`[start] 目标页面 ${URL_}`);
  console.log('');

  // ── 1) 清理旧进程 ──────────────────────────────────────────────────────
  const browserAlive = (await getJson(`http://127.0.0.1:${PORT}/json/version`, 800)) !== null;

  if (browserAlive && REUSE) {
    console.log(`[1/4] 复用已运行的浏览器 (端口 ${PORT}, ${el()})`);
  } else {
    if (browserAlive && !NO_KILL) {
      const old = pidsOnPort(PORT);
      if (old.length) { console.log(`[1/4] 结束旧浏览器 PID ${old.join(',')} (${el()})`); killPids(old); }
      await sleep(500);
    } else {
      console.log(`[1/4] 无需清理旧浏览器 (${el()})`);
    }
    // 旧代理也要清，否则它会攥着失效的 wsPath
    if (!NO_PROXY) {
      const oldProxy = pidsOnPort(PROXY_PORT);
      if (oldProxy.length) {
        console.log(`      结束旧代理 PID ${oldProxy.join(',')} (${el()})`);
        killPids(oldProxy);
        await sleep(300);
      }
    }
  }

  // ── 2) 启动浏览器并等 READY ────────────────────────────────────────────
  if (browserAlive && REUSE) {
    // 复用时补写端点文件
    const v = await getJson(`http://127.0.0.1:${PORT}/json/version`, 1500);
    if (v?.webSocketDebuggerUrl) {
      const { writeEndpoint } = await import('./browser-discovery.mjs');
      writeEndpoint({ browserId: BROWSER, port: PORT, wsUrl: v.webSocketDebuggerUrl, pid: pidsOnPort(PORT)[0] ?? null });
      console.log(`[2/4] 端点文件已刷新 (${el()})`);
    }
  } else {
    console.log(`[2/4] 启动浏览器（lean 瘦身档）...`);
    const r = spawn(NODE, [
      path.join(HERE, 'launch-browser.mjs'),
      '--browser', BROWSER, '--port', String(PORT), '--url', URL_, '--wait', '60',
    ], { stdio: 'inherit' });
    const code = await new Promise(res => r.on('exit', res));
    if (code !== 0) {
      console.error(`❌ 浏览器未就绪（退出码 ${code}）`);
      process.exit(1);
    }
  }

  if (NO_PROXY) {
    console.log(`\n[start] 完成（--no-proxy）总耗时 ${el()}`);
    return;
  }

  // ── 3) 启动代理并等 connected ──────────────────────────────────────────
  console.log(`[3/4] 启动 CDP 代理 ...`);
  const logFd = fs.openSync(PROXY_LOG, 'a');
  const proxy = spawn(NODE, [path.join(HERE, 'cdp-proxy.mjs')], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  proxy.unref();
  fs.closeSync(logFd);

  const deadline = Date.now() + 30000;
  let ok = false;
  while (Date.now() < deadline) {
    const h = await getJson(`http://127.0.0.1:${PROXY_PORT}/health`, 1500);
    if (h?.status === 'ok' && h.connected) { ok = true; break; }
    await sleep(250);
  }
  if (!ok) {
    console.error(`❌ 代理 30s 内未连上浏览器。日志: ${PROXY_LOG}`);
    process.exit(1);
  }
  console.log(`      代理就绪 (端口 ${PROXY_PORT}, ${el()})`);

  // ── 4) 定位目标 tab ────────────────────────────────────────────────────
  const targets = await getJson(`http://127.0.0.1:${PROXY_PORT}/targets`, 8000);
  const pages = Array.isArray(targets) ? targets.filter(t => t.type === 'page') : [];
  const hit = pages.find(t => (t.url || '').includes(PAGE_MATCH));
  console.log(`[4/4] 页面 tab 共 ${pages.length} 个 (${el()})`);
  if (!hit) {
    console.log(`      ⚠️ 没有匹配 "${PAGE_MATCH}" 的页面。现有页面：`);
    for (const p of pages) console.log(`        - ${p.url}`);
  } else {
    console.log(`      TID=${hit.targetId}`);
    console.log(`      ${hit.url}`);
    if (TID_OUT) {
      fs.writeFileSync(TID_OUT, hit.targetId, 'utf8');
      console.log(`      已写入 ${TID_OUT}`);
    }
  }

  console.log(`\n[start] ✅ 全部就绪，总耗时 ${el()}`);
  console.log(`        代理 http://127.0.0.1:${PROXY_PORT}   调试端口 ${PORT}`);
  console.log(`        日志 ${PROXY_LOG}`);

  if (!HOLD) {
    console.log('');
    console.log('⚠️  未加 --hold：本进程退出后，浏览器与代理可能被一并回收。');
    console.log('    以后台任务方式使用时请加 --hold。');
    return;
  }

  console.log('');
  console.log('[start] --hold：保持运行中。结束本任务即回收浏览器与代理。');
  const shutdown = (sig) => {
    console.log(`\n[start] 收到 ${sig}，清理进程 ...`);
    if (!NO_PROXY) killPids(pidsOnPort(PROXY_PORT));
    if (!REUSE) killPids(pidsOnPort(PORT));
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // 长驻：每 30s 打一次心跳，便于日志确认链路还活着
  for (;;) {
    await sleep(30000);
    const h = await getJson(`http://127.0.0.1:${PROXY_PORT}/health`, 2000);
    if (!h?.connected) {
      console.log(`[start] ⚠️ 代理已断开（${new Date().toLocaleTimeString()}），尝试重连 ...`);
      const again = await getJson(`http://127.0.0.1:${PROXY_PORT}/targets`, 8000);
      if (!Array.isArray(again)) console.log('[start] ⚠️ 重连未成功，稍后自动再试');
      else console.log('[start] ✅ 已恢复');
    }
  }
}

main().catch(e => { console.error('[start] 失败:', e); process.exit(1); });
