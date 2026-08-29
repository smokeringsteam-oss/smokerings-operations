// Per-subreddit post flair, keyed by the normalized subreddit name (lowercase,
// no "r/" prefix — matches what normalizeSubreddit() in redditPoster.js
// produces). `null` means the subreddit either doesn't use flair or we
// intentionally post without one there.
//
// Source of truth for this mapping: the user's own account history of what
// flair was used on each subreddit for past Smoke Rings BBQ posts.
export const SUBREDDIT_FLAIRS = {
  bangalorefoodies: 'Pop-up', // used on 2 posts, including the crosspost
  bangaloremarketplace: 'Selling',
  bengaluru: 'Foods & stuff | ಆಹಾರ-ತಿಂಡಿ',
  bangalore: 'Suggestions',
  indiranagar: null,
  bangloremarketplace: null, // note: distinct (typo'd) subreddit from bangaloremarketplace
  bangaloresocial: null,
  test: 'Test',
};

// Looks up the flair text for a normalized subreddit name, or null if that
// subreddit has no configured flair.
export function getFlairForSubreddit(subreddit) {
  const key = String(subreddit || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(SUBREDDIT_FLAIRS, key) ? SUBREDDIT_FLAIRS[key] : null;
}
