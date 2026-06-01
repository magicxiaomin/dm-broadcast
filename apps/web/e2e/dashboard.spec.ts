import { expect, test, type Page, type Route } from "@playwright/test";

const apiBase = "https://dm-broadcast-api.magicxiaomin.workers.dev";

const dashboard = {
  ok: true,
  devices: [
    {
      id: "android-wa-8618205924392-8",
      device_name: "creator-phone",
      wa_jid: "8618205924392:8@s.whatsapp.net",
      status: "online",
      safety_status: "ready",
      safety_retry_after_seconds: 0,
      safety_json: JSON.stringify({ state: "connected" }),
      last_seen_at: 1770000000000,
      user_id: "user-creator-a",
    },
    {
      id: "android-wa-secondary",
      device_name: "creator-second-phone",
      wa_jid: "8618205000000:5@s.whatsapp.net",
      status: "online",
      safety_status: "ready",
      safety_retry_after_seconds: 0,
      safety_json: JSON.stringify({ state: "connected" }),
      last_seen_at: 1770000002500,
      user_id: "user-creator-a",
    },
    {
      id: "android-wa-unassigned",
      device_name: "spare-phone",
      wa_jid: "8613000000000@s.whatsapp.net",
      status: "offline",
      safety_status: "ready",
      safety_retry_after_seconds: 0,
      safety_json: JSON.stringify({ state: "connected" }),
      last_seen_at: 1770000005000,
      user_id: null,
    },
  ],
  campaigns: [
    {
      id: "campaign-real-1",
      title: "真实小号验收",
      message_template: "hello from e2e",
      points: 7,
      created_at: 1770000000000,
    },
  ],
  tasks: [
    {
      id: "task-pending-1",
      campaign_id: "campaign-real-1",
      campaign_title: "真实小号验收",
      device_id: "android-wa-8618205924392-8",
      contact_jid: "85255804693@s.whatsapp.net",
      status: "pending",
      points: 7,
      created_at: 1770000000000,
      payload_json: JSON.stringify({ text: "hello from e2e" }),
    },
    {
      id: "task-read-1",
      campaign_id: "campaign-real-1",
      campaign_title: "真实已读",
      device_id: "android-wa-8618205924392-8",
      contact_jid: "85255804693@s.whatsapp.net",
      status: "read",
      points: 7,
      created_at: 1770000001000,
      sent_at: 1770000002000,
      read_at: 1770000003000,
      acked_at: 1770000003000,
      payload_json: JSON.stringify({ text: "read message" }),
    },
    {
      id: "task-sent-1",
      campaign_id: "campaign-real-1",
      campaign_title: "真实待确认",
      device_id: "android-wa-8618205924392-8",
      contact_jid: "85255804693@s.whatsapp.net",
      status: "sent",
      points: 7,
      created_at: 1770000005000,
      sent_at: 1770000006000,
      payload_json: JSON.stringify({ text: "sent message" }),
    },
  ],
  events: [
    {
      id: "event-1",
      task_id: "task-read-1",
      event_type: "message_ack",
      payload_json: JSON.stringify({ ack_level: 2 }),
      created_at: 1770000003000,
    },
  ],
  ledger: [
    {
      id: "ledger-1",
      user_id: "android-wa-8618205924392-8",
      task_id: "task-read-1",
      entry_type: "read_reward",
      points: 7,
      created_at: 1770000004000,
    },
  ],
};

type ApiContacts = { ok: boolean; contacts: Array<Record<string, unknown>> };

const contacts: ApiContacts = {
  ok: true,
  contacts: [
    {
      id: "contact-1",
      wa_jid: "85255804693@s.whatsapp.net",
      display_name: "小号 +85255804693",
    },
  ],
};

const deviceContacts: Record<string, ApiContacts> = {
  "android-wa-8618205924392-8": {
    ok: true,
    contacts: [
      {
        id: "owned-contact-primary",
        device_id: "android-wa-8618205924392-8",
        wa_jid: "85255804693@s.whatsapp.net",
        display_name: "小号 +85255804693",
      },
    ],
  },
  "android-wa-secondary": {
    ok: true,
    contacts: [
      {
        id: "owned-contact-secondary",
        device_id: "android-wa-secondary",
        wa_jid: "85259990000@s.whatsapp.net",
        display_name: "二号联系人",
      },
    ],
  },
};

const users = {
  ok: true,
  users: [
    {
      id: "user-creator-a",
      display_name: "萝卜胡",
      notes: "主测试号",
      device_count: 2,
      points: 7,
      ledger_entries: 1,
      pending_tasks: 1,
      pending_points: 7,
      created_at: 1770000000000,
      updated_at: 1770000000000,
    },
  ],
};

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await expect(page.getByRole("main").getByRole("heading", { name: "总览" })).toBeVisible();
});

test("线上 demo 口令门已移除，常规请求不需要手填 ADMIN_TOKEN", async ({ page }) => {
  await expect(page.getByLabel("访问密码")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "进入后台" })).toHaveCount(0);
  await expect(page.getByText("android-wa-8618205924392-8")).toBeVisible();
});

test("总览页渲染 mock 的设备、任务、积分数据并展示诚实标签", async ({ page }) => {
  await expect(page.getByText("android-wa-8618205924392-8")).toBeVisible();
  await expect(page.getByText("85255804693@s.whatsapp.net").first()).toBeVisible();
  await expect(page.getByText("message_ack")).toBeVisible();

  await expect(page.getByText("活跃(近 15 分钟)").first()).toBeVisible();
  await expect(page.locator(".metric", { hasText: "待确认" })).toBeVisible();
  await expect(page.locator(".metric", { hasText: "已入账" })).toBeVisible();
  await expect(page.getByText("在线")).toHaveCount(0);
});

test("sent 状态在总览和任务页都显示为待确认，不显示已发送", async ({ page }) => {
  await expect(page.locator(".metric", { hasText: "待确认" })).toBeVisible();
  await page.getByRole("button", { name: "任务记录" }).click();
  await expect(page.locator(".badge", { hasText: "待确认" })).toBeVisible();
  await expect(page.getByRole("main").getByText("已发送", { exact: true })).toHaveCount(0);
});

test("无真实 android-wa 设备时禁用下发并移除 android-prototype 兜底", async ({ page }) => {
  await page.route(`${apiBase}/v1/dashboard`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...dashboard,
        devices: [{
          id: "android-prototype",
          device_name: "login-pending",
          status: "offline",
          safety_status: "unknown",
          safety_retry_after_seconds: 0,
        }],
        tasks: [],
        events: [],
        ledger: [],
      }),
    });
  });

  await page.getByRole("button", { name: "连接" }).click();
  await page.getByRole("button", { name: "创建任务" }).click();

  await expect(page.getByText("无可用设备:请先在 Android 端登录账号")).toBeVisible();
  await expect(page.getByRole("option", { name: "android-prototype" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "创建并下发" })).toBeDisabled();
});

test("运营鉴权失败时提示 Cloudflare Access 或本地 ADMIN_TOKEN", async ({ page }) => {
  await page.route(`${apiBase}/v1/dashboard`, async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "unauthorized" }),
    });
  });

  await page.getByRole("button", { name: "连接" }).click();
  await expect(page.getByText("本地开发请填写 ADMIN_TOKEN；线上请通过 Cloudflare Access 登录")).toBeVisible();
  await expect(page.getByText("刷新失败：unauthorized")).toHaveCount(0);
});

test("用户优先下发：默认按每台设备联系人建 campaign，部分失败可见", async ({ page }) => {
  const campaignRequests: Array<{ headers: Record<string, string>; body: unknown }> = [];

  await page.route(`${apiBase}/v1/campaigns`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const body = request.postDataJSON() as { deviceId?: string };
      campaignRequests.push({
        headers: request.headers(),
        body,
      });
      if (body.deviceId === "android-wa-secondary") {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ ok: false, error: "secondary failed" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, campaign: { id: "campaign-created", taskCount: 1 } }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, campaigns: [] }) });
  });

  await page.getByRole("button", { name: "连接" }).click();
  await expect(page.getByText("已刷新")).toBeVisible();

  await page.getByRole("button", { name: "创建任务" }).click();
  await expect(page.getByLabel("用户")).toHaveValue("user-creator-a");
  await expect(page.getByLabel("选择设备 android-wa-8618205924392-8")).toBeChecked();
  await expect(page.getByLabel("选择设备 android-wa-secondary")).toBeChecked();
  await expect(page.getByLabel("收件人 android-wa-8618205924392-8")).toHaveValue("小号 +85255804693, 85255804693@s.whatsapp.net");
  await expect(page.getByLabel("收件人 android-wa-secondary")).toHaveValue("二号联系人, 85259990000@s.whatsapp.net");

  await page.getByLabel("标题").fill("E2E 用户下发");
  await page.getByLabel("消息").fill("来自 Playwright 的 hermetic 消息");
  await page.getByLabel("积分").fill("9");
  await page.getByRole("button", { name: "创建并下发" }).click();

  await expect.poll(() => campaignRequests.length).toBe(2);
  expect(campaignRequests[0]?.headers.authorization).toBeUndefined();
  expect(campaignRequests.map((entry) => entry.body)).toEqual([
    {
      title: "E2E 用户下发 · creator-phone",
      message: "来自 Playwright 的 hermetic 消息",
      contacts: [{ name: "小号 +85255804693", jid: "85255804693@s.whatsapp.net" }],
      points: 9,
      deviceId: "android-wa-8618205924392-8",
    },
    {
      title: "E2E 用户下发 · creator-second-phone",
      message: "来自 Playwright 的 hermetic 消息",
      contacts: [{ name: "二号联系人", jid: "85259990000@s.whatsapp.net" }],
      points: 9,
      deviceId: "android-wa-secondary",
    },
  ]);
  await expect(page.getByText("下发完成：1 台成功，1 台失败")).toBeVisible();
  await expect(page.getByText("android-wa-8618205924392-8：已创建 1 条")).toBeVisible();
  await expect(page.getByText("android-wa-secondary：secondary failed")).toBeVisible();
  await expect(page.getByText("失败设备可调整收件人或安全状态后重试")).toBeVisible();
});

test("用户下发支持手动覆盖单台设备收件人并只向选中设备建 campaign", async ({ page }) => {
  const campaignRequests: Array<{ body: unknown }> = [];

  await page.route(`${apiBase}/v1/campaigns`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      campaignRequests.push({ body: request.postDataJSON() });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, campaign: { id: "campaign-created", taskCount: 2 } }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, campaigns: [] }) });
  });

  await page.getByRole("button", { name: "连接" }).click();
  await page.getByRole("button", { name: "创建任务" }).click();
  await page.getByLabel("选择设备 android-wa-secondary").uncheck();
  await page.getByLabel("标题").fill("E2E 覆盖");
  await page.getByLabel("消息").fill("覆盖收件人消息");
  await page.getByLabel("收件人 android-wa-8618205924392-8").fill("覆盖一, 85251111111@s.whatsapp.net\n85252222222@s.whatsapp.net");
  await page.getByRole("button", { name: "创建并下发" }).click();

  await expect.poll(() => campaignRequests.length).toBe(1);
  expect(campaignRequests[0]?.body).toEqual({
    title: "E2E 覆盖 · creator-phone",
    message: "覆盖收件人消息",
    contacts: [
      { name: "覆盖一", jid: "85251111111@s.whatsapp.net" },
      { jid: "85252222222@s.whatsapp.net" },
    ],
    points: 10,
    deviceId: "android-wa-8618205924392-8",
  });
  await expect(page.getByText("下发完成：1 台成功，0 台失败")).toBeVisible();
});

test("用户页建 user，设备页分配归属，Ledger 按真实 User 聚合展示", async ({ page }) => {
  let createUserRequest: { headers: Record<string, string>; body: unknown } | null = null;
  let assignRequest: { headers: Record<string, string>; body: unknown } | null = null;

  await page.route(`${apiBase}/v1/users`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      createUserRequest = {
        headers: request.headers(),
        body: request.postDataJSON(),
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          user: {
            id: "user-created",
            display_name: "新创作者",
            notes: "e2e",
            device_count: 0,
            points: 0,
            pending_tasks: 0,
            pending_points: 0,
          },
        }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(users) });
  });
  await page.route(`${apiBase}/v1/devices/assign`, async (route) => {
    assignRequest = {
      headers: route.request().headers(),
      body: route.request().postDataJSON(),
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, device: { id: "android-wa-unassigned", user_id: "user-creator-a" } }),
    });
  });

  await page.getByRole("button", { name: "连接" }).click();
  await expect(page.getByText("已刷新")).toBeVisible();

  await page.getByRole("button", { name: "用户" }).click();
  await expect(page.getByRole("main").getByRole("heading", { name: "用户", exact: true })).toBeVisible();
  await expect(page.getByText("萝卜胡")).toBeVisible();
  await expect(page.getByText("已入账").first()).toBeVisible();
  await expect(page.getByText("待确认").first()).toBeVisible();
  await expect(page.getByText("7 分").first()).toBeVisible();

  await page.getByLabel("用户 ID").fill("user-created");
  await page.getByLabel("显示名称").fill("新创作者");
  await page.getByLabel("备注").fill("e2e");
  await page.getByRole("button", { name: "创建用户" }).click();
  await expect.poll(() => createUserRequest).not.toBeNull();
  expect(createUserRequest?.headers.authorization).toBeUndefined();
  expect(createUserRequest?.body).toEqual({ id: "user-created", displayName: "新创作者", notes: "e2e" });

  await page.getByRole("button", { name: "设备管理" }).click();
  await expect(page.locator(".badge", { hasText: "未归属" })).toBeVisible();
  await page.getByLabel("归属用户 android-wa-unassigned").selectOption("user-creator-a");
  await expect.poll(() => assignRequest).not.toBeNull();
  expect(assignRequest?.headers.authorization).toBeUndefined();
  expect(assignRequest?.body).toEqual({ deviceId: "android-wa-unassigned", userId: "user-creator-a" });

  await page.getByRole("button", { name: "积分 Ledger" }).click();
  await expect(page.getByText("真实 User 汇总")).toBeVisible();
  await expect(page.getByText("萝卜胡")).toBeVisible();
  await expect(page.getByText("android-wa-8618205924392-8")).toHaveCount(0);
});

async function mockApi(page: Page) {
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith(apiBase)) {
      await fulfillApi(route);
      return;
    }
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
      await route.continue();
      return;
    }
    throw new Error(`Unexpected network request: ${url}`);
  });
}

async function fulfillApi(route: Route) {
  const request = route.request();
  const url = new URL(request.url());
  if (request.method() === "GET" && url.pathname === "/v1/dashboard") {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(dashboard) });
    return;
  }
  if (request.method() === "GET" && url.pathname === "/v1/contacts") {
    const deviceId = url.searchParams.get("deviceId");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(deviceId ? deviceContacts[deviceId] || { ok: true, contacts: [] } : contacts),
    });
    return;
  }
  if (request.method() === "GET" && url.pathname === "/v1/users") {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(users) });
    return;
  }
  if (request.method() === "POST" && url.pathname === "/v1/campaigns") {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, campaign: { id: "campaign-created", taskCount: 1 } }),
    });
    return;
  }
  await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, error: "not_found" }) });
}
