import { expect, test, type Page, type Route } from "@playwright/test";

const apiBase = "https://dm-broadcast-api.magicxiaomin.workers.dev";
const adminToken = "test-admin-token";

const dashboard = {
  ok: true,
  summary: {
    devices: 1,
    campaigns: 1,
    points: 7,
    tasksByStatus: [
      { status: "pending", count: 1 },
      { status: "sent", count: 1 },
      { status: "read", count: 1 },
    ],
  },
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

const contacts = {
  ok: true,
  contacts: [
    {
      id: "contact-1",
      wa_jid: "85255804693@s.whatsapp.net",
      display_name: "小号 +85255804693",
    },
  ],
};

test.beforeEach(async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByLabel("访问密码").fill("dm-demo-2026");
  await page.getByRole("button", { name: "进入后台" }).click();
  await expect(page.getByRole("main").getByRole("heading", { name: "总览" })).toBeVisible();
});

test("总览页渲染 mock 的设备、任务、积分数据并展示诚实标签", async ({ page }) => {
  await expect(page.getByText("android-wa-8618205924392-8")).toBeVisible();
  await expect(page.getByText("85255804693@s.whatsapp.net").first()).toBeVisible();
  await expect(page.getByText("message_ack")).toBeVisible();

  await expect(page.getByText("活跃(近 15 分钟)")).toBeVisible();
  await expect(page.getByText("待确认")).toBeVisible();
  await expect(page.getByText("已入账")).toBeVisible();
  await expect(page.getByText("在线")).toHaveCount(0);
});

test("内容下发表单提交 POST /v1/campaigns 且携带 Bearer token 和正确 body", async ({ page }) => {
  let campaignRequest: { headers: Record<string, string>; body: unknown } | null = null;

  await page.route(`${apiBase}/v1/campaigns`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      campaignRequest = {
        headers: request.headers(),
        body: request.postDataJSON(),
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, campaign: { id: "campaign-created", taskCount: 1 } }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, campaigns: [] }) });
  });

  await page.getByLabel("ADMIN_TOKEN").fill(adminToken);
  await page.getByRole("button", { name: "连接" }).click();
  await expect(page.getByText("已刷新")).toBeVisible();

  await page.getByRole("button", { name: "创建任务" }).click();
  await page.getByLabel("标题").fill("E2E 广播");
  await page.getByLabel("消息").fill("来自 Playwright 的 hermetic 消息");
  await page.getByLabel("联系人，每行：名称, jid").fill("小号, 85255804693@s.whatsapp.net");
  await page.getByLabel("积分").fill("9");
  await page.getByRole("button", { name: "创建并下发" }).click();

  await expect.poll(() => campaignRequest).not.toBeNull();
  expect(campaignRequest?.headers.authorization).toBe(`Bearer ${adminToken}`);
  expect(campaignRequest?.body).toEqual({
    title: "E2E 广播",
    message: "来自 Playwright 的 hermetic 消息",
    contacts: [{ name: "小号", jid: "85255804693@s.whatsapp.net" }],
    points: 9,
    deviceId: "android-wa-8618205924392-8",
  });
  await expect(page.getByText("任务已创建：1 条，等待设备轮询领取")).toBeVisible();
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
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(contacts) });
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
