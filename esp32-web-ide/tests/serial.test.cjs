const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');

test('Electron: session picker, hotplug, IPC validation, app:// permissions and safe external URLs', async () => {
  const ses = new EventEmitter();
  ses.setPermissionCheckHandler = fn => ses.check = fn;
  ses.setPermissionRequestHandler = fn => ses.request = fn;
  ses.setDevicePermissionHandler = fn => ses.device = fn;
  const ipc = new EventEmitter();
  let wc;
  let winOpenHandler;
  class Window extends EventEmitter {
    constructor() {
      super();
      wc = new EventEmitter();
      wc.session = ses;
      wc.send = (...args) => sent.push(args);
      wc.setWindowOpenHandler = fn => { winOpenHandler = fn; };
      wc.getURL = () => 'app://esp32studio/index.html';
      this.webContents = wc;
    }
    loadURL() {}
  }
  const sent = [];
  const openedUrls = [];
  const app = new EventEmitter(); app.whenReady = () => Promise.resolve();
  const electron = {
    app,
    BrowserWindow: Window,
    ipcMain: ipc,
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    Menu: { setApplicationMenu() {} },
    shell: { openExternal: u => openedUrls.push(u) },
  };
  vm.runInNewContext(fs.readFileSync('electron/main.cjs', 'utf8'), {
    require: name => name === 'electron' ? electron : require(name),
    __dirname: '/test/electron',
    process: { env: {}, platform: 'win32' },
    URL,
    Response,
  });
  await Promise.resolve();
  assert.equal(ses.listenerCount('select-serial-port'), 1);
  assert.equal(wc.listenerCount('select-serial-port'), 0);
  const selected = [];
  ses.emit('select-serial-port', { preventDefault() {} }, [{ portId: '7', portName: 'COM7', vendorId: '1A86' }], wc, id => selected.push(id));
  assert.equal(sent[0][0], 'serial:ports');
  ipc.emit('serial:select', { sender: {} }, '7');
  ipc.emit('serial:select', { sender: wc }, 'unknown');
  assert.equal(selected.length, 0);
  ses.emit('serial-port-added', {}, { portId: '8' }, wc);
  assert.equal(sent.at(-1)[0], 'serial:added');
  ipc.emit('serial:select', { sender: wc }, '7');
  assert.deepEqual(selected, ['7']);
  assert.equal(ses.check(wc, 'serial', 'app://esp32studio'), true);
  assert.equal(ses.check(wc, 'serial', 'https://evil.example'), false);
  assert.equal(ses.device({ deviceType: 'serial', origin: 'app://esp32studio' }), true);
  assert.equal(ses.device({ deviceType: 'usb', origin: 'app://esp32studio' }), false);

  // Проверка фильтрации внешних ссылок
  winOpenHandler({ url: 'https://github.com/homa95120-wq/-/releases/download/esp32-studio-latest/ESP32.Studio.Setup.1.0.0.exe' });
  winOpenHandler({ url: 'javascript:alert(1)' });
  winOpenHandler({ url: 'file:///C:/Windows/System32/cmd.exe' });
  winOpenHandler({ url: 'https://evil.example/malware.exe' });
  assert.deepEqual(openedUrls, [
    'https://github.com/homa95120-wq/-/releases/download/esp32-studio-latest/ESP32.Studio.Setup.1.0.0.exe',
  ]);
});

test('Cancel requestPort does not reopen picker', async () => {
  const { Device } = await import('../src/device.js');
  let calls = 0;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      serial: {
        requestPort: async () => {
          calls++;
          throw new DOMException('Cancelled', 'NotFoundError');
        },
      },
    },
  });
  await assert.rejects(new Device().connect(), { name: 'NotFoundError' });
  assert.equal(calls, 1);
});

test('Device: distinguishes COM open vs REPL ready, does not mark run started before raw REPL OK, and surfaces bootloader errors on timeout', async () => {
  const { Device, diagnoseReplTimeout } = await import('../src/device.js');
  const enc = new TextEncoder();

  function createFakePort(responder) {
    const queue = [];
    let resolveRead = null;
    const pushRx = (str) => {
      const bytes = enc.encode(str);
      if (resolveRead) {
        const r = resolveRead;
        resolveRead = null;
        r({ value: bytes, done: false });
      } else {
        queue.push(bytes);
      }
    };
    return {
      pushRx,
      open: async () => {},
      close: async () => {
        if (resolveRead) {
          const r = resolveRead;
          resolveRead = null;
          r({ value: undefined, done: true });
        }
      },
      setSignals: async () => {},
      addEventListener() {},
      removeEventListener() {},
      readable: {
        getReader() {
          return {
            read: () => {
              if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
              return new Promise(r => { resolveRead = r; });
            },
            cancel: async () => {
              if (resolveRead) {
                const r = resolveRead;
                resolveRead = null;
                r({ value: undefined, done: true });
              }
            },
            releaseLock() {},
          };
        },
      },
      writable: {
        getWriter() {
          return {
            write: async (chunk) => {
              responder?.(new TextDecoder().decode(chunk), pushRx);
            },
            releaseLock() {},
          };
        },
      },
    };
  }

  // 1. COM открыт, но плата выдаёт ошибку загрузчика и не входит в raw REPL
  const termOut = [];
  const portTimeout = createFakePort((tx, pushRx) => {
    if (tx.includes('\x01')) {
      pushRx('ESP-ROM:esp32s3\r\nimage at 0x10000 has invalid magic byte\r\n');
    }
  });
  const dev1 = new Device();
  dev1.rawTimeout = 60;
  dev1.onData = s => termOut.push(s);
  await dev1.open(portTimeout, 115200);
  assert.equal(dev1.connected, true);
  assert.equal(dev1.replReady, false);

  let startedCalled = false;
  await assert.rejects(
    dev1.run('print("wifi")', () => { startedCalled = true; }),
    /Таймаут: плата не ответила \("raw REPL; CTRL-B to exit\\r\\n>"\).*invalid magic byte/
  );
  assert.equal(startedCalled, false);
  assert.equal(dev1.running, false);
  assert.equal(dev1.replReady, false);
  assert.equal(dev1.lastDiagnostic?.kind, 'bootloader-invalid-image');
  assert.match(termOut.join(''), /image at 0x10000 has invalid magic byte/);
  await dev1.disconnect();

  // 2. Плата отвечает в raw REPL и возвращает OK + вывод в одном пакете
  const termOut2 = [];
  let runEnded = false;
  const portOk = createFakePort((tx, pushRx) => {
    if (tx.includes('\x01')) {
      pushRx('raw REPL; CTRL-B to exit\r\n>');
    } else if (tx.includes('\x04')) {
      pushRx('OKscan_done\r\n\x04\x04>');
    }
  });
  const dev2 = new Device();
  dev2.rawTimeout = 200;
  dev2.onData = s => termOut2.push(s);
  dev2.addEventListener('run-end', () => { runEnded = true; });
  await dev2.open(portOk, 115200);

  let started2 = false;
  await dev2.run('print("scan_done")', () => {
    started2 = true;
    termOut2.push('[STARTED]');
  });
  assert.equal(started2, true);
  assert.equal(dev2.replReady, true);
  assert.equal(runEnded, true);
  assert.match(termOut2.join(''), /\[STARTED\][\s\S]*scan_done/);
  await dev2.disconnect();

  // 3. Проверка классификации пустого ответа (S3 встроенный USB vs COM)
  const diagNoData = diagnoseReplTimeout('', 115200);
  assert.equal(diagNoData.kind, 'no-data');
  assert.match(diagNoData.summary, /не доказывает отсутствие MicroPython/i);
  assert.match(diagNoData.summary, /встроенный разъём USB/i);
});

test('Updater: detects new build by commit SHA when version stays 1.0.0 on esp32-studio-latest and selects Windows asset', async () => {
  const {
    checkGitHubUpdate,
    compareBuilds,
    parseReleaseMetadata,
    isSafeReleaseUrl,
  } = await import('../src/updater.js');

  const releasePayload = {
    tag_name: 'esp32-studio-latest',
    name: 'ESP32 Studio (последняя сборка)',
    published_at: '2026-10-24T17:00:49Z',
    html_url: 'https://github.com/homa95120-wq/-/releases/tag/esp32-studio-latest',
    body:
      'Автоматическая сборка ESP32 Studio.\n' +
      '- Версия: `1.0.0`\n' +
      '- Сборка (коммит): `243cd4de8ec16bea40e21e3f8cecc7c988aca08e`\n' +
      '<!-- esp32-studio-release: {"version":"1.0.0","commit":"243cd4de8ec16bea40e21e3f8cecc7c988aca08e","tag":"esp32-studio-latest"} -->',
    assets: [
      {
        name: 'ESP32-Studio-1.0.0-portable.exe',
        size: 120072644,
        updated_at: '2026-10-24T17:20:18Z',
        browser_download_url: 'https://github.com/homa95120-wq/-/releases/download/esp32-studio-latest/ESP32-Studio-1.0.0-portable.exe',
      },
      {
        name: 'ESP32.Studio.Setup.1.0.0.exe',
        size: 139518901,
        updated_at: '2026-10-24T17:20:21Z',
        browser_download_url: 'https://github.com/homa95120-wq/-/releases/download/esp32-studio-latest/ESP32.Studio.Setup.1.0.0.exe',
      },
      {
        name: 'evil.exe',
        size: 1000,
        updated_at: '2026-10-24T17:20:21Z',
        browser_download_url: 'https://evil.example/evil.exe',
      },
    ],
  };

  const parsed = parseReleaseMetadata(releasePayload);
  assert.equal(parsed.version, '1.0.0');
  assert.equal(parsed.shortCommit, '243cd4d');
  assert.equal(parsed.assets.length, 2); // evil.exe отфильтрован
  assert.equal(isSafeReleaseUrl('https://evil.example/evil.exe'), false);

  // Старый коммит при той же версии 1.0.0 -> есть обновление
  const resOld = await checkGitHubUpdate({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => releasePayload }),
    localBuild: { version: '1.0.0', commit: '1111111222222233333334444444555555566666', shortCommit: '1111111', builtAt: '2026-10-24T16:00:00Z' },
    portable: false,
  });
  assert.equal(resOld.hasUpdate, true);
  assert.equal(resOld.reason, 'new-commit');
  assert.equal(resOld.downloads.primary.name, 'ESP32.Studio.Setup.1.0.0.exe');
  assert.equal(resOld.downloads.secondary.name, 'ESP32-Studio-1.0.0-portable.exe');

  // Тот же коммит при версии 1.0.0 (даже если файл на GitHub загружен на 2 минуты позже сборки) -> обновление не требуется
  const resSame = await checkGitHubUpdate({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => releasePayload }),
    localBuild: { version: '1.0.0', commit: '243cd4de8ec16bea40e21e3f8cecc7c988aca08e', shortCommit: '243cd4d', builtAt: '2026-10-24T17:18:00Z' },
    portable: true,
  });
  assert.equal(resSame.hasUpdate, false);
  assert.equal(resSame.reason, 'same-commit');
  assert.equal(resSame.downloads.primary.name, 'ESP32-Studio-1.0.0-portable.exe');

  // Релиз без метки коммита — сравнение по времени публикации артефакта
  const cmpLegacy = compareBuilds(
    { version: '1.0.0', commit: '243cd4d', builtAt: '2026-10-24T16:00:00Z' },
    { version: '1.0.0', commit: '', updatedAt: '2026-10-24T17:20:21Z' },
  );
  assert.equal(cmpLegacy.hasUpdate, true);
  assert.equal(cmpLegacy.reason, 'newer-timestamp');

  // Ошибка сети и ошибка GitHub API
  await assert.rejects(
    checkGitHubUpdate({
      fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
    }),
    /Не удалось связаться с GitHub/
  );
  await assert.rejects(
    checkGitHubUpdate({
      fetchImpl: async () => ({ ok: false, status: 403 }),
    }),
    /Превышен лимит запросов к GitHub API/
  );
});
