// Pixel-art residents shared by the 3D world, the 2D fallback and the HTML avatars.
// Every resident gets a stable look from their id: skin, hair, build and sector gear.
export const CELL_W = 34;
export const CELL_H = 50;
export const FRAMES = 5; // 0-3 walk cycle, 4 standing

const SKIN = ['#f1c9a1', '#dcaa7f', '#bd8459', '#91603e', '#62402a'];
const HAIR = ['#241a13', '#45301f', '#71502f', '#a8834f', '#c9c3b2', '#7a321e', '#141110'];
const SAFE_COLOR = /^#[0-9a-f]{6}$/i;

export function hashString(text) {
  let h = 2166136261;
  for (const ch of String(text)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function shade(hex, delta) {
  const parts = [1, 3, 5].map(i => Math.max(0, Math.min(255, parseInt(hex.slice(i, i + 2), 16) + delta)));
  return '#' + parts.map(v => v.toString(16).padStart(2, '0')).join('');
}

export function appearanceFor(agent = {}) {
  const h = hashString(agent.id || agent.name || 'resident');
  const color = SAFE_COLOR.test(agent.color || '') ? agent.color.toLowerCase() : '#b6a17c';
  const sector = Math.max(0, Math.min(5, Number(agent.floor) || 0));
  const look = { color, sector, skin: SKIN[h % SKIN.length], hair: HAIR[(h >>> 3) % HAIR.length], style: (h >>> 6) % 6, build: (h >>> 9) % 2 };
  look.key = [look.color, look.sector, look.skin, look.hair, look.style, look.build].join('|');
  return look;
}

// Draws one resident facing right inside a 32x48 box whose origin is (ox, oy).
function drawBody(c, look, frame, ox, oy) {
  const r = (x, y, w, h, col) => { c.fillStyle = col; c.fillRect(ox + x, oy + y, w, h); };
  const cloth = look.color, light = shade(cloth, 24), dark = shade(cloth, -32), deep = shade(cloth, -58);
  const skin = look.skin, skinDark = shade(skin, -30), hair = look.hair;
  const walking = frame < 4;
  const stride = walking ? [3, 0, -3, 0][frame] : 0;
  const liftBack = frame === 1 ? 1 : 0, liftFront = frame === 3 ? 1 : 0;
  const wide = look.build;
  const boot = '#211b15', bootTop = '#4a3c2c';

  // Back arm and back leg sit behind the torso.
  const backArm = 13 + Math.round(stride * 0.6);
  r(backArm, 16, 3, 10, deep); r(backArm, 26, 3, 2, skinDark);
  const backLeg = 14 - stride;
  r(backLeg, 29, 4, 14 - liftBack, deep); r(backLeg, 36 - liftBack, 4, 1, shade(cloth, -70));
  r(backLeg, 43 - liftBack, 5, 3, boot); r(backLeg + 5, 44 - liftBack, 1, 2, boot);

  // Front leg.
  const frontLeg = 15 + stride;
  r(frontLeg, 29, 4, 14 - liftFront, dark); r(frontLeg + 3, 30, 1, 12 - liftFront, cloth);
  r(frontLeg, 36 - liftFront, 4, 1, deep);
  r(frontLeg, 43 - liftFront, 5, 3, boot); r(frontLeg + 5, 44 - liftFront, 1, 2, boot); r(frontLeg, 43 - liftFront, 4, 1, bootTop);

  // Torso: a work coverall with collar, zip, pocket and belt.
  r(12 - wide, 15, 10 + wide, 14, cloth);
  r(12 - wide, 16, 2, 12, dark); r(19, 16, 2, 12, light);
  r(15, 15, 4, 2, light); r(17, 17, 1, 10, dark); r(18, 19, 2, 2, dark);
  r(12 - wide, 27, 10 + wide, 2, '#2b2a20'); r(19, 27, 2, 2, '#bf9f55');

  // Neck and head.
  r(15, 13, 3, 2, skinDark);
  r(13, 5, 7, 8, skin); r(20, 8, 1, 2, skin); r(14, 12, 5, 1, skinDark); r(14, 8, 1, 2, skinDark);
  r(18, 8, 1, 1, '#17130f'); r(18, 11, 2, 1, shade(skin, -45));
  switch (look.style) {
    case 0: r(12, 3, 8, 3, hair); r(12, 5, 2, 4, hair); r(19, 4, 1, 1, hair); break;
    case 1: r(13, 4, 7, 2, hair); r(13, 5, 1, 3, hair); break;
    case 2: r(12, 3, 8, 3, hair); r(11, 5, 3, 10, hair); r(19, 4, 1, 2, hair); break;
    case 3: r(12, 3, 8, 3, hair); r(9, 5, 3, 3, hair); r(12, 5, 2, 4, hair); break;
    case 4: r(13, 4, 7, 1, skinDark); r(15, 11, 5, 2, hair); r(19, 10, 1, 1, hair); r(13, 5, 1, 3, hair); break;
    default: r(11, 2, 10, 4, hair); r(11, 5, 3, 6, hair); r(12, 1, 6, 1, hair); r(20, 4, 1, 2, hair);
  }

  // Front arm swings against the front leg.
  const frontArm = 16 - Math.round(stride * 0.7);
  r(frontArm, 16, 3, 10, dark); r(frontArm + 2, 17, 1, 8, cloth); r(frontArm, 26, 3, 2, skin);

  // Sector gear.
  switch (look.sector) {
    case 0: r(17, 16, 1, 6, '#6e2a22'); r(19, 19, 2, 2, '#e3c169'); break; // tie and badge
    case 1: r(17, 8, 4, 1, '#1b1c19'); r(17, 7, 1, 1, '#1b1c19'); r(12, 5, 1, 6, '#25261f'); r(19, 11, 2, 1, '#25261f'); break; // glasses, headset
    case 2: r(14, 14, 7, 3, '#8d3c2e'); r(14, 17, 2, 4, '#8d3c2e'); r(15, 14, 2, 1, '#b2563f'); break; // scarf
    case 3: r(12, 2, 9, 3, '#d9a92a'); r(12, 5, 10, 1, '#a97d17'); r(13, 3, 7, 1, '#f2cc52'); r(11, 28, 3, 3, '#5a4630'); break; // hard hat, tool pouch
    case 4: r(12, 3, 8, 2, '#56693a'); r(19, 5, 4, 1, '#3f5029'); for (let k = 0; k < 4; k++) r(13 + k * 2, 16 + k * 2, 2, 2, '#6b5233'); r(10, 24, 3, 4, '#6b5233'); break; // cap, satchel
    default: r(13, 5, 8, 1, '#2a2a26'); r(17, 5, 2, 1, '#86a3a8'); r(19, 5, 2, 1, '#86a3a8'); r(19, 22, 2, 1, deep); r(frontArm + 1, 27, 1, 5, '#8f9496'); r(frontArm, 31, 3, 1, '#8f9496'); // goggles, wrench
  }
}

// Adds a one pixel dark outline so residents read clearly against busy backgrounds.
function outline(c, w, h) {
  const img = c.getImageData(0, 0, w, h), d = img.data, src = new Uint8ClampedArray(d);
  const solid = (x, y) => x >= 0 && y >= 0 && x < w && y < h && src[(y * w + x) * 4 + 3] > 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (src[i + 3] === 0 && (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1))) { d[i] = 14; d[i + 1] = 18; d[i + 2] = 13; d[i + 3] = 255; }
  }
  c.putImageData(img, 0, 0);
}

// Paints one resident's strip onto any 2D context, so the atlas worker can use it with an OffscreenCanvas.
export function paintAtlas(c, look) {
  for (let f = 0; f < FRAMES; f++) drawBody(c, look, f, f * CELL_W + 1, 1);
  outline(c, CELL_W * FRAMES, CELL_H);
}

const atlasCache = new Map(), pendingAtlas = new Map();
// A horizontal strip of FRAMES cells, each CELL_W x CELL_H, facing right.
export function residentAtlas(look) {
  if (atlasCache.has(look.key)) return atlasCache.get(look.key);
  // A strip still waiting for the worker is painted here and now, on the canvas the world already holds.
  const canvas = pendingAtlas.get(look.key) || document.createElement('canvas');
  pendingAtlas.delete(look.key);
  canvas.width = CELL_W * FRAMES; canvas.height = CELL_H;
  paintAtlas(canvas.getContext('2d'), look);
  atlasCache.set(look.key, canvas);
  return canvas;
}
// An empty canvas of the right size that the worker fills in later. ready is true when the strip already exists.
export function reserveAtlas(look) {
  if (atlasCache.has(look.key)) return { canvas: atlasCache.get(look.key), ready: true };
  let canvas = pendingAtlas.get(look.key);
  if (!canvas) { canvas = document.createElement('canvas'); canvas.width = CELL_W * FRAMES; canvas.height = CELL_H; pendingAtlas.set(look.key, canvas); }
  return { canvas, ready: false };
}
// Copies a strip the worker painted onto the reserved canvas. False when it was already painted another way.
export function fillAtlas(key, bitmap) {
  const canvas = pendingAtlas.get(key);
  if (!canvas) return false;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  pendingAtlas.delete(key); atlasCache.set(key, canvas);
  return true;
}
export const atlasPending = key => pendingAtlas.has(key);

const avatarCache = new Map();
export function avatarDataUrl(agent) {
  const look = appearanceFor(agent);
  if (avatarCache.has(look.key)) return avatarCache.get(look.key);
  const canvas = document.createElement('canvas');
  canvas.width = CELL_W; canvas.height = CELL_H;
  canvas.getContext('2d').drawImage(residentAtlas(look), (FRAMES - 1) * CELL_W, 0, CELL_W, CELL_H, 0, 0, CELL_W, CELL_H);
  const url = canvas.toDataURL('image/png');
  avatarCache.set(look.key, url);
  return url;
}
