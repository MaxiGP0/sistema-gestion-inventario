import { KeyRound, ShieldCheck } from 'lucide-react';
import ChangePasswordForm from '@/components/ChangePasswordForm';
import Card from '@/components/ui/Card';

/**
 * Seguridad de la cuenta. El resumen de usuario/rol de la sesión lo muestra
 * el layout de Configuración; acá vive el formulario de cambio de contraseña.
 */
export default function SecuritySettingsPage() {
  return (
    <section className="space-y-6" aria-labelledby="change-password-title">
      <Card>
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-status-delivered-soft text-status-delivered">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h2 id="change-password-title" className="text-base font-semibold text-foreground">
              Cambiar contraseña
            </h2>
            <p className="mt-1 text-sm text-muted">
              Ingresá tu contraseña actual y elegí una nueva. La sesión de este dispositivo se
              mantiene abierta; las demás se cierran automáticamente.
            </p>
          </div>
        </div>

        <ChangePasswordForm />
      </Card>

      <Card padding="sm" className="flex items-start gap-3">
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-subtle" aria-hidden="true" />
        <p className="text-xs text-muted">
          Si no recordás tu contraseña actual, pedile a un administrador que restablezca el acceso
          desde Usuarios.
        </p>
      </Card>
    </section>
  );
}
