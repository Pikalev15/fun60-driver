import { useState, useEffect, useRef, useCallback } from "react";

/* ─────────────────────────────────────────────────────────────────────────────
   PROTOCOL  (ry5088 — extracted from github.com/dot-agi/ry5088-flasher)
───────────────────────────────────────────────────────────────────────────── */
const VID = 0x3151, PID = 0x5030, USAGE_PAGE = 0xFFFF, DEV_ID = 2307;
const RL  = 64; // report length

const MAG = { PRESS: 0x00, LIFT: 0x01, RT_PRESS: 0x02, RT_LIFT: 0x03, MODE: 0x07 };
const MODE = { NORMAL: 0, RT: 1, DKS: 2, MODTAP: 3, TOGGLE: 4, SNAPTAP: 5 };
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
  setLedOn:    on                         => pkt(0x05, [on ? 1 : 0]),
  getLedParam: ()                         => pkt(0x87),
  setLedParam: (mode, spd, bri, r, g, b)  => {
    const p = new Uint8Array(RL);
    p[0]=0x07; p[1]=mode; p[2]=spd; p[3]=bri; p[4]=0; p[5]=r; p[6]=g; p[7]=b;
    return bit8(p);
  },
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
  if (sub === MAG.MODE) { for (let i = 0; i < 64; i++) out.push(r[i]); }
  else                  { for (let i = 0; i < 32; i++) out.push(r[i*2] | (r[i*2+1] << 8)); }
  return out;
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
function useKeyboard({ onSettings }) {
  const dev      = useRef(null);
  const debounce = useRef({});
  const [status, setStatus] = useState("idle"); // idle|connecting|connected|error
  const [info,   setInfo]   = useState(null);
  const [err,    setErr]    = useState(null);
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
      const poll = await send(CMD.getPolling()); settings.pollingCode = poll[2];
      const lon  = await send(CMD.getLedOn());   settings.ledOn = lon[1] === 1;
      const lp   = await send(CMD.getLedParam());
      settings.ledMode = lp[1]; settings.ledSpeed = lp[2]; settings.ledBri = lp[3];
      settings.ledR = lp[5]; settings.ledG = lp[6]; settings.ledB = lp[7];

      // Magnetism — 2 pages per sub-command
      const mag = {};
      for (const sub of [MAG.PRESS, MAG.LIFT, MAG.RT_PRESS, MAG.RT_LIFT]) {
        const p0 = await send(CMD.getMag(sub, 0));
        const p1 = await send(CMD.getMag(sub, 1));
        mag[sub] = [...parseMagPage(p0, sub), ...parseMagPage(p1, sub)];
      }
      const m0 = await send(CMD.getMag(MAG.MODE, 0));
      const m1 = await send(CMD.getMag(MAG.MODE, 1));
      mag[MAG.MODE] = [...parseMagPage(m0, MAG.MODE), ...parseMagPage(m1, MAG.MODE)];
      settings.mag = mag;
      return settings;
    } catch (e) { console.warn("readSettings partial failure:", e); return {}; }
  }, [send]);

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
      setInfo(infor); setStatus("connected");
      device.addEventListener("disconnect", () => {
        dev.current = null; setStatus("idle"); setInfo(null);
      });
      const s = await readSettings(); onSettings?.(s);
    } catch (e) { setStatus("error"); setErr(e.message); dev.current = null; }
  }, [hidOK, send, readSettings, onSettings]);

  const disconnect = useCallback(async () => {
    try { await dev.current?.close(); } catch {}
    dev.current = null; setStatus("idle"); setInfo(null);
  }, []);

  return { hidOK, status, info, err, connect, disconnect, send, dSend };
}

/* ─────────────────────────────────────────────────────────────────────────────
   PRIMITIVES
───────────────────────────────────────────────────────────────────────────── */
function Toggle({ on, onChange }) {
  return (
    <div onClick={() => onChange(!on)} style={{
      width:40, height:22, borderRadius:11, cursor:"pointer", flexShrink:0,
      background: on ? C.accent : C.track, position:"relative",
      transition:"background .18s",
      boxShadow: on ? `0 0 8px ${C.accent}55` : "none",
    }}>
      <div style={{
        position:"absolute", top:3, left: on ? 21 : 3,
        width:16, height:16, borderRadius:8,
        background: on ? C.atxt : "#9aa0a6",
        transition:"left .18s", boxShadow:"0 1px 3px rgba(0,0,0,.5)",
      }}/>
    </div>
  );
}

function Slider({ label, value, min, max, step, onChange, unit="mm", color=C.accent, noLabel, disabled }) {
  const pct = ((value-min)/(max-min))*100;
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:6, opacity: disabled ? .4 : 1 }}>
      {!noLabel && (
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline" }}>
          <span style={{ fontSize:11, color:C.muted, textTransform:"uppercase", letterSpacing:".06em" }}>{label}</span>
          <span style={{ fontFamily:MONO, fontSize:12, color, fontWeight:700 }}>
            {Number(value).toFixed(2)}{unit}
          </span>
        </div>
      )}
      <div style={{ position:"relative", height:4, borderRadius:2, background:C.track }}>
        <div style={{ position:"absolute", left:0, width:`${pct}%`, height:"100%", borderRadius:2, background:color }}/>
        <div style={{
          position:"absolute", top:"50%", left:`${pct}%`,
          transform:"translate(-50%,-50%)", width:14, height:14, borderRadius:7,
          background:C.surf, border:`2.5px solid ${color}`, pointerEvents:"none",
        }}/>
        <input type="range" min={min} max={max} step={step} value={value}
          disabled={disabled}
          onChange={e => onChange(parseFloat(e.target.value))}
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
function ConnectBanner({ hidOK, status, info, err, onConnect, onDisconnect }) {
  if (status === "connected") return (
    <div style={{
      display:"flex", alignItems:"center", gap:10,
      padding:"8px 16px", background:"rgba(74,222,128,.06)",
      border:`1px solid rgba(74,222,128,.2)`, borderRadius:7,
    }}>
      <div style={{ width:8, height:8, borderRadius:4, background:C.green, boxShadow:`0 0 6px ${C.green}` }}/>
      <span style={{ fontSize:12, color:C.green, fontWeight:600 }}>Connected</span>
      {info && <span style={{ fontSize:11, color:C.muted, fontFamily:MONO }}>{info.version} · dev_id {info.devId}</span>}
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
    }}>
      <div style={{ width:8, height:8, borderRadius:4, background: status==="connecting" ? C.accent : C.muted,
        animation: status==="connecting" ? "pulse 1s infinite" : "none" }}/>
      <span style={{ fontSize:12, color: err ? C.red : C.muted }}>
        {status==="connecting" ? "Connecting…" : err ? `Error: ${err}` : "No keyboard connected"}
      </span>
      <span style={{ fontSize:11, color:C.muted }}>
        {!err && "Settings shown are defaults until connected."}
      </span>
      <button onClick={onConnect} disabled={status==="connecting"} style={{
        marginLeft:"auto", display:"flex", alignItems:"center", gap:6,
        padding:"6px 14px", borderRadius:4,
        background: C.accent, border:"none", color:C.atxt,
        fontSize:12, fontWeight:700, cursor: status==="connecting" ? "wait" : "pointer",
        fontFamily:FONT, boxShadow:`0 0 10px ${C.accent}44`,
        opacity: status==="connecting" ? .6 : 1,
      }}>
        🔌 Connect Keyboard
      </button>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   KEYBOARD VIZ
───────────────────────────────────────────────────────────────────────────── */
function KeyboardViz({ keyDepths, selectedKeys, onKeyClick, onSelectAll, onDeselect }) {
  const [hov, setHov] = useState(null);
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:0 }}>
      {/* body */}
      <div style={{
        background:C.kbBody, borderRadius:"10px 10px 14px 14px",
        padding:"12px 13px 16px", display:"inline-flex", flexDirection:"column", gap:G,
        border:`1px solid ${C.kbBord}`,
        boxShadow:C.shadow,
        position:"relative",
      }}>
        {/* status LEDs */}
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
              const bg  = sel ? (hov_ ? C.keySlH : C.keySel)
                        : d > 0.02 ? C.keyDepthBg(d)
                        : hov_ ? C.keyHv : C.key;
              return (
                <button key={key.id}
                  onClick={() => onKeyClick(key.id)}
                  onMouseEnter={() => setHov(key.id)}
                  onMouseLeave={() => setHov(null)}
                  title={`${key.l||"Space"} · idx ${key.magIdx}${key.shared?" (shared)":""} · ${(d*4).toFixed(2)}mm`}
                  style={{
                    width:kw(key.u), height:38, borderRadius:4, flexShrink:0,
                    background:bg, border:"none", padding:0, cursor:"pointer",
                    outline: sel ? `2px solid rgba(91,81,255,.8)` : "none", outlineOffset:-1,
                    boxShadow: d>0.02 ? C.keyDepthShadow(d) : C.keyRestShadow,
                    display:"flex", flexDirection:"column",
                    alignItems:"center", justifyContent:"center",
                    position:"relative", overflow:"hidden",
                    transform: d>0 ? `translateY(${Math.round(d*2)}px)` : "none",
                    transition:"background .06s",
                  }}
                >
                  {/* depth bar */}
                  {d > 0.02 && <div style={{
                    position:"absolute", bottom:0, left:0,
                    width:`${d*100}%`, height:2,
                    background: sel ? C.selectedMark : C.keyDepthBar,
                    borderTopRightRadius:1,
                  }}/>}
                  {/* shared-slot indicator */}
                  {key.shared && <div style={{
                    position:"absolute", top:2, right:2,
                    width:3, height:3, borderRadius:"50%",
                    background: sel ? C.selectedDot : C.sharedDot,
                  }}/>}
                  <span style={{
                    fontSize:key.u>=1.5?9:10, fontFamily:FONT, fontWeight:700,
                    color: sel?C.selectedTxt:C.keyTxt, userSelect:"none", lineHeight:1,
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

      {/* sub-bar */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"7px 2px 0" }}>
        <span style={{ fontSize:10, color:C.muted, maxWidth:"60%" }}>
          {selectedKeys.size === 0
            ? "SELECT ONE OR MORE KEYS TO CONFIGURE PER-KEY SETTINGS"
            : `${selectedKeys.size} KEY${selectedKeys.size>1?"S":""} SELECTED`}
        </span>
        <div style={{ display:"flex", gap:6 }}>
          {[["Select all keys", onSelectAll], ["Discard selection", onDeselect]].map(([label, fn]) => (
            <button key={label} onClick={fn} style={{
              padding:"4px 11px", borderRadius:4, border:`1px solid ${C.bord}`,
              background:"transparent", color:C.sub, fontSize:11,
              cursor:"pointer", fontFamily:FONT,
            }}>{label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   QUICK SETTINGS CARDS
───────────────────────────────────────────────────────────────────────────── */
function APCard({ ap, setAp, connected, dSend, selectedKeys }) {
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
          Press a key to test the actuation point.
        </div>
      </div>
    </div>
  );
}

function RTCard({ rtOn, setRtOn, sens, setSens, split, setSplit, press, setPress, rel, setRel, connected, dSend, selectedKeys }) {
  const selArr = [...selectedKeys];
  const handleToggle = v => {
    setRtOn(v);
    if (!connected) return;
    const mode = v ? MODE.RT : MODE.NORMAL;
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

function AdvancedPanel({ selectedKeys }) {
  const depths = [0.5,1.5,2.5,3.5];
  const [rows, setRows] = useState(depths.map(()=>({type:"None",key:""})));
  const upd = (i,k,v) => setRows(p=>p.map((r,j)=>j===i?{...r,[k]:v}:r));
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
      <div style={{ fontSize:13, fontWeight:700, color:C.txt }}>Dynamic Keystroke</div>
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
      if (s.mag[MAG.PRESS]?.[0])    setAp(cmm(s.mag[MAG.PRESS][0]));
      if (s.mag[MAG.RT_PRESS]?.[0]) setSens(cmm(s.mag[MAG.RT_PRESS][0]));
      if (s.mag[MAG.MODE]?.[0] !== undefined) setRtOn(s.mag[MAG.MODE][0] === MODE.RT);
    }
  }, []);

  const { hidOK, status, info, err, connect, disconnect, send, dSend } = useKeyboard({ onSettings });
  const connected = status === "connected";

  // Demo animation
  const animRef = useRef(null); const stRef = useRef({}); const velRef = useRef({});
  useEffect(() => {
    if (!demo) { clearInterval(animRef.current); setDepths({}); return; }
    const keys = ["w","a","s","d","q","e","r","f","spc","lsh","c","v","k1","k2","j","k","l"];
    keys.forEach(k => { stRef.current[k] = Math.random()*.2; velRef.current[k] = (Math.random()-.5)*.04; });
    animRef.current = setInterval(() => {
      keys.forEach(k => {
        let v = velRef.current[k]||0, d = (stRef.current[k]||0)+v;
        if(d>1){d=1;velRef.current[k]=-Math.abs(v);}
        if(d<0){d=0;velRef.current[k]= Math.abs(v);}
        if(Math.random()<.018) velRef.current[k]=(Math.random()-.5)*.06;
        stRef.current[k]=d;
      });
      setDepths({...stRef.current});
    }, 33);
    return () => clearInterval(animRef.current);
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
        <div style={{ width:52, flexShrink:0, background:C.nav,
          borderRight:`1px solid ${C.bord}`, display:"flex", flexDirection:"column",
          alignItems:"center", paddingTop:10, gap:2 }}>
          <div style={{ width:32, height:32, borderRadius:7, background:C.accent,
            display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:15, fontWeight:900, color:C.atxt, marginBottom:14, letterSpacing:"-1px" }}>W</div>
          {NAV.map(n => (
            <button key={n.id} onClick={()=>setSection(n.id)} title={n.tip} style={{
              width:38, height:38, borderRadius:6, background:"transparent", border:"none",
              cursor:"pointer", color: section===n.id?C.accent:C.muted,
              display:"flex", alignItems:"center", justifyContent:"center",
              borderLeft:`2px solid ${section===n.id?C.accent:"transparent"}`,
              transition:"color .12s",
            }}>{n.icon}</button>
          ))}
          <div style={{ flex:1 }}/>
          <button onClick={() => setThemeName(isLight ? "dark" : "light")}
            title={isLight ? "Switch to dark mode" : "Switch to light mode"}
            aria-label={isLight ? "Switch to dark mode" : "Switch to light mode"}
            style={{ width:38,height:38,borderRadius:6,background:isLight?C.activeBg:"transparent",
              border:"none",cursor:"pointer",color:isLight?C.accent:C.muted,
              display:"flex",alignItems:"center",justifyContent:"center",
              marginBottom:0 }}>{isLight ? IC.moon : IC.sun}</button>
          <button title="Help" aria-label="Help" style={{ width:38,height:38,borderRadius:6,background:"transparent",
            border:"none",cursor:"pointer",color:C.muted,
            display:"flex",alignItems:"center",justifyContent:"center",
            marginBottom:8 }}>{IC.help}</button>
        </div>

        {/* ── TEXT SIDEBAR ────────────────────────────────────────── */}
        <div style={{ width:210, flexShrink:0, background:C.panel,
          borderRight:`1px solid ${C.bord}`, display:"flex", flexDirection:"column", overflow:"hidden" }}>
          <div style={{ padding:"14px 14px 8px", borderBottom:`1px solid ${C.bord}` }}>
            <div style={{ fontSize:10, fontWeight:700, color:C.muted, letterSpacing:".06em",
              textTransform:"uppercase", marginBottom:8 }}>Keyboard Configuration</div>
            <div style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 8px",
              borderRadius:6, background:C.surf, border:`1px solid ${C.bord}`, cursor:"pointer" }}>
              <div style={{ width:28,height:20,borderRadius:3,background:C.bord,flexShrink:0,
                display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,color:C.muted }}>⌨</div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:9, color:C.muted }}>My devices</div>
                <div style={{ fontSize:11, color:C.txt, fontWeight:600 }}>FUN60 Ultra TMR</div>
              </div>
              <span style={{ fontSize:10, color:C.muted }}>▾</span>
            </div>
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
          <NavItem icon="◎" label="Actuation Point" active={section==="ap"} onClick={()=>setSection("ap")}/>
          <NavItem icon="⚡" label="Rapid Trigger"  active={section==="rt"} onClick={()=>setSection("rt")}/>
          <NavItem icon="◉" label="RGB Settings"   active={section==="rgb"} onClick={()=>setSection("rgb")}/>
          <NavItem icon="⇄" label="Remap"          active={section==="remap"} onClick={()=>setSection("remap")}/>
          <NavItem icon="⊟" label="Advanced Keys"  active={section==="advanced"} onClick={()=>setSection("advanced")} badge="DKS"/>

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
              onConnect={connect} onDisconnect={disconnect}/>

            {/* keyboard */}
            <KeyboardViz keyDepths={depths} selectedKeys={selKeys}
              onKeyClick={toggleKey}
              onSelectAll={()=>setSelKeys(new Set(ALL_KEYS.map(k=>k.id)))}
              onDeselect={()=>setSelKeys(new Set())}/>

            {/* section title */}
            <div style={{ fontSize:18, fontWeight:800, color:C.txt, marginTop:2 }}>
              {NAV.find(n=>n.id===section)?.tip ?? "Quick Settings"}
            </div>

            {/* quick settings: 3-card grid */}
            {section==="quick" && (
              <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:12 }}>
                {[
                  <APCard   ap={ap} setAp={setAp} connected={connected} dSend={dSend} selectedKeys={selKeys}/>,
                  <RTCard   rtOn={rtOn} setRtOn={setRtOn} sens={sens} setSens={setSens}
                            split={split} setSplit={setSplit} press={press} setPress={setPress}
                            rel={rel} setRel={setRel} connected={connected} dSend={dSend} selectedKeys={selKeys}/>,
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
                {section==="ap"       && <APCard ap={ap} setAp={setAp} connected={connected} dSend={dSend} selectedKeys={selKeys}/>}
                {section==="rt"       && <RTCard rtOn={rtOn} setRtOn={setRtOn} sens={sens} setSens={setSens}
                                           split={split} setSplit={setSplit} press={press} setPress={setPress}
                                           rel={rel} setRel={setRel} connected={connected} dSend={dSend} selectedKeys={selKeys}/>}
                {section==="rgb"      && <RGBPanel ledOn={ledOn} setLedOn={setLedOn} ledMode={ledMode} setLedMode={setLedMode}
                                           ledR={ledR} setLedR={setLedR} ledG={ledG} setLedG={setLedG}
                                           ledB={ledB} setLedB={setLedB} ledSpeed={ledSpeed} setLedSpeed={setLedSpeed}
                                           ledBri={ledBri} setLedBri={setLedBri} connected={connected} dSend={dSend}/>}
                {section==="remap"    && <RemapPanel selectedKeys={selKeys}/>}
                {section==="advanced" && <AdvancedPanel selectedKeys={selKeys}/>}
              </div>
            )}
            <div style={{ height:20 }}/>
          </div>
        </div>
      </div>

      <style>{`
        *{box-sizing:border-box}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
        ::-webkit-scrollbar{width:5px}
        ::-webkit-scrollbar-track{background:${C.bg}}
        ::-webkit-scrollbar-thumb{background:${C.bord};border-radius:3px}
        button{outline:none}
        input[type=range]{-webkit-appearance:none;appearance:none}
      `}</style>
    </div>
  );
}
