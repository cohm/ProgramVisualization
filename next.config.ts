import type { NextConfig } from "next";
import { execSync } from 'child_process';

// Get git commit hash, timestamp, and repository URL at build time
const getGitInfo = () => {
  try {
    const hash = execSync('git rev-parse --short HEAD').toString().trim();
    const timestamp = execSync('git log -1 --format=%cd --date=iso-strict').toString().trim();
    
    // Try to get the repository URL from git remote
    let repoUrl = '';
    try {
      const remoteUrl = execSync('git config --get remote.origin.url').toString().trim();
      // Convert SSH URLs to HTTPS (e.g., git@github.com:user/repo.git -> https://github.com/user/repo)
      if (remoteUrl.startsWith('git@github.com:')) {
        repoUrl = remoteUrl.replace('git@github.com:', 'https://github.com/').replace(/\.git$/, '');
      } else if (remoteUrl.startsWith('https://')) {
        repoUrl = remoteUrl.replace(/\.git$/, '');
      }
    } catch (e) {
      // No remote configured, leave empty
    }
    
    return { hash, timestamp, repoUrl };
  } catch (e) {
    return { hash: 'unknown', timestamp: new Date().toISOString(), repoUrl: '' };
  }
};

const gitInfo = getGitInfo();

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  env: {
    NEXT_PUBLIC_GIT_HASH: gitInfo.hash,
    NEXT_PUBLIC_GIT_TIMESTAMP: gitInfo.timestamp,
    NEXT_PUBLIC_GIT_REPO_URL: gitInfo.repoUrl,
  },
};

export default nextConfig;
