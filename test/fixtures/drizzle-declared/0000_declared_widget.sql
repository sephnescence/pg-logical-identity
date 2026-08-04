CREATE TABLE "widget" (
	"id" bigint PRIMARY KEY NOT NULL,
	"label" text,
	"internal" text
);
--> statement-breakpoint
COMMENT ON TABLE "widget" IS 'logical_id=11111111-1111-4111-8111-111111111111';
--> statement-breakpoint
COMMENT ON COLUMN "widget"."id" IS 'logical_id=22222222-2222-4222-8222-222222222222';
--> statement-breakpoint
COMMENT ON COLUMN "widget"."label" IS 'Display label shown in the admin UI. logical_id=33333333-3333-4333-8333-333333333333';
