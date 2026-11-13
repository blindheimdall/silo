// One live page connection (Server-Sent Events), safe with slow clients. Messages of one tick are joined and sent with a
// single compressor flush. While the connection still holds unsent data, nothing new is written: the caller skips the
// page that tick and later sends one patch (or the full state) from what the page last got, so updates are merged
// instead of piling up in memory. A page that stays behind too long, or with too much unsent, is closed; it connects
// again by itself and gets the whole state.
import zlib from 'node:zlib';

export const LIVE_LIMITS = {behind: 256 * 1024, cut: 4 * 1024 * 1024, stall: 60_000};

export function liveChannel(res, enc, {limits = LIVE_LIMITS, now = Date.now, onClose} = {}) {
  const z = enc === 'br' ? zlib.createBrotliCompress({params: {[zlib.constants.BROTLI_PARAM_QUALITY]: 4}}) : enc === 'gzip' ? zlib.createGzip({level: 5}) : null;
  if (z) z.pipe(res);
  const parts = [];
  const c = {
    closed: false, behindSince: 0, skipped: 0, resyncs: 0,
    // Bytes written but not yet taken by the network, in the compressor and in the socket.
    unsent() { return (res.writableLength || 0) + (z ? z.writableLength || 0 : 0); },
    // True while the page has not taken what it was sent. Closes it when it stays that way too long.
    behind() {
      if (c.closed) return true;
      const pending = c.unsent(), late = res.writableNeedDrain || pending > limits.behind;
      if (!late) { c.behindSince = 0; return false; }
      c.behindSince ||= now();
      if (pending > limits.cut || now() - c.behindSince > limits.stall) c.close();
      return true;
    },
    write(text) { if (!c.closed) parts.push(text); },
    send(name, data) { c.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); },
    // Everything queued since the last flush goes out as one write and one compressor flush.
    flush() {
      if (c.closed || !parts.length) return;
      const text = parts.join(''); parts.length = 0;
      try {
        if (z) { z.write(text); z.flush(enc === 'br' ? zlib.constants.BROTLI_OPERATION_FLUSH : zlib.constants.Z_SYNC_FLUSH); }
        else res.write(text);
      } catch { c.close(); }
    },
    // What is still queued (a last "end" message) goes out first.
    close() { if (c.closed) return; c.flush(); c.closed = true; parts.length = 0; try { z ? z.end() : res.end(); } catch {} onClose?.(c); },
  };
  return c;
}
