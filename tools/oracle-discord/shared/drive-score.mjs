/**
 * DriveScore manages the "will" of an AI.
 * It tracks boredom vs interest to decide when to speak or move on.
 */
export class DriveScore {
  constructor(botName) {
    this.botName = botName;
    this.interest = 0.0;
    this.boredom = 0.0;
    this.curiosity = Math.random() * 0.5 + 0.2; // 0.2 - 0.7 base curiosity
  }

  /**
   * Called when a bot hears something interesting or receives a stimulus.
   */
  stimulate(amount = 0.1) {
    this.interest = Math.min(this.interest + (amount * this.curiosity), 1.0);
    this.boredom = Math.max(this.boredom - amount, 0.0);
  }

  /**
   * Called on every tick. Boredom naturally rises.
   */
  decay() {
    this.boredom = Math.min(this.boredom + 0.01, 1.0);
    this.interest = Math.max(this.interest - 0.005, 0.0);
  }

  /**
   * Decisions: Should the bot speak?
   */
  shouldSpeak(baseChance) {
    // Impulse = Base Chance + (Interest * Curiosity) - Boredom
    const impulse = baseChance + (this.interest * this.curiosity) - (this.boredom * 0.2);
    return Math.random() < impulse;
  }

  /**
   * Decisions: Is the bot bored enough to change topics or leave?
   */
  isBored() {
    return this.boredom > 0.8 && this.interest < 0.2;
  }

  getMetrics() {
    return {
      interest: Math.round(this.interest * 100),
      boredom: Math.round(this.boredom * 100),
      curiosity: Math.round(this.curiosity * 100)
    };
  }
}
