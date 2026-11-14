import { frameCount } from '../src/media/screening';

describe('safety frame sampling', () => {
  it('keeps what short videos always got', () => {
    expect(frameCount(1)).toBe(1);
    expect(frameCount(10)).toBe(5);
    expect(frameCount(16)).toBe(8);
  });
  it('takes one every 10 s on longer videos, up to the cap', () => {
    expect(frameCount(120)).toBe(12);
    expect(frameCount(600)).toBe(48);
    expect(frameCount(7200)).toBe(48);
  });
  it('honours the settings', () => {
    expect(frameCount(600, 5, 90)).toBe(90);
    expect(frameCount(600, 60, 90)).toBe(10);
    expect(frameCount(600, 10, 12)).toBe(12);
  });
});
