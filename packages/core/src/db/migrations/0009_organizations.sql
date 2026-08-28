-- Organizations table
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_login TEXT NOT NULL UNIQUE,
  name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Organization members table
CREATE TABLE organization_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_login TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member', -- 'owner' | 'admin' | 'member'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, user_login)
);

-- Add org_id to repos table
ALTER TABLE repos ADD COLUMN org_id UUID REFERENCES organizations(id) ON DELETE SET NULL;

-- Indexes
CREATE INDEX idx_organizations_github_login ON organizations(github_login);
CREATE INDEX idx_organization_members_user_login ON organization_members(user_login);
CREATE INDEX idx_organization_members_org_id ON organization_members(organization_id);
CREATE INDEX idx_repos_org_id ON repos(org_id);

-- Trigger for updated_at on organizations
CREATE TRIGGER set_updated_at_organizations
  BEFORE UPDATE ON organizations
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- Trigger for updated_at on organization_members
CREATE TRIGGER set_updated_at_organization_members
  BEFORE UPDATE ON organization_members
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();