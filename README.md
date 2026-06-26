<div align="center">

# FUN60 Custom Web Driver

Browser-based WebHID configurator for the MonsGeek FUN60 Ultra TMR.


An unofficial, open alternative to proprietary keyboard software, built as a
single-page Vite + React app that talks directly to the keyboard from the
browser.

</div>

---

## Overview
This web based driver connects to the FUN60 Ultra TMR through the browser's WebHID API.
It reads the keyboard's current settings, exposes a visual 60 percent layout,
and sends feature-report commands for magnetic switch, polling, profile, and RGB
configuration.

Big Thanks to dot-agi for creating https://github.com/dot-agi/ry5088-flasher as a baseline reference for all of the opcodes nessacary for creating this driver

Also thanks to https://github.com/echtzeit-solutions/monsgeek-akko-linux/ for exposing certain opcodes like dks and snaptap

| Area | Status |
| --- | --- |
| WebHID connection | Implemented |
| Device identity check | Implemented |
| Profile read/write | Implemented |
| Actuation point writes | Implemented |
| Rapid Trigger mode and sensitivity | Implemented |
| Polling rate selection | Implemented |
| LED power, mode, color, brightness, speed | Implemented |
| Remap panel | UI only |
| Dynamic Keystroke panel | UI only |
| Live analog depth from hardware | Not wired yet |
| SOCD (snap tap) | Partially applied (untestested) |

## Features

- Connects to the keyboard over WebHID, with VID/PID/usage filtering.
- Verifies the connected device against expected FUN60 identifiers.
- Reads profile, polling, LED, firmware, and magnetic switch settings after
  connection.
- Shows a selectable 60 percent ANSI keyboard visualizer.
- Applies actuation point changes globally or to selected keys.
- Enables or disables Rapid Trigger globally or per selected key.
- Applies Rapid Trigger press sensitivity to selected keys or all mapped keys.
- Supports polling rates from `125 Hz` through `8000 Hz`.
- Controls LED power, animation mode, color, brightness, and speed.
- Provides four profile slots and a local demo mode for visual key-depth motion.

## Hardware Target

| Field | Value |
| --- | --- |
| Keyboard | MonsGeek FUN60 Ultra TMR |
| Protocol family | RongYuan RY5088-style HID |
| USB vendor ID | `0x3151` |
| USB product ID | `0x5030` |
| HID usage page | `0xFFFF` |
| HID usage | `0x02` |
| Device ID | `2307` |

Some right-side keys share firmware magnetic slot `63`, matching the behavior
documented in the source comments.

## Requirements

Use a Chromium-based browser with WebHID support.

| Browser | Support |
| --- | --- |
| Chrome | Supported |
| Edge | Supported |
| Brave | Supported |
| Firefox | Not supported |
| Safari | Not supported |

WebHID requires a secure context, so use `localhost` for development or an HTTPS
origin for deployment.

## Quick Start

```bash
npm install
npm run dev
```

Then open the Vite URL in Chrome, Edge, or Brave, connect the keyboard by USB,
and press **Connect Keyboard**.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Vite development server. |
| `npm run build` | Build the production bundle into `dist/`. |
| `npm run preview` | Serve the production build locally. |
| `npm run lint` | Run ESLint across the project. |

## Project Layout

```text
.
|-- public/
|   |-- favicon.svg
|   `-- icons.svg
|-- src/
|   |-- App.jsx
|   |-- index.css
|   |-- main.jsx
|   `-- assets/
|-- index.html
|-- package.json
|-- vite.config.js
`-- eslint.config.js
```

Most of the implementation currently lives in `src/App.jsx`:

| Section | Responsibility |
| --- | --- |
| Protocol helpers | Build and parse RY5088-style HID reports. |
| `useKeyboard` | Manage WebHID connection, reads, writes, and disconnects. |
| Layout metadata | Define the FUN60 visual layout and magnetic indices. |
| Keyboard visualizer | Select keys and show demo key-depth feedback. |
| Settings panels | Actuation, Rapid Trigger, polling, RGB, remap, and DKS UI. |
| App shell | Sidebar navigation, profiles, connection banner, and topbar. |

## Protocol Notes

The app sends and receives `64` byte HID feature reports. Magnetic switch
distances are displayed in millimeters and encoded for the wire protocol as
centi-millimeters.

Implemented command areas:

- device info
- active profile
- polling rate
- LED power and parameters
- magnetic actuation, lift, Rapid Trigger press, Rapid Trigger lift, and mode
  values

## Roadmap Notes

The UI already includes entry points for more advanced configuration, but these
areas still need protocol work before they can change keyboard state:

- key remapping
- Dynamic Keystroke configuration
- live analog depth from the hardware telemetry interface
- clearer save semantics beyond sending the selected profile command

## Disclaimer

This project is unofficial and is not affiliated with MonsGeek, Akko, RongYuan,
or Wooting.

Use it at your own risk. Keyboard configuration tools can change device state,
and untested protocol writes may have unintended effects. As of now, this project is in a horribly experimental state. Enjoy!
