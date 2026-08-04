ALTER TABLE "widget" RENAME COLUMN "label" TO "title";--> statement-breakpoint
ALTER TABLE "widget" ADD COLUMN "weight" integer;--> statement-breakpoint
COMMENT ON COLUMN "widget"."weight" IS 'logical_id=44444444-4444-4444-8444-444444444444';
