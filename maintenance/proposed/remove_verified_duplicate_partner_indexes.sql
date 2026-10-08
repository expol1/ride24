SET lock_timeout = '5s';
SET statement_timeout = '15s';
DO $indexes$
DECLARE pair record;
BEGIN
  FOR pair IN SELECT * FROM (VALUES
    ('public.idx_bookings_partner_id','public.bookings_partner_idx'),
    ('public.idx_car_classes_partner','public.car_classes_partner_idx')
  ) AS p(remove_index, keep_index)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_index a JOIN pg_index b ON a.indrelid=b.indrelid
      WHERE a.indexrelid=to_regclass(pair.remove_index)
        AND b.indexrelid=to_regclass(pair.keep_index)
        AND a.indisvalid AND b.indisvalid AND a.indisready AND b.indisready
        AND NOT a.indisunique AND NOT b.indisunique
        AND NOT a.indisprimary AND NOT b.indisprimary
        AND NOT a.indisexclusion AND NOT b.indisexclusion
        AND a.indnatts=b.indnatts AND a.indnkeyatts=b.indnkeyatts
        AND a.indkey=b.indkey AND a.indclass=b.indclass
        AND a.indcollation=b.indcollation AND a.indoption=b.indoption
        AND a.indexprs::text IS NOT DISTINCT FROM b.indexprs::text
        AND a.indpred::text IS NOT DISTINCT FROM b.indpred::text
        AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conindid=a.indexrelid)
    ) THEN
      RAISE EXCEPTION 'Index is not a safe duplicate: %',pair.remove_index;
    END IF;
    EXECUTE 'DROP INDEX ' || pair.remove_index;
  END LOOP;
END;
$indexes$;

