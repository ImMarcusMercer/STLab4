-- The invoice number is assigned once, when the document leaves DRAFT. The first
-- guard rejected that assignment, so the transition from NULL to a number is allowed
-- while every later change to the identity or the billing dates stays forbidden.
CREATE OR REPLACE FUNCTION bcis_guard_invoice_identity() RETURNS trigger AS $$
BEGIN
	IF (OLD.invoice_number IS NOT NULL AND NEW.invoice_number IS DISTINCT FROM OLD.invoice_number)
		OR ROW(OLD.cycle_id, OLD.run_id, OLD.subscriber_id, OLD.service_account_id, OLD.source, OLD.period_label, OLD.issue_date, OLD.due_date, OLD.created_by, OLD.created_at)
			IS DISTINCT FROM
			ROW(NEW.cycle_id, NEW.run_id, NEW.subscriber_id, NEW.service_account_id, NEW.source, NEW.period_label, NEW.issue_date, NEW.due_date, NEW.created_by, NEW.created_at) THEN
		RAISE EXCEPTION 'bcis_immutable_row: invoice identity and billing dates cannot be changed' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
