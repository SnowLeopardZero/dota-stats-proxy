// Посредник к Stratz для Vercel.
// Stratz не пускает запросы с общих адресов Cloudflare, поэтому постоянный сайт
// (cloudflare/worker.js) пересылает запросы сюда — адрес задаётся в STRATZ_PROXY.
// Делает то же, что server.py: запросы только по готовым шаблонам, лимиты, кеш.
// Токен — в настройках проекта Vercel (Environment Variables → STRATZ_TOKEN), в файлах его нет.

const STRATZ_URL = "https://api.stratz.com/graphql";

// Ограничения, чтобы не потратить лимит токена
const LIMIT_TOTAL = 150;  // запросов к Stratz в минуту всего
const CACHE_SECONDS = { player: 120, match: 600, heroItems: 3600 };  // сколько хранить ответ

// Типы матчей — те же, что в app.js (CATEGORIES) и server.py
const CATEGORY_FILTERS = {
  all: "",
  ranked: "lobbyTypeIds: [7]",
  normal: "gameModeIds: [1, 22], lobbyTypeIds: [0]",
  turbo: "gameModeIds: [23]",
};

function playerQuery(pid) {
  const groups = Object.entries(CATEGORY_FILTERS).map(([key, f]) => `h_${key}: matchesGroupBy(request: { playerList: SINGLE, groupBy: HERO, take: 100000 ${f ? ", " + f : ""} }) {
          ... on MatchGroupByHeroType { heroId matchCount winCount }
        }
        `).join("");
  return `query { player(steamAccountId: ${pid}) {
      matchCount
      winCount
      steamAccount { seasonRank seasonLeaderboardRank smurfFlag }
      ranks { rank asOfDateTime }
      ${groups}
      matches(request: { take: 100 }) {
        id didRadiantWin durationSeconds startDateTime gameMode lobbyType rank
        players(steamAccountId: ${pid}) {
          heroId kills deaths assists isRadiant leaverStatus
          goldPerMinute experiencePerMinute numLastHits
        }
      }
    } }`;
}

function matchQuery(mid) {
  return `query { match(id: ${mid}) {
      radiantNetworthLeads
      radiantExperienceLeads
      topLaneOutcome midLaneOutcome bottomLaneOutcome
      players {
        heroId imp position lane award intentionalFeeding
        stats {
          itemPurchases { itemId time }
          deathEvents { time }
          killEvents { time }
          wards { type }
          campStack
          runes { time }
          lastHitsPerMinute
        }
      }
    } }`;
}

function heroItemsQuery(hid) {
  return `query { heroStats {
      itemFullPurchase(heroId: ${hid}) { itemId time matchCount winCount }
      itemBootPurchase(heroId: ${hid}) { itemId time matchCount winCount }
    } }`;
}

// Разрешённые запросы: вид -> [шаблон, самый большой допустимый ID]
const QUERIES = {
  player: [playerQuery, 2 ** 32],
  match: [matchQuery, 2 ** 40],
  heroItems: [heroItemsQuery, 1000],
};

// Кеш и счётчик живут в памяти, пока Vercel держит функцию запущенной
const cache = new Map();  // "вид:id" -> [время, ответ]
let requestTimes = [];    // времена запросов к Stratz за последнюю минуту

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
    if (text.length > 1000) throw new Error();
  }
  return JSON.parse(text);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Нужен POST" });

  const token = (process.env.STRATZ_TOKEN || "").trim();
  if (!token) return sendJson(res, 503, { error: "Токен Stratz не задан" });

  // Присылают только {"kind": "player" | "match" | "heroItems", "id": число}
  let kind, itemId;
  try {
    const body = await readBody(req);
    kind = body.kind;
    itemId = Number(body.id);
    if (!Object.hasOwn(QUERIES, kind) || !Number.isInteger(itemId)) throw new Error();
    if (!(itemId > 0 && itemId < QUERIES[kind][1])) throw new Error();
  } catch (e) {
    return sendJson(res, 400, { error: "Неверный запрос" });
  }

  // Если недавно уже спрашивали то же самое — отвечаем из кеша
  const key = kind + ":" + itemId;
  const saved = cache.get(key);
  if (saved && Date.now() - saved[0] < CACHE_SECONDS[kind] * 1000) return sendJson(res, 200, saved[1]);

  if (!allowed()) return sendJson(res, 429, { error: "Слишком много запросов, подожди минуту" });

  try {
    const response = await fetch(STRATZ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token,
        "User-Agent": "STRATZ_API",  // Stratz требует такой заголовок
      },
      body: JSON.stringify({ query: QUERIES[kind][0](itemId) }),
    });
    if (!response.ok) {
      // Начало ответа помогает понять причину отказа
      const detail = (await response.text()).slice(0, 200);
      return sendJson(res, response.status, { error: "Stratz ответил ошибкой " + response.status, detail });
    }
    const data = await response.json();
    cache.set(key, [Date.now(), data]);
    if (cache.size > 500) cache.delete(cache.keys().next().value);  // чтобы кеш не разрастался
    return sendJson(res, 200, data);
  } catch (e) {
    return sendJson(res, 502, { error: "Не удалось связаться со Stratz: " + e.message });
  }
};
