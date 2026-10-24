/** Прошивка MicroPython через esptool-js (Web Serial). */
import { ESPLoader, Transport } from 'esptool-js';

const AUTO_OFFSET = { ESP32: 0x1000, 'ESP32-S2': 0x1000, 'ESP32-S3': 0x0, 'ESP32-C3': 0x0, 'ESP32-C6': 0x0, 'ESP32-C2': 0x0, 'ESP32-H2': 0x0 };

/**
 * @param {SerialPort} port  закрытый порт
 * @param {{data:Uint8Array|null, fileName?:string, offset:'auto'|number, erase:boolean, baud:number, log:(s:string)=>void, progress:(p:number)=>void}} o
 */
export async function flashFirmware(port, o) {
  const transport = new Transport(port, false);
  const terminal = { clean() {}, writeLine: (s) => o.log(s + '\n'), write: (s) => o.log(s) };
  const loader = new ESPLoader({ transport, baudrate: o.baud, romBaudrate: 115200, terminal });
  try {
    if (o.data && o.fileName) {
      o.log(`Файл: ${o.fileName} (${o.data.byteLength} байт)\n`);
    }
    if (o.data && o.data.byteLength > 0 && o.data[0] !== 0xe9) {
      o.log(`⚠ Внимание: первый байт файла (0x${o.data[0].toString(16)}) не равен 0xE9. Проверь, что выбран корректный .bin для ESP32.\n`);
    }
    o.log(`Скорость прошивки: ${o.baud}, стирание перед записью: ${o.erase ? 'да (все данные будут удалены)' : 'нет'}\n`);
    o.log('Вхожу в режим загрузки…\n');
    const chip = await loader.main();
    o.log(`Чип: ${chip}\n`);
    const key = Object.keys(AUTO_OFFSET).find(k => chip.toUpperCase().startsWith(k) && (k !== 'ESP32' || !/ESP32-/.test(chip.toUpperCase())));
    const offset = o.offset === 'auto' ? (AUTO_OFFSET[key] ?? 0x0) : o.offset;
    o.log(`Адрес записи: 0x${offset.toString(16)}\n`);
    if (key === 'ESP32-S3' && offset !== 0x0) {
      o.log(`⚠ Для ESP32-S3 официальный образ MicroPython должен записываться по адресу 0x0.\n`);
    }

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
      o.log('\n✓ Запись завершена успешно, перезагружаю плату…\n');
    } else {
      o.log('Стираю флеш…\n');
      await loader.eraseFlash();
      o.log('✓ Флеш стёрт.\n');
    }
    await loader.after('hard_reset');
    o.log('✓ Перезагрузка выполнена (если плата осталась в загрузчике — нажми кнопку RESET).\n');
    return chip;
  } finally {
    try { await transport.disconnect(); } catch {}
    try { if (port?.readable || port?.writable) await port.close(); } catch {}
  }
}
