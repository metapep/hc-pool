import { CreateDateColumn, DeleteDateColumn, UpdateDateColumn } from 'typeorm';

import { DateTimeTransformer } from './DateTimeTransformer';

export abstract class TrackedEntity {
    @DeleteDateColumn({ nullable: true, type: 'timestamp with time zone', transformer: new DateTimeTransformer() })
    public deletedAt?: Date;

    @CreateDateColumn({ type: 'timestamp with time zone', transformer: new DateTimeTransformer() })
    public createdAt?: Date

    @UpdateDateColumn({ type: 'timestamp with time zone', transformer: new DateTimeTransformer() })
    public updatedAt?: Date
}