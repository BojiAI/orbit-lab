export function renderScore(duration) {
  const sampleRate = 48000, frames = sampleRate * duration;
  const samples = Buffer.alloc(44 + 4 * frames);
  const channels = [new Float32Array(frames), new Float32Array(frames)];
  const tau = 2 * Math.PI;
  const midi = note => 440 * 2 ** ((note - 69) / 12);
  function smooth(x) { const p = Math.max(0, Math.min(1, x)); return p * p * (3 - 2 * p); }

  function add(start, finish, pan, signal) {
    const left = Math.sqrt(0.5 - pan / 2);
    const right = Math.sqrt(0.5 + pan / 2);
    for (let i = Math.round(start * sampleRate); i < Math.min(frames, Math.round(finish * sampleRate)); i++) {
      const value = signal(i / sampleRate - start);
      channels[0][i] += left * value;
      channels[1][i] += right * value;
    }
  }

  function pad(start, end, notes, volume) {
    const length = end - start;
    notes.forEach((note, i) => {
      const frequency = midi(note);
      add(start, end, [-0.40, 0.31, -0.13, 0.42][i], t => {
        const phase = tau * t * frequency + i * 0.53;
        const detuned = tau * t * frequency * (i % 2 ? 1.0015 : 0.998);
        const envelope = smooth(t / 2.6) * smooth((length - t) / 3.0);
        const oscillation = Math.sin(phase + 0.14 * Math.sin(tau * 0.58 * t)) + 0.42 * Math.sin(detuned) + 0.15 * Math.sin(2 * phase);
        return (volume / notes.length) * envelope * (0.90 + 0.10 * Math.sin(tau * 0.27 * t + i)) * oscillation;
      });
    });
  }

  function bell(start, note, volume, pan) {
    const f = midi(note);
    for (const [delay, gain, position] of [[0, 1, pan], [0.29, 0.20, -pan], [0.58, 0.09, 0.5 * pan]]) {
      add(start + delay, start + delay + 5.3, position, t => {
        const phase = tau * f * t;
        const envelope = smooth(t / 0.026) * Math.exp(-1.15 * t) * smooth((5.3 - t) / 0.4);
        return gain * volume * envelope * (Math.sin(phase) + 0.56 * Math.sin(2.003 * phase) * Math.exp(-1.25 * t) +
          0.18 * Math.sin(3.011 * phase) * Math.exp(-3.9 * t));
      });
    }
  }

  function pass(center, volume) {
    const length = 1.5;
    let mixture = 0, shift = 0, seed = 78881;
    add(center - 1, center + 0.5, 0, t => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const raw = 2 * (seed / 4294967296) - 1;
      mixture += (0.019 + 0.057 * smooth(t)) * (raw - mixture);
      shift += 0.0043 * (mixture - shift);
      const swell = Math.sin(Math.PI * t / length) ** 2 * smooth((length - t) / 0.32);
      return volume * swell * (0.65 * (mixture - shift) + 0.19 * Math.sin(tau * t * (35 + 12 * t)));
    });
  }

  pad(0, 8.7, [38, 50, 57, 64], 0.18);
  pad(5.3, 17.7, [34, 46, 53, 60], 0.19);
  pad(14.5, 25.5, [36, 48, 55, 62], 0.145);
  pad(23.1, 34.5, [41, 53, 60, 64], 0.17);
  pad(30.2, 37, [38, 50, 57, 65], 0.168);

  for (const [at, note, gain, pan] of [
    [0.55, 62, 0.11, -0.25], [1.37, 69, 0.078, 0.30], [2.26, 76, 0.068, -0.11],
    [5.25, 46, 0.059, -0.05], [6.35, 58, 0.067, -0.18], [8.05, 65, 0.059, 0.25],
    [9.18, 72, 0.057, 0.4], [11.16, 53, 0.070, -0.32], [12.56, 60, 0.051, 0.26],
    [13.44, 65, 0.084, 0.22], [15.64, 70, 0.067, -0.26], [16.91, 60, 0.092, -0.15],
    [19.50, 67, 0.06, 0.24], [22.2, 74, 0.042, -0.42], [24.55, 65, 0.104, -0.22],
    [26.01, 72, 0.072, 0.37], [27.86, 76, 0.066, -0.21], [29.84, 79, 0.057, 0.18],
    [32.24, 62, 0.082, -0.24], [33.13, 69, 0.072, 0.22], [34.05, 77, 0.052, -0.08],
  ]) bell(at, note, gain, pan);

  for (const time of [5.16, 9.05, 13.38, 16.85, 24.47, 32.15]) pass(time, 0.15);

  let peak = 0;
  for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(channels[0][i]), Math.abs(channels[1][i]));
  const gain = 0.48 / peak;
  samples.write('RIFF', 0);
  samples.writeUInt32LE(samples.length - 8, 4);
  samples.write('WAVEfmt ', 8);
  samples.writeUInt32LE(16, 16);
  samples.writeUInt16LE(1, 20);
  samples.writeUInt16LE(2, 22);
  samples.writeUInt32LE(sampleRate, 24);
  samples.writeUInt32LE(sampleRate * 4, 28);
  samples.writeUInt16LE(4, 32);
  samples.writeUInt16LE(16, 34);
  samples.write('data', 36);
  samples.writeUInt32LE(4 * frames, 40);
  for (let i = 0; i < frames; i++) {
    const time = i / sampleRate;
    const endFade = smooth((duration - time) / 1.25);
    samples.writeInt16LE(Math.round(32767 * gain * endFade * channels[0][i]), 44 + i * 4);
    samples.writeInt16LE(Math.round(32767 * gain * endFade * channels[1][i]), 46 + i * 4);
  }
  return samples;
}
