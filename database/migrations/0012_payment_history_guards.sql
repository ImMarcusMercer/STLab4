-- Phase 5 guards. A recorded payment can never be edited or deleted: the identity of
-- the entry is fixed when it is stored, and only its state moves, which the posting
-- transaction flag still governs. An allocation may only ever gain a reversal mark, and
-- the invoice a payment settles must always carry exactly the allocated total in its
-- paid column, so an allocation can never be written without moving the invoice.
CREATE OR REPLACE FUNCTION bcis_guard_payment_history() RETURNS trigger AS $$
DECLARE
	posting boolean := coalesce(current_setting('bcis.posting', true), 'off') = 'on';
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'bcis_immutable_row: a payment cannot be deleted, void or reverse it instead' USING ERRCODE = '23514';
	END IF;

	IF ROW(OLD.subscriber_id, OLD.method, OLD.direction, OLD.amount_centavos, OLD.received_on, OLD.reference_number, OLD.recorded_by, OLD.reversal_of_id, OLD.notes, OLD.created_at)
		IS DISTINCT FROM
		ROW(NEW.subscriber_id, NEW.method, NEW.direction, NEW.amount_centavos, NEW.received_on, NEW.reference_number, NEW.recorded_by, NEW.reversal_of_id, NEW.notes, NEW.created_at) THEN
		RAISE EXCEPTION 'bcis_immutable_row: a recorded payment cannot be edited, void or reverse it instead' USING ERRCODE = '23514';
	END IF;

	IF NOT posting AND ROW(OLD.status, OLD.receipt_number, OLD.reason, OLD.verified_by, OLD.verified_at, OLD.voided_at, OLD.void_reason)
		IS DISTINCT FROM
		ROW(NEW.status, NEW.receipt_number, NEW.reason, NEW.verified_by, NEW.verified_at, NEW.voided_at, NEW.void_reason) THEN
		RAISE EXCEPTION 'bcis_immutable_row: posted payment state is append-only, post a reversal instead' USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION bcis_guard_allocation_history() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'bcis_immutable_row: an allocation cannot be deleted, reverse the payment instead' USING ERRCODE = '23514';
	END IF;

	IF ROW(OLD.payment_id, OLD.invoice_id, OLD.source, OLD.amount_centavos, OLD.actor_id, OLD.created_at)
		IS DISTINCT FROM
		ROW(NEW.payment_id, NEW.invoice_id, NEW.source, NEW.amount_centavos, NEW.actor_id, NEW.created_at) THEN
		RAISE EXCEPTION 'bcis_immutable_row: an allocation cannot be edited, reverse the payment instead' USING ERRCODE = '23514';
	END IF;

	-- A reversal keeps the row and only marks it, so the history of what a payment
	-- settled is never rewritten.
	IF (OLD.reversed_at IS NULL) IS DISTINCT FROM (NEW.reversed_at IS NULL)
		AND coalesce(current_setting('bcis.posting', true), 'off') <> 'on' THEN
		RAISE EXCEPTION 'bcis_immutable_row: an allocation can only be reversed by a posting transaction' USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION bcis_guard_proof_history() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'bcis_immutable_row: an attached proof is kept for the life of the payment' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

-- The paid column of an invoice is the sum of the allocations that are still standing, so
-- the deferred check runs once the whole transaction has moved both sides. The same check
-- holds on the other side of the allocation: a payment can never settle more invoices than
-- the money it received, which is what stops one receipt from being counted twice.
CREATE OR REPLACE FUNCTION bcis_check_allocation_invariants() RETURNS trigger AS $$
DECLARE
	target uuid := NEW.invoice_id;
	source_payment uuid := NEW.payment_id;
	allocated integer;
	paid integer;
	invoice_status text;
	allocated_by_payment integer;
	received integer;
BEGIN
	SELECT i.paid_centavos, i.status INTO paid, invoice_status FROM invoices i WHERE i.id = target;
	IF NOT FOUND OR invoice_status IN ('DRAFT', 'VOID') THEN
		RETURN NULL;
	END IF;

	SELECT coalesce(sum(a.amount_centavos), 0)::integer INTO allocated
	FROM payment_allocations a WHERE a.invoice_id = target AND a.reversed_at IS NULL;

	IF allocated <> paid THEN
		RAISE EXCEPTION 'bcis_allocation_mismatch: allocations of invoice % total % but the invoice records %', target, allocated, paid USING ERRCODE = '23514';
	END IF;

	SELECT p.amount_centavos INTO received FROM payments p WHERE p.id = source_payment;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'bcis_allocation_orphan: allocation % has no payment %', NEW.id, source_payment USING ERRCODE = '23514';
	END IF;

	SELECT coalesce(sum(a.amount_centavos), 0)::integer INTO allocated_by_payment
	FROM payment_allocations a WHERE a.payment_id = source_payment AND a.reversed_at IS NULL;

	IF allocated_by_payment > received THEN
		RAISE EXCEPTION 'bcis_allocation_exceeds_payment: payment % received % but its allocations total %', source_payment, received, allocated_by_payment USING ERRCODE = '23514';
	END IF;

	RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_allocations_invoice_totals ON payment_allocations;
DROP FUNCTION IF EXISTS bcis_check_allocation_totals();

CREATE TRIGGER payments_immutable_guard BEFORE UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION bcis_guard_payment_history();
CREATE TRIGGER payment_allocations_immutable_guard BEFORE UPDATE OR DELETE ON payment_allocations FOR EACH ROW EXECUTE FUNCTION bcis_guard_allocation_history();
CREATE TRIGGER payment_proofs_immutable_guard BEFORE UPDATE OR DELETE ON payment_proofs FOR EACH ROW EXECUTE FUNCTION bcis_guard_proof_history();
CREATE CONSTRAINT TRIGGER payment_allocations_invariants AFTER INSERT OR UPDATE ON payment_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bcis_check_allocation_invariants();
