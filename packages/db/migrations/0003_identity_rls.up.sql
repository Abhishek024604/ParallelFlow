-- ADR-031: RLS for the global identity tables, and a narrow "user scope" for cross-arena reads.
--
-- Contexts (set by packages/db, transaction-local):
--   tenant   app.org_id = <org>, app.user_id = <user>     one org, as in schema_v2
--   user     app.org_id = nil uuid, app.user_id = <user>  only the user's own rows, across orgs
--   identity app.org_id = nil uuid, app.user_email = <verified email>  login / sign-up only
-- New policies read settings through the helpers below, which turn '' (a pooled connection that ran an
-- earlier transaction) into NULL instead of failing the uuid cast.

SET search_path = saras, public;

CREATE FUNCTION saras.current_user_id() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;
CREATE FUNCTION saras.current_org_id() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.org_id', true), '')::uuid $$;
CREATE FUNCTION saras.in_user_scope() RETURNS boolean LANGUAGE sql STABLE
  AS $$ SELECT coalesce(current_setting('app.org_id', true) = '00000000-0000-0000-0000-000000000000', false) $$;
CREATE FUNCTION saras.current_auth_email() RETURNS public.citext LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.user_email', true), '')::public.citext $$;
CREATE FUNCTION saras.is_system_job() RETURNS boolean LANGUAGE sql STABLE
  AS $$ SELECT coalesce(current_setting('app.system_job', true) = 'on', false) $$;

-- ---------------------------------------------------------------- users
-- Visible: yourself; the user whose verified email is signing in; co-members of the current org.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

CREATE POLICY users_read ON users FOR SELECT USING (
  id = saras.current_user_id()
  OR email = saras.current_auth_email()
  OR EXISTS (SELECT 1 FROM org_memberships m
             WHERE m.user_id = users.id AND m.org_id = saras.current_org_id())
);

-- Accounts are created at sign-up for the verified email only. System jobs may insert for seeding and
-- tests; no production job creates users.
CREATE POLICY users_insert ON users FOR INSERT WITH CHECK (
  email = saras.current_auth_email() OR saras.is_system_job()
);

-- Edit yourself (or your account during sign-in); a system job only edits members of its own org.
CREATE POLICY users_update ON users FOR UPDATE
  USING (
    id = saras.current_user_id()
    OR email = saras.current_auth_email()
    OR (saras.is_system_job() AND EXISTS (SELECT 1 FROM org_memberships m
                                          WHERE m.user_id = users.id AND m.org_id = saras.current_org_id()))
  )
  WITH CHECK (
    id = saras.current_user_id()
    OR email = saras.current_auth_email()
    OR (saras.is_system_job() AND EXISTS (SELECT 1 FROM org_memberships m
                                          WHERE m.user_id = users.id AND m.org_id = saras.current_org_id()))
  );
-- No DELETE policy: accounts are deactivated (deactivated_at), never deleted by the app.

-- ---------------------------------------------------------------- organizations
-- Visible: the current org; in user scope, every org you are an active member of (arena list).
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;

CREATE POLICY orgs_read ON organizations FOR SELECT USING (
  id = saras.current_org_id()
  OR (saras.in_user_scope() AND EXISTS (SELECT 1 FROM org_memberships m
                                        WHERE m.org_id = organizations.id
                                          AND m.user_id = saras.current_user_id()
                                          AND m.status = 'active'))
);
-- Creating an arena creates its (hidden) org inside a tenant context for the new org id.
CREATE POLICY orgs_insert ON organizations FOR INSERT WITH CHECK (id = saras.current_org_id());
CREATE POLICY orgs_update ON organizations FOR UPDATE
  USING (id = saras.current_org_id()) WITH CHECK (id = saras.current_org_id());

-- ---------------------------------------------------------------- user scope: own rows only, read only
-- Permissive, so they add to tenant_isolation; gated on user scope so tenant contexts stay single-org.
CREATE POLICY own_org_memberships ON org_memberships FOR SELECT
  USING (saras.in_user_scope() AND user_id = saras.current_user_id());
CREATE POLICY own_project_memberships ON project_members FOR SELECT
  USING (saras.in_user_scope() AND user_id = saras.current_user_id());
-- Projects you are a member of, while your org membership is active (suspended / expired guests: none).
CREATE POLICY member_projects ON projects FOR SELECT
  USING (saras.in_user_scope() AND EXISTS (
    SELECT 1 FROM project_members pm
    JOIN org_memberships m ON m.org_id = pm.org_id AND m.user_id = pm.user_id
    WHERE pm.project_id = projects.id
      AND pm.user_id = saras.current_user_id()
      AND m.status = 'active' AND (m.expires_at IS NULL OR m.expires_at > now())));
