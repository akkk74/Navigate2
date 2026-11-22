// Слой совместимости: API Scriptable -> Android (Kotlin-мост `Android`).
var __seq = 0, __httpCbs = {}, __locCbs = {};

class Request {
  constructor(url) {
    this.url = url; this.method = "GET"; this.headers = {}; this.body = null;
    this.timeoutInterval = 60; this.response = null;
  }
  loadString() {
    return new Promise((resolve, reject) => {
      const id = ++__seq;
      __httpCbs[id] = {
        resolve: (r) => { this.response = { statusCode: r.status, headers: r.headers || {} }; resolve(r.text); },
        reject
      };
      Android.http(id, JSON.stringify({
        url: this.url, method: this.method, headers: this.headers,
        body: this.body, timeout: this.timeoutInterval
      }));
    });
  }
}
window.__httpDone = (id, r) => {
  const cb = __httpCbs[id]; if (!cb) return; delete __httpCbs[id];
  if (r && r.ok) cb.resolve(r); else cb.reject(new Error((r && r.error) || "Сетевая ошибка"));
};

const __fm = {
  documentsDirectory: () => "/docs",
  temporaryDirectory: () => "/tmp",
  joinPath: (a, b) => String(a).replace(/\/$/, "") + "/" + b,
  fileExists: (p) => Android.fileExists(p),
  readString: (p) => Android.readFile(p),
  writeString: (p, s) => Android.writeFile(p, String(s)),
  downloadFileFromiCloud: async () => {}
};
const FileManager = { local: () => __fm, iCloud: () => __fm };
const Script = { name: () => "Sputnik" };
const Pasteboard = { copyString: (t) => Android.copy(String(t)) };

const Location = {
  setAccuracyToBest() {},
  current() {
    return new Promise((resolve, reject) => {
      const id = ++__seq; __locCbs[id] = { resolve, reject }; Android.getLocation(id);
    });
  }
};
window.__locDone = (id, r) => {
  const cb = __locCbs[id]; if (!cb) return; delete __locCbs[id];
  if (r && typeof r.lat === "number") cb.resolve({ latitude: r.lat, longitude: r.lng });
  else cb.reject(new Error((r && r.error) || "GPS"));
};

class WebView {
  constructor() { this.shouldAllowRequest = null; window.__wv = this; }
  evaluateJavaScript(code) { Android.toUi(code); return Promise.resolve(); }
  loadHTML(html) {
    // В Android отправляем команды через мост, а не через смену location.href
    html = html.replace("window.location.href = nextUrl;",
      "(window.AndroidBridge ? AndroidBridge.send(nextUrl) : (window.location.href = nextUrl));");
    Android.showUi(html);
    return Promise.resolve();
  }
  present() { return Promise.resolve(); }
}
window.__handleUrl = (u) => {
  try { window.__wv && window.__wv.shouldAllowRequest && window.__wv.shouldAllowRequest({ url: u }); } catch (e) {}
};
