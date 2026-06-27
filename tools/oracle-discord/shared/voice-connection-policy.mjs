/**
 * Unified voice connect policy — pure, no Discord imports.
 * All native-bot voice entry points must call decideVoiceAction only.
 */
import {
  allowsMicCapture,
  isRadioOutputAgent,
  voiceChannelLogTag,
} from './voice-input-policy.mjs';

/**
 * @param {string} botName
 * @param {{ phase?: string, isWorkingHours?: boolean, humanInRoom?: boolean, hasActiveShift?: boolean, channelId?: string, socialChannelId?: string }} ctx
 */
export function decideVoiceAction(botName, ctx = {}) {
  const name = String(botName || '').trim();
  const phase = ctx.phase || 'connect';
  const isWorkingHours = !!ctx.isWorkingHours;
  const humanInRoom = !!ctx.humanInRoom;
  const hasActiveShift = !!ctx.hasActiveShift;
  const channelId = String(ctx.channelId || '');
  const socialChannelId = String(ctx.socialChannelId || '');
  const logTag = voiceChannelLogTag(name);

  if (allowsMicCapture(name)) {
    return { shouldConnect: true, attachMic: true, logTag: 'Voice', reason: 'leo_voice_agent' };
  }

  if (!isRadioOutputAgent(name)) {
    return { shouldConnect: false, attachMic: false, logTag, reason: 'not_voice_agent' };
  }

  const groqWorkVoice = isWorkingHours && humanInRoom;
  const groqOffHours = !isWorkingHours;

  if (phase === 'voice_event' && channelId && socialChannelId && channelId !== socialChannelId) {
    return { shouldConnect: false, attachMic: false, logTag: 'RadioOut', reason: 'not_social_room' };
  }

  if (hasActiveShift && !groqWorkVoice) {
    return { shouldConnect: false, attachMic: false, logTag: 'RadioOut', reason: 'work_shift_active' };
  }

  if (isWorkingHours && !humanInRoom) {
    return { shouldConnect: false, attachMic: false, logTag: 'RadioOut', reason: 'work_hours_no_human' };
  }

  if (groqOffHours || groqWorkVoice) {
    const reason = groqWorkVoice ? 'work_hours_human_present' : 'off_hours_radio';
    return { shouldConnect: true, attachMic: false, logTag: 'RadioOut', reason };
  }

  return { shouldConnect: false, attachMic: false, logTag: 'RadioOut', reason: 'policy_denied' };
}