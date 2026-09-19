import { describe, it, expect } from 'vitest';
import swaggerJsdoc from 'swagger-jsdoc';

const spec = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: { title: 'Truxify test API', version: '1.0.0' },
  },
  apis: ['src/routes/mlRoutes.js'],
});

describe('ML A/B-testing rollback OpenAPI contract', () => {
  it('documents the admin rollback endpoint and test identifier', () => {
    const operation = spec.paths['/api/ml/ab-testing/rollback/{testId}']?.post;
    expect(operation).toBeDefined();
    expect(operation.tags).toEqual(['ML A/B Testing']);
    expect(operation.summary).toBe('Roll back an ML A/B test');
    expect(operation.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'testId',
          in: 'path',
          required: true,
        }),
      ])
    );
  });

  it('documents authentication, error outcomes, and rollback schema', () => {
    const operation = spec.paths['/api/ml/ab-testing/rollback/{testId}'].post;
    expect(operation.security).toEqual([{ BearerAuth: [] }]);
    for (const status of ['200', '401', '403', '429', '502']) {
      expect(operation.responses).toHaveProperty(status);
    }

    const schema = spec.components.schemas.MlAbTestingRollbackResponse;
    expect(schema).toBeDefined();
    expect(schema.required).toEqual(['action', 'test_id', 'reason', 'timestamp']);
    expect(schema.properties.action.enum).toEqual([
      'insufficient_metrics',
      'rollback',
      'rollback_failed',
      'promote',
    ]);
    expect(schema.properties.timestamp.format).toBe('date-time');
    expect(spec.components.securitySchemes.BearerAuth).toEqual({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
  });
});
