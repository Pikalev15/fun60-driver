# FUN60 Driver

Browser-based configurator for the MonsGeek FUN60 Ultra TMR keyboard.

FUN60 Driver is a Vite + React app that talks to the keyboard through the
WebHID API. It is intended as an unofficial, open alternative to proprietary
desktop configuration software.

## Current Features

- Connects to the FUN60 Ultra TMR over WebHID.
- Verifies the keyboard by vendor ID, product ID, usage page, usage, and device
  ID before applying settings.
- Reads the active profile, polling rate, LED settings, firmware version, and
  magnetic switch settings after connection.
- Provides a 60 percent ANSI keyboard visualizer with selectable keys.
- Applies actuation point changes globally or to selected keys.
- Enables or disables Rapid Trigger globally or per selected key.
- Applies Rapid Trigger press sensitivity to selected keys or all mapped keys.
- Supports polling rate selection from 125 Hz through 8000 Hz.
- Controls LED power, mode, color, brightness, and speed.
- Includes profile selection for four profile slots.
- Includes a demo mode for visualizing analog key depth without hardware.

The Remap and Dynamic Keystroke panels currently provide UI scaffolding only.
They do not send remap or DKS configuration commands to the keyboard yet.

## Supported Hardware

The app is currently targeted at:

- MonsGeek FUN60 Ultra TMR
- USB vendor ID: `0x3151`
- USB product ID: `0x5030`
- HID usage page: `0xFFFF`
- HID usage: `0x02`
- Device ID: `2307`

The code assumes a RongYuan RY5088-style protocol and magnetic key mapping. Some
right-side keys share firmware magnetic slot `63`, matching the keyboard
firmware behavior noted in the source comments.

## Browser Requirements

Use a Chromium-based browser with WebHID support:

- Chrome
- Edge
- Brave

Firefox and Safari do not currently support WebHID.

Because WebHID requires a secure context, run the app from `localhost` during
development or from an HTTPS origin when deployed.

## Getting Started

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Open the Vite URL in a Chromium-based browser, connect the keyboard by USB, and
press **Connect Keyboard**.

## Available Scripts

```bash
npm run dev
```

Starts the Vite development server.

```bash
npm run build
```

Builds the production bundle into `dist/`.

```bash
npm run preview
```

Serves the production build locally for preview.

```bash
npm run lint
```

Runs ESLint across the project.

## Project Structure

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

Most of the app currently lives in `src/App.jsx`, including:

- RY5088 command packet helpers
- WebHID connection and settings reads
- FUN60 keyboard layout metadata
- visual keyboard selection
- quick settings cards
- RGB, remap, and advanced panels
- main application shell

## Protocol Notes

The app sends and receives 64-byte HID feature reports.

Implemented command areas include:

- device info
- active profile
- polling rate
- LED power and LED parameters
- magnetic actuation, lift, Rapid Trigger press, Rapid Trigger lift, and mode
  values

Magnetic switch distances are displayed in millimeters and encoded for the wire
protocol as centi-millimeters.

## Development Status

Working in the current code:

- WebHID device selection and connection
- feature-report communication
- device identity check
- settings read after connection
- profile switching
- actuation point writes
- Rapid Trigger mode writes
- Rapid Trigger sensitivity writes
- polling rate writes
- LED setting writes
- interactive keyboard selection

Present but not fully wired to hardware:

- remapping
- Dynamic Keystroke configuration
- live analog depth from the keyboard
- save semantics beyond sending the selected profile command

## Disclaimer

This project is unofficial and is not affiliated with MonsGeek, Akko, RongYuan,
or Wooting.

Use it at your own risk. Keyboard configuration tools can change device state,
and untested protocol writes may have unintended effects.
