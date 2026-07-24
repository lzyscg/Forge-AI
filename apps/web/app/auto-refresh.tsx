'use client';

import { useEffect } from 'react';

export function AutoRefresh({ interval = 5000 }: { interval?: number }) {
  useEffect(() => {
    const timer = setInterval(() => {
      window.location.reload();
    }, interval);
    return () => clearInterval(timer);
  }, [interval]);

  return null;
}
