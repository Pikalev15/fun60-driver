# MonsGeek FUN60 Pro Support Notes

Source: [`echtzeit-solutions/monsgeek-akko-linux` issue #5](https://github.com/echtzeit-solutions/monsgeek-akko-linux/issues/5)

This note summarizes the useful driver/protocol information from the issue about adding **MonsGeek FUN60 Pro** support to the Linux driver and to a WebHID-style driver app.

---

## TL;DR

The **FUN60 Pro** appears to use the same MonsGeek/Akko RY5088/AT32F405 protocol family as the existing supported boards, but it has a different USB PID and may expose its vendor HID interface on **Usage Page `0xFFFF`** instead of only `0xFF00`.

For a driver/app, the important changes are:

```txt
VID: 0x3151
PID: 0x502d
Display name: MonsGeek FUN60 Pro
Key count: 61
Magnetism / HE: true
Sidelight: false
Protocol family: M1 V5 / RY5088-compatible
Likely usage page: 0xFFFF
Known working protocol mask target: PID 0x5030
```

The issue author got the keyboard detected by adding `0x3151:0x502d`, allowing Usage Page `0xFFFF`, and temporarily treating the board as the already-supported **M1 V5 wired protocol target `0x5030`**.

---

## Confirmed / claimed from the issue

### USB identity

The issue gives this example `lsusb` identity:

```txt
ID 3151:502d MonsGeek Keyboard
```

Meaning:

```txt
Vendor ID  = 0x3151
Product ID = 0x502d
```

### Device definition

The issue proposes this device entry:

```rust
DeviceDefinition {
    vid: 0x3151,
    pid: 0x502d,
    name: "fun60pro",
    display_name: "MonsGeek FUN 60 Pro",
    key_count: 61,
    has_magnetism: true,
    has_sidelight: false,
}
```

### Usage page issue

The main detection problem is that newer MonsGeek/Akko models can expose their vendor HID interface on:

```txt
Usage Page 0xFFFF
```

The existing driver logic was looking for the older vendor page:

```txt
Usage Page 0xFF00
```

So the safe discovery rule is to accept both:

```rust
usage_page == 0xff00 || usage_page == 0xffff
```

### Protocol compatibility

The maintainer comment says the workaround confirms that the protocol is effectively the same across these newer RY5088/AT32F405-based boards.

The temporary hack used in the issue was:

```rust
if info.vendor_id() == 0x3151 && info.product_id() == 0x502d {
    return self.interfaces.iter().find(|i|
        i.pid == 0x5030 &&
        i.interface_number == info.interface_number() as i32
    );
}
```

In plain English: **when the driver sees FUN60 Pro `0x502d`, pretend it is the M1 V5 wired protocol device `0x5030` so the existing command layout works.**

A cleaner real fix is to use a `protocol_family` or `protocol_target_pid` field instead of hardcoding this masquerade in `find_matching()`.

---

## Linux driver changes from the issue

### 1. Add FUN60 Pro to `devices.rs`

File:

```txt
iot_driver_linux/src/devices.rs
```

Add:

```rust
DeviceDefinition {
    vid: 0x3151,
    pid: 0x502d,
    name: "fun60pro",
    display_name: "MonsGeek FUN 60 Pro",
    key_count: 61,
    has_magnetism: true,
    has_sidelight: false,
},
```

---

### 2. Temporary protocol mask in `registry.rs`

File:

```txt
iot_driver_linux/src/hal/registry.rs
```

Temporary workaround:

```rust
pub fn find_matching(&self, info: &hidapi::DeviceInfo) -> Option<&HidInterface> {
    // HACK: Treat FUN60 Pro as M1 V5 wired protocol target.
    if info.vendor_id() == 0x3151 && info.product_id() == 0x502d {
        return self.interfaces.iter().find(|i|
            i.pid == 0x5030 &&
            i.interface_number == info.interface_number() as i32
        );
    }

    self.interfaces.iter().find(|i| i.matches(info))
}
```

Better future version:

```rust
protocol_family: ProtocolFamily::Ry5088M1V5,
```

or:

```rust
protocol_target_pid: 0x5030,
```

That way new boards can reuse the same protocol without pretending to be another PID in the matching code.

---

### 3. Add the PID to discovery

File:

```txt
iot_driver_linux/monsgeek-transport/src/discovery.rs
```

Add the FUN60 Pro VID/PID wherever known devices are listed, including both `new()` and `with_printer_config()` if the repo still has both paths:

```rust
known_devices: vec![
    (device::VENDOR_ID, device::PID_M1_V5_WIRED),
    (device::VENDOR_ID, device::PID_M1_V5_DONGLE),
    (device::VENDOR_ID, device::PID_M1_V5_BLUETOOTH),
    (0x3151, 0x502d),
],
```

---

### 4. Accept `0xFFFF` for the feature/config interface

The issue suggests allowing both `0xFF00` and `0xFFFF` for feature/config interfaces:

```rust
fn is_usb_feature_interface(device_info: &hidapi::DeviceInfo) -> bool {
    (device_info.usage_page() == 0xff00 || device_info.usage_page() == 0xffff)
        && (device_info.usage() == 0x02 || device_info.usage() == 0x01)
}
```

Notes:

- Usage `0x02` is normally the config/feature-report interface.
- Usage `0x01` may also need to be accepted on some newer models.
- Check that the selected interface actually has feature reports before using it for config writes.

---

### 5. Accept `0xFFFF` for the input/live telemetry interface

For live magnetic / Hall-effect travel telemetry:

```rust
fn is_usb_input_interface(device_info: &hidapi::DeviceInfo) -> bool {
    (device_info.usage_page() == 0xff00 || device_info.usage_page() == 0xffff)
        && device_info.usage() == 0x01
}
```

---

## WebHID app implications

For a browser driver, add FUN60 Pro as another supported target:

```js
const BOARDS = [
  {
    id: "fun60pro",
    name: "MonsGeek FUN60 Pro",
    vid: 0x3151,
    pid: 0x502d,
    keyCount: 61,
    hasMagnetism: true,
    hasSidelight: false,
    protocolFamily: "ry5088-m1v5",
    usagePages: [0xff00, 0xffff],
    protocolTargetPid: 0x5030,
  },
];
```

### Safer WebHID selection

Do not only filter by usage page. Request by VID/PID, then inspect collections:

```js
const devices = await navigator.hid.requestDevice({
  filters: [{ vendorId: 0x3151, productId: 0x502d }],
});
```

Then pick the config interface by checking for feature reports:

```js
const config = devices.find(d =>
  d.collections.some(c =>
    (c.usagePage === 0xff00 || c.usagePage === 0xffff) &&
    (c.usage === 0x02 || c.usage === 0x01) &&
    c.featureReports?.length > 0
  )
);
```

Pick the live input interface by checking for input reports:

```js
const live = devices.find(d =>
  d.collections.some(c =>
    (c.usagePage === 0xff00 || c.usagePage === 0xffff) &&
    c.usage === 0x01 &&
    c.inputReports?.length > 0
  )
);
```

### Do not hard-fail on old `DEV_ID`

If an app currently checks for one exact device ID from `GET_INFOR`, make that check board-specific or warning-only for FUN60 Pro until the exact `dev_id` is confirmed.

Bad for multi-board support:

```js
if (infor.devId !== 2307) throw new Error("Wrong device");
```

Better:

```js
if (board.expectedDevId && infor.devId !== board.expectedDevId) {
  console.warn("Unexpected dev_id", infor.devId);
}
```

---

## Build / install notes from the issue

Basic flow:

```bash
git clone https://github.com/echtzeit-solutions/monsgeek-akko-linux.git
cd monsgeek-akko-linux
make driver
sudo make install
```

If an old version was already installed from the same folder:

```bash
sudo make uninstall
```

### Fedora / Bazzite / SteamOS-style atomic distro notes

The issue suggests compiling in a matching Fedora container, then installing from the host.

Dependencies mentioned:

```bash
sudo dnf install gcc make pkgconf-pkg-config systemd-devel hidapi-devel protobuf-compiler openssl-devel cargo rust
sudo dnf install alsa-lib-devel
sudo dnf install jack-audio-connection-kit-devel
```

Build inside container:

```bash
cd monsgeek-akko-linux
make driver
```

Then from the host:

```bash
cd monsgeek-akko-linux
sudo make install
```

---

## Known dmesg behavior

The issue comment shows Linux messages like:

```txt
hid-generic 0003:3151:502D....: ignoring exceeding usage max
```

This does not necessarily mean the keyboard is unusable. The same log also shows multiple HID functions appearing, including keyboard, consumer control, system control, mouse, and hidraw devices.

Expected exposed functions include:

```txt
Keyboard input
Consumer Control
System Control
Mouse-like HID function
Vendor/config hidraw interface
Live/input hidraw interface
```

---

## What is still uncertain

These points should be verified on real FUN60 Pro hardware:

- Exact HID descriptor usage page from `usbhid-dump`.
- Exact `GET_INFOR` returned `dev_id`.
- Whether all magnetic/AP/RT commands behave exactly like M1 V5.
- Whether live travel telemetry uses the same report ID and payload shape.
- Whether Bluetooth and 2.4G dongle modes expose the same config path.
- Whether profile/keymap/Fn-layer chunks are identical across all firmware versions.

---

## Practical recommendation for our app

For FUN60 Pro support, implement this first:

```js
const VID = 0x3151;
const PID_FUN60_PRO = 0x502d;
const PID_PROTOCOL_M1V5 = 0x5030;
const USAGE_PAGES = [0xff00, 0xffff];
```

Add it to the board list, but reuse the same RY5088 protocol module used by the M1 V5/FUN60 Ultra path.

Then test in this order:

1. Connect / read `GET_INFOR`.
2. Read active profile.
3. Read RGB on/off and LED params.
4. Toggle RGB on/off.
5. Read magnetic values.
6. Set one harmless actuation point on one key.
7. Enable live magnetic telemetry.
8. Read/write Fn layer only after confirming chunk layout.
9. Read/write keymatrix only after backing up the current mapping.

---

## Minimal patch checklist

```txt
[ ] Add 0x3151:0x502d to supported boards
[ ] Mark key_count = 61
[ ] Mark has_magnetism = true
[ ] Mark has_sidelight = false
[ ] Allow usage_page 0xff00 and 0xffff
[ ] Accept usage 0x02 for config/feature reports
[ ] Accept usage 0x01 for live input reports
[ ] Reuse M1 V5 / RY5088 protocol family
[ ] Avoid hard-failing on unknown dev_id until confirmed
[ ] Confirm live telemetry report format on hardware
[ ] Confirm Fn/keymatrix chunks before writing remaps
```
