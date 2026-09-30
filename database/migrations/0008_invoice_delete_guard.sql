-- A posted invoice is never deleted either. The foreign keys already refuse the
-- delete once a line, an adjustment or a ledger entry exists, but a draft or an
-- invoice without postings would still disappear silently, so the same guard now
-- covers DELETE and reports the reason instead of relying on a constraint.
CREATE OR REPLACE FUNCTION bcis_guard_invoice_identity() RETURNS trigger AS $$
DECLARE
	posting boolean := coalesce(current_setting('bcis.posting', true), 'off') = 'on';
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'bcis_immutable_row: a stored invoice cannot be deleted, void it instead' USING ERRCODE = '23514';
	END IF;

	IF (OLD.invoice_number IS NOT NULL AND NEW.invoice_number IS DISTINCT FROM OLD.invoice_number)
		OR ROW(OLD.cycle_id, OLD.run_id, OLD.subscriber_id, OLD.service_account_id, OLD.source, OLD.period_label, OLD.issue_date, OLD.due_date, OLD.created_by, OLD.created_at)
			IS DISTINCT FROM
			ROW(NEW.cycle_id, NEW.run_id, NEW.subscriber_id, NEW.service_account_id, NEW.source, NEW.period_label, NEW.issue_date, NEW.due_date, NEW.created_by, NEW.created_at) THEN
		RAISE EXCEPTION 'bcis_immutable_row: invoice identity and billing dates cannot be changed' USING ERRCODE = '23514';
	END IF;

	IF NOT posting AND ROW(OLD.status, OLD.subtotal_centavos, OLD.adjustment_centavos, OLD.total_centavos, OLD.paid_centavos, OLD.balance_centavos, OLD.finalized_at, OLD.voided_at, OLD.void_reason, OLD.notes)
		IS DISTINCT FROM
		ROW(NEW.status, NEW.subtotal_centavos, NEW.adjustment_centavos, NEW.total_centavos, NEW.paid_centavos, NEW.balance_centavos, NEW.finalized_at, NEW.voided_at, NEW.void_reason, NEW.notes) THEN
		RAISE EXCEPTION 'bcis_immutable_row: posted invoice figures are append-only, post an adjustment instead' USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER invoice_identity_immutable ON invoices;
CREATE TRIGGER invoice_identity_immutable BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION bcis_guard_invoice_identity();
