/**
 * profile-guard.js — decide whether the Free launcher may reuse an existing
 * build configuration.
 *
 * `npm run dev:windows` used to skip configuration whenever
 * `www/js/kernel_config.js` existed, without checking *which* profile it
 * described. A checkout previously configured with `BUILD_PROFILE=pro` would
 * therefore launch, identify itself as the Free Electron edition, and keep
 * Pro-only runtime content such as `www/vendor/webr`.
 *
 * The decision is a pure function so it can be unit-tested on any platform,
 * without running npm or launching anything — the launcher itself is hard to
 * test, but this is the part that was wrong.
 */

/** Profiles the Free launcher is willing to prepare. */
const FREE_PROFILES = ['mini', 'light', 'full'];

/** Runtime content that only the Pro profile bundles. */
const PRO_ONLY_RUNTIME_DIRS = ['webr'];

/**
 * @param {object} state
 * @param {string|null} state.existingProfile  profile in the generated config, or null
 * @param {string} state.intendedProfile       the profile this launch wants
 * @param {boolean} [state.force]
 * @returns {{ action: 'configure'|'skip', reason: string }}
 */
function decideConfiguration({ existingProfile, intendedProfile, force = false }) {
  if (force) {
    return { action: 'configure', reason: '--force was given' };
  }
  if (!existingProfile) {
    return { action: 'configure', reason: 'no build profile is configured yet' };
  }
  if (existingProfile === 'unknown') {
    return { action: 'configure', reason: 'the generated config has no readable profile' };
  }
  if (existingProfile !== intendedProfile) {
    // Covers the Pro case and any other mismatch: a tree configured for one
    // profile must not be launched as another, or the app misreports what it is
    // and may carry runtimes the profile does not include.
    return {
      action: 'configure',
      reason: `configured profile is '${existingProfile}', but this launch wants '${intendedProfile}'`,
    };
  }
  return { action: 'skip', reason: `already configured for '${intendedProfile}'` };
}

/**
 * Is this a profile the Free launcher may prepare?
 * `pro` is rejected outright rather than reconfigured, because selecting it is
 * a deliberate act and silently overwriting it would destroy someone's setup.
 */
function isFreeProfile(profile) {
  return FREE_PROFILES.includes(profile);
}

module.exports = {
  FREE_PROFILES,
  PRO_ONLY_RUNTIME_DIRS,
  decideConfiguration,
  isFreeProfile,
};
