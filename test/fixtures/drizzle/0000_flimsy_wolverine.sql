CREATE TABLE "users" (
	"id" bigint PRIMARY KEY NOT NULL,
	"full_name" text,
	"email" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" ("email");
