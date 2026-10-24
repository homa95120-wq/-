/**
 * Связь с платой по Web Serial + протокол raw REPL MicroPython.
 *
 *  Терминал всегда получает поток байт от платы (onData).
 *  Команды (список файлов, загрузка, запуск) выполняются через raw REPL:
 *    Ctrl-A  → raw режим,  код + Ctrl-D → выполнить,  Ctrl-B → обычный REPL.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export class Device extends EventTarget {
  constructor() {
    super();
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.connected = false;
    this.buf = '';          // накопитель для expect()
    this.quiet = false;     // не слать в терминал (во время служебных команд)
    this.running = false;   // идёт исполнение пользовательского кода в raw REPL
    this.busy = false;
    this.onData = () => {};
  }

  static get supported() { return 'serial' in navigator; }

  async connect(baud = 115200) {
    if (!Device.supported) throw new Error('Web Serial не поддерживается. Используй Chrome, Edge или Opera.');
    // Без VID-фильтра: показываем также неизвестные USB-UART и системные COM-порты.
    // Отмена не должна открывать второй диалог.
    const port = await navigator.serial.requestPort();
    await this.open(port, baud);
  }

  async open(port, baud = 115200) {
    await port.open({ baudRate: baud, bufferSize: 65536 });
    this.port = port;
    this.buf = '';
    this.writer = port.writable.getWriter();
    this.connected = true;
    this.baud = baud;
    this._readLoop();
    port.addEventListener('disconnect', () => this._lost());
    // Прерываем что бы ни крутилось и показываем приглашение
    await this.write('\r\x03\x03');
    await this.sleep(100);
    await this.write('\x02\r');
    this.dispatchEvent(new Event('connect'));
  }

  async disconnect() {
    if (!this.port) return;
    const port = this.port;
    this.connected = false;
    try { await this.reader?.cancel(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    await this.sleep(50);
    try { await port.close(); } catch {}
    this.port = null; this.reader = null; this.writer = null;
    this.dispatchEvent(new Event('disconnect'));
  }

  /** Отдать порт (закрытый) другому потребителю, например прошивальщику */
  async release() {
    const port = this.port;
    await this.disconnect();
    return port;
  }

  _lost() {
    if (!this.connected) return;
    this.connected = false;
    this.port = null; this.reader = null; this.writer = null;
    this.dispatchEvent(new Event('disconnect'));
  }

  async _readLoop() {
    while (this.port?.readable && this.connected) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          const s = dec.decode(value, { stream: true });
          this.buf += s;
          if (this.buf.length > 200000) this.buf = this.buf.slice(-100000);
          if (!this.quiet) this.onData(s);
          // программа, запущенная через run(), завершилась → вернуть обычный REPL
          if (this.running && this.buf.includes('\x04>')) {
            this.running = false;
            this.buf = '';
            this.write('\x02').catch(() => {});
            this.dispatchEvent(new Event('run-end'));
          }
        }
      } catch (e) {
        if (this.connected) console.warn('serial read', e);
      } finally {
        try { this.reader.releaseLock(); } catch {}
      }
      if (!this.connected) break;
    }
    this._lost();
  }

  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async write(data) {
    if (!this.writer) throw new Error('Плата не подключена');
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    // пишем кусками, чтобы не переполнить буфер USB-CDC
    const CH = 256;
    for (let i = 0; i < bytes.length; i += CH) {
      await this.writer.write(bytes.subarray(i, i + CH));
      if (bytes.length > CH) await this.sleep(8);
    }
  }

  /** Ждать, пока в буфере появится marker. Возвращает текст до маркера и обрезает буфер. */
  async expect(marker, timeout = 5000) {
    const t0 = Date.now();
    for (;;) {
      const i = this.buf.indexOf(marker);
      if (i >= 0) {
        const out = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + marker.length);
        return out;
      }
      if (Date.now() - t0 > timeout) throw new Error(`Таймаут: плата не ответила (${JSON.stringify(marker)})`);
      await this.sleep(10);
    }
  }

  // ---------- raw REPL ----------
  async enterRaw() {
    this.buf = '';
    await this.write('\r\x03\x03');     // стоп
    await this.sleep(60);
    this.buf = '';
    await this.write('\r\x01');         // raw mode
    await this.expect('raw REPL; CTRL-B to exit\r\n>', 3000);
  }

  async exitRaw() { await this.write('\x02'); }

  /** Выполнить код в raw REPL и вернуть {out, err}. Терминал молчит. */
  async exec(code, timeout = 10000) {
    if (this.busy) throw new Error('Плата занята');
    this.busy = true; this.quiet = true;
    try {
      await this.enterRaw();
      await this.write(code);
      await this.write('\x04');
      const ok = await this.expect('OK', 3000);
      void ok;
      const out = await this.expect('\x04', timeout);
      const err = await this.expect('\x04', timeout);
      await this.expect('>', 2000);
      await this.exitRaw();
      if (err.trim()) throw new Error(err.trim());
      return out;
    } finally {
      this.quiet = false; this.busy = false;
    }
  }

  /** Запустить код, вывод стримится в терминал. Не ждёт завершения. */
  async run(code) {
    if (this.busy) throw new Error('Плата занята');
    this.busy = true; this.quiet = true;
    try {
      await this.enterRaw();
      await this.write(code);
      await this.write('\x04');
      await this.expect('OK', 3000);
      this.running = true;
      this.quiet = false;
      this.onData('\r\n');
    } catch (e) {
      this.quiet = false;
      throw e;
    } finally {
      this.busy = false;
    }
  }

  async stop() {
    await this.write('\r\x03\x03');
    if (this.running) { this.running = false; await this.sleep(50); await this.write('\x02'); }
  }

  async softReset() {
    await this.stop();
    await this.sleep(50);
    await this.write('\x04');
  }

  // ---------- файловые операции ----------
  async listdir(path = '/') {
    const out = await this.exec(
`import os,json
r=[]
for n in os.listdir(${JSON.stringify(path)}):
    p=(${JSON.stringify(path)}.rstrip('/')+'/'+n)
    s=os.stat(p)
    r.append([n,s[6],(s[0]&0x4000)!=0])
print(json.dumps(r))`);
    return JSON.parse(out.trim() || '[]').map(([name, size, dir]) => ({ name, size, dir }));
  }

  async readFile(path) {
    const out = await this.exec(
`import binascii
with open(${JSON.stringify(path)},'rb') as f:
    while True:
        b=f.read(512)
        if not b: break
        print(binascii.b2a_base64(b).decode().strip())`, 30000);
    const bin = atob(out.replace(/\s+/g, ''));
    return dec.decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  }

  async writeFile(path, text, onProgress) {
    const bytes = typeof text === 'string' ? enc.encode(text) : text;
    if (this.busy) throw new Error('Плата занята');
    this.busy = true; this.quiet = true;
    try {
      await this.enterRaw();
      const send = async (code) => {
        await this.write(code + '\x04');
        await this.expect('OK', 3000);
        const out = await this.expect('\x04', 10000);
        const err = await this.expect('\x04', 10000);
        await this.expect('>', 2000);
        if (err.trim()) throw new Error(err.trim());
        return out;
      };
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      if (dir) await send(`import os\ntry:\n os.mkdir(${JSON.stringify(dir)})\nexcept: pass`);
      await send(`import binascii\nf=open(${JSON.stringify(path)},'wb')`);
      const CH = 768;
      for (let i = 0; i < bytes.length; i += CH) {
        const chunk = bytes.subarray(i, i + CH);
        const b64 = btoa(String.fromCharCode(...chunk));
        await send(`f.write(binascii.a2b_base64('${b64}'))`);
        onProgress?.(Math.min(1, (i + CH) / bytes.length));
      }
      await send('f.close()');
      await this.exitRaw();
    } finally {
      this.quiet = false; this.busy = false;
    }
  }

  async remove(path) {
    await this.exec(`import os\ntry:\n os.remove(${JSON.stringify(path)})\nexcept OSError:\n os.rmdir(${JSON.stringify(path)})`);
  }

  async info() {
    const out = await this.exec(
`import os,sys,gc,json
try:
    import machine; f=machine.freq()
except: f=0
s=os.statvfs('/')
gc.collect()
print(json.dumps({"platform":sys.platform,"version":os.uname().version,"machine":os.uname().machine,"freq":f,"fs_total":s[0]*s[2],"fs_free":s[0]*s[3],"mem_free":gc.mem_free()}))`);
    return JSON.parse(out.trim());
  }
}
