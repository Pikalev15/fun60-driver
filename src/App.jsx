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
const LED_MODES = { 0x00: "Off", 0x01: "Static", 0x02: "Breathing", 0x03: "Wave",
                    0x04: "Reactive", 0x05: "Rainbow", 0x06: "Spiral", 0x08: "Ripple" };

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
  setProfile:  p                          => pkt(0x04, [p]),
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
      const validCodes = new Set(Object.values(POLL));
      settings.pollingCode = validCodes.has(poll[2]) ? poll[2]
                            : validCodes.has(poll[1]) ? poll[1]
                            : poll[2];
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

  return { hidOK, status, info, err, telemetry, telemetryFmt, connect, disconnect, send, dSend, openTelemetry };
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

function Slider({ label, value, min, max, step, onChange, unit="mm", color=C.accent, noLabel, disabled }) {
  const pct = ((value-min)/(max-min))*100;
  const [drag, setDrag] = useState(false);
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:6, opacity: disabled ? .4 : 1 }}>
      {!noLabel && (
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline" }}>
          <span style={{ fontSize:11, color:C.muted, textTransform:"uppercase", letterSpacing:".06em" }}>{label}</span>
          <span style={{ fontFamily:MONO, fontSize:12, color, fontWeight:700, transition:"color .15s" }}>
            {Number(value).toFixed(2)}{unit}
          </span>
        </div>
      )}
      <div style={{ position:"relative", height:4, borderRadius:2, background:C.track }}>
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
  if (section === "ap") return hov_ ? "#7b74ff" : "#5B51FF";
  return hov_ ? C.keyHv : C.key;
}

function KeyboardViz({ keyDepths, selectedKeys, onKeyClick, onSimPress, onSimRelease, section, apByIdx, globalAp, rtPressByIdx, globalSens }) {
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
        <div style={{ position:"absolute", top:6, right:14, display:"flex", gap:5 }}>
          {[C.accent,"#5B51FF",C.green].map((c,i) => (
            <div key={i} style={{ width:5,height:5,borderRadius:"50%",background:c,opacity:.6,boxShadow:`0 0 4px ${c}` }}/>
          ))}
        </div>

        {ROWS.map((row, ri) => (
          <div key={ri} style={{ display:"flex", gap:G }}>
            {row.map(key => {
              const d   = keyDepths[key.id] || 0;
              const sel = selectedKeys.has(key.id);
              const hov_ = hov === key.id;
              const bg  = sectionKeyColor(section, key, d, sel, hov_, apByIdx, globalAp);
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
                    color: sel?C.selectedTxt:(section==="ap"?"#fff":(section==="quick"?"#fff":C.keyTxt)), userSelect:"none", lineHeight:1,
                    marginTop: showValueLabels ? 4 : 0,
                  }}>{key.l}</span>
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

function PerfCard({ pollingCode, setPollingCode, connected, dSend }) {
  const hz = POLL_HZ[pollingCode] ?? 1000;
  const RATES = [8000, 4000, 2000, 1000, 500, 250, 125];
  const handleRate = code => {
    setPollingCode(code);
    if (connected) dSend("poll", CMD.setPolling(code), 0);
  };
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
      <div>
        <div style={{ fontSize:14, fontWeight:700, color:C.txt }}>Tachyon Mode</div>
        <div style={{ fontSize:11, color:C.muted, marginTop:2 }}>
          Maximizes input speed by prioritizing keypress response.
        </div>
      </div>
      <div>
        <div style={{ fontSize:9, fontWeight:700, color:C.muted, letterSpacing:".07em", textTransform:"uppercase", marginBottom:6 }}>SCAN RATE</div>
        <div style={{ fontSize:22, fontWeight:800, color:C.accent }}>{hz >= 1000 ? `${hz/1000}K` : hz} Hz</div>
      </div>
      <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>
        {RATES.map(r => {
          const code = POLL[r];
          return (
            <button key={r} onClick={() => handleRate(code)} style={{
              padding:"4px 8px", borderRadius:4, border:`1px solid ${(POLL_HZ[pollingCode]??1000)===r?C.accent:C.bord}`,
              background:(POLL_HZ[pollingCode]??1000)===r?C.activeBg:"transparent",
              color:(POLL_HZ[pollingCode]??1000)===r?C.accent:C.muted,
              fontSize:10, fontFamily:MONO, cursor:"pointer",
              fontWeight:(POLL_HZ[pollingCode]??1000)===r?700:400,
            }}>{r>=1000?`${r/1000}K`:r}</button>
          );
        })}
      </div>
      {hz >= 2000 && (
        <div style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 11px",
          borderRadius:6, background:"rgba(74,222,128,.07)", border:"1px solid rgba(74,222,128,.2)" }}>
          <div style={{ width:16,height:16,borderRadius:"50%",background:C.green,
            display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,color:"#0d3320",fontWeight:800 }}>✓</div>
          <span style={{ fontSize:11, color:C.green, fontWeight:600 }}>True {hz >= 1000 ? `${hz/1000}K` : hz}Hz Polling Active</span>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   FULL SECTION PANELS
───────────────────────────────────────────────────────────────────────────── */
function RGBPanel({ ledOn, setLedOn, ledMode, setLedMode, ledR, setLedR, ledG, setLedG, ledB, setLedB,
                    ledSpeed, setLedSpeed, ledBri, setLedBri, connected, dSend }) {
  const MODES = Object.entries(LED_MODES);
  const apply = (mode, spd, bri, r, g, b) => {
    if (connected) dSend("led", CMD.setLedParam(mode, spd, bri, r, g, b));
  };
  const hex = `#${[ledR,ledG,ledB].map(v=>v.toString(16).padStart(2,"0")).join("")}`;
  const setHex = h => {
    const [r,g,b] = [1,3,5].map(i => parseInt(h.slice(i,i+2),16));
    setLedR(r); setLedG(g); setLedB(b);
    apply(ledMode, ledSpeed, ledBri, r, g, b);
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
            <button key={code} onClick={() => { setLedMode(+code); apply(+code,ledSpeed,ledBri,ledR,ledG,ledB); }} style={{
              padding:"6px 11px", border:`1px solid ${ledMode===+code?C.accent:C.bord}`,
              borderRadius:4, background:ledMode===+code?C.activeBg:"transparent",
              color:ledMode===+code?C.accent:C.muted, fontSize:12, textAlign:"left",
              fontFamily:FONT, cursor:"pointer",
            }}>{name}</button>
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
          <Slider label="Brightness" value={ledBri/7} min={0} max={1} step={1/7} unit=""
            onChange={v => { const b=Math.round(v*7); setLedBri(b); apply(ledMode,ledSpeed,b,ledR,ledG,ledB); }}/>
          <Slider label="Speed" value={ledSpeed/7} min={0} max={1} step={1/7} unit="" color="#a78bfa"
            onChange={v => { const s=Math.round(v*7); setLedSpeed(s); apply(ledMode,s,ledBri,ledR,ledG,ledB); }}/>
        </div>
      </div>}
    </div>
  );
}

function RemapPanel({ selectedKeys }) {
  const [cat, setCat] = useState("Standard");
  const cats = ["Standard","Modifier","Media","Macro","Layer","Disabled"];
  const selArr = [...selectedKeys];
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
      <div style={{ fontSize:13, fontWeight:700, color:C.txt }}>Key Remap</div>
      <div style={{ fontSize:12, color:C.muted }}>
        {selectedKeys.size===0 ? "Select a key above to remap it." : `Remapping ${selectedKeys.size} key${selectedKeys.size>1?"s":""}.`}
      </div>
      {selectedKeys.size>0 && <>
        <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}>
          {cats.map(c => (
            <button key={c} onClick={()=>setCat(c)} style={{
              padding:"5px 10px", border:`1px solid ${cat===c?C.accent:C.bord}`,
              borderRadius:4, background:cat===c?C.activeBg:"transparent",
              color:cat===c?C.accent:C.muted, fontSize:11, fontFamily:FONT, cursor:"pointer",
            }}>{c}</button>
          ))}
        </div>
        <div style={{ padding:"10px 14px", background:C.over, borderRadius:6,
          border:`1px solid ${C.bord}`, fontSize:12, color:C.muted,
          display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ color:C.accent, fontFamily:MONO, fontWeight:700 }}>
            {selArr.map(k=>ALL_KEYS.find(x=>x.id===k)?.l||k).join(", ")}
          </span>
          <span>→</span>
          <span>{cat==="Disabled"?"[disabled]":`[${cat}]`}</span>
          <button style={{ marginLeft:"auto", padding:"4px 11px",
            background:C.accent, color:C.atxt, border:"none", borderRadius:4,
            fontSize:11, fontWeight:700, fontFamily:FONT, cursor:"pointer" }}>Assign</button>
        </div>
      </>}
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

const PNAMES = ["Quick Settings","Profile 2","CS:GO","Valorant"];
const PCOLORS = ["#FFD45C","#a78bfa","#f97316","#38bdf8"];


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

/* ─────────────────────────────────────────────────────────────────────────────
   MAIN APP
───────────────────────────────────────────────────────────────────────────── */
export default function App() {
  const [themeName, setThemeName] = useState("dark");
  const [section, setSection]   = useState("quick");
  const [profile, setProfile]   = useState(0);
  const [selKeys, setSelKeys]   = useState(new Set());
  const [depths,  setDepths]    = useState({});
  const [demo,    setDemo]      = useState(false);
  const [activeDevice, setActiveDevice] = useState("fun60");
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);

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
    if (s.ledSpeed   !== undefined) setLedSpeed(s.ledSpeed);
    if (s.ledBri     !== undefined) setLedBri(s.ledBri);
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



  const onTelemetry = useCallback(t => {
    if (!t || !t.keyId) return;
    // Real HID travel wins over demo animation when it is available.
    // Each 0x05/0x1B packet updates one key, so merge instead of replacing.
    setDepths(prev => {
      const next = { ...prev };
      if (t.normalized <= 0.01) delete next[t.keyId];
      else next[t.keyId] = t.normalized;
      return next;
    });
  }, []);

  const { hidOK, status, info, err, telemetry, telemetryFmt, connect, disconnect, send, dSend, openTelemetry } = useKeyboard({ onSettings, onTelemetry });
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

  const handleProfileChange = i => {
    setProfile(i);
    if (connected) dSend("profile", CMD.setProfile(i), 0);
  };

  C = THEMES[themeName];
  const pColor = PCOLORS[profile];
  const isLight = themeName === "light";

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100vh",
      background:C.bg, color:C.txt, fontFamily:FONT, fontSize:13, overflow:"hidden" }}>
      <link rel="preconnect" href="https://fonts.googleapis.com"/>
      <link href="https://fonts.googleapis.com/css2?family=Nunito+Sans:wght@400;600;700;800;900&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet"/>

      <div style={{ display:"flex", flex:1, minHeight:0 }}>

        {/* ── ICON SIDEBAR ────────────────────────────────────────── */}
        <div style={{ width:64, flexShrink:0, background:C.nav,
          borderRight:`1px solid ${C.bord}`, display:"flex", flexDirection:"column",
          alignItems:"center", padding:"12px 0 10px", gap:4 }}>
          <div style={{ width:42, height:42, borderRadius:12, background:`linear-gradient(135deg,${C.accent},${C.accent}cc)`,
            display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:17, fontWeight:900, color:C.atxt, marginBottom:12, letterSpacing:"-1px",
            boxShadow:`0 10px 24px ${C.accent}22, inset 0 1px 0 rgba(255,255,255,.28)` }}>F</div>
          {NAV.map(n => <IconRailButton key={n.id} item={n} active={section===n.id} onClick={()=>setSection(n.id)}/>)}
          <div style={{ flex:1 }}/>
          <IconRailButton item={{icon:isLight ? IC.moon : IC.sun, tip:isLight ? "Switch to dark mode" : "Switch to light mode"}}
            active={false} onClick={() => setThemeName(isLight ? "dark" : "light")}/>
          <IconRailButton item={{icon:IC.help, tip:"Help"}} active={false} onClick={()=>{}}/>
        </div>

        {/* ── TEXT SIDEBAR ────────────────────────────────────────── */}
        <div style={{ width:250, flexShrink:0, background:C.panel,
          borderRight:`1px solid ${C.bord}`, display:"flex", flexDirection:"column", overflow:"visible" }}>
          <div style={{ padding:"14px 14px 10px", borderBottom:`1px solid ${C.bord}`, position:"relative" }}>
            <div style={{ fontSize:10, fontWeight:800, color:C.muted, letterSpacing:".08em",
              textTransform:"uppercase", marginBottom:9 }}>Keyboard Configuration</div>
            <DevicePicker open={deviceMenuOpen} setOpen={setDeviceMenuOpen}
              activeDevice={activeDevice} setActiveDevice={setActiveDevice} setDemo={setDemo}/>
          </div>

          <div style={{ padding:"10px 14px 4px" }}>
            <div style={{ fontSize:10, fontWeight:700, color:C.muted, letterSpacing:".06em", textTransform:"uppercase", marginBottom:4 }}>Profiles</div>
          </div>
          {[0,1,2,3].map(i => (
            <button key={i} onClick={()=>handleProfileChange(i)} style={{
              display:"flex", alignItems:"center", gap:8, width:"100%", padding:"6px 14px",
              background: profile===i&&section==="quick" ? C.activeBg : "transparent",
              border:"none", borderLeft:`2px solid ${profile===i&&section==="quick"?C.accent:"transparent"}`,
              cursor:"pointer", fontFamily:FONT, fontSize:12,
              color: profile===i?C.txt:C.muted,
            }}>
              <div style={{ width:8,height:8,borderRadius:"50%",
                background: i===profile?C.green:C.bord,
                boxShadow: i===profile?`0 0 5px ${C.green}99`:"none" }}/>
              {PNAMES[i]}
            </button>
          ))}

          <div style={{ padding:"12px 14px 4px", marginTop:4, borderTop:`1px solid ${C.bord}` }}>
            <div style={{ fontSize:10, fontWeight:700, color:C.muted, letterSpacing:".06em", textTransform:"uppercase" }}>
              Configuration
            </div>
          </div>
          <SidebarNavItem icon={IC.tgt} label="Actuation Point" active={section==="ap"} onClick={()=>setSection("ap")}/>
          <SidebarNavItem icon={IC.bolt} label="Rapid Trigger"  active={section==="rt"} onClick={()=>setSection("rt")}/>
          <SidebarNavItem icon={IC.rgb} label="RGB Settings"   active={section==="rgb"} onClick={()=>setSection("rgb")}/>
          <SidebarNavItem icon={IC.rmp} label="Remap"          active={section==="remap"} onClick={()=>setSection("remap")}/>
          <SidebarNavItem icon={IC.adv} label="Advanced Keys"  active={section==="advanced"} onClick={()=>setSection("advanced")} badge="DKS"/>

          <div style={{ flex:1 }}/>
          <div style={{ padding:"8px 14px", fontSize:9, color:C.bord, borderTop:`1px solid ${C.bord}` }}>
            Wootility v5.3.1 clone
          </div>
        </div>

        {/* ── MAIN CONTENT ─────────────────────────────────────────── */}
        <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden" }}>
          {/* topbar */}
          <div style={{ height:52, flexShrink:0, background:C.panel,
            borderBottom:`1px solid ${C.bord}`,
            display:"flex", alignItems:"center", padding:"0 20px", gap:12 }}>
            <div style={{ width:32,height:32,borderRadius:"50%",
              background:`linear-gradient(135deg,${pColor},${pColor}99)`,
              display:"flex",alignItems:"center",justifyContent:"center",
              fontSize:14,fontWeight:900,color:C.atxt,boxShadow:`0 0 8px ${pColor}66` }}>
              {PNAMES[profile][0]}
            </div>
            <div style={{ fontSize:14, fontWeight:700, color:C.txt }}>{PNAMES[profile]}</div>
            <button style={{ padding:"4px 10px 4px 12px", border:`1px solid ${C.bord}`,
              borderRadius:4, background:C.surf, color:C.sub, fontSize:11,
              cursor:"pointer", fontFamily:FONT, display:"flex", alignItems:"center", gap:5 }}>
              Mode <span style={{ color:C.muted }}>▾</span>
            </button>
            <div style={{ flex:1 }}/>

            {/* demo */}
            <button onClick={()=>setDemo(d=>!d)} style={{
              padding:"4px 10px", border:`1px solid ${demo?C.accent:C.bord}`,
              borderRadius:4, background:demo?C.activeBg:"transparent",
              color:demo?C.accent:C.muted, fontSize:10, fontWeight:700,
              cursor:"pointer", fontFamily:FONT, letterSpacing:".05em",
            }}>{demo?"◉ DEMO":"○ DEMO"}</button>

            {["↩","↪"].map((a,i) => (
              <button key={i} style={{ width:30,height:30,borderRadius:4,
                border:`1px solid ${C.bord}`,background:"transparent",
                color:C.muted,cursor:"pointer",fontSize:15 }}>{a}</button>
            ))}

            <button onClick={() => connected ? dSend("save-profile", CMD.setProfile(profile), 0) : null}
              style={{ display:"flex",alignItems:"center",gap:6,
                padding:"6px 14px",borderRadius:4,
                background: connected ? C.accent : C.disabledBg,
                border:"none", color: connected ? C.atxt : C.disabledTxt,
                fontSize:12,fontWeight:700,cursor:connected?"pointer":"default",
                fontFamily:FONT,
                boxShadow: connected ? `0 0 10px ${C.accent}55` : "none" }}>
              🔒 Save to Keyboard
            </button>
          </div>

          {/* scroll area */}
          <div style={{ flex:1, overflow:"auto", padding:"18px 22px",
            display:"flex", flexDirection:"column", gap:14 }}>

            {/* connection banner */}
            <ConnectBanner hidOK={hidOK} status={status} info={info} err={err}
              telemetry={telemetry} telemetryFmt={telemetryFmt}
              onConnect={connect} onDisconnect={disconnect} onTelemetryConnect={openTelemetry}/>

            {/* keyboard */}
            <KeyboardViz keyDepths={depths} selectedKeys={selKeys}
              onKeyClick={toggleKey}
              onSimPress={id => setSimKey(id, true)}
              onSimRelease={id => setSimKey(id, false)}
              section={section} apByIdx={apByIdx} globalAp={ap}
              rtPressByIdx={rtPressByIdx} globalSens={sens}/>

            {/* select all / discard — sits with the section title, matching reference */}
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginTop:-4 }}>
              <span style={{ fontSize:10, color:C.muted, letterSpacing:".04em" }}>
                {selKeys.size === 0
                  ? (section==="ap"||section==="rt"||section==="remap"||section==="advanced"
                      ? "SELECT ONE OR MORE KEYS TO CONFIGURE PER-KEY SETTINGS" : "")
                  : `${selKeys.size} KEY${selKeys.size>1?"S":""} SELECTED`}
              </span>
              <div style={{ display:"flex", gap:6 }}>
                <button onClick={()=>setSelKeys(new Set(ALL_KEYS.map(k=>k.id)))} style={{
                  padding:"4px 11px", borderRadius:4, border:`1px solid ${C.bord}`,
                  background:"transparent", color:C.sub, fontSize:11, cursor:"pointer", fontFamily:FONT,
                  transition:"border-color .15s, color .15s",
                }}>Select all keys</button>
                <button onClick={()=>setSelKeys(new Set())} disabled={selKeys.size===0} style={{
                  padding:"4px 11px", borderRadius:4, border:`1px solid ${C.bord}`,
                  background:"transparent", color: selKeys.size===0?C.disabledTxt:C.sub, fontSize:11,
                  cursor: selKeys.size===0?"default":"pointer", fontFamily:FONT,
                  opacity: selKeys.size===0?.5:1, transition:"opacity .15s",
                }}>Discard selection</button>
              </div>
            </div>

            {/* section title */}
            <div style={{ fontSize:18, fontWeight:800, color:C.txt, marginTop:2 }}>
              {NAV.find(n=>n.id===section)?.tip ?? "Quick Settings"}
            </div>

            {/* quick settings: 3-card grid */}
            {section==="quick" && (
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(260px,1fr))", gap:12 }}>
                {[
                  <APCard   ap={ap} setAp={setAp} connected={connected} dSend={dSend} selectedKeys={selKeys} apByIdx={apByIdx} liftByIdx={liftByIdx} depths={depths}/>,
                  <RTCard   rtOn={rtOn} setRtOn={setRtOn} sens={sens} setSens={setSens}
                            split={split} setSplit={setSplit} press={press} setPress={setPress}
                            rel={rel} setRel={setRel} connected={connected} dSend={dSend} selectedKeys={selKeys}
                            rtPressByIdx={rtPressByIdx} rtLiftByIdx={rtLiftByIdx}/>,
                  <PerfCard pollingCode={pollCode} setPollingCode={setPollCode} connected={connected} dSend={dSend}/>,
                ].map((card,i) => (
                  <div key={i} style={{ background:C.surf, borderRadius:8,
                    border:`1px solid ${C.bord}`, padding:16 }}>{card}</div>
                ))}
              </div>
            )}

            {/* other panels */}
            {section !== "quick" && (
              <div style={{ background:C.surf, borderRadius:8, border:`1px solid ${C.bord}`, padding:20 }}>
                {section==="ap"       && <APCard ap={ap} setAp={setAp} connected={connected} dSend={dSend} selectedKeys={selKeys} apByIdx={apByIdx} liftByIdx={liftByIdx} depths={depths}/>}
                {section==="rt"       && <RTCard rtOn={rtOn} setRtOn={setRtOn} sens={sens} setSens={setSens}
                                           split={split} setSplit={setSplit} press={press} setPress={setPress}
                                           rel={rel} setRel={setRel} connected={connected} dSend={dSend} selectedKeys={selKeys}
                                           rtPressByIdx={rtPressByIdx} rtLiftByIdx={rtLiftByIdx}/>}
                {section==="rgb"      && <RGBPanel ledOn={ledOn} setLedOn={setLedOn} ledMode={ledMode} setLedMode={setLedMode}
                                           ledR={ledR} setLedR={setLedR} ledG={ledG} setLedG={setLedG}
                                           ledB={ledB} setLedB={setLedB} ledSpeed={ledSpeed} setLedSpeed={setLedSpeed}
                                           ledBri={ledBri} setLedBri={setLedBri} connected={connected} dSend={dSend}/>}
                {section==="remap"    && <RemapPanel selectedKeys={selKeys}/>}
                {section==="advanced" && <AdvancedPanel selectedKeys={selKeys} connected={connected} dSend={dSend} socdPairs={socdPairs} setSocdPairs={setSocdPairs}/>}
              </div>
            )}
            <div style={{ height:20 }}/>
          </div>
        </div>
      </div>

      <style>{`
        *{box-sizing:border-box}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
        @keyframes popIn{0%{transform:scale(0);opacity:0}100%{transform:scale(1);opacity:1}}
        @keyframes fadeSlideUp{0%{opacity:0;transform:translateY(4px)}100%{opacity:1;transform:translateY(0)}}
        @keyframes fadeIn{0%{opacity:0}100%{opacity:1}}
        @keyframes deviceMenuIn{0%{opacity:0;transform:translateY(-6px) scale(.98)}100%{opacity:1;transform:translateY(0) scale(1)}}
        @keyframes railSelect{0%{transform:scaleY(.35);opacity:.2}100%{transform:scaleY(1);opacity:1}}
        ::-webkit-scrollbar{width:5px}
        ::-webkit-scrollbar-track{background:${C.bg}}
        ::-webkit-scrollbar-thumb{background:${C.bord};border-radius:3px}
        button{outline:none; transition:opacity .12s, border-color .15s, color .15s, background .15s}
        button:active{transform:scale(.97)}
        input[type=range]{-webkit-appearance:none;appearance:none}
      `}</style>
    </div>
  );
}
