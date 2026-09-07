# What the phone needs from `riseup-backend`

Written from the mobile client, against the API as it actually is on
2026-09-06. Every item here is something the app already calls, already types,
or already degrades around — so each one is a server change with no matching
app release.

Ordered by what it unblocks, not by size.

---

## 1. Four paths in PRD §8.1 do not exist

The mobile PRD's "already in `riseup-backend` — reuse, do not duplicate" table
lists these under paths that 404. `src/api/endpoints.ts` uses the real ones;
this is recorded so the PRD can be corrected rather than rediscovered.

| PRD §8.1 says | Actually is |
| --- | --- |
| `POST /videos/confirm` | `POST /api/v1/videos/{job_id}/uploaded` |
| `GET /videos/jobs` | `GET /api/v1/videos` |
| `GET /videos/jobs/{id}` | `GET /api/v1/videos/{job_id}/status` |
| `POST /videos/.../lineup` | `POST /api/v1/matches/{job_id}/lineup` — keyed by **job** id |

**No backend work.** This is a documentation fix.

---

## 2. `POST /auth/device` and `POST /auth/refresh` are not needed

PRD §8.2 specifies them. The backend authenticates with Clerk
(`security/clerk_auth.py`), and `@clerk/clerk-expo` already provides
device-bound sessions with silent refresh, persisted to the iOS Keychain and
Android EncryptedSharedPreferences. The app uses that.

**Recommend deleting both from §8.2.** The one thing they would have bought
that Clerk does not — a shared club device with a short-lived pairing code
instead of individual logins — is PRD open question 1, and is a different
design from a device-bound token pair.

---

## 3. `POST /me/devices` — BLOCKING for §6

Nothing in §6 works without it. The app obtains an Expo push token on every
launch and posts it here; today that 404s, the token is cached, and the attempt
repeats next launch. **The endpoint shipping is sufficient — no app release.**

```
POST /api/v1/me/devices
  { "token": "ExponentPushToken[...]", "platform": "ios" | "android", "app_version": "0.1.0" }
  → 201 { "device_id": "..." }

DELETE /api/v1/me/devices/{device_id}     on sign-out
```

Sending is `POST https://exp.host/--/api/v2/push/send` with the stored tokens —
one credential for both platforms, instead of an APNs certificate chain and an
FCM key with different rotation schedules.

**The payload contract the app already routes on** (`src/notifications/types.ts`):

```jsonc
{
  "title": "Analysis complete",
  "body":  "Saturday vs AS Sale is ready.",
  "data": {
    "category": "analysis_complete",   // one of the six in §6
    "match_id": "...",                 // or "job_id"
    "sent_at":  "2026-09-06T18:04:00Z" // server time, for a phone that was off
  }
}
```

`data.category` must be one of `analysis_complete`, `analysis_failed`,
`lineup_needed`, `upload_complete`, `upload_stalled`, `quota_warning`. An
unknown category still lands in the inbox, with no deep link.

**§6 requires `analysis_failed` to name a cause, not a job id.** The failure
reason has to reach the payload as a sentence a coach can act on — "one camera
stopped recording after 62 minutes", "the two cameras did not overlap enough to
follow players across" — not a stack trace and not a job id.

---

## 4. `GET /matches/{id}/summary` — the §8.2 mobile read

The summary screen currently makes two calls and downloads every player's full
metric row, heatmap grids included, to render about forty numbers. On a
touchline connection that is exactly the difference §8.2 describes between
instant and sluggish.

`src/lib/summary.ts` composes the same result client-side, and is where this
plugs in when it lands.

---

## 5. The summary screen cannot show what §7 asks for

`matches` (see `storage/db.py` SCHEMA) has no columns for these:

| §7 asks for | Missing | Smallest fix |
| --- | --- | --- |
| Result | `home_score`, `away_score` | Two nullable integer columns |
| Date | kick-off time | A `kicked_off_at` column. `created_at` is the **upload** time — wrong for anything filmed Saturday and uploaded Sunday |
| Opponent | opponent name | A column, or accept that `label` is it |
| Pitch | venue name | `venue_id` is a bare FK with no join in the read path |
| xG | not computed | Pipeline work, not API work |

The app omits each of these rather than rendering a placeholder. A 0–0 that
looks real is worse than no scoreline.

---

## 6. Resumable upload — BLOCKING for v0.2

A presigned PUT is one request. There is no byte range to resume from, so an
upload interrupted at 90% of an 18 GB match restarts at zero. §5's "a 36 GB
pair over club Wi-Fi is an overnight job" is precisely the case that fails: an
overnight transfer that must complete in one unbroken run will not.

Fine for a 200 MB clip, which is all v0.1 does.

**Needs multipart:** `POST /videos/upload-url` returning an upload id and
per-part presigned URLs, a completion call that assembles them, and a status
call reporting which parts landed. `src/upload/manager.ts` keeps an
`uploadedBytes` cursor per entry so this lands as a change to one function.

---

## 7. Cross-cutting requirements from §8.3, none of which are implemented

The client already sends and handles all four. Each is a server-side change
alone.

**Idempotency keys.** Every mutating request carries `Idempotency-Key`. The
server ignores it, so a retried `POST /videos/upload-url` on a bad connection
mints a second job — and the club is billed twice for one match. This is the
highest-value item in this section.

**ETags.** The app sends `If-None-Match` on reads and implements the 304
branch. No endpoint returns an ETag, so foreground polling pulls a full body
every time.

**Cursor pagination.** `GET /matches` and `GET /videos` take `limit` only. A
club with 200 matches cannot page.

**Error envelope.** Errors are FastAPI's `{"detail": "..."}`, sometimes a
sentence and sometimes a validation array. §8.3 asks for a stable machine code
plus a human string. `src/api/errors.ts` parses `{code, message, detail}` when
it appears and falls back to a status map — so until the envelope exists,
every error a coach reads is the app's own sentence, not the server's.

---

## 8. `GET /me` returns no club name

Four fields: `user_id`, `club_id`, `role`, `email`. The settings screen shows
the raw Clerk org id (`org_2xyz...`) because inventing a name would be worse.

Adding `club_name` — and the user's full role list, since a user may hold more
than one — removes the only placeholder in the signed-in app.

---

## 9. `track_id` is not a player identity

`GET /players/{player_id}/history` takes a ByteTrack `track_id`, assigned per
match and numbered 1–22 within it. Track 7 on Saturday and track 7 last week
are different people roughly twenty-one times out of twenty-two. The backend's
own docstring flags the mapping to a persistent player id as future work.

§7's "comparison against that player's own season median" depends on it. The
app gates the comparison on the human-assigned name matching across matches
(`src/lib/season.ts`) — the only stable identity there is — so it appears only
for squads who have done their lineup assignments.

A median over unfiltered history would be a real number, rendered confidently,
describing nobody.

---

## 10. One active job per club

`videos.py::_refuse_if_busy` rejects a second concurrent job per club. The
upload queue is serialised to match, and a 409 returns an entry to the queue
rather than failing it. Worth knowing before §5's clip flow meets a club that
wants to upload five training clips at once.

---

## 11. Notification history

The inbox is a local mirror. A phone that was off for a week has no record of
what it missed, and a reinstall starts empty. §6's "matching in-app inbox" is
only fully true with a server-side list — `GET /me/notifications`, cursor
paginated, with read state.

---

## 12. The rig survey has to travel with the session

PRD §8.2 has `POST /capture/sessions` carrying "per-device homography from the
framing step, capture settings". That is not enough. The survey the app now
collects (`src/capture/survey/schema.ts`) is a larger document, and every part
of it is needed at ingest:

- **Intrinsics and their provenance.** `reported` (a device calibration),
  `geometric` (derived from focal length and sensor size), or `unknown`. The
  solver should weight a calibrated matrix differently from a 1%-accurate
  estimate, and it cannot do that if the payload only carries numbers.
- **Distortion**, in one of two models — Brown-Conrady coefficients on Android,
  a lookup table on iOS. Consumers must branch on `model`, not assume.
- **Which controlled settings actually applied.** A session where a phone
  refused to disable stabilisation is still processable, but the fixed-camera
  assumption does not hold and ingest needs to know that rather than infer it
  from a drifting solve.
- **Real frame timing** — measured fps, jitter, rolling-shutter skew, and the
  timestamp source. Speed metrics are wrong by the ratio between requested and
  delivered frame rate, and rolling shutter is a systematic bias in sprint
  speed, not noise.
- **Tilt and roll from the IMU**, which is an independent prior on two of the
  three rotation parameters and the cheapest available check on a bad solve.
- **The measured baseline**, which is what the app cross-checks the two camera
  positions against and what governs handover quality across the seam.
- **All four pitch sides plus a diagonal.** Municipal pitches are not
  rectangles; fitting positions to an assumed rectangle puts a systematic error
  into everything.

The record is versioned (`schemaVersion`) because sessions filmed this season
get re-processed by next season's pipeline, and it must be able to tell which
fields it can trust.

**Two endpoints, then:**

```
POST /api/v1/capture/sessions          # accepts `survey` alongside the rest
GET  /api/v1/venues/{id}/survey        # last survey for a venue
PUT  /api/v1/venues/{id}/survey        # pitch dimensions + markings, reusable
```

The venue split matters for the operator, not the model: pitch dimensions and
marking condition are per-ground and do not change between matches. Re-entering
them every Saturday is how a survey stops being done properly.

Also worth adding to `GET /venues/pitches`, which today returns
`length_m`/`width_m` only — a shape the four-sided survey cannot round-trip.

---

## 13. The saved camera list should be club-wide, not per-device

`src/capture/devices/store.ts` keeps the club's cameras — and their lens
calibrations — in local storage on one handset. That is the wrong scope for
what it holds.

A calibration is expensive to produce and identical for everybody: one person
photographs the chessboard once, and every other phone at that club should
then be able to pick "Club camcorder" and get the lens model with it. Kept
locally, the second volunteer to use the same camera has to calibrate it
again, which is exactly the per-match cost PRD §4.3 exists to remove.

```
GET    /api/v1/cameras                     # the club's cameras
POST   /api/v1/cameras                     # register one
PATCH  /api/v1/cameras/{id}                # rename
DELETE /api/v1/cameras/{id}
POST   /api/v1/cameras/{id}/calibrations   # store a solved lens
```

A calibration is keyed by **resolution and zoom**, not by camera alone — a 4K
mode is often a sensor crop while 1080p is a scale of it, so the intrinsics
differ and applying the wrong one is a silent scale error in every distance.
The client already models it that way (`LensCalibration`).

**The larger prize is cross-club.** Distortion is a property of a lens model,
not of one club's copy of it. A verified calibration for a given body at a
given resolution is reusable by every club with the same camera, which turns
a twenty-minute chessboard session into a lookup for everyone after the first.
That wants a curated, server-owned catalogue keyed by make/model/resolution —
seeded from calibrations that ingest has confirmed against real pitch
geometry, never from vendor datasheets.

The app deliberately ships no such table today: we hold no verified
coefficients for named consumer bodies, and a seeded plausible one would be
indistinguishable downstream from a measured one. `catalogue.ts` defines
support by capability class instead, which is honest and needs no data we do
not have.
