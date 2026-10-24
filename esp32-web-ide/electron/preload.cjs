// Диалог выбора COM-порта для Web Serial внутри Electron
const { ipcRenderer, contextBridge } = require('electron');

contextBridge.exposeInMainWorld('esp32studio', {
  desktop: true,
  platform: process.platform,
  portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR),
});

let overlay = null;
function closeOverlay() { overlay?.remove(); overlay = null; }

function labelOf(p) {
  const vendor = typeof p.vendorId === 'string' ? parseInt(p.vendorId, 16) : p.vendorId;
  const vid = vendor ? ` VID ${vendor.toString(16).padStart(4, '0').toUpperCase()}` : '';
  const hint = { 0x303a: 'Espressif USB', 0x10c4: 'CP210x', 0x1a86: 'CH340 / CH343', 0x0403: 'FTDI' }[vendor] || '';
  return `${p.portName || p.displayName || p.portId}${p.displayName && p.displayName !== p.portName ? ' — ' + p.displayName : ''}${hint ? ' · ' + hint : vid}`;
}

function render(ports) {
  closeOverlay();
  overlay = document.createElement('div');
  overlay.id = 'port-picker';
  overlay.innerHTML = `
  <style>
    #port-picker{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;display:flex;align-items:flex-start;justify-content:center;padding-top:60px;font-family:"Segoe UI",system-ui,sans-serif;font-size:13px}
    #port-picker .box{width:520px;max-width:92vw;background:#252526;border:1px solid #454545;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.6);color:#ccc;overflow:hidden}
    #port-picker h3{margin:0;padding:12px 16px;font-size:13px;font-weight:600;background:#3c3c3c;color:#fff}
    #port-picker ul{list-style:none;margin:0;padding:6px 0;max-height:50vh;overflow:auto}
    #port-picker li{padding:8px 16px;cursor:pointer;display:flex;gap:10px;align-items:center}
    #port-picker li:hover{background:#04395e;color:#fff}
    #port-picker li.empty{color:#858585;cursor:default}
    #port-picker li.empty:hover{background:none;color:#858585}
    #port-picker .foot{display:flex;justify-content:flex-end;gap:8px;padding:10px 16px;border-top:1px solid #3c3c3c}
    #port-picker button{background:#3c3c3c;color:#ccc;border:0;padding:6px 14px;border-radius:2px;cursor:pointer;font-family:inherit}
    #port-picker button:hover{background:#4a4a4a}
  </style>
  <div class="box">
    <h3>Выбери порт платы</h3>
    <ul></ul>
    <div class="foot"><span style="flex:1;color:#858585;align-self:center">Подключи плату по USB — список обновится сам</span><button data-act="cancel">Отмена</button></div>
  </div>`;
  const ul = overlay.querySelector('ul');
  if (!ports.length) ul.innerHTML = '<li class="empty">Портов не найдено. Проверь кабель (нужен кабель с данными, не только зарядка) и драйвер CH343 / CH340 / CP210x. Для платы с двумя USB используй разъём COM.</li>';
  for (const p of ports) {
    const li = document.createElement('li');
    li.innerHTML = '<span>🔌</span><span></span>';
    li.lastChild.textContent = labelOf(p);
    li.onclick = () => { ipcRenderer.send('serial:select', p.portId); closeOverlay(); };
    ul.append(li);
  }
  overlay.querySelector('[data-act=cancel]').onclick = () => { ipcRenderer.send('serial:select', ''); closeOverlay(); };
  document.body.append(overlay);
}

let current = [];
ipcRenderer.on('serial:ports', (_e, ports) => { current = ports; render(current); });
ipcRenderer.on('serial:added', (_e, p) => { if (overlay) { current = current.filter(x => x.portId !== p.portId); current.push(p); render(current); } });
ipcRenderer.on('serial:removed', (_e, p) => { if (overlay) { current = current.filter(x => x.portId !== p.portId); render(current); } });
