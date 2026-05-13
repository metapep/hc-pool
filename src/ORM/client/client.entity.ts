import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import { DateTimeTransformer } from '../utils/DateTimeTransformer';
import { TrackedEntity } from '../utils/TrackedEntity.entity';

//https://www.sqlite.org/withoutrowid.html

//The WITHOUT ROWID optimization is likely to be helpful for tables that have non-integer
// or composite (multi-column) PRIMARY KEYs and that do not store large strings or BLOBs.
//WITHOUT ROWID tables work best when individual rows are not too large.
@Entity({ withoutRowid: true })
@Index(['address', 'clientName', 'sessionId'], { unique: true })
export class ClientEntity extends TrackedEntity {


    @PrimaryColumn({ length: 62, type: 'varchar' })
    address: string;

    @PrimaryColumn({ length: 64, type: 'varchar' })
    clientName: string;

    @PrimaryColumn({ length: 8, type: 'varchar' })
    sessionId: string;


    @Column({ length: 128, type: 'varchar', nullable: true })
    userAgent: string;



    @Column({ type: 'timestamp with time zone', transformer: new DateTimeTransformer() })
    startTime: Date;

    @Column({ type: 'real', default: 0 })
    bestDifficulty: number

    // Live hashrate is a JS float (e.g. 250117.44). SQLite's untyped integer
    // column silently accepted the value but Postgres' int32 rejects with
    // 22P02 'invalid input syntax for type integer'. Use double precision so
    // the full IEEE-754 range round-trips cleanly.
    @Column({ type: 'double precision', default: 0 })
    hashRate: number;

}

