import { describe, expect, expectTypeOf, it } from 'vitest';
import type * as Editor from '@ep-connectors/editor-ports/schedule';
import type { OverlayEvent, OverlayRead } from '../src/overlay.js';

// The Host hands readGoogleCalendarRange's result to the Editor's ScheduleReadPort as it is.
// The copy of the Editor port (editor-ports) is the contract; the read DTO has to fit it both ways.
describe('the read DTO and the Editor port', () => {
  it('has the same shape as the Editor OverlayRead, including fetchedAt: null', () => {
    expectTypeOf<OverlayRead>().toEqualTypeOf<Editor.OverlayRead>();
    expectTypeOf<OverlayEvent>().toEqualTypeOf<Editor.OverlayEvent>();
    expectTypeOf<null>().toExtend<OverlayRead['fetchedAt']>();
    expect(true).toBe(true);
  });
});
