import "./styles.css";

const env = (import.meta as unknown as { env?: Record<string, string> }).env || {};
const IS_LOCAL_DEV = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const IS_ACCESS_HOST = window.location.hostname === "whatsapp.novelvela.com" || window.location.hostname.endsWith(".dm-broadcast-web.pages.dev");
const API_DEFAULT = env.VITE_API_BASE || (IS_ACCESS_HOST ? "/api" : "https://dm-broadcast-api.magicxiaomin.workers.dev");

type Row = Record<string, unknown>;
type PageKey = "overview" | "dispatch" | "tasks" | "ledger" | "devices" | "users";
type DispatchResult = {
  deviceId: string;
  ok: boolean;
  message: string;
  taskCount?: number;
};

type Dashboard = {
  ok: boolean;
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
  { key: "users", label: "用户", desc: "归属、待确认、已入账" },
];

const state = {
  page: (localStorage.getItem("dm.page") as PageKey) || "overview",
  apiBase: localStorage.getItem("dm.apiBase") || API_DEFAULT,
  adminToken: localStorage.getItem("dm.adminToken") || "",
  dashboard: null as Dashboard | null,
  contacts: [] as Row[],
  users: [] as Row[],
  contactFilter: "",
  taskFilter: "",
  deviceFilter: "",
  selectedTaskId: "",
  formContacts: "",
  dispatchUserId: localStorage.getItem("dm.dispatchUserId") || "",
  dispatchSelectedDeviceIds: [] as string[],
  dispatchSelectionInitialized: false,
  dispatchContactOverrides: {} as Record<string, string>,
  deviceContactsById: {} as Record<string, Row[]>,
  deviceContactsLoading: {} as Record<string, boolean>,
  deviceContactsError: {} as Record<string, string>,
  dispatchResults: [] as DispatchResult[],
  showTestData: localStorage.getItem("dm.showTestData") === "1",
  loading: false,
  message: "",
  needsOperatorAuth: false,
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
  const requestUrl = `${state.apiBase}${path}`;
  const isRelativeApi = state.apiBase.startsWith("/");
  const isSameOriginApi = isRelativeApi || new URL(requestUrl, window.location.origin).origin === window.location.origin;
  const res = await fetch(`${state.apiBase}${path}`, {
    ...init,
    credentials: isSameOriginApi ? "same-origin" : "omit",
    headers: {
      "content-type": "application/json",
      ...(state.adminToken ? { authorization: `Bearer ${state.adminToken}` } : {}),
      ...(init.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.message || data.error || `${res.status}`) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
  return data as T;
}

async function refresh(message = "已刷新") {
  state.loading = true;
  render();
  try {
    const [dashboard, contacts, users] = await Promise.all([
      api<Dashboard>("/v1/dashboard"),
      api<{ contacts: Row[] }>("/v1/contacts"),
      api<{ users: Row[] }>("/v1/users"),
    ]);
    state.dashboard = dashboard;
    state.contacts = contacts.contacts || [];
    state.users = users.users || [];
    state.message = message;
    state.needsOperatorAuth = false;
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error ? Number((error as { status?: number }).status || 0) : 0;
    if (status === 401) {
      state.needsOperatorAuth = true;
      state.message = IS_LOCAL_DEV ? "本地开发请填写 ADMIN_TOKEN；线上请通过 Cloudflare Access 登录" : "请通过 Cloudflare Access 登录后台";
    } else {
      state.message = `刷新失败：${error instanceof Error ? error.message : String(error)}`;
    }
  } finally {
    state.loading = false;
    render();
  }
}

async function createUser(event: Event) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const userId = String(data.get("id") || "").trim();
  const displayName = String(data.get("displayName") || "").trim();
  const notes = String(data.get("notes") || "").trim();
  if (!displayName) {
    state.message = "创建用户失败：显示名称必填";
    render();
    return;
  }

  state.loading = true;
  render();
  try {
    await api("/v1/users", {
      method: "POST",
      body: JSON.stringify({ id: userId || undefined, displayName, notes: notes || undefined }),
    });
    form.reset();
    await refresh("用户已创建");
    state.page = "users";
  } catch (error) {
    state.message = `创建用户失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    state.loading = false;
    render();
  }
}

async function assignDevice(deviceId: string, userId: string) {
  try {
    await api("/v1/devices/assign", {
      method: "POST",
      body: JSON.stringify({ deviceId, userId: userId || null }),
    });
    await refresh(userId ? "设备归属已更新" : "设备已设为未归属");
    state.page = "devices";
  } catch (error) {
    state.message = `分配失败：${error instanceof Error ? error.message : String(error)}`;
    render();
  }
}

function setPage(page: PageKey) {
  state.page = page;
  localStorage.setItem("dm.page", page);
  render();
}

function parseContactsText(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [nameOrJid, maybeJid] = line.split(",").map((part) => part.trim());
      return maybeJid ? { name: nameOrJid, jid: maybeJid } : { jid: nameOrJid };
    })
    .filter((contact) => contact.jid);
}

function contactsToText(contacts: Row[]) {
  return contacts
    .map((contact) => {
      const jid = textCell(contact.wa_jid);
      if (jid === "-") return "";
      const name = textCell(contact.display_name);
      return name === "-" ? jid : `${name}, ${jid}`;
    })
    .filter(Boolean)
    .join("\n");
}

function recipientTextForDevice(deviceId: string) {
  if (Object.prototype.hasOwnProperty.call(state.dispatchContactOverrides, deviceId)) {
    return state.dispatchContactOverrides[deviceId] || "";
  }
  return contactsToText(state.deviceContactsById[deviceId] || []);
}

function campaignTitleForDevice(baseTitle: string, device: Row) {
  const deviceName = String(device.device_name || "").trim() || String(device.id || "");
  return `${baseTitle} · ${deviceName}`;
}

async function createCampaign(event: Event) {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = new FormData(form);
  const dataSnapshot = visibleData();
  const selectedIds = new Set(state.dispatchSelectedDeviceIds);
  const selectedDevices = dataSnapshot.devices
    .filter((device) => selectedIds.has(String(device.id || "")))
    .filter(isDeviceReady);
  if (!selectedDevices.length) {
    state.message = "创建失败：无可用设备:请先在 Android 端登录账号或等待发送安全恢复";
    render();
    return;
  }

  state.loading = true;
  state.dispatchResults = [];
  render();
  try {
    const title = String(data.get("title") || "").trim();
    const message = String(data.get("message") || "").trim();
    const points = Number(data.get("points") || 10);
    const results: DispatchResult[] = [];

    for (const device of selectedDevices) {
      const deviceId = String(device.id || "");
      const contacts = parseContactsText(recipientTextForDevice(deviceId));
      if (!contacts.length) {
        results.push({ deviceId, ok: false, message: "没有可下发收件人" });
        state.dispatchResults = [...results];
        render();
        continue;
      }
      try {
        const result = await api<{ campaign: { id: string; taskCount: number } }>("/v1/campaigns", {
          method: "POST",
          body: JSON.stringify({
            title: campaignTitleForDevice(title, device),
            message,
            contacts,
            points,
            deviceId,
          }),
        });
        results.push({
          deviceId,
          ok: true,
          taskCount: result.campaign.taskCount,
          message: `已创建 ${result.campaign.taskCount} 条`,
        });
      } catch (error) {
        results.push({ deviceId, ok: false, message: error instanceof Error ? error.message : String(error) });
      }
      state.dispatchResults = [...results];
      render();
    }

    const successCount = results.filter((result) => result.ok).length;
    const failedCount = results.length - successCount;
    state.message = `下发完成：${successCount} 台成功，${failedCount} 台失败`;
    if (failedCount === 0) state.dispatchResults = results;
  } catch (error) {
    state.message = `下发失败：${error instanceof Error ? error.message : String(error)}`;
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
  return { devices, tasks, campaigns, events, ledger, contacts, users: state.users };
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

function dispatchDevicesForUser(data: ReturnType<typeof visibleData>, userId: string) {
  return data.devices
    .filter(isAccountScopedDevice)
    .filter((device) => String(device.user_id || "") === userId);
}

function readyDispatchDevicesForUser(data: ReturnType<typeof visibleData>, userId: string) {
  return dispatchDevicesForUser(data, userId).filter(isDeviceReady);
}

function deviceDisplayName(device: Row) {
  return String(device.device_name || "").trim() || String(device.id || "");
}

function setDispatchUser(userId: string, data: ReturnType<typeof visibleData>) {
  state.dispatchUserId = userId;
  localStorage.setItem("dm.dispatchUserId", userId);
  state.dispatchSelectedDeviceIds = readyDispatchDevicesForUser(data, userId).map((device) => String(device.id || ""));
  state.dispatchSelectionInitialized = true;
  state.dispatchContactOverrides = {};
  state.dispatchResults = [];
  void loadDeviceContacts(state.dispatchSelectedDeviceIds);
}

function syncDispatchSelection(data: ReturnType<typeof visibleData>) {
  const users = data.users;
  const availableUserIds = new Set(users.map((user) => String(user.id || "")));
  if (!state.dispatchUserId || !availableUserIds.has(state.dispatchUserId)) {
    const firstUserWithReadyDevice = users.find((user) => readyDispatchDevicesForUser(data, String(user.id || "")).length > 0);
    const firstUser = firstUserWithReadyDevice || users[0];
    if (firstUser) setDispatchUser(String(firstUser.id || ""), data);
  }

  const userDeviceIds = new Set(dispatchDevicesForUser(data, state.dispatchUserId).map((device) => String(device.id || "")));
  const readyDeviceIds = new Set(readyDispatchDevicesForUser(data, state.dispatchUserId).map((device) => String(device.id || "")));
  state.dispatchSelectedDeviceIds = state.dispatchSelectedDeviceIds
    .filter((deviceId) => userDeviceIds.has(deviceId) && readyDeviceIds.has(deviceId));
  if (!state.dispatchSelectionInitialized && !state.dispatchSelectedDeviceIds.length && readyDeviceIds.size > 0) {
    state.dispatchSelectedDeviceIds = Array.from(readyDeviceIds);
    state.dispatchSelectionInitialized = true;
  }
  void loadDeviceContacts(state.dispatchSelectedDeviceIds);
}

function setDispatchDeviceSelected(deviceId: string, checked: boolean) {
  const selected = new Set(state.dispatchSelectedDeviceIds);
  if (checked) selected.add(deviceId);
  else selected.delete(deviceId);
  state.dispatchSelectedDeviceIds = Array.from(selected);
  state.dispatchSelectionInitialized = true;
  state.dispatchResults = [];
  void loadDeviceContacts(state.dispatchSelectedDeviceIds);
  render();
}

async function loadDeviceContacts(deviceIds: string[]) {
  const missing = deviceIds.filter((deviceId) => (
    state.deviceContactsById[deviceId] === undefined
    && !state.deviceContactsLoading[deviceId]
  ));
  if (!missing.length) return;

  for (const deviceId of missing) {
    state.deviceContactsLoading[deviceId] = true;
    state.deviceContactsError[deviceId] = "";
  }
  render();

  await Promise.all(missing.map(async (deviceId) => {
    try {
      const result = await api<{ contacts: Row[] }>(`/v1/contacts?deviceId=${encodeURIComponent(deviceId)}`);
      state.deviceContactsById[deviceId] = result.contacts || [];
    } catch (error) {
      state.deviceContactsError[deviceId] = error instanceof Error ? error.message : String(error);
      state.deviceContactsById[deviceId] = [];
    } finally {
      state.deviceContactsLoading[deviceId] = false;
    }
  }));
  render();
}

function sumPoints(rows: Row[]) {
  return rows.reduce((total, entry) => total + Number(entry.points || 0), 0);
}

function userById(userId: unknown) {
  const id = String(userId || "");
  return state.users.find((user) => String(user.id || "") === id) || null;
}

function userLabel(userId: unknown) {
  if (!userId) return "未归属";
  const user = userById(userId);
  return user ? `${textCell(user.display_name)} (${textCell(user.id)})` : String(userId);
}

function pointsText(value: unknown) {
  return `${Number(value || 0)} 分`;
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

function statusChipForTask(task: Row) {
  const status = String(task.status || "");
  const label = status === "read" ? "已读"
    : status === "sent" ? "待确认"
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
            const tokenInput = form.elements.namedItem("adminToken") as HTMLInputElement | null;
            state.apiBase = input.value.replace(/\/$/, "");
            state.adminToken = tokenInput?.value.trim() || "";
            localStorage.setItem("dm.apiBase", state.apiBase);
            localStorage.setItem("dm.adminToken", state.adminToken);
            refresh();
          } }, [
            el("input", { name: "api", value: state.apiBase, "aria-label": "API Base" }),
            IS_LOCAL_DEV ? el("input", {
              name: "adminToken",
              class: state.needsOperatorAuth ? "needs-token" : "",
              type: "password",
              value: state.adminToken,
              placeholder: "ADMIN_TOKEN",
              "aria-label": "ADMIN_TOKEN",
              autocomplete: "off",
            }) : "",
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
  syncDispatchSelection(data);
  const users = data.users;
  const userDevices = dispatchDevicesForUser(data, state.dispatchUserId);
  const readyDevices = readyDispatchDevicesForUser(data, state.dispatchUserId);
  const selectedIds = new Set(state.dispatchSelectedDeviceIds);
  const selectedDevices = readyDevices.filter((device) => selectedIds.has(String(device.id || "")));
  const hasReadyDevice = readyDevices.length > 0;
  const loadingContacts = selectedDevices.some((device) => state.deviceContactsLoading[String(device.id || "")]);
  const canSubmit = Boolean(state.dispatchUserId) && selectedDevices.length > 0 && !loadingContacts;

  renderShell([
    pageHead("创建任务", "按用户选择设备；默认使用每台设备自己同步的联系人，创建后由 Android 轮询领取"),
    el("section", { class: "grid two" }, [
      card("下发配置", [
        el("form", { class: "task-form", onsubmit: createCampaign }, [
          el("label", {}, [
            el("span", { text: "用户" }),
            el("select", {
              name: "userId",
              "aria-label": "用户",
              value: state.dispatchUserId,
              disabled: !users.length,
              onchange: (event: Event) => {
                setDispatchUser((event.currentTarget as HTMLSelectElement).value, data);
                render();
              },
            }, [
              users.length ? "" : el("option", { value: "", text: "暂无用户" }),
              ...users.map((user) => el("option", { value: String(user.id), text: `${textCell(user.display_name)} (${textCell(user.id)})` })),
            ]),
          ]),
          users.length ? "" : el("div", { class: "form-hint warning", text: "暂无用户:请先在“用户”页创建并在“设备管理”分配设备" }),
          el("label", {}, [el("span", { text: "标题" }), el("input", { name: "title", required: true, value: "MVP 真机测试" })]),
          el("label", {}, [el("span", { text: "消息" }), el("textarea", { name: "message", required: true, rows: 6, placeholder: "发给该用户设备联系人的固定文本" })]),
          el("div", { class: "form-row" }, [
            el("label", {}, [el("span", { text: "积分" }), el("input", { name: "points", type: "number", value: "10", min: "0" })]),
            el("div", { class: "form-hint", text: "每台选中设备会单独创建一个 campaign；收件人来自该设备同步数据，可逐台覆盖。" }),
          ]),
          hasReadyDevice ? "" : el("div", { class: "form-hint warning", text: "无可用设备:请先在 Android 端登录账号或等待发送安全恢复" }),
          selectedDevices.length ? "" : el("div", { class: "form-hint warning", text: "请至少选择一台发送安全为可发送的用户设备" }),
          loadingContacts ? el("div", { class: "form-hint", text: "正在读取设备联系人，请稍候" }) : "",
          el("button", { class: "btn primary wide", type: "submit", disabled: !canSubmit || state.loading, text: state.loading ? "下发中" : "创建并下发" }),
        ]),
      ], undefined, "不做 AI 改写，不承诺订阅者过滤；只创建真实 Worker task。"),
      card("用户设备与收件人", [
        el("div", { class: "device-list" }, userDevices.length ? userDevices.map((device) => {
          const deviceId = String(device.id || "");
          const ready = isDeviceReady(device);
          const selected = selectedIds.has(deviceId);
          return el("label", { class: ready ? "device-option" : "device-option disabled" }, [
            el("input", {
              type: "checkbox",
              "aria-label": `选择设备 ${deviceId}`,
              checked: selected,
              disabled: !ready,
              onchange: (event: Event) => setDispatchDeviceSelected(deviceId, (event.currentTarget as HTMLInputElement).checked),
            }),
            el("span", {}, [
              el("strong", { text: deviceDisplayName(device) }),
              el("span", { class: "mono muted block", text: deviceId }),
            ]),
            badge(deviceActivityLabel(device), statusTone(device.status)),
            badge(deviceSafety(device), statusTone(device.safety_status)),
          ]);
        }) : [
          el("div", { class: "form-hint warning", text: "该用户暂无 android-wa-* 设备" }),
        ]),
        el("div", { class: "recipient-list" }, selectedDevices.map((device) => {
          const deviceId = String(device.id || "");
          const contactCount = state.deviceContactsById[deviceId]?.length || 0;
          const loading = state.deviceContactsLoading[deviceId];
          const error = state.deviceContactsError[deviceId];
          return el("section", { class: "recipient-panel" }, [
            el("div", { class: "recipient-head" }, [
              el("div", {}, [
                el("strong", { text: deviceDisplayName(device) }),
                el("span", { class: "mono muted block", text: deviceId }),
              ]),
              badge(loading ? "读取联系人" : `${contactCount} 个联系人`, loading ? "accent" : contactCount ? "success" : "warning"),
            ]),
            error ? el("div", { class: "form-hint warning", text: `读取联系人失败：${error}` }) : "",
            el("label", {}, [
              el("span", { text: "收件人，每行：名称, jid" }),
              el("textarea", {
                "aria-label": `收件人 ${deviceId}`,
                rows: 5,
                value: recipientTextForDevice(deviceId),
                placeholder: "可手动覆盖，例如：小号, 85255804693@s.whatsapp.net",
                oninput: (event: Event) => {
                  state.dispatchContactOverrides[deviceId] = (event.currentTarget as HTMLTextAreaElement).value;
                  state.dispatchResults = [];
                },
              }),
            ]),
          ]);
        })),
      ], undefined, "默认从 B17a 的 /v1/contacts?deviceId= 读取；数据刷新每 5-10s 有延迟。"),
    ]),
    state.dispatchResults.length ? card("下发结果", [
      table(["设备", "结果", "说明"], state.dispatchResults.map((result) => [
        el("span", { class: "mono", text: result.deviceId }),
        badge(result.ok ? "成功" : "失败", result.ok ? "success" : "danger"),
        el("span", { text: `${result.deviceId}：${result.message}` }),
      ])),
      state.dispatchResults.some((result) => !result.ok)
        ? el("div", { class: "form-hint warning", text: "失败设备可调整收件人或安全状态后重试" })
        : "",
    ]) : "",
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
  const totalBooked = data.users.reduce((total, user) => total + Number(user.points || 0), 0);
  const totalPending = data.users.reduce((total, user) => total + Number(user.pending_points || 0), 0);

  renderShell([
    pageHead("积分 Ledger", "只展示当前真实 read_reward 入账；兑换审批暂不属于 MVP"),
    el("section", { class: "metrics three" }, [
      metric("已入账", totalBooked || "-", "warning"),
      metric("待确认", totalPending || "-"),
      metric("入账笔数", data.ledger.length || "-"),
    ]),
    el("section", { class: "grid two" }, [
      card("真实 User 汇总", [
        table(["用户", "待确认", "已入账", "设备"], data.users.map((user) => [
          el("span", {}, [
            el("strong", { text: textCell(user.display_name) }),
            el("span", { class: "mono muted block", text: textCell(user.id) }),
          ]),
          badge(pointsText(user.pending_points), "accent"),
          badge(pointsText(user.points), "success"),
          el("span", { class: "tnum muted", text: textCell(user.device_count) }),
        ])),
      ], undefined, "按 B14a 的真实 User 聚合，不再按 device_id 归并。"),
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
      table(["设备", "WA 账号", "归属用户", "状态", "发送安全", "retry", "最后活跃"], devices.map((device) => [
        el("span", { class: "mono", text: textCell(device.id) }),
        el("span", { class: "mono muted", text: textCell(device.wa_jid) }),
        el("div", { class: "assignment-cell" }, [
          badge(userLabel(device.user_id), device.user_id ? "success" : "warning"),
          el("select", {
            "aria-label": `归属用户 ${textCell(device.id)}`,
            value: String(device.user_id || ""),
            onchange: (event: Event) => assignDevice(String(device.id || ""), (event.currentTarget as HTMLSelectElement).value),
          }, [
            el("option", { value: "", text: "未归属" }),
            ...data.users.map((user) => el("option", { value: String(user.id), text: `${user.display_name} (${user.id})` })),
          ]),
        ]),
        badge(deviceActivityLabel(device), statusTone(device.status)),
        badge(deviceSafety(device), statusTone(device.safety_status)),
        el("span", { class: "tnum muted", text: `${Number(device.safety_retry_after_seconds || 0)}s` }),
        el("span", { class: "tnum muted", text: fmtTime(device.last_seen_at) }),
      ])),
    ], undefined, "设备绑定和扫码登录在 Android App 内完成；当前 Web 不提供 token 吊销假能力。"),
  ]);
}

function renderUsers(data: ReturnType<typeof visibleData>) {
  const totalBooked = data.users.reduce((total, user) => total + Number(user.points || 0), 0);
  const totalPending = data.users.reduce((total, user) => total + Number(user.pending_points || 0), 0);
  renderShell([
    pageHead("用户", "运营维护的创作者账号；无创作者登录，仅用于设备归属和积分聚合"),
    el("section", { class: "metrics three" }, [
      metric("用户", data.users.length || "-"),
      metric("待确认", totalPending || "-"),
      metric("已入账", totalBooked || "-", "warning"),
    ]),
    el("section", { class: "grid two" }, [
      card("建用户", [
        el("form", { class: "task-form", onsubmit: createUser }, [
          el("label", {}, [el("span", { text: "用户 ID" }), el("input", { name: "id", placeholder: "可空，后端自动生成" })]),
          el("label", {}, [el("span", { text: "显示名称" }), el("input", { name: "displayName", required: true, placeholder: "创作者昵称" })]),
          el("label", {}, [el("span", { text: "备注" }), el("input", { name: "notes", placeholder: "运营备注，可空" })]),
          el("button", { class: "btn primary wide", type: "submit", text: state.loading ? "创建中" : "创建用户" }),
        ]),
      ], undefined, "这里只是运营后台账号，不提供创作者注册或登录。"),
      card("用户聚合", [
        table(["用户", "待确认", "已入账", "设备", "备注"], data.users.map((user) => [
          el("span", {}, [
            el("strong", { text: textCell(user.display_name) }),
            el("span", { class: "mono muted block", text: textCell(user.id) }),
          ]),
          badge(pointsText(user.pending_points), "accent"),
          badge(pointsText(user.points), "success"),
          el("span", { class: "tnum muted", text: textCell(user.device_count) }),
          el("span", { class: "muted", text: textCell(user.notes) }),
        ])),
      ], undefined, "待确认来自 sent 未读任务；已入账来自 read_reward ledger 聚合。"),
    ]),
  ]);
}

function render() {
  const data = visibleData();
  if (state.page === "dispatch") return renderDispatch(data);
  if (state.page === "tasks") return renderTasks(data);
  if (state.page === "ledger") return renderLedger(data);
  if (state.page === "devices") return renderDevices(data);
  if (state.page === "users") return renderUsers(data);
  return renderOverview(data);
}

render();
refresh();
