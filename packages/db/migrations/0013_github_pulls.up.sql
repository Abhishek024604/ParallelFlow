-- ADR-042: an arena lists the pull requests of its GitHub repository.
--
-- Developers open pull requests on GitHub from VS Code (as themselves). The pull_request webhook
-- (verified, one delivery once, ADR-040) upserts them into pull_requests, so the arena's list shows
-- them next to in-app pull requests. A GitHub row is a mirror: reviews and the merge happen on
-- GitHub under branch protection, never in the app.
--
-- New columns (all NULL for in-app pull requests): github_number, html_url, github_state
-- (open, draft, closed, merged), head_ref, author_login. merged_at is reused. A GitHub row may
-- have no ParallelFlow author (author_user_id NULL; author_login names the GitHub account), any
-- branch name and base, and a merge without merged_by (GitHub's merger is not a ParallelFlow user).
-- The checks that pin in-app rows (ai/ branch, base main, merged_by) still hold for them.
--
-- pull_requests already has tenant_isolation with FORCE RLS (0008); webhook writes run as a system
-- job in the arena's own org. No policy is edited or dropped; no SECURITY DEFINER.

SET search_path = saras, public;

ALTER TABLE pull_requests
  ADD COLUMN github_number int CHECK (github_number > 0),
  ADD COLUMN html_url      text CHECK (html_url ~ '^https://github\.com/[A-Za-z0-9._/-]{1,300}$'),
  ADD COLUMN github_state  text CHECK (github_state IN ('open', 'draft', 'closed', 'merged')),
  ADD COLUMN head_ref      text CHECK (char_length(head_ref) BETWEEN 1 AND 255),
  ADD COLUMN author_login  text CHECK (author_login ~ '^[A-Za-z0-9-]{1,39}(\[bot\])?$');

-- The 0008 checks have generated names; find them by what they say.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'saras.pull_requests'::regclass AND contype = 'c'
       AND (pg_get_constraintdef(oid) LIKE '%''^ai/''%'
         OR pg_get_constraintdef(oid) LIKE '%(base = ''main''::text)%'
         OR pg_get_constraintdef(oid) LIKE '%merged_by IS NOT NULL%')
  LOOP
    EXECUTE format('ALTER TABLE saras.pull_requests DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE pull_requests
  ADD CONSTRAINT pull_requests_github_shape CHECK (
    github_number IS NULL
    OR (html_url IS NOT NULL AND github_state IS NOT NULL AND head_ref IS NOT NULL)),
  ADD CONSTRAINT pull_requests_branch_check CHECK (branch ~ '^ai/' OR github_number IS NOT NULL),
  ADD CONSTRAINT pull_requests_base_check CHECK (
    base = 'main' OR (github_number IS NOT NULL AND char_length(base) BETWEEN 1 AND 255)),
  ADD CONSTRAINT pull_requests_author_check CHECK (
    author_user_id IS NOT NULL OR github_number IS NOT NULL),
  ADD CONSTRAINT pull_requests_merged_check CHECK (
    CASE WHEN github_number IS NULL
      THEN (status = 'merged') = (merged_at IS NOT NULL AND merged_by IS NOT NULL AND merge_sha IS NOT NULL)
      ELSE (status = 'merged') = (merged_at IS NOT NULL)
    END),
  ADD CONSTRAINT pull_requests_github_number_key UNIQUE (project_id, github_number);
ALTER TABLE pull_requests ALTER COLUMN author_user_id DROP NOT NULL;

-- One open in-app PR per branch; GitHub enforces its own (forks may reuse a branch name).
DROP INDEX pull_requests_one_open_per_branch;
CREATE UNIQUE INDEX pull_requests_one_open_per_branch ON pull_requests (project_id, branch)
  WHERE status IN ('open', 'approved', 'changes_requested') AND github_number IS NULL;
