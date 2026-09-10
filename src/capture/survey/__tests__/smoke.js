/**
 * Smoke test for the pure-TypeScript half of the lens/survey work.
 *
 * Everything here runs without a phone, a camera or a native toolchain. The
 * calib3d module cannot be tested this way — it needs a compiled build — so
 * this covers the parts that CAN be checked now, which is most of the maths.
 */

const derive = require('../../../../.smoke/capture/survey/derive');
const distortion = require('../../../../.smoke/capture/survey/distortion');
const opencv = require('../../../../.smoke/capture/survey/opencv');
const exif = require('../../../../.smoke/capture/survey/exif');
const validate = require('../../../../.smoke/capture/survey/validate');
const landmarks = require('../../../../.smoke/capture/framing/landmarks');
const visibility = require('../../../../.smoke/capture/framing/visibility');
const detector = require('../../../../.smoke/capture/framing/detector');
const pair = require('../../../../.smoke/capture/framing/pair');
const dicts = require('../../../../.smoke/i18n/dictionaries');
const i18nmod = require('../../../../.smoke/i18n/i18n');
const chunks = require('../../../../.smoke/capture/upload/chunkManifest');
const chunksync = require('../../../../.smoke/capture/devices/merge');
const solve = require('../../../../.smoke/capture/calibration/solve');
const marker = require('../../../../.smoke/capture/sync/marker');

let pass = 0;
let fail = 0;

function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`);
  }
}

function close(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

console.log('\n1. OpenCV coefficient ordering — the bug this was all about');
{
  // Android LENS_DISTORTION is [k1, k2, k3, p1, p2].
  const android = [0.1, 0.2, 0.3, 0.4, 0.5];
  const model = opencv.fromAndroidLensDistortion(android);
  // OpenCV distCoeffs is [k1, k2, p1, p2, k3] — tangential in the MIDDLE.
  check(
    'Android -> OpenCV swaps k3 past p1,p2',
    JSON.stringify(model.coefficients) === JSON.stringify([0.1, 0.2, 0.4, 0.5, 0.3]),
    JSON.stringify(model.coefficients),
  );
  check(
    'round-trip back to Android order is lossless',
    JSON.stringify(opencv.toAndroidLensDistortion(model)) === JSON.stringify(android),
  );

  let threw = false;
  try {
    opencv.fromAndroidLensDistortion([0.1, 0.2, 0.3]);
  } catch {
    threw = true;
  }
  check('refuses a vector that is not five coefficients', threw);
}

console.log('\n2. Brown-Conrady forward/inverse round-trip');
{
  const model = { coefficients: [-0.28, 0.09, 0.001, -0.002, 0.0], origin: 'chessboard', approximate: false };
  let worst = 0;
  for (const [x, y] of [[0.1, 0.05], [0.4, 0.3], [-0.5, 0.45], [0.62, -0.38]]) {
    const d = opencv.distortNormalised(model, x, y);
    const u = opencv.undistortNormalised(model, d.x, d.y);
    worst = Math.max(worst, Math.hypot(u.x - x, u.y - y));
  }
  check('undistort inverts distort to <1e-6 normalised', worst < 1e-6, `worst ${worst.toExponential(2)}`);
}

console.log('\n3. Plumb-line fit recovers a known distortion');
{
  const W = 3840;
  const H = 2160;
  const LAMBDA_TRUE = -0.18; // barrel, roughly an action camera
  const norm = 0.5 * Math.hypot(W, H);
  const cx = W / 2;
  const cy = H / 2;

  // Invert the division model to turn a straight line into a bent observation:
  // find p_d such that p_d / (1 + L|p_d|^2) == p_u.
  function distort(pu) {
    let pd = { x: pu.x, y: pu.y };
    for (let i = 0; i < 60; i += 1) {
      const r2 = pd.x * pd.x + pd.y * pd.y;
      pd = { x: pu.x * (1 + LAMBDA_TRUE * r2), y: pu.y * (1 + LAMBDA_TRUE * r2) };
    }
    return pd;
  }

  // Four lines that are straight in the world, at different distances from the
  // centre — which is what makes the fit well-constrained.
  const lines = [];
  const yFractions = [0.08, 0.3, 0.72, 0.94];
  yFractions.forEach((fy, i) => {
    const pts = [];
    for (let k = 0; k <= 8; k += 1) {
      const pu = { x: ((k / 8) * W - cx) / norm, y: (fy * H - cy) / norm };
      const pd = distort(pu);
      pts.push({ x: pd.x * norm + cx, y: pd.y * norm + cy });
    }
    lines.push({ id: `l${i}`, label: `line ${i}`, points: pts });
  });

  const result = distortion.fitDistortion(lines, W, H);
  check('fit succeeds on four synthetic lines', result.ok === true);
  if (result.ok) {
    const f = result.fit;
    check(
      'recovers lambda to within 0.005',
      close(f.lambda, LAMBDA_TRUE, 0.005),
      `got ${f.lambda.toFixed(4)}, true ${LAMBDA_TRUE}`,
    );
    check(
      'residual after correction is sub-pixel',
      f.rmsResidualPx < 1.0,
      `${f.rmsResidualPx.toFixed(3)} px (was ${f.rmsResidualBeforePx.toFixed(1)} px)`,
    );
    check('correction is a large improvement', f.rmsResidualBeforePx > f.rmsResidualPx * 10);
    check('fit is judged credible', distortion.fitIsCredible(f) === true);

    const bow = distortion.edgeBowPx(f);
    check('edge bow is a usable operator number', bow > 5, `${bow.toFixed(1)} px at the frame edge`);
  }

  // A straight lens must fit to ~zero and still be credible.
  const straight = [];
  yFractions.slice(0, 2).forEach((fy, i) => {
    const pts = [];
    for (let k = 0; k <= 8; k += 1) {
      pts.push({ x: (k / 8) * W, y: fy * H });
    }
    straight.push({ id: `s${i}`, label: `straight ${i}`, points: pts });
  });
  const flat = distortion.fitDistortion(straight, W, H);
  check(
    'a rectilinear lens fits to lambda ~ 0',
    flat.ok && Math.abs(flat.fit.lambda) < 0.01,
    flat.ok ? `lambda ${flat.fit.lambda.toExponential(2)}` : 'fit failed',
  );
  check('and is still reported credible', flat.ok && distortion.fitIsCredible(flat.fit) === true);

  // One line is not enough evidence, by design.
  const one = distortion.fitDistortion([lines[0]], W, H);
  check('one line is refused', one.ok === false && one.failure.reason === 'too_few_lines');
}

console.log('\n4. Intrinsics from sensor geometry');
{
  // A representative flagship rear camera: 6.9 mm lens, 9.8 x 7.3 mm sensor.
  const i = derive.intrinsicsFromGeometry({
    focalLengthMm: 6.9,
    sensorPhysicalWidthMm: 9.8,
    sensorPhysicalHeightMm: 7.3,
    activeArrayWidthPx: 4032,
    activeArrayHeightPx: 3024,
  });
  const expectedFx = 6.9 * (4032 / 9.8);
  check('fx = f * (Wpx / Wmm)', close(i.fxPx.value, expectedFx, 0.01), `${i.fxPx.value.toFixed(1)} px`);
  check('square pixels give fx ~ fy', close(i.fxPx.value, i.fyPx.value, i.fxPx.value * 0.01));
  check('marked as a geometric estimate', i.source === 'geometric');
  check('principal point assumed at centre', i.cxPx.value === 2016 && i.cyPx.value === 1512);
  check('carries a non-null uncertainty', i.fxPx.sigma > 0);

  const fov = derive.horizontalFovDeg(i);
  check('implies a plausible FOV', fov > 50 && fov < 80, `${fov.toFixed(1)} deg`);
}

console.log('\n5. Intrinsics scaling — active array vs recorded stream');
{
  const base = derive.intrinsicsFromGeometry({
    focalLengthMm: 6.9,
    sensorPhysicalWidthMm: 9.8,
    sensorPhysicalHeightMm: 7.3,
    activeArrayWidthPx: 4000,
    activeArrayHeightPx: 3000,
  });
  const scaled = derive.scaleIntrinsicsToStream(base, 2000, 1500);
  check('same aspect ratio scales by exactly the ratio', scaled !== null && close(scaled.fxPx.value, base.fxPx.value / 2, 0.01));
  const cropped = derive.scaleIntrinsicsToStream(base, 3840, 2160);
  check('different aspect ratio refuses rather than guessing', cropped === null);
}

console.log('\n6. Orientation from gravity');
{
  const flat = derive.orientationFromGravity(Array(50).fill({ x: 0, y: 0, z: 1 }), new Date().toISOString(), 1000);
  check('phone flat on its back => camera points down, +90', close(flat.tiltDeg.value, 90, 0.01), `${flat.tiltDeg.value.toFixed(2)} deg`);

  const upright = derive.orientationFromGravity(Array(50).fill({ x: 0, y: 1, z: 0 }), new Date().toISOString(), 1000);
  check('upright => optical axis level, 0', close(upright.tiltDeg.value, 0, 0.01));
  check('and reported stable', upright.stable === true);

  // A rig aimed 10 degrees down.
  const t = (10 * Math.PI) / 180;
  const tilted = derive.orientationFromGravity(
    Array(50).fill({ x: 0, y: Math.cos(t), z: Math.sin(t) }),
    new Date().toISOString(),
    1000,
  );
  check('a 10 deg downward aim reads as 10', close(tilted.tiltDeg.value, 10, 0.01), `${tilted.tiltDeg.value.toFixed(2)} deg`);

  // Shaken: magnitude far from 1 g must not be trusted.
  const shaken = derive.orientationFromGravity(
    Array(50).fill(0).map((_, i) => ({ x: 0.4 * Math.sin(i), y: 1, z: 0.4 * Math.cos(i) })),
    new Date().toISOString(),
    1000,
  );
  check('a moving device is flagged unstable', shaken.stable === false);
}

console.log('\n7. Baseline cross-check');
{
  const cam = (role, along) => ({
    role,
    sourceKind: 'phone',
    external: null,
    deviceId: 'd',
    deviceModel: 'm',
    heightM: { value: 6, sigma: 0.03, provenance: 'measured' },
    perpendicularDistanceM: { value: 30, sigma: 0.03, provenance: 'measured' },
    alongTouchlineM: { value: along, sigma: 0.03, provenance: 'measured' },
    coversHalf: role === 'A' ? 'west' : 'east',
    touchlineSide: 'north',
    orientation: { tiltDeg: { value: 8, sigma: 0.2, provenance: 'device' }, rollDeg: { value: 0, sigma: 0.2, provenance: 'device' }, headingDeg: null, stable: true, sampleCount: 50, durationMs: 1000, capturedAt: '' },
    intrinsics: { source: 'geometric', fxPx: { value: 2800, sigma: 28, provenance: 'derived' }, fyPx: { value: 2800, sigma: 28, provenance: 'derived' }, cxPx: { value: 1920, sigma: 40, provenance: 'derived' }, cyPx: { value: 1080, sigma: 40, provenance: 'derived' }, skew: null, focalLengthMm: 6.9, sensorPhysicalWidthMm: 9.8, sensorPhysicalHeightMm: 7.3, activeArrayWidthPx: 3840, activeArrayHeightPx: 2160 },
    distortion: { model: 'none', radial: null, tangential: null, lookupTable: null, division: null },
    settings: { videoStabilisation: 'applied', opticalStabilisation: 'applied', autofocusLock: 'applied', autoExposureLock: 'applied', whiteBalanceLock: 'applied', zoomRatio: 1, cropRegion: null, lensId: null, lensFacing: 'back' },
    timing: { nominalFps: 30, measuredFps: null, frameIntervalJitterMs: null, rollingShutterSkewNs: null, timestampSource: 'realtime', sampleTimestampsNs: null },
  });

  const survey = (measuredBaseline) => ({
    schemaVersion: 1, surveyId: 's', sessionId: null, venueId: null,
    startedAt: '', completedAt: '', rigMode: 'pair',
    pitch: {
      northTouchlineM: { value: 105, sigma: 0.5, provenance: 'measured' },
      southTouchlineM: { value: 105, sigma: 0.5, provenance: 'measured' },
      westGoalLineM: { value: 68, sigma: 0.5, provenance: 'measured' },
      eastGoalLineM: { value: 68, sigma: 0.5, provenance: 'measured' },
      diagonalM: { value: 125, sigma: 0.5, provenance: 'measured' },
      markingCondition: 'fresh', surface: 'grass', notes: null,
    },
    venueFix: null,
    cameras: [cam('A', -10), cam('B', 10)],
    baselineM: measuredBaseline === null ? null : { value: measuredBaseline, sigma: 0.03, provenance: 'measured' },
    notes: null, appVersion: '0.1.0',
  });

  const good = derive.checkBaseline(survey(20.0));
  check('derives 20 m from two positions 10 m either side', close(good.derivedM, 20, 1e-9), `${good.derivedM.toFixed(3)} m`);
  check('an agreeing tape gives a small z', Math.abs(good.zScore) < 3, `z = ${good.zScore.toFixed(2)}`);

  // A transcription error: the tape says 26 m.
  const bad = derive.checkBaseline(survey(26.0));
  check('a 6 m disagreement is caught', Math.abs(bad.zScore) > 3, `z = ${bad.zScore.toFixed(1)}, residual ${bad.residualM.toFixed(1)} m`);

  const none = derive.checkBaseline(survey(null));
  check('no measurement still reports the derived value', none.measuredM === null && none.derivedM > 0);
}

console.log('\n8. EXIF focal length');
{
  const facts = exif.readExifCameraFacts({
    Make: 'GoPro',
    Model: 'GoPro HERO12 Black',
    '{Exif}': { FocalLenIn35mmFilm: 15, DigitalZoomRatio: 1 },
  });
  check('reads make and model through nested iOS dictionaries', facts.make === 'GoPro' && facts.model === 'GoPro HERO12 Black');
  check('reads the 35mm equivalent', facts.focalLength35mm === 15);
  // The collapse drops the DUPLICATED prefix, it does not strip the make.
  // 'GoPro' + 'GoPro HERO12 Black' must not become 'GoPro GoPro HERO12 Black'.
  check('does not double the make in the display name', exif.describeCamera(facts) === 'GoPro HERO12 Black', exif.describeCamera(facts));

  const fov = exif.fovFrom35mm(15, 1);
  check('15mm equivalent is a wide FOV', fov > 90 && fov < 110, `${fov.toFixed(1)} deg`);

  const i = exif.intrinsicsFromExif({ facts, videoWidthPx: 3840, videoHeightPx: 2160, sameModeConfirmed: true });
  check('produces intrinsics tagged as exif', i !== null && i.source === 'exif');
  check('confirmed same-mode carries the tighter 4% sigma', close(i.fxPx.sigma / i.fxPx.value, 0.04, 1e-9));

  const loose = exif.intrinsicsFromExif({ facts, videoWidthPx: 3840, videoHeightPx: 2160, sameModeConfirmed: false });
  check('unconfirmed carries 15%', close(loose.fxPx.sigma / loose.fxPx.value, 0.15, 1e-9));

  const missing = exif.intrinsicsFromExif({ facts: exif.readExifCameraFacts({ Make: 'X' }), videoWidthPx: 1920, videoHeightPx: 1080, sameModeConfirmed: true });
  check('no focal length returns null rather than a default', missing === null);

  // Rational strings, which is how some bodies write EXIF.
  const rational = exif.readExifCameraFacts({ FocalLengthIn35mmFilm: '24/1' });
  check('parses a rational focal length', rational.focalLength35mm === 24);
}

console.log('\n9. Division model -> OpenCV needs a focal length');
{
  const fit = { model: 'division', lambda: -0.18, normalisationPx: 2203, principalPointPx: { x: 1920, y: 1080 }, imageWidthPx: 3840, imageHeightPx: 2160, rmsResidualPx: 0.2, rmsResidualBeforePx: 30, lineCount: 4, pointCount: 36 };
  check('refuses to convert without a focal length', opencv.fromDivisionModel(fit, null) === null);
  const converted = opencv.fromDivisionModel(fit, 2800);
  check('converts when given one', converted !== null && converted.coefficients.length === 5);
  check('and marks the result approximate', converted.approximate === true);
  check('k1 has the opposite sign to lambda', converted.coefficients[0] > 0, `k1 = ${converted.coefficients[0].toFixed(4)}`);
}

console.log('\n10. Validator gates');
{
  const base = JSON.parse(JSON.stringify({
    schemaVersion: 1, surveyId: 's', sessionId: null, venueId: null, startedAt: '', completedAt: '',
    rigMode: 'single',
    pitch: { northTouchlineM: { value: 105, sigma: 0.5, provenance: 'measured' }, southTouchlineM: { value: 105, sigma: 0.5, provenance: 'measured' }, westGoalLineM: { value: 68, sigma: 0.5, provenance: 'measured' }, eastGoalLineM: { value: 68, sigma: 0.5, provenance: 'measured' }, diagonalM: { value: 125, sigma: 0.5, provenance: 'measured' }, markingCondition: 'fresh', surface: 'grass', notes: null },
    venueFix: null, baselineM: null, notes: null, appVersion: '0.1.0',
    cameras: [{
      role: 'A', sourceKind: 'external',
      external: { make: 'GoPro', model: 'HERO12', lensModel: null, stabilisationConfirmedOff: true, focusConfirmedLocked: true, exposureConfirmedLocked: true, exifSameModeConfirmed: true, videoWidthPx: 3840, videoHeightPx: 2160, acknowledgedRectilinear: false },
      deviceId: 'x', deviceModel: 'HERO12',
      heightM: { value: 6, sigma: 0.03, provenance: 'measured' },
      perpendicularDistanceM: { value: 30, sigma: 0.03, provenance: 'measured' },
      alongTouchlineM: { value: 0, sigma: 0.03, provenance: 'measured' },
      coversHalf: 'west', touchlineSide: 'north',
      orientation: { tiltDeg: { value: 8, sigma: 0.2, provenance: 'device' }, rollDeg: { value: 0, sigma: 0.2, provenance: 'device' }, headingDeg: null, stable: true, sampleCount: 50, durationMs: 1000, capturedAt: '' },
      intrinsics: { source: 'exif', fxPx: { value: 2800, sigma: 112, provenance: 'derived' }, fyPx: { value: 2800, sigma: 112, provenance: 'derived' }, cxPx: { value: 1920, sigma: 40, provenance: 'derived' }, cyPx: { value: 1080, sigma: 40, provenance: 'derived' }, skew: null, focalLengthMm: null, sensorPhysicalWidthMm: null, sensorPhysicalHeightMm: null, activeArrayWidthPx: 3840, activeArrayHeightPx: 2160 },
      distortion: { model: 'unknown', radial: null, tangential: null, lookupTable: null, division: null },
      settings: { videoStabilisation: 'not_attempted', opticalStabilisation: 'not_attempted', autofocusLock: 'not_attempted', autoExposureLock: 'not_attempted', whiteBalanceLock: 'not_attempted', zoomRatio: 1, cropRegion: null, lensId: null, lensFacing: 'unknown' },
      timing: { nominalFps: 30, measuredFps: null, frameIntervalJitterMs: null, rollingShutterSkewNs: null, timestampSource: 'unknown', sampleTimestampsNs: null },
    }],
  }));

  const withUnknownLens = validate.validateSurvey(base);
  const codes = withUnknownLens.map((i) => i.code);
  check('unknown lens blocks recording', codes.includes('LENS_MODEL_MISSING') && withUnknownLens.find((i) => i.code === 'LENS_MODEL_MISSING').blocking === true);
  check('an external camera is NOT told to lock its white balance', !codes.includes('AWB_NOT_LOCKED'), codes.join(', '));
  check('a single rig raises no baseline or pair issues', !codes.some((c) => c.startsWith('BASELINE') || c === 'SAME_HALF_ASSIGNED' || c === 'INCOMPLETE_RIG'));

  const acked = JSON.parse(JSON.stringify(base));
  acked.cameras[0].external.acknowledgedRectilinear = true;
  const ackIssues = validate.validateSurvey(acked);
  check('acknowledging unblocks but still warns', validate.hasBlockingIssues(ackIssues) === false && ackIssues.map((i) => i.code).includes('LENS_MODEL_ACKNOWLEDGED_ABSENT'));

  const solved = JSON.parse(JSON.stringify(base));
  solved.cameras[0].distortion.model = 'none';
  check('a lens measured and found straight is a lens model', !validate.validateSurvey(solved).map((i) => i.code).includes('LENS_MODEL_MISSING'));

  const shaky = JSON.parse(JSON.stringify(base));
  shaky.cameras[0].distortion.model = 'none';
  shaky.cameras[0].external.stabilisationConfirmedOff = false;
  check('unconfirmed stabilisation on an external camera blocks', validate.validateSurvey(shaky).find((i) => i.code === 'EXTERNAL_STABILISATION_UNCONFIRMED').blocking === true);

  const tooClose = JSON.parse(JSON.stringify(base));
  tooClose.cameras[0].distortion.model = 'none';
  tooClose.cameras[0].perpendicularDistanceM.value = 15;
  check('closer than 20 m blocks', validate.validateSurvey(tooClose).find((i) => i.code === 'TOO_CLOSE_TO_PITCH').blocking === true);
}

console.log('\n11. Frame timing from real timestamps');
{
  // 30 fps with one dropped frame partway through.
  const ts = [];
  let t = 0;
  for (let i = 0; i < 60; i += 1) {
    ts.push(t);
    t += (i === 30 ? 2 : 1) * 33_333_333;
  }
  const timing = derive.timingFromTimestamps(ts);
  check('median interval ignores the dropped frame', close(timing.fps.value, 30, 0.1), `${timing.fps.value.toFixed(2)} fps`);
  check('jitter is non-zero and reported', timing.jitterMs.value > 0, `${timing.jitterMs.value.toFixed(2)} ms`);
  check('too few samples returns null', derive.timingFromTimestamps([0, 1]) === null);
}

console.log('');
console.log('12. Pitch landmarks');
{
  const marks = landmarks.pitchLandmarks(105, 68);
  check('a full-size pitch yields 31 landmarks', marks.length === 31, String(marks.length));
  check('ids are unique', new Set(marks.map((m) => m.id)).size === marks.length);
  check('all inside the pitch', marks.every((m) => m.x >= 0 && m.x <= 105 && m.y >= 0 && m.y <= 68));
  const spot = marks.find((m) => m.id === 'west_penalty_spot');
  check('west penalty spot is 11 m out, centred', close(spot.x, 11, 1e-9) && close(spot.y, 34, 1e-9));
  check('east penalty spot mirrors it', close(marks.find((m) => m.id === 'east_penalty_spot').x, 94, 1e-9));
  const penN = marks.find((m) => m.id === 'west_pen_north');
  check('penalty area is 16.5 m deep', close(penN.x, 16.5, 1e-9));
  check('penalty area is 40.32 m wide', close(penN.y, 34 - 20.16, 1e-9));
  // Interior dimensions are absolute, not scaled: a penalty box is the
  // same size on a small pitch. That is why this takes real dimensions.
  const small = landmarks.pitchLandmarks(90, 55);
  check('penalty depth does not scale with the pitch', close(small.find((m) => m.id === 'west_pen_north').x, 16.5, 1e-9));
  check('but the corners do', close(small.find((m) => m.id === 'corner_ne').x, 90, 1e-9));
}

console.log('');
console.log('13. Visibility gate');
{
  const all = landmarks.pitchLandmarks(105, 68);
  const pick = (ids) => all.filter((m) => ids.includes(m.id));
  const none = visibility.assessVisibility([]);
  check('nothing visible blocks', !none.ok && none.issues[0].code === 'NO_LANDMARKS');
  // Four points solves a homography and is NOT enough for this gate:
  // four leaves no way to notice that one of them is wrong.
  check('four landmarks still blocks', !visibility.assessVisibility(pick(['corner_nw','corner_ne','corner_se','corner_sw'])).ok);
  // The case a raw count would wave through: ten points, all in one box.
  const clustered = visibility.assessVisibility(pick(['west_pen_gl_north','west_pen_gl_south','west_pen_north','west_pen_south','west_goal_gl_north','west_goal_gl_south','west_goal_north','west_goal_south','west_penalty_spot','west_post_north']));
  check('ten clustered landmarks are refused', !clustered.ok, clustered.spreadM2.toFixed(0) + ' m2 hull');
  check('and named as clustered', clustered.issues.some((i) => i.code === 'LANDMARKS_CLUSTERED'));
  // Fatal and looks fine: all along one touchline.
  const collinear = visibility.assessVisibility(pick(['corner_nw','corner_sw','west_pen_gl_north','west_pen_gl_south','west_goal_gl_north','west_goal_gl_south','west_post_north','west_post_south']));
  check('eight landmarks on one goal line are refused', !collinear.ok, 'n=' + collinear.count + ' conditioning ' + collinear.conditioning.toFixed(4));
  check('and named as collinear', collinear.issues.some((i) => i.code === 'LANDMARKS_COLLINEAR'));
  const good = visibility.assessVisibility(pick(['corner_nw','corner_ne','corner_se','corner_sw','halfway_north','halfway_south','centre_mark','west_pen_north','west_pen_south','east_pen_north','east_pen_south','west_penalty_spot']));
  check('a well-spread view passes', good.ok, 'n=' + good.count + ' spread=' + good.spreadM2.toFixed(0) + ' cond=' + good.conditioning.toFixed(2));
  check('and reports all three regions', good.regions.length === 3, good.regions.join(','));
  check('conditioning is scale-free', close(visibility.conditioningOf([{x:0,y:0},{x:10,y:0},{x:0,y:10},{x:10,y:10}]), visibility.conditioningOf([{x:0,y:0},{x:100,y:0},{x:0,y:100},{x:100,y:100}]), 1e-9));
  check('hull area of a 10x10 square is 100', close(visibility.convexHullArea([{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}]), 100, 1e-9));
  check('two points have no hull', visibility.convexHullArea([{x:0,y:0},{x:1,y:1}]) === 0);
}

console.log('');
console.log('14. Detection filtering');
{
  const all = landmarks.pitchLandmarks(105, 68);
  const resolved = detector.resolveDetections([
    { id: 'corner_nw', x: 10, y: 10, confidence: 0.95 },
    { id: 'corner_ne', x: 20, y: 10, confidence: 0.4 },
    { id: 'corner_nw', x: 11, y: 11, confidence: 0.9 },
    { id: 'not_a_landmark', x: 5, y: 5, confidence: 0.99 },
    { id: 'centre_mark', x: 50, y: 40, confidence: 0.7 },
  ], all);
  check('low confidence is dropped', !resolved.some((l) => l.id === 'corner_ne'));
  check('duplicates are dropped', resolved.filter((l) => l.id === 'corner_nw').length === 1);
  check('unknown ids are dropped', resolved.length === 2, resolved.map((l) => l.id).join(','));
  check('a missing detector reports unavailable, not pass', detector.detectorUnavailable().available === false);
  check('and none is registered by default', detector.isDetectorAvailable() === false);
}

console.log('');
console.log('15. Region-of-interest coverage');
{
  const all = landmarks.pitchLandmarks(105, 68);
  const pick = (ids) => all.filter((m) => ids.includes(m.id));
  const pitch = visibility.wholePitch(105, 68);
  // The case hull area cannot see: landmarks at BOTH ends, nothing in the
  // middle. Large hull, well conditioned, and blind where play happens.
  const barbell = pick(['corner_nw','corner_sw','west_pen_north','west_pen_south','corner_ne','corner_se','east_pen_north','east_pen_south']);
  const bar = visibility.assessVisibility(barbell, pitch);
  check('a barbell layout has a large hull', bar.spreadM2 > 4000, bar.spreadM2.toFixed(0) + ' m2');
  check('and is well conditioned', bar.conditioning > 0.3, bar.conditioning.toFixed(2));
  check('so extent checks alone would pass it', !bar.issues.some((i) => i.code === 'LANDMARKS_CLUSTERED' || i.code === 'LANDMARKS_COLLINEAR'));
  check('but coverage catches the empty middle', !bar.ok, 'worst gap ' + bar.worstGapM.toFixed(0) + ' m');
  check('and names it', bar.issues.some((i) => i.code === 'COVERAGE_GAP'));
  // Same points plus the centre circle: the hole is filled.
  const filled = visibility.assessVisibility(pick(barbell.map((m) => m.id).concat(['centre_mark','circle_north','circle_south','halfway_north','halfway_south'])), pitch);
  check('adding the centre closes the gap', filled.worstGapM < bar.worstGapM, filled.worstGapM.toFixed(0) + ' m vs ' + bar.worstGapM.toFixed(0) + ' m');
  check('and it passes', filled.ok);
  check('hull coverage is a fraction', filled.hullCoverage > 0.5 && filled.hullCoverage <= 1, filled.hullCoverage.toFixed(2));
  const west = visibility.halfWithOverlap(105, 68, 'west');
  check('a west ROI stops short of the east end', west.maxX < 105 && west.minX === 0, west.minX + '..' + west.maxX);
}

console.log('');
console.log('16. The pair gate');
{
  const all = landmarks.pitchLandmarks(105, 68);
  const pick = (ids) => all.filter((m) => ids.includes(m.id));
  const ids = (ms) => ms.map((m) => m.id);
  const roiA = visibility.halfWithOverlap(105, 68, 'west');
  const roiB = visibility.halfWithOverlap(105, 68, 'east');
  const base = { roiA, roiB, pitchLengthM: 105, pitchWidthM: 68 };

  const westSide = ['corner_nw','corner_sw','west_pen_north','west_pen_south','west_pen_gl_north','west_pen_gl_south','west_penalty_spot','west_goal_north','west_goal_south'];
  const eastSide = ['corner_ne','corner_se','east_pen_north','east_pen_south','east_pen_gl_north','east_pen_gl_south','east_penalty_spot','east_goal_north','east_goal_south'];

  // THE DANGEROUS CASE. Each camera covers its own half properly and they
  // share nothing: A takes the north halfway point, B the south one. Both
  // pass individually; the rig cannot work.
  const disjointA = pick(westSide.concat(['halfway_north','circle_north']));
  const disjointB = pick(eastSide.concat(['halfway_south','circle_south']));
  const disjoint = pair.assessPair(Object.assign({ a: disjointA, b: disjointB }, base));
  const perCameraCodes = disjoint.perCamera.A.issues.concat(disjoint.perCamera.B.issues).map((i) => i.code);
  check('no per-camera check can see a missing overlap',
    !perCameraCodes.some((c) => c.startsWith('PAIR_')), perCameraCodes.join('/') || 'none');
  check('but the pair is refused', !disjoint.ok, 'shared=' + disjoint.sharedCount);
  check('and names the missing overlap', disjoint.issues.some((i) => i.code === 'PAIR_NO_COMMON_GROUND'));

  // Sharing ONLY the halfway line is collinear, and genuinely not enough:
  // points on a line cannot fix how two views relate, however many there are.
  const halfwayOnly = ['halfway_north','halfway_south','centre_mark','circle_north','circle_south'];
  const lineA = pick(westSide.concat(halfwayOnly));
  const lineB = pick(eastSide.concat(halfwayOnly));
  const lineOnly = pair.assessPair(Object.assign({ a: lineA, b: lineB }, base));
  check('sharing only the halfway line is refused', !lineOnly.ok,
    'shared=' + lineOnly.sharedCount + ' cond=' + lineOnly.sharedConditioning.toFixed(3));
  check('and named as collinear overlap', lineOnly.issues.some((i) => i.code === 'PAIR_OVERLAP_COLLINEAR'));
  check('the diameter is measured across the width, not along the length',
    lineOnly.sharedSpreadM > 60, lineOnly.sharedSpreadM.toFixed(0) + ' m');

  // A healthy rig: the overlap reaches off the halfway line, so both cameras
  // also see a penalty box.
  const wide = halfwayOnly.concat(['west_pen_north','west_pen_south']);
  const goodA = pick(westSide.concat(wide));
  const goodB = pick(eastSide.concat(wide));
  const good = pair.assessPair(Object.assign({ a: goodA, b: goodB }, base));
  check('an overlap reaching off the line passes', good.ok,
    'shared=' + good.sharedCount + ' spread=' + good.sharedSpreadM.toFixed(0) + ' m cond=' + good.sharedConditioning.toFixed(2));
  check('the union covers the pitch', good.combined.ok, 'gap ' + good.combined.worstGapM.toFixed(0) + ' m');

  // A view that fails ALONE and is carried by the pair.
  const weakA = pick(['halfway_north','halfway_south','centre_mark','west_pen_north','west_pen_south']);
  const carried = pair.assessPair(Object.assign({ a: weakA, b: goodB }, base));
  check('the weak camera fails on its own', !carried.perCamera.A.ok,
    carried.perCamera.A.issues.map((i) => i.code).join('/'));
  check('but the pair carries it', carried.ok,
    'compensated: ' + carried.compensated.map((c) => c.role + ':' + c.code).join(','));
  check('and says which failures were carried', carried.compensated.length > 0);

  // Seeing nothing is never carried: there is no shared geometry to relate it by.
  const blind = pair.assessPair(Object.assign({ a: [], b: goodB }, base));
  check('a blind camera is never carried', !blind.ok);
  check('and is reported, not silently compensated', blind.compensated.length === 0);
}


console.log('');
console.log('17. Translations');
{
  const keys = (d) => Object.keys(d).sort();
  const en = keys(dicts.en), fr = keys(dicts.fr), ar = keys(dicts.ar);
  check('English is the reference', en.length > 50, en.length + ' keys');
  const missingFr = en.filter((k) => dicts.fr[k] === undefined);
  const missingAr = en.filter((k) => dicts.ar[k] === undefined);
  check('French covers every English key', missingFr.length === 0, missingFr.join(',') || 'complete');
  check('Arabic covers every English key', missingAr.length === 0, missingAr.join(',') || 'complete');
  const extraFr = fr.filter((k) => dicts.en[k] === undefined);
  const extraAr = ar.filter((k) => dicts.en[k] === undefined);
  check('no orphan French keys', extraFr.length === 0, extraFr.join(',') || 'none');
  check('no orphan Arabic keys', extraAr.length === 0, extraAr.join(',') || 'none');
  // Placeholders must survive translation, or a string renders a literal
  // brace to a user in one language and the value in another.
  const ph = (v) => (v.match(/\{(\w+)\}/g) || []).sort().join(',');
  const mismatched = en.filter((k) => ph(dicts.en[k]) !== ph(dicts.fr[k] || '') || ph(dicts.en[k]) !== ph(dicts.ar[k] || ''));
  check('placeholders match across all three', mismatched.length === 0, mismatched.join(',') || 'all aligned');
  // Languages are named in themselves, never translated: somebody stuck
  // in a language they cannot read has to find their way out.
  check('language names are identical in every locale', dicts.en['lang.ar'] === dicts.fr['lang.ar'] && dicts.fr['lang.ar'] === dicts.ar['lang.ar'], dicts.ar['lang.ar']);
  check('and are written in their own script', dicts.en['lang.ar'] === 'العربية');
}

console.log('');
console.log('18. Chunk manifests — reassembly of an out-of-order upload');
{
  const SEC = 1e9;
  // A four-chunk session, each 300 s, on a session-wide clock.
  const make = (seq, opts) =>
    Object.assign(
      {
        sessionId: 's1',
        deviceId: 'd1',
        role: 'solo',
        sequence: seq,
        startPtsNs: seq * 300 * SEC,
        endPtsNs: (seq + 1) * 300 * SEC,
        frameCount: 300 * 30,
        sha256: 'x'.repeat(64),
        byteLength: 1000,
        recordedAt: '2026-09-08T15:00:00Z',
        appVersion: '1.0.0',
        final: false,
      },
      opts,
    );

  const good = [make(0), make(1), make(2), make(3, { final: true })];

  // Arrival order is not sequence order — that is the whole point.
  const shuffled = [good[2], good[0], good[3], good[1]];
  const r = chunks.verifyChunkSet(shuffled);
  check('out-of-order arrival reassembles', r.reassemblable, r.problems.map((p) => p.code).join(',') || 'clean');
  check(
    'sorted by sequence regardless of arrival',
    r.ordered.map((c) => c.sequence).join(',') === '0,1,2,3',
    r.ordered.map((c) => c.sequence).join(','),
  );
  check('total duration is the session span', r.totalDurationNs === 1200 * SEC, r.totalDurationNs / SEC + ' s');
  check('total bytes sum', r.totalBytes === 4000);

  // A chunk that never uploaded.
  const missing = chunks.verifyChunkSet([good[0], good[1], good[3]]);
  check('a missing chunk is refused', !missing.reassemblable);
  check(
    'and is named so it can be re-sent',
    JSON.stringify(chunks.outstandingSequences(missing)) === '[2]',
    JSON.stringify(chunks.outstandingSequences(missing)),
  );

  // THE CASE A SEQUENCE NUMBER CANNOT CATCH: every index present, in order,
  // but chunk 1 stopped four seconds early. Concatenating loses four seconds
  // of match with nothing raising an error.
  const short = [make(0), make(1, { endPtsNs: (2 * 300 - 4) * SEC }), make(2), make(3, { final: true })];
  const gap = chunks.verifyChunkSet(short);
  check('a complete index run with a time hole is still refused', !gap.reassemblable);
  check(
    'and the problem is named as a time gap, not a missing chunk',
    gap.problems.some((p) => p.code === 'TIME_GAP'),
    gap.problems.map((p) => p.code).join(','),
  );
  check(
    'the gap is measured in ms for a support answer',
    (gap.problems.find((p) => p.code === 'TIME_GAP') || {}).message.includes('4000 ms'),
  );

  // Overlap — a retried chunk re-encoded from slightly earlier.
  const overlap = [make(0), make(1, { startPtsNs: (300 - 2) * SEC }), make(2), make(3, { final: true })];
  check(
    'an overlap is refused too, not silently double-counted',
    chunks.verifyChunkSet(overlap).problems.some((p) => p.code === 'TIME_OVERLAP'),
  );

  // Sub-frame jitter must NOT trip the gate, or every real session fails.
  const jitter = [make(0), make(1, { startPtsNs: 300 * SEC + 1_000_000 }), make(2), make(3, { final: true })];
  check(
    '1 ms of encoder jitter is tolerated',
    chunks.verifyChunkSet(jitter).reassemblable,
    chunks.verifyChunkSet(jitter).problems.map((p) => p.code).join(',') || 'clean',
  );

  // Nothing marked final: the phone may still be recording, or may have died.
  check(
    'an unfinalised set is not reassembled',
    chunks.verifyChunkSet([make(0), make(1), make(2)]).problems.some((p) => p.code === 'NOT_FINALISED'),
  );

  // Two matches must never be spliced.
  const mixed = [make(0), Object.assign(make(1), { sessionId: 's2' }), make(2), make(3, { final: true })];
  check(
    'chunks from two sessions are refused',
    chunks.verifyChunkSet(mixed).problems.some((p) => p.code === 'MIXED_SESSION'),
  );

  // A retry that was not de-duplicated.
  check(
    'a duplicate sequence is caught',
    chunks.verifyChunkSet([make(0), make(1), make(1), make(2), make(3, { final: true })]).problems.some(
      (p) => p.code === 'DUPLICATE_SEQUENCE',
    ),
  );

  check('an empty set is refused', !chunks.verifyChunkSet([]).reassemblable);

  // Keys sort lexicographically into sequence order — what somebody listing
  // the bucket at 1 a.m. relies on.
  const keys = [0, 2, 10, 3].map((n) => chunks.chunkObjectKey({ sessionId: 's1', role: 'A', sequence: n }));
  const sorted = [...keys].sort();
  check(
    'object keys sort lexicographically into sequence order',
    sorted[0].endsWith('00000.mp4') && sorted[1].endsWith('00002.mp4') && sorted[3].endsWith('00010.mp4'),
    sorted[3],
  );
}

console.log('');
console.log('19. Camera sync — merging one club list across handsets');
{
  const lens = (w, h, zoom, solvedAt, extra) =>
    Object.assign(
      {
        id: `${w}x${h}@${zoom}-${solvedAt}`,
        widthPx: w, heightPx: h, zoomRatio: zoom,
        method: 'chessboard',
        cameraMatrix: [2100, 0, 1920, 0, 2100, 1080, 0, 0, 1],
        distortion: { coefficients: [-0.31, 0.12, 0.001, -0.002, 0.04], origin: 'chessboard', approximate: false },
        rmsReprojectionError: 0.3, edgeBowPx: 41, solvedAt, appVersion: '0.1.0',
      },
      extra,
    );

  const cam = (id, label, extra) =>
    Object.assign(
      {
        id, serverId: null, classId: 'camcorder', label, kind: 'external',
        make: null, model: null, lensModel: null, calibrations: [],
        createdAt: '2026-09-01T00:00:00Z', lastUsedAt: null, useCount: 0,
      },
      extra,
    );

  // A re-solve at the same setting: the newer one wins, and only one survives.
  const merged = chunksync.mergeCalibrations(
    [lens(3840, 2160, 1, '2026-09-01T00:00:00Z')],
    [lens(3840, 2160, 1, '2026-09-05T00:00:00Z')],
  );
  check('a re-solve at one setting collapses to one lens', merged.length === 1, `${merged.length}`);
  check('and the newer solve is the survivor', merged[0].solvedAt === '2026-09-05T00:00:00Z');

  // Different settings are different lenses and must all survive.
  const both = chunksync.mergeCalibrations(
    [lens(3840, 2160, 1, '2026-09-01T00:00:00Z')],
    [lens(1920, 1080, 1, '2026-09-02T00:00:00Z')],
  );
  check('4K and 1080p both survive a merge', both.length === 2, `${both.length}`);

  // Zoom within a hundredth is ONE setting — same rule as the server's zoom_key.
  const jitter = chunksync.mergeCalibrations(
    [lens(3840, 2160, 1.0, '2026-09-01T00:00:00Z')],
    [lens(3840, 2160, 1.004, '2026-09-05T00:00:00Z')],
  );
  check('zoom 1.004 is the same setting as 1.000, matching the server', jitter.length === 1);

  // THE PAYOFF: a camera somebody else calibrated arrives on a phone that has
  // never seen it, lens model included.
  const fresh = chunksync.reconcile(
    [],
    [cam('srv-1', 'Club camcorder', { serverId: 'srv-1', calibrations: [lens(3840, 2160, 1, '2026-09-05T00:00:00Z')] })],
  );
  check('a camera another member registered arrives here', fresh.cameras.length === 1);
  check('and its lens model comes with it', fresh.cameras[0].calibrations.length === 1);
  check('with nothing to push back', fresh.toPush.length === 0);

  // A camera created offline is queued, never dropped.
  const offline = chunksync.reconcile([cam('local-1', 'Youssef phone')], []);
  check('a camera created offline is kept', offline.cameras.length === 1);
  check('and queued for push rather than deleted', offline.toPush.length === 1);

  // Never-pushed local meets the server row for the same physical camera:
  // matched by label, because that is the server's own unique key.
  const byLabel = chunksync.reconcile(
    [cam('local-2', 'Club camcorder', { calibrations: [lens(1920, 1080, 1, '2026-09-01T00:00:00Z')] })],
    [cam('srv-2', 'Club camcorder', { serverId: 'srv-2', calibrations: [lens(3840, 2160, 1, '2026-09-04T00:00:00Z')] })],
  );
  check('a never-pushed local camera matches the server row by name', byLabel.cameras.length === 1,
        `${byLabel.cameras.length} rows`);
  check('it adopts the server id', byLabel.cameras[0].serverId === 'srv-2');
  check('and BOTH calibrations survive the union', byLabel.cameras[0].calibrations.length === 2);
  check('nothing is re-pushed as a duplicate', byLabel.toPush.length === 0);

  // A rename must not orphan the camera — serverId is what matching uses once set.
  const renamed = chunksync.reconcile(
    [cam('local-3', 'Main camcorder', { serverId: 'srv-3' })],
    [cam('srv-3', 'Club camcorder', { serverId: 'srv-3' })],
  );
  check('a renamed camera is still one camera, not two', renamed.cameras.length === 1,
        `${renamed.cameras.length} rows`);

  // The usage tally is club-wide, so the larger count is the real one.
  const tally = chunksync.reconcile(
    [cam('local-4', 'Cam', { serverId: 'srv-4', useCount: 2 })],
    [cam('srv-4', 'Cam', { serverId: 'srv-4', useCount: 7 })],
  );
  check('the club-wide usage count wins over this handset\u2019s', tally.cameras[0].useCount === 7);
}

console.log('');
console.log('20. Pitch calibration — is this view solvable?');
{
  const LEN = 105, WID = 68;
  const marks = landmarks.pitchLandmarks(LEN, WID);
  const W = 3840, H = 2160;

  // A synthetic camera: a plausible homography mapping pitch metres to a 4K
  // frame, with real perspective foreshortening (the far touchline compressed).
  const TRUE_H = [
    32.0,   1.2, 240.0,
     2.0,  -9.5, 1900.0,
     0.0007, -0.0042, 1.0,
  ];
  const project = (x, y) => {
    const w = TRUE_H[6] * x + TRUE_H[7] * y + TRUE_H[8];
    return { x: (TRUE_H[0] * x + TRUE_H[1] * y + TRUE_H[2]) / w,
             y: (TRUE_H[3] * x + TRUE_H[4] * y + TRUE_H[5]) / w };
  };
  const tap = (id, jitterPx = 0) => {
    const m = marks.find((l) => l.id === id);
    if (!m) throw new Error('no landmark ' + id);
    const p = project(m.x, m.y);
    return { landmarkId: id, imageX: p.x + jitterPx, imageY: p.y + jitterPx };
  };

  const wellSpread = marks
    .filter((l, i) => i % 2 === 0)
    .slice(0, 12)
    .map((l) => tap(l.id));

  const base = { landmarks: marks, imageWidth: W, imageHeight: H };

  // 1. A clean view solves, and recovers the homography we projected with.
  const good = solve.assessSolvability({ ...base, correspondences: wellSpread });
  check('a well-spread view is solvable', good.solvable, good.message.slice(0, 46));
  check('and the fit is essentially exact', good.rmsErrorPx < 0.5,
        good.rmsErrorPx.toFixed(3) + ' px rms');
  check('and it reports the weaker solver honestly', good.solvedBy === 'least_squares');

  // The recovered matrix must actually reproject a point we did NOT fit on.
  {
    const held = marks.find((l) => !wellSpread.some((c) => c.landmarkId === l.id));
    const expected = project(held.x, held.y);
    const got = solve.applyHomography(good.homography, { x: held.x, y: held.y });
    const err = Math.hypot(got.x - expected.x, got.y - expected.y);
    check('a landmark NOT used in the fit reprojects correctly', err < 1.0,
          err.toFixed(3) + ' px on "' + held.label + '"');
  }

  // 2. THE CASE GEOMETRY CANNOT CATCH: right landmarks, well spread, one tap
  //    put on the wrong spot. The view is fine; the taps disagree.
  const misTapped = wellSpread.map((c, i) =>
    i === 3 ? { ...c, imageX: c.imageX + 900, imageY: c.imageY + 500 } : c);
  const bad = solve.assessSolvability({ ...base, correspondences: misTapped });
  check('one mis-tapped point is refused', !bad.solvable);
  check('and it is named as inconsistent taps, not a bad view',
        bad.failure === 'TAPS_INCONSISTENT', bad.failure);
  check('and the worst point is identified by name',
        bad.worstPoint !== null && bad.message.includes(bad.worstPoint.label),
        bad.worstPoint && bad.worstPoint.label);

  // 3. Too few points to determine a homography at all.
  const three = solve.assessSolvability({ ...base, correspondences: wellSpread.slice(0, 3) });
  check('three points cannot solve a homography', !three.solvable);
  check('and the reason is arithmetic, not framing',
        three.failure === 'TOO_FEW_FOR_HOMOGRAPHY', three.failure);

  // 4. Points along the halfway line: they FIT perfectly and are unsolvable.
  //    This is why the view is judged before the reprojection error.
  const collinear = marks
    .filter((l) => Math.abs(l.x - LEN / 2) < 0.01)
    .map((l) => tap(l.id));
  if (collinear.length >= 4) {
    const line = solve.assessSolvability({ ...base, correspondences: collinear });
    check('collinear points are refused despite fitting perfectly', !line.solvable);
    check('and the reason is the view, not the taps',
          line.failure === 'VIEW_INADEQUATE', line.failure);
  }

  // 5. Honest finger imprecision must NOT fail a good calibration.
  const jittered = marks
    .filter((l, i) => i % 2 === 0).slice(0, 12)
    .map((l, i) => tap(l.id, ((i % 5) - 2) * 12));
  const shaky = solve.assessSolvability({ ...base, correspondences: jittered });
  check('a dozen pixels of tap wobble still solves', shaky.solvable,
        shaky.rmsErrorPx.toFixed(1) + ' px rms');

  // 6. An OpenCV RANSAC result is used when supplied, and labelled as such.
  const viaOpenCv = solve.assessSolvability({
    ...base, correspondences: wellSpread,
    homography: { h: TRUE_H, solvedBy: 'opencv_ransac' },
  });
  check('a supplied RANSAC solve is used instead of the fallback',
        viaOpenCv.solvedBy === 'opencv_ransac');
  check('and it reprojects exactly, being the true matrix',
        viaOpenCv.rmsErrorPx < 1e-6, viaOpenCv.rmsErrorPx.toExponential(1));

  // 7. Empty state.
  check('no taps at all asks for taps',
        solve.assessSolvability({ ...base, correspondences: [] }).failure === 'NO_POINTS');

  // 8. Frame/capture agreement — a homography is valid at ONE frame size.
  check('a 4K frame matches a 4K capture',
        !solve.framesDisagree({ width: 3840, height: 2160 }, { widthPx: 3840, heightPx: 2160 }).disagree);
  check('a 1080p frame against 4K capture is flagged',
        solve.framesDisagree({ width: 1920, height: 1080 }, { widthPx: 3840, heightPx: 2160 }).disagree);
  check('but is recognised as the same SHAPE, so it rescales',
        solve.framesDisagree({ width: 1920, height: 1080 }, { widthPx: 3840, heightPx: 2160 }).sameShape);
  check('a 4:3 still against a 16:9 video is a different crop',
        !solve.framesDisagree({ width: 4032, height: 3024 }, { widthPx: 3840, heightPx: 2160 }).sameShape);
}

console.log('');
console.log('21. Audio sync marker — one timeline from several cameras');
{
  // 8 kHz keeps the test quick; the maths is sample-rate agnostic and the
  // shipping marker runs at 48 kHz.
  const RATE = 8000;
  const spec = { startHz: 500, endHz: 3000, durationMs: 250, sampleRate: RATE };
  const chirp = marker.generateChirp(spec);
  check('the chirp is the length it says', chirp.length === RATE * 0.25, chirp.length + ' samples');
  check('and it fades in rather than clicking', Math.abs(chirp[0]) < 0.01, chirp[0].toFixed(4));

  // A recording: silence, then the chirp at a known instant, plus noise.
  const plant = (atSec, noiseAmp, gain) => {
    const total = RATE * 3;
    const rec = new Float32Array(total);
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
    for (let i = 0; i < total; i++) rec[i] = rnd() * noiseAmp;
    const start = Math.round(atSec * RATE);
    for (let i = 0; i < chirp.length; i++) rec[start + i] += chirp[i] * gain;
    return rec;
  };

  // 1. Clean-ish recovery of a known instant.
  const d1 = marker.findMarker(plant(1.5, 0.05, 1.0), chirp, RATE);
  check('the marker is found', d1.found, 'peak ' + d1.peakRatio.toFixed(1) + 'x background');
  check('at the instant it was planted', Math.abs(d1.atSeconds - 1.5) < 0.002,
        d1.atSeconds.toFixed(5) + ' s vs 1.5');

  // 2. THE POINT OF A CHIRP: it still works buried in noise, where a click
  //    would not. Noise three times the signal amplitude.
  const d2 = marker.findMarker(plant(0.9, 3.0, 1.0), chirp, RATE);
  check('found under noise 3x its own amplitude', d2.found, 'peak ' + d2.peakRatio.toFixed(1) + 'x');
  check('and still lands within a millisecond', Math.abs(d2.atSeconds - 0.9) < 0.001,
        ((d2.atSeconds - 0.9) * 1000).toFixed(3) + ' ms error');

  // 3. No marker present at all must NOT produce a confident answer.
  let seed = 999;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  const pureNoise = new Float32Array(RATE * 3);
  for (let i = 0; i < pureNoise.length; i++) pureNoise[i] = rnd();
  check('pure noise reports NOT found', !marker.findMarker(pureNoise, chirp, RATE).found,
        marker.findMarker(pureNoise, chirp, RATE).peakRatio.toFixed(2) + 'x');

  // 4. A DC offset must not drag the peak to lag zero.
  const dc = plant(1.2, 0.05, 1.0);
  for (let i = 0; i < dc.length; i++) dc[i] += 0.8;
  const d4 = marker.findMarker(dc, chirp, RATE);
  check('a DC offset does not move the peak', Math.abs(d4.atSeconds - 1.2) < 0.002,
        d4.atSeconds.toFixed(4));

  // 5. THE ERROR THAT WOULD POISON EVERY POSITION: propagation delay.
  //    Two cameras, clocks perfectly synced, 30 m apart. B hears it later
  //    purely because sound takes time to get there.
  const flight30 = 30 / marker.SPEED_OF_SOUND_MS;
  const hearings = [
    { deviceId: 'A', atSeconds: 2.000, distanceM: 0, peakRatio: 20 },
    { deviceId: 'B', atSeconds: 2.000 + flight30, distanceM: 30, peakRatio: 20 },
  ];
  const corrected = marker.correctForPropagation(hearings, 'A');
  const b = corrected.find((o) => o.deviceId === 'B');
  check('two synced cameras 30 m apart resolve to ZERO offset',
        Math.abs(b.offsetSeconds) < 0.0005, (b.offsetSeconds * 1000).toFixed(3) + ' ms');
  check('and the flight time removed is reported', Math.abs(b.propagationRemovedSeconds - flight30) < 1e-6,
        (b.propagationRemovedSeconds * 1000).toFixed(1) + ' ms');
  check('which at 30 fps would have been ~2.6 frames of silent error',
        Math.abs(marker.offsetInFrames(flight30, 30) - 2.6) < 0.2,
        marker.offsetInFrames(flight30, 30).toFixed(2) + ' frames');

  // 6. A genuine clock offset survives the correction.
  const skewed = [
    { deviceId: 'A', atSeconds: 2.000, distanceM: 0, peakRatio: 20 },
    { deviceId: 'B', atSeconds: 2.000 + flight30 - 0.120, distanceM: 30, peakRatio: 20 },
  ];
  const bs = marker.correctForPropagation(skewed, 'A').find((o) => o.deviceId === 'B');
  check('a real 120 ms clock skew is recovered', Math.abs(bs.offsetSeconds - 0.120) < 0.001,
        (bs.offsetSeconds * 1000).toFixed(1) + ' ms');

  // 7. An unsurveyed camera is warned about, not silently assumed to be at 0 m.
  const unknown = marker.correctForPropagation(
    [{ deviceId: 'A', atSeconds: 2, distanceM: 0, peakRatio: 20 },
     { deviceId: 'B', atSeconds: 2, distanceM: null, peakRatio: 20 }], 'A');
  const ub = unknown.find((o) => o.deviceId === 'B');
  check('an unsurveyed camera warns rather than assuming', ub.warnings.length > 0);
  check('and refuses to state an uncertainty', ub.uncertaintySeconds === null);

  // 8. A marker that was not clearly heard cannot be trusted.
  const faint = marker.correctForPropagation(
    [{ deviceId: 'A', atSeconds: 2, distanceM: 0, peakRatio: 20 },
     { deviceId: 'B', atSeconds: 2, distanceM: 10, peakRatio: 1.4 }], 'A');
  const fb = faint.find((o) => o.deviceId === 'B');
  check('a faint detection is flagged and given no uncertainty',
        fb.uncertaintySeconds === null && fb.warnings.length > 0, fb.warnings[0].slice(0, 44));
}

console.log('22. Aligning on the referee, not on our own chirp');
{
  const RATE = 8000;
  // TWO DIFFERENT GENERATORS, and that is not fussiness. The first version of
  // this test seeded both noise streams from the same LCG, so B's "independent"
  // noise was A's noise shifted -- and the correlator correctly locked onto
  // that shift instead of the whistle, at every SNR, deterministically. The
  // estimator was suspected at length; the harness was the fault.
  const lcg = (s) => () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff * 2 - 1; };
  const mulberry = (s) => () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
  const rA = lcg(7);
  const rB = mulberry(999331);

  // Crowd hiss plus a whistle-like shriek. Nothing here is a template the code
  // knows about -- that is the whole point of correlating the recordings.
  const a = (() => {
    const n = RATE * 6;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = rA() * 0.25;
    const at = Math.round(n * 0.45), len = Math.round(0.18 * RATE);
    for (let i = 0; i < len; i++) {
      const e = Math.sin((Math.PI * i) / len);
      x[at + i] += e * 0.9 * (Math.sin(2 * Math.PI * 3400 * i / RATE)
                            + 0.6 * Math.sin(2 * Math.PI * 4100 * i / RATE));
    }
    return x;
  })();

  const heardAgain = (delaySamples, gain, noiseAmp) => {
    const y = new Float32Array(a.length);
    let p = 0;
    for (let i = 0; i < a.length; i++) {
      const s = i - delaySamples >= 0 ? a[i - delaySamples] : 0;
      p = 0.6 * p + 0.4 * s;             // a different frequency response
      y[i] = p * gain + rB() * noiseAmp; // and its own unrelated noise
    }
    return y;
  };

  const trueDelay = 0.0875;   // 30 m of flight
  const good = marker.alignByAmbient(a, heardAgain(700, 0.35, 0.2), RATE, 0.5);
  check('two cameras align on match sound alone, with no template', good.found,
        'peak ' + good.peakRatio.toFixed(1) + 'x background');
  check('and the recovered delay matches what was applied',
        Math.abs(good.otherDelaySeconds - trueDelay) < 0.002,
        ((good.otherDelaySeconds - trueDelay) * 1000).toFixed(2) + ' ms error');

  // Buried too deep: the answer is still RIGHT, and correctly not trusted.
  const faint = marker.alignByAmbient(a, heardAgain(700, 0.1, 0.4), RATE, 0.5);
  check('a too-faint match is refused rather than reported', !faint.found,
        'ratio ' + faint.peakRatio.toFixed(1) + ' < ' + marker.MIN_AMBIENT_PEAK_RATIO);

  const unrelated = new Float32Array(RATE * 6);
  for (let i = 0; i < unrelated.length; i++) unrelated[i] = rB() * 0.3;
  const u = marker.alignByAmbient(a, unrelated, RATE, 0.5);
  check('two unrelated recordings report not found', !u.found, 'ratio ' + u.peakRatio.toFixed(2));

  // ── THE LIMIT. This is why the whistle cannot be the truth. ──
  const amb30 = marker.propagationAmbiguity(30, 30);
  check('a 30 m rig carries +/-87 ms of irreducible ambiguity',
        Math.abs(amb30.worstCaseSeconds - 0.0875) < 0.001,
        (amb30.worstCaseSeconds * 1000).toFixed(1) + ' ms');
  check('which is 2.6 frames at 30 fps -- not sub-frame',
        !amb30.negligible && amb30.worstCaseFrames > 2,
        amb30.worstCaseFrames.toFixed(2) + ' frames');
  check('a 60 m rig is worse still', marker.propagationAmbiguity(60, 30).worstCaseFrames > 5,
        marker.propagationAmbiguity(60, 30).worstCaseFrames.toFixed(1) + ' frames');
  check('but two cameras 2 m apart have none worth counting',
        marker.propagationAmbiguity(2, 30).negligible,
        marker.propagationAmbiguity(2, 30).worstCaseFrames.toFixed(3) + ' frames');

  const flight = 30 / marker.SPEED_OF_SOUND_MS;
  const viaChirp = marker.correctForPropagation(
    [{ deviceId: 'A', atSeconds: 2, distanceM: 0, peakRatio: 20 },
     { deviceId: 'B', atSeconds: 2 + flight, distanceM: 30, peakRatio: 20 }], 'A');
  check('the chirp resolves the same 30 m rig to zero, because the source is known',
        Math.abs(viaChirp.find((o) => o.deviceId === 'B').offsetSeconds) < 0.0005);
}

console.log('');
console.log('23. Translations that actually resolve');
{
  // THE GAP THAT LET `[MISSING...]` SHIP UNDER ALL FIVE TABS. Section 17
  // compares the dictionaries to each other -- parity, orphans, placeholder
  // agreement -- and never calls translate(). Two dictionaries can agree
  // perfectly and both be unreadable, which is exactly what happened: flat
  // dotted keys handed to i18n-js, which reads a dot as a path.
  const missing = [];
  for (const loc of ['en', 'fr', 'ar']) {
    i18nmod.setActiveLocale(loc);
    for (const key of Object.keys(dicts.en)) {
      const out = i18nmod.translate(key);
      // Match the MISSING TRANSLATION marker specifically -- i18n-js writes
      // `[missing "en.x.y" translation]`. A looser test for the word "missing"
      // also catches `[missing {email} value]`, which is a key that resolved
      // fine and was simply called without its variables here.
      if (typeof out !== 'string' || /missing ".*" translation/.test(out)) {
        missing.push(loc + ':' + key);
      }
    }
  }
  i18nmod.setActiveLocale('en');
  check('every key resolves in every locale', missing.length === 0,
        missing.length === 0 ? (Object.keys(dicts.en).length * 3) + ' lookups'
                             : missing.length + ' unresolved, e.g. ' + missing[0]);

  check('a tab label is the actual word', i18nmod.translate('tabs.matches') === dicts.en['tabs.matches'],
        JSON.stringify(i18nmod.translate('tabs.matches')));

  i18nmod.setActiveLocale('fr');
  check('and it changes with the locale', i18nmod.translate('tabs.matches') === dicts.fr['tabs.matches'],
        JSON.stringify(i18nmod.translate('tabs.matches')));
  i18nmod.setActiveLocale('en');

  // No key may be a prefix of another, or expansion cannot represent both.
  const clash = i18nmod.collisions(dicts.en);
  check('no key is a prefix of another', clash.length === 0, clash.join(',') || 'none');

  // Placeholders must interpolate, not render literally.
  const withVar = Object.keys(dicts.en).find((k) => /\{\w+\}/.test(dicts.en[k]));
  if (withVar) {
    const name = /\{(\w+)\}/.exec(dicts.en[withVar])[1];
    const out = i18nmod.translate(withVar, { [name]: 'XYZZY' });
    check('placeholders interpolate rather than printing braces',
          out.includes('XYZZY') && !out.includes('{' + name + '}'),
          withVar + ' -> ' + out.slice(0, 40));
  }
}

console.log('');
console.log('24. Footage that starts with the match already under way');
{
  const SEC = 1e9;
  const make = (seq, opts) => Object.assign({
    sessionId: 's1', deviceId: 'd1', role: 'solo', sequence: seq,
    startPtsNs: seq * 300 * SEC, endPtsNs: (seq + 1) * 300 * SEC,
    frameCount: 9000, sha256: 'x'.repeat(64), byteLength: 1000,
    recordedAt: '2026-09-10T15:00:00Z', appVersion: '1.0.0', final: false,
  }, opts);

  // THE HOLE THE CONTINUITY CHECK CANNOT SEE. Chunks numbered from zero,
  // perfectly abutting, hashing cleanly -- and recording began 20 minutes
  // after the rig was armed, so the opening is simply absent.
  const late = [
    make(0, { startPtsNs: 1200 * SEC, endPtsNs: 1500 * SEC }),
    make(1, { startPtsNs: 1500 * SEC, endPtsNs: 1800 * SEC }),
    make(2, { startPtsNs: 1800 * SEC, endPtsNs: 2100 * SEC, final: true }),
  ];
  const r = chunks.verifyChunkSet(late);
  check('a late start is caught', r.problems.some((p) => p.code === 'STARTED_IN_PLAY'),
        r.problems.map((p) => p.code).join(',') || 'none');
  check('and it is NOT reported as a gap or a missing chunk',
        !r.problems.some((p) => ['TIME_GAP', 'MISSING_SEQUENCE'].includes(p.code)),
        'the chunks themselves are continuous');
  check('the message says how much is missing, in minutes',
        (r.problems.find((p) => p.code === 'STARTED_IN_PLAY') || {}).message.includes('20 min'),
        (r.problems.find((p) => p.code === 'STARTED_IN_PLAY') || {}).message.slice(0, 46));

  // A normal start must not trip it -- a couple of seconds of arming is fine.
  const prompt = [make(0, { startPtsNs: 2 * SEC, endPtsNs: 302 * SEC }),
                  make(1, { startPtsNs: 302 * SEC, endPtsNs: 602 * SEC, final: true })];
  check('two seconds of arming delay is not flagged',
        !chunks.verifyChunkSet(prompt).problems.some((p) => p.code === 'STARTED_IN_PLAY'));

  // ── The same question for a whole-file upload, which has no chunks ──
  const cov = (o) => chunks.checkRecordingCoverage(o);

  check('an upload starting 25 min after kick-off is flagged',
        cov({ kickoffAt: '2026-09-10T15:00:00Z', recordingStartedAt: '2026-09-10T15:25:00Z' })
          .verdict === 'starts_in_play');
  check('and says what is missing rather than the arithmetic',
        cov({ kickoffAt: '2026-09-10T15:00:00Z', recordingStartedAt: '2026-09-10T15:25:00Z' })
          .message.includes('25 min'));
  check('an upload starting before kick-off is fine',
        cov({ kickoffAt: '2026-09-10T15:00:00Z', recordingStartedAt: '2026-09-10T14:52:00Z' })
          .verdict === 'covers_opening');
  check('a minute of clock drift is tolerated',
        cov({ kickoffAt: '2026-09-10T15:00:00Z', recordingStartedAt: '2026-09-10T15:01:00Z' })
          .verdict === 'covers_opening');

  // An untrusted camera clock must produce "unknown", never a confident lie.
  check('an untrusted camera clock yields unknown, not a false alarm',
        cov({ kickoffAt: '2026-09-10T15:00:00Z', recordingStartedAt: '2026-09-10T19:00:00Z',
              clockTrusted: false }).verdict === 'unknown');
  check('and no kick-off time also yields unknown',
        cov({ kickoffAt: null, recordingStartedAt: '2026-09-10T15:25:00Z' }).verdict === 'unknown');
  check('an unreadable timestamp yields unknown rather than NaN',
        cov({ kickoffAt: 'not-a-date', recordingStartedAt: '2026-09-10T15:25:00Z' })
          .verdict === 'unknown');

  // A late start AND a short file is a different conversation.
  const both = cov({ kickoffAt: '2026-09-10T15:00:00Z',
                     recordingStartedAt: '2026-09-10T15:25:00Z', durationSeconds: 20 * 60 });
  check('a late start that is also short says so', both.message.includes('20 min long'),
        both.message.slice(-58));
}

console.log(`\n${'='.repeat(60)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log('='.repeat(60));
process.exit(fail === 0 ? 0 : 1);
