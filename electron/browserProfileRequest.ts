export type BrowserProfilePreference = 'shared' | 'isolated';

const sharedProfilePatterns: RegExp[] = [

  /\b(?:use|using|open\w*|in|on|through|via|with)\s+(?:my|our|the\s+user'?s)\s+(?:own\s+)?(?:normal|regular|usual|everyday|existing|current|main|default|personal|primary)?\s*(?:browser|chrome|edge|firefox|brave|opera|vivaldi|safari)\b/i,

  /\b(?:my|our|the\s+user'?s|his|her|their)\s+(?:own\s+)?(?:normal|regular|usual|everyday|existing|current|main|default|personal|primary|saved|signed[-\s]?in|logged[-\s]?in)?\s*(?:browser\s+|chrome\s+|edge\s+|firefox\s+)?(?:profile|session|sign[-\s]?ins?|logins?|cookies|bookmarks|passwords|browsing\s+history|extensions)\b/i,

  /\b(?:the\s+)?(?:default|shared|same|main)\s+(?:browser\s+)?profile\b/i,

  /\balready\s+(?:signed|logged)[-\s]?in\b/i,
  /\b(?:signed|logged)[-\s]?in\s+(?:browser|profile|session|account|tab|window)\b/i
];

const isolatedProfilePatterns: RegExp[] = [
  /\b(?:separate|own|fresh|clean|private|isolated|new|dedicated|worker)\s+(?:browser\s+)?profile\b/i,
  /\b(?:incognito|private\s+window|private\s+browsing)\b/i,
  /\bdo\s*n[o']?t\s+use\s+(?:my|our|the\s+user'?s)\s+(?:own\s+)?(?:browser|profile|session|sign[-\s]?ins?|logins?)\b/i
];

export function requestedBrowserProfile(text: string): BrowserProfilePreference | null {

  const value = String(text ?? '').replace(/[‘’ʼ]/g, "'");
  if (!value.trim()) return null;
  if (isolatedProfilePatterns.some((pattern) => pattern.test(value))) return 'isolated';
  if (sharedProfilePatterns.some((pattern) => pattern.test(value))) return 'shared';
  return null;
}
