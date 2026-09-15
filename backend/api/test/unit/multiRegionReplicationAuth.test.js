import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const receiveData = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../../k8s/multi-region/region-service.js', () => ({
    default: {
        receiveData
    }
}));

import regionRoutes from '../../../../k8s/multi-region/routes.js';

describe('multi-region replication authentication', () => {
    let app;
    let previousReplicationKey;

    beforeEach(() => {
        previousReplicationKey = process.env.REPLICATION_API_KEY;
        process.env.REPLICATION_API_KEY = 'test-replication-secret';
        receiveData.mockClear();

        app = express();
        app.use(express.json());
        app.use(regionRoutes);
    });

    afterEach(() => {
        if (previousReplicationKey === undefined) {
            delete process.env.REPLICATION_API_KEY;
        } else {
            process.env.REPLICATION_API_KEY = previousReplicationKey;
        }
    });

    it('rejects replication writes without credentials', async () => {
        const response = await request(app)
            .post('/replication/receive')
            .send({ payload: 'unauthorized' });

        expect(response.status).toBe(401);
        expect(receiveData).not.toHaveBeenCalled();
    });

    it('rejects replication writes with an invalid credential', async () => {
        const response = await request(app)
            .post('/replication/receive')
            .set('x-replication-key', 'wrong-secret')
            .send({ payload: 'invalid' });

        expect(response.status).toBe(401);
        expect(receiveData).not.toHaveBeenCalled();
    });

    it('fails closed when replication authentication is not configured', async () => {
        delete process.env.REPLICATION_API_KEY;

        const response = await request(app)
            .post('/replication/receive')
            .send({ payload: 'unconfigured' });

        expect(response.status).toBe(503);
        expect(receiveData).not.toHaveBeenCalled();
    });

    it('accepts replication writes with the configured credential', async () => {
        const payload = { payload: 'trusted' };

        const response = await request(app)
            .post('/replication/receive')
            .set('x-replication-key', 'test-replication-secret')
            .send(payload);

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            success: true,
            message: 'Data received'
        });
        expect(receiveData).toHaveBeenCalledWith(payload);
    });
});
