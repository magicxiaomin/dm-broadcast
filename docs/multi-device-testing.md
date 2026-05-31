# Multi-device testing runbook

本 runbook 用于验证多设备多账号下的任务隔离、账号隔离、积分归属、风控独立和封号边界。它只描述测试流程，不改变线上数据结构。

## Preflight

```sh
npm run multi-device:preflight
```

脚本只读取 Worker `/v1/devices` 和本机 `adb devices`，不会创建 campaign 或真实 IM 任务。它检查：

- 至少 2 台 distinct `android-wa-*` 云端设备。
- 云端不应存在 `android-prototype` 设备。
- 每台设备处于可发送状态：`status=online`、无 retry-after、非 `risk_stopped` / `cooling_down`，SDK bridge state 为空或 `connected`。
- ADB 当前连接的物理设备列表，用于辅助确认真机准备状态。

如果没有设备、缺少 `DM_ADMIN_TOKEN`、或设备未 ready，脚本会输出 `not_ready` JSON 并安全退出，不发真实任务。需要把未就绪作为失败时可加：

```sh
npm run multi-device:preflight -- --strict
```

## Provision steps

1. 准备至少两台 Android 真机，分别安装原型 App。
2. 每台手机用不同 IM 账号扫码登录。
3. 在 App 内读取身份，确认云端 device id 是 `android-wa-<账号标识>`，不是 `android-prototype`。
4. 每台设备同步联系人。
5. 分别确认 safety ready：无风控停止、无发送冷却、无操作冷却。
6. 运行 `npm run multi-device:preflight`，确认两台以上 distinct `android-wa-*` ready。

## Create isolated campaigns

对每台设备分别创建独立 campaign，并显式指定对应 `deviceId`。不要创建无 `deviceId` 的 campaign；Worker 会返回 400。

建议最小测试矩阵：

| Campaign | Device | Recipient | Purpose |
|---|---|---|---|
| A | `android-wa-account-a` | 测试小号或 A 专用联系人 | 验证设备 A 只领取 A 的任务 |
| B | `android-wa-account-b` | 测试小号或 B 专用联系人 | 验证设备 B 只领取 B 的任务 |

## Historical isolation pitfalls now fixed

1. 旧逻辑中 `/v1/tasks/pull` 未传 `deviceId` 会静默回退 `android-prototype`。多设备测试时，未登录或漏传参数的设备会共用同一桶并互相抢任务。
2. 旧逻辑中 `createCampaign` 允许 `deviceId` 为空，随后 `pull` 使用 `device_id IS NULL OR device_id = ?`，导致无主任务能被任意轮询设备认领。

当前规则是强隔离：campaign 必须显式指定 `deviceId`，pull 必须显式带 `deviceId`，且只认领 `device_id = ?` 的任务。这里没有实现 B2-full 的 per-device token；隔离边界仍依赖显式指派。

## Observations

- 任务隔离：设备 A pull 不应拿到指派给设备 B 的任务；设备 B 能拿到自己的任务。
- 账号隔离：每台设备上报的 `wa_jid/accountJid` 与 `android-wa-*` device id 对应不同账号。
- 积分归属：read 或 `message_ack ack_level>=2` 后，ledger 的 `user_id` 应归到执行发送的设备账号。
- 风控独立：设备 A 若 `risk_stopped` 或 cooling down，只暂停 A 的 pull；设备 B 仍可领取自己的 ready 任务。
- 封号边界：若某账号触发 IM 风控或封禁，只记录该账号和设备的状态；不要把它误判为全局 Worker 故障。

## Useful commands

```sh
npm run readiness:check
npm run multi-device:preflight
DM_DEVICE_ID=android-wa-account-a DM_REAL_CONTACT_JID=... npm run e2e:real
DM_DEVICE_ID=android-wa-account-b DM_REAL_CONTACT_JID=... npm run e2e:real
```
