/*
 *  ESP32-S3 Wi-Fi CSI "радар" — детектор движения в комнате без датчиков.
 *
 *  Как работает:
 *   1. ESP32-S3 подключается к твоему роутеру (или сам поднимает точку доступа).
 *   2. Постоянно пингует роутер (≈20 пакетов/сек) — на каждый ответ Wi-Fi-чип
 *      отдаёт CSI: амплитуду сигнала по ~64 поднесущим OFDM.
 *   3. Когда в комнате кто-то двигается, отражения меняются и "отпечаток" CSI плывёт.
 *      Считаем, насколько текущий кадр отличается от усреднённого — это и есть "движение".
 *   4. Плата отдаёт веб-страницу с радарным экраном, графиком и спектром поднесущих.
 *
 *  Нужно: Arduino IDE + пакет esp32 от Espressif версии 3.x, плата "ESP32S3 Dev Module".
 *  Внешних библиотек не требуется.
 */

#include <WiFi.h>
#include <WebServer.h>
#include <esp_wifi.h>
#include <lwip/inet.h>
#include <ping/ping_sock.h>
#include <math.h>
#include "index_html.h"

// ========================= НАСТРОЙКИ =========================
// Вариант 1 (лучше): вписать свой Wi-Fi. Плата подключится к роутеру и будет его пинговать.
// Вариант 2: оставить WIFI_SSID пустым — плата поднимет точку доступа "CSI-Radar",
//            а трафик для CSI будет создавать сам браузер телефона/ноутбука.
const char* WIFI_SSID = "";
const char* WIFI_PASS = "";

const char* AP_SSID = "CSI-Radar";
const char* AP_PASS = "12345678";

#define PING_INTERVAL_MS   50     // частота опроса роутера (20 Гц)
#define HISTORY_LEN        300    // точек истории на графике (30 сек при 100 мс)
#define MAX_SUBCARRIERS    128
#define CALIB_SECONDS      5      // сколько секунд собирать "тишину" после старта
// =============================================================

WebServer server(80);
portMUX_TYPE csiMux = portMUX_INITIALIZER_UNLOCKED;

// --- состояние, обновляемое из колбэка CSI ---
static float    avgAmp[MAX_SUBCARRIERS];    // медленное среднее (фон)
static float    curAmp[MAX_SUBCARRIERS];    // последний кадр
static int      nSub = 0;
static float    motionRaw = 0;              // мгновенная метрика
static float    motionSmooth = 0;           // сглаженная
static int      lastRssi = 0;
static uint32_t csiFrames = 0;
static bool     avgInit = false;

// --- калибровка / история (обновляется в loop) ---
static float    noiseFloor = 0.02f;
static float    threshold  = 0.06f;
static bool     calibrating = true;
static uint32_t calibStart = 0;
static float    calibSum = 0;  static uint32_t calibN = 0;
static float    history[HISTORY_LEN];
static int      histHead = 0;
static uint32_t lastSample = 0;

// ------------------------------------------------------------
// CSI колбэк: вызывается Wi-Fi задачей на каждый принятый кадр
// ------------------------------------------------------------
static void IRAM_ATTR csi_cb(void* ctx, wifi_csi_info_t* info) {
  if (!info || !info->buf || info->len < 4) return;

  int n = info->len / 2;                       // пары (Im, Re) на поднесущую
  if (n > MAX_SUBCARRIERS) n = MAX_SUBCARRIERS;

  float amp[MAX_SUBCARRIERS];
  float sum = 0;
  for (int i = 0; i < n; i++) {
    float im = info->buf[2 * i];
    float re = info->buf[2 * i + 1];
    amp[i] = sqrtf(im * im + re * re);
    sum += amp[i];
  }
  if (sum < 1e-3f) return;
  float norm = (float)n / sum;                 // нормируем, чтобы AGC не мешал
  for (int i = 0; i < n; i++) amp[i] *= norm;

  float diff = 0;
  portENTER_CRITICAL_ISR(&csiMux);
  if (!avgInit || nSub != n) {
    for (int i = 0; i < n; i++) avgAmp[i] = amp[i];
    nSub = n; avgInit = true;
  } else {
    for (int i = 0; i < n; i++) {
      diff += fabsf(amp[i] - avgAmp[i]);
      avgAmp[i] += 0.03f * (amp[i] - avgAmp[i]);     // фон адаптируется медленно
    }
    diff /= n;
  }
  for (int i = 0; i < n; i++) curAmp[i] = amp[i];
  motionRaw = diff;
  motionSmooth += 0.25f * (diff - motionSmooth);
  lastRssi = info->rx_ctrl.rssi;
  csiFrames++;
  portEXIT_CRITICAL_ISR(&csiMux);
}

// ------------------------------------------------------------
// Включаем CSI
// ------------------------------------------------------------
static void startCSI() {
  wifi_csi_config_t cfg = {};
  cfg.lltf_en           = true;
  cfg.htltf_en          = true;
  cfg.stbc_htltf2_en    = true;
  cfg.ltf_merge_en      = true;
  cfg.channel_filter_en = false;
  cfg.manu_scale        = false;
  cfg.shift             = false;
  ESP_ERROR_CHECK(esp_wifi_set_csi_config(&cfg));
  ESP_ERROR_CHECK(esp_wifi_set_csi_rx_cb(&csi_cb, nullptr));
  ESP_ERROR_CHECK(esp_wifi_set_csi(true));
  Serial.println("[CSI] включён");
}

// ------------------------------------------------------------
// Пингуем роутер, чтобы постоянно был трафик → постоянный CSI
// ------------------------------------------------------------
static esp_ping_handle_t pingHandle = nullptr;

static void startPing(IPAddress target) {
  esp_ping_config_t cfg = ESP_PING_DEFAULT_CONFIG();
  ip_addr_t addr;
  ipaddr_aton(target.toString().c_str(), &addr);
  cfg.target_addr = addr;
  cfg.count       = ESP_PING_COUNT_INFINITE;
  cfg.interval_ms = PING_INTERVAL_MS;
  cfg.timeout_ms  = PING_INTERVAL_MS * 2;
  cfg.data_size   = 32;
  cfg.task_stack_size = 4096;
  esp_ping_callbacks_t cbs = {};
  if (esp_ping_new_session(&cfg, &cbs, &pingHandle) == ESP_OK) {
    esp_ping_start(pingHandle);
    Serial.printf("[PING] %s каждые %d мс\n", target.toString().c_str(), PING_INTERVAL_MS);
  } else {
    Serial.println("[PING] не удалось запустить");
  }
}

// ------------------------------------------------------------
// HTTP
// ------------------------------------------------------------
static void handleRoot() {
  server.send_P(200, "text/html", INDEX_HTML);
}

static void handleData() {
  float ms, mr, amps[MAX_SUBCARRIERS];
  int n, rssi; uint32_t frames;
  portENTER_CRITICAL(&csiMux);
  ms = motionSmooth; mr = motionRaw; n = nSub; rssi = lastRssi; frames = csiFrames;
  for (int i = 0; i < n; i++) amps[i] = curAmp[i];
  portEXIT_CRITICAL(&csiMux);

  String json;
  json.reserve(4096);
  json += "{\"motion\":";  json += String(ms, 4);
  json += ",\"raw\":";      json += String(mr, 4);
  json += ",\"floor\":";    json += String(noiseFloor, 4);
  json += ",\"thr\":";      json += String(threshold, 4);
  json += ",\"calib\":";    json += calibrating ? "true" : "false";
  json += ",\"rssi\":";     json += rssi;
  json += ",\"frames\":";   json += frames;
  json += ",\"level\":";    json += String(threshold > 0 ? ms / threshold : 0, 3);
  json += ",\"hist\":[";
  for (int i = 0; i < HISTORY_LEN; i++) {
    int idx = (histHead + i) % HISTORY_LEN;
    if (i) json += ',';
    json += String(history[idx], 3);
  }
  json += "],\"amps\":[";
  for (int i = 0; i < n; i++) { if (i) json += ','; json += String(amps[i], 2); }
  json += "]}";
  server.send(200, "application/json", json);
}

static void handleCalib() {
  calibrating = true; calibStart = millis(); calibSum = 0; calibN = 0;
  server.send(200, "text/plain", "ok");
}

// ------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n=== ESP32-S3 Wi-Fi CSI Radar ===");

  bool staMode = strlen(WIFI_SSID) > 0;
  IPAddress pingTarget;

  if (staMode) {
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);                       // без сна — стабильный CSI
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    Serial.printf("Подключаюсь к %s", WIFI_SSID);
    uint32_t t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) { delay(300); Serial.print('.'); }
    Serial.println();
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("Не подключился — перехожу в режим точки доступа");
      staMode = false;
    } else {
      pingTarget = WiFi.gatewayIP();
      Serial.print("IP платы: "); Serial.println(WiFi.localIP());
    }
  }
  if (!staMode) {
    WiFi.mode(WIFI_AP);
    WiFi.softAP(AP_SSID, AP_PASS);
    Serial.printf("Точка доступа \"%s\", пароль \"%s\", адрес http://", AP_SSID, AP_PASS);
    Serial.println(WiFi.softAPIP());
  }

  startCSI();
  if (staMode) startPing(pingTarget);

  server.on("/", handleRoot);
  server.on("/data", handleData);
  server.on("/calib", handleCalib);
  server.begin();

  calibStart = millis();
  Serial.println("Открой адрес платы в браузере. Первые 5 сек — калибровка, не двигайся.");
  Serial.println("Serial Plotter: motion, threshold");
}

void loop() {
  server.handleClient();

  uint32_t now = millis();
  if (now - lastSample >= 100) {
    lastSample = now;
    float m;
    portENTER_CRITICAL(&csiMux);
    m = motionSmooth;
    portEXIT_CRITICAL(&csiMux);

    history[histHead] = m;
    histHead = (histHead + 1) % HISTORY_LEN;

    if (calibrating) {
      if (now - calibStart > 1000) { calibSum += m; calibN++; }   // первую секунду пропускаем
      if (now - calibStart > CALIB_SECONDS * 1000UL && calibN > 0) {
        noiseFloor = calibSum / calibN;
        if (noiseFloor < 0.005f) noiseFloor = 0.005f;
        threshold = noiseFloor * 2.5f;
        calibrating = false;
        Serial.printf("[CALIB] фон=%.4f порог=%.4f\n", noiseFloor, threshold);
      }
    }

    // для Serial Plotter
    Serial.printf("motion:%.4f,threshold:%.4f\n", m, threshold);
  }
}
