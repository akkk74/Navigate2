package com.sputnik.monitor

import android.Manifest
import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import android.app.Activity
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.Charset
import java.util.concurrent.Executors

/**
 * Две WebView:
 *  - engine (скрытая): исполняет исходный скрипт (SOAP, парсинг, генерация HTML) + слой совместимости;
 *  - ui (видимая): показывает карту/интерфейс, команды sputnik://... пересылает в engine.
 */
class MainActivity : Activity() {

    private lateinit var engine: WebView
    private lateinit var ui: WebView
    private val main = Handler(Looper.getMainLooper())
    private val pool = Executors.newCachedThreadPool()
    private var engineStarted = false
    private var pendingLocationId: Int? = null

    @SuppressLint("SetJavaScriptEnabled", "AddJavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(true)

        val root = FrameLayout(this)
        ui = WebView(this)
        engine = WebView(this)
        root.addView(ui, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(engine, FrameLayout.LayoutParams(1, 1))
        engine.alpha = 0f
        setContentView(root)

        configure(ui.settings)
        configure(engine.settings)
        ui.overScrollMode = View.OVER_SCROLL_NEVER
        ui.addJavascriptInterface(UiBridge(), "AndroidBridge")
        engine.addJavascriptInterface(EngineBridge(), "Android")

        ui.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (url.startsWith("sputnik://")) { sendToEngine(url); return true }
                return false
            }
        }
        engine.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String?) {
                if (engineStarted) return
                engineStarted = true
                val js = assets.open("engine.js").bufferedReader(Charsets.UTF_8).use { it.readText() }
                view.evaluateJavascript(js, null)
            }
        }
        engine.loadDataWithBaseURL("https://sputnik.local/engine", "<html><body></body></html>", "text/html", "UTF-8", null)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configure(s: WebSettings) {
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        s.mediaPlaybackRequiresUserGesture = false
        s.setSupportZoom(false)
        s.cacheMode = WebSettings.LOAD_DEFAULT
    }

    private fun sendToEngine(url: String) {
        main.post { engine.evaluateJavascript("window.__handleUrl(${JSONObject.quote(url)})", null) }
    }

    override fun onDestroy() {
        pool.shutdownNow()
        ui.destroy(); engine.destroy()
        super.onDestroy()
    }

    // ---------------- UI -> Kotlin ----------------
    inner class UiBridge {
        @JavascriptInterface
        fun send(url: String) { if (url.startsWith("sputnik://")) sendToEngine(url) }
    }

    // ---------------- engine -> Kotlin ----------------
    inner class EngineBridge {
        private fun docFile(path: String): File {
            val dir = File(filesDir, "docs").apply { mkdirs() }
            return File(dir, path.substringAfterLast('/'))
        }

        @JavascriptInterface fun fileExists(path: String): Boolean = docFile(path).exists()
        @JavascriptInterface fun readFile(path: String): String? =
            try { docFile(path).readText(Charsets.UTF_8) } catch (e: Exception) { null }
        @JavascriptInterface fun writeFile(path: String, text: String) {
            try { docFile(path).writeText(text, Charsets.UTF_8) } catch (e: Exception) { }
        }

        @JavascriptInterface fun readAsset(name: String): String? =
            try { assets.open(name).bufferedReader(Charsets.UTF_8).use { it.readText() } } catch (e: Exception) { null }

        @JavascriptInterface fun showUi(html: String) {
            main.post { ui.loadDataWithBaseURL("https://sputnik.local/", html, "text/html", "UTF-8", null) }
        }

        @JavascriptInterface fun toUi(code: String) {
            main.post { ui.evaluateJavascript(code, null) }
        }

        @JavascriptInterface fun copy(text: String) {
            main.post {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("sputnik", text))
            }
        }

        @JavascriptInterface fun fatal(msg: String) {
            main.post { Toast.makeText(this@MainActivity, "Ошибка движка: " + msg.take(300), Toast.LENGTH_LONG).show() }
        }

        @JavascriptInterface fun getLocation(id: Int) { main.post { requestLocation(id) } }

        @JavascriptInterface fun http(id: Int, reqJson: String) {
            pool.execute {
                val result = JSONObject()
                try {
                    val req = JSONObject(reqJson)
                    val conn = URL(req.getString("url")).openConnection() as HttpURLConnection
                    val timeoutMs = (req.optDouble("timeout", 30.0) * 1000).toInt()
                    conn.connectTimeout = timeoutMs
                    conn.readTimeout = timeoutMs
                    conn.requestMethod = req.optString("method", "GET")
                    req.optJSONObject("headers")?.let { h ->
                        h.keys().forEach { k -> conn.setRequestProperty(k, h.getString(k)) }
                    }
                    if (!req.isNull("body")) {
                        conn.doOutput = true
                        conn.outputStream.use { it.write(req.getString("body").toByteArray(Charsets.UTF_8)) }
                    }
                    val code = conn.responseCode
                    val stream = if (code >= 400) conn.errorStream else conn.inputStream
                    val bytes = stream?.use { s ->
                        val bos = ByteArrayOutputStream()
                        s.copyTo(bos); bos.toByteArray()
                    } ?: ByteArray(0)
                    val ctype = conn.contentType ?: ""
                    val cs = Regex("charset=([\\w-]+)", RegexOption.IGNORE_CASE).find(ctype)?.groupValues?.get(1)
                    val charset = try { if (cs != null) Charset.forName(cs) else Charsets.UTF_8 } catch (e: Exception) { Charsets.UTF_8 }
                    val headers = JSONObject()
                    for ((k, v) in conn.headerFields) {
                        if (k != null) headers.put(k, v.joinToString(", "))
                    }
                    result.put("ok", true).put("status", code)
                        .put("text", String(bytes, charset)).put("headers", headers)
                    conn.disconnect()
                } catch (e: Exception) {
                    result.put("ok", false).put("error", e.message ?: e.toString())
                }
                main.post {
                    engine.evaluateJavascript(
                        "window.__httpDone($id, JSON.parse(${JSONObject.quote(result.toString())}))", null
                    )
                }
            }
        }
    }

    // ---------------- Геолокация ----------------
    private fun locationReply(id: Int, json: JSONObject) {
        engine.evaluateJavascript("window.__locDone($id, JSON.parse(${JSONObject.quote(json.toString())}))", null)
    }

    private fun requestLocation(id: Int) {
        val granted = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (!granted) {
            pendingLocationId = id
            requestPermissions(
                arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), 77
            )
            return
        }
        fetchLocation(id)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != 77) return
        val id = pendingLocationId ?: return
        pendingLocationId = null
        if (grantResults.any { it == PackageManager.PERMISSION_GRANTED }) fetchLocation(id)
        else locationReply(id, JSONObject().put("error", "Нет доступа к геолокации. Разрешите доступ в настройках Android."))
    }

    @SuppressLint("MissingPermission")
    private fun fetchLocation(id: Int) {
        val lm = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        var done = false
        fun finish(loc: Location?) {
            if (done) return
            done = true
            if (loc != null) locationReply(id, JSONObject().put("lat", loc.latitude).put("lng", loc.longitude))
            else locationReply(id, JSONObject().put("error", "Не удалось определить координаты GPS"))
        }
        fun lastKnown(): Location? = try {
            lm.getProviders(true).mapNotNull { lm.getLastKnownLocation(it) }.maxByOrNull { it.time }
        } catch (e: Exception) { null }

        val provider = when {
            lm.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
            lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
            else -> null
        }
        if (provider == null) { finish(lastKnown()); return }

        try {
            if (Build.VERSION.SDK_INT >= 30) {
                lm.getCurrentLocation(provider, null, mainExecutor) { loc -> finish(loc ?: lastKnown()) }
            } else {
                val listener = object : LocationListener {
                    override fun onLocationChanged(location: Location) { finish(location) }
                    @Deprecated("legacy") override fun onStatusChanged(p: String?, s: Int, e: Bundle?) {}
                    override fun onProviderEnabled(p: String) {}
                    override fun onProviderDisabled(p: String) {}
                }
                @Suppress("DEPRECATION")
                lm.requestSingleUpdate(provider, listener, Looper.getMainLooper())
            }
        } catch (e: Exception) { finish(lastKnown()); return }
        main.postDelayed({ finish(lastKnown()) }, 15000)
    }
}
