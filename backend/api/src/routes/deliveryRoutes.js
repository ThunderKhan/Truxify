import express from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { userLimiter } from '../middleware/rateLimiter.js';
import { validateBody } from '../middleware/validate.js';
import { orderRepository, orderLifecycleService, logger } from '../core/container.js';
import { sendFcmNotification, storeDeliveryOtp } from '../services/notificationService.js';

const router = express.Router();

const confirmOtpSchema = z.object({
  otp: z.string().regex(/^\d{4}$/, { message: 'OTP must be 4 digits' }).optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth radius in meters
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) *
    Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // in meters
}

/**
 * @openapi
 * components:
 *   securitySchemes:
 *     BearerAuth:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: JWT
 *   schemas:
 *     DeliveryConfirmationRequest:
 *       type: object
 *       required: [otp]
 *       properties:
 *         otp:
 *           type: string
 *           pattern: '^\\d{4}$'
 *           minLength: 4
 *           maxLength: 4
 *           description: Server-verified four-digit delivery OTP.
 *           example: '4821'
 *         latitude:
 *           type: number
 *           description: Optional caller-provided latitude. It is not used as the delivery authorization signal.
 *           example: 19.076
 *         longitude:
 *           type: number
 *           description: Optional caller-provided longitude. It is not used as the delivery authorization signal.
 *           example: 72.8777
 *     DeliveryConfirmationResponse:
 *       type: object
 *       required: [success, message, payment_released, isGeofenced]
 *       properties:
 *         success: { type: boolean, example: true }
 *         message: { type: string, example: Delivery verified successfully! Payment released to driver. }
 *         payment_released: { type: boolean, example: true }
 *         isGeofenced: { type: boolean, example: true }
 *     DeliveryConfirmationAcceptedResponse:
 *       type: object
 *       required: [message, escrow_status, payment_released, isGeofenced]
 *       properties:
 *         message: { type: string, example: Delivery verified successfully. Escrow payout requires reconciliation. }
 *         escrow_status: { type: string, example: released }
 *         payment_released: { type: boolean, example: true }
 *         isGeofenced: { type: boolean, example: true }
 *     DeliveryConfirmationError:
 *       type: object
 *       properties:
 *         error: { type: string }
 * /api/delivery/{id}/confirm-otp:
 *   post:
 *     tags: [Delivery]
 *     summary: Confirm delivery with the server-verified OTP
 *     description: Confirms delivery for the driver assigned to the order and releases the associated escrow payment. Caller-supplied GPS coordinates do not replace OTP verification.
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         description: Order identifier accepted by the order repository.
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/DeliveryConfirmationRequest'
 *     responses:
 *       200:
 *         description: Delivery verified and payment released.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DeliveryConfirmationResponse'
 *       202:
 *         description: Delivery verified while escrow payout requires reconciliation.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DeliveryConfirmationAcceptedResponse'
 *       400:
 *         description: Missing or invalid OTP.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DeliveryConfirmationError'
 *       401:
 *         description: Authentication is required.
 *       403:
 *         description: Caller is not the driver assigned to the order.
 *       404:
 *         description: Order not found.
 *       500:
 *         description: Delivery confirmation failed or an internal server error occurred.
 */
router.post('/:id/confirm-otp', authenticate, userLimiter, validateBody(confirmOtpSchema), async (req, res) => {
  try {
    const orderId = req.params.id;
    const { otp, latitude, longitude } = req.body;

    // 1. Fetch order details from database
    const order = await orderRepository.findOrderByAnyId(orderId, '*');
    if (!order || !order.data) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    const orderData = order.data;

    // Ensure access control: only the assigned driver or admin can confirm delivery
    if (orderData.driver_id !== req.user.id) {
      return res.status(403).json({ error: 'Access Denied: You are not assigned to this order.' });
    }

    // GPS coordinates submitted by the caller are untrusted, so delivery
    // confirmation must always use the server-verified OTP.
    if (!otp) {
      return res.status(400).json({ error: 'OTP is required to confirm delivery.' });
    }

    const otpToVerify = otp;

    // 4. Trigger delivery completion and escrow payment release
    // This calls verifyDelivery under the hood which releases smart contract payments
    const { escrowUpdateFailed } = await orderLifecycleService.verifyDeliveryFn(
      orderData.id,
      req.user.id,
      otpToVerify
    );

    // 5. Send FCM push notification to the driver: "Payment Released ✓ ₹XXXX credited"
    const displayAmount = orderData.total_amount ? (orderData.total_amount / 100).toFixed(2) : '0.00';
    await sendFcmNotification(req.user.id, {
      title: 'Payment Released',
      body: `✓ ₹${displayAmount} credited`
    }).catch(err => {
      logger.warn(`[confirm-otp] Notification delivery failed: ${err.message}`);
    });

    if (escrowUpdateFailed) {
      return res.status(202).json({
        message: 'Delivery verified successfully. Escrow payout requires reconciliation.',
        escrow_status: 'released',
        payment_released: true,
        isGeofenced: true
      });
    }

    return res.json({
      success: true,
      message: 'Delivery verified successfully! Payment released to driver.',
      payment_released: true,
      isGeofenced: true
    });
  } catch (err) {
    logger.error('[confirm-otp] Exception:', err.message);
    return res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
  }
});

export default router;
