import type { NextConfig } from "next";
import { execSync } from 'child_process';

// Get git commit hash, timestamp, and repository URL at build time.
//
// Build context affects what's available:
// - Vercel: VERCEL_GIT_* env vars are set; we use those.
// - Local / GitHub Actions checkout: shell out to `git`.
// - Tarball / Docker layer with no .git: the catch returns 'unknown'.
//   To avoid the silent fallback in that case, set NEXT_PUBLIC_GIT_HASH (and
//   optionally NEXT_PUBLIC_GIT_TIMESTAMP / NEXT_PUBLIC_GIT_REPO_URL) in the
//   build environment — Next inlines them just like the values produced here.
const getGitInfo = () => {
  try {
    // On Vercel, use their environment variables if available
    const hash = process.env.VERCEL_GIT_COMMIT_SHA?.substring(0, 7) || 
                 execSync('git rev-parse --short HEAD').toString().trim();
    
    const timestamp = execSync('git log -1 --format=%cd --date=iso-strict').toString().trim();
    
    // Try to get the repository URL from git remote or Vercel env vars
    let repoUrl = '';
    
    // Check Vercel environment variables first
    if (process.env.VERCEL_GIT_PROVIDER && process.env.VERCEL_GIT_REPO_OWNER && process.env.VERCEL_GIT_REPO_SLUG) {
      repoUrl = `https://${process.env.VERCEL_GIT_PROVIDER}.com/${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}`;
    } else {
      // Fall back to git remote
      try {
        const remoteUrl = execSync('git config --get remote.origin.url').toString().trim();
        // Convert SSH URLs to HTTPS (e.g., git@github.com:user/repo.git -> https://github.com/user/repo)
        if (remoteUrl.startsWith('git@github.com:')) {
          repoUrl = remoteUrl.replace('git@github.com:', 'https://github.com/').replace(/\.git$/, '');
        } else if (remoteUrl.startsWith('https://')) {
          repoUrl = remoteUrl.replace(/\.git$/, '');
        }
      } catch {
        // No remote configured, use hardcoded fallback for this repo
        repoUrl = 'https://github.com/cohm/ProgramVisualization';
      }
    }

    return { hash, timestamp, repoUrl };
  } catch {
    return { 
      hash: process.env.VERCEL_GIT_COMMIT_SHA?.substring(0, 7) || 'unknown', 
      timestamp: new Date().toISOString(), 
      repoUrl: 'https://github.com/cohm/ProgramVisualization'
    };
  }
};

const gitInfo = getGitInfo();

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  // Ensure Chromium brotli assets are bundled with the export-pdf route.
  // The same path is also declared in `vercel.json` (functions →
  // src/app/api/export-pdf/route.ts → includeFiles); keep them in sync.
  // Both are required: Next uses outputFileTracingIncludes during the build
  // step, Vercel uses includeFiles when packaging the serverless function.
  outputFileTracingIncludes: {
    // Route pathname for app router
    '/api/export-pdf': [
      './node_modules/@sparticuz/chromium/bin/**',
    ],
  },
  // Keep chromium as an external package to preserve its internal paths
  serverExternalPackages: ['@sparticuz/chromium'],
  env: {
    NEXT_PUBLIC_GIT_HASH: gitInfo.hash,
    NEXT_PUBLIC_GIT_TIMESTAMP: gitInfo.timestamp,
    NEXT_PUBLIC_GIT_REPO_URL: gitInfo.repoUrl,
  },
};

export default nextConfig;
