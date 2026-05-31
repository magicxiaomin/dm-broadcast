# Backlog — 审计发现 → 候选 ticket

由 Claude Code 对 `codex/mvp-full-stack-audit` 分支审计后整理。决策已定：**认代码为基线**。
每项落地前应先开正式 ticket（含验收标准 + 禁区）。

## 真缺口（功能层面，建议优先）

### B1 · redemptions 兑换审批
- 现状：spec 设想的 `redemptions` 表 + `/redeem/:id/approve|reject` 完全未实现，积分只增不可兑换。
- 目标：补兑换申请、人工审批、幂等扣分（`ledger_entries` entry_type=redeem，唯一约束防重复）。
- 验收（草案）：worker:safety-smoke 覆盖「余额不足拒绝 / 通过后幂等扣分 / 拒绝不扣分」；Web 有审批队列页。

### B2 · 设备端鉴权（per-device token）
- 现状：设备端无 token，仅部分 admin 路由有 ADMIN_TOKEN。任意调用方可注册设备 / 拉任务 / 报事件。
- 目标：评估 spec 的 `/auth/bind` 弱证明 + device_token（KV 存 `dt:{token}`），设备路由强制校验。
- 验收（草案）：无效 token 的 pull/register/events 返回 401；smoke 覆盖。

## 工程债（已决定暂留，到点再迁）

### B3 · Web 迁移 Next.js + shadcn/ui
- 现状：Vite + 原生 TS（单 `main.ts`），带 demo 口令门。原型够用。
- 触发条件：需要多路由 / 组件复用 / 团队协作时再迁。

### B4 · wa-sdk AAR 迁 GitHub Packages Maven
- 现状：13.2MB `apps/android/app/libs/wa-sdk-release.aar` 提交进 git。
- 触发条件：`magicxiaomin/wa` 发布到 GitHub Packages 后，改 `build.gradle` 用 Maven 依赖并从 git 移除 AAR。

## 测试与可复现性

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

## 一致性

### B6 · spec 与代码命名差异（已认基线，仅记录）
- npm（非 pnpm）、apps/worker（非 apps/api）、手写路由（非 Hono）、/v1 路由、表名 campaigns/tasks/ledger_entries（非 broadcasts/deliveries/points_ledger）、KV binding=STATE、已读积分按 campaign points（非固定 +1）。
- 决定：以代码为准，AGENTS.md 已对齐。无需改代码。
