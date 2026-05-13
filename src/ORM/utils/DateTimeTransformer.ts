import { ValueTransformer } from 'typeorm';

/**
 * Date <-> DB transformer. Originally written for SQLite, where the upstream
 * public-pool used `toLocaleString()` to coerce Date into a TEXT-friendly
 * representation. On Postgres with `timestamp with time zone` columns the
 * pg driver already knows how to serialize/deserialize Date objects, and
 * the locale-string round-trip produced
 *   "invalid input syntax for type timestamp with time zone:
 *    '0NaN-NaN-NaNTNaN:NaN:NaN.NaN+NaN:NaN'"
 * because undefined Dates collapsed to NaN.
 *
 * Pass Date objects through unchanged. TypeORM + pg handle the rest.
 * Kept as a class so the entity decorator surface (`transformer: new
 * DateTimeTransformer()`) does not need to change.
 */
export class DateTimeTransformer implements ValueTransformer {
    to(value: Date | undefined | null): Date | undefined | null {
        return value;
    }

    from(value: any): Date {
        return value;
    }
}