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
    // Заранее собранный Tailwind вместо CDN-компилятора (он тормозит на Android)
    const css = Android.readAsset("tailwind.css");
    if (css && css.length > 2000) {
      html = html.replace('<script src="https://cdn.tailwindcss.com"></script>', () => "<style>" + css + "</style>");
    }
    // backdrop-filter (стекло) очень тяжёлый для Android WebView
    html = html.replace(/(-webkit-)?backdrop-filter\s*:[^;}]*;?/g, "");
    Android.showUi(html);
    return Promise.resolve();
  }
  present() { return Promise.resolve(); }
}
window.__handleUrl = (u) => {
  try { window.__wv && window.__wv.shouldAllowRequest && window.__wv.shouldAllowRequest({ url: u }); } catch (e) {}
};

(async () => {

// ============================================================================
// 1. ХРАНИЛИЩЕ НАСТРОЕК И СОСТОЯНИЕ СЕССИИ
// ============================================================================
const fm = FileManager.local();
const SETTINGS_PATH = fm.joinPath(fm.documentsDirectory(), "sputnik_mobile_settings.json");

const DEFAULT_SETTINGS = {
  server: "https://webask.ugmk.com/ASK-BUR/NavisolServiceMobile.asmx",
  login: "kru-test",
  password: "Jndf;yst29",
  autoRefresh: true,
  refreshInterval: 3,
  selInterval: 1,
  smooth: true,
  predictMotion: true,
  fps: 60,
  followSelected: true,
  showLabels: true,
  showOffline: true,
  showZones: false,
  showDynamicZones: true,
  dynZoneRadius: 60,
  darkMode: false,
  autoConnect: false,
  uiScale: 1,
  favorites: [],
  customZones: [],
  mapTypeFilter: { belaz: true, excavator: true, bulldozer: true, grader: true, fuel: true, other: true }
};

let sessionCookies = "";
let cachedSession = null;

/**
 * Загружает сохранённые настройки с iPhone
 */
function loadSettings() {
  try {
    if (fm.fileExists(SETTINGS_PATH)) {
      const raw = fm.readString(SETTINGS_PATH);
      const parsed = JSON.parse(raw);
      return Object.assign({}, DEFAULT_SETTINGS, parsed);
    }
  } catch (e) {}
  return Object.assign({}, DEFAULT_SETTINGS);
}

/**
 * Сохраняет настройки на iPhone
 */
function saveSettings(cfg) {
  try {
    fm.writeString(SETTINGS_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {}
}

// ============================================================================
// 2. СЕТЕВОЙ СЛОЙ (ПРЯМЫЕ ЗАПРОСЫ С IPHONE, WSDL И SOAP)
// ============================================================================
function escapeXml(str) {
  return String(str === null || str === undefined ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unescapeXml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Нативный HTTP-запрос Scriptable (без ограничений CORS)
 */
async function nativeHttp(url, method = "GET", headers = {}, body = null) {
  const req = new Request(url);
  req.method = method;
  req.timeoutInterval = 25;
  const finalHeaders = Object.assign({}, headers);
  if (sessionCookies) {
    finalHeaders["Cookie"] = sessionCookies;
  }
  req.headers = finalHeaders;
  if (body !== null) {
    req.body = body;
  }

  const text = await req.loadString();
  const resp = req.response || {};
  const status = resp.statusCode || 200;

  if (resp.headers) {
    const setCookieKey = Object.keys(resp.headers).find(k => k.toLowerCase() === "set-cookie");
    if (setCookieKey && resp.headers[setCookieKey]) {
      const cookieVal = String(resp.headers[setCookieKey]).split(";")[0].trim();
      if (cookieVal) sessionCookies = cookieVal;
    }
  }

  return { status, text: text || "", headers: resp.headers || {} };
}

/**
 * Отправка SOAP 1.1 запроса на ASMX-сервер
 */
async function callSoap(serverUrl, namespace, methodName, paramsObj) {
  const nsClean = namespace.endsWith("/") ? namespace : namespace + "/";
  const paramsXml = Object.entries(paramsObj || {})
    .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`)
    .join("");

  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:xsd="http://www.w3.org/2001/XMLSchema"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <${methodName} xmlns="${namespace}">
      ${paramsXml}
    </${methodName}>
  </soap:Body>
</soap:Envelope>`;

  return await nativeHttp(
    serverUrl,
    "POST",
    {
      "Content-Type": "text/xml; charset=utf-8",
      "SOAPAction": `"${nsClean}${methodName}"`
    },
    envelope
  );
}

/**
 * Разбор WSDL-описания ASMX-сервиса: targetNamespace, методы и их параметры
 */
function parseWsdl(xml) {
  const nsMatch = xml.match(/targetNamespace\s*=\s*["']([^"']+)["']/i);
  const namespace = nsMatch ? nsMatch[1] : "http://tempuri.org/";

  const opNames = new Set();
  const opRegex = /<(?:[a-z0-9]+:)?operation\b[^>]*\bname\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = opRegex.exec(xml)) !== null) {
    opNames.add(m[1]);
  }

  const methods = [];

  for (const opName of opNames) {
    const params = [];
    const safeOp = opName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const startRegex = new RegExp(
      `<(?:[a-z0-9]+:)?element\\b[^>]*\\bname\\s*=\\s*["']${safeOp}["'][^>]*>`,
      "ig"
    );
    let sm;
    while ((sm = startRegex.exec(xml)) !== null) {
      if (sm[0].endsWith("/>")) continue;

      const contentStart = sm.index + sm[0].length;
      const tagScanner = /<(\/?)(?:[a-z0-9]+:)?element\b([^>]*)>/gi;
      tagScanner.lastIndex = contentStart;
      let depth = 1;
      let contentEnd = -1;
      let tm;
      while ((tm = tagScanner.exec(xml)) !== null) {
        const isClosing = tm[1] === "/";
        const isSelfClosing = tm[2].trim().endsWith("/");
        if (isClosing) {
          depth--;
          if (depth === 0) {
            contentEnd = tm.index;
            break;
          }
        } else if (!isSelfClosing) {
          depth++;
        }
      }

      if (contentEnd > contentStart) {
        const inner = xml.slice(contentStart, contentEnd);
        const paramRegex = /<(?:[a-z0-9]+:)?element\b([^>]*)\/?>/gi;
        let pm;
        while ((pm = paramRegex.exec(inner)) !== null) {
          const attrs = pm[1];
          const nameM = attrs.match(/\bname\s*=\s*["']([^"']+)["']/i);
          const typeM = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
          if (nameM && !params.some(p => p.name === nameM[1])) {
            params.push({ name: nameM[1], type: typeM ? typeM[1] : "string" });
          }
        }
        if (params.length > 0) break;
      }
    }

    if (params.length === 0) {
      const msgRegex = new RegExp(
        `<(?:[a-z0-9]+:)?message\\b[^>]*\\bname\\s*=\\s*["']${safeOp}(?:SoapIn|HttpPostIn|HttpGetIn)["'][^>]*>([\\s\\S]*?)<\\/(?:[a-z0-9]+:)?message>`,
        "i"
      );
      const msgMatch = xml.match(msgRegex);
      if (msgMatch) {
        const partRegex = /<(?:[a-z0-9]+:)?part\b([^>]*)\/?>/gi;
        let ptm;
        while ((ptm = partRegex.exec(msgMatch[1])) !== null) {
          const attrs = ptm[1];
          const nameM = attrs.match(/\bname\s*=\s*["']([^"']+)["']/i);
          const typeM = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
          if (nameM && nameM[1].toLowerCase() !== "parameters") {
            params.push({ name: nameM[1], type: typeM ? typeM[1] : "string" });
          }
        }
      }
    }

    methods.push({ name: opName, params });
  }

  return { namespace, methods };
}

/**
 * Автоматически подставляет значения параметров SOAP-метода на основе их имён и типов
 */
function buildParamsForMethod(paramDefs, ctx) {
  const result = {};
  if (!Array.isArray(paramDefs)) return result;

  for (const p of paramDefs) {
    const n = (p.name || "").toLowerCase();
    const t = (p.type || "").toLowerCase();

    if (/psw|pass|pwd/.test(n)) {
      result[p.name] = ctx.password || "";
    } else if (/login|user|uname/.test(n)) {
      result[p.name] = ctx.login || "";
    } else if (/token|session|sid|guid|key/.test(n)) {
      result[p.name] = ctx.token || "";
    } else if (/group/.test(n)) {
      if (/int|long|short|byte|dec|num/.test(t)) {
        result[p.name] = (ctx.groupId !== undefined && ctx.groupId !== "" && /^-?\d+$/.test(String(ctx.groupId)))
          ? String(ctx.groupId)
          : "0";
      } else {
        result[p.name] = ctx.groupId !== undefined ? String(ctx.groupId) : "";
      }
    } else if (/obj|unit|car|veh|device|ts|tc|^id$|^pid$|objectid|imei/.test(n) && ctx.objectId !== undefined && ctx.objectId !== "") {
      result[p.name] = String(ctx.objectId);
    } else if (/from|start|begin|beg|dt1|date1|d1/.test(n) && ctx.fromDate) {
      result[p.name] = ctx.fromDate;
    } else if (/to|end|finish|dt2|date2|d2/.test(n) && ctx.toDate) {
      result[p.name] = ctx.toDate;
    } else if (/date|time|dt/.test(n) && ctx.fromDate) {
      result[p.name] = ctx.fromDate;
    } else if (/bool/.test(t)) {
      result[p.name] = "false";
    } else if (/int|long|short|byte|decimal|double|float/.test(t)) {
      result[p.name] = "0";
    } else {
      result[p.name] = "";
    }
  }
  return result;
}

/**
 * Полноценный линейный XML-парсер (строит дерево узлов без потери вложенности)
 */
function parseXmlTree(xmlString, depth = 0) {
  const root = { tag: "root", attrs: {}, text: "", children: [] };
  if (!xmlString || depth > 3) return root;

  const cleaned = String(xmlString)
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner) => escapeXml(inner));

  const stack = [root];
  const tagRegex = /<(\/?)([A-Za-z0-9_:-]+)([^>]*?)(\/?)>/g;
  let lastIndex = 0;
  let match;

  while ((match = tagRegex.exec(cleaned)) !== null) {
    if (match.index > lastIndex) {
      const txt = cleaned.slice(lastIndex, match.index);
      if (txt.trim()) {
        stack[stack.length - 1].text += unescapeXml(txt);
      }
    }
    lastIndex = tagRegex.lastIndex;

    const isClose = match[1] === "/";
    const fullTag = match[2];
    const attrStr = match[3] || "";
    const isSelfClose = match[4] === "/" || attrStr.trim().endsWith("/");
    const localTag = fullTag.includes(":") ? fullTag.split(":").pop() : fullTag;

    if (isClose) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === localTag) {
          stack.length = i;
          break;
        }
      }
    } else {
      const attrs = {};
      if (attrStr.includes("=")) {
        const attrRe = /([A-Za-z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
        let am;
        while ((am = attrRe.exec(attrStr)) !== null) {
          const aName = am[1].includes(":") ? am[1].split(":").pop() : am[1];
          attrs[aName] = unescapeXml(am[2] !== undefined ? am[2] : (am[3] || ""));
        }
      }
      const node = { tag: localTag, attrs, text: "", children: [] };
      stack[stack.length - 1].children.push(node);
      if (!isSelfClose) {
        stack.push(node);
      }
    }
  }

  const walkAndExpand = (node) => {
    if (node.children.length === 0 && node.text) {
      const t = node.text.trim();
      if (t.startsWith("<") && t.endsWith(">") && t.length > 5) {
        const sub = parseXmlTree(t, depth + 1);
        if (sub.children.length > 0) {
          node.children = sub.children;
          node.text = "";
        }
      }
    }
    for (const ch of node.children) {
      walkAndExpand(ch);
    }
  };
  walkAndExpand(root);

  return root;
}

/**
 * Собирает плоский словарь полей узла (атрибуты + дочерние листовые теги)
 */
function collectNodeFields(node) {
  const fields = {};
  if (node.attrs) {
    for (const [k, v] of Object.entries(node.attrs)) {
      if (v !== "" && !/^xmlns$/i.test(k)) fields[k] = v.trim();
    }
  }
  for (const ch of node.children) {
    if (ch.children.length === 0 && ch.text.trim() !== "") {
      fields[ch.tag] = ch.text.trim();
    } else if (ch.children.length > 0 && ch.children.length <= 10) {
      let hasOnlyLeaves = true;
      for (const sub of ch.children) {
        if (sub.children.length > 0) {
          hasOnlyLeaves = false;
          break;
        }
      }
      if (hasOnlyLeaves) {
        for (const sub of ch.children) {
          if (sub.text.trim() !== "" && !(sub.tag in fields)) {
            fields[sub.tag] = sub.text.trim();
          }
        }
      }
    }
  }
  return fields;
}

function walkXmlNodes(node, visitor) {
  visitor(node);
  for (const ch of node.children) {
    walkXmlNodes(ch, visitor);
  }
}

function findLatLngInFields(fields) {
  const keys = Object.keys(fields);
  const findBy = (re) => {
    const k = keys.find(key => re.test(key));
    return k ? fields[k] : "";
  };

  let latStr = findBy(/^(lat|latitude|y|lt|la|coordy|poslat|lastlat|gpslat|plat|shirota)$/i);
  if (!latStr) {
    const k = keys.find(key =>
      /(?:^|_)lat(?:itude)?(?:$|_|\d)|lat(?:itude)?$/i.test(key) &&
      !/plate|relat|late|isolat|translat|accumulat|calculat|interpolat|ventilat|simulat|flat/i.test(key)
    );
    if (k) latStr = fields[k];
  }

  let lngStr = findBy(/^(lon|lng|long|longitude|x|ln|lo|coordx|poslon|lastlon|gpslon|plon|dolgota)$/i);
  if (!lngStr) {
    const k = keys.find(key =>
      /(?:^|_)(?:lon|lng|long(?:itude)?)(?:$|_|\d)|(?:lon|lng|longitude)$/i.test(key) &&
      !/belong|along|clone|salon|colon|prolong|oblong/i.test(key)
    );
    if (k) lngStr = fields[k];
  }

  return { latStr, lngStr };
}

function extractJsonCandidates(rawText) {
  const results = [];
  const tryParse = (str) => {
    if (!str) return;
    const t = str.trim();
    if ((t.startsWith("[") && t.endsWith("]")) || (t.startsWith("{") && t.endsWith("}"))) {
      try {
        results.push(JSON.parse(t));
      } catch (e) {}
    }
  };

  const resTagRe = /<[A-Za-z0-9_:-]*Result[^>]*>([\s\S]*?)<\/[A-Za-z0-9_:-]*Result>/gi;
  let m;
  while ((m = resTagRe.exec(rawText)) !== null) {
    let inner = unescapeXml(m[1]).trim();
    if (inner.includes("&lt;") || inner.includes("&quot;")) inner = unescapeXml(inner).trim();
    tryParse(inner);
  }

  if (results.length === 0) {
    tryParse(unescapeXml(rawText));
  }

  const flatItems = [];
  const walkJson = (val) => {
    if (!val || typeof val !== "object") return;
    if (Array.isArray(val)) {
      for (const el of val) walkJson(el);
      return;
    }
    flatItems.push(val);
    for (const v of Object.values(val)) {
      if (v && typeof v === "object") walkJson(v);
    }
  };
  for (const r of results) walkJson(r);
  return flatItems;
}

/**
 * Извлекает список объектов мониторинга из XML или JSON ответа сервера
 */
function extractVehicles(rawText) {
  const vehicles = [];

  try {
    const jsonItems = extractJsonCandidates(rawText);
    jsonItems.forEach((item, idx) => {
      const flat = {};
      Object.entries(item).forEach(([k, v]) => {
        if (v !== null && v !== undefined && typeof v !== "object") flat[k] = String(v).trim();
      });
      if (Object.keys(flat).length < 2) return;

      const { latStr, lngStr } = findLatLngInFields(flat);
      const lat = parseCoord(latStr);
      const lng = parseCoord(lngStr);
      if (!isValidLatLng(lat, lng)) return;

      const keys = Object.keys(flat);
      const findVal = (re) => {
        const k = keys.find(key => re.test(key));
        return k ? flat[k] : "";
      };

      const speed = parseCoord(findVal(/^(speed|spd|velocity|lastspeed|v|s)$/i)) || 0;
      const courseRaw = findVal(/^(course|azimuth|heading|dir|direction|angle|crs)$/i);
      const courseVal = courseRaw !== "" ? parseCoord(courseRaw) : NaN;
      const onlineRaw = findVal(/^(online|isonline|connected|isconnected|link|haslink|valid|isvalid|active|isactive)$/i);
      const online = !(onlineRaw !== "" && /^(false|0|no|off|нет)$/i.test(onlineRaw));
      const duration = speed > 2 ? `${Math.round(speed)} км/ч` : (online ? "Стоянка" : "Нет связи");
      const engineOff = parseEngineOffFromFields(flat, speed, duration);

      vehicles.push({
        id: findVal(/^(id|obj|guid|uid|objectid|objid|unitid|carid|deviceid|code|imei|oid|pid|tsid|tcid)$/i) || String(idx),
        name: findVal(/^(name|objectname|objname|title|regnumber|gosnum|gosnumber|caption|vehiclename|carname|number|label|nm|garnum)$/i) || `Объект #${idx + 1}`,
        address: findVal(/^(address|addr|location|place|geoaddr|lastaddress)$/i) || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
        lat,
        lng,
        speed,
        course: !isNaN(courseVal) ? courseVal : null,
        online,
        active: online && speed > 2,
        engineOff,
        lastTime: findVal(/^(time|lasttime|datetime|msgtime|gpstime|date|lastdate|eventtime|navtime|dt|timestamp|lastmsgtime|loctime)$/i) || new Date().toLocaleTimeString("ru-RU"),
        duration,
        fuel: "",
        rawFields: flat
      });
    });
    if (vehicles.length > 0) return deduplicateVehicles(vehicles);
  } catch (e) {}

  const tree = parseXmlTree(rawText);
  let idx = 0;

  walkXmlNodes(tree, (node) => {
    if (node.tag === "root" || /Response$|Result$|Envelope$|Body$/i.test(node.tag)) return;
    const rawFields = collectNodeFields(node);
    const keys = Object.keys(rawFields);
    if (keys.length < 2) return;

    const { latStr, lngStr } = findLatLngInFields(rawFields);
    if (!latStr || !lngStr) return;

    const lat = parseCoord(latStr);
    const lng = parseCoord(lngStr);
    if (!isValidLatLng(lat, lng)) return;

    const findVal = (re) => {
      const k = keys.find(key => re.test(key));
      return k ? rawFields[k] : "";
    };

    const idVal = findVal(/^(id|obj|guid|uid|objectid|objid|unitid|carid|deviceid|code|imei|oid|pid|tsid|tcid)$/i) || String(idx);
    const nameVal = findVal(/^(name|objectname|objname|title|regnumber|gosnum|gosnumber|caption|vehiclename|carname|number|label|nm|garnum)$/i) || `Объект #${idx + 1}`;
    const addrVal = findVal(/^(address|addr|location|place|geoaddr|lastaddress)$/i) || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    const speedVal = parseCoord(findVal(/^(speed|spd|velocity|lastspeed|v|s)$/i)) || 0;
    const courseRaw = findVal(/^(course|azimuth|heading|dir|direction|angle|crs)$/i);
    const courseVal = courseRaw !== "" ? parseCoord(courseRaw) : NaN;
    const timeVal = findVal(/^(time|lasttime|datetime|msgtime|gpstime|date|lastdate|eventtime|navtime|dt|timestamp|lastmsgtime|loctime)$/i) || new Date().toLocaleTimeString("ru-RU");
    const durVal = findVal(/^(duration|statetime|stoptime|status|state)$/i);
    const onlineRaw = findVal(/^(online|isonline|connected|isconnected|link|haslink|valid|isvalid|active|isactive)$/i);

    let online = true;
    if (onlineRaw !== "" && /^(false|0|no|off|нет)$/i.test(onlineRaw)) {
      online = false;
    }

    const active = online && speedVal > 2;
    const duration = durVal && !/^(true|false)$/i.test(durVal)
      ? durVal
      : (active ? `${Math.round(speedVal)} км/ч` : (online ? "Стоянка" : "Нет связи"));
    const engineOff = parseEngineOffFromFields(rawFields, speedVal, duration);

    vehicles.push({
      id: idVal,
      name: nameVal,
      address: addrVal,
      lat,
      lng,
      speed: speedVal,
      course: !isNaN(courseVal) ? courseVal : null,
      online,
      active,
      engineOff,
      lastTime: timeVal,
      duration,
      fuel: "",
      rawFields
    });
    idx++;
  });

  return deduplicateVehicles(vehicles);
}

/**
 * Определяет, заглушен ли двигатель по сырым полям объекта с сервера
 */
function parseEngineOffFromFields(rawFields, speed, duration) {
  if ((speed || 0) > 2) return false;
  if (duration && /заглуш|выкл|масс/i.test(String(duration))) return true;
  if (!rawFields || typeof rawFields !== "object") return null;
  for (const [k, val] of Object.entries(rawFields)) {
    const kl = k.toLowerCase();
    const sv = String(val || "").trim().toLowerCase();
    if (
      /^(ign|ignition|isign|isignition|engine|isengine|engineon|ignitionon|motor|zazh|zazhiganie|зажигание|двигатель|двс|mass|massa|масса|power|pwr|питание)$/.test(kl) ||
      /(?:^|_)(?:ign|ignition|engine|motor|зажиг|двиг|масс|питан)/.test(kl)
    ) {
      if (/^(0|false|no|off|выкл|нет|заглуш)/.test(sv)) return true;
      if (/^(1|true|yes|on|вкл|да|завед|работ)/.test(sv)) return false;
    }
    if (/^(volt|voltage|vbat|pwrvolt|akb|акб|напряжение|бортсеть)$/.test(kl) || /(?:volt|напряж|борт)/.test(kl)) {
      const num = parseFloat(sv.replace(",", "."));
      if (!isNaN(num) && num <= 10) return true;
    }
  }
  return null;
}

/**
 * Извлекает точки маршрута (трека) из ответа GetObjectHistoryMobile
 */
function findWeightInFields(fields) {
  const keys = Object.keys(fields);
  const k = keys.find(key => /^(weight|w|load|ves|massa|cargo|tonn|payload|вес|груз|масса)$/i.test(key)
    || (/(?:weight|ves|load|груз|масс)/i.test(key) && !/dyn|динам|max|min|norm|id|name/i.test(key)));
  if (!k) return null;
  const num = parseCoord(fields[k]);
  return isNaN(num) ? null : num;
}

function findTimeInFields(fields) {
  const keys = Object.keys(fields);
  const findBy = (re) => {
    const k = keys.find(key => re.test(key));
    return k ? fields[k] : "";
  };
  let t = findBy(/^(time|datetime|msgtime|gpstime|date|navtime|eventtime|dt|timestamp|loctime|t|tm|pttime|pointtime|tracktime|timeutc|timelocal|localtime|localdate|recdate|rectime|dtime)$/i);
  if (t) return t;
  const k2 = keys.find(key => /(?:time|date|^dt|tm)/i.test(key) && fields[key]);
  if (k2) return fields[k2];
  for (const val of Object.values(fields)) {
    const s = String(val || "").trim();
    if (/\d{1,2}:\d{2}(?::\d{2})?/.test(s) && s.length <= 32) return s;
  }
  return "";
}

function extractTrackPoints(rawText) {
  const points = [];

  try {
    const jsonItems = extractJsonCandidates(rawText);
    jsonItems.forEach(item => {
      const flat = {};
      Object.entries(item).forEach(([k, v]) => {
        if (v !== null && v !== undefined && typeof v !== "object") flat[k] = String(v).trim();
      });
      if (Object.keys(flat).length < 2) return;
      const { latStr, lngStr } = findLatLngInFields(flat);
      const lat = parseCoord(latStr);
      const lng = parseCoord(lngStr);
      if (isValidLatLng(lat, lng)) {
        const keys = Object.keys(flat);
        const findVal = (re) => {
          const k = keys.find(key => re.test(key));
          return k ? flat[k] : "";
        };
        points.push({
          lat,
          lng,
          speed: parseCoord(findVal(/^(speed|spd|velocity|v|s)$/i)) || 0,
          time: findTimeInFields(flat),
          weight: findWeightInFields(flat)
        });
      }
    });
    if (points.length > 0) return points;
  } catch (e) {}

  const tree = parseXmlTree(rawText);
  walkXmlNodes(tree, (node) => {
    if (node.tag === "root" || /Response$|Result$|Envelope$|Body$/i.test(node.tag)) return;
    const fields = collectNodeFields(node);
    const keys = Object.keys(fields);
    if (keys.length < 1) return;

    const findVal = (re) => {
      const k = keys.find(key => re.test(key));
      return k ? fields[k] : "";
    };

    let { latStr, lngStr } = findLatLngInFields(fields);
    if (!latStr || !lngStr) {
      latStr = latStr || findVal(/^(b|n)$/i);
      lngStr = lngStr || findVal(/^(l|e)$/i);
    }

    let lat = parseCoord(latStr);
    let lng = parseCoord(lngStr);

    if (!isValidLatLng(lat, lng)) {
      const pairStr = findVal(/^(pos|coord|coords|point|pt|ll|latlon)$/i);
      if (pairStr) {
        const parts = pairStr.split(/[,;\s]+/).filter(Boolean).map(parseCoord);
        if (parts.length >= 2) {
          lat = parts[0];
          lng = parts[1];
        }
      }
    }

    if (!isValidLatLng(lat, lng)) return;

    const spd = parseCoord(findVal(/^(speed|spd|velocity|v|s)$/i)) || 0;
    const time = findTimeInFields(fields);
    const weight = findWeightInFields(fields);

    points.push({ lat, lng, speed: spd, time, weight });
  });

  if (points.length > 0) return points;

  const clean = unescapeXml(rawText);
  const pairMatches = clean.match(/\b\d{2}[.,]\d{4,7}[,;\s]+\d{2,3}[.,]\d{4,7}\b/g);
  if (pairMatches && pairMatches.length >= 2) {
    for (const pair of pairMatches) {
      const parts = pair.split(/[,;\s]+/).map(parseCoord);
      if (parts.length >= 2 && isValidLatLng(parts[0], parts[1])) {
        points.push({ lat: parts[0], lng: parts[1], speed: 0, time: "" });
      }
    }
  }

  return points;
}

/**
 * Извлекает список датчиков из ответа GetSensorsMobile (XML-дерево и JSON)
 */
function extractSensors(rawText) {
  const sensors = [];
  const cleanText = unescapeXml(rawText);

  try {
    const jsonArrays = cleanText.match(/\[\s*\{[\s\S]*?\}\s*\]/g);
    if (jsonArrays) {
      for (const candidate of jsonArrays) {
        try {
          const arr = JSON.parse(candidate);
          if (Array.isArray(arr)) {
            arr.forEach(item => {
              const name = item.name ?? item.Name ?? item.SensorName ?? item.Title ?? item.Caption ?? item.DisplayName;
              const val = item.value ?? item.Value ?? item.Val ?? item.TextValue ?? item.CurValue ?? item.CurrentValue ?? item.State;
              const unit = item.unit ?? item.Unit ?? item.Units ?? item.Measure ?? "";
              if (name !== undefined && val !== undefined && String(val).trim() !== "") {
                sensors.push({
                  name: String(name).trim(),
                  value: String(val).trim() + (unit ? " " + String(unit).trim() : "")
                });
              }
            });
          }
        } catch (e) {}
      }
    }
  } catch (e) {}

  const tree = parseXmlTree(rawText);
  walkXmlNodes(tree, (node) => {
    if (node.tag === "root") return;
    const fields = collectNodeFields(node);
    const keys = Object.keys(fields);
    if (keys.length < 2) return;

    const findVal = (re) => {
      const k = keys.find(key => re.test(key));
      return k ? fields[k] : "";
    };

    const name = findVal(/^(name|sensorname|title|caption|typename|displayname|paramname|desc|description)$/i);
    const val = findVal(/^(value|val|textvalue|state|strvalue|curvalue|currentvalue|lastvalue|fuelvalue|numvalue|rawvalue)$/i);
    const unit = findVal(/^(unit|units|measure|dimension|eu)$/i);
    if (name && val) {
      sensors.push({
        name,
        value: val + (unit ? " " + unit : "")
      });
    }
  });

  const seen = new Set();
  return sensors.filter(s => {
    const key = `${s.name}_${s.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractFuelFromRawFields(rawFields) {
  if (!rawFields || typeof rawFields !== "object") return "";
  const matches = [];
  for (const [k, val] of Object.entries(rawFields)) {
    const keyLower = k.toLowerCase();
    if (
      /fuel|dut|fls|lls|tank|topliv|топлив|бак|дут/.test(keyLower) &&
      !/rate|norm|cons|расход|max|cap|min|sensor|id|type|name|flag|enable|use/i.test(keyLower)
    ) {
      const cleaned = String(val).trim();
      if (cleaned !== "" && !/^(null|undefined|false|true)$/i.test(cleaned)) {
        const num = parseFloat(cleaned.replace(",", "."));
        const formatted = !isNaN(num) && !/[a-zа-я%]/i.test(cleaned) ? `${cleaned} л` : cleaned;
        matches.push(formatted);
      }
    }
  }
  return matches.join(" / ");
}

function extractZones(rawText) {
  const zones = [];
  const tree = parseXmlTree(rawText);

  walkXmlNodes(tree, (node) => {
    if (node.tag === "root" || /Response$|Result$|Envelope$|Body$/i.test(node.tag)) return;
    const fields = collectNodeFields(node);
    const keys = Object.keys(fields);

    const findVal = (re) => {
      const k = keys.find(key => re.test(key));
      return k ? fields[k] : "";
    };

    const name = findVal(/^(name|zonename|title|caption)$/i) || `Геозона #${zones.length + 1}`;
    const rawColor = findVal(/^(color|fillcolor|linecolor)$/i);
    let color = "#2563eb";
    if (/^#[0-9a-f]{3,8}$/i.test(rawColor)) color = rawColor;
    else if (/^[0-9a-f]{6}$/i.test(rawColor)) color = "#" + rawColor;

    const coordsStr = findVal(/^(points|coords|coordinates|geometry|polygon|path|wkt|vertexes|vertices)$/i);
    if (coordsStr) {
      const pairs = coordsStr.match(/-?\d+[.,]\d+[\s,]+-?\d+[.,]\d+/g) || [];
      const polyPts = [];
      for (const pair of pairs) {
        const nums = pair.split(/[\s,]+/).filter(Boolean).map(parseCoord);
        if (nums.length >= 2) {
          if (isValidLatLng(nums[0], nums[1])) polyPts.push([nums[0], nums[1]]);
          else if (isValidLatLng(nums[1], nums[0])) polyPts.push([nums[1], nums[0]]);
        }
      }
      if (polyPts.length >= 3) {
        zones.push({ type: "polygon", name, color, points: polyPts });
        return;
      }
    }

    const subPoints = [];
    walkXmlNodes(node, (sub) => {
      if (sub === node) return;
      const sf = collectNodeFields(sub);
      const sk = Object.keys(sf);
      const laK = sk.find(k => /^(lat|latitude|y)$/i.test(k));
      const loK = sk.find(k => /^(lon|lng|longitude|x)$/i.test(k));
      if (laK && loK) {
        const la = parseCoord(sf[laK]);
        const lo = parseCoord(sf[loK]);
        if (isValidLatLng(la, lo)) subPoints.push([la, lo]);
      }
    });
    if (subPoints.length >= 3 && node.children.length <= 20) {
      zones.push({ type: "polygon", name, color, points: subPoints });
      return;
    }

    const radStr = findVal(/^(radius|rad|r)$/i);
    const latStr = findVal(/^(lat|latitude|y|centerlat)$/i);
    const lngStr = findVal(/^(lon|lng|longitude|x|centerlon)$/i);
    if (radStr && latStr && lngStr) {
      const la = parseCoord(latStr);
      const lo = parseCoord(lngStr);
      const r = parseCoord(radStr);
      if (isValidLatLng(la, lo) && !isNaN(r) && r > 0) {
        zones.push({ type: "circle", name, color, lat: la, lng: lo, radius: r });
      }
    }
  });

  const seen = new Set();
  return zones.filter(z => {
    const key = z.type === "circle"
      ? `c_${z.name}_${z.lat.toFixed(4)}_${z.lng.toFixed(4)}`
      : `p_${z.name}_${z.points.length}_${z.points[0][0].toFixed(4)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseCoord(val) {
  if (val === null || val === undefined) return NaN;
  return parseFloat(String(val).trim().replace(",", "."));
}

function isValidLatLng(lat, lng) {
  return !isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && (lat !== 0 || lng !== 0);
}

function deduplicateVehicles(arr) {
  const seen = new Set();
  return arr.filter(v => {
    const key = `${v.id}_${v.lat.toFixed(5)}_${v.lng.toFixed(5)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (!v.fuel) {
      v.fuel = extractFuelFromRawFields(v.rawFields);
    }
    return true;
  });
}

/**
 * Полный цикл подключения: WSDL -> Авторизация -> Загрузка объектов
 */
async function performConnect(serverUrl, login, password) {
  const logs = [];
  const log = (msg) => {
    const t = new Date().toLocaleTimeString("ru-RU");
    logs.push(`[${t}] ${msg}`);
  };

  const currentCfg = loadSettings();
  saveSettings(Object.assign({}, currentCfg, { server: serverUrl, login, password }));
  sessionCookies = "";
  cachedSession = null;

  try {
    log(`Подключение к ${serverUrl}`);

    const wsdlRes = await nativeHttp(`${serverUrl}?WSDL`, "GET", {
      "Accept": "text/xml, application/xml, */*"
    });

    if (wsdlRes.status >= 400 || !wsdlRes.text) {
      throw new Error(`WSDL недоступен (HTTP ${wsdlRes.status})`);
    }

    const wsdl = parseWsdl(wsdlRes.text);
    log(`Namespace: ${wsdl.namespace}`);
    log(`Методов в WSDL (${wsdl.methods.length}): ${wsdl.methods.map(m => `${m.name}(${m.params.map(p => p.name).join(",")})`).join("; ")}`);

    const ctx = { login, password, token: "", groupId: "" };

    const groupsMethod = wsdl.methods.find(m => /getusergroups/i.test(m.name));
    if (groupsMethod) {
      const gParams = buildParamsForMethod(groupsMethod.params, ctx);
      log(`Запрос групп: ${groupsMethod.name}(${Object.keys(gParams).join(", ")})`);
      try {
        const gRes = await callSoap(serverUrl, wsdl.namespace, groupsMethod.name, gParams);
        const gClean = unescapeXml(gRes.text);
        log(`Ответ ${groupsMethod.name} [HTTP ${gRes.status}]: ${gClean.slice(0, 350)}`);
        const gidMatch = gClean.match(/<(?:[a-z0-9]+:)?(?:Id|ID|GroupId|GroupID|Code)>([^<]+)<\//i);
        if (gidMatch) {
          ctx.groupId = gidMatch[1].trim();
          log(`Найдена группа ID: ${ctx.groupId}`);
        }
      } catch (e) {
        log(`Ошибка ${groupsMethod.name}: ${e.message}`);
      }
    }

    const loginMethods = wsdl.methods.filter(m => /login|auth|logon|signin|connect|checkuser/i.test(m.name));
    for (const lm of loginMethods) {
      const params = buildParamsForMethod(lm.params, ctx);
      log(`Вызов авторизации: ${lm.name}(${Object.keys(params).join(", ")})`);
      const res = await callSoap(serverUrl, wsdl.namespace, lm.name, params);
      log(`Ответ ${lm.name} [HTTP ${res.status}]: ${res.text.slice(0, 300)}`);

      const guidMatch = res.text.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
      if (guidMatch) {
        ctx.token = guidMatch[0];
        log(`Получен токен сессии: ${ctx.token}`);
      } else {
        const resultTag = res.text.match(/<[A-Za-z0-9_]+Result>([^<]{4,128})<\/[A-Za-z0-9_]+Result>/i);
        if (resultTag && !/true|false|error|fail/i.test(resultTag[1])) {
          ctx.token = resultTag[1].trim();
          log(`Получен ключ ответа: ${ctx.token}`);
        }
      }

      const directVehicles = extractVehicles(res.text);
      if (directVehicles.length > 0) {
        cachedSession = { serverUrl, namespace: wsdl.namespace, wsdl, ctx, methodName: lm.name, paramsObj: params };
        log(`Загружено объектов напрямую: ${directVehicles.length}`);
        return { ok: true, vehicles: directVehicles, logs };
      }
    }

    const dataMethods = wsdl.methods
      .filter(m =>
        /object|unit|vehicle|car|state|pos|coord|last|data|list|monitor|info|current|device|ts|tc/i.test(m.name) &&
        !/history|track|route|report|sensor|zone|photo|image|version|ping|logout|group/i.test(m.name)
      )
      .sort((a, b) => (/getobjectslistmobile/i.test(b.name) ? 1 : 0) - (/getobjectslistmobile/i.test(a.name) ? 1 : 0));

    const candidates = dataMethods.length > 0
      ? dataMethods
      : wsdl.methods.filter(m => !loginMethods.includes(m) && m !== groupsMethod && m.params.length <= 5);

    for (const dm of candidates) {
      const hasGroupParam = dm.params.some(p => /group/i.test(p.name));
      const groupVariants = hasGroupParam
        ? Array.from(new Set([ctx.groupId, "0", "-1", ""].filter(v => v !== undefined)))
        : [ctx.groupId];

      const dtParam = dm.params.find(p => /fromdt|fromdate|date|dt/i.test(p.name));
      const dtVariants = dtParam
        ? [null, "01.01.2000 00:00:00", "2000-01-01T00:00:00", "2000-01-01 00:00:00", "0", ""]
        : [undefined];

      for (const gv of groupVariants) {
        for (const dtVal of dtVariants) {
          const tryCtx = Object.assign({}, ctx, { groupId: gv });
          const params = buildParamsForMethod(dm.params, tryCtx);
          if (dtParam) {
            if (dtVal === null) {
              delete params[dtParam.name];
            } else {
              params[dtParam.name] = dtVal;
            }
          }

          log(`Запрос данных: ${dm.name}(${Object.entries(params).map(([k, v]) => `${k}=${/psw|pass|pwd/i.test(k) ? "***" : v}`).join(", ")})`);
          try {
            const res = await callSoap(serverUrl, wsdl.namespace, dm.name, params);
            const cleanBody = unescapeXml(res.text);
            log(`Ответ ${dm.name} [HTTP ${res.status}, ${res.text.length} байт]: ${cleanBody.slice(0, 500)}`);

            const found = extractVehicles(res.text);
            if (found.length > 0) {
              cachedSession = { serverUrl, namespace: wsdl.namespace, wsdl, ctx: tryCtx, methodName: dm.name, paramsObj: params };
              log(`Успешно распознано объектов: ${found.length}`);
              return { ok: true, vehicles: found, logs };
            }
          } catch (e) {
            log(`Ошибка метода ${dm.name}: ${e.message}`);
          }
        }
      }
    }

    return {
      ok: false,
      error: "Сервер ответил, но координаты объектов не распознаны автоматически. Скопируйте лог для диагностики.",
      logs
    };
  } catch (err) {
    log(`ОШИБКА: ${err.message}`);
    return {
      ok: false,
      error: err.message,
      logs
    };
  }
}

/**
 * Быстрое фоновое обновление данных (без повторного чтения WSDL)
 */
async function performFastRefresh() {
  if (!cachedSession) {
    const cfg = loadSettings();
    return await performConnect(cfg.server, cfg.login, cfg.password);
  }
  try {
    const t0 = Date.now();
    const res = await callSoap(
      cachedSession.serverUrl,
      cachedSession.namespace,
      cachedSession.methodName,
      cachedSession.paramsObj
    );
    const t1 = Date.now();
    const found = extractVehicles(res.text);
    const t2 = Date.now();
    if (found.length > 0) {
      return { ok: true, vehicles: found, netMs: t1 - t0, parseMs: t2 - t1, bytes: (res.text || "").length };
    }
    return { ok: false, error: "Пустой ответ при обновлении" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function formatDateVariants(isoLocal) {
  const pad = n => String(n).padStart(2, "0");
  const norm = isoLocal && isoLocal.length === 16 ? isoLocal + ":00" : isoLocal;
  const m = (norm || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) {
    return {
      ruLocal: isoLocal,
      isoLocal: norm,
      spaceLocal: norm,
      ruUtc: isoLocal,
      isoUtc: norm,
      compactLocal: isoLocal
    };
  }

  const yr = Number(m[1]), mo = Number(m[2]), dy = Number(m[3]);
  const hr = Number(m[4]), mi = Number(m[5]), sc = Number(m[6]);
  const d = new Date(yr, mo - 1, dy, hr, mi, sc);

  const uYr = d.getUTCFullYear();
  const uMo = pad(d.getUTCMonth() + 1);
  const uDy = pad(d.getUTCDate());
  const uHr = pad(d.getUTCHours());
  const uMi = pad(d.getUTCMinutes());
  const uSc = pad(d.getUTCSeconds());
  const unixSec = String(Math.floor(d.getTime() / 1000));

  return {
    ruLocal: `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}:${m[6]}`,
    isoLocal: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`,
    spaceLocal: `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`,
    ruUtc: `${uDy}.${uMo}.${uYr} ${uHr}:${uMi}:${uSc}`,
    isoUtc: `${uYr}-${uMo}-${uDy}T${uHr}:${uMi}:${uSc}`,
    spaceUtc: `${uYr}-${uMo}-${uDy} ${uHr}:${uMi}:${uSc}`,
    compactLocal: `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}${m[6]}`,
    unixSec
  };
}

/**
 * Загрузка маршрута (истории) объекта за выбранный период через GetObjectHistoryMobile
 */
async function performGetHistory(objectId, fromIso, toIso, altIdsRaw) {
  if (!cachedSession || !cachedSession.wsdl) {
    return { ok: false, error: "Сначала подключитесь к серверу" };
  }
  const histMethod = cachedSession.wsdl.methods.find(m => /history|track|route/i.test(m.name));
  if (!histMethod) {
    return { ok: false, error: "Метод истории маршрута не найден в WSDL" };
  }

  const f = formatDateVariants(fromIso);
  const t = formatDateVariants(toIso);

  const dateAttempts = [
    { label: "RU-Local", from: f.ruLocal, to: t.ruLocal },
    { label: "RU-UTC", from: f.ruUtc, to: t.ruUtc },
    { label: "ISO-Local", from: f.isoLocal, to: t.isoLocal },
    { label: "ISO-UTC", from: f.isoUtc, to: t.isoUtc },
    { label: "Space-Local", from: f.spaceLocal, to: t.spaceLocal },
    { label: "Space-UTC", from: f.spaceUtc, to: t.spaceUtc },
    { label: "UnixSec", from: f.unixSec, to: t.unixSec }
  ];

  const idCandidates = [objectId];
  if (altIdsRaw) {
    altIdsRaw.split("|").map(s => s.trim()).filter(Boolean).forEach(cid => {
      if (!idCandidates.includes(cid) && idCandidates.length < 3) {
        idCandidates.push(cid);
      }
    });
  }

  const debugLines = [];

  for (const candId of idCandidates) {
    for (const attempt of dateAttempts) {
      const histCtx = Object.assign({}, cachedSession.ctx, {
        objectId: candId,
        fromDate: attempt.from,
        toDate: attempt.to
      });

      const params = buildParamsForMethod(histMethod.params, histCtx);
      const dateParams = histMethod.params.filter(
        p => /date|time|from|to|start|end|begin|finish|dt/i.test(p.name) || /datetime/i.test(p.type || "")
      );
      if (dateParams.length >= 2) {
        params[dateParams[0].name] = attempt.from;
        params[dateParams[1].name] = attempt.to;
      }

      try {
        const res = await callSoap(cachedSession.serverUrl, cachedSession.namespace, histMethod.name, params);
        const points = extractTrackPoints(res.text);
        if (points.length > 0) {
          return { ok: true, points, method: histMethod.name, format: attempt.label };
        }
        const safeParams = Object.assign({}, params);
        Object.keys(safeParams).forEach(k => { if (/psw|pass|pwd/i.test(k)) safeParams[k] = "***"; });
        const snippet = unescapeXml(res.text).slice(0, 450);
        debugLines.push(`[${attempt.label}] ${histMethod.name}(${JSON.stringify(safeParams)}) -> HTTP ${res.status} (${res.text.length}б): ${snippet}`);
      } catch (err) {
        debugLines.push(`[${attempt.label}] Ошибка: ${err.message}`);
      }
    }
  }

  return {
    ok: false,
    error: "За выбранный период точек маршрута не найдено.",
    debug: debugLines.slice(0, 2).join("\n")
  };
}

/**
 * Загрузка дополнительных датчиков объекта через GetSensorsMobile
 */
async function performGetSensors(objectId) {
  if (!cachedSession || !cachedSession.wsdl) {
    return { ok: false, objectId, sensors: [] };
  }
  const sensMethod = cachedSession.wsdl.methods.find(m => /sensor/i.test(m.name));
  if (!sensMethod) {
    return { ok: false, objectId, sensors: [] };
  }
  const sensCtx = Object.assign({}, cachedSession.ctx, { objectId });
  const params = buildParamsForMethod(sensMethod.params, sensCtx);
  try {
    const res = await callSoap(cachedSession.serverUrl, cachedSession.namespace, sensMethod.name, params);
    const sensors = extractSensors(res.text);
    return { ok: true, objectId, sensors };
  } catch (e) {
    return { ok: false, objectId, sensors: [] };
  }
}

/**
 * Загрузка геозон с сервера через GetZonesMobile
 */
async function performGetZones() {
  if (!cachedSession || !cachedSession.wsdl) {
    return { ok: false, error: "Сначала подключитесь к серверу", zones: [] };
  }
  const zoneMethod = cachedSession.wsdl.methods.find(m => /zone|geofence/i.test(m.name));
  if (!zoneMethod) {
    return { ok: false, error: "Метод геозон не найден в WSDL", zones: [] };
  }
  const params = buildParamsForMethod(zoneMethod.params, cachedSession.ctx);
  try {
    const res = await callSoap(cachedSession.serverUrl, cachedSession.namespace, zoneMethod.name, params);
    const zones = extractZones(res.text);
    return {
      ok: true,
      zones,
      debug: `${zoneMethod.name} -> HTTP ${res.status}, найдено зон: ${zones.length}`
    };
  } catch (err) {
    return { ok: false, error: "Ошибка загрузки геозон: " + err.message, zones: [] };
  }
}

/**
 * Получение текущего местоположения iPhone через нативный GPS Scriptable
 */
async function performGetMyLocation() {
  try {
    Location.setAccuracyToBest();
    const loc = await Location.current();
    if (loc && typeof loc.latitude === "number" && typeof loc.longitude === "number") {
      return { ok: true, lat: loc.latitude, lng: loc.longitude };
    }
    return { ok: false, error: "Не удалось определить координаты GPS" };
  } catch (err) {
    return { ok: false, error: "Нет доступа к геолокации iPhone. Разрешите доступ для Scriptable в Настройках." };
  }
}

/**
 * Экспорт текущего скрипта в .js файл для отправки другу (с очисткой логина и пароля)
 */
async function performShareApp() {
  return { ok: false, error: "Отправка скрипта недоступна в Android-версии" };
}

// ============================================================================
// 3. ГЕНЕРАЦИЯ HTML-ИНТЕРФЕЙСА (КАРТА, СПИСОК, НАСТРОЙКИ)
// ============================================================================
function buildAppHtml(settings, assets) {
  assets = assets || {};
  const inlineJs = (t) => String(t).replace(/<\/script/gi, "<\\/script");
  const tailwindTag = assets.tailwind
    ? "<script>" + inlineJs(assets.tailwind) + "</script>"
    : '<script src="https://cdn.tailwindcss.com"></script>';
  const leafletCssTag = assets.leafletCss
    ? "<style>" + assets.leafletCss + "</style>"
    : '<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />';
  const leafletJsTag = assets.leafletJs
    ? "<script>" + inlineJs(assets.leafletJs) + "</script>"
    : '<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>';
  const escAttr = (s) => String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const safeServer = escAttr(settings.server);
  const safeLogin = escAttr(settings.login);
  const safePass = escAttr(settings.password);
  const prefsJson = JSON.stringify({
    autoRefresh: settings.autoRefresh !== false,
    refreshInterval: Number(settings.refreshInterval) || 3,
    selInterval: Number(settings.selInterval) || 1,
    smooth: settings.smooth !== false,
    predictMotion: settings.predictMotion !== false,
    fps: Number(settings.fps) === 30 ? 30 : 60,
    followSelected: settings.followSelected !== false,
    showLabels: settings.showLabels !== false,
    showOffline: settings.showOffline !== false,
    showZones: Boolean(settings.showZones),
    showDynamicZones: settings.showDynamicZones !== false,
    dynZoneRadius: Number(settings.dynZoneRadius) || 60,
    darkMode: Boolean(settings.darkMode),
    autoConnect: Boolean(settings.autoConnect),
    uiScale: Number(settings.uiScale) || 1,
    favorites: Array.isArray(settings.favorites) ? settings.favorites : [],
    customZones: Array.isArray(settings.customZones) ? settings.customZones : [],
    mapTypeFilter: Object.assign({ belaz: true, excavator: true, bulldozer: true, grader: true, fuel: true, other: true }, settings.mapTypeFilter || {})
  });

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Кузбассразрезуголь</title>
  ${tailwindTag}
  ${leafletCssTag}
  ${leafletJsTag}
  <style>
    :root {
      --ui-scale: 1;
      --lg-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
      --lg-ease: cubic-bezier(0.22, 1, 0.36, 1);
    }
    html { font-size: calc(16px * var(--ui-scale, 1)); }
    html, body { height: 100%; width: 100%; margin: 0; padding: 0; overflow: hidden; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", Roboto, sans-serif;
      -webkit-tap-highlight-color: transparent;
      overscroll-behavior: none;
      -webkit-font-smoothing: antialiased;
      background: linear-gradient(155deg, #e8f1ff 0%, #f1f5fb 48%, #e6ecfa 100%);
    }
    .tabular-nums { font-variant-numeric: tabular-nums; }

    /* ===== ЖИВОЙ AMBIENT-ФОН ПОД СТЕКЛОМ (для вкладок Объекты и Настройки) ===== */
    .lg-mesh {
      position: fixed;
      inset: 0;
      pointer-events: none;
      overflow: hidden;
      z-index: 0;
    }
    .lg-orb {
      position: absolute;
      border-radius: 9999px;
      filter: blur(56px);
      opacity: 0.55;
      will-change: transform;
      animation: lgFloat 16s ease-in-out infinite alternate;
    }
    .lg-orb-1 {
      width: 240px; height: 240px;
      top: -60px; left: -50px;
      background: radial-gradient(circle, rgba(56, 189, 248, 0.65), rgba(37, 99, 235, 0.15));
    }
    .lg-orb-2 {
      width: 260px; height: 260px;
      bottom: 80px; right: -70px;
      background: radial-gradient(circle, rgba(129, 140, 248, 0.55), rgba(168, 85, 247, 0.14));
      animation-delay: -6s;
      animation-duration: 20s;
    }
    .lg-orb-3 {
      width: 190px; height: 190px;
      top: 42%; left: 55%;
      background: radial-gradient(circle, rgba(45, 212, 191, 0.42), rgba(14, 165, 233, 0.08));
      animation-delay: -11s;
      animation-duration: 24s;
    }
    @keyframes lgFloat {
      0% { transform: translate3d(0, 0, 0) scale(1); }
      50% { transform: translate3d(18px, -22px, 0) scale(1.08); }
      100% { transform: translate3d(-14px, 16px, 0) scale(0.96); }
    }
    body.dark-mode .lg-orb { opacity: 0.32; }
    body.dark-mode .lg-orb-1 { background: radial-gradient(circle, rgba(14, 165, 233, 0.65), rgba(30, 58, 138, 0.08)); }
    body.dark-mode .lg-orb-2 { background: radial-gradient(circle, rgba(99, 102, 241, 0.6), rgba(88, 28, 135, 0.08)); }
    body.dark-mode .lg-orb-3 { background: radial-gradient(circle, rgba(20, 184, 166, 0.45), rgba(15, 23, 42, 0.05)); }

    /* ===== LIQUID GLASS ПОВЕРХНОСТИ (СВЕТЛАЯ И ТЁМНАЯ ТЕМА) ===== */
    .lg-glass, .glass-card {
      background: linear-gradient(145deg, rgba(255, 255, 255, 0.72) 0%, rgba(255, 255, 255, 0.48) 55%, rgba(255, 255, 255, 0.64) 100%);
      -webkit-backdrop-filter: blur(26px) saturate(210%);
      backdrop-filter: blur(26px) saturate(210%);
      border: 1px solid rgba(255, 255, 255, 0.72);
      box-shadow:
        0 10px 30px rgba(15, 23, 42, 0.10),
        0 2px 8px rgba(15, 23, 42, 0.05),
        inset 0 1.5px 0 rgba(255, 255, 255, 0.92),
        inset 0 -1px 0 rgba(15, 23, 42, 0.06);
    }
    .lg-glass-dark, .glass-dark {
      background: linear-gradient(145deg, rgba(18, 26, 44, 0.78) 0%, rgba(11, 17, 32, 0.86) 60%, rgba(20, 30, 52, 0.82) 100%);
      -webkit-backdrop-filter: blur(28px) saturate(210%);
      backdrop-filter: blur(28px) saturate(210%);
      border: 1px solid rgba(255, 255, 255, 0.18);
      box-shadow:
        0 20px 48px rgba(0, 0, 0, 0.46),
        0 4px 14px rgba(0, 0, 0, 0.28),
        inset 0 1.5px 0 rgba(255, 255, 255, 0.24),
        inset 0 -1px 0 rgba(255, 255, 255, 0.05);
    }
    .lg-card {
      background: linear-gradient(155deg, rgba(255, 255, 255, 0.78) 0%, rgba(255, 255, 255, 0.56) 100%);
      -webkit-backdrop-filter: blur(24px) saturate(195%);
      backdrop-filter: blur(24px) saturate(195%);
      border: 1px solid rgba(255, 255, 255, 0.82);
      box-shadow:
        0 10px 28px rgba(15, 23, 42, 0.07),
        inset 0 1.5px 0 rgba(255, 255, 255, 0.95);
    }
    .lg-dock {
      background: linear-gradient(150deg, rgba(255, 255, 255, 0.72) 0%, rgba(255, 255, 255, 0.50) 100%);
      -webkit-backdrop-filter: blur(30px) saturate(230%);
      backdrop-filter: blur(30px) saturate(230%);
      border: 1px solid rgba(255, 255, 255, 0.82);
      box-shadow:
        0 14px 36px rgba(15, 23, 42, 0.16),
        0 2px 8px rgba(15, 23, 42, 0.08),
        inset 0 1.5px 0 rgba(255, 255, 255, 0.96),
        inset 0 -1px 0 rgba(15, 23, 42, 0.06);
    }
    .lg-pill-indicator {
      position: absolute;
      top: 5px;
      bottom: 5px;
      left: 5px;
      width: calc((100% - 10px) / 3);
      border-radius: 9999px;
      background: linear-gradient(145deg, rgba(255, 255, 255, 0.96) 0%, rgba(235, 244, 255, 0.82) 100%);
      border: 1px solid rgba(255, 255, 255, 0.95);
      box-shadow:
        0 4px 14px rgba(37, 99, 235, 0.18),
        inset 0 1px 0 rgba(255, 255, 255, 1);
      transition: transform 0.36s var(--lg-spring);
      pointer-events: none;
      z-index: 0;
    }
    .lg-press {
      transition: transform 0.22s var(--lg-spring), background-color 0.2s ease, box-shadow 0.2s ease, opacity 0.2s ease;
    }
    .lg-press:active { transform: scale(0.92); }

    /* ===== КАРТА И МАРКЕРЫ ===== */
    #map { width: 100%; height: 100%; z-index: 1; background: #e2e8f0; }
    body.dark-mode #map { background: #060913; }
    #map.dark-tiles .leaflet-tile-pane {
      filter: invert(100%) hue-rotate(180deg) brightness(88%) contrast(95%) saturate(88%);
    }
    #map.hide-labels .car-label { display: none; }
    #map.hide-labels .car-marker-priority .car-label { display: block; }

    .car-arrow { transition: transform 0.5s var(--lg-ease); }
    .car-marker-wrap { contain: layout style; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }

    /* Адаптивные Liquid Glass попапы на карте (светлая и тёмная тема) */
    .leaflet-popup-content-wrapper {
      background: linear-gradient(145deg, rgba(255, 255, 255, 0.82) 0%, rgba(242, 247, 255, 0.68) 100%) !important;
      -webkit-backdrop-filter: blur(28px) saturate(220%);
      backdrop-filter: blur(28px) saturate(220%);
      color: #0f172a !important;
      border-radius: 24px !important;
      border: 1px solid rgba(255, 255, 255, 0.85) !important;
      box-shadow:
        0 18px 42px rgba(15, 23, 42, 0.18),
        0 4px 12px rgba(15, 23, 42, 0.08),
        inset 0 1.5px 0 rgba(255, 255, 255, 0.96),
        inset 0 -1px 0 rgba(15, 23, 42, 0.06) !important;
      animation: lgPopIn 0.26s var(--lg-spring);
    }
    .leaflet-popup-tip {
      background: rgba(248, 251, 255, 0.84) !important;
      box-shadow: 0 4px 12px rgba(15, 23, 42, 0.12) !important;
    }
    .leaflet-container a.leaflet-popup-close-button {
      color: #64748b !important;
      top: 8px !important;
      right: 10px !important;
      font-weight: 700 !important;
    }
    .leaflet-popup-content { margin: 14px 16px !important; min-width: 220px; }

    .lg-popup-zone { color: #d97706; }
    .lg-popup-dist { color: #2563eb; }
    .lg-popup-meta { border-top: 1px solid rgba(15, 23, 42, 0.10); color: #475569; }
    .lg-popup-dur { color: #0f172a; }

    body.dark-mode .leaflet-popup-content-wrapper {
      background: linear-gradient(145deg, rgba(22, 32, 54, 0.82) 0%, rgba(11, 17, 32, 0.88) 100%) !important;
      color: #f8fafc !important;
      border: 1px solid rgba(255, 255, 255, 0.18) !important;
      box-shadow:
        0 20px 46px rgba(0, 0, 0, 0.50),
        inset 0 1.5px 0 rgba(255, 255, 255, 0.22),
        inset 0 -1px 0 rgba(255, 255, 255, 0.05) !important;
    }
    body.dark-mode .leaflet-popup-tip { background: rgba(16, 24, 42, 0.88) !important; }
    body.dark-mode .leaflet-container a.leaflet-popup-close-button { color: #94a3b8 !important; }
    body.dark-mode .lg-popup-zone { color: #fcd34d; }
    body.dark-mode .lg-popup-dist { color: #93c5fd; }
    body.dark-mode .lg-popup-meta { border-top-color: rgba(255, 255, 255, 0.12); color: #cbd5e1; }
    body.dark-mode .lg-popup-dur { color: #ffffff; }

    /* Адаптивные стеклянные кнопки и плитки телеметрии в нижней панели объекта */
    .lg-icon-btn {
      background: rgba(255, 255, 255, 0.65);
      border: 1px solid rgba(255, 255, 255, 0.85);
      color: #334155;
      box-shadow: 0 2px 8px rgba(15, 23, 42, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.95);
    }
    body.dark-mode .lg-icon-btn {
      background: rgba(30, 41, 59, 0.72);
      border-color: rgba(255, 255, 255, 0.14);
      color: #e2e8f0;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.14);
    }

    .lg-pill-blue {
      background: rgba(59, 130, 246, 0.14);
      border: 1px solid rgba(59, 130, 246, 0.30);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.55);
    }
    .lg-pill-blue .lg-pill-lbl { color: #1d4ed8; }
    .lg-pill-blue .lg-pill-val { color: #1e40af; }
    body.dark-mode .lg-pill-blue {
      background: rgba(59, 130, 246, 0.17);
      border-color: rgba(59, 130, 246, 0.34);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.10);
    }
    body.dark-mode .lg-pill-blue .lg-pill-lbl { color: rgba(191, 219, 254, 0.82); }
    body.dark-mode .lg-pill-blue .lg-pill-val { color: #93c5fd; }

    .lg-pill-amber {
      background: rgba(245, 158, 11, 0.14);
      border: 1px solid rgba(245, 158, 11, 0.30);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.55);
    }
    .lg-pill-amber .lg-pill-lbl { color: #b45309; }
    .lg-pill-amber .lg-pill-val { color: #92400e; }
    body.dark-mode .lg-pill-amber {
      background: rgba(245, 158, 11, 0.16);
      border-color: rgba(245, 158, 11, 0.32);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.10);
    }
    body.dark-mode .lg-pill-amber .lg-pill-lbl { color: rgba(253, 230, 138, 0.8); }
    body.dark-mode .lg-pill-amber .lg-pill-val { color: #fcd34d; }

    .lg-pill-indigo {
      background: rgba(99, 102, 241, 0.13);
      border: 1px solid rgba(99, 102, 241, 0.28);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.55);
    }
    .lg-pill-indigo .lg-pill-lbl { color: #4338ca; }
    .lg-pill-indigo .lg-pill-val { color: #3730a3; }
    body.dark-mode .lg-pill-indigo {
      background: rgba(99, 102, 241, 0.17);
      border-color: rgba(99, 102, 241, 0.34);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.10);
    }
    body.dark-mode .lg-pill-indigo .lg-pill-lbl { color: rgba(199, 210, 254, 0.82); }
    body.dark-mode .lg-pill-indigo .lg-pill-val { color: #a5b4fc; }

    .lg-pill-orange {
      background: rgba(249, 115, 22, 0.14);
      border: 1px solid rgba(249, 115, 22, 0.30);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.55);
    }
    .lg-pill-orange .lg-pill-lbl { color: #c2410c; }
    .lg-pill-orange .lg-pill-val { color: #9a3412; }
    body.dark-mode .lg-pill-orange {
      background: rgba(249, 115, 22, 0.17);
      border-color: rgba(249, 115, 22, 0.35);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.10);
    }
    body.dark-mode .lg-pill-orange .lg-pill-lbl { color: rgba(254, 215, 170, 0.82); }
    body.dark-mode .lg-pill-orange .lg-pill-val { color: #fdba74; }

    .lg-pill-emerald {
      background: rgba(16, 185, 129, 0.14);
      border: 1px solid rgba(16, 185, 129, 0.30);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.55);
    }
    .lg-pill-emerald .lg-pill-lbl { color: #047857; }
    .lg-pill-emerald .lg-pill-val { color: #065f46; }
    body.dark-mode .lg-pill-emerald {
      background: rgba(16, 185, 129, 0.16);
      border-color: rgba(16, 185, 129, 0.34);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.10);
    }
    body.dark-mode .lg-pill-emerald .lg-pill-lbl { color: rgba(167, 243, 208, 0.82); }
    body.dark-mode .lg-pill-emerald .lg-pill-val { color: #6ee7b7; }

    .lg-pill-red {
      background: rgba(239, 68, 68, 0.14);
      border: 1px solid rgba(239, 68, 68, 0.30);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.55);
    }
    .lg-pill-red .lg-pill-lbl { color: #b91c1c; }
    .lg-pill-red .lg-pill-val { color: #991b1b; }
    body.dark-mode .lg-pill-red {
      background: rgba(239, 68, 68, 0.16);
      border-color: rgba(239, 68, 68, 0.34);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.10);
    }
    body.dark-mode .lg-pill-red .lg-pill-lbl { color: rgba(254, 202, 202, 0.82); }
    body.dark-mode .lg-pill-red .lg-pill-val { color: #fca5a5; }

    .lg-pill-neutral {
      background: rgba(148, 163, 184, 0.16);
      border: 1px solid rgba(148, 163, 184, 0.30);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.65);
    }
    .lg-pill-neutral .lg-pill-lbl { color: #475569; }
    .lg-pill-neutral .lg-pill-val { color: #0f172a; }
    body.dark-mode .lg-pill-neutral {
      background: rgba(51, 65, 85, 0.52);
      border-color: rgba(148, 163, 184, 0.26);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.10);
    }
    body.dark-mode .lg-pill-neutral .lg-pill-lbl { color: #94a3b8; }
    body.dark-mode .lg-pill-neutral .lg-pill-val { color: #f1f5f9; }

    /* Адаптивные Liquid Glass подписи под машинами (светлое стекло на схеме, тёмное на спутнике и ночью) */
    .car-label {
      margin-top: 3px;
      background: linear-gradient(145deg, rgba(255, 255, 255, 0.86) 0%, rgba(241, 246, 255, 0.74) 100%);
      -webkit-backdrop-filter: blur(14px) saturate(200%);
      backdrop-filter: blur(14px) saturate(200%);
      color: #0f172a;
      font-size: calc(10px * var(--ui-scale, 1));
      font-weight: 700;
      letter-spacing: 0.01em;
      padding: 2px 8px;
      border-radius: 9999px;
      white-space: nowrap;
      box-shadow: 0 4px 12px rgba(15, 23, 42, 0.16), inset 0 1px 0 rgba(255, 255, 255, 0.96);
      border: 1px solid rgba(255, 255, 255, 0.88);
      font-variant-numeric: tabular-nums;
      transition: background 0.25s ease, color 0.25s ease, border-color 0.25s ease;
    }
    body.dark-mode .car-label,
    #map.sat-tiles .car-label {
      background: linear-gradient(145deg, rgba(15, 23, 42, 0.82) 0%, rgba(10, 15, 28, 0.76) 100%);
      color: #f8fafc;
      font-weight: 600;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.40), inset 0 1px 0 rgba(255, 255, 255, 0.22);
      border-color: rgba(255, 255, 255, 0.22);
    }

    .lg-accent-indigo { color: #4f46e5; }
    .lg-accent-blue { color: #2563eb; }
    .lg-accent-amber { color: #d97706; }
    body.dark-mode .lg-accent-indigo { color: #a5b4fc; }
    body.dark-mode .lg-accent-blue { color: #93c5fd; }
    body.dark-mode .lg-accent-amber { color: #fcd34d; }

    .text-\\[11px\\] { font-size: calc(11px * var(--ui-scale, 1)) !important; }
    .text-\\[10px\\] { font-size: calc(10px * var(--ui-scale, 1)) !important; }
    .text-\\[9px\\] { font-size: calc(9px * var(--ui-scale, 1)) !important; }
    .no-scroll::-webkit-scrollbar { display: none; }
    .no-scroll { -ms-overflow-style: none; scrollbar-width: none; }

    /* ===== АНИМАЦИИ ИНТЕРФЕЙСА ===== */
    @keyframes lgSheetIn {
      0% { opacity: 0; transform: translate3d(0, 28px, 0) scale(0.95); }
      100% { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
    }
    @keyframes lgBackdropIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes lgPopIn {
      0% { opacity: 0; transform: scale(0.88); }
      100% { opacity: 1; transform: scale(1); }
    }
    @keyframes lgTabIn {
      0% { opacity: 0; transform: translate3d(0, 8px, 0) scale(0.99); }
      100% { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
    }
    @keyframes lgToastIn {
      0% { opacity: 0; transform: translate3d(-50%, -18px, 0) scale(0.92); }
      100% { opacity: 1; transform: translate3d(-50%, 0, 0) scale(1); }
    }
    @keyframes lgListIn {
      0% { opacity: 0; transform: translate3d(0, 10px, 0); }
      100% { opacity: 1; transform: translate3d(0, 0, 0); }
    }
    @keyframes lgSpin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    @keyframes lgLivePulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.45; transform: scale(0.82); }
    }
    @keyframes lgSheetOut {
      0% { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
      100% { opacity: 0; transform: translate3d(0, 48px, 0) scale(0.96); }
    }
    @keyframes lgBackdropOut {
      from { opacity: 1; }
      to { opacity: 0; }
    }
    .sheet-anim { animation: lgSheetIn 0.34s var(--lg-spring) both; will-change: transform, opacity; }
    .modal-backdrop-anim { animation: lgBackdropIn 0.2s ease-out both; }
    .modal-closing { animation: lgBackdropOut 0.2s ease-in forwards !important; pointer-events: none; }
    .modal-closing .sheet-anim { animation: lgSheetOut 0.2s cubic-bezier(0.4, 0, 1, 1) forwards !important; }
    .tab-anim { animation: lgTabIn 0.26s var(--lg-ease) both; }
    .toast-anim { animation: lgToastIn 0.32s var(--lg-spring) both; }
    .lg-list-item { animation: lgListIn 0.26s var(--lg-ease) both; }
    .lg-spin { display: inline-block; animation: lgSpin 0.85s linear infinite; }
    .lg-live-dot {
      display: inline-block;
      width: 7px; height: 7px;
      border-radius: 9999px;
      background: #ffffff;
      box-shadow: 0 0 8px rgba(255,255,255,0.9);
      animation: lgLivePulse 1.8s ease-in-out infinite;
    }

    .fav-tile {
      -webkit-user-select: none;
      user-select: none;
      -webkit-touch-callout: none;
      touch-action: pan-x;
      transition: transform 0.22s var(--lg-spring), box-shadow 0.2s ease;
    }
    .fav-tile-dragging {
      position: relative;
      z-index: 60 !important;
      box-shadow: 0 18px 36px rgba(0, 0, 0, 0.38) !important;
      border-color: #f59e0b !important;
      transition: box-shadow 0.15s ease !important;
      opacity: 0.96;
    }
    .custom-zone-label {
      background: rgba(15, 23, 42, 0.82);
      -webkit-backdrop-filter: blur(12px) saturate(180%);
      backdrop-filter: blur(12px) saturate(180%);
      color: #ffffff;
      font-size: calc(11px * var(--ui-scale, 1));
      font-weight: 700;
      padding: 3px 10px;
      border-radius: 9999px;
      white-space: nowrap;
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.36), inset 0 1px 0 rgba(255,255,255,0.28);
      border: 1.5px solid rgba(255, 255, 255, 0.35);
      transform: translate(-50%, -50%);
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    @keyframes pulse-ring {
      0% { transform: scale(0.9); opacity: 0.9; }
      70% { transform: scale(2.2); opacity: 0; }
      100% { transform: scale(2.2); opacity: 0; }
    }
    .my-loc-pulse {
      position: absolute; inset: 0; border-radius: 50%;
      background: rgba(59, 130, 246, 0.45);
      animation: pulse-ring 1.8s cubic-bezier(0.215, 0.61, 0.355, 1) infinite;
    }

    /* Кнопки плавающей панели навигации */
    .nav-btn {
      position: relative;
      z-index: 1;
      transition: color 0.24s ease, transform 0.22s var(--lg-spring);
      border-radius: 9999px;
    }
    .nav-btn-active {
      color: #2563eb !important;
      font-weight: 700 !important;
    }
    .nav-btn-active .nav-ico { transform: translateY(-1px) scale(1.1); }
    .nav-ico { transition: transform 0.28s var(--lg-spring); }

    /* Переключатели-ползунки в стиле Liquid Glass iOS 26 */
    .ios-switch {
      position: relative;
      display: inline-block;
      width: 52px;
      height: 31px;
      flex-shrink: 0;
      cursor: pointer;
    }
    .ios-switch input { opacity: 0; width: 0; height: 0; position: absolute; }
    .ios-slider {
      position: absolute;
      inset: 0;
      background: rgba(148, 163, 184, 0.34);
      border: 1px solid rgba(255, 255, 255, 0.45);
      border-radius: 9999px;
      box-shadow: inset 0 2px 5px rgba(15, 23, 42, 0.14);
      transition: background 0.26s ease, box-shadow 0.26s ease, border-color 0.26s ease;
    }
    .ios-slider::before {
      content: "";
      position: absolute;
      height: 25px;
      width: 25px;
      left: 2px;
      top: 2px;
      background: linear-gradient(160deg, #ffffff 0%, #f1f5f9 100%);
      border-radius: 9999px;
      box-shadow: 0 3px 8px rgba(0, 0, 0, 0.24), inset 0 1px 0 #ffffff;
      transition: transform 0.32s var(--lg-spring), width 0.2s ease;
    }
    .ios-switch:active .ios-slider::before { width: 29px; }
    .ios-switch input:checked + .ios-slider {
      background: linear-gradient(135deg, #34d399, #10b981);
      border-color: rgba(255, 255, 255, 0.35);
      box-shadow: 0 0 14px rgba(16, 185, 129, 0.35), inset 0 1px 1px rgba(255, 255, 255, 0.4);
    }
    .ios-switch input:checked + .ios-slider::before {
      transform: translateX(21px);
    }
    .ios-switch:active input:checked + .ios-slider::before {
      transform: translateX(17px);
    }

    /* ===== ТЁМНАЯ ТЕМА LIQUID GLASS (Obsidian Glass) ===== */
    body.dark-mode {
      background: linear-gradient(155deg, #050811 0%, #0b1120 55%, #070c18 100%);
      color: #f1f5f9;
    }
    body.dark-mode .lg-glass, body.dark-mode .glass-card {
      background: linear-gradient(145deg, rgba(24, 34, 56, 0.72) 0%, rgba(13, 20, 36, 0.62) 100%) !important;
      border-color: rgba(255, 255, 255, 0.16) !important;
      color: #f8fafc !important;
      box-shadow:
        0 12px 32px rgba(0, 0, 0, 0.42),
        inset 0 1.5px 0 rgba(255, 255, 255, 0.20),
        inset 0 -1px 0 rgba(255, 255, 255, 0.04) !important;
    }
    body.dark-mode .lg-card, body.dark-mode .dm-surface {
      background: linear-gradient(155deg, rgba(22, 32, 52, 0.76) 0%, rgba(13, 19, 34, 0.68) 100%) !important;
      -webkit-backdrop-filter: blur(26px) saturate(190%);
      backdrop-filter: blur(26px) saturate(190%);
      color: #f1f5f9 !important;
      border-color: rgba(255, 255, 255, 0.13) !important;
      box-shadow: 0 14px 36px rgba(0, 0, 0, 0.38), inset 0 1.5px 0 rgba(255, 255, 255, 0.16) !important;
    }
    body.dark-mode .lg-dock {
      background: linear-gradient(150deg, rgba(22, 32, 54, 0.76) 0%, rgba(12, 18, 32, 0.68) 100%) !important;
      border-color: rgba(255, 255, 255, 0.16) !important;
      box-shadow: 0 18px 42px rgba(0, 0, 0, 0.52), inset 0 1.5px 0 rgba(255, 255, 255, 0.20) !important;
    }
    body.dark-mode .lg-pill-indicator {
      background: linear-gradient(145deg, rgba(59, 130, 246, 0.34) 0%, rgba(37, 99, 235, 0.22) 100%);
      border-color: rgba(147, 197, 253, 0.35);
      box-shadow: 0 4px 16px rgba(37, 99, 235, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.25);
    }
    body.dark-mode .nav-btn-active { color: #93c5fd !important; }
    body.dark-mode .ios-slider {
      background: rgba(51, 65, 85, 0.55);
      border-color: rgba(255, 255, 255, 0.12);
    }
    body.dark-mode .dm-bg { background: transparent !important; }
    body.dark-mode .dm-input {
      background: rgba(15, 23, 42, 0.62) !important;
      color: #f8fafc !important;
      border-color: rgba(255, 255, 255, 0.12) !important;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
    }
    body.dark-mode .dm-seg {
      background: rgba(9, 14, 26, 0.62) !important;
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    body.dark-mode .dm-muted { color: #94a3b8 !important; }
    body.dark-mode .dm-divider { border-color: rgba(255, 255, 255, 0.09) !important; }
    body.dark-mode .dm-btn {
      background: linear-gradient(145deg, rgba(24, 34, 56, 0.78) 0%, rgba(13, 20, 36, 0.68) 100%) !important;
      color: #f1f5f9 !important;
      border-color: rgba(255, 255, 255, 0.16) !important;
      box-shadow: 0 10px 26px rgba(0, 0, 0, 0.38), inset 0 1.5px 0 rgba(255, 255, 255, 0.18) !important;
    }
    body.dark-mode .dm-list { background: transparent !important; }
    body.dark-mode .dm-list > div { border-color: rgba(255, 255, 255, 0.08) !important; }
  </style>
</head>
<body class="text-slate-900 fixed inset-0 overflow-hidden flex flex-col select-none">
  <div class="lg-mesh" aria-hidden="true">
    <div class="lg-orb lg-orb-1"></div>
    <div class="lg-orb lg-orb-2"></div>
    <div class="lg-orb lg-orb-3"></div>
  </div>

  <div id="toast" class="fixed top-4 left-1/2 -translate-x-1/2 z-[1200] w-[92%] max-w-md hidden text-xs font-semibold px-4 py-3 rounded-xl shadow-lg text-center text-white"></div>

  <!-- МОДАЛЬНОЕ МЕНЮ ОБЪЕКТА (ПО КНОПКЕ ⋯ ИЛИ ДОЛГОМУ НАЖАТИЮ) -->
  <div id="ctx-menu" class="hidden fixed inset-0 z-[1100] modal-backdrop-anim bg-slate-950/40 backdrop-blur-md flex items-end justify-center p-3 pb-6" onclick="if(event.target===this) closeCtxMenu()">
    <div class="dm-surface lg-card w-full max-w-md sheet-anim rounded-[28px] shadow-2xl overflow-hidden border border-transparent">
      <div class="w-10 h-1 rounded-full bg-slate-300/70 dark:bg-slate-600 mx-auto mt-2.5 shrink-0"></div>
      <div class="dm-divider px-5 pt-4 pb-3 border-b border-slate-100 flex items-center justify-between gap-2">
        <div class="min-w-0 flex-1">
          <div id="ctx-title" class="font-bold text-base truncate">Объект</div>
          <div id="ctx-sub" class="dm-muted text-xs text-slate-500 truncate mt-0.5">Выберите действие</div>
        </div>
        <button id="ctx-fav-btn" onclick="toggleFavoriteFromCtx()" title="В избранное" class="w-9 h-9 rounded-full bg-amber-50 text-amber-500 text-lg flex items-center justify-center shrink-0 active:scale-95">☆</button>
        <button onclick="closeCtxMenu()" class="dm-input w-8 h-8 rounded-full bg-slate-100 text-slate-500 font-bold text-sm flex items-center justify-center shrink-0">✕</button>
      </div>
      <div class="p-3 space-y-2">
        <button onclick="openRouteModalFromCtx()" class="w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl bg-blue-600 active:bg-blue-700 text-white font-semibold text-sm shadow-sm transition">
          <span class="text-lg">🗺️</span>
          <div class="text-left">
            <div>История маршрута</div>
            <div class="text-[11px] font-normal text-blue-100">Трек за период, стоянки и воспроизведение</div>
          </div>
        </button>

        <button onclick="openInfoModalFromCtx()" class="dm-input w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl bg-slate-100 active:bg-slate-200 font-semibold text-sm transition">
          <span class="text-lg">ℹ️</span>
          <div class="text-left">
            <div>Информация и датчики</div>
            <div class="dm-muted text-[11px] font-normal text-slate-500">Топливо, вес, геозоны и все поля с сервера</div>
          </div>
        </button>

        <button onclick="copyCoordsFromCtx()" class="dm-input w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl bg-slate-100 active:bg-slate-200 font-semibold text-sm transition">
          <span class="text-lg">📋</span>
          <div class="text-left">
            <div>Скопировать координаты</div>
            <div id="ctx-coords-sub" class="dm-muted text-[11px] font-normal text-slate-500 font-mono">0.00000, 0.00000</div>
          </div>
        </button>
      </div>
    </div>
  </div>

  <!-- МОДАЛЬНОЕ ОКНО СВОДКИ ПО ПАРКУ И ОЧЕРЕДЯМ (ПО НАЖАТИЮ НА БЕЙДЖ СТАТУСА) -->
  <div id="summary-modal" class="hidden fixed inset-0 z-[1150] modal-backdrop-anim bg-slate-950/45 backdrop-blur-md flex items-end sm:items-center justify-center p-3" onclick="if(event.target===this) closeSummaryModal()">
    <div class="dm-surface lg-card w-full max-w-md sheet-anim rounded-[28px] shadow-2xl overflow-hidden max-h-[82vh] flex flex-col border border-transparent">
      <div class="w-10 h-1 rounded-full bg-slate-300/70 dark:bg-slate-600 mx-auto mt-2.5 shrink-0"></div>
      <div class="dm-divider px-5 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
        <div class="min-w-0">
          <div class="font-bold text-base">Сводка парка и очереди</div>
          <div id="summary-sub" class="dm-muted text-xs text-slate-500 mt-0.5">Статус техники в реальном времени</div>
        </div>
        <button onclick="closeSummaryModal()" class="dm-input w-8 h-8 rounded-full bg-slate-100 text-slate-500 font-bold text-sm flex items-center justify-center shrink-0">✕</button>
      </div>
      <div id="summary-body" class="p-4 overflow-y-auto space-y-4"></div>
    </div>
  </div>

  <!-- МОДАЛЬНОЕ ОКНО ВЫБОРА ДАТЫ И ВРЕМЕНИ ДЛЯ МАРШРУТА -->
  <div id="route-modal" class="hidden fixed inset-0 z-[1150] modal-backdrop-anim bg-slate-950/45 backdrop-blur-md flex items-center justify-center p-4" onclick="if(event.target===this) closeRouteModal()">
    <div class="dm-surface lg-card w-full max-w-md sheet-anim rounded-[28px] shadow-2xl overflow-hidden border border-transparent">
      <div class="w-10 h-1 rounded-full bg-slate-300/70 dark:bg-slate-600 mx-auto mt-2.5 shrink-0"></div>
      <div class="dm-divider px-5 py-4 border-b border-slate-100 flex items-center justify-between">
        <div class="min-w-0">
          <div class="font-bold text-base">История маршрута</div>
          <div id="route-obj-name" class="dm-muted text-xs text-slate-500 truncate">Объект</div>
        </div>
        <button onclick="closeRouteModal()" class="dm-input w-8 h-8 rounded-full bg-slate-100 text-slate-500 font-bold text-sm flex items-center justify-center">✕</button>
      </div>
      <div class="p-5 space-y-3.5">
        <div class="grid grid-cols-4 gap-1.5 text-[11px] font-semibold">
          <button onclick="setRoutePreset('3h')" class="dm-input py-2 rounded-xl bg-slate-100 active:bg-slate-200">3 часа</button>
          <button onclick="setRoutePreset('shift')" class="dm-input py-2 rounded-xl bg-slate-100 active:bg-slate-200">Смена 12ч</button>
          <button onclick="setRoutePreset('today')" class="dm-input py-2 rounded-xl bg-slate-100 active:bg-slate-200">Сегодня</button>
          <button onclick="setRoutePreset('yesterday')" class="dm-input py-2 rounded-xl bg-slate-100 active:bg-slate-200">Вчера</button>
        </div>
        <div>
          <label class="dm-muted block text-xs font-semibold text-slate-600 mb-1">От (дата и время)</label>
          <input id="route-from" type="datetime-local" class="dm-input w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-blue-500">
        </div>
        <div>
          <label class="dm-muted block text-xs font-semibold text-slate-600 mb-1">До (дата и время)</label>
          <input id="route-to" type="datetime-local" class="dm-input w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-blue-500">
        </div>
        <button id="btn-build-route" onclick="requestRoute()" class="w-full bg-blue-600 active:bg-blue-700 text-white font-semibold py-3 rounded-xl shadow-md transition">
          Показать маршрут
        </button>
        <pre id="route-debug-box" class="hidden bg-slate-900 text-amber-300 text-[10px] font-mono p-2.5 rounded-xl max-h-28 overflow-y-auto whitespace-pre-wrap break-all select-text"></pre>
        <button id="btn-copy-route-debug" onclick="copyRouteDebug()" class="hidden w-full dm-input bg-slate-100 text-xs font-semibold text-amber-500 py-2.5 rounded-xl border border-amber-500/30">
          📋 Скопировать ответ сервера для диагностики
        </button>
      </div>
    </div>
  </div>

  <!-- МОДАЛЬНОЕ ОКНО ПОЛНОЙ ИНФОРМАЦИИ ОБ ОБЪЕКТЕ -->
  <div id="info-modal" class="hidden fixed inset-0 z-[1150] modal-backdrop-anim bg-slate-950/45 backdrop-blur-md flex items-end sm:items-center justify-center p-3" onclick="if(event.target===this) closeInfoModal()">
    <div class="dm-surface lg-card w-full max-w-md sheet-anim rounded-[28px] shadow-2xl overflow-hidden max-h-[85vh] flex flex-col border border-transparent">
      <div class="w-10 h-1 rounded-full bg-slate-300/70 dark:bg-slate-600 mx-auto mt-2.5 shrink-0"></div>
      <div class="dm-divider px-5 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
        <div class="min-w-0">
          <div id="info-title" class="font-bold text-base truncate">Информация об объекте</div>
          <div id="info-sub" class="dm-muted text-xs text-slate-500 truncate mt-0.5">Полные данные с сервера</div>
        </div>
        <button onclick="closeInfoModal()" class="dm-input w-8 h-8 rounded-full bg-slate-100 text-slate-500 font-bold text-sm flex items-center justify-center shrink-0">✕</button>
      </div>
      <div id="info-body" class="p-4 overflow-y-auto space-y-3 select-text"></div>
    </div>
  </div>

  <!-- МОДАЛЬНОЕ ОКНО «КТО В ГЕОЗОНЕ» -->
  <div id="zone-modal" class="hidden fixed inset-0 z-[1150] modal-backdrop-anim bg-slate-950/45 backdrop-blur-md flex items-end sm:items-center justify-center p-3" onclick="if(event.target===this) closeZoneModal()">
    <div class="dm-surface lg-card w-full max-w-md sheet-anim rounded-[28px] shadow-2xl overflow-hidden max-h-[80vh] flex flex-col border border-transparent">
      <div class="w-10 h-1 rounded-full bg-slate-300/70 dark:bg-slate-600 mx-auto mt-2.5 shrink-0"></div>
      <div class="dm-divider px-5 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
        <div class="min-w-0">
          <div id="zone-modal-title" class="font-bold text-base truncate">Геозона</div>
          <div id="zone-modal-sub" class="dm-muted text-xs text-slate-500 truncate mt-0.5">Техника внутри зоны</div>
        </div>
        <button onclick="closeZoneModal()" class="dm-input w-8 h-8 rounded-full bg-slate-100 text-slate-500 font-bold text-sm flex items-center justify-center shrink-0">✕</button>
      </div>
      <div id="zone-modal-body" class="p-3 overflow-y-auto divide-y divide-slate-100"></div>
      <div id="zone-modal-actions" class="hidden dm-divider p-3 border-t border-slate-100 grid grid-cols-2 gap-2 shrink-0">
        <button id="btn-zone-edit" class="dm-input py-2.5 rounded-xl bg-slate-100 active:bg-slate-200 text-xs font-semibold">✏️ Переименовать</button>
        <button id="btn-zone-delete" class="py-2.5 rounded-xl bg-red-500/15 active:bg-red-500/25 text-red-500 text-xs font-semibold border border-red-500/30">🗑️ Удалить зону</button>
      </div>
    </div>
  </div>

  <!-- МОДАЛЬНОЕ ОКНО ПОДПИСИ И ЦВЕТА СВОЕЙ ЗОНЫ -->
  <div id="save-zone-modal" class="hidden fixed inset-0 z-[1160] modal-backdrop-anim bg-slate-950/45 backdrop-blur-md flex items-center justify-center p-4" onclick="if(event.target===this) closeSaveZoneModal()">
    <div class="dm-surface lg-card w-full max-w-md sheet-anim rounded-[28px] shadow-2xl overflow-hidden border border-transparent">
      <div class="w-10 h-1 rounded-full bg-slate-300/70 dark:bg-slate-600 mx-auto mt-2.5 shrink-0"></div>
      <div class="dm-divider px-5 py-4 border-b border-slate-100 flex items-center justify-between">
        <div class="min-w-0">
          <div id="save-zone-title" class="font-bold text-base">Подписать зону</div>
          <div id="save-zone-sub" class="dm-muted text-xs text-slate-500 truncate mt-0.5">Укажите название и цвет на карте</div>
        </div>
        <button onclick="closeSaveZoneModal()" class="dm-input w-8 h-8 rounded-full bg-slate-100 text-slate-500 font-bold text-sm flex items-center justify-center">✕</button>
      </div>
      <div class="p-5 space-y-4">
        <div>
          <label class="dm-muted block text-xs font-semibold text-slate-600 mb-1.5">Название зоны</label>
          <input id="custom-zone-name" type="text" placeholder="Например: Отвал №2, Ремонт, Склад..."
            class="dm-input w-full bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm outline-none focus:border-blue-500">
        </div>
        <div>
          <label class="dm-muted block text-xs font-semibold text-slate-600 mb-2">Цвет зоны</label>
          <div id="zone-color-picker" class="flex items-center justify-between gap-2">
            <button type="button" data-color="#2563eb" onclick="selectZoneColor('#2563eb')" class="w-9 h-9 rounded-full bg-blue-600 ring-offset-2 transition active:scale-95"></button>
            <button type="button" data-color="#16a34a" onclick="selectZoneColor('#16a34a')" class="w-9 h-9 rounded-full bg-green-600 ring-offset-2 transition active:scale-95"></button>
            <button type="button" data-color="#f97316" onclick="selectZoneColor('#f97316')" class="w-9 h-9 rounded-full bg-orange-500 ring-offset-2 transition active:scale-95"></button>
            <button type="button" data-color="#ef4444" onclick="selectZoneColor('#ef4444')" class="w-9 h-9 rounded-full bg-red-500 ring-offset-2 transition active:scale-95"></button>
            <button type="button" data-color="#a855f7" onclick="selectZoneColor('#a855f7')" class="w-9 h-9 rounded-full bg-purple-500 ring-offset-2 transition active:scale-95"></button>
            <button type="button" data-color="#06b6d4" onclick="selectZoneColor('#06b6d4')" class="w-9 h-9 rounded-full bg-cyan-500 ring-offset-2 transition active:scale-95"></button>
          </div>
        </div>
        <button onclick="saveCustomZone()" class="w-full bg-blue-600 active:bg-blue-700 text-white font-semibold py-3 rounded-xl shadow-md transition">
          Сохранить зону
        </button>
      </div>
    </div>
  </div>

  <!-- МОДАЛЬНОЕ ОКНО ФИЛЬТРА ОТОБРАЖАЕМЫХ ТИПОВ ТЕХНИКИ -->
  <div id="map-filter-modal" class="hidden fixed inset-0 z-[1160] modal-backdrop-anim bg-slate-950/45 backdrop-blur-md flex items-end sm:items-center justify-center p-3" onclick="if(event.target===this) closeMapFilterModal()">
    <div class="dm-surface lg-card w-full max-w-md sheet-anim rounded-[28px] shadow-2xl overflow-hidden max-h-[82vh] flex flex-col border border-transparent">
      <div class="w-10 h-1 rounded-full bg-slate-300/70 dark:bg-slate-600 mx-auto mt-2.5 shrink-0"></div>
      <div class="dm-divider px-5 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
        <div class="min-w-0">
          <div class="font-bold text-base">Фильтр отображения</div>
          <div class="dm-muted text-xs text-slate-500 mt-0.5">Какие типы техники показывать на карте и в списке</div>
        </div>
        <button onclick="closeMapFilterModal()" class="dm-input w-8 h-8 rounded-full bg-slate-100 text-slate-500 font-bold text-sm flex items-center justify-center shrink-0">✕</button>
      </div>
      <div id="map-filter-list" class="p-3 overflow-y-auto space-y-1.5"></div>
      <div class="dm-divider p-3 border-t border-slate-100 space-y-2 shrink-0">
        <div class="grid grid-cols-2 gap-2">
          <button type="button" onclick="setAllMapTypes(true)" class="dm-input py-2.5 rounded-xl bg-slate-100 active:bg-slate-200 text-xs font-semibold text-emerald-600">Выбрать все</button>
          <button type="button" onclick="setAllMapTypes(false)" class="dm-input py-2.5 rounded-xl bg-slate-100 active:bg-slate-200 text-xs font-semibold text-red-500">Снять все</button>
        </div>
        <button type="button" onclick="closeMapFilterModal()" class="w-full py-2.5 rounded-xl bg-blue-600 active:bg-blue-700 text-white text-sm font-semibold shadow-sm">Готово</button>
      </div>
    </div>
  </div>

  <main class="flex-1 min-h-0 relative overflow-hidden w-full">

    <!-- КАРТА -->
    <section id="tab-map" class="absolute inset-0 flex flex-col hidden">
      <!-- Разгруженная верхняя панель: поиск + статус-сводка + быстрое обновление -->
      <div class="absolute top-3 left-3 right-3 z-[400] flex flex-col gap-2 pointer-events-none">
        <div class="flex items-center gap-1.5 pointer-events-auto">
          <div class="relative flex-1 min-w-0">
            <div class="relative flex items-center">
              <span class="absolute left-3 text-slate-400 pointer-events-none flex items-center"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.2" y2="16.2"/></svg></span>
              <input id="map-search" type="text" placeholder="Поиск техники..."
                oninput="onMapSearchInput()" onfocus="onMapSearchInput()"
                class="dm-btn glass-card w-full rounded-2xl pl-9 pr-8 py-2.5 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-blue-500/40 transition">
              <button id="map-search-clear" onclick="clearMapSearch()"
                class="hidden absolute right-2 w-6 h-6 rounded-full bg-slate-200 text-slate-600 text-xs font-bold flex items-center justify-center active:bg-slate-300">
                ✕
              </button>
            </div>
            <div id="map-search-results" class="dm-surface lg-glass sheet-anim hidden absolute left-0 right-0 mt-1.5 rounded-2xl max-h-56 overflow-y-auto divide-y divide-slate-900/10 z-[450]"></div>
          </div>

          <button id="btn-map-refresh" onclick="manualRefresh()" title="Обновить" class="dm-btn glass-card lg-press rounded-2xl w-10 h-10 flex items-center justify-center text-blue-600 shrink-0 transition">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>
          </button>

          <button id="status-badge" onclick="openSummaryModal()" title="Сводка парка и очереди" class="bg-slate-700 text-white text-xs font-bold px-3 h-10 rounded-xl shadow-lg active:scale-95 shrink-0 flex items-center gap-1">
            Офлайн
          </button>
        </div>

        <!-- Быстрый доступ к избранным объектам -->
        <div id="fav-bar" class="hidden pointer-events-auto flex items-center gap-1.5 overflow-x-auto no-scroll py-1.5 px-0.5"></div>
      </div>

      <!-- Вертикальный блок кнопок управления картой справа (удобно для одной руки) -->
      <div class="absolute right-3 top-1/2 -translate-y-1/2 z-[400] flex flex-col gap-2 pointer-events-auto">
        <button onclick="toggleLayer()" title="Спутник / Схема" class="dm-btn lg-glass lg-press w-11 h-11 rounded-2xl flex flex-col items-center justify-center">
          <span id="layer-icon" class="leading-none"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8"/><path d="M3.6 15h16.8"/><path d="M12 3a13 13 0 0 1 0 18"/><path d="M12 3a13 13 0 0 0 0 18"/></svg></span>
          <span id="layer-label" class="text-[9px] font-bold leading-none mt-0.5">Спутн.</span>
        </button>
        <button onclick="stopFollowAndFitAll()" title="Показать все объекты" class="dm-btn lg-glass lg-press w-11 h-11 rounded-2xl flex flex-col items-center justify-center">
          <span class="leading-none"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.95" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg></span>
          <span class="text-[9px] font-bold leading-none mt-0.5">Все</span>
        </button>
        <button id="btn-my-loc" onclick="requestMyLocation()" title="Моё местоположение" class="dm-btn lg-glass lg-press w-11 h-11 rounded-2xl flex flex-col items-center justify-center text-blue-600">
          <span id="my-loc-icon" class="leading-none"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.95" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg></span>
          <span class="text-[9px] font-bold leading-none mt-0.5">Я</span>
        </button>
        <button id="btn-draw-zone" onclick="toggleDrawZoneMode()" title="Создать свою зону" class="dm-btn lg-glass lg-press w-11 h-11 rounded-2xl flex flex-col items-center justify-center text-indigo-600">
          <span class="leading-none"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.95" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></span>
          <span class="text-[9px] font-bold leading-none mt-0.5">Зона</span>
        </button>
      </div>

      <!-- Панель создания собственной зоны на карте -->
      <div id="draw-zone-bar" class="hidden sheet-anim lg-glass absolute bottom-[88px] left-3 right-3 z-[420] text-slate-900 rounded-3xl px-4 py-3.5 space-y-2.5">
        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0 flex-1">
            <div class="text-xs font-bold flex items-center gap-1.5"><span>✏️</span><span>Новая зона</span></div>
            <div id="draw-zone-hint" class="lg-accent-indigo text-[11px] font-medium truncate mt-0.5">Нажмите на карту, чтобы указать центр круга</div>
          </div>
          <div class="dm-seg flex bg-slate-900/10 p-0.5 rounded-xl text-[11px] font-semibold shrink-0">
            <button type="button" id="draw-mode-circle" onclick="setDrawMode('circle')" class="lg-press px-2.5 py-1 rounded-lg bg-gradient-to-r from-indigo-500 to-blue-600 text-white shadow-sm">⭕ Круг</button>
            <button type="button" id="draw-mode-polygon" onclick="setDrawMode('polygon')" class="lg-press dm-muted px-2.5 py-1 rounded-lg text-slate-600">⬠ Контур</button>
          </div>
        </div>

        <div id="draw-circle-controls" class="dm-divider flex items-center gap-2.5 pt-2 border-t border-slate-900/10">
          <span class="dm-muted text-[11px] text-slate-600 font-semibold shrink-0">Радиус:</span>
          <input id="draw-radius-slider" type="range" min="20" max="500" step="10" value="80" oninput="onDrawRadiusChange(this.value)" class="flex-1 accent-indigo-500 h-1.5">
          <span id="draw-radius-val" class="lg-accent-indigo tabular-nums text-xs font-bold min-w-[46px] text-right">80 м</span>
        </div>

        <div class="dm-divider flex items-center gap-2 pt-2 border-t border-slate-900/10">
          <button type="button" onclick="cancelDrawZoneMode()" class="lg-icon-btn lg-press px-3.5 py-2 rounded-2xl text-xs font-semibold">
            Отмена
          </button>
          <button type="button" id="btn-draw-undo" onclick="undoDrawPoint()" class="hidden lg-icon-btn lg-press lg-accent-amber px-3.5 py-2 rounded-2xl text-xs font-semibold">
            ↩ Назад
          </button>
          <button type="button" id="btn-draw-finish" onclick="openSaveZoneModal()" class="lg-press flex-1 py-2.5 rounded-2xl bg-gradient-to-r from-indigo-600 to-blue-600 text-white text-xs font-bold shadow-md shadow-indigo-600/25">
            Подписать и сохранить ✓
          </button>
        </div>
      </div>

      <!-- Плашка активного маршрута (трека) с блоками статистики и ползунком времени -->
      <div id="track-bar" class="hidden sheet-anim lg-glass absolute bottom-[88px] left-3 right-3 z-[410] text-slate-900 rounded-3xl px-4 py-3 space-y-2.5">
        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0 flex-1">
            <div id="track-title" class="text-xs font-bold truncate">Маршрут</div>
            <div id="track-time-stats" class="dm-muted text-[10px] text-slate-500 font-medium truncate mt-0.5 hidden"></div>
          </div>
          <button onclick="clearRouteFromMap()" class="lg-icon-btn lg-press w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center shrink-0">
            ✕
          </button>
        </div>
        <div class="grid grid-cols-2 gap-1.5">
          <div class="lg-pill-blue rounded-2xl px-2.5 py-1.5 flex items-center justify-between gap-1.5 min-w-0">
            <span class="lg-pill-lbl text-[10px] uppercase font-bold truncate">Пробег</span>
            <span id="track-stat-dist" class="lg-pill-val tabular-nums text-xs font-bold shrink-0">0 км</span>
          </div>
          <div class="lg-pill-orange rounded-2xl px-2.5 py-1.5 flex items-center justify-between gap-1.5 min-w-0">
            <span class="lg-pill-lbl text-[10px] uppercase font-bold truncate">Рейсы</span>
            <span id="track-stat-trips" class="lg-pill-val tabular-nums text-xs font-bold shrink-0">0</span>
          </div>
          <div class="lg-pill-emerald rounded-2xl px-2.5 py-1.5 flex items-center justify-between gap-1.5 min-w-0">
            <span class="lg-pill-lbl text-[10px] uppercase font-bold truncate">Макс. скор.</span>
            <span id="track-stat-speed" class="lg-pill-val tabular-nums text-xs font-bold shrink-0">0 км/ч</span>
          </div>
          <div class="lg-pill-indigo rounded-2xl px-2.5 py-1.5 flex items-center justify-between gap-1.5 min-w-0">
            <span class="lg-pill-lbl text-[10px] uppercase font-bold truncate">Стоянки</span>
            <span id="track-stat-stops" class="lg-pill-val tabular-nums text-xs font-bold shrink-0">0</span>
          </div>
        </div>
        <div class="dm-divider flex items-center gap-1.5 pt-2 border-t border-slate-900/10">
          <button id="btn-play-route" onclick="togglePlayback()" class="lg-press w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 text-white text-xs font-bold flex items-center justify-center shadow-md shadow-blue-600/25 shrink-0">
            ▶
          </button>
          <button id="btn-play-speed" onclick="cyclePlaybackSpeed()" class="lg-icon-btn lg-press lg-accent-blue h-8 px-2.5 rounded-full text-[11px] font-bold flex items-center justify-center shrink-0 min-w-[36px]">
            1x
          </button>
          <button id="btn-play-follow" onclick="togglePlaybackFollow()" title="Следить за точкой" class="lg-press w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 text-white flex items-center justify-center shadow-md shadow-blue-600/25 shrink-0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="7"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/></svg>
          </button>
          <input id="route-slider" type="range" min="0" max="0" value="0" oninput="onPlaybackSlide(this.value)" class="flex-1 accent-blue-500 h-1.5">
          <div id="route-play-info" class="lg-icon-btn tabular-nums text-[11px] font-mono font-bold px-2.5 py-1 rounded-full shrink-0 text-center min-w-[68px]">--:--:--</div>
        </div>
      </div>

      <!-- Плашка выбранного объекта: название, время, статус + карточки топлива, веса и скорости -->
      <div id="follow-bar" class="hidden sheet-anim lg-glass absolute bottom-[88px] left-3 right-3 z-[400] text-slate-900 rounded-3xl px-4 py-3 space-y-2.5">
        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0 flex-1" onclick="panToSelectedNow()">
            <div class="flex items-center gap-1.5">
              <span id="follow-dot" class="w-2.5 h-2.5 rounded-full shrink-0 bg-emerald-400 shadow-sm"></span>
              <span id="follow-name" class="text-xs font-bold truncate">Объект</span>
            </div>
            <div id="follow-meta" class="dm-muted text-[11px] text-slate-500 truncate mt-0.5">00:00:00</div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <button id="btn-follow-toggle" onclick="toggleFollowMode()" title="Вести объект" class="lg-press w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 text-white flex items-center justify-center shadow-md shadow-blue-600/25">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="7"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/></svg>
            </button>
            <button id="btn-follow-fav" onclick="toggleFavoriteSelected()" title="В избранное" class="lg-icon-btn lg-press w-7 h-7 rounded-full text-amber-500 text-sm flex items-center justify-center">
              ☆
            </button>
            <button onclick="openCtxForSelected()" title="Меню и трек" class="lg-icon-btn lg-press w-7 h-7 rounded-full text-sm font-bold flex items-center justify-center">
              ⋯
            </button>
            <button onclick="clearSelection()" title="Закрыть" class="lg-icon-btn lg-press w-7 h-7 rounded-full text-xs font-bold flex items-center justify-center">
              ✕
            </button>
          </div>
        </div>
        <div class="dm-divider grid grid-cols-3 gap-1.5 pt-2 border-t border-slate-900/10">
          <div id="follow-fuel-box" onclick="openInfoForSelected()" class="lg-pill-amber lg-press rounded-2xl px-2 py-1.5 flex items-center justify-center gap-1.5 min-w-0 cursor-pointer">
            <span class="text-xs leading-none shrink-0">⛽</span>
            <div class="min-w-0 text-left">
              <div class="lg-pill-lbl text-[9px] uppercase leading-none font-bold">Топливо</div>
              <div id="follow-fuel" class="lg-pill-val tabular-nums text-[11px] font-bold truncate leading-tight mt-0.5">—</div>
            </div>
          </div>
          <div id="follow-weight-box" onclick="openInfoForSelected()" class="lg-pill-indigo lg-press rounded-2xl px-2 py-1.5 flex items-center justify-center gap-1.5 min-w-0 cursor-pointer">
            <span class="text-xs leading-none shrink-0">⚖️</span>
            <div class="min-w-0 text-left">
              <div class="lg-pill-lbl text-[9px] uppercase leading-none font-bold">Вес</div>
              <div id="follow-weight" class="lg-pill-val tabular-nums text-[11px] font-bold truncate leading-tight mt-0.5">—</div>
            </div>
          </div>
          <div id="follow-belaz-box" onclick="openSelectedExcavatorZone()" class="hidden col-span-2 lg-pill-orange lg-press rounded-2xl px-2.5 py-1.5 flex items-center justify-center gap-2 min-w-0 cursor-pointer">
            <span class="text-sm leading-none shrink-0">🚚</span>
            <div class="min-w-0 text-left">
              <div id="follow-belaz-label" class="lg-pill-lbl text-[9px] uppercase leading-none font-bold">БелАЗов в радиусе</div>
              <div id="follow-belaz-count" class="lg-pill-val text-[11px] font-bold truncate leading-tight mt-0.5">0 шт.</div>
            </div>
          </div>
          <div id="follow-speed-box" onclick="openInfoForSelected()" class="lg-pill-emerald lg-press rounded-2xl px-2 py-1.5 flex items-center justify-center gap-1.5 min-w-0 cursor-pointer">
            <span class="text-xs leading-none shrink-0">⚡</span>
            <div class="min-w-0 text-left">
              <div class="lg-pill-lbl text-[9px] uppercase leading-none font-bold">Скорость</div>
              <div id="follow-speed" class="lg-pill-val tabular-nums text-[11px] font-bold truncate leading-tight mt-0.5">0 км/ч</div>
            </div>
          </div>
          <div id="follow-trips-box" onclick="openRouteForSelected()" class="col-span-3 lg-pill-blue lg-press rounded-2xl px-3 py-1.5 grid grid-cols-2 items-center gap-2 min-w-0 cursor-pointer">
            <div class="flex items-center justify-between gap-1.5 min-w-0 pr-2 border-r border-blue-500/25">
              <div class="flex items-center gap-1 min-w-0">
                <span class="text-xs leading-none shrink-0">🚛</span>
                <span id="follow-trips-label" class="lg-pill-lbl text-[9px] uppercase leading-none font-bold truncate">Рейсы (№1)</span>
              </div>
              <span id="follow-trips-val" class="lg-pill-val tabular-nums text-[11px] font-bold shrink-0">—</span>
            </div>
            <div class="flex items-center justify-between gap-1.5 min-w-0 pl-0.5">
              <div class="flex items-center gap-1 min-w-0">
                <span class="text-xs leading-none shrink-0">🛣️</span>
                <span class="lg-pill-lbl text-[9px] uppercase leading-none font-bold truncate">Пробег</span>
              </div>
              <span id="follow-dist-val" class="lg-pill-val tabular-nums text-[11px] font-bold shrink-0">—</span>
            </div>
          </div>
        </div>
      </div>

      <div id="map" class="flex-1"></div>
    </section>

    <!-- ОБЪЕКТЫ -->
    <section id="tab-objects" class="dm-bg absolute inset-0 flex flex-col hidden z-[2]">
      <header class="dm-surface lg-glass mx-3 mt-3 rounded-3xl px-4 pt-3.5 pb-3 shrink-0">
        <div class="flex items-center justify-between gap-2 mb-2">
          <h1 class="text-lg font-bold truncate">Объекты <span id="obj-count" class="text-slate-400">(0)</span></h1>
          <div class="flex items-center gap-2 shrink-0">
            <button id="btn-obj-filter" onclick="openMapFilterModal()" class="dm-input px-2.5 py-1.5 rounded-xl bg-slate-100 active:bg-slate-200 text-xs font-semibold flex items-center gap-1.5 border border-transparent">
              <span class="flex items-center"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="10" y1="18" x2="14" y2="18"/></svg></span><span>Фильтр</span><span id="obj-filter-badge" class="hidden bg-blue-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none"></span>
            </button>
            <button onclick="manualRefresh()" class="text-blue-600 text-sm font-semibold">Обновить</button>
          </div>
        </div>
        <div class="relative mb-2">
          <input id="search" type="text" placeholder="Поиск по названию или адресу..." oninput="renderList()"
            class="dm-input w-full bg-slate-100 text-sm rounded-xl pl-3.5 pr-9 py-2 outline-none focus:ring-2 focus:ring-blue-500 border border-transparent">
          <button id="search-clear" onclick="clearListSearch()"
            class="hidden absolute right-2.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full bg-slate-300 text-slate-700 text-[11px] font-bold flex items-center justify-center">
            ✕
          </button>
        </div>

        <!-- Фильтр по типу техники и избранным -->
        <div class="flex items-center gap-1.5 overflow-x-auto no-scroll mb-2 pb-0.5 text-[11px] font-semibold">
          <button id="ft-all" onclick="setTypeFilter('all')" class="shrink-0 px-2.5 py-1.5 rounded-xl bg-blue-600 text-white">Все типы</button>
          <button id="ft-fav" onclick="setTypeFilter('fav')" class="dm-input shrink-0 px-2.5 py-1.5 rounded-xl bg-slate-100 text-slate-600">⭐ Избранные</button>
          <button id="ft-exc" onclick="setTypeFilter('exc')" class="dm-input shrink-0 px-2.5 py-1.5 rounded-xl bg-slate-100 text-slate-600">⛏️ Экскаваторы</button>
          <button id="ft-fuel" onclick="setTypeFilter('fuel')" class="dm-input shrink-0 px-2.5 py-1.5 rounded-xl bg-slate-100 text-slate-600">⛽ Заправки</button>
          <button id="ft-other" onclick="setTypeFilter('other')" class="dm-input shrink-0 px-2.5 py-1.5 rounded-xl bg-slate-100 text-slate-600">🚚 Техника</button>
        </div>

        <div class="grid grid-cols-2 gap-1.5">
          <div class="dm-seg grid grid-cols-3 bg-slate-100 p-0.5 rounded-xl text-[11px] font-medium">
            <button id="fc-all" onclick="setConn('all')" class="py-1.5 rounded-lg bg-blue-600 text-white">Все</button>
            <button id="fc-online" onclick="setConn('online')" class="py-1.5 rounded-lg text-slate-500">Связь</button>
            <button id="fc-offline" onclick="setConn('offline')" class="py-1.5 rounded-lg text-slate-500">Нет</button>
          </div>
          <div class="dm-seg grid grid-cols-3 bg-slate-100 p-0.5 rounded-xl text-[11px] font-medium">
            <button id="fa-all" onclick="setAct('all')" class="py-1.5 rounded-lg bg-blue-600 text-white">Все</button>
            <button id="fa-active" onclick="setAct('active')" class="py-1.5 rounded-lg text-slate-500">Едет</button>
            <button id="fa-inactive" onclick="setAct('inactive')" class="py-1.5 rounded-lg text-slate-500">Стоит</button>
          </div>
        </div>
      </header>
      <div id="list" class="dm-list flex-1 overflow-y-auto px-3 pt-2.5 pb-28 space-y-2"></div>
    </section>

    <!-- НАСТРОЙКИ / ВХОД -->
    <section id="tab-settings" class="dm-bg absolute inset-0 overflow-y-auto px-4 pt-6 z-[2]">
      <div class="max-w-md mx-auto pb-28">
        <div class="text-center mb-6 relative">
          <div class="w-24 h-24 mx-auto rounded-full bg-blue-500/20 blur-2xl absolute left-1/2 -translate-x-1/2 -top-3 pointer-events-none"></div>
          <div class="relative w-18 h-18 w-16 h-16 mx-auto rounded-3xl bg-white shadow-xl shadow-blue-500/15 border border-white/80 flex items-center justify-center p-2.5 mb-3">
            <svg viewBox="0 0 100 92" class="w-full h-full" xmlns="http://www.w3.org/2000/svg" aria-label="Кузбассразрезуголь">
              <polygon points="10,84 46,12 58,36 44,64 72,64 82,84" fill="#000000"/>
              <polygon points="52,58 69,24 86,58" fill="#009be0"/>
            </svg>
          </div>
          <h1 class="text-xl font-extrabold tracking-tight">КУЗБАССРАЗРЕЗУГОЛЬ</h1>
          <p class="dm-muted text-xs text-slate-500">Прямое подключение с iPhone</p>
        </div>

        <div class="dm-surface lg-card rounded-3xl p-4 space-y-3.5 mb-4">
          <div>
            <label class="dm-muted block text-xs font-semibold text-slate-600 mb-1">Сервер (.asmx)</label>
            <input id="in-server" type="url" value="${safeServer}" class="dm-input w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-blue-500">
          </div>
          <div>
            <label class="dm-muted block text-xs font-semibold text-slate-600 mb-1">Логин</label>
            <input id="in-login" type="text" value="${safeLogin}" class="dm-input w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-blue-500">
          </div>
          <div>
            <label class="dm-muted block text-xs font-semibold text-slate-600 mb-1">Пароль</label>
            <input id="in-pass" type="password" value="${safePass}" class="dm-input w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-blue-500">
          </div>
          <button id="btn-go" onclick="triggerConnect()" class="w-full bg-gradient-to-r from-blue-600 to-indigo-600 active:scale-[0.98] text-white font-semibold py-3.5 rounded-2xl shadow-lg shadow-blue-600/25 transition">
            Подключить
          </button>
        </div>

        <!-- Поделиться файлом приложения с другом -->
        <div class="dm-surface lg-card rounded-3xl p-4 mb-4">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="text-sm font-bold">Передать приложение другу</div>
              <div class="dm-muted text-[11px] text-slate-500 mt-0.5">Файл <span class="font-mono">Кузбассразрезуголь.js</span> (без вашего пароля)</div>
            </div>
            <button id="btn-share-app" onclick="shareAppFile()" class="shrink-0 bg-gradient-to-r from-emerald-500 to-teal-600 active:scale-95 text-white text-xs font-semibold px-4 py-2.5 rounded-2xl shadow-md shadow-emerald-600/20 transition inline-flex items-center gap-1.5">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg><span>Отправить</span>
            </button>
          </div>
        </div>

        <!-- Настройки мониторинга и карты (с переключателями в стиле iOS) -->
        <div class="dm-surface lg-card rounded-3xl p-4 space-y-3.5 mb-4">
          <div class="dm-muted text-xs font-bold text-slate-800 uppercase tracking-wide">Настройки карты и обновления</div>

          <div class="flex items-center justify-between gap-3">
            <div>
              <div class="text-sm font-semibold">Автообновление</div>
              <div class="dm-muted text-[11px] text-slate-500">Обновлять позиции в фоне</div>
            </div>
            <label class="ios-switch">
              <input id="opt-autorefresh" type="checkbox" onchange="onPrefsChange()">
              <span class="ios-slider"></span>
            </label>
          </div>

          <div>
            <div class="dm-muted text-xs font-semibold text-slate-600 mb-1.5">Выбранный объект — обновлять каждые</div>
            <div class="dm-seg grid grid-cols-4 bg-slate-100 p-1 rounded-xl text-[11px] font-semibold">
              <button type="button" id="sel-1" onclick="setSelInterval(1)" class="py-1.5 rounded-lg">1 сек</button>
              <button type="button" id="sel-2" onclick="setSelInterval(2)" class="py-1.5 rounded-lg">2 сек</button>
              <button type="button" id="sel-3" onclick="setSelInterval(3)" class="py-1.5 rounded-lg">3 сек</button>
              <button type="button" id="sel-5" onclick="setSelInterval(5)" class="py-1.5 rounded-lg">5 сек</button>
            </div>
          </div>

          <div>
            <div class="dm-muted text-xs font-semibold text-slate-600 mb-1.5">Остальные объекты — обновлять каждые</div>
            <div class="dm-seg grid grid-cols-5 bg-slate-100 p-1 rounded-xl text-[11px] font-semibold">
              <button type="button" id="int-1" onclick="setIntervalOpt(1)" class="py-1.5 rounded-lg">1 сек</button>
              <button type="button" id="int-3" onclick="setIntervalOpt(3)" class="py-1.5 rounded-lg">3 сек</button>
              <button type="button" id="int-5" onclick="setIntervalOpt(5)" class="py-1.5 rounded-lg">5 сек</button>
              <button type="button" id="int-10" onclick="setIntervalOpt(10)" class="py-1.5 rounded-lg">10 сек</button>
              <button type="button" id="int-30" onclick="setIntervalOpt(30)" class="py-1.5 rounded-lg">30 сек</button>
            </div>
          </div>

          <div class="dm-divider flex items-center justify-between gap-3 pt-2 border-t border-slate-100">
            <div>
              <div class="text-sm font-semibold">Плавное движение маркеров</div>
              <div class="dm-muted text-[11px] text-slate-500">Анимация между точками GPS без рывков</div>
            </div>
            <label class="ios-switch">
              <input id="opt-smooth" type="checkbox" onchange="onPrefsChange()">
              <span class="ios-slider"></span>
            </label>
          </div>

          <div class="dm-divider flex items-center justify-between gap-3 pt-2 border-t border-slate-100">
            <div>
              <div class="text-sm font-semibold">Прогноз движения (убрать задержку)</div>
              <div class="dm-muted text-[11px] text-slate-500">Упреждение по скорости и курсу между пакетами GPS</div>
            </div>
            <label class="ios-switch">
              <input id="opt-predict" type="checkbox" onchange="onPrefsChange()">
              <span class="ios-slider"></span>
            </label>
          </div>

          <div>
            <div class="dm-muted text-xs font-semibold text-slate-600 mb-1.5">Частота кадров анимации</div>
            <div class="dm-seg grid grid-cols-2 bg-slate-100 p-1 rounded-xl text-[11px] font-semibold">
              <button type="button" id="fps-30" onclick="setFps(30)" class="py-1.5 rounded-lg">30 к/с (экономия)</button>
              <button type="button" id="fps-60" onclick="setFps(60)" class="py-1.5 rounded-lg">60 к/с (плавно)</button>
            </div>
          </div>

          <div class="dm-divider flex items-center justify-between gap-3 pt-2 border-t border-slate-100">
            <div>
              <div class="text-sm font-semibold">Вести выбранный объект</div>
              <div class="dm-muted text-[11px] text-slate-500">Держать машину в центре карты</div>
            </div>
            <label class="ios-switch">
              <input id="opt-follow" type="checkbox" onchange="onPrefsChange()">
              <span class="ios-slider"></span>
            </label>
          </div>

          <div class="dm-divider flex items-center justify-between gap-3 pt-2 border-t border-slate-100">
            <div>
              <div class="text-sm font-semibold">Подписи и скорость на карте</div>
              <div class="dm-muted text-[11px] text-slate-500">Скрываются при отдалении (кроме избранных)</div>
            </div>
            <label class="ios-switch">
              <input id="opt-labels" type="checkbox" onchange="onPrefsChange()">
              <span class="ios-slider"></span>
            </label>
          </div>

          <div class="dm-divider flex items-center justify-between gap-3 pt-2 border-t border-slate-100">
            <div>
              <div class="text-sm font-semibold">Геозоны (GetZonesMobile)</div>
              <div class="dm-muted text-[11px] text-slate-500">Отображать участки и базы на карте</div>
            </div>
            <label class="ios-switch">
              <input id="opt-zones" type="checkbox" onchange="onPrefsChange()">
              <span class="ios-slider"></span>
            </label>
          </div>

          <div class="dm-divider flex items-center justify-between gap-3 pt-2 border-t border-slate-100">
            <div>
              <div class="text-sm font-semibold">Зоны экскаваторов и заправок</div>
              <div class="dm-muted text-[11px] text-slate-500">Круги вокруг экскаваторов и АТЗ/АЗС</div>
            </div>
            <label class="ios-switch">
              <input id="opt-dynzones" type="checkbox" onchange="onPrefsChange()">
              <span class="ios-slider"></span>
            </label>
          </div>

          <div>
            <div class="dm-muted text-xs font-semibold text-slate-600 mb-1.5">Радиус зон экскаваторов и заправок</div>
            <div class="dm-seg grid grid-cols-4 bg-slate-100 p-1 rounded-xl text-[11px] font-semibold">
              <button type="button" id="rad-40" onclick="setDynRadius(40)" class="py-1.5 rounded-lg">40 м</button>
              <button type="button" id="rad-60" onclick="setDynRadius(60)" class="py-1.5 rounded-lg">60 м</button>
              <button type="button" id="rad-100" onclick="setDynRadius(100)" class="py-1.5 rounded-lg">100 м</button>
              <button type="button" id="rad-150" onclick="setDynRadius(150)" class="py-1.5 rounded-lg">150 м</button>
            </div>
          </div>

          <div class="dm-divider flex items-center justify-between gap-3 pt-2 border-t border-slate-100">
            <div>
              <div class="text-sm font-semibold">Показывать «Нет связи»</div>
              <div class="dm-muted text-[11px] text-slate-500">Отображать неактивные маркеры</div>
            </div>
            <label class="ios-switch">
              <input id="opt-offline" type="checkbox" onchange="onPrefsChange()">
              <span class="ios-slider"></span>
            </label>
          </div>

          <div class="dm-divider flex items-center justify-between gap-3 pt-2 border-t border-slate-100">
            <div>
              <div class="text-sm font-semibold">Тёмная тема (ночной режим)</div>
              <div class="dm-muted text-[11px] text-slate-500">Удобно для работы в машине ночью</div>
            </div>
            <label class="ios-switch">
              <input id="opt-darkmode" type="checkbox" onchange="onPrefsChange()">
              <span class="ios-slider"></span>
            </label>
          </div>

          <div class="dm-divider pt-2 border-t border-slate-100">
            <div class="flex items-center justify-between gap-2 mb-1.5">
              <div>
                <div class="text-sm font-semibold">Размер интерфейса</div>
                <div class="dm-muted text-[11px] text-slate-500">Для слабовидящих (текст, кнопки, карта)</div>
              </div>
              <span id="ui-scale-label" class="text-[11px] font-bold text-blue-600 shrink-0">100% · Обычный</span>
            </div>
            <div class="dm-seg grid grid-cols-5 bg-slate-100 p-1 rounded-xl font-bold items-center">
              <button type="button" id="scale-1" onclick="setUiScale(1)" style="font-size:11px" class="py-1.5 rounded-lg leading-none">1</button>
              <button type="button" id="scale-2" onclick="setUiScale(1.12)" style="font-size:13px" class="py-1.5 rounded-lg leading-none">2</button>
              <button type="button" id="scale-3" onclick="setUiScale(1.25)" style="font-size:15px" class="py-1.5 rounded-lg leading-none">3</button>
              <button type="button" id="scale-4" onclick="setUiScale(1.38)" style="font-size:17px" class="py-1.5 rounded-lg leading-none">4</button>
              <button type="button" id="scale-5" onclick="setUiScale(1.5)" style="font-size:19px" class="py-1.5 rounded-lg leading-none">5</button>
            </div>
          </div>

          <div class="dm-divider flex items-center justify-between gap-3 pt-2 border-t border-slate-100">
            <div>
              <div class="text-sm font-semibold">Автовход при запуске</div>
              <div class="dm-muted text-[11px] text-slate-500">Сразу подключаться и открывать карту</div>
            </div>
            <label class="ios-switch">
              <input id="opt-autoconnect" type="checkbox" onchange="onPrefsChange()">
              <span class="ios-slider"></span>
            </label>
          </div>
        </div>

        <div class="dm-surface lg-card rounded-3xl p-4">
          <div class="flex items-center justify-between mb-2">
            <span class="dm-muted text-xs font-bold text-slate-700">Журнал подключения</span>
            <button onclick="copyLog()" class="text-xs text-blue-600 font-semibold">Копировать</button>
          </div>
          <pre id="log-box" class="bg-slate-900 text-emerald-400 text-[11px] font-mono p-3 rounded-xl h-40 overflow-y-auto whitespace-pre-wrap break-all select-text">Нажмите «Подключить» для входа на сервер.</pre>
          <div id="perf-line" class="dm-muted text-[10px] text-slate-400 mt-1 font-mono"></div>
        </div>
      </div>
    </section>

  </main>

  <!-- ПЛАВАЮЩАЯ НИЖНЯЯ ПАНЕЛЬ LIQUID GLASS -->
  <nav class="fixed left-4 right-4 z-[500] pointer-events-none" style="bottom: max(env(safe-area-inset-bottom, 0px), 12px);">
    <div class="lg-dock pointer-events-auto relative grid grid-cols-3 h-[60px] max-w-sm mx-auto rounded-full p-[5px]">
      <div id="nav-pill" class="lg-pill-indicator" style="transform: translateX(200%);"></div>
      <button id="nav-map" onclick="switchTab('map')" class="nav-btn flex flex-col items-center justify-center text-slate-500 text-[11px] font-medium active:scale-95">
        <span class="nav-ico mb-0.5"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/></svg></span><span>Карта</span>
      </button>
      <button id="nav-objects" onclick="switchTab('objects')" class="nav-btn flex flex-col items-center justify-center text-slate-500 text-[11px] font-medium active:scale-95">
        <span class="nav-ico mb-0.5"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M10 17h4V5H2v12h3"/><path d="M14 9h4l4 4v4h-3"/><circle cx="7.5" cy="17.5" r="2.2"/><circle cx="17.5" cy="17.5" r="2.2"/></svg></span><span>Объекты</span>
      </button>
      <button id="nav-settings" onclick="switchTab('settings')" class="nav-btn nav-btn-active flex flex-col items-center justify-center text-blue-600 text-[11px] font-medium active:scale-95">
        <span class="nav-ico mb-0.5"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span><span>Настройки</span>
      </button>
    </div>
  </nav>

  <script>
    let map, street, sat, isSat = false;
    let vehicles = [], markers = {};
    let prevCoords = {};
    let sensorCache = {};
    let tripsCache = {};
    let connF = 'all', actF = 'all', typeF = 'all';
    let isConnected = false;
    let isFetching = false;
    let refreshFailCount = 0;
    let connectionState = 'offline';
    let hasInitialFit = false;
    let selectedId = null;
    let refreshTimer = null;
    let prefs = ${prefsJson};
    let ctxTargetId = null;
    let infoTargetId = null;
    let suppressNextClick = false;
    let favSuppressClick = false;
    let favDragState = null;
    let lastRouteDebug = '';

    let routeLayerGroup = null;
    let zonesLayerGroup = null;
    let dynZonesLayerGroup = null;
    let customZonesLayerGroup = null;
    let drawPreviewLayerGroup = null;
    let serverZones = [];
    let dynamicZones = [];
    let zonesLoaded = false;
    let myLoc = null;
    let myLocMarker = null;

    let isDrawingZone = false;
    let drawMode = 'circle';
    let drawCenter = null;
    let drawRadius = 80;
    let drawPoints = [];
    let editingZoneId = null;
    let selectedZoneColor = '#2563eb';

    let routePoints = [];
    let routePlayMarker = null;
    let playbackTimer = null;
    let playbackIdx = 0;
    let activeRouteObjectId = null;
    let playbackSpeed = 1;
    let playbackFollow = true;
    const PLAYBACK_SPEEDS = [1, 2, 5, 10];

    let nativeQueue = [];
    let nativePumpActive = false;
    let fetchWatchdog = null;

    // --- плавная анимация и раздельные интервалы ---
    let animSet = new Set();
    let animRaf = 0;
    let lastFrameTs = 0;
    let followPausedUntil = 0;
    let lastSelApply = 0;
    let lastOthersApply = 0;
    let lastReqTs = 0;
    let lastMoveEndTs = 0;
    let moveEndTimer = null;
    let dynCircles = {};
    let fpsCount = 0;
    let fpsT0 = 0;
    let perfFps = 0;

    function selMs() { return Math.max(500, (Number(prefs.selInterval) || 1) * 1000); }
    function othMs() { return Math.max(1000, (Number(prefs.refreshInterval) || 3) * 1000); }

    function scheduleNextRefresh() {
      clearTimeout(refreshTimer);
      refreshTimer = null;
      if (!isConnected || !prefs.autoRefresh) return;
      const period = (selectedId && !activeRouteObjectId) ? Math.min(selMs(), othMs()) : othMs();
      const wait = Math.max(50, period - (performance.now() - lastReqTs));
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        if (activeRouteObjectId) { scheduleNextRefresh(); return; }
        triggerFastRefresh(true);
      }, wait);
    }

    function pauseFollow() {
      followPausedUntil = performance.now() + 6000;
      setTimeout(kickAnim, 6100);
    }

    function metersBetween(lat1, lng1, lat2, lng2) {
      const dLat = (lat2 - lat1) * 111320;
      const dLng = (lng2 - lng1) * 111320 * Math.cos(lat1 * Math.PI / 180);
      return Math.sqrt(dLat * dLat + dLng * dLng);
    }

    function unwrapAngle(prev, next) {
      if (prev === undefined || prev === null) return next;
      const d = ((next - prev) % 360 + 540) % 360 - 180;
      return prev + d;
    }

    function kickAnim() {
      if (!animRaf) animRaf = requestAnimationFrame(animFrame);
    }

    function calcVelDegPerSec(v) {
      if (!prefs.predictMotion || !v || !v.active || (v.speed || 0) <= 2) return { vLat: 0, vLng: 0 };
      if (v.course === null || v.course === undefined || isNaN(v.course)) return { vLat: 0, vLng: 0 };
      const mps = Math.min(v.speed, 95) / 3.6;
      const rad = v.course * Math.PI / 180;
      const cosLat = Math.max(0.1, Math.cos(v.lat * Math.PI / 180));
      return {
        vLat: (mps * Math.cos(rad)) / 111320,
        vLng: (mps * Math.sin(rad)) / (111320 * cosLat)
      };
    }

    function setMarkerTarget(m, v, now) {
      const vel = calcVelDegPerSec(v);
      const st = m._an;
      if (!st) {
        m._an = {
          rLat: v.lat, rLng: v.lng,
          tLat: v.lat, tLng: v.lng,
          fixTs: now, lastStepTs: now,
          vLat: vel.vLat, vLng: vel.vLng
        };
        if (vel.vLat || vel.vLng) animSet.add(v.id);
        return;
      }

      const moved = (v.lat !== st.tLat || v.lng !== st.tLng);
      st.vLat = vel.vLat;
      st.vLng = vel.vLng;

      if (!moved) {
        if ((vel.vLat || vel.vLng) && (now - st.fixTs) < 2800) {
          animSet.add(v.id);
        }
        return;
      }

      const jump = metersBetween(st.rLat, st.rLng, v.lat, v.lng);
      st.fixTs = now;
      st.tLat = v.lat;
      st.tLng = v.lng;

      if (!prefs.smooth || jump > 1200 || !m._icon) {
        st.rLat = v.lat;
        st.rLng = v.lng;
        st.lastStepTs = now;
        m.setLatLng([v.lat, v.lng]);
        if (vel.vLat || vel.vLng) animSet.add(v.id);
        else animSet.delete(v.id);
        return;
      }

      st.lastStepTs = now;
      animSet.add(v.id);
      m._icon.style.willChange = 'transform';
    }

    function placeMarker(m, lat, lng, draw) {
      const ll = L.latLng(lat, lng);
      m._latlng = ll;
      if (draw && m._icon) m._setPos(map.latLngToLayerPoint(ll));
      if (draw && m._popup && m.isPopupOpen()) {
        try { m._popup._latlng = ll; m._popup._updatePosition(); } catch (e) {}
      }
    }

    function finishAnims() {
      animSet.forEach(id => {
        const m = markers[id];
        if (m && m._an) {
          m._an.rLat = m._an.tLat;
          m._an.rLng = m._an.tLng;
          placeMarker(m, m._an.tLat, m._an.tLng, !map._animatingZoom);
          if (m._icon) m._icon.style.willChange = '';
        }
      });
      animSet.clear();
    }

    function fireMoveEndThrottled(now) {
      if (now - lastMoveEndTs > 500) {
        lastMoveEndTs = now;
        map.fire('moveend');
        return;
      }
      if (!moveEndTimer) {
        moveEndTimer = setTimeout(() => {
          moveEndTimer = null;
          lastMoveEndTs = performance.now();
          if (map) map.fire('moveend');
        }, 520);
      }
    }

    // держим выбранную машину в центре: движение карты синхронно с маркером, каждый кадр
    function followStep(now) {
      if (!prefs.followSelected || !selectedId || activeRouteObjectId || isDrawingZone) return false;
      const m = markers[selectedId];
      if (!m || !map) return false;
      if (map._animatingZoom || (map._panAnim && map._panAnim._inProgress)) return true;
      if (now < followPausedUntil) return false;
      const p = map.latLngToContainerPoint(m._latlng);
      const sz = map.getSize();
      let dx = p.x - sz.x / 2;
      let dy = p.y - sz.y / 2;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1.0) return false;
      if (dist > 35) { dx *= 0.18; dy *= 0.18; }
      if (typeof map._rawPanBy === 'function') {
        map._rawPanBy(L.point(Math.round(dx), Math.round(dy)));
        map.fire('move');
        fireMoveEndThrottled(now);
      } else {
        map.panBy([dx, dy], { animate: false });
      }
      return dist > 35;
    }

    function animFrame(ts) {
      animRaf = 0;
      if (!map) return;
      const fps = Number(prefs.fps) === 30 ? 30 : 60;
      if (ts - lastFrameTs < 1000 / fps - 4) {
        animRaf = requestAnimationFrame(animFrame);
        return;
      }
      const frameDt = lastFrameTs ? Math.min(0.1, Math.max(0.008, (ts - lastFrameTs) / 1000)) : 0.016;
      lastFrameTs = ts;
      fpsCount++;
      if (ts - fpsT0 >= 1000) { perfFps = fpsCount; fpsCount = 0; fpsT0 = ts; }

      const tabMap = document.getElementById('tab-map');
      const visible = tabMap && !tabMap.classList.contains('hidden') && !document.hidden;
      if (!visible) {
        finishAnims();
        return;
      }

      const zooming = Boolean(map._animatingZoom);
      if (animSet.size) {
        const bounds = map.getBounds().pad(0.25);
        // Плавная экспоненциальная подстройка без рывков и откатов (tau = 0.42 сек)
        const alpha = 1 - Math.exp(-frameDt / 0.42);
        const MAX_PREDICT_SEC = 2.4;
        animSet.forEach(id => {
          const m = markers[id];
          if (!m || !m._an) { animSet.delete(id); return; }
          const st = m._an;
          const hasVel = prefs.predictMotion && (st.vLat !== 0 || st.vLng !== 0);
          let predSec = 0;
          if (hasVel) {
            const rawSec = Math.max(0, (ts - st.fixTs) / 1000);
            // Мягкое затухание упреждения, чтобы маркер не «улетал» на поворотах и остановках
            predSec = Math.min(MAX_PREDICT_SEC, 1.8 * (1 - Math.exp(-rawSec / 1.8)));
          }
          const goalLat = st.tLat + st.vLat * predSec;
          const goalLng = st.tLng + st.vLng * predSec;

          st.rLat += (goalLat - st.rLat) * alpha;
          st.rLng += (goalLng - st.rLng) * alpha;

          const draw = !zooming && (id === selectedId || bounds.contains([st.rLat, st.rLng]));
          placeMarker(m, st.rLat, st.rLng, draw);

          const remMeters = metersBetween(st.rLat, st.rLng, goalLat, goalLng);
          const stillPredicting = hasVel && ((ts - st.fixTs) / 1000 < 2.8);
          if (remMeters < 0.25 && !stillPredicting) {
            st.rLat = goalLat;
            st.rLng = goalLng;
            placeMarker(m, goalLat, goalLng, draw);
            animSet.delete(id);
            if (m._icon) m._icon.style.willChange = '';
          }
        });
      }

      let needDistAnim = false;
      if (selectedId && !activeRouteObjectId && !isDrawingZone) {
        const tc = tripsCache[selectedId];
        if (tc && tc.loaded) {
          const targetKm = (tc.baseDistKm || 0) + (tc.liveDistKm || 0);
          if (tc.dispDistKm === undefined) tc.dispDistKm = targetKm;
          const diff = targetKm - tc.dispDistKm;
          if (Math.abs(diff) > 0.002) {
            const distAlpha = 1 - Math.exp(-frameDt / 0.5);
            tc.dispDistKm += diff * distAlpha;
            needDistAnim = true;
          } else {
            tc.dispDistKm = targetKm;
          }
          const distEl = document.getElementById('follow-dist-val');
          if (distEl) {
            const txt = tc.dispDistKm.toFixed(1) + ' км';
            if (distEl.textContent !== txt) distEl.textContent = txt;
          }
        }
      }

      const needFollow = followStep(ts);
      if (animSet.size || needFollow || needDistAnim) animRaf = requestAnimationFrame(animFrame);
    }

    function sendNative(url) {
      nativeQueue.push(url);
      if (!nativePumpActive) pumpNativeQueue();
    }

    function pumpNativeQueue() {
      if (!nativeQueue.length) {
        nativePumpActive = false;
        return;
      }
      nativePumpActive = true;
      const nextUrl = nativeQueue.shift();
      window.location.href = nextUrl;
      setTimeout(pumpNativeQueue, 20);
    }

    function armFetchWatchdog() {
      clearTimeout(fetchWatchdog);
      fetchWatchdog = setTimeout(() => {
        isFetching = false;
        const b = document.getElementById('btn-map-refresh');
        if (b) b.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>';
        scheduleNextRefresh();
      }, 18000);
    }

    window.addEventListener('DOMContentLoaded', () => {
      map = L.map('map', { zoomControl: false, attributionControl: false, preferCanvas: true }).setView([56.8389, 60.6057], 6);
      street = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, keepBuffer: 4, updateInterval: 150 });
      sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, keepBuffer: 4, updateInterval: 150 });
      zonesLayerGroup = L.layerGroup().addTo(map);
      dynZonesLayerGroup = L.layerGroup().addTo(map);
      customZonesLayerGroup = L.layerGroup().addTo(map);
      drawPreviewLayerGroup = L.layerGroup().addTo(map);
      routeLayerGroup = L.layerGroup().addTo(map);

      applyBaseTileLayer();
      applyDarkMode();
      applyUiScale();
      renderCustomZones();

      map.on('click', (e) => {
        if (isDrawingZone) {
          handleDrawMapClick(e.latlng);
          return;
        }
        document.getElementById('map-search-results').classList.add('hidden');
        document.getElementById('map-search').blur();
      });
      map.on('zoomend', updateZoomLabels);
      map.on('zoomend', kickAnim);
      map.on('dragstart', pauseFollow);
      const mapElInit = document.getElementById('map');
      mapElInit.addEventListener('touchstart', (e) => { if (e.touches && e.touches.length > 1) pauseFollow(); }, { passive: true });
      mapElInit.addEventListener('wheel', pauseFollow, { passive: true });
      document.addEventListener('visibilitychange', () => { if (!document.hidden) kickAnim(); });
      updateZoomLabels();

      initModalSwipeDismiss();
      syncPrefsUI();
      renderList();
      switchTab('settings');
      if (prefs.autoConnect) {
        setTimeout(() => triggerConnect(), 250);
      }
    });

    function updateZoomLabels() {
      const mapEl = document.getElementById('map');
      if (!map || !mapEl) return;
      mapEl.classList.toggle('hide-labels', map.getZoom() < 12);
    }

    function applyBaseTileLayer() {
      if (!map) return;
      [street, sat].forEach(l => {
        if (map.hasLayer(l)) map.removeLayer(l);
      });
      const mapEl = document.getElementById('map');
      const iconEl = document.getElementById('layer-icon');
      const lblEl = document.getElementById('layer-label');
      mapEl.classList.toggle('sat-tiles', Boolean(isSat));
      if (isSat) {
        sat.addTo(map);
        mapEl.classList.remove('dark-tiles');
        if (iconEl) iconEl.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/></svg>';
        if (lblEl) lblEl.textContent = 'Схема';
      } else {
        street.addTo(map);
        mapEl.classList.toggle('dark-tiles', Boolean(prefs.darkMode));
        if (iconEl) iconEl.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8"/><path d="M3.6 15h16.8"/><path d="M12 3a13 13 0 0 1 0 18"/><path d="M12 3a13 13 0 0 0 0 18"/></svg>';
        if (lblEl) lblEl.textContent = 'Спутн.';
      }
    }

    function applyDarkMode() {
      document.body.classList.toggle('dark-mode', Boolean(prefs.darkMode));
      applyBaseTileLayer();
    }

    const UI_SCALES = [
      { id: 1, val: 1, label: '100% · Обычный' },
      { id: 2, val: 1.12, label: '112% · Крупный' },
      { id: 3, val: 1.25, label: '125% · Большой' },
      { id: 4, val: 1.38, label: '138% · Очень большой' },
      { id: 5, val: 1.5, label: '150% · Максимум' }
    ];

    function applyUiScale() {
      const scale = Number(prefs.uiScale) || 1;
      document.documentElement.style.setProperty('--ui-scale', String(scale));
      if (map) setTimeout(() => map.invalidateSize(), 120);
    }

    function setUiScale(val) {
      prefs.uiScale = Number(val) || 1;
      applyUiScale();
      syncPrefsUI();
      persistPrefs();
      renderMarkers(true);
    }

    function syncPrefsUI() {
      const setChk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = Boolean(val); };
      setChk('opt-autorefresh', prefs.autoRefresh);
      setChk('opt-follow', prefs.followSelected);
      setChk('opt-labels', prefs.showLabels);
      setChk('opt-zones', prefs.showZones);
      setChk('opt-dynzones', prefs.showDynamicZones !== false);
      setChk('opt-offline', prefs.showOffline);
      setChk('opt-darkmode', prefs.darkMode);
      setChk('opt-autoconnect', prefs.autoConnect);

      const curInt = Number(prefs.refreshInterval) || 3;
      [1, 3, 5, 10, 30].forEach(sec => {
        const btn = document.getElementById('int-' + sec);
        if (btn) {
          btn.className = curInt === sec
            ? 'py-1.5 rounded-lg bg-blue-600 text-white shadow-sm'
            : 'py-1.5 rounded-lg text-slate-500';
        }
      });

      const curSel = Number(prefs.selInterval) || 1;
      [1, 2, 3, 5].forEach(sec => {
        const btn = document.getElementById('sel-' + sec);
        if (btn) {
          btn.className = curSel === sec
            ? 'py-1.5 rounded-lg bg-blue-600 text-white shadow-sm'
            : 'py-1.5 rounded-lg text-slate-500';
        }
      });
      setChk('opt-smooth', prefs.smooth !== false);
      setChk('opt-predict', prefs.predictMotion !== false);
      const curFps = Number(prefs.fps) === 30 ? 30 : 60;
      [30, 60].forEach(f => {
        const btn = document.getElementById('fps-' + f);
        if (btn) {
          btn.className = curFps === f
            ? 'py-1.5 rounded-lg bg-blue-600 text-white shadow-sm'
            : 'py-1.5 rounded-lg text-slate-500';
        }
      });

      const curRad = Number(prefs.dynZoneRadius) || 60;
      [40, 60, 100, 150].forEach(rad => {
        const btn = document.getElementById('rad-' + rad);
        if (btn) {
          btn.className = curRad === rad
            ? 'py-1.5 rounded-lg bg-blue-600 text-white shadow-sm'
            : 'py-1.5 rounded-lg text-slate-500';
        }
      });

      const curScale = Number(prefs.uiScale) || 1;
      let matchedScale = UI_SCALES[0];
      UI_SCALES.forEach(sc => {
        const isActive = Math.abs(curScale - sc.val) < 0.02;
        if (isActive) matchedScale = sc;
        const btn = document.getElementById('scale-' + sc.id);
        if (btn) {
          btn.className = isActive
            ? 'py-1.5 rounded-lg bg-blue-600 text-white shadow-sm leading-none'
            : 'py-1.5 rounded-lg text-slate-500 leading-none';
        }
      });
      const scaleLbl = document.getElementById('ui-scale-label');
      if (scaleLbl) scaleLbl.textContent = matchedScale.label;

      updateFilterButtonBadge();
      updateFollowBar();
    }

    function setDynRadius(rad) {
      prefs.dynZoneRadius = Number(rad) || 60;
      syncPrefsUI();
      persistPrefs();
      renderDynamicZones();
      renderMarkers(false);
      renderList();
      renderFavoritesBar();
      updateFollowBar();
    }

    function setIntervalOpt(sec) {
      prefs.refreshInterval = Number(sec) || 3;
      syncPrefsUI();
      persistPrefs();
      restartAutoRefresh();
    }

    function setSelInterval(sec) {
      prefs.selInterval = Number(sec) || 1;
      syncPrefsUI();
      persistPrefs();
      restartAutoRefresh();
    }

    function setFps(f) {
      prefs.fps = Number(f) === 30 ? 30 : 60;
      syncPrefsUI();
      persistPrefs();
    }

    function onPrefsChange() {
      const prevZones = prefs.showZones;
      const getChk = (id, defVal) => { const el = document.getElementById(id); return el ? el.checked : defVal; };
      prefs.autoRefresh = getChk('opt-autorefresh', true);
      prefs.followSelected = getChk('opt-follow', true);
      prefs.showLabels = getChk('opt-labels', true);
      prefs.showZones = getChk('opt-zones', false);
      prefs.showDynamicZones = getChk('opt-dynzones', true);
      prefs.showOffline = getChk('opt-offline', true);
      prefs.darkMode = getChk('opt-darkmode', false);
      prefs.autoConnect = getChk('opt-autoconnect', false);
      prefs.smooth = getChk('opt-smooth', true);
      prefs.predictMotion = getChk('opt-predict', true);
      if (!prefs.smooth) finishAnims();

      applyDarkMode();
      persistPrefs();
      restartAutoRefresh();
      renderDynamicZones();
      renderServerZones();
      renderMarkers(true);
      renderList();
      renderFavoritesBar();
      updateFollowBar();

      if (prefs.showZones && !prevZones && isConnected && !zonesLoaded) {
        requestZones();
      }
    }

    function persistPrefs() {
      sendNative('sputnik://saveprefs?data=' + encodeURIComponent(JSON.stringify(prefs)));
    }

    function restartAutoRefresh() {
      scheduleNextRefresh();
    }

    function switchTab(t) {
      const tabs = ['map', 'objects', 'settings'];
      const idx = tabs.indexOf(t);
      const pill = document.getElementById('nav-pill');
      if (pill && idx >= 0) {
        pill.style.transform = 'translateX(' + (idx * 100) + '%)';
      }
      tabs.forEach(id => {
        const sec = document.getElementById('tab-' + id);
        const isTarget = id === t;
        sec.classList.toggle('hidden', !isTarget);
        if (isTarget && id !== 'map') {
          sec.classList.remove('tab-anim');
          void sec.offsetWidth;
          sec.classList.add('tab-anim');
        }
        const nav = document.getElementById('nav-' + id);
        nav.classList.toggle('nav-btn-active', isTarget);
        nav.classList.toggle('text-blue-600', isTarget);
        nav.classList.toggle('text-slate-500', !isTarget);
      });
      if (t === 'map' && map) setTimeout(() => map.invalidateSize(), 100);
      if (t === 'objects') renderList();
    }

    function toggleLayer() {
      isSat = !isSat;
      applyBaseTileLayer();
    }

    function triggerConnect() {
      if (isFetching) return;
      isFetching = true;
      armFetchWatchdog();
      const s = document.getElementById('in-server').value.trim();
      const l = document.getElementById('in-login').value.trim();
      const p = document.getElementById('in-pass').value;
      const btn = document.getElementById('btn-go');
      btn.textContent = 'Подключение...';
      btn.disabled = true;
      document.getElementById('log-box').textContent = 'Отправка запроса с iPhone...';
      sendNative('sputnik://connect?server=' + encodeURIComponent(s) + '&login=' + encodeURIComponent(l) + '&password=' + encodeURIComponent(p));
    }

    function triggerSilentReconnect() {
      if (isFetching) return;
      isFetching = true;
      connectionState = 'reconnecting';
      updateStatusBadge();
      armFetchWatchdog();
      const s = document.getElementById('in-server').value.trim();
      const l = document.getElementById('in-login').value.trim();
      const p = document.getElementById('in-pass').value;
      sendNative('sputnik://reconnect?server=' + encodeURIComponent(s) + '&login=' + encodeURIComponent(l) + '&password=' + encodeURIComponent(p));
    }

    function manualRefresh() {
      if (!isConnected) {
        triggerConnect();
        return;
      }
      triggerFastRefresh(false);
    }

    function triggerFastRefresh(isSilent) {
      if (isFetching) return;
      isFetching = true;
      armFetchWatchdog();
      lastReqTs = performance.now();
      if (!isSilent) {
        const b = document.getElementById('btn-map-refresh');
        if (b) b.innerHTML = '<svg class="lg-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>';
      }
      // если остальным ещё рано обновляться — просим у телефона только выбранный объект (лёгкий ответ)
      const othDue = !isSilent || (lastReqTs - lastOthersApply >= othMs() - 200);
      const only = (!othDue && selectedId) ? selectedId : '';
      sendNative('sputnik://refresh?silent=' + (isSilent ? '1' : '0') + (only ? '&only=' + encodeURIComponent(only) : ''));
    }

    function calcBearing(lat1, lon1, lat2, lon2) {
      const toRad = d => d * Math.PI / 180;
      const toDeg = r => r * 180 / Math.PI;
      const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
      const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2))
        - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
      return (toDeg(Math.atan2(y, x)) + 360) % 360;
    }

    function enrichCourses(newList) {
      newList.forEach(v => {
        const prev = prevCoords[v.id];
        if (v.course === null || v.course === undefined || isNaN(v.course)) {
          if (prev && (Math.abs(prev.lat - v.lat) > 0.00004 || Math.abs(prev.lng - v.lng) > 0.00004)) {
            v.course = calcBearing(prev.lat, prev.lng, v.lat, v.lng);
          } else if (prev && prev.course !== null && prev.course !== undefined) {
            v.course = prev.course;
          }
        }
        prevCoords[v.id] = { lat: v.lat, lng: v.lng, course: v.course };
      });
    }

    window.onNativeResult = function(res) {
      isFetching = false;
      clearTimeout(fetchWatchdog);
      const btn = document.getElementById('btn-go');
      btn.textContent = 'Подключить';
      btn.disabled = false;

      if (res.logs && res.logs.length) {
        document.getElementById('log-box').textContent = res.logs.join('\\n');
      }

      if (res.ok) {
        isConnected = true;
        refreshFailCount = 0;
        connectionState = 'online';
        zonesLoaded = false;
        vehicles = res.vehicles || [];
        enrichCourses(vehicles);
        lastSelApply = lastOthersApply = performance.now();
        updateStatusBadge();
        renderDynamicZones();
        renderMarkers(true);
        renderList();
        renderFavoritesBar();
        switchTab('map');
        if (!hasInitialFit && !selectedId) {
          hasInitialFit = true;
          setTimeout(fitAll, 180);
        } else if (selectedId && prefs.followSelected) {
          panToSelectedNow();
        }
        setTimeout(requestZones, 350);
        restartAutoRefresh();
        showToast('Загружено объектов: ' + vehicles.length, 'bg-emerald-600');
      } else {
        connectionState = 'error';
        updateStatusBadge();
        showToast(res.error || 'Ошибка подключения', 'bg-red-600');
      }
    };

    window.onNativeReconnectResult = function(res) {
      isFetching = false;
      clearTimeout(fetchWatchdog);
      if (res && res.ok) {
        refreshFailCount = 0;
        connectionState = 'online';
        vehicles = res.vehicles || [];
        enrichCourses(vehicles);
        updateStatusBadge();
        renderDynamicZones();
        renderMarkers(false);
        renderList();
        renderFavoritesBar();
        updateFollowBar();
        if (selectedId && prefs.followSelected && !activeRouteObjectId) {
          panToSelectedNow();
        }
        showToast('Связь с сервером восстановлена', 'bg-emerald-600');
      } else {
        connectionState = 'error';
        updateStatusBadge();
      }
    };

    window.onNativeRefreshResult = function(res, isSilent) {
      isFetching = false;
      clearTimeout(fetchWatchdog);
      const b = document.getElementById('btn-map-refresh');
      if (b) b.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>';
      scheduleNextRefresh();

      if (res && res.ok) {
        refreshFailCount = 0;
        connectionState = 'online';
        const now = performance.now();
        let othersApplied = false;

        if (res.partial) {
          const nv = (res.vehicles || [])[0];
          if (nv) {
            const i = vehicles.findIndex(x => x.id === nv.id);
            if (i >= 0) {
              if (!nv.rawFields && vehicles[i].rawFields) nv.rawFields = vehicles[i].rawFields;
              enrichCourses([nv]);
              vehicles[i] = nv;
              accumulateLiveDistance(nv);
              updateSingleMarker(nv, now);
            }
          }
          lastSelApply = now;
          updateStatusBadge();
        } else {
          const list = res.vehicles || [];
          const oldById = {};
          vehicles.forEach(x => { oldById[x.id] = x; });
          const selDue = now - lastSelApply >= selMs() - 200;
          const othDue = now - lastOthersApply >= othMs() - 200;
          const accepted = [];
          let selTaken = false;
          vehicles = list.map(nv => {
            const old = oldById[nv.id];
            const isSel = nv.id === selectedId;
            if (!old || (isSel && selDue) || (!isSel && othDue)) {
              if (!nv.rawFields && old && old.rawFields) nv.rawFields = old.rawFields;
              accepted.push(nv);
              if (isSel) selTaken = true;
              return nv;
            }
            return old;
          });
          enrichCourses(accepted);
          if (selTaken && selectedId) {
            const svDist = vehicles.find(x => x.id === selectedId);
            if (svDist) accumulateLiveDistance(svDist);
          }
          if (othDue) { lastOthersApply = now; othersApplied = true; }
          if (selTaken) lastSelApply = now;

          updateStatusBadge();
          if (othersApplied) {
            renderDynamicZones();
            renderMarkers(false);
            renderList();
            renderFavoritesBar();
          } else if (selTaken && selectedId) {
            const sv = vehicles.find(x => x.id === selectedId);
            if (sv) updateSingleMarker(sv, now);
          }
        }
        updateFollowBar();
        kickAnim();
        if (selectedId && !activeRouteObjectId) {
          fetchSensorsForSelected(selectedId, false);
          fetchTripsForSelected(selectedId, false);
        }
        const pl = document.getElementById('perf-line');
        if (pl && res.netMs !== undefined) {
          pl.textContent = '⏱ сеть ' + res.netMs + ' мс · разбор ' + res.parseMs + ' мс · '
            + Math.round((res.bytes || 0) / 1024) + ' КБ · анимация ' + perfFps + ' к/с';
        }
        if (!isSilent) {
          showToast('Обновлено (' + vehicles.length + ')', 'bg-emerald-600');
        }
      } else {
        refreshFailCount++;
        if (refreshFailCount >= 3) {
          refreshFailCount = 0;
          triggerSilentReconnect();
        } else {
          connectionState = 'error';
          updateStatusBadge();
          if (!isSilent) {
            showToast((res && res.error) || 'Не удалось обновить', 'bg-red-600');
          }
        }
      }
    };

    // ==================== ТИПЫ ТЕХНИКИ, УМНЫЕ ГЕОЗОНЫ, ЭКСКАВАТОРЫ И ЗАПРАВКИ ====================
    const _typeCache = {};
    function _getTypeFlags(v) {
      const nm = (v && v.name) ? v.name : '';
      let f = _typeCache[nm];
      if (!f) {
        const fuel = /атз|азс|топлив|заправ|бензовоз|цистерн|гсм|fuel|tanker/i.test(nm);
        const exc = !fuel && /экс\\.?|экг|hitachi|komatsu\\s*pc|liebherr\\s*r|wk-|cat\\s*6|p&h|pc\\d|ex\\d|rh\\d|экскав/i.test(nm);
        const belaz = !fuel && !exc && /белаз|belaz/i.test(nm);
        const bull = !fuel && !exc && !belaz && /бульдоз|бульд\\.?|т-?\\s?170|т-?\\s?330|т-?\\s?500|т-?\\s?25|т-?\\s?35|d\\s?375|d\\s?275|d\\s?155|d\\s?65|d\\s?85|d\\s?9|d\\s?10|d\\s?11|sd\\s?\\d|shantui|чтз|четра|komatsu\\s*d|cat\\s*d|liebherr\\s*pr|б-?10/i.test(nm);
        const grader = !fuel && !exc && !belaz && !bull && /грейдер|автогрейд|аг-?\\d|дз-?\\d|гс-?\\d|gd\\s?\\d|cat\\s*14|cat\\s*16|cat\\s*24|komatsu\\s*gd|sem\\s*9|xcmg\\s*gr/i.test(nm);
        const cat = fuel ? 'fuel' : (exc ? 'excavator' : (belaz ? 'belaz' : (bull ? 'bulldozer' : (grader ? 'grader' : 'other'))));
        f = { fuel, exc, belaz, bull, grader, cat };
        _typeCache[nm] = f;
      }
      return f;
    }

    function isExcavator(v) { return _getTypeFlags(v).exc; }
    function isFuelStation(v) { return _getTypeFlags(v).fuel; }
    function isBelaz(v) { return _getTypeFlags(v).belaz; }
    function isBulldozer(v) { return _getTypeFlags(v).bull; }
    function isGrader(v) { return _getTypeFlags(v).grader; }

    const MAP_TYPE_DEFS = [
      { key: 'belaz', label: 'БелАЗ', emoji: '🚚' },
      { key: 'excavator', label: 'Экскаватор', emoji: '⛏️' },
      { key: 'bulldozer', label: 'Бульдозер', emoji: '🚜' },
      { key: 'grader', label: 'Грейдер', emoji: '🚧' },
      { key: 'fuel', label: 'Заправки (АТЗ/АЗС)', emoji: '⛽' },
      { key: 'other', label: 'Прочие', emoji: '🔧' }
    ];

    function getMapTypeFilter() {
      if (!prefs.mapTypeFilter || typeof prefs.mapTypeFilter !== 'object') {
        prefs.mapTypeFilter = { belaz: true, excavator: true, bulldozer: true, grader: true, fuel: true, other: true };
      }
      return prefs.mapTypeFilter;
    }

    function getVehicleCategory(v) {
      if (isFuelStation(v)) return 'fuel';
      if (isExcavator(v)) return 'excavator';
      if (isBelaz(v)) return 'belaz';
      if (isBulldozer(v)) return 'bulldozer';
      if (isGrader(v)) return 'grader';
      return 'other';
    }

    function isTypeEnabled(catKey) {
      const f = getMapTypeFilter();
      return f[catKey] !== false;
    }

    function isVehicleAllowedByFilter(v) {
      return isTypeEnabled(getVehicleCategory(v));
    }

    function updateFilterButtonBadge() {
      const badge = document.getElementById('obj-filter-badge');
      const btn = document.getElementById('btn-obj-filter');
      if (!badge || !btn) return;
      const total = MAP_TYPE_DEFS.length;
      const activeCount = MAP_TYPE_DEFS.filter(d => isTypeEnabled(d.key)).length;
      if (activeCount < total) {
        badge.textContent = activeCount + '/' + total;
        badge.classList.remove('hidden');
        btn.classList.add('border-blue-500', 'text-blue-600');
      } else {
        badge.classList.add('hidden');
        btn.classList.remove('border-blue-500', 'text-blue-600');
      }
    }

    function renderMapFilterModalList() {
      const box = document.getElementById('map-filter-list');
      if (!box) return;
      const counts = { belaz: 0, excavator: 0, bulldozer: 0, grader: 0, fuel: 0, other: 0 };
      vehicles.forEach(v => {
        const cat = getVehicleCategory(v);
        if (counts[cat] !== undefined) counts[cat]++;
      });
      box.innerHTML = MAP_TYPE_DEFS.map(d => {
        const checked = isTypeEnabled(d.key);
        return '<label class="dm-input flex items-center justify-between gap-3 px-3.5 py-3 rounded-2xl bg-slate-50 border border-slate-200/70 cursor-pointer active:opacity-80">'
          + '<div class="flex items-center gap-3 min-w-0">'
          + '<input type="checkbox" ' + (checked ? 'checked' : '') + ' onchange="toggleMapTypeFilter(\\'' + d.key + '\\', this.checked)" class="w-5 h-5 accent-blue-600 rounded shrink-0">'
          + '<span class="text-lg leading-none shrink-0">' + d.emoji + '</span>'
          + '<span class="text-sm font-semibold truncate">' + esc(d.label) + '</span>'
          + '</div>'
          + '<span class="dm-muted text-xs font-bold text-slate-500 shrink-0">' + counts[d.key] + '</span>'
          + '</label>';
      }).join('');
    }

    function openMapFilterModal() {
      renderMapFilterModalList();
      const _m_map_filter_modal = document.getElementById('map-filter-modal'); if (_m_map_filter_modal._closeTimer) clearTimeout(_m_map_filter_modal._closeTimer); _m_map_filter_modal.classList.remove('modal-closing', 'hidden');
    }

    function closeMapFilterModal() {
      closeModalAnimated('map-filter-modal');
    }

    function toggleMapTypeFilter(catKey, isChecked) {
      const f = getMapTypeFilter();
      f[catKey] = Boolean(isChecked);
      persistPrefs();
      updateFilterButtonBadge();
      renderDynamicZones();
      renderMarkers(false);
      renderList();
    }

    function setAllMapTypes(val) {
      const f = getMapTypeFilter();
      MAP_TYPE_DEFS.forEach(d => { f[d.key] = Boolean(val); });
      persistPrefs();
      renderMapFilterModalList();
      updateFilterButtonBadge();
      renderDynamicZones();
      renderMarkers(false);
      renderList();
    }

    function countBelazNearExcavator(exc, radius) {
      const r = Number(radius) || Number(prefs.dynZoneRadius) || 60;
      return vehicles.filter(other =>
        other.id !== exc.id &&
        other.online &&
        isBelaz(other) &&
        (haversineKm(exc.lat, exc.lng, other.lat, other.lng) * 1000 <= r)
      ).length;
    }

    function getVehicleEmoji(v) {
      if (isFuelStation(v)) return '⛽';
      if (isExcavator(v)) return '⛏️';
      return '🚚';
    }

    function isVehicleMassOff(v) {
      if (!v) return false;
      if (!v.online) return true;
      const cached = sensorCache[v.id];
      if (cached && cached.massOff === true) return true;
      const pm = parsePointTimeMs(v.lastTime);
      if (!isNaN(pm) && (Date.now() - pm) > 15 * 60000) return true;
      return false;
    }

    function isVehicleOffOrOffline(v) {
      if (!v) return false;
      if (!v.online) return true;
      if ((v.speed || 0) > 2) return false;
      const cached = sensorCache[v.id];
      if (cached && (cached.massOff === true || cached.engineOff === true)) return true;
      if (cached && cached.engineOff === false) return false;
      if (v.engineOff === true) return true;
      const pm = parsePointTimeMs(v.lastTime);
      if (!isNaN(pm) && (Date.now() - pm) > 15 * 60000) return true;
      return false;
    }

    function formatStopClock(ms) {
      if (!ms || isNaN(ms)) return '—';
      const d = new Date(ms);
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      const hhmm = pad(d.getHours()) + ':' + pad(d.getMinutes());
      if (d.getDate() === now.getDate() && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) {
        return hhmm;
      }
      return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + ' ' + hhmm;
    }

    function formatLongDuration(ms) {
      if (ms === null || ms === undefined || isNaN(ms) || ms < 0) return '—';
      const totalMin = Math.floor(ms / 60000);
      if (totalMin < 1) return '<1м';
      const days = Math.floor(totalMin / 1440);
      const hours = Math.floor((totalMin % 1440) / 60);
      const mins = totalMin % 60;
      if (days > 0) return days + 'д ' + hours + 'ч';
      if (hours > 0) return hours + 'ч ' + mins + 'м';
      return mins + 'м';
    }

    function getStopInfoForVehicle(v) {
      const massOff = isVehicleMassOff(v);
      const statusLabel = massOff ? 'Выключена масса' : 'Двигатель заглушен';
      let stopMs = null;

      // 1. Точное время остановки из трека смены (если загружен)
      const tc = tripsCache[v.id];
      if (tc && tc.loaded && tc.stopStartMs && !isNaN(tc.stopStartMs)) {
        stopMs = tc.stopStartMs;
      }

      // 2. Если трек ещё не загружен — проверяем поля сервера или lastTime
      if (!stopMs && v.rawFields) {
        for (const [k, val] of Object.entries(v.rawFields)) {
          if (/^(stoptime|statetime|lastmovetime|stoppedat|idlefrom)$/i.test(k)) {
            const p = parsePointTimeMs(val);
            if (!isNaN(p)) { stopMs = p; break; }
          }
        }
      }
      if (!stopMs) {
        const pm = parsePointTimeMs(v.lastTime);
        if (!isNaN(pm)) stopMs = pm;
      }

      const isLoading = tc && tc.pending && !tc.loaded && !massOff;
      const stopTimeText = stopMs ? formatStopClock(stopMs) : (isLoading ? '...' : '—');
      const durText = stopMs ? formatLongDuration(Math.max(0, Date.now() - stopMs)) : (isLoading ? '...' : '—');
      return { statusLabel, stopTimeText, durText };
    }

    const RED_CROSS_SVG = '<svg width="11" height="11" viewBox="0 0 12 12" style="display:block;flex-shrink:0;"><path d="M2.2 2.2L9.8 9.8M9.8 2.2L2.2 9.8" stroke="#ef4444" stroke-width="2.6" stroke-linecap="round"/></svg>';

    function getColor(v) {
      if (isVehicleOffOrOffline(v)) return '#ef4444';
      if (v.active) return '#22c55e';
      if (isFuelStation(v)) return '#06b6d4';
      if (isExcavator(v)) return '#f97316';
      return '#9333ea';
    }

    function pointInPolygon(lat, lng, poly) {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i][0], yi = poly[i][1];
        const xj = poly[j][0], yj = poly[j][1];
        const intersect = ((yi > lng) !== (yj > lng)) &&
          (lat < (xj - xi) * (lng - yi) / ((yj - yi) || 1e-12) + xi);
        if (intersect) inside = !inside;
      }
      return inside;
    }

    function isVehicleInZone(v, zone) {
      if (!v || !zone) return false;
      if (zone.ownerId && v.id === zone.ownerId) return false;
      if (zone.type === 'circle') {
        if (Math.abs(v.lat - zone.lat) * 110500 > zone.radius) return false;
        const distMeters = haversineKm(v.lat, v.lng, zone.lat, zone.lng) * 1000;
        return distMeters <= zone.radius;
      }
      if (zone.type === 'polygon' && zone.points && zone.points.length >= 3) {
        return pointInPolygon(v.lat, v.lng, zone.points);
      }
      return false;
    }

    function getZonesForVehicle(v) {
      const matched = [];
      for (let i = 0; i < serverZones.length; i++) {
        if (isVehicleInZone(v, serverZones[i])) {
          matched.push({ name: serverZones[i].name, kind: 'server', icon: '🗺️' });
        }
      }
      for (let i = 0; i < dynamicZones.length; i++) {
        if (isVehicleInZone(v, dynamicZones[i])) {
          matched.push({
            name: dynamicZones[i].shortName,
            kind: dynamicZones[i].kind,
            icon: dynamicZones[i].kind === 'fuel' ? '⛽' : '⛏️'
          });
        }
      }
      const czList = Array.isArray(prefs.customZones) ? prefs.customZones : [];
      for (let i = 0; i < czList.length; i++) {
        if (isVehicleInZone(v, czList[i])) {
          matched.push({
            name: czList[i].name,
            kind: 'custom',
            icon: '📌',
            color: czList[i].color || '#2563eb'
          });
        }
      }
      return matched;
    }

    // ==================== ПОЛЬЗОВАТЕЛЬСКИЕ ЗОНЫ (РИСОВАНИЕ И ПОДПИСЬ) ====================
    function getZoneLabelCenter(z) {
      if (z.type === 'circle') return [z.lat, z.lng];
      if (z.points && z.points.length) {
        let sumLat = 0, sumLng = 0;
        for (let i = 0; i < z.points.length; i++) {
          sumLat += z.points[i][0];
          sumLng += z.points[i][1];
        }
        return [sumLat / z.points.length, sumLng / z.points.length];
      }
      return null;
    }

    function renderCustomZones() {
      if (!customZonesLayerGroup) return;
      customZonesLayerGroup.clearLayers();
      const czList = Array.isArray(prefs.customZones) ? prefs.customZones : [];

      czList.forEach(z => {
        const col = z.color || '#2563eb';
        const zoneObj = Object.assign({ kind: 'custom' }, z);
        let layer = null;
        if (z.type === 'circle' && typeof z.lat === 'number' && typeof z.lng === 'number') {
          layer = L.circle([z.lat, z.lng], {
            radius: Number(z.radius) || 80,
            color: col,
            weight: 2.5,
            fillColor: col,
            fillOpacity: 0.2
          }).addTo(customZonesLayerGroup);
        } else if (z.type === 'polygon' && Array.isArray(z.points) && z.points.length >= 3) {
          layer = L.polygon(z.points, {
            color: col,
            weight: 2.5,
            fillColor: col,
            fillOpacity: 0.2
          }).addTo(customZonesLayerGroup);
        }

        if (layer) {
          layer.on('click', (e) => {
            if (isDrawingZone) return;
            L.DomEvent.stopPropagation(e);
            openZoneVehiclesModal(zoneObj);
          });

          const center = getZoneLabelCenter(z);
          if (center) {
            const labelIcon = L.divIcon({
              className: '',
              html: '<div class="custom-zone-label" style="border-color:' + esc(col) + ';"><span>📌</span><span>' + esc(z.name) + '</span></div>',
              iconSize: [0, 0],
              iconAnchor: [0, 0]
            });
            const lblMarker = L.marker(center, { icon: labelIcon, zIndexOffset: 200 }).addTo(customZonesLayerGroup);
            lblMarker.on('click', (e) => {
              if (isDrawingZone) return;
              L.DomEvent.stopPropagation(e);
              openZoneVehiclesModal(zoneObj);
            });
          }
        }
      });
    }

    function toggleDrawZoneMode() {
      if (isDrawingZone) {
        cancelDrawZoneMode();
      } else {
        startDrawZoneMode();
      }
    }

    function startDrawZoneMode() {
      if (activeRouteObjectId) clearRouteFromMap();
      isDrawingZone = true;
      editingZoneId = null;
      drawCenter = null;
      drawPoints = [];
      drawRadius = 80;
      document.getElementById('draw-radius-slider').value = String(drawRadius);
      document.getElementById('draw-radius-val').textContent = drawRadius + ' м';
      setDrawMode('circle');

      const btn = document.getElementById('btn-draw-zone');
      if (btn) btn.classList.add('ring-2', 'ring-indigo-500');
      document.getElementById('draw-zone-bar').classList.remove('hidden');
      updateFollowBar();
      renderDrawPreview();
    }

    function cancelDrawZoneMode() {
      isDrawingZone = false;
      drawCenter = null;
      drawPoints = [];
      if (drawPreviewLayerGroup) drawPreviewLayerGroup.clearLayers();
      const btn = document.getElementById('btn-draw-zone');
      if (btn) btn.classList.remove('ring-2', 'ring-indigo-500');
      document.getElementById('draw-zone-bar').classList.add('hidden');
      updateFollowBar();
    }

    function setDrawMode(mode) {
      drawMode = mode;
      drawCenter = null;
      drawPoints = [];
      document.getElementById('draw-mode-circle').className = mode === 'circle'
        ? 'lg-press px-2.5 py-1 rounded-lg bg-gradient-to-r from-indigo-500 to-blue-600 text-white shadow-sm'
        : 'lg-press dm-muted px-2.5 py-1 rounded-lg text-slate-600';
      document.getElementById('draw-mode-polygon').className = mode === 'polygon'
        ? 'lg-press px-2.5 py-1 rounded-lg bg-gradient-to-r from-indigo-500 to-blue-600 text-white shadow-sm'
        : 'lg-press dm-muted px-2.5 py-1 rounded-lg text-slate-600';
      document.getElementById('draw-circle-controls').classList.toggle('hidden', mode !== 'circle');
      document.getElementById('btn-draw-undo').classList.toggle('hidden', mode !== 'polygon');
      updateDrawHint();
      renderDrawPreview();
    }

    function updateDrawHint() {
      const hint = document.getElementById('draw-zone-hint');
      if (!hint) return;
      if (drawMode === 'circle') {
        hint.textContent = drawCenter
          ? ('Центр выбран • радиус ' + drawRadius + ' м (можно тапнуть в другое место)')
          : 'Нажмите на карту, чтобы указать центр круга';
      } else {
        if (drawPoints.length === 0) hint.textContent = 'Нажимайте на карту, чтобы расставить углы зоны (мин. 3 точки)';
        else if (drawPoints.length < 3) hint.textContent = 'Точек: ' + drawPoints.length + ' (нужно ещё ' + (3 - drawPoints.length) + ')';
        else hint.textContent = 'Точек: ' + drawPoints.length + ' • можно добавить ещё или сохранить';
      }
    }

    function onDrawRadiusChange(val) {
      drawRadius = Number(val) || 80;
      document.getElementById('draw-radius-val').textContent = drawRadius + ' м';
      updateDrawHint();
      renderDrawPreview();
    }

    function handleDrawMapClick(latlng) {
      if (drawMode === 'circle') {
        drawCenter = [latlng.lat, latlng.lng];
      } else {
        drawPoints.push([latlng.lat, latlng.lng]);
      }
      updateDrawHint();
      renderDrawPreview();
    }

    function undoDrawPoint() {
      if (drawPoints.length > 0) {
        drawPoints.pop();
        updateDrawHint();
        renderDrawPreview();
      }
    }

    function renderDrawPreview() {
      if (!drawPreviewLayerGroup) return;
      drawPreviewLayerGroup.clearLayers();
      if (!isDrawingZone) return;

      if (drawMode === 'circle' && drawCenter) {
        L.circle(drawCenter, {
          radius: drawRadius,
          color: '#6366f1',
          weight: 2.5,
          dashArray: '6, 6',
          fillColor: '#6366f1',
          fillOpacity: 0.22
        }).addTo(drawPreviewLayerGroup);
        L.circleMarker(drawCenter, {
          radius: 6,
          color: '#ffffff',
          weight: 2,
          fillColor: '#4f46e5',
          fillOpacity: 1
        }).addTo(drawPreviewLayerGroup);
      } else if (drawMode === 'polygon' && drawPoints.length > 0) {
        if (drawPoints.length >= 3) {
          L.polygon(drawPoints, {
            color: '#6366f1',
            weight: 2.5,
            dashArray: '6, 6',
            fillColor: '#6366f1',
            fillOpacity: 0.22
          }).addTo(drawPreviewLayerGroup);
        } else if (drawPoints.length === 2) {
          L.polyline(drawPoints, {
            color: '#6366f1',
            weight: 2.5,
            dashArray: '6, 6'
          }).addTo(drawPreviewLayerGroup);
        }
        drawPoints.forEach((pt, idx) => {
          L.circleMarker(pt, {
            radius: idx === 0 ? 7 : 5,
            color: '#ffffff',
            weight: 2,
            fillColor: idx === 0 ? '#22c55e' : '#4f46e5',
            fillOpacity: 1
          }).addTo(drawPreviewLayerGroup);
        });
      }
    }

    function selectZoneColor(col) {
      selectedZoneColor = col;
      document.querySelectorAll('#zone-color-picker button').forEach(btn => {
        const active = btn.getAttribute('data-color') === col;
        btn.classList.toggle('ring-4', active);
        btn.classList.toggle('ring-blue-400', active);
        btn.classList.toggle('scale-110', active);
      });
    }

    function openSaveZoneModal() {
      if (drawMode === 'circle' && !drawCenter) {
        showToast('Сначала нажмите на карту, чтобы указать центр зоны', 'bg-amber-500');
        return;
      }
      if (drawMode === 'polygon' && drawPoints.length < 3) {
        showToast('Отметьте минимум 3 точки на карте для контура', 'bg-amber-500');
        return;
      }
      editingZoneId = null;
      document.getElementById('save-zone-title').textContent = 'Подписать зону';
      document.getElementById('save-zone-sub').textContent = drawMode === 'circle'
        ? ('Круг радиусом ' + drawRadius + ' м')
        : ('Контур из ' + drawPoints.length + ' точек');
      document.getElementById('custom-zone-name').value = '';
      selectZoneColor(selectedZoneColor || '#2563eb');
      const _m_save_zone_modal = document.getElementById('save-zone-modal'); if (_m_save_zone_modal._closeTimer) clearTimeout(_m_save_zone_modal._closeTimer); _m_save_zone_modal.classList.remove('modal-closing', 'hidden');
      setTimeout(() => document.getElementById('custom-zone-name').focus(), 100);
    }

    function openEditCustomZone(zoneId) {
      const czList = Array.isArray(prefs.customZones) ? prefs.customZones : [];
      const z = czList.find(item => item.id === zoneId);
      if (!z) return;
      closeZoneModal();
      editingZoneId = z.id;
      document.getElementById('save-zone-title').textContent = 'Изменить зону';
      document.getElementById('save-zone-sub').textContent = 'Новое название и цвет на карте';
      document.getElementById('custom-zone-name').value = z.name || '';
      selectZoneColor(z.color || '#2563eb');
      const _m_save_zone_modal = document.getElementById('save-zone-modal'); if (_m_save_zone_modal._closeTimer) clearTimeout(_m_save_zone_modal._closeTimer); _m_save_zone_modal.classList.remove('modal-closing', 'hidden');
      setTimeout(() => document.getElementById('custom-zone-name').focus(), 100);
    }

    function closeSaveZoneModal() {
      closeModalAnimated('save-zone-modal');
    }

    function saveCustomZone() {
      const nameInput = document.getElementById('custom-zone-name');
      const name = (nameInput.value || '').trim();
      if (!name) {
        showToast('Введите название зоны', 'bg-red-600');
        return;
      }
      if (!Array.isArray(prefs.customZones)) prefs.customZones = [];

      if (editingZoneId) {
        const z = prefs.customZones.find(item => item.id === editingZoneId);
        if (z) {
          z.name = name;
          z.color = selectedZoneColor;
        }
        editingZoneId = null;
        closeSaveZoneModal();
        showToast('Зона обновлена', 'bg-emerald-600');
      } else {
        const newZone = drawMode === 'circle'
          ? {
              id: 'cz_' + Date.now(),
              name: name,
              type: 'circle',
              color: selectedZoneColor,
              lat: drawCenter[0],
              lng: drawCenter[1],
              radius: drawRadius
            }
          : {
              id: 'cz_' + Date.now(),
              name: name,
              type: 'polygon',
              color: selectedZoneColor,
              points: drawPoints.slice()
            };
        prefs.customZones.push(newZone);
        closeSaveZoneModal();
        cancelDrawZoneMode();
        showToast('Зона «' + name + '» сохранена 📌', 'bg-emerald-600');
      }

      persistPrefs();
      renderCustomZones();
      renderMarkers(false);
      renderList();
      renderFavoritesBar();
      updateFollowBar();
    }

    function deleteCustomZone(zoneId) {
      if (!Array.isArray(prefs.customZones)) return;
      prefs.customZones = prefs.customZones.filter(z => z.id !== zoneId);
      closeZoneModal();
      persistPrefs();
      renderCustomZones();
      renderMarkers(false);
      renderList();
      renderFavoritesBar();
      updateFollowBar();
      showToast('Зона удалена', 'bg-slate-700');
    }

    function formatVehicleZonesShort(v) {
      const zs = getZonesForVehicle(v);
      if (!zs.length) return '';
      return zs.slice(0, 2).map(z => z.icon + ' ' + z.name).join(' • ');
    }

    function renderDynamicZones() {
      const radius = Number(prefs.dynZoneRadius) || 60;
      dynamicZones = [];

      vehicles.forEach(v => {
        if (!v.online) return;
        if (isFuelStation(v)) {
          dynamicZones.push({
            key: 'dyn_fuel_' + v.id,
            ownerId: v.id,
            type: 'circle',
            kind: 'fuel',
            name: 'Заправка: ' + v.name,
            shortName: v.name,
            lat: v.lat,
            lng: v.lng,
            radius: radius,
            color: '#06b6d4'
          });
        } else if (isExcavator(v)) {
          dynamicZones.push({
            key: 'dyn_exc_' + v.id,
            ownerId: v.id,
            type: 'circle',
            kind: 'excavator',
            name: 'Экскаватор: ' + v.name,
            shortName: v.name,
            lat: v.lat,
            lng: v.lng,
            radius: radius,
            color: '#f97316'
          });
        }
      });

      if (!dynZonesLayerGroup) return;
      const showZ = prefs.showDynamicZones && !activeRouteObjectId;
      const keepKeys = {};
      if (showZ) {
        dynamicZones.forEach(z => {
          if (!isTypeEnabled(z.kind === 'fuel' ? 'fuel' : 'excavator')) return;
          let inside = 0;
          for (let i = 0; i < vehicles.length; i++) {
            if (isVehicleInZone(vehicles[i], z)) inside++;
          }
          const wt = inside > 0 ? 2.5 : 1.5;
          const fo = inside > 0 ? 0.24 : 0.12;
          let c = dynCircles[z.key];
          if (!c) {
            c = L.circle([z.lat, z.lng], {
              radius: z.radius,
              color: z.color,
              weight: wt,
              dashArray: z.kind === 'excavator' ? '5, 5' : null,
              fillColor: z.color,
              fillOpacity: fo
            }).addTo(dynZonesLayerGroup);
            c.on('click', (e) => {
              L.DomEvent.stopPropagation(e);
              openZoneVehiclesModal(c._zone);
            });
            c._sty = wt + '_' + fo;
            dynCircles[z.key] = c;
          } else {
            const ll = c.getLatLng();
            if (ll.lat !== z.lat || ll.lng !== z.lng) c.setLatLng([z.lat, z.lng]);
            if (c.getRadius() !== z.radius) c.setRadius(z.radius);
            const sty = wt + '_' + fo;
            if (c._sty !== sty) {
              c.setStyle({ weight: wt, fillOpacity: fo });
              c._sty = sty;
            }
          }
          c._zone = z;
          keepKeys[z.key] = true;
        });
      }
      Object.keys(dynCircles).forEach(k => {
        if (!keepKeys[k]) {
          dynZonesLayerGroup.removeLayer(dynCircles[k]);
          delete dynCircles[k];
        }
      });
    }

    function renderServerZones() {
      if (!zonesLayerGroup) return;
      zonesLayerGroup.clearLayers();
      if (!prefs.showZones) return;

      serverZones.forEach((z, idx) => {
        const col = z.color || '#2563eb';
        const zoneObj = Object.assign({ key: 'srv_' + idx, kind: 'server' }, z);
        let layer = null;
        if (z.type === 'circle') {
          layer = L.circle([z.lat, z.lng], { radius: z.radius, color: col, weight: 2, fillColor: col, fillOpacity: 0.16 }).addTo(zonesLayerGroup);
        } else if (z.points && z.points.length >= 3) {
          layer = L.polygon(z.points, { color: col, weight: 2, fillColor: col, fillOpacity: 0.16 }).addTo(zonesLayerGroup);
        }
        if (layer) {
          layer.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            openZoneVehiclesModal(zoneObj);
          });
        }
      });
    }

    function openZoneVehiclesModal(zone) {
      const inside = vehicles.filter(v => isVehicleInZone(v, zone));
      const icon = zone.kind === 'fuel' ? '⛽' : (zone.kind === 'excavator' ? '⛏️' : (zone.kind === 'custom' ? '📌' : '🗺️'));
      document.getElementById('zone-modal-title').textContent = icon + ' ' + zone.name;
      const radText = zone.type === 'circle' ? ('Радиус ' + Math.round(zone.radius) + ' м • ') : '';
      document.getElementById('zone-modal-sub').textContent = radText + 'Техники внутри: ' + inside.length;

      const actionsEl = document.getElementById('zone-modal-actions');
      if (actionsEl) {
        if (zone.kind === 'custom' && zone.id) {
          actionsEl.classList.remove('hidden');
          document.getElementById('btn-zone-edit').onclick = () => openEditCustomZone(zone.id);
          document.getElementById('btn-zone-delete').onclick = () => deleteCustomZone(zone.id);
        } else {
          actionsEl.classList.add('hidden');
        }
      }

      const body = document.getElementById('zone-modal-body');
      if (!inside.length) {
        body.innerHTML = '<div class="py-8 text-center text-xs text-slate-400">Сейчас внутри этой зоны нет другой техники</div>';
      } else {
        body.innerHTML = inside.map(v => {
          const c = getColor(v);
          return '<div onclick="closeZoneModal();selectObject(\\'' + esc(v.id) + '\\', true)" class="flex items-center gap-3 px-2 py-3 active:bg-slate-100/50 rounded-xl cursor-pointer">'
            + '<div class="w-7 h-7 rounded-lg flex items-center justify-center text-xs shrink-0" style="background:' + c + '">' + getVehicleEmoji(v) + '</div>'
            + '<div class="flex-1 min-w-0">'
            + '<div class="text-sm font-semibold truncate">' + esc(v.name) + '</div>'
            + '<div class="dm-muted text-[11px] text-slate-500 truncate">' + esc(v.duration) + ' • ' + esc(v.lastTime) + '</div>'
            + '</div>'
            + '<span class="text-xs font-semibold text-blue-500 shrink-0">Показать →</span>'
            + '</div>';
        }).join('');
      }
      const _m_zone_modal = document.getElementById('zone-modal'); if (_m_zone_modal._closeTimer) clearTimeout(_m_zone_modal._closeTimer); _m_zone_modal.classList.remove('modal-closing', 'hidden');
    }

    function closeZoneModal() {
      closeModalAnimated('zone-modal');
    }

    // ==================== СВОДКА ПАРКА И ОЧЕРЕДЕЙ ====================
    function openSummaryModal() {
      if (!isConnected) {
        switchTab('settings');
        return;
      }
      const moving = vehicles.filter(v => v.online && v.active).length;
      const parked = vehicles.filter(v => v.online && !v.active).length;
      const offline = vehicles.filter(v => !v.online).length;

      document.getElementById('summary-sub').textContent = 'Всего объектов: ' + vehicles.length + ' • Радиус зон: ' + (prefs.dynZoneRadius || 60) + ' м';

      let html = '<div class="grid grid-cols-3 gap-2">'
        + '<div class="bg-emerald-500/10 border border-emerald-500/30 rounded-2xl p-3 text-center">'
        + '<div class="text-xl font-extrabold text-emerald-500">' + moving + '</div>'
        + '<div class="dm-muted text-[11px] font-semibold text-slate-500 mt-0.5">В движении</div>'
        + '</div>'
        + '<div class="bg-purple-500/10 border border-purple-500/30 rounded-2xl p-3 text-center">'
        + '<div class="text-xl font-extrabold text-purple-500">' + parked + '</div>'
        + '<div class="dm-muted text-[11px] font-semibold text-slate-500 mt-0.5">Стоянка</div>'
        + '</div>'
        + '<div class="bg-red-500/10 border border-red-500/30 rounded-2xl p-3 text-center">'
        + '<div class="text-xl font-extrabold text-red-500">' + offline + '</div>'
        + '<div class="dm-muted text-[11px] font-semibold text-slate-500 mt-0.5">Нет связи</div>'
        + '</div>'
        + '</div>';

      const queueRows = dynamicZones.map(z => {
        const inside = vehicles.filter(v => isVehicleInZone(v, z));
        return { zone: z, count: inside.length, inside };
      }).sort((a, b) => b.count - a.count);

      html += '<div>'
        + '<div class="dm-muted text-[11px] font-bold text-slate-400 uppercase mb-2">Очереди у экскаваторов и АТЗ (' + queueRows.length + ')</div>';

      if (!queueRows.length) {
        html += '<div class="dm-input bg-slate-50 rounded-2xl p-4 text-center text-xs text-slate-400 border border-slate-100">Активных экскаваторов и АТЗ на связи не найдено</div>';
      } else {
        html += '<div class="dm-input bg-slate-50 rounded-2xl border border-slate-100 divide-y divide-slate-200/60 overflow-hidden">'
          + queueRows.map(item => {
            const z = item.zone;
            const icon = z.kind === 'fuel' ? '⛽' : '⛏️';
            const badgeCls = item.count > 0
              ? (z.kind === 'fuel' ? 'bg-cyan-500 text-white' : 'bg-orange-500 text-white')
              : 'bg-slate-200 text-slate-500';
            const badgeText = item.count > 0 ? (item.count + ' маш.') : 'Свободен';
            const namesPreview = item.count > 0
              ? '<div class="dm-muted text-[10px] text-slate-500 truncate mt-0.5">' + esc(item.inside.map(x => x.name).join(', ')) + '</div>'
              : '';
            return '<div onclick="focusZoneOwner(\\'' + esc(z.ownerId) + '\\')" class="flex items-center justify-between gap-2 px-3.5 py-2.5 active:bg-slate-200/50 cursor-pointer">'
              + '<div class="min-w-0 flex-1">'
              + '<div class="text-xs font-bold truncate">' + icon + ' ' + esc(z.shortName) + '</div>'
              + namesPreview
              + '</div>'
              + '<span class="text-[11px] font-bold px-2.5 py-1 rounded-xl shrink-0 ' + badgeCls + '">' + badgeText + '</span>'
              + '</div>';
          }).join('')
          + '</div>';
      }
      html += '</div>';

      document.getElementById('summary-body').innerHTML = html;
      const _m_summary_modal = document.getElementById('summary-modal'); if (_m_summary_modal._closeTimer) clearTimeout(_m_summary_modal._closeTimer); _m_summary_modal.classList.remove('modal-closing', 'hidden');
    }

    function closeSummaryModal() {
      closeModalAnimated('summary-modal');
    }

    function focusZoneOwner(ownerId) {
      closeSummaryModal();
      selectObject(ownerId, true);
    }

    function requestZones() {
      if (!isConnected) return;
      sendNative('sputnik://zones');
    }

    window.onNativeZonesResult = function(res) {
      if (res && res.debug) {
        document.getElementById('log-box').textContent += '\\n[Геозоны] ' + res.debug;
      }
      if (res && res.ok && res.zones && res.zones.length > 0) {
        zonesLoaded = true;
        serverZones = res.zones;
        renderServerZones();
        renderMarkers(false);
        renderList();
        renderFavoritesBar();
        updateFollowBar();
        if (prefs.showZones) {
          showToast('Загружено геозон: ' + serverZones.length, 'bg-blue-600');
        }
      } else if (prefs.showZones) {
        if (res && res.error) showToast(res.error, 'bg-slate-700');
        else showToast('На сервере не найдено геозон', 'bg-slate-700');
      }
    };

    // ==================== МОЁ МЕСТОПОЛОЖЕНИЕ И РАССТОЯНИЕ ====================
    function requestMyLocation() {
      const ic = document.getElementById('my-loc-icon');
      if (ic) ic.innerHTML = '<svg class="lg-spin" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';
      sendNative('sputnik://mylocation');
    }

    function haversineKm(lat1, lon1, lat2, lon2) {
      const R = 6371;
      const toRad = d => d * Math.PI / 180;
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function formatDistanceFromMe(v) {
      if (!myLoc || !v) return '';
      const km = haversineKm(myLoc.lat, myLoc.lng, v.lat, v.lng);
      return km < 1 ? Math.round(km * 1000) + ' м' : km.toFixed(1) + ' км';
    }

    window.onNativeLocationResult = function(res) {
      const ic = document.getElementById('my-loc-icon');
      if (ic) ic.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.95" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>';

      if (res && res.ok) {
        myLoc = { lat: res.lat, lng: res.lng };
        const myIcon = L.divIcon({
          className: '',
          html: '<div style="position:relative;width:18px;height:18px;transform:translate(-50%,-50%);">'
            + '<div class="my-loc-pulse"></div>'
            + '<div style="position:absolute;inset:2px;background:#2563eb;border:2.5px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,0.4);"></div>'
            + '</div>',
          iconSize: [0, 0],
          iconAnchor: [0, 0]
        });

        if (myLocMarker) {
          myLocMarker.setLatLng([myLoc.lat, myLoc.lng]);
        } else {
          myLocMarker = L.marker([myLoc.lat, myLoc.lng], { icon: myIcon, zIndexOffset: 900 })
            .addTo(map)
            .bindPopup('<div class="text-xs font-bold text-center">Вы здесь</div>');
        }
        map.setView([myLoc.lat, myLoc.lng], Math.max(map.getZoom(), 14), { animate: true });
        updateFollowBar();
        renderMarkers(false);
        showToast('Ваше местоположение определено', 'bg-blue-600');
      } else {
        showToast((res && res.error) || 'Не удалось получить GPS', 'bg-red-600');
      }
    };

    // ==================== ИЗБРАННЫЕ ОБЪЕКТЫ ====================
    function isFavorite(id) {
      return Array.isArray(prefs.favorites) && prefs.favorites.includes(id);
    }

    function toggleFavorite(id) {
      if (!Array.isArray(prefs.favorites)) prefs.favorites = [];
      const idx = prefs.favorites.indexOf(id);
      if (idx >= 0) {
        prefs.favorites.splice(idx, 1);
        showToast('Удалено из избранного', 'bg-slate-700');
      } else {
        prefs.favorites.push(id);
        showToast('Добавлено в избранное ⭐', 'bg-amber-500');
      }
      persistPrefs();
      renderFavoritesBar();
      renderList();
      renderMarkers(false);
      updateFollowBar();
    }

    function toggleFavoriteSelected() {
      if (selectedId) toggleFavorite(selectedId);
    }

    function toggleFavoriteFromCtx() {
      if (!ctxTargetId) return;
      toggleFavorite(ctxTargetId);
      const favBtn = document.getElementById('ctx-fav-btn');
      if (favBtn) favBtn.textContent = isFavorite(ctxTargetId) ? '★' : '☆';
    }

    function renderFavoritesBar() {
      if (favDragState && favDragState.active) return;
      const bar = document.getElementById('fav-bar');
      if (!bar) return;
      const favIds = Array.isArray(prefs.favorites) ? prefs.favorites : [];
      const favObjs = favIds.map(id => vehicles.find(v => v.id === id)).filter(Boolean);
      if (!favObjs.length) {
        bar.classList.add('hidden');
        bar.innerHTML = '';
        return;
      }
      bar.classList.remove('hidden');
      const radius = Number(prefs.dynZoneRadius) || 60;
      bar.innerHTML = favObjs.map(v => {
        const c = getColor(v);
        const activeRing = v.id === selectedId ? 'ring-2 ring-blue-500' : '';
        let zoneSubHtml = '';

        if (isExcavator(v)) {
          const belazCount = countBelazNearExcavator(v, radius);
          const subColor = belazCount > 0 ? 'text-orange-500' : 'dm-muted text-slate-400';
          zoneSubHtml = '<div class="text-[10px] font-bold ' + subColor + ' truncate leading-tight mt-0.5">'
            + '🚚 БелАЗов: ' + belazCount
            + '</div>';
        } else {
          const matchedZones = getZonesForVehicle(v);
          const excZone = matchedZones.find(z => z.kind === 'excavator');
          const fuelZone = matchedZones.find(z => z.kind === 'fuel');
          const customZone = matchedZones.find(z => z.kind === 'custom');
          const targetZone = excZone || fuelZone || customZone;
          if (targetZone) {
            const subCls = targetZone.kind === 'fuel'
              ? 'text-cyan-500'
              : (targetZone.kind === 'excavator' ? 'text-orange-500' : '');
            const subStyle = targetZone.kind === 'custom'
              ? ' style="color:' + esc(targetZone.color || '#2563eb') + '"'
              : '';
            zoneSubHtml = '<div class="text-[10px] font-bold ' + subCls + ' truncate leading-tight mt-0.5"' + subStyle + '>'
              + targetZone.icon + ' ' + esc(targetZone.name)
              + '</div>';
          }
        }

        const statusDotHtml = isVehicleOffOrOffline(v)
          ? '<span class="w-3 h-3 shrink-0 flex items-center justify-center" title="Заглушен / нет связи">' + RED_CROSS_SVG + '</span>'
          : '<span class="w-2 h-2 rounded-full shrink-0" style="background:' + c + '"></span>';

        return '<button data-fav-id="' + esc(v.id) + '" onclick="onFavTileClick(\\'' + esc(v.id) + '\\')" class="fav-tile dm-btn lg-glass lg-press shrink-0 rounded-2xl px-3 py-1.5 text-left flex flex-col justify-center active:scale-95 ' + activeRing + '">'
          + '<div class="flex items-center gap-1.5 text-[11px] font-semibold">'
          + '<span class="text-amber-500 leading-none">★</span>'
          + statusDotHtml
          + '<span class="max-w-[115px] truncate">' + esc(v.name) + '</span>'
          + (v.active ? '<span class="text-[10px] text-emerald-500 font-bold">' + Math.round(v.speed) + '</span>' : '')
          + '</div>'
          + zoneSubHtml
          + '</button>';
      }).join('');

      bindFavoritesDrag(bar);
    }

    function onFavTileClick(id) {
      if (favSuppressClick) return;
      selectObject(id, true);
    }

    function swapFavoritesOrder(idA, idB) {
      if (!Array.isArray(prefs.favorites)) return;
      const iA = prefs.favorites.indexOf(idA);
      const iB = prefs.favorites.indexOf(idB);
      if (iA >= 0 && iB >= 0) {
        const tmp = prefs.favorites[iA];
        prefs.favorites[iA] = prefs.favorites[iB];
        prefs.favorites[iB] = tmp;
      }
    }

    function bindFavoritesDrag(bar) {
      if (!bar || bar._dragBound) return;
      bar._dragBound = true;

      const getPoint = (e) => (e.touches && e.touches[0]) ? e.touches[0] : e;

      const finishDrag = () => {
        if (!favDragState) return;
        const st = favDragState;
        clearTimeout(st.timer);
        if (st.active && st.tile) {
          st.tile.classList.remove('fav-tile-dragging');
          st.tile.style.transform = '';
          favSuppressClick = true;
          setTimeout(() => { favSuppressClick = false; }, 260);
          if (st.changed) {
            persistPrefs();
            renderList();
          }
          favDragState = null;
          renderFavoritesBar();
        } else {
          favDragState = null;
        }
        window.removeEventListener('touchmove', onMove, { passive: false });
        window.removeEventListener('touchend', finishDrag);
        window.removeEventListener('touchcancel', finishDrag);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', finishDrag);
      };

      const onMove = (e) => {
        if (!favDragState) return;
        const pt = getPoint(e);
        if (!pt) return;
        const st = favDragState;
        st.lastX = pt.clientX;
        st.lastY = pt.clientY;

        if (!st.active) {
          if (Math.hypot(pt.clientX - st.startX, pt.clientY - st.startY) > 10) {
            finishDrag();
          }
          return;
        }

        if (e.cancelable) e.preventDefault();

        const barRect = bar.getBoundingClientRect();
        if (pt.clientX < barRect.left + 32 && bar.scrollLeft > 0) {
          const step = Math.min(10, bar.scrollLeft);
          bar.scrollLeft -= step;
          st.anchorX += step;
        } else if (pt.clientX > barRect.right - 32 && bar.scrollLeft < bar.scrollWidth - bar.clientWidth) {
          const step = Math.min(10, bar.scrollWidth - bar.clientWidth - bar.scrollLeft);
          bar.scrollLeft += step;
          st.anchorX -= step;
        }

        let dx = pt.clientX - st.anchorX;
        st.tile.style.transform = 'translateX(' + dx + 'px) scale(1.12)';

        const tileRect = st.tile.getBoundingClientRect();
        const centerX = tileRect.left + tileRect.width / 2;
        const prev = st.tile.previousElementSibling;
        const next = st.tile.nextElementSibling;

        if (prev && prev.hasAttribute('data-fav-id')) {
          const prevRect = prev.getBoundingClientRect();
          if (centerX < prevRect.left + prevRect.width / 2) {
            const oldLeft = st.tile.offsetLeft;
            bar.insertBefore(st.tile, prev);
            swapFavoritesOrder(st.id, prev.getAttribute('data-fav-id'));
            const newLeft = st.tile.offsetLeft;
            st.anchorX += (newLeft - oldLeft);
            st.changed = true;
            dx = pt.clientX - st.anchorX;
            st.tile.style.transform = 'translateX(' + dx + 'px) scale(1.12)';
            return;
          }
        }

        if (next && next.hasAttribute('data-fav-id')) {
          const nextRect = next.getBoundingClientRect();
          if (centerX > nextRect.left + nextRect.width / 2) {
            const oldLeft = st.tile.offsetLeft;
            bar.insertBefore(next, st.tile);
            swapFavoritesOrder(st.id, next.getAttribute('data-fav-id'));
            const newLeft = st.tile.offsetLeft;
            st.anchorX += (newLeft - oldLeft);
            st.changed = true;
            dx = pt.clientX - st.anchorX;
            st.tile.style.transform = 'translateX(' + dx + 'px) scale(1.12)';
          }
        }
      };

      const onStart = (e) => {
        const tile = e.target.closest('[data-fav-id]');
        if (!tile) return;
        const pt = getPoint(e);
        if (!pt) return;

        finishDrag();

        const id = tile.getAttribute('data-fav-id');
        const st = {
          id,
          tile,
          startX: pt.clientX,
          startY: pt.clientY,
          lastX: pt.clientX,
          lastY: pt.clientY,
          anchorX: pt.clientX,
          active: false,
          changed: false,
          timer: null
        };

        st.timer = setTimeout(() => {
          if (favDragState !== st) return;
          st.active = true;
          st.anchorX = st.lastX;
          tile.classList.add('fav-tile-dragging');
          tile.style.transform = 'translateX(0px) scale(1.12)';
          if (navigator.vibrate) {
            try { navigator.vibrate(15); } catch (_) {}
          }
        }, 380);

        favDragState = st;
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', finishDrag);
        window.addEventListener('touchcancel', finishDrag);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', finishDrag);
      };

      bar.addEventListener('touchstart', onStart, { passive: true });
      bar.addEventListener('mousedown', onStart);
      bar.addEventListener('contextmenu', (e) => {
        if (e.target.closest('[data-fav-id]')) e.preventDefault();
      });
    }

    function updateStatusBadge() {
      const badge = document.getElementById('status-badge');
      if (!badge) return;
      if (!isConnected) {
        badge.textContent = 'Офлайн';
        badge.className = 'bg-slate-800/90 backdrop-blur-md text-white text-xs font-bold px-3.5 h-10 rounded-2xl shadow-lg active:scale-95 shrink-0 flex items-center gap-1';
        return;
      }
      if (connectionState === 'reconnecting') {
        badge.textContent = '⟳ ' + vehicles.length;
        badge.className = 'bg-amber-500 text-white text-xs font-bold px-3 h-10 rounded-xl shadow-lg active:scale-95 shrink-0 flex items-center gap-1';
        return;
      }
      if (connectionState === 'error') {
        badge.textContent = '⚠ ' + vehicles.length;
        badge.className = 'bg-red-600 text-white text-xs font-bold px-3 h-10 rounded-xl shadow-lg active:scale-95 shrink-0 flex items-center gap-1';
        return;
      }
      badge.innerHTML = (prefs.autoRefresh ? '<span class="lg-live-dot"></span>' : '') + '<span>' + vehicles.length + '</span>';
      badge.className = 'lg-press bg-gradient-to-r from-emerald-500/90 to-teal-500/90 backdrop-blur-xl border border-white/35 text-white text-xs font-bold px-3.5 h-10 rounded-2xl shadow-lg shadow-emerald-500/30 shrink-0 flex items-center gap-1.5 tabular-nums';
    }

    function buildMarkerIcon(v) {
      const c = getColor(v);
      const isSel = v.id === selectedId;
      const isFav = isFavorite(v.id);
      const isOff = isVehicleOffOrOffline(v);
      const favStar = isFav ? '★ ' : '';
      const scale = Number(prefs.uiScale) || 1;
      const size = Math.round(32 * Math.min(1.35, scale));
      const half = Math.round(size / 2);
      const glyphSize = Math.round(15 * Math.min(1.3, scale));
      const ring = isSel
        ? 'box-shadow:0 0 0 4px rgba(37,99,235,0.65), 0 3px 10px rgba(0,0,0,.45);'
        : 'box-shadow:0 3px 10px rgba(0,0,0,.35);';
      const hasCourse = v.active && v.course !== null && v.course !== undefined && !isNaN(v.course) && !isExcavator(v) && !isFuelStation(v);

      let circleBg = c;
      let circleBorder = '#fff';
      let innerGlyph = '';
      if (isOff && !isExcavator(v) && !isFuelStation(v)) {
        circleBg = '#ffffff';
        circleBorder = '#ef4444';
        innerGlyph = '<svg width="' + glyphSize + '" height="' + glyphSize + '" viewBox="0 0 16 16"><path d="M3 3L13 13M13 3L3 13" stroke="#ef4444" stroke-width="3.2" stroke-linecap="round"/></svg>';
      } else if (hasCourse) {
        innerGlyph = '<svg class="car-arrow" width="' + glyphSize + '" height="' + glyphSize + '" viewBox="0 0 24 24" style="transform:rotate(' + Math.round(v.course) + 'deg);"><path fill="white" d="M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71z"/></svg>';
      } else {
        innerGlyph = '<span style="font-size:' + glyphSize + 'px;line-height:1;">' + getVehicleEmoji(v) + '</span>';
      }

      const spdPart = v.active ? ' · ' + Math.round(v.speed) + ' км/ч' : '';
      const labelHtml = prefs.showLabels
        ? '<div class="car-label">' + favStar + esc(v.name) + spdPart + '</div>'
        : '';

      const priorityCls = (isSel || isFav) ? ' car-marker-priority' : '';

      return L.divIcon({
        className: 'car-marker-wrap' + priorityCls,
        html: '<div style="display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-' + half + 'px);">'
          + '<div style="width:' + size + 'px;height:' + size + 'px;background:' + circleBg + ';border:2.5px solid ' + circleBorder + ';border-radius:50%;' + ring + 'display:flex;align-items:center;justify-content:center;">' + innerGlyph + '</div>'
          + labelHtml
          + '</div>',
        iconSize: [0, 0],
        iconAnchor: [0, 0],
        popupAnchor: [0, -(half + 2)]
      });
    }

    function attachLongPress(marker, vehicleId) {
      const bindEl = () => {
        const el = marker.getElement();
        if (!el || el._lpBound) return;
        el._lpBound = true;
        let timer = null;
        let sx = 0, sy = 0;

        const start = (e) => {
          const pt = e.touches ? e.touches[0] : e;
          sx = pt.clientX;
          sy = pt.clientY;
          clearTimeout(timer);
          timer = setTimeout(() => {
            suppressNextClick = true;
            setTimeout(() => { suppressNextClick = false; }, 500);
            openCtxMenu(vehicleId);
          }, 550);
        };
        const move = (e) => {
          if (!timer) return;
          const pt = e.touches ? e.touches[0] : e;
          if (Math.hypot(pt.clientX - sx, pt.clientY - sy) > 12) {
            clearTimeout(timer);
            timer = null;
          }
        };
        const cancel = () => {
          clearTimeout(timer);
          timer = null;
        };

        el.addEventListener('touchstart', start, { passive: true });
        el.addEventListener('touchmove', move, { passive: true });
        el.addEventListener('touchend', cancel);
        el.addEventListener('touchcancel', cancel);
        el.addEventListener('mousedown', start);
        el.addEventListener('mousemove', move);
        el.addEventListener('mouseup', cancel);
        el.addEventListener('mouseleave', cancel);
        el.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          cancel();
          openCtxMenu(vehicleId);
        });
      };

      marker._lp = bindEl;
      bindEl();
      marker.on('add', bindEl);
    }

    function getCachedTelemetryShort(v) {
      const parts = [];
      const cached = sensorCache[v.id];
      const fuel = (cached && cached.fuel) ? cached.fuel : v.fuel;
      const weight = (cached && cached.weight) ? cached.weight : '';
      if (fuel) parts.push('⛽ ' + fuel);
      if (weight) parts.push('⚖️ ' + weight);
      return parts.join(' • ');
    }

    function buildPopupHtml(v) {
      const distStr = formatDistanceFromMe(v);
      const distLine = distStr ? '<div class="lg-popup-dist text-[11px] font-semibold mt-1.5">📍 ' + esc(distStr) + ' от вас</div>' : '';
      const zoneStr = formatVehicleZonesShort(v);
      const zoneLine = zoneStr ? '<div class="lg-popup-zone text-[11px] font-semibold mb-1.5">' + esc(zoneStr) + '</div>' : '';
      const isInactiveBelaz = isBelaz(v) && isVehicleOffOrOffline(v);

      if (isInactiveBelaz) {
        const info = getStopInfoForVehicle(v);
        return '<div class="text-center">'
          + '<div class="font-bold text-sm mb-1 flex items-center justify-center gap-1.5">'
          + '<span class="inline-flex items-center justify-center">' + RED_CROSS_SVG + '</span>'
          + '<span>' + (isFavorite(v.id) ? '★ ' : '') + esc(v.name) + '</span>'
          + '</div>'
          + zoneLine
          + '<div class="lg-pill-red rounded-xl px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide inline-flex items-center gap-1 mb-2">'
          + '<span class="lg-pill-val">Не в работе · ' + esc(info.statusLabel) + '</span>'
          + '</div>'
          + '<div class="grid grid-cols-2 gap-1.5 text-left">'
          + '<div class="lg-pill-neutral rounded-xl px-2.5 py-1.5">'
          + '<div class="lg-pill-lbl text-[9px] uppercase font-bold leading-none">Остановка</div>'
          + '<div class="lg-pill-val tabular-nums text-xs font-bold mt-1 leading-none">' + esc(info.stopTimeText) + '</div>'
          + '</div>'
          + '<div class="lg-pill-red rounded-xl px-2.5 py-1.5">'
          + '<div class="lg-pill-lbl text-[9px] uppercase font-bold leading-none">Стоит уже</div>'
          + '<div class="lg-pill-val tabular-nums text-xs font-bold mt-1 leading-none">' + esc(info.durText) + '</div>'
          + '</div>'
          + '</div>'
          + distLine
          + '<button onclick="openInfoForId(\\'' + esc(v.id) + '\\')" class="lg-press mt-2.5 w-full bg-gradient-to-r from-blue-600 to-indigo-600 text-white text-xs font-semibold py-2.5 px-3 rounded-2xl shadow-md shadow-blue-600/25">ℹ️ Подробная информация</button>'
          + '</div>';
      }

      return '<div class="text-center">'
        + '<div class="font-bold text-sm mb-1.5">' + (isFavorite(v.id) ? '★ ' : '') + getVehicleEmoji(v) + ' ' + esc(v.name) + '</div>'
        + zoneLine
        + '<div class="lg-popup-meta flex justify-between text-[11px] pt-1.5"><span class="tabular-nums">' + esc(v.lastTime) + '</span><span class="lg-popup-dur font-bold ml-2">' + esc(v.duration) + '</span></div>'
        + distLine
        + '<button onclick="openInfoForId(\\'' + esc(v.id) + '\\')" class="lg-press mt-2.5 w-full bg-gradient-to-r from-blue-600 to-indigo-600 text-white text-xs font-semibold py-2.5 px-3 rounded-2xl shadow-md shadow-blue-600/25">ℹ️ Подробная информация</button>'
        + '</div>';
    }

    function markerStructSig(v) {
      const hasCourse = v.active && v.course !== null && v.course !== undefined && !isNaN(v.course) && !isExcavator(v) && !isFuelStation(v);
      return [getColor(v), isVehicleOffOrOffline(v), getVehicleEmoji(v), v.id === selectedId, isFavorite(v.id),
        prefs.showLabels, prefs.uiScale, hasCourse].join('|');
    }

    // обновление "живых" частей маркера без пересоздания иконки: подпись со скоростью и поворот стрелки
    function updateMarkerDynamic(m, v) {
      const el = m._icon;
      if (!el) return;
      if (m._elLabel === undefined) {
        m._elLabel = el.querySelector('.car-label');
        m._elArrow = el.querySelector('.car-arrow');
        m._lblText = undefined;
        m._ang = undefined;
      }
      if (m._elLabel) {
        const t = (isFavorite(v.id) ? '★ ' : '') + v.name + (v.active ? ' · ' + Math.round(v.speed) + ' км/ч' : '');
        if (m._lblText !== t) {
          m._elLabel.textContent = t;
          m._lblText = t;
        }
      }
      if (m._elArrow && v.course !== null && v.course !== undefined && !isNaN(v.course)) {
        const a = unwrapAngle(m._ang, v.course);
        if (m._ang === undefined || Math.abs(a - m._ang) > 0.5) {
          m._ang = a;
          m._elArrow.style.transform = 'rotate(' + a.toFixed(1) + 'deg)';
        }
      }
    }

    function updateSingleMarker(v, now) {
      const m = markers[v.id];
      if (!m) {
        renderMarkers(false);
        return;
      }
      m._v = v;
      const sig = markerStructSig(v);
      if (m._sig !== sig) {
        m.setIcon(buildMarkerIcon(v));
        m.setZIndexOffset(v.id === selectedId ? 1000 : 0);
        m._sig = sig;
        m._elLabel = undefined;
        if (m._lp) m._lp();
      }
      setMarkerTarget(m, v, now || performance.now());
      updateMarkerDynamic(m, v);
      if (m.isPopupOpen()) {
        const html = buildPopupHtml(v);
        if (m._popupHtml !== html) {
          m._popupHtml = html;
          m.setPopupContent(html);
        }
      }
    }

    function renderMarkers(forceIcons) {
      const visibleIds = new Set();
      const now = performance.now();

      vehicles.forEach(v => {
        if (activeRouteObjectId && v.id !== activeRouteObjectId) return;
        if (!prefs.showOffline && !v.online && v.id !== selectedId && v.id !== activeRouteObjectId) return;
        if (!isVehicleAllowedByFilter(v) && v.id !== selectedId && v.id !== activeRouteObjectId) return;
        visibleIds.add(v.id);
        const sig = markerStructSig(v);
        let m = markers[v.id];

        if (m) {
          m._v = v;
          if (forceIcons || m._sig !== sig) {
            m.setIcon(buildMarkerIcon(v));
            m.setZIndexOffset(v.id === selectedId ? 1000 : 0);
            m._sig = sig;
            m._elLabel = undefined;
            if (m._lp) m._lp();
          }
          setMarkerTarget(m, v, now);
          updateMarkerDynamic(m, v);
          if (m.isPopupOpen()) {
            const html = buildPopupHtml(v);
            if (m._popupHtml !== html) {
              m._popupHtml = html;
              m.setPopupContent(html);
            }
          }
        } else {
          const popupHtml = buildPopupHtml(v);
          m = L.marker([v.lat, v.lng], { icon: buildMarkerIcon(v), zIndexOffset: v.id === selectedId ? 1000 : 0 })
            .addTo(map).bindPopup(popupHtml);
          m._sig = sig;
          m._v = v;
          m._popupHtml = popupHtml;
          m.on('click', () => {
            if (suppressNextClick) {
              m.closePopup();
              return;
            }
            selectObject(v.id, false);
          });
          m.on('popupopen', () => {
            if (m._v) {
              const html = buildPopupHtml(m._v);
              m._popupHtml = html;
              m.setPopupContent(html);
            }
          });
          attachLongPress(m, v.id);
          markers[v.id] = m;
          setMarkerTarget(m, v, now);
          updateMarkerDynamic(m, v);
        }
      });

      Object.keys(markers).forEach(id => {
        if (!visibleIds.has(id)) {
          map.removeLayer(markers[id]);
          delete markers[id];
          animSet.delete(id);
        }
      });

      document.getElementById('obj-count').textContent = '(' + vehicles.length + ')';
    }

    // ==================== МЕНЮ ДЕЙСТВИЙ, МАРШРУТ, ИНФОРМАЦИЯ ====================
    function openCtxMenu(id) {
      const v = vehicles.find(x => x.id === id);
      if (!v) return;
      ctxTargetId = v.id;
      document.getElementById('ctx-title').textContent = getVehicleEmoji(v) + ' ' + v.name;
      const distStr = formatDistanceFromMe(v);
      document.getElementById('ctx-sub').textContent = v.duration + ' • ' + v.lastTime + (distStr ? ' • ' + distStr : '');
      document.getElementById('ctx-coords-sub').textContent = v.lat.toFixed(6) + ', ' + v.lng.toFixed(6);
      const favBtn = document.getElementById('ctx-fav-btn');
      if (favBtn) favBtn.textContent = isFavorite(v.id) ? '★' : '☆';
      const _m_ctx_menu = document.getElementById('ctx-menu'); if (_m_ctx_menu._closeTimer) clearTimeout(_m_ctx_menu._closeTimer); _m_ctx_menu.classList.remove('modal-closing', 'hidden');
    }


    // ==================== ПЛАВНОЕ ЗАКРЫТИЕ И СВАЙП ВНИЗ ДЛЯ МОДАЛЬНЫХ ОКОН ====================
    function closeModalAnimated(id) {
      const el = document.getElementById(id);
      if (!el || el.classList.contains('hidden')) return;
      if (el._closeTimer) clearTimeout(el._closeTimer);
      el.classList.add('modal-closing');
      el._closeTimer = setTimeout(() => {
        el.classList.add('hidden');
        el.classList.remove('modal-closing');
        el.style.opacity = '';
        const sheet = el.querySelector('.sheet-anim');
        if (sheet) {
          sheet.style.transform = '';
          sheet.style.transition = '';
        }
        el._closeTimer = null;
      }, 200);
    }

    function initModalSwipeDismiss() {
      const modalIds = [
        'ctx-menu', 'summary-modal', 'route-modal',
        'info-modal', 'zone-modal', 'save-zone-modal', 'map-filter-modal'
      ];
      modalIds.forEach(id => {
        const modal = document.getElementById(id);
        if (!modal || modal._swipeBound) return;
        const sheet = modal.querySelector('.sheet-anim');
        if (!sheet) return;
        modal._swipeBound = true;

        let tracking = false;
        let startY = 0;
        let startTime = 0;
        let curDy = 0;

        sheet.addEventListener('touchstart', (e) => {
          if (!e.touches || e.touches.length !== 1) return;
          const tag = (e.target && e.target.tagName || '').toLowerCase();
          if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
          const scrollParent = e.target.closest('.overflow-y-auto');
          if (scrollParent && scrollParent.scrollTop > 2) return;
          tracking = true;
          startY = e.touches[0].clientY;
          startTime = Date.now();
          curDy = 0;
          sheet.style.transition = 'none';
        }, { passive: true });

        sheet.addEventListener('touchmove', (e) => {
          if (!tracking || !e.touches || !e.touches[0]) return;
          const dy = e.touches[0].clientY - startY;
          if (dy <= 0) {
            if (curDy > 0) {
              curDy = 0;
              sheet.style.transform = '';
              modal.style.opacity = '';
            }
            return;
          }
          curDy = dy;
          if (e.cancelable) e.preventDefault();
          sheet.style.transform = 'translate3d(0,' + dy + 'px,0)';
          modal.style.opacity = String(Math.max(0.25, 1 - dy / 340));
        }, { passive: false });

        const finishSwipe = () => {
          if (!tracking) return;
          tracking = false;
          const dt = Date.now() - startTime;
          if (curDy > 80 || (curDy > 38 && dt < 220)) {
            sheet.style.transition = 'transform 0.2s cubic-bezier(0.4, 0, 1, 1)';
            sheet.style.transform = 'translate3d(0, 100%, 0)';
            modal.style.transition = 'opacity 0.2s ease-out';
            modal.style.opacity = '0';
            if (modal._closeTimer) clearTimeout(modal._closeTimer);
            modal._closeTimer = setTimeout(() => {
              modal.classList.add('hidden');
              modal.classList.remove('modal-closing');
              modal.style.opacity = '';
              modal.style.transition = '';
              sheet.style.transform = '';
              sheet.style.transition = '';
              modal._closeTimer = null;
            }, 200);
          } else {
            sheet.style.transition = 'transform 0.32s cubic-bezier(0.34, 1.56, 0.64, 1)';
            sheet.style.transform = 'translate3d(0, 0, 0)';
            modal.style.opacity = '';
            setTimeout(() => {
              sheet.style.transform = '';
              sheet.style.transition = '';
            }, 330);
          }
          curDy = 0;
        };

        sheet.addEventListener('touchend', finishSwipe);
        sheet.addEventListener('touchcancel', finishSwipe);
      });
    }

    function closeCtxMenu() {
      closeModalAnimated('ctx-menu');
    }

    function copyCoordsFromCtx() {
      const v = vehicles.find(x => x.id === ctxTargetId);
      if (!v) return;
      const text = v.name + ': ' + v.lat.toFixed(6) + ', ' + v.lng.toFixed(6);
      sendNative('sputnik://copy?text=' + encodeURIComponent(text));
      closeCtxMenu();
      showToast('Координаты скопированы 📋', 'bg-slate-800');
    }

    function openCtxForSelected() {
      if (selectedId) openCtxMenu(selectedId);
    }

    function openInfoForSelected() {
      if (!selectedId) return;
      ctxTargetId = selectedId;
      openInfoModalFromCtx();
    }

    function openSelectedExcavatorZone() {
      if (!selectedId) return;
      const z = dynamicZones.find(item => item.ownerId === selectedId);
      if (z) {
        openZoneVehiclesModal(z);
      } else {
        openInfoForSelected();
      }
    }

    function openInfoForId(id) {
      if (!id) return;
      ctxTargetId = id;
      openInfoModalFromCtx();
    }

    function fetchSensorsForSelected(id, force) {
      if (!id || !isConnected) return;
      const cached = sensorCache[id];
      const now = Date.now();
      if (!force && cached && (cached.pending || (now - (cached.ts || 0) < 15000))) return;
      sensorCache[id] = Object.assign({}, cached || {}, { pending: true });
      sendNative('sputnik://sensors?id=' + encodeURIComponent(id));
    }

    function getCurrentShiftStart(nowDate) {
      const d = new Date(nowDate.getTime());
      const mins = d.getHours() * 60 + d.getMinutes();
      if (mins >= 450 && mins < 1170) {
        // 1-я смена: 07:30 – 19:30
        d.setHours(7, 30, 0, 0);
      } else if (mins >= 1170) {
        // 2-я смена (вечер): с 19:30 сегодня
        d.setHours(19, 30, 0, 0);
      } else {
        // 2-я смена (ночь/утро до 07:30): с 19:30 вчера
        d.setDate(d.getDate() - 1);
        d.setHours(19, 30, 0, 0);
      }
      return d;
    }

    function getCurrentShiftNumber(nowDate) {
      const d = nowDate || new Date();
      const mins = d.getHours() * 60 + d.getMinutes();
      return (mins >= 450 && mins < 1170) ? 1 : 2;
    }

    function fetchTripsForSelected(id, force) {
      if (!id || !isConnected) return;
      const v = vehicles.find(x => x.id === id);
      if (!v || isExcavator(v) || isFuelStation(v)) return;
      const cached = tripsCache[id];
      const now = Date.now();
      if (!force && cached && (cached.pending || (now - (cached.ts || 0) < 45000))) return;
      tripsCache[id] = Object.assign({}, cached || {}, { pending: true });
      if (id === selectedId) updateFollowBar();

      const nowDate = new Date();
      const fromDate = getCurrentShiftStart(nowDate);
      const altIds = [];
      if (v.rawFields) {
        Object.entries(v.rawFields).forEach(([k, val]) => {
          const s = String(val || '').trim();
          if (!s || s === v.id) return;
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) || /^(id|obj|guid|uid|objectid|code)$/i.test(k)) {
            if (!altIds.includes(s)) altIds.push(s);
          }
        });
      }
      sendNative('sputnik://trips?id=' + encodeURIComponent(id)
        + '&from=' + encodeURIComponent(toLocalInputValue(fromDate))
        + '&to=' + encodeURIComponent(toLocalInputValue(nowDate))
        + '&altIds=' + encodeURIComponent(altIds.join('|')));
    }

    window.onNativeTripsResult = function(res) {
      const targetId = res && res.objectId;
      if (!targetId) return;
      const pts = (res && res.ok && Array.isArray(res.points)) ? res.points : [];
      const analysis = analyzeRouteTrips(pts);
      const baseDistKm = pts.length > 1 ? calcDistanceKm(pts) : 0;
      const prevTc = tripsCache[targetId] || {};
      const curShiftKey = getCurrentShiftStart(new Date()).getTime();
      const sameShift = prevTc.shiftKey === curShiftKey;
      const baseCount = analysis.tripsCount;
      // Если история уже догнала живой счётчик — сбрасываем liveExtra, чтобы не было двойного счёта
      const prevTotal = (prevTc.count || 0) + (prevTc.liveExtra || 0);
      const nextLiveExtra = (sameShift && baseCount < prevTotal) ? (prevTotal - baseCount) : 0;

      // Плавная синхронизация пробега: не даём цифре "откатываться назад" из-за задержки истории на сервере
      const prevDistTotal = sameShift ? ((prevTc.baseDistKm || 0) + (prevTc.liveDistKm || 0)) : 0;
      const keepLiveDist = (sameShift && prevDistTotal > baseDistKm && (prevDistTotal - baseDistKm) < 1.5)
        ? (prevDistTotal - baseDistKm)
        : 0;
      const curVeh = vehicles.find(x => x.id === targetId);
      const lastPt = pts.length ? pts[pts.length - 1] : null;
      const anchorLat = curVeh ? curVeh.lat : (lastPt ? lastPt.lat : null);
      const anchorLng = curVeh ? curVeh.lng : (lastPt ? lastPt.lng : null);

      // Вычисляем точное время начала текущей остановки по хвосту трека
      let stopStartMs = null;
      if (pts.length > 0 && (pts[pts.length - 1].speed || 0) <= 2) {
        let sIdx = pts.length - 1;
        while (sIdx > 0 && (pts[sIdx - 1].speed || 0) <= 2) {
          sIdx--;
        }
        const tMs = parsePointTimeMs(pts[sIdx].time);
        if (!isNaN(tMs)) stopStartMs = tMs;
      }

      tripsCache[targetId] = {
        count: baseCount,
        liveExtra: nextLiveExtra,
        liveLoaded: sameShift ? Boolean(prevTc.liveLoaded) : false,
        lastWeight: sameShift ? (prevTc.lastWeight !== undefined ? prevTc.lastWeight : null) : null,
        shiftKey: curShiftKey,
        baseDistKm: baseDistKm,
        liveDistKm: keepLiveDist,
        dispDistKm: sameShift && prevTc.dispDistKm !== undefined ? prevTc.dispDistKm : (baseDistKm + keepLiveDist),
        lastDistLat: anchorLat,
        lastDistLng: anchorLng,
        stopStartMs: stopStartMs,
        loaded: true,
        pending: false,
        ts: Date.now()
      };
      if (targetId === selectedId) {
        updateFollowBar();
        kickAnim();
        const mk = markers[targetId];
        if (mk && mk.isPopupOpen() && curVeh) {
          const html = buildPopupHtml(curVeh);
          mk._popupHtml = html;
          mk.setPopupContent(html);
        }
      }
    };

    function accumulateLiveDistance(v) {
      if (!v || !v.id) return;
      const tc = tripsCache[v.id];
      if (!tc || !tc.loaded) return;
      const curShiftKey = getCurrentShiftStart(new Date()).getTime();
      if (tc.shiftKey !== curShiftKey) return;
      if (tc.lastDistLat !== null && tc.lastDistLat !== undefined && tc.lastDistLng !== null && tc.lastDistLng !== undefined) {
        const dKm = haversineKm(tc.lastDistLat, tc.lastDistLng, v.lat, v.lng);
        // Отсекаем шум GPS на стоянке (< 3 м) и телепорты (> 2 км за 1 тик)
        if ((v.speed || 0) > 2 && dKm >= 0.003 && dKm < 2.0) {
          tc.liveDistKm = (tc.liveDistKm || 0) + dKm;
          tc.lastDistLat = v.lat;
          tc.lastDistLng = v.lng;
        } else if (dKm >= 0.015 && dKm < 2.0) {
          tc.lastDistLat = v.lat;
          tc.lastDistLng = v.lng;
        }
      } else {
        tc.lastDistLat = v.lat;
        tc.lastDistLng = v.lng;
      }
    }

    function openRouteForSelected() {
      if (!selectedId) return;
      ctxTargetId = selectedId;
      openRouteModalFromCtx();
    }

    function toLocalInputValue(date) {
      const pad = n => String(n).padStart(2, '0');
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
        + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
    }

    function openRouteModalFromCtx() {
      closeCtxMenu();
      const v = vehicles.find(x => x.id === ctxTargetId);
      if (!v) return;
      document.getElementById('route-obj-name').textContent = v.name;
      document.getElementById('route-debug-box').classList.add('hidden');
      document.getElementById('btn-copy-route-debug').classList.add('hidden');
      setRoutePreset('today');
      const _m_route_modal = document.getElementById('route-modal'); if (_m_route_modal._closeTimer) clearTimeout(_m_route_modal._closeTimer); _m_route_modal.classList.remove('modal-closing', 'hidden');
    }

    function closeRouteModal() {
      closeModalAnimated('route-modal');
    }

    function setRoutePreset(preset) {
      const now = new Date();
      let from = new Date(now);
      let to = new Date(now);

      if (preset === '3h') {
        from = new Date(now.getTime() - 3 * 3600 * 1000);
      } else if (preset === 'shift') {
        from = getCurrentShiftStart(now);
      } else if (preset === 'today') {
        from.setHours(0, 0, 0, 0);
      } else if (preset === 'yesterday') {
        from.setDate(from.getDate() - 1);
        from.setHours(0, 0, 0, 0);
        to.setDate(to.getDate() - 1);
        to.setHours(23, 59, 0, 0);
      }

      document.getElementById('route-from').value = toLocalInputValue(from);
      document.getElementById('route-to').value = toLocalInputValue(to);
    }

    function requestRoute() {
      if (!ctxTargetId) return;
      const fromVal = document.getElementById('route-from').value;
      const toVal = document.getElementById('route-to').value;
      if (!fromVal || !toVal) {
        showToast('Укажите дату и время «От» и «До»', 'bg-red-600');
        return;
      }
      if (fromVal > toVal) {
        showToast('Дата «От» не может быть позже даты «До»', 'bg-red-600');
        return;
      }
      document.getElementById('route-debug-box').classList.add('hidden');
      document.getElementById('btn-copy-route-debug').classList.add('hidden');
      const btn = document.getElementById('btn-build-route');
      btn.textContent = 'Загрузка маршрута...';
      btn.disabled = true;

      const v = vehicles.find(x => x.id === ctxTargetId);
      const altIds = [];
      if (v && v.rawFields) {
        Object.entries(v.rawFields).forEach(([k, val]) => {
          const s = String(val || '').trim();
          if (!s || s === v.id) return;
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) || /^(id|obj|guid|uid|objectid|code)$/i.test(k)) {
            if (!altIds.includes(s)) altIds.push(s);
          }
        });
      }

      sendNative('sputnik://history?id=' + encodeURIComponent(ctxTargetId)
        + '&from=' + encodeURIComponent(fromVal)
        + '&to=' + encodeURIComponent(toVal)
        + '&altIds=' + encodeURIComponent(altIds.join('|')));
    }

    function copyRouteDebug() {
      if (!lastRouteDebug) return;
      sendNative('sputnik://copy?text=' + encodeURIComponent(lastRouteDebug));
      showToast('Ответ сервера скопирован', 'bg-slate-800');
    }

    function calcDistanceKm(pts) {
      let total = 0;
      for (let i = 1; i < pts.length; i++) {
        total += haversineKm(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
      }
      return total;
    }

    function speedToColor(spd) {
      if (spd >= 70) return '#ef4444';
      if (spd >= 40) return '#f59e0b';
      return '#22c55e';
    }

    function parsePointTimeMs(str) {
      if (!str) return NaN;
      const s = String(str).trim();
      if (/^\\d{10,13}$/.test(s)) {
        return s.length === 10 ? Number(s) * 1000 : Number(s);
      }
      const ru = s.match(/(\\d{2})\\.(\\d{2})\\.(\\d{4})[\\sT]+(\\d{2}):(\\d{2})(?::(\\d{2}))?/);
      if (ru) {
        return new Date(Number(ru[3]), Number(ru[2]) - 1, Number(ru[1]), Number(ru[4]), Number(ru[5]), Number(ru[6] || 0)).getTime();
      }
      const d = Date.parse(s);
      return isNaN(d) ? NaN : d;
    }

    function isSegmentStopped(p1, p2, dtMs) {
      const s1 = p1.speed || 0;
      const s2 = p2.speed || 0;
      if (s1 <= 3 && s2 <= 3) return true;
      // Если трекер проредил стоячие точки (прислал "встал" и через пару минут "поехал"),
      // проверяем фактическую среднюю скорость по расстоянию между точками
      if (dtMs >= 15000 && (s1 <= 3 || s2 <= 3)) {
        const distKm = haversineKm(p1.lat, p1.lng, p2.lat, p2.lng);
        const avgKmh = distKm / (dtMs / 3600000);
        if (avgKmh <= 4.5) return true;
      }
      return false;
    }

    function calcTotalStopMs(pts) {
      if (!pts || pts.length < 2) return null;
      let stopMs = 0;
      let validPairs = 0;
      for (let i = 1; i < pts.length; i++) {
        const t1 = parsePointTimeMs(pts[i - 1].time);
        const t2 = parsePointTimeMs(pts[i].time);
        if (!isNaN(t1) && !isNaN(t2) && t2 > t1 && (t2 - t1) < 3600000 * 6) {
          const dt = t2 - t1;
          validPairs++;
          if (isSegmentStopped(pts[i - 1], pts[i], dt)) {
            stopMs += dt;
          }
        }
      }
      return validPairs > 0 ? stopMs : null;
    }

    function formatMinutesShort(totalMin) {
      if (!totalMin || totalMin < 1) return '<1 мин';
      const h = Math.floor(totalMin / 60);
      const m = Math.round(totalMin % 60);
      return h > 0 ? (h + 'ч ' + m + 'м') : (m + 'м');
    }

    function calcTrackTimeStats(pts) {
      let moveMs = 0, stopMs = 0;
      for (let i = 1; i < pts.length; i++) {
        const t1 = parsePointTimeMs(pts[i - 1].time);
        const t2 = parsePointTimeMs(pts[i].time);
        if (!isNaN(t1) && !isNaN(t2) && t2 > t1 && (t2 - t1) < 3600000 * 6) {
          const dt = t2 - t1;
          if (isSegmentStopped(pts[i - 1], pts[i], dt)) stopMs += dt;
          else moveMs += dt;
        }
      }
      if (moveMs + stopMs < 60000) return '';
      return 'Движ: ' + formatMinutesShort(moveMs / 60000) + ' • Стоп: ' + formatMinutesShort(stopMs / 60000);
    }

    function analyzeRouteTrips(pts) {
      if (!pts || pts.length < 2) return { tripsCount: 0, loadingGroups: [] };

      const excZones = dynamicZones.filter(z => z.kind === 'excavator');

      // 0. Приоритетный подсчёт по весу (переход с порожнего <= 35 т до гружёного >= 100 т)
      const hasWeightData = pts.some(p => p.weight !== null && p.weight !== undefined && !isNaN(p.weight));
      if (hasWeightData) {
        let wTrips = 0;
        let isLoaded = false;
        let sawEmpty = false;
        const wLoadEvents = [];

        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          const w = (p.weight !== null && p.weight !== undefined && !isNaN(p.weight)) ? Number(p.weight) : null;
          if (w === null) continue;

          if (w <= 35) {
            sawEmpty = true;
            isLoaded = false;
          } else if (w >= 100 && !isLoaded && (sawEmpty || i === 0)) {
            isLoaded = true;
            wTrips++;
            // Ищем ближайший экскаватор в точке погрузки (для метки на карте)
            let nearExc = null;
            let bestDist = Infinity;
            for (let j = 0; j < excZones.length; j++) {
              const z = excZones[j];
              const dm = haversineKm(p.lat, p.lng, z.lat, z.lng) * 1000;
              if (dm <= 150 && dm < bestDist) {
                bestDist = dm;
                nearExc = z;
              }
            }
            if (nearExc) {
              wLoadEvents.push({
                ownerId: nearExc.ownerId,
                name: nearExc.shortName || nearExc.name,
                excLat: nearExc.lat,
                excLng: nearExc.lng,
                startTime: p.time || '',
                endTime: p.time || ''
              });
            }
          }
        }

        if (wTrips > 0) {
          const byExc = {};
          wLoadEvents.forEach(ev => {
            if (!byExc[ev.ownerId]) {
              byExc[ev.ownerId] = { ownerId: ev.ownerId, name: ev.name, lat: ev.excLat, lng: ev.excLng, loads: [] };
            }
            byExc[ev.ownerId].loads.push({ startTime: ev.startTime, endTime: ev.endTime });
          });
          return { tripsCount: wTrips, loadingGroups: Object.values(byExc), byWeight: true };
        }
      }

      // 1. Точный подсчёт карьерных рейсов от экскаваторов:
      //    - радиус погрузки 85–100 м (учитывает перемещение экскаватора по забою за смену)
      //    - отсечение "проезда мимо": машина должна замедлиться (<= 5 км/ч) и провести в зоне >= 30 сек
      //    - выезд от экскаватора минимум на 350 м + защита от дублей (мин. 2.5 мин между рейсами)
      const loadEvents = [];

      if (excZones.length > 0) {
        let excTrips = 0;
        let candidate = null;
        let confirmedLoad = null;
        let tripDistKm = 0;
        let lastTripMs = NaN;

        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          const pMs = parsePointTimeMs(p.time);
          const spd = p.speed || 0;

          if (i > 0 && confirmedLoad) {
            tripDistKm += haversineKm(pts[i - 1].lat, pts[i - 1].lng, p.lat, p.lng);
          }

          let nearExc = null;
          let bestDist = Infinity;
          for (let j = 0; j < excZones.length; j++) {
            const z = excZones[j];
            const rad = Math.min(Math.max(z.radius || 60, 85), 110);
            const dm = haversineKm(p.lat, p.lng, z.lat, z.lng) * 1000;
            if (dm <= rad && dm < bestDist) {
              bestDist = dm;
              nearExc = z;
            }
          }

          if (nearExc) {
            if (!candidate || candidate.ownerId !== nearExc.ownerId) {
              candidate = {
                ownerId: nearExc.ownerId,
                name: nearExc.shortName || nearExc.name,
                lat: p.lat,
                lng: p.lng,
                excLat: nearExc.lat,
                excLng: nearExc.lng,
                startTime: p.time || '',
                endTime: p.time || '',
                startMs: pMs,
                endMs: pMs,
                minSpeed: spd,
                slowPts: spd <= 5 ? 1 : 0,
                hasTime: !isNaN(pMs)
              };
            } else {
              candidate.endTime = p.time || candidate.endTime;
              if (!isNaN(pMs)) {
                candidate.endMs = pMs;
                candidate.hasTime = true;
              }
              if (spd < candidate.minSpeed) candidate.minSpeed = spd;
              if (spd <= 5) candidate.slowPts++;
            }

            const dwellMs = (candidate.hasTime && !isNaN(candidate.startMs) && !isNaN(candidate.endMs))
              ? (candidate.endMs - candidate.startMs)
              : 0;

            const isRealLoad = candidate.hasTime
              ? (candidate.minSpeed <= 5 && dwellMs >= 30000)
              : (candidate.slowPts >= 2);

            if (isRealLoad) {
              confirmedLoad = candidate;
              tripDistKm = 0;
            }
          } else {
            // Если трекер проредил точки стоянки (1 точка в зоне -> следующая через >= 30 сек уже за зоной, но скорость была <= 5)
            if (candidate && !confirmedLoad && candidate.hasTime && !isNaN(pMs) && !isNaN(candidate.startMs)) {
              const totalDwell = pMs - candidate.startMs;
              const distFromCand = haversineKm(candidate.lat, candidate.lng, p.lat, p.lng);
              const avgSpd = totalDwell > 0 ? (distFromCand / (totalDwell / 3600000)) : 99;
              if (candidate.minSpeed <= 5 && totalDwell >= 30000 && avgSpd <= 12) {
                confirmedLoad = candidate;
                tripDistKm = distFromCand;
              }
            }
            candidate = null;

            if (confirmedLoad) {
              const awayMeters = haversineKm(p.lat, p.lng, confirmedLoad.excLat, confirmedLoad.excLng) * 1000;
              const cooldownOk = isNaN(pMs) || isNaN(lastTripMs) || ((pMs - lastTripMs) >= 150000);
              if (awayMeters >= 350 && tripDistKm >= 0.35 && cooldownOk) {
                excTrips++;
                loadEvents.push(confirmedLoad);
                if (!isNaN(pMs)) lastTripMs = pMs;
                confirmedLoad = null;
                tripDistKm = 0;
              }
            }
          }
        }

        if (excTrips > 0) {
          const byExc = {};
          loadEvents.forEach(ev => {
            if (!byExc[ev.ownerId]) {
              byExc[ev.ownerId] = {
                ownerId: ev.ownerId,
                name: ev.name,
                lat: ev.excLat,
                lng: ev.excLng,
                loads: []
              };
            }
            byExc[ev.ownerId].loads.push({
              startTime: ev.startTime,
              endTime: ev.endTime
            });
          });
          return { tripsCount: excTrips, loadingGroups: Object.values(byExc) };
        }
      }

      // 2. Универсальный подсчёт выездных рейсов (если экскаваторы не попали в трек)
      let trips = 0;
      let segDistKm = 0;
      let stopPts = 0;
      let stopMs = 0;

      for (let i = 1; i < pts.length; i++) {
        const d = haversineKm(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
        const t1 = parsePointTimeMs(pts[i - 1].time);
        const t2 = parsePointTimeMs(pts[i].time);
        const dt = (!isNaN(t1) && !isNaN(t2) && t2 > t1 && (t2 - t1) < 1800000) ? (t2 - t1) : 0;

        if (!isSegmentStopped(pts[i - 1], pts[i], dt)) {
          segDistKm += d;
          stopPts = 0;
          stopMs = 0;
        } else {
          stopPts++;
          stopMs += dt;
          const realStop = (!isNaN(t2) && !isNaN(t1)) ? (stopMs >= 30000) : (stopPts === 3);
          if (realStop && segDistKm >= 0.35) {
            trips++;
            segDistKm = 0;
            stopPts = 0;
            stopMs = 0;
          }
        }
      }
      if (segDistKm >= 0.35) trips++;
      return { tripsCount: trips, loadingGroups: [] };
    }

    window.onNativeHistoryResult = function(res) {
      const btn = document.getElementById('btn-build-route');
      btn.textContent = 'Показать маршрут';
      btn.disabled = false;

      if (res && res.debug) {
        lastRouteDebug = res.debug;
        document.getElementById('log-box').textContent += '\\n[Маршрут] ' + res.debug;
      }

      if (!res || !res.ok || !res.points || !res.points.length) {
        if (lastRouteDebug) {
          const dbgBox = document.getElementById('route-debug-box');
          dbgBox.textContent = lastRouteDebug;
          dbgBox.classList.remove('hidden');
          document.getElementById('btn-copy-route-debug').classList.remove('hidden');
        }
        showToast((res && res.error) || 'Нет данных маршрута за этот период', 'bg-red-600');
        return;
      }

      closeRouteModal();
      switchTab('map');
      stopPlayback();
      routeLayerGroup.clearLayers();
      routePoints = res.points;
      activeRouteObjectId = ctxTargetId;
      updateFollowBar();
      renderDynamicZones();
      renderMarkers(true);

      const allLatLngs = [];
      for (let i = 0; i < routePoints.length; i++) {
        allLatLngs.push([routePoints[i].lat, routePoints[i].lng]);
        if (i > 0) {
          const prev = routePoints[i - 1];
          const cur = routePoints[i];
          const segColor = speedToColor(cur.speed || prev.speed || 0);
          L.polyline([[prev.lat, prev.lng], [cur.lat, cur.lng]], {
            color: segColor,
            weight: 4.5,
            opacity: 0.92
          }).addTo(routeLayerGroup);
        }
      }

      let stopsCount = 0;
      let runStart = -1;
      for (let i = 0; i <= routePoints.length; i++) {
        const isStopped = i < routePoints.length && (routePoints[i].speed || 0) <= 2;
        if (isStopped && runStart === -1) {
          runStart = i;
        } else if (!isStopped && runStart !== -1) {
          if (i - runStart >= 4) {
            const st = routePoints[runStart];
            const en = routePoints[i - 1];
            stopsCount++;
            const pIcon = L.divIcon({
              className: '',
              html: '<div style="width:20px;height:20px;background:#1d4ed8;color:#fff;border:2px solid #fff;border-radius:6px;font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.4);transform:translate(-50%,-50%);">P</div>',
              iconSize: [0, 0],
              iconAnchor: [0, 0]
            });
            L.marker([st.lat, st.lng], { icon: pIcon })
              .addTo(routeLayerGroup)
              .bindPopup('<div class="text-xs font-bold">Стоянка #' + stopsCount + '</div><div class="text-[11px] text-slate-300">' + esc(st.time) + (en.time ? ' — ' + esc(en.time) : '') + '</div>');
          }
          runStart = -1;
        }
      }

      const first = routePoints[0];
      const last = routePoints[routePoints.length - 1];
      L.circleMarker([first.lat, first.lng], { radius: 7, color: '#fff', weight: 2, fillColor: '#16a34a', fillOpacity: 1 })
        .addTo(routeLayerGroup)
        .bindPopup('<div class="text-xs font-bold">Старт</div><div class="text-[11px] text-slate-300">' + esc(first.time) + '</div>');
      L.circleMarker([last.lat, last.lng], { radius: 7, color: '#fff', weight: 2, fillColor: '#dc2626', fillOpacity: 1 })
        .addTo(routeLayerGroup)
        .bindPopup('<div class="text-xs font-bold">Финиш</div><div class="text-[11px] text-slate-300">' + esc(last.time) + '</div>');

      routePlayMarker = L.circleMarker([first.lat, first.lng], {
        radius: 8,
        color: '#ffffff',
        weight: 3,
        fillColor: '#2563eb',
        fillOpacity: 1
      }).addTo(routeLayerGroup);

      playbackIdx = 0;
      const slider = document.getElementById('route-slider');
      slider.max = Math.max(0, routePoints.length - 1);
      slider.value = 0;
      updatePlaybackUI(false);

      const dist = calcDistanceKm(routePoints).toFixed(1);
      const tripAnalysis = analyzeRouteTrips(routePoints);
      const tripsCount = tripAnalysis.tripsCount;
      const loadingGroups = tripAnalysis.loadingGroups || [];

      // Отображаем на маршруте точки погрузки с названиями экскаваторов
      loadingGroups.forEach(grp => {
        const cnt = grp.loads.length;
        const loadIcon = L.divIcon({
          className: '',
          html: '<div style="display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-50%);">'
            + '<div style="width:28px;height:28px;background:linear-gradient(135deg,#f97316,#ea580c);color:#fff;border:2.5px solid #fff;border-radius:50%;font-size:13px;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(234,88,12,0.45);">⛏️</div>'
            + '<div class="car-label" style="margin-top:3px;border-color:rgba(249,115,22,0.55);">⛏️ ' + esc(grp.name) + ' · ' + cnt + '</div>'
            + '</div>',
          iconSize: [0, 0],
          iconAnchor: [0, 0],
          popupAnchor: [0, -16]
        });

        const listHtml = grp.loads.slice(0, 12).map((ld, idx) => {
          const t1 = ld.startTime ? ld.startTime.slice(-8) : '';
          const t2 = ld.endTime && ld.endTime !== ld.startTime ? ' — ' + ld.endTime.slice(-8) : '';
          return '<div class="flex justify-between gap-3 text-[11px] py-0.5"><span class="opacity-70">Рейс #' + (idx + 1) + '</span><span class="tabular-nums font-semibold">' + esc(t1 + t2) + '</span></div>';
        }).join('') + (cnt > 12 ? '<div class="text-[10px] opacity-60 mt-1">и ещё ' + (cnt - 12) + '...</div>' : '');

        L.marker([grp.lat, grp.lng], { icon: loadIcon, zIndexOffset: 650 })
          .addTo(routeLayerGroup)
          .bindPopup('<div class="text-center">'
            + '<div class="font-bold text-xs mb-1">⛏️ Погрузка: ' + esc(grp.name) + '</div>'
            + '<div class="lg-popup-zone text-[11px] font-semibold mb-1.5">Всего погрузок: ' + cnt + '</div>'
            + '<div class="lg-popup-meta pt-1.5 text-left max-h-36 overflow-y-auto">' + listHtml + '</div>'
            + '</div>');
      });

      const maxSpd = Math.round(Math.max(...routePoints.map(p => p.speed || 0)));
      const v = vehicles.find(x => x.id === ctxTargetId);

      document.getElementById('track-title').textContent = 'Маршрут: ' + (v ? v.name : ctxTargetId);
      document.getElementById('track-stat-dist').textContent = dist + ' км';
      document.getElementById('track-stat-trips').textContent = String(tripsCount);
      document.getElementById('track-stat-speed').textContent = maxSpd + ' км/ч';
      document.getElementById('track-stat-stops').textContent = String(stopsCount);
      const tStats = calcTrackTimeStats(routePoints);
      const tStatsEl = document.getElementById('track-time-stats');
      if (tStatsEl) {
        tStatsEl.textContent = tStats;
        tStatsEl.classList.toggle('hidden', !tStats);
      }
      document.getElementById('track-bar').classList.remove('hidden');

      setTimeout(() => {
        map.fitBounds(L.latLngBounds(allLatLngs).pad(0.15));
      }, 120);
      showToast('Маршрут построен (' + dist + ' км • рейсов: ' + tripsCount + ')', 'bg-blue-600');
    };

    function formatTrackPointTime(pt, idx) {
      const pad = n => String(n).padStart(2, '0');
      const raw = pt && pt.time ? String(pt.time).trim() : '';
      if (raw) {
        const tm = raw.match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
        if (tm) return tm[1].length === 5 ? tm[1] + ':00' : tm[1];
        if (/^\d{10,13}$/.test(raw)) {
          const ms = raw.length === 10 ? Number(raw) * 1000 : Number(raw);
          const d = new Date(ms);
          if (!isNaN(d.getTime())) return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        }
      }
      // Запасной вариант: если сервер не прислал время в точках, вычисляем по выбранному периоду
      const fVal = document.getElementById('route-from') && document.getElementById('route-from').value;
      const tVal = document.getElementById('route-to') && document.getElementById('route-to').value;
      if (fVal && tVal && routePoints.length > 1) {
        const fMs = new Date(fVal).getTime();
        const tMs = new Date(tVal).getTime();
        if (!isNaN(fMs) && !isNaN(tMs) && tMs > fMs) {
          const d = new Date(fMs + (tMs - fMs) * (idx / (routePoints.length - 1)));
          return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        }
      }
      return '--:--:--';
    }

    function updatePlaybackUI(shouldPan) {
      if (!routePoints.length) return;
      const pt = routePoints[playbackIdx] || routePoints[0];
      if (routePlayMarker) {
        routePlayMarker.setLatLng([pt.lat, pt.lng]);
      }
      if (shouldPan && playbackFollow && map) {
        map.panTo([pt.lat, pt.lng], { animate: true, duration: 0.25 });
      }
      document.getElementById('route-play-info').textContent = formatTrackPointTime(pt, playbackIdx);
    }

    function onPlaybackSlide(val) {
      playbackIdx = Math.max(0, Math.min(routePoints.length - 1, Number(val) || 0));
      updatePlaybackUI(true);
    }

    function togglePlaybackFollow() {
      playbackFollow = !playbackFollow;
      const btn = document.getElementById('btn-play-follow');
      if (btn) {
        btn.className = playbackFollow
          ? 'lg-press w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 text-white text-xs flex items-center justify-center shadow-md shadow-blue-600/25 shrink-0'
          : 'lg-icon-btn lg-press w-8 h-8 rounded-full text-xs flex items-center justify-center opacity-70 shrink-0';
      }
      if (playbackFollow) updatePlaybackUI(true);
    }

    function startPlaybackLoop() {
      if (playbackTimer) {
        clearInterval(playbackTimer);
        playbackTimer = null;
      }
      const cfgMap = {
        1: { ms: 180, step: Math.max(1, Math.floor(routePoints.length / 260)) },
        2: { ms: 90, step: Math.max(1, Math.floor(routePoints.length / 260)) },
        5: { ms: 55, step: Math.max(1, Math.ceil(routePoints.length / 150)) },
        10: { ms: 40, step: Math.max(1, Math.ceil(routePoints.length / 75)) }
      };
      const cfg = cfgMap[playbackSpeed] || cfgMap[1];

      playbackTimer = setInterval(() => {
        playbackIdx += cfg.step;
        if (playbackIdx >= routePoints.length - 1) {
          playbackIdx = routePoints.length - 1;
          document.getElementById('route-slider').value = playbackIdx;
          updatePlaybackUI(true);
          stopPlayback();
          return;
        }
        document.getElementById('route-slider').value = playbackIdx;
        updatePlaybackUI(true);
      }, cfg.ms);
    }

    function cyclePlaybackSpeed() {
      const idx = PLAYBACK_SPEEDS.indexOf(playbackSpeed);
      playbackSpeed = PLAYBACK_SPEEDS[(idx + 1) % PLAYBACK_SPEEDS.length];
      const btn = document.getElementById('btn-play-speed');
      if (btn) btn.textContent = playbackSpeed + 'x';
      if (playbackTimer) {
        startPlaybackLoop();
      }
    }

    function togglePlayback() {
      if (playbackTimer) {
        stopPlayback();
        return;
      }
      if (!routePoints.length) return;
      if (playbackIdx >= routePoints.length - 1) playbackIdx = 0;
      document.getElementById('btn-play-route').textContent = '❚❚';
      startPlaybackLoop();
    }

    function stopPlayback() {
      if (playbackTimer) {
        clearInterval(playbackTimer);
        playbackTimer = null;
      }
      const btn = document.getElementById('btn-play-route');
      if (btn) btn.textContent = '▶';
    }

    function clearRouteFromMap() {
      stopPlayback();
      routePoints = [];
      routePlayMarker = null;
      activeRouteObjectId = null;
      if (routeLayerGroup) routeLayerGroup.clearLayers();
      document.getElementById('track-bar').classList.add('hidden');
      updateFollowBar();
      renderDynamicZones();
      renderMarkers(true);
    }

    function openInfoModalFromCtx() {
      closeCtxMenu();
      const v = vehicles.find(x => x.id === ctxTargetId);
      if (!v) return;
      infoTargetId = v.id;

      document.getElementById('info-title').textContent = getVehicleEmoji(v) + ' ' + v.name;
      document.getElementById('info-sub').textContent = 'ID: ' + v.id + ' • ' + (v.online ? 'На связи' : 'Нет связи');

      const curZones = getZonesForVehicle(v);
      const zoneText = curZones.length ? curZones.map(z => z.icon + ' ' + z.name).join(', ') : 'Вне геозон';

      const mainRows = [
        ['Название', v.name],
        ['ID объекта', v.id],
        ['Текущая геозона', zoneText],
        ['Статус', !v.online ? 'Нет связи' : (v.active ? 'В движении' : (isVehicleOffOrOffline(v) ? 'Заглушен (на связи)' : 'Стоянка (на связи)'))],
        ['Скорость', Math.round(v.speed) + ' км/ч'],
        ['Курс (азимут)', v.course !== null && v.course !== undefined ? Math.round(v.course) + '°' : '—'],
        ['Состояние / длительность', v.duration],
        ['Последнее сообщение', v.lastTime],
        ['Адрес', v.address],
        ['Координаты (Lat, Lon)', v.lat.toFixed(6) + ', ' + v.lng.toFixed(6)]
      ];
      const distStr = formatDistanceFromMe(v);
      if (distStr) mainRows.push(['Расстояние от вас', distStr]);

      const cached = sensorCache[v.id];
      const initialFuel = (cached && cached.fuel) || v.fuel || '';
      const initialWeight = (cached && cached.weight) || '';
      const speedColorCls = v.active
        ? 'bg-emerald-500/10 border-emerald-500/30'
        : 'bg-blue-500/10 border-blue-500/30';

      let html = '<div class="grid grid-cols-3 gap-2">'
        + '<div class="bg-amber-500/10 rounded-2xl p-2.5 border border-amber-500/30 flex flex-col items-center text-center justify-center">'
        + '<span class="text-lg leading-none mb-1">⛽</span>'
        + '<div class="dm-muted text-[10px] font-bold text-slate-500 uppercase">Топливо</div>'
        + '<div id="info-fuel-value" class="text-sm font-bold mt-0.5 break-words">' + (initialFuel ? esc(initialFuel) : '...') + '</div>'
        + '</div>'
        + '<div class="bg-indigo-500/10 rounded-2xl p-2.5 border border-indigo-500/30 flex flex-col items-center text-center justify-center">'
        + '<span class="text-lg leading-none mb-1">⚖️</span>'
        + '<div class="dm-muted text-[10px] font-bold text-slate-500 uppercase">Вес</div>'
        + '<div id="info-weight-value" class="text-sm font-bold mt-0.5 break-words">' + (initialWeight ? esc(initialWeight) : '...') + '</div>'
        + '<div id="info-weight-sub" class="dm-muted text-[10px] text-slate-500 leading-tight mt-0.5 hidden"></div>'
        + '</div>'
        + '<div class="' + speedColorCls + ' rounded-2xl p-2.5 border flex flex-col items-center text-center justify-center">'
        + '<span class="text-lg leading-none mb-1">⚡</span>'
        + '<div class="dm-muted text-[10px] font-bold text-slate-500 uppercase">Скорость</div>'
        + '<div class="text-sm font-bold mt-0.5">' + Math.round(v.speed) + ' км/ч</div>'
        + '</div>'
        + '</div>';

      html += '<div class="dm-input bg-slate-50 rounded-2xl p-3 border border-slate-100">'
        + '<div class="dm-muted text-[11px] font-bold text-slate-400 uppercase mb-2">Основные данные</div>'
        + '<div class="divide-y divide-slate-200/70">'
        + mainRows.map(([k, val]) => '<div class="py-1.5 flex justify-between gap-3 text-xs"><span class="dm-muted text-slate-500 shrink-0">' + esc(k) + '</span><span class="font-semibold text-right break-all">' + esc(val) + '</span></div>').join('')
        + '</div></div>';

      html += '<div id="info-sensors-box" class="dm-input bg-slate-50 rounded-2xl p-3 border border-slate-100">'
        + '<div class="dm-muted text-[11px] font-bold text-slate-400 uppercase mb-1.5">Датчики (GetSensorsMobile)</div>'
        + '<div class="text-xs text-slate-400">Загрузка датчиков...</div>'
        + '</div>';

      const raw = v.rawFields || {};
      const rawKeys = Object.keys(raw);
      if (rawKeys.length > 0) {
        html += '<div class="dm-input bg-slate-50 rounded-2xl p-3 border border-slate-100">'
          + '<div class="dm-muted text-[11px] font-bold text-slate-400 uppercase mb-2">Все поля с сервера (' + rawKeys.length + ')</div>'
          + '<div class="divide-y divide-slate-200/70">'
          + rawKeys.map(k => '<div class="py-1.5 flex justify-between gap-3 text-xs"><span class="dm-muted text-slate-500 font-mono text-[11px] shrink-0">' + esc(k) + '</span><span class="font-medium text-right break-all">' + esc(raw[k]) + '</span></div>').join('')
          + '</div></div>';
      }

      document.getElementById('info-body').innerHTML = html;
      const _m_info_modal = document.getElementById('info-modal'); if (_m_info_modal._closeTimer) clearTimeout(_m_info_modal._closeTimer); _m_info_modal.classList.remove('modal-closing', 'hidden');

      sendNative('sputnik://sensors?id=' + encodeURIComponent(v.id));
    }

    window.onNativeSensorsResult = function(res) {
      const box = document.getElementById('info-sensors-box');
      const fuelEl = document.getElementById('info-fuel-value');
      const weightEl = document.getElementById('info-weight-value');
      const weightSubEl = document.getElementById('info-weight-sub');
      const sensorsList = (res && res.ok && res.sensors) ? res.sensors : [];
      const targetId = (res && res.objectId) || infoTargetId;
      const isInfoOpenForTarget = infoTargetId === targetId && !document.getElementById('info-modal').classList.contains('hidden');

      let parsedFuel = '';
      let parsedWeight = '';

      const fuelSensors = sensorsList.filter(s => /топлив|дут|бак|fuel|dut|lls|fls|tank|уровень/i.test(s.name));
      if (fuelSensors.length > 0) {
        parsedFuel = fuelSensors.map(s => s.value).join(' / ');
      }

      const weightSensors = sensorsList.filter(s => /вес|weight|load|груз|масс|тонн/i.test(s.name));
      const mainWeight = weightSensors.find(s => !/динам|dyn/i.test(s.name));
      const dynWeight = weightSensors.find(s => /динам|dyn/i.test(s.name));

      if (mainWeight) {
        parsedWeight = mainWeight.value;
      } else if (dynWeight) {
        parsedWeight = dynWeight.value;
      } else if (weightSensors.length > 0) {
        parsedWeight = weightSensors[0].value;
      }

      let parsedEngineOff = null;
      let parsedMassOff = null;
      const ignSensor = sensorsList.find(s => /зажиг|двиг|мотор|ignition|engine|двс/i.test(s.name));
      if (ignSensor) {
        const sv = String(ignSensor.value || '').trim().toLowerCase();
        if (/^(0|false|no|off|выкл|нет|заглуш)/.test(sv)) parsedEngineOff = true;
        else if (/^(1|true|yes|on|вкл|да|завед|работ)/.test(sv)) parsedEngineOff = false;
      }
      const massSensor = sensorsList.find(s => /масс|питан|напряж|борт|акб|volt|power|pwr|vbat/i.test(s.name));
      if (massSensor) {
        const sv = String(massSensor.value || '').trim().toLowerCase();
        const num = parseFloat(sv.replace(',', '.'));
        if (/^(0|false|no|off|выкл|нет)/.test(sv) || (!isNaN(num) && num <= 10)) {
          parsedMassOff = true;
          parsedEngineOff = true;
        } else if (/^(1|true|yes|on|вкл|да)/.test(sv) || (!isNaN(num) && num > 10)) {
          parsedMassOff = false;
        }
      }

      if (targetId) {
        const prev = sensorCache[targetId] || {};
        const nextEngineOff = parsedEngineOff !== null ? parsedEngineOff : (prev.engineOff !== undefined ? prev.engineOff : null);
        const nextMassOff = parsedMassOff !== null ? parsedMassOff : (prev.massOff !== undefined ? prev.massOff : null);
        const engChanged = prev.engineOff !== nextEngineOff || prev.massOff !== nextMassOff;
        sensorCache[targetId] = {
          fuel: parsedFuel || prev.fuel || '',
          weight: parsedWeight || prev.weight || '',
          engineOff: nextEngineOff,
          massOff: nextMassOff,
          loaded: true,
          pending: false,
          ts: Date.now()
        };
        // Онлайн-отсечка рейса по весам (переход <= 35 т -> >= 100 т)
        if (parsedWeight) {
          const wNum = parseFloat(String(parsedWeight).replace(',', '.'));
          if (!isNaN(wNum)) {
            const shiftKey = getCurrentShiftStart(new Date()).getTime();
            const tc = tripsCache[targetId] || {};
            if (tc.shiftKey !== shiftKey) {
              tc.shiftKey = shiftKey;
              tc.liveExtra = 0;
              tc.liveLoaded = false;
              tc.lastWeight = null;
            }
            if (wNum <= 35) {
              tc.liveLoaded = false;
            } else if (wNum >= 100 && !tc.liveLoaded && tc.lastWeight !== null && tc.lastWeight <= 35) {
              tc.liveLoaded = true;
              tc.liveExtra = (tc.liveExtra || 0) + 1;
            }
            tc.lastWeight = wNum;
            tripsCache[targetId] = tc;
          }
        }
        if (targetId === selectedId) {
          updateFollowBar();
        }
        if (engChanged) {
          renderFavoritesBar();
          renderMarkers(false);
          renderList();
        }
      }

      if (!isInfoOpenForTarget) return;

      if (fuelEl) {
        if (parsedFuel) fuelEl.textContent = parsedFuel;
        else if (fuelEl.textContent === '...') fuelEl.textContent = '—';
      }

      if (weightEl) {
        if (mainWeight) {
          weightEl.textContent = mainWeight.value;
          if (dynWeight && weightSubEl) {
            weightSubEl.textContent = 'дин. ' + dynWeight.value;
            weightSubEl.classList.remove('hidden');
          }
        } else if (dynWeight) {
          weightEl.textContent = dynWeight.value;
        } else if (weightSensors.length > 0) {
          weightEl.textContent = weightSensors[0].value;
        } else if (weightEl.textContent === '...') {
          weightEl.textContent = '—';
        }
      }

      if (!box) return;
      if (sensorsList.length > 0) {
        box.innerHTML = '<div class="dm-muted text-[11px] font-bold text-slate-400 uppercase mb-2">Датчики (' + sensorsList.length + ')</div>'
          + '<div class="divide-y divide-slate-200/70">'
          + sensorsList.map(s => '<div class="py-1.5 flex justify-between gap-3 text-xs"><span class="dm-muted text-slate-500">' + esc(s.name) + '</span><span class="font-semibold text-right">' + esc(s.value) + '</span></div>').join('')
          + '</div>';
      } else {
        box.innerHTML = '<div class="dm-muted text-[11px] font-bold text-slate-400 uppercase mb-1">Датчики</div>'
          + '<div class="text-xs text-slate-400">Дополнительные датчики не найдены</div>';
      }
    };

    function closeInfoModal() {
      closeModalAnimated('info-modal');
    }

    function fitAll() {
      const list = Object.values(markers);
      if (!list.length) return;
      map.fitBounds(L.featureGroup(list).getBounds().pad(0.2));
    }

    function stopFollowAndFitAll() {
      selectedId = null;
      updateFollowBar();
      renderMarkers(false);
      scheduleNextRefresh();
      fitAll();
    }

    function selectObject(id, zoomIn) {
      const v = vehicles.find(x => x.id === id);
      if (!v) return;
      selectedId = v.id;
      followPausedUntil = 0;
      renderMarkers(false);
      scheduleNextRefresh();
      kickAnim();
      renderFavoritesBar();
      updateFollowBar();
      fetchSensorsForSelected(v.id, false);
      fetchTripsForSelected(v.id, false);
      if (zoomIn) {
        const targetZoom = Math.max(map.getZoom(), 15);
        map.setView([v.lat, v.lng], targetZoom, { animate: true });
      } else if (prefs.followSelected) {
        map.panTo([v.lat, v.lng], { animate: true });
      }
      if (markers[v.id]) markers[v.id].openPopup();
    }

    function panToSelectedNow() {
      if (!selectedId) return;
      followPausedUntil = 0;
      const v = vehicles.find(x => x.id === selectedId);
      if (v && map) {
        map.panTo([v.lat, v.lng], { animate: true });
      }
    }

    function toggleFollowMode() {
      prefs.followSelected = !prefs.followSelected;
      const el = document.getElementById('opt-follow');
      if (el) el.checked = prefs.followSelected;
      persistPrefs();
      updateFollowBar();
      if (prefs.followSelected) panToSelectedNow();
    }

    function clearSelection() {
      selectedId = null;
      updateFollowBar();
      renderFavoritesBar();
      renderMarkers(false);
      scheduleNextRefresh();
      map.closePopup();
    }

    function updateFollowBar() {
      const bar = document.getElementById('follow-bar');
      if (!selectedId || activeRouteObjectId || isDrawingZone) {
        bar.classList.add('hidden');
        return;
      }
      const v = vehicles.find(x => x.id === selectedId);
      if (!v) {
        bar.classList.add('hidden');
        return;
      }
      bar.classList.remove('hidden');
      const followDotEl = document.getElementById('follow-dot');
      if (followDotEl) {
        if (isVehicleOffOrOffline(v)) {
          followDotEl.style.background = 'transparent';
          followDotEl.className = 'w-3.5 h-3.5 shrink-0 flex items-center justify-center';
          followDotEl.innerHTML = RED_CROSS_SVG;
        } else {
          followDotEl.innerHTML = '';
          followDotEl.className = 'w-2.5 h-2.5 rounded-full shrink-0 shadow-sm';
          followDotEl.style.background = getColor(v);
        }
      }
      document.getElementById('follow-name').textContent = getVehicleEmoji(v) + ' ' + v.name;

      let ageTag = '';
      const pm = parsePointTimeMs(v.lastTime);
      if (!isNaN(pm)) {
        const ageSec = Math.max(0, Math.round((Date.now() - pm) / 1000));
        if (ageSec < 3600) ageTag = ' (' + ageSec + 'с назад)';
      }
      const metaParts = ['🕒 ' + v.lastTime + ageTag];
      const zoneStr = formatVehicleZonesShort(v);
      if (zoneStr) metaParts.push(zoneStr);
      const distStr = formatDistanceFromMe(v);
      if (distStr) metaParts.push('📍 ' + distStr);
      document.getElementById('follow-meta').textContent = metaParts.join(' • ');

      const fuelBox = document.getElementById('follow-fuel-box');
      const weightBox = document.getElementById('follow-weight-box');
      const belazBox = document.getElementById('follow-belaz-box');
      const tripsBox = document.getElementById('follow-trips-box');
      const tripsValEl = document.getElementById('follow-trips-val');

      if (isExcavator(v)) {
        if (fuelBox) fuelBox.classList.add('hidden');
        if (weightBox) weightBox.classList.add('hidden');
        if (belazBox) belazBox.classList.remove('hidden');
        if (tripsBox) tripsBox.classList.add('hidden');
        const radius = Number(prefs.dynZoneRadius) || 60;
        const belazCount = countBelazNearExcavator(v, radius);
        document.getElementById('follow-belaz-label').textContent = 'БелАЗов (' + radius + ' м)';
        document.getElementById('follow-belaz-count').textContent = belazCount + ' шт.';
      } else {
        if (fuelBox) fuelBox.classList.remove('hidden');
        if (weightBox) weightBox.classList.remove('hidden');
        if (belazBox) belazBox.classList.add('hidden');
        if (tripsBox) tripsBox.classList.toggle('hidden', isFuelStation(v));

        const cached = sensorCache[v.id];
        const fuelVal = (cached && cached.fuel) || v.fuel || '';
        const weightVal = (cached && cached.weight) || '';
        const isLoadingSensors = cached && cached.pending && !cached.loaded;

        document.getElementById('follow-fuel').textContent = fuelVal || (isLoadingSensors ? '...' : '—');
        document.getElementById('follow-weight').textContent = weightVal || (isLoadingSensors ? '...' : '—');

        const tripsLblEl = document.getElementById('follow-trips-label');
        if (tripsLblEl) {
          tripsLblEl.textContent = 'Рейсы (№' + getCurrentShiftNumber(new Date()) + ')';
        }
        const distValEl = document.getElementById('follow-dist-val');
        if (tripsValEl && !isFuelStation(v)) {
          const tc = tripsCache[v.id];
          if (tc && tc.loaded) {
            tripsValEl.textContent = String((tc.count || 0) + (tc.liveExtra || 0));
            if (distValEl) {
              const curKm = tc.dispDistKm !== undefined ? tc.dispDistKm : ((tc.baseDistKm || 0) + (tc.liveDistKm || 0));
              distValEl.textContent = curKm.toFixed(1) + ' км';
            }
          } else if (tc && tc.pending) {
            tripsValEl.textContent = '...';
            if (distValEl) distValEl.textContent = '...';
          } else {
            tripsValEl.textContent = '—';
            if (distValEl) distValEl.textContent = '—';
          }
        }
      }

      document.getElementById('follow-speed').textContent = Math.round(v.speed) + ' км/ч';

      const spdBox = document.getElementById('follow-speed-box');
      const spdValEl = document.getElementById('follow-speed');
      if (spdBox && spdValEl) {
        const pillCls = !v.online ? 'lg-pill-red' : (v.active ? 'lg-pill-emerald' : 'lg-pill-neutral');
        spdBox.className = pillCls + ' lg-press rounded-2xl px-2 py-1.5 flex items-center justify-center gap-1.5 min-w-0 cursor-pointer';
        spdValEl.className = 'lg-pill-val tabular-nums text-[11px] font-bold truncate leading-tight mt-0.5';
      }

      const favBtn = document.getElementById('btn-follow-fav');
      if (favBtn) favBtn.textContent = isFavorite(v.id) ? '★' : '☆';
      const btn = document.getElementById('btn-follow-toggle');
      if (prefs.followSelected) {
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="7"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/></svg>';
        btn.className = 'lg-press w-7 h-7 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 text-white text-xs flex items-center justify-center shadow-md shadow-blue-600/25';
      } else {
        btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1.5"/><rect x="14" y="4" width="4" height="16" rx="1.5"/></svg>';
        btn.className = 'lg-icon-btn lg-press w-7 h-7 rounded-full text-xs flex items-center justify-center';
      }
    }

    function focusObj(id) {
      const v = vehicles.find(x => x.id === id);
      if (!v) return;
      switchTab('map');
      setTimeout(() => {
        selectObject(v.id, true);
      }, 150);
    }

    function onMapSearchInput() {
      const input = document.getElementById('map-search');
      const clearBtn = document.getElementById('map-search-clear');
      const box = document.getElementById('map-search-results');
      const q = input.value.trim().toLowerCase();

      clearBtn.classList.toggle('hidden', !q);

      if (!q) {
        box.classList.add('hidden');
        box.innerHTML = '';
        return;
      }

      const matches = vehicles.filter(v => v.name.toLowerCase().includes(q)).slice(0, 15);
      if (!matches.length) {
        box.innerHTML = '<div class="px-3.5 py-2.5 text-xs text-slate-400 text-center">Объекты не найдены</div>';
      } else {
        box.innerHTML = matches.map(v => {
          const c = getColor(v);
          return '<div onclick="selectMapSearchObj(\\'' + esc(v.id) + '\\')" class="flex items-center gap-2.5 px-3.5 py-2.5 active:bg-slate-100/50 border-b border-slate-100/60 last:border-b-0">'
            + '<div class="w-6 h-6 rounded-lg flex items-center justify-center text-xs shrink-0" style="background:' + c + '">' + getVehicleEmoji(v) + '</div>'
            + '<div class="flex-1 min-w-0">'
            + '<div class="text-xs font-semibold truncate">' + esc(v.name) + '</div>'
            + '<div class="dm-muted text-[11px] text-slate-400 truncate">' + esc(v.address) + '</div>'
            + '</div>'
            + '<span class="text-[10px] font-semibold shrink-0" style="color:' + c + '">' + esc(v.duration) + '</span>'
            + '</div>';
        }).join('');
      }
      box.classList.remove('hidden');
    }

    function clearMapSearch() {
      document.getElementById('map-search').value = '';
      document.getElementById('map-search-clear').classList.add('hidden');
      const box = document.getElementById('map-search-results');
      box.classList.add('hidden');
      box.innerHTML = '';
    }

    function selectMapSearchObj(id) {
      const v = vehicles.find(x => x.id === id);
      if (!v) return;
      document.getElementById('map-search').value = v.name;
      document.getElementById('map-search-clear').classList.remove('hidden');
      document.getElementById('map-search-results').classList.add('hidden');
      document.getElementById('map-search').blur();
      selectObject(v.id, true);
    }

    function clearListSearch() {
      document.getElementById('search').value = '';
      renderList();
    }

    function setTypeFilter(val) {
      typeF = val;
      ['all', 'fav', 'exc', 'fuel', 'other'].forEach(k => {
        const el = document.getElementById('ft-' + k);
        if (!el) return;
        el.className = k === val
          ? 'shrink-0 px-2.5 py-1.5 rounded-xl bg-blue-600 text-white'
          : 'dm-input shrink-0 px-2.5 py-1.5 rounded-xl bg-slate-100 text-slate-600';
      });
      renderList();
    }

    function setConn(val) {
      connF = val;
      ['all', 'online', 'offline'].forEach(k => {
        document.getElementById('fc-' + k).className = k === val ? 'py-1.5 rounded-lg bg-blue-600 text-white' : 'py-1.5 rounded-lg text-slate-500';
      });
      renderList();
    }

    function setAct(val) {
      actF = val;
      ['all', 'active', 'inactive'].forEach(k => {
        document.getElementById('fa-' + k).className = k === val ? 'py-1.5 rounded-lg bg-blue-600 text-white' : 'py-1.5 rounded-lg text-slate-500';
      });
      renderList();
    }

    function renderList() {
      const tabObj = document.getElementById('tab-objects');
      if (tabObj && tabObj.classList.contains('hidden')) return;
      const q = document.getElementById('search').value.trim().toLowerCase();
      document.getElementById('search-clear').classList.toggle('hidden', !q);
      const favOrder = Array.isArray(prefs.favorites) ? prefs.favorites : [];
      updateFilterButtonBadge();
      const filtered = vehicles.filter(v => {
        if (!isVehicleAllowedByFilter(v)) return false;
        if (typeF === 'fav' && !isFavorite(v.id)) return false;
        if (typeF === 'exc' && !isExcavator(v)) return false;
        if (typeF === 'fuel' && !isFuelStation(v)) return false;
        if (typeF === 'other' && (isExcavator(v) || isFuelStation(v))) return false;
        if (connF === 'online' && !v.online) return false;
        if (connF === 'offline' && v.online) return false;
        if (actF === 'active' && !v.active) return false;
        if (actF === 'inactive' && v.active) return false;
        if (q && !v.name.toLowerCase().includes(q) && !v.address.toLowerCase().includes(q)) return false;
        return true;
      }).sort((a, b) => {
        const ia = favOrder.indexOf(a.id);
        const ib = favOrder.indexOf(b.id);
        if (ia >= 0 && ib >= 0) return ia - ib;
        if (ia >= 0) return -1;
        if (ib >= 0) return 1;
        return 0;
      });

      const el = document.getElementById('list');
      if (!filtered.length) {
        el.innerHTML = '<div class="p-8 text-center text-slate-400 text-sm">Нет объектов</div>';
        return;
      }
      el.innerHTML = filtered.map((v, idx) => {
        const c = getColor(v);
        const fav = isFavorite(v.id);
        const isOff = isVehicleOffOrOffline(v);
        const zoneStr = formatVehicleZonesShort(v);
        const telem = getCachedTelemetryShort(v);
        const subText = zoneStr || telem || v.address;
        const subCls = zoneStr ? 'text-[11px] font-semibold text-amber-500 truncate' : 'dm-muted text-xs text-slate-500 truncate';
        const badgeStyle = (isOff && !isExcavator(v) && !isFuelStation(v))
          ? 'background:#fff;border:2px solid #ef4444;color:#ef4444;'
          : 'background:' + c + ';';
        const badgeGlyph = (isOff && !isExcavator(v) && !isFuelStation(v))
          ? RED_CROSS_SVG
          : getVehicleEmoji(v);
        const delayMs = Math.min(idx, 12) * 22;
        return '<div style="animation-delay:' + delayMs + 'ms" class="lg-card lg-list-item lg-press flex items-center gap-2.5 px-3.5 py-3 rounded-2xl">'
          + '<button onclick="event.stopPropagation();toggleFavorite(\\'' + esc(v.id) + '\\')" class="lg-press text-lg leading-none ' + (fav ? 'text-amber-400' : 'text-slate-300') + ' px-1">' + (fav ? '★' : '☆') + '</button>'
          + '<div onclick="focusObj(\\'' + esc(v.id) + '\\')" class="flex-1 min-w-0 flex items-center gap-2.5">'
          + '<div class="w-9 h-9 rounded-2xl flex items-center justify-center shrink-0 text-white text-sm shadow-sm" style="' + badgeStyle + '">' + badgeGlyph + '</div>'
          + '<div class="flex-1 min-w-0"><div class="flex justify-between gap-2"><div class="font-semibold text-sm truncate">' + esc(v.name) + '</div><span class="tabular-nums text-[11px] font-bold shrink-0" style="color:' + c + '">' + esc(v.duration) + '</span></div><div class="' + subCls + '">' + esc(subText) + '</div></div>'
          + '</div>'
          + '<button onclick="event.stopPropagation();openCtxMenu(\\'' + esc(v.id) + '\\')" title="Действия" class="dm-input lg-press w-8 h-8 rounded-xl bg-white/60 text-slate-500 font-bold text-sm flex items-center justify-center shrink-0">⋯</button>'
          + '</div>';
      }).join('');
    }

    function copyLog() {
      const txt = document.getElementById('log-box').textContent;
      sendNative('sputnik://copy?text=' + encodeURIComponent(txt));
      showToast('Лог скопирован', 'bg-slate-800');
    }

    function shareAppFile() {
      const btn = document.getElementById('btn-share-app');
      if (btn) btn.textContent = '...';
      sendNative('sputnik://shareapp');
    }

    window.onNativeShareResult = function(res) {
      const btn = document.getElementById('btn-share-app');
      if (btn) btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg><span>Отправить</span>';
      if (res && !res.ok && res.error) {
        showToast(res.error, 'bg-red-600');
      }
    };

    function showToast(msg, cls) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.className = 'toast-anim fixed top-4 left-1/2 -translate-x-1/2 z-[1200] max-w-[90%] text-xs font-semibold px-5 py-3 rounded-full backdrop-blur-2xl border border-white/25 shadow-2xl text-center text-white ' + cls;
      clearTimeout(window._tt);
      window._tt = setTimeout(() => t.classList.add('hidden'), 3200);
    }

    function esc(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }
  </script>
</body>
</html>`;
}

// ============================================================================
// 4. ЗАПУСК ПРИЛОЖЕНИЯ В SCRIPTABLE
// ============================================================================
function safeJsonForJs(obj) {
  return JSON.stringify(obj)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function parseQueryParams(url) {
  const query = url.split("?")[1] || "";
  const params = {};
  query.split("&").forEach(pair => {
    const eq = pair.indexOf("=");
    if (eq > 0) {
      const k = pair.slice(0, eq);
      const v = pair.slice(eq + 1);
      params[decodeURIComponent(k)] = decodeURIComponent(v || "");
    }
  });
  return params;
}

async function cachedAsset(url, name) {
  const path = fm.joinPath(fm.documentsDirectory(), name);
  try {
    if (fm.fileExists(path)) {
      const cached = fm.readString(path);
      if (cached && cached.length > 1000) return cached;
    }
  } catch (e) {}
  try {
    const req = new Request(url);
    req.timeoutInterval = 15;
    const txt = await req.loadString();
    const st = req.response && req.response.statusCode;
    if (txt && txt.length > 1000 && (!st || st < 400)) {
      fm.writeString(path, txt);
      return txt;
    }
  } catch (e) {}
  return null;
}

async function loadAssets() {
  const [tailwind, leafletCss, leafletJs] = await Promise.all([
    Promise.resolve(null),
    cachedAsset("https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", "sputnik_cache_leaflet.css"),
    cachedAsset("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js", "sputnik_cache_leaflet.js")
  ]);
  return { tailwind, leafletCss, leafletJs };
}

async function main() {
  const settings = loadSettings();
  const wv = new WebView();

  wv.shouldAllowRequest = (request) => {
    const url = request.url || "";

    if (url.startsWith("sputnik://connect?")) {
      const params = parseQueryParams(url);
      (async () => {
        try {
          const result = await performConnect(params.server, params.login, params.password);
          await wv.evaluateJavaScript(`window.onNativeResult(${safeJsonForJs(result)});`, false);
        } catch (err) {
          const fallback = { ok: false, error: err.message || "Сбой подключения", logs: [String(err)] };
          await wv.evaluateJavaScript(`window.onNativeResult(${safeJsonForJs(fallback)});`, false);
        }
      })();
      return false;
    }

    if (url.startsWith("sputnik://reconnect?")) {
      const params = parseQueryParams(url);
      (async () => {
        try {
          const result = await performConnect(params.server, params.login, params.password);
          await wv.evaluateJavaScript(`window.onNativeReconnectResult(${safeJsonForJs(result)});`, false);
        } catch (err) {
          const fallback = { ok: false, error: err.message || "Сбой переподключения" };
          await wv.evaluateJavaScript(`window.onNativeReconnectResult(${safeJsonForJs(fallback)});`, false);
        }
      })();
      return false;
    }

    if (url.startsWith("sputnik://refresh")) {
      const isSilent = url.includes("silent=1");
      const onlyId = parseQueryParams(url).only || "";
      (async () => {
        try {
          const result = await performFastRefresh();
          if (result && result.ok && Array.isArray(result.vehicles)) {
            if (onlyId) {
              // обновляем только выбранный объект: в WebView уходит 1 объект, а не весь парк
              result.vehicles = result.vehicles.filter(v => String(v.id) === String(onlyId));
              result.partial = true;
            }
            // не гоняем тяжёлые rawFields в WebView на каждом обновлении (они уже есть после входа)
            result.vehicles = result.vehicles.map(v => {
              const slim = Object.assign({}, v);
              delete slim.rawFields;
              return slim;
            });
          }
          await wv.evaluateJavaScript(`window.onNativeRefreshResult(${safeJsonForJs(result)}, ${isSilent});`, false);
        } catch (err) {
          const fallback = { ok: false, error: err.message || "Сбой обновления" };
          await wv.evaluateJavaScript(`window.onNativeRefreshResult(${safeJsonForJs(fallback)}, ${isSilent});`, false);
        }
      })();
      return false;
    }

    if (url.startsWith("sputnik://saveprefs?")) {
      try {
        const params = parseQueryParams(url);
        const parsed = JSON.parse(params.data || "{}");
        const current = loadSettings();
        saveSettings(Object.assign({}, current, parsed));
      } catch (e) {}
      return false;
    }

    if (url.startsWith("sputnik://copy?")) {
      try {
        const params = parseQueryParams(url);
        Pasteboard.copyString(params.text || "");
      } catch (e) {}
      return false;
    }

    if (url.startsWith("sputnik://trips?")) {
      const params = parseQueryParams(url);
      (async () => {
        try {
          const result = await performGetHistory(params.id, params.from, params.to, params.altIds || "");
          const payload = { ok: Boolean(result && result.ok), objectId: params.id, points: (result && result.points) || [] };
          await wv.evaluateJavaScript(`window.onNativeTripsResult(${safeJsonForJs(payload)});`, false);
        } catch (err) {
          await wv.evaluateJavaScript(`window.onNativeTripsResult({ok:false,objectId:${safeJsonForJs(params.id)},points:[]});`, false);
        }
      })();
      return false;
    }

    if (url.startsWith("sputnik://history?")) {
      const params = parseQueryParams(url);
      (async () => {
        try {
          const result = await performGetHistory(params.id, params.from, params.to, params.altIds || "");
          await wv.evaluateJavaScript(`window.onNativeHistoryResult(${safeJsonForJs(result)});`, false);
        } catch (err) {
          const fallback = { ok: false, error: err.message || "Ошибка загрузки маршрута" };
          await wv.evaluateJavaScript(`window.onNativeHistoryResult(${safeJsonForJs(fallback)});`, false);
        }
      })();
      return false;
    }

    if (url.startsWith("sputnik://shareapp")) {
      (async () => {
        try {
          const result = await performShareApp();
          await wv.evaluateJavaScript(`window.onNativeShareResult(${safeJsonForJs(result)});`, false);
        } catch (err) {
          const fallback = { ok: false, error: err.message || "Ошибка экспорта" };
          await wv.evaluateJavaScript(`window.onNativeShareResult(${safeJsonForJs(fallback)});`, false);
        }
      })();
      return false;
    }

    if (url.startsWith("sputnik://sensors?")) {
      const params = parseQueryParams(url);
      (async () => {
        try {
          const result = await performGetSensors(params.id);
          await wv.evaluateJavaScript(`window.onNativeSensorsResult(${safeJsonForJs(result)});`, false);
        } catch (err) {
          await wv.evaluateJavaScript(`window.onNativeSensorsResult({ok:false,objectId:${safeJsonForJs(params.id)},sensors:[]});`, false);
        }
      })();
      return false;
    }

    if (url.startsWith("sputnik://zones")) {
      (async () => {
        try {
          const result = await performGetZones();
          await wv.evaluateJavaScript(`window.onNativeZonesResult(${safeJsonForJs(result)});`, false);
        } catch (err) {
          const fallback = { ok: false, error: err.message || "Ошибка геозон", zones: [] };
          await wv.evaluateJavaScript(`window.onNativeZonesResult(${safeJsonForJs(fallback)});`, false);
        }
      })();
      return false;
    }

    if (url.startsWith("sputnik://mylocation")) {
      (async () => {
        try {
          const result = await performGetMyLocation();
          await wv.evaluateJavaScript(`window.onNativeLocationResult(${safeJsonForJs(result)});`, false);
        } catch (err) {
          const fallback = { ok: false, error: err.message || "Ошибка GPS" };
          await wv.evaluateJavaScript(`window.onNativeLocationResult(${safeJsonForJs(fallback)});`, false);
        }
      })();
      return false;
    }

    return true;
  };

  const assets = await loadAssets();
  await wv.loadHTML(buildAppHtml(settings, assets));
  await wv.present(true);
}

await main();
})().catch(e => Android.fatal(String((e && e.stack) || e)));
