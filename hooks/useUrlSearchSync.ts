'use client';

import { useCallback, useEffect, useRef } from 'react';

interface UseUrlSearchSyncOptions {
  /** Término que llega del Server Component (searchParams.search). */
  serverValue: string;
  /** Actualiza el input local. */
  setValue: (value: string) => void;
  /** Nombre del parámetro de la URL que contiene la búsqueda. */
  paramName?: string;
  /** Desactiva la sincronización mientras el buscador resuelve todo localmente. */
  enabled?: boolean;
}

/**
 * Mantiene un buscador local alineado con la URL sin pisar lo que el usuario
 * está escribiendo.
 *
 * El servidor re-renderiza después de cada `router.replace` del debounce y
 * vuelve a enviar el término que ya se había comprometido. Aplicarlo tal cual
 * borraba los caracteres escritos mientras la navegación estaba en curso.
 *
 * Reglas:
 * - Si el valor entrante es el eco de nuestra propia navegación, se ignora y se
 *   conserva el input (puede tener texto más nuevo sin comprometer).
 * - Si el valor entrante coincide con la URL actual, vino de atrás/adelante o de
 *   un enlace externo: se aplica.
 * - Si no coincide con la URL, es una respuesta vieja: se ignora.
 *
 * Devuelve `markCommitted`, que debe llamarse justo antes de cada
 * `router.replace`/`router.push` que escriba el término en la URL.
 */
export function useUrlSearchSync({
  serverValue,
  setValue,
  paramName = 'search',
  enabled = true,
}: UseUrlSearchSyncOptions): (value: string) => void {
  const committedRef = useRef(serverValue);
  const previousServerValueRef = useRef(serverValue);
  const allowNextSyncRef = useRef(false);

  // Un `popstate` es la única señal fiable de atrás/adelante: en ese caso la
  // URL manda aunque el término coincida con el último que enviamos.
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handlePopState = () => {
      allowNextSyncRef.current = true;
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (serverValue === previousServerValueRef.current) return;

    previousServerValueRef.current = serverValue;

    const fromHistory = allowNextSyncRef.current;
    allowNextSyncRef.current = false;

    // Eco de nuestra propia navegación: el usuario pudo seguir escribiendo.
    if (!fromHistory && serverValue === committedRef.current) return;

    if (!fromHistory) {
      const urlValue = new URLSearchParams(window.location.search).get(paramName) ?? '';
      if (serverValue !== urlValue) return; // Respuesta vieja.
    }

    committedRef.current = serverValue;
    setValue(serverValue);
  }, [serverValue, enabled, paramName, setValue]);

  return useCallback((value: string) => {
    committedRef.current = value.trim();
  }, []);
}
