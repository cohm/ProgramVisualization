/**
 * What build this is, from the values `next.config.ts` fixes at build time.
 *
 * A release is a build made from a `vX.Y.Z` tag, and only releases are
 * deployed to the public sites. Anything else, a PR preview or a local run,
 * is identified by its commit, and by its PR when Vercel reports one.
 */

const RELEASE = /^v\d+\.\d+\.\d+$/;

export interface BuildInfo {
  /** "v1.2.0" on a release build, otherwise undefined. */
  release?: string;
  /** `git describe` output, e.g. "v1.2.0-3-ga4280c5"; empty before the first tag. */
  describe: string;
  hash?: string;
  /** The commit's own time, ISO 8601; empty when it was not available. */
  timestamp?: string;
  repoUrl?: string;
  /** The PR a Vercel preview was built for. */
  pr?: string;
}

export function buildInfo(): BuildInfo {
  const describe = process.env.NEXT_PUBLIC_APP_VERSION ?? '';
  const hash = process.env.NEXT_PUBLIC_GIT_HASH;
  return {
    release: RELEASE.test(describe) ? describe : undefined,
    describe,
    hash: hash && hash !== 'unknown' ? hash : undefined,
    timestamp: process.env.NEXT_PUBLIC_GIT_TIMESTAMP || undefined,
    repoUrl: process.env.NEXT_PUBLIC_GIT_REPO_URL || undefined,
    pr: process.env.NEXT_PUBLIC_PR_NUMBER || undefined,
  };
}

/**
 * The build as the export's audit stamp names it: "v1.2.0 (a4280c5)" for a
 * release, "build a4280c5" otherwise, so an exported chart can be traced to
 * the version a reader saw or, failing that, to its commit.
 */
export function buildStamp(info: BuildInfo = buildInfo()): string | undefined {
  if (info.release) return info.hash ? `${info.release} (${info.hash})` : info.release;
  return info.hash ? `build ${info.hash}` : undefined;
}
