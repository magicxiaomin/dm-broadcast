package com.magicxiaomin.dmbroadcast.device

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import com.magicxiaomin.wa.sdk.WaBridgeClient
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

class MainActivity : Activity() {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val defaultApiBase = "https://dm-broadcast-api.magicxiaomin.workers.dev"
    private val pendingTaskByClientMsgId = mutableMapOf<String, CloudTask>()
    private val pollRunnable = object : Runnable {
        override fun run() {
            pollOnce()
            mainHandler.postDelayed(this, POLL_INTERVAL_MS)
        }
    }

    private lateinit var client: WaBridgeClient
    private lateinit var status: TextView
    private lateinit var safetyView: TextView
    private lateinit var apiInput: EditText
    private lateinit var resolveInput: EditText
    private lateinit var qrImage: ImageView
    private lateinit var qrPayload: TextView
    private lateinit var logView: TextView
    private lateinit var logScroll: ScrollView

    private var apiBase = defaultApiBase
    private var deviceId = FALLBACK_DEVICE_ID
    private var selfJid = ""
    private var connected = false
    private var polling = false
    private var lastTask: CloudTask? = null
    private var lastReportedDeviceStatus = ""
    private var lastReportedSafetySignature = ""
    @Volatile private var riskStopped = false

    data class CloudTask(
        val id: String,
        val contactJid: String,
        val text: String,
        val clientMsgId: String,
        val points: Int,
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestNotificationsIfNeeded()
        buildUi()
        bindBridge()
    }

    override fun onDestroy() {
        stopPolling()
        runCatching { client.unbind() }
        super.onDestroy()
    }

    private fun buildUi() {
        status = TextView(this).apply {
            textSize = 15f
            text = "正在启动桥接服务..."
            setTextIsSelectable(true)
        }
        safetyView = TextView(this).apply {
            textSize = 13f
            text = "安全状态：未读取"
            setTextIsSelectable(true)
        }
        apiInput = EditText(this).apply {
            setSingleLine(true)
            setText(apiBase)
        }
        resolveInput = EditText(this).apply {
            setSingleLine(true)
            hint = "手机号或 JID，用于解析测试联系人"
        }
        qrImage = ImageView(this).apply {
            adjustViewBounds = true
            maxHeight = dp(360)
        }
        qrPayload = TextView(this).apply {
            textSize = 10f
            setTextIsSelectable(true)
            maxLines = 4
        }
        logView = TextView(this).apply {
            textSize = 13f
            setTextIsSelectable(true)
        }
        logScroll = ScrollView(this).apply {
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
            addView(logView)
        }

        val connectButton = Button(this).apply {
            text = "连接 / 生成二维码"
            setOnClickListener {
                status.text = "正在连接..."
                runBridgeCall { client.connectBridge() }
            }
        }
        val identityButton = Button(this).apply {
            text = "读取身份"
            setOnClickListener { loadIdentityAndRegister() }
        }
        val safetyButton = Button(this).apply {
            text = "安全状态"
            setOnClickListener { refreshSafetyStatus() }
        }
        val startPollButton = Button(this).apply {
            text = "启动轮询"
            setOnClickListener {
                apiBase = apiInput.text.toString().trim().ifBlank { defaultApiBase }.removeSuffix("/")
                startPolling()
            }
        }
        val stopPollButton = Button(this).apply {
            text = "停止轮询"
            setOnClickListener { stopPolling() }
        }
        val syncContactsButton = Button(this).apply {
            text = "同步联系人"
            setOnClickListener { syncContacts() }
        }
        val readButton = Button(this).apply {
            text = "验收已读"
            setOnClickListener { postReadForLastTask() }
        }
        val resolveButton = Button(this).apply {
            text = "解析并同步"
            setOnClickListener { resolveAndSyncContact() }
        }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 48, 32, 32)
            addView(status)
            addView(safetyView)
            addView(TextView(this@MainActivity).apply { text = "Worker API"; textSize = 13f })
            addView(apiInput)
            addView(row(connectButton, identityButton))
            addView(row(safetyButton))
            addView(row(startPollButton, stopPollButton))
            addView(row(syncContactsButton, readButton))
            addView(resolveInput)
            addView(row(resolveButton))
            addView(qrImage)
            addView(qrPayload)
            addView(TextView(this@MainActivity).apply {
                text = "设备 / 云端 / IM 事件"
                textSize = 14f
            })
            addView(logScroll)
        }
        setContentView(root)
    }

    private fun bindBridge() {
        client = WaBridgeClient(this, "dm-broadcast-device")
        client.setEventListener { eventType, payloadJson -> handleBridgeEvent(eventType, payloadJson) }
        runCatching {
            client.bind()
            status.text = "正在绑定桥接服务..."
        }.onFailure {
            status.text = "桥接服务绑定失败：${it.message}"
        }
    }

    private fun handleBridgeEvent(eventType: String, payloadJson: String) {
        status.text = "$eventType\n$payloadJson"
        appendLog("IM $eventType $payloadJson")
        when (eventType) {
            "qr_generated" -> {
                val qr = JSONObject(payloadJson).optString("qr")
                if (qr.isNotBlank()) {
                    qrImage.setImageBitmap(makeQr(qr))
                    qrPayload.text = qr
                }
            }
            "connected", "session_restored" -> {
                connected = true
                loadIdentityAndRegister()
            }
            "error" -> {
                val message = runCatching { JSONObject(payloadJson).optString("message") }.getOrDefault(payloadJson)
                safetyFromBridgeError(message)?.let { safety ->
                    applySafetyStatus(safety)
                    appendLog("SAFETY inferred from bridge event $safety")
                }
            }
            "read", "message_read", "receipt_read", "read_receipt" -> {
                forwardImEvent(eventType, payloadJson)
            }
            else -> {
                if (eventType.startsWith("message_")) {
                    forwardImEvent(eventType, payloadJson)
                }
            }
        }
    }

    private fun loadIdentityAndRegister() {
        runBridgeCall {
            val identity = client.getSelfIdentity()
            val json = JSONObject(identity)
            selfJid = json.optString("self_jid")
            deviceId = deviceIdForSelfJid(selfJid)
            pendingTaskByClientMsgId.clear()
            lastTask = null
            lastReportedDeviceStatus = ""
            lastReportedSafetySignature = ""
            connected = json.optBoolean("is_connected", connected)
            appendLogOnMain("SELF $identity")
            appendLogOnMain("DEVICE scoped id=$deviceId")
            val safety = readSafetyStatus()
            registerDevice(safety)
            appendLogOnMain("CLOUD registered $deviceId")
            syncContacts()
            mainHandler.post { startPolling() }
        }
    }

    private fun registerDevice(safety: JSONObject? = null) {
        val body = JSONObject()
            .put("id", deviceId)
            .put("deviceName", "dm-broadcast-device")
            .put("waJid", selfJid)
            .put("accountJid", selfJid)
            .put("status", if (connected) "online" else "offline")
        if (safety != null) body.put("safety", safety)
        postJson("/v1/devices/register", body)
    }

    private fun syncContacts() {
        runBridgeCall {
            val contactsJson = client.getContacts()
            val source = JSONArray(contactsJson)
            val contacts = JSONArray()
            for (i in 0 until source.length()) {
                val item = source.getJSONObject(i)
                val jid = item.optString("jid")
                if (jid.isNotBlank()) {
                    contacts.put(JSONObject().put("jid", jid).put("name", item.optString("name")))
                }
            }
            val response = postJson("/v1/contacts/sync", JSONObject().put("contacts", contacts))
            appendLogOnMain("CLOUD contacts ${response.optInt("synced")} / ${source.length()}")
        }
    }

    private fun resolveAndSyncContact() {
        val raw = resolveInput.text.toString().trim()
        if (raw.isBlank()) {
            appendLog("RESOLVE input empty")
            return
        }
        runBridgeCall {
            val resolved = client.resolveJID(raw)
            appendLogOnMain("RESOLVE $raw -> $resolved")
            val jid = when {
                resolved.trim().isNotBlank() -> resolved.trim()
                raw.contains("@") -> raw
                else -> {
                    appendLogOnMain("RESOLVE not registered or empty result for $raw")
                    return@runBridgeCall
                }
            }.let {
                if (it.contains("@")) it else "$it@s.whatsapp.net"
            }
            val preferredJid = preferredJidFromUserInfo(jid) ?: jid
            val response = postJson(
                "/v1/contacts/sync",
                JSONObject().put(
                    "contacts",
                    JSONArray().put(JSONObject().put("jid", preferredJid).put("name", "小号 +85255804693")),
                ),
            )
            appendLogOnMain("CLOUD resolved contact synced ${response.optInt("synced")} jid=$preferredJid")
        }
    }

    private fun startPolling() {
        if (polling) return
        polling = true
        appendLog("POLL started")
        pollOnce()
        mainHandler.postDelayed(pollRunnable, POLL_INTERVAL_MS)
    }

    private fun stopPolling() {
        polling = false
        mainHandler.removeCallbacks(pollRunnable)
        appendLog("POLL stopped")
    }

    private fun pollOnce() {
        if (!polling || !connected) return
        Thread {
            val result = runCatching {
                if (!isSendAllowedBySafety()) {
                    appendLogOnMain("POLL paused by SDK safety")
                    return@runCatching
                }
                val response = getJson("/v1/tasks/pull?deviceId=$deviceId&limit=3")
                val tasks = response.optJSONArray("tasks") ?: JSONArray()
                if (tasks.length() == 0) {
                    appendLogOnMain("POLL no tasks")
                }
                for (i in 0 until tasks.length()) {
                    val item = tasks.getJSONObject(i)
                    val task = CloudTask(
                        id = item.getString("id"),
                        contactJid = item.getString("contactJid"),
                        text = item.getString("text"),
                        clientMsgId = item.getString("clientMsgId"),
                        points = item.optInt("points", 0),
                    )
                    sendCloudTask(task)
                }
            }
            result.exceptionOrNull()?.let { appendLogOnMain("POLL error ${it.message}") }
        }.start()
    }

    private fun sendCloudTask(task: CloudTask) {
        if (!isSendAllowedBySafety()) {
            appendLogOnMain("SEND skipped by SDK safety ${task.id}")
            return
        }
        pendingTaskByClientMsgId[task.clientMsgId] = task
        lastTask = task
        val sendTarget = preferredJidFromUserInfo(task.contactJid) ?: task.contactJid
        Thread.sleep(6_000)
        if (!isSendAllowedBySafety()) {
            appendLogOnMain("SEND delayed by SDK operation safety ${task.id}")
            return
        }
        appendLogOnMain("SEND ${task.id} -> $sendTarget (${task.points} pts)")
        val result = runCatching {
            client.sendText(sendTarget, task.text, task.clientMsgId)
        }
        result.exceptionOrNull()?.let { err ->
            pendingTaskByClientMsgId.remove(task.clientMsgId)
            postJson(
                "/v1/events",
                JSONObject()
                    .put("deviceId", deviceId)
                    .put("taskId", task.id)
                    .put("clientMsgId", task.clientMsgId)
                    .put("eventType", "message_failed")
                    .put("payload", JSONObject().put("error", err.message ?: "sendText failed")),
            )
            appendLogOnMain("SEND failed ${task.id}: ${err.message}")
        }
    }

    private fun preferredJidFromUserInfo(jid: String): String? {
        val result = runCatching {
            val userInfo = client.getUserInfo(JSONArray().put(jid).toString())
            appendLogOnMain("USERINFO $jid -> $userInfo")
            val first = JSONArray(userInfo).optJSONObject(0)
            first?.optString("lid")?.takeIf { it.isNotBlank() }
        }
        result.exceptionOrNull()?.let { appendLogOnMain("USERINFO error ${it.message}") }
        return result.getOrNull()
    }

    private fun refreshSafetyStatus() {
        runBridgeCall {
            val safety = readSafetyStatus()
            if (safety != null) {
                registerDevice(safety)
            }
            appendLogOnMain("SAFETY ${safety ?: "{}"}")
        }
    }

    private fun readSafetyStatus(): JSONObject? {
        val result = runCatching { JSONObject(client.getSafetyStatus()) }
        result.onSuccess { applySafetyStatus(it) }
        result.exceptionOrNull()?.let { err ->
            appendLogOnMain("SAFETY error ${err.message}")
        }
        return result.getOrNull()
    }

    private fun applySafetyStatus(json: JSONObject) {
        val risk = json.optBoolean("risk_stopped", false)
        val riskWait = json.optInt("risk_retry_after_seconds", 0)
        val sendWait = json.optInt("send_retry_after_seconds", 0)
        val operationWait = json.optInt("operation_retry_after_seconds", 0)
        val wait = maxOf(riskWait, sendWait, operationWait)
        val bridgeState = json.optString("state")
        val notConnected = bridgeState.isNotBlank() && bridgeState != "connected"
        riskStopped = risk
        val label = when {
            risk -> "安全状态：risk stop，等待 ${riskWait}s"
            notConnected -> "安全状态：连接中 ($bridgeState)"
            wait > 0 -> "安全状态：冷却中，等待 ${wait}s"
            else -> "安全状态：可发送"
        }
        val cloudStatus = when {
            risk -> "risk_stopped"
            wait > 0 || notConnected -> "cooldown"
            connected -> "online"
            else -> "offline"
        }
        reportDeviceStatus(cloudStatus, json)
        mainHandler.post { safetyView.text = label }
    }

    private fun reportDeviceStatus(deviceStatus: String, safety: JSONObject? = null) {
        val safetySignature = safety?.toString() ?: ""
        if (deviceStatus == lastReportedDeviceStatus && safetySignature == lastReportedSafetySignature) return
        lastReportedDeviceStatus = deviceStatus
        lastReportedSafetySignature = safetySignature
        Thread {
            runCatching {
                val body = JSONObject()
                    .put("id", deviceId)
                    .put("deviceName", "dm-broadcast-device")
                    .put("waJid", selfJid)
                    .put("accountJid", selfJid)
                    .put("status", deviceStatus)
                if (safety != null) {
                    body.put("safety", safety)
                }
                postJson("/v1/devices/register", body)
            }.onFailure {
                appendLogOnMain("CLOUD status error ${it.message}")
            }
        }.start()
    }

    private fun isSendAllowedBySafety(): Boolean {
        val safety = readSafetyStatus() ?: return false
        runCatching { registerDevice(safety) }
            .exceptionOrNull()
            ?.let { appendLogOnMain("SAFETY report error ${it.message}") }
        val riskWait = safety.optInt("risk_retry_after_seconds", 0)
        val sendWait = safety.optInt("send_retry_after_seconds", 0)
        val operationWait = safety.optInt("operation_retry_after_seconds", 0)
        val wait = maxOf(riskWait, sendWait, operationWait)
        val bridgeState = safety.optString("state")
        val notConnected = bridgeState.isNotBlank() && bridgeState != "connected"
        if (safety.optBoolean("risk_stopped", false) || riskStopped || wait > 0 || notConnected) {
            appendLogOnMain("SAFETY blocks send risk=${safety.optBoolean("risk_stopped", false)} wait=${wait}s state=$bridgeState")
            return false
        }
        return true
    }

    private fun forwardImEvent(eventType: String, payloadJson: String) {
        Thread {
            val result = runCatching {
                val payload = JSONObject(payloadJson)
                val clientMsgId = payload.optString("clientMsgId")
                val task = pendingTaskByClientMsgId[clientMsgId]
                val normalized = eventType.lowercase()
                if (normalized == "message_failed" || normalized == "failed" || normalized.contains("read")) {
                    pendingTaskByClientMsgId.remove(clientMsgId)
                }
                postJson(
                    "/v1/events",
                    JSONObject()
                        .put("deviceId", deviceId)
                        .put("taskId", task?.id ?: "")
                        .put("clientMsgId", clientMsgId)
                        .put("eventType", eventType)
                        .put("payload", payload),
                )
                appendLogOnMain("CLOUD event $eventType task=${task?.id ?: clientMsgId}")
            }
            result.exceptionOrNull()?.let { appendLogOnMain("CLOUD event error ${it.message}") }
        }.start()
    }

    private fun postReadForLastTask() {
        val task = pendingTaskByClientMsgId.values.lastOrNull() ?: lastTask
        if (task == null) {
            appendLog("READ no local task; use Web task table if already sent")
            return
        }
        Thread {
            val result = runCatching {
                postJson(
                    "/v1/events",
                    JSONObject()
                        .put("deviceId", deviceId)
                        .put("taskId", task.id)
                        .put("clientMsgId", task.clientMsgId)
                        .put("eventType", "read")
                        .put("payload", JSONObject().put("source", "android_acceptance_button")),
                )
            }
            result.onSuccess { appendLogOnMain("READ posted ${task.id}") }
            result.exceptionOrNull()?.let { appendLogOnMain("READ error ${it.message}") }
        }.start()
    }

    private fun getJson(path: String): JSONObject {
        return requestJson("GET", path, null)
    }

    private fun postJson(path: String, body: JSONObject): JSONObject {
        return requestJson("POST", path, body)
    }

    private fun requestJson(method: String, path: String, body: JSONObject?): JSONObject {
        val url = URL(apiBase + path)
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15000
            readTimeout = 20000
            setRequestProperty("content-type", "application/json")
            setRequestProperty("accept", "application/json")
            if (body != null) doOutput = true
        }
        if (body != null) {
            OutputStreamWriter(conn.outputStream).use { it.write(body.toString()) }
        }
        val stream = if (conn.responseCode in 200..299) conn.inputStream else conn.errorStream
        val text = BufferedReader(InputStreamReader(stream)).use { it.readText() }
        if (conn.responseCode !in 200..299) {
            throw IllegalStateException("HTTP ${conn.responseCode}: $text")
        }
        return JSONObject(text)
    }

    private fun runBridgeCall(block: () -> Unit) {
        Thread {
            val result = runCatching(block)
            result.exceptionOrNull()?.let { err ->
                mainHandler.post {
                    status.text = "调用失败：${err.message}"
                    safetyFromBridgeError(err.message)?.let { safety ->
                        applySafetyStatus(safety)
                        appendLog("SAFETY inferred from bridge error $safety")
                    }
                    appendLog("ERROR ${err.message}")
                }
            }
        }.start()
    }

    private fun safetyFromBridgeError(message: String?): JSONObject? {
        val text = message ?: return null
        if (!text.contains("risk stop active", ignoreCase = true)) return null
        val reason = text
            .substringAfter("risk stop active:", "")
            .substringBefore("; retry after")
            .trim()
            .ifBlank { text }
        return JSONObject()
            .put("risk_stopped", true)
            .put("risk_reason", reason)
            .put("risk_retry_after_seconds", parseRetryAfterSeconds(text))
            .put("state", "disconnected")
    }

    private fun parseRetryAfterSeconds(message: String): Int {
        val retryText = message.substringAfter("retry after", "")
        if (retryText.isBlank()) return 0
        var seconds = 0
        Regex("(\\d+)\\s*d").find(retryText)?.let { seconds += it.groupValues[1].toInt() * 86400 }
        Regex("(\\d+)\\s*h").find(retryText)?.let { seconds += it.groupValues[1].toInt() * 3600 }
        Regex("(\\d+)\\s*m").find(retryText)?.let { seconds += it.groupValues[1].toInt() * 60 }
        Regex("(\\d+)\\s*s").find(retryText)?.let { seconds += it.groupValues[1].toInt() }
        return seconds
    }

    private fun deviceIdForSelfJid(jid: String): String {
        val account = jid
            .substringBefore("@")
            .lowercase()
            .replace(Regex("[^a-z0-9]+"), "-")
            .trim('-')
            .take(64)
        return if (account.isBlank()) FALLBACK_DEVICE_ID else "$DEVICE_ID_PREFIX$account"
    }

    private fun appendLogOnMain(line: String) {
        mainHandler.post { appendLog(line) }
    }

    private fun appendLog(line: String) {
        logView.append(line + "\n")
        logScroll.post { logScroll.fullScroll(View.FOCUS_DOWN) }
    }

    private fun row(vararg views: View): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            for (view in views) {
                (view.parent as? ViewGroup)?.removeView(view)
                addView(view, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            }
        }
    }

    private fun dp(value: Int): Int {
        return (value * resources.displayMetrics.density).toInt()
    }

    private fun makeQr(payload: String): Bitmap {
        val size = 720
        val matrix = QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, size, size)
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        for (x in 0 until size) {
            for (y in 0 until size) {
                bitmap.setPixel(x, y, if (matrix[x, y]) 0xFF000000.toInt() else 0xFFFFFFFF.toInt())
            }
        }
        return bitmap
    }

    private fun requestNotificationsIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 100)
        }
    }

    companion object {
        private const val FALLBACK_DEVICE_ID = "android-prototype"
        private const val DEVICE_ID_PREFIX = "android-wa-"
        private const val POLL_INTERVAL_MS = 10_000L
    }
}
