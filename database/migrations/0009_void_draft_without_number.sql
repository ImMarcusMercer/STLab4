-- A draft that is discarded never received a document number, so voiding it kept the
-- row without a number. The check now requires a number for every status that is
-- actually issued, and accepts a VOID document with or without one, because a voided
-- document is either a numbered issued charge with a reversal or a discarded draft.
ALTER TABLE invoices DROP CONSTRAINT invoice_draft_unpaid;
ALTER TABLE invoices ADD CONSTRAINT invoice_draft_unpaid CHECK (status = 'DRAFT' OR status = 'VOID' OR invoice_number IS NOT NULL);
