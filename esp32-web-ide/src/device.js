/**
 * Связь с платой по Web Serial + протокол raw REPL MicroPython.
 *
 *  Терминал всегда получает поток байт от платы (onData).
 *  Команды (список файлов, загрузка, запуск) выполняются через raw REPL:
 *    Ctrl-A  → raw режим,  код + Ctrl-D → выполнить,  Ctrl-B → обычный REPL.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Классифицирует причину таймаута raw REPL по байтам, полученным от платы.
 * Отсутствие ответа на COM-порту НЕ является доказательством отсутствия MicroPython.
 */
export function diagnoseReplTimeout(rxText = '', baud = 115200) {
  const text = typeof rxText === 'string' ? rxText : '';
  const trimmed = text.trim();

  if (/invalid magic byte|invalid header/i.test(text)) {
    return {
      kind: 'bootloader-invalid-image',
      rxSample: trimmed.slice(-300),
      baud,
      summary:
        'Загрузчик ESP32 сообщил о повреждённом или неполном образе прошивки (invalid magic byte / invalid header). ' +
        'Проверь полное имя файла .bin (для ESP32-S3 N16R8 нужен ESP32_GENERIC_S3-SPIRAM_OCT-*.bin по адресу 0x0) и убедись, что запись дошла до конца.',
    };
  }

  if (/waiting for download|download mode/i.test(text)) {
    return {
      kind: 'bootloader-download',
      rxSample: trimmed.slice(-300),
      baud,
      summary:
        'Плата находится в режиме загрузчика (waiting for download). Нажми физическую кнопку RESET на плате и повтори проверку REPL.',
    };
  }

  if (!trimmed) {
    return {
      kind: 'no-data',
      rxSample: '',
      baud,
      summary:
        'COM-порт открыт, но плата не прислала данных в ответ на Ctrl+C / Ctrl+A. ' +
        'Это не доказывает отсутствие MicroPython: на платах ESP32-S3 с двумя разъёмами (COM и USB) загрузчик работает через COM (CH343), ' +
        'а консоль REPL MicroPython может быть выведена на встроенный разъём USB (Espressif USB-CDC, VID 303A).',
    };
  }

  return {
    kind: 'unexpected-output',
    rxSample: trimmed.slice(-300),
    baud,
    summary:
      'Плата присылает данные в порт, но не переходит в raw REPL MicroPython. ' +
      'Возможно, выполняется плотный цикл без прерывания, запущена другая прошивка или скорость порта не совпадает.',
  };
}

export class Device extends EventTarget {
  constructor() {
    super();
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.connected = false;      // открыт ли COM-порт
    this.replReady = false;      // подтверждён ли ответ MicroPython REPL
    this.buf = '';               // накопитель для expect()
    this.lastRx = '';            // последние принятые данные (для диагностики)
    this.lastDiagnostic = null;  // результат последней диагностики таймаута
    this.rawTimeout = 3000;      // таймаут ожидания raw REPL (мс)
    this.quiet = false;          // не слать в терминал (во время служебных команд)
    this.running = false;        // идёт исполнение пользовательского кода в raw REPL
    this.busy = false;
    this.onData = () => {};
    this._onDisconnect = () => this._lost();
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
    try { await port.setSignals?.({ dataTerminalReady: false, requestToSend: false }); } catch {}
    this.port = port;
    this.buf = '';
    this.lastRx = '';
    this.lastDiagnostic = null;
    this.replReady = false;
    this.running = false;
    this.busy = false;
    this.quiet = false;
    this.writer = port.writable.getWriter();
    this.connected = true;
    this.baud = baud;
    this._readLoop();
    try { port.removeEventListener?.('disconnect', this._onDisconnect); } catch {}
    port.addEventListener?.('disconnect', this._onDisconnect);
    // Прерываем что бы ни крутилось и запрашиваем обычное приглашение
    await this.write('\r\x03\x03');
    await this.sleep(100);
    await this.write('\x02\r');
    this.dispatchEvent(new Event('connect'));
  }

  async disconnect() {
    if (!this.port) return;
    const port = this.port;
    this.connected = false;
    this.replReady = false;
    this.running = false;
    this.busy = false;
    this.quiet = false;
    try { port.removeEventListener?.('disconnect', this._onDisconnect); } catch {}
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
    try { this.port?.removeEventListener?.('disconnect', this._onDisconnect); } catch {}
    this.connected = false;
    this.replReady = false;
    this.running = false;
    this.busy = false;
    this.quiet = false;
    this.port = null; this.reader = null; this.writer = null;
    this.dispatchEvent(new Event('disconnect'));
  }

  _flushRunBuffer() {
    if (!this.running || !this.buf) return;
    const endIdx = this.buf.indexOf('\x04>');
    if (endIdx >= 0) {
      const out = this.buf.slice(0, endIdx).replace(/\x04/g, '');
      this.buf = this.buf.slice(endIdx + 2);
      if (out) this.onData(out);
      this.running = false;
      this.write('\x02').catch(() => {});
      this.dispatchEvent(new Event('run-end'));
    } else {
      const out = this.buf.replace(/\x04/g, '');
      this.buf = '';
      if (out) this.onData(out);
    }
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
          this.lastRx = (this.lastRx + s).slice(-4096);
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
    const marker = 'raw REPL; CTRL-B to exit\r\n>';
    const firstTimeout = Math.max(20, Math.floor(this.rawTimeout * 0.6));
    const retryTimeout = Math.max(20, this.rawTimeout - firstTimeout);
    let captured = '';

    this.buf = '';
    await this.write('\r\x03\x03');     // стоп
    await this.sleep(Math.min(60, firstTimeout));
    captured += this.buf;
    this.buf = '';
    await this.write('\r\x01');         // raw mode

    try {
      await this.expect(marker, firstTimeout);
    } catch (firstErr) {
      captured += this.buf;
      this.buf = '';
      if (!this.connected) throw firstErr;
      // Вторая попытка: выйти из возможного paste/raw режима, прервать код и снова запросить raw REPL
      await this.write('\r\x02\r\x03\x03');
      await this.sleep(Math.min(80, retryTimeout));
      captured += this.buf;
      this.buf = '';
      await this.write('\r\x01');
      try {
        await this.expect(marker, retryTimeout);
      } catch {
        captured += this.buf;
        this.buf = '';
        this.replReady = false;
        // Если во время тихого опроса плата прислала ошибки загрузчика/лог — показать их в терминале
        if (this.quiet && captured) this.onData(captured);
        const diag = diagnoseReplTimeout(captured || this.lastRx, this.baud);
        this.lastDiagnostic = diag;
        this.dispatchEvent(new CustomEvent('repl-timeout', { detail: diag }));
        let msg = `Таймаут: плата не ответила (${JSON.stringify(marker)})`;
        if (diag.kind === 'bootloader-invalid-image') {
          msg += ' — загрузчик сообщил об ошибке образа прошивки (invalid magic byte / header)';
        } else if (diag.kind === 'bootloader-download') {
          msg += ' — плата в режиме загрузчика (нажми RESET)';
        }
        const err = new Error(msg);
        err.diagnostic = diag;
        throw err;
      }
    }

    const wasReady = this.replReady;
    this.replReady = true;
    this.lastDiagnostic = null;
    if (!wasReady) this.dispatchEvent(new Event('repl-ready'));
  }

  async exitRaw() { await this.write('\x02'); }

  /** Выполнить код в raw REPL и вернуть out. Терминал молчит. */
  async exec(code, timeout = 10000) {
    if (this.busy) throw new Error('Плата занята');
    this.busy = true; this.quiet = true;
    try {
      await this.enterRaw();
      await this.write(code);
      await this.write('\x04');
      const ok = await this.expect('OK', this.rawTimeout);
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

  /**
   * Запустить код, вывод стримится в терминал.
   * Не отмечает запуск успешным и не вызывает onStarted до ответа raw REPL ('OK').
   */
  async run(code, onStarted) {
    if (this.busy) throw new Error('Плата занята');
    this.busy = true; this.quiet = true;
    this.running = false;
    try {
      await this.enterRaw();
      await this.write(code);
      await this.write('\x04');
      await this.expect('OK', this.rawTimeout);
      this.replReady = true;
      this.running = true;
      this.quiet = false;
      onStarted?.();
      this.dispatchEvent(new Event('run-start'));
      this.onData('\r\n');
      this._flushRunBuffer();
    } catch (e) {
      this.running = false;
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
        await this.expect('OK', this.rawTimeout);
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
