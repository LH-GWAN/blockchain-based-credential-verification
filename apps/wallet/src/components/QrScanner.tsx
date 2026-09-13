'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Button, Notice } from '@/components/ui';
import { COPY } from '@/lib/copy';

type Scanner = { stop(): Promise<void>; clear(): void };

/**
 * 카메라 QR 스캔 (P2). html5-qrcode 는 브라우저 전용이라 동적으로 불러오고,
 * 카메라가 없거나 권한이 거부되면 안내 문구만 보여준다 (빌드·화면은 깨지지 않는다).
 */
export function QrScanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const elementId = useId().replace(/:/g, '_');
  const scannerRef = useRef<Scanner | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) throw new Error('no-camera');
        const mod = await import('html5-qrcode');
        if (cancelled) return;
        const scanner = new mod.Html5Qrcode(elementId, { verbose: false });
        scannerRef.current = scanner;
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 240, height: 240 } },
          (text: string) => {
            onResult(text);
          },
          () => undefined,
        );
        if (!cancelled) setStarting(false);
      } catch {
        if (!cancelled) {
          setError(COPY.present.cameraUnavailable);
          setStarting(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      const s = scannerRef.current;
      scannerRef.current = null;
      if (s) {
        s.stop()
          .catch(() => undefined)
          .finally(() => {
            try {
              s.clear();
            } catch {
              /* ignore */
            }
          });
      }
    };
  }, [elementId, onResult]);

  return (
    <div className="space-y-2">
      {error ? (
        <Notice kind="warn">{error}</Notice>
      ) : (
        <div id={elementId} className="overflow-hidden rounded-2xl bg-black" aria-label="카메라 미리보기">
          {starting && <p className="p-4 text-center text-white">카메라를 여는 중…</p>}
        </div>
      )}
      <Button variant="secondary" full onClick={onClose}>
        {COPY.present.stopScan}
      </Button>
    </div>
  );
}
