import { useState, useEffect, useRef, useCallback } from "react";

/* ─────────────────────────────────────────────────────────────────────────────
   PROTOCOL  (ry5088 — extracted from github.com/dot-agi/ry5088-flasher)
───────────────────────────────────────────────────────────────────────────── */
const VID = 0x3151, PID = 0x5030, USAGE_PAGE = 0xFFFF, DEV_ID = 2307;
const RL  = 64; // report length

// Sub-command IDs verified against github.com/echtzeit-solutions/monsgeek-akko-linux
// (hardware-read-verified + gRPC server built for official-app interop — more
// authoritative than the dot-agi repo for these specific byte values).
const MAG = {
  PRESS: 0x00, LIFT: 0x01, RT_PRESS: 0x02, RT_LIFT: 0x03,
  DKS_TRAVEL: 0x04, MODTAP_TIME: 0x05, BOTTOM_DZ: 0x06,
  MODE: 0x07, SNAPTAP_EN: 0x09, DKS_MODES: 0x0A,
  TOP_DZ: 0xFB, // firmware >= v10.24 only
};
// KEY_MODE (sub 0x07) byte values from the MonsGeek/Akko protocol docs.
// Rapid Trigger is mode 1, DKS is 2, Mod-Tap is 3, Toggle is 4, Snap-Tap is 5.
const MODE = { NORMAL: 0, RAPID_TRIGGER: 1, DKS: 2, MODTAP: 3, TOGGLE_HOLD: 4, TOGGLE_DOTS: 4, SNAPTAP: 5 };
const RT_BIT = MODE.RAPID_TRIGGER;
const POLL = { 8000: 0x00, 4000: 0x01, 2000: 0x02, 1000: 0x03, 500: 0x04, 250: 0x05, 125: 0x07 };
const POLL_HZ = { 0x00: 8000, 0x01: 4000, 0x02: 2000, 0x03: 1000, 0x04: 500, 0x05: 250, 0x07: 125 };
// LED mode IDs from the MonsGeek/Akko RY5088 protocol docs / linux driver.
// Keep the labels tied to the raw numeric mode code so the UI does not call
// mode 0x03 "Wave" when the keyboard actually treats it as Neon, etc.
const LED_MODES = {
  0x00: "Off",
  0x01: "Constant",
  0x02: "Breathing",
  0x03: "Neon",
  0x04: "Wave",
  0x05: "Ripple",
  0x06: "Raindrop",
  0x07: "Snake",
  0x08: "Reactive",
  0x09: "Converge",
  0x0A: "Sine Wave",
  0x0B: "Kaleidoscope",
  0x0C: "Line Wave",
  0x0D: "User Picture",
  0x0E: "Laser",
  0x0F: "Circle Wave",
  0x10: "Rainbow",
  0x11: "Rain Down",
  0x12: "Meteor",
  0x13: "Reactive Off",
  0x14: "Music Patterns",
  0x15: "Screen Sync",
  0x16: "Music Bars",
  0x17: "Train",
};

const mm  = v => Math.round(v * 100); // mm → centi-mm (wire units)
const cmm = v => v / 100;             // centi-mm → mm (display)

function bit7(r) {
  let s = 0; for (let i = 0; i < 7; i++) s = (s + r[i]) & 0xFF;
  r[7] = (0xFF - s) & 0xFF; return r;
}
function bit8(r) {
  let s = 0; for (let i = 0; i < 8; i++) s = (s + r[i]) & 0xFF;
  r[8] = (0xFF - s) & 0xFF; return r;
}
function pkt(op, args = []) {
  const r = new Uint8Array(RL); r[0] = op;
  args.forEach((v, i) => { r[i + 1] = v; });
  return bit7(r);
}

const CMD = {
  getInfor:    ()                         => pkt(0x8F),
  getProfile:  ()                         => pkt(0x84),
  setProfile:  p                          => pkt(0x04, [p & 0x03]),
  getPolling:  ()                         => pkt(0x83),
  setPolling:  code                       => pkt(0x03, [0, code]),
  getLedOn:    ()                         => pkt(0x85),
  // Hardware-observed polarity: the bit is a "disable" flag, not "enable" —
  // 0 = LED on, 1 = LED off. (Confirmed backwards from the natural reading;
  // toggling "off" in the UI was turning the keyboard's LEDs on and vice
  // versa before this fix.)
  setLedOn:    on                         => pkt(0x05, [on ? 0 : 1]),
  getLedParam: ()                         => pkt(0x87),
  setLedParam: (mode, spd, bri, r, g, b)  => {
    const p = new Uint8Array(RL);
    p[0]=0x07; p[1]=mode; p[2]=spd; p[3]=bri; p[4]=0; p[5]=r; p[6]=g; p[7]=b;
    return bit8(p);
  },
  // Enable/disable live magnetic key depth input events.
  // Emits input report 0x05 event 0x1B: [0x1B, lo, hi, keyIdx].
  setMagnetismReport: on => pkt(0x1B, [on ? 1 : 0]),
  // Magnetism — single key. valueCmm in centi-mm (200 = 2.00 mm)
  setMag: (sub, keyIdx, valueCmm) => {
    const r = new Uint8Array(RL);
    r[0]=0x65; r[1]=sub; r[2]=0x00; r[3]=keyIdx;
    r[8]=valueCmm & 0xFF; r[9]=(valueCmm >> 8) & 0xFF;
    return bit7(r);
  },
  // Magnetism — read (32 u16 LE per page for subs 0-3; 64 u8 per page for sub 7)
  getMag: (sub, page) => {
    const r = new Uint8Array(RL); r[0]=0xE5; r[1]=sub; r[4]=page; return bit7(r);
  },
  // Magnetism — bulk set (up to 28 u16 per chunk, page = chunk index)
  setMagBulk: (sub, page, values) => {
    const r = new Uint8Array(RL);
    r[0]=0x65; r[1]=sub; r[2]=0x01; r[3]=page;
    values.slice(0, 28).forEach((v, i) => { r[8+i*2]=v&0xFF; r[9+i*2]=(v>>8)&0xFF; });
    return bit7(r);
  },
  // Set mode for ALL keys at once (0x1D)
  setGlobalMode: mode => pkt(0x1D, [mode]),
  // Fn layers use the same safe chunked layout documented for SET_KEYMATRIX / SET_FN:
  // [0] cmd, [1] layer_id, [2] chunk_index, [8..63] payload.
  getFn: (layer = 1, chunk = 0) => {
    const r = new Uint8Array(RL); r[0]=0x90; r[1]=layer & 0x05; r[2]=chunk & 0x0F; return bit7(r);
  },
  setFnChunk: (layer = 1, chunk = 0, payload = []) => {
    const r = new Uint8Array(RL); r[0]=0x10; r[1]=layer & 0x05; r[2]=chunk & 0x0F;
    Array.from(payload).slice(0, 56).forEach((v, i) => { r[8+i] = v & 0xFF; });
    return bit7(r);
  },
};

function parseInfor(r) {
  if (!r || r.length < 9 || r[0] !== 0x8F) return null;
  return { devId: r[1] | (r[2] << 8), version: `v${r[8]}.${String(r[7]).padStart(2,"0")}` };
}
function parseMagPage(r, sub) {
  // GET_MULTI_MAG response is RAW — no opcode echo
  const out = [];
  if (sub === MAG.MODE || sub === MAG.SNAPTAP_EN) { for (let i = 0; i < 64; i++) out.push(r[i]); }
  else { for (let i = 0; i < 32; i++) out.push(r[i*2] | (r[i*2+1] << 8)); }
  return out;
}

function extractPollingCode(r) {
  if (!r) return null;
  const validCodes = new Set(Object.values(POLL));
  if (validCodes.has(r[2])) return r[2];
  if (validCodes.has(r[1])) return r[1];
  return null;
}
function formatHz(hz) {
  return hz >= 1000 ? `${hz / 1000}K` : `${hz}`;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));


// Exact live magnetic telemetry parser from monsgeek-akko-linux docs.
// Raw HID frame: 05 1B lo hi idx
// WebHID exposes reportId separately, so event.data is: [1B, lo, hi, idx, ...]
function parseTelemetryDepth(reportId, data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data.buffer || data);
  if (reportId !== 0x05 || bytes.length < 4 || bytes[0] !== 0x1B) return null;

  const raw = bytes[1] | (bytes[2] << 8);
  const idx = bytes[3];

  // Docs describe magnetic values with a precision factor, commonly raw/10
  // (20 -> 2.0 mm). Some configs elsewhere use centi-mm, so keep a safe
  // fallback if /10 would be impossible for a 4 mm switch.
  let scale = 10;
  let mmTravel = raw / scale;
  if (mmTravel > 4.5 && raw / 100 <= 4.5) {
    scale = 100;
    mmTravel = raw / scale;
  }

  const key = ALL_KEYS.find(k => k.magIdx === idx);
  if (!key) return { idx, raw, mm: mmTravel, normalized: 0, format: `0x05/0x1B raw/${scale}` };

  const normalized = Math.max(0, Math.min(1, mmTravel / 4.0));
  return {
    idx, raw, mm: mmTravel, normalized, keyId: key.id,
    depths: normalized > 0.01 ? { [key.id]: normalized } : {},
    format: `0x05/0x1B raw/${scale}`,
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
   KEY LAYOUT  (60 % ANSI — mag indices from 2307.toml: site = col*6 + row)
   Sites 64+ share mag[63] by firmware design (MG_NUM_MAG_KEYS = 64).
───────────────────────────────────────────────────────────────────────────── */
const U = 40, G = 3;
const kw = u => Math.round(u * U + (u - 1) * G);

// magIdx: firmware magnetism array index (-1 = shared / unknown)
// shared: true when key shares mag[63] with other rightmost keys
const ROWS = [
  [
    {id:"esc",l:"Esc",u:1,magIdx:1},  {id:"k1",l:"1",u:1,magIdx:7},
    {id:"k2",l:"2",u:1,magIdx:13},    {id:"k3",l:"3",u:1,magIdx:19},
    {id:"k4",l:"4",u:1,magIdx:25},    {id:"k5",l:"5",u:1,magIdx:31},
    {id:"k6",l:"6",u:1,magIdx:37},    {id:"k7",l:"7",u:1,magIdx:43},
    {id:"k8",l:"8",u:1,magIdx:49},    {id:"k9",l:"9",u:1,magIdx:55},
    {id:"k0",l:"0",u:1,magIdx:61},    {id:"minus",l:"–",u:1,magIdx:63,shared:true},
    {id:"equal",l:"=",u:1,magIdx:63,shared:true},
    {id:"bksp",l:"⌫",u:2,magIdx:63,shared:true},
  ],[
    {id:"tab",l:"Tab",u:1.5,magIdx:2},  {id:"q",l:"Q",u:1,magIdx:8},
    {id:"w",l:"W",u:1,magIdx:14},        {id:"e",l:"E",u:1,magIdx:20},
    {id:"r",l:"R",u:1,magIdx:26},        {id:"t",l:"T",u:1,magIdx:32},
    {id:"y",l:"Y",u:1,magIdx:38},        {id:"u",l:"U",u:1,magIdx:44},
    {id:"i",l:"I",u:1,magIdx:50},        {id:"o",l:"O",u:1,magIdx:56},
    {id:"p",l:"P",u:1,magIdx:62},        {id:"lbr",l:"[",u:1,magIdx:63,shared:true},
    {id:"rbr",l:"]",u:1,magIdx:63,shared:true},
    {id:"bsl",l:"\\",u:1.5,magIdx:63,shared:true},
  ],[
    {id:"caps",l:"Caps",u:1.75,magIdx:3},{id:"a",l:"A",u:1,magIdx:9},
    {id:"s",l:"S",u:1,magIdx:15},        {id:"d",l:"D",u:1,magIdx:21},
    {id:"f",l:"F",u:1,magIdx:27},        {id:"g",l:"G",u:1,magIdx:33},
    {id:"h",l:"H",u:1,magIdx:39},        {id:"j",l:"J",u:1,magIdx:45},
    {id:"k",l:"K",u:1,magIdx:51},        {id:"l",l:"L",u:1,magIdx:57},
    {id:"semi",l:";",u:1,magIdx:63},     {id:"apos",l:"'",u:1,magIdx:63,shared:true},
    {id:"ent",l:"Enter",u:2.25,magIdx:63,shared:true},
  ],[
    {id:"lsh",l:"Shift",u:2.25,magIdx:4},{id:"z",l:"Z",u:1,magIdx:16},
    {id:"x",l:"X",u:1,magIdx:22},        {id:"c",l:"C",u:1,magIdx:28},
    {id:"v",l:"V",u:1,magIdx:34},        {id:"b",l:"B",u:1,magIdx:40},
    {id:"n",l:"N",u:1,magIdx:46},        {id:"m",l:"M",u:1,magIdx:52},
    {id:"com",l:",",u:1,magIdx:58},      {id:"dot",l:".",u:1,magIdx:63,shared:true},
    {id:"fsl",l:"/",u:1,magIdx:63,shared:true},
    {id:"rsh",l:"Shift",u:2.75,magIdx:63,shared:true},
  ],[
    {id:"lctl",l:"Ctrl",u:1.25,magIdx:5},{id:"lwin",l:"⊞",u:1.25,magIdx:23},
    {id:"lalt",l:"Alt",u:1.25,magIdx:17},{id:"spc",l:"",u:6.25,magIdx:41},
    {id:"ralt",l:"Alt",u:1.25,magIdx:63,shared:true},
    {id:"menu",l:"Menu",u:1.25,magIdx:63,shared:true},
    {id:"rctl",l:"Ctrl",u:1.25,magIdx:63,shared:true},
  ],
];
const ALL_KEYS = ROWS.flat();
const KEY_CODE_TO_ID = {
  Escape:"esc", Digit1:"k1", Digit2:"k2", Digit3:"k3", Digit4:"k4", Digit5:"k5",
  Digit6:"k6", Digit7:"k7", Digit8:"k8", Digit9:"k9", Digit0:"k0",
  Minus:"minus", Equal:"equal", Backspace:"bksp",
  Tab:"tab", KeyQ:"q", KeyW:"w", KeyE:"e", KeyR:"r", KeyT:"t", KeyY:"y",
  KeyU:"u", KeyI:"i", KeyO:"o", KeyP:"p", BracketLeft:"lbr",
  BracketRight:"rbr", Backslash:"bsl",
  CapsLock:"caps", KeyA:"a", KeyS:"s", KeyD:"d", KeyF:"f", KeyG:"g",
  KeyH:"h", KeyJ:"j", KeyK:"k", KeyL:"l", Semicolon:"semi",
  Quote:"apos", Enter:"ent",
  ShiftLeft:"lsh", KeyZ:"z", KeyX:"x", KeyC:"c", KeyV:"v", KeyB:"b",
  KeyN:"n", KeyM:"m", Comma:"com", Period:"dot", Slash:"fsl",
  ShiftRight:"rsh",
  ControlLeft:"lctl", MetaLeft:"lwin", AltLeft:"lalt", Space:"spc",
  AltRight:"ralt", ContextMenu:"menu", ControlRight:"rctl",
};



// USB HID keyboard usages for the first real Fn-layer pass.
// The stock firmware stores keymaps/Fn layers in chunked 56-byte payloads using
// SET_FN (0x10) / GET_FN (0x90). We keep the UI map as keyId -> action, then
// serialize into matrix/mag order when writing.
const HID = {
  NONE: 0x00, A:0x04, B:0x05, C:0x06, D:0x07, E:0x08, F:0x09, G:0x0A, H:0x0B,
  I:0x0C, J:0x0D, K:0x0E, L:0x0F, M:0x10, N:0x11, O:0x12, P:0x13, Q:0x14,
  R:0x15, S:0x16, T:0x17, U:0x18, V:0x19, W:0x1A, X:0x1B, Y:0x1C, Z:0x1D,
  N1:0x1E, N2:0x1F, N3:0x20, N4:0x21, N5:0x22, N6:0x23, N7:0x24, N8:0x25,
  N9:0x26, N0:0x27, ENTER:0x28, ESC:0x29, BSPC:0x2A, TAB:0x2B, SPACE:0x2C,
  MINUS:0x2D, EQUAL:0x2E, LBR:0x2F, RBR:0x30, BSL:0x31, SEMI:0x33, APOS:0x34,
  GRAVE:0x35, COMMA:0x36, DOT:0x37, SLASH:0x38, CAPS:0x39,
  F1:0x3A, F2:0x3B, F3:0x3C, F4:0x3D, F5:0x3E, F6:0x3F, F7:0x40, F8:0x41,
  F9:0x42, F10:0x43, F11:0x44, F12:0x45, PRTSC:0x46, INS:0x49, HOME:0x4A,
  PGUP:0x4B, DEL:0x4C, END:0x4D, PGDN:0x4E, RIGHT:0x4F, LEFT:0x50, DOWN:0x51,
  UP:0x52, LCTRL:0xE0, LSHIFT:0xE1, LALT:0xE2, LGUI:0xE3, RCTRL:0xE4, RSHIFT:0xE5,
  RALT:0xE6, RGUI:0xE7,
};
const HID_LABEL = Object.fromEntries(Object.entries(HID).map(([name, code]) => [code, name.replace(/^N(\d)$/,'$1')]));
const FN_SPECIAL = {
  LOCK: 0xF1, FN1: 0xF2, CYCLE: 0xF3,
  MEDIA_PREV: 0xF4, MEDIA_PLAY: 0xF5, MEDIA_NEXT: 0xF6,
  VOL_MUTE: 0xF7, VOL_DOWN: 0xF8, VOL_UP: 0xF9,
  RGB_DEC: 0xFA, RGB_INC: 0xFB, P1: 0xFC, P2: 0xFD, P3: 0xFE, P4: 0xFF,
};
const FN_SPECIAL_LABEL = {
  [FN_SPECIAL.LOCK]: 'Key Lock', [FN_SPECIAL.FN1]: 'Fn 1', [FN_SPECIAL.CYCLE]: 'Cycle',
  [FN_SPECIAL.MEDIA_PREV]: '◀◀', [FN_SPECIAL.MEDIA_PLAY]: '▶Ⅱ', [FN_SPECIAL.MEDIA_NEXT]: '▶▶',
  [FN_SPECIAL.VOL_MUTE]: '🔇', [FN_SPECIAL.VOL_DOWN]: 'Vol −', [FN_SPECIAL.VOL_UP]: 'Vol +',
  [FN_SPECIAL.RGB_DEC]: 'RGB −', [FN_SPECIAL.RGB_INC]: 'RGB +',
  [FN_SPECIAL.P1]: 'P1', [FN_SPECIAL.P2]: 'P2', [FN_SPECIAL.P3]: 'P3', [FN_SPECIAL.P4]: 'P4',
};
const DEFAULT_FN1 = {
  esc:{code:HID.GRAVE,label:'`'}, k1:{code:HID.F1,label:'F1'}, k2:{code:HID.F2,label:'F2'}, k3:{code:HID.F3,label:'F3'},
  k4:{code:HID.F4,label:'F4'}, k5:{code:HID.F5,label:'F5'}, k6:{code:HID.F6,label:'F6'}, k7:{code:HID.F7,label:'F7'},
  k8:{code:HID.F8,label:'F8'}, k9:{code:HID.F9,label:'F9'}, k0:{code:HID.F10,label:'F10'}, minus:{code:HID.F11,label:'F11'},
  equal:{code:HID.F12,label:'F12'}, bksp:{code:HID.DEL,label:'Del'},
  tab:{code:HID.PRTSC,label:'Prt Sc'}, q:{code:HID.HOME,label:'Home'}, w:{code:HID.UP,label:'↑'}, e:{code:HID.END,label:'End'},
  r:{code:HID.PGUP,label:'Pg Up'}, i:{code:HID.INS,label:'Ins'}, o:{code:FN_SPECIAL.P1,label:'P1'}, p:{code:FN_SPECIAL.P2,label:'P2'},
  lbr:{code:FN_SPECIAL.P3,label:'P3'}, rbr:{code:FN_SPECIAL.P4,label:'P4'},
  a:{code:HID.LEFT,label:'←'}, s:{code:HID.DOWN,label:'↓'}, d:{code:HID.RIGHT,label:'→'}, f:{code:HID.PGDN,label:'Pg Dn'},
  h:{code:FN_SPECIAL.MEDIA_PREV,label:'◀◀'}, j:{code:FN_SPECIAL.MEDIA_PLAY,label:'▶Ⅱ'}, k:{code:FN_SPECIAL.MEDIA_NEXT,label:'▶▶'},
  l:{code:FN_SPECIAL.RGB_DEC,label:'RGB −'}, semi:{code:FN_SPECIAL.RGB_INC,label:'RGB +'}, ent:{code:FN_SPECIAL.CYCLE,label:'Cycle'},
  lsh:{code:HID.LSHIFT,label:'L-Shift'}, n:{code:FN_SPECIAL.VOL_MUTE,label:'🔇'}, m:{code:FN_SPECIAL.VOL_DOWN,label:'Vol −'},
  com:{code:FN_SPECIAL.VOL_UP,label:'Vol +'}, dot:{code:HID.UP,label:'↑'}, rsh:{code:HID.RSHIFT,label:'R-Shift'},
  lctl:{code:HID.LCTRL,label:'L-Ctrl'}, lwin:{code:FN_SPECIAL.LOCK,label:'Key Lock'}, lalt:{code:HID.LALT,label:'L-Alt'},
  spc:{code:HID.SPACE,label:'Spacebar'}, ralt:{code:HID.LEFT,label:'←'}, menu:{code:HID.DOWN,label:'↓'}, rctl:{code:HID.RIGHT,label:'→'},
};
const FN_ACTIONS = [
  {group:'Navigation', items:[['None',HID.NONE],['Esc',HID.ESC],['`',HID.GRAVE],['Del',HID.DEL],['Ins',HID.INS],['Home',HID.HOME],['End',HID.END],['Pg Up',HID.PGUP],['Pg Dn',HID.PGDN],['↑',HID.UP],['↓',HID.DOWN],['←',HID.LEFT],['→',HID.RIGHT]]},
  {group:'Function', items:[['F1',HID.F1],['F2',HID.F2],['F3',HID.F3],['F4',HID.F4],['F5',HID.F5],['F6',HID.F6],['F7',HID.F7],['F8',HID.F8],['F9',HID.F9],['F10',HID.F10],['F11',HID.F11],['F12',HID.F12]]},
  {group:'Media / Profile', items:[['Prt Sc',HID.PRTSC],['Prev',FN_SPECIAL.MEDIA_PREV],['Play',FN_SPECIAL.MEDIA_PLAY],['Next',FN_SPECIAL.MEDIA_NEXT],['Mute',FN_SPECIAL.VOL_MUTE],['Vol −',FN_SPECIAL.VOL_DOWN],['Vol +',FN_SPECIAL.VOL_UP],['P1',FN_SPECIAL.P1],['P2',FN_SPECIAL.P2],['P3',FN_SPECIAL.P3],['P4',FN_SPECIAL.P4],['Cycle',FN_SPECIAL.CYCLE],['Fn 1',FN_SPECIAL.FN1],['Key Lock',FN_SPECIAL.LOCK]]},
];
function fnLabelFromCode(code) { return FN_SPECIAL_LABEL[code] || HID_LABEL[code] || (code ? `0x${code.toString(16).padStart(2,'0')}` : ''); }
function cloneFnLayer(layer) { return Object.fromEntries(Object.entries(layer).map(([k,v]) => [k, {...v}])); }
function fnLayerToBytes(layer) {
  const out = new Uint8Array(ALL_KEYS.length);
  ALL_KEYS.forEach((key, i) => { out[i] = layer[key.id]?.code ?? 0; });
  return out;
}
function bytesToFnLayer(bytes) {
  const next = {};
  ALL_KEYS.forEach((key, i) => {
    const code = bytes?.[i] ?? 0;
    if (code) next[key.id] = { code, label: fnLabelFromCode(code) };
  });
  return next;
}

/* ─────────────────────────────────────────────────────────────────────────────
   DESIGN TOKENS  (extracted from Wootility 5.3.1 source)
───────────────────────────────────────────────────────────────────────────── */
const THEMES = {
  dark: {
    bg: "#181a1b", surf: "#222426", over: "#2b2e31",
    nav: "#111213", panel: "#1a1c1d", track: "#3a3f44",
    bord: "#34383c", bordHv: "#4a5058", kbBody: "#111213", kbBord: "#2a2d30",
    key: "#FFD45C", keyHv: "#ffe07a", keyTxt: "#1a1200",
    keySel: "#5B51FF", keySlH: "#7168ff",
    txt: "#e8ebed", sub: "#ccd1d6", muted: "#7C848D",
    accent: "#FFD45C", atxt: "#1a1200", activeBg: "rgba(255,212,92,.08)",
    disabledBg: "#3a3a2a", disabledTxt: "#6a6a4a",
    shadow: "0 8px 32px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.04)",
    keyRestShadow: "0 2px 0 rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.15)",
    keyDepthShadow: d => `inset 0 ${Math.round(d*5)}px 4px rgba(0,0,0,.3),0 0 0 1px rgba(0,0,0,.2)`,
    keyDepthBg: d => `hsl(${48-d*30},${90-d*20}%,${78-d*28}%)`,
    keyDepthBar: "rgba(0,0,0,.3)", sharedDot: "rgba(0,0,0,.25)",
    selectedMark: "rgba(255,255,255,.5)", selectedDot: "rgba(255,255,255,.4)",
    selectedTxt: "#fff", selectedSub: "rgba(255,255,255,.7)", depthTxt: "rgba(0,0,0,.45)",
    watermark: "rgba(255,255,255,.06)",
    green: "#4ade80", red: "#EE3F3F", blue: "#38bdf8",
  },
  light: {
    bg: "#f5f4ef", surf: "#ffffff", over: "#f0eee7",
    nav: "#f9f7f0", panel: "#ffffff", track: "#ded9ca",
    bord: "#ded8c9", bordHv: "#c7bea9", kbBody: "#ece6d7", kbBord: "#d8cfbc",
    key: "#fff6d8", keyHv: "#ffefaf", keyTxt: "#35270b",
    keySel: "#4f46e5", keySlH: "#635bff",
    txt: "#201f1b", sub: "#504b42", muted: "#81776a",
    accent: "#d59b00", atxt: "#1d1600", activeBg: "rgba(213,155,0,.12)",
    disabledBg: "#ece6d0", disabledTxt: "#9c8f72",
    shadow: "0 14px 35px rgba(82,68,33,.14), inset 0 1px 0 rgba(255,255,255,.8)",
    keyRestShadow: "0 2px 0 rgba(111,88,28,.22),inset 0 1px 0 rgba(255,255,255,.85)",
    keyDepthShadow: d => `inset 0 ${Math.round(d*5)}px 4px rgba(111,88,28,.22),0 0 0 1px rgba(111,88,28,.14)`,
    keyDepthBg: d => `hsl(${48-d*22},${88-d*12}%,${88-d*20}%)`,
    keyDepthBar: "rgba(87,68,18,.26)", sharedDot: "rgba(87,68,18,.22)",
    selectedMark: "rgba(255,255,255,.55)", selectedDot: "rgba(255,255,255,.45)",
    selectedTxt: "#ffffff", selectedSub: "rgba(255,255,255,.78)", depthTxt: "rgba(68,50,10,.55)",
    watermark: "rgba(71,57,21,.12)",
    green: "#16a34a", red: "#dc2626", blue: "#0284c7",
  },
};
let C = THEMES.dark;
const FONT = "'Nunito Sans','Inter',system-ui,sans-serif";
const MONO = "'JetBrains Mono',monospace";

/* ─────────────────────────────────────────────────────────────────────────────
   useKeyboard HOOK
───────────────────────────────────────────────────────────────────────────── */
function useKeyboard({ onSettings, onTelemetry }) {
  const dev      = useRef(null);
  const liveDev  = useRef(null);
  const debounce = useRef({});
  const [status, setStatus] = useState("idle"); // idle|connecting|connected|error
  const [info,   setInfo]   = useState(null);
  const [err,    setErr]    = useState(null);
  const [telemetry, setTelemetry] = useState("off"); // off|connecting|on|error
  const [telemetryFmt, setTelemetryFmt] = useState(null);
  const hidOK = typeof navigator !== "undefined" && "hid" in navigator;

  const send = useCallback(async report => {
    if (!dev.current) throw new Error("Not connected");
    await dev.current.sendFeatureReport(0, report);
    const r = await dev.current.receiveFeatureReport(0);
    return new Uint8Array(r.buffer);
  }, []);

  // debounced send — key identifies the parameter slot (e.g. "mag-0x00-14")
  const dSend = useCallback((key, report, delay = 250) => {
    clearTimeout(debounce.current[key]);
    debounce.current[key] = setTimeout(() => send(report).catch(console.error), delay);
  }, [send]);

  const readSettings = useCallback(async () => {
    try {
      const settings = {};
      const prof = await send(CMD.getProfile()); settings.profile = prof[1] & 3;
      const poll = await send(CMD.getPolling());
      // Byte position for the rate code wasn't hardware-confirmed — guard
      // against the same kind of offset assumption that broke AP/RT by
      // accepting whichever byte actually matches a known rate code.
      settings.pollingCode = extractPollingCode(poll) ?? poll[2];
      const lon  = await send(CMD.getLedOn());   settings.ledOn = lon[1] !== 1;
      const lp   = await send(CMD.getLedParam());
      settings.ledMode = lp[1]; settings.ledSpeed = lp[2]; settings.ledBri = lp[3];
      settings.ledR = lp[5]; settings.ledG = lp[6]; settings.ledB = lp[7];

      // Magnetism — 2 pages per sub-command. Read every sub-command that the
      // UI can display or edit, including SNAPTAP_EN, so nothing silently
      // falls back to a default after connecting.
      const mag = {};
      for (const sub of [MAG.PRESS, MAG.LIFT, MAG.RT_PRESS, MAG.RT_LIFT, MAG.MODE, MAG.SNAPTAP_EN]) {
        const p0 = await send(CMD.getMag(sub, 0));
        const p1 = await send(CMD.getMag(sub, 1));
        mag[sub] = [...parseMagPage(p0, sub), ...parseMagPage(p1, sub)];
      }
      settings.mag = mag;
      return settings;
    } catch (e) { console.warn("readSettings partial failure:", e); return {}; }
  }, [send]);



  const openTelemetry = useCallback(async () => {
    if (!hidOK || !navigator.hid) return;
    setTelemetry("connecting");
    try {
      let devices = await navigator.hid.getDevices();
      const hasDepthInput = d =>
        d.vendorId === VID && d.productId === PID &&
        d.collections.some(c =>
          c.inputReports?.some(r => r.reportId === 0x05) ||
          (c.usagePage === USAGE_PAGE && c.inputReports?.length > 0)
        );
      let live = devices.find(hasDepthInput);

      // If permission for the live/input collection was not granted yet,
      // request by VID/PID, then pick the collection that exposes input report 0x05.
      if (!live) {
        const matches = await navigator.hid.requestDevice({
          filters: [{ vendorId: VID, productId: PID }]
        });
        live = matches.find(hasDepthInput) || matches.find(d => d.collections.some(c => c.inputReports?.length > 0)) || matches[0];
      }
      if (!live) { setTelemetry("off"); return; }
      if (!live.opened) await live.open();
      liveDev.current = live;

      live.addEventListener("inputreport", event => {
        const parsed = parseTelemetryDepth(event.reportId, new Uint8Array(event.data.buffer));
        if (!parsed) return;
        setTelemetryFmt(parsed.format);
        onTelemetry?.(parsed);
      });
      live.addEventListener("disconnect", () => {
        liveDev.current = null;
        setTelemetry("off");
      });
      setTelemetry("on");
    } catch (e) {
      console.warn("telemetry open failed:", e);
      setTelemetry("error");
    }
  }, [hidOK, onTelemetry]);

  const connect = useCallback(async () => {
    if (!hidOK) return;
    setStatus("connecting"); setErr(null);
    try {
      const matches = await navigator.hid.requestDevice({
        // usage 0x02 is the config/feature-report interface — the keyboard
        // also exposes a usage 0x01 telemetry interface on the same
        // VID/PID/usagePage that has NO feature reports, so without this
        // requestDevice() can hand back the wrong one.
        filters: [{ vendorId: VID, productId: PID, usagePage: USAGE_PAGE, usage: 0x02 }]
      });
      if (!matches.length) { setStatus("idle"); return; }
      // Defensive: explicitly pick whichever match actually declares a
      // Feature report, in case more than one collection still matches.
      const device = matches.find(d =>
        d.collections.some(c => c.featureReports?.length > 0)
      ) || matches[0];
      await device.open();
      dev.current = device;
      const infor = parseInfor(await send(CMD.getInfor()));
      if (!infor || infor.devId !== DEV_ID) {
        await device.close(); dev.current = null;
        throw new Error(`Wrong device (dev_id ${infor?.devId ?? "?"}, expected ${DEV_ID})`);
      }
      setInfo(infor);
      device.addEventListener("disconnect", () => {
        dev.current = null; setStatus("idle"); setInfo(null);
      });
      // Read the FULL hardware state (profile, polling, LED, every per-key
      // magnetism array) and let the caller apply it to UI state BEFORE we
      // flip to "connected" — this is what prevents toggles like RGB from
      // flashing their default value for a frame before snapping to the
      // keyboard's real, already-on state.
      setStatus("reading");
      const s = await readSettings();
      onSettings?.(s);
      // Ask firmware to start emitting live magnetic depth events:
      // input report 0x05, event type 0x1B, payload lo/hi/index.
      try { await send(CMD.setMagnetismReport(true)); }
      catch (e) { console.warn("could not enable magnetism report:", e); }
      setStatus("connected");
      // Attach the live HID input stream so Visual Feedback can use real switch
      // travel instead of demo keydown.
      openTelemetry().catch(console.error);
    } catch (e) { setStatus("error"); setErr(e.message); dev.current = null; }
  }, [hidOK, send, readSettings, onSettings, openTelemetry]);

  const disconnect = useCallback(async () => {
    try { if (dev.current) await send(CMD.setMagnetismReport(false)); } catch {}
    try { await liveDev.current?.close(); } catch {}
    try { await dev.current?.close(); } catch {}
    liveDev.current = null; dev.current = null; setStatus("idle"); setInfo(null); setTelemetry("off");
  }, [send]);

  return { hidOK, status, info, err, telemetry, telemetryFmt, connect, disconnect, send, dSend, openTelemetry, readSettings };
}

/* ─────────────────────────────────────────────────────────────────────────────
   PRIMITIVES
───────────────────────────────────────────────────────────────────────────── */
function Toggle({ on, onChange }) {
  return (
    <div onClick={() => onChange(!on)} style={{
      width:40, height:22, borderRadius:11, cursor:"pointer", flexShrink:0,
      background: on ? C.accent : C.track, position:"relative",
      transition:"background .25s cubic-bezier(.4,0,.2,1)",
      boxShadow: on ? `0 0 8px ${C.accent}55` : "none",
    }}>
      <div style={{
        position:"absolute", top:2, left: on ? 20 : 2,
        width:18, height:18, borderRadius:9,
        background: on ? C.atxt : "#9aa0a6",
        transition:"left .25s cubic-bezier(.34,1.56,.64,1)",
        boxShadow:"0 1px 3px rgba(0,0,0,.5)",
        display:"flex", alignItems:"center", justifyContent:"center",
        fontSize:9, fontWeight:900, color: on ? C.accent : C.track,
      }}>{on ? "✓" : "✕"}</div>
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange, unit="mm", color=C.accent, noLabel, disabled, displayValue, displayText, ticks }) {
  const pct = ((value-min)/(max-min))*100;
  const shownValue = displayValue ?? value;
  const [drag, setDrag] = useState(false);
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:6, opacity: disabled ? .4 : 1 }}>
      {!noLabel && (
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline" }}>
          <span style={{ fontSize:11, color:C.muted, textTransform:"uppercase", letterSpacing:".06em" }}>{label}</span>
          <span style={{ fontFamily:MONO, fontSize:12, color, fontWeight:700, transition:"color .15s" }}>
            {displayText ?? `${Number(shownValue).toFixed(2)}${unit}`}
          </span>
        </div>
      )}
      <div style={{ position:"relative", height:4, borderRadius:2, background:C.track }}>
        {ticks?.map(t => {
          const tp = ((t-min)/(max-min))*100;
          return <div key={t} style={{
            position:"absolute", left:`${tp}%`, top:"50%", transform:"translate(-50%,-50%)",
            width:6, height:6, borderRadius:3, background:C.track,
            border:`1px solid ${tp <= pct ? color : C.bord}`, zIndex:1,
          }}/>;
        })}
        <div style={{ position:"absolute", left:0, width:`${pct}%`, height:"100%", borderRadius:2, background:color, transition: drag?"none":"width .12s ease-out" }}/>
        <div style={{
          position:"absolute", top:"50%", left:`${pct}%`,
          transform:`translate(-50%,-50%) scale(${drag?1.25:1})`, width:14, height:14, borderRadius:7,
          background:C.surf, border:`2.5px solid ${color}`, pointerEvents:"none",
          transition: drag ? "left .03s linear, transform .12s cubic-bezier(.34,1.56,.64,1)" : "left .12s ease-out, transform .12s cubic-bezier(.34,1.56,.64,1)",
          boxShadow: drag ? `0 0 0 5px ${color}22` : "none",
        }}/>
        <input type="range" min={min} max={max} step={step} value={value}
          disabled={disabled}
          onChange={e => onChange(parseFloat(e.target.value))}
          onPointerDown={() => setDrag(true)}
          onPointerUp={() => setDrag(false)}
          style={{ position:"absolute", inset:0, opacity:0, cursor: disabled?"not-allowed":"pointer", width:"100%", margin:0 }}/>
      </div>
    </div>
  );
}

function ChipBadge({ label, color="#FFD45C" }) {
  return (
    <span style={{
      fontSize:9, fontWeight:700, padding:"2px 6px", borderRadius:3,
      background:`${color}18`, color, letterSpacing:".05em",
      textTransform:"uppercase", border:`1px solid ${color}40`,
    }}>{label}</span>
  );
}

function NavItem({ icon, label, active, badge, onClick }) {
  return (
    <button onClick={onClick} style={{
      display:"flex", alignItems:"center", gap:10, width:"100%", padding:"8px 14px",
      background: active ? C.activeBg : "transparent",
      border:"none", borderLeft:`2px solid ${active ? C.accent : "transparent"}`,
      cursor:"pointer", fontFamily:FONT, fontSize:13,
      color: active ? C.txt : C.muted, fontWeight: active ? 600 : 400,
      textAlign:"left", transition:"all .12s",
    }}>
      <span style={{ opacity: active ? 1 : .55, fontSize:14 }}>{icon}</span>
      <span style={{ flex:1 }}>{label}</span>
      {badge && <ChipBadge label={badge} color={C.green}/>}
    </button>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   CONNECTION BANNER
───────────────────────────────────────────────────────────────────────────── */
function ConnectBanner({ hidOK, status, info, err, telemetry, telemetryFmt, onConnect, onDisconnect, onTelemetryConnect }) {
  if (status === "connected") return (
    <div style={{
      display:"flex", alignItems:"center", gap:10,
      padding:"8px 16px", background:"rgba(74,222,128,.06)",
      border:`1px solid rgba(74,222,128,.2)`, borderRadius:7,
    }}>
      <div style={{ width:8, height:8, borderRadius:4, background:C.green, boxShadow:`0 0 6px ${C.green}` }}/>
      <span style={{ fontSize:12, color:C.green, fontWeight:600 }}>Connected</span>
      {info && <span style={{ fontSize:11, color:C.muted, fontFamily:MONO }}>{info.version} · dev_id {info.devId}</span>}
      <span style={{ fontSize:11, color: telemetry === "on" ? C.green : telemetry === "error" ? C.red : C.muted, fontFamily:MONO }}>
        live HID: {telemetry === "on" ? `on · ${telemetryFmt || "auto"}` : telemetry}
      </span>
      {telemetry !== "on" && <button onClick={onTelemetryConnect} style={{
        marginLeft:"auto", padding:"3px 10px", border:`1px solid ${C.bord}`,
        borderRadius:4, background:"transparent", color:C.muted,
        fontSize:10, cursor:"pointer", fontFamily:FONT,
      }}>Enable live HID</button>}
      <button onClick={onDisconnect} style={{
        marginLeft:"auto", padding:"3px 10px", border:`1px solid ${C.bord}`,
        borderRadius:4, background:"transparent", color:C.muted,
        fontSize:10, cursor:"pointer", fontFamily:FONT,
      }}>Disconnect</button>
    </div>
  );

  if (!hidOK) return (
    <div style={{
      padding:"10px 14px", background:"rgba(238,63,63,.06)",
      border:`1px solid rgba(238,63,63,.2)`, borderRadius:7,
      fontSize:12, color:C.red,
    }}>
      WebHID not available in this context. Open this page in Chrome / Edge, or run locally.
    </div>
  );

  return (
    <div style={{
      display:"flex", alignItems:"center", gap:12,
      padding:"8px 14px", background:C.surf,
      border:`1px solid ${C.bord}`, borderRadius:7,
      transition:"background .2s",
    }}>
      <div style={{ width:8, height:8, borderRadius:4, background: (status==="connecting"||status==="reading") ? C.accent : C.muted,
        animation: (status==="connecting"||status==="reading") ? "pulse 1s infinite" : "none" }}/>
      <span style={{ fontSize:12, color: err ? C.red : C.muted }}>
        {status==="connecting" ? "Connecting…" : status==="reading" ? "Reading settings from keyboard…" : err ? `Error: ${err}` : "No keyboard connected"}
      </span>
      <span style={{ fontSize:11, color:C.muted }}>
        {!err && status==="idle" && "Settings shown are defaults until connected."}
      </span>
      <button onClick={onConnect} disabled={status==="connecting"||status==="reading"} style={{
        marginLeft:"auto", display:"flex", alignItems:"center", gap:6,
        padding:"6px 14px", borderRadius:4,
        background: C.accent, border:"none", color:C.atxt,
        fontSize:12, fontWeight:700, cursor: (status==="connecting"||status==="reading") ? "wait" : "pointer",
        fontFamily:FONT, boxShadow:`0 0 10px ${C.accent}44`,
        opacity: (status==="connecting"||status==="reading") ? .6 : 1,
        transition:"opacity .2s",
      }}>
        🔌 Connect Keyboard
      </button>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   KEYBOARD VIZ
───────────────────────────────────────────────────────────────────────────── */
function sectionKeyColor(section, key, d, sel, hov_, apByIdx, globalAp) {
  if (sel) return hov_ ? C.keySlH : C.keySel;
  if (d > 0.02) return C.keyDepthBg(d);
  if (section === "quick") {
    const idx = ALL_KEYS.indexOf(key);
    const hue = Math.round((idx / ALL_KEYS.length) * 300);
    return hov_ ? `hsl(${hue},85%,68%)` : `hsl(${hue},78%,58%)`;
  }
  if (section === "ap") return hov_ ? C.keyHv : C.key;
  return hov_ ? C.keyHv : C.key;
}

function KeyboardViz({ keyDepths, selectedKeys, onKeyClick, onSimPress, onSimRelease, section, apByIdx, globalAp, rtPressByIdx, globalSens, labelMap }) {
  const [hov, setHov] = useState(null);
  const showApLabels = section === "ap";
  const showRtLabels = section === "rt";
  const showValueLabels = showApLabels || showRtLabels;
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:0 }}>
      <div style={{
        background:C.kbBody, borderRadius:"10px 10px 14px 14px",
        padding:"12px 13px 16px", display:"inline-flex", flexDirection:"column", gap:G,
        border:`1px solid ${C.kbBord}`,
        boxShadow:C.shadow,
        position:"relative",
        transition:"box-shadow .3s",
      }}>
        {ROWS.map((row, ri) => (
          <div key={ri} style={{ display:"flex", gap:G }}>
            {row.map(key => {
              const d   = keyDepths[key.id] || 0;
              const sel = selectedKeys.has(key.id);
              const hov_ = hov === key.id;
              const bg  = sectionKeyColor(section, key, d, sel, hov_, apByIdx, globalAp);
              const displayLabel = labelMap?.[key.id] ?? key.l;
              const keyApMm = key.magIdx >= 0 && apByIdx?.[key.magIdx] != null ? cmm(apByIdx[key.magIdx]) : globalAp;
              const keyRtMm = key.magIdx >= 0 && rtPressByIdx?.[key.magIdx] != null ? cmm(rtPressByIdx[key.magIdx]) : globalSens;
              const labelVal = showApLabels ? keyApMm : keyRtMm;
              return (
                <button key={key.id}
                  onClick={() => onKeyClick(key.id)}
                  onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); onSimPress?.(key.id); }}
                  onPointerUp={e => {
                    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
                    onSimRelease?.(key.id);
                  }}
                  onPointerCancel={() => onSimRelease?.(key.id)}
                  onMouseEnter={() => setHov(key.id)}
                  onMouseLeave={() => { setHov(null); onSimRelease?.(key.id); }}
                  title={`${key.l||"Space"} · idx ${key.magIdx}${key.shared?" (shared)":""} · ${(d*4).toFixed(2)}mm`}
                  style={{
                    width:kw(key.u), height:38, borderRadius:4, flexShrink:0,
                    background:bg, border:"none", padding:0, cursor:"pointer",
                    outline: sel ? `1.5px solid rgba(255,255,255,.5)` : "none", outlineOffset:-1,
                    boxShadow: d>0.02 ? C.keyDepthShadow(d) : C.keyRestShadow,
                    display:"flex", flexDirection:"column",
                    alignItems:"center", justifyContent:"center",
                    position:"relative", overflow:"hidden",
                    transform: d>0 ? `translateY(${Math.round(d*2)}px)` : "none",
                    transition:"background .12s ease-out, transform .05s linear, outline-color .15s",
                  }}
                >
                  {/* selection dot — matches reference's white-dot marker */}
                  {sel && <div style={{
                    position:"absolute", top:3, right:3,
                    width:5, height:5, borderRadius:"50%",
                    background:"#fff", boxShadow:"0 0 4px rgba(255,255,255,.8)",
                    animation:"popIn .18s cubic-bezier(.34,1.56,.64,1)",
                  }}/>}
                  {/* depth bar */}
                  {d > 0.02 && <div style={{
                    position:"absolute", bottom:0, left:0,
                    width:`${d*100}%`, height:2,
                    background: sel ? C.selectedMark : C.keyDepthBar,
                    borderTopRightRadius:1, transition:"width .03s linear",
                  }}/>}
                  {/* shared-slot indicator */}
                  {key.shared && !sel && <div style={{
                    position:"absolute", top:2, right:2,
                    width:3, height:3, borderRadius:"50%",
                    background: C.sharedDot,
                  }}/>}
                  {/* per-key value label (Actuation Point + Rapid Trigger sections) */}
                  {showValueLabels && !sel && d < 0.02 && labelVal != null && (
                    <span style={{
                      position:"absolute", top:2, left:3,
                      fontSize:6, fontFamily:MONO,
                      color: showApLabels ? "rgba(255,255,255,.65)" : C.muted,
                      lineHeight:1,
                    }}>{labelVal.toFixed(2)}</span>
                  )}
                  <span style={{
                    fontSize:key.u>=1.5?9:10, fontFamily:FONT, fontWeight:700,
                    color: sel?C.selectedTxt:(section==="quick"?"#fff":C.keyTxt), userSelect:"none", lineHeight:1,
                    marginTop: showValueLabels ? 4 : 0,
                  }}>{displayLabel}</span>
                  {d > 0.08 && <span style={{
                    fontSize:6.5, fontFamily:MONO, lineHeight:1, marginTop:1,
                    color: sel?C.selectedSub:C.depthTxt,
                  }}>{(d*4).toFixed(1)}</span>}
                </button>
              );
            })}
          </div>
        ))}
        <div style={{ position:"absolute", bottom:4, left:"50%", transform:"translateX(-50%)",
          fontSize:7, fontWeight:800, letterSpacing:".2em",
          color:C.watermark, textTransform:"uppercase" }}>wooting</div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   SELECTED KEY DETAILS — shows the real per-key activation range for
   whichever key(s) are currently selected ("click range" readout).
───────────────────────────────────────────────────────────────────────────── */
function SelectedKeyDetails({ selectedKeys, mode, apByIdx, liftByIdx, rtPressByIdx, rtLiftByIdx }) {
  const keys = [...selectedKeys].map(id => ALL_KEYS.find(k => k.id === id)).filter(Boolean);
  if (keys.length === 0) return null;
  const shown = keys.slice(0, 6);
  return (
    <div style={{
      display:"flex", flexDirection:"column", gap:5, padding:"10px 12px",
      background:C.over, borderRadius:6, border:`1px solid ${C.bord}`,
      animation:"fadeSlideUp .18s ease-out",
    }}>
      <div style={{ fontSize:9, fontWeight:700, color:C.muted, letterSpacing:".06em", textTransform:"uppercase" }}>
        {mode === "ap" ? "Current click range" : "Current RT sensitivity"}
      </div>
      {shown.map(k => {
        const i = k.magIdx;
        let line;
        if (mode === "ap") {
          const p = i>=0 && apByIdx?.[i] != null ? cmm(apByIdx[i]).toFixed(2) : "—";
          const l = i>=0 && liftByIdx?.[i] != null ? cmm(liftByIdx[i]).toFixed(2) : "—";
          line = `activates ${p}mm · releases ${l}mm`;
        } else {
          const p = i>=0 && rtPressByIdx?.[i] != null ? cmm(rtPressByIdx[i]).toFixed(2) : "—";
          const l = i>=0 && rtLiftByIdx?.[i] != null ? cmm(rtLiftByIdx[i]).toFixed(2) : "—";
          line = `press Δ ${p}mm · release Δ ${l}mm`;
        }
        return (
          <div key={k.id} style={{ display:"flex", justifyContent:"space-between", fontSize:11, gap:10 }}>
            <span style={{ fontFamily:MONO, color:C.accent, fontWeight:700, flexShrink:0 }}>{k.l || "Space"}</span>
            <span style={{ color:C.sub, fontFamily:MONO, textAlign:"right" }}>{line}</span>
          </div>
        );
      })}
      {keys.length > shown.length && (
        <div style={{ fontSize:10, color:C.muted }}>+{keys.length - shown.length} more selected</div>
      )}
    </div>
  );
}


function KeyTravelPreview({ depths, selectedKeys, ap }) {
  const selected = [...selectedKeys];
  const pool = selected.length ? selected : Object.keys(depths || {});
  let activeId = pool[0] || null;
  let depth = 0;
  pool.forEach(id => {
    const d = depths?.[id] || 0;
    if (d >= depth) { depth = d; activeId = id; }
  });

  const key = ALL_KEYS.find(k => k.id === activeId);
  const label = key?.l || (activeId === "spc" ? "Space" : "—");

  // keyDepths is a 0→1 ratio over the UI's 0→4mm scale.
  // The FUN60 switch bottoms out around 3mm, so the switch art and meter
  // hard-stop at 3.00mm while the scale still shows 0→4mm.
  const MAX_TRAVEL_MM = 3.0;
  const METER_MM = 4.0;
  const rawTravelMm = Math.max(0, depth * METER_MM);
  const travelMm = Math.max(0, Math.min(MAX_TRAVEL_MM, rawTravelMm));
  const travelNorm = Math.max(0, Math.min(1, travelMm / MAX_TRAVEL_MM));
  const meterPct = Math.max(0, Math.min(100, (travelMm / METER_MM) * 100));
  const apNorm = Math.max(0, Math.min(1, ap / METER_MM));
  const maxStopPct = (MAX_TRAVEL_MM / METER_MM) * 100;
  const stemDrop = Math.max(0, Math.min(16, travelNorm * 16));
  const pressed = travelMm > 0.025;
  const maxed = travelMm >= MAX_TRAVEL_MM - 0.035;
  const actuated = travelMm >= ap && pressed;
  const meterTicks = [0, 1, 2, 3, 4];

  // ---- Isometric box geometry helpers --------------------------------
  // A box is defined by its top diamond's 4 points (N/E/S/W, all sharing
  // the same projection angle) extruded downward by height H. This keeps
  // every face mathematically aligned instead of hand-picked coordinates
  // that don't actually share a common vanishing geometry.
  const iso = (cx, topY, hw, hd, H, taper = 1) => {
    const N = [cx, topY], E = [cx + hw, topY + hd], S = [cx, topY + 2*hd], W = [cx - hw, topY + hd];
    // Tapered (frustum) extrusion: the bottom diamond is scaled by `taper`
    // around its own center rather than just dropped straight down. A
    // straight extrusion (taper=1) is what read as a sharp, blocky cube —
    // real switch housings flare outward toward the base.
    const cy = topY + hd, cy2 = cy + H, bw = hw * taper, bd = hd * taper;
    const N2 = [cx, cy2 - bd], E2 = [cx + bw, cy2], S2 = [cx, cy2 + bd], W2 = [cx - bw, cy2];
    return { top: [N, E, S, W], left: [W, S, S2, W2], right: [S, E, E2, S2], N, E, S, W, N2, E2, S2, W2 };
  };
  const pts = arr => arr.map(p => p.join(",")).join(" ");
  const centroid = arr => {
    const n = arr.length;
    return [arr.reduce((a,[x])=>a+x,0)/n, arr.reduce((a,[,y])=>a+y,0)/n];
  };
  const insetQuad = (arr, s) => {
    const [cx, cy] = centroid(arr);
    return arr.map(([x,y]) => [cx + (x-cx)*s, cy + (y-cy)*s]);
  };

  const base  = iso(135, 92, 64, 16, 32, 1.16);  // dark lower housing — flares outward
  const green = iso(135, 44, 42, 13, 46, 1.24);  // mint upper housing — more pronounced flare
  const stemA = iso(135, 40, 7, 3, 22, 1);        // cross-stem, wide blade — stays straight
  const stemB = iso(135, 40, 3, 7, 22, 1);        // cross-stem, perpendicular blade
  const window_ = insetQuad(green.left, 0.55);

  return (
    <div style={{
      marginTop:10, padding:"14px 14px 12px", borderRadius:10,
      background:`linear-gradient(180deg,${C.over},${C.panel})`,
      border:`1px solid ${actuated ? C.accent : C.bord}`,
      boxShadow: actuated ? `0 0 18px ${C.accent}22, inset 0 1px 0 rgba(255,255,255,.04)` : "inset 0 1px 0 rgba(255,255,255,.035)",
      display:"grid", gridTemplateColumns:"minmax(230px,1fr) 92px", gap:16,
      alignItems:"center", overflow:"hidden",
      transition:"border-color .16s ease, box-shadow .16s ease",
    }}>
      <div style={{ minHeight:166, position:"relative", display:"flex", alignItems:"center", justifyContent:"center" }}>
        <svg width="270" height="166" viewBox="0 0 270 166" role="img" aria-label="magnetic switch travel preview" style={{ overflow:"visible" }}>
          <defs>
            <linearGradient id="baseTop" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#666c6e"/><stop offset=".5" stopColor="#585d60"/><stop offset="1" stopColor="#4a4f51"/>
            </linearGradient>
            <linearGradient id="baseLeft" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#4f5456"/><stop offset=".6" stopColor="#3c4042"/><stop offset="1" stopColor="#303437"/>
            </linearGradient>
            <linearGradient id="baseRight" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#3d4144"/><stop offset=".6" stopColor="#2d3032"/><stop offset="1" stopColor="#212427"/>
            </linearGradient>
            <linearGradient id="greenTop" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor={actuated ? "#d4ffe9" : "#c6ffe2"}/>
              <stop offset=".5" stopColor={actuated ? "#9ff4c4" : "#94edbc"}/>
              <stop offset="1" stopColor={actuated ? "#83eeb6" : "#74e8ac"}/>
            </linearGradient>
            <linearGradient id="greenLeft" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#86efb7"/><stop offset=".6" stopColor="#5fd699"/><stop offset="1" stopColor="#4ccb8c"/>
            </linearGradient>
            <linearGradient id="greenRight" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#52ca8c"/><stop offset=".6" stopColor="#39ad73"/><stop offset="1" stopColor="#2a9c64"/>
            </linearGradient>
            <linearGradient id="stemFace" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="#d4dade"/><stop offset=".5" stopColor="#ffffff"/><stop offset="1" stopColor="#aab2b7"/>
            </linearGradient>
            <linearGradient id="stemSide" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#b9c0c4"/><stop offset="1" stopColor="#8c9396"/>
            </linearGradient>
            <radialGradient id="swSheen" cx="0.35" cy="0.3" r="0.65">
              <stop offset="0" stopColor="rgba(255,255,255,.55)"/>
              <stop offset="1" stopColor="rgba(255,255,255,0)"/>
            </radialGradient>
            <filter id="swShadow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="7"/></filter>
            <filter id="swGlow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
            <filter id="swSoft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.2"/></filter>
          </defs>

          <ellipse cx="135" cy="148" rx="84" ry="17" fill="rgba(0,0,0,.4)" filter="url(#swShadow)"/>

          {/* dark lower housing — round joins + soft edge blur so corners read
              as gently rounded rather than razor-sharp polygon vertices */}
          <g strokeLinejoin="round" filter="url(#swSoft)">
            <polygon points={pts(base.left)}  fill="url(#baseLeft)"  stroke="rgba(255,255,255,.05)" strokeWidth="1.5"/>
            <polygon points={pts(base.right)} fill="url(#baseRight)" stroke="rgba(0,0,0,.08)" strokeWidth="1.5"/>
          </g>
          <polygon points={pts(base.top)} fill="url(#baseTop)" stroke="rgba(255,255,255,.14)" strokeWidth="1.2" strokeLinejoin="round"/>

          {/* mint upper housing */}
          <g strokeLinejoin="round" filter="url(#swSoft)">
            <polygon points={pts(green.left)}  fill="url(#greenLeft)"  stroke="rgba(255,255,255,.18)" strokeWidth="1.5"/>
            <polygon points={pts(green.right)} fill="url(#greenRight)" stroke="rgba(0,40,20,.14)" strokeWidth="1.5"/>
          </g>
          <polygon points={pts(green.top)} fill="url(#greenTop)" stroke="rgba(255,255,255,.55)" strokeWidth="1.3" strokeLinejoin="round"/>
          {/* soft specular sheen, like a gently curved product render */}
          <polygon points={pts(green.top)} fill="url(#swSheen)" opacity=".8"/>

          {/* recessed front window, inset into the left face */}
          <polygon points={pts(window_)} fill="rgba(255,255,255,.22)" stroke="rgba(10,90,55,.5)" strokeWidth="1" strokeLinejoin="round"/>
          <polygon points={pts(insetQuad(window_, 0.62))} fill="rgba(255,255,255,.16)"/>

          {/* cross-shaped stem, presses downward on actuation */}
          <g transform={`translate(0 ${stemDrop})`} filter={pressed ? "url(#swGlow)" : undefined} style={{ transition:"transform .035s linear" }} strokeLinejoin="round">
            <polygon points={pts(stemA.left)}  fill="url(#stemSide)" stroke="rgba(0,0,0,.18)"/>
            <polygon points={pts(stemA.right)} fill="#9aa1a5"        stroke="rgba(0,0,0,.16)"/>
            <polygon points={pts(stemB.left)}  fill="url(#stemSide)" stroke="rgba(0,0,0,.18)"/>
            <polygon points={pts(stemB.right)} fill="#9aa1a5"        stroke="rgba(0,0,0,.16)"/>
            <polygon points={pts(stemA.top)} fill="url(#stemFace)" stroke="rgba(0,0,0,.2)"/>
            <polygon points={pts(stemB.top)} fill="url(#stemFace)" stroke="rgba(0,0,0,.2)"/>
          </g>

          {maxed && <g>
            <rect x="107" y="138" width="60" height="3" rx="1.5" fill={C.accent} filter="url(#swGlow)"/>
            <text x="138" y="152" textAnchor="middle" fill={C.accent} fontSize="9" fontFamily="monospace" fontWeight="800">3.0mm MAX</text>
          </g>}
        </svg>
      </div>

      <div style={{ display:"flex", alignItems:"center", gap:9, justifyContent:"flex-end" }}>
        <div style={{
          height:136, width:34, borderRadius:18, background:C.track,
          border:`1px solid ${C.bord}`, position:"relative", overflow:"hidden",
          boxShadow:"inset 0 2px 8px rgba(0,0,0,.34)",
        }}>
          {/* downward fill: 0.0 at top, hard-stop at 3.0mm */}
          <div style={{
            position:"absolute", left:3, right:3, top:3,
            height:`calc(${meterPct}% - 6px)`, minHeight: pressed ? 4 : 0,
            maxHeight:`calc(${maxStopPct}% - 6px)`,
            borderRadius:15,
            background:`linear-gradient(180deg,${C.accent},${C.green})`,
            boxShadow: pressed ? `0 0 12px ${C.green}55` : "none",
            transition:"height .035s linear, box-shadow .12s ease",
          }}/>
          <div style={{
            position:"absolute", left:5, right:5, top:`calc(${maxStopPct}% - 1px)`, height:2,
            background: maxed ? C.accent : "rgba(255,255,255,.34)",
            boxShadow: maxed ? `0 0 8px ${C.accent}` : "none",
            borderRadius:2,
            transition:"background .12s ease, box-shadow .12s ease",
          }}/>
          {maxed && <div style={{
            position:"absolute", left:10, right:10, top:`calc(${maxStopPct}% + 4px)`, height:3,
            background:C.accent, borderRadius:2,
            boxShadow:`0 0 10px ${C.accent}`,
          }}/>} 
          <div style={{
            position:"absolute", left:0, right:0, top:`${apNorm*100}%`, height:2,
            background:C.red, boxShadow:`0 0 7px ${C.red}`,
          }}/>
          {meterTicks.map(mm => (
            <div key={mm} style={{
              position:"absolute", left:mm===3 ? 1 : 5, right:mm===3 ? 1 : 5,
              top:`${(mm/METER_MM)*100}%`, height:mm===3 ? 1.5 : 1,
              background:mm===3 ? "rgba(255,255,255,.34)" : "rgba(255,255,255,.18)",
            }}/>
          ))}
        </div>
        <div style={{ height:136, display:"flex", flexDirection:"column", justifyContent:"space-between", fontFamily:MONO }}>
          {meterTicks.map(mm => (
            <span key={mm} style={{
              fontSize:9,
              color: mm===3 && maxed ? C.accent : (Math.abs(travelMm-mm)<.18 ? C.accent : C.muted),
              fontWeight: mm===3 && maxed ? 800 : 400,
            }}>{mm.toFixed(1)}</span>
          ))}
        </div>
      </div>

      <div style={{ gridColumn:"1 / -1", display:"flex", justifyContent:"space-between", alignItems:"center", gap:10 }}>
        <div style={{ fontSize:11, color:C.muted }}>
          {pressed ? `${label} switch travel` : "Press a key to preview switch travel"}
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontFamily:MONO, fontSize:12, fontWeight:800, color: actuated ? C.green : C.accent }}>
            {travelMm.toFixed(2)}mm
          </span>
          {maxed && <span style={{ fontSize:9, color:C.accent, fontWeight:900, letterSpacing:".07em" }}>MAX</span>}
          <span style={{ fontSize:10, color: actuated ? C.green : C.muted, fontWeight:800, letterSpacing:".06em" }}>
            {actuated ? "ACTUATED" : `AP ${ap.toFixed(2)}mm`}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   QUICK SETTINGS CARDS
───────────────────────────────────────────────────────────────────────────── */
function APCard({ ap, setAp, connected, dSend, selectedKeys, apByIdx, liftByIdx, depths }) {
  const selArr = [...selectedKeys];
  const handleChange = v => {
    setAp(v);
    if (!connected) return;
    const val = mm(v);
    if (selArr.length === 0) {
      // bulk set all keys
      const all = Array(64).fill(val);
      [0, 1].forEach(page => dSend(`ap-bulk-${page}`, CMD.setMagBulk(MAG.PRESS, page, all.slice(page*28, page*28+28))));
    } else {
      selArr.forEach(id => {
        const k = ALL_KEYS.find(x => x.id === id);
        if (k && k.magIdx >= 0) dSend(`ap-${k.magIdx}`, CMD.setMag(MAG.PRESS, k.magIdx, val));
      });
    }
  };
  const pct = ((ap-0.1)/(4.0-0.1))*100;
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
      <div style={{ display:"flex", justifyContent:"space-between" }}>
        <div>
          <div style={{ fontSize:14, fontWeight:700, color:C.txt }}>Actuation Point</div>
          <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>
            Set where a key press registers.
          </div>
        </div>
      </div>
      <div style={{ display:"flex", gap:14, alignItems:"center" }}>
        <div style={{ width:56, height:66, background:C.surf, borderRadius:8,
          border:`1px solid ${C.bord}`, display:"flex", alignItems:"center",
          justifyContent:"center", fontSize:26, flexShrink:0 }}>⌨</div>
        <div style={{ flex:1 }}>
          <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:6 }}>
            <div style={{ background:C.accent, color:C.atxt, fontSize:10, fontWeight:700,
              padding:"2px 7px", borderRadius:3 }}>⚑ {ap.toFixed(2)}</div>
          </div>
          <Slider value={ap} min={0.1} max={4.0} step={0.05} onChange={handleChange} noLabel disabled={false}/>
          <div style={{ display:"flex", justifyContent:"space-between", marginTop:4 }}>
            <span style={{ fontSize:9, color:C.muted }}>HIGH</span>
            <span style={{ fontSize:10, fontFamily:MONO, color:C.accent, fontWeight:700 }}>{ap.toFixed(2)} mm</span>
            <span style={{ fontSize:9, color:C.muted }}>LOW</span>
          </div>
        </div>
      </div>
      <div style={{ borderTop:`1px solid ${C.bord}`, paddingTop:10 }}>
        <div style={{ fontSize:9, fontWeight:700, color:C.muted, letterSpacing:".07em", textTransform:"uppercase" }}>
          VISUAL FEEDBACK
        </div>
        <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>
          Live depth shows here when HID telemetry is on. In Demo, press any key to animate the switch to its configured actuation depth.
        </div>
        <KeyTravelPreview depths={depths || {}} selectedKeys={selectedKeys} ap={ap}/>
      </div>
      <SelectedKeyDetails selectedKeys={selectedKeys} mode="ap" apByIdx={apByIdx} liftByIdx={liftByIdx}/>
    </div>
  );
}

function RTCard({ rtOn, setRtOn, sens, setSens, split, setSplit, press, setPress, rel, setRel, connected, dSend, selectedKeys, rtPressByIdx, rtLiftByIdx }) {
  const selArr = [...selectedKeys];
  const handleToggle = v => {
    setRtOn(v);
    if (!connected) return;
    const mode = v ? RT_BIT : MODE.NORMAL;
    if (selArr.length === 0) dSend("rt-mode-global", CMD.setGlobalMode(mode));
    else selArr.forEach(id => {
      const k = ALL_KEYS.find(x => x.id === id);
      if (k && k.magIdx >= 0) dSend(`mode-${k.magIdx}`, CMD.setMag(MAG.MODE, k.magIdx, mode));
    });
  };
  const handleSens = v => {
    setSens(v);
    if (!connected) return;
    const val = mm(v);
    const targets = selArr.length > 0 ? selArr : ALL_KEYS.map(k => k.id);
    targets.forEach(id => {
      const k = ALL_KEYS.find(x => x.id === id);
      if (k && k.magIdx >= 0) {
        dSend(`rtp-${k.magIdx}`, CMD.setMag(MAG.RT_PRESS, k.magIdx, val));
        if (!split) dSend(`rtl-${k.magIdx}`, CMD.setMag(MAG.RT_LIFT, k.magIdx, val));
      }
    });
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ fontSize:14, fontWeight:700, color:C.txt }}>Rapid Trigger</span>
          </div>
          <div style={{ fontSize:11, color:C.muted, marginTop:2, maxWidth:200 }}>
            Key reacts on movement, not fixed depth.
          </div>
        </div>
        <Toggle on={rtOn} onChange={handleToggle}/>
      </div>

      {rtOn && <>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <span style={{ fontSize:11, color:C.muted }}>Separate press / release</span>
          <Toggle on={split} onChange={setSplit}/>
        </div>
        <div>
          <div style={{ fontSize:9, fontWeight:700, color:C.muted, letterSpacing:".07em", textTransform:"uppercase", marginBottom:6 }}>
            SENSITIVITY
          </div>
          {!split ? <>
            <Slider value={sens} min={0.1} max={4.0} step={0.05} onChange={handleSens} noLabel/>
            <div style={{ display:"flex", justifyContent:"space-between", marginTop:4 }}>
              <span style={{ fontSize:9, color:C.muted }}>HIGH</span>
              <span style={{ fontSize:11, fontFamily:MONO, color:C.accent, fontWeight:700 }}>{sens.toFixed(2)} mm</span>
              <span style={{ fontSize:9, color:C.muted }}>LOW</span>
            </div>
          </> : <>
            <Slider label="Press δ"   value={press} min={0.1} max={4.0} step={0.05} onChange={setPress}/>
            <div style={{ marginTop:8 }}>
              <Slider label="Release δ" value={rel}   min={0.1} max={4.0} step={0.05} onChange={setRel} color="#a78bfa"/>
            </div>
          </>}
        </div>
      </>}
      <SelectedKeyDetails selectedKeys={selectedKeys} mode="rt" rtPressByIdx={rtPressByIdx} rtLiftByIdx={rtLiftByIdx}/>
    </div>
  );
}

function PerfCard({ pollingCode, setPollingCode, connected, send, liveReportHz = 0 }) {
  const hz = POLL_HZ[pollingCode] ?? 1000;
  const RATES = [8000, 4000, 2000, 1000, 500, 250, 125];
  const [verify, setVerify] = useState({ state:"idle", expectedCode:null, actualCode:null, raw:"" });

  const handleRate = async code => {
    setPollingCode(code);
    setVerify({ state: connected ? "pending" : "idle", expectedCode: code, actualCode:null, raw:"" });
    if (!connected || !send) return;

    try {
      await send(CMD.setPolling(code));
      await sleep(90);
      const res = await send(CMD.getPolling());
      const actualCode = extractPollingCode(res);
      if (actualCode != null) setPollingCode(actualCode);
      setVerify({
        state: actualCode === code ? "ok" : "fail",
        expectedCode: code,
        actualCode,
        raw: [...res].map(x => x.toString(16).padStart(2,"0")).join(" "),
      });
    } catch (e) {
      setVerify({ state:"error", expectedCode: code, actualCode:null, raw: e?.message || String(e) });
    }
  };

  const expectedHz = verify.expectedCode != null ? POLL_HZ[verify.expectedCode] : hz;
  const actualHz = verify.actualCode != null ? POLL_HZ[verify.actualCode] : null;
  const ok = verify.state === "ok";
  const pending = verify.state === "pending";
  const failed = verify.state === "fail" || verify.state === "error";

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
      <div>
        <div style={{ fontSize:14, fontWeight:700, color:C.txt }}>Tachyon Mode</div>
        <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>
          Sets the keyboard USB polling target. Readback confirms whether firmware accepted it.
        </div>
      </div>
      <div>
        <div style={{ fontSize:9, fontWeight:700, color:C.muted, letterSpacing:".07em", textTransform:"uppercase", marginBottom:6 }}>SCAN RATE</div>
        <div style={{ fontSize:22, fontWeight:800, color:C.accent }}>{formatHz(hz)} Hz</div>
      </div>
      <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>
        {RATES.map(r => {
          const code = POLL[r];
          const active = (POLL_HZ[pollingCode]??1000)===r;
          return (
            <button key={r} onClick={() => handleRate(code)} style={{
              padding:"4px 8px", borderRadius:4, border:`1px solid ${active?C.accent:C.bord}`,
              background:active?C.activeBg:"transparent",
              color:active?C.accent:C.muted,
              fontSize:10, fontFamily:MONO, cursor: connected?"pointer":"pointer",
              fontWeight:active?700:400,
            }}>{r>=1000?`${r/1000}K`:r}</button>
          );
        })}
      </div>

      <div style={{ display:"flex", flexDirection:"column", gap:6, padding:"9px 11px",
        borderRadius:6, background:C.over, border:`1px solid ${ok?"rgba(74,222,128,.32)":failed?"rgba(238,63,63,.32)":C.bord}` }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:9, fontWeight:800, color:C.muted, letterSpacing:".07em", textTransform:"uppercase" }}>Polling verification</span>
          <span style={{ fontSize:10, fontFamily:MONO, color: ok?C.green:failed?C.red:C.muted, fontWeight:800 }}>
            {!connected ? "connect first" : pending ? "checking…" : ok ? "readback ✓" : failed ? "mismatch" : "not checked"}
          </span>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6 }}>
          <div style={{ fontSize:11, color:C.muted }}>Requested <b style={{ color:C.txt }}>{formatHz(expectedHz)}Hz</b></div>
          <div style={{ fontSize:11, color:C.muted }}>Readback <b style={{ color:actualHz?C.txt:C.muted }}>{actualHz ? `${formatHz(actualHz)}Hz` : "—"}</b></div>
        </div>
        <div style={{ fontSize:11, color:C.muted }}>
          Live HID depth events: <b style={{ color:liveReportHz ? C.accent : C.muted, fontFamily:MONO }}>{liveReportHz}</b> reports/s
        </div>
        {verify.raw && <div title={verify.raw} style={{ fontSize:9, color:C.muted, fontFamily:MONO, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
          raw {verify.raw}
        </div>}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   FULL SECTION PANELS
───────────────────────────────────────────────────────────────────────────── */
function RGBPanel({ ledOn, setLedOn, ledMode, setLedMode, ledR, setLedR, ledG, setLedG, ledB, setLedB,
                    ledSpeed, setLedSpeed, ledBri, setLedBri, connected, dSend }) {
  const MODES = Object.entries(LED_MODES);
  // Hardware brightness/speed are exposed as 5 UI levels here:
  // 0/1/2/3/4 -> 0/25/50/75/100%.
  // 0 is the explicit off/lowest state; 4 is the real maximum.
  const safeBri = Math.max(0, Math.min(4, Number.isFinite(ledBri) ? ledBri : 4));
  const safeSpeed = Math.max(0, Math.min(4, Number.isFinite(ledSpeed) ? ledSpeed : 4));
  const levelPct = v => `${Math.round((Math.max(0, Math.min(4, v)) / 4) * 100)}%`;
  const apply = (mode, spd, bri, r, g, b) => {
    if (connected) dSend("led", CMD.setLedParam(mode, spd, bri, r, g, b));
  };
  const hex = `#${[ledR,ledG,ledB].map(v=>v.toString(16).padStart(2,"0")).join("")}`;
  const setHex = h => {
    const [r,g,b] = [1,3,5].map(i => parseInt(h.slice(i,i+2),16));
    setLedR(r); setLedG(g); setLedB(b);
    apply(ledMode, safeSpeed, safeBri, r, g, b);
  };
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:18 }}>
      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
        <Toggle on={ledOn} onChange={v => { setLedOn(v); if(connected) dSend("ledOn",CMD.setLedOn(v),0); }}/>
        <span style={{ fontSize:14, fontWeight:700, color:C.txt }}>LED Lighting</span>
      </div>
      {ledOn && <div style={{ display:"flex", gap:24, flexWrap:"wrap" }}>
        <div style={{ display:"flex", flexDirection:"column", gap:3, minWidth:110 }}>
          <div style={{ fontSize:9, color:C.muted, textTransform:"uppercase", letterSpacing:".06em", marginBottom:4 }}>Mode</div>
          {MODES.map(([code, name]) => (
            <button key={code} onClick={() => { setLedMode(+code); apply(+code,safeSpeed,safeBri,ledR,ledG,ledB); }} style={{
              padding:"6px 11px", border:`1px solid ${ledMode===+code?C.accent:C.bord}`,
              borderRadius:4, background:ledMode===+code?C.activeBg:"transparent",
              color:ledMode===+code?C.accent:C.muted, fontSize:12, textAlign:"left",
              fontFamily:FONT, cursor:"pointer", display:"flex", justifyContent:"space-between", gap:10, alignItems:"center",
            }}>
              <span>{name}</span>
              <span style={{ fontFamily:MONO, fontSize:9, opacity:.65 }}>0x{(+code).toString(16).padStart(2,"0")}</span>
            </button>
          ))}
        </div>
        <div style={{ flex:1, display:"flex", flexDirection:"column", gap:14, minWidth:200 }}>
          <div>
            <div style={{ fontSize:9, color:C.muted, textTransform:"uppercase", letterSpacing:".06em", marginBottom:8 }}>Colour</div>
            <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
              <div style={{ width:32,height:32,borderRadius:6,background:hex,
                border:`1px solid ${C.bord}`, boxShadow:`0 0 10px ${hex}88`, flexShrink:0 }}/>
              {["#FFD45C","#5B51FF","#ef4444","#4ade80","#38bdf8","#f5f5f5"].map(c => (
                <div key={c} onClick={() => setHex(c)} style={{
                  width:20,height:20,borderRadius:3,background:c,cursor:"pointer",
                  border:hex===c?`2px solid ${C.txt}`:`1px solid ${C.bord}`,
                }}/>
              ))}
              <label style={{ fontSize:10, color:C.muted, fontFamily:MONO, cursor:"pointer" }}>
                {hex.toUpperCase()}
                <input type="color" value={hex} onChange={e=>setHex(e.target.value)}
                  style={{ opacity:0, width:0, height:0, position:"absolute" }}/>
              </label>
            </div>
          </div>
          <Slider label="Brightness" value={safeBri} min={0} max={4} step={1} unit=""
            displayText={levelPct(safeBri)} ticks={[0,1,2,3,4]}
            onChange={v => { const b=Math.max(0, Math.min(4, Math.round(v))); setLedBri(b); apply(ledMode,safeSpeed,b,ledR,ledG,ledB); }}/>
          <Slider label="Speed" value={safeSpeed} min={0} max={4} step={1} unit="" color="#a78bfa"
            displayText={levelPct(safeSpeed)} ticks={[0,1,2,3,4]}
            onChange={v => { const s=Math.max(0, Math.min(4, Math.round(v))); setLedSpeed(s); apply(ledMode,s,safeBri,ledR,ledG,ledB); }}/>
        </div>
      </div>}
    </div>
  );
}

function RemapPanel({ selectedKeys, activeLayer, fnLayer, setFnLayer, connected, send, writeFnLayer }) {
  const [cat, setCat] = useState("Function");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const selArr = [...selectedKeys];
  const targetLayer = activeLayer === "fn1";

  const assign = async (label, code) => {
    if (!targetLayer || selArr.length === 0) return;
    const next = cloneFnLayer(fnLayer);
    selArr.forEach(id => {
      if (code === HID.NONE) delete next[id];
      else next[id] = { code, label };
    });
    setFnLayer(next);
    setBusy(true); setMsg("Saving Fn Layer 1…");
    try {
      if (connected) await writeFnLayer(1, next);
      setMsg(connected ? "Fn Layer 1 saved to keyboard." : "Fn Layer 1 changed in UI only. Connect keyboard to write it.");
    } catch (e) {
      console.warn("Fn layer write failed", e);
      setMsg(`Write failed: ${e.message || e}`);
    } finally { setBusy(false); }
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
      <div>
        <div style={{ fontSize:13, fontWeight:700, color:C.txt }}>Fn Layer Remap</div>
        <div style={{ fontSize:12, color:C.muted, marginTop:3 }}>
          {targetLayer ? "Select keys, then assign what they output while Fn is held." : "Switch to Fn Layer 1 on the left to edit the real Fn layer."}
        </div>
      </div>
      <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
        {["Navigation","Function","Media / Profile"].map(c => (
          <button key={c} onClick={()=>setCat(c)} style={{
            padding:"7px 11px", border:`1px solid ${cat===c?C.accent:C.bord}`,
            borderRadius:5, background:cat===c?C.activeBg:"transparent",
            color:cat===c?C.accent:C.muted, fontSize:11, fontWeight:800, fontFamily:FONT, cursor:"pointer",
          }}>{c}</button>
        ))}
        <span style={{ marginLeft:"auto", fontSize:11, color: connected ? C.green : C.muted, fontFamily:MONO }}>
          {connected ? "SET_FN 0x10 ready" : "demo only"}
        </span>
      </div>
      <div style={{ padding:"12px 14px", background:C.over, borderRadius:7, border:`1px solid ${C.bord}` }}>
        <div style={{ fontSize:10, color:C.muted, textTransform:"uppercase", letterSpacing:".07em", fontWeight:900, marginBottom:8 }}>
          {selArr.length ? "Selected" : "No key selected"}
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", color:C.sub, fontSize:12 }}>
          {selArr.length ? selArr.map(id => <span key={id} style={{ padding:"4px 7px", borderRadius:4, background:C.surf, color:C.accent, fontFamily:MONO, fontWeight:800 }}>{ALL_KEYS.find(k=>k.id===id)?.l || id}</span>) : "Select one or more keys on the keyboard preview."}
        </div>
      </div>
      {targetLayer && selArr.length > 0 && FN_ACTIONS.filter(g => g.group===cat).map(group => (
        <div key={group.group} style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(74px,1fr))", gap:8 }}>
          {group.items.map(([label, code]) => (
            <button key={`${label}-${code}`} disabled={busy} onClick={()=>assign(label, code)} style={{
              minHeight:42, padding:"8px 9px", borderRadius:6, border:`1px solid ${C.bord}`,
              background:C.surf, color:C.txt, fontFamily:FONT, fontSize:12, fontWeight:850,
              cursor:busy?"wait":"pointer", boxShadow:"inset 0 1px 0 rgba(255,255,255,.04)",
            }}>{label}</button>
          ))}
        </div>
      ))}
      {targetLayer && <div style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 12px", borderRadius:7, background:C.over, border:`1px solid ${C.bord}`, color:C.muted, fontSize:12 }}>
        <span style={{ color:C.accent, fontWeight:900 }}>Wire format:</span>
        <span>safe chunked <span style={{ fontFamily:MONO }}>SET_FN 0x10</span>, layer id 1, max 56 bytes per chunk.</span>
      </div>}
      {msg && <div style={{ fontSize:12, color:msg.includes("failed")?C.red:C.green, fontWeight:800 }}>{msg}</div>}
    </div>
  );
}

function AdvancedPanel({ selectedKeys, connected, dSend, socdPairs, setSocdPairs }) {
  const [tab, setTab] = useState("dks"); // dks | socd | modtap | toggle
  const selArr = [...selectedKeys];
  const selKeyObjs = selArr.map(id => ALL_KEYS.find(k => k.id === id)).filter(Boolean);

  // ---- DKS ----
  const depths = [0.5,1.5,2.5,3.5];
  const [rows, setRows] = useState(depths.map(()=>({type:"None",key:""})));
  const upd = (i,k,v) => setRows(p=>p.map((r,j)=>j===i?{...r,[k]:v}:r));

  // ---- SOCD / Snap-Tap ----
  const canPair = selKeyObjs.length === 2 && selKeyObjs.every(k => k.magIdx >= 0);
  const setKeyMode = (k, mode, snapEn) => {
    if (!connected || !k || k.magIdx < 0) return;
    dSend(`mode-${k.magIdx}`, CMD.setMag(MAG.MODE, k.magIdx, mode));
    if (snapEn !== undefined) dSend(`snapen-${k.magIdx}`, CMD.setMag(MAG.SNAPTAP_EN, k.magIdx, snapEn));
  };
  const makePair = () => {
    const [k1, k2] = selKeyObjs;
    setKeyMode(k1, MODE.SNAPTAP, 1);
    setKeyMode(k2, MODE.SNAPTAP, 1);
    setSocdPairs(p => [...p, [k1.id, k2.id]]);
  };
  const removePair = idx => {
    const [id1, id2] = socdPairs[idx];
    [id1, id2].forEach(id => setKeyMode(ALL_KEYS.find(k => k.id === id), MODE.NORMAL, 0));
    setSocdPairs(p => p.filter((_, i) => i !== idx));
  };

  // ---- Mod-Tap ----
  const [modTapMs, setModTapMs] = useState(180);
  const applyModTap = () => selKeyObjs.forEach(k => {
    if (k.magIdx < 0) return;
    setKeyMode(k, MODE.MODTAP);
    if (connected) dSend(`modtap-${k.magIdx}`, CMD.setMag(MAG.MODTAP_TIME, k.magIdx, modTapMs));
  });

  // ---- Toggle ----
  const applyToggle = variant => selKeyObjs.forEach(k => setKeyMode(k, variant));

  const resetSelected = () => selKeyObjs.forEach(k => setKeyMode(k, MODE.NORMAL, 0));

  const TABS = [["dks","DKS"],["socd","SOCD / Snap-Tap"],["modtap","Mod-Tap"],["toggle","Toggle"]];

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}>
        {TABS.map(([id,label]) => (
          <button key={id} onClick={()=>setTab(id)} style={{
            padding:"6px 12px", border:`1px solid ${tab===id?C.accent:C.bord}`,
            borderRadius:5, background:tab===id?C.activeBg:"transparent",
            color:tab===id?C.accent:C.muted, fontSize:11, fontFamily:FONT,
            cursor:"pointer", fontWeight:tab===id?700:400,
          }}>{label}</button>
        ))}
      </div>

      {tab==="dks" && (
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          <div style={{ fontSize:12, color:C.muted }}>
            4 actions at fixed depths.{selectedKeys.size===0?" Select a key to configure.":""}
          </div>
          {selectedKeys.size>0 && depths.map((d,i)=>(
            <div key={d} style={{ display:"flex", alignItems:"center", gap:10, padding:"9px 14px",
              background:C.over, borderRadius:6, border:`1px solid ${C.bord}` }}>
              <span style={{ width:44, fontFamily:MONO, fontSize:12, color:C.accent, fontWeight:700 }}>{d.toFixed(1)} mm</span>
              <div style={{ width:1, height:20, background:C.bord }}/>
              {["Key press","Key release","None"].map(t=>(
                <button key={t} onClick={()=>upd(i,"type",t)} style={{
                  padding:"4px 8px", border:`1px solid ${rows[i].type===t?C.accent:C.bord}`,
                  borderRadius:4, background:rows[i].type===t?C.activeBg:"transparent",
                  color:rows[i].type===t?C.accent:C.muted, fontSize:10, fontFamily:FONT, cursor:"pointer",
                }}>{t}</button>
              ))}
              {rows[i].type!=="None" && <input value={rows[i].key} maxLength={4}
                onChange={e=>upd(i,"key",e.target.value.toUpperCase())}
                placeholder="A" style={{ width:40, padding:"4px 7px", fontFamily:MONO,
                  background:C.surf, border:`1px solid ${C.bord}`, borderRadius:4,
                  color:C.txt, fontSize:12, outline:"none", textAlign:"center", marginLeft:"auto" }}/>}
            </div>
          ))}
        </div>
      )}

      {tab==="socd" && (
        <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
          <div style={{ fontSize:12, color:C.muted }}>
            Select exactly 2 keys (e.g. A + D) and pair them. Both are flagged Snap-Tap —
            pressing one while the other is held releases the older one (last-input-wins SOCD).
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <span style={{ fontSize:11, color:C.muted }}>
              {selKeyObjs.length===0 ? "No keys selected" :
               selKeyObjs.length===2 ? `${selKeyObjs.map(k=>k.l||"Space").join(" + ")} selected` :
               `${selKeyObjs.length} selected — need exactly 2`}
            </span>
            <button disabled={!canPair} onClick={makePair} style={{
              marginLeft:"auto", padding:"5px 12px", borderRadius:5, border:"none",
              background: canPair?C.accent:C.disabledBg, color: canPair?C.atxt:C.disabledTxt,
              fontSize:11, fontWeight:700, cursor: canPair?"pointer":"default", fontFamily:FONT,
            }}>Set as SOCD pair</button>
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {socdPairs.length===0 && <div style={{ fontSize:11, color:C.muted, fontStyle:"italic" }}>No pairs configured yet.</div>}
            {socdPairs.map(([id1,id2], i) => {
              const k1 = ALL_KEYS.find(k=>k.id===id1), k2 = ALL_KEYS.find(k=>k.id===id2);
              return (
                <div key={i} style={{ display:"flex", alignItems:"center", gap:10, padding:"7px 12px",
                  background:C.over, borderRadius:6, border:`1px solid ${C.bord}` }}>
                  <span style={{ fontFamily:MONO, fontSize:12, color:C.accent, fontWeight:700 }}>
                    {k1?.l||"Space"} ↔ {k2?.l||"Space"}
                  </span>
                  <button onClick={()=>removePair(i)} style={{
                    marginLeft:"auto", padding:"3px 9px", borderRadius:4, border:`1px solid ${C.bord}`,
                    background:"transparent", color:C.muted, fontSize:10, cursor:"pointer", fontFamily:FONT,
                  }}>Remove</button>
                </div>
              );
            })}
          </div>
          <div style={{ fontSize:10, color:C.muted, fontStyle:"italic", paddingTop:6, borderTop:`1px solid ${C.bord}` }}>
            Pairing is tracked here in the app only — the keyboard itself just stores a
            Snap-Tap flag per key, not which other key it's paired with.
          </div>
        </div>
      )}

      {tab==="modtap" && (
        <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
          <div style={{ fontSize:12, color:C.muted }}>
            {selKeyObjs.length===0
              ? "Select a key to make it dual-function — tap for the normal key, hold for a modifier."
              : `Configuring ${selKeyObjs.length} key${selKeyObjs.length>1?"s":""}.`}
          </div>
          {selKeyObjs.length>0 && <>
            <Slider label="Hold threshold" value={modTapMs} min={80} max={400} step={10} unit=" ms" onChange={setModTapMs}/>
            <button onClick={applyModTap} style={{
              padding:"6px 14px", borderRadius:5, border:"none", alignSelf:"flex-start",
              background:C.accent, color:C.atxt, fontSize:11, fontWeight:700, cursor:"pointer", fontFamily:FONT,
            }}>Apply Mod-Tap</button>
            <div style={{ fontSize:10, color:C.muted, fontStyle:"italic" }}>
              Sets the hold/tap timing threshold. Assigning which key fires on tap vs. hold
              isn't wired up yet — that needs the keymatrix remap command.
            </div>
          </>}
        </div>
      )}

      {tab==="toggle" && (
        <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
          <div style={{ fontSize:12, color:C.muted }}>
            {selKeyObjs.length===0
              ? "Select key(s) to make them latch on/off instead of momentary."
              : `Configuring ${selKeyObjs.length} key${selKeyObjs.length>1?"s":""}.`}
          </div>
          {selKeyObjs.length>0 && (
            <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
              <button onClick={()=>applyToggle(MODE.TOGGLE_HOLD)} style={{
                padding:"7px 14px", borderRadius:5, border:`1px solid ${C.bord}`,
                background:C.surf, color:C.txt, fontSize:12, cursor:"pointer", fontFamily:FONT,
              }}>Toggle (Hold variant)</button>
              <button onClick={()=>applyToggle(MODE.TOGGLE_DOTS)} style={{
                padding:"7px 14px", borderRadius:5, border:`1px solid ${C.bord}`,
                background:C.surf, color:C.txt, fontSize:12, cursor:"pointer", fontFamily:FONT,
              }}>Toggle (Dots variant)</button>
            </div>
          )}
        </div>
      )}

      {selKeyObjs.length>0 && tab!=="dks" && (
        <button onClick={resetSelected} style={{
          alignSelf:"flex-start", padding:"4px 11px", borderRadius:4, border:`1px solid ${C.bord}`,
          background:"transparent", color:C.muted, fontSize:10, cursor:"pointer", fontFamily:FONT,
        }}>Reset selected to Normal</button>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   ICON SIDEBAR SVGs
───────────────────────────────────────────────────────────────────────────── */
const IC = {
  kb:   <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h12" strokeLinecap="round"/></svg>,
  bolt: <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M13 2L4.5 13.5H12L11 22L19.5 10.5H12L13 2Z"/></svg>,
  tgt:  <svg width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1" fill="currentColor"/></svg>,
  adv:  <svg width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>,
  rmp:  <svg width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M5 12h14M15 7l5 5-5 5" strokeLinecap="round"/></svg>,
  rgb:  <svg width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" strokeLinecap="round"/></svg>,
  gear: <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" strokeLinecap="round"/></svg>,
  help: <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3M12 17h.01" strokeLinecap="round"/></svg>,
  sun:  <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42" strokeLinecap="round"/></svg>,
  moon: <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24"><path d="M21 14.5A8.5 8.5 0 119.5 3a6.5 6.5 0 0011.5 11.5z" strokeLinecap="round" strokeLinejoin="round"/></svg>,
};

const NAV = [
  {id:"quick",   icon:IC.kb,   tip:"Quick Settings"},
  {id:"ap",      icon:IC.tgt,  tip:"Actuation Point"},
  {id:"rt",      icon:IC.bolt, tip:"Rapid Trigger"},
  {id:"rgb",     icon:IC.rgb,  tip:"RGB Settings"},
  {id:"remap",   icon:IC.rmp,  tip:"Remap"},
  {id:"advanced",icon:IC.adv,  tip:"Advanced Keys"},
];

const PROFILE_PRESETS = [
  { name:"Typing Profile", badge:"O", fn:"Fn 1", color:"#2454ff", icon:"▣", onboard:true, isDefault:true },
  { name:"Rapid Profile", badge:"P", fn:"Fn 1", color:"#ef4444", icon:"▦", onboard:true, isDefault:false },
  { name:"Gaming Profile", badge:"G", fn:"Fn 2", color:"#22c55e", icon:"▣", onboard:true, isDefault:false },
  { name:"Coding Profile", badge:"C", fn:"Fn 3", color:"#a855f7", icon:"▦", onboard:true, isDefault:false },
];
const PNAMES = PROFILE_PRESETS.map(p => p.name);
const PCOLORS = PROFILE_PRESETS.map(p => p.color);


const DEVICE_OPTIONS = [
  { id:"fun60", name:"FUN60 Ultra TMR", tag:"ANSI", demo:false, img:"⌨" },
  { id:"demo60", name:"Demo FUN60 60HE", tag:"DEMO", demo:true, img:"▥" },
  { id:"woot60", name:"Wooting 60HE v2", tag:"DEMO", demo:true, img:"▤" },
];

function DeviceThumb({ device, active, compact=false }) {
  return (
    <div style={{
      width: compact ? 38 : 52, height: compact ? 30 : 38, borderRadius:7,
      background:`linear-gradient(135deg, ${C.over}, ${C.nav})`,
      border:`1px solid ${active ? C.accent : C.bord}`,
      boxShadow: active ? `0 0 14px ${C.accent}33` : "inset 0 1px 0 rgba(255,255,255,.04)",
      display:"flex", alignItems:"center", justifyContent:"center",
      color: active ? C.accent : C.muted, fontSize: compact ? 14 : 18,
      transition:"border-color .18s, box-shadow .18s, color .18s, transform .18s",
    }}>{device.img}</div>
  );
}

function DevicePicker({ open, setOpen, activeDevice, setActiveDevice, setDemo }) {
  const current = DEVICE_OPTIONS.find(d => d.id === activeDevice) || DEVICE_OPTIONS[0];
  return (
    <div style={{ position:"relative" }}>
      <button onClick={()=>setOpen(!open)} style={{
        width:"100%", display:"flex", alignItems:"center", gap:10, padding:8,
        borderRadius:8, background:C.surf, border:`1px solid ${open?C.bordHv:C.bord}`,
        color:C.txt, cursor:"pointer", fontFamily:FONT, textAlign:"left",
        boxShadow: open ? `0 8px 24px rgba(0,0,0,.22)` : "none",
        transition:"border-color .16s, box-shadow .16s, background .16s",
      }}>
        <DeviceThumb device={current} active compact />
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:9, color:C.muted }}>My devices</div>
          <div style={{ fontSize:12, color:C.txt, fontWeight:800, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{current.name}</div>
        </div>
        <span style={{ color:C.muted, transform:open?"rotate(180deg)":"rotate(0deg)", transition:"transform .18s" }}>⌄</span>
      </button>

      {open && <div style={{
        position:"absolute", left:0, right:-12, top:"calc(100% + 8px)", zIndex:20,
        background:C.over, border:`1px solid ${C.bordHv}`, borderRadius:10,
        padding:8, display:"flex", flexDirection:"column", gap:7,
        boxShadow:"0 18px 50px rgba(0,0,0,.38)",
        animation:"deviceMenuIn .18s cubic-bezier(.22,1,.36,1)",
      }}>
        {DEVICE_OPTIONS.map(d => {
          const active = d.id === activeDevice;
          return (
            <button key={d.id} onClick={()=>{ setActiveDevice(d.id); setDemo(d.demo); setOpen(false); }} style={{
              display:"flex", alignItems:"center", gap:10, width:"100%", padding:8,
              borderRadius:8, border:`1px solid ${active?C.accent:"transparent"}`,
              background:active?C.activeBg:C.surf, color:C.txt, cursor:"pointer",
              fontFamily:FONT, textAlign:"left", transition:"transform .14s, border-color .14s, background .14s",
            }} onMouseEnter={e=>{e.currentTarget.style.transform="translateX(2px)"}} onMouseLeave={e=>{e.currentTarget.style.transform="translateX(0)"}}>
              <DeviceThumb device={d} active={active} />
              <div style={{ flex:1 }}>
                <div style={{ fontSize:12, fontWeight:800 }}>{d.name}</div>
                <div style={{ fontSize:10, color:C.muted }}>{d.tag}</div>
              </div>
              {active && <span style={{ color:C.accent, fontWeight:900 }}>✓</span>}
            </button>
          );
        })}
      </div>}
    </div>
  );
}


function ProfileIcon({ profile, size=48 }) {
  return (
    <div style={{
      width:size, height:size, borderRadius:"50%",
      border:`3px solid ${profile.color}`,
      boxShadow:`0 0 18px ${profile.color}88`,
      background: profile.image
        ? C.nav
        : profile.color === "#ef4444"
          ? "repeating-linear-gradient(45deg,#d7f7e8 0 7px,#ef4444 7px 11px,#d7f7e8 11px 18px)"
          : `linear-gradient(135deg,${C.over},${C.nav})`,
      color:C.txt, display:"flex", alignItems:"center", justifyContent:"center",
      fontSize:Math.round(size*.45), fontWeight:900, flexShrink:0,
      overflow:"hidden",
    }}>
      {profile.image ? (
        <img src={profile.image} alt="" style={{ width:"100%", height:"100%", objectFit:"cover", display:"block" }}/>
      ) : profile.icon}
    </div>
  );
}


function ProfileEditModal({ profile, open, onClose, onSave }) {
  const [name, setName] = useState(profile?.name || "");
  const [image, setImage] = useState(profile?.image || "");
  const [emojiIcon, setEmojiIcon] = useState(profile?.icon || "▣");
  const fileRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setName(profile?.name || "");
    setImage(profile?.image || "");
    setEmojiIcon(profile?.icon || "▣");
  }, [open, profile]);

  if (!open || !profile) return null;

  const readIconFile = file => {
    if (!file || !file.type?.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => setImage(String(reader.result || ""));
    reader.readAsDataURL(file);
  };

  const save = () => {
    const cleanName = name.trim() || profile.name || "Profile";
    onSave?.({ name: cleanName, icon: emojiIcon || "▣", image });
    onClose?.();
  };

  return (
    <>
      <div onClick={onClose} style={{ position:"fixed", inset:0, zIndex:180, background:"rgba(0,0,0,.55)", backdropFilter:"blur(2px)" }}/>
      <div style={{
        position:"fixed", zIndex:181, left:"50%", top:"50%", transform:"translate(-50%,-50%)",
        width:"min(520px,calc(100vw - 32px))", borderRadius:14,
        background:C.surf, border:`1px solid ${C.bordHv}`,
        boxShadow:"0 28px 90px rgba(0,0,0,.55)", padding:24,
        color:C.txt, animation:"deviceMenuIn .16s cubic-bezier(.22,1,.36,1)",
      }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:22 }}>
          <div>
            <div style={{ fontSize:24, fontWeight:900, letterSpacing:"-.02em" }}>Edit Profile</div>
            <div style={{ color:C.muted, marginTop:4 }}>Rename it or upload a custom icon from your PC.</div>
          </div>
          <button onClick={onClose} style={{ width:34, height:34, borderRadius:8, border:"none", background:C.over, color:C.muted, cursor:"pointer", fontSize:18 }}>×</button>
        </div>

        <div style={{ display:"grid", gridTemplateColumns:"110px 1fr", gap:22, alignItems:"start" }}>
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:12 }}>
            <ProfileIcon profile={{ ...profile, icon:emojiIcon, image }} size={86}/>
            <button onClick={()=>fileRef.current?.click()} style={{ width:"100%", padding:"10px 12px", borderRadius:8, border:"none", background:C.accent, color:C.atxt, fontFamily:FONT, fontWeight:900, cursor:"pointer" }}>Upload icon</button>
            <button onClick={()=>setImage("")} style={{ width:"100%", padding:"8px 10px", borderRadius:8, border:`1px solid ${C.bord}`, background:"transparent", color:C.muted, fontFamily:FONT, fontWeight:800, cursor:"pointer" }}>Remove image</button>
            <input ref={fileRef} type="file" accept="image/*" onChange={e=>readIconFile(e.target.files?.[0])} style={{ display:"none" }}/>
          </div>

          <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
            <label style={{ display:"flex", flexDirection:"column", gap:8 }}>
              <span style={{ color:C.sub, fontWeight:900 }}>Profile name</span>
              <input value={name} onChange={e=>setName(e.target.value)} autoFocus style={{
                height:46, borderRadius:8, border:`1px solid ${C.bord}`, background:C.over,
                color:C.txt, padding:"0 13px", fontFamily:FONT, fontWeight:900, fontSize:16,
                outline:"none",
              }}/>
            </label>
            <label style={{ display:"flex", flexDirection:"column", gap:8 }}>
              <span style={{ color:C.sub, fontWeight:900 }}>Fallback symbol</span>
              <input value={emojiIcon} maxLength={2} onChange={e=>setEmojiIcon(e.target.value)} style={{
                height:44, width:96, borderRadius:8, border:`1px solid ${C.bord}`, background:C.over,
                color:C.txt, padding:"0 13px", fontFamily:FONT, fontWeight:900, fontSize:20,
                textAlign:"center", outline:"none",
              }}/>
            </label>
            <div style={{ color:C.muted, lineHeight:1.45, fontSize:13 }}>
              Uploaded icons are stored in this app state as a Data URL. For now, this is UI-only; it does not write profile images to the keyboard firmware.
            </div>
          </div>
        </div>

        <div style={{ display:"flex", justifyContent:"flex-end", gap:10, marginTop:24 }}>
          <button onClick={onClose} style={{ padding:"10px 14px", borderRadius:8, border:`1px solid ${C.bord}`, background:"transparent", color:C.sub, fontFamily:FONT, fontWeight:900, cursor:"pointer" }}>Cancel</button>
          <button onClick={save} style={{ padding:"10px 16px", borderRadius:8, border:"none", background:C.accent, color:C.atxt, fontFamily:FONT, fontWeight:900, cursor:"pointer" }}>Save Profile</button>
        </div>
      </div>
    </>
  );
}

function ProfileActionMenu({ open, onClose, onEdit, onDuplicate, onToggleInactive, onboard }) {
  if (!open) return null;
  const items = [
    { label:"Edit Profile", action:onEdit },
    { label:"Duplicate", action:onDuplicate },
    { label:onboard ? "Move to Inactive Profiles" : "Move to Onboard Profiles", action:onToggleInactive },
    { label:"Share", action:()=>{} },
  ];
  return (
    <>
      <div onClick={onClose} style={{ position:"fixed", inset:0, zIndex:110 }}/>
      <div onClick={e=>e.stopPropagation()} style={{
        position:"absolute", top:54, right:10, zIndex:130, minWidth:270,
        background:C.over, border:`1px solid ${C.bordHv}`, borderRadius:9,
        padding:"14px 0", boxShadow:"0 18px 55px rgba(0,0,0,.46)",
        animation:"deviceMenuIn .14s cubic-bezier(.22,1,.36,1)",
      }}>
        {items.map(item => (
          <button key={item.label} onClick={e=>{ e.stopPropagation(); onClose(); item.action?.(); }} style={{
            width:"100%", border:"none", background:"transparent", color:C.txt,
            fontFamily:FONT, fontSize:18, fontWeight:800, textAlign:"left",
            padding:"16px 22px", cursor:"pointer", transition:"background .12s, color .12s",
          }} onMouseEnter={e=>{e.currentTarget.style.background=C.bord; e.currentTarget.style.color=C.txt;}}
             onMouseLeave={e=>{e.currentTarget.style.background="transparent";}}>
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}

function ProfileCard({ profile, index, active, onSelect, onDuplicate, onToggleInactive, onEdit }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div role="button" tabIndex={0} onClick={onSelect} onKeyDown={e=>{ if(e.key==="Enter" || e.key===" "){ e.preventDefault(); onSelect?.(); } }} style={{
      position:"relative", zIndex: menuOpen ? 120 : (active ? 2 : 1), minHeight:78, borderRadius:10, padding:"13px 16px",
      background: active ? C.over : C.surf,
      border:`1px solid ${active ? C.accent : C.bord}`,
      color:C.txt, fontFamily:FONT, cursor:"pointer", textAlign:"left",
      display:"flex", alignItems:"center", gap:16,
      boxShadow: menuOpen ? "0 22px 60px rgba(0,0,0,.36)" : (active ? `0 0 0 1px ${C.accent}22, inset 0 1px 0 rgba(255,255,255,.04)` : "inset 0 1px 0 rgba(255,255,255,.03)"),
      transition:"background .16s, border-color .16s, transform .16s, box-shadow .16s",
    }} onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-1px)"}} onMouseLeave={e=>{e.currentTarget.style.transform="translateY(0)"}}>
      <span style={{
        position:"absolute", top:8, left:8, width:24, height:24, borderRadius:"50%",
        background:C.bordHv, color:C.txt, display:"flex", alignItems:"center", justifyContent:"center",
        fontSize:13, fontWeight:900,
      }}>{index+1}</span>
      <ProfileIcon profile={profile}/>
      <div style={{ minWidth:0, flex:1, display:"flex", alignItems:"center", gap:10 }}>
        <span style={{ fontSize:18, fontWeight:900, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{profile.name}</span>
        <span style={{ padding:"3px 10px", borderRadius:12, background:C.bordHv, color:C.sub, fontSize:13, fontWeight:900 }}>{profile.fn}</span>
        <span style={{ padding:"3px 10px", borderRadius:12, background:C.bordHv, color:C.sub, fontSize:13, fontWeight:900 }}>{profile.badge}</span>
      </div>
      {profile.isDefault && <span style={{ padding:"5px 10px", borderRadius:8, background:C.accent, color:C.atxt, fontSize:13, fontWeight:900 }}>DEFAULT</span>}
      <button onClick={e=>{ e.stopPropagation(); setMenuOpen(v=>!v); }} style={{
        width:38, height:42, borderRadius:8, border:"none", background:menuOpen?C.bordHv:"transparent",
        color:menuOpen?C.accent:C.muted, fontSize:22, lineHeight:1, cursor:"pointer",
        display:"flex", alignItems:"center", justifyContent:"center",
      }}>⋮</button>
      <ProfileActionMenu
        open={menuOpen}
        onClose={()=>setMenuOpen(false)}
        onEdit={()=>onEdit?.(index)}
        onDuplicate={()=>onDuplicate?.(index)}
        onToggleInactive={()=>onToggleInactive?.(index)}
        onboard={profile.onboard}
      />
    </div>
  );
}

function MyProfilesPanel({ profiles, activeProfile, onSelect, onNewProfile, onDuplicateProfile, onToggleInactive, onEditProfile }) {
  const inactive = profiles.filter(p => !p.onboard);
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:22, padding:"4px 0 24px", animation:"fadeSlideUp .18s ease-out" }}>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:16 }}>
        <h1 style={{ margin:0, fontSize:30, color:C.txt, letterSpacing:"-.02em" }}>My Profiles</h1>
        <div style={{ display:"flex", gap:10 }}>
          <button style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 16px", borderRadius:8, border:"none", background:C.over, color:C.txt, fontFamily:FONT, fontSize:15, fontWeight:900, cursor:"pointer" }}>⇩ Import Profile</button>
          <button onClick={onNewProfile} style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 16px", borderRadius:8, border:"none", background:C.over, color:C.txt, fontFamily:FONT, fontSize:15, fontWeight:900, cursor:"pointer" }}>＋ New Profile</button>
        </div>
      </div>

      <section style={{ background:C.panel, border:`1px solid ${C.bord}`, borderRadius:10, padding:18 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
          <h2 style={{ margin:0, fontSize:20, color:C.txt }}>Onboard profiles</h2>
          <span style={{ width:24, height:24, borderRadius:"50%", border:`2px solid ${C.muted}`, color:C.muted, display:"flex", alignItems:"center", justifyContent:"center", fontWeight:900 }}>?</span>
          <span style={{ padding:"3px 8px", borderRadius:8, background:C.bordHv, color:C.txt, fontWeight:900 }}>{profiles.filter(p=>p.onboard).length} / 4</span>
        </div>
        <p style={{ margin:"0 0 18px", fontSize:18, color:C.sub }}>To load a profile onto your keyboard, drag and drop it into this section. To swap profiles, drag and drop them onto each other.</p>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(2,minmax(280px,1fr))", gap:16 }}>
          {profiles.filter(p=>p.onboard).map((prof,i)=><ProfileCard key={prof.name+i} profile={prof} index={i} active={activeProfile===i} onSelect={()=>onSelect(profiles.findIndex(p=>p===prof))} onDuplicate={onDuplicateProfile} onToggleInactive={onToggleInactive} onEdit={onEditProfile}/>) }
        </div>
        <div style={{ marginTop:16, border:`2px dashed ${C.bord}`, borderRadius:9, height:86, display:"flex", alignItems:"center", justifyContent:"center", color:C.muted, fontSize:18, fontWeight:700 }}>Drag & Drop a Profile here</div>
      </section>

      <section style={{ background:C.panel, border:`1px solid ${C.bord}`, borderRadius:10, padding:18 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:18 }}>
          <h2 style={{ margin:0, fontSize:20, color:C.txt }}>Inactive profiles</h2>
          <span style={{ width:24, height:24, borderRadius:"50%", border:`2px solid ${C.muted}`, color:C.muted, display:"flex", alignItems:"center", justifyContent:"center", fontWeight:900 }}>?</span>
        </div>
        {inactive.length ? <div style={{ display:"grid", gridTemplateColumns:"repeat(2,minmax(280px,1fr))", gap:16 }}>{inactive.map((prof,i)=><ProfileCard key={prof.name+i} profile={prof} index={profiles.findIndex(p=>p===prof)} active={false} onSelect={()=>onSelect(profiles.findIndex(p=>p===prof))} onDuplicate={onDuplicateProfile} onToggleInactive={onToggleInactive} onEdit={onEditProfile}/>)}</div> :
          <div style={{ border:`2px dashed ${C.bord}`, borderRadius:9, height:86, display:"flex", alignItems:"center", justifyContent:"center", color:C.muted, fontSize:18, fontWeight:700 }}>Drag & Drop a Profile here</div>}
      </section>
    </div>
  );
}

function ProfileDropdown({ profiles, activeProfile, open, onToggle, onSelect, onNewProfile, onEditProfile, onDuplicateProfile, onToggleInactive }) {
  const current = profiles[activeProfile] || profiles[0];
  return (
    <div style={{ position:"relative", width:"min(760px,62vw)" }}>
      <button onClick={onToggle} style={{
        width:"100%", height:62, border:"none", borderRadius:7, overflow:"hidden",
        background:C.surf, color:C.txt, fontFamily:FONT, cursor:"pointer",
        display:"grid", gridTemplateColumns:"68px 1fr 54px", alignItems:"center",
        boxShadow:"0 10px 25px rgba(0,0,0,.18)", textAlign:"left",
      }}>
        <div style={{ height:"100%", display:"flex", alignItems:"center", justifyContent:"center", background:`linear-gradient(135deg,${current.color}38,${C.surf})`, borderRight:`1px solid ${C.bord}` }}>
          <ProfileIcon profile={current} size={42}/>
        </div>
        <div style={{ padding:"0 18px", fontSize:15, fontWeight:900 }}>{current.name}</div>
        <div style={{ color:C.txt, textAlign:"center", fontSize:18, transform:open?"rotate(180deg)":"none", transition:"transform .16s" }}>⌃</div>
      </button>
      {open && <div style={{
        position:"absolute", top:"calc(100% + 12px)", left:0, right:0, zIndex:50,
        background:C.over, border:`1px solid ${C.bordHv}`, borderRadius:10, padding:18,
        boxShadow:"0 24px 70px rgba(0,0,0,.46)", animation:"deviceMenuIn .18s cubic-bezier(.22,1,.36,1)",
      }}>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 60px 160px", gap:10, marginBottom:16 }}>
          <div style={{ height:48, borderRadius:7, background:C.nav, display:"flex", alignItems:"center", gap:12, padding:"0 14px", color:C.muted, fontSize:20 }}><span>⌕</span><span style={{ fontSize:20 }}>Search</span></div>
          <button style={{ border:"none", borderRadius:7, background:C.bordHv, color:C.txt, fontSize:20, cursor:"pointer" }}>⇩</button>
          <button onClick={onNewProfile} style={{ border:"none", borderRadius:7, background:C.bordHv, color:C.txt, fontFamily:FONT, fontSize:18, fontWeight:900, cursor:"pointer" }}>New Profile</button>
        </div>
        <div style={{ color:C.muted, fontWeight:900, fontSize:14, marginBottom:10, textTransform:"uppercase" }}>Onboard profiles</div>
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          {profiles.filter(p=>p.onboard).map((prof,i)=><ProfileCard key={prof.name+i} profile={prof} index={i} active={activeProfile===i} onSelect={()=>{ onSelect(profiles.findIndex(p=>p===prof)); onToggle(false); }} onDuplicate={onDuplicateProfile} onToggleInactive={onToggleInactive} onEdit={onEditProfile}/>) }
        </div>
      </div>}
    </div>
  );
}

function IconRailButton({ item, active, onClick }) {
  return (
    <button onClick={onClick} title={item.tip} style={{
      width:42, height:42, borderRadius:10, border:"none", cursor:"pointer",
      color: active ? C.txt : C.muted,
      background: active ? C.activeBg : "transparent",
      display:"flex", alignItems:"center", justifyContent:"center",
      position:"relative", transition:"background .18s, color .18s, transform .18s",
    }} onMouseEnter={e=>{e.currentTarget.style.transform="translateX(2px)"}} onMouseLeave={e=>{e.currentTarget.style.transform="translateX(0)"}}>
      {active && <div style={{
        position:"absolute", left:2, width:3, height:22, borderRadius:3,
        background:C.accent, boxShadow:`0 0 10px ${C.accent}aa`,
        animation:"railSelect .2s cubic-bezier(.34,1.56,.64,1)",
      }}/>} 
      <span style={{ transform:active?"scale(1.08)":"scale(1)", transition:"transform .18s" }}>{item.icon}</span>
    </button>
  );
}

function SidebarNavItem({ icon, label, active, badge, onClick }) {
  return (
    <button onClick={onClick} style={{
      display:"flex", alignItems:"center", gap:10, width:"calc(100% - 16px)", margin:"2px 8px",
      padding:"9px 10px", borderRadius:8, border:`1px solid ${active?C.bordHv:"transparent"}`,
      background: active ? C.activeBg : "transparent", cursor:"pointer",
      fontFamily:FONT, fontSize:13, color: active ? C.txt : C.muted, fontWeight: active ? 800 : 600,
      textAlign:"left", position:"relative", overflow:"hidden",
      transition:"background .18s, color .18s, border-color .18s, transform .18s",
    }} onMouseEnter={e=>{e.currentTarget.style.transform="translateX(2px)"}} onMouseLeave={e=>{e.currentTarget.style.transform="translateX(0)"}}>
      {active && <div style={{
        position:"absolute", left:0, top:6, bottom:6, width:3, borderRadius:3,
        background:C.accent, boxShadow:`0 0 10px ${C.accent}99`, animation:"railSelect .2s cubic-bezier(.34,1.56,.64,1)",
      }}/>} 
      <span style={{ opacity: active ? 1 : .65, color: active ? C.accent : "currentColor", display:"flex" }}>{icon}</span>
      <span style={{ flex:1 }}>{label}</span>
      {badge && <ChipBadge label={badge} color={C.green}/>} 
    </button>
  );
}



function SettingsCategoryItem({ icon, label, active, badge, onClick }) {
  return (
    <button onClick={onClick} style={{
      width:"100%", display:"flex", alignItems:"center", gap:12,
      padding:"12px 14px", borderRadius:8, border:"none",
      background:active ? C.over : "transparent", color:active ? C.txt : C.sub,
      fontFamily:FONT, fontSize:15, fontWeight:active ? 900 : 700,
      cursor:"pointer", textAlign:"left", transition:"background .16s, color .16s, transform .16s",
    }} onMouseEnter={e=>{e.currentTarget.style.transform="translateX(2px)"}} onMouseLeave={e=>{e.currentTarget.style.transform="translateX(0)"}}>
      <span style={{ color:active ? C.accent : C.muted, display:"flex" }}>{icon}</span>
      <span style={{ flex:1 }}>{label}</span>
      {badge && <span style={{ background:C.accent, color:C.atxt, borderRadius:7, padding:"2px 7px", fontSize:11, fontWeight:900 }}>{badge}</span>}
    </button>
  );
}

function SettingsSidebar({ settingsCat, setSettingsCat, activeDevice }) {
  const current = DEVICE_OPTIONS.find(d => d.id === activeDevice) || DEVICE_OPTIONS[0];
  return (
    <>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:24 }}>
        <div style={{ fontSize:15, fontWeight:900, color:C.txt }}>Settings</div>
        <div style={{ color:C.muted, fontSize:14 }}>▣</div>
      </div>
      <div style={{ opacity:.48, marginBottom:28 }}>
        <button style={{
          width:"100%", display:"flex", alignItems:"center", gap:12, padding:12,
          borderRadius:10, background:C.over, border:`1px solid ${C.bord}`,
          color:C.txt, fontFamily:FONT, textAlign:"left", cursor:"default",
        }}>
          <DeviceThumb device={current} active={false}/>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:10, color:C.muted }}>Demo devices</div>
            <div style={{ fontSize:14, color:C.txt, fontWeight:900, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>Wooting 60HE...</div>
          </div>
          <span style={{ color:C.muted }}>⌄</span>
        </button>
      </div>

      <div style={{ fontSize:11, fontWeight:900, color:C.muted, margin:"0 14px 14px", letterSpacing:".02em" }}>Keyboard Settings</div>
      <SettingsCategoryItem icon={IC.kb} label="General Settings" active={settingsCat==="general"} onClick={()=>setSettingsCat("general")}/>
      <SettingsCategoryItem icon={IC.adv} label="Switch Selector" badge="NEW" active={settingsCat==="switch"} onClick={()=>setSettingsCat("switch")}/>

      <div style={{ fontSize:11, fontWeight:900, color:C.muted, margin:"30px 14px 14px", letterSpacing:".02em" }}>Updates</div>
      <SettingsCategoryItem icon={IC.rmp} label="Updates" active={settingsCat==="updates"} onClick={()=>setSettingsCat("updates")}/>

      <div style={{ fontSize:11, fontWeight:900, color:C.muted, margin:"30px 14px 14px", letterSpacing:".02em" }}>Appearance Settings</div>
      <SettingsCategoryItem icon={IC.rgb} label="Interface" active={settingsCat==="interface"} onClick={()=>setSettingsCat("interface")}/>

      <div style={{ flex:1 }}/>
      <div style={{ textAlign:"center", color:C.muted, fontSize:13, fontWeight:700, paddingBottom:4 }}>Fun60 Ultra tmr ultil v0.2.1</div>
    </>
  );
}

function SettingsCard({ children, style }) {
  return <div style={{ background:C.surf, border:`1px solid ${C.bord}`, borderRadius:8, padding:22, ...style }}>{children}</div>;
}

function SettingsPanel({ settingsCat, setSettingsCat, themeName, setThemeName, resolvedThemeName }) {
  const appearance = themeName === "system" ? `Following system (${resolvedThemeName === "light" ? "Light" : "Dark"})` : (themeName === "light" ? "Light Theme" : "Dark Theme");
  return (
    <div style={{ width:"min(760px,100%)", margin:"0 auto", padding:"26px 0 80px", animation:"fadeSlideUp .18s ease-out" }}>
      {settingsCat === "interface" && <>
        <h1 style={{ margin:"0 0 26px", fontSize:26, color:C.txt, letterSpacing:"-.02em" }}>Interface</h1>
        <div style={{ display:"flex", flexDirection:"column", gap:30 }}>
          <section>
            <h2 style={{ margin:"0 0 18px", color:C.sub, fontSize:20 }}>Language</h2>
            <button style={{ width:"100%", height:54, border:"none", borderRadius:7, background:C.over, color:C.txt, display:"flex", alignItems:"center", justifyContent:"space-between", padding:"0 20px", fontFamily:FONT, fontSize:15, fontWeight:800, cursor:"pointer" }}>
              English <span style={{ color:C.muted }}>⌄</span>
            </button>
            <SettingsCard style={{ marginTop:20, display:"flex", gap:14, alignItems:"flex-start", background:C.over }}>
              <div style={{ width:32, height:32, borderRadius:"50%", background:"rgba(59,130,246,.18)", color:C.blue, display:"flex", alignItems:"center", justifyContent:"center", fontWeight:900, flexShrink:0 }}>i</div>
              <div>
                <div style={{ fontWeight:900, color:C.txt, marginBottom:5 }}>These translations are made by ChatGPT for now.</div>
                <div style={{ color:C.sub, lineHeight:1.45 }}>Help improve translations, spot errors, or add your language in the github. <span style={{ color:C.accent, fontWeight:900 }}>Learn more</span></div>
              </div>
            </SettingsCard>
          </section>

          <div style={{ height:1, background:C.bord }}/>

          <section>
            <h2 style={{ margin:"0 0 20px", color:C.sub, fontSize:20 }}>Appearance</h2>
            <div style={{ display:"flex", gap:14, flexWrap:"wrap" }}>
              {[
                ["light", "☀", "Light Theme", false],
                ["dark", "☾", "Dark Theme", false],
                ["system", "ↄ", "Follow System", false],
              ].map(([id,icon,label,disabled]) => {
                const active = id === themeName;
                return <button key={id} disabled={disabled} onClick={()=>!disabled && setThemeName(id)} title={id === "system" ? "Follow your OS/browser color scheme" : label} style={{
                  width:124, height:96, borderRadius:8, border:`1px solid ${active?C.bordHv:C.bord}`,
                  background:active ? C.over : C.surf, color:disabled?C.muted:C.txt,
                  opacity:disabled?.55:1, cursor:disabled?"default":"pointer", fontFamily:FONT,
                  display:"flex", flexDirection:"column", justifyContent:"center", alignItems:"center", gap:10,
                  position:"relative",
                }}>
                  <span style={{ fontSize:28, color:active?C.accent:C.muted }}>{icon}</span>
                  <span style={{ fontSize:15, fontWeight:800 }}>{label}</span>
                  {id === "system" && <span style={{ position:"absolute", bottom:-18, background:active?C.accent:C.bordHv, color:active?C.atxt:C.sub, borderRadius:7, padding:"2px 7px", fontSize:10, fontWeight:900 }}>{active?"ACTIVE":"AUTO"}</span>}
                </button>
              })}
            </div>
          </section>
        </div>
      </>}

      {settingsCat === "general" && <>
        <h1 style={{ margin:"0 0 26px", fontSize:26, color:C.txt }}>General Settings</h1>
        <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
          <SettingsCard><div style={{ fontSize:18, fontWeight:900, marginBottom:8 }}>Keyboard name</div><div style={{ color:C.muted, marginBottom:14 }}>This only changes the name inside this web driver.</div><input defaultValue="FUN60 Ultra TMR" style={{ width:"100%", height:46, borderRadius:7, border:`1px solid ${C.bord}`, background:C.over, color:C.txt, padding:"0 14px", fontFamily:FONT, fontWeight:800 }}/></SettingsCard>
          <SettingsCard><div style={{ fontSize:18, fontWeight:900, marginBottom:8 }}>Factory reset</div><div style={{ color:C.muted, marginBottom:14 }}>Placeholder UI for now. Actual reset command is not wired.</div><button style={{ padding:"10px 14px", borderRadius:7, border:`1px solid ${C.red}`, background:"transparent", color:C.red, fontFamily:FONT, fontWeight:900 }}>Reset keyboard settings</button></SettingsCard>
        </div>
      </>}

      {settingsCat === "switch" && <>
        <h1 style={{ margin:"0 0 26px", fontSize:26, color:C.txt }}>Switch Selector</h1>
        <SettingsCard><div style={{ fontSize:18, fontWeight:900, marginBottom:8 }}>Magnetic switch type</div><div style={{ color:C.muted, marginBottom:18 }}>Choose a visual preset. This does not flash firmware.</div><div style={{ display:"grid", gridTemplateColumns:"repeat(2,minmax(180px,1fr))", gap:12 }}>{["TMR magnetic", "Hall effect", "Custom curve", "Factory default"].map((x,i)=><button key={x} style={{ padding:"16px", borderRadius:8, border:`1px solid ${i===0?C.accent:C.bord}`, background:i===0?C.activeBg:C.over, color:i===0?C.accent:C.txt, fontFamily:FONT, fontWeight:900, cursor:"pointer" }}>{x}</button>)}</div></SettingsCard>
      </>}

      {settingsCat === "updates" && <>
        <h1 style={{ margin:"0 0 26px", fontSize:26, color:C.txt }}>Updates</h1>
        <SettingsCard><div style={{ fontSize:18, fontWeight:900, marginBottom:8 }}>Driver version</div><div style={{ color:C.muted, marginBottom:18 }}>Local development build using the current React prototype.</div><div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}><span style={{ fontFamily:MONO, color:C.sub }}>v0.1.0-dev</span><button style={{ padding:"10px 14px", borderRadius:7, border:"none", background:C.accent, color:C.atxt, fontFamily:FONT, fontWeight:900 }}>Check for updates</button></div></SettingsCard>
      </>}
    </div>
  );
}

function HelpPanel() {
  return (
    <div style={{ width:"min(760px,100%)", margin:"0 auto", padding:"40px 0 80px" }}>
      <h1 style={{ margin:"0 0 20px", fontSize:30 }}>Help</h1>
      <SettingsCard><div style={{ fontSize:18, fontWeight:900, marginBottom:8 }}>Keyboard not connecting?</div><div style={{ color:C.muted, lineHeight:1.5 }}>Use Chrome or Edge, close the official driver, then reconnect the keyboard. Live HID may ask for a second device permission.</div></SettingsCard>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   MAIN APP
───────────────────────────────────────────────────────────────────────────── */
export default function App() {
  const [themeName, setThemeName] = useState("dark");
  const [systemTheme, setSystemTheme] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return "dark";
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });
  const [section, setSection]   = useState("quick");
  const [settingsCat, setSettingsCat] = useState("interface");
  const [profile, setProfile]   = useState(0);
  const [profiles, setProfiles] = useState(PROFILE_PRESETS);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState(null);
  const [selKeys, setSelKeys]   = useState(new Set());
  const [depths,  setDepths]    = useState({});
  const [demo,    setDemo]      = useState(false);
  const [activeDevice, setActiveDevice] = useState("fun60");
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
  const [profileSwitching, setProfileSwitching] = useState(false);

  // Hardware state — defaults match factory firmware
  const [ap,       setAp]       = useState(2.00);
  const [rtOn,     setRtOn]     = useState(false);
  const [sens,     setSens]     = useState(0.50);
  const [split,    setSplit]    = useState(false);
  const [press,    setPress]    = useState(0.50);
  const [rel,      setRel]      = useState(0.50);
  const [pollCode, setPollCode] = useState(0x03); // 1000Hz default
  const [ledOn,    setLedOn]    = useState(true);
  const [ledMode,  setLedMode]  = useState(0x03);
  const [ledSpeed, setLedSpeed] = useState(2);
  const [ledBri,   setLedBri]   = useState(4);
  const [ledR,     setLedR]     = useState(255);
  const [ledG,     setLedG]     = useState(255);
  const [ledB,     setLedB]     = useState(255);
  const [socdPairs, setSocdPairs] = useState([]); // [[keyId1, keyId2], ...] — UI-only grouping
  const [activeLayer, setActiveLayer] = useState("main");
  const [fnLayer, setFnLayer] = useState(() => cloneFnLayer(DEFAULT_FN1));
  const [fnLayerStatus, setFnLayerStatus] = useState("default");

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const update = e => setSystemTheme(e.matches ? "light" : "dark");
    update(mq);
    mq.addEventListener?.("change", update);
    mq.addListener?.(update);
    return () => {
      mq.removeEventListener?.("change", update);
      mq.removeListener?.(update);
    };
  }, []);


  // Full per-key arrays as read back from hardware (index = magIdx). Kept
  // separate from the single "global" values above so the keyboard preview
  // and per-key detail readouts can show real per-key state, not just
  // whatever the last slider drag happened to be.
  const [apByIdx,       setApByIdx]       = useState(null);
  const [liftByIdx,     setLiftByIdx]     = useState(null);
  const [rtPressByIdx,  setRtPressByIdx]  = useState(null);
  const [rtLiftByIdx,   setRtLiftByIdx]   = useState(null);
  const [modeByIdx,     setModeByIdx]     = useState(null);
  const [snaptapByIdx,  setSnaptapByIdx]  = useState(null);

  // Populate state from keyboard on connect
  const onSettings = useCallback(s => {
    if (!s) return;
    if (s.profile   !== undefined) setProfile(s.profile);
    if (s.pollingCode !== undefined) setPollCode(s.pollingCode);
    if (s.ledOn      !== undefined) setLedOn(s.ledOn);
    if (s.ledMode    !== undefined) setLedMode(s.ledMode);
    if (s.ledSpeed   !== undefined) setLedSpeed(Math.max(0, Math.min(4, s.ledSpeed)));
    if (s.ledBri     !== undefined) setLedBri(Math.max(0, Math.min(4, s.ledBri)));
    if (s.ledR       !== undefined) setLedR(s.ledR);
    if (s.ledG       !== undefined) setLedG(s.ledG);
    if (s.ledB       !== undefined) setLedB(s.ledB);
    if (s.mag) {
      // magIdx 0 is an unused matrix slot (no physical key maps to it — see
      // the keymap below, Esc starts at magIdx 1). Reading [0] as a "global"
      // representative value always returns 0, which is why AP/RT/RT-on
      // looked broken. Use Esc's real magIdx instead.
      const REF_IDX = 1;
      if (s.mag[MAG.PRESS])    { setApByIdx(s.mag[MAG.PRESS]);      setAp(cmm(s.mag[MAG.PRESS][REF_IDX])); }
      if (s.mag[MAG.LIFT])     setLiftByIdx(s.mag[MAG.LIFT]);
      if (s.mag[MAG.RT_PRESS]) { setRtPressByIdx(s.mag[MAG.RT_PRESS]); setSens(cmm(s.mag[MAG.RT_PRESS][REF_IDX])); }
      if (s.mag[MAG.RT_LIFT])  setRtLiftByIdx(s.mag[MAG.RT_LIFT]);
      if (s.mag[MAG.MODE])     { setModeByIdx(s.mag[MAG.MODE]);     setRtOn(s.mag[MAG.MODE][REF_IDX] === MODE.RAPID_TRIGGER); }
      if (s.mag[MAG.SNAPTAP_EN]) setSnaptapByIdx(s.mag[MAG.SNAPTAP_EN]);
    }
  }, []);



  const telemetryRateWindowRef = useRef([]);
  const telemetryRateLastUpdateRef = useRef(0);
  const [liveReportHz, setLiveReportHz] = useState(0);

  const onTelemetry = useCallback(t => {
    if (!t || !t.keyId) return;
    const now = performance.now();
    const win = telemetryRateWindowRef.current;
    win.push(now);
    while (win.length && now - win[0] > 1000) win.shift();
    if (now - telemetryRateLastUpdateRef.current > 200) {
      telemetryRateLastUpdateRef.current = now;
      setLiveReportHz(win.length);
    }
    // Real HID travel wins over demo animation when it is available.
    // Each 0x05/0x1B packet updates one key, so merge instead of replacing.
    setDepths(prev => {
      const next = { ...prev };
      if (t.normalized <= 0.01) delete next[t.keyId];
      else next[t.keyId] = t.normalized;
      return next;
    });
  }, []);

  const { hidOK, status, info, err, telemetry, telemetryFmt, connect, disconnect, send, dSend, openTelemetry, readSettings } = useKeyboard({ onSettings, onTelemetry });
  const connected = status === "connected";

  // Demo animation: simulated key travel driven by physical or pointer presses.
  const simFrameRef = useRef(null);
  const simDepthRef = useRef({});
  const simPressedRef = useRef(new Set());

  const setSimKey = useCallback((id, pressed) => {
    if (!demo || !id) return;
    if (pressed) simPressedRef.current.add(id);
    else simPressedRef.current.delete(id);
  }, [demo]);

  useEffect(() => {
    if (!demo || telemetry === "on") {
      cancelAnimationFrame(simFrameRef.current);
      simPressedRef.current.clear();
      simDepthRef.current = {};
      if (telemetry !== "on") setDepths({});
      return;
    }

    let last = performance.now();
    const tick = now => {
      const dt = Math.min(34, now - last) / 16.67;
      last = now;

      const next = { ...simDepthRef.current };
      const ids = new Set([...Object.keys(next), ...simPressedRef.current]);
      ids.forEach(id => {
        const k = ALL_KEYS.find(x => x.id === id);
        const apMm = k?.magIdx >= 0 && apByIdx?.[k.magIdx] != null ? cmm(apByIdx[k.magIdx]) : ap;
        // Normal browser keydown/keyup is digital, not analog. For demo mode,
        // ramp to the configured actuation point instead of faking a full
        // 4.00 mm bottom-out. This makes the visual feedback match what the
        // setting actually means.
        const target = simPressedRef.current.has(id) ? Math.max(0.03, Math.min(1, apMm / 4)) : 0;
        const current = next[id] || 0;
        const speed = target > current ? 0.22 : 0.20;
        const value = current + (target - current) * Math.min(1, speed * dt);
        if (target === 0 && value < 0.01) delete next[id];
        else next[id] = Math.max(0, Math.min(1, value));
      });

      simDepthRef.current = next;
      setDepths(next);
      simFrameRef.current = requestAnimationFrame(tick);
    };

    simFrameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(simFrameRef.current);
  }, [demo, telemetry, apByIdx, ap]);

  useEffect(() => {
    if (!demo) return;

    const isEditable = el =>
      el?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el?.tagName);
    const keyDown = e => {
      if (isEditable(e.target) || e.repeat) return;
      const id = KEY_CODE_TO_ID[e.code];
      if (!id) return;
      e.preventDefault();
      simPressedRef.current.add(id);
    };
    const keyUp = e => {
      const id = KEY_CODE_TO_ID[e.code];
      if (!id) return;
      e.preventDefault();
      simPressedRef.current.delete(id);
    };

    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
    };
  }, [demo]);

  const toggleKey = useCallback(id => {
    setSelKeys(p => { const s=new Set(p); s.has(id)?s.delete(id):s.add(id); return s; });
  }, []);

  const readFnLayer = useCallback(async (layer = 1) => {
    // GET_FN exists, but readback layout differs slightly across firmware. Try
    // the documented chunk indexes and accept either echoed payload-at-8 or raw.
    const chunks = [];
    for (let chunk = 0; chunk < 2; chunk++) {
      const r = await send(CMD.getFn(layer, chunk));
      const body = r?.[0] === 0x90 ? Array.from(r.slice(8, 64)) : Array.from(r || []);
      chunks.push(...body.slice(0, 56));
      await sleep(20);
    }
    const parsed = bytesToFnLayer(chunks);
    if (Object.keys(parsed).length) {
      setFnLayer(prev => ({ ...prev, ...parsed }));
      setFnLayerStatus("read from keyboard");
    }
    return parsed;
  }, [send]);

  const writeFnLayer = useCallback(async (layer = 1, nextLayer = fnLayer) => {
    const bytes = Array.from(fnLayerToBytes(nextLayer));
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 56) chunks.push(bytes.slice(i, i + 56));
    for (let chunk = 0; chunk < chunks.length; chunk++) {
      await send(CMD.setFnChunk(layer, chunk, chunks[chunk]));
      await sleep(70);
    }
    setFnLayerStatus("saved to keyboard");
  }, [send, fnLayer]);

  const switchLayer = useCallback(async layer => {
    setActiveLayer(layer);
    setSelKeys(new Set());
    if (layer === "fn1" && connected) {
      setFnLayerStatus("reading…");
      try { await readFnLayer(1); }
      catch (e) { console.warn("GET_FN failed", e); setFnLayerStatus("using local default"); }
    }
  }, [connected, readFnLayer]);

  const handleProfileChange = async i => {
    const slot = Math.max(0, Math.min(3, Number(i) || 0));
    setProfile(slot);
    setProfileMenuOpen(false);

    // Local/demo mode: just switch the visible active profile.
    if (!connected) return;

    setProfileSwitching(true);
    try {
      // SET_PROFILE = 0x04. GET_PROFILE = 0x84. The slot is 0–3.
      // After switching, firmware reloads that slot's config, so immediately
      // read everything back and apply it to the UI.
      await send(CMD.setProfile(slot));
      await sleep(120);

      const reply = await send(CMD.getProfile());
      const actual = (reply?.[1] ?? slot) & 0x03;
      setProfile(actual);

      const freshSettings = await readSettings();
      onSettings(freshSettings);
    } catch (e) {
      console.warn("profile switch failed:", e);
      // If the write/read fails, recover the real active slot when possible.
      try {
        const freshSettings = await readSettings();
        onSettings(freshSettings);
      } catch {}
    } finally {
      setProfileSwitching(false);
    }
  };

  const addProfile = () => {
    setProfiles(prev => [...prev, {
      name: `Profile ${prev.length + 1}`,
      badge: String(prev.length + 1), fn: "Fn 1", color: "#38bdf8", icon: "▣",
      onboard: prev.filter(p => p.onboard).length < 4,
      isDefault: false,
    }]);
    setSection("profiles");
  };

  const duplicateProfile = idx => {
    setProfiles(prev => {
      const src = prev[idx];
      if (!src) return prev;
      return [...prev, { ...src, name: `${src.name} Copy`, isDefault:false, onboard: prev.filter(p => p.onboard).length < 4 }];
    });
    setSection("profiles");
  };

  const toggleProfileInactive = idx => {
    setProfiles(prev => prev.map((p, i) => i === idx ? { ...p, onboard: !p.onboard, isDefault: p.isDefault && p.onboard ? false : p.isDefault } : p));
    if (profile === idx) setProfile(0);
  };

  const saveProfileEdit = updates => {
    if (editingProfile == null) return;
    setProfiles(prev => prev.map((p, i) => i === editingProfile ? { ...p, ...updates } : p));
  };

  const resolvedThemeName = themeName === "system" ? systemTheme : themeName;
  C = THEMES[resolvedThemeName] || THEMES.dark;
  const pColor = profiles[profile]?.color || PCOLORS[profile] || C.accent;
  const isLight = resolvedThemeName === "light";

  return (
    <div style={{ height:"100vh", background:C.bg, color:C.txt, fontFamily:FONT, fontSize:13, overflow:"hidden" }}>
      <link rel="preconnect" href="https://fonts.googleapis.com"/>
      <link href="https://fonts.googleapis.com/css2?family=Nunito+Sans:wght@400;600;700;800;900&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet"/>
      <ProfileEditModal profile={editingProfile == null ? null : profiles[editingProfile]} open={editingProfile != null} onClose={()=>setEditingProfile(null)} onSave={saveProfileEdit}/>

      <div style={{ display:"grid", gridTemplateColumns:"64px 318px 1fr", height:"100%", minWidth:1100 }}>
        {/* Wootility-style icon rail */}
        <aside style={{
          background:C.nav, borderRight:`1px solid ${C.bord}`,
          display:"flex", flexDirection:"column", alignItems:"center",
          padding:"10px 0", gap:9,
        }}>
          <div style={{
            width:40, height:30, marginBottom:8, border:`3px solid ${C.txt}`,
            color:C.txt, display:"flex", alignItems:"center", justifyContent:"center",
            fontWeight:900, fontSize:18, boxShadow:"inset 0 -2px 0 rgba(255,255,255,.16)",
          }}>▣</div>
          {[
            {id:"keyboard", icon:IC.kb, label:"Keyboard", go:()=>setSection("quick"), active:!["settings","help"].includes(section)},
            {id:"settings", icon:IC.gear, label:"Settings", go:()=>{ setSection("settings"); setSettingsCat("interface"); }, active:section==="settings"},
            {id:"help", icon:IC.help, label:"Help", go:()=>setSection("help"), active:section==="help"},
          ].map(item => (
            <button key={item.id} onClick={item.go} style={{
              width:48, minHeight:54, borderRadius:6, border:"none",
              background:item.active?C.over:"transparent", color:item.active?C.txt:C.muted,
              cursor:"pointer", fontFamily:FONT, display:"flex", flexDirection:"column",
              alignItems:"center", justifyContent:"center", gap:5, position:"relative",
              transition:"background .16s, color .16s, transform .16s",
            }} onMouseEnter={e=>{e.currentTarget.style.transform="translateX(2px)"}} onMouseLeave={e=>{e.currentTarget.style.transform="translateX(0)"}}>
              <span style={{ color:item.active?C.accent:C.muted, display:"flex", transform:item.active?"scale(1.05)":"scale(1)", transition:"transform .16s" }}>{item.icon}</span>
              <span style={{ fontSize:11, fontWeight:800, lineHeight:1 }}>{item.label}</span>
            </button>
          ))}
          <div style={{ flex:1 }}/>
          <button onClick={() => setThemeName(resolvedThemeName === "light" ? "dark" : "light")} style={{ width:38, height:38, borderRadius:8, border:"none", background:"transparent", color:C.muted, cursor:"pointer" }}>{isLight ? IC.moon : IC.sun}</button>
        </aside>

        {/* left configuration column */}
        <aside style={{ background:C.surf, borderRight:`1px solid ${C.bord}`, padding:20, display:"flex", flexDirection:"column", overflow:"visible" }}>
          {section === "settings" ? (
            <SettingsSidebar settingsCat={settingsCat} setSettingsCat={setSettingsCat} activeDevice={activeDevice}/>
          ) : section === "help" ? (
            <>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:24 }}>
                <div style={{ fontSize:15, fontWeight:900, color:C.txt }}>Help</div>
                <div style={{ color:C.muted, fontSize:14 }}>?</div>
              </div>
              <SidebarNavItem icon={IC.help} label="Connection Help" active={true} onClick={()=>setSection("help")}/>
              <SidebarNavItem icon={IC.kb} label="Back to Keyboard" active={false} onClick={()=>setSection("quick")}/>
              <div style={{ flex:1 }}/>
              <div style={{ textAlign:"center", color:C.muted, fontSize:13, fontWeight:700 }}>FUN60 Web Driver</div>
            </>
          ) : (
            <>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:20 }}>
                <div style={{ fontSize:15, fontWeight:900, color:C.txt }}>Keyboard Configuration</div>
                <div style={{ color:C.muted, fontSize:13 }}>▣</div>
              </div>

              <div style={{ marginBottom:20 }}>
                <DevicePicker open={deviceMenuOpen} setOpen={setDeviceMenuOpen}
                  activeDevice={activeDevice} setActiveDevice={setActiveDevice} setDemo={setDemo}/>
              </div>

              <div style={{ fontSize:11, fontWeight:900, color:C.muted, margin:"10px 12px 10px", letterSpacing:".03em" }}>Profiles</div>
              <SidebarNavItem icon={IC.kb} label="Quick Settings" active={section==="quick"} onClick={()=>setSection("quick")}/>
              <SidebarNavItem icon={IC.kb} label="My Profiles" active={section==="profiles"} onClick={()=>setSection("profiles")}/>

              <div style={{ fontSize:11, fontWeight:900, color:C.muted, margin:"26px 12px 10px", letterSpacing:".03em" }}>Keyboard Configuration</div>
              <SidebarNavItem icon={IC.tgt} label="Actuation Point" active={section==="ap"} onClick={()=>setSection("ap")}/>
              <SidebarNavItem icon={IC.bolt} label="Rapid Trigger" active={section==="rt"} onClick={()=>setSection("rt")}/>
              <SidebarNavItem icon={IC.rgb} label="RGB Settings" active={section==="rgb"} onClick={()=>setSection("rgb")}/>
              <SidebarNavItem icon={IC.rmp} label="Remap" active={section==="remap"} onClick={()=>setSection("remap")}/>
              <SidebarNavItem icon={IC.adv} label="Advanced Keys" active={section==="advanced"} onClick={()=>setSection("advanced")}/>

              <div style={{ flex:1 }}/>
              <div style={{ textAlign:"center", color:C.muted, fontSize:13, fontWeight:700, paddingBottom:4 }}>FUN60 Web Driver</div>
            </>
          )}
</aside>

        {/* main application area */}
        <main style={{ background:C.bg, overflow:"hidden", display:"flex", flexDirection:"column" }}>
          {/* floating top profile bar */}
          {!["settings","help"].includes(section) && <div style={{ height:82, flexShrink:0, position:"relative", display:"flex", justifyContent:"center", alignItems:"center", padding:"0 22px" }}>
            <ProfileDropdown profiles={profiles} activeProfile={profile} open={profileMenuOpen} onToggle={(v)=>setProfileMenuOpen(typeof v === "boolean" ? v : !profileMenuOpen)} onSelect={handleProfileChange} onNewProfile={addProfile} onEditProfile={setEditingProfile} onDuplicateProfile={duplicateProfile} onToggleInactive={toggleProfileInactive}/>
            {profileSwitching && <span style={{ marginLeft:10, fontSize:11, color:C.accent, fontWeight:800, fontFamily:MONO }}>switching…</span>}
            <div style={{ position:"absolute", right:20, display:"flex", alignItems:"center", gap:12 }}>
              <span style={{ color:C.bordHv, fontSize:18 }}>↶</span>
              <span style={{ color:C.bordHv, fontSize:18 }}>↷</span>
              <button onClick={()=>setDemo(d=>!d)} style={{ border:"none", borderRadius:6, background:demo?C.accent:C.over, color:demo?C.atxt:C.sub, padding:"10px 15px", fontFamily:FONT, fontWeight:900, cursor:"pointer" }}>{demo?"Exit Demo Mode":"Demo Mode"}</button>
            </div>
          </div>}

          <div style={{ flex:1, overflow:"auto", padding: section==="settings" || section==="help" ? "0 56px 28px" : "0 34px 34px" }}>
            <div style={{ width:"min(1240px,100%)", margin:"0 auto", display:"flex", flexDirection:"column", gap:18 }}>
              {!["settings","help"].includes(section) && <ConnectBanner hidOK={hidOK} status={status} info={info} err={err}
                telemetry={telemetry} telemetryFmt={telemetryFmt}
                onConnect={connect} onDisconnect={disconnect} onTelemetryConnect={openTelemetry}/>}

              {section==="settings" ? (
                <SettingsPanel settingsCat={settingsCat} setSettingsCat={setSettingsCat} themeName={themeName} setThemeName={setThemeName} resolvedThemeName={resolvedThemeName}/>
              ) : section==="help" ? (
                <HelpPanel/>
              ) : section==="profiles" ? (
                <MyProfilesPanel profiles={profiles} activeProfile={profile} onSelect={handleProfileChange} onNewProfile={addProfile} onDuplicateProfile={duplicateProfile} onToggleInactive={toggleProfileInactive} onEditProfile={setEditingProfile}/>
              ) : (<>
              {/* keyboard hero */}
              <div style={{ display:"grid", gridTemplateColumns:"118px minmax(720px,1fr)", alignItems:"center", gap:18 }}>
                <div style={{ alignSelf:"center" }}>
                  <div style={{ color:C.muted, fontSize:13, fontWeight:900, letterSpacing:".04em", marginBottom:8 }}>LAYERS <span style={{ opacity:.7 }}>ⓘ</span></div>
                  {[
                    ["main", "Main Layer"],
                    ["fn1", "Fn Layer 1"]
                  ].map(([id,label]) => {
                    const active = activeLayer === id;
                    return (
                    <button key={id} onClick={() => switchLayer(id)} style={{ width:"100%", marginBottom:8, padding:"12px 10px", borderRadius:6, border:`1px solid ${active?C.accent:"transparent"}`, background:active?C.activeBg:C.over, color:active?C.txt:C.muted, fontFamily:FONT, fontSize:12, fontWeight:900, display:"flex", justifyContent:"space-between", cursor:"pointer" }}>
                      <span>{label}</span><span>{id === "fn1" ? "Fn" : "⋮"}</span>
                    </button>
                    );
                  })}
                </div>

                <div style={{ display:"flex", justifyContent:"center", alignItems:"center", minHeight:286, overflow:"visible" }}>
                  <div style={{ transform:"scale(1.38)", transformOrigin:"center", filter:"drop-shadow(0 22px 28px rgba(0,0,0,.45))" }}>
                    <KeyboardViz keyDepths={depths} selectedKeys={selKeys}
                      onKeyClick={toggleKey}
                      onSimPress={id => setSimKey(id, true)}
                      onSimRelease={id => setSimKey(id, false)}
                      section={section} apByIdx={apByIdx} globalAp={ap}
                      rtPressByIdx={rtPressByIdx} globalSens={sens}
                      labelMap={activeLayer === "fn1" ? Object.fromEntries(Object.entries(fnLayer).map(([id, v]) => [id, v.label])) : null}/>
                  </div>
                </div>
              </div>

              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginTop:4 }}>
                <div style={{ fontSize:11, color:C.muted, fontWeight:900, letterSpacing:".04em", textTransform:"uppercase" }}>
                  {selKeys.size === 0
                    ? (section==="quick" ? "To adjust actuation point and rapid trigger, please select one or more keys first" : "Select one or more keys from the preview above")
                    : `${selKeys.size} key${selKeys.size>1?"s":""} selected`}
                </div>
                <div style={{ display:"flex", gap:8 }}>
                  <button onClick={()=>setSelKeys(new Set(ALL_KEYS.map(k=>k.id)))} style={{ padding:"8px 13px", borderRadius:6, border:"none", background:C.over, color:C.sub, fontSize:12, fontWeight:800, cursor:"pointer", fontFamily:FONT }}>Select all keys</button>
                  <button onClick={()=>setSelKeys(new Set())} disabled={selKeys.size===0} style={{ padding:"8px 13px", borderRadius:6, border:"none", background:C.surf, color: selKeys.size===0?C.muted:C.sub, fontSize:12, fontWeight:800, cursor:selKeys.size?"pointer":"default", fontFamily:FONT }}>Discard selection</button>
                </div>
              </div>

              {section==="quick" && (
                <>
                  <h1 style={{ margin:"2px 0 0", fontSize:22, lineHeight:1, color:C.txt }}>Quick Settings</h1>
                  <div style={{ display:"grid", gridTemplateColumns:"repeat(3,minmax(250px,1fr))", gap:16 }}>
                    <div style={{ background:C.surf, borderRadius:7, minHeight:330, border:`1px solid ${C.bord}`, padding:20 }}>
                      <APCard ap={ap} setAp={setAp} connected={connected} dSend={dSend} selectedKeys={selKeys} apByIdx={apByIdx} liftByIdx={liftByIdx} depths={depths}/>
                    </div>
                    <div style={{ background:C.surf, borderRadius:7, minHeight:330, border:`1px solid ${C.bord}`, padding:20 }}>
                      <RTCard rtOn={rtOn} setRtOn={setRtOn} sens={sens} setSens={setSens}
                        split={split} setSplit={setSplit} press={press} setPress={setPress}
                        rel={rel} setRel={setRel} connected={connected} dSend={dSend} selectedKeys={selKeys}
                        rtPressByIdx={rtPressByIdx} rtLiftByIdx={rtLiftByIdx}/>
                    </div>
                    <div style={{ background:C.surf, borderRadius:7, minHeight:330, border:`1px solid ${C.bord}`, padding:20 }}>
                      <PerfCard pollingCode={pollCode} setPollingCode={setPollCode} connected={connected} send={send} liveReportHz={liveReportHz}/>
                    </div>
                  </div>
                </>
              )}

              {section!=="quick" && (
                <div style={{ background:C.surf, borderRadius:8, border:`1px solid ${C.bord}`, overflow:"hidden", minHeight:370 }}>
                  <div style={{ height:54, display:"flex", alignItems:"center", justifyContent:"space-between", padding:"0 20px", borderBottom:`1px solid ${C.bord}` }}>
                    <div style={{ fontSize:18, fontWeight:900, color:C.txt }}>{section==="advanced" ? "Snappy Tappy (SOCD)" : section==="remap" ? (activeLayer === "fn1" ? "Fn Layer 1" : "Main Layer") : NAV.find(n=>n.id===section)?.tip}</div>
                    <div style={{ display:"flex", gap:8 }}>
                      <button style={{ padding:"7px 12px", border:"none", borderRadius:6, background:C.over, color:C.sub, fontSize:12, fontWeight:900, cursor:"pointer" }}>Cancel</button>
                      <button style={{ padding:"7px 12px", border:"none", borderRadius:6, background:selKeys.size?C.accent:"#282c30", color:selKeys.size?C.atxt:C.muted, fontSize:12, fontWeight:900, cursor:selKeys.size?"pointer":"default" }}>Continue</button>
                    </div>
                  </div>
                  <div style={{ padding:22 }}>
                    {section==="ap" && <APCard ap={ap} setAp={setAp} connected={connected} dSend={dSend} selectedKeys={selKeys} apByIdx={apByIdx} liftByIdx={liftByIdx} depths={depths}/>} 
                    {section==="rt" && <RTCard rtOn={rtOn} setRtOn={setRtOn} sens={sens} setSens={setSens}
                      split={split} setSplit={setSplit} press={press} setPress={setPress}
                      rel={rel} setRel={setRel} connected={connected} dSend={dSend} selectedKeys={selKeys}
                      rtPressByIdx={rtPressByIdx} rtLiftByIdx={rtLiftByIdx}/>} 
                    {section==="rgb" && <RGBPanel ledOn={ledOn} setLedOn={setLedOn} ledMode={ledMode} setLedMode={setLedMode}
                      ledR={ledR} setLedR={setLedR} ledG={ledG} setLedG={setLedG}
                      ledB={ledB} setLedB={setLedB} ledSpeed={ledSpeed} setLedSpeed={setLedSpeed}
                      ledBri={ledBri} setLedBri={setLedBri} connected={connected} dSend={dSend}/>} 
                    {section==="remap" && <RemapPanel selectedKeys={selKeys} activeLayer={activeLayer} fnLayer={fnLayer} setFnLayer={setFnLayer} connected={connected} send={send} writeFnLayer={writeFnLayer}/>} 
                    {section==="advanced" && (
                      <div style={{ display:"flex", flexDirection:"column", gap:18 }}>
                        <div>
                          <div style={{ fontSize:13, fontWeight:900, color:C.sub, marginBottom:5 }}>Select 2 keys from your keyboard or the preview above to assign Snappy Tappy (SOCD)</div>
                          <div style={{ color:C.muted, fontSize:12 }}>Snappy Tappy monitors the 2 selected keys and activates them based on your chosen settings.</div>
                        </div>
                        <div style={{ display:"flex", justifyContent:"center", gap:14, padding:"16px 0 26px" }}>
                          {[0,1].map(i => {
                            const chosen = [...selKeys][i];
                            const key = chosen ? ALL_KEYS.find(k=>k.id===chosen) : null;
                            return <div key={i} style={{ textAlign:"center" }}>
                              <div style={{ color:C.sub, fontSize:12, fontWeight:900, marginBottom:6 }}>Key {i+1}</div>
                              <div style={{ width:66, height:66, borderRadius:8, border:`1px dashed ${i===0?C.accent:C.bord}`, display:"flex", alignItems:"center", justifyContent:"center", color:key?C.txt:C.muted, background:C.surf, fontWeight:900 }}>{key?.l || "Assign"}</div>
                            </div>;
                          })}
                        </div>
                        <AdvancedPanel selectedKeys={selKeys} connected={connected} dSend={dSend} socdPairs={socdPairs} setSocdPairs={setSocdPairs}/>
                        <div style={{ display:"flex", alignItems:"center", gap:10, background:C.over, borderRadius:7, padding:"13px 14px", color:C.sub, fontSize:12 }}>
                          <span style={{ width:24, height:24, borderRadius:"50%", background:C.disabledBg, display:"flex", alignItems:"center", justifyContent:"center", color:C.accent }}>⚠</span>
                          Use of Snappy Tappy (SOCD) is prohibited in certain games, such as Counter-Strike 2. Use caution in competitive environments.
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
              </>)}
              <div style={{ height:22 }}/>
            </div>
          </div>
        </main>
      </div>

      <style>{`
        *{box-sizing:border-box}
        body{margin:0;background:${C.bg}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
        @keyframes popIn{0%{transform:scale(0);opacity:0}100%{transform:scale(1);opacity:1}}
        @keyframes fadeSlideUp{0%{opacity:0;transform:translateY(4px)}100%{opacity:1;transform:translateY(0)}}
        @keyframes fadeIn{0%{opacity:0}100%{opacity:1}}
        @keyframes deviceMenuIn{0%{opacity:0;transform:translateY(-6px) scale(.98)}100%{opacity:1;transform:translateY(0) scale(1)}}
        @keyframes railSelect{0%{transform:scaleY(.35);opacity:.2}100%{transform:scaleY(1);opacity:1}}
        ::-webkit-scrollbar{width:6px;height:6px}
        ::-webkit-scrollbar-track{background:${C.bg}}
        ::-webkit-scrollbar-thumb{background:${C.bordHv};border-radius:6px}
        button{outline:none; transition:opacity .12s, border-color .15s, color .15s, background .15s, transform .15s}
        button:active{transform:scale(.985)}
        input[type=range]{-webkit-appearance:none;appearance:none}
      `}</style>
    </div>
  );
}
