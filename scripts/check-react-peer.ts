/**
 * Guards the advertised React peer range.
 *
 * `peerDependencies` promises support for every React major in its range, so CI
 * installs and tests each one. This script is the gate that keeps that promise
 * honest: it fails when CI is asked to verify a React major the published range
 * does not actually cover, so widening an install can never quietly turn into an
 * unsupported compatibility claim.
 */

import manifest from '../package.json'

const requested = process.argv[2]

if (requested === undefined) {
  throw new Error('Usage: bun run scripts/check-react-peer.ts <react-major>')
}

/**
 * A range covers a major when some alternative pins that leading major. Enough to
 * prove coverage here, without reimplementing semver for a two-major range.
 */
function covers(peerRange: string, version: string): boolean {
  const major = version.split('.')[0] ?? ''

  if (major === '') return false

  return peerRange.split('||').some(
    (alternative) =>
      (alternative
        .trim()
        .replace(/^[\^~>=<\s]*/, '')
        .split('.')[0] ?? '') === major,
  )
}

const range = manifest.peerDependencies.react

if (!covers(range, requested)) {
  throw new Error(
    `react@${requested} is outside the published peer range react@${range}. ` +
      `Either widen peerDependencies.react or drop this CI matrix entry.`,
  )
}

console.log(`react@${range} covers react@${requested}.`)
