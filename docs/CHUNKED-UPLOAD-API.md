# Chunked capture — the API that does not exist yet

What the app needs in order to record into itself and upload during the match,
with the exact payloads. Written against `src/capture/upload/chunkManifest.ts`,
which already implements the client half and the verification.

---

## What exists today, and why it does not cover this

| Route | What it does |
| --- | --- |
| `POST /api/v1/videos/upload-url` | One presigned PUT for one whole file |
| `POST /api/v1/videos/rig-upload-urls` | One job, **one URL per camera**, whole files |
| `POST /api/v1/videos/{job_id}/uploaded` | Confirm one whole file |
| `POST /api/v1/videos/{job_id}/rig-uploaded` | Confirm every camera of a rig |
| `GET /api/v1/videos/{job_id}/status` | Job progress |

Every one of them assumes **the file is finished before the upload starts**.
That is the model the app has today: film on your own camera, come home, upload
an 18 GB file. It is coherent and it is not what chunking needs.

Chunking inverts the order. Segments are registered and uploaded **while the
match is still being played**, individually, out of order, from more than one
device, and the server has to decide whether what arrived can be put back
together. Nothing above can express "chunk 7 of camera A, 300 s to 600 s, and
here is its hash".

Three things follow that the existing routes have no place for:

1. **A session that outlives a request.** A job today is created by the upload
   that fills it. A capture session is created at kick-off and accepts chunks
   for ninety minutes.
2. **Continuity, not just completeness.** Chunk 7 arriving is not the same as
   chunk 7 joining up with chunk 6 — see below.
3. **A deletion gate.** The phone frees space as chunks are confirmed, so
   "confirmed" has to mean the server has the bytes and has checked them.

---

## 1. Open a session

```
POST /api/v1/capture/sessions
```

**Sends**

```json
{
  "rigId": "rig_3xK…",
  "venueId": "ven_9aQ…",
  "pitchId": "pit_2bF…",
  "startedAt": "2026-09-10T14:58:12.400Z",
  "appVersion": "0.1.0",
  "cameras": [
    {
      "role": "A",
      "deviceId": "dev_7c21…",
      "clubCameraId": "cam_4dE…",
      "widthPx": 3840,
      "heightPx": 2160,
      "fps": 30,
      "lens": {
        "lensId": "lens_88a…",
        "coefficients": [-0.31, 0.12, 0.001, -0.002, 0.04],
        "origin": "chessboard",
        "approximate": false,
        "cameraMatrix": [[2100,0,1920],[0,2100,1080],[0,0,1]]
      }
    }
  ]
}
```

`rigId`, `venueId` and `pitchId` are all nullable — a single phone filming a
friendly has none of them.

**The lens is sent as VALUES, not as a reference.** `lensId` is carried for
provenance only. A session that named a lens row would change meaning when
somebody re-calibrates that camera in March, silently rewriting how February's
match was analysed. `venue_cameras.calibrated_length_m` already sets this
precedent.

**Returns**

```json
{
  "sessionId": "ses_5mQ…",
  "chunkTargetSeconds": 300,
  "maxChunkBytes": 629145600,
  "expiresAt": "2026-09-10T20:58:12Z"
}
```

The server dictates chunk length rather than the client choosing, so the two
ends cannot disagree about what a chunk is, and so it can be tuned without
shipping an app release.

---

## 2. Register a chunk and get somewhere to put it

```
POST /api/v1/capture/sessions/{sessionId}/chunks
```

**Sends** — this is `ChunkManifest` from `chunkManifest.ts`, minus the fields
the session already knows.

```json
{
  "deviceId": "dev_7c21…",
  "role": "A",
  "sequence": 7,
  "startPtsNs": 2100000000000,
  "endPtsNs": 2400000000000,
  "frameCount": 9000,
  "byteLength": 412334102,
  "sha256": "9f2c…",
  "recordedAt": "2026-09-10T15:33:12.400Z",
  "final": false
}
```

`startPtsNs` / `endPtsNs` run on a clock that spans the **whole session**, not
one that restarts per chunk. A per-chunk clock starting at zero makes every
chunk look like it begins where the last one ended, and the continuity check
below then passes on footage with holes in it.

**Returns**

```json
{
  "uploadUrl": "https://…?X-Amz-Signature=…",
  "objectKey": "sessions/ses_5mQ…/A/00007.mp4",
  "expiresAt": "2026-09-10T16:33:12Z"
}
```

**Idempotent on `(sessionId, role, sequence)`.** A retry after a dropped
response must return the same object key rather than mint a second one, or a
flaky connection produces duplicate chunks that both look valid.

---

## 3. Confirm it landed — and only then may the phone delete

```
POST /api/v1/capture/sessions/{sessionId}/chunks/{role}/{sequence}/uploaded
```

**Sends**

```json
{ "sha256": "9f2c…", "byteLength": 412334102 }
```

**Returns**

```json
{ "verified": true, "mayDelete": true }
```

or, on a mismatch:

```json
{
  "verified": false,
  "mayDelete": false,
  "reason": "The stored object hashes to 4a71… and the phone recorded 9f2c…. Re-upload this chunk."
}
```

**`mayDelete` is the whole point of this route.** The phone frees space as it
goes, so it must never delete on the strength of a PUT that returned 200 — the
object can be truncated, the multipart can have failed silently. It deletes
when the server has re-hashed the bytes it holds and said so. `verified: false`
is recoverable precisely because the phone still has the file.

---

## 4. What has landed so far

```
GET /api/v1/capture/sessions/{sessionId}
```

**Returns**

```json
{
  "sessionId": "ses_5mQ…",
  "status": "recording",
  "cameras": [
    {
      "role": "A",
      "received": [0,1,2,3,4,5,6,8],
      "missing": [7],
      "durationSeconds": 2400,
      "bytes": 3298672816,
      "final": false
    }
  ]
}
```

Drives the in-match health display, and lets the phone re-send what never
arrived **while it still has it**. A gap found at reassembly is a gap nobody
can fill.

---

## 5. Finish, and reassemble

```
POST /api/v1/capture/sessions/{sessionId}/complete
```

**Sends** — the sync evidence, from `src/capture/sync/marker.ts`:

```json
{
  "endedAt": "2026-09-10T16:41:55.100Z",
  "sync": {
    "method": "audio_marker",
    "masterDeviceId": "dev_7c21…",
    "offsets": [
      {
        "deviceId": "dev_9f44…",
        "offsetSeconds": -0.1183,
        "propagationRemovedSeconds": 0.0875,
        "uncertaintySeconds": 0.0015,
        "peakRatio": 41.2
      }
    ]
  }
}
```

`method` is one of `audio_marker`, `ambient`, or `none`, and the server should
record which — an `ambient` alignment on a 30 m rig carries ±87 ms of
irreducible ambiguity and the analysis needs to know that before it reports
distances.

**Returns 200** when the set can be reassembled:

```json
{ "reassemblable": true, "jobId": "job_2Kd…", "durationSeconds": 5412 }
```

**Returns 409** when it cannot, with the problems named:

```json
{
  "reassemblable": false,
  "problems": [
    { "code": "TIME_GAP", "role": "A", "sequences": [6,7],
      "message": "4000 ms of the match is missing between chunk 6 and 7." }
  ]
}
```

The codes are exactly `ChunkSetProblem['code']` in `chunkManifest.ts`:
`EMPTY`, `DUPLICATE_SEQUENCE`, `MISSING_SEQUENCE`, `TIME_GAP`, `TIME_OVERLAP`,
`NOT_FINALISED`, `MIXED_SESSION`. **The server must run the same check the
client runs** — `verifyChunkSet` is the reference implementation, and the two
must not drift, because the client's copy is the one that can still fix things.

### The check that is easy to skip and must not be

Sorting by `sequence` and finding 0…n present is **not** enough. A chunk can
carry the right index and still be short — dropped frames at a boundary, a late
encoder flush, thermal throttling. Concatenated, that is a match with seconds
missing from the middle, no error raised anywhere, and a possession sequence
that appears to teleport.

Consecutive chunks must **abut in time**: `startPtsNs[n+1] - endPtsNs[n]` within
2 ms, which is well under one frame at 30 fps.

---

## 6. Abandon

```
POST /api/v1/capture/sessions/{sessionId}/abandon
```

**Sends** `{ "reason": "operator_cancelled" | "device_failed" | "storage_full" }`

Frees the staged objects. Without it a rig that fails mid-match leaves 30 GB of
orphaned chunks per abandoned attempt.

---

## Storage shape

```
sessions/{sessionId}/{role}/{sequence:05d}.mp4
```

Zero-padded so a plain bucket listing is already in sequence order, which is
what somebody debugging at 1 a.m. will do before they find this document.

---

## Summary of what to build

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/v1/capture/sessions` | POST | Open a session; returns chunk policy |
| `/api/v1/capture/sessions/{id}` | GET | What has landed; drives health + re-send |
| `/api/v1/capture/sessions/{id}/chunks` | POST | Register chunk, get presigned PUT |
| `/api/v1/capture/sessions/{id}/chunks/{role}/{seq}/uploaded` | POST | Verify hash; gate deletion |
| `/api/v1/capture/sessions/{id}/complete` | POST | Verify continuity, reassemble, enqueue |
| `/api/v1/capture/sessions/{id}/abandon` | POST | Release staged objects |

Tables: a `capture_sessions` row (club, rig, venue, pitch, status, chunk policy,
sync evidence) and a `capture_chunks` row per chunk (session, role, sequence,
pts range, frame count, sha256, bytes, object key, verified_at), unique on
`(session_id, role, sequence)`.
