// What a spoken command is allowed to turn into. Same stance as
// purchaseScan.test.js: Gemini heard something, so treat the answer as a
// claim — and the screen confirms all of it before a row is written.
import { describe, it, expect } from 'vitest';
import { normaliseVoiceCommand } from './voiceCommand.js';

const MATERIALS = [{ material_id: 'RM-001', item_name: 'Pork Shoulder', category: 'Meat' }];
const VENDORS = [{ vendor_id: 'VEN-001', vendor_name: 'Venkateshwara Pork' }];
const TEAM = ['Adarsh', 'Sowmya'];

const read = (parsed) => normaliseVoiceCommand(parsed, { materials: MATERIALS, vendors: VENDORS, team: TEAM });

describe('normaliseVoiceCommand', () => {
  it('turns a spoken purchase into a checked draft', () => {
    const { purchase, tasks } = read({
      transcript: 'bought 5 kg pork shoulder from venkateshwara for 2700',
      vendorName: 'Venkateshwara',
      channel: 'B2C',
      lines: [{ itemName: 'pork shoulder', materialId: 'RM-001', quantity: 5, unit: 'kg', unitPrice: 0, lineTotal: 2700 }],
      tasks: [],
    });

    expect(tasks).toEqual([]);
    expect(purchase).toMatchObject({ vendorName: 'Venkateshwara Pork', channel: 'B2C', purchaseDate: '' });
    expect(purchase.lines[0]).toMatchObject({ materialId: 'RM-001', itemName: 'Pork Shoulder', quantity: 5, unitPrice: 540 });
  });

  it('drops an invented catalogue id and an unknown channel', () => {
    const { purchase } = read({
      channel: 'Wholesale',
      lines: [{ itemName: 'Butcher paper', materialId: 'RM-999', quantity: 2 }],
    });

    expect(purchase.channel).toBe('B2C');
    expect(purchase.lines[0]).toMatchObject({ materialId: '', matched: false, unitPrice: 0 });
  });

  it('has no purchase when nothing was bought', () => {
    expect(read({ transcript: 'what is the weather', lines: [], tasks: [] })).toMatchObject({
      purchase: null,
      tasks: [],
      transcript: 'what is the weather',
    });
    expect(read(null)).toMatchObject({ purchase: null, tasks: [] });
  });

  it('keeps only tasks with a title, and only assignees on the team', () => {
    const { tasks } = read({
      tasks: [
        { title: ' Call the gas vendor ', assignee: 'sowmya' },
        { title: 'Post the reel', assignee: 'Soumya', repeatsWeekly: true, day: 'friday', time: '9 AM' },
        { title: '   ' },
      ],
    });

    expect(tasks).toEqual([
      { title: 'Call the gas vendor', assignee: 'Sowmya', repeatsWeekly: false, day: '', time: '' },
      { title: 'Post the reel', assignee: '', repeatsWeekly: true, day: 'Friday', time: '9 AM' },
    ]);
  });
});
