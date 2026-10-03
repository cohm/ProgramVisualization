'use client';

import React from 'react';
import kthColors from '@/data/kth-colors.json';
import { buildInfo } from '@/lib/buildInfo';

const REPO = 'https://github.com/cohm/ProgramVisualization';

/**
 * The fixed corner link that says which build is on screen.
 *
 * A release reads "github · v1.2.0 · 2026-10-03", the version linking to its
 * release notes. Anything else, a PR preview or a local run, reads
 * "github · PR #128 · a4280c5 2026-10-02 07:20:04", linking to the PR and the
 * commit, so a preview cannot be mistaken for a release.
 */
export default function BuildBadge() {
  const info = buildInfo();
  const repo = info.repoUrl ?? REPO;
  const link = { color: kthColors.KthBlue?.HEX || '#004791', textDecoration: 'none', fontFamily: 'monospace' } as const;
  const time = info.timestamp ? new Date(info.timestamp).toISOString().replace('T', ' ') : '';
  const parts: React.ReactNode[] = [
    <a key="repo" href={REPO} target="_blank" rel="noopener noreferrer" style={link}>github</a>,
  ];
  if (info.release) {
    parts.push(<a key="v" href={`${repo}/releases/tag/${info.release}`} target="_blank" rel="noopener noreferrer" style={link}>{info.release}</a>);
    if (time) parts.push(<span key="t">{time.slice(0, 10)}</span>);
  } else {
    if (info.pr) parts.push(<a key="pr" href={`${repo}/pull/${info.pr}`} target="_blank" rel="noopener noreferrer" style={link}>PR #{info.pr}</a>);
    if (info.hash) {
      parts.push(
        <span key="h">
          <a href={`${repo}/commit/${info.hash}`} target="_blank" rel="noopener noreferrer" style={link}>{info.hash}</a>
          {time && <span style={{ marginLeft: 8 }}>{time.slice(0, 19)}</span>}
        </span>,
      );
    }
  }
  return (
    <div style={{
      position: 'fixed',
      bottom: 8,
      right: 8,
      fontSize: 11,
      color: '#6b7280',
      background: 'rgba(255, 255, 255, 0.9)',
      padding: '4px 8px',
      borderRadius: 4,
      boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
    }}>
      {parts.flatMap((p, i) => (i === 0 ? [p] : [<span key={`s${i}`}>{' · '}</span>, p]))}
    </div>
  );
}
