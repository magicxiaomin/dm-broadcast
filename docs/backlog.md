# Backlog — 审计发现 → 候选 ticket

由 Claude Code 对 `codex/mvp-full-stack-audit` 分支审计后整理。决策已定：**认代码为基线**。
每项落地前应先开正式 ticket（含验收标准 + 禁区）。

## 真缺口（功能层面，建议优先）

### B1 · redemptions 兑换审批
- 现状：spec 设想的 `redemptions` 表 + `/redeem/:id/approve|reject` 完全未实现，积分只增不可兑换。
- 目标：补兑换申请、人工审批、幂等扣分（`ledger_entries` entry_type=redeem，唯一约束防重复）。
- 验收（草案）：worker:safety-smoke 覆盖「余额不足拒绝 / 通过后幂等扣分 / 拒绝不扣分」；Web 有审批队列页。

### B2-min · 双钥匙最小鉴权（已完成）
- 现状：`/health` 公开；运营路由需 `ADMIN_TOKEN`；设备路由需共享 `DEVICE_TOKEN`；二者均通过 `Authorization: Bearer <token>` 传递。
- 覆盖：无 token / 错 token / 设备 token 调运营路由的拒绝断言已进入 `worker:safety-smoke`。

### B2-full · 每设备鉴权（per-device token）
- 现状：B2-min 仍是共享设备钥匙，没有 owner scope、每设备 token 或绑定证明。
- 目标：评估 spec 的 `/auth/bind` 弱证明 + device_token（KV 存 `dt:{token}`），设备路由强制校验每设备身份与作用域。
- 验收（草案）：无效 token 的 pull/register/events 返回 401；设备 A token 不能拉/报设备 B 任务；smoke 覆盖。

## 工程债（已决定暂留，到点再迁）

### B3 · Web 迁移 Next.js + shadcn/ui
- 现状：Vite + 原生 TS（单 `main.ts`），带 demo 口令门。原型够用。
- 触发条件：需要多路由 / 组件复用 / 团队协作时再迁。

### B4 · wa-sdk AAR 迁 GitHub Packages Maven
- 现状：13.2MB `apps/android/app/libs/wa-sdk-release.aar` 提交进 git。
- 触发条件：`magicxiaomin/wa` 发布到 GitHub Packages 后，改 `build.gradle` 用 Maven 依赖并从 git 移除 AAR。

### B16 · KV 免费额度 / 遥测写入策略（PR #13 真机验证发现）
- 现状：`/health`、`/v1/devices/register`、`/v1/events` 每次都向 KV 写 `last_seen`/`last_event` 遥测；免费版 KV 写额度耗尽时曾返回 1101，把核心端点打挂。PR #13 已把这些写入改为 best-effort（吞错 + warn），核心 D1 流程不再被 KV 额度拖垮。
- 风险（多设备扩容更快触顶）：额度耗尽时 KV 遥测静默降级。影响有限——UI 设备状态读 D1（`devices.last_seen_at`），不依赖 KV。
- 后续：评估降低 KV 写频（如按间隔/采样写）或正式接受遥测降级；必要时升 KV 套餐。

### B5 · 验证脚本依赖声明（本 PR 已修）
- 已把 `miniflare` / `esbuild` 加入根 devDependencies，使 `worker:safety-smoke` 在干净环境（CI）可跑。

### B7 · 集成/真机脚本与 CI 的边界
- `worker:smoke` / `worker:online-safety-smoke` / `e2e:real` / `acceptance:check` 依赖线上 Worker 或真机/Android SDK，**不进主 CI**（会污染线上、需 secrets）。
- 它们是手动/夜间验收入口；主 CI 只跑 hermetic 的 `worker:check + web:build + worker:safety-smoke`。
- 后续可考虑：用专用 staging Worker + 定时 workflow 跑线上 smoke。

### B8 · Web 行为 E2E（进 CI）
- 现状：Web 只有 `web:build`（编译级），无行为测试。
- 目标：headless 浏览器（Playwright）驱动 + 断言，至少覆盖：总览渲染、建广播、注入 read 后积分变化。
- 验收（草案）：新增 `web:e2e` 脚本进「Sanity Checks / build」；CI 绿。Codex 可附运行截图。

### B10 · 安卓真机验证脚本（Codex 本地跑，产出证据）
- 现状：Android 只有 `assembleDebug`（编译级），行为全靠手动。
- 目标：Codex 用 ADB 截屏 + 驱动一次 `pull → sendText` 流程，产出截图/日志附 PR。
- 边界：依赖物理真机，**不进 GitHub CI**；属 Codex 在挂设备的 Mac 上跑的证据项，Claude 审证据 + 人抽查。

### B9 · 测试节奏写进 AGENTS.md（本 PR 已做）
- AGENTS.md「测试责任」小节已明确 A / A+ / B+ / C 各区谁跑、何时跑、证据形式。

### B12 · 多设备多账号测试赋能 + 隔离坑修复（已完成）
- 已修 Worker 隔离坑：campaign 创建必须显式传 `deviceId`；pull 必须显式传 `deviceId` 且只认领 `device_id = ?` 的任务。
- 已新增 `multi-device:preflight` 手动检查入口和 `docs/multi-device-testing.md` runbook。
- 边界：未做 B2-full；本项不引入 per-device token，隔离依赖显式 deviceId 指派。

### B13 · 前端打磨（apps/web，低优先）
来自对 `apps/web/src/main.ts` 的审计，均非功能 bug：
- **#1 文案不一致**：`sent` 状态在总览 metric 显示「待确认」，但 `statusChipForTask` 仍显示「已发送」。诚实标签改动未贯穿，需统一术语。
- **#2 残留 android-prototype 兜底**（B12 审计 PR #11 发现）：`defaultDeviceId()` 仍以 `"android-prototype"` 兜底，下拉框在零真实设备时仍提供该选项，可建出指向前登录桶的 campaign。改为：移除兜底；零真实设备时禁止下发并提示「无可用设备」。
- **#3 缺 ADMIN_TOKEN 的 UX 断点**：demo 密码解锁后若未填 ADMIN_TOKEN，`/v1/dashboard` 返回 401，`refresh()` 仅提示「刷新失败：unauthorized」，不引导用户去顶栏填 token。加明确引导 / 区分两道门。
- **#4 死代码（顺手清）**：`Dashboard.summary` 类型字段声明但未用（前端从过滤后数据重算 metric）。

## 身份与反作弊（未来架构，较重）

### B14 · 用户账号系统（重身份重构）
- 现状：无 User 实体；IM 账号（self_jid）≡ 设备（`android-wa-<账号>`）≡ `ledger.user_id`，三者重叠（代码：`userId = body.deviceId || task.device_id`）。一人多机 = 多个独立身份、积分分散在多个桶。
- 目标：引入真实 User（注册/登录/资料）；`User 1:N IM账号/设备`；积分桶上移到 User 层聚合。`android-wa-*` 降级为 User 名下的设备绑定。
- 迁移接触点：
  - `ledger.user_id` 语义从「device_id」改为「真实 user id」+ 新增 `User↔设备` 映射表 + 存量 ledger 回填；
  - 积分查询/汇总按 User 聚合；
  - `/auth/bind` 时把设备绑定到 User（与 B2-full 的 per-device token + owner scope 合流）。
- 依赖/关联：**B1 兑换审批**（余额与兑换归 User）、**B2-full**（per-device token + owner scope）。

### B15 · 防刷积分 / 反作弊（依赖 B14）
- 风险：一个 User 名下多台设备装**相同联系人**，对同一 recipient 重复发送，刷取重复 `read_reward`；真实触达没增加，积分虚高。
- 核心规则：**同一 User 下，相同联系人（recipient JID）跨多设备只算一个有效触达**——按 `(user, recipient)` 去重，同一收件人对同一 user 的同一广播只计一次积分。
- 关联 spec 中已设想但**代码未实现**的防刷常量：`NEW_OWNER_COOLDOWN_DAYS`（新账号冷静期不计分）、`RECIPIENT_DAILY_CAP`（同一 recipient 每日封顶）、弱证明下以兑换人工审批兜底。
- 验收（草案）：smoke 覆盖「同一 user 两设备发同一 recipient，只入账一次」；跨设备 recipient 去重逻辑可验证。
- 依赖：**B14**（需要 User↔设备 归属关系才能跨设备去重）。

## 一致性

### B6 · spec 与代码命名差异（已认基线，仅记录）
- npm（非 pnpm）、apps/worker（非 apps/api）、手写路由（非 Hono）、/v1 路由、表名 campaigns/tasks/ledger_entries（非 broadcasts/deliveries/points_ledger）、KV binding=STATE、已读积分按 campaign points（非固定 +1）。
- 决定：以代码为准，AGENTS.md 已对齐。无需改代码。
