# main.py — Mindustry Serpulo сервер на ESP32-S3 (MicroPython)
# Инструкция: скопируйте весь этот файл в ESP32 Studio в main.py и нажмите "Запустить"
# Игра считается на ESP32, картинка и управление — на ПК-клиенте.

import network
import usocket as socket
import _thread
import time
import ujson

# ==================== НАСТРОЙКИ ====================
WIFI_SSID = "MindustryServer"
WIFI_PASS = "mind1234"
TCP_PORT = 26789          # Порт для подключения ПК-клиента
TICK_FPS = 30             # Частота тиков симуляции
# ===================================================

# ---------------- Состояние игры ----------------
class GameState:
    def __init__(self):
        self.tick = 0
        self.wave = 1
        self.wave_active = False
        self.wave_time_left = 30.0
        self.buildings = {}   # (x,y) -> {type, hp}
        self.units = {}       # id -> {x, y, hp, type, enemy}
        self.projectiles = [] # [x, y, vx, vy, damage, alive]
        self.power_produce = 0.0
        self.power_consume = 0.0
        self.power_deficit = 0.0

state = GameState()
clients = []
lock = _thread.allocate_lock()
next_unit_id = 1
next_proj_id = 1

# ---------------- Wi-Fi (точка доступа) ----------------
def setup_wifi():
    ap = network.WLAN(network.AP_IF)
    ap.config(essid=WIFI_SSID, password=WIFI_PASS, authmode=network.AUTH_WPA_WPA2_PSK)
    ap.active(True)
    while not ap.active():
        time.sleep(0.1)
    ip = ap.ifconfig()[0]
    print("Wi-Fi AP запущен:", WIFI_SSID)
    print("IP адрес ESP32:", ip)
    print("Подключайте ПК-клиент к:", ip, "порт", TCP_PORT)

# ---------------- Обработка команд от ПК ----------------
def process_command(text):
    global next_unit_id
    text = text.strip()
    if not text:
        return
    parts = text.split()
    cmd = parts[0]

    if cmd == "build" and len(parts) == 4:
        # build <type> <x> <y>
        btype = parts[1]
        x = int(parts[2])
        y = int(parts[3])
        state.buildings[(x, y)] = {"type": btype, "hp": 100}
        print("Постройка:", btype, x, y)

    elif cmd == "remove" and len(parts) == 3:
        # remove <x> <y>
        x = int(parts[1]); y = int(parts[2])
        state.buildings.pop((x, y), None)
        print("Удалено:", x, y)

    elif cmd == "spawn_unit" and len(parts) == 5:
        # spawn_unit <x> <y> <hp> <enemy:0|1>
        global next_unit_id
        x = float(parts[1]); y = float(parts[2])
        hp = float(parts[3]); enemy = int(parts[4]) == 1
        uid = next_unit_id; next_unit_id += 1
        state.units[uid] = {"x": x, "y": y, "hp": hp, "max_hp": hp,
                            "type": "unit", "enemy": enemy}
        print("Юнит спавн:", uid, x, y, "enemy=", enemy)

    elif cmd == "shoot" and len(parts) == 5:
        # shoot <x> <y> <tx> <ty>
        global next_proj_id
        sx = float(parts[1]); sy = float(parts[2])
        tx = float(parts[3]); ty = float(parts[4])
        dx = tx - sx; dy = ty - sy
        dist = (dx*dx + dy*dy) ** 0.5
        if dist < 0.001:
            dist = 0.001
        speed = 80.0
        pid = next_proj_id; next_proj_id += 1
        state.projectiles.append([sx, sy, dx/dist*speed, dy/dist*speed, 25.0, True, pid])
        print("Выстрел:", pid, sx, sy, "->", tx, ty)

    elif cmd == "wave":
        state.wave_active = True
        print("Волна запущена вручную")

    elif cmd == "ping":
        print("Ping от клиента")

# ---------------- TCP сервер ----------------
def handle_client(conn, addr):
    print("Клиент подключён:", addr)
    with lock:
        clients.append(conn)
    try:
        conn.settimeout(0.05)
        buf = ""
        while True:
            try:
                data = conn.recv(64)
                if not data:
                    break
                buf += data.decode('utf-8', 'ignore')
                while "\n" in buf:
                    line, buf = buf.split("\n", 1)
                    process_command(line)
            except OSError:
                break
            time.sleep(0.01)
    except Exception as e:
        print("Ошибка клиента:", e)
    finally:
        with lock:
            if conn in clients:
                clients.remove(conn)
        try:
            conn.close()
        except:
            pass
        print("Клиент отключён:", addr)

def broadcast_state():
    with lock:
        if not clients:
            return
        msg = ujson.dumps({
            "t": state.tick,
            "wave": state.wave,
            "active": 1 if state.wave_active else 0,
            "wave_time": round(state.wave_time_left, 1),
            "buildings": [[k[0], k[1], v["type"], v["hp"]] for k, v in state.buildings.items()],
            "units": [[uid, u["x"], u["y"], u["hp"], u["max_hp"], 1 if u["enemy"] else 0]
                      for uid, u in state.units.items()],
            "projectiles": [[p[6], p[0], p[1]] for p in state.projectiles if p[5]],
            "power": {"p": round(state.power_produce,1),
                      "c": round(state.power_consume,1),
                      "d": round(state.power_deficit,2)}
        }) + "\n"
        data = msg.encode('utf-8')
        dead = []
        for c in clients:
            try:
                c.send(data)
            except:
                dead.append(c)
        for c in dead:
            if c in clients:
                clients.remove(c)
            try:
                c.close()
            except:
                pass

# ---------------- Игровой цикл (30 тиков/с) ----------------
def game_loop():
    last = time.ticks_ms()
    while True:
        now = time.ticks_ms()
        dt = time.ticks_diff(now, last) / 1000.0
        last = now
        if dt <= 0 or dt > 0.2:
            dt = 1.0 / TICK_FPS

        state.tick += 1

        # Волны
        if state.wave_active:
            state.wave_time_left -= dt
            if state.wave_time_left <= 0:
                state.wave += 1
                state.wave_time_left = 10.0
                print("Волна:", state.wave)
        else:
            state.wave_time_left -= dt
            if state.wave_time_left <= 0:
                state.wave_active = True
                state.wave_time_left = 30.0
                print("Волна активирована:", state.wave)

        # Снаряды: полёт и попадание
        for p in state.projectiles:
            if not p[5]:
                continue
            p[0] += p[2] * dt
            p[1] += p[3] * dt
            # простая дистанция
            if abs(p[0]) > 1000 or abs(p[1]) > 1000:
                p[5] = False
                continue
            # попадание по юнитам
            for uid, u in state.units.items():
                dx = p[0] - u["x"]; dy = p[1] - u["y"]
                if (dx*dx + dy*dy) < 100:  # радиус попадания ~10
                    u["hp"] -= p[4]
                    p[5] = False
                    print("Попадание в юнит", uid, "hp=", u["hp"])
                    break

        # Удаление мертвых юнитов
        dead_units = [uid for uid, u in state.units.items() if u["hp"] <= 0]
        for uid in dead_units:
            del state.units[uid]
            print("Юнит уничтожен:", uid)

        broadcast_state()
        time.sleep(0.033)  # ~30 FPS

# ---------------- Точка входа ----------------
def main():
    print("=== Mindustry Serpulo ESP32 Server (MicroPython) ===")
    setup_wifi()

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.bind(('0.0.0.0', TCP_PORT))
    srv.listen(5)
    srv.settimeout(0.5)
    print("TCP сервер слушает порт", TCP_PORT)

    _thread.start_new_thread(game_loop, ())

    while True:
        try:
            conn, addr = srv.accept()
            _thread.start_new_thread(handle_client, (conn, addr))
        except OSError:
            pass
        except Exception as e:
            print("Ошибка accept:", e)

main()
