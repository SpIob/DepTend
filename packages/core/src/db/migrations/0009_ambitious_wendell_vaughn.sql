ALTER TYPE "public"."ecosystem" ADD VALUE 'cargo';--> statement-breakpoint
DROP INDEX "idx_mission_scores_composite_tier";--> statement-breakpoint
CREATE INDEX "idx_mission_scores_composite_tier" ON "mission_scores" USING btree (FLOOR("composite_score" / 0.5) DESC);