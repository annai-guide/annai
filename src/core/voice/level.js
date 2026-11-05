/**
 * The level check (the second-drive design, section 3): how loud the user's voice has been lately, and the least a sound must reach to
 * begin a turn while something plays in the car. Lyrics that never open a turn never reach the model, cost nothing and can't be answered.
 * Measured on one drive, one car, one volume (53 live turns): the voice peaked at about -3 to -13 dB, lyrics at about -16 to -26 dB, a few
 * quiet words of the user's lower ("yeah." at -19); the floor with music on was about -54 to -66 dB, without it mostly -66 to -86 dB. So
 * these numbers are a first guess: `live.turn` logs voiceDb, minDb, keptFrames and keptPeakDb to tune them. Too high a minimum leaves the
 * user unheard, the worst failure here, so every doubt means no minimum: a floor not yet learned (Detector), no voiceDb yet, a tap, a new route.
 * It learns only from the user: a turn she answered, or one they tapped for. A level that fell with time, or learned from every turn, let
 * lyrics through within a minute, and they then read as the user's own, so each one the model let go woke Kokoro.
 */
export const LEVEL = Object.freeze({
  /** A floor above this says something is playing; under it (a quiet car) there is no minimum. */
  NOISY_FLOOR_DB: -70,
  /** The minimum, under voiceDb. */
  BELOW_VOICE_DB: 10,
  /** A turn's peak this near voiceDb is at the user's own level. */
  OWN_WITHIN_DB: 6,
});

export class VoiceLevel {
  /** The loudest of the user's turns, in dB; null with none since the route last changed, or a tap's turn. @type {number | null} */
  db = null;

  /** A turn of the user's: a running maximum. @param {number} peakDb */
  heard(peakDb) {
    if (this.db === null || peakDb > this.db) this.db = peakDb;
  }

  /** The audio route changed (what was learned was for another microphone), or a tapped turn says what their voice is now. */
  reset() {
    this.db = null;
  }

  /** The least a frame must reach to begin a turn over this floor; null: no minimum. @param {number} floorDb */
  minimum(floorDb) {
    const db = this.db;
    return db !== null && floorDb > LEVEL.NOISY_FLOOR_DB ? db - LEVEL.BELOW_VOICE_DB : null;
  }

  /** Whether a turn's peak is at the user's own level; with no voiceDb, nothing says so. @param {number | null} peakDb */
  own(peakDb) {
    return peakDb !== null && this.db !== null && peakDb >= this.db - LEVEL.OWN_WITHIN_DB;
  }
}
