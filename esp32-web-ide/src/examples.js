export const EXAMPLES = [
  {
    name: 'blink.py', title: 'Мигание светодиодом',
    code: `# Мигание встроенным светодиодом
# ESP32-S3 DevKitC: RGB-светодиод на GPIO48 (см. neopixel.py)
# Классический ESP32 DevKit: GPIO2
from machine import Pin
import time

led = Pin(2, Pin.OUT)

while True:
    led.value(not led.value())
    print("LED:", led.value())
    time.sleep(0.5)
`,
  },
  {
    name: 'neopixel.py', title: 'RGB-светодиод (ESP32-S3)',
    code: `# Встроенный RGB-светодиод WS2812 на ESP32-S3 DevKitC (GPIO48, иногда GPIO38)
from machine import Pin
from neopixel import NeoPixel
import time

np = NeoPixel(Pin(48), 1)

def wheel(pos):
    pos = pos % 255
    if pos < 85:  return (255 - pos * 3, pos * 3, 0)
    if pos < 170: pos -= 85; return (0, 255 - pos * 3, pos * 3)
    pos -= 170;   return (pos * 3, 0, 255 - pos * 3)

i = 0
while True:
    r, g, b = wheel(i)
    np[0] = (r // 8, g // 8, b // 8)   # приглушаем яркость
    np.write()
    i += 2
    time.sleep(0.02)
`,
  },
  {
    name: 'wifi_scan.py', title: 'Сканер Wi-Fi сетей',
    code: `import network, time

wlan = network.WLAN(network.STA_IF)
wlan.active(True)

print("Сканирую…")
for ssid, bssid, ch, rssi, auth, hidden in sorted(wlan.scan(), key=lambda x: -x[3]):
    name = ssid.decode() or "<скрытая>"
    print(f"{rssi:4d} dBm  ch{ch:2d}  {name}")
`,
  },
  {
    name: 'wifi_web.py', title: 'Веб-сервер (управление пином)',
    code: `import network, socket, time
from machine import Pin

SSID = "ИМЯ_СЕТИ"
PASS = "ПАРОЛЬ"

led = Pin(2, Pin.OUT)
wlan = network.WLAN(network.STA_IF)
wlan.active(True)
wlan.connect(SSID, PASS)
while not wlan.isconnected():
    print("."); time.sleep(0.5)
print("Открой в браузере: http://%s" % wlan.ifconfig()[0])

html = """<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center">
<h1>ESP32</h1><p>LED: %s</p>
<a href="/on"><button style="font-size:2em">ВКЛ</button></a>
<a href="/off"><button style="font-size:2em">ВЫКЛ</button></a></body></html>"""

s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("0.0.0.0", 80)); s.listen(2)
while True:
    cl, addr = s.accept()
    req = cl.recv(1024)
    if b"/on" in req: led.value(1)
    if b"/off" in req: led.value(0)
    cl.send("HTTP/1.0 200 OK\\r\\nContent-Type: text/html\\r\\n\\r\\n")
    cl.send(html % ("ВКЛ" if led.value() else "ВЫКЛ"))
    cl.close()
`,
  },
  {
    name: 'button.py', title: 'Кнопка с прерыванием',
    code: `from machine import Pin
import time

# Кнопка BOOT на большинстве плат — GPIO0 (нажата = 0)
btn = Pin(0, Pin.IN, Pin.PULL_UP)
count = 0

def on_press(pin):
    global count
    count += 1

btn.irq(trigger=Pin.IRQ_FALLING, handler=on_press)

while True:
    print("нажатий:", count)
    time.sleep(1)
`,
  },
  {
    name: 'analog.py', title: 'АЦП и ШИМ',
    code: `from machine import Pin, ADC, PWM
import time

pot = ADC(Pin(1))            # ESP32-S3: GPIO1..GPIO10 — ADC1
pot.atten(ADC.ATTN_11DB)     # диапазон 0..3.3 В
pwm = PWM(Pin(2), freq=1000)

while True:
    v = pot.read_u16()       # 0..65535
    pwm.duty_u16(v)
    print("ADC:", v, " %.2f В" % (v / 65535 * 3.3))
    time.sleep(0.1)
`,
  },
  {
    name: 'i2c_scan.py', title: 'Сканер I2C',
    code: `from machine import Pin, SoftI2C

i2c = SoftI2C(scl=Pin(9), sda=Pin(8), freq=100000)
found = i2c.scan()
if found:
    for a in found: print("Устройство на адресе 0x%02X" % a)
else:
    print("Ничего не найдено. Проверь SDA/SCL и подтяжку.")
`,
  },
  {
    name: 'boot.py', title: 'boot.py — автозапуск при включении',
    code: `# boot.py выполняется первым при каждом включении, затем main.py
import gc
gc.collect()
print("boot.py: плата запущена")
`,
  },
];
