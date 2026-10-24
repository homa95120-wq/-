// ESP32 Studio — desktop (Electron)
const { app, BrowserWindow, protocol, net, session, ipcMain, Menu, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DIST = path.join(__dirname, '..', 'dist');
const isDev = !!process.env.VITE_DEV_SERVER_URL;

// Собственная схема app:// — безопасный контекст, работают Web Serial и web-workers Monaco
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

let win;
let pendingPortCb = null;
let availablePortIds = new Set();

function trustedContents(wc) { return wc === win?.webContents; }
function trustedOrigin(origin) {
  try {
    const url = new URL(origin);
    return isDev ? url.origin === new URL(process.env.VITE_DEV_SERVER_URL).origin
      : url.protocol === 'app:' && url.host === 'esp32studio';
  } catch { return false; }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 900, minHeight: 600,
    backgroundColor: '#1e1e1e',
    title: 'ESP32 Studio',
    icon: path.join(__dirname, '..', 'resources', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: false,
    },
  });
  Menu.setApplicationMenu(null);

  const ses = win.webContents.session;

  // --- Web Serial: выбор порта ---
  ses.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    if (!trustedContents(webContents)) { callback(''); return; }
    if (pendingPortCb) pendingPortCb('');
    pendingPortCb = callback;
    availablePortIds = new Set(portList.map(p => p.portId));
    win.webContents.send('serial:ports', portList.map(p => ({
      portId: p.portId, portName: p.portName, displayName: p.displayName,
      vendorId: p.vendorId, productId: p.productId,
    })));
  });
  ses.on('serial-port-added', (_e, port, wc) => {
    if (!pendingPortCb || !trustedContents(wc)) return;
    availablePortIds.add(port.portId);
    win.webContents.send('serial:added', port);
  });
  ses.on('serial-port-removed', (_e, port, wc) => {
    if (!pendingPortCb || !trustedContents(wc)) return;
    availablePortIds.delete(port.portId);
    win.webContents.send('serial:removed', port);
  });
  win.on('closed', () => {
    const cb = pendingPortCb; pendingPortCb = null; availablePortIds.clear();
    if (cb) cb('');
  });

  ses.setPermissionCheckHandler((wc, permission, origin) =>
    trustedContents(wc) && permission === 'serial' && trustedOrigin(origin));
  ses.setPermissionRequestHandler((wc, permission, callback) =>
    callback(trustedContents(wc) && permission === 'serial' && trustedOrigin(wc.getURL())));
  ses.setDevicePermissionHandler((details) =>
    details.deviceType === 'serial' && trustedOrigin(details.origin));

  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  if (isDev) win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else win.loadURL('app://esp32studio/index.html');
}

ipcMain.on('serial:select', (event, portId) => {
  if (!trustedContents(event.sender) || typeof portId !== 'string') return;
  if (portId && !availablePortIds.has(portId)) return;
  const cb = pendingPortCb;
  pendingPortCb = null; availablePortIds.clear();
  if (cb) cb(portId);
});

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const u = new URL(req.url);
    let p = decodeURIComponent(u.pathname);
    if (p === '/' || p === '') p = '/index.html';
    const file = path.normalize(path.join(DIST, p));
    if (!file.startsWith(DIST)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
