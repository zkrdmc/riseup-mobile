# riseup-mobile

The RiseUp companion app. React Native (Expo), iOS and Android.

`PRD.md` is the specification. `docs/BACKEND-GAPS.md` is what the phone needs
from `riseup-backend` that does not exist yet — read it before concluding a
screen is unfinished, because several of them are finished and waiting.

---

## What is built

### v0.1 — the plumbing

The phasing in PRD §10 puts auth, clip upload, match list, summary and push
before any camera work, because that is the fastest route to a coach holding
something real and every later phase depends on the plumbing it builds.

| | |
| --- | --- |
| **Auth** | Clerk, the same instance as the dashboard. A coach's existing account works with no migration. Gated on club membership — an orphan account is refused at the door rather than 403ing on every request afterwards |
| **Match list** | Finished matches merged with in-flight upload jobs, so an upload from ten seconds ago is visible |
| **Match summary** | Data-quality banner, team totals, top five by distance and by sprints |
| **Player quick view** | Four metrics, own-season comparison, heatmap |
| **Uploads** | Clip picking, background transfer, persisted queue, honest time estimate |
| **Push** | Registration, delivery, in-app inbox, deep links — waiting on `POST /me/devices` |
| **Role switch** | Analyst opens on the match list, Operator on capture (§2) |
| **Language** | English, French, Arabic. Chosen in settings, stored on the account, so the phone and the dashboard agree |

### Since v0.1 — the rig, before it films

The camera work landed setup-first, and that ordering is the point: everything
below decides whether footage will be *solvable*, and every one of those
decisions has to be made while the tripod is still in someone's hands.

| | |
| --- | --- |
| **Rig survey** | One document per session describing what processing cannot recover from the footage. Every value is tagged measured, reported or estimated — a consumer that cannot tell those apart will eventually average them |
| **Lens survey** | For cameras that do not report their own intrinsics (PRD §4.3), fitted from straight lines |
| **Camera library** | A picker limited to cameras the pipeline can actually process, with a readiness and calibration summary per device |
| **Visibility gate** | Live: a detector reports which pitch landmarks it can see, and the gate decides whether that is enough to solve from — while the answer can still be changed by moving the tripod |
| **Pair gate** | Judges the RIG, not each camera. One camera seeing only its own goal area is unsolvable alone and fine when the other shares six landmarks; two cameras can each look excellent and share nothing, and that rig is useless |
| **`modules/riseup-vision`** | A local Expo native module wrapping OpenCV `calib3d`, for the undistort solve. Swift/ObjC++ on iOS, Gradle on Android |

**Recording is still not built**, and the capture tab says so in one line rather
than advertising it. The screen does a real job today — survey and camera
library — because a tab that only announces future features fails Apple's
minimum-functionality bar (App Review 2.1 / 4.2) and reads to Google as
broken. Both are right.

**The lens coefficient order is normalised on OpenCV's.** Android hands
distortion over as `[k1,k2,k3,p1,p2]` and OpenCV expects `[k1,k2,p1,p2,k3]` —
tangential in the middle rather than at the end. Passing one to the other puts
`k3` in `p1`'s slot, which is a bug that produces plausible-looking output. See
`src/capture/survey/opencv.ts`.

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

### Environment variables, and which Clerk instance goes where

**One source of truth per environment.**

A **development** build reads your local `.env`, because its JS is bundled by
Metro on your machine. EAS has no `development` variables and does not need
any: a dev-client build embeds no JS bundle, so there is nothing for them to
end up in. The LAN address is per-machine anyway and does not belong on a
server.

A **preview or production** build bundles in the cloud, where `.env` does not
exist. Those values live on EAS:

```bash
npx eas-cli env:list --environment production
npx eas-cli env:set --name EXPO_PUBLIC_API_URL --value https://api.riseupai.co   --environment production --visibility plaintext
```

`eas.json` deliberately carries **no `env` blocks**. A value there silently
overrides the remote variable of the same name, so keeping any there means two
places to look and one of them quietly winning.

Miss a variable and the build **succeeds**, then the app dies on launch —
`src/lib/config.ts` throws on a missing one, which on a release build is a
white screen. The message names the variable, but only on a device with logs
attached.

**The app's Clerk key must match the backend's `CLERK_JWKS_URL`.** The backend
verifies every token's signature against the JWKS of one instance, so a
`pk_test` token reaching a backend configured for the live instance fails on
every request. The pairing is app build to API deployment to Clerk instance,
and all three move together:

| Build | API | Clerk instance | App key | Backend `CLERK_JWKS_URL` |
| --- | --- | --- | --- | --- |
| `development` | your LAN | `prompt-moose-74.clerk.accounts.dev` | `pk_test_...` | `https://prompt-moose-74.clerk.accounts.dev/.well-known/jwks.json` |
| `preview` | `api.riseupai.co` | `clerk.riseupai.co` | `pk_live_...` | `https://clerk.riseupai.co/.well-known/jwks.json` |
| `production` | `api.riseupai.co` | `clerk.riseupai.co` | `pk_live_...` | `https://clerk.riseupai.co/.well-known/jwks.json` |

Both JWKS endpoints are live and serve one RS256 signing key each, under
distinct instance ids (`ins_3AgU5S9...` for development, `ins_3Bp2g4s...` for
production). Distinct instances mean **distinct user and organization
databases**, and `club_id` is the Clerk organization id — so a club created on
the development instance has a different id on production, while every row in
`matches`, `player_metrics` and `team_metrics` still carries the old one.
Moving a club between instances is a data migration, not a config change.

**Preview and production run the same keys on purpose.** Preview is a release
rehearsal, not a sandbox: the same API, the same Clerk instance, the same data,
differing only in distribution and package format. Promoting a preview build to
production changes nothing about what it talks to, so nothing can shift
underneath it at the moment of release — which is the failure a separate
pre-production instance invites, where the thing you signed off is not quite
the thing you shipped.

The cost is that a preview APK operates on **real club data**. Uploads started
from one are real jobs against real quota, and identity assignments from one
are real edits.

> **Test against a test club, not a test instance.** The safety that a separate
> Clerk instance would have given comes instead from a dedicated organization on
> the production instance — an internal club whose matches nobody is coaching
> from. That keeps the rehearsal faithful, which is the point of this setup,
> while keeping a real club's season out of reach of a build that has not
> shipped yet.

### Before the first production build

Two things on the backend, neither of which is in this repo:

**`CLERK_JWKS_URL` must be set on the production deployment** to
`https://clerk.riseupai.co/.well-known/jwks.json` — verified live, one RS256
key. It was absent from the pulled Vercel production env at the time of
writing; if it really is unset, `clerk_auth.py` raises on every authenticated
request and the API returns 500 for everything. Check with `vercel env ls`.

**`CLERK_AUTHORIZED_PARTIES` has no entry for the app.** It defaults to three
web origins (`core/config.py`), and the backend rejects a token whose `azp`
claim is not among them. Mobile tokens pass today only because Clerk's native
SDKs generally omit `azp` and the check allows a missing claim. If sign-in
returns `401 "Token was not issued for this application."`, that is this — read
the rejected `azp` out of the server log and add it to the list.

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
npm run smoke              # the survey and framing maths, and the dictionaries
```

`npm run smoke` compiles the capture modules on their own and runs them under
plain Node — no Metro, no device, no React. The geometry it covers is a port of
`camera/rig.py` in `riseup-ml` and the thresholds are product decisions, so it
is the one part of this app that must not drift silently from the server.

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
  i18n/                    dictionaries, plural rules, the locale store
  capture/
    survey/                the rig record, the lens model, EXIF, validation
    framing/               landmarks, per-view visibility, the pair gate
    devices/               camera catalogue, readiness, persistence
    sensors/               device orientation, the location disclosure
    native/                the seam to modules/riseup-vision

modules/
  riseup-vision/           local Expo native module: OpenCV calib3d
```

**A new native module means a new build.** A development client compiled before
`riseup-vision` existed does not contain it, and the failure is not a build
error — it is a runtime one, on the device, in the undistort path. The module
degrades rather than crashing a build that lacks `calib3d`, so the tell is a
survey that silently refuses to solve. Rebuild with `eas-cli build` after
pulling any change under `modules/`.

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
- **v0.3** — the two-phone rig. **The framing half has landed early**: the
  survey, the lens model, the visibility gate and the pair gate are in and
  smoke-tested, because they are what decides whether footage can be solved and
  they had to exist before there was any point recording. What remains is
  pairing over Bluetooth/local network, preflight, the audible sync marker and
  in-match health.
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
