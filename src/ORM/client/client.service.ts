import { Injectable } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { BehaviorSubject, firstValueFrom } from 'rxjs';
import { IsNull, LessThan, ObjectLiteral, Repository } from 'typeorm';

import { ClientEntity } from './client.entity';



@Injectable()
export class ClientService {


    public insertQueue: { result: BehaviorSubject<ObjectLiteral | null>, partialClient: Partial<ClientEntity> }[] = [];


    constructor(
        @InjectRepository(ClientEntity)
        private clientRepository: Repository<ClientEntity>
    ) {

    }

    @Interval(1000 * 5)
    public async insertClients() {
        const queueCopy = [...this.insertQueue];
        this.insertQueue = [];

        const results = await this.clientRepository.insert(queueCopy.map(c => c.partialClient));

        queueCopy.forEach((c, index) => {
            c.result.next(results.generatedMaps[index]);
        });
    }

    public async killDeadClients() {
        // Mark zombie sessions (no heartbeat in last 5 min) as soft-deleted.
        // Upstream public-pool used raw SQLite DATETIME() calls in a
        // QueryBuilder.set/where pair; on Postgres 'function datetime does
        // not exist' fires every interval and dead-session cleanup never
        // runs. Switching to TypeORM's dialect-agnostic IsNull / LessThan
        // operators + a JS Date sidesteps the SQLite/Postgres divergence
        // and matches the deleteOldStatistics pattern in the sister service.
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        return await this.clientRepository.update(
            { deletedAt: IsNull(), updatedAt: LessThan(fiveMinutesAgo) },
            { deletedAt: new Date() },
        );
    }

    public async heartbeat(address: string, clientName: string, sessionId: string, hashRate: number, updatedAt: Date) {
        return await this.clientRepository.update({ address, clientName, sessionId }, { hashRate, deletedAt: null, updatedAt });
    }

    // public async save(client: Partial<ClientEntity>) {
    //     return await this.clientRepository.save(client);
    // }


    public async insert(partialClient: Partial<ClientEntity>): Promise<ClientEntity> {

        const result = new BehaviorSubject(null);

        this.insertQueue.push({ result, partialClient });


        //  const insertResult = await this.clientRepository.insert(partialClient);

        const generatedMap = await firstValueFrom(result);

        const client = {
            ...partialClient,
            ...generatedMap
        };

        return client as ClientEntity;
    }

    public async delete(sessionId: string) {
        return await this.clientRepository.softDelete({ sessionId });
    }

    public async deleteOldClients() {

        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        return await this.clientRepository
            .createQueryBuilder()
            .delete()
            .from(ClientEntity)
            .where('deletedAt < :deletedAt', { deletedAt: oneDayAgo })
            .execute();

    }

    public async updateBestDifficulty(sessionId: string, bestDifficulty: number) {
        return await this.clientRepository.update({ sessionId }, { bestDifficulty });
    }
    public async connectedClientCount(): Promise<number> {
        return await this.clientRepository.count();
    }

    public async getByAddress(address: string): Promise<ClientEntity[]> {
        return await this.clientRepository.find({
            where: {
                address
            }
        })
    }


    public async getByName(address: string, clientName: string): Promise<ClientEntity[]> {
        return await this.clientRepository.find({
            where: {
                address,
                clientName
            }
        })
    }

    public async getBySessionId(address: string, clientName: string, sessionId: string): Promise<ClientEntity> {
        return await this.clientRepository.findOne({
            where: {
                address,
                clientName,
                sessionId
            }
        })
    }

    public async deleteAll() {
        return await this.clientRepository.softDelete({})
    }

    public async getUserAgents() {
        const result = await this.clientRepository.createQueryBuilder('client')
            .select('client.userAgent as userAgent')
            .addSelect('COUNT(client.userAgent)', 'count')
            .addSelect('MAX(client.bestDifficulty)', 'bestDifficulty')
            .addSelect('SUM(client.hashRate)', 'totalHashRate')
            .groupBy('client.userAgent')
            .orderBy('count', 'DESC')
            .getRawMany();
        return result;
    }

    public async getActiveClients(): Promise<ClientEntity[]> {
        return this.clientRepository.find({
            order: {
                updatedAt: 'DESC'
            }
        });
    }

}
