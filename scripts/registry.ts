/**
 * The npm registry as the scripts that read it see it: the URLs of a package's documents, a bounded JSON fetch,
 * the provenance entries of an attestations document, and the defensive reads of what comes back.
 * check-lockfile.ts judges a lockfile by these documents, and bump.ts waits for a release to appear in them.
 */

export const REGISTRY = 'https://registry.npmjs.org/';
/** The predicate type of the provenance attestation npm attaches to a version published with provenance. */
export const PROVENANCE = 'https://slsa.dev/provenance/v1';

/** Resolves with the JSON body of the document at url, and rejects when there is no complete answer. */
export type FetchJson = (url: string) => Promise<unknown>;

/** The value of an own property of value, or undefined when value is not an object or has no such property. */
export function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

export function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An error's message, followed by its cause's, which is where fetch keeps the network error. */
export function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
}

/** A package name as the registry's own clients put it in a URL: a scope's slash escaped. It accepts both. */
function escaped(name: string): string {
  return name.replace('/', '%2F');
}

/** The packument URL of name: every version, with its publish time under `time`. */
export function packumentUrl(name: string): string {
  return `${REGISTRY}${escaped(name)}`;
}

/** The attestations URL of name@version: the attestations npm holds for that version. */
export function attestationsUrl(name: string, version: string): string {
  return `${REGISTRY}-/npm/v1/attestations/${escaped(name)}@${version}`;
}

/**
 * The entries of an attestations document whose predicate type is PROVENANCE, as the registry lists them, each
 * carrying under `bundle` the Sigstore bundle gh verifies. A document of another shape has none. The count is the
 * caller's rule: check-lockfile.ts requires exactly one, and bump.ts waits for at least one.
 */
export function provenanceAttestations(document: unknown): unknown[] {
  const attestations = field(document, 'attestations');
  return Array.isArray(attestations)
    ? attestations.filter((attestation) => field(attestation, 'predicateType') === PROVENANCE)
    : [];
}

/** The JSON body of a GET on url, within timeoutMs. It rejects on a status outside 200 to 299. */
export async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    if (signal.aborted) throw new Error(`no complete answer within ${timeoutMs / 1000} s`);
    throw error;
  }
}
