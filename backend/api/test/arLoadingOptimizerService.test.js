import { describe, expect, it } from 'vitest';
import { arLoadingOptimizerService } from '../src/services/arLoadingOptimizerService.js';

describe('ARLoadingOptimizerService', () => {
  it('rejects a pallet that exceeds container length', async () => {
    await expect(
      arLoadingOptimizerService.generateLoadingPlan({
        container: {
          lengthCm: 100,
          widthCm: 100,
          heightCm: 100,
          maxPayloadKg: 10000
        },
        pallets: [
          {
            id: 'P1',
            lengthCm: 120,
            widthCm: 50,
            heightCm: 50,
            weightKg: 100
          }
        ]
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'Pallet P1 exceeds container dimensions'
    });
  });

  it('rejects non-positive pallet dimensions', async () => {
    await expect(
      arLoadingOptimizerService.generateLoadingPlan({
        container: {
          lengthCm: 100,
          widthCm: 100,
          heightCm: 100,
          maxPayloadKg: 10000
        },
        pallets: [
          {
            id: 'P1',
            lengthCm: 0,
            widthCm: 50,
            heightCm: 50,
            weightKg: 100
          }
        ]
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('returns bounding boxes that remain inside the container', async () => {
    const plan = await arLoadingOptimizerService.generateLoadingPlan({
      container: {
        lengthCm: 100,
        widthCm: 100,
        heightCm: 100,
        maxPayloadKg: 10000
      },
      pallets: [
        {
          id: 'P1',
          lengthCm: 40,
          widthCm: 50,
          heightCm: 20,
          weightKg: 100
        },
        {
          id: 'P2',
          lengthCm: 40,
          widthCm: 50,
          heightCm: 20,
          weightKg: 100
        }
      ]
    });

    for (const placement of plan.placementSequence) {
      const [minX, minY, minZ] = placement.arBoundingBox.min;
      const [maxX, maxY, maxZ] = placement.arBoundingBox.max;
      expect(minX).toBeGreaterThanOrEqual(0);
      expect(minY).toBeGreaterThanOrEqual(0);
      expect(minZ).toBeGreaterThanOrEqual(0);
      expect(maxX).toBeLessThanOrEqual(1);
      expect(maxY).toBeLessThanOrEqual(1);
      expect(maxZ).toBeLessThanOrEqual(1);
    }
  });
});
