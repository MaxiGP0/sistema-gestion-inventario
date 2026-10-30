'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Lock, Moon, Sun, User } from 'lucide-react';
import BrandWordmark from '@/components/BrandWordmark';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import Input from '@/components/ui/Input';
import { useDarkMode } from '@/hooks/useDarkMode';
import { useUser } from '@/context/UserContext';
import { api } from '@/lib/api-client';
import type { LoginResponse } from '@/lib/types';

export default function LoginForm() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { refresh } = useUser();
  const router = useRouter();
  const [darkMode, setDarkMode] = useDarkMode();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await api.post<LoginResponse>('/api/auth/login', { username, password });

      // La sesión ya quedó en una cookie httpOnly firmada por el servidor;
      // solo hay que refrescar el contexto de usuario.
      await refresh();

      // Redirigir al dashboard principal
      router.replace('/');
    } catch (err: unknown) {
      const errObj = err as Error;
      setError(errObj.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-background px-4 py-10 text-foreground">
      <div className="absolute right-3 top-3 sm:right-6 sm:top-6">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setDarkMode(!darkMode)}
          aria-label="Cambiar tema"
          title="Cambiar tema"
        >
          <Sun className="hidden h-5 w-5 text-status-draft dark:block" aria-hidden="true" />
          <Moon className="h-5 w-5 dark:hidden" aria-hidden="true" />
        </Button>
      </div>

      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <BrandWordmark className="h-10 w-auto" />
          <h1 className="mt-6 text-xl font-semibold text-foreground">Ingresar al sistema</h1>
          <p className="mt-1 text-sm text-muted">
            Gestión integral de catálogo, pedidos, depósito y facturación.
          </p>
        </div>

        <Card padding="lg" elevation="1">
          {error ? (
            <div
              role="alert"
              className="mb-5 flex items-start gap-2 rounded-md border border-status-blocked-border bg-status-blocked-soft p-3 text-sm text-status-blocked"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          ) : null}

          <form onSubmit={handleLogin} className="space-y-5">
            <Input
              id="login-username"
              label="Usuario"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              leadingIcon={User}
              placeholder="Ingrese su usuario"
            />

            <Input
              id="login-password"
              label="Contraseña"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              leadingIcon={Lock}
              placeholder="••••••••"
            />

            <Button
              type="submit"
              variant="primary"
              size="lg"
              fullWidth
              loading={loading}
              loadingLabel="Verificando..."
            >
              Ingresar al sistema
            </Button>
          </form>

          <p className="mt-6 text-center text-xs text-subtle">
            Acceso con credenciales personales · Sesión firmada en el servidor
          </p>
          <p className="mt-2 text-center text-[11px] text-subtle">
            Por{' '}
            <a
              href="https://github.com/MaxiGP0"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-muted underline-offset-2 hover:text-foreground hover:underline"
            >
              MaxiGP0
            </a>{' '}
            ·{' '}
            <a
              href="https://www.linkedin.com/in/maximo-gomez-pessoa/"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-muted underline-offset-2 hover:text-foreground hover:underline"
            >
              LinkedIn
            </a>
          </p>
        </Card>
      </div>
    </div>
  );
}
