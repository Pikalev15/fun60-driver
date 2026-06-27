# MonsGeek FUN60 / RY5088 Opcode Reference

> Working notes for the FUN60 Ultra / RY5088 WebHID driver project. This combines confirmed protocol data from the MonsGeek/Akko Linux driver docs/source, the dot-agi RY5088 firmware notes, the FUN60 manual, and the current web-app implementation.

## Device / transport basics

| Item | Value / note |
|---|---|
| Main VID | `0x3151` |
| Current app PID | `0x5030` |
| Vendor usage page | `0xFFFF` |
| Config usage | `0x02` |
| Feature report size | `64 bytes` payload through WebHID report ID `0` |
| Live input report | Report ID `0x05` |
| Config interface | Vendor HID feature reports |
| Keyboard input interface | Standard keyboard HID + vendor input events |

## Packet format

### WebHID feature report payload

In the browser, `sendFeatureReport(0, report)` sends the 64-byte payload directly. The report ID `0` is passed separately by WebHID.

```txt
byte 0      command opcode
byte 1-6    params
byte 7      checksum for most commands
byte 8-63   payload / chunk data
```

### Bit7 checksum

Used by most commands.

```js
function bit7(r) {
  let s = 0;
  for (let i = 0; i < 7; i++) s = (s + r[i]) & 0xff;
  r[7] = (0xff - s) & 0xff;
  return r;
}
```

### Bit8 checksum

Used by LED parameter commands.

```js
function bit8(r) {
  let s = 0;
  for (let i = 0; i < 8; i++) s = (s + r[i]) & 0xff;
  r[8] = (0xff - s) & 0xff;
  return r;
}
```

## Core commands

| Opcode | Direction | Name | Payload / meaning | App status |
|---:|---|---|---|---|
| `0x01` | SET | `SET_RESET` | Factory reset | Known, not exposed by default |
| `0x03` | SET | `SET_REPORT` / polling | `[0, code]` | Implemented |
| `0x04` | SET | `SET_PROFILE` | `[profile 0-3]` | Implemented |
| `0x05` | SET | `SET_LEDONOFF` | Hardware polarity observed: `0 = on`, `1 = off` | Implemented |
| `0x06` | SET | `SET_DEBOUNCE` | debounce ms | Not wired |
| `0x07` | SET | `SET_LEDPARAM` | LED mode, speed, brightness, RGB | Implemented |
| `0x08` | SET | `SET_SLEDPARAM` | side/secondary LED params | Not wired |
| `0x09` | SET | `SET_KBOPTION` | keyboard options | Not wired |
| `0x0A` | SET | `SET_KEYMATRIX` | chunked keymap write | Planned |
| `0x0B` | SET | `SET_MACRO` | chunked macro write | Planned |
| `0x0C` | SET | `SET_USERPIC` | per-key static RGB color data | Planned |
| `0x0D` | SET | `SET_AUDIO_VIZ` | 16 audio frequency bands | Not wired |
| `0x0E` | SET | `SET_SCREEN_COLOR` | RGB screen-sync data | Not wired |
| `0x10` | SET | `SET_FN` | chunked Fn layer write | Partially implemented |
| `0x11` | SET | `SET_SLEEPTIME` | sleep/deep-sleep timeout | Not wired |
| `0x12` | SET | `SET_USERGIF` | per-key RGB animation | Not wired |
| `0x17` | SET | `SET_AUTOOS_EN` | auto OS detection | Not wired |
| `0x18` | SET | `SET_USERGIFSTART` | animation upload start | Not wired |
| `0x1B` | SET | `SET_MAGNETISM_REPORT` | `[1] enable live travel`, `[0] disable` | Implemented |
| `0x1C` | SET | `SET_MAGNETISM_CAL` | min-position calibration start/stop | Not wired |
| `0x1D` | SET | `SET_KEY_MAGNETISM_MODE` | global/per-key HE mode | Implemented for global mode path |
| `0x1E` | SET | `SET_MAGNETISM_MAX_CAL` | max-position calibration start/stop | Not wired |
| `0x65` | SET | `SET_MULTI_MAGNETISM` | per-key HE settings | Implemented for AP/RT/mode |

## Core GET commands

| Opcode | Name | Response / meaning | App status |
|---:|---|---|---|
| `0x80` | `GET_REV` / `GET_RF_VERSION` | firmware revision | Not wired |
| `0x83` | `GET_REPORT` | polling rate code | Implemented |
| `0x84` | `GET_PROFILE` | active profile `0-3` | Implemented |
| `0x85` | `GET_LEDONOFF` | LED on/off state | Implemented |
| `0x86` | `GET_DEBOUNCE` | debounce settings | Not wired |
| `0x87` | `GET_LEDPARAM` | LED mode/speed/brightness/color | Implemented |
| `0x88` | `GET_SLEDPARAM` | secondary LED params | Not wired |
| `0x89` | `GET_KBOPTION` | keyboard options | Not wired |
| `0x8A` | `GET_KEYMATRIX` | key mappings | Planned |
| `0x8B` | `GET_MACRO` | macro data | Planned |
| `0x8C` | `GET_USERPIC` | per-key RGB colors | Planned |
| `0x8F` | `GET_USB_VERSION` / info | device id + firmware version | Implemented |
| `0x90` | `GET_FN` | Fn layer | Partially implemented |
| `0x91` | `GET_SLEEPTIME` | sleep timeout | Not wired |
| `0x97` | `GET_AUTOOS_EN` | auto OS setting | Not wired |
| `0x9C` | `GET_MAGNETISM_CAL` | min calibration data | Not wired |
| `0x9D` | `GET_KEY_MAGNETISM_MODE` | per-key mode data | Not wired separately |
| `0x9E` | `GET_MAGNETISM_CALMAX` | max calibration data | Not wired |
| `0xE5` | `GET_MULTI_MAGNETISM` | AP/RT/DKS/mode arrays | Implemented for AP/RT/mode reads |
| `0xE6` | `GET_FEATURE_LIST` | supported features bitmap | Not wired |

## Polling rate codes

| UI Hz | Code |
|---:|---:|
| 8000 | `0x00` |
| 4000 | `0x01` |
| 2000 | `0x02` |
| 1000 | `0x03` |
| 500 | `0x04` |
| 250 | `0x05` |
| 125 | `0x07` |

Command:

```js
SET: pkt(0x03, [0, code])
GET: pkt(0x83)
```

## Profiles

| Feature | Opcode | Format |
|---|---:|---|
| Set active profile | `0x04` | `[profile & 0x03]` |
| Get active profile | `0x84` | response byte `1` = profile `0-3` |

Recommended flow:

```js
await send(CMD.setProfile(slot));
await sleep(120);
const r = await send(CMD.getProfile());
const actual = r[1] & 0x03;
const fresh = await readSettings();
applySettings(fresh);
```

Profile names and icons are app-side only. The hardware stores profile slots, not custom profile card metadata.

## RGB / LED

### Main LED on/off

```js
GET: 0x85
SET: 0x05
```

Observed polarity in our app testing:

| UI state | Byte sent |
|---|---:|
| LED on | `0` |
| LED off | `1` |

### Main LED params

```txt
byte 0 = 0x07
byte 1 = mode
byte 2 = speed 0-4
byte 3 = brightness 0-4
byte 4 = 0
byte 5 = red
byte 6 = green
byte 7 = blue
byte 8 = bit8 checksum
```

The UI maps speed/brightness as:

| Raw | UI |
|---:|---:|
| `0` | `0%` |
| `1` | `25%` |
| `2` | `50%` |
| `3` | `75%` |
| `4` | `100%` |

### LED modes

| Code | Mode |
|---:|---|
| `0x00` | Off |
| `0x01` | Constant |
| `0x02` | Breathing |
| `0x03` | Neon |
| `0x04` | Wave |
| `0x05` | Ripple |
| `0x06` | Raindrop |
| `0x07` | Snake |
| `0x08` | Reactive |
| `0x09` | Converge |
| `0x0A` | Sine Wave |
| `0x0B` | Kaleidoscope |
| `0x0C` | Line Wave |
| `0x0D` | User Picture |
| `0x0E` | Laser |
| `0x0F` | Circle Wave |
| `0x10` | Rainbow |
| `0x11` | Rain Down |
| `0x12` | Meteor |
| `0x13` | Reactive Off |
| `0x14` | Music Patterns |
| `0x15` | Screen Sync |
| `0x16` | Music Bars |
| `0x17` | Train |
| `0x18` | Fireworks, source-listed but not used in current app |
| `0x19` | Per-Key Color, source-listed but not used in current app |

## Magnetic / HE settings

### Set one key

```txt
byte 0 = 0x65
byte 1 = sub-command
byte 2 = 0x00 single-key write
byte 3 = key index
byte 8 = value low byte
byte 9 = value high byte
byte 7 = bit7 checksum
```

### Bulk set

```txt
byte 0 = 0x65
byte 1 = sub-command
byte 2 = 0x01 bulk write
byte 3 = page/chunk index
byte 8+ = up to 28 little-endian u16 values
byte 7 = bit7 checksum
```

### Read magnetic settings

```txt
byte 0 = 0xE5
byte 1 = sub-command
byte 4 = page
byte 7 = bit7 checksum
```

GET_MULTI_MAGNETISM responses are raw data and do not echo `0xE5`.

### Magnetism subcommands

| Sub | Name | Value format | App status |
|---:|---|---|---|
| `0x00` | Press travel / actuation point | u16 | Implemented |
| `0x01` | Lift travel / release point | u16 | Implemented read/write support path |
| `0x02` | RT press sensitivity | u16 | Implemented |
| `0x03` | RT lift sensitivity | u16 | Implemented |
| `0x04` | DKS travel | 4-byte structures | Planned |
| `0x05` | Mod-Tap time | u8 pages | Planned |
| `0x06` | Bottom deadzone | u16 | Planned |
| `0x07` | Key mode | u8 pages | Implemented |
| `0x09` | Snap Tap enable | u8 pages | Partially implemented/read |
| `0x0A` | DKS modes/actions | variant-specific | Planned |
| `0xFB` | Top deadzone | u16, firmware >= 10.24 | Planned |
| `0xFC` | Switch type | u16/variant | Not wired |
| `0xFE` | Calibration | raw calibration | Not wired |

### Key mode values

| Value | Mode |
|---:|---|
| `0` | Normal |
| `1` | Rapid Trigger |
| `2` | DKS |
| `3` | Mod-Tap |
| `4` | Toggle |
| `5` | Snap Tap |

## Live key travel telemetry

Enable:

```js
pkt(0x1B, [1])
```

Disable:

```js
pkt(0x1B, [0])
```

Input report format:

```txt
Report ID 0x05
byte 0 = 0x1B event type
byte 1 = depth low
byte 2 = depth high
byte 3 = key index
```

Decode:

```js
const raw = bytes[1] | (bytes[2] << 8);
const keyIndex = bytes[3];
```

## Fn layers

| Feature | Opcode | Notes |
|---|---:|---|
| Set Fn layer | `0x10` | chunked write |
| Get Fn layer | `0x90` | readback format may vary by firmware |

### Chunked write layout for `SET_FN`

```txt
byte 0 = 0x10
byte 1 = layer id 0-5
byte 2 = chunk index 0-based
byte 3-6 = padding/params
byte 7 = bit7 checksum
byte 8-63 = up to 56 bytes payload
```

Host-side safety limits:

```txt
layer_id: 0-5
chunk_index: 0-9
total payload: <= 514 bytes
```

### FUN60 Fn Layer 1 stock map used in current app

This is based on the FUN60 manual and the uploaded video reference.

| Base key | Fn output / label | Wire status |
|---|---|---|
| Esc | no Fn function | no mapping |
| 1 | F1 | HID-safe |
| 2 | F2 | HID-safe |
| 3 | F3 | HID-safe |
| 4 | F4 | HID-safe |
| 5 | F5 | HID-safe |
| 6 | F6 | HID-safe |
| 7 | F7 | HID-safe |
| 8 | F8 | HID-safe |
| 9 | F9 | HID-safe |
| 0 | F10 | HID-safe |
| - | F11 | HID-safe |
| = | F12 | HID-safe |
| Backspace | Delete | HID-safe |
| W/A/S/D | arrows | HID-safe |
| P | PrtSc | HID-safe |
| I | Insert | HID-safe |
| E/R/T | BT1/BT2/BT3 | UI label only until vendor byte is captured |
| Y | 2.4G | UI label only until vendor byte is captured |
| ; / ' | brightness down/up | UI label only until vendor byte is captured |
| \ | RGB / color cycle | UI label only until vendor byte is captured |
| Space | battery check | UI label only until vendor byte is captured |
| Left Win | Win Lock | tentative special code / needs test |
| Right Alt | Mac/Win | UI label only until vendor byte is captured |

## Keymatrix / main remap

| Feature | Opcode |
|---|---:|
| Set keymatrix | `0x0A` |
| Get keymatrix | `0x8A` |

Uses the same chunked write layout style as `SET_FN`, but byte `1` is the keymap/layer id. Safe range is `0-5`. This is the next major real-driver feature to implement.

## Macros

| Feature | Opcode |
|---|---:|
| Set macro | `0x0B` |
| Get macro | `0x8B` |

Safe host limit: keep `macro_id` within `0-15` for flash path safety, even if some docs mention broader command ranges.

## Events / notifications

Report ID: `0x05`.

| Event type | Format | Meaning |
|---:|---|---|
| `0x01` | `05 01 [profile]` | profile changed |
| `0x03` | `05 03 [state] 01` | Win lock toggled |
| `0x03` | `05 03 [state] 03` | WASD/arrow swap toggled |
| `0x03` | `05 03 [layer] 08` | Fn layer toggled |
| `0x03` | `05 03 04 09` | backlight toggled |
| `0x04` | `05 04 [mode]` | main LED mode changed |
| `0x05` | `05 05 [speed]` | main LED speed changed, `0-4` |
| `0x06` | `05 06 [level]` | main LED brightness changed, `0-4` |
| `0x07` | `05 07 [color]` | main LED color changed |
| `0x0F` | `05 0F 01/00` | settings save start/complete |
| `0x1B` | `05 1B lo hi idx` | live key travel |
| `0x88` | `05 88 00 00 level flags` | battery status |

## Dongle / RF commands

These matter for 2.4GHz support and are mostly not needed for wired WebHID.

| Opcode | Name | Notes |
|---:|---|---|
| `0xF0` | `GET_DONGLE_INFO` | dongle-local |
| `0xF6` | `SET_CTRL_BYTE` | dongle-local |
| `0xF7` | `GET_DONGLE_STATUS` | dongle-local battery/RF cache |
| `0xF8` | `ENTER_PAIRING` | pairing mode, magic required |
| `0x7A` | `PAIRING_CMD` | 3-byte SPI pairing control |
| `0xFC` | `GET_CACHED_RESPONSE` | RF forwarded-command response cache |
| `0xFD` | `GET_DONGLE_ID` | dongle-local |
| `0xFE` | `GET_CALIBRATION` on keyboard / response-size command on dongle | byte collision by transport |

## Firmware / bootloader commands

| Opcode | Name | Notes |
|---:|---|---|
| `0x7F` | `ENTER_BOOTLOADER` / factory reset path | magic `55 AA 55 AA`; dangerous |
| `0xBA` | firmware transfer command family | bootloader mode |
| `0xC5` | ISP prepare | used before bootloader entry |
| `0xAC` | flash chip erase | dangerous / not for app UI |

Do not expose firmware erase/update controls in the normal driver UI until recovery steps are fully documented.

## Implementation priority checklist

1. Finish stock Fn layer labels and safe HID writes.
2. Capture vendor bytes for battery, BT1/BT2/BT3, 2.4G, RGB toggle/color, light +/- and Mac/Win.
3. Implement `GET_KEYMATRIX` / `SET_KEYMATRIX` for real remap.
4. Implement export/import profile data in browser storage.
5. Add macro editor only after macro wire format is verified.
6. Add calibration UI behind a warning.

## Sources used

- `echtzeit-solutions/monsgeek-akko-linux` protocol docs and source.
- `dot-agi/ry5088-flasher` RY5088 firmware docs.
- MonsGeek FUN60 user manual, combination key table.
- Uploaded video reference for visual Fn layer defaults.
