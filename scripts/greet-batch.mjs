#!/usr/bin/env node
/**
 * 批量打招呼执行器（招聘端 · 推荐牛人）
 *
 * 这是 greet20.py（原先放在个人工作目录、无法随 skill 交付）的 Node 版移植与加固。
 * 现在整条链路都在 skill 内，换一台机器只要有 Node 22 + Edge/Chrome 就能直接跑。
 *
 * 相对旧脚本的加固点：
 *   1. **不再给元素打 data-agent-target 标记**。旧版为让选择器命中而打标记，
 *      又被"清理辅助函数"清掉 → 重试路径选择器失配 → 代理报 400 → 整批崩溃。
 *      现在选择器由 data-geekid 派生（稳定键），点击交给 /clickSafe 用坐标完成。
 *   2. **点击前先做命中测试**。全屏遮罩吞点击时不再"返回成功但业务零动作"——
 *      /clickSafe 会自动点掉中性关闭按钮并复测，仍不通过就拒绝点击（409）。
 *   3. 成败一律以**业务状态**判定（按钮文案变化 / 全页计数下降 / 回执弹窗出现），
 *      不看代理返回值。
 *   4. 页面不可见 → 自动走 /restore-window 恢复（不再直接熔断整批）。
 *   5. 限频交给 pacing.mjs：档位可控、风险自动拉长、硬边界不可越过、连败熔断。
 *
 * 用法：
 *   node scripts/greet-batch.mjs --plan screen.result.json [选项]
 *
 *   --plan <file>       必填。screen-talent.mjs 的输出（取其 accepted 数组），或候选数组
 *   --action <file>     动作模板，默认 templates/actions/zhipin-boss-greet.json
 *   --limit <n>         本批最多处理几个
 *   --skip <id,id>      跳过这些 id（通常用于续跑已完成的）
 *   --dry               只定位与校验，不点击
 *   --profile <name>    限频档位 conservative|balanced|efficient，默认 balanced
 *   --target <id>       标签页 targetId；省略则读 --tid-file 或自动选第一个 page
 *   --tid-file <file>   存放 targetId 的文件，默认 ./_tid.txt
 *   --proxy <url>       代理地址，默认 http://127.0.0.1:3456
 *   --touch <file>      已触达记录文件（配合 --commit 回写）
 *   --commit            把成功项写入 --touch 文件（不写则冷却期与去重会静默失效）
 *   --out <file>        结果 JSON 路径，默认 ./greet-batch-result.json
 *   --log <file>        日志路径，默认 ./greet-batch.log
 *   --json              结束时额外打印 JSON 摘要
 *
 * 退出码：0 正常结束 / 1 参数或环境错误 / 4 命中熔断（风险信号 / 连败）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextGap, resolveProfile, gate } from './pacing.mjs';
import { evalJs, clickSafe, pickTarget } from './human-click.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ACTION = path.join(ROOT, 'templates', 'actions', 'zhipin-boss-greet.json');

// ─────────────────────────────────────────────────────── CLI 解析
function parse(argv) {
  const o = {
    plan: null, action: DEFAULT_ACTION, limit: null, skip: '', dry: false,
    profile: 'balanced', target: null, tidFile: './_tid.txt', proxy: 'http://127.0.0.1:3456',
    touch: null, commit: false, out: './greet-batch-result.json', log: './greet-batch.log',
    json: false, job: '',
  };
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`用法: node scripts/greet-batch.mjs --plan <file> [选项]

  --plan <file>     必填，候选名单（screen-talent 输出或数组）
  --action <file>   动作模板，默认 ${path.relative(ROOT, DEFAULT_ACTION)}
  --limit <n>       本批最多处理几个        --skip <id,id>  跳过这些 id
  --dry             只定位校验，不点击       --profile <name> conservative|balanced|efficient
  --target <id>     标签页 id               --tid-file <file>  默认 ./_tid.txt
  --touch <file>    已触达记录             --commit           成功项回写 --touch
  --out <file>      结果 JSON               --log <file>       日志
  --json            结束时打印 JSON 摘要

环境变量: CDP_PROXY_URL 覆盖代理地址`);
    process.exit(0);
  }
  const val = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
  o.plan = val('plan');
  o.action = val('action', DEFAULT_ACTION);
  o.limit = val('limit') ? Number(val('limit')) : null;
  o.skip = val('skip', '');
  o.dry = argv.includes('--dry');
  o.profile = val('profile', 'balanced');
  o.target = val('target');
  o.tidFile = val('tid-file', './_tid.txt');
  o.proxy = val('proxy', process.env.CDP_PROXY_URL || 'http://127.0.0.1:3456');
  o.touch = val('touch');
  o.commit = argv.includes('--commit');
  o.out = val('out', './greet-batch-result.json');
  o.log = val('log', './greet-batch.log');
  o.json = argv.includes('--json');
  o.job = val('job', '');
  return o;
}

const opts = parse(process.argv.slice(2));
if (!opts.plan) { console.error('缺少 --plan <file>'); process.exit(1); }

// ─────────────────────────────────────────────────────── 基础工具
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const pad = (n) => String(n).padStart(2, '0');
const stamp = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };

function log(msg) {
  const line = `[${stamp()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(opts.log, line + '\n'); } catch { /* ignore */ }
}

async function rawJson(pathname, init = {}, timeoutMs = 30000) {
  const saved = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };
  process.env.NO_PROXY = '*'; process.env.no_proxy = '*';
  try {
    const res = await fetch(opts.proxy + pathname, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
  } catch (e) {
    return { status: 0, body: { error: String(e.message).slice(0, 160) } };
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// ─────────────────────────────────────────────────────── 页面侧 JS 生成
const frameExpr = (action) =>
  `[...document.querySelectorAll('iframe')].find(x=>(x.src||'').includes(${JSON.stringify(action.frameMatch)}))`;

function jsRisk(action) {
  const r = action.riskProbe || {};
  return `(()=>{try{
  const f=${frameExpr(action)};
  const doc=f&&f.contentDocument;
  const txt=doc?(doc.body.innerText||''):'';
  const hits=(arr)=>arr.some(t=>txt.includes(t));
  return JSON.stringify({
    vis:document.visibilityState,
    captcha:[...document.querySelectorAll(${JSON.stringify(r.captchaSelectors || '[class*=captcha]')})].filter(e=>e.offsetParent!==null).length,
    quiz:hits(${JSON.stringify(r.quizTexts || [])}),
    freq:hits(${JSON.stringify(r.freqTexts || [])}),
    loginWall:location.href.includes(${JSON.stringify(r.loginWallUrlPart || '/web/user/')})||hits(${JSON.stringify(r.loginWallTexts || [])}),
    url:location.href
  });
  }catch(e){return JSON.stringify({error:'throw:'+e.message})}})()`;
}

function jsCardState(action, gid) {
  const inner = action.card.inner.replace('{id}', gid);
  const root = (action.card.root || action.card.inner).replace('{id}', gid);
  return `(()=>{try{
  const f=${frameExpr(action)};
  if(!f||!f.contentDocument) return JSON.stringify({error:'no-frame'});
  const d=f.contentDocument;
  const dlg=[...d.querySelectorAll(${JSON.stringify(action.modal.container)})].filter(e=>getComputedStyle(e).display!=='none'&&e.offsetWidth>200);
  const innerEl=d.querySelector(${JSON.stringify(inner)});
  const rootEl=d.querySelector(${JSON.stringify(root)});
  const b=rootEl?rootEl.querySelector(${JSON.stringify(action.greetBtn)}):null;
  const c=rootEl?rootEl.querySelector(${JSON.stringify(action.continueBtn)}):null;
  return JSON.stringify({
    dlg:dlg.length,
    innerFound:!!innerEl,
    rootFound:!!rootEl,
    btnFound:!!b,
    cardGone:!innerEl,
    btn:b?(b.innerText||'').trim():'(none)',
    cont:c?(c.innerText||'').trim():null,
    greets:d.querySelectorAll(${JSON.stringify(action.counters.greet)}).length,
    cards:d.querySelectorAll(${JSON.stringify(action.counters.card)}).length
  });
  }catch(e){return JSON.stringify({error:'throw:'+e.message})}})()`;
}

// ─────────────────────────────────────────────────────── 主流程
async function main() {
  const action = JSON.parse(fs.readFileSync(opts.action, 'utf8'));
  const planRaw = JSON.parse(fs.readFileSync(opts.plan, 'utf8'));
  const all = Array.isArray(planRaw) ? planRaw : (planRaw.accepted || []);
  if (!Array.isArray(all) || !all.length) { console.error('名单为空或格式不认识（期望数组或 {accepted:[...]}）'); process.exit(1); }

  const skipIds = new Set(String(opts.skip || '').split(',').map((s) => s.trim()).filter(Boolean));
  const list = all.slice(0, opts.limit ?? all.length);

  // 限频档位
  let profile;
  try { profile = resolveProfile(opts.profile); }
  catch (e) { console.error(e.message); process.exit(1); }

  const tid = opts.target || (() => { try { return fs.readFileSync(opts.tidFile, 'utf8').trim(); } catch { return null; } })()
    || await pickTarget(opts.proxy);

  log('═'.repeat(70));
  log(`批量打招呼 · 目标 ${list.length} 人${opts.dry ? ' · [DRY 只定位不点击]' : ''} · 限频档 ${profile.label}(${profile.key})`);
  log(`标签页 ${tid}　动作模板 ${path.basename(opts.action)}`);
  if (skipIds.size) log(`显式跳过 ${skipIds.size} 人`);

  // 日额度闸门
  let todayTouched = 0;
  if (opts.touch && fs.existsSync(opts.touch)) {
    try {
      const t = JSON.parse(fs.readFileSync(opts.touch, 'utf8'));
      const today = new Date().toISOString().slice(0, 10);
      todayTouched = t.filter((x) => String(x.ts || '').startsWith(today.replace(/-/g, '-')) || String(x.ts || '').startsWith(today)).length;
    } catch { /* ignore */ }
  }
  const g = gate(profile, { todayTouched });
  log(`额度闸门：今日 ${g.todayTouched}/${g.dailyMax}　剩余 ${g.quotaLeft}　时段 ${g.inWindow ? '合规' : '不合规'}`);
  if (!g.allowed) {
    log(`⛔ 闸门不允许执行：${g.reasons.join('；')}`);
    if (!opts.dry) process.exit(3);
  }

  const results = [];
  let doneCount = 0;          // 真正执行过的（用于限频序号）
  let lastRisk = false;       // 上一轮是否命中风险信号
  let consecutiveFail = 0;    // 连续失败计数
  let cardGoneCount = 0;      // 「卡片已不在」的计数（用于判断模板是否失效）
  let stopReason = null;

  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const idx = i + 1;

    if (skipIds.has(t.id)) {
      log(`[${idx}/${list.length}] ↷ ${t.name || t.id} 在跳过列表，忽略`);
      results.push({ ...t, status: 'skipped-prior' });
      continue;
    }

    // ── 限频等待（首次不等待）
    if (!opts.dry && doneCount > 0) {
      const gap = nextGap(profile, { index: doneCount, risk: lastRisk });
      log(`[${idx}/${list.length}] 限频等待 ${gap.seconds}s（${gap.reason}）`);
      await sleep(gap.seconds * 1000);
    }
    lastRisk = false;   // 每轮重置，由本轮信号决定

    // ── 风险闸门
    if (!opts.dry) {
      const risk = await evalJs(opts.proxy, tid, jsRisk(action)).catch(() => null);
      const r = typeof risk === 'string' ? (() => { try { return JSON.parse(risk); } catch { return null; } })() : risk;
      if (r) {
        if (r.quiz) { stopReason = 'STOP:页面要求答题（平台已判定违规后的处置动作）'; break; }
        if (r.freq) { stopReason = 'STOP:出现「操作过于频繁／次数已用完」'; break; }
        if (r.captcha) { stopReason = 'STOP:出现验证码'; break; }
        if (r.loginWall) { stopReason = 'STOP:登录失效'; break; }
        if (r.vis !== 'visible') {
          log('  ⚠ 页面不可见（窗口可能被最小化），尝试自动恢复…');
          const rw = await rawJson(`/restore-window?target=${encodeURIComponent(tid)}&all=1`, {}, 20000);
          log(`  restore-window → ${JSON.stringify(rw.body).slice(0, 180)}`);
          await sleep(1500);
          const again = await evalJs(opts.proxy, tid, jsRisk(action)).catch(() => null);
          const r2 = typeof again === 'string' ? (() => { try { return JSON.parse(again); } catch { return null; } })() : again;
          if (r2?.vis === 'visible') log('  ✓ 窗口已恢复可见，继续');
          else { stopReason = `STOP:页面不可见（自动恢复失败：${r?.vis}）`; break; }
        }
      }
    }

    // ── 读取卡片状态
    const stateRaw = await evalJs(opts.proxy, tid, jsCardState(action, t.id)).catch(() => null);
    const s0 = typeof stateRaw === 'string' ? (() => { try { return JSON.parse(stateRaw); } catch { return null; } })() : stateRaw;

    if (!s0 || s0.error) {
      log(`[${idx}/${list.length}] ✗ ${t.name || t.id} 读取卡片失败：${JSON.stringify(s0).slice(0, 160)}`);
      results.push({ ...t, status: 'failed', note: `读取卡片失败 ${s0?.error || ''}` });
      consecutiveFail += 1;
      if (consecutiveFail >= 2) { stopReason = 'STOP:连续 2 次失败，熔断以免扩大异常'; break; }
      doneCount += 1;
      continue;
    }

    const contTexts = action.successSignals?.continueTexts || ['继续沟通'];
    if (s0.cardGone || (s0.cont && contTexts.some((x) => s0.cont.includes(x)))) {
      cardGoneCount += 1;
      log(`[${idx}/${list.length}] ↷ ${t.name || t.id} 已是「${s0.cont || '继续沟通'}」或卡片已不在，跳过`);
      results.push({ ...t, status: 'skipped-already' });
      continue;
    }

    // 模板自检：卡片在、但点击定位根找不到 → 选择器模板过时。
    // 这一条至关重要：不检查的话会静默跳过，重演「每轮都成功、实际零动作」。
    if (s0.innerFound && !s0.rootFound) {
      log(`[${idx}/${list.length}] ⛔ ${t.name || t.id} 卡片存在但点击定位失败 —— 动作模板的选择器可能已过时`);
      results.push({ ...t, status: 'failed', note: 'root 选择器未命中，模板可能过时' });
      consecutiveFail += 1;
      if (consecutiveFail >= 2) { stopReason = 'STOP:连续 2 次定位失败（疑似动作模板过时），熔断'; break; }
      doneCount += 1;
      continue;
    }

    if (!s0.btnFound || s0.btn === '(none)') {
      log(`[${idx}/${list.length}] ↷ ${t.name || t.id} 该卡片无打招呼按钮，跳过（可能已过期/不匹配）`);
      results.push({ ...t, status: 'skipped-nobutton' });
      continue;
    }

    const rootSel = (action.card.root || action.card.inner).replace('{id}', t.id);
    const greetSel = `frame:${action.frameMatch} ||| ${rootSel} ${action.greetBtn}`;
    const boxSel = `frame:${action.frameMatch} ||| ${rootSel}`;

    // dry 模式额外做一次「点击选择器能否命中」的静态校验 —— 它才是真正决定点击落点的选择器
    if (opts.dry) {
      const hitRaw = await evalJs(opts.proxy, tid, `(()=>{const f=${frameExpr(action)};const d=f&&f.contentDocument;if(!d)return 'no-frame';return String(d.querySelectorAll(${JSON.stringify(greetSel.split('|||')[1].trim())}).length)})()`).catch(() => 'err');
      const hitN = String(typeof hitRaw === 'object' ? hitRaw?.value : hitRaw).trim();
      const okHit = hitN === '1';
      log(`[${idx}/${list.length}] ${okHit ? '✔' : '✗'} ${t.name || t.id} · ${t.title || ''}｜按钮「${s0.btn}」｜点击选择器命中 ${hitN} 个｜全页按钮数 ${s0.greets}`);
      results.push({ ...t, status: okHit ? 'dry-ok' : 'failed', btnText: s0.btn, clickSelHits: hitN });
      if (!okHit) consecutiveFail += 1;
      doneCount += 1;
      continue;
    }

    // ── hover 到卡片（拟人 + 触发可能的 hover 显现）
    if (action.preClick?.hoverCard !== false) {
      await rawJson(`/mouseMove?target=${encodeURIComponent(tid)}&steps=8&selector=${encodeURIComponent(boxSel)}`, {}, 20000).catch(() => {});
      const pause = action.preClick?.hoverPauseMs || [700, 1800];
      await sleep(rand(pause[0], pause[1]));
    }

    // ── 点击 + 业务校验（最多两次；重试是完整重跑，不依赖任何标记）
    let ok = false; let lastState = null; let usedSafe = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const greetsBefore = s0.greets;
      const click = await clickSafe({ proxy: opts.proxy, target: tid, selector: greetSel });
      if (!click.ok) {
        usedSafe = true;
        log(`  ✗ 第${attempt}次点击未执行（HTTP ${click.status}）：${click.body?.blocked ? '被遮挡且未能解除' : click.body?.invisible ? '元素不可见' : click.body?.error || ''}`);
        if (click.body?.notes?.length) click.body.notes.forEach((n) => log(`     · ${n}`));
      } else if (click.body?.notes?.length) {
        click.body.notes.forEach((n) => log(`     · ${n}`));
      }

      // 轮询业务状态
      const waitS = attempt === 1 ? (action.verify.pollSeconds || 15) : (action.verify.pollSecondsRetry || 10);
      const interval = action.verify.intervalMs || 800;
      const t0 = Date.now();
      while (Date.now() - t0 < waitS * 1000) {
        await sleep(interval);
        const sr = await evalJs(opts.proxy, tid, jsCardState(action, t.id)).catch(() => null);
        const s = typeof sr === 'string' ? (() => { try { return JSON.parse(sr); } catch { return null; } })() : sr;
        if (!s || s.error) continue;
        lastState = s;
        const sentByCont = !!s.cont && contTexts.some((x) => s.cont.includes(x));
        const sentByModal = action.successSignals?.modalAppearsMeansSent !== false && s.dlg > 0;
        const sentByCount = action.successSignals?.counterDropMeansSent !== false && typeof s.greets === 'number' && s.greets < greetsBefore;
        if (sentByCont || sentByModal || sentByCount) {
          ok = true;
          log(`  ✓ 第${attempt}次点击生效（+${((Date.now() - t0) / 1000).toFixed(1)}s）` +
              `按钮=${s.cont || s.btn}　遮罩=${s.dlg}　全页按钮数=${s.greets}(起始 ${greetsBefore})` +
              `${sentByCont ? ' [文案]' : sentByModal ? ' [回执弹窗]' : ' [计数下降]'}`);
          break;
        }
      }
      if (ok) break;

      log(`  ✗ 第${attempt}次点击 ${waitS}s 内无业务变化　状态=${JSON.stringify(lastState).slice(0, 160)}`);
      // 只有确认「确实没发出去」才重试
      if (lastState && (lastState.cont || lastState.cardGone)) { log('  → 目标状态已变化，不再重试'); break; }
    }

    if (ok) {
      consecutiveFail = 0;
      results.push({ ...t, status: 'succeeded', btnAfter: lastState?.cont, greetsAfter: lastState?.greets });
      log(`[${idx}/${list.length}] ✅ ${t.name || t.id} · ${t.title || ''} 已送达`);
    } else {
      consecutiveFail += 1;
      lastRisk = true;
      results.push({ ...t, status: 'unverified', btnAfter: lastState?.btn, note: '两次点击均无业务变化' });
      log(`[${idx}/${list.length}] ⚠ ${t.name || t.id} 未确认送达（下次间隔将拉长）`);
      if (consecutiveFail >= 2) { stopReason = 'STOP:连续 2 次未确认送达，熔断以免扩大异常'; break; }
    }
    doneCount += 1;
    if (usedSafe) lastRisk = true;   // 出现过遮挡/元素异常 → 下次拉长
  }

  // ─────────────────────────────────────────────────── 收尾
  const succeeded = results.filter((r) => r.status === 'succeeded');
  const skipped = results.filter((r) => String(r.status).startsWith('skipped'));
  const failed = results.filter((r) => ['failed', 'unverified'].includes(r.status));

  log('═'.repeat(70));
  log(`完成：成功 ${succeeded.length} / 跳过 ${skipped.length} / 未确认 ${failed.length} / 目标 ${list.length}`);
  if (stopReason) log(`熔断原因：${stopReason}`);
  // 模板失效的强提示：大部分卡片都"找不到"，通常不是人不在，而是选择器过时了
  if (cardGoneCount > list.length / 2 && list.length >= 4) {
    log(`⚠ 提示：${cardGoneCount}/${list.length} 个目标都定位不到卡片。若你确认这些卡片应当存在，`);
    log(`  说明动作模板的选择器已随站点改版失效 —— 请按 SKILL.md「首次执行必做：结构探测」重新探测并更新`);
    log(`  templates/actions/zhipin-boss-greet.json。`);
  }

  fs.writeFileSync(opts.out, JSON.stringify(results, null, 2), 'utf8');

  if (opts.commit && opts.touch) {
    let touch = [];
    try { touch = JSON.parse(fs.readFileSync(opts.touch, 'utf8')); } catch { touch = []; }
    const have = new Set(touch.map((x) => x.id));
    const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
    let added = 0;
    for (const r of succeeded) {
      if (have.has(r.id)) continue;
      touch.push({ id: r.id, name: r.name || '', title: r.title || '', ts, status: 'sent', via: 'recommend', job: opts.job || '' });
      added += 1;
    }
    fs.writeFileSync(opts.touch, JSON.stringify(touch, null, 2), 'utf8');
    log(`触达记录已回写：新增 ${added} 条 → ${opts.touch}（累计 ${touch.length} 条）`);
  } else if (succeeded.length) {
    log('⚠ 未传 --commit，本次触达未写入记录文件 —— 冷却期与去重将失去依据，请记得补写。');
  }

  const summary = {
    ok: failed.length === 0 && !stopReason,
    targets: list.length, succeeded: succeeded.length, skipped: skipped.length, failed: failed.length,
    profile: profile.key, stopReason, names: succeeded.map((r) => r.name || r.id),
  };
  if (opts.json) console.log(JSON.stringify(summary, null, 2));
  process.exit(stopReason ? 4 : (failed.length ? 1 : 0));
}

main().catch((e) => { console.error('异常终止：', e.message); process.exit(1); });
