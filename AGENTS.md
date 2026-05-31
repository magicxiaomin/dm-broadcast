# AGENTS.md — dm-broadcast

> 唯一真相源。CLAUDE.md 仅指向本文件。**本文件描述仓库的真实现状（baseline = 已验证的代码），不是早期设想。** 与早期 spec 的差异见文末「偏离与 backlog」。

## 一句话简介

运营方通过 Web 后台向多台创作者安卓设备下发文本广播任务；设备用第三方 IM（WhatsApp）账号逐联系人发送私信；已读事件（`message_ack` ack_level≥2）回流后给任务幂等加积分。**MVP 定位：调试原型，不上产品、不面向真实用户。** 已在真机 + 真账号 + 真实收件人上端到端验证过一次完整链路。

---

## 仓库结构（现状）

```
dm-broadcast/
├── apps/
│   ├── web/         ← 运营后台：Vite + TypeScript（原生 DOM，非框架），5 页
│   ├── worker/      ← 任务云：Cloudflare Workers，手写 fetch 路由（非 Hono），D1 + KV binding
│   └── android/     ← 创作者客户端：Kotlin + wa-sdk-release.aar（现在提交在 app/libs/）
├── docs/            ← current-status.md（已验证证据）、acceptance-plan.md、backlog.md
├── scripts/         ← 验证/部署脚本（smoke / safety-smoke / readiness / e2e / deploy）
├── .github/         ← CI 闸门 + issue/PR 模板
├── AGENTS.md  CLAUDE.md  README.md
└── package.json     ← npm workspaces（apps/web、apps/worker；android 由 gradle 独立构建）
```

---

## 技术栈（现状）

| 层 | 技术 |
|---|---|
| 任务云 | Cloudflare Workers（手写路由）+ D1；KV binding 保留但当前不在热路径读写，TypeScript |
| 运营后台 | Vite + TypeScript（原生 DOM SPA），带 demo 口令门 |
| 安卓客户端 | Kotlin，compileSdk 35，依赖 `libs/wa-sdk-release.aar` + zxing |
| 包管理 | npm workspaces（根 package.json + package-lock.json） |

> 注：早期 spec 写的 pnpm / Hono / Next.js+shadcn / GitHub Packages Maven 均未采用，已按「认代码为基线」收编。详见文末。

---

## 环境与命令

```bash
npm install                       # 安装 web/worker 及脚本依赖

# 开发
npm run web:dev                   # Vite, http://localhost:3000
npm --workspace @dm-broadcast/worker run dev   # wrangler dev

# CI 闸门（见 .github/workflows/ci.yml）
npm run worker:check              # worker tsc --noEmit
npm run web:build                 # vite build
npm run worker:safety-smoke       # Miniflare 本地 hermetic 冒烟（无需真 Cloudflare）

# 数据库 migration
npm --workspace @dm-broadcast/worker run db:migrate:local
npm --workspace @dm-broadcast/worker run db:migrate:remote

# 部署（手动，CI 不自动部署；需 CLOUDFLARE_API_TOKEN）
npm run worker:deploy:api

# Android（需本地 Android SDK + gradle，不在主 CI）
cd apps/android && ./gradlew :app:assembleDebug   # 或用 docs/acceptance-plan.md 的完整命令
DM_REAL_CONTACT_JID="85255804693@s.whatsapp.net" npm run android:verify  # 真机证据采集，不进 CI
```

---

## 部署现状（live）

- Worker：`dm-broadcast-api` → `https://dm-broadcast-api.magicxiaomin.workers.dev`
- D1：`dm_broadcast_mvp`（id 在 wrangler.toml）
- KV：binding 名 **`STATE`**；当前保留作未来低频配置/演示开关，核心热路径不读写 KV
- 当前真机：`N0WR2G0009`；发送账号 `8618205924392:8@s.whatsapp.net` → 云端设备 `android-wa-8618205924392-8`
- 真实收件人验收目标：`+85255804693`（`85255804693@s.whatsapp.net`）

---

## 架构（三层）

```
运营后台 Web (apps/web)
   │ POST /v1/campaigns · GET /v1/dashboard · POST /v1/tasks/requeue
   ▼
任务云 Cloudflare (apps/worker)
   手写路由 · D1(6表) · KV binding(STATE, 当前热路径不用) · safety gate · stale-claim 自动释放
   │ /v1/devices/register · /v1/contacts/sync · /v1/tasks/pull · /v1/events
   ▼
创作者安卓设备 (apps/android, 依赖 magicxiaomin/wa)
   轮询 pull → safety 检查 → sendText → 回流 message_sent/failed/ack
   │ message_ack(ack_level≥2, 按 server_msg_id 归因)
   ▼
联系人（收私信 → 读/不读）
```

**关键边界：** 私信内容不经过 Cloudflare。已读靠 `message_ack` 实时事件，设备离线期间错过的 ack 无法补查——已读统计系统性偏低，是架构边界不是 bug。

---

## D1 Schema（7 张表，现状）

`users` · `devices` · `contacts` · `campaigns` · `tasks` · `im_events` · `ledger_entries`

要点：
- `users`：运营后台维护的 creator/user 账号；无登录/鉴权语义。`devices.user_id` nullable，一设备最多归属一个 user。
- `tasks`：status = pending/claimed/sent/read/failed；`points` 来自所属 campaign（积分额度可配，非固定 +1）；`server_msg_id` 经 `im_events` 关联回流。
- `ledger_entries`：append-only；`user_id` 仍存 device id。user 积分通过 `users ← devices ← ledger_entries` 查询时聚合，不回填、不重写。**幂等命门** = `UNIQUE INDEX (task_id, entry_type) WHERE entry_type='read_reward'`。
- safety 列在 `devices`：`safety_status` / `safety_retry_after_seconds` / `safety_json` / `safety_updated_at`。
- 完整定义见 `apps/worker/migrations/0001_initial.sql` + 后续 migration（权威）。migration 由 `_dm_migrations` 跟踪，只应用未跑过的文件；**禁止漂移：改 schema 必须同步本表与 migration。**

---

## API 路由（/v1，现状）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /health | 健康检查（公开） |
| GET | /v1/dashboard | 后台汇总（设备/任务/事件/ledger，需 ADMIN_TOKEN） |
| GET/POST | /v1/devices · /v1/devices/register | 设备列表（ADMIN_TOKEN） / 注册（DEVICE_TOKEN，含 safety 上报） |
| GET/POST | /v1/users · /v1/devices/assign | 运营维护 user 列表/创建（含已入账与待确认聚合） / 设备归属绑定（ADMIN_TOKEN） |
| GET/POST | /v1/contacts · /v1/contacts/sync | 联系人列表（ADMIN_TOKEN） / 同步（DEVICE_TOKEN） |
| GET/POST | /v1/campaigns | 广播列表 / 创建（展开 tasks，需 ADMIN_TOKEN；创建必须显式传 deviceId） |
| GET | /v1/tasks · /v1/tasks/pull | 任务列表（ADMIN_TOKEN） / 原子认领（DEVICE_TOKEN；必须显式传 deviceId；严格 `device_id = ?`；safety gate + stale 释放） |
| POST | /v1/tasks/requeue | failed/claimed → pending（需 ADMIN_TOKEN） |
| POST | /v1/events | message_sent/failed/read/message_ack（需 DEVICE_TOKEN；ack 按 server_msg_id 归因加分） |
| GET | /v1/ledger | 积分流水（需 ADMIN_TOKEN） |
| POST | /v1/admin/cleanup-test-data | 清测试数据（需 ADMIN_TOKEN） |

鉴权现状：B2-min 已落地，所有 `/v1/*` 路由除 `/health` 外统一使用 `Authorization: Bearer <token>`。运营路由只接受 `ADMIN_TOKEN`，设备路由只接受共享 `DEVICE_TOKEN`。`DEVICE_TOKEN` 是 MVP 共享设备钥匙，不是 per-device token；spec 设想的 `/auth/bind` 弱证明与每设备 token 仍留在 B2-full backlog。

---

## 已验证规则（现状常量）

| 项 | 现状 | 说明 |
|---|---|---|
| 已读判定 | `ack_level >= 2` | wa SDK 定义 ack_level 2 为 read receipt |
| stale claim 释放 | 10 分钟 | 超时 claimed 自动回 pending + `task_claim_expired` |
| safety 暂停 | `safety_updated_at + retry_after_seconds` | 期间 pull 返回 `paused:true`、空任务 |
| 已读积分 | 按 campaign `points` | 真机验收用过 +5；非 spec 设想的固定 +1 |
| 设备 ID | `android-wa-<账号>` | 登录后按账号作用域；`android-prototype` 仅登录前回退 |

> 改这些值需开 ticket 并经审计，不允许执行 agent 自行调整。

---

## 工作流与分工

```
Claude Code（规划 + 审计）        Codex（执行）
────────────────────────        ──────────────
- 写 ticket（验收标准+禁区）       - 按 ticket 在 feat/* 分支实现
- 审计 PR：对照验收标准、查越界    - 跑通本地闸门后提 PR
- 有运行权：跑测试/起 dev/打接口   - 不跨 ticket、不改上面常量
- 产出审计意见，不写业务代码        - 真机相关附日志/录屏作为证据
```

**交接规则（吸取本次教训）：**
1. **任何实现都必须先有 ticket**（含可验证的验收标准 + 禁区）。本次 Codex 无 ticket 自由发挥，导致架构偏离——以后不允许。
2. Codex 开 `feat/<ticket>` 分支 → PR 到 `main`。
3. CI「Sanity Checks / build」必须绿才请求审计。
4. **验收标准至少一条可被 CI/测试机械验证**；纯人工判断的项（真机行为）须附证据。
5. 真机/异步链路 CI 无法覆盖 → 验收靠 Claude 运行 + 你贴的真机证据，这是显式的手动闸门。
6. 每个 ticket 独立可测，禁止跨步合并。

---

## 测试责任

测试不是单个角色的活，按「**谁能验证什么 + 在哪台机器跑 + 谁判定真假**」分区。
Codex 不只验证「能编译」——它能驱动浏览器自动化 + 截图、用 ADB 截安卓真机屏并驱动流程，
应尽量做**真行为验证**，能进 CI 的优先进 CI。

| 区 | 内容 | 在哪跑 | 谁做 | 谁判定 |
|---|---|---|---|---|
| A · hermetic | `worker:check` / `web:build` / `worker:safety-smoke`(Miniflare) | GitHub CI | Codex 写 | CI（自动） |
| A+ · Web 行为 E2E | headless 浏览器(Playwright)驱动 + 断言 | **可进 CI** | Codex 写 | CI + Claude 复验 |
| B+ · 安卓真机验证 | `npm run android:verify` 用 ADB 截屏 + logcat 驱动 pull→send 流程 | 挂着真机的 Mac | Codex 跑，**截图/日志作 PR 证据** | Claude 审证据 + 你抽查 |
| C · 真实 IM 终验 | 真账号发真人、ack 回流、封号风险 | 真机 | Codex 发 + 你读/判定 | **你终审** |

原则：
- **能自动化的必须自动化，能进 CI 的优先进 CI**——CI 不会挑结果，是客观闸门。
- 进不了 CI 的真机验证，Codex 须附**截图/录屏/日志证据**；Claude 抽查复跑，不凭单张截图采信（防"只贴通过的图"）。
- `android:verify` 必须在已安装当前 Android debug 包、已扫码登录、Worker 有 ready 的 `android-wa-*` 设备、且显式设置 `DM_REAL_CONTACT_JID` 时才会创建真实任务；无 ADB 设备或无显式收件人时不得创建真实任务。证据落在 `outputs/android-device-verify/<timestamp>/`，目录已 gitignore，不进 CI。
- 仍不可约的人类部分：**真实收件人那一读** + **封号风险判断** + **最终 merge 终审**。
- 当前自动化测试集中在 worker 层；Web/Android 行为测试是缺口，见 backlog B8/B10。

---

## 禁区 / 红线

- 禁止无 ticket 直接实现或重构。
- 禁止改「已验证规则」常量、改 D1 schema 而不同步 migration + 本文件。
- 禁止在 worker 存储实际私信内容。
- 禁止绕过 CI 合并（`--no-verify` / 直接 push main）。
- 禁止自行添加 MVP 不实现清单中的功能。

## MVP 不实现清单

FCM/APNs 推送 · LLM 改写文案 · 强身份证明 · 现金提现 · 订阅机制 · 多设备共享 owner · 群组发送 · 媒体消息 · 逐收件人个性化文案 · 多语言 i18n

---

## UI 诚实标签约定（apps/web 必须遵守）

| 字段 | 正确写法 | 禁止写法 |
|---|---|---|
| 设备状态 | 活跃（近 15 分钟） | 在线 |
| 已读统计 | 已读（可统计）+「有延迟」 | 裸数字 |
| 积分 | 待确认 / 已入账 | 单一合计 |
| 金币说明 | 不可提现、不可转让 | 省略 |
| 数据刷新 | 「每 5–10s 刷新 · 有延迟」 | 声称实时 |

---

## 偏离与 backlog（认代码为基线后的待办）

早期 spec 与现状的差异，已决定**以代码为准**；以下作为后续 ticket（详见 `docs/backlog.md`）：

| # | 缺口 / 偏离 | 决定 |
|---|---|---|
| B1 | redemptions 兑换审批（表+路由）完全缺失 | 真缺口，开 ticket 补 |
| B2-min | 双钥匙最小鉴权（ADMIN_TOKEN / DEVICE_TOKEN） | 已落地 |
| B2-full | 每设备 token / owner scope / `/auth/bind` 弱证明 | 真缺口，排后续 ticket |
| B3 | Web 是 Vite 原生 TS，非 Next.js+shadcn | 暂留 Vite，迁移排 ticket |
| B4 | wa-sdk AAR 13MB 提交进 git，非 Maven | 暂留 git，迁移排 ticket |
| B5 | 验证脚本依赖（miniflare/esbuild）未声明 | 本 PR 已补进 devDependencies |
| B6 | worker 手写路由（非 Hono）、npm（非 pnpm）、/v1 路由与表名 | 无害，已认作基线 |
| B12 | 多设备多账号测试赋能 + 隔离坑修复 | 已落地 |
| B14a | 用户账号系统后端（users 表 + 设备归属 + 查询时聚合） | 已落地 |

---

## 原则

- 优先最简单可行；发现过度设计主动指出并给更简做法。
- 真相源单一：schema 以 migration 为准，流程以本文件为准，已验证证据在 `docs/current-status.md`。
