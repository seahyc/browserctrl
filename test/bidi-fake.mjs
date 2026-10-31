// A minimal WebDriver BiDi server for tests: an RFC 6455 WebSocket over node:net that answers
// commands with a handler and records them. No dependencies.
import net from 'node:net';
import crypto from 'node:crypto';

function frame(text) {
  const payload = Buffer.from(text);
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x81, len]) : len < 65536 ? Buffer.from([0x81, 126, len >> 8, len & 255]) : (() => {
    const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 127; b.writeBigUInt64BE(BigInt(len), 2); return b;
  })();
  return Buffer.concat([head, payload]);
}

function* parseFrames(state) {
  while (state.buf.length >= 2) {
    const b = state.buf;
    const opcode = b[0] & 0x0f;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    const masked = (b[1] & 0x80) !== 0;
    const maskOff = off;
    if (masked) off += 4;
    if (b.length < off + len) return;
    const data = Buffer.from(b.subarray(off, off + len));
    if (masked) for (let i = 0; i < data.length; i++) data[i] ^= b[maskOff + (i % 4)];
    state.buf = b.subarray(off + len);
    yield { opcode, data };
  }
}

/** handler(method, params) → result object, or throws { error, message } for a BiDi error. */
export async function startFakeBidi(handler) {
  const calls = [];
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let upgraded = false;
    const state = { buf: Buffer.alloc(0) };
    socket.on('data', async chunk => {
      if (!upgraded) {
        const req = chunk.toString('utf8');
        const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(req)?.[1]?.trim();
        if (!key) { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
        const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        upgraded = true;
        return;
      }
      state.buf = Buffer.concat([state.buf, chunk]);
      for (const { opcode, data } of parseFrames(state)) {
        if (opcode === 0x8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode === 0x9) { socket.write(Buffer.from([0x8a, 0])); continue; }
        if (opcode !== 0x1) continue;
        const msg = JSON.parse(data.toString('utf8'));
        calls.push({ method: msg.method, params: msg.params });
        try {
          const result = await handler(msg.method, msg.params);
          socket.write(frame(JSON.stringify({ type: 'success', id: msg.id, result: result ?? {} })));
        } catch (e) {
          socket.write(frame(JSON.stringify({ type: 'error', id: msg.id, error: e.error || 'unknown error', message: e.message || '' })));
        }
      }
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    calls,
    methods: () => calls.map(c => c.method),
    close: () => new Promise(r => { for (const s of sockets) s.destroy(); server.close(r); }),
  };
}

/** A page-function reply as script.callFunction returns it. */
export const pageResult = value => ({ type: 'success', realm: 'r', result: { type: 'string', value: JSON.stringify(value) } });
