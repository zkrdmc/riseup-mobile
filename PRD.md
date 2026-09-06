# RiseUp Mobile — Product Requirements

Companion app for the RiseUp football analytics platform.

Related: `Product/RiseUp - PRD.md` §3.0 (Multi-Camera Capture & Fusion Layer) is
the normative specification for everything in §4 below. Where this document and
that one disagree, that one wins.

---

## 1. What this is, and what it is not

**It is a companion.** Four jobs, in order of how much of the engineering they
justify:

1. **Film a match** — the two-phone rig, including the setup that makes the
   footage usable.
2. **Get footage off the phone** — resumable upload, verified deletion.
3. **Know when analysis is ready** — push notification, and what changed.
4. **Glance at the result** — enough to satisfy curiosity on the drive home.

**It is not the analysis product.** The web dashboard remains where tactical
work happens. Explicit non-goals for v1:

- No tactical chatbot, no scouting search, no player similarity.
    
- No video scrubbing, telestration, or clip editing on the phone.
    
- No squad administration beyond confirming a lineup.
    

The reason to be strict about this: the capture path is genuinely hard and
carries the whole product's data quality. Every hour spent building a phone
version of the dashboard is an hour not spent on the thing only the phone can
do.

---

## 2. Users — there are two of them, and they are not the same person

| | **The Analyst** | **The Operator** |
| --- | --- | --- |
| Who | Head coach, assistant, club analyst | Youth coach, volunteer, kit man |
| Wants | Did the analysis land, and what does it say | To be told exactly where to stand |
| Analytics literacy | High | None assumed |
| Touches the rig | Never | Every match |
| Opens the app | Twice a week | Twice a month, under time pressure |

Designing for one average user serves neither. The Operator is doing an
unfamiliar physical task, outdoors, probably late, with a match about to kick
off — and they are the one whose mistakes are unrecoverable.

**Requirement:** the home screen is role-aware. An account marked Operator
opens directly into capture. An Analyst opens into the match list. A user may
hold both roles and switch, but the app does not make them choose every time.

---

## 3. Offline is the default, not an edge case

Moroccan municipal grounds and academy pitches do not have reliable data. The
Operator flow happens where there is no signal.

**Every step from arriving at the ground to the final whistle must work fully
offline**, including pairing, framing validation, preflight, recording and
in-match health. Nothing in the capture path may block on a network call.

Upload, notification and analytics are online features and may say so.

This constraint drives the framing-check design in §4.2 and is the single
most likely thing to be forgotten during implementation.

---

## 4. Capture

This is PRD §3.0.2 rendered as a user flow. It is the majority of the
engineering.

### 4.1 Pairing and roles

- Two devices pair locally over Bluetooth/local network — **not** through the
  server (§3).
    
- One is designated **A (master)**. A defines the master timeline (PRD §3.0.3)
  and its track ids survive fusion. The choice is persisted and shown
  unambiguously on both screens, because a swapped assignment inverts the sync
  offset sign.
    
- The pair is checked for compatibility: same capture resolution and frame
  rate, both able to lock exposure/white balance/focus. A matched device model
  is strongly preferred; a mismatched pair warns and records the difference for
  the colour correction at calibration.
    

**Android:** devices reporting Camera2 `INFO_SUPPORTED_HARDWARE_LEVEL` of
`LEGACY` cannot honour the locks and are refused at pairing, with an
explanation. This is not negotiable — a rig that cannot lock exposure produces
a visible seam and degraded re-identification for the whole match.

### 4.2 Framing assistant — the highest-value screen in the app

A misaimed rig is invisible to the operator and is not discovered until
processing, hours later, when the match is unrepeatable. This screen exists to
make that failure impossible.

**Flow:**

1. Mount both phones, aim roughly.
    
2. On each device, the operator taps 4+ known pitch points on the live
   viewfinder — corners, penalty box corners, halfway line ends. A guided
   sequence, one point at a time, with a diagram showing which.
    
3. The app solves a homography per device from those correspondences.
    
4. It runs the coverage check and renders the verdict as an overlay:
   which parts of the pitch neither camera sees, how wide the overlap band is,
   and how many pixels tall a player will be at the worst point.
    
5. Blocking issues must be resolved before recording is available. Advisory
   issues are shown and dismissible.
    

**Why manual point-tapping rather than automatic line detection:** it works
offline on any device with no model, it takes about twenty seconds, and it
fails visibly rather than silently. Automatic pitch-line calibration is the
better long-term answer and is already the server's job at ingest — but a
viewfinder overlay that silently mis-solves is worse than one that asks.

**Algorithm ownership.** The check is `camera/rig.py` in `riseup-ml`
(`analyse()`, `CameraView`, the convex-polygon clipping). It must be ported to
the app, not reimplemented — it is ~200 lines of pure convex geometry with no
dependencies, and the thresholds are product decisions that must not drift
between two codebases. The server re-runs the same check at ingest against the
real solver's homographies; a disagreement between the two is a bug in the port
and should be reported as such.

The guidance the check produces is already actionable ("the overlap band is
7 m, below the 12 m needed to hand identity across it — angle the phones toward
each other") and should be surfaced close to verbatim.

**Setup guidance to build the screen around** (measured, PRD §3.0.1):

- Mount at the halfway line, **~30 m back**, as high as available.
    
- Aim each phone **~32 m outside** the halfway line — not at the centre of its
  own half, which produces a huge overlap and uncovered corners at once.
    
- Below ~20 m back the overlap band collapses and identity handover fails.
    

### 4.3 Preflight

All blocking, all checkable offline:

| Gate | Threshold | Why |
| --- | --- | --- |
| Free space | ≥ 20 GB per device | 4K30 is ~18 GB for a full match; a device that fills mid-match takes the half with it |
| Power | External power, or battery > 90% | Sustained 4K recording exceeds battery for 105 minutes |
| Thermal | State nominal | A device already warm will throttle and drop frames |
| Locks | AE/AWB/focus locked on both | Cannot be retrofitted after the fact |
| Framing | No blocking issues | §4.2 |
| Pairing | Both devices present, roles assigned | §4.1 |

### 4.4 Recording

- **Into the app's own container, never the system camera roll.** The app then
  owns codec, bitrate and frame-rate stability; it can write a sidecar carrying
  the sync marker and lock state; and it owns deletion, which matters because
  iOS cannot remove a photo-library asset without a system prompt per file.
    
- 4K30, constant frame rate where the device permits. Variable frame rate is
  detected and recorded in the sidecar so ingest can normalise rather than
  assume.
    
- An audible **sync marker** is emitted at session start on both devices
  (PRD §3.0.3). Audio must be recorded on both and must not be
  noise-suppressed asymmetrically.
    
- Recording is one tap on A; B follows over the local link. B also starts on
  its own if the link drops — a rig that fails to record because the phones
  lost Bluetooth is worse than one that starts 200 ms apart, which the audio
  sync corrects anyway.
    

### 4.5 In-match health

A persistent, glanceable state on both devices, and an alert on A if B is in
trouble:

- Thermal throttling
    
- Dropped frames
    
- Remaining storage and battery, expressed as **minutes of recording left**,
  not percentages
    
- Link to the paired device
    

Half-time is a recording boundary. The app prompts to stop and restart, and the
two halves become two segments of one session.

---

## 5. Upload and retention

- **Resumable and background.** Must survive process death, network loss and
  the app being closed. A 36 GB pair over club Wi-Fi is an overnight job.
    
- **Wi-Fi by default**, with an explicit opt-in for cellular that states the
  data volume.
    
- Per-segment progress, and an honest time estimate.
    
- **Deletion is opt-in and only after server-side checksum verification.**
  Deleting a club's only copy of a match on the strength of an upload believed
  to have succeeded is an unrecoverable failure of trust. Default is to keep
  and prompt later.
    
- **Clips as well as matches.** A short clip taken on the phone (a drill, a
  set piece) goes through the same upload path with a different processing
  profile. This is the low-commitment entry point for a club that has not yet
  committed to filming a whole match with a rig, and is likely the most-used
  feature in the first month.
    

---

## 6. Notifications

Push, with a matching in-app inbox so nothing is only ever a notification.

| Event | Priority | Action |
| --- | --- | --- |
| Analysis complete | High | Opens the match summary |
| Analysis failed | High | Opens a plain-language reason and what to do |
| Needs lineup assignment | High | Opens the assignment screen — blocks results |
| Upload complete | Normal | Offers verified deletion |
| Upload stalled > 24 h | Normal | Opens upload manager |
| Quota warning | Normal | Opens billing |

**Requirements:**

- Never notify without a resolvable action.
    
- Per-category preferences, and quiet hours.
    
- "Analysis failed" must name a cause the operator can act on — insufficient
  coverage, sync failure, one camera lost — not a job id.
    

---

## 7. Glance analytics

Sized for a phone and for two minutes of attention. Anything deeper deep-links
to the web dashboard.

**Match summary**
- Result, date, opponent, pitch
- Data quality banner: intervals where only one camera contributed
  (PRD §3.0.4), sync residual if abnormal
- Team totals: distance, sprints, possession share, xG
- Top five players by distance and by sprints
- Link: open the auto-directed video (PRD §3.0.6)

**Player quick view**
- Distance, top speed, sprint count, minutes
- Comparison against that player's own season median — not against the squad,
  which invites the wrong conversation on a phone screen
- Heatmap thumbnail

**Match list**
- Newest first, with processing state inline

Explicitly out of scope for v1: xT flow maps, pass networks, tactical shape,
player similarity. They do not survive the screen size and their absence is
what keeps the app small.

---

## 8. API surface

### 8.1 Already in `riseup-backend` — reuse, do not duplicate

| Endpoint | Use |
| --- | --- |
| `POST /videos/upload` | Direct upload (small clips) |
| `POST /videos/upload-url` | Presigned URL for large uploads |
| `POST /videos/confirm` | Confirm presigned upload, start extraction |
| `GET /videos/upload-mode` | Which upload path this deployment supports |
| `GET /videos/jobs`, `GET /videos/jobs/{id}` | Upload/processing state |
| `POST /videos/.../lineup` | Manual player identity assignment |
| `GET /matches`, `/matches/{id}`, `/matches/{id}/players` | Match list and results |
| `GET /me` | Current user, club, roles |
| `GET/PUT /team-index` | Squad, onboarding state |
| `GET /venues/pitches` | Pitch dimensions for the framing check |

### 8.2 New endpoints required

**Auth**
- `POST /auth/device` — exchange credentials for a device-bound token pair.
- `POST /auth/refresh` — refresh without re-login. Mobile sessions are long;
  an app that logs the Operator out before a match is a failed app.

**Push**
- `POST /me/devices` — register a push token, platform, app version.
- `DELETE /me/devices/{id}` — deregister on logout.
- `GET/PATCH /me/notification-preferences`.

**Capture sessions** — the rig's unit of work, distinct from an upload
- `POST /capture/sessions` — open a session: pitch id, device pair, roles,
  per-device homography from the framing step, capture settings.
- `PATCH /capture/sessions/{id}` — state transitions and health telemetry.
- `POST /capture/sessions/{id}/segments` — register a segment (half) per
  device, then upload via the existing presigned flow.
- `POST /capture/sessions/{id}/complete` — all segments uploaded; enqueue the
  dual-camera pipeline.
- `GET /capture/sessions/{id}` — status, including per-device upload progress.

  A session is not an upload. Two devices, two halves and four files must
  arrive as one analysable unit, and the sync offset, the rig homographies and
  the lock state belong to the session rather than to any one file.

**Framing validation (server-side re-check)**
- `POST /capture/framing/validate` — accepts two homographies plus image sizes
  and pitch dimensions, returns the same report the app computed. Used at
  ingest and for support, **not** on the critical path at the ground (§3).

**Mobile-shaped reads**
- `GET /matches/{id}/summary` — one compact payload for §7. The existing
  `/matches/{id}` plus `/players` is several round trips and far more data than
  the summary screen renders; on a phone that is the difference between
  instant and sluggish.
- `GET /matches/{id}/video` — playback URL for the auto-directed feed, with
  the tactical panorama as an alternate.

**Clips**
- `POST /clips` — upload with a processing profile, reusing the video upload
  path underneath.

### 8.3 Cross-cutting API requirements

- Every list endpoint paginated, cursor-based.
    
- ETag / `If-None-Match` on match reads — the app polls on foreground.
    
- Idempotency keys on every mobile-initiated `POST`. Uploads retry from poor
  networks; a duplicated session or a double-charged job is the predictable
  consequence of not doing this.
    
- Errors carry a stable machine code plus a human string the app can show
  directly.
    

---

## 9. Technology

The shell can be cross-platform; **the capture path cannot.**

Locking exposure, white balance and focus, controlling bitrate and frame-rate
stability, and reading thermal state are `AVCaptureDevice` on iOS and
Camera2/CameraX on Android, with materially different semantics and no
faithful cross-platform abstraction. Attempting one is how the AE lock quietly
stops working on a subset of Android devices and nobody notices for a season.

**Recommendation:** React Native or Flutter for the shell (match list, summary,
upload manager, settings — most of the screens, little of the risk), with
native modules for capture, framing overlay and background upload. Budget the
capture module as two implementations, because it is two implementations.

---

## 10. Phasing

| Phase | Scope | Why this order |
| --- | --- | --- |
| **v0.1** | Auth, clip upload, match list, summary, push notifications | Ships value with no rig, and exercises the whole backend path end to end |
| **v0.2** | Single-phone match capture, upload, verified deletion | Capture mechanics without the rig's complexity |
| **v0.3** | Two-phone rig: pairing, framing assistant, preflight, sync marker, health | The hard part, on foundations that already work |
| **v0.4** | Data-quality surfacing, auto-directed video playback, lineup assignment | Closes the loop from filming to watching |

v0.1 deliberately precedes any camera work. It is the fastest route to a coach
holding something real, and every later phase depends on the auth, upload and
notification plumbing it builds.

---

## 11. Non-functional

- **Offline-first** for the entire capture path (§3).
    
- **Storage:** ~18 GB per device per match at 4K30. The app manages its own
  container, shows usage, and never silently fills the device.
    
- **Battery and thermal:** capture assumes external power and says so.
    
- **Security:** device-bound tokens, no long-lived credentials on device,
  biometric re-auth for billing. Footage in the app container is covered by
  platform file encryption.
    
- **Privacy:** match footage contains minors at academy level. Retention,
  deletion and consent follow whatever the club agreement records
  (`GET /agreements`); the app must never be the reason footage outlives it.
    

---

## 12. Open questions

1. **Does the Operator have an account?** A per-club shared device with a
   short-lived pairing code may be better than individual logins for a
   volunteer who films twice a season.
    
2. **Two phones, whose?** A club may not own two matched devices. Does RiseUp
   supply a kit, and does that change the "no hardware" positioning?
    
3. **Half-time handling** — automatic detection, or explicitly operator-driven?
   Automatic is nicer and is one more thing that can be wrong.
    
4. **Clip processing profile** — which metrics are meaningful on a 30-second
   clip with no pitch calibration? Possibly none, which would make clips a
   storage-and-sharing feature rather than an analysis one.
    
5. **Does the app need to play the panorama at all**, or is the auto-directed
   feed sufficient on a phone? The tactical view may be web-only.
