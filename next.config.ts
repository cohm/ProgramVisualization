import type { NextConfig } from "next";
import { execSync } from 'child_process';

// Build identification, fixed at build time: the release version, commit
// hash, commit time and repository URL.
//
// The version is the release tag the build was made from, `git describe`
// against `v*` tags: "v1.2.0" for a release, "v1.2.0-3-ga4280c5" for a build
// three commits after it, the bare hash before any tag exists. A release build
// needs the tags in its checkout (`fetch-depth: 0` in the workflows).
//
// Build context affects what's available:
// - GitHub Actions (releases, Pages) and local builds: `git`.
// - Vercel's own builds (PR previews): VERCEL_GIT_* env vars; `git` may be
//   missing. The PR number comes from VERCEL_GIT_PULL_REQUEST_ID.
// - Anywhere, NEXT_PUBLIC_APP_VERSION / NEXT_PUBLIC_GIT_HASH /
//   NEXT_PUBLIC_GIT_TIMESTAMP in the environment override what is found here.
const git = (args: string): string => {
  try {
    return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
};

const getGitInfo = () => {
  const hash = process.env.NEXT_PUBLIC_GIT_HASH
    || process.env.VERCEL_GIT_COMMIT_SHA?.substring(0, 7)
    || git('rev-parse --short HEAD')
    || 'unknown';
  // The commit's own time. Left empty rather than replaced by the build time
  // when git is not available: a footer showing the build clock as the
  // commit time was wrong without saying so.
  const timestamp = process.env.NEXT_PUBLIC_GIT_TIMESTAMP || git('log -1 --format=%cI');
  const version = process.env.NEXT_PUBLIC_APP_VERSION
    || git("describe --tags --match 'v[0-9]*' --abbrev=7")
    || '';

  let repoUrl = 'https://github.com/cohm/ProgramVisualization';
  if (process.env.VERCEL_GIT_PROVIDER && process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG) {
    repoUrl = `https://${process.env.VERCEL_GIT_PROVIDER}.com/${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}`;
  } else {
    // Convert SSH URLs to HTTPS (e.g., git@github.com:user/repo.git -> https://github.com/user/repo)
    const remoteUrl = git('config --get remote.origin.url');
    if (remoteUrl.startsWith('git@github.com:')) {
      repoUrl = remoteUrl.replace('git@github.com:', 'https://github.com/').replace(/\.git$/, '');
    } else if (remoteUrl.startsWith('https://')) {
      repoUrl = remoteUrl.replace(/\.git$/, '');
    }
  }

  return { hash, timestamp, version, repoUrl, pr: process.env.VERCEL_GIT_PULL_REQUEST_ID || '' };
};

const gitInfo = getGitInfo();

// `BUILD_TARGET=pages` switches to a static export for GitHub Pages: no
// server runtime, basePath set to the repo slug, image optimisation off.
// The Pages workflow also deletes `src/app/api` before building so the
// PDF route doesn't make `next build` fail under `output: 'export'`. The
// Vercel build leaves BUILD_TARGET unset and keeps the original
// server-mode config.
//
// IMPORTANT: keep the two configs as separate top-level objects rather
// than spreading conditional fragments. Next 16's config loader silently
// drops fields produced by `...(cond ? {...} : {...})` spreads — empirically
// `output: 'export'` was being ignored that way and the build never
// produced an `out/` directory. Top-level branching avoids the issue.
const isPagesBuild = process.env.BUILD_TARGET === 'pages';
const repoSlug = process.env.GITHUB_REPOSITORY?.split('/')[1] || 'ProgramVisualization';
const basePath = isPagesBuild ? `/${repoSlug}` : '';

const sharedEnv = {
  NEXT_PUBLIC_APP_VERSION: gitInfo.version,
  NEXT_PUBLIC_GIT_HASH: gitInfo.hash,
  NEXT_PUBLIC_GIT_TIMESTAMP: gitInfo.timestamp,
  NEXT_PUBLIC_GIT_REPO_URL: gitInfo.repoUrl,
  NEXT_PUBLIC_PR_NUMBER: gitInfo.pr,
};

const nextConfig: NextConfig = isPagesBuild
  ? {
      reactCompiler: true,
      // `next dev` on Next 16.3.x otherwise re-appends a generic
      // <!-- BEGIN:nextjs-agent-rules --> block to the hand-maintained
      // AGENTS.md on every run, dirtying the working tree each time.
      agentRules: false,
      output: 'export',
      basePath,
      assetPrefix: `${basePath}/`,
      images: { unoptimized: true },
      trailingSlash: true,
      env: sharedEnv,
    }
  : {
      reactCompiler: true,
      // Set in both branches deliberately, not spread in: see the note above
      // about Next 16's loader dropping fields from conditional spreads.
      agentRules: false,
      // Ensure Chromium brotli assets are bundled with the export-pdf route.
      // The same path is also declared in `vercel.json` (functions →
      // src/app/api/export-pdf/route.ts → includeFiles); keep them in sync.
      // Both are required: Next uses outputFileTracingIncludes during the
      // build step, Vercel uses includeFiles when packaging the serverless
      // function.
      outputFileTracingIncludes: {
        '/api/export-pdf': [
          './node_modules/@sparticuz/chromium/bin/**',
        ],
      },
      // Keep chromium as an external package to preserve its internal paths
      serverExternalPackages: ['@sparticuz/chromium'],
      env: sharedEnv,
    };

export default nextConfig;
