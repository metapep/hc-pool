import { Column, Entity, PrimaryColumn } from 'typeorm';

import { TrackedEntity } from '../utils/TrackedEntity.entity';

@Entity()
export class AddressSettingsEntity extends TrackedEntity {

    @PrimaryColumn({ length: 62, type: 'varchar' })
    address: string;

    // Accumulated share-difficulty sum across the address — a float in JS,
    // grows unbounded. Postgres int32 column would overflow; use double
    // precision to match the per-row 'real' columns elsewhere in the entity
    // tree.
    @Column({ type: 'double precision', default: 0 })
    shares: number;

    @Column({ type: 'real', default: 0 })
    bestDifficulty: number;

    @Column({ nullable: true })
    miscCoinbaseScriptData: string;

    @Column({ nullable: true })
    bestDifficultyUserAgent: string;

}

