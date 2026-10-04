-- Phase 7 service control guards.
--
-- This migration is trigger and policy only, so it changes no table definition. Drizzle
-- generates a snapshot per migration and compares the next one against it, so the snapshot
-- here is deliberately the same shape as 0014: what is being added is database behaviour that
-- a schema diff cannot describe. The SUSPENDED service status itself is a column constraint
-- and lives in database/schema.ts and its own generated migration, so the two cannot drift.
--
-- A suspension and a reconnection are documents, not flags: the identity of the document
-- (its number, its account, the reason it was raised, the policy it was raised under and the
-- amount frozen onto it) can never be edited or deleted, so "why was this customer cut off"
-- stays answerable after the fact. Only the lifecycle fields move, only forward, and only
-- inside a transaction that has declared itself a service control transaction.
--
-- A service account may only enter or leave SUSPENDED through such a transaction, and the
-- database then insists that the same transaction wrote the service history entry for the
-- change. That is what stops a disconnection happening with nothing to show for it, even if
-- someone reaches the database directly.
CREATE OR REPLACE FUNCTION bcis_guard_suspension_state() RETURNS trigger AS $$
DECLARE
	managed boolean := coalesce(current_setting('bcis.control', true), 'off') = 'on';
	step text;
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'bcis_immutable_row: a suspension cannot be deleted, lift it instead' USING ERRCODE = '23514';
	END IF;

	IF ROW(OLD.suspension_number, OLD.service_account_id, OLD.reason, OLD.notes, OLD.effective_date, OLD.grace_period_days,
		OLD.threshold_centavos, OLD.arrears_at_suspension_centavos, OLD.months_unpaid_at_suspension, OLD.approved_by, OLD.created_at)
		IS DISTINCT FROM
		ROW(NEW.suspension_number, NEW.service_account_id, NEW.reason, NEW.notes, NEW.effective_date, NEW.grace_period_days,
		NEW.threshold_centavos, NEW.arrears_at_suspension_centavos, NEW.months_unpaid_at_suspension, NEW.approved_by, NEW.created_at) THEN
		RAISE EXCEPTION 'bcis_immutable_row: a suspension is kept as it was raised, it can only be lifted' USING ERRCODE = '23514';
	END IF;

	IF NOT managed AND NEW.status IS DISTINCT FROM OLD.status THEN
		RAISE EXCEPTION 'bcis_immutable_row: suspension state is append-only, lift it through the service control command' USING ERRCODE = '23514';
	END IF;

	IF OLD.status IS DISTINCT FROM NEW.status THEN
		step := CASE
			WHEN OLD.status = 'ACTIVE' AND NEW.status = 'LIFTED' THEN 'lifted'
			WHEN OLD.status = 'ACTIVE' AND NEW.status = 'CANCELLED' THEN 'cancelled'
			ELSE NULL
		END;
		IF step IS NULL THEN
			RAISE EXCEPTION 'bcis_invalid_transition: a suspension cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
		END IF;
		-- A lifted suspension is dated by the transaction that lifted it, so the date is never
		-- left blank on a document that claims to have ended.
		IF NEW.status = 'LIFTED' AND (NEW.lifted_at IS NULL OR NEW.lifted_by IS NULL) THEN
			RAISE EXCEPTION 'bcis_incomplete_transition: a lifted suspension must record when it was lifted and who lifted it' USING ERRCODE = '23514';
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION bcis_guard_reconnection_state() RETURNS trigger AS $$
DECLARE
	managed boolean := coalesce(current_setting('bcis.control', true), 'off') = 'on';
	step text;
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'bcis_immutable_row: a reconnection cannot be deleted, complete or cancel it instead' USING ERRCODE = '23514';
	END IF;

	IF ROW(OLD.reconnection_number, OLD.service_account_id, OLD.suspension_id, OLD.fee_centavos, OLD.requested_by, OLD.requested_at)
		IS DISTINCT FROM
		ROW(NEW.reconnection_number, NEW.service_account_id, NEW.suspension_id, NEW.fee_centavos, NEW.requested_by, NEW.requested_at) THEN
		RAISE EXCEPTION 'bcis_immutable_row: a reconnection request is kept as it was raised, it can only be progressed' USING ERRCODE = '23514';
	END IF;

	IF NOT managed AND ROW(OLD.status, OLD.technician_id, OLD.assigned_at, OLD.completed_at, OLD.notes)
		IS DISTINCT FROM
		ROW(NEW.status, NEW.technician_id, NEW.assigned_at, NEW.completed_at, NEW.notes) THEN
		RAISE EXCEPTION 'bcis_immutable_row: reconnection progress is append-only, use the reconnection commands' USING ERRCODE = '23514';
	END IF;

	IF OLD.status IS DISTINCT FROM NEW.status THEN
		step := CASE
			WHEN OLD.status = 'REQUESTED' AND NEW.status = 'ASSIGNED' THEN 'assigned'
			WHEN OLD.status = 'REQUESTED' AND NEW.status = 'CANCELLED' THEN 'cancelled'
			WHEN OLD.status = 'ASSIGNED' AND NEW.status = 'COMPLETED' THEN 'completed'
			WHEN OLD.status = 'ASSIGNED' AND NEW.status = 'CANCELLED' THEN 'cancelled'
			ELSE NULL
		END;
		IF step IS NULL THEN
			RAISE EXCEPTION 'bcis_invalid_transition: a reconnection cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
		END IF;
		IF NEW.status = 'ASSIGNED' AND NEW.technician_id IS NULL THEN
			RAISE EXCEPTION 'bcis_incomplete_transition: an assigned reconnection must name the technician' USING ERRCODE = '23514';
		END IF;
		IF NEW.status = 'COMPLETED' AND (NEW.technician_id IS NULL OR NEW.completed_at IS NULL) THEN
			RAISE EXCEPTION 'bcis_incomplete_transition: a completed reconnection must name the technician and the completion date' USING ERRCODE = '23514';
		END IF;
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Entering or leaving SUSPENDED is a service control action: it happens inside a transaction
-- that has set bcis.control, and the deferred check below then requires the matching service
-- history row before the transaction is allowed to commit.
CREATE OR REPLACE FUNCTION bcis_guard_service_control_status() RETURNS trigger AS $$
BEGIN
	IF NEW.status IS DISTINCT FROM OLD.status
		AND (NEW.status = 'SUSPENDED' OR OLD.status = 'SUSPENDED')
		AND coalesce(current_setting('bcis.control', true), 'off') <> 'on' THEN
		RAISE EXCEPTION 'bcis_control_required: suspending or restoring a service must go through the service control commands' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- now() is the start of this transaction, so a history row written by any earlier transaction
-- is strictly older than it. That makes "the same transaction wrote the history entry" a test
-- the database can answer for itself.
CREATE OR REPLACE FUNCTION bcis_check_service_control_history() RETURNS trigger AS $$
BEGIN
	IF NEW.status IS DISTINCT FROM OLD.status
		AND coalesce(current_setting('bcis.control', true), 'off') = 'on' THEN
		IF NOT EXISTS (
			SELECT 1 FROM master_history h
			WHERE h.resource = 'services' AND h.record_id = NEW.id
				AND h.created_at >= now()
				AND h.snapshot->>'status' = NEW.status
				AND h.snapshot->>'controlEvent' IS NOT NULL
		) THEN
			RAISE EXCEPTION 'bcis_history_required: the service history must record the change to % in the same transaction', NEW.status USING ERRCODE = '23514';
		END IF;
	END IF;
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- One suspension at a time per service account: a second disconnection cannot be raised while
-- the first is still in force.
CREATE UNIQUE INDEX "suspensions_one_active_idx" ON "suspensions" ("service_account_id") WHERE "status" = 'ACTIVE';
--> statement-breakpoint
CREATE UNIQUE INDEX "reconnections_one_open_idx" ON "reconnections" ("suspension_id") WHERE "status" IN ('REQUESTED','ASSIGNED');

CREATE TRIGGER suspensions_state_guard BEFORE UPDATE OR DELETE ON suspensions FOR EACH ROW EXECUTE FUNCTION bcis_guard_suspension_state();
--> statement-breakpoint
CREATE TRIGGER reconnections_state_guard BEFORE UPDATE OR DELETE ON reconnections FOR EACH ROW EXECUTE FUNCTION bcis_guard_reconnection_state();
--> statement-breakpoint
CREATE TRIGGER service_accounts_control_guard BEFORE UPDATE ON service_accounts FOR EACH ROW EXECUTE FUNCTION bcis_guard_service_control_status();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER service_accounts_control_history AFTER UPDATE ON service_accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bcis_check_service_control_history();
