import { describe, expect, it } from 'vitest';
import swaggerJsdoc from 'swagger-jsdoc';

const spec = swaggerJsdoc({
  definition: { openapi: '3.0.0', info: { title: 'Truxify API', version: '1.0.0' } },
  apis: ['./src/routes/mlRoutes.js'],
});

describe('ML demand heatmap OpenAPI contract', () => {
  const operation = spec.paths['/api/ml/demand-heatmap']?.get;

  it('documents the endpoint and authentication', () => {
    expect(operation).toBeDefined();
    expect(operation.security).toEqual([{ bearerAuth: [] }]);
  });

  it('documents the zoneId query parameter', () => {
    expect(operation.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'zoneId',
          in: 'query',
          required: false,
        }),
      ]),
    );
  });

  it('documents the fallback response schema', () => {
    expect(operation.responses?.['200']?.content?.['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/MlDemandHeatmapResponse',
    });
    expect(spec.components?.schemas?.MlDemandHeatmapResponse).toBeDefined();
  });
});
