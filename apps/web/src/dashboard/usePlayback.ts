import { useEffect, useRef, useState } from 'react';
import type { SimSpeed } from '../sync/source';

/**
 * Local playback clock for replay. Seeking, play/pause and speed stay inside
 * the UI (INTERFACE.md §3). With live delivery the clock follows the newest
 * simulated time until the viewer scrubs away.
 */
/** Live clock: how far t may trail the newest time, in simulated seconds. */
const LIVE_LAG = 2;
/** Live clock rate before arrivals are observed (engine: 1 tick / 200 ms). */
const LIVE_RATE_GUESS = 5;

export function usePlayback(end: number, liveTime?: number) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<SimSpeed>(4);
  const [following, setFollowing] = useState(true);
  /** Timestamp of the previous animation frame, for frame-rate-independent playback. */
  const last = useRef<number | null>(null);

  /**
   * Live: rows arrive in whole ticks (several per wall-clock second), so
   * jumping to each new tick makes walkers teleport. Instead t glides toward
   * the newest time at the observed arrival rate, never past it, and stays at
   * most LIVE_LAG behind (snapping forward if it falls further back).
   */
  const latest = useRef(liveTime);
  /** Simulated seconds per wall-clock second, estimated from arrivals. */
  const rate = useRef(LIVE_RATE_GUESS);
  const arrived = useRef<{ time: number; at: number } | null>(null);
  useEffect(() => {
    latest.current = liveTime;
    if (liveTime === undefined) return;
    const now = performance.now();
    const prev = arrived.current;
    if (prev && liveTime > prev.time && now > prev.at) {
      const observed = ((liveTime - prev.time) * 1000) / (now - prev.at);
      // Smooth the estimate; a single slow or bursty update should not jerk the clock.
      rate.current = rate.current * 0.8 + observed * 0.2;
    }
    arrived.current = { time: liveTime, at: now };
  }, [liveTime]);
  const isLive = liveTime !== undefined;
  useEffect(() => {
    if (!isLive || !following) return;
    let frame = 0;
    let before: number | null = null;
    const step = (now: number) => {
      const dt = before === null ? 0 : (now - before) / 1000;
      before = now;
      const target = latest.current ?? 0;
      setT((prev) =>
        Math.min(target, Math.max(target - LIVE_LAG, prev + dt * rate.current)),
      );
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [isLive, following]);

  // Replay: advance t by real elapsed time × speed each frame, stop at the end.
  useEffect(() => {
    if (!playing || liveTime !== undefined) return;
    let frame = 0;
    const step = (now: number) => {
      const dt = last.current === null ? 0 : (now - last.current) / 1000;
      last.current = now;
      setT((prev) => {
        const next = Math.min(end, prev + dt * speed);
        if (next >= end) setPlaying(false);
        return next;
      });
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      last.current = null;
    };
  }, [playing, speed, end, liveTime]);

  return {
    t,
    playing,
    speed,
    following,
    setSpeed,
    /** Jump to a time (clamped). In live mode, seeking back stops following. */
    seek(next: number) {
      setT(Math.max(0, Math.min(end, next)));
      if (liveTime !== undefined) setFollowing(next >= liveTime);
    },
    /** Play/pause in replay (restarting from 0 at the end); "follow live" in live mode. */
    toggle() {
      if (liveTime !== undefined) return setFollowing(true);
      if (t >= end) setT(0);
      setPlaying((p) => !p);
    },
    pause() {
      setPlaying(false);
    },
  };
}
