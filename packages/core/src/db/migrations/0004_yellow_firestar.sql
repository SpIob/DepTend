CREATE TABLE "repo_bookmarks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"user_login" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_bookmarks_user_repo_unique" UNIQUE("user_login","repo_id")
);
--> statement-breakpoint
ALTER TABLE "repo_bookmarks" ADD CONSTRAINT "repo_bookmarks_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;