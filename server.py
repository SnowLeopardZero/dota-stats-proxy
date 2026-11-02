# Маленький сервер для страницы «Dota статистика».
# 1) Показывает файлы страницы (index.html, style.css, app.js).
# 2) Ходит в Stratz: браузер сам туда обратиться не может,
#    а токен нельзя класть в код страницы — его увидел бы любой.
#
# Запросы к Stratz сервер собирает сам по готовым шаблонам (игрок, матч, предметы героя).
# Страница присылает только вид запроса и число-ID — так чужой человек не сможет
# использовать твой токен для своих запросов.
#
# Токен берётся из переменной окружения STRATZ_TOKEN (в файлах его нет),
# а если окно открыто до setx — прямо из настроек Windows.
# Запуск: python server.py  ->  открыть http://localhost:8765

import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# На Render порт задаёт сам хостинг (переменная PORT) — тогда слушаем все адреса, иначе только свой компьютер
ON_HOSTING = bool(os.environ.get("PORT"))
PORT = int(os.environ.get("PORT") or (sys.argv[1] if len(sys.argv) > 1 else 8765))  # другой порт: python server.py 8766
HOST = "0.0.0.0" if ON_HOSTING else "127.0.0.1"
STRATZ_URL = "https://api.stratz.com/graphql"
FOLDER = os.path.dirname(os.path.abspath(__file__))

# Ограничения, чтобы не потратить лимит токена
LIMIT_PER_VISITOR = 30   # запросов к Stratz в минуту с одного адреса
LIMIT_TOTAL = 150        # запросов к Stratz в минуту всего
CACHE_SECONDS = {"player": 120, "match": 600, "heroItems": 3600}  # сколько хранить ответ

# Типы матчей — те же, что в app.js (CATEGORIES)
CATEGORY_FILTERS = {
    "all": "",
    "ranked": "lobbyTypeIds: [7]",
    "normal": "gameModeIds: [1, 22], lobbyTypeIds: [0]",
    "turbo": "gameModeIds: [23]",
}


def player_query(pid):
    groups = "".join(
        f"""h_{key}: matchesGroupBy(request: {{ playerList: SINGLE, groupBy: HERO, take: 100000 {", " + f if f else ""} }}) {{
          ... on MatchGroupByHeroType {{ heroId matchCount winCount }}
        }}
        """ for key, f in CATEGORY_FILTERS.items())
    return f"""query {{ player(steamAccountId: {pid}) {{
      matchCount
      winCount
      steamAccount {{ seasonRank seasonLeaderboardRank smurfFlag }}
      ranks {{ rank asOfDateTime }}
      {groups}
      matches(request: {{ take: 100 }}) {{
        id didRadiantWin durationSeconds startDateTime gameMode lobbyType rank
        players(steamAccountId: {pid}) {{
          heroId kills deaths assists isRadiant leaverStatus
          goldPerMinute experiencePerMinute numLastHits
        }}
      }}
    }} }}"""


def match_query(mid):
    return f"""query {{ match(id: {mid}) {{
      radiantNetworthLeads
      radiantExperienceLeads
      topLaneOutcome midLaneOutcome bottomLaneOutcome
      players {{
        heroId imp position lane award intentionalFeeding
        stats {{
          itemPurchases {{ itemId time }}
          deathEvents {{ time }}
          killEvents {{ time }}
          wards {{ type }}
          campStack
          runes {{ time }}
          lastHitsPerMinute
        }}
      }}
    }} }}"""


def hero_items_query(hid):
    return f"""query {{ heroStats {{
      itemFullPurchase(heroId: {hid}) {{ itemId time matchCount winCount }}
      itemBootPurchase(heroId: {hid}) {{ itemId time matchCount winCount }}
    }} }}"""


# Разрешённые запросы: вид -> (шаблон, самый большой допустимый ID)
QUERIES = {
    "player": (player_query, 2 ** 32),
    "match": (match_query, 2 ** 40),
    "heroItems": (hero_items_query, 1000),
}

cache = {}       # (вид, id) -> (время, ответ)
requests_log = {}  # адрес -> список времён запросов
lock = threading.Lock()


def get_token():
    # Сначала смотрим переменную в текущем окне
    token = os.environ.get("STRATZ_TOKEN")
    if token:
        return token
    # Окно, открытое до команды setx, токен не видит — тогда читаем его прямо из настроек Windows
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            return winreg.QueryValueEx(key, "STRATZ_TOKEN")[0]
    except Exception:
        return None


def allowed(visitor):
    # Не больше LIMIT_PER_VISITOR запросов в минуту с адреса и LIMIT_TOTAL всего
    now = time.time()
    with lock:
        for key in list(requests_log):
            requests_log[key] = [t for t in requests_log[key] if now - t < 60]
            if not requests_log[key]:
                del requests_log[key]
        total = sum(len(v) for v in requests_log.values())
        mine = requests_log.setdefault(visitor, [])
        if len(mine) >= LIMIT_PER_VISITOR or total >= LIMIT_TOTAL:
            return False
        mine.append(now)
        return True


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=FOLDER, **kwargs)

    def send_json(self, status, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # Страница спрашивает, подключён ли Stratz
        if self.path == "/api/status":
            self.send_json(200, {"stratz": bool(get_token())})
            return
        # Сервер отдаёт только файлы самой страницы
        if self.path.split("?")[0].endswith(".py"):
            self.send_json(404, {"error": "Нет такого адреса"})
            return
        super().do_GET()

    def do_POST(self):
        if self.path != "/api/stratz":
            self.send_json(404, {"error": "Нет такого адреса"})
            return

        token = get_token()
        if not token:
            self.send_json(503, {"error": "Токен Stratz не задан"})
            return

        # Страница присылает {"kind": "player" | "match" | "heroItems", "id": число}
        try:
            length = min(int(self.headers.get("Content-Length", 0)), 1000)
            body = json.loads(self.rfile.read(length))
            kind = body["kind"]
            item_id = int(body["id"])
            template, max_id = QUERIES[kind]
            if not 0 < item_id < max_id:
                raise ValueError
        except Exception:
            self.send_json(400, {"error": "Неверный запрос"})
            return

        # Если недавно уже спрашивали то же самое — отвечаем из кеша
        key = (kind, item_id)
        with lock:
            saved = cache.get(key)
        if saved and time.time() - saved[0] < CACHE_SECONDS[kind]:
            self.send_json(200, saved[1])
            return

        # Через туннель Cloudflare настоящий адрес посетителя приходит в заголовке CF-Connecting-IP
        visitor = self.headers.get("CF-Connecting-IP") or self.client_address[0]
        if not allowed(visitor):
            self.send_json(429, {"error": "Слишком много запросов, подожди минуту"})
            return

        query = json.dumps({"query": template(item_id)}).encode("utf-8")
        request = urllib.request.Request(STRATZ_URL, data=query, method="POST", headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + token,
            "User-Agent": "STRATZ_API",  # Stratz требует такой заголовок
        })
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                data = json.loads(response.read())
            with lock:
                cache[key] = (time.time(), data)
                if len(cache) > 500:  # чтобы кеш не разрастался
                    cache.pop(next(iter(cache)))
            self.send_json(200, data)
        except urllib.error.HTTPError as e:
            self.send_json(e.code, {"error": "Stratz ответил ошибкой " + str(e.code)})
        except Exception as e:
            self.send_json(502, {"error": "Не удалось связаться со Stratz: " + str(e)})

    def log_message(self, format, *args):
        pass  # не засоряем консоль сообщениями о каждом файле


if __name__ == "__main__":
    # На Windows Python по умолчанию даёт двум серверам занять один порт — запрещаем это
    ThreadingHTTPServer.allow_reuse_address = False
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError:
        print("Порт " + str(PORT) + " занят — скорее всего, сервер уже запущен в другом окне.")
        print("Закрой то окно (или нажми там Ctrl + C) и запусти снова.")
        sys.exit(1)
    print("Stratz:", "подключён" if get_token() else "токен не задан, данные будут с OpenDota")
    print("Открой в браузере: http://localhost:" + str(PORT))
    print("Остановить: Ctrl + C")
    server.serve_forever()
