import './style.css';
import '@xterm/xterm/css/xterm.css';
import * as monaco from 'monaco-editor';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Device } from './device.js';
import { flashFirmware } from './flasher.js';
import { EXAMPLES } from './examples.js';
import {
  checkGitHubUpdate,
  getLocalBuildInfo,
  formatBuildDate,
  isSafeReleaseUrl,
  RELEASE_PAGE_URL,
} from './updater.js';

self.MonacoEnvironment = {
  getWorker: () => new Worker(new URL('monaco-editor/editor/editor.worker.start.js', import.meta.url), { type: 'module' }),
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ============================================================
//  Сведения о текущей сборке и обновления с GitHub
// ============================================================
const localBuild = getLocalBuildInfo();
const runtimeEnv = window.esp32studio || { desktop: false, platform: 'web', portable: false };

function describeLocalBuild() {
  const mode = runtimeEnv.desktop
    ? (runtimeEnv.portable ? 'Windows Portable' : `Desktop (${runtimeEnv.platform})`)
    : 'Веб-версия';
  const dateStr = localBuild.builtAt ? formatBuildDate(localBuild.builtAt) : 'дата неизвестна';
  return `v${localBuild.version} · сборка ${localBuild.shortCommit} (${dateStr}) · ${mode}`;
}

$('#sb-build').textContent = `v${localBuild.version} (${localBuild.shortCommit})`;
$('#set-build-info').textContent =
  `Версия: ${localBuild.version}\n` +
  `Сборка (коммит): ${localBuild.shortCommit}\n` +
  `Дата сборки: ${formatBuildDate(localBuild.builtAt)}\n` +
  `Канал: ${localBuild.releaseTag}`;

function openSafeExternal(url) {
  if (!isSafeReleaseUrl(url)) {
    toast('Заблокирована ссылка вне официального GitHub Release', 'err');
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

async function openUpdateModal() {
  const modal = $('#update-modal');
  const elLocal = $('#upd-local');
  const elRemote = $('#upd-remote');
  const elStatus = $('#upd-status');
  const btnPrimary = $('#btn-update-download');
  const btnAlt = $('#btn-update-alt');

  modal.classList.remove('hidden');
  elLocal.textContent = describeLocalBuild();
  elRemote.textContent = 'Проверяю релиз esp32-studio-latest на GitHub…';
  elStatus.className = 'update-status';
  elStatus.textContent = 'Запрашиваю метаданные официального релиза esp32-studio-latest…';
  btnPrimary.disabled = true;
  btnPrimary.textContent = '⬇ Скачать обновление';
  btnPrimary.onclick = null;
  btnAlt.classList.add('hidden');
  btnAlt.onclick = null;

  try {
    const res = await checkGitHubUpdate({
      localBuild,
      portable: Boolean(runtimeEnv.portable),
    });
    const remoteCommitStr = res.remote.shortCommit ? `сборка ${res.remote.shortCommit}` : 'коммит не указан в метаданных';
    const remoteDateStr = res.remote.updatedAt ? `обновлён ${formatBuildDate(res.remote.updatedAt)}` : 'дата не указана';
    elRemote.textContent = `v${res.remote.version} · ${remoteCommitStr} · ${remoteDateStr}`;

    if (res.hasUpdate) {
      elStatus.className = 'update-status has-update';
      elStatus.textContent = `Доступна новая сборка! ${res.summary}`;
    } else {
      elStatus.className = 'update-status up-to-date';
      elStatus.textContent = `Обновление не требуется: ${res.summary} При необходимости файл можно скачать повторно.`;
    }

    const { primary, secondary } = res.downloads;
    if (primary) {
      const sizeMb = primary.size ? ` (${(primary.size / 1048576).toFixed(1)} МБ)` : '';
      btnPrimary.disabled = false;
      btnPrimary.textContent = `⬇ Скачать обновление: ${primary.name}${sizeMb}`;
      btnPrimary.onclick = () => openSafeExternal(primary.url);
    } else {
      btnPrimary.disabled = false;
      btnPrimary.textContent = '⬇ Скачать обновление со страницы релиза';
      btnPrimary.onclick = () => openSafeExternal(res.remote.pageUrl || RELEASE_PAGE_URL);
    }

    if (secondary) {
      const altKind = /portable/i.test(secondary.name) ? 'Portable-версию (.exe без установки)' : 'установщик Setup (.exe)';
      btnAlt.textContent = `Скачать ${altKind}: ${secondary.name}`;
      btnAlt.classList.remove('hidden');
      btnAlt.onclick = () => openSafeExternal(secondary.url);
    }
  } catch (err) {
    elRemote.textContent = 'Не удалось получить данные о релизе';
    elStatus.className = 'update-status error';
    elStatus.textContent = err.message || 'Ошибка при проверке обновлений на GitHub.';
    btnPrimary.disabled = false;
    btnPrimary.textContent = '🌐 Открыть страницу релиза GitHub вручную';
    btnPrimary.onclick = () => openSafeExternal(RELEASE_PAGE_URL);
  }
}

function closeUpdateModal() {
  $('#update-modal').classList.add('hidden');
}

$('#btn-update').onclick = openUpdateModal;
$('#btn-settings-update').onclick = openUpdateModal;
$('#sb-build').onclick = openUpdateModal;
$('#btn-update-close').onclick = closeUpdateModal;
$('#btn-update-cancel').onclick = closeUpdateModal;
$('#btn-update-retry').onclick = openUpdateModal;
$('#btn-update-page').onclick = () => openSafeExternal(RELEASE_PAGE_URL);
$('#update-modal').addEventListener('mousedown', (e) => {
  if (e.target === $('#update-modal')) closeUpdateModal();
});

// ============================================================
//  Состояние проекта (хранится в localStorage)
// ============================================================
const LS_KEY = 'esp32studio.project';
const DEFAULT_PROJECT = {
  files: {
    'main.py': EXAMPLES[0].code,
  },
  open: ['main.py'],
  active: 'main.py',
};
let project = loadProject();
const models = new Map();       // name -> monaco model
const saved = new Map();        // name -> last saved text (для индикатора ●)
const deviceFiles = new Map();  // 'dev:name' -> content (открытые файлы с платы)

function loadProject() {
  try {
    const p = JSON.parse(localStorage.getItem(LS_KEY));
    if (p && p.files) return p;
  } catch {}
  return structuredClone(DEFAULT_PROJECT);
}
function persist() {
  if (!settings.autosave) return;
  for (const [name, m] of models) if (!name.startsWith('dev:')) project.files[name] = m.getValue();
  localStorage.setItem(LS_KEY, JSON.stringify(project));
}

// ============================================================
//  Настройки
// ============================================================
const settings = Object.assign(
  { baud: 115200, font: 14, minimap: true, wrap: false, autosave: true, sidebarW: 260, panelH: 240 },
  JSON.parse(localStorage.getItem('esp32studio.settings') || '{}'),
);
function saveSettings() { localStorage.setItem('esp32studio.settings', JSON.stringify(settings)); }

// ============================================================
//  Monaco
// ============================================================
monaco.editor.defineTheme('esp-dark', {
  base: 'vs-dark', inherit: true,
  rules: [],
  colors: { 'editor.background': '#1e1e1e' },
});
const editor = monaco.editor.create($('#editor'), {
  theme: 'esp-dark',
  fontSize: settings.font,
  fontFamily: '"Cascadia Code", Consolas, "Fira Code", Menlo, monospace',
  fontLigatures: true,
  minimap: { enabled: settings.minimap },
  wordWrap: settings.wrap ? 'on' : 'off',
  automaticLayout: true,
  tabSize: 4,
  insertSpaces: true,
  renderWhitespace: 'selection',
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  cursorBlinking: 'smooth',
  bracketPairColorization: { enabled: true },
  padding: { top: 6 },
});

// Автодополнение для MicroPython
const MPY_WORDS = {
  machine: ['Pin', 'ADC', 'PWM', 'I2C', 'SoftI2C', 'SPI', 'SoftSPI', 'UART', 'Timer', 'RTC', 'WDT', 'freq', 'reset', 'deepsleep', 'lightsleep', 'unique_id', 'TouchPad', 'DAC'],
  time: ['sleep', 'sleep_ms', 'sleep_us', 'ticks_ms', 'ticks_us', 'ticks_diff', 'time', 'localtime'],
  network: ['WLAN', 'STA_IF', 'AP_IF'],
  Pin: ['OUT', 'IN', 'PULL_UP', 'PULL_DOWN', 'IRQ_RISING', 'IRQ_FALLING', 'value', 'on', 'off', 'irq', 'toggle'],
  os: ['listdir', 'remove', 'mkdir', 'rmdir', 'rename', 'stat', 'uname', 'statvfs'],
  wlan: ['active', 'connect', 'disconnect', 'isconnected', 'ifconfig', 'scan', 'status', 'config'],
};
const MODULES = ['machine', 'time', 'network', 'socket', 'os', 'sys', 'gc', 'json', 'math', 'random', 'neopixel', 'esp', 'esp32', 'dht', 'onewire', 'ds18x20', 'ubinascii', 'ustruct', 'uasyncio', 'asyncio', 'bluetooth', 'framebuf', 'micropython', 'urequests', 'ntptime', 'webrepl'];
monaco.languages.registerCompletionItemProvider('python', {
  triggerCharacters: ['.'],
  provideCompletionItems(model, pos) {
    const line = model.getLineContent(pos.lineNumber).slice(0, pos.column - 1);
    const word = model.getWordUntilPosition(pos);
    const range = { startLineNumber: pos.lineNumber, endLineNumber: pos.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
    const dot = line.match(/(\w+)\.\w*$/);
    let items = [];
    if (dot && MPY_WORDS[dot[1]]) {
      items = MPY_WORDS[dot[1]].map(l => ({ label: l, kind: monaco.languages.CompletionItemKind.Method, insertText: l, range }));
    } else if (/^\s*(import|from)\s+\w*$/.test(line)) {
      items = MODULES.map(l => ({ label: l, kind: monaco.languages.CompletionItemKind.Module, insertText: l, range }));
    } else {
      items = [
        ...MODULES.map(l => ({ label: l, kind: monaco.languages.CompletionItemKind.Module, insertText: l, range })),
        { label: 'blink-loop', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'from machine import Pin\nimport time\n\nled = Pin(${1:2}, Pin.OUT)\nwhile True:\n    led.value(not led.value())\n    time.sleep(${2:0.5})\n', insertTextRules: 4, documentation: 'Шаблон мигания', range },
        { label: 'wifi-connect', kind: monaco.languages.CompletionItemKind.Snippet, insertText: 'import network, time\nwlan = network.WLAN(network.STA_IF)\nwlan.active(True)\nwlan.connect("${1:SSID}", "${2:PASS}")\nwhile not wlan.isconnected():\n    time.sleep(0.5)\nprint(wlan.ifconfig())\n', insertTextRules: 4, documentation: 'Подключение к Wi-Fi', range },
      ];
    }
    return { suggestions: items };
  },
});

editor.onDidChangeCursorPosition(e => { $('#sb-pos').textContent = `Стр ${e.position.lineNumber}, Стлб ${e.position.column}`; });

// ============================================================
//  Терминал
// ============================================================
const term = new Terminal({
  theme: { background: '#1e1e1e', foreground: '#cccccc', cursor: '#aeafad', selectionBackground: '#264f78' },
  fontFamily: '"Cascadia Code", Consolas, Menlo, monospace',
  fontSize: 13, cursorBlink: true, convertEol: false, scrollback: 5000,
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open($('#terminal'));
fit.fit();
new ResizeObserver(() => { try { fit.fit(); } catch {} }).observe($('#terminal'));
term.writeln('\x1b[90mESP32 Studio — терминал REPL. Нажми «⚡ Подключить», чтобы начать.\x1b[0m');

// ============================================================
//  Устройство, статусы подключения и диагностика REPL
// ============================================================
const dev = new Device();
let isFlashing = false;
let connState = 'disconnected';

const lastFlashRecord = {
  fileName: '',
  fileSize: 0,
  offset: 'auto',
  baud: 460800,
  erase: false,
  status: 'не выполнялась в этой сессии',
  logTail: '',
};

/**
 * Устанавливает честный статус подключения:
 * - disconnected: «⚡ Не подключено»
 * - flashing:     «⚡ Идёт прошивка»
 * - port-open:    «🔌 COM открыт» (порт открыт, ответ MicroPython ещё проверяется)
 * - repl-ready:   «⚡ MicroPython готов» (получен ответ от REPL)
 * - no-repl:      «⚠ Нет ответа REPL (COM открыт)»
 */
function setConnState(state) {
  connState = state;
  const sbConn = $('#sb-conn');
  const btnConn = $('#btn-connect');
  const sb = $('#statusbar');

  btnConn.classList.remove('connected', 'port-open', 'no-repl');
  sb.classList.remove('disconnected', 'flashing', 'port-open', 'no-repl', 'repl-ready');

  if (state === 'flashing') {
    sbConn.textContent = '⚡ Идёт прошивка';
    btnConn.textContent = '⚡ Идёт прошивка…';
    btnConn.title = 'Выполняется прошивка платы через загрузчик';
    btnConn.disabled = true;
    sb.classList.add('flashing');
    return;
  }

  btnConn.disabled = !Device.supported;

  if (state === 'port-open') {
    sbConn.textContent = '🔌 COM открыт';
    btnConn.textContent = '⏏ Закрыть COM';
    btnConn.title = 'COM-порт открыт, проверяется ответ MicroPython REPL. Нажми, чтобы закрыть COM-порт';
    btnConn.classList.add('port-open');
    sb.classList.add('port-open');
    return;
  }

  if (state === 'repl-ready') {
    sbConn.textContent = '⚡ MicroPython готов';
    btnConn.textContent = '⏏ Отключить';
    btnConn.title = 'MicroPython REPL готов. Нажми, чтобы отключить плату';
    btnConn.classList.add('connected');
    sb.classList.add('repl-ready');
    return;
  }

  if (state === 'no-repl') {
    sbConn.textContent = '⚠ Нет ответа REPL (COM открыт)';
    btnConn.textContent = '⏏ Закрыть COM';
    btnConn.title = 'Открыт только COM-порт, MicroPython REPL не ответил. Нажми, чтобы закрыть порт';
    btnConn.classList.add('no-repl');
    sb.classList.add('no-repl');
    return;
  }

  sbConn.textContent = '⚡ Не подключено';
  btnConn.textContent = '⚡ Подключить';
  btnConn.title = 'Подключить плату по USB';
  sb.classList.add('disconnected');
}

// Панель подсказки и диагностики при отсутствии ответа REPL
const replHint = document.createElement('div');
replHint.hidden = true;
replHint.style.cssText = 'position:fixed;bottom:28px;left:56px;right:16px;z-index:900;padding:12px 14px;background:#3d2e10;color:#fff;border:1px solid #b58a30;border-radius:4px;box-shadow:0 4px 16px rgba(0,0,0,.5);line-height:1.45';
const replHintText = document.createElement('div');
replHintText.style.marginBottom = '8px';
const replHintBtns = document.createElement('div');
replHintBtns.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center';

function makeHintBtn(label, onClick, secondary = false) {
  const b = document.createElement('button');
  b.className = secondary ? 'btn secondary' : 'btn';
  b.style.cssText = 'width:auto;margin:0;padding:5px 10px;font-size:12px;display:inline-block';
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

replHintBtns.append(
  makeHintBtn('🔄 Проверить REPL снова', () => refreshDevice()),
  makeHintBtn('🔌 Сменить порт (USB / COM)', async () => {
    replHint.hidden = true;
    if (dev.connected) await dev.disconnect();
    await toggleConnect();
  }, true),
  makeHintBtn('📋 Диагностика и журнал', () => showDiagnosticReport(), true),
  makeHintBtn('⚡ К прошивке', () => { replHint.hidden = true; showView('flash'); }, true),
  makeHintBtn('Скрыть', () => { replHint.hidden = true; }, true),
);
replHint.append(replHintText, replHintBtns);
document.body.append(replHint);

function updateReplHint(diag) {
  const summary = diag?.summary ||
    'COM-порт открыт, но MicroPython REPL не ответил. Отсутствие ответа на COM-порту НЕ доказывает отсутствие MicroPython.';
  replHintText.textContent =
    `${summary} ` +
    'Что проверить на ESP32-S3 N16R8: (1) нажми кнопку RESET на плате и «Проверить REPL снова»; ' +
    '(2) переставь кабель в разъём USB (встроенный USB Espressif, VID 303A) — на S3 загрузчик работает на COM/CH343, а REPL часто на USB; ' +
    '(3) проверь полное имя .bin и последние строки журнала прошивки. ' +
    '⚠ Не включай повторное стирание флеш без необходимости — оно удалит все данные на плате.';
  replHint.hidden = false;
}

function showDiagnosticReport() {
  const out = $('#output');
  const selectedFile = $('#fw-file')?.files?.[0];
  const binName = selectedFile ? `${selectedFile.name} (${selectedFile.size} байт)` : (lastFlashRecord.fileName || 'не выбран в текущей сессии (сообщи полное имя .bin)');
  const rxTail = dev.lastRx ? dev.lastRx.trim().slice(-600) : '(от платы не поступило ни одного байта после открытия порта)';
  const fwTail = lastFlashRecord.logTail || ($('#fw-status')?.textContent || 'Готов').trim().split('\n').slice(-10).join('\n');

  out.textContent =
    '=== ДИАГНОСТИКА ПОДКЛЮЧЕНИЯ И ТАЙМАУТА REPL (ESP32-S3 N16R8) ===\n\n' +
    `Статус подключения: ${$('#sb-conn').textContent}\n` +
    `Скорость REPL: ${settings.baud} бод\n` +
    `Файл прошивки (.bin): ${binName}\n` +
    `Параметры последней прошивки: адрес=${lastFlashRecord.offset}, скорость=${lastFlashRecord.baud}, стирание=${lastFlashRecord.erase ? 'да' : 'нет'}, итог=${lastFlashRecord.status}\n\n` +
    '--- Последние строки журнала прошивки ---\n' +
    `${fwTail}\n\n` +
    '--- Последние принятые данные из открытого COM-порта ---\n' +
    `${rxTail}\n\n` +
    '--- Что проверить и сообщить для диагностики ---\n' +
    '1. Полное имя выбранного файла .bin (для ESP32-S3 N16R8 с 8 МБ Octal PSRAM нужен ESP32_GENERIC_S3-SPIRAM_OCT-*.bin, адрес 0x0).\n' +
    '2. Последние строки журнала прошивки: есть ли подтверждение «✓ Запись завершена успешно, перезагружаю плату…».\n' +
    '3. Повторяется ли в терминале строка «image at 0x10000 has invalid magic byte» при нажатии кнопки RESET на плате.\n' +
    '4. Разъём USB vs COM: на ESP32-S3 с двумя USB-C разъём COM (CH343, VID 1A86) всегда работает для загрузчика,\n' +
    '   но REPL MicroPython может отвечать на втором разъёме — USB (Espressif USB-CDC, VID 303A).\n' +
    '5. ⚠ Внимание: не запускай повторное стирание флеш без необходимости — стирание удаляет все файлы и данные на плате.\n';
  showPanel('output');
}

dev.onData = (s) => term.write(s);
term.onData((d) => { if (dev.connected && !dev.busy) dev.write(d).catch(() => {}); });

dev.addEventListener('connect', () => {
  setConnState('port-open');
  $('#dev-info').textContent = 'COM-порт открыт.\nПроверяю ответ MicroPython REPL…';
  toast('COM-порт открыт. Проверяю ответ MicroPython REPL…', 'ok');
  term.writeln('\r\n[COM-порт открыт; ожидание ответа MicroPython REPL…]');
  setTimeout(refreshDevice, 600);
});
dev.addEventListener('repl-ready', () => {
  if (!isFlashing && dev.connected) {
    replHint.hidden = true;
    setConnState('repl-ready');
  }
});
dev.addEventListener('repl-timeout', (ev) => {
  if (!isFlashing && dev.connected) {
    setConnState('no-repl');
    updateReplHint(ev.detail);
  }
});
dev.addEventListener('disconnect', () => {
  replHint.hidden = true;
  if (isFlashing) {
    setConnState('flashing');
    return;
  }
  setConnState('disconnected');
  $('#sb-chip').textContent = '';
  $('#tree-device').innerHTML = '<li class="muted">Подключи плату</li>';
  $('#dev-info').textContent = '—';
  term.writeln('\r\n\x1b[90m[COM-порт закрыт]\x1b[0m');
});
dev.addEventListener('run-end', () => status('Выполнение завершено'));
setConnState('disconnected');

async function toggleConnect() {
  if (isFlashing) return;
  if (dev.connected) { await dev.disconnect(); return; }
  try {
    await dev.connect(settings.baud);
  } catch (e) {
    if (e.name === 'NotFoundError' || /No port selected|cancel/i.test(e.message)) return;
    const message = e.name === 'NetworkError'
      ? 'Не удалось открыть COM-порт. Закрой другие программы и окна ESP32 Studio, переподключи кабель и проверь драйвер CH343. ' + e.message
      : e.message;
    term.writeln('\r\n[Ошибка подключения] ' + message);
    toast(message, 'err');
  }
}

async function refreshDevice() {
  if (!dev.connected || dev.busy || isFlashing) return;
  status('Проверка связи с MicroPython REPL…');
  try {
    const info = await dev.info();
    replHint.hidden = true;
    setConnState('repl-ready');
    status('MicroPython готов');
    $('#sb-chip').textContent = `${info.machine.split(' with ')[1] || info.platform} · ${info.version}`;
    $('#dev-info').textContent =
      `Статус: MicroPython готов\n` +
      `${info.machine}\nMicroPython ${info.version}\nCPU: ${(info.freq / 1e6) | 0} МГц\n` +
      `Флеш: ${kb(info.fs_free)} свободно из ${kb(info.fs_total)}\nRAM свободно: ${kb(info.mem_free)}`;
    await listDevice();
  } catch (e) {
    if (!dev.connected || isFlashing) return;
    setConnState('no-repl');
    status('Нет ответа REPL (COM открыт)');
    const diag = e.diagnostic || dev.lastDiagnostic;
    updateReplHint(diag);
    $('#dev-info').textContent =
      'Статус: COM открыт, нет ответа REPL.\n' +
      (diag?.summary || 'Плата не ответила на запрос raw REPL.') + '\n\n' +
      'Нажми RESET на плате или проверь второй разъём USB (встроенный USB S3).';
    term.writeln(`\r\n\x1b[33m${e.message}\x1b[0m`);
  }
}
let devPath = '/';
async function listDevice(path = devPath) {
  devPath = path;
  $('#dev-root').textContent = path;
  const list = await dev.listdir(path);
  const ul = $('#tree-device');
  ul.innerHTML = '';
  if (path !== '/') {
    const up = li('..', '📁', '');
    up.onclick = () => listDevice(path.replace(/\/[^/]+\/?$/, '') || '/');
    ul.append(up);
  }
  list.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  for (const f of list) {
    const full = (path === '/' ? '' : path) + '/' + f.name;
    const el = li(f.name, f.dir ? '📁' : icon(f.name), f.dir ? '' : kb(f.size));
    el.title = full;
    el.onclick = () => f.dir ? listDevice(full) : openDeviceFile(full);
    el.oncontextmenu = (e) => {
      e.preventDefault();
      dropdown(e.clientX, e.clientY, [
        { label: 'Открыть', run: () => f.dir ? listDevice(full) : openDeviceFile(full) },
        { label: 'Скачать в проект', run: () => downloadToProject(full, f.name), hide: f.dir },
        { label: 'Запустить', run: () => runDeviceFile(full), hide: f.dir },
        { sep: true },
        { label: 'Удалить', run: () => deleteDeviceFile(full) },
      ]);
    };
    ul.append(el);
  }
  if (!list.length) ul.innerHTML = '<li class="muted">пусто</li>';
}
function li(text, ico, size) {
  const el = document.createElement('li');
  el.innerHTML = `<span class="ico">${ico}</span><span class="nm"></span><span class="size">${size}</span>`;
  el.querySelector('.nm').textContent = text;
  return el;
}

async function openDeviceFile(path) {
  try {
    status('Читаю ' + path + '…');
    const text = await dev.readFile(path);
    const key = 'dev:' + path;
    deviceFiles.set(key, text);
    openFile(key, text);
    status('');
  } catch (e) { toast(e.message, 'err'); }
}
async function downloadToProject(path, name) {
  const text = await dev.readFile(path);
  project.files[uniqueName(name)] = text;
  persist(); renderTree(); toast(`${name} скопирован в проект`, 'ok');
}
async function runDeviceFile(path) {
  if (!needDev()) return;
  showPanel('terminal');
  status(`⏳ Ожидание ответа raw REPL для запуска ${path}…`);
  try {
    await dev.run(`exec(open(${JSON.stringify(path)}).read())`, () => {
      replHint.hidden = true;
      setConnState('repl-ready');
      status('▶ Выполняю ' + path);
      term.writeln(`\r\n\x1b[32m▶ ${path}\x1b[0m`);
    });
  } catch (e) {
    if (dev.connected && !dev.replReady) {
      setConnState('no-repl');
      updateReplHint(e.diagnostic || dev.lastDiagnostic);
    }
    status('⚠ Запуск не выполнен: нет ответа REPL');
    term.writeln(`\r\n\x1b[33m[Не удалось запустить ${path}: ${e.message}]\x1b[0m`);
    toast(e.message, 'err');
  }
}
async function deleteDeviceFile(path) {
  if (!confirm(`Удалить ${path} с платы?`)) return;
  try { await dev.remove(path); await listDevice(); toast('Удалено', 'ok'); } catch (e) { toast(e.message, 'err'); }
}

// ============================================================
//  Файлы проекта / вкладки
// ============================================================
function icon(name) {
  if (name.endsWith('.py')) return '<span style="color:#4b8bbe">🐍</span>';
  if (name.endsWith('.json')) return '<span style="color:#cbcb41">{}</span>';
  if (name.endsWith('.txt') || name.endsWith('.md')) return '📄';
  if (name.endsWith('.html')) return '<span style="color:#e37933">◇</span>';
  return '📄';
}
function lang(name) {
  if (name.endsWith('.py')) return 'python';
  if (name.endsWith('.json')) return 'json';
  if (name.endsWith('.html')) return 'html';
  if (name.endsWith('.js')) return 'javascript';
  if (name.endsWith('.css')) return 'css';
  if (name.endsWith('.md')) return 'markdown';
  return 'plaintext';
}
function displayName(key) { return key.startsWith('dev:') ? key.slice(4).replace(/^\//, '') : key; }

function renderTree() {
  const ul = $('#tree-local');
  ul.innerHTML = '';
  for (const name of Object.keys(project.files).sort()) {
    const el = li(name, icon(name), '');
    if (name === project.active) el.classList.add('active');
    if (isDirty(name)) el.querySelector('.nm').insertAdjacentHTML('beforeend', ' <span class="dot">●</span>');
    el.onclick = () => openFile(name);
    el.oncontextmenu = (e) => {
      e.preventDefault();
      dropdown(e.clientX, e.clientY, [
        { label: 'Открыть', run: () => openFile(name) },
        { label: 'Загрузить на плату', run: () => uploadFile(name) },
        { label: 'Переименовать', run: () => renameFile(name) },
        { label: 'Скачать на компьютер', run: () => downloadFile(name) },
        { sep: true },
        { label: 'Удалить', run: () => deleteFile(name) },
      ]);
    };
    ul.append(el);
  }
  if (!Object.keys(project.files).length) ul.innerHTML = '<li class="muted">Нет файлов — нажми ＋</li>';
}
function isDirty(key) {
  const m = models.get(key);
  if (!m) return false;
  return saved.has(key) && saved.get(key) !== m.getValue();
}
function getModel(key, text) {
  if (models.has(key)) return models.get(key);
  const content = text ?? project.files[key] ?? '';
  const m = monaco.editor.createModel(content, lang(displayName(key)), monaco.Uri.parse('inmemory:///' + encodeURIComponent(key)));
  m.onDidChangeContent(() => { renderTabs(); renderTree(); if (!key.startsWith('dev:')) persist(); });
  models.set(key, m);
  saved.set(key, content);
  return m;
}
function openFile(key, text) {
  const m = getModel(key, text);
  if (!project.open.includes(key)) project.open.push(key);
  project.active = key;
  editor.setModel(m);
  $('#welcome').classList.add('hidden');
  $('#bc-file').textContent = displayName(key);
  $('#breadcrumb').firstChild.textContent = key.startsWith('dev:') ? 'плата › ' : 'проект › ';
  $('#tb-title').textContent = `${displayName(key)} — ESP32 Studio`;
  $('#sb-lang').textContent = { python: 'Python', json: 'JSON', html: 'HTML', plaintext: 'Текст', markdown: 'Markdown', javascript: 'JavaScript', css: 'CSS' }[lang(displayName(key))];
  renderTabs(); renderTree(); persist();
  editor.focus();
}
function closeFile(key) {
  if (isDirty(key) && !confirm(`${displayName(key)} не сохранён на плату. Закрыть?`)) return;
  project.open = project.open.filter(k => k !== key);
  if (project.active === key) {
    project.active = project.open[project.open.length - 1] || null;
    if (project.active) openFile(project.active);
    else { editor.setModel(null); $('#welcome').classList.remove('hidden'); $('#bc-file').textContent = '—'; $('#tb-title').textContent = 'ESP32 Studio'; }
  }
  if (key.startsWith('dev:')) { models.get(key)?.dispose(); models.delete(key); saved.delete(key); }
  renderTabs(); persist();
}
function renderTabs() {
  const tabs = $('#tabs');
  tabs.innerHTML = '';
  for (const key of project.open) {
    const t = document.createElement('div');
    t.className = 'tab' + (key === project.active ? ' active' : '') + (isDirty(key) ? ' dirty' : '');
    t.innerHTML = `<span class="ico">${key.startsWith('dev:') ? '📟' : icon(displayName(key))}</span><span class="nm"></span><span class="close"></span>`;
    t.querySelector('.nm').textContent = displayName(key);
    t.title = key.startsWith('dev:') ? 'Файл на плате: ' + key.slice(4) : key;
    t.onclick = () => openFile(key);
    t.querySelector('.close').onclick = (e) => { e.stopPropagation(); closeFile(key); };
    t.onauxclick = (e) => { if (e.button === 1) closeFile(key); };
    tabs.append(t);
  }
}
function uniqueName(name) {
  if (!project.files[name]) return name;
  const [, base, ext] = name.match(/^(.*?)(\.[^.]*)?$/);
  let i = 1; while (project.files[`${base}_${i}${ext || ''}`]) i++;
  return `${base}_${i}${ext || ''}`;
}
function newFile(name, content = '') {
  name = name ?? prompt('Имя файла:', 'script.py');
  if (!name) return;
  if (!/\./.test(name)) name += '.py';
  if (project.files[name] && !confirm(`${name} уже есть. Заменить?`)) return;
  project.files[name] = content;
  models.get(name)?.dispose(); models.delete(name); saved.delete(name);
  renderTree(); openFile(name);
}
function renameFile(old) {
  const name = prompt('Новое имя:', old);
  if (!name || name === old) return;
  project.files[name] = models.get(old)?.getValue() ?? project.files[old];
  delete project.files[old];
  models.get(old)?.dispose(); models.delete(old); saved.delete(old);
  project.open = project.open.map(k => k === old ? name : k);
  if (project.active === old) project.active = name;
  renderTree(); openFile(name);
}
function deleteFile(name) {
  if (!confirm(`Удалить ${name} из проекта?`)) return;
  delete project.files[name];
  models.get(name)?.dispose(); models.delete(name); saved.delete(name);
  project.open = project.open.filter(k => k !== name);
  if (project.active === name) { project.active = null; closeFile(name); }
  renderTree(); renderTabs(); persist();
}
function downloadFile(name) {
  const text = models.get(name)?.getValue() ?? project.files[name];
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = displayName(name); a.click();
}
function openLocal() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.multiple = true; inp.accept = '.py,.txt,.json,.html,.md,.js,.css';
  inp.onchange = async () => {
    for (const f of inp.files) { const t = await f.text(); project.files[f.name] = t; models.get(f.name)?.dispose(); models.delete(f.name); saved.delete(f.name); }
    renderTree(); if (inp.files[0]) openFile(inp.files[0].name);
  };
  inp.click();
}

// ============================================================
//  Действия с платой
// ============================================================
function needDev() {
  if (isFlashing) { toast('Дождись завершения прошивки', 'err'); return false; }
  if (!dev.connected) { toast('Сначала подключи плату (⚡)', 'err'); return false; }
  return true;
}
function currentCode() { return editor.getModel()?.getValue() ?? ''; }

async function runCurrent() {
  if (!needDev() || !project.active) return;
  const fileName = displayName(project.active);
  showPanel('terminal');
  status(`⏳ Ожидание ответа raw REPL для запуска ${fileName}…`);
  try {
    await dev.run(currentCode(), () => {
      replHint.hidden = true;
      setConnState('repl-ready');
      status('▶ Выполняю ' + fileName);
      term.writeln(`\r\n\x1b[32m▶ ${fileName}\x1b[0m`);
    });
  } catch (e) {
    if (dev.connected && !dev.replReady) {
      setConnState('no-repl');
      updateReplHint(e.diagnostic || dev.lastDiagnostic);
    }
    status('⚠ Запуск не выполнен: нет ответа REPL');
    term.writeln(`\r\n\x1b[33m[Запуск ${fileName} не выполнен: ${e.message}]\x1b[0m`);
    toast(e.message, 'err');
  }
}
async function stopRun() { if (!needDev()) return; await dev.stop(); status('■ Остановлено'); }
async function softReset() { if (!needDev()) return; await dev.softReset(); status('⟳ Сброс'); setTimeout(refreshDevice, 1500); }

async function uploadFile(key = project.active) {
  if (!needDev() || !key) return;
  const text = models.get(key)?.getValue() ?? project.files[key];
  let target = key.startsWith('dev:') ? key.slice(4) : '/' + key;
  if (!key.startsWith('dev:')) {
    target = prompt('Путь на плате:', target);
    if (!target) return;
  }
  try {
    status(`⬆ Загружаю ${target}…`);
    await dev.writeFile(target, text, p => status(`⬆ ${target} ${(p * 100) | 0}%`));
    saved.set(key, text);
    renderTabs(); renderTree();
    status(''); toast(`${target} записан на плату`, 'ok');
    listDevice().catch(() => {});
  } catch (e) { toast(e.message, 'err'); status(''); }
}
async function uploadAll() {
  if (!needDev()) return;
  for (const name of Object.keys(project.files)) {
    const text = models.get(name)?.getValue() ?? project.files[name];
    status(`⬆ ${name}…`);
    try { await dev.writeFile('/' + name, text); saved.set(name, text); } catch (e) { toast(`${name}: ${e.message}`, 'err'); }
  }
  renderTabs(); renderTree(); status('');
  toast('Все файлы загружены', 'ok'); listDevice().catch(() => {});
}

// ============================================================
//  Прошивка
// ============================================================
function kb(n) { return n < 1024 ? n + ' Б' : (n / 1024).toFixed(1) + ' КБ'; }

$('#fw-file').onchange = () => {
  const f = $('#fw-file').files?.[0];
  const infoEl = $('#fw-file-info');
  if (!f) {
    infoEl.textContent = 'Файл .bin не выбран';
    return;
  }
  infoEl.textContent = `Выбран: ${f.name} (${kb(f.size)}, ${f.size} байт)`;
};

async function doFlash(eraseOnly = false) {
  if (isFlashing) return;
  const file = $('#fw-file').files[0];
  if (!eraseOnly && !file) return toast('Выбери .bin файл прошивки', 'err');
  const eraseChecked = eraseOnly || $('#fw-erase').checked;
  if (!eraseOnly && eraseChecked) {
    const ok = confirm(
      'Включена опция «Стереть флеш перед записью».\n' +
      'Это безвозвратно удалит все файлы (main.py и др.) и сохранённые данные на плате.\n\n' +
      'Продолжить прошивку со стиранием?'
    );
    if (!ok) return;
  }

  const log = $('#fw-status');
  const bar = $('#fw-bar');
  const out = $('#output');
  log.textContent = '';
  out.textContent = '=== ЖУРНАЛ ПРОШИВКИ ===\n';
  bar.style.width = '0';
  $('#btn-flash').disabled = $('#btn-erase').disabled = true;

  const off = $('#fw-offset').value;
  const baud = +$('#fw-baud').value;
  lastFlashRecord.fileName = eraseOnly ? '(только стирание)' : `${file.name} (${file.size} байт)`;
  lastFlashRecord.fileSize = eraseOnly ? 0 : file.size;
  lastFlashRecord.offset = off;
  lastFlashRecord.baud = baud;
  lastFlashRecord.erase = eraseChecked;
  lastFlashRecord.status = 'идёт прошивка…';
  lastFlashRecord.logTail = '';

  const appendFlashLog = (s) => {
    log.textContent += s;
    log.scrollTop = log.scrollHeight;
    out.textContent += s;
    out.scrollTop = out.scrollHeight;
    lastFlashRecord.logTail = log.textContent.trim().split('\n').slice(-10).join('\n');
  };

  let port = null;
  try {
    isFlashing = true;
    replHint.hidden = true;
    setConnState('flashing');
    status('Идёт прошивка…');

    if (dev.connected) {
      port = await dev.release();
      setConnState('flashing');
    } else {
      port = await navigator.serial.requestPort();
      setConnState('flashing');
    }

    const data = eraseOnly ? null : new Uint8Array(await file.arrayBuffer());
    const chip = await flashFirmware(port, {
      data,
      fileName: file?.name || '',
      offset: off === 'auto' ? 'auto' : parseInt(off, 16),
      erase: eraseChecked,
      baud,
      log: appendFlashLog,
      progress: (p) => {
        const pct = Math.round(p * 100);
        bar.style.width = pct + '%';
        status(`Идёт прошивка… ${pct}%`);
      },
    });
    bar.style.width = '100%';
    lastFlashRecord.status = `успешно (${chip})`;
    status('Прошивка завершена, переподключаю порт…');
    toast(eraseOnly ? 'Флеш стёрт' : `MicroPython прошит на ${chip}`, 'ok');
    await new Promise(r => setTimeout(r, 1500));
    isFlashing = false;
    await dev.open(port, settings.baud);
    showView('device');
  } catch (e) {
    isFlashing = false;
    setConnState(dev.connected ? (dev.replReady ? 'repl-ready' : 'port-open') : 'disconnected');
    if (e.name === 'NotFoundError' || /No port selected|cancel/i.test(e.message)) {
      lastFlashRecord.status = 'отменено пользователем';
      status('');
      log.textContent = 'Прошивка отменена (порт не выбран).';
    } else {
      lastFlashRecord.status = 'ошибка: ' + e.message;
      appendFlashLog('\nОШИБКА: ' + e.message + '\n');
      status('Ошибка прошивки');
      toast('Прошивка: ' + e.message, 'err');
    }
  } finally {
    isFlashing = false;
    $('#btn-flash').disabled = $('#btn-erase').disabled = false;
  }
}

// ============================================================
//  UI: виды, панель, палитра, меню
// ============================================================
function showView(v) {
  const act = $(`.act[data-view="${v}"]`);
  if (act.classList.contains('active') && !$('#sidebar').classList.contains('collapsed')) {
    $('#sidebar').classList.add('collapsed'); return;
  }
  $('#sidebar').classList.remove('collapsed');
  $$('.act').forEach(a => a.classList.toggle('active', a === act));
  $$('.view').forEach(el => el.classList.toggle('hidden', el.id !== 'view-' + v));
  if (v === 'device' && dev.connected) refreshDevice();
}
$$('.act').forEach(a => a.onclick = () => showView(a.dataset.view));

function showPanel(p) {
  $('#panel').classList.remove('collapsed');
  $$('.ptab').forEach(t => t.classList.toggle('active', t.dataset.panel === p));
  $('#terminal').classList.toggle('hidden', p !== 'terminal');
  $('#output').classList.toggle('hidden', p !== 'output');
  if (p === 'terminal') setTimeout(() => fit.fit(), 0);
}
$$('.ptab').forEach(t => t.onclick = () => showPanel(t.dataset.panel));
$('#btn-panel-toggle').onclick = () => { $('#panel').classList.toggle('collapsed'); setTimeout(() => fit.fit(), 0); };
$('#btn-term-clear').onclick = () => term.clear();

function status(msg) { $('#sb-msg').textContent = msg; }
let toastT;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg; t.className = kind; clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.add('hidden'), 3500);
}

function dropdown(x, y, items) {
  const dd = $('#dropdown');
  dd.innerHTML = '';
  for (const it of items) {
    if (it.hide) continue;
    const el = document.createElement('li');
    if (it.sep) { el.className = 'sep'; dd.append(el); continue; }
    el.innerHTML = `<span></span>${it.key ? `<kbd>${it.key}</kbd>` : ''}`;
    el.firstChild.textContent = it.label;
    el.onclick = () => { hideDropdown(); it.run(); };
    dd.append(el);
  }
  dd.classList.remove('hidden');
  dd.style.left = Math.min(x, innerWidth - 240) + 'px';
  dd.style.top = Math.min(y, innerHeight - dd.offsetHeight - 30) + 'px';
}
function hideDropdown() { $('#dropdown').classList.add('hidden'); $$('.menu').forEach(m => m.classList.remove('open')); }
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#dropdown, .menu')) hideDropdown(); });

// ---- команды ----
const COMMANDS = [
  { id: 'connect', label: 'Устройство: Подключить / отключить плату', key: 'Ctrl+Shift+C', run: toggleConnect },
  { id: 'run', label: 'Запустить текущий файл', key: 'F5', run: runCurrent },
  { id: 'stop', label: 'Остановить выполнение', key: 'Shift+F5', run: stopRun },
  { id: 'upload', label: 'Загрузить текущий файл на плату', key: 'Ctrl+U', run: () => uploadFile() },
  { id: 'uploadall', label: 'Загрузить все файлы проекта на плату', run: uploadAll },
  { id: 'reset', label: 'Мягкий сброс платы', key: 'Ctrl+Shift+R', run: softReset },
  { id: 'refresh', label: 'Проверить REPL и обновить список файлов на плате', run: refreshDevice },
  { id: 'diag', label: 'Устройство: Диагностика таймаута REPL и журнал прошивки', run: showDiagnosticReport },
  { id: 'update', label: 'Справка: Обновить с GitHub (проверить релиз esp32-studio-latest)', run: openUpdateModal },
  { id: 'new', label: 'Файл: Новый файл', key: 'Ctrl+N', run: () => newFile() },
  { id: 'open', label: 'Файл: Открыть с компьютера…', key: 'Ctrl+O', run: openLocal },
  { id: 'save', label: 'Файл: Сохранить проект (в браузере)', key: 'Ctrl+S', run: () => { persist(); toast('Проект сохранён в браузере', 'ok'); } },
  { id: 'download', label: 'Файл: Скачать текущий файл', run: () => project.active && downloadFile(project.active) },
  { id: 'rename', label: 'Файл: Переименовать', key: 'F2', run: () => project.active && !project.active.startsWith('dev:') && renameFile(project.active) },
  { id: 'close', label: 'Файл: Закрыть вкладку', key: 'Ctrl+W', run: () => project.active && closeFile(project.active) },
  { id: 'format', label: 'Форматировать документ', key: 'Shift+Alt+F', run: () => editor.getAction('editor.action.formatDocument')?.run() },
  { id: 'panel', label: 'Вид: Показать/скрыть панель', key: 'Ctrl+J', run: () => $('#btn-panel-toggle').click() },
  { id: 'sidebar', label: 'Вид: Показать/скрыть боковую панель', key: 'Ctrl+B', run: () => $('#sidebar').classList.toggle('collapsed') },
  { id: 'explorer', label: 'Вид: Проводник', key: 'Ctrl+Shift+E', run: () => showView('explorer') },
  { id: 'flash', label: 'Вид: Прошивка MicroPython', run: () => showView('flash') },
  { id: 'examples', label: 'Вид: Примеры', run: () => showView('examples') },
  { id: 'termclear', label: 'Терминал: Очистить', run: () => term.clear() },
  { id: 'help', label: 'Справка: Горячие клавиши', key: 'F1', run: showHelp },
];
const cmd = Object.fromEntries(COMMANDS.map(c => [c.id, c]));

function showHelp() {
  const out = $('#output');
  out.textContent = 'ГОРЯЧИЕ КЛАВИШИ\n\n' + COMMANDS.filter(c => c.key).map(c => `${c.key.padEnd(14)} ${c.label}`).join('\n') +
    '\n\nВ терминале: Ctrl+C — прервать программу, Ctrl+D — мягкий сброс, Ctrl+E — режим вставки.\n' +
    'main.py на плате запускается автоматически при включении.\n\n' +
    `Текущая сборка: ${describeLocalBuild()}`;
  showPanel('output');
}

// палитра
let palSel = 0, palItems = [];
function openPalette() {
  $('#palette').classList.remove('hidden');
  const inp = $('#palette-input'); inp.value = ''; inp.focus(); renderPalette('');
}
function closePalette() { $('#palette').classList.add('hidden'); editor.focus(); }
function renderPalette(q) {
  q = q.toLowerCase();
  palItems = COMMANDS.filter(c => c.label.toLowerCase().includes(q));
  palSel = 0;
  $('#palette-list').innerHTML = palItems.map((c, i) => `<li class="${i === 0 ? 'sel' : ''}" data-i="${i}"><span>${c.label}</span><kbd>${c.key || ''}</kbd></li>`).join('');
  $$('#palette-list li').forEach(el => el.onclick = () => { closePalette(); palItems[+el.dataset.i].run(); });
}
$('#palette-input').oninput = (e) => renderPalette(e.target.value);
$('#palette-input').onkeydown = (e) => {
  if (e.key === 'Escape') closePalette();
  if (e.key === 'ArrowDown') { palSel = Math.min(palSel + 1, palItems.length - 1); }
  if (e.key === 'ArrowUp') { palSel = Math.max(palSel - 1, 0); }
  if (e.key === 'Enter' && palItems[palSel]) { closePalette(); palItems[palSel].run(); }
  $$('#palette-list li').forEach((el, i) => el.classList.toggle('sel', i === palSel));
  $$('#palette-list li')[palSel]?.scrollIntoView({ block: 'nearest' });
};
document.addEventListener('mousedown', (e) => { if (!$('#palette').classList.contains('hidden') && !e.target.closest('#palette')) closePalette(); });

// меню
const MENUS = {
  file: ['new', 'open', 'save', 'download', null, 'rename', 'close'],
  device: ['connect', null, 'run', 'stop', 'upload', 'uploadall', 'reset', 'refresh', 'diag', null, 'flash'],
  help: ['update', 'diag', null, 'help', 'examples', { label: 'Документация MicroPython ESP32', run: () => window.open('https://docs.micropython.org/en/latest/esp32/quickref.html', '_blank', 'noopener,noreferrer') }],
};
$$('.menu').forEach(m => m.onclick = (e) => {
  const r = m.getBoundingClientRect();
  m.classList.add('open');
  dropdown(r.left, r.bottom, MENUS[m.dataset.menu].map(x => x === null ? { sep: true } : typeof x === 'string' ? cmd[x] : x));
});

// горячие клавиши
document.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase(), c = e.ctrlKey || e.metaKey;
  const inTerm = e.target.closest('#terminal');
  const hit = (id) => { e.preventDefault(); cmd[id].run(); };
  if (c && e.shiftKey && k === 'p') { e.preventDefault(); return openPalette(); }
  if (e.key === 'F1') { e.preventDefault(); return openPalette(); }
  if (e.key === 'F5' && !e.shiftKey) return hit('run');
  if (e.key === 'F5' && e.shiftKey) return hit('stop');
  if (c && k === 'u') return hit('upload');
  if (c && k === 's') return hit('save');
  if (c && k === 'n') return hit('new');
  if (c && k === 'o') return hit('open');
  if (c && k === 'w') return hit('close');
  if (c && k === 'j') return hit('panel');
  if (c && k === 'b' && !inTerm) return hit('sidebar');
  if (c && e.shiftKey && k === 'e') return hit('explorer');
  if (c && e.shiftKey && k === 'c') return hit('connect');
  if (c && e.shiftKey && k === 'r') return hit('reset');
  if (e.key === 'F2') return hit('rename');
  if (e.key === 'Escape') { closePalette(); hideDropdown(); closeUpdateModal(); }
}, true);

// кнопки
$('#btn-connect').onclick = toggleConnect;
$('#btn-run').onclick = runCurrent;
$('#btn-stop').onclick = stopRun;
$('#btn-upload').onclick = () => uploadFile();
$('#btn-reset').onclick = softReset;
$('#btn-newfile').onclick = () => newFile();
$('#btn-openlocal').onclick = openLocal;
$('#btn-download').onclick = () => project.active && downloadFile(project.active);
$('#btn-devrefresh').onclick = refreshDevice;
$('#btn-uploadall').onclick = uploadAll;
$('#btn-flash').onclick = () => doFlash(false);
$('#btn-erase').onclick = () =>
  confirm('Стереть ВСЮ флеш-память платы?\nВсе файлы (main.py и др.), прошивка и данные будут безвозвратно удалены.') && doFlash(true);
$('#sb-conn').onclick = toggleConnect;
$('#sb-baud').onclick = () => showView('settings');

// примеры
for (const ex of EXAMPLES) {
  const el = li(ex.title, icon(ex.name), '');
  el.title = ex.name;
  el.onclick = () => newFile(uniqueName(ex.name), ex.code);
  $('#tree-examples').append(el);
}

// настройки
$('#set-baud').value = settings.baud; $('#sb-baud').textContent = settings.baud;
$('#set-font').value = settings.font; $('#set-minimap').checked = settings.minimap;
$('#set-wrap').checked = settings.wrap; $('#set-autosave').checked = settings.autosave;
$('#set-baud').onchange = (e) => { settings.baud = +e.target.value; $('#sb-baud').textContent = settings.baud; saveSettings(); };
$('#set-font').onchange = (e) => { settings.font = +e.target.value; editor.updateOptions({ fontSize: settings.font }); saveSettings(); };
$('#set-minimap').onchange = (e) => { settings.minimap = e.target.checked; editor.updateOptions({ minimap: { enabled: settings.minimap } }); saveSettings(); };
$('#set-wrap').onchange = (e) => { settings.wrap = e.target.checked; editor.updateOptions({ wordWrap: settings.wrap ? 'on' : 'off' }); saveSettings(); };
$('#set-autosave').onchange = (e) => { settings.autosave = e.target.checked; saveSettings(); };
$('#btn-wipe').onclick = () => {
  if (!confirm('Удалить все файлы проекта из браузера?')) return;
  localStorage.removeItem(LS_KEY);
  for (const m of models.values()) m.dispose();
  models.clear(); saved.clear();
  project = structuredClone(DEFAULT_PROJECT);
  renderTree(); openFile(project.active);
};

// ресайз боковой панели и нижней панели
$('#sidebar').style.width = settings.sidebarW + 'px';
$('#panel').style.height = settings.panelH + 'px';
function drag(sash, onMove, onEnd) {
  sash.onmousedown = (e) => {
    e.preventDefault();
    const mv = (ev) => onMove(ev);
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); onEnd?.(); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
  };
}
drag($('#sash-side'), (e) => { settings.sidebarW = Math.max(160, Math.min(600, e.clientX - 48)); $('#sidebar').style.width = settings.sidebarW + 'px'; }, saveSettings);
drag($('#sash-panel'), (e) => { settings.panelH = Math.max(35, Math.min(innerHeight - 200, innerHeight - 22 - e.clientY)); $('#panel').style.height = settings.panelH + 'px'; $('#panel').classList.remove('collapsed'); fit.fit(); }, saveSettings);

// ---- старт ----
if (!Device.supported) {
  toast('Этот браузер не поддерживает Web Serial. Нужен Chrome, Edge или Opera на компьютере / Android.', 'err');
  $('#btn-connect').disabled = true;
}
renderTree();
project.open = project.open.filter(k => project.files[k] !== undefined);
if (project.active && project.files[project.active] !== undefined) openFile(project.active);
else if (project.open[0]) openFile(project.open[0]);
else renderTabs();
window.addEventListener('beforeunload', persist);
