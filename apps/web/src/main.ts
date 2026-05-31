import "./styles.css";

const API_DEFAULT = "https://dm-broadcast-api.magicxiaomin.workers.dev";
const DEMO_PASSWORD = ((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_DEMO_PASSWORD || "dm-demo-2026").trim();
const AUTH_STORAGE_KEY = "dm.demoAuth";
const AUTH_VALUE = "unlocked";

type Row = Record<string, unknown>;
type PageKey = "overview" | "dispatch" | "tasks" | "ledger" | "devices";

type Dashboard = {
  ok: boolean;
  summary: {
    devices: number;
    campaigns: number;
    points: number;
    tasksByStatus: Array<{ status: string; count: number }>;
  };
  devices: Row[];
  campaigns: Row[];
  tasks: Row[];
  events: Row[];
  ledger: Row[];
};

const NAV: Array<{ key: PageKey; label: string; desc: string }> = [
  { key: "overview", label: "总览", desc: "设备健康 / 任务状态 / 最近事件" },
  { key: "dispatch", label: "创建任务", desc: "下发到真实设备与联系人" },
  { key: "tasks", label: "任务记录", desc: "发送 / 失败 / 已读 / 重排队" },
  { key: "ledger", label: "积分 Ledger", desc: "read_reward 入账审计" },
  { key: "devices", label: "设备管理", desc: "账号、safety、心跳" },
];

const state = {
  authenticated: sessionStorage.getItem(AUTH_STORAGE_KEY) === AUTH_VALUE,
  page: (localStorage.getItem("dm.page") as PageKey) || "overview",
  apiBase: localStorage.getItem("dm.apiBase") || API_DEFAULT,
  adminToken: localStorage.getItem("dm.adminToken") || "",
  dashboard: null as Dashboard | null,
  contacts: [] as Row[],
  contactFilter: "",
  taskFilter: "",
  deviceFilter: "",
  selectedTaskId: "",
  formContacts: "",
  showTestData: localStorage.getItem("dm.showTestData") === "1",
  loading: false,
  message: "",
  authMessage: "",
};

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("missing #app");

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  children: Array<Node | string> = [],
) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key === "value" && (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement)) node.value = String(value);
    else if (key === "checked" && node instanceof HTMLInputElement) node.checked = Boolean(value);
    else if (key === "disabled" && node instanceof HTMLButtonElement) node.disabled = Boolean(value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (value !== false && value !== null && value !== undefined) node.setAttribute(key, String(value));
  }
  for (const child of children) node.append(child);
  return node;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${state.apiBase}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(state.adminToken ? { authorization: `Bearer ${state.adminToken}` } : {}),
      ...(init.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `${res.status}`);
  return data as T;
}

async function refresh(message = "已刷新") {
  state.loading = true;
  render();
  try {
    const [dashboard, contacts] = await Promise.all([
      api<Dashboard>("/v1/dashboard"),
      api<{ contacts: Row[] }>("/v1/contacts"),
    ]);
    state.dashboard = dashboard;
    state.contacts = contacts.contacts || [];
    state.message = message;
  } catch (error) {
    state.message = `刷新失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    state.loading = false;
    render();
  }
}

function setPage(page: PageKey) {
  state.page = page;
  localStorage.setItem("dm.page", page);
  render();
}

async function createCampaign(event: Event) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const contactLines = String(data.get("contacts") || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const contacts = contactLines.map((line) => {
    const [nameOrJid, maybeJid] = line.split(",").map((part) => part.trim());
    return maybeJid ? { name: nameOrJid, jid: maybeJid } : { jid: nameOrJid };
  });

  state.loading = true;
  render();
  try {
    const result = await api<{ campaign: { id: string; taskCount: number } }>("/v1/campaigns", {
      method: "POST",
      body: JSON.stringify({
        title: data.get("title"),
        message: data.get("message"),
        contacts,
        points: Number(data.get("points") || 10),
        deviceId: data.get("deviceId") || undefined,
      }),
    });
    state.message = `任务已创建：${result.campaign.taskCount} 条，等待设备轮询领取`;
    state.formContacts = "";
    form.reset();
    state.page = "tasks";
    await refresh(state.message);
  } catch (error) {
    state.message = `创建失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    state.loading = false;
    render();
  }
}

async function requeueTask(taskId: string) {
  try {
    await api("/v1/tasks/requeue", {
      method: "POST",
      body: JSON.stringify({ taskId, reason: "web_operator" }),
    });
    await refresh("任务已重新排队");
  } catch (error) {
    state.message = `重新排队失败：${error instanceof Error ? error.message : String(error)}`;
    render();
  }
}

function hasTestMarker(value: unknown) {
  const text = String(value || "").toLowerCase();
  return text.includes("api-acceptance-")
    || text.includes("online-safety-")
    || text.includes("online-long-retry-")
    || text.includes("safety-gate-")
    || text.includes("smoke-device-")
    || text.includes("smoke-")
    || text.includes("acceptance-device@s.whatsapp.net")
    || text.includes("acceptance-contact@s.whatsapp.net")
    || text.includes("api acceptance")
    || text.includes("android poll acceptance")
    || text.includes("unknown device acceptance")
    || text.includes("worker smoke")
    || text.includes("safety smoke")
    || text.includes("online safety smoke")
    || text.includes("worker-smoke")
    || text.includes("worker-online-safety-smoke");
}

function isTestDevice(device: Row) {
  return hasTestMarker(device.id) || hasTestMarker(device.device_name) || hasTestMarker(device.safety_json);
}

function isTestContact(contact: Row) {
  return hasTestMarker(contact.wa_jid) || hasTestMarker(contact.display_name);
}

function isTestTask(task: Row) {
  return hasTestMarker(task.device_id)
    || hasTestMarker(task.contact_jid)
    || hasTestMarker(task.campaign_title)
    || hasTestMarker(task.payload_json);
}

function visibleData() {
  const d = state.dashboard;
  const testTaskIds = new Set((d?.tasks || []).filter(isTestTask).map((task) => String(task.id || "")));
  const testCampaignIds = new Set((d?.tasks || []).filter(isTestTask).map((task) => String(task.campaign_id || "")));
  const devices = state.showTestData ? (d?.devices || []) : (d?.devices || []).filter((device) => !isTestDevice(device));
  const tasks = state.showTestData ? (d?.tasks || []) : (d?.tasks || []).filter((task) => !isTestTask(task));
  const campaigns = state.showTestData
    ? (d?.campaigns || [])
    : (d?.campaigns || []).filter((campaign) => !testCampaignIds.has(String(campaign.id || "")) && !hasTestMarker(campaign.title) && !hasTestMarker(campaign.message_template));
  const events = state.showTestData
    ? (d?.events || [])
    : (d?.events || []).filter((event) => !testTaskIds.has(String(event.task_id || "")) && !hasTestMarker(event.payload_json));
  const ledger = state.showTestData
    ? (d?.ledger || [])
    : (d?.ledger || []).filter((entry) => !testTaskIds.has(String(entry.task_id || "")) && !hasTestMarker(entry.user_id) && !hasTestMarker(entry.metadata_json));
  const contacts = state.showTestData ? state.contacts : state.contacts.filter((contact) => !isTestContact(contact));
  return { devices, tasks, campaigns, events, ledger, contacts };
}

function textCell(value: unknown) {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

function shortId(value: unknown, size = 10) {
  const text = textCell(value);
  if (text === "-" || text.length <= size + 4) return text;
  return `${text.slice(0, size)}...`;
}

function parsePayload(value: unknown): Row {
  if (!value || typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : {};
  } catch {
    return {};
  }
}

function fmtTime(value: unknown) {
  const ms = Number(value || 0);
  return ms ? new Date(ms).toLocaleString() : "-";
}

function statusTone(status: unknown) {
  const s = String(status || "");
  if (s === "read" || s === "online" || s === "ready") return "success";
  if (s === "sent" || s === "claimed" || s === "pending") return "accent";
  if (s === "failed" || s === "risk_stopped") return "danger";
  if (s === "cooling_down" || s === "cooldown") return "warning";
  return "neutral";
}

function deviceSafety(device: Row) {
  const status = String(device.safety_status || "unknown");
  const wait = Number(device.safety_retry_after_seconds || 0);
  const safety = parsePayload(device.safety_json);
  const bridge = String(safety.state || "");
  if (status === "ready") return bridge && bridge !== "connected" ? `连接中：${bridge}` : "可发送";
  if (status === "risk_stopped") return `risk stop ${wait}s`;
  if (status === "cooling_down") return `冷却 ${wait}s`;
  return bridge || "-";
}

function deviceActivityLabel(device: Row) {
  const status = String(device.status || "");
  if (status === "online") return "活跃(近 15 分钟)";
  if (status === "offline") return "未活跃";
  return status || "-";
}

function isAccountScopedDevice(device: Row) {
  return String(device.id || "").startsWith("android-wa-");
}

function isDeviceReady(device: Row) {
  const status = String(device.status || "");
  const safetyStatus = String(device.safety_status || "");
  const retryAfter = Number(device.safety_retry_after_seconds || 0);
  return status === "online" && (safetyStatus === "ready" || safetyStatus === "unknown" || safetyStatus === "") && retryAfter === 0;
}

function defaultDeviceId() {
  const devices = state.dashboard?.devices || [];
  return String(
    devices.find((device) => isAccountScopedDevice(device) && isDeviceReady(device))?.id
      || devices.find((device) => isAccountScopedDevice(device))?.id
      || "android-prototype",
  );
}

function sumPoints(rows: Row[]) {
  return rows.reduce((total, entry) => total + Number(entry.points || 0), 0);
}

function countStatus(tasks: Row[], status: string) {
  return tasks.filter((task) => String(task.status || "") === status).length;
}

function badge(label: unknown, tone = statusTone(label)) {
  return el("span", { class: `badge ${tone}`, text: textCell(label) });
}

function card(title: string, body: Array<Node | string>, right?: Node | string, desc?: string) {
  return el("section", { class: "card" }, [
    el("div", { class: "card-head" }, [
      el("div", {}, [
        el("h2", { text: title }),
        desc ? el("p", { text: desc }) : "",
      ]),
      right || "",
    ]),
    el("div", { class: "card-body" }, body),
  ]);
}

function metric(label: string, value: string | number, tone = "") {
  return el("div", { class: `metric ${tone}` }, [
    el("span", { text: label }),
    el("strong", { text: value }),
  ]);
}

function table(headers: string[], rows: Array<Array<Node | string>>, className = "") {
  return el("div", { class: "table-wrap" }, [
    el("table", { class: `data-table ${className}` }, [
      el("thead", {}, [el("tr", {}, headers.map((h) => el("th", { text: h })))]),
      el("tbody", {}, rows.length ? rows.map((row) => el("tr", {}, row.map((cell) => el("td", {}, [cell])))) : [
        el("tr", {}, [el("td", { colspan: headers.length, text: "暂无数据" })]),
      ]),
    ]),
  ]);
}

function pageHead(title: string, desc: string, right?: Node | string) {
  return el("div", { class: "page-head" }, [
    el("div", {}, [el("h1", { text: title }), el("p", { text: desc })]),
    right || "",
  ]);
}

function unlock(event: Event) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const input = form.elements.namedItem("password") as HTMLInputElement;
  if (input.value.trim() !== DEMO_PASSWORD) {
    state.authMessage = "密码不正确";
    input.select();
    renderAuth();
    return;
  }
  sessionStorage.setItem(AUTH_STORAGE_KEY, AUTH_VALUE);
  state.authenticated = true;
  state.authMessage = "";
  render();
  refresh("已解锁后台");
}

function lock() {
  sessionStorage.removeItem(AUTH_STORAGE_KEY);
  state.authenticated = false;
  state.dashboard = null;
  state.contacts = [];
  state.message = "";
  renderAuth();
}

function renderAuth() {
  app.replaceChildren(
    el("main", { class: "auth-screen" }, [
      el("section", { class: "auth-panel" }, [
        el("div", { class: "brand auth-brand" }, [
          el("div", { class: "brand-mark", text: "DM" }),
          el("div", {}, [el("strong", { text: "DM Broadcast" }), el("span", { text: "演示后台访问确认" })]),
        ]),
        el("div", { class: "auth-copy" }, [
          el("h1", { text: "请输入演示密码" }),
          el("p", { text: "当前后台可以创建真实任务。演示阶段先用简单密码避免误访问和误操作。" }),
        ]),
        el("form", { class: "auth-form", onsubmit: unlock }, [
          el("label", {}, [
            el("span", { text: "访问密码" }),
            el("input", { name: "password", type: "password", autocomplete: "current-password", autofocus: true, required: true }),
          ]),
          state.authMessage ? el("div", { class: "auth-error", text: state.authMessage }) : el("div", { class: "auth-error", text: " " }),
          el("button", { class: "btn primary wide", type: "submit", text: "进入后台" }),
        ]),
      ]),
    ]),
  );
}

function statusChipForTask(task: Row) {
  const status = String(task.status || "");
  const label = status === "read" ? "已读"
    : status === "sent" ? "已发送"
      : status === "claimed" ? "已领取"
        : status === "pending" ? "待发送"
          : status === "failed" ? "失败"
            : status || "-";
  return badge(label, statusTone(status));
}

function taskActions(task: Row) {
  const status = String(task.status || "");
  const taskId = String(task.id || "");
  const actions: Array<Node | string> = [];
  if (status === "failed" || status === "claimed") {
    actions.push(el("button", { type: "button", class: "btn outline sm", text: "重新排队", onclick: () => requeueTask(taskId) }));
  }
  return actions.length ? el("div", { class: "row-actions" }, actions) : el("span", { class: "muted", text: "-" });
}

function useContact(contact: Row) {
  state.formContacts = `${textCell(contact.display_name || contact.wa_jid)}, ${textCell(contact.wa_jid)}`;
  state.page = "dispatch";
  state.message = "联系人已填入任务表单";
  render();
}

function renderShell(content: Node[]) {
  const current = NAV.find((item) => item.key === state.page) || NAV[0];
  app.replaceChildren(
    el("div", { class: "app-shell" }, [
      el("aside", { class: "sidebar" }, [
        el("div", { class: "brand" }, [
          el("div", { class: "brand-mark", text: "DM" }),
          el("div", {}, [el("strong", { text: "DM Broadcast" }), el("span", { text: "链路运营后台" })]),
        ]),
        el("nav", { class: "nav" }, NAV.map((item) => el("button", {
          class: item.key === state.page ? "nav-item active" : "nav-item",
          type: "button",
          onclick: () => setPage(item.key),
        }, [
          el("span", { text: item.label }),
          el("small", { text: item.desc }),
        ]))),
        el("div", { class: "sidebar-foot" }, [
          el("span", { class: "live-dot" }),
          el("span", { text: "数据轮询刷新 · 有延迟" }),
        ]),
      ]),
      el("section", { class: "workspace" }, [
        el("header", { class: "topbar" }, [
          el("div", {}, [el("h1", { text: current.label }), el("p", { text: current.desc })]),
          el("form", { class: "api-form", onsubmit: (event: Event) => {
            event.preventDefault();
            const form = event.currentTarget as HTMLFormElement;
            const input = form.elements.namedItem("api") as HTMLInputElement;
            const tokenInput = form.elements.namedItem("adminToken") as HTMLInputElement;
            state.apiBase = input.value.replace(/\/$/, "");
            state.adminToken = tokenInput.value.trim();
            localStorage.setItem("dm.apiBase", state.apiBase);
            localStorage.setItem("dm.adminToken", state.adminToken);
            refresh();
          } }, [
            el("input", { name: "api", value: state.apiBase, "aria-label": "API Base" }),
            el("input", {
              name: "adminToken",
              type: "password",
              value: state.adminToken,
              placeholder: "ADMIN_TOKEN",
              "aria-label": "ADMIN_TOKEN",
              autocomplete: "off",
            }),
            el("label", { class: "toggle" }, [
              el("input", {
                type: "checkbox",
                checked: state.showTestData,
                onchange: (event: Event) => {
                  state.showTestData = (event.currentTarget as HTMLInputElement).checked;
                  localStorage.setItem("dm.showTestData", state.showTestData ? "1" : "0");
                  render();
                },
              }),
              el("span", { text: "测试数据" }),
            ]),
            el("button", { type: "submit", class: "btn outline sm", text: "连接" }),
            el("button", { type: "button", class: "btn primary sm", text: state.loading ? "刷新中" : "刷新", onclick: () => refresh() }),
            el("button", { type: "button", class: "btn ghost sm", text: "锁定", onclick: lock }),
          ]),
        ]),
        el("main", { class: "content" }, [
          el("div", { class: "status-line", text: state.message || " " }),
          ...content,
        ]),
      ]),
    ]),
  );
}

function renderOverview(data: ReturnType<typeof visibleData>) {
  const readyDevices = data.devices.filter(isDeviceReady).length;
  const latestTasks = data.tasks.slice(0, 6);
  const latestEvents = data.events.slice(0, 8);
  renderShell([
    pageHead("总览", "真实链路状态：设备、任务、已读回流、积分入账"),
    el("section", { class: "metrics" }, [
      metric("设备", data.devices.length || "-", "accent"),
      metric("可发送", readyDevices || "-"),
      metric("待发送", countStatus(data.tasks, "pending") + countStatus(data.tasks, "claimed")),
      metric("待确认", countStatus(data.tasks, "sent")),
      metric("已读", countStatus(data.tasks, "read"), "success"),
      metric("已入账", sumPoints(data.ledger) || "-", "warning"),
    ]),
    el("section", { class: "grid two" }, [
      card("设备健康", [
        table(["设备", "账号", "状态", "发送安全", "最后活跃"], data.devices.map((device) => [
          el("span", { class: "mono", text: shortId(device.id, 24) }),
          el("span", { class: "mono muted", text: textCell(device.wa_jid) }),
          badge(deviceActivityLabel(device), statusTone(device.status)),
          badge(deviceSafety(device), statusTone(device.safety_status)),
          el("span", { class: "tnum muted", text: fmtTime(device.last_seen_at) }),
        ])),
      ]),
      card("最近任务", [
        table(["联系人", "状态", "积分", "操作"], latestTasks.map((task) => [
          el("span", { class: "mono", text: shortId(task.contact_jid, 28) }),
          statusChipForTask(task),
          el("span", { class: "tnum", text: textCell(task.points) }),
          taskActions(task),
        ])),
      ]),
    ]),
    card("最近事件", [
      table(["类型", "任务", "时间"], latestEvents.map((event) => [
        badge(event.event_type, statusTone(event.event_type)),
        el("span", { class: "mono muted", text: shortId(event.task_id, 22) }),
        el("span", { class: "tnum muted", text: fmtTime(event.created_at) }),
      ])),
    ]),
  ]);
}

function renderDispatch(data: ReturnType<typeof visibleData>) {
  const contactText = data.contacts
    .slice(0, 8)
    .map((contact) => `${textCell(contact.display_name || contact.wa_jid)}, ${textCell(contact.wa_jid)}`)
    .join("\n");
  const visibleContacts = data.contacts.filter((contact) => {
    const query = state.contactFilter.trim().toLowerCase();
    if (!query) return true;
    return `${textCell(contact.display_name)} ${textCell(contact.wa_jid)}`.toLowerCase().includes(query);
  });
  const deviceOptions = data.devices.filter(isAccountScopedDevice);

  renderShell([
    pageHead("创建任务", "选择真实发送设备与联系人，创建后由 Android 轮询领取"),
    el("section", { class: "grid two" }, [
      card("下发配置", [
        el("form", { class: "task-form", onsubmit: createCampaign }, [
          el("label", {}, [el("span", { text: "标题" }), el("input", { name: "title", required: true, value: "MVP 真机测试" })]),
          el("label", {}, [el("span", { text: "消息" }), el("textarea", { name: "message", required: true, rows: 6, placeholder: "发给小号 +85255804693 的测试消息" })]),
          el("label", {}, [
            el("span", { text: "联系人，每行：名称, jid" }),
            el("textarea", {
              name: "contacts",
              required: true,
              rows: 5,
              value: state.formContacts,
              placeholder: contactText || "小号 +85255804693, 85255804693@s.whatsapp.net",
              oninput: (event: Event) => { state.formContacts = (event.currentTarget as HTMLTextAreaElement).value; },
            }),
          ]),
          el("div", { class: "form-row" }, [
            el("label", {}, [el("span", { text: "积分" }), el("input", { name: "points", type: "number", value: "10", min: "0" })]),
            el("label", {}, [
              el("span", { text: "设备" }),
              el("select", { name: "deviceId", value: defaultDeviceId() }, [
                ...deviceOptions.map((device) => el("option", { value: String(device.id), text: `${device.id} · ${deviceSafety(device)}` })),
                deviceOptions.length ? "" : el("option", { value: "android-prototype", text: "android-prototype" }),
              ]),
            ]),
          ]),
          el("button", { class: "btn primary wide", type: "submit", text: state.loading ? "创建中" : "创建并下发" }),
        ]),
      ], undefined, "不做 AI 改写，不承诺订阅者过滤；只创建真实 Worker task。"),
      card("联系人", [
        el("input", {
          class: "search-input",
          placeholder: "搜索备注或 JID",
          value: state.contactFilter,
          oninput: (event: Event) => {
            state.contactFilter = (event.currentTarget as HTMLInputElement).value;
            render();
          },
        }),
        table(["备注", "JID", "操作"], visibleContacts.map((contact) => [
          textCell(contact.display_name),
          el("span", { class: "mono", text: textCell(contact.wa_jid) }),
          el("button", { type: "button", class: "btn outline sm", text: "填入", onclick: () => useContact(contact) }),
        ])),
      ], undefined, "Android 同步到云端的联系人；也可手动填写 JID。"),
    ]),
  ]);
}

function renderTasks(data: ReturnType<typeof visibleData>) {
  const query = state.taskFilter.trim().toLowerCase();
  const tasks = data.tasks.filter((task) => {
    if (!query) return true;
    return `${textCell(task.id)} ${textCell(task.contact_jid)} ${textCell(task.device_id)} ${textCell(task.status)}`.toLowerCase().includes(query);
  });
  const selectedTask = tasks.find((task) => String(task.id) === state.selectedTaskId) || tasks[0];
  const selectedEvents = selectedTask ? data.events.filter((event) => String(event.task_id || "") === String(selectedTask.id)) : [];
  const payload = selectedTask ? parsePayload(selectedTask.payload_json) : {};

  renderShell([
    pageHead("任务记录", "查看发送链路、失败原因、ack/read 回流和重排队操作", el("input", {
      class: "search-input compact",
      placeholder: "搜索任务 / 联系人 / 设备",
      value: state.taskFilter,
      oninput: (event: Event) => { state.taskFilter = (event.currentTarget as HTMLInputElement).value; render(); },
    })),
    card("任务列表", [
      table(["联系人", "设备", "状态", "创建", "发送 / 已读", "操作"], tasks.map((task) => [
        el("button", {
          class: String(task.id) === String(selectedTask?.id) ? "link-row active" : "link-row",
          type: "button",
          text: shortId(task.contact_jid, 30),
          onclick: () => { state.selectedTaskId = String(task.id); render(); },
        }),
        el("span", { class: "mono muted", text: shortId(task.device_id, 28) }),
        statusChipForTask(task),
        el("span", { class: "tnum muted", text: fmtTime(task.created_at) }),
        el("span", { class: "tnum muted", text: `${fmtTime(task.sent_at)} / ${fmtTime(task.read_at)}` }),
        taskActions(task),
      ])),
    ]),
    selectedTask ? card("任务详情", [
      el("div", { class: "detail-grid" }, [
        detail("任务", selectedTask.id, true),
        detail("联系人", selectedTask.contact_jid, true),
        detail("设备", selectedTask.device_id, true),
        detail("状态", statusChipForTask(selectedTask)),
        detail("积分", selectedTask.points),
        detail("ack", fmtTime(selectedTask.acked_at)),
        detail("消息", payload.text || "-"),
        detail("错误", selectedTask.error || "-"),
      ]),
      table(["事件", "payload", "时间"], selectedEvents.map((event) => [
        badge(event.event_type, statusTone(event.event_type)),
        el("span", { class: "mono pre", text: textCell(event.payload_json) }),
        el("span", { class: "tnum muted", text: fmtTime(event.created_at) }),
      ])),
    ]) : "",
  ].filter(Boolean) as Node[]);
}

function detail(label: string, value: unknown, mono = false) {
  const node = value instanceof Node ? value : el("span", { class: mono ? "mono" : "", text: textCell(value) });
  return el("div", { class: "detail" }, [el("span", { text: label }), node]);
}

function renderLedger(data: ReturnType<typeof visibleData>) {
  const totals = new Map<string, { points: number; entries: number }>();
  for (const entry of data.ledger) {
    const user = String(entry.user_id || "-");
    const current = totals.get(user) || { points: 0, entries: 0 };
    current.points += Number(entry.points || 0);
    current.entries += 1;
    totals.set(user, current);
  }

  renderShell([
    pageHead("积分 Ledger", "只展示当前真实 read_reward 入账；兑换审批暂不属于 MVP"),
    el("section", { class: "metrics three" }, [
      metric("总积分", sumPoints(data.ledger) || "-", "warning"),
      metric("入账笔数", data.ledger.length || "-"),
      metric("积分用户", totals.size || "-"),
    ]),
    el("section", { class: "grid two" }, [
      card("用户汇总", [
        table(["用户", "积分", "笔数"], Array.from(totals.entries()).map(([user, total]) => [
          el("span", { class: "mono", text: user }),
          el("span", { class: "tnum strong", text: total.points }),
          el("span", { class: "tnum muted", text: total.entries }),
        ])),
      ]),
      card("入账流水", [
        table(["任务", "类型", "积分", "时间"], data.ledger.map((entry) => [
          el("span", { class: "mono", text: shortId(entry.task_id, 24) }),
          badge(entry.entry_type, "success"),
          el("span", { class: "tnum strong", text: textCell(entry.points) }),
          el("span", { class: "tnum muted", text: fmtTime(entry.created_at) }),
        ])),
      ]),
    ]),
  ]);
}

function renderDevices(data: ReturnType<typeof visibleData>) {
  const query = state.deviceFilter.trim().toLowerCase();
  const devices = data.devices.filter((device) => {
    if (!query) return true;
    return `${textCell(device.id)} ${textCell(device.wa_jid)} ${textCell(device.status)} ${textCell(device.safety_status)}`.toLowerCase().includes(query);
  });

  renderShell([
    pageHead("设备管理", "查看 Android 原型设备、账号作用域 device id 和发送安全状态", el("input", {
      class: "search-input compact",
      placeholder: "搜索设备 / WA 账号",
      value: state.deviceFilter,
      oninput: (event: Event) => { state.deviceFilter = (event.currentTarget as HTMLInputElement).value; render(); },
    })),
    card("已注册设备", [
      table(["设备", "WA 账号", "状态", "发送安全", "retry", "最后活跃"], devices.map((device) => [
        el("span", { class: "mono", text: textCell(device.id) }),
        el("span", { class: "mono muted", text: textCell(device.wa_jid) }),
        badge(deviceActivityLabel(device), statusTone(device.status)),
        badge(deviceSafety(device), statusTone(device.safety_status)),
        el("span", { class: "tnum muted", text: `${Number(device.safety_retry_after_seconds || 0)}s` }),
        el("span", { class: "tnum muted", text: fmtTime(device.last_seen_at) }),
      ])),
    ], undefined, "设备绑定和扫码登录在 Android App 内完成；当前 Web 不提供 token 吊销假能力。"),
  ]);
}

function render() {
  if (!state.authenticated) return renderAuth();
  const data = visibleData();
  if (state.page === "dispatch") return renderDispatch(data);
  if (state.page === "tasks") return renderTasks(data);
  if (state.page === "ledger") return renderLedger(data);
  if (state.page === "devices") return renderDevices(data);
  return renderOverview(data);
}

render();
if (state.authenticated) refresh();
