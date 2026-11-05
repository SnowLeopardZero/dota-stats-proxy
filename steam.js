// Посредник к steamcommunity для Vercel.
// Steam отвечает 429 на запросы с общих адресов Cloudflare, поэтому worker
// (cloudflare/worker.js) пересылает сюда запросы инвентаря, цен и профиля.
// Адрес посредника задаётся в STEAM_PROXY в wrangler.toml сайта.
//
// Публичным прокси это не является: worker присылает заголовок X-Steam-Proxy-Secret,
// здесь он сверяется с переменной STEAM_SESSION_SECRET (та же, что в Cloudflare).
// Разрешены только три вида запросов с проверкой параметров — произвольный
// запрос к Steam через наш токен/адрес не пройдёт.

const COMMUNITY = "https://steamcommunity.com";
// steamcommunity не любит «компьютерные» заголовки User-Agent — притворяемся браузером
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const LIMIT_TOTAL = 150;                  // запросов к Steam в минуту всего
const INVENTORY_CACHE = 300;              // инвентарь — 5 минут
const PROFILE_CACHE = 600;                // ник и аватар — 10 минут
const PRICE_CACHE = 6 * 3600;             // цена предмета — 6 часов
const PRICE_CHUNK = 30;                   // столько цен отдаём за один запрос
const GAMES = { 570: "Dota 2", 730: "Counter-Strike 2", 440: "Team Fortress 2", 252490: "Rust" };

// Кеш и счётчик живут в памяти, пока Vercel держит функцию запущенной
const cache = new Map();  // ключ -> [время, ответ]
let requestTimes = [];

function allowed() {
  const now = Date.now();
  requestTimes = requestTimes.filter((t) => now - t < 60000);
  if (requestTimes.length >= LIMIT_TOTAL) return false;
  requestTimes.push(now);
  return true;
}

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

// Vercel обычно сам разбирает JSON в req.body; если нет — читаем тело сами
async function readBody(req) {
  if (req.body !== undefined) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 4000) throw new Error();
  }
  return JSON.parse(text);
}

async function steamGet(url) {
  return fetch(url, { headers: { "User-Agent": BROWSER_UA }, signal: AbortSignal.timeout(20000) });
}

// Ответ Steam вида "1 234,56 pуб." — превращаем в число
function parsePrice(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/[^\d,.\s]/g, "").trim()
    .replace(/[\s\u00a0\u202f]/g, "").replace(",", ".");
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : null;
}

// ---------- Виды запросов ----------

// Инвентарь: отдаём статус и тело как есть — парсит worker (там та же логика, что у server.py)
async function runInventory(res, p) {
  const key = "inv:" + p.steamid + ":" + p.appid;
  const saved = cache.get(key);
  if (saved && Date.now() - saved[0] < INVENTORY_CACHE * 1000) return sendJson(res, 200, saved[1]);

  if (!allowed()) return sendJson(res, 429, { error: "Слишком много запросов, подожди минуту" });

  let result;
  try {
    const response = await steamGet(COMMUNITY + "/inventory/" + p.steamid + "/" + p.appid + "/2?l=russian&count=5000");
    let body = null;
    if (response.status === 200) body = await response.json();
    result = { steamStatus: response.status, body: body };
  } catch (e) {
    return sendJson(res, 502, { error: "Не удалось связаться со Steam: " + e.message });
  }
  // 429 не кешируем — вдруг лимит скоро снимется
  if (result.steamStatus !== 429) {
    cache.set(key, [Date.now(), result]);
    if (cache.size > 500) cache.delete(cache.keys().next().value);
  }
  return sendJson(res, 200, result);
}

// Цены: сразу пачкой, с кешем 6 часов
async function runPrices(res, p) {
  const prices = {};
  let limited = false;
  for (const hash of p.hashes) {
    const key = "price:" + p.appid + ":" + hash;
    const saved = cache.get(key);
    if (saved && Date.now() - saved[0] < PRICE_CACHE * 1000) {
      prices[hash] = saved[1];
      continue;
    }
    if (!allowed()) { limited = true; break; }
    try {
      const response = await steamGet(COMMUNITY + "/market/priceoverview/?appid=" + p.appid +
        "&currency=5&market_hash_name=" + encodeURIComponent(hash));
      if (response.status === 429) { limited = true; break; }
      let price = null;
      if (response.ok) {
        const data = await response.json();
        price = data.success !== false ? parsePrice(data.lowest_price || data.median_price) : null;
      }
      cache.set(key, [Date.now(), price]);
      if (cache.size > 500) cache.delete(cache.keys().next().value);
      prices[hash] = price;
    } catch (e) {
      prices[hash] = null;
    }
  }
  return sendJson(res, 200, { prices: prices, limited: limited });
}

// Профиль: ник и аватар из публичного XML (ключа Steam Web API не нужно)
async function runProfile(res, p) {
  const key = "profile:" + p.steamid;
  const saved = cache.get(key);
  if (saved && Date.now() - saved[0] < PROFILE_CACHE * 1000) return sendJson(res, 200, saved[1]);

  if (!allowed()) return sendJson(res, 429, { error: "Слишком много запросов, подожди минуту" });

  const profile = { name: null, avatar: null };
  try {
    const response = await steamGet(COMMUNITY + "/profiles/" + p.steamid + "/?xml=1");
    if (response.ok) {
      const text = await response.text();
      const name = text.match(/<steamID><!\[CDATA\[(.+?)\]\]><\/steamID>/s);
      const avatar = text.match(/<avatarMedium><!\[CDATA\[(.+?)\]\]><\/avatarMedium>/s);
      profile.name = name ? name[1] : null;
      profile.avatar = avatar ? avatar[1] : null;
    }
  } catch (e) {
    // не вышло — вернём пустой профиль, в кабинете покажется Steam ID
  }
  cache.set(key, [Date.now(), profile]);
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return sendJson(res, 200, profile);
}

// Разрешённые виды: вид -> проверка параметров
const KINDS = {
  inventory: {
    check(p) {
      if (!/^\d{17}$/.test(String(p.steamid || ""))) throw new Error();
      if (!Object.hasOwn(GAMES, Number(p.appid))) throw new Error();
      p.appid = Number(p.appid);
    },
    run: runInventory,
  },
  prices: {
    check(p) {
      if (!Object.hasOwn(GAMES, Number(p.appid))) throw new Error();
      p.appid = Number(p.appid);
      if (!Array.isArray(p.hashes) || !p.hashes.length || p.hashes.length > PRICE_CHUNK) throw new Error();
      p.hashes = p.hashes.map(String).filter(Boolean);
    },
    run: runPrices,
  },
  profile: {
    check(p) {
      if (!/^\d{17}$/.test(String(p.steamid || ""))) throw new Error();
    },
    run: runProfile,
  },
};

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Нужен POST" });

  const secret = (process.env.STEAM_SESSION_SECRET || "").trim();
  if (!secret) return sendJson(res, 503, { error: "Секрет посредника не задан" });
  if (String(req.headers["x-steam-proxy-secret"] || "").trim() !== secret) {
    return sendJson(res, 403, { error: "Нет доступа" });
  }

  // Присылают только {"kind": "inventory" | "prices" | "profile", ...параметры}
  let kind, p;
  try {
    p = await readBody(req);
    kind = p.kind;
    if (!Object.hasOwn(KINDS, kind)) throw new Error();
    KINDS[kind].check(p);
  } catch (e) {
    return sendJson(res, 400, { error: "Неверный запрос" });
  }
  return KINDS[kind].run(res, p);
};
