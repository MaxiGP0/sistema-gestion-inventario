import AppShell from '@/components/app-shell/AppShell';
import { requireRolePage } from '@/lib/auth-page';
import { USER_ROLES } from '@/lib/authz';
import { sectionMetadata } from '@/lib/metadata';
import SettingsAccountSummary from './SettingsAccountSummary';
import SettingsTabs from './SettingsTabs';

/**
 * Metadata de la sección Configuración. Las páginas de preferencias usan el
 * contexto de usuario en el cliente, así que la metadata vive en el layout.
 */
export const metadata = sectionMetadata(
  'Cuenta y ajustes',
  'Preferencias personales de la cuenta, la seguridad y las notificaciones.',
);

export default async function SettingsLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await requireRolePage(USER_ROLES);

  return (
    <AppShell
      role={session.role}
      username={session.username}
      pageTitle="Cuenta y ajustes"
      pageDescription="Preferencias, seguridad y notificaciones."
      backLabel="Volver"
      backHref="/"
    >
      <div className="mx-auto w-full max-w-2xl space-y-6">
        <SettingsAccountSummary />
        <SettingsTabs />
        {children}
      </div>
    </AppShell>
  );
}
