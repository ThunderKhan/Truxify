import { describe, it, expect } from 'vitest';
import swaggerJsdoc from 'swagger-jsdoc';

const spec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: { title: 'Truxify test API', version: '1.0.0' },
  },
  apis: ['src/routes/deliveryRoutes.js'],
});

describe('delivery confirmation OpenAPI contract', () => {
  it('documents the confirm-otp operation and request contract', () => {
    const operation = spec.paths['/api/delivery/{id}/confirm-otp']?.post;
    expect(operation).toBeDefined();
    expect(operation.tags).toEqual(['Delivery']);
    expect(operation.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'id',
          in: 'path',
          required: true,
        }),
      ])
    );
    expect(operation.requestBody.required).toBe(true);
  });

  it('documents authentication and all documented outcomes', () => {
    const operation = spec.paths['/api/delivery/{id}/confirm-otp'].post;
    expect(operation.security).toEqual([{ BearerAuth: [] }]);
    for (const status of ['200', '202', '400', '401', '403', '404', '500']) {
      expect(operation.responses).toHaveProperty(status);
    }
    expect(operation.responses['200'].content['application/json'].schema.$ref)
      .toBe('#/components/schemas/DeliveryConfirmationResponse');
    expect(operation.responses['202'].content['application/json'].schema.$ref)
      .toBe('#/components/schemas/DeliveryConfirmationAcceptedResponse');
    expect(spec.components.securitySchemes.BearerAuth).toEqual({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
  });
});
