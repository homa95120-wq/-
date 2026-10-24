const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');

test('Electron: session picker, hotplug, IPC validation and app:// permissions', async () => {
  const ses = new EventEmitter();
  ses.setPermissionCheckHandler = fn => ses.check = fn;
  ses.setPermissionRequestHandler = fn => ses.request = fn;
  ses.setDevicePermissionHandler = fn => ses.device = fn;
  const ipc = new EventEmitter();
  let wc;
  class Window extends EventEmitter {
    constructor() { super(); wc = new EventEmitter(); wc.session = ses; wc.send = (...args) => sent.push(args); wc.setWindowOpenHandler = () => {}; wc.getURL = () => 'app://esp32studio/index.html'; this.webContents = wc; }
    loadURL() {}
  }
  const sent = [];
  const app = new EventEmitter(); app.whenReady = () => Promise.resolve();
  const electron = { app, BrowserWindow: Window, ipcMain: ipc, protocol: { registerSchemesAsPrivileged() {}, handle() {} }, Menu: { setApplicationMenu() {} }, shell: {} };
  vm.runInNewContext(fs.readFileSync('electron/main.cjs', 'utf8'), {
    require: name => name === 'electron' ? electron : require(name), __dirname: '/test/electron', process: { env: {}, platform: 'win32' }, URL, Response,
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
});

test('Cancel requestPort does not reopen picker', async () => {
  const { Device } = await import('../src/device.js');
  let calls = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { serial: { requestPort: async () => { calls++; throw new DOMException('Cancelled', 'NotFoundError'); } } } });
  await assert.rejects(new Device().connect(), { name: 'NotFoundError' });
  assert.equal(calls, 1);
});
