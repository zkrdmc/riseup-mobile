/**
 * Smoke test for the pure-TypeScript half of the lens/survey work.
 *
 * Everything here runs without a phone, a camera or a native toolchain. The
 * calib3d module cannot be tested this way — it needs a compiled build — so
 * this covers the parts that CAN be checked now, which is most of the maths.
 */

const derive = require('../../../../.smoke/derive');
const distortion = require('../../../../.smoke/distortion');
const opencv = require('../../../../.smoke/opencv');
const exif = require('../../../../.smoke/exif');
const validate = require('../../../../.smoke/validate');

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

console.log(`\n${'='.repeat(60)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log('='.repeat(60));
process.exit(fail === 0 ? 0 : 1);
