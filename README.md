# auto-hr-boss

**BOSS 直聘招聘端自动化工具** —— 通过 CDP（Chrome DevTools Protocol）直连你**本机已登录的** Edge / Chrome，
用真实浏览器完成招聘端的批量操作：拉取推荐牛人、按 JD 筛选简历、批量打招呼、回写触达记录。

它同时是一套**通用的浏览器自动化 skill**——搜索、抓取、填表、登录后操作、动态页面渲染，都能用。

| | |
|---|---|
| **版本** | 2.6.0 |
| **作者** | [健衡医疗](https://github.com/shuaibiq6) |
| **许可** | MIT |
| **运行环境** | Node.js ≥ 22 + Edge / Chrome，**零第三方依赖** |

---

## 为什么不是"又一个爬虫脚本"

| 特性 | 说明 |
|---|---|
| **零第三方依赖** | 全部脚本只 import Node 内置模块，`git clone` 后直接跑，**不需要 `npm install`** |
| **不碰你的日常浏览器** | 使用独立副本 profile（`%LOCALAPPDATA%\EdgeCDP`），不影响你正在用的窗口、书签和登录态 |
| **动作是"真人式"的** | 鼠标走三次贝塞尔曲线、ease-out 非匀速、末段过冲回正、点击前瞄准延迟 |
| **点击前做命中测试** | `POST /clickSafe` 先测落点，被遮罩挡住会自动关闭中性弹窗；关不掉就**返回 409 且不点击** |
| **限频可审计** | 等待时间由 `pacing.mjs` 统一裁决，不会散落在各脚本里各自 `sleep(random())` |
| **成败只看业务状态** | 不信任代理返回值，以「按钮文案变化 / 全局计数下降 / 节点消失」判定，杜绝"每轮都成功、实际零动作" |

---

## 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Windows 10+ / macOS 12+ / Linux | CDP 代理适配三平台的浏览器路径与进程管理 |
| **Node.js** | **≥ 22（必需）** | 用到原生 `WebSocket` / `fetch` / `AbortSignal.timeout`，Node 20 及以下**无法运行** |
| 浏览器 | Microsoft Edge 或 Google Chrome（桌面版） | 通过 CDP 直连，天然携带登录态 |
| 网络 | 能访问目标站点；localhost 回环可用 | 代理监听 `127.0.0.1:3456`，浏览器调试端口 `127.0.0.1:9222` |
| 磁盘 | ≥ 200 MB 空闲 | 浏览器副本用户数据目录 |
| 权限 | 对目录有**写权限**即可 | **不需要**管理员 / root |

> **不需要**：Python、npm、Docker、管理员权限、任何系统级服务安装。

```bash
node -v        # 需要 v22.x 或更高
```

Node 版本不足时推荐用 winget / Homebrew / 官网 LTS 安装包升级，**不要动系统自带的旧版本**。

---

## 安装

```bash
git clone https://github.com/shuaibiq6/auto-hr-boss.git
cd auto-hr-boss
```

也可以直接下载 zip 解压，效果一样。

---

## 快速上手（三步）

### 第 1 步：环境自检

```bash
node scripts/setup-env.mjs
```

它会检查 10 项：平台、Node 版本、第三方依赖、浏览器、副本 profile 可写性、目录写权限、端口占用、端点文件时效等。
看到「结论：全绿，可直接使用」就可以继续。

```
✓ [OK  ] Node.js v22.22.2
✓ [OK  ] 第三方依赖：无
✓ [OK  ] 浏览器：检测到 Microsoft Edge
✓ [OK  ] 副本用户目录可写
✓ [OK  ] skill 目录可写
✓ [OK  ] 端口 3456：空闲
```

- 退出码：`0` 全绿 / `2` 有需确认项 / `1` 有阻塞项。每个 FAIL 项都会直接给出解决指引。
- 加 `--fix`：自动建目录、从模板生成 `config.env`、清理过期端点文件。
- 加 `--json`：输出机器可读报告。

### 第 2 步：拉起浏览器会话

```bash
node scripts/start-session.mjs \
  --url https://www.zhipin.com/web/chat/recommend \
  --page-match zhipin.com \
  --tid-out ./_tid.txt
```

一条命令依次完成「按调试端口清掉旧浏览器进程 → 启动带调试端口的浏览器 → 等待 CDP 就绪 → 启动代理 → 定位目标标签页」，
正常 **5–10 秒**跑完，并把目标标签页 id 写入 `_tid.txt`。

> **关键：登录态不会随代码迁移。**
> 这一步启动的是**本机**的浏览器副本 profile，新环境上是全新状态。
> **第一次使用需要在该窗口里手动登录 BOSS 直聘**（登录后 profile 被复用，下次不用重登）。
> 这是设计使然——登录凭据不该、也无法作为可打包资产传递。

### 第 3 步：验证链路

```bash
node scripts/human-click.mjs --selector "body" --json
```

返回 `"ok": true` 就说明整条链路（浏览器 → 代理 → 输入域）通畅。

---

## 核心场景：BOSS 招聘端批量打招呼

### 流程总览

```
拉取候选人池  →  按 JD 筛选（准入闸门）  →  限频节拍器出时间表  →  批量打招呼  →  回写触达记录
   ↓                  ↓                        ↓                    ↓              ↓
浏览器滚动       screen-talent.mjs        pacing.mjs         greet-batch.mjs    --commit
```

### 1）准备 JD 与候选人名单

`screen-talent.mjs` 是**招聘方准入闸门**，按 JD 要求与候选人简历做匹配度打分，输出降序名单。

```bash
# 生成配置模板
node scripts/screen-talent.mjs --init

# 运行筛选
node scripts/screen-talent.mjs \
  --job screen.job.json \
  --talent talent.json \
  --touch screen.touch.json \
  --out screen.result.json
```

闸门分四层：**G0 红线**（硬性不匹配直接淘汰）/ **G1 匹配度** / **G2 批次** / **G3 时序**。
被拒的人会写明理由，不是黑箱。

### 2）先演练，再正式执行

```bash
# DRY：不点击，但会校验「真正的点击选择器」能否命中
node scripts/greet-batch.mjs --plan screen.result.json --limit 25 --dry
```

**务必先跑 `--dry`。** 它会验证动作模板里的选择器在当前页面结构上真的能命中——
站点改版后这是最省事的发现方式。

### 3）正式批量执行

```bash
node scripts/greet-batch.mjs \
  --plan screen.result.json \
  --limit 25 \
  --profile balanced \
  --touch screen.touch.json \
  --commit
```

`greet-batch.mjs` 已封装全流程：

- **限频**：向 `pacing.mjs` 询问每次等待秒数，不自己 `sleep`
- **遮罩处理**：每轮点击前后都检查并关闭可见弹窗
- **窗口自愈**：页面不可见时自动 `/restore-window`，不直接熔断整批
- **连败熔断**：连续 2 次未确认送达即停止
- **成功判定**：以业务状态（文案 / 计数 / 节点）为准，不看代理返回值
- **`--commit`**：回写触达记录

> ⚠️ **一定要带 `--commit`。** 否则历史记录不累积，冷却期与重复触达拦截会**静默失效**——
> 闸门看起来在跑，实际已经失去拦截能力。

### 4）只执行到「发出招呼语」为止

候选人回复之后的对话由**你本人**完成。首次消息通常受平台模板约束，
真正能改变对方判断的，是**他回复之后你发出的第一条消息**——必须针对他的简历写具体内容。

---

## 限频与安全参数

**一句话：单次强度必须固定在「永远够不到平台阈值」的水平。等待时间不是性能问题，是安全成本。**

实测拆解一次 20 人触达：

| 组成 | 耗时 | 占比 |
|---|---|---|
| 页面动作（hover + 点击 + 校验） | 约 33 秒 | **7.4%** |
| 刻意等待（GAP） | 约 413 秒 | **92.6%** |

**耗时的九成是"故意等出来的"。** 想缩短总时长只有两条合规路径：**拆会话**或**降 N**。

### 三个安全档

| 档位 | 定位 | GAP 区间 | 单会话上限 | 日上限 | 活跃时段 |
|---|---|---|---|---|---|
| `conservative` | 红线优先。企业账号 / 首次使用 / 平台近期有动作 | 120–300s | 10 人 | 20 次 | 09:30–11:30 / 14:00–17:30 |
| `balanced` ★默认 | 风险与体验平衡，经实测验证 | 75–210s | 25 人 | 45 次 | 09:30–11:30 / 14:00–17:30 |
| `efficient` | 体验优先，时间敏感时用 | 60–150s | 30 人 | 60 次 | 09:00–12:00 / 13:30–18:00 |

**选档建议**：不确定就先跑 `conservative`，观察一到两天无异常再升档；同一天内不要跨档混跑。

### 硬边界（任何档位都不可越过）

| 边界 | 值 |
|---|---|
| GAP 绝对下限 / 上限 | **60s** / **300s** |
| 单会话人数 | **30 人** |
| 风险放大系数 | **×1.5**（命中风险信号时该次间隔放大） |
| 连败熔断 | **连续 2 次** |

### 风险信号 → 自动拉长（不中断整批）

上一次需重试 / 出现过页面不可见 / 校验走了冗余分支 / 点击曾因遮挡被拒（返回 409）。

### 熔断信号 → 立即停止当天全部操作

验证码 / **被要求答题**（优先级最高，那是平台已判定违规后的处置）/ 「操作频繁」/ 登录失效 / 收到明确拒绝或拉黑。

---

## 命令速查

| 想做什么 | 命令 |
|---|---|
| 环境自检 | `node scripts/setup-env.mjs`（`--fix` 自动修复，`--json` 机器可读） |
| 一键拉起会话 | `node scripts/start-session.mjs --url <URL> --page-match <域名> --tid-out ./_tid.txt` |
| 只起代理（浏览器已开） | `node scripts/check-deps.mjs` |
| 看有哪些标签页 | `curl -s http://127.0.0.1:3456/targets` |
| 页面信息 | `curl -s "http://127.0.0.1:3456/info?target=$(cat _tid.txt)"` |
| 执行 JS | `curl -s -X POST "http://127.0.0.1:3456/eval?target=$(cat _tid.txt)" -d 'document.title'` |
| 可靠点击 + 校验 | `node scripts/human-click.mjs --selector "<css>" --verify "<js>"` |
| 招聘方筛选闸门 | `node scripts/screen-talent.mjs --job <JD> --talent <简历> --out <结果>` |
| 看限频档位与硬边界 | `node scripts/pacing.mjs profiles` |
| 生成执行时间表 | `node scripts/pacing.mjs plan --count 25 --profile balanced` |
| 查今日额度与时段 | `node scripts/pacing.mjs check --today 45` |
| 批量打招呼（演练） | `node scripts/greet-batch.mjs --plan <名单> --dry` |
| 批量打招呼（正式） | `node scripts/greet-batch.mjs --plan <名单> --touch <记录> --commit` |
| 恢复被最小化的窗口 | `curl "http://127.0.0.1:3456/restore-window?target=<id>&all=1"` |

完整的 Proxy HTTP API 列表见 [`SKILL.md`](SKILL.md)。

---

## 目录结构

```
auto-hr-boss/
├── README.md                   # 本文件
├── SKILL.md                    # 完整说明（流程、陷阱、API 参考）—— 建议通读
├── CHANGELOG.md                # 变更记录
├── config.env                  # 本机偏好（用哪个浏览器），首次自检自动生成
├── scripts/
│   ├── setup-env.mjs           # 环境自检 / 部署助手
│   ├── start-session.mjs       # 一键拉起（浏览器 + 代理 + 定位标签页）
│   ├── cdp-proxy.mjs           # CDP 代理（核心，长驻）
│   ├── launch-browser.mjs      # 启动带调试端口的浏览器
│   ├── browser-discovery.mjs   # 调试端口发现（库）
│   ├── pacing.mjs              # 限频节拍器
│   ├── human-click.mjs         # 高可靠点击 + 业务状态轮询
│   ├── greet-batch.mjs         # 批量打招呼执行器
│   ├── screen-talent.mjs       # 招聘方准入闸门（选谁）
│   ├── preflight.mjs           # 求职方准入闸门
│   ├── risk-check.mjs          # 风控自检
│   ├── slim-profile.mjs        # 副本 profile 瘦身
│   ├── find-url.mjs            # 本地书签 / 历史检索
│   └── match-site.mjs          # 站点经验匹配
├── references/
│   ├── environment-setup.md    # ★ 环境与部署（新机器必读）
│   ├── pacing-policy.md        # ★ 限频策略
│   ├── cdp-api.md              # CDP API 参考
│   ├── talent-outreach.md      # 招聘方触达风险模型
│   ├── recruiter-perspective.md# 求职方触达风险模型
│   ├── migration-2.5.3.md      # 旧版 API 迁移
│   └── site-patterns/          # 各站点经验（选择器、陷阱）
└── templates/
    ├── config.env.template
    └── actions/                # 站点动作模板（打招呼等）
```

---

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `node: command not found` | 没装 Node 或不在 PATH | 装 Node 22+，重开终端 |
| `SyntaxError` / `WebSocket is not defined` | Node < 22 | 升级到 22+ |
| `browser: 未连接 — 没有任何浏览器打开远程调试开关` | 没启动带调试端口的浏览器 | 跑 `start-session.mjs`，不要手敲启动命令 |
| 点击返回 `clicked:true` 但页面无反应 | 被全屏遮罩吞掉 | 改用 `/clickSafe`（内置命中测试与自动关遮罩） |
| `/clickHuman`、`/mouseMove` 永久挂起，`/eval` 却正常 | 窗口被最小化或完全遮挡（Chromium 节流渲染器） | 调 `/restore-window?target=<id>&all=1` |
| `连接超时（轮询 36s）` | 浏览器有远程调试授权弹窗未点「允许」 | 在浏览器窗口点「允许」 |
| 端口 3456 被占 | 上次代理没退干净 | `MSYS_NO_PATHCONV=1 taskkill /F /PID $(netstat -ano \| grep LISTENING \| grep ":3456" \| awk '{print $5}' \| head -1)` |
| 批量执行"每轮都成功"但一个都没发出去 | 动作模板选择器已随站点改版失效 | 跑 `greet-batch.mjs --dry`，它会校验真实点击选择器 |

排查时先把 `setup-env.mjs` 的输出附上，它能覆盖九成环境问题。
更完整的故障排查表见 [`references/environment-setup.md`](references/environment-setup.md)。

---

## ⚠️ 安全与合规（必读）

本工具用于自动化操作真实网站，**请自行评估使用场景**。

- 自动化触达**在多数平台的服务协议下是违规的**。防护措施降低的是被识别的概率，**不是消除违规事实**。
- 招聘方的首要风险不是"被投诉"，而是**无效触达**本身：平台会量化招聘方的回复率，
  大量无人回应的招呼会被判定为低质量触达，**压低职位曝光**。所以"发得多"在招聘端是**负收益**。
- **企业账号被处置的代价高于个人账号**——影响企业认证与全部在招职位，通常需公司层面申诉。
- 出现**验证码 / 答题 / 「操作频繁」/ 登录失效 / 被拒绝或拉黑**时，请**立即停止当天全部操作**。
  其中**「要求答题」优先级最高**——那是平台**已判定违规之后**的处置动作。
- 批量触达的对象是**真实的人**。与其研究伪装，不如提高触达的相关性。

详细风险模型见 [`references/talent-outreach.md`](references/talent-outreach.md)（招聘方视角）
与 [`references/recruiter-perspective.md`](references/recruiter-perspective.md)（求职方视角）。

---

## 许可

MIT
