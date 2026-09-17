// Sprint rollover: which board items get carried into the current sprint.
import { describe, it, expect } from 'vitest';
import { itemsToCarryOver } from './githubProjects.js';

const DAY = 24 * 60 * 60 * 1000;
const AT = new Date('2026-09-14T06:00:00Z');
const lastSprintEnd = new Date('2026-09-14T00:00:00Z').getTime();

function item(overrides) {
  return {
    id: 'item',
    sprintTitle: 'Sprint 10',
    sprintEndMs: lastSprintEnd,
    status: 'In Progress',
    state: 'OPEN',
    ...overrides,
  };
}

describe('itemsToCarryOver', () => {
  it('moves open items from an ended sprint', () => {
    const items = [item({ id: 'a', status: 'Backlog' }), item({ id: 'b', status: 'In Progress' }), item({ id: 'c', status: null })];
    expect(itemsToCarryOver(items, 'Sprint 11', AT).map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('also picks up items from older ended sprints', () => {
    const items = [item({ id: 'old', sprintTitle: 'Sprint 8', sprintEndMs: lastSprintEnd - 14 * DAY })];
    expect(itemsToCarryOver(items, 'Sprint 11', AT)).toHaveLength(1);
  });

  it('skips Done/Cancelled items and closed issues, but still moves open drafts', () => {
    const items = [
      item({ id: 'done', status: 'Done' }),
      item({ id: 'cancelled', status: 'Cancelled' }),
      item({ id: 'closed', state: 'CLOSED' }),
      item({ id: 'draft', state: null }),
    ];
    expect(itemsToCarryOver(items, 'Sprint 11', AT).map((i) => i.id)).toEqual(['draft']);
  });

  it('leaves unscheduled, current and future sprint items alone', () => {
    const items = [
      item({ id: 'none', sprintTitle: null, sprintEndMs: null }),
      item({ id: 'current', sprintTitle: 'Sprint 11', sprintEndMs: lastSprintEnd + 7 * DAY }),
      item({ id: 'future', sprintTitle: 'Sprint 12', sprintEndMs: lastSprintEnd + 14 * DAY }),
    ];
    expect(itemsToCarryOver(items, 'Sprint 11', AT)).toEqual([]);
  });

  it('does not move an item from a sprint that ends later today', () => {
    const items = [item({ sprintEndMs: AT.getTime() + 1 })];
    expect(itemsToCarryOver(items, 'Sprint 11', AT)).toEqual([]);
  });
});
