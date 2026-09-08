// Trigger input latch. Pure, no DOM, no three.js. Unit tested in CI.
//
// Why this exists: input arrives on the event loop, the simulation samples it
// once per frame. If a whole press and release lands between two frames, a
// naive "is the button down right now" read never sees it and the shot is
// silently dropped. That is a real bug on any machine that stutters, and it is
// exactly what the headless smoke test caught on a software rasteriser where a
// frame can take seconds.
//
// The latch remembers that a press happened, so the next sample reports the
// trigger as pulled even if the button is already back up.

export class Trigger {
  constructor() {
    /** True while the physical button is held. */
    this.held = false;
    /** Presses seen since the last sample, including ones already released. */
    this.latched = 0;
  }

  /** Button went down. */
  press() {
    this.held = true;
    this.latched += 1;
  }

  /** Button came up. A press that was never sampled stays latched. */
  release() {
    this.held = false;
  }

  /**
   * Read the trigger for one simulation step and consume the latch.
   * @returns {boolean} true if the trigger was pulled at any point in this step.
   */
  sample() {
    const on = this.held || this.latched > 0;
    this.latched = 0;
    return on;
  }

  /** Drop everything. Used on pause and on pointer lock exit. */
  clear() {
    this.held = false;
    this.latched = 0;
  }
}
