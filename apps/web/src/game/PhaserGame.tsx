import { useEffect, useRef } from 'react';
import Phaser from 'phaser';
export interface WorkerView {
  id: string;
  label: string;
  active: boolean;
  activity: string;
}
export function PhaserGame({ workers }: { workers: WorkerView[] }) {
  const host = useRef<HTMLDivElement>(null),
    latest = useRef(workers);
  latest.current = workers;
  useEffect(() => {
    class Kitchen extends Phaser.Scene {
      markers: Phaser.GameObjects.Arc[] = [];
      labels: Phaser.GameObjects.Text[] = [];
      create() {
        for (let x = 0; x < 680; x += 40)
          for (let y = 0; y < 260; y += 40)
            this.add.rectangle(x + 20, y + 20, 38, 38, 0x152329);
        ['PREP / 2 SLOTS', 'OVEN / 1 SLOT', 'FINISH'].forEach((s, i) => {
          this.add
            .rectangle(125 + i * 215, 55, 170, 65, 0x293b3e)
            .setStrokeStyle(1, 0x56706b);
          this.add.text(60 + i * 215, 45, s, {
            fontSize: '12px',
            color: '#b7d5c6',
          });
        });
        for (let i = 0; i < 4; i++) {
          this.markers.push(
            this.add.circle(
              90 + i * 165,
              200,
              17,
              [0xb8eb80, 0x80d9eb, 0xeac28a, 0xba9ef3][i],
            ),
          );
          this.labels.push(
            this.add.text(35 + i * 165, 225, '', {
              fontSize: '11px',
              color: '#d2ded8',
            }),
          );
        }
      }
      update() {
        this.markers.forEach((m, i) => {
          const w = latest.current[i];
          m.setVisible(!!w);
          m.y = Phaser.Math.Linear(m.y, w?.active ? 120 : 195, 0.06);
          this.labels[i].setText(w ? `${w.label}\n${w.activity}` : '');
        });
      }
    }
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: host.current!,
      width: 680,
      height: 270,
      backgroundColor: '#152329',
      scene: Kitchen,
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
      audio: { noAudio: true },
    });
    return () => game.destroy(true);
  }, []);
  return (
    <div
      ref={host}
      className="game"
      aria-label="Live worker station visualization"
    />
  );
}
