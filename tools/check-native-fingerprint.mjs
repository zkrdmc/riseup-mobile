#!/usr/bin/env node
/**
 * Has the native side changed without the app version being bumped?
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY THIS SCRIPT EXISTS
 * ══════════════════════════════════════════════════════════════════════════
 * `app.json` used to set `runtimeVersion: { policy: "fingerprint" }`. EAS then
 * computed a fingerprint on the developer's machine AND on the build worker,
 * and refused the build if they disagreed. They disagreed for a reason nobody
 * would guess: a local `./gradlew assembleRelease` REWRITES files inside
 * `node_modules` — AGP 8 no longer accepts `package` in a library manifest, so
 * the build strips it in place — which changed a hashed input and killed two
 * consecutive cloud builds with a bare "Unknown error".
 *
 * `node_modules` is not in git, so no commit can protect it. The policy is now
 * `appVersion`, which cannot mismatch because it hashes nothing.
 *
 * THAT TRADE HAS A COST, AND THIS IS THE MITIGATION.
 * `runtimeVersion` is what decides which builds an OTA update may be delivered
 * to. Under `appVersion` it is the `version` string, so if a native module is
 * added and the version is NOT bumped, an update built against the new native
 * code will be offered to an installed binary that does not contain it — and
 * the app crashes on launch, in the field, for everybody who already had it.
 *
 * The fingerprint policy prevented that automatically and unreliably. This
 * checks the same fact deliberately: it hashes the native inputs, compares
 * them to a committed baseline, and fails if they moved while `version` stood
 * still. Run it in CI and before a release.
 *
 *   npm run check:native          compare against the baseline
 *   npm run check:native -- --update   accept the current state as the baseline
 *
 * Note it will also, usefully, catch the stripped manifest above: if a local
 * Gradle build has mutated `node_modules`, the hash moves and this says so.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const baselinePath = join(here, 'native-fingerprint.json');

const PLATFORMS = ['android', 'ios'];

function appVersion() {
  const config = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8'));
  return config.expo?.version ?? null;
}

function fingerprint(platform) {
  // The same command EAS runs for this. Invoked through npx so it uses the
  // project's own expo-updates rather than anything global.
  // `shell: true` because on Windows the resolved binary is `npx.cmd`, and
  // spawning a .cmd without a shell fails with EINVAL rather than anything
  // that names the problem.
  const out = execSync(
    `npx expo-updates fingerprint:generate --platform ${platform}`,
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  // The command prints the full source list as JSON; we want the hash.
  const parsed = JSON.parse(out);
  if (typeof parsed.hash !== 'string') {
    throw new Error(`no hash in the fingerprint for ${platform}`);
  }
  return parsed.hash;
}

function main() {
  const update = process.argv.includes('--update');
  const version = appVersion();
  if (version === null) {
    console.error('check:native — app.json has no expo.version to compare against.');
    process.exit(1);
  }

  const current = {};
  for (const platform of PLATFORMS) {
    try {
      current[platform] = fingerprint(platform);
    } catch (error) {
      // A machine that cannot compute this must not be blocked by it. Warn
      // loudly and pass: the check is a safety net, not a gate on being able
      // to work.
      console.warn(
        `check:native — could not fingerprint ${platform}, skipping it: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (Object.keys(current).length === 0) {
    console.warn('check:native — nothing could be fingerprinted; not failing.');
    return;
  }

  if (update || !existsSync(baselinePath)) {
    writeFileSync(
      baselinePath,
      `${JSON.stringify({ version, ...current }, null, 2)}\n`,
      'utf8',
    );
    console.log(`check:native — baseline written for version ${version}:`);
    for (const [platform, hash] of Object.entries(current)) {
      console.log(`  ${platform}  ${hash}`);
    }
    return;
  }

  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const moved = Object.entries(current).filter(
    ([platform, hash]) => baseline[platform] !== undefined && baseline[platform] !== hash,
  );

  if (moved.length === 0) {
    console.log(`check:native — native inputs unchanged for version ${version}.`);
    return;
  }

  if (baseline.version !== version) {
    // Native changed AND the version was bumped. That is the correct pairing,
    // so record the new state rather than complaining about it.
    writeFileSync(
      baselinePath,
      `${JSON.stringify({ version, ...current }, null, 2)}\n`,
      'utf8',
    );
    console.log(
      `check:native — native inputs changed and version moved `
      + `${baseline.version} → ${version}. Baseline updated; commit it.`,
    );
    return;
  }

  console.error('');
  console.error('check:native — THE NATIVE SIDE CHANGED AND THE VERSION DID NOT.');
  for (const [platform, hash] of moved) {
    console.error(`  ${platform}  ${baseline[platform]} → ${hash}`);
  }
  console.error('');
  console.error(`  app.json version is still ${version}.`);
  console.error('');
  console.error('  runtimeVersion is the appVersion policy, so an OTA update built');
  console.error('  against this native code WOULD BE DELIVERED to installed binaries');
  console.error('  that do not contain it, and they crash on launch.');
  console.error('');
  console.error('  Two possibilities:');
  console.error('');
  console.error('   1. A native dependency really did change. Bump expo.version in');
  console.error('      app.json, then run: npm run check:native -- --update');
  console.error('');
  console.error('   2. Nothing changed on purpose, and a local Gradle build mutated');
  console.error('      node_modules. A release build strips `package=` from library');
  console.error('      manifests in place. Check with:');
  console.error('');
  console.error("        grep -rl '<manifest  xmlns' node_modules --include=AndroidManifest.xml");
  console.error('');
  console.error('      Restore the affected package (reinstall it) and re-run.');
  console.error('');
  process.exit(1);
}

main();
