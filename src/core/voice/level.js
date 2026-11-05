/**
 * The level check (the second-drive design, section 3): how loud the user's voice has been lately, and the least a sound must reach to
 * begin a turn while something plays in the car. Lyrics that never open a turn never reach the model, cost nothing and can't be answered.
 * Measured on one drive, one car, one volume (53 live turns): the voice peaked at about -3 to -13 dB, lyrics at about -16 to -26 dB, a few
 * quiet words of the user's lower ("yeah." at -19); the floor with music on was about -54 to -66 dB, without it mostly -66 to -86 dB. So
 * these numbers are a first guess: `live.turn` logs voiceDb, minDb, keptFrames and keptPeakDb to tune them. Too high a minimum leaves the
 * user unheard, the worst failure here, so every doubt means no minimum: a floor not yet learned (Detector), no voiceDb yet, a tap, a new route.
 * It learns only from the turns she answered: a level that fell with time, or learned from every turn, let lyrics through within a minute,
 * and they then read as the user's own, so each one the model let go woke Kokoro. It is the second-loudest of the last few, not the loudest:
 * she answers a lyric now and then, and one at -7.8 dB against a voice of -23.3 dB would keep that voice from opening a turn until a tap.
 */
export const LEVEL = Object.freeze({
  /** A floor above this says something is playing; under it (a quiet car) there is no minimum. */
  NOISY_FLOOR_DB: -70,
  /** The minimum, under voiceDb. */
  BELOW_VOICE_DB: 10,
  /** A turn's peak this near voiceDb is at the user's own level. */
  OWN_WITHIN_DB: 6,
  /** How many of the turns she answered voiceDb looks at. */
  TURNS: 5,
});

export class VoiceLevel {
  /** The peaks of the turns she answered, newest last, since the route last changed or a tapped turn said what the user's voice is now. @type {number[]} */
  #peaks = [];

  /** voiceDb, in dB: the second-loudest of those peaks; null with fewer than two, as one may be a lyric. @returns {number | null} */
  get db() {
    return [...this.#peaks].sort((a, b) => b - a)[1] ?? null;
  }

  /** A turn she answered. @param {number} peakDb */
  heard(peakDb) {
    this.#peaks = [...this.#peaks, peakDb].slice(-LEVEL.TURNS);
  }

  /** The audio route changed (what was learned was for another microphone), or a tapped turn says what their voice is now. */
  reset() {
    this.#peaks = [];
  }

  /** The least a frame must reach to begin a turn over this floor; null: no minimum. @param {number} floorDb */
  minimum(floorDb) {
    const db = this.db;
    return db !== null && floorDb > LEVEL.NOISY_FLOOR_DB ? db - LEVEL.BELOW_VOICE_DB : null;
  }

  /**
   * Whether a turn's peak is at the user's own level. With no voiceDb: in a quiet car, yes, as lyrics need something playing (a real first
   * turn let go in a note's session still reaches Kokoro); over a loud floor, or one not known, nothing says so.
   * @param {number | null} peakDb @param {number | null} floorDb
   */
  own(peakDb, floorDb) {
    if (peakDb === null) return false;
    const db = this.db;
    return db === null ? floorDb !== null && floorDb <= LEVEL.NOISY_FLOOR_DB : peakDb >= db - LEVEL.OWN_WITHIN_DB;
  }
}
