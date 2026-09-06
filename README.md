# riseup-mobile

The RiseUp companion app. React Native (Expo), iOS and Android.

`PRD.md` is the specification. `docs/BACKEND-GAPS.md` is what the phone needs
from `riseup-backend` that does not exist yet — read it before concluding a
screen is unfinished, because several of them are finished and waiting.

---

## What is built: v0.1

The phasing in PRD §10 puts auth, clip upload, match list, summary and push
before any camera work, because that is the fastest route to a coach holding
something real and every later phase depends on the plumbing it builds.

| | |
| --- | --- |
| **Auth** | Clerk, the same instance as the dashboard. A coach's existing account works with no migration |
| **Match list** | Finished matches merged with in-flight upload jobs, so an upload from ten seconds ago is visible |
| **Match summary** | Data-quality banner, team totals, top five by distance and by sprints |
| **Player quick view** | Four metrics, own-season comparison, heatmap |
| **Uploads** | Clip picking, background transfer, persisted queue, honest time estimate |
| **Push** | Registration, delivery, in-app inbox, deep links — waiting on `POST /me/devices` |
| **Role switch** | Analyst opens on the match list, Operator on capture (§2) |

**Capture is deliberately not built.** The tab exists and says so. A screen
that looks like it films and does not is the one failure §4 exists to prevent.

---

## Running it

**Expo Go will not work** past the first screen. Clerk, SecureStore and the
background upload session are native modules, so this needs a development
build — an app binary with those modules compiled in, which then loads JS from
your machine over the LAN.

There are two ways to get that binary, and which one you need depends on the
machine you are on. If you are on Windows or have never built natively before,
take the first one.

### Quickstart — from a clean checkout to the app on a phone

Every command, in order. Nothing here needs Android Studio, a JDK or a Mac.

```bash
# 1. Install, and point the app at this machine
npm install
cp .env.example .env
ipconfig                 # find the Wi-Fi IPv4 address; ignore any 172.x adapter
#   then edit .env:  EXPO_PUBLIC_API_URL=http://<that address>:8000

# 2. Build a development client in the cloud (~15 min the first time)
npx eas-cli login        # a free Expo account
npx eas-cli build --profile development --platform android
#   -> returns a download link. Open it ON THE PHONE and install the APK.

# 3. Start the API so the phone can reach it
#   in riseup-backend, and note the host: 0.0.0.0, not 127.0.0.1
uvicorn api.main:app --host 0.0.0.0 --port 8000

# 4. Serve the JS to the installed app
npm start                # expo start --dev-client
```

Open the app on the phone. It finds Metro on the LAN, loads, and lands on the
sign-in screen. Use a Clerk account that belongs to a club organisation — an
account with no org authenticates and then 403s on every request.

Rebuild with `eas-cli build` only when a **native** dependency changes. JS and
TypeScript changes need nothing more than `npm start`.

Windows Firewall will usually prompt on the first connection to port 8000 and
to Metro on 8081. Allow both on private networks, or the phone times out with
no error worth reading.

### iOS

The quickstart above builds Android. iOS is the same command with
`--platform ios`:

```bash
npx eas-cli build --profile development --platform ios
```

— but it needs a **paid Apple Developer account**, because a build that runs on
a physical device has to be signed. There is no way around that from a non-Mac,
and the free-account workaround people mention (a 7-day provisioning profile
through Xcode) still requires macOS.

The build profiles live in `eas.json`: `development` for the dev client,
`preview` for a signed internal APK that runs without Metro, and `production`
for an app bundle.

### Local builds — needs the native toolchains

```bash
npx expo prebuild            # generates ios/ and android/
npm run android              # or: npm run ios (macOS only)
```

`npm run android` needs **Android Studio, the SDK, `ANDROID_HOME` set, and
JDK 17**. Java 8 will not build this. `npm run ios` needs **macOS and Xcode**;
there is no Windows or Linux path to a local iOS build.

`ios/` and `android/` are gitignored because they are generated. Do not edit
them by hand — the edit is silently destroyed by the next `prebuild`. Anything
that must change in native config belongs in `app.json`, as config plugin
input.

### When it does not connect

The two failures both look like the app hanging and then giving up, and neither
names its cause.

**`.env` points at `localhost`.** A phone resolving `localhost` resolves
itself. It must be the machine's LAN address, and not a `172.x` WSL or Hyper-V
adapter — the phone cannot route to those either.

**The API is bound to `127.0.0.1`.** Reachable only from the machine it runs
on, whatever address the app asks for. It needs `--host 0.0.0.0`.

And one that looks like neither:

**`EXPO_PUBLIC_*` is inlined at build time.** After changing one, restart with
`npx expo start --clear`. A fast refresh will not pick it up, and the "why is
it still hitting the old host" that follows costs twenty minutes every time.

### Do not run `npm audit fix --force`

It resolves past the versions the Expo SDK pins and produces a dependency tree
that fails at runtime with an error naming none of the packages it changed. The
advisories in this tree are in build-time tooling, not in anything shipped to a
device.

```bash
npx expo install --check   # the tool that actually keeps versions correct
npm run typecheck          # tsc --noEmit
```

---

## How it is organised

```
app/                       expo-router. Files are routes; nothing else lives here
  (auth)/sign-in           the only unauthenticated screen
  (app)/(tabs)/            matches · capture · uploads · inbox · settings
  (app)/match/[id]         summary
  (app)/match/player       quick view, presented as a modal

src/
  theme/tokens.ts          the design system. The only file with raw hex
  ui/                      primitives. Screens compose these and never restyle
  api/                     client, types, endpoints, React Query hooks
  auth/                    Clerk token cache, and the Analyst/Operator role
  lib/                     formatting and the derivations screens need
  upload/                  the persisted upload queue
  notifications/           push registration, the inbox, the category contract
```

Two rules that keep it that way:

**Screens do not write style values.** Everything comes from `src/theme/tokens.ts`
via `src/ui`. The dashboard's own tokens file documents what the alternative
cost there — fourteen greys, thirty-eight uses of a 9px font size — and this is
the same system, one step up in scale for a phone held at arm's length.

**Screens do not write API paths.** They come from `src/api/endpoints.ts`,
because four of the paths in PRD §8.1 are wrong and a screen that writes its
own string will write the PRD's version.

---

## Design

This is the phone's half of `riseup-frontend/src/styles/tokens.css` v3.0. Same
near-black surface ramp, same hairline-instead-of-shadow grammar, same three
faces (Archivo / DM Sans / **DM Mono** for every label and measured number),
and the same reserved accent: `#35c98d` means *live, running, measured,
connected*, and appears at most once per screen. If a second one shows up, one
of them is decoration.

The deliberate divergences from the web scale — larger type, softer radii, a
wider gutter — and the reasoning for each are documented at the top of
`src/theme/tokens.ts`.

---

## Where it goes next

Per PRD §10, and in this order:

- **v0.2** — single-phone capture into the app's own container, resumable
  upload, verified deletion. Blocked on multipart upload (gap 6).
- **v0.3** — the two-phone rig. Pairing over Bluetooth/local network, the
  framing assistant, preflight, the audible sync marker, in-match health.
- **v0.4** — data-quality surfacing, auto-directed video, lineup assignment.

The framing assistant's geometry is a **port** of `camera/rig.py` in
`riseup-ml`, not a reimplementation (§4.2). Around 200 lines of convex geometry
with no dependencies, and the thresholds are product decisions that must not
drift between two codebases. The server re-runs the same check at ingest; a
disagreement between the two is a bug in the port.

Everything from arriving at the ground to the final whistle must work with no
network (§3). That constraint is the single most likely thing to be forgotten
during implementation, and it is why the framing check is a local solve rather
than a server call.
