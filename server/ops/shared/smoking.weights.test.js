import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, removeTestDb } from '../../core/testDb.js';

let dir;
let smoking;
let inventory;

beforeAll(async () => {
  ({ dir } = createTestDb({
    materials: [{ item_id: 'RM-PORK', item_name: 'Pork shoulder', category: 'Meat', quantity_on_hand: 20 }],
  }));
  // After createTestDb, which points KB_SQLITE_PATH at the temp database.
  smoking = await import('./smoking.js');
  inventory = await import('../../core/inventoryStore.js');
});

afterAll(() => removeTestDb(dir));

const stockOnHand = () => Number(inventory.getMeatMaterials().find((m) => m.item_id === 'RM-PORK').quantity_on_hand);

// Brined and rubbed, then carried as far as `upTo`.
function sessionAt(upTo) {
  const { session } = smoking.startBrining({ materialId: 'RM-PORK', brineStart: '2026-09-10T08:00', brineEnd: '2026-09-10T20:00' });
  const id = session.session_id;
  smoking.completeRub({ sessionId: id, rubStart: '2026-09-11T06:00', rubEnd: '2026-09-11T06:30' });
  if (upTo === 'ready_to_smoke') return id;
  smoking.startSmoking({ sessionId: id, rawWeightKg: 5, smokingStart: '2026-09-11T07:00' });
  if (upTo === 'smoking') return id;
  smoking.finishSmoking({ sessionId: id, smokingEnd: '2026-09-11T19:00', finishedWeightWithBoneKg: 3 });
  return id;
}

describe('updateSessionWeights', () => {
  it('corrects raw and finished weights, recomputes yield, and moves stock by the raw difference', () => {
    const id = sessionAt('resting');
    const before = stockOnHand();

    const { session } = smoking.updateSessionWeights({
      sessionId: id,
      rawWeightKg: '4.5',
      finishedWeightWithBoneKg: '3.2',
      finishedWeightWithoutBoneKg: '2.7',
    });

    expect(Number(session.raw_weight_kg)).toBe(4.5);
    expect(Number(session.finished_weight_with_bone_kg)).toBe(3.2);
    expect(Number(session.finished_weight_without_bone_kg)).toBe(2.7);
    expect(Number(session.yield_pct)).toBe(71.1);
    expect(session.stage).toBe('resting');
    // 0.5 kg less went on the smoker than was first logged, so it goes back.
    expect(stockOnHand()).toBeCloseTo(before + 0.5);
  });

  it('refuses a finished weight heavier than raw', () => {
    const id = sessionAt('resting');
    expect(() => smoking.updateSessionWeights({ sessionId: id, finishedWeightWithoutBoneKg: '6' })).toThrow(/heavier/);
  });

  it('refuses finished weights before Smoking finish, and raw before Smoking start', () => {
    const smokingId = sessionAt('smoking');
    expect(() => smoking.updateSessionWeights({ sessionId: smokingId, finishedWeightWithBoneKg: '3' })).toThrow(
      /Smoking finish/,
    );
    const readyId = sessionAt('ready_to_smoke');
    expect(() => smoking.updateSessionWeights({ sessionId: readyId, rawWeightKg: '3' })).toThrow(/Smoking start/);
  });

  it('clears a finished weight sent blank, but never the raw one', () => {
    const id = sessionAt('resting');
    const { session } = smoking.updateSessionWeights({ sessionId: id, finishedWeightWithBoneKg: '' });
    expect(session.finished_weight_with_bone_kg === '' || session.finished_weight_with_bone_kg == null).toBe(true);
    expect(session.yield_pct === '' || session.yield_pct == null).toBe(true);
    expect(() => smoking.updateSessionWeights({ sessionId: id, rawWeightKg: '' })).toThrow(/can't be cleared/);
  });
});
