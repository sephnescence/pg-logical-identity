CREATE TABLE "card" (
	"id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	"name" text NOT NULL,
	"collector_number" text NOT NULL,
	"set_identifier" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "card_set_collector_idx" ON "card" ("set_identifier", "collector_number");
--> statement-breakpoint
COMMENT ON TABLE "card" IS 'logical_id=86b4485c-391c-4615-8fe5-49ab9b2603e7';
--> statement-breakpoint
COMMENT ON COLUMN "card"."id" IS 'logical_id=b30e5cdb-2fc3-496c-b331-6f8e633e1b50';
--> statement-breakpoint
COMMENT ON COLUMN "card"."name" IS 'logical_id=82c9838d-df66-4b25-a03b-64b81305c35e';
--> statement-breakpoint
COMMENT ON COLUMN "card"."collector_number" IS 'logical_id=e0056a68-a0b4-40ad-80a2-93b366889ae3';
--> statement-breakpoint
COMMENT ON COLUMN "card"."set_identifier" IS 'logical_id=1aa50852-fadd-456a-a483-64128cd5ff54';
