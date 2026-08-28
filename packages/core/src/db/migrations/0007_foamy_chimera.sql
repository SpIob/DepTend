ALTER TYPE "public"."dep_type" ADD VALUE 'transitive';--> statement-breakpoint
CREATE TABLE "notification_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_login" text NOT NULL,
	"repo_id" uuid NOT NULL,
	"event_types" text[] DEFAULT ARRAY['new_mission', 'claimed', 'resolved'] NOT NULL,
	"github_issue_number" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_subscriptions_user_repo_unique" UNIQUE("user_login","repo_id")
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_login" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_members_org_user_unique" UNIQUE("organization_id","user_login")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_login" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_github_login_unique" UNIQUE("github_login")
);
--> statement-breakpoint
ALTER TABLE "mission_scores" ALTER COLUMN "impact_inputs" SET DEFAULT '{"cvss_score":null,"severity":"unknown","is_transitive":false,"dep_type":"production","days_since_advisory":null,"epss_score":null}'::jsonb;--> statement-breakpoint
ALTER TABLE "advisories" ADD COLUMN "epss_score" numeric(6, 5);--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "org_id" uuid;--> statement-breakpoint
ALTER TABLE "notification_subscriptions" ADD CONSTRAINT "notification_subscriptions_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_notification_subscriptions_repo_id" ON "notification_subscriptions" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "idx_notification_subscriptions_user_login" ON "notification_subscriptions" USING btree ("user_login");--> statement-breakpoint
CREATE INDEX "idx_organization_members_user_login" ON "organization_members" USING btree ("user_login");--> statement-breakpoint
CREATE INDEX "idx_organization_members_org_id" ON "organization_members" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_organizations_github_login" ON "organizations" USING btree ("github_login");--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_advisories_severity_id" ON "advisories" USING btree ("severity","id");--> statement-breakpoint
CREATE INDEX "idx_dependencies_ecosystem_id" ON "dependencies" USING btree ("ecosystem","id");--> statement-breakpoint
CREATE INDEX "idx_mission_scores_effort_composite" ON "mission_scores" USING btree ("effort_label","composite_score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_missions_status_repo" ON "missions" USING btree ("status","repo_id");--> statement-breakpoint
CREATE INDEX "idx_repos_org_id" ON "repos" USING btree ("org_id");