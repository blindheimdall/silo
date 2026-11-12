// Paints resident sprite strips off the main thread, so a silo with hundreds of residents opens without a stall.
// Receives {looks:[look]}, answers in small batches of {done:[{key,bitmap}]} and finally {end:true}.
import { paintAtlas, CELL_W, CELL_H, FRAMES } from './resident-sprite.js';

const BATCH = 24;
self.onmessage = e => {
  const looks = e.data?.looks || [];
  let done = [];
  const send = () => { if (done.length) self.postMessage({ done }, done.map(x => x.bitmap)); done = []; };
  for (const look of looks) {
    try {
      const canvas = new OffscreenCanvas(CELL_W * FRAMES, CELL_H);
      paintAtlas(canvas.getContext('2d'), look);
      done.push({ key: look.key, bitmap: canvas.transferToImageBitmap() });
    } catch {}
    if (done.length >= BATCH) send();
  }
  send();
  self.postMessage({ end: true });
};
