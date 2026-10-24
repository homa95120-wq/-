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
  win.webContents.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    pendingPortCb = callback;
    win.webContents.send('serial:ports', portList.map(p => ({
      portId: p.portId, portName: p.portName, displayName: p.displayName,
      vendorId: p.vendorId, productId: p.productId,
    })));
  });
  win.webContents.on('serial-port-added', (_e, port) => win.webContents.send('serial:added', port));
  win.webContents.on('serial-port-removed', (_e, port) => win.webContents.send('serial:removed', port));

  ses.setPermissionCheckHandler((_wc, permission) => permission === 'serial' || permission === 'usb' ? true : false);
  ses.setDevicePermissionHandler((details) => details.deviceType === 'serial');

  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  if (isDev) win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else win.loadURL('app://esp32studio/index.html');
}

ipcMain.on('serial:select', (_e, portId) => {
  if (pendingPortCb) { pendingPortCb(portId || ''); pendingPortCb = null; }
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
