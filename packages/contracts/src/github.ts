import { z } from 'zod';

// An arena's repository on GitHub (ADR-040), through the server's ParallelFlow GitHub App. Once an
// arena is connected, GitHub's repository is the arena repo: every approved gate is pushed there,
// and pushes and merged pull requests on GitHub come back into the arena's Overview.
// Additive to openapi_v2.yaml (Phase A).
//   GET    /projects/{id}/github                status (arena.read)
//   POST   /projects/{id}/github/connect        owner → { url } of the GitHub App install page
//   GET    /github/setup                        GitHub's Setup URL → GitHub sign-in (OAuth)
//   GET    /github/callback                     GitHub's Callback URL → back to the arena
//   GET    /projects/{id}/github/choices?grant= owner → the repositories to pick from
//   POST   /projects/{id}/github/repo           owner → connects one of them
//   POST   /projects/{id}/github/sync           owner → 202, syncs now
//   DELETE /projects/{id}/github                owner → 204
//   POST   /github/webhook                      GitHub (X-Hub-Signature-256)

/** The repository an arena is connected to. */
export interface GithubRepoLink {
  owner: string;
  name: string;
  /** owner/name */
  full_name: string;
  /** https://github.com/owner/name */
  html_url: string;
  /** https://github.com/owner/name.git (no credentials) */
  clone_url: string;
  default_branch: string;
  connected_at: string;
  /** Last time the arena repo and GitHub matched. */
  last_synced_at: string | null;
  /** Plain words, when the last sync failed; null when it worked. */
  last_sync_error: string | null;
}

/** GET /projects/{id}/github */
export interface GithubStatus {
  /** False when this server has no GitHub App set up. */
  available: boolean;
  /** You may connect, sync or disconnect (the arena owner). */
  can_manage: boolean;
  repo: GithubRepoLink | null;
}

/** POST /projects/{id}/github/connect: open `url` (GitHub) in the same tab. */
export interface GithubConnectStart {
  url: string;
}

/** One repository the person picked when installing the app, for GET …/github/choices. */
export interface GithubRepoChoice {
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
}

/** The query parameter GitHub's callback sends back to the arena page with the grant. */
export const GITHUB_GRANT_PARAM = 'github_grant';
/** …and on failure, a reason code (GithubConnectError). */
export const GITHUB_ERROR_PARAM = 'github_error';

export type GithubConnectError = 'denied' | 'expired' | 'no_access' | 'no_repos' | 'failed';

export const GithubConnectRepoSchema = z.object({
  grant: z.string().min(20).max(4000),
  repo_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type GithubConnectRepo = z.output<typeof GithubConnectRepoSchema>;
