ALTER TABLE "backup_history" DROP CONSTRAINT "backup_byte_size";--> statement-breakpoint
ALTER TABLE "backup_history" ADD CONSTRAINT "backup_byte_size" CHECK ("backup_history"."byte_size" >= 0);