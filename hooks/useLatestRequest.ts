'use client';

import { useState } from 'react';
import { createLatestRequest, type LatestRequest } from '@/lib/latest-request';

/**
 * Un coordinador `LatestRequest` estable por componente/consulta. Cada hook que
 * dispara búsquedas independientes debe crear el suyo.
 */
export function useLatestRequest(): LatestRequest {
  const [latest] = useState(createLatestRequest);
  return latest;
}
