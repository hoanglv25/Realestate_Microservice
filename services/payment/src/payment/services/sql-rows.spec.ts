import { updatedRows } from './sql-rows';

describe('updatedRows', () => {
  it('[rows, rowCount] của UPDATE ... RETURNING → rows', () => {
    expect(updatedRows([[{ id: 1 }], 1])).toEqual([{ id: 1 }]);
    expect(updatedRows([[], 0])).toEqual([]);
  });

  it('dạng khác (không phải mảng hai tầng) → rỗng', () => {
    expect(updatedRows(undefined)).toEqual([]);
    expect(updatedRows([{ id: 1 }])).toEqual([]);
  });
});
