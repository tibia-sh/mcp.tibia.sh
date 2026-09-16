/**
 * The first-party packages, which are the ones this repo deploys and the only ones exempt from the release age.
 * check-lockfile.ts verifies each one's provenance against the workflow named here.
 */

/** The first-party packages the hosting repo may pin, each with the workflow that signs its provenance. */
export const FIRST_PARTY: ReadonlyMap<string, { workflow: string }> = new Map([
  ['@tibia.sh/tibiawiki-mcp', { workflow: 'tibia-sh/tibiawiki-mcp/.github/workflows/release.yml' }],
  ['@tibia.sh/tibiawiki-data', { workflow: 'tibia-sh/tibiawiki-data/.github/workflows/release.yml' }],
]);

/** The scope of every first-party package. A package under it without an entry in FIRST_PARTY is not trusted. */
export const FIRST_PARTY_SCOPE = '@tibia.sh/';
