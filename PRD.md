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

### 4.0 Two configurations, not one

Everything below assumed two fixed phones. There are two supported setups, and
the difference runs through framing, preflight and processing:

**Two phones, fixed.** The rig of PRD §3.0.1. Both bolted down for the match,
each covering a half with an overlap band between them. The only configuration
that clears the ~40 px detection floor in the far third (~47 px measured), and
therefore the only one that supports the full quality claim.

**One camera, panned by an operator.** A phone or camera on a tripod, turned to
follow play. Lower angular resolution — a single 4K camera covering the pitch
sits at ~20 px on the worst player, below the detection floor — so the far
third degrades. It is supported because it is what most clubs can actually
staff, and because it is a real product for the near and middle thirds.

**Say which one produced a result.** A single-camera match and a rig match are
not the same measurement, and a summary that presents them identically invites
a coach to compare them. The data-quality banner in §7 is where that belongs.

#### What "moving" means, precisely

The constraint is not that the camera must be still. It is that its **optical
centre must not translate**.

- **Panning is fine.** A camera turning on a tripod rotates about a fixed
  point. That is pure rotation, and the pitch stays solvable frame by frame
  from the lines in view.
- **Drifting is not.** Handheld, walking, airborne. A few centimetres of
  parallax between frames moves a player on the far side of the pitch by
  metres, and nothing downstream can undo it.

Rotation is recoverable; parallax is not. Every camera rule in the app follows
from that one sentence.

#### Notes for the physical rig

For the single-camera panned setup, a rig assisting the operator has three
constraints that are expensive to retrofit:

- **Put the pan axis over the optical centre**, not behind it. A head that
  rotates the camera about a point 10 cm behind the lens translates the centre
  as it turns, which reintroduces exactly the parallax that makes handheld
  footage unusable. This is the single most important mechanical requirement
  and it is invisible in the footage.

- **Pan only. No tilt, no roll, no height change during a match.** Tilt is
  recoverable in principle and doubles the calibration burden in practice;
  roll is worse. One axis keeps the solve cheap and keeps the operator's job
  to one motion.

- **Constrain the pan rate.** A fast swing produces rolling-shutter shear
  across the frame — the sensor reads top to bottom while the scene moves —
  which distorts player positions in a way that is systematic, not noise, and
  looks like nothing on playback. A damped head that resists fast movement is
  doing measurement work, not just making the footage look nicer.

- **The mount must not creep.** A head that drifts a degree over ninety
  minutes moves the far touchline by metres. Whatever locks the height and the
  tilt has to hold under its own weight for the full match.

Height and distance follow §3.0.1 unchanged: about 30 m back, as high as
available. Below ~20 m the geometry fails for a rig; for a single panned
camera it fails differently — the camera cannot reach the far corners without
a pan so wide that the pitch leaves frame entirely.

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

**Two phones that are not the same phone.** Clubs will not reliably own a
matched pair, so the app must handle a mismatched rig as a normal case rather
than an error (main PRD §3.0.10). Three things follow for this screen:

- **Do not require matching resolutions.** Record each device at the best it
  offers. Fusion weights each camera by its own geometry, so a better camera is
  preferred automatically wherever both can see; nothing needs configuring.

- **Name the weak half.** When the resolution check fails on a mixed rig, the
  shortfall belongs to one camera and moving the mount will not fix it.
  `RigReport.worst_camera` says which. The screen must offer the remedy that
  works — *"swap the phones so the better camera covers the far end"* — and
  must not show the placement advice, which is correct only for a matched rig
  that is badly positioned.

- **Offer the swap as an action, not as text.** The operator is on a ladder
  holding two phones. "Assign this device to the other end" should be one tap
  that exchanges the roles, then re-runs the check.

Where the two devices differ, the app shall recommend aiming the **better**
camera at the half the analyst cares about, and state plainly that the other
half will be weaker. A mismatched rig is still worth recording — it is strictly
better than one camera — but the operator should know what they are getting.

**Setup guidance to build the screen around** (measured, PRD §3.0.1):

- Mount at the halfway line, **~30 m back**, as high as available.
    
- Aim each phone **~32 m outside** the halfway line — not at the centre of its
  own half, which produces a huge overlap and uncovered corners at once.
    
- Below ~20 m back the overlap band collapses and identity handover fails.
    

### 4.3 Lens survey — once per camera, not once per match

Everything the pipeline does downstream assumes a rectilinear camera, and a
homography cannot represent lens distortion (main PRD 3.0.9). So every camera
needs a lens model before its footage is worth anything at the frame edges —
which is exactly where the far corners of the pitch land.

**On a phone, this is free.** iOS reports `AVCameraCalibrationData` and Android
reports `LENS_DISTORTION` with `LENS_INTRINSIC_CALIBRATION`; the app records
them and there is no user-facing step at all. Note that iOS gives a radial
magnification **lookup table**, not polynomial coefficients, and that Android's
coefficient order is not OpenCV's.

**On anything else, the app has to solve it.** A borrowed camcorder, an action
camera, or the club's existing fixed camera reports nothing. The survey flow:

1. Print the chessboard (the app offers a PDF, sized for A4 and for A3).
    
2. The app guides the operator through 12–20 photographs.
    
3. It solves intrinsics and distortion on device and stores the result against
   that camera, with its resolution and zoom setting.
    
4. It reports the reprojection error and how far a straight line at the frame
   edge actually bows, in pixels — so the operator sees whether the camera
   needed correcting at all.
    

**The guidance is the entire value of this screen.** The natural way to
photograph a calibration board produces a useless calibration: careful, well-lit,
head-on shots constrain focal length beautifully and distortion barely at all,
and yield a confident model that corrects nothing. The app must actively push
the operator to:

- **Tilt the board steeply**, 30–45°, in several directions.
    
- **Put the board in each corner of the frame.** The centre of a lens is very
  nearly rectilinear; the corners are the whole problem.
    
- Keep the board **flat** — a curled printout is indistinguishable from lens
  distortion and gets baked into every match.
    
- Shoot at the **resolution and zoom the match will be filmed at.**
    

A live overlay showing which regions of the frame have been covered is the
right interface: it turns an abstract instruction into a checklist the operator
can finish.

**Requirement:** recording is blocked without a lens model for every camera in
the rig, or an explicit acknowledgement that the footage will be treated as
rectilinear and the job marked accordingly.

### 4.4 Preflight

All blocking, all checkable offline:

| Gate | Threshold | Why |
| --- | --- | --- |
| Free space | ≥ 20 GB per device | 4K30 is ~18 GB for a full match; a device that fills mid-match takes the half with it |
| Power | External power, or battery > 90% | Sustained 4K recording exceeds battery for 105 minutes |
| Thermal | State nominal | A device already warm will throttle and drop frames |
| Locks | AE/AWB/focus locked on both | Cannot be retrofitted after the fact |
| Lens model | present for every camera | Distortion cannot be recovered later (4.3) |
| Framing | No blocking issues | §4.2 |
| Pairing | Both devices present, roles assigned | §4.1 |

### 4.5 Recording

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
    

### 4.6 In-match health

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
    

### 5.1 Chunked upload — signing and reassembly

Upload is not a job that starts when the match ends. Video is cut into short
segments and sent **during play**, so the phone never holds more than a couple
of minutes at a time and a 90-minute match cannot die at minute 70 because
storage ran out. The full recording is reconstructed in storage on arrival;
analysis runs when the operator stops.

That means segments arrive out of order, and the server has to put them back
together with certainty rather than hope.

**Not a visual watermark.** The instinct is to burn a marker into the picture.
It must not be done: these frames *are* the measurement. A burned-in marker
occludes whatever is behind it, and near the far touchline it occludes players
at exactly the scale — around 40 px tall — where detection is already marginal.
It also does not survive re-encoding faithfully and cannot be verified without
decoding video.

**A signed manifest instead.** Every chunk carries, in its upload and in its own
container metadata:

| Field | Why |
| --- | --- |
| `sessionId`, `deviceId`, `role` | Which match, which camera. Prevents two matches being spliced. |
| `sequence` | 0-based, monotonic. What the server sorts on. |
| `startPtsNs`, `endPtsNs` | On a clock running for the **whole session**, not restarting per chunk. |
| `frameCount` | Cross-checks duration against frame rate. |
| `sha256`, `byteLength` | Integrity, and the chain of custody the backend already computes for whole uploads. |
| `final` | Set on the last chunk. Distinguishes "the match ended" from "the phone went into a tunnel". |

**Ordering is the easy half. Continuity is the half that bites.** Out-of-order
arrival is not really the problem — every chunk knows its index. What an index
cannot tell you is whether the chunks actually *join up*. A chunk can carry the
right sequence number and still be short: dropped frames at a boundary, a late
encoder flush, thermal throttling. Sorted by index you get 0, 1, 2, 3 with a
hole between 1 and 2 that nothing in the numbering reveals. Concatenated, that
is a match with four seconds missing from the middle, no error raised anywhere,
and a possession sequence that appears to teleport.

So the check is that consecutive chunks **abut in time**, within a tolerance
well under one frame — contiguity in time, not just in index.

**Verified twice, on purpose.** On the phone before the session is completed,
and on the server before anything is concatenated. The phone check is the one
that matters: deletion is gated on confirmation, so a missing chunk found there
can still be re-sent. A gap found only at the server is a gap nobody can fill.

Implemented in `src/capture/upload/chunkManifest.ts`; see also gap 15 in
`docs/BACKEND-GAPS.md`.

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
