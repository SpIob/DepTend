-- Composite indexes for board query filters (ADR 0031 optimization)
-- These support the multi-table join + filter pattern in getBoardMissionsWithScoresPage

-- advisories: filter by severity, join on id
CREATE INDEX IF NOT EXISTS idx_advisories_severity_id ON advisories (severity, id);

-- dependencies: filter by ecosystem, join on id  
CREATE INDEX IF NOT EXISTS idx_dependencies_ecosystem_id ON dependencies (ecosystem, id);

-- mission_scores: filter by effortLabel, order by compositeScore
CREATE INDEX IF NOT EXISTS idx_mission_scores_effort_composite ON mission_scores (effort_label, composite_score DESC);

-- missions: status filter + repo join (for potential future repo-scoped board)
CREATE INDEX IF NOT EXISTS idx_missions_status_repo ON missions (status, repo_id);