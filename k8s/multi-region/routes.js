import crypto from 'crypto';
import express from 'express';
import regionService from './region-service.js';
import logger from '../../backend/api/src/middleware/logger.js';

const router = express.Router();

const authenticateReplicationRequest = (req, res, next) => {
    const configuredKey = process.env.REPLICATION_API_KEY;
    const providedKey = req.get('x-replication-key');

    if (!configuredKey) {
        logger.error('Replication authentication is not configured: REPLICATION_API_KEY is missing');
        return res.status(503).json({
            success: false,
            error: 'Replication authentication is not configured'
        });
    }

    if (!providedKey) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized'
        });
    }

    const configuredDigest = crypto.createHash('sha256').update(configuredKey).digest();
    const providedDigest = crypto.createHash('sha256').update(providedKey).digest();

    if (!crypto.timingSafeEqual(configuredDigest, providedDigest)) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized'
        });
    }

    return next();
};

// Get region metrics
router.get('/regions/metrics', async (req, res) => {
    try {
        const metrics = await regionService.getRegionMetrics();
        res.json({
            success: true,
            data: metrics,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Metrics error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get region health
router.get('/regions/health', async (req, res) => {
    try {
        const health = await regionService.checkAllRegions();
        res.json({
            success: true,
            data: health,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Health check error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get replication lag
router.get('/regions/replication-lag', async (req, res) => {
    try {
        const lag = await regionService.getReplicationLag();
        res.json({
            success: true,
            data: lag,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Replication lag error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get active region
router.get('/regions/active', async (req, res) => {
    try {
        const region = regionService.getTargetRegion();
        res.json({
            success: true,
            data: region,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Active region error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Route request
router.post('/regions/route', async (req, res) => {
    try {
        const region = await regionService.routeRequest(req.body);
        res.json({
            success: true,
            data: {
                region,
                routed: true
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Route request error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Replication receive endpoint
router.post('/replication/receive', authenticateReplicationRequest, async (req, res) => {
    try {
        await regionService.receiveData(req.body);
        res.json({
            success: true,
            message: 'Data received',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Replication receive error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
