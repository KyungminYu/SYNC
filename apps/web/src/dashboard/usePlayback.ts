import { useEffect, useRef, useState } from 'react';
import type { SimSpeed } from '../sync/source';

/**
 * Local playback clock for replay. Seeking, play/pause and speed stay inside
 * the UI (INTERFACE.md §3). With live delivery the clock follows the newest
 * simulated time until the viewer scrubs away.
 */
/**
 * Live clock: t trails the newest time by LIVE_DELAY..LIVE_LAG simulated
 * seconds. Staying a tick behind means the next tick has usually arrived
 * before t gets there, so nobody (a newcomer at the door) waits for data.
 */
// Ticks arrive unevenly (a busy tick takes longer to write), so the buffer is
// a few ticks deep and the steering gentle: walkers keep an even pace instead
// of slowing down whenever one tick is late.
const LIVE_DELAY = 3;
const LIVE_LAG = 6;
/** How hard the live clock steers back toward LIVE_DELAY (1 / seconds). */
const LIVE_GAIN = 0.3;
/** Live clock rate before enough arrivals are observed (simulated s per s). */
const LIVE_RATE_GUESS = 1;
/** Arrivals the live rate is averaged over. */
const LIVE_RATE_WINDOW = 8;

/**
 * With a global clock (the runner's start time and ms per tick) live time is
 * read straight from it, CLOCK_DELAY ticks behind so the engine has written
 * the tick before it is drawn; never past the newest data.
 */
const CLOCK_DELAY = 1.5;

export function usePlayback(
  end: number,
  liveTime?: number,
  /** Global clock of the live scenario, when its runner shares one. */
  clock?: { startedAt: number; tickMs: number },
) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<SimSpeed>(4);
  const [following, setFollowing] = useState(true);
  /** Timestamp of the previous animation frame, for frame-rate-independent playback. */
  const last = useRef<number | null>(null);

  /**
   * Live: rows arrive in whole ticks (several per wall-clock second), so
   * jumping to each new tick makes walkers teleport. Instead t glides at the
   * observed arrival rate, steered to stay LIVE_DELAY behind the newest time
   * (so the next tick is usually in before t needs it), never past the data
   * and at most LIVE_LAG behind (snapping forward if it falls further back).
   */
  const latest = useRef(liveTime);
  /** Simulated seconds per wall-clock second, from recent arrivals. */
  const rate = useRef(LIVE_RATE_GUESS);
  /**
   * The last few arrivals (newest tick and when it came). The rate is their
   * average over a span of seconds, so the burst of rows right after
   * subscribing, or one late tick, does not skew the pace.
   */
  const arrivals = useRef<Array<{ time: number; at: number }>>([]);
  useEffect(() => {
    latest.current = liveTime;
    if (liveTime === undefined) return;
    const now = performance.now();
    const list = arrivals.current;
    if (!list.length || liveTime > list[list.length - 1].time)
      list.push({ time: liveTime, at: now });
    while (list.length > LIVE_RATE_WINDOW) list.shift();
    const first = list[0];
    const last = list[list.length - 1];
    // Only trust a span of at least a couple of seconds.
    if (last.at - first.at >= 2000)
      rate.current = ((last.time - first.time) * 1000) / (last.at - first.at);
  }, [liveTime]);
  /** Latest global clock, read by the frame loop without restarting it. */
  const clockRef = useRef(clock);
  clockRef.current = clock;
  const isLive = liveTime !== undefined;
  useEffect(() => {
    if (!isLive || !following) return;
    let frame = 0;
    let before: number | null = null;
    const step = (now: number) => {
      const dt = before === null ? 0 : (now - before) / 1000;
      before = now;
      const target = latest.current ?? 0;
      // Global clock: everyone shows the same scenario time; wait at the
      // newest tick if the engine has not written the next one yet.
      if (clockRef.current) {
        const { startedAt, tickMs } = clockRef.current;
        const global = (Date.now() - startedAt) / tickMs - CLOCK_DELAY;
        setT(Math.max(0, Math.min(target, global)));
        frame = requestAnimationFrame(step);
        return;
      }
      setT((prev) => {
        // Move at the observed rate, sped up or slowed down by how far t is
        // from its spot LIVE_DELAY behind the newest tick; never past the data.
        const speed = Math.max(
          0,
          rate.current + (target - LIVE_DELAY - prev) * LIVE_GAIN,
        );
        const next = prev + dt * speed;
        return Math.max(0, target - LIVE_LAG, Math.min(target - 0.1, next));
      });
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
