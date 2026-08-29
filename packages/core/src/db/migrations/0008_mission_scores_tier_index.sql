CREATE INDEX "idx_mission_scores_composite_tier" ON "mission_scores" USING btree (FLOOR("composite_score" / 0.5) DESC);
