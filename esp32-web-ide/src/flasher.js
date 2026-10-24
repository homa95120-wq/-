/** Прошивка MicroPython через esptool-js (Web Serial). */
import { ESPLoader, Transport } from 'esptool-js';

const AUTO_OFFSET = { ESP32: 0x1000, 'ESP32-S2': 0x1000, 'ESP32-S3': 0x0, 'ESP32-C3': 0x0, 'ESP32-C6': 0x0, 'ESP32-C2': 0x0, 'ESP32-H2': 0x0 };

/**
 * @param {SerialPort} port  закрытый порт
 * @param {{data:Uint8Array, offset:'auto'|number, erase:boolean, baud:number, log:(s)=>void, progress:(p)=>void}} o
 */
export async function flashFirmware(port, o) {
  const transport = new Transport(port, false);
  const terminal = { clean() {}, writeLine: (s) => o.log(s + '\n'), write: (s) => o.log(s) };
  const loader = new ESPLoader({ transport, baudrate: o.baud, romBaudrate: 115200, terminal });
  try {
    o.log('Вхожу в режим загрузки…\n');
    const chip = await loader.main();
    o.log(`Чип: ${chip}\n`);
    const key = Object.keys(AUTO_OFFSET).find(k => chip.toUpperCase().startsWith(k) && (k !== 'ESP32' || !/ESP32-/.test(chip.toUpperCase())));
    const offset = o.offset === 'auto' ? (AUTO_OFFSET[key] ?? 0x0) : o.offset;
    o.log(`Адрес записи: 0x${offset.toString(16)}\n`);

    if (o.data) {
      await loader.writeFlash({
        fileArray: [{ data: o.data, address: offset }],
        flashSize: 'keep',
        flashMode: 'keep',
        flashFreq: 'keep',
        eraseAll: o.erase,
        compress: true,
        reportProgress: (_i, written, total) => o.progress(written / total),
      });
      o.log('\nЗапись завершена, перезагружаю плату.\n');
    } else {
      o.log('Стираю флеш…\n');
      await loader.eraseFlash();
      o.log('Флеш стёрт.\n');
    }
    await loader.after('hard_reset');
    return chip;
  } finally {
    try { await transport.disconnect(); } catch {}
  }
}
