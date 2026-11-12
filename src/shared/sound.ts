/**
 * 勾选音效：用 WebAudio 现场合成一个短促的"哒"声，不引入任何音频文件。
 * 浏览器需要用户先有交互才允许播放（勾选本身就是交互，没问题）。
 */
let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx ??= new Ctor();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** 播放"哒"——三角波从 880Hz 快速滑到 160Hz，90ms 内衰减干净。 */
export function playCheckSound(enabled: boolean): void {
  if (!enabled) return;
  const audio = getCtx();
  if (!audio) return;
  const t = audio.currentTime;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(880, t);
  osc.frequency.exponentialRampToValueAtTime(150, t + 0.06);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.2, t + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
  osc.connect(gain);
  gain.connect(audio.destination);
  osc.start(t);
  osc.stop(t + 0.12);
}
