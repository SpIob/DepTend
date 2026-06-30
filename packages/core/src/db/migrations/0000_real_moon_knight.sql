CREATE TYPE "public"."advisory_source" AS ENUM('osv', 'ghsa');--> statement-breakpoint
CREATE TYPE "public"."dep_type" AS ENUM('production', 'development', 'peer', 'optional');--> statement-breakpoint
CREATE TYPE "public"."ecosystem" AS ENUM('npm');--> statement-breakpoint
CREATE TYPE "public"."effort_label" AS ENUM('trivial', 'low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."ingestion_status" AS ENUM('pending', 'running', 'complete', 'failed');--> statement-breakpoint
CREATE TYPE "public"."mission_status" AS ENUM('open', 'claimed', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."mission_type" AS ENUM('vulnerability_fix', 'dep_update', 'maintenance', 'license_issue');--> statement-breakpoint
CREATE TYPE "public"."score_confidence" AS ENUM('high', 'medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('critical', 'high', 'medium', 'low', 'unknown');--> statement-breakpoint
CREATE TABLE "advisories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"osv_id" text NOT NULL,
	"source" "advisory_source" NOT NULL,
	"ecosystem" "ecosystem" DEFAULT 'npm' NOT NULL,
	"package_name" text NOT NULL,
	"severity" "severity" DEFAULT 'unknown' NOT NULL,
	"cvss_score" numeric(4, 1),
	"summary" text NOT NULL,
	"details" text,
	"affected_versions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fixed_version" text,
	"published_at" timestamp with time zone,
	"modified_at" timestamp with time zone,
	"raw_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "advisories_osv_id_unique" UNIQUE("osv_id")
);
--> statement-breakpoint
CREATE TABLE "dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"ecosystem" "ecosystem" DEFAULT 'npm' NOT NULL,
	"package_name" text NOT NULL,
	"version_spec" text NOT NULL,
	"resolved_version" text,
	"dep_type" "dep_type" NOT NULL,
	"latest_version" text,
	"is_deprecated" boolean DEFAULT false NOT NULL,
	"deprecation_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dependencies_repo_package_deptype_unique" UNIQUE("repo_id","package_name","dep_type")
);
--> statement-breakpoint
CREATE TABLE "dependency_advisories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dependency_id" uuid NOT NULL,
	"advisory_id" uuid NOT NULL,
	"is_affected" boolean NOT NULL,
	"match_method" text DEFAULT 'version_spec' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dependency_advisories_unique" UNIQUE("dependency_id","advisory_id")
);
--> statement-breakpoint
CREATE TABLE "ingestion_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"triggered_by" text NOT NULL,
	"status" "ingestion_status" DEFAULT 'running' NOT NULL,
	"dependencies_found" integer DEFAULT 0 NOT NULL,
	"advisories_fetched" integer DEFAULT 0 NOT NULL,
	"missions_created" integer DEFAULT 0 NOT NULL,
	"missions_updated" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"error_stack" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mission_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"impact_score" numeric(4, 1) NOT NULL,
	"ecosystem_value_score" numeric(4, 1) NOT NULL,
	"composite_score" numeric(4, 1) NOT NULL,
	"effort_label" "effort_label" NOT NULL,
	"impact_inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ecosystem_value_inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effort_inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" "score_confidence" NOT NULL,
	"confidence_notes" text[],
	"confidence_flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scoring_version" text DEFAULT '0.1.0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mission_scores_mission_id_unique" UNIQUE("mission_id")
);
--> statement-breakpoint
CREATE TABLE "missions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"action_hint" text,
	"mission_type" "mission_type" NOT NULL,
	"status" "mission_status" DEFAULT 'open' NOT NULL,
	"advisory_id" uuid,
	"dependency_id" uuid,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"dismiss_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_url" text NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"description" text,
	"stars" integer DEFAULT 0 NOT NULL,
	"open_issues_count" integer DEFAULT 0 NOT NULL,
	"topics" text[] DEFAULT '{}' NOT NULL,
	"homepage_url" text,
	"ingestion_status" "ingestion_status" DEFAULT 'pending' NOT NULL,
	"last_ingested_at" timestamp with time zone,
	"ingestion_error" text,
	"submitted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repos_github_url_unique" UNIQUE("github_url"),
	CONSTRAINT "repos_owner_name_unique" UNIQUE("owner","name")
);
--> statement-breakpoint
ALTER TABLE "dependencies" ADD CONSTRAINT "dependencies_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency_advisories" ADD CONSTRAINT "dependency_advisories_dependency_id_dependencies_id_fk" FOREIGN KEY ("dependency_id") REFERENCES "public"."dependencies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependency_advisories" ADD CONSTRAINT "dependency_advisories_advisory_id_advisories_id_fk" FOREIGN KEY ("advisory_id") REFERENCES "public"."advisories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_scores" ADD CONSTRAINT "mission_scores_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_advisory_id_advisories_id_fk" FOREIGN KEY ("advisory_id") REFERENCES "public"."advisories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_dependency_id_dependencies_id_fk" FOREIGN KEY ("dependency_id") REFERENCES "public"."dependencies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_advisories_package_name" ON "advisories" USING btree ("package_name");--> statement-breakpoint
CREATE INDEX "idx_advisories_ecosystem" ON "advisories" USING btree ("ecosystem");--> statement-breakpoint
CREATE INDEX "idx_advisories_severity" ON "advisories" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "idx_advisories_modified_at" ON "advisories" USING btree ("modified_at");--> statement-breakpoint
CREATE INDEX "idx_dependencies_repo_id" ON "dependencies" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "idx_dependencies_package_name" ON "dependencies" USING btree ("package_name");--> statement-breakpoint
CREATE INDEX "idx_dependencies_ecosystem" ON "dependencies" USING btree ("ecosystem");--> statement-breakpoint
CREATE INDEX "idx_dep_advisories_dependency_id" ON "dependency_advisories" USING btree ("dependency_id");--> statement-breakpoint
CREATE INDEX "idx_dep_advisories_advisory_id" ON "dependency_advisories" USING btree ("advisory_id");--> statement-breakpoint
CREATE INDEX "idx_dep_advisories_is_affected" ON "dependency_advisories" USING btree ("is_affected");--> statement-breakpoint
CREATE INDEX "idx_ingestion_runs_repo_id" ON "ingestion_runs" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "idx_ingestion_runs_status" ON "ingestion_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_ingestion_runs_started_at" ON "ingestion_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "idx_mission_scores_mission_id" ON "mission_scores" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "idx_mission_scores_composite_score" ON "mission_scores" USING btree ("composite_score");--> statement-breakpoint
CREATE INDEX "idx_mission_scores_confidence" ON "mission_scores" USING btree ("confidence");--> statement-breakpoint
CREATE INDEX "idx_missions_repo_id" ON "missions" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "idx_missions_status" ON "missions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_missions_mission_type" ON "missions" USING btree ("mission_type");--> statement-breakpoint
CREATE INDEX "idx_missions_advisory_id" ON "missions" USING btree ("advisory_id");--> statement-breakpoint
CREATE INDEX "idx_repos_ingestion_status" ON "repos" USING btree ("ingestion_status");--> statement-breakpoint
CREATE INDEX "idx_repos_last_ingested_at" ON "repos" USING btree ("last_ingested_at");