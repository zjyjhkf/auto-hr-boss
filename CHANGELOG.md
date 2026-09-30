# 变更记录

本 skill 基于市场版 **2.5.4** 做了本地增强，目标是**可脱离原环境、打包交付给他人部署使用**。
下面只记录本地增强部分（原版能力不在此重复）。

---

## 2.6.0 — 2026-09-30 · 可交付化改造

### 新增：环境声明与自动部署

- **`scripts/setup-env.mjs`** —— 环境自检 / 部署助手。检查平台、Node 版本、第三方依赖、浏览器、
  副本 profile 可写性、skill 目录写权限、端口占用、端点文件时效，并逐项给出解决指引。
  `--json` 供上层解析，`--fix` 自动建目录 / 生成 `config.env` / 清理过期端点。退出码 `0/1/2` 表示全绿 / 阻塞 / 待确认。
- **`references/environment-setup.md`** —— 硬性要求表、部署三步、端口说明、"哪些东西每台机器必须独立"、
  故障排查表、最小交付清单。
- **`check-deps.mjs`** 与 **`SKILL.md`** 明确 **Node ≥ 22 为硬要求**（原生 WebSocket），
  并声明**零第三方依赖、无需 npm install**（`setup-env` 会实际扫描所有脚本 import 来验证这一点）。
- **`launch-browser.mjs` / `browser-discovery.mjs`**：浏览器可执行文件候选表收敛为**单一真值源**
  （新增 `findBrowserExe` / `browserExeCandidates` / `copyProfileDir` / `detectInstalledBrowsers` 导出），
  消除两处硬编码漂移；顺带支持 Chromium 变体的 profile 目录命名。

### 新增：限频节拍器（把"等待时间"变成可审计的组件）

- **`scripts/pacing.mjs`** —— 三档安全配置（`conservative` / `balanced` / `efficient`）、
  硬边界（GAP 60–300s、单会话 ≤30 人、风险 ×1.5、连败 2 次熔断）、带方差随机（±15%）、
  活跃时段与日额度闸门。CLI 提供 `profiles` / `plan` / `next` / `check`，可作库 import。
  `--job <闸门配置>` 让节拍器与 `screen-talent.mjs` 的参数**同源**，避免"计划说的"和"实际做的"不一致。
- **`references/pacing-policy.md`** —— 为什么不能压缩 GAP（实测 92.6% 耗时是故意等出来的）、
  三档选择建议、熔断信号清单、想扩大范围时的正确顺序。
- **`SKILL.md`** 新增「批量触达：限频与动作可靠性」章节。

### 改进：拟人化动作与可靠点击

- **`cdp-proxy.mjs`**
  - 鼠标轨迹从「6 段直线插值」升级为**三次贝塞尔曲线 + ease-out 非匀速 + 末段过冲回正 + 瞄准延迟 + 随机按住时长**，
    步数随距离自适应（4–26 步）。`/clickHuman` 与 `/mouseMove` 共用同一套轨迹引擎。
  - **新增 `POST /clickSafe`**：命中测试 → 若被遮挡则自动点掉中性关闭按钮（只点「知道了/关闭/取消」，
    **明确排除「不再提示」这类改用户设置的动作**）→ **轮询复测**（容忍弹窗过渡动画）→ 拟人轨迹点击。
    仍无法命中则返回 **409 且不点击**，杜绝"返回成功但业务零动作"。
  - **新增 `GET /restore-window`**：走浏览器级 `Browser.*` 域做 `getWindowForTarget → windowState:normal → activateTarget`，
    解决窗口最小化导致 Input 域命令永久挂起、而 `ensureActive` 救不回来的情况；`&all=1` 批量处理所有窗口。
  - `/clickHuman` 返回体新增 `hitTest` 字段，调用方可区分「事件已发出」与「落在目标上」。
- **`scripts/human-click.mjs`（新）** —— `/clickSafe` 与业务状态轮询的 CLI + 模块封装
  （`pickTarget` / `clickSafe` / `waitUntil` / `evalJs`）。内置代理绕过（避免 `HTTP_PROXY` 劫持 localhost）。

### 新增：批量打招呼执行器移入 skill

- **`scripts/greet-batch.mjs`（新）** —— 把原先散落在个人工作目录的 `greet20.py` 逻辑移植为 Node 版并加固：
  - **不再给元素打 `data-agent-target` 标记**。旧版为此打过标记，又被"清理辅助函数"清掉 → 重试路径选择器失配 →
    代理报 400 → **整批崩溃**。现在选择器由 `data-geekid` 派生（稳定键），点击交给 `/clickSafe` 用坐标完成。
  - 成败一律以**业务状态**判定（文案变化 / 全局计数下降 / 回执弹窗出现），不看代理返回值。
  - 页面不可见 → 自动 `/restore-window`，不再直接熔断整批。
  - 接入 `pacing.mjs`；连败 2 次熔断；`--dry` 会**校验真正的点击选择器**能否命中（发现"模板过时"最省事的方式）；
    结束时结果写盘 + `--commit` 回写触达记录。
- **`templates/actions/zhipin-boss-greet.json`（新）** —— 站点动作模板（选择器、成功判定策略、校验节奏、滚动参数）。
  站点改版后只需改模板，不必动脚本。

### 修复

- **`templates/actions/*.json` 的选择器写法**：打招呼按钮与 `.card-inner` 是**兄弟关系**，不在其内部。
  后代选择器 `.card-inner[data-geekid=X] .btn-greet` 实测命中 **0** 个元素，
  必须用 `.geek-card-small:has(.card-inner[data-geekid=X]) .btn-greet`。
  这个坑 `--dry` 原本会掩盖（dry 走的是另一套定位逻辑），已改为 dry 也校验真实点击选择器。
- 新增**模板失效自检**：卡片存在但点击定位根找不到时明确报错，而不是静默跳过 ——
  避免重演「每轮都成功、实际零动作」。
- 增加"过半目标都定位不到卡片"的强提示（提示模板可能已随站点改版失效）。

### 文档

- 新增 `README.md`（面向使用者：三步上手、命令速查、目录结构、安全须知）。
- 新增 `references/environment-setup.md`、`references/pacing-policy.md`。
- `SKILL.md`：新增「运行环境」章节；新增「批量触达：限频与动作可靠性」章节；更新 Proxy API 列表与 References 索引。

---

## 验证记录（2026-09-30 本机实测）

| 项目 | 结果 |
|---|---|
| `setup-env.mjs` 自检 | 10 项全绿，退出码 0 |
| `/clickSafe` 三场景（无遮挡 / 有遮罩可关 / 有遮罩不可关） | **9/9 通过**。第三场景正确返回 409 且业务未被误触发 |
| `pacing.mjs profiles/plan/next/check` | 四个子命令输出正常，`check` 在额度用尽时退出码 3 |
| `greet-batch.mjs --dry`（真实 BOSS 推荐页） | 4/4 定位成功，**点击选择器命中 1 个** |
| `/restore-window` | 正常返回窗口状态与可见性 |

> 全部验证均在**只读或空白页**完成，未发出任何真实触达。
