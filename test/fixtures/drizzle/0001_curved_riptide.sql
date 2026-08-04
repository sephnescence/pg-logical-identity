ALTER TABLE "users" RENAME COLUMN "full_name" TO "display_name";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "created_at" timestamptz DEFAULT now();
