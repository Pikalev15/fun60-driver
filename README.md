# FUN60 Driver

<h3 align="center">
Open-source WebHID configurator for the MonsGeek FUN60 Ultra TMR
</h3>

<p align="center">
A native-driver replacement built entirely in the browser.
</p>

---

## ✨ Features

FUN60 Driver is an open-source alternative configuration tool for the
**MonsGeek FUN60 Ultra TMR**.

It communicates directly with the keyboard using **WebHID**, removing the need
for proprietary desktop software.

### Supported

✅ Web-based configuration  
✅ No installation required  
✅ Direct USB HID communication  
✅ Per-key actuation control  
✅ Rapid Trigger configuration  
✅ Lift point adjustment  
✅ RGB control  
✅ Profile switching  
✅ Polling rate control  
✅ Live analog key depth support *(experimental)*  

---

## 🎯 Why?

The FUN60 Ultra TMR uses a powerful magnetic switch system, but the official
software limits customization.

This project aims to provide:

- a cleaner UI
- open protocol documentation
- cross-platform support
- scriptable keyboard configuration
- community-driven development

---

# 🖥️ Tech Stack

- React
- WebHID API
- JavaScript
- Vite
- Browser-native HID communication

No:
- native drivers
- background services
- proprietary installers

---

# 🔌 Supported Hardware

| Device | Support |
|-|-|
| MonsGeek FUN60 Ultra TMR | ✅ |
| RY5088 platform keyboards | Experimental |

Hardware details:

- MCU: Artery AT32F405
- Wireless MCU: Panchip PAN1080
- Sensor: TMR magnetic switches
- USB Vendor: `0x3151`
- Product ID: `0x5030`

The FUN60 uses the RongYuan RY5088 platform. :contentReference[oaicite:1]{index=1}

---

# 🚀 Getting Started

## Requirements

- Chromium based browser
  - Chrome
  - Edge
  - Brave

WebHID is currently not supported by Firefox/Safari.

---

## Installation

Clone:

```bash
git clone https://github.com/Pikalev15/fun60-driver.git

cd fun60-driver
```

Install dependencies:

```bash
npm install
```

Run:

```bash
npm run dev
```

Open the local website and press:

```
Connect Keyboard
```

---

# 🔧 How It Works

The driver communicates through WebHID Feature Reports.

Communication format:

```
64 byte HID Feature Report

Byte 0:
  Command opcode

Byte 1-6:
  Arguments

Byte 7:
  Checksum
```

The keyboard exposes a vendor HID interface:

```
VID: 0x3151
PID: 0x5030
Usage Page: 0xFFFF
```

---

# 🎚️ Magnetic Switch Control

FUN60 Driver exposes the RY5088 magnetic commands:

## Actuation Point

Adjust when a key activates.

Example:

```
0.1mm → 4.0mm range
```

---

## Rapid Trigger

Configure:

- press sensitivity
- release sensitivity

Useful for:

- competitive gaming
- fast movement inputs
- custom typing setups

---

## Per-Key Configuration

Every key can have independent:

- actuation point
- release point
- rapid trigger values
- key mode

---

# 🌈 RGB

Supported lighting controls:

- static
- breathing
- wave
- reactive
- rainbow
- custom per-key colors

---

# 📁 Project Structure

```
src/

├── lib/
│   └── ry5088.js
│       Protocol implementation

├── hooks/
│   └── useKeyboard.js
│       WebHID connection layer

├── components/

│   ├── KeyboardViz.jsx
│   ├── RTPanel.jsx
│   ├── RGBPanel.jsx
│   └── QuickSettings.jsx

└── App.jsx
```

---

# 🧪 Development Status

## Working

✅ Device detection  
✅ Hardware communication  
✅ Actuation control  
✅ Rapid Trigger  
✅ RGB  
✅ Profiles  

## Planned

⬜ Firmware tools  
⬜ Wireless support  
⬜ Better key visualizer  
⬜ Macro editor  
⬜ Advanced analog features  

---

# ⚠️ Disclaimer

This project is unofficial.

It is not affiliated with:

- MonsGeek
- Akko
- RongYuan

Use at your own risk.

Firmware flashing features may permanently damage your device if used incorrectly.

---

# 🤝 Contributing

Contributions welcome.

Ideas:

- UI improvements
- protocol testing
- additional RY5088 devices
- documentation

Open an issue or submit a pull request.

---

# 📜 Credits

Protocol research:

- RY5088 reverse engineering community
- Contributors documenting the platform

Built for the keyboard community ❤️